import { EventEmitter } from 'events'
import { OPEN } from './constants'
import { PeerOptions } from './types'

/**
 * The Peer class holds one or more sockets, one per key (aka discoveryKey aka channel).
 * To get the socket corresponding to a given key:
 * ```ts
 * const socket = peer.get(key)
 * ```
 *
 * You interact with that socket just like you would any socket:
 * ```ts
 * socket.send('hello!')
 * socket.on(MESSAGE, message => {...})
 * ```
 */
export class Peer extends EventEmitter {
  id: string
  url: string
  private sockets: Map<string, WebSocket> = new Map() // key -> socket

  constructor({ url, id }: PeerOptions) {
    super()
    this.url = url
    this.id = id
  }

  add(key: string) {
    // don't add twice
    if (this.sockets.has(key)) return

    const socket = new WebSocket(`${this.url}/${this.id}/${key}`)
    this.sockets.set(key, socket)

    socket.addEventListener('open', () => this.emit(OPEN, key))
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
      socket.close()
      this.sockets.delete(key)
    }
  }
}
