import debug, { Debugger } from 'debug'
import { EventEmitter } from './EventEmitter'
// import TypedEmitter from 'typed-emitter'
import { isReady } from './isReady'
import { newid } from './newid'
import { ClientOptions, DocumentId, Message, PeerSocketMap, UserName } from './types'

const HEARTBEAT = JSON.stringify({ type: 'Heartbeat' })

export interface PeerEventPayload {
  userName: UserName
  documentId: DocumentId
  socket: WebSocket
}

// interface ClientEvents {
//   'server.connect': () => void
//   'server.disconnect': () => void
//   'peer.connect': ({ userName, documentId, socket }: PeerEventPayload) => void
//   'peer.disconnect': ({ userName, documentId, socket }: PeerEventPayload) => void
//   error: (ev: Event) => void
// }

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
 *   .join('my-document-userName')
 *   .on('peer.connect', ({documentId, userName, socket}) => {
 *     // send a message
 *     socket.send('Hello!')
 *
 *     // listen for messages
 *     socket.onmessage = (e) => {
 *       const { data } = e
 *       console.log(data)
 *     }
 *   })
 * ```
 */
export class Client extends EventEmitter {
  //  export class Client extends (EventEmitter as new () => TypedEmitter<ClientEvents>) {
  public userName: UserName

  /** The base URL of the relay server */
  public url: string

  /** All the document IDs we're interested in */
  public documentIds: Set<DocumentId> = new Set()

  /** All the peers we're connected to.
   * (A 'peer' in this case is actually just a bunch of sockets -
   * one per documentId that we have in common.) */
  public peers: Map<UserName, PeerSocketMap> = new Map()

  public log: Debugger

  private serverConnection: WebSocket
  private retryDelay: number

  private minRetryDelay: number
  private maxRetryDelay: number
  private backoffFactor: number
  private heartbeat: ReturnType<typeof setInterval>
  private serverConnectionQueue: Message.ClientToServer[] = []

  /**
   * @param userName a string that identifies you uniquely, defaults to a UUID
   * @param url the url of the `relay`, e.g. `http://myrelay.mydomain.com`
   * @param documentIds one or more document IDs that you're interested in
   */
  constructor({
    userName = newid(),
    url,
    documentIds = [],
    minRetryDelay = 10,
    backoffFactor = 1.5,
    maxRetryDelay = 30000,
  }: ClientOptions) {
    super()
    this.log = debug(`lf:relay:client:${userName}`)

    this.userName = userName
    this.url = url
    this.minRetryDelay = minRetryDelay
    this.maxRetryDelay = maxRetryDelay
    this.backoffFactor = backoffFactor

    // start out at the initial retry delay
    this.retryDelay = minRetryDelay

    this.connectToServer(documentIds)
  }

  /**
   * Lets the server know that you're interested in a document. If there are other peers who have
   * joined the same DocumentId, you and the remote peer will both receive an introduction message,
   * inviting you to connect.
   * @param documentId
   */
  public join(documentId: DocumentId) {
    this.log('joining', documentId)
    this.documentIds.add(documentId)
    const message: Message.Join = { type: 'Join', documentIds: [documentId] }
    this._send(message)
    return this
  }

  /**
   * Leaves a documentId and closes any connections related to it
   * @param documentId
   */
  public leave(documentId: DocumentId) {
    this.log('leaving', documentId)
    this.documentIds.delete(documentId)
    for (const [userName] of this.peers) {
      this.closeSocket(userName, documentId)
    }
    const message: Message.Leave = { type: 'Leave', documentIds: [documentId] }
    this._send(message)
    return this
  }

  /**
   * Disconnects from one peer
   * @param peerUserName Name of the peer to disconnect. If none is provided, we disconnect all peers.
   */
  public disconnectPeer(peerUserName: UserName) {
    this.log(`disconnecting from ${peerUserName}`)
    const peer = this.get(peerUserName)
    for (const [documentId] of peer) {
      this.closeSocket(peerUserName, documentId)
    }
    return this
  }

  /**
   * Disconnects from all peers and from the relay server
   */
  public disconnectServer() {
    this.log(`disconnecting from all peers'}`)
    const peersToDisconnect = Array.from(this.peers.keys()) // all of them
    for (const userName of peersToDisconnect) {
      this.disconnectPeer(userName)
    }
    this.removeAllListeners()
    this.serverConnection.close()
  }

  public has(peerUserName: UserName, documentId?: DocumentId) {
    if (documentId !== undefined) {
      return this.has(peerUserName) && this.peers.get(peerUserName).has(documentId)
    } else {
      return this.peers.has(peerUserName)
    }
  }

  public get(peerUserName: UserName, documentId?: DocumentId) {
    if (documentId !== undefined) {
      return this.get(peerUserName)?.get(documentId)
    } else {
      // create an entry for this peer if there isn't already one
      if (!this.has(peerUserName)) this.peers.set(peerUserName, new Map())
      return this.peers.get(peerUserName)
    }
  }

  // INTERNALS

  /**
   * Connects to the relay server, lets it know what documents we're interested in
   * @param documentIds array of IDs of documents we're interested in
   * @returns the socket connecting us to the server
   */
  private connectToServer(documentIds: DocumentId[] = []) {
    const url = `${this.url}/introduction/${this.userName}`
    this.log('connecting to relay server', url)

    const socket = new WebSocket(url)

    socket.onopen = async () => {
      await isReady(socket)
      this.retryDelay = this.minRetryDelay
      this._drainQueue()
      documentIds.forEach(documentId => this.join(documentId))
      this.emit('server.connect')

      this.heartbeat = setInterval(() => socket.send(HEARTBEAT), 5000)
    }

    socket.onmessage = messageEvent => {
      const { data } = messageEvent
      const message = JSON.parse(data.toString()) as Message.ServerToClient

      // The only kind of message that we receive from the relay server is an introduction, which tells
      // us that someone else is interested in the same thing we are.
      if (message.type !== 'Introduction') throw new Error(`Invalid message type '${message.type}'`)

      // When we receive that message, we respond by requesting a "direct" connection to the peer
      // (via piped sockets on the relay server) for each document ID that we have in common

      const connectToPeer = (documentId: DocumentId, userName: UserName) => {
        const peer = this.get(userName)
        if (peer.has(documentId)) return // don't add twice

        const url = `${this.url}/connection/${this.userName}/${userName}/${documentId}`
        const socket = new WebSocket(url)

        socket.onopen = async () => {
          // make sure the socket is actually in READY state
          await isReady(socket)

          // add the socket to the map for this peer
          peer.set(documentId, socket)

          this.emit('peer.connect', { userName, documentId, socket })
        }

        // if the other end disconnects, we disconnect
        socket.onclose = () => {
          this.closeSocket(userName, documentId)
          this.emit('peer.disconnect', { userName, documentId, socket })
        }
      }

      const { userName, documentIds = [] } = message
      documentIds.forEach(documentId => connectToPeer(documentId, userName))
    }

    socket.onclose = () => {
      this.emit('server.disconnect')

      // stop heartbeat
      clearInterval(this.heartbeat)

      // try to reconnect after a delay
      setTimeout(() => this.connectToServer(documentIds), this.retryDelay)

      // increase the delay for next time
      if (this.retryDelay < this.maxRetryDelay)
        this.retryDelay *= this.backoffFactor + Math.random() * 0.1 - 0.05 // randomly vary the delay

      this.log(`Relay connection closed. Retrying in ${Math.floor(this.retryDelay / 1000)}s`)
    }

    socket.onerror = (ev: Event) => {
      this.emit('error', ev)
    }

    this.serverConnection = socket
    return this.serverConnection
  }

  private _drainQueue() {
    while (this.serverConnectionQueue.length) {
      let message = this.serverConnectionQueue.pop()
      this._send(message)
    }
  }

  private _send(message: Message.ClientToServer) {
    try {
      this.serverConnection.send(JSON.stringify(message))
    } catch (err) {
      this.serverConnectionQueue.push(message)
    }
  }

  private closeSocket(userName: UserName, documentId: DocumentId) {
    const peer = this.get(userName)
    if (peer.has(documentId)) {
      const socket = peer.get(documentId)
      if (socket && socket.readyState !== socket.CLOSED && socket.readyState !== socket.CLOSING)
        socket.close()
      peer.delete(documentId)
    }
  }
}

// It's normal for a document with a lot of participants to have a lot of connections, so increase
// the limit to avoid spurious warnings about emitter leaks.
// EventEmitter.defaultMaxListeners = 500
