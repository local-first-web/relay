import { EventEmitter } from 'events'
import wsStream, { WebSocketDuplex } from 'websocket-stream'
import { OPEN } from './constants'
import { PeerOptions } from './types'

/**
 * The Peer class holds one or more sockets, one per documentId (aka discoveryKey aka channel).
 * It's not exported from the package and should be treated as private - consumers can
 * get the socket from the 'peer' event payload.
 */
export class Peer extends EventEmitter {
  userName: string
  url: string
  public sockets: Map<string, WebSocketDuplex> = new Map() // documentId -> socket

  constructor({ url, userName }: PeerOptions) {
    super()
    this.url = url
    this.userName = userName
  }

  add(documentId: string) {
    // don't add twice
    if (!this.sockets.has(documentId)) {
      const socket = wsStream(`${this.url}/${this.userName}/${documentId}`)
      this.sockets.set(documentId, socket)
      this.emit(OPEN, { userName: this.userName, documentId, socket })
    }
  }

  has(documentId: string): boolean {
    return this.sockets.has(documentId)
  }

  get(documentId: string) {
    return this.sockets.get(documentId)
  }

  remove(documentId: string) {
    const socket = this.get(documentId)
    if (socket) {
      socket.removeAllListeners()
      socket.end()
      this.sockets.delete(documentId)
    }
  }

  disconnect() {
    for (const documentId in this.sockets) {
      this.remove(documentId)
    }
  }
}
