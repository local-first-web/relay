import { getPortPromise as getAvailablePort } from "portfinder"
import { describe, expect, it } from "vitest"
import { Client } from "../Client.js"
import { eventPromise } from "../lib/eventPromise.js"
import { DocumentId, Server } from "../index.js"
import { PeerEventPayload } from "../lib/types.js"
import { pack, unpack } from "../lib/msgpack.js"
import { WebSocket } from "isomorphic-ws"

let testId = 0

const setup = async () => {
  testId++
  const port = 3000 + testId
  const url = `ws://localhost:${port}`

  const server = new Server({ port })
  server.listen({ silent: true })

  const documentId = `test-documentId-${testId}`
  const documentIds = [documentId]

  const alice = new Client({ userName: `a-${testId}`, url, documentIds })
  const bob = new Client({ userName: `b-${testId}`, url, documentIds })
  const charlie = new Client({ userName: `c-${testId}`, url, documentIds })

  const teardown = async () => {
    alice.disconnectServer()
    bob.disconnectServer()
    charlie.disconnectServer()
    await pause(10)
    server.close()
  }
  return { url, server, alice, bob, charlie, documentId, teardown }
}

it("joins a documentId and connects to a peer", async () => {
  // Alice and Bob both join a documentId
  const { alice, bob, documentId, teardown } = await setup()
  await allConnected(alice, bob)

  expect(alice.has(bob.userName, documentId)).toBe(true)
  expect(bob.has(alice.userName, documentId)).toBe(true)

  await teardown()
})

it("both peers have the second document", async () => {
  const { alice, bob, teardown } = await setup()

  const anotherDocumentId = "some-other-document-1234"
  alice.join(anotherDocumentId)
  bob.join(anotherDocumentId)

  await allConnected(alice, bob, anotherDocumentId)

  expect(alice.has(bob.userName, anotherDocumentId)).toBe(true)
  expect(bob.has(alice.userName, anotherDocumentId)).toBe(true)

  await teardown()
})

// it("emits peer.connect only once per peer connection", async () => {
//   // Alice and Bob both join a documentId
//   const documentId = `some-other-test-documentId-${testId}`

//   const { url, teardown } = await setup()
//   let connections = 0
//   const alice = new Client({ userName: `alice-${testId}`, url })

//   alice.on("peer.connect", () => {
//     connections++
//     if (connections > 1) throw new Error(`peer connect emitted ${connections}x`)
//   })
//   const bob = new Client({ userName: `bob-${testId}`, url })

//   bob.join(documentId)
//   alice.join(documentId)
//   alice.join(documentId)

//   await allConnected(alice, bob)

//   expect(alice.has(bob.userName, documentId)).toBe(true)
//   expect(bob.has(alice.userName, documentId)).toBe(true)

//   await pause(500)
//   await teardown()
// })

it("leaves a documentId", async () => {
  // Alice and Bob both join a documentId
  const { alice, bob, documentId, teardown } = await setup()
  await allConnected(alice, bob)

  expect(alice.has(bob.userName, documentId)).toBe(true)
  expect(alice.documentIds).toContain(documentId)

  // Alice decides she's no longer interested in this document
  alice.leave(documentId)

  expect(alice.has(bob.userName, documentId)).toBe(false)
  expect(alice.documentIds).not.toContain(documentId)

  await teardown()
})

it("Bob is disconnected from Alice and vice versa", async () => {
  // Alice and Bob both join a documentId
  const { alice, bob, documentId, teardown } = await setup()
  await allConnected(alice, bob)

  alice.disconnectPeer(bob.userName)
  await allDisconnected(alice, bob)

  // Bob is disconnected from Alice and vice versa
  expect(alice.has(bob.userName, documentId)).toBe(false)
  expect(bob.has(alice.userName, documentId)).toBe(false)

  await teardown()
})

it("everyone is disconnected from Alice and vice versa", async () => {
  // Alice, Bob, and Charlie all join a documentId
  const { alice, bob, charlie, documentId, teardown } = await setup()
  await Promise.all([allConnected(alice, bob), allConnected(alice, charlie)])

  // Alice disconnects from everyone
  alice.disconnectServer()
  await Promise.all([
    allDisconnected(alice, bob),
    allDisconnected(alice, charlie),
  ])

  // Bob is disconnected from Alice and vice versa
  expect(alice.has(bob.userName, documentId)).toBe(false)
  expect(bob.has(alice.userName, documentId)).toBe(false)

  // Charlie is disconnected from Alice and vice versa
  expect(alice.has(charlie.userName, documentId)).toBe(false)
  expect(charlie.has(alice.userName, documentId)).toBe(false)

  await teardown()
})

it(`she's disconnected then she's connected again`, async () => {
  // Alice and Bob connect
  const { alice, bob, documentId, teardown } = await setup()
  await allConnected(alice, bob)

  // Alice disconnects
  alice.disconnectServer()
  await allDisconnected(alice, bob)

  // Alice and Bob are disconnected
  expect(alice.has(bob.userName, documentId)).toBe(false)
  expect(bob.has(alice.userName, documentId)).toBe(false)

  // Alice reconnects
  alice.connectToServer()
  alice.join(documentId)
  await allConnected(alice, bob)

  // Alice and Bob are connected again
  expect(alice.has(bob.userName, documentId)).toBe(true)
  expect(bob.has(alice.userName, documentId)).toBe(true)

  await teardown()
})

it("sends a message to a remote peer", async () => {
  const { alice, bob, teardown } = await setup()

  const [aliceSocket, bobSocket] = await allConnected(alice, bob)

  aliceSocket.send(pack("hello"))

  const data = await eventPromise(bobSocket, "message")
  expect(unpack(data)).toEqual("hello")

  await teardown()
})

it("stays open when peer disconnects", async () => {
  const { alice, bob, teardown } = await setup()

  await allConnected(alice, bob)

  expect(alice.open).toBe(true)
  expect(bob.open).toBe(true)

  alice.disconnectPeer(bob.userName)
  expect(alice.open).toBe(true)
  expect(bob.open).toBe(true)

  await teardown()
})

it("closes when server disconnects", async () => {
  const { alice, bob, server, teardown } = await setup()

  await allConnected(alice, bob)

  expect(alice.open).toBe(true)
  expect(bob.open).toBe(true)

  teardown()
  await eventPromise(alice, "server.disconnect")
  expect(alice.open).toBe(false)
})

const allConnected = (a: Client, b: Client, documentId?: DocumentId) =>
  Promise.all([connection(a, b, documentId), connection(b, a, documentId)])

const allDisconnected = (a: Client, b: Client) =>
  Promise.all([disconnection(a, b), disconnection(b, a)])

const connection = (a: Client, b: Client, documentId?: DocumentId) =>
  new Promise<WebSocket>(resolve =>
    a.on("peer.connect", ({ userName, documentId: d, socket }) => {
      if (
        userName === b.userName &&
        // are we waiting to connect on a specific document ID?
        (documentId === undefined || documentId === d)
      )
        resolve(socket)
    })
  )

const disconnection = (a: Client, b: Client) =>
  new Promise<void>(resolve =>
    a.on("peer.disconnect", ({ userName = "" }) => {
      if (userName === b.userName) resolve()
    })
  )

const pause = (t = 100) =>
  new Promise<void>(resolve => setTimeout(() => resolve(), t))
