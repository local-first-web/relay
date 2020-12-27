import wsStream from 'websocket-stream'
import debug from 'debug'
import WebSocket from 'ws'
import { Server } from './Server'
import { getPortPromise as getAvailablePort } from 'portfinder'
import { OPEN } from './constants'
import { MESSAGE } from './constants'

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
    const peer = new WebSocket(`${url}/introduction/${id}`)
    const joinMessage = {
      type: 'Join',
      id,
      join: [key],
    }
    peer.once(OPEN, () => peer.send(JSON.stringify(joinMessage)))
    return peer
  }

  describe('Introduction', () => {
    it('should make a connection', (done) => {
      const { aliceId } = setup()
      server.once('introductionConnection', (id) => {
        expect(id).toEqual(aliceId)
      })

      const alice = new WebSocket(`${url}/introduction/${aliceId}`)

      alice.once(OPEN, () => {
        expect(server.peers).toHaveProperty(aliceId)
        expect(server.keys).toEqual({})
        done()
      })
    })

    it('should invite peers to connect', async () => {
      const { aliceId, bobId, key } = setup()
      const alice = requestIntroduction(aliceId, key)
      const bob = requestIntroduction(bobId, key)

      const aliceDone = new Promise<void>((resolve) => {
        alice.once(MESSAGE, (d) => {
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
        bob.once(MESSAGE, (d) => {
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
    it.only('should pipe connections between two peers', (done) => {
      const { aliceId, bobId, key } = setup()

      const aliceRequest = requestIntroduction(aliceId, key)
      const bobRequest = requestIntroduction(bobId, key) // need to make request even if we don't use the result

      aliceRequest.once(MESSAGE, (d) => {
        // recap of previous test: we'll get an invitation to connect to the remote peer
        const invitation = JSON.parse(d.toString())

        expect(invitation).toEqual({
          type: 'Introduction',
          id: bobId,
          keys: [key],
        })

        const alice = new WebSocket(`${url}/connection/${aliceId}/${bobId}/${key}`)
        const bob = new WebSocket(`${url}/connection/${bobId}/${aliceId}/${key}`)

        // send message from local to remote
        alice.once(OPEN, () => alice.send('DUDE!!'))
        bob.once('message', (data) => {
          expect(data.toString()).toEqual('DUDE!!')
        })

        // send message from remote to local
        bob.once(OPEN, () => bob.send('hello'))
        alice.once('message', (data) => {
          expect(data.toString()).toEqual('hello')
          done()
        })
      })
    })

    it('should close a peer when asked to', (done) => {
      const { aliceId, bobId, key } = setup()

      const aliceRequest = requestIntroduction(aliceId, key)
      const bobRequest = requestIntroduction(bobId, key) // need to make request even if we don't use the result

      aliceRequest.once(MESSAGE, (d) => {
        const alice = new WebSocket(`${url}/connection/${aliceId}/${bobId}/${key}`)
        const bob = new WebSocket(`${url}/connection/${bobId}/${aliceId}/${key}`)

        alice.once(OPEN, () => {
          alice.send('hey bob!')
          // close local after sending
          alice.close()
        })

        bob.once('data', (d) => {
          expect(d).toEqual('hey bob!')

          bob.send('sup alice')
          alice.once('data', (d) => {
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
      const peers = ['a', 'b', 'c', 'd', 'e']
      const expectedIntroductions = factorial(peers.length) / factorial(peers.length - 2) // Permutations of 2

      expect.assertions(expectedIntroductions)

      const ids = peers.map((id) => `peer-${id}-${testId}`)
      const introductionRequests = ids.map((d) => requestIntroduction(d, key))
      let invitations = 0

      introductionRequests.forEach((peer) => {
        peer.on(MESSAGE, (data) => {
          const introduction = JSON.parse(data.toString())
          expect(introduction.type).toBe('Introduction')

          invitations += 1
          if (invitations === expectedIntroductions) done()
        })
      })
    })
  })
})

const factorial = (n: number): number => (n === 1 ? 1 : n * factorial(n - 1))
