import { Server } from '@localfirst/relay'
import debug from 'debug'
import { getPortPromise as getAvailablePort } from 'portfinder'
import { Client, PeerEventPayload } from './Client'
import { PEER } from './constants'

describe('client', () => {
  const log = debug('lf:relay-client:tests')
  let port: number
  let url: string

  let server: Server
  let key: string
  let testId: number = 0
  let aliceId: string
  let bobId: string

  beforeAll(async () => {
    // find a port and set things up
    port = await getAvailablePort({ port: 3000 })
    url = `ws://localhost:${port}`

    server = new Server({ port })
    server.listen({ silent: true })
  })

  beforeEach(() => {
    testId += 1
    aliceId = `alice-${testId}`
    bobId = `bob-${testId}`
    key = `test-key-${testId}`
    log(`TEST ${testId}`)
  })

  afterAll(() => {
    server.close()
  })

  describe('connections', () => {
    const setup = () => {
      const alice = new Client({ id: aliceId, url })
      const bob = new Client({ id: bobId, url })

      alice.join(key)
      bob.join(key)
      return { alice, bob }
    }

    describe('join', () => {
      it('should connect to a peer', async () => {
        const { alice, bob } = setup()

        await Promise.all([
          new Promise<void>((resolve) => {
            alice.on(PEER, ({ id }: PeerEventPayload) => {
              expect(id).toEqual(bobId)
              resolve()
            })
          }),
          new Promise<void>((resolve) => {
            bob.on(PEER, ({ id }: PeerEventPayload) => {
              expect(id).toEqual(aliceId)
              resolve()
            })
          }),
        ])
      })
    })

    describe('leave', () => {
      it('should ', () => {})
    })

    describe('disconnect from one', () => {
      it('should ', () => {})
    })

    describe('disconnect from all', () => {
      it('should ', () => {})
    })

    describe('disconnect then reconnect', () => {
      it('should ', () => {})
    })

    describe('send/receive', () => {
      it('should send a message to a remote peer', (done) => {
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
