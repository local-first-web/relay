import debug from 'debug'
import { EventEmitter } from 'events'
import express from 'express'
import expressWs from 'express-ws'
import { Server as HttpServer, Socket } from 'net'
import wsStream, { WebSocketDuplex } from 'websocket-stream'
import { deduplicate } from './lib/deduplicate'
import { intersection } from './lib/intersection'
import { UserName, ConnectRequestParams, DocumentId, Message } from './types'

const { app } = expressWs(express())

const options = { objectMode: true }
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
 * - **Introductions** (aka discovery): Alice or Bob can provide one or more document documentIds that
 *   they're interested in. If Alice is interested in the same documentId or documentIds as Bob, each will receive
 *   an `Introduction` message with the other's userName. They can then use that information to connect.
 *
 * - **Connection**: Once introduced, Alice can request to connect with Bob on a given document documentId
 *   (can think of it as a 'channel'). If we get matching connection requests from Alice and Bob, we
 *   just pipe their sockets together.
 */
export class Server extends EventEmitter {
  public port: number

  /**
   * In this context:
   * - `userName` is always a peer userName.
   * - `peer` is always a reference to a client's socket connection.
   * - `documentId` is always a document userName (elsewhere referred to as a 'channel' or a 'discovery documentId'.
   */
  public peers: Record<UserName, WebSocketDuplex> = {}
  public documentIds: Record<UserName, DocumentId[]> = {}

  /**
   * For two peers to connect, they both need to send a connection request, specifying both the
   * remote peer userName and the document documentId. When we've gotten the request from Alice but not yet from
   * Bob, we temporarily store a reference to Alice's request in `holding`, and store any
   * messages from Bob in `messages`.
   */
  private holding: Record<UserName, { socket: WebSocketDuplex; messages: any[] }> = {}

  /**
   * Keep these references for cleanup
   */
  private httpServer?: HttpServer
  private httpSockets: Socket[] = []

  private log: debug.Debugger

  constructor({ port = 8080 } = {}) {
    super()
    this.log = debug(`lf:relay:${port}`)
    this.port = port
  }

  // SERVER

  listen({ silent = false }: ListenOptions = {}) {
    // Allow hitting this server from a browser as a sanity check
    app.get('/', (_, res) => res.send(logoPage).end())

    // Introduction request
    app.ws('/introduction/:userName', (ws, { params: { userName } }) => {
      this.log('received introduction request', userName)
      //@ts-ignore
      this.openIntroductionConnection(wsStream(ws, options), userName)
    })

    // Connection request
    app.ws('/connection/:A/:B/:documentId', (ws, { params: { A, B, documentId } }) => {
      this.log('received connection request', A, B)
      //@ts-ignore
      this.openConnection({ socket: wsStream(ws, options), A, B, documentId })
    })

    return (this.httpServer = app
      .listen(this.port, () => {
        if (!silent) console.log(`◆ Listening at http://localhost:${this.port}`)
        this.emit('ready')
      })
      // keep track of sockets for cleanup
      .on('connection', (socket) => this.httpSockets.push(socket)))
  }

  close() {
    this.log('attempting httpServer.close')
    this.httpSockets.forEach((socket) => {
      socket.end()
      socket.destroy()
    })
    return this.httpServer?.close(() => {
      this.log('closed')
      this.emit('close')
    })
  }

  // DISCOVERY

  private openIntroductionConnection(socket: WebSocketDuplex, userName: UserName) {
    this.log('introduction connection', userName)
    this.peers[userName] = socket

    socket.on('data', this.handleIntroductionRequest(userName))
    socket.on('close', this.closeIntroductionConnection(userName))

    this.emit('introductionConnection', userName)
  }

  private handleIntroductionRequest = (userName: UserName) => (data: any) => {
    const A = userName // A and B always refer to peer ids
    const message = JSON.parse(data.toString()) as Message.Join
    this.log('received introduction request %o', message)

    // An introduction request from the client will include a list of documentIds to join.
    // We combine those documentIds with any we already have and deduplicate.
    const { documentIds } = message
    const current = this.documentIds[A] ?? []
    this.documentIds[A] = current.concat(documentIds).reduce(deduplicate, [])

    // if this peer (A) has interests in common with any existing peer (B), introduce them to each other
    for (const B in this.peers) {
      // don't introduce peer to themselves
      if (A === B) continue

      // find documentIds that both peers are interested in
      const commonKeys = intersection(this.documentIds[A], this.documentIds[B])
      if (commonKeys.length) {
        this.log('sending introductions', A, B, commonKeys)
        this.sendIntroduction(A, B, commonKeys)
        this.sendIntroduction(B, A, commonKeys)
      }
    }
  }

  // If we find another peer interested in the same documentId(s), we send both peers an introduction,
  // which they can use to connect
  private sendIntroduction = (A: UserName, B: UserName, documentIds: DocumentId[]) => {
    const message: Message.Introduction = {
      type: 'Introduction',
      userName: B, // the userName of the other peer
      documentIds, // the documentId(s) both are interested in
    }
    this.peers[A]?.write(JSON.stringify(message))
  }

  private closeIntroductionConnection = (userName: UserName) => () => {
    delete this.peers[userName]
    delete this.documentIds[userName]
  }

  // PEER CONNECTIONS

  private openConnection({ socket, A, B, documentId }: ConnectRequestParams) {
    const socketA = socket
    // A and B always refer to peers' userNames.

    // These are string documentIds for identifying this request and the reciprocal request
    // (which may or may not have already come in)
    const AseeksB = `${A}:${B}:${documentId}`
    const BseeksA = `${B}:${A}:${documentId}`

    const holdMessage = (message: any) => this.holding[AseeksB]?.messages.push(message)

    if (this.holding[BseeksA]) {
      // We already have a connection request from Bob; hook them up
      this.log('found peer, connecting', AseeksB)

      const { socket: socketB, messages } = this.holding[BseeksA]

      // Send any stored messages
      messages.forEach((message) => socketA.write(message))

      // Pipe the two sockets together
      socketA.pipe(socketB).pipe(socketA)

      // Don't need to hold the connection or messages any more
      socketA.removeListener('data', holdMessage)
      delete this.holding[BseeksA]
    } else {
      // We haven't heard from Bob yet; hold this connection
      this.log('holding connection for peer', AseeksB)

      // hold Alice's socket ready, and hold any messages Alice sends to Bob in the meantime
      this.holding[AseeksB] = { socket: socketA, messages: [] }

      // hold on to incoming message from Alice for Bob
      socketA.on('data', holdMessage)

      // clean up
      socketA.on('close', () => delete this.holding[AseeksB])
    }
  }
}
