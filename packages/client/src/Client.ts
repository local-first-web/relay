import { DocumentId } from '@localfirst/relay'
import debug, { Debugger } from 'debug'
import { EventEmitter } from 'events'
import wsStream, { WebSocketDuplex } from 'websocket-stream'

import { newid } from './newid'

import { UserName, Message } from '@localfirst/relay'

const initialRetryDelay = 100
const backoffCoeff = 1.5 + Math.random() * 0.1
const maxRetryDelay = 30000

/**
 * This is a client for `relay` that makes it easier to interact with it.
 *
 * You don't strictly need to use this client - you can interact directly with the server the way we
 * do in the server tests - but it automates the business of accepting invitations when they're
 * received.
 *
 * The client keeps track of all peers that the server connects you to, and for each peer it keeps
 * track of each documentId (aka discoveryKey, aka channel) that you're working with that peer on.
 *
 * The peers are WebSocket instances
 *
 * The simplest workflow is something like this:
 *
 * ```ts
 * client = new Client({ userName: 'my-peer-userName', url })
 * client.join('my-document-userName')
 * client.on('peer', ({documentId, userName, socket}) => {
 *   // send a message
 *   socket.write('Hello!')
 *
 *   // listen for messages
 *   socket.on('data', () => {
 *     console.log(messsage)
 *   })
 * })
 * ```
 */
export class Client extends EventEmitter {
  public userName: UserName
  public url: string
  public documentIds: Set<DocumentId> = new Set()
  // public peers: Map<UserName, Peer> = new Map()
  public peers: Map<UserName, Map<DocumentId, WebSocketDuplex>> = new Map()

  private serverConnection: WebSocketDuplex
  private retryDelay: number

  log: Debugger

  /**
   * @param userName a string that identifies you uniquely, defaults to a UUID
   * @param url the url of the `relay`, e.g. `http://myrelay.mydomain.com`
   */
  constructor({ userName = newid(), url }: ClientOptions) {
    super()
    this.log = debug(`lf:relay:client:${userName}`)

    this.userName = userName
    this.url = url
    this.retryDelay = initialRetryDelay
    this.serverConnection = this.connectToServer()
  }

  /**
   * Joining a documentId (discoveryKey) lets the server know that you're interested in it, and if there are
   * other peers who have joined the same documentId, you and the remote peer will both receive an
   * introduction message, inviting you to connect.
   * @param documentId
   */
  join(documentId: DocumentId) {
    this.log('joining', documentId)
    this.documentIds.add(documentId)
    this.sendToServer({ type: 'Join', documentIds: [documentId] })
  }

  leave(documentId: DocumentId) {
    this.log('leaving', documentId)
    this.documentIds.delete(documentId)
    // this.peers.forEach((peer) => {
    //   peer.remove(documentId)
    // })
    this.peers.forEach((peer) => {
      if (peer.has(documentId)) {
        const socket = peer.get(documentId)
        socket.destroy()
        peer.delete(documentId)
      }
    })
    this.sendToServer({ type: 'Leave', documentIds: [documentId] })
  }

  disconnect(userName?: UserName) {
    const peers: Map<DocumentId, WebSocketDuplex>[] = userName
      ? [this.peers.get(userName)]
      : Array.from(this.peers.values())
    peers.forEach((peer) => {
      for (const [documentId, socket] of peer) {
        socket.destroy()
        peer.delete(documentId)
      }
    })
  }

  getSocket(userName: UserName, documentId: DocumentId) {
    return this.peers.get(userName)?.get(documentId)
  }

  ////// PRIVATE

  private connectToServer(): WebSocketDuplex {
    const url = `${this.url}/introduction/${this.userName}`
    this.log('connecting to signal server', url)

    const serverConnection = wsStream(url)
      .on('open', () => {
        // successful connection - reset retry delay
        this.retryDelay = initialRetryDelay

        this.sendToServer({ type: 'Join', documentIds: Array.from(this.documentIds) })
        this.emit('server.connect')
      })

      .on('close', () => {
        // try to reconnect after a delay
        if (this.retryDelay < maxRetryDelay) this.retryDelay *= backoffCoeff
        this.log(`Relay connection closed. Retrying in ${Math.floor(this.retryDelay / 1000)}s`)
        setTimeout(() => this.connectToServer(), this.retryDelay)

        this.emit('server.disconnect')
      })

      .on('data', (data: string) => {
        this.log('message from signal server', data)
        const msg = JSON.parse(data.toString()) as Message.ServerToClient

        // The only kind of message that we receive from the relay server is an introduction, which tells
        // us that someone else is interested in the same thing we are. When we receive that message, we
        // automatically try to connect "directly" to the peer (via piped sockets on the signaling server).
        switch (msg.type) {
          case 'Introduction':
            const { userName, documentIds = [] } = msg

            // use existing connection, or connect to peer
            const peer = this.peers.get(userName) ?? new Map<DocumentId, WebSocketDuplex>()
            this.peers.set(userName, peer)

            // identify any documentIds for which we don't already have a connection to this peer
            const newKeys = documentIds.filter((documentId) => !peer.has(documentId))

            // identify any documentIds for which we don't already have a connection to this peer
            newKeys.forEach((documentId) => {
              const url = `${this.url}/connection/${this.userName}/${userName}/${documentId}`
              const socket = wsStream(url) //
                .on('close', () => {
                  peer.delete(documentId)
                  socket.destroy()
                  this.emit('peer.disconnect', { userName, documentId })
                })
              peer.set(documentId, socket)
              this.emit('peer.connect', { userName, documentId, socket })
            })
            break
          default:
            throw new Error(`Invalid message type '${msg.type}'`)
        }
      })

      .on('error', (args: any) => {
        this.log('error', args)
      })

    return serverConnection
  }

  private sendToServer(msg: Message.ClientToServer) {
    this.log('sending to server %o', msg)
    this.serverConnection.write(JSON.stringify(msg))
  }
}

// It's normal for a document with a lot of participants to have a lot of connections, so increase
// the limit to avoid spurious warnings about emitter leaks.
EventEmitter.defaultMaxListeners = 500

export interface PeerEventPayload {
  documentId: DocumentId
  userName: UserName
  socket: WebSocketDuplex
}

export interface ClientOptions {
  userName?: UserName
  url: string
}
