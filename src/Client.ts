import debug from "debug"
import WebSocket from "isomorphic-ws"
import pkg from "../package.json" assert { type: "json" }
import { EventEmitter } from "./lib/EventEmitter.js"
import { isReady } from "./lib/isReady.js"
import { pack, unpack } from "./lib/msgpack.js"
import { newid } from "./lib/newid.js"
import type {
  ClientEvents,
  ClientOptions,
  DocumentId,
  Message,
  PeerId,
  PeerSocketMap,
} from "./types.js"

const { version } = pkg
const HEARTBEAT = pack({ type: "Heartbeat" })
const HEARTBEAT_INTERVAL = 55000 // 55 seconds

export interface PeerEventPayload {
  peerId: PeerId
  documentId: DocumentId
  socket: WebSocket
}

/**
 * This is a client for `relay` that keeps track of all peers that the server connects you to, and
 * for each peer it keeps track of each documentId (aka discoveryKey, aka channel) that you're
 * working with that peer on.
 *
 * The peers are WebSocket instances.
 *
 * The simplest workflow is something like this:
 *
 * ```ts
 * client = new Client({ peerId: 'my-peer-peerId', url })
 *   .join('my-document-peerId')
 *   .addEventListener('peer-connect', ({documentId, peerId, socket}) => {
 *     // send a message
 *     socket.send('Hello!')
 *
 *     // listen for messages
 *     socket.addEventListener("message", { data } => {
 *       console.log(data)
 *     })
 *   })
 * ```
 */
export class Client extends EventEmitter<ClientEvents> {
  public peerId: PeerId

  /** The base URL of the relay server */
  public url: string

  /** All the document IDs we're interested in */
  public documentIds: Set<DocumentId> = new Set()

  /** All the peers we're connected to. (A 'peer' in this case is actually just a bunch of sockets -
   * one per documentId that we have in common.) */
  public peers: Map<PeerId, PeerSocketMap> = new Map()

  /** When disconnected, the delay in milliseconds before the next retry */
  public retryDelay: number

  /** Is the connection to the server currently open? */
  public open: boolean

  /** If the connection is closed, do we want to reopen it? */
  private shouldReconnectIfClosed: boolean = true

  /** Parameters for retries */
  private minRetryDelay: number
  private maxRetryDelay: number
  private backoffFactor: number

  /** Reference to the heartbeat interval */
  private heartbeat: ReturnType<typeof setInterval>

  private serverConnection: WebSocket
  private pendingMessages: Message.ClientToServer[] = []

  /**
   * @param peerId a string that identifies you uniquely, defaults to a CUID
   * @param url the url of the `relay`, e.g. `http://myrelay.mydomain.com`
   * @param documentIds one or more document IDs that you're interested in
   */
  constructor({
    peerId = newid(),
    url,
    documentIds = [],
    minRetryDelay = 10,
    backoffFactor = 1.5,
    maxRetryDelay = 30000,
  }: ClientOptions) {
    super()
    this.log = debug(`lf:relay:client:${peerId}`)
    this.log("version", version)

    this.peerId = peerId
    this.url = url
    this.minRetryDelay = minRetryDelay
    this.maxRetryDelay = maxRetryDelay
    this.backoffFactor = backoffFactor

    // start out at the initial retry delay
    this.retryDelay = minRetryDelay

    this.connectToServer()
    documentIds.forEach(id => this.join(id))
  }

  // PUBLIC API

  /**
   * Connects to the relay server, lets it know what documents we're interested in
   * @param documentIds array of IDs of documents we're interested in
   * @returns the socket connecting us to the server
   */
  public connectToServer() {
    const url = `${this.url}/introduction/${this.peerId}`
    this.log("connecting to relay server", url)

    this.serverConnection = new WebSocket(url)
    this.serverConnection.binaryType = "arraybuffer"

    this.serverConnection.addEventListener("open", () => {
      this.onServerOpen()
    })
    this.serverConnection.addEventListener("message", event => {
      this.onServerMessage(event)
    })
    this.serverConnection.addEventListener("close", () => {
      this.onServerClose()
    })
    this.serverConnection.addEventListener("error", event => {
      this.onServerError(event)
    })
  }

  /**
   * Lets the server know that you're interested in a document. If there are other peers who have
   * joined the same DocumentId, you and the remote peer will both receive an introduction message,
   * inviting you to connect.
   * @param documentId
   */
  public join(documentId: DocumentId) {
    this.log("joining", documentId)
    this.documentIds.add(documentId)
    const message: Message.Join = { type: "Join", documentIds: [documentId] }
    this.send(message)
    return this
  }

  /**
   * Leaves a documentId and closes any connections related to it
   * @param documentId
   */
  public leave(documentId: DocumentId) {
    this.log("leaving", documentId)
    this.documentIds.delete(documentId)
    for (const [peerId] of this.peers) {
      this.closeSocket(peerId, documentId)
    }
    const message: Message.Leave = { type: "Leave", documentIds: [documentId] }
    this.send(message)
    return this
  }

  /**
   * Disconnects from one peer
   * @param peerPeerId Name of the peer to disconnect. If none is provided, we disconnect all peers.
   */
  public disconnectPeer(peerPeerId: PeerId) {
    this.log(`disconnecting from ${peerPeerId}`)
    const peer = this.get(peerPeerId)
    for (const [documentId] of peer) {
      this.closeSocket(peerPeerId, documentId)
    }
    return this
  }

