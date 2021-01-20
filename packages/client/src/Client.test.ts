import { Server } from '@localfirst/relay'
import { getPortPromise as getAvailablePort } from 'portfinder'
import { Client, PeerEventPayload } from './Client'
import { PEER } from './constants'

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

      const alice = new Client({ userName: `alice-${testId}`, url })
      const bob = new Client({ userName: `bob-${testId}`, url })
      const charlie = new Client({ userName: `charlie-${testId}`, url })

      alice.join(documentId)
      bob.join(documentId)
      charlie.join(documentId)

      return { alice, bob, charlie, documentId }
    }

    describe('Alice and Bob both join', () => {
      beforeEach(() => {})
      it('joins a documentId and connects to a peer', async () => {
        const { alice, bob } = setup()
        await connected(alice, bob)

        expect(alice.peers.has(bob.userName)).toBe(true)
        expect(bob.peers.has(alice.userName)).toBe(true)
      })
    })

    describe('leave', () => {
      it('leaves a documentId', async () => {
        const { alice, bob, documentId } = setup()
        await connected(alice, bob)

        expect(alice.peers.has(bob.userName)).toBe(true)
        expect(alice.getSocket(bob.userName, documentId)).not.toBeUndefined()
        expect(alice.documentIds).toContain(documentId)

        // Alice decides she's no longer interested in this topic
        alice.leave(documentId)

        expect(alice.peers.has(bob.userName)).toBe(true) // still have an entry for Bob
        expect(alice.getSocket(bob.userName, documentId)).toBeUndefined() // but not for this documentId
        expect(alice.documentIds).not.toContain(documentId)
      })
    })

    describe('disconnect from one peer', () => {
      it('disconnects', async () => {
        const { alice, bob } = setup()
        await connected(alice, bob)

        alice.disconnect(bob.userName)

        // both are disconnected
        expect(alice.peers.has(bob.userName)).toBe(false)
        expect(bob.peers.has(alice.userName)).toBe(false)
      })
    })

    describe('disconnect from all peers', () => {
      it('disconnects', async () => {
        const { alice, bob, charlie } = setup()
        await Promise.all([connected(alice, bob), connected(alice, charlie)])

        alice.disconnect()

        expect(alice.peers.has(bob.userName)).toBe(false)
        expect(alice.peers.has(charlie.userName)).toBe(false)
        expect(bob.peers.has(alice.userName)).toBe(false)
        expect(charlie.peers.has(alice.userName)).toBe(false)
      })
    })

    describe('disconnect then reconnect', () => {
      it('should ', async () => {
        const { alice, bob, documentId } = setup()
        await connected(alice, bob)

        // Alice disconnects
        alice.disconnect()

        // Alice reconnects
        alice.join(documentId)
      })
    })

    describe('send/receive', () => {
      it('should send a message to a remote peer', async (done) => {
        const { alice, bob } = setup()

        alice.on(PEER, ({ socket }: PeerEventPayload) => {
          socket.write('hello')
        })

        bob.on(PEER, ({ socket }: PeerEventPayload) => {
          socket.on('data', (data) => {
            expect(data.toString()).toEqual('hello')
            done()
          })
        })
      })
    })
  })
})

const connected = (a: Client, b: Client) => Promise.all([connection(a, b), connection(b, a)])

const connection = (a: Client, b: Client) =>
  new Promise<void>((resolve) =>
    a.on(PEER, ({ userName }) => {
      if (userName === b.userName) resolve()
    })
  )
