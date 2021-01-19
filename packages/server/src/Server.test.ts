import wsStream, { WebSocketDuplex } from 'websocket-stream'
import { Server } from './Server'
import { getPortPromise as getAvailablePort } from 'portfinder'
import { Message } from 'types'

// const log = debug('lf:relay:tests')

/**
 * In this context:
 * - `id` is always a peer id.
 * - `peer` is always a reference to a client's socket connection.
 * - `key` is always a document id (elsewhere referred to as a 'channel' or a 'discovery key'.
 */
describe('Server', () => {
  let port: number
  let url: string
  let server: Server
  let testId = 0

  beforeAll(async () => {
    // find a port and set things up
    port = await getAvailablePort({ port: 3100 })
    url = `ws://localhost:${port}`

    server = new Server({ port })
    server.listen({ silent: true })
  })

  const setup = () => {
    testId += 1
    const aliceId = `alice-${testId}`
    const bobId = `bob-${testId}`
    const key = `test-key-${testId}`
    return { aliceId, bobId, key }
  }

  afterAll(() => {
    server.close()
  })

  const requestIntroduction = (id: string, key: string) => {
    const peer = wsStream(`${url}/introduction/${id}`)
    const joinMessage: Message.Join = {
      type: 'Join',
      keys: [key],
    }
    peer.write(JSON.stringify(joinMessage))
    return peer
  }

  describe('Introduction', () => {
    it('should make a connection', (done) => {
      const { aliceId } = setup()

      server.once('introductionConnection', (id) => {
        expect(id).toEqual(aliceId)
        expect(server.peers).toHaveProperty(aliceId)
        expect(server.keys).toEqual({})
        done()
      })

      // make a connection
      const alice = wsStream(`${url}/introduction/${aliceId}`)
    })

    it('should invite peers to connect', async () => {
      const { aliceId, bobId, key } = setup()
      const alice = requestIntroduction(aliceId, key)
      const bob = requestIntroduction(bobId, key)

      const aliceDone = new Promise<void>((resolve) => {
        alice.once('data', (d) => {
          const invitation = JSON.parse(d.toString())
          expect(invitation).toEqual({
            type: 'Introduction',
            id: bobId,
            keys: [key],
          })
          resolve()
        })
      })
      const bobDone = new Promise<void>((resolve) => {
        bob.once('data', (d) => {
          const invitation = JSON.parse(d.toString())
          expect(invitation).toEqual({
            type: 'Introduction',
            id: aliceId,
            keys: [key],
          })
          resolve()
        })
      })
      await Promise.all([aliceDone, bobDone])
    })
  })

  describe('Peer connections', () => {
    it('should pipe connections between two peers', (done) => {
      expect.assertions(3)

      const { aliceId, bobId, key } = setup()

      const aliceRequest = requestIntroduction(aliceId, key)
      const _bobRequest = requestIntroduction(bobId, key) // need to make request even if we don't use the result

      aliceRequest.once('data', (d) => {
        // recap of previous test: we'll get an invitation to connect to the remote peer
        const invitation = JSON.parse(d.toString())

        expect(invitation).toEqual({
          type: 'Introduction',
          id: bobId,
          keys: [key],
        })

        const alice = wsStream(`${url}/connection/${aliceId}/${bobId}/${key}`)
        const bob = wsStream(`${url}/connection/${bobId}/${aliceId}/${key}`)

        // send message from local to remote
        alice.write('DUDE!!')
        bob.once('data', (data) => {
          expect(data.toString()).toEqual('DUDE!!')
        })

        // send message from remote to local
        bob.write('hello')
        alice.once('data', (data) => {
          expect(data.toString()).toEqual('hello')
          done()
        })
      })
    })

    it('should close a peer when asked to', (done) => {
      expect.assertions(1)

      const { aliceId, bobId, key } = setup()

      const aliceRequest = requestIntroduction(aliceId, key)
      const _bobRequest = requestIntroduction(bobId, key) // need to make request even if we don't use the result

      aliceRequest.once('data', (d) => {
        const alice = wsStream(`${url}/connection/${aliceId}/${bobId}/${key}`)
        const bob = wsStream(`${url}/connection/${bobId}/${aliceId}/${key}`)

        alice.write('hey bob!')
        // close local after sending
        alice.end()

        bob.once('data', (d) => {
          expect(d.toString()).toEqual('hey bob!')

          bob.write('sup alice')
          alice.once('data', () => {
            throw new Error('should never get here')
          })
          done()
        })
      })
    })
  })

  describe('N-way', () => {
    it('Should make introductions between all the peers', (done) => {
      const { key } = setup()
      let introductions = 0
      const peers = ['a', 'b', 'c', 'd', 'e']

      const expectedIntroductions = factorial(peers.length) / factorial(peers.length - 2) // Permutations of 2

      expect.assertions(expectedIntroductions)

      const ids = peers.map((id) => `peer-${id}-${testId}`)
      const sockets = ids.map((id: string) => wsStream(`${url}/introduction/${id}`))

      sockets.forEach((socket: WebSocketDuplex) => {
        socket.on('data', (data) => {
          try {
            const message = JSON.parse(data.toString())
            expect(message.type).toBe('Introduction')
          } catch (e) {}

          introductions += 1

          if (introductions === expectedIntroductions) done()
        })
      })
      sockets.forEach(async (socket: WebSocketDuplex) => {
        const joinMessage = { type: 'Join', keys: [key] }
        socket.write(JSON.stringify(joinMessage))
      })
    })
  })
})

const factorial = (n: number): number => (n === 1 ? 1 : n * factorial(n - 1))
