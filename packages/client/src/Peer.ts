import Debug from 'debug'
import { EventEmitter } from 'events'
import { CLOSE, OPEN } from './constants'
import { PeerOptions } from './types'

const log = Debug('lf:relay-client:peer')

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
  private keys: Map<string, WebSocket> = new Map() // key -> socket

  constructor({ url, id }: PeerOptions) {
    super()
    this.url = url
    this.id = id
  }

  add(key: string) {
    // don't add twice
    if (this.keys.has(key)) return

    const id = this.id
    const url = `${this.url}/${id}/${key}`

    const socket = new WebSocket(url)
    this.keys.set(key, socket)

    const onopen = () => {
      log(OPEN, key)
      this.emit(OPEN, key)
    }
    socket.onopen = onopen.bind(this)

    const onclose = () => {
      log('socket.onclose')
      this.emit(CLOSE)
      this.remove(key)
    }
    socket.onclose = onclose.bind(this)

    const onerror = ({ err }: any) => {
      log('socket.onerror %s', err)
    }
    socket.onerror = onerror.bind(this)
  }

  has(key: string): boolean {
    return this.keys.has(key)
  }

  get(key: string) {
    return this.keys.get(key)
  }

  close(key: string) {
    const socket = this.get(key)
    if (socket) {
      log('%s closing socket: %s', this.id, key)
      socket.close()
      this.keys.delete(key)
    }
  }

  remove(key: string) {
    log('%s removing connection: %s', this.id, key)
    this.keys.delete(key)
  }
}
