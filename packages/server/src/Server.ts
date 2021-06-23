import debug from 'debug'
import { EventEmitter } from './EventEmitter'
import express from 'express'
import expressWs from 'express-ws'
import WebSocket from 'ws'
import { Server as HttpServer, Socket } from 'net'
import { deduplicate } from './deduplicate'
import { intersection } from './intersection'
import { UserName, ConnectRequestParams, DocumentId, Message } from './types'
import { pipeSockets } from './pipeSockets'

const { app } = expressWs(express())

const logoPage = `
  <body style="background:black; display:flex; justify-content:center; align-items:center">
    <img src="https://raw.githubusercontent.com/local-first-web/branding/main/svg/relay-v.svg" width="50%" alt="@localfirst/relay logo"/>
  </body>`

interface ListenOptions {
  silent?: boolean
}

/**
 * This server provides two services:
 *
 * - **Introductions** (aka discovery): Alice or Bob can provide one or more document documentIds that
 *   they're interested in. If Alice is interested in the same documentId or documentIds as Bob, each will receive
 *   an `Introduction` message with the other's userName. They can then use that information to connect.
 *
 * - **Connection**: Once introduced, Alice can request to connect with Bob on a given document documentId
 *   (can think of it as a 'channel'). If we get matching connection requests from Alice and Bob, we
 *   just pipe their sockets together.
 */
export class Server extends EventEmitter {
  public port: number

  /**
   * In this context:
   * - `userName` is a peer's userName.
   * - `peer` is always a reference to a client's socket connection.
   * - `documentId` is an identifier for a document or a topic (elsewhere referred to as a 'channel' or a 'discovery key').
   */
  public peers: Record<UserName, WebSocket> = {}
  public documentIds: Record<UserName, DocumentId[]> = {}

  /**
   * For two peers to connect, they both need to send a connection request, specifying both the
   * remote peer userName and the documentId. When we've gotten the request from Alice but not yet from
   * Bob, we temporarily store a reference to Alice's request in `holding`, and store any
   * messages from Bob in `messages`.
   */
  private holding: Record<string, { socket: WebSocket; messages: any[] }> = {}

  /**
   * Keep these references for cleanup
   */
  private httpServer?: HttpServer
  private httpSockets: Socket[] = []

  public log: debug.Debugger

  constructor({ port = 8080 } = {}) {
    super()
    this.log = debug(`lf:relay:${port}`)
    this.port = port
  }

  // SERVER

  listen({ silent = false }: ListenOptions = {}) {
    return new Promise<void>((resolve, reject) => {
      // Allow hitting this server from a browser as a sanity check
      app.get('/', (_, res) => res.send(logoPage).end())

      // Introduction request
      app.ws('/introduction/:userName', (ws, { params: { userName } }) => {
        this.log('received introduction request', userName)
        this.openIntroductionConnection(ws, userName)
      })

      // Connection request
      app.ws('/connection/:A/:B/:documentId', (ws, { params: { A, B, documentId } }) => {
        this.log('received connection request', A, B)
        this.openConnection({ socket: ws, A, B, documentId })
      })

      this.httpServer = app
        .listen(this.port, () => {
          if (!silent) console.log(`🐟 ⯁ Listening at http://localhost:${this.port}`)
          this.emit('ready')
          resolve()
        })
        .on('connection', socket => {
          // keep track of sockets for cleanup
          this.httpSockets.push(socket)
        })
    })
  }

  close() {
    this.log('attempting httpServer.close')
    this.httpSockets.forEach(socket => {
      socket.end()
      socket.destroy()
    })
    return this.httpServer?.close(() => {
      this.emit('close')
    })
  }

  // DISCOVERY

  private openIntroductionConnection(socket: WebSocket, userName: UserName) {
    this.peers[userName] = socket

    socket.on('message', this.handleIntroductionRequest(userName))
    socket.on('close', this.closeIntroductionConnection(userName))

    this.emit('introductionConnection', userName)
  }

