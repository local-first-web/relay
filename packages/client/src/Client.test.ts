import { Server } from '@localfirst/relay'
import debug from 'debug'
import { getPortPromise as getAvailablePort } from 'portfinder'
import { Client, PeerEventPayload } from './Client'
import { PEER } from './constants'

describe('Client', () => {
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
    await server.listen({ silent: true })
  })

  beforeEach(() => {
    testId += 1
    aliceId = `alice-${testId}`
    bobId = `bob-${testId}`
    key = `test-key-${testId}`
    log(`TEST ${testId}`)
  })

  afterEach(() => {})

  afterAll(() => {
    server.close()
  })

  describe('Initialization', () => {
    let client: Client

    it('should connect to the discovery server', () => {
      client = new Client({ id: aliceId, url })
      expect(client.serverConnection.url).toContain(`ws://localhost:${port}/introduction/alice`)
    })
  })

  describe('Join', () => {
    let alice: Client
    let bob: Client

    it('should connect to a peer', async () => {
      alice = new Client({ id: aliceId, url })
      bob = new Client({ id: bobId, url })

      alice.join(key)
      bob.join(key)

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

  describe('Send/Receive', () => {
    let alice: Client
    let bob: Client

    it('should send a message to a remote peer', (done) => {
      alice = new Client({ id: aliceId, url })
      bob = new Client({ id: bobId, url })

      alice.join(key)
      bob.join(key)

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
