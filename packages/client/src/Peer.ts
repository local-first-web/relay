import { EventEmitter } from 'events'
import wsStream, { WebSocketDuplex } from 'websocket-stream'
import { OPEN } from './constants'
import { PeerOptions } from './types'

/**
 * The Peer class holds one or more sockets, one per key (aka discoveryKey aka channel).
 * It's not exported from the package and should be treated as private - consumers can
 * get the appropriate port from
 */
export class Peer extends EventEmitter {
  id: string
  url: string
  private sockets: Map<string, WebSocketDuplex> = new Map() // key -> socket

  constructor({ url, id }: PeerOptions) {
    super()
    this.url = url
    this.id = id
  }

  add(key: string) {
    // don't add twice
    if (!this.sockets.has(key)) {
      const socket = wsStream(`${this.url}/${this.id}/${key}`)
      this.sockets.set(key, socket)
      this.emit(OPEN, key)
    }
  }

  has(key: string): boolean {
    return this.sockets.has(key)
  }

  get(key: string) {
    return this.sockets.get(key)
  }

  remove(key: string) {
    const socket = this.get(key)
    if (socket) {
      socket.end()
      socket.destroy()
      this.sockets.delete(key)
    }
  }
}
