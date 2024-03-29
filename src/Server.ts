import debug from "debug"
import express from "express"
import expressWs, { Application } from "express-ws"
import WebSocket, { WebSocketServer } from "ws"
import { pack, unpack } from "msgpackr"
import pkg from "../package.json" assert { type: "json" }
import { EventEmitter } from "./lib/EventEmitter.js"
import { deduplicate } from "./lib/deduplicate.js"
import { intersection } from "./lib/intersection.js"
import { pipeSockets } from "./lib/pipeSockets.js"
import {
  ConnectRequestParams,
  DocumentId,
  Message,
  ServerEvents,
  PeerId,
} from "./types.js"

/**
 * This server provides two services:
 *
 * - **Introductions** (aka discovery): Alice or Bob can provide one or more document documentIds that
 *   they're interested in. If Alice is interested in the same documentId or documentIds as Bob, each will receive
 *   an `Introduction` message with the other's peerId. They can then use that information to connect.
 *
 * - **Connection**: Once introduced, Alice can request to connect with Bob on a given document documentId
 *   (can think of it as a 'channel'). If we get matching connection requests from Alice and Bob, we
 *   just pipe their sockets together.
 */
export class Server extends EventEmitter<ServerEvents> {
  public port: number

  /**
   * In this context:
   * - `peerId` is a peer's peerId.
   * - `peer` is always a reference to a client's socket connection.
   * - `documentId` is an identifier for a document or a topic (elsewhere referred to as a 'channel' or a 'discovery key').
   */
  public peers: Record<PeerId, WebSocket> = {}
  public documentIds: Record<PeerId, DocumentId[]> = {}

  /**
   * For two peers to connect, they both need to send a connection request, specifying both the
   * remote peer peerId and the documentId. When we've gotten the request from Alice but not yet from
   * Bob, we temporarily store a reference to Alice's request in `holding`, and store any
   * messages from Bob in `messages`.
   */
  private holding: Record<string, { socket: WebSocket; messages: any[] }> = {}

  /**
   * Keep these references for cleanup
   */
  private socket: WebSocketServer
  private app: Application
  private sockets = new Set<WebSocket>()

  public log: debug.Debugger

  constructor({ port = 8080 } = {}) {
    super()
    this.port = port
    this.app = expressWs(express()).app
    this.socket = new WebSocketServer({ noServer: true })

    this.log = debug(`lf:relay:${port}`)
    this.log("version", pkg.version)
  }

  // SERVER

  listen({ silent = false }: ListenOptions = {}) {
    return new Promise<void>((resolve, reject) => {
      this.app
        // Allow hitting this server from a browser as a sanity check
        .get("/", (_, res) => {
          res.send(logoPage).end()
        })

        // Introduction request
        .ws(
          "/introduction/:peerId", //
          (socket, { params: { peerId } }) => {
            this.log("received introduction request", peerId)
            this.openIntroductionConnection(socket, peerId)
            this.sockets.add(socket)
          }
        )

        // Connection request
        .ws(
          "/connection/:A/:B/:documentId",
          (socket, { params: { A, B, documentId } }) => {
            this.log("received connection request", A, B)
            this.openConnection({ socket, A, B, documentId })
            this.sockets.add(socket)
          }
        )

        .listen(this.port, () => {
          if (!silent)
            console.log(`🐟 Listening at http://localhost:${this.port}`)
          this.emit("ready")
          resolve()
        })

        .on("error", error => {
          if (!silent) console.error(error)
          reject()
        })
    })
  }

  close() {
    this.sockets.forEach(socket => {
      socket.removeAllListeners()
      socket.close()
      socket.terminate()
    })
    this.app.removeAllListeners()
  }

  // DISCOVERY

  private openIntroductionConnection(socket: WebSocket, peerId: PeerId) {
    this.peers[peerId] = socket

    socket
      .on("message", this.handleIntroductionRequest(peerId))
      .on("close", this.closeIntroductionConnection(peerId))

    this.emit("introduction", peerId)
  }

