import WebSocket from "isomorphic-ws"
import { expect, it } from "vitest"
import { Server } from "../Server.js"
import { eventPromise } from "../lib/eventPromise.js"
import { isReady } from "../lib/isReady.js"
import { pack, unpack } from "../lib/msgpack.js"
import { pause } from "../lib/pause.js"
import type { Message } from "../types.js"
import { permutationsOfTwo } from "./helpers/permutationsOfTwo.js"

/**
 * In this context:
 * - `peerId` is always a peer peerId.
 * - `peer` is always a reference to a client's socket connection.
 * - `documentId` is always a document peerId (elsewhere referred to as a 'channel' or a 'discovery documentId'.
 */
let testId = 0

const setup = async () => {
  testId++
  const port = 3010 + testId
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

  return { testId, aliceId, bobId, documentId, port, url, server, teardown }
}

const requestIntroduction = async (
  url: string,
  peerId: string,
  documentId: string
) => {
  const peer = new WebSocket(`${url}/introduction/${peerId}`)
  const joinMessage: Message.Join = {
    type: "Join",
    documentIds: [documentId],
  }

  await isReady(peer)
  peer.send(pack(joinMessage))
  return peer
}

it("should make an introduction connection", async () => {
  const { aliceId, url, server, teardown } = await setup()

  const alice = new WebSocket(`${url}/introduction/${aliceId}`)
  const peerId = await eventPromise(server, "introduction")
  expect(peerId).toEqual(aliceId)
  expect(server.peers).toHaveProperty(aliceId)
  expect(server.documentIds).toEqual({})

  await teardown(alice)
})

it("should not crash when sent malformed data", async () => {
  const { aliceId, bobId, documentId, url, server, teardown } = await setup()

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
        peerId: bobId,
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
        peerId: aliceId,
        documentIds: [documentId],
      })
      resolve()
    })
  })
  await Promise.all([aliceDone, bobDone])

  await teardown(alice, bob)
})

it("should pipe connections between two peers", async () => {
  const { aliceId, bobId, documentId, url, teardown } = await setup()

  const aliceRequest = await requestIntroduction(url, aliceId, documentId)
  const _bobRequest = await requestIntroduction(url, bobId, documentId) // need to make request even if we don't use the result

  const message = await eventPromise(aliceRequest, "message")
  // recap of previous test: we'll get an invitation to connect to the remote peer
  const invitation = unpack(message)

  expect(invitation).toEqual({
    type: "Introduction",
    peerId: bobId,
    documentIds: [documentId],
  })

  const alice = new WebSocket(
    `${url}/connection/${aliceId}/${bobId}/${documentId}`
  )
  const bob = new WebSocket(
    `${url}/connection/${bobId}/${aliceId}/${documentId}`
  )

  await Promise.all([eventPromise(alice, "open"), eventPromise(bob, "open")])

  // send message from alice to bob
  alice.send(pack("DUDE!!"))

  const aliceMessage = await eventPromise(bob, "message")
  expect(unpack(aliceMessage)).toEqual("DUDE!!")

  // send message from bob to alice
  bob.send(pack("hello"))
  const bobMessage = await eventPromise(alice, "message")
  expect(unpack(bobMessage)).toEqual("hello")

  await teardown(alice, bob)
})

it("should close a peer when asked to", async () => {
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

  // Alice sends a message
  alice.send(pack("hey bob!"))

  // She then closes the connection
  alice.close()

  // Bob receives the message
  await eventPromise(bob, "message")

  // Bob sends a message back
  bob.send(pack("sup alice"))

  // Alice should not receive the message, because her connection is closed
  const aliceReceivedMessage = await Promise.race([
    eventPromise(alice, "message").then(() => true),
    pause(100).then(() => false),
  ])
  expect(aliceReceivedMessage).toBe(false)

  await teardown(alice, bob)
})

it("Should make introductions between N peers", async () => {
  const { documentId, url, teardown } = await setup()
  const peers = ["a", "b", "c", "d", "e"]

  const expectedIntroductions = permutationsOfTwo(peers.length)

  const peerIds = peers.map(peerId => `peer-${peerId}-${testId}`)

  const sockets = peerIds.map(
    (peerId: string) => new WebSocket(`${url}/introduction/${peerId}`)
  )

  const joinMessage = { type: "Join", documentIds: [documentId] }
  sockets.forEach(async (socket: WebSocket) => {
    socket.on("open", () => {
      socket.send(pack(joinMessage))
    })
  })

  const introductions = await new Promise<number>(resolve => {
    let introductions = 0
    sockets.forEach(socket => {
      socket.on("message", () => {
        introductions += 1
        if (introductions === expectedIntroductions) resolve(introductions)
      })
    })
  })
  expect(introductions).toBe(expectedIntroductions)

  await teardown(...sockets)
})

it("Should not crash when one peer disconnects mid-introduction", async () => {
  const { documentId, url, teardown } = await setup()
  const peers = ["a", "b", "c", "d", "e"]

  const peerIds = peers.map(peerId => `peer-${peerId}-${testId}`)

  const expectedIntroductions = permutationsOfTwo(peers.length - 1) // one will misbehave

  const sockets = peerIds.map(
    peerId => new WebSocket(`${url}/introduction/${peerId}`)
  )

  const joinMessage = { type: "Join", documentIds: [documentId] }
  sockets.forEach(async (socket, i) => {
    socket.on("open", () => {
      socket.send(pack(joinMessage))
      if (i === 0) socket.close() // <- misbehaving node
    })
  })

  const introductions = await new Promise<number>(resolve => {
    let introductions = 0
    sockets.forEach(socket => {
      socket.on("message", () => {
        introductions += 1
        if (introductions === expectedIntroductions) {
          resolve(introductions)
        }
      })
    })
  })
  expect(introductions).toBe(expectedIntroductions)

  await teardown(...sockets)
})
