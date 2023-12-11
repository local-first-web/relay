import { getPortPromise as getAvailablePort } from "portfinder"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import WebSocket from "isomorphic-ws"
import { Server } from "./Server.js"
import type { Message } from "./types.js"
import { eventPromise, eventPromises } from "./eventPromise.js"
import { pack, unpack } from "./msgpack.js"
import { pause } from "./pause.js"
import { isReady } from "./isReady.js"

// const log = debug('lf:relay:tests')

/**
 * In this context:
 * - `userName` is always a peer userName.
 * - `peer` is always a reference to a client's socket connection.
 * - `documentId` is always a document userName (elsewhere referred to as a 'channel' or a 'discovery documentId'.
 */
describe("Server", () => {
  let testId = Math.trunc(Math.random() * 60000)

  const setup = async () => {
    testId += 1
    const port = await getAvailablePort({
      port: 100 + testId,
    })
    const url = `ws://localhost:${port}`

    const server = new Server({ port })
    await server.listen({ silent: true })

    const aliceId = `alice-${testId}`
    const bobId = `bob-${testId}`
    const documentId = `test-documentId-${testId}`

    const teardown = async (...sockets: WebSocket[]) => {
      await pause(10)
      sockets.forEach(socket => {
        socket.close()
      })
      await pause(10)
      server.close()
    }

    return { aliceId, bobId, documentId, port, url, server, teardown }
  }

  const requestIntroduction = async (
    url: string,
    userName: string,
    documentId: string
  ) => {
    const peer = new WebSocket(`${url}/introduction/${userName}`)
    const joinMessage: Message.Join = {
      type: "Join",
      documentIds: [documentId],
    }

    await isReady(peer)
    peer.send(pack(joinMessage))
    return peer
  }

  describe("Introduction", () => {
    it("should make a connection", async () => {
      const { aliceId, url, server, teardown } = await setup()

      const alice = new WebSocket(`${url}/introduction/${aliceId}`)
      const userName = await eventPromise(server, "introductionConnection")
      expect(userName).toEqual(aliceId)
      expect(server.peers).toHaveProperty(aliceId)
      expect(server.documentIds).toEqual({})

      await teardown(alice)
    })

    it("should not crash when sent malformed data", async () => {
      const { aliceId, bobId, documentId, url, server, teardown } =
        await setup()

      const alice = await requestIntroduction(url, aliceId, documentId)

      // Bob's behavior will be non-standard so we'll drive it by hand
      const bob = new WebSocket(`${url}/introduction/${bobId}`)

      const badMessage = new Uint8Array([1, 2, 3]) // not valid msgpack
      await eventPromise(bob, "open")

      // Bob sends an invalid message
      bob.send(badMessage)

      // No servers are harmed

      // Bob then sends a valid join message
      bob.send(
        pack({
          type: "Join",
          documentIds: [documentId],
        })
      )

      // The bad message didn't kill the server - Bob gets a response back
      const messageBytes = await eventPromise(bob, "message")
      const msg = unpack(messageBytes)
      expect(msg.type).toBe("Introduction")

      await teardown(alice, bob)
    })

    it("should invite peers to connect", async () => {
      const { aliceId, bobId, documentId, url, teardown } = await setup()
      const alice = await requestIntroduction(url, aliceId, documentId)
      const bob = await requestIntroduction(url, bobId, documentId)

      const aliceDone = new Promise<void>(resolve => {
        alice.once("message", d => {
          const invitation = unpack(d)
          expect(invitation).toEqual({
            type: "Introduction",
            userName: bobId,
            documentIds: [documentId],
          })
          resolve()
        })
      })
      const bobDone = new Promise<void>(resolve => {
        bob.on("message", d => {
          const invitation = unpack(d)
          expect(invitation).toEqual({
            type: "Introduction",
            userName: aliceId,
            documentIds: [documentId],
          })
          resolve()
        })
      })
      await Promise.all([aliceDone, bobDone])

      await teardown(alice, bob)
    })
  })

  describe("Peer connections", () => {
    it("should pipe connections between two peers", async done => {
      const { aliceId, bobId, documentId, url, teardown } = await setup()

      const aliceRequest = await requestIntroduction(url, aliceId, documentId)
      const _bobRequest = await requestIntroduction(url, bobId, documentId) // need to make request even if we don't use the result

      const message = await eventPromise(aliceRequest, "message")
      // recap of previous test: we'll get an invitation to connect to the remote peer
      const invitation = unpack(message)

      expect(invitation).toEqual({
        type: "Introduction",
        userName: bobId,
        documentIds: [documentId],
      })

      const alice = new WebSocket(
        `${url}/connection/${aliceId}/${bobId}/${documentId}`
      )
      const bob = new WebSocket(
        `${url}/connection/${bobId}/${aliceId}/${documentId}`
      )

      // send message from local to remote
      alice.once("open", () => alice.send(pack("DUDE!!")))
      bob.once("message", data => {
        expect(unpack(data)).toEqual("DUDE!!")
      })

      // send message from remote to local
      bob.once("open", () => bob.send(pack("hello")))
      const data = await eventPromise(alice, "message")
      expect(unpack(data)).toEqual("hello")

      await teardown(alice, bob)
    })

    it("should close a peer when asked to", async done => {
      const { aliceId, bobId, documentId, url, teardown } = await setup()

      const aliceRequest = await requestIntroduction(url, aliceId, documentId)
      const _bobRequest = await requestIntroduction(url, bobId, documentId) // need to make request even if we don't use the result

      await eventPromise(aliceRequest, "message")

      const alice = new WebSocket(
        `${url}/connection/${aliceId}/${bobId}/${documentId}`
      )
      const bob = new WebSocket(
        `${url}/connection/${bobId}/${aliceId}/${documentId}`
      )

      await eventPromise(alice, "open")
      alice.send(pack("hey bob!"))
      alice.close()

      const d = await eventPromise(bob, "message")
      expect(unpack(d)).toEqual("hey bob!")

      bob.send(pack("sup alice"))

      alice.once("message", () => {
        throw new Error("should never get here")
      })

      await pause(100)
      await teardown(alice, bob)
    })
  })

  describe("N-way", () => {
    it("Should make introductions between all the peers", async done => {
      const { documentId, url, teardown } = await setup()
      const peers = ["a", "b", "c", "d", "e"]

      const expectedIntroductions = permutationsOfTwo(peers.length)

      const userNames = peers.map(userName => `peer-${userName}-${testId}`)

      const sockets = userNames.map(
        (userName: string) => new WebSocket(`${url}/introduction/${userName}`)
      )

      const joinMessage = { type: "Join", documentIds: [documentId] }
      sockets.forEach(async (socket: WebSocket) => {
        socket.onopen = () => {
          socket.send(pack(joinMessage))
        }
      })

      const introductions = await new Promise<number>(resolve => {
        let introductions = 0
        sockets.forEach(socket => {
          socket.onmessage = () => {
            introductions += 1
            if (introductions === expectedIntroductions) {
              resolve(introductions)
            }
          }
        })
      })
      expect(introductions).toBe(expectedIntroductions)

      await teardown()
    })

    it("Should not crash when one peer disconnects mid-introduction", async done => {
      const { documentId, url, teardown } = await setup()
      const peers = ["a", "b", "c", "d", "e"]

      const userNames = peers.map(userName => `peer-${userName}-${testId}`)

      const expectedIntroductions = permutationsOfTwo(peers.length - 1) // one will misbehave

      const sockets = userNames.map(
        userName => new WebSocket(`${url}/introduction/${userName}`)
      )

      const joinMessage = { type: "Join", documentIds: [documentId] }
      sockets.forEach(async (socket, i) => {
        socket.onopen = () => {
          socket.send(pack(joinMessage))
          if (i === 0) socket.close() // <- misbehaving node
        }
      })

      const introductions = await new Promise<number>(resolve => {
        let introductions = 0
        sockets.forEach(socket => {
          socket.onmessage = () => {
            introductions += 1
            if (introductions === expectedIntroductions) {
              resolve(introductions)
            }
          }
        })
      })
      expect(introductions).toBe(expectedIntroductions)

      await teardown(...sockets)
    })
  })
})

const permutationsOfTwo = (n: number) => factorial(n) / factorial(n - 2)
const factorial = (n: number): number => (n === 1 ? 1 : n * factorial(n - 1))