  private handleIntroductionRequest =
    (peerId: PeerId) => (data: Uint8Array) => {
      const A = peerId // A and B always refer to peer peerIds
      const currentDocumentIds = this.documentIds[A] ?? []

      const tryParse = <T>(s: Uint8Array): T | Error => {
        try {
          return unpack(s)
        } catch (error: any) {
          return new Error(error.toString())
        }
      }

      const message = tryParse<Message.ClientToServer>(data)
      if (message instanceof Error) {
        this.emit("error", { error: message, data })
        return
      }

      switch (message.type) {
        case "❤️":
          // heartbeat - nothing to do
          this.log("♥", peerId)
          break

        case "Join":
          this.log("introduction request: %o", message)
          // An introduction request from the client will include a list of documentIds to join.
          // We combine those documentIds with any we already have and deduplicate.
          this.documentIds[A] = currentDocumentIds
            .concat(message.documentIds)
            .reduce(deduplicate, [])

          // if this peer (A) has interests in common with any existing peer (B), introduce them to each other
          for (const B in this.peers) {
            // don't introduce peer to themselves
            if (A === B) continue

            // find documentIds that both peers are interested in
            const commonKeys = intersection(
              this.documentIds[A],
              this.documentIds[B]
            )
            if (commonKeys.length) {
              this.log("sending introductions", A, B, commonKeys)
              this.sendIntroduction(A, B, commonKeys)
              this.sendIntroduction(B, A, commonKeys)
            }
          }
          break
        case "Leave":
          // remove the provided documentIds from this peer's list
          this.documentIds[A] = currentDocumentIds.filter(
            id => !message.documentIds.includes(id)
          )
          break

        default:
          break
      }
    }

  private send(peer: WebSocket, message: Message.ServerToClient) {
    if (peer && peer.readyState === WebSocket.OPEN) {
      // We catch that so that any transient socket errors don't crash the server
      try {
        peer.send(pack(message))
      } catch (err) {
        console.error("Failed to send message to peer")
      }
    }
  }

  // If we find another peer interested in the same documentId(s), we send both peers an introduction,
  // which they can use to connect
  private sendIntroduction = (
    A: PeerId,
    B: PeerId,
    documentIds: DocumentId[]
  ) => {
    const message: Message.Introduction = {
      type: "Introduction",
      peerId: B, // the peerId of the other peer
      documentIds, // the documentId(s) both are interested in
    }
    let peer = this.peers[A]
    this.send(peer, message)
  }

  private closeIntroductionConnection = (peerId: PeerId) => () => {
    delete this.peers[peerId]
    delete this.documentIds[peerId]
  }

  // PEER CONNECTIONS

  private openConnection({ socket, A, B, documentId }: ConnectRequestParams) {
    const socketA = socket
    // A and B always refer to peerIds.

    // `AseeksB` and `BseeksA` are keys for identifying this request and the reciprocal request
    // (which may or may not have already come in)
    const AseeksB = `${A}:${B}:${documentId}`
    const BseeksA = `${B}:${A}:${documentId}`

    const holdMessage = (message: any) =>
      this.holding[AseeksB]?.messages.push(message)

    if (this.holding[BseeksA]) {
      // We already have a connection request from Bob; hook them up
      const { socket: socketB, messages } = this.holding[BseeksA]

      this.log(
        `found peer, connecting ${AseeksB} (${messages.length} stored messages)`
      )
      // Send any stored messages
      messages.forEach(message => this.send(socket, message))

      // Pipe the two sockets together
      pipeSockets(socketA, socketB)

      // Don't need to hold the connection or messages any more
      socketA.removeListener("message", holdMessage)
      delete this.holding[BseeksA]
    } else {
      // We haven't heard from Bob yet; hold this connection
      this.log("holding connection for peer", AseeksB)

      // hold Alice's socket ready, and hold any messages Alice sends to Bob in the meantime
      this.holding[AseeksB] = { socket: socketA, messages: [] }

      socketA
        // hold on to incoming messages from Alice for Bob
        .on("message", holdMessage)
        .on("close", () => delete this.holding[AseeksB])
    }
  }
}

const logoPage = `
  <body style="background:black; display:flex; justify-content:center; align-items:center">
    <img src="https://raw.githubusercontent.com/local-first-web/branding/main/svg/relay-v.svg" width="50%" alt="@localfirst/relay logo"/>
  </body>`

interface ListenOptions {
  silent?: boolean
}
