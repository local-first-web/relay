import debug, { Debugger } from 'debug'
import { EventEmitter } from 'events'
import { WebSocketDuplex } from 'websocket-stream'
import { CLOSE, OPEN, PEER } from './constants'
import { newid } from './newid'

import { Peer } from './Peer'
import { ClientOptions, Message } from './types'

const initialRetryDelay = 1000
const backoffCoeff = 1.5 + Math.random() * 0.1

/**
 * This is a client for `relay` that makes it easier to interact with it.
 *
 * You don't strictly need to use this client - you can interact directly with the server the way we
 * do in the server tests - but it automates the business of accepting invitations when they're
 * received.
 *
 * The client keeps track of all peers that the server connects you to, and for each peer it keeps
 * track of each key (aka discoveryKey, aka channel) that you're working with that peer on.
 *
 * The peers are WebSocket instances
 *
 * The simplest workflow is something like this:
 *
 * ```ts
 * client = new Client({ id: 'my-peer-id', url })
 * client.join('my-document-id')
 * client.on(peer, (peer, key) => {
 *   const socket = peer.get(key) // `socket` is a WebSocket instance
 *
 *   // send a message
 *   socket.send('Hello!')
 *
 *   // listen for messages
 *   socket.onmessage = () => {
//  *     console.log(messsage)
 *   }
 * })
 * ```
 */
export class Client extends EventEmitter {
  public id: string
  public url: string
  public keys: Set<string> = new Set()
  public serverConnection: WebSocket

  private peers: Map<string, Peer> = new Map()
  private retryDelay: number

  log: Debugger

  /**
   * @param id a string that identifies you uniquely, defaults to a UUID
   * @param url the url of  the `relay`, e.g. `http://signal.mydomain.com`
   */
  constructor({ id = newid(), url }: ClientOptions) {
    super()
    this.log = debug(`lf:relay-client:${id}`)

    this.id = id
    this.url = url
    this.retryDelay = initialRetryDelay
    this.serverConnection = this.connectToServer() // this is a WebSocket
  }

  // Joining a key (discoveryKey) lets the server know that you're interested in it, and if there are
  // other peers who have joined the same key, you and the remote peer will both receive an
  // introduction message, inviting you to connect.
  join(key: string) {
    this.log('joining', key)

    this.keys.add(key)

    this.sendToServer({
      type: 'Join',
      join: [key],
    })
  }

  getSocket(id: string, key: string) {
    return this.peers.get(id).get(key)
  }

  ////// PRIVATE

  private connectToServer(): WebSocket {
    const url = `${this.url}/introduction/${this.id}`

    this.log('connecting to signal server', url)

    this.serverConnection = new WebSocket(url)

    const onopen = () => {
      // successful connection - reset retry delay
      this.retryDelay = initialRetryDelay

      this.sendToServer({
        type: 'Join',
        join: [...this.keys],
      })
      this.emit(OPEN)
    }
    this.serverConnection.onopen = onopen.bind(this)

    const onclose = () => {
      this.retryDelay *= backoffCoeff
      const retryDelaySeconds = Math.floor(this.retryDelay / 1000)
      this.log(`signal server connection closed... retrying in ${retryDelaySeconds}s`)
      setTimeout(() => this.connectToServer(), this.retryDelay)
      this.emit(CLOSE)
    }
    this.serverConnection.onclose = onclose.bind(this)

    const onmessage = ({ data }: { data: string }) => {
      this.log('message from signal server', data)
      const message = JSON.parse(data.toString()) as Message.ServerToClient
      this.receiveFromServer(message)
    }
    this.serverConnection.onmessage = onmessage.bind(this)

    const onerror = (args: any) => {
      this.log('signal server error', args)
    }
    this.serverConnection.onerror = onerror.bind(this)

    return this.serverConnection
  }

  private sendToServer(msg: Message.ClientToServer) {
    if (this.serverConnection.readyState === WebSocket.OPEN) {
      this.log('sending to server %o', msg)
      this.serverConnection.send(JSON.stringify(msg))
    }
  }

  // The only kind of message that we receive from the signal server is an introduction, which tells
  // us that someone else is interested in the same thing we are. When we receive that message, we
  // automatically try to connect "directly" to the peer (via piped sockets on the signaling server).
  private receiveFromServer(msg: Message.ServerToClient) {
    this.log('received from signal server %o', msg)
    switch (msg.type) {
      case 'Introduction':
        const { id, keys = [] } = msg

        // use existing connection, or connect to peer
        const peer = this.peers.get(id) ?? this.connectToPeer(id)

        // identify any keys for which we don't already have a connection to this peer
        const newKeys = keys.filter((key) => !peer.has(key))
        newKeys.forEach((key) => {
          peer.on(OPEN, (peerKey) => {
            this.log('found peer', id, peerKey)
            const socket = peer.get(key)
            this.emit(PEER, { key, id, socket } as PeerEventPayload)
          })
          peer.add(key)
        })
        break
      default:
        throw new Error(`Invalid message type '${msg.type}'`)
    }
  }

  private connectToPeer(id: string): Peer {
    this.log('requesting direct connection to peer', id)
    const url = `${this.url}/connection/${this.id}` // remaining parameters are added by peer
    const peer = new Peer({ url, id })
    this.peers.set(id, peer)
    return peer
  }
}

// It's normal for a document with a lot of participants to have a lot of connections, so increase
// the limit to avoid spurious warnings about emitter leaks.
EventEmitter.defaultMaxListeners = 500

export interface PeerEventPayload {
  key: string
  id: string
  socket: WebSocketDuplex
}
