import debug from 'debug'
import { EventEmitter } from 'events'
import express from 'express'
import expressWs from 'express-ws'
import { Server as HttpServer, Socket } from 'net'
import wsStream from 'websocket-stream'
import { Data } from 'ws'
import * as WebSocket from 'ws'
import { CLOSE, MESSAGE } from './constants'
import { deduplicate } from './lib/deduplicate'
import { intersection } from './lib/intersection'
import { ClientID, ConnectRequestParams, DocumentID, Message } from './types'

const { app } = expressWs(express())

const logoPage = `
  <body style="background:black; display:flex; justify-content:center; align-items:center">
    <img src="https://raw.githubusercontent.com/local-first-web/branding/main/svg/relay-v.svg" width="50%" alt="@localfirst/relay logo"/>
  </body>`

interface ListenOptions {
  silent?: boolean
}

/**
 * This server provides two services:
 *
 * - **Introductions** (aka discovery): Alice or Bob can provide one or more document keys that
 *   they're interested in. If Alice is interested in the same key or keys as Bob, each will receive
 *   an `Introduction` message with the other's id. They can then use that information to connect.
 *
 * - **Connection**: Once introduced, Alice can request to connect with Bob on a given document key
 *   (can think of it as a 'channel'). If we get matching connection requests from Alice and Bob, we
 *   just pipe their sockets together.
 */
export class Server extends EventEmitter {
  public port: number

  /**
   * In this context:
   * - `id` is always a peer id.
   * - `peer` is always a reference to a client's socket connection.
   * - `key` is always a document id (elsewhere referred to as a 'channel' or a 'discovery key'.
   */
  public peers: Record<ClientID, WebSocket> = {}
  public keys: Record<ClientID, DocumentID[]> = {}

  /**
   * For two peers to connect, they both need to send a connection request, specifying both the
   * remote peer id and the document key. When we've gotten the request from Alice but not yet from
   * Bob, we temporarily store a reference to Alice's request in `holding`, and store any
   * messages from Bob in `messages`.
   */
  private holding: Record<ClientID, { socket: WebSocket; messages: Data[] }> = {}

  /**
   * When we start listening, we keep a reference to the `httpServer` so we can close it if asked to.
   */
  private httpServer?: HttpServer

  /**
   * HTTP sockets, tracking for cleanup
   */
  private sockets: Socket[] = []

  private log: debug.Debugger

  constructor({ port = 8080 } = {}) {
    super()
    this.log = debug(`lf:relay:${port}`)
    this.port = port
  }

  // SERVER

  listen({ silent = false }: ListenOptions = {}) {
    return new Promise<void>((resolve) => {
      // Allow hitting this server from a browser as a sanity check
      app.get('/', (_, res) => res.send(logoPage).end())

      // Introduction request
      app.ws('/introduction/:id', (ws, { params: { id } }) => {
        this.log('received introduction request', id)
        this.openIntroductionConnection(ws, id)
      })

      // Connection request
      app.ws('/connection/:A/:B/:key', (ws, { params: { A, B, key } }) => {
        this.log('received connection request', A, B)
        this.openConnection({ socket: ws, A, B, key })
      })

      this.httpServer = app
        .listen(this.port, () => {
          const msg = `◆ Listening at http://localhost:${this.port}`
          if (!silent) console.log(msg)
          this.log(msg)
          this.emit('ready')
          resolve()
        })
        // keep track of sockets for cleanup
        .on('connection', (socket) => this.sockets.push(socket))
    })
  }

  close() {
    return new Promise<void>((resolve) => {
      if (this.httpServer) {
        this.log('attempting httpServer.close')
        this.sockets.forEach((socket) => socket.destroy())
        this.httpServer.close(() => {
          this.log('closed')
          this.emit(CLOSE)
          resolve()
        })
      } else this.log('nothing to close!')
    })
  }

  // DISCOVERY

  private openIntroductionConnection(socket: WebSocket, id: ClientID) {
    this.log('introduction connection', id)
    this.peers[id] = socket

    socket.on(MESSAGE, this.handleIntroductionRequest(id))
    socket.on(CLOSE, this.closeIntroductionConnection(id))

    this.emit('introductionConnection', id)
  }

  private handleIntroductionRequest = (id: ClientID) => (data: Data) => {
    const A = id // A and B always refer to peer ids
    const message = JSON.parse(data.toString()) as Message.Join
    this.log('received introduction request %o', message)

    // An introduction request from the client will include a list of keys to join.
    // We combine those keys with any we already have and deduplicate.
    const { join = [] } = message
    const current = this.keys[A] ?? []
    this.keys[A] = current.concat(join).reduce(deduplicate, [])

    // if this peer (A) has interests in common with any existing peer (B), introduce them to each other
    for (const B in this.peers) {
      // don't introduce peer to themselves
      if (A === B) continue

      // find keys that both peers are interested in
      const commonKeys = intersection(this.keys[A], this.keys[B])
      if (commonKeys.length) {
        this.log('sending introductions', A, B, commonKeys)
        this.sendIntroduction(A, B, commonKeys)
        this.sendIntroduction(B, A, commonKeys)
      }
    }
  }

  // If we find another peer interested in the same key(s), we send both peers an introduction,
  // which they can use to connect
  private sendIntroduction = (A: ClientID, B: ClientID, keys: DocumentID[]) => {
    const message: Message.Introduction = {
      type: 'Introduction',
      id: B, // the id of the other peer
      keys, // the key(s) both are interested in
    }
    this.peers[A]?.send(JSON.stringify(message))
  }

  private closeIntroductionConnection = (id: ClientID) => () => {
    delete this.peers[id]
    delete this.keys[id]
  }

  // PEER CONNECTIONS

  private openConnection({ socket: socketA, A, B, key }: ConnectRequestParams) {
    // A and B always refer to peers' client ids.

    // These are string keys for identifying this request and the reciprocal request
    // (which may or may not have already come in)
    const AseeksB = `${A}:${B}:${key}`
    const BseeksA = `${B}:${A}:${key}`

    const holdMessage = (message: any) => this.holding[AseeksB]?.messages.push(message)

    if (this.holding[BseeksA]) {
      // We already have a connection request from Bob; hook them up
      this.log('found peer, connecting', AseeksB)
      const { socket: socketB, messages } = this.holding[BseeksA]

      // Send any stored messages
      messages.forEach((message) => socketA.send(message))

      // Pipe the two sockets together

      const aStream = wsStream(socketA)
      const bStream = wsStream(socketB)

      aStream.pipe(bStream)
      bStream.pipe(aStream)

      // Don't need to hold the connection or messages any more
      socketA.removeListener(MESSAGE, holdMessage)
      delete this.holding[BseeksA]
    } else {
      // We haven't heard from Bob yet; hold this connection
      this.log('holding connection for peer', AseeksB)

      // hold Alice's socket ready, and hold any messages Alice sends to Bob in the meantime
      this.holding[AseeksB] = { socket: socketA, messages: [] }

      // hold on to incoming message from Alice for Bob
      socketA.on(MESSAGE, holdMessage)

      // clean up
      socketA.on(CLOSE, () => delete this.holding[AseeksB])
    }
  }
}
