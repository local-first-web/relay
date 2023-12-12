import WebSocket from "isomorphic-ws"

export type UserName = string

export type DocumentId = string

export type ConnectRequestParams = {
  socket: WebSocket
  A: UserName
  B: UserName
  documentId: DocumentId
}

export namespace Message {
  export type ClientToServer = Join | Leave | Heartbeat

  export interface Heartbeat {
    type: "Heartbeat"
  }

  export interface Join {
    type: "Join"
    documentIds: DocumentId[]
  }

  export interface Leave {
    type: "Leave"
    documentIds: DocumentId[]
  }

  export type ServerToClient = Introduction

  export interface Introduction {
    type: "Introduction"
    userName: UserName // the other peer we're introducing this client to
    documentIds: DocumentId[]
  }
}

export type ClientEvents = {
  "server.connect": () => void
  "server.disconnect": () => void
  error: (err: Error) => void
  "peer.connect": (payload: PeerEventPayload) => void
  "peer.disconnect": (payload: PeerEventPayload) => void
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

export type PeerSocketMap = Map<DocumentId, WebSocket | null>