  /**
   * Disconnects from all peers and from the relay server
   */
  public disconnectServer() {
    this.log(`disconnecting from all peers`)

    // Don't automatically try to reconnect after deliberately disconnecting
    this.shouldReconnectIfClosed = false

    const peersToDisconnect = Array.from(this.peers.keys()) // all of them
    for (const peerId of peersToDisconnect) {
      this.disconnectPeer(peerId)
    }
    this.removeAllListeners()
    this.serverConnection.close()
  }

  public has(peerPeerId: PeerId, documentId?: DocumentId): boolean {
    if (documentId !== undefined) {
      return this.has(peerPeerId) && this.peers.get(peerPeerId)!.has(documentId)
    } else {
      return this.peers.has(peerPeerId)
    }
  }

  public get(peerPeerId: PeerId): PeerSocketMap
  public get(peerPeerId: PeerId, documentId: DocumentId): WebSocket | null
  public get(peerPeerId: PeerId, documentId?: DocumentId) {
    if (documentId !== undefined) {
      return this.get(peerPeerId)?.get(documentId)
    } else {
      // create an entry for this peer if there isn't already one
      if (!this.has(peerPeerId)) this.peers.set(peerPeerId, new Map())
      return this.peers.get(peerPeerId)
    }
  }

  // PRIVATE

  /**
   * When we connect to the server, we set up a heartbeat to keep the connection alive, and we send
   * any pending messages that we weren't able to send before.
   */
  private async onServerOpen() {
    await isReady(this.serverConnection)
    this.retryDelay = this.minRetryDelay
    this.shouldReconnectIfClosed = true
    this.sendPendingMessages()
    this.open = true
    this.heartbeat = setInterval(
      () => this.serverConnection.send(HEARTBEAT),
      HEARTBEAT_INTERVAL
    )
    this.emit("server-connect")
  }

  /**
   * The only kind of message that we receive from the relay server is an introduction, which tells
   * us that someone else is interested in the same thing we are.
   */
  private onServerMessage({ data }: WebSocket.MessageEvent) {
    const message = unpack(data) as Message.ServerToClient

    if (message.type !== "Introduction")
      throw new Error(`Invalid message type '${message.type}'`)

    const { peerId, documentIds = [] } = message
    documentIds.forEach(documentId => {
      this.connectToPeer(documentId, peerId)
    })
  }

  /**
   * When we receive an introduction message, we respond by requesting a "direct" connection to the
   * peer (via piped sockets on the relay server) for each document ID that we have in common
   */
  private connectToPeer(documentId: DocumentId, peerId: PeerId) {
    const peer = this.get(peerId)
    if (peer.has(documentId)) return // don't add twice
    peer.set(documentId, null)

    const url = `${this.url}/connection/${this.peerId}/${peerId}/${documentId}`
    const socket = new WebSocket(url)
    socket.binaryType = "arraybuffer"

    socket.addEventListener("open", async () => {
      // make sure the socket is actually in READY state
      await isReady(socket)
      // add the socket to the map for this peer
      peer.set(documentId, socket)
      this.emit("peer-connect", { peerId, documentId, socket })
    })

    // if the other end disconnects, we disconnect
    socket.addEventListener("close", () => {
      this.closeSocket(peerId, documentId)
      this.emit("peer-disconnect", { peerId, documentId, socket })
    })
  }

  private onServerClose() {
    this.open = false
    this.emit("server-disconnect")
    clearInterval(this.heartbeat)
    if (this.shouldReconnectIfClosed) this.tryToReopen()
  }

  private onServerError({ error }: WebSocket.ErrorEvent) {
    this.emit("error", error)
  }

  /** Send any messages we were given before the server was ready */
  private sendPendingMessages() {
    while (this.pendingMessages.length) {
      const message = this.pendingMessages.shift()!
      this.send(message)
    }
  }

  /** Try to reconnect after a delay  */
  private tryToReopen() {
    setTimeout(() => {
      this.connectToServer()
      this.documentIds.forEach(id => this.join(id))
    }, this.retryDelay)

    // increase the delay for next time
    if (this.retryDelay < this.maxRetryDelay)
      this.retryDelay *= this.backoffFactor + Math.random() * 0.1 - 0.05 // randomly vary the delay

    this.log(
      `Relay connection closed. Retrying in ${Math.floor(
        this.retryDelay / 1000
      )}s`
    )
  }

  /** Send a message to the server */
  private async send(message: Message.ClientToServer) {
    await isReady(this.serverConnection)
    try {
      const msgBytes = pack(message)
      this.serverConnection.send(msgBytes)
    } catch (err) {
      this.pendingMessages.push(message)
    }
  }

  private closeSocket(peerId: PeerId, documentId: DocumentId) {
    const peer = this.get(peerId)
    if (peer.has(documentId)) {
      const socket = peer.get(documentId)
      if (
        socket &&
        socket.readyState !== socket.CLOSED &&
        socket.readyState !== socket.CLOSING
      ) {
        // socket.removeAllListeners()
        socket.close()
      }
      peer.delete(documentId)
    }
  }
}
