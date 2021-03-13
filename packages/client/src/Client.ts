import debug, { Debugger } from 'debug'
import { EventEmitter } from 'events'
import { newid } from './newid'
import { DocumentId, Message, UserName } from './types'

type PeerSocketMap = Map<DocumentId, WebSocket>

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
 *     socket.write('Hello!')
 *
 *     // listen for messages
 *     socket.on('data', () => {
 *       console.log(messsage)
 *     })
 *   })
 * ```
 */
export class Client extends EventEmitter {
  public userName: UserName

  /** The base URL of the relay server */
  public url: string

  /** All the DocumentIds we're interested in */
  public documentIds: Set<DocumentId> = new Set()

  /** All the peers we're connected to.
   * (A 'peer' in this case is actually just a bunch of sockets -
   * one per documentId that we have in common.) */
  public peers: Map<UserName, PeerSocketMap> = new Map()

  private serverConnection: WebSocket
  private retryDelay: number

  log: Debugger
  minRetryDelay: number
  maxRetryDelay: number
  backoffFactor: number

  /**
   * @param userName a string that identifies you uniquely, defaults to a UUID
   * @param url the url of the `relay`, e.g. `http://myrelay.mydomain.com`
   */
  constructor({
    userName = newid(),
    url,
    documentIds = [],
    minRetryDelay = 100,
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
   * Joins a documentId (discoveryKey) to let the server know that you're interested in it. If there
   * are other peers who have joined the same documentId, you and the remote peer will both receive
   * an introduction message, inviting you to connect.
   * @param documentId
   */
  public join(documentId: DocumentId) {
    this.log('joining', documentId)
    this.documentIds.add(documentId)
    this.sendToServer({ type: 'Join', documentIds: [documentId] })
    return this
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
    return this
  }

  /**
   * Disconnects from one or all peers
   * @param peerUserName Name of the peer to disconnect. If none is provided, we disconnect all peers.
   */
  public disconnect(peerUserName?: UserName) {
    this.log(`disconnecting from ${peerUserName ?? 'all peers'}`)

    const peersToDisconnect = peerUserName
      ? [peerUserName] // just this one
      : Array.from(this.peers.keys()) // all of them

    for (const userName of peersToDisconnect) {
      const peer = this.getPeer(userName)
      for (const [documentId] of peer) {
        this.removeSocket(userName, documentId)
      }
    }

    return this
  }

  public has(peerUserName: UserName, documentId: DocumentId) {
    return this.peers.has(peerUserName) && this.peers.get(peerUserName).has(documentId)
  }

  public get(peerUserName: UserName, documentId: DocumentId) {
    return this.peers.get(peerUserName)?.get(documentId)
  }

  ////// PRIVATE

  private connectToServer(documentIds: DocumentId[] = []) {
    const url = `${this.url}/introduction/${this.userName}`
    this.log('connecting to relay server', url)

    const socket = new WebSocket(url)

    socket.onopen = () => {
      this.log('connection open')
      this.retryDelay = this.minRetryDelay
      documentIds.forEach(documentId => this.join(documentId))
      this.emit('server.connect')
    }

    socket.onmessage = messageEvent => {
      const { data } = messageEvent
      this.log('message', data)
      const message = JSON.parse(data.toString()) as Message.ServerToClient
      this.receiveFromServer(message)
    }

    socket.onclose = () => {
      this.log('server close')
      this.emit('server.disconnect')
      this.tryToReconnect(documentIds)
    }

    socket.onerror = (args: any) => {
      this.log('error', args)
      this.emit('error', args)
    }

    this.serverConnection = socket
    return this.serverConnection
  }

  private tryToReconnect(documentIds: string[]) {
    setTimeout(() => this.connectToServer(documentIds), this.retryDelay)
    if (this.retryDelay < this.maxRetryDelay)
      this.retryDelay *= this.backoffFactor + Math.random() * 0.1 - 0.05 // randomly vary the delay

    const retryDelaySeconds = Math.floor(this.retryDelay / 1000)
    this.log(`Relay connection closed. Retrying in ${retryDelaySeconds}s`)
  }

  private sendToServer(message: Message.ClientToServer) {
    this.log('sending to server %o', message)
    this.serverConnection.send(JSON.stringify(message))
  }

  private receiveFromServer(message: Message.ServerToClient) {
    if (message.type !== 'Introduction') throw new Error(`Invalid message type '${message.type}'`)

    // The only kind of message that we receive from the relay server is an introduction, which tells
    // us that someone else is interested in the same thing we are. When we receive that message, we
    // automatically try to connect "directly" to the peer (via piped sockets on the relay server).
    const { userName, documentIds = [] } = message
    this.addPeer(userName, documentIds)
  }

  private getPeer(userName: UserName) {
    if (!this.peers.has(userName)) this.peers.set(userName, new Map())
    return this.peers.get(userName)
  }

  private addPeer(userName: UserName, documentIds: DocumentId[]) {
    this.log(`adding peer: ${userName}`)
    documentIds.forEach(documentId => this.addSocket(userName, documentId))
  }

  private addSocket(userName: UserName, documentId: DocumentId) {
    const peer = this.getPeer(userName)
    if (peer.has(documentId)) return // don't add twice

    const socket = new WebSocket(
      `${this.url}/connection/${this.userName}/${userName}/${documentId}`
    )

    socket.onopen = () => {
      peer.set(documentId, socket)
      this.emit('peer.connect', { userName, documentId, socket })
    }

    // if the other end disconnects, we disconnect
    socket.onclose = () => {
      this.log(`peer disconnect: ${userName} ${documentId}`)
      this.removeSocket(userName, documentId)
      this.emit('peer.disconnect', { userName, documentId })
    }
  }

  private removeSocket(userName: UserName, documentId: DocumentId) {
    const peer = this.getPeer(userName)
    if (!peer.has(documentId)) {
      this.log(`socket for ${userName} is already gone`)
      return // can't remove twice
    }

    this.log(`closing socket ${userName}`)
    const socket = peer.get(documentId)
    socket.close()
    peer.delete(documentId)
  }
}

export interface PeerEventPayload {
  documentId: DocumentId
  userName: UserName
  socket: WebSocket
}

export interface ClientOptions {
  /** My user name. If one is not provided, a random one will be created for this session. */
  userName?: UserName

  /** The base URL of the relay server to connect to. */
  url: string

  /** DocumentId(s) to join immediately */
  documentIds?: DocumentId[]

  minRetryDelay?: number
  maxRetryDelay?: number
  backoffFactor?: number
}

// It's normal for a document with a lot of participants to have a lot of connections, so increase
// the limit to avoid spurious warnings about emitter leaks.
EventEmitter.defaultMaxListeners = 500