  private handleIntroductionRequest = (userName: UserName) => (data: any) => {
    const A = userName // A and B always refer to peer userNames
    const currentDocumentIds = this.documentIds[A] ?? []

    const message = tryParse<Message.ClientToServer>(data.toString())
    if (message instanceof Error) {
      this.emit('error', { error: message, data })
      return
    }

    switch (message.type) {
      case 'Heartbeat':
        // nothing to do
        this.log('♥')
        break

      case 'Join':
        this.log('introduction request: %o', message)
        // An introduction request from the client will include a list of documentIds to join.
        // We combine those documentIds with any we already have and deduplicate.
        this.documentIds[A] = currentDocumentIds.concat(message.documentIds).reduce(deduplicate, [])

        // if this peer (A) has interests in common with any existing peer (B), introduce them to each other
        for (const B in this.peers) {
          // don't introduce peer to themselves
          if (A === B) continue

          // find documentIds that both peers are interested in
          const commonKeys = intersection(this.documentIds[A], this.documentIds[B])
          if (commonKeys.length) {
            this.log('sending introductions', A, B, commonKeys)
            this.sendIntroduction(A, B, commonKeys)
            this.sendIntroduction(B, A, commonKeys)
          }
        }
        break
      case 'Leave':
        // remove the provided documentIds from this peer's list
        this.documentIds[A] = currentDocumentIds.filter(id => !message.documentIds.includes(id))
        break

      default:
        break
    }
  }

  private send(peer: WebSocket, message: Message.ServerToClient) {
    if (peer && peer.readyState === WebSocket.OPEN) {
      try {
        peer.send(JSON.stringify(message))
      } catch (err) {
        console.error('Failed to send message to peer')
      }
    }
  }

  // If we find another peer interested in the same documentId(s), we send both peers an introduction,
  // which they can use to connect
  private sendIntroduction = (A: UserName, B: UserName, documentIds: DocumentId[]) => {
    const message: Message.Introduction = {
      type: 'Introduction',
      userName: B, // the userName of the other peer
      documentIds, // the documentId(s) both are interested in
    }
    let peer = this.peers[A]
    this.send(peer, message)
  }

  private closeIntroductionConnection = (userName: UserName) => () => {
    delete this.peers[userName]
    delete this.documentIds[userName]
  }

  // PEER CONNECTIONS

  private openConnection({ socket, A, B, documentId }: ConnectRequestParams) {
    const socketA = socket
    // A and B always refer to peer userNames.

    // `AseeksB` and `BseeksA` are keys for identifying this request and the reciprocal request
    // (which may or may not have already come in)
    const AseeksB = `${A}:${B}:${documentId}`
    const BseeksA = `${B}:${A}:${documentId}`

    const holdMessage = (message: any) => this.holding[AseeksB]?.messages.push(message)

    if (this.holding[BseeksA]) {
      // We already have a connection request from Bob; hook them up

      const { socket: socketB, messages } = this.holding[BseeksA]

      this.log(`found peer, connecting ${AseeksB} (${messages.length} stored messages)`)
      // Send any stored messages
      messages.forEach(message => this.send(socket, message))

      // Pipe the two sockets together
      pipeSockets(socketA, socketB)

      // Don't need to hold the connection or messages any more
      socketA.removeListener('message', holdMessage)
      delete this.holding[BseeksA]
    } else {
      // We haven't heard from Bob yet; hold this connection
      this.log('holding connection for peer', AseeksB)

      // hold Alice's socket ready, and hold any messages Alice sends to Bob in the meantime
      this.holding[AseeksB] = { socket: socketA, messages: [] }

      socketA
        // hold on to incoming messages from Alice for Bob
        .on('message', holdMessage)
        .on('close', () => delete this.holding[AseeksB])
    }
  }
}

const tryParse = <T>(s: string): T | Error => {
  try {
    return JSON.parse(s)
  } catch (err) {
    if (err instanceof SyntaxError) {
      return new SyntaxError('Message is not valid JSON')
    }
    return err
  }
}
