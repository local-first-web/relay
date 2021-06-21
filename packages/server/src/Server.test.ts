import { Server } from './Server'
import { getPortPromise as getAvailablePort } from 'portfinder'
import { Message } from 'types'
import WebSocket from 'ws'

// const log = debug('lf:relay:tests')

/**
 * In this context:
 * - `userName` is always a peer userName.
 * - `peer` is always a reference to a client's socket connection.
 * - `documentId` is always a document userName (elsewhere referred to as a 'channel' or a 'discovery documentId'.
 */
describe('Server', () => {
  let testId = 0
  let url: string
  let server: Server

  beforeAll(async () => {
    // find a port and set things up
    const port = await getAvailablePort({ port: 3100 })
    url = `ws://localhost:${port}`

    server = new Server({ port })
    await server.listen({ silent: true })
  })

  const setup = () => {
    testId += 1
    const aliceId = `alice-${testId}`
    const bobId = `bob-${testId}`
    const documentId = `test-documentId-${testId}`
    return { aliceId, bobId, documentId }
  }

  afterAll(() => {
    server.close()
  })

  const requestIntroduction = (userName: string, documentId: string) => {
    const peer = new WebSocket(`${url}/introduction/${userName}`)
    const joinMessage: Message.Join = {
      type: 'Join',
      documentIds: [documentId],
    }
    peer.once('open', () => peer.send(JSON.stringify(joinMessage)))
    return peer
  }

  describe('Introduction', () => {
    it('should make a connection', done => {
      const { aliceId } = setup()

      server.on('introductionConnection', userName => {
        expect(userName).toEqual(aliceId)
        expect(server.peers).toHaveProperty(aliceId)
        expect(server.documentIds).toEqual({})
        done()
      })

      // make a connection
      const alice = new WebSocket(`${url}/introduction/${aliceId}`)
    })

    it('should invite peers to connect', async () => {
      const { aliceId, bobId, documentId } = setup()
      const alice = requestIntroduction(aliceId, documentId)
      const bob = requestIntroduction(bobId, documentId)

      const aliceDone = new Promise<void>(resolve => {
        alice.once('message', d => {
          const invitation = JSON.parse(d.toString())
          expect(invitation).toEqual({
            type: 'Introduction',
            userName: bobId,
            documentIds: [documentId],
          })
          resolve()
        })
      })
      const bobDone = new Promise<void>(resolve => {
        bob.on('message', d => {
          const invitation = JSON.parse(d.toString())
          expect(invitation).toEqual({
            type: 'Introduction',
            userName: aliceId,
            documentIds: [documentId],
          })
          resolve()
        })
      })
      await bobDone
      // await Promise.all([aliceDone, bobDone])
    })
  })

  describe('Peer connections', () => {
    it('should pipe connections between two peers', done => {
      const { aliceId, bobId, documentId } = setup()

      const aliceRequest = requestIntroduction(aliceId, documentId)
      const _bobRequest = requestIntroduction(bobId, documentId) // need to make request even if we don't use the result

      aliceRequest.once('message', d => {
        // recap of previous test: we'll get an invitation to connect to the remote peer
        const invitation = JSON.parse(d.toString())

        expect(invitation).toEqual({
          type: 'Introduction',
          userName: bobId,
          documentIds: [documentId],
        })

        const alice = new WebSocket(`${url}/connection/${aliceId}/${bobId}/${documentId}`)
        const bob = new WebSocket(`${url}/connection/${bobId}/${aliceId}/${documentId}`)

        // send message from local to remote
        alice.once('open', () => alice.send('DUDE!!'))
        bob.once('message', data => {
          expect(data.toString()).toEqual('DUDE!!')
        })

        // send message from remote to local
        bob.once('open', () => bob.send('hello'))
        alice.once('message', data => {
          expect(data.toString()).toEqual('hello')
          done()
        })
      })
    })

    it('should close a peer when asked to', done => {
      const { aliceId, bobId, documentId } = setup()

      const aliceRequest = requestIntroduction(aliceId, documentId)
      const _bobRequest = requestIntroduction(bobId, documentId) // need to make request even if we don't use the result

      aliceRequest.once('message', d => {
        const alice = new WebSocket(`${url}/connection/${aliceId}/${bobId}/${documentId}`)
        const bob = new WebSocket(`${url}/connection/${bobId}/${aliceId}/${documentId}`)

        alice.once('open', () => {
          alice.send('hey bob!')
          alice.close()
        })

        bob.once('message', d => {
          expect(d.toString()).toEqual('hey bob!')

          bob.send('sup alice')
          alice.once('message', () => {
            throw new Error('should never get here')
          })
          done()
        })
      })
    })
  })

  describe('N-way', () => {
    it('Should make introductions between all the peers', done => {
      const { documentId } = setup()
      let introductions = 0
      const peers = ['a', 'b', 'c', 'd', 'e']

      const expectedIntroductions = factorial(peers.length) / factorial(peers.length - 2) // Permutations of 2

      const userNames = peers.map(userName => `peer-${userName}-${testId}`)

      const sockets = userNames.map(
        (userName: string) => new WebSocket(`${url}/introduction/${userName}`)
      )

      sockets.forEach((socket: WebSocket) => {
        socket.onmessage = event => {
          const { data } = event
          const message = JSON.parse(data.toString())
          expect(message.type).toBe('Introduction')

          introductions += 1
          if (introductions === expectedIntroductions) done()
        }
      })

      const joinMessage = { type: 'Join', documentIds: [documentId] }
      sockets.forEach(async (socket: WebSocket) => {
        socket.onopen = () => {
          socket.send(JSON.stringify(joinMessage))
        }
      })
    })
  })

  describe('Handle errors gracefully', () => {
    it('Should not crash when peer disconnects mid-introduction', done => {
      const { documentId } = setup()
      let introductions = 0
      const peers = ['a', 'b', 'c', 'd', 'e']

      const userNames = peers.map(userName => `peer-${userName}-${testId}`)

      const expectedIntroductions = 4

      const sockets = userNames.map(
        (userName: string) => new WebSocket(`${url}/introduction/${userName}`)
      )

      sockets.forEach((socket: WebSocket) => {

        socket.onopen = () => {
          socket.send('malicious client can crash you :)')
        }

        socket.onmessage = event => {
          const { data } = event
          const message = JSON.parse(data.toString())
          expect(message.type).toBe('Introduction')

          introductions += 1
          if (introductions === expectedIntroductions) done()
        }
      })

      const joinMessage = { type: 'Join', documentIds: [documentId] }
      sockets.forEach(async (socket: WebSocket) => {
        socket.onopen = () => {
          socket.send(JSON.stringify(joinMessage))
          if (introductions === 0) socket.close()
        }
      })
    })
  })
})

const factorial = (n: number): number => (n === 1 ? 1 : n * factorial(n - 1))
