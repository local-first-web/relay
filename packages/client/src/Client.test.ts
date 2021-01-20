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
      const key = `test-key-${testId}`

      const alice = new Client({ id: `alice-${testId}`, url })
      const bob = new Client({ id: `bob-${testId}`, url })
      const charlie = new Client({ id: `charlie-${testId}`, url })

      alice.join(key)
      bob.join(key)
      charlie.join(key)

      return { alice, bob, charlie, key }
    }

    describe('Alice and Bob both join', () => {
      beforeEach(() => {})
      it('joins a key and connects to a peer', async () => {
        const { alice, bob } = setup()
        await connected(alice, bob)

        expect(alice.peers.has(bob.id)).toBe(true)
        expect(bob.peers.has(alice.id)).toBe(true)
      })
    })

    describe('leave', () => {
      it('leaves a key', async () => {
        const { alice, bob, key } = setup()
        await connected(alice, bob)

        expect(alice.peers.has(bob.id)).toBe(true)
        expect(alice.getSocket(bob.id, key)).not.toBeUndefined()
        expect(alice.keys).toContain(key)

        // Alice decides she's no longer interested in this topic
        alice.leave(key)

        expect(alice.peers.has(bob.id)).toBe(true) // still have an entry for Bob
        expect(alice.getSocket(bob.id, key)).toBeUndefined() // but not for this key
        expect(alice.keys).not.toContain(key)
      })
    })

    describe('disconnect from one peer', () => {
      it('disconnects', async () => {
        const { alice, bob } = setup()
        await connected(alice, bob)

        alice.disconnect(bob.id)

        // both are disconnected
        expect(alice.peers.has(bob.id)).toBe(false)
        expect(bob.peers.has(alice.id)).toBe(false)
      })
    })

    describe('disconnect from all peers', () => {
      it('disconnects', async () => {
        const { alice, bob, charlie } = setup()
        await Promise.all([connected(alice, bob), connected(alice, charlie)])

        alice.disconnect()

        expect(alice.peers.has(bob.id)).toBe(false)
        expect(alice.peers.has(charlie.id)).toBe(false)
        expect(bob.peers.has(alice.id)).toBe(false)
        expect(charlie.peers.has(alice.id)).toBe(false)
      })
    })

    describe('disconnect then reconnect', () => {
      it('should ', async () => {
        const { alice, bob, key } = setup()
        await connected(alice, bob)

        // Alice disconnects
        alice.disconnect()

        // Alice reconnects
        alice.join(key)
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
    a.on(PEER, ({ id }) => {
      if (id === b.id) resolve()
    })
  )
