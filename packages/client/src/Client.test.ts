import { Server } from '@localfirst/relay'
import { getPortPromise as getAvailablePort } from 'portfinder'
import { Client, PeerEventPayload } from './Client'

describe('client', () => {
  let port: number
  let url: string

  let server: Server
  let testId: number = 0

  beforeAll(async () => {
    // find a port and set things up
    port = await getAvailablePort({ port: 3000 })
    url = `ws://localhost:${port}`

    server = new Server({ port })
    server.listen({ silent: true })
  })

  afterAll(() => {
    server.close()
  })

  describe('connections', () => {
    const setup = () => {
      testId += 1
      const documentId = `test-documentId-${testId}`
      const documentIds = [documentId]

      const alice = new Client({ userName: `alice-${testId}`, url, documentIds })
      const bob = new Client({ userName: `bob-${testId}`, url, documentIds })
      const charlie = new Client({ userName: `charlie-${testId}`, url, documentIds })

      return { alice, bob, charlie, documentId }
    }

    describe('Alice and Bob both join', () => {
      it('joins a documentId and connects to a peer', async () => {
        // Alice and Bob both join a documentId
        const { alice, bob, documentId } = setup()
        await allConnected(alice, bob)

        expect(alice.has(bob.userName, documentId)).toBe(true)
        expect(bob.has(alice.userName, documentId)).toBe(true)
      })
    })

    describe('Alice leaves a document', () => {
      it('leaves a documentId', async () => {
        // Alice and Bob both join a documentId
        const { alice, bob, documentId } = setup()
        await allConnected(alice, bob)

        expect(alice.has(bob.userName, documentId)).toBe(true)
        expect(alice.documentIds).toContain(documentId)

        // Alice decides she's no longer interested in this document
        alice.leave(documentId)

        expect(alice.has(bob.userName, documentId)).toBe(false)
        expect(alice.documentIds).not.toContain(documentId)
      })
    })

    describe('Alice disconnects from Bob', () => {
      it('Bob is disconnected from Alice and vice versa', async () => {
        // Alice and Bob both join a documentId
        const { alice, bob, documentId } = setup()
        await allConnected(alice, bob)

        alice.disconnect(bob.userName)
        await allDisconnected(bob, alice)

        // Bob is disconnected from Alice and vice versa
        expect(alice.has(bob.userName, documentId)).toBe(false)
        expect(bob.has(alice.userName, documentId)).toBe(false)
      })
    })

    describe('Alice disconnects from everyone', () => {
      it('everyone is disconnected from Alice and vice versa', async () => {
        // Alice, Bob, and Charlie all join a documentId
        const { alice, bob, charlie, documentId } = setup()
        await Promise.all([allConnected(alice, bob), allConnected(alice, charlie)])

        // Alice disconnects from everyone
        alice.disconnect()
        await Promise.all([allDisconnected(alice, bob), allDisconnected(alice, charlie)])

        // Bob is disconnected from Alice and vice versa
        expect(alice.has(bob.userName, documentId)).toBe(false)
        expect(bob.has(alice.userName, documentId)).toBe(false)

        // Charlie is disconnected from Alice and vice versa
        expect(alice.has(charlie.userName, documentId)).toBe(false)
        expect(charlie.has(alice.userName, documentId)).toBe(false)
      })
    })

    describe('Alice disconnects then reconnects', () => {
      it(`she's disconnected then she's connected again`, async () => {
        // Alice and Bob connect
        const { alice, bob, documentId } = setup()
        await allConnected(alice, bob)

        // Alice disconnects
        alice.disconnect()
        await allDisconnected(alice, bob)

        // Alice and Bob are disconnectred
        expect(alice.has(bob.userName, documentId)).toBe(false)
        expect(bob.has(alice.userName, documentId)).toBe(false)

        // Alice reconnects
        alice.join(documentId)
        await allConnected(alice, bob)

        // Alice and Bob are connected again
        expect(alice.has(bob.userName, documentId)).toBe(true)
        expect(bob.has(alice.userName, documentId)).toBe(true)
      })
    })

    describe('send/receive', () => {
      it('should send a message to a remote peer', async done => {
        const { alice, bob } = setup()

        alice.on('peer.connect', ({ socket }: PeerEventPayload) => {
          socket.write('hello')
        })

        bob.on('peer.connect', ({ socket }: PeerEventPayload) => {
          socket.on('data', data => {
            expect(data.toString()).toEqual('hello')
            done()
          })
        })
      })
    })
  })
})

const allConnected = (a: Client, b: Client) => Promise.all([connection(a, b), connection(b, a)])
const allDisconnected = (a: Client, b: Client) =>
  Promise.all([disconnection(a, b), disconnection(b, a)])

const connection = (a: Client, b: Client) =>
  new Promise<void>(resolve =>
    a.on('peer.connect', ({ userName }) => {
      if (userName === b.userName) resolve()
    })
  )

const disconnection = (a: Client, b: Client) =>
  new Promise<void>(resolve =>
    a.on('peer.disconnect', ({ userName = '' }) => {
      if (userName === b.userName) resolve()
    })
  )
