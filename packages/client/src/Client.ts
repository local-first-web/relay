import { DocumentId } from '@localfirst/relay'
import debug, { Debugger } from 'debug'
import { EventEmitter } from 'events'
import wsStream, { WebSocketDuplex } from 'websocket-stream'

import { newid } from './newid'

import { UserName, Message } from '@localfirst/relay'

const initialRetryDelay = 100
const backoffCoeff = 1.5 + Math.random() * 0.1
const maxRetryDelay = 30000

type PeerSocketMap = Map<DocumentId, WebSocketDuplex>

/**
 * This is a client for `relay` that keeps track of all peers that the server connects you to, and
 * for each peer it keeps track of each documentId (aka discoveryKey, aka channel) that you're
 * working with that peer on.
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

  /** The base URL of the relay server */
  public url: string

  /** All the DocumentIds we're interested in */
  public documentIds: Set<DocumentId> = new Set()
  public peers: Map<UserName, PeerSocketMap> = new Map()

  private serverConnection: WebSocketDuplex
  private retryDelay: number

  log: Debugger

  /**
   * @param userName a string that identifies you uniquely, defaults to a UUID
   * @param url the url of the `relay`, e.g. `http://myrelay.mydomain.com`
   */
  constructor({ userName = newid(), url, documentIds = [] }: ClientOptions) {
    super()
    this.log = debug(`lf:relay:client:${userName}`)

    this.userName = userName
    this.url = url
    this.retryDelay = initialRetryDelay

    this.connectToServer(documentIds)
  }

  /**
   * Joins a documentId (discoveryKey) to let the server know that you're interested in it. If there
   * are other peers who have joined the same documentId, you and the remote peer will both receive
   * an introduction message, inviting you to connect.
   * @param documentId
   */
  public join(documentId: DocumentId) {
    this.log('joining', documentId)
    this.documentIds.add(documentId)
    this.sendToServer({ type: 'Join', documentIds: [documentId] })
  }

  /**
   * Leaves a documentId and closes any connections
   * @param documentId
   */
  public leave(documentId: DocumentId) {
    this.log('leaving', documentId)
    this.documentIds.delete(documentId)
    for (const [userName] of this.peers) {
      this.removeSocket(userName, documentId)
    }
    this.sendToServer({ type: 'Leave', documentIds: [documentId] })
  }

  /**
   * Disconnects from one or all peers
   * @param userName Name of the peer to disconnect. If none is provided, we disconnect all peers.
   */
  public disconnect(userName?: UserName) {
    const peersToDisconnect = userName
      ? [userName] // just this one
      : Array.from(this.peers.keys()) // all of them

    for (const userName of peersToDisconnect) {
      const peer = this.getPeer(userName)
      for (const [documentId] of peer) {
        this.removeSocket(userName, documentId)
      }
    }
  }

  public has(userName: UserName, documentId: DocumentId) {
    return this.peers.has(userName) && this.peers.get(userName).has(documentId)
  }

  public get(userName: UserName, documentId: DocumentId) {
    return this.peers.get(userName)?.get(documentId)
  }

  ////// PRIVATE

  private connectToServer(documentIds: DocumentId[] = []) {
    const url = `${this.url}/introduction/${this.userName}`
    this.log('connecting to signal server', url)

    this.serverConnection = wsStream(url)
      .on('data', (data: any) => {
        this.log('message from signal server', data)
        const msg = JSON.parse(data.toString()) as Message.ServerToClient
        this.receiveFromServer(msg)
      })
      .on('close', () => {
        // try to reconnect after a delay
        if (this.retryDelay < maxRetryDelay) this.retryDelay *= backoffCoeff
        const retryDelaySeconds = Math.floor(this.retryDelay / 1000)
        this.log(`Relay connection closed. Retrying in ${retryDelaySeconds}s`)
        setTimeout(() => this.connectToServer(documentIds), this.retryDelay)

        this.emit('server.disconnect')
      })
      .on('error', (args: any) => {
        this.log('error', args)
        this.emit('error', args)
      })

    this.retryDelay = initialRetryDelay
    documentIds.forEach(documentId => this.join(documentId))
    this.emit('server.connect')
  }

  private sendToServer(msg: Message.ClientToServer) {
    this.log('sending to server %o', msg)
    this.serverConnection.write(JSON.stringify(msg))
  }

  private receiveFromServer(msg: Message.ServerToClient) {
    // The only kind of message that we receive from the relay server is an introduction, which tells
    // us that someone else is interested in the same thing we are. When we receive that message, we
    // automatically try to connect "directly" to the peer (via piped sockets on the signaling server).
    switch (msg.type) {
      case 'Introduction':
        const { userName, documentIds = [] } = msg
        this.addPeer(userName, documentIds)
        break
      default:
        throw new Error(`Invalid message type '${msg.type}'`)
    }
  }

  private getPeer(userName: UserName) {
    if (!this.peers.has(userName)) this.peers.set(userName, new Map())
    return this.peers.get(userName)
  }

  private addPeer(userName: UserName, documentIds: DocumentId[]) {
    documentIds.forEach(documentId => this.addSocket(userName, documentId))
  }

  private addSocket(userName: UserName, documentId: DocumentId) {
    const peer = this.getPeer(userName)
    if (!peer.has(documentId)) {
      const url = `${this.url}/connection/${this.userName}/${userName}/${documentId}`
      const socket = wsStream(url) //
        .on('close', () => {
          this.removeSocket(userName, documentId)
          this.emit('peer.disconnect', { userName, documentId })
        })
      peer.set(documentId, socket)
      this.emit('peer.connect', { userName, documentId, socket })
    }
  }

  private removeSocket(userName: UserName, documentId: DocumentId) {
    const peer = this.getPeer(userName)
    if (peer.has(documentId)) {
      const socket = peer.get(documentId)
      socket.destroy()
      peer.delete(documentId)
    }
  }
}

export interface PeerEventPayload {
  documentId: DocumentId
  userName: UserName
  socket: WebSocketDuplex
}

export interface ClientOptions {
  /** My user name. If one is not provided, a random one will be created for this session. */
  userName?: UserName

  /** The base URL of the relay server to connect to. */
  url: string

  /** DocumentId(s) to join immediately */
  documentIds?: DocumentId[]
}

// It's normal for a document with a lot of participants to have a lot of connections, so increase
// the limit to avoid spurious warnings about emitter leaks.
EventEmitter.defaultMaxListeners = 500
