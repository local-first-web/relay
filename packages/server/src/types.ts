import { WebSocketDuplex } from 'websocket-stream'

export type ConnectRequestParams = {
  socket: WebSocketDuplex
  A: ClientId
  B: ClientId
  documentId: DocumentId
}

export namespace Message {
  export type ClientToServer = Join | Leave

  export interface Join {
    type: 'Join'
    documentIds: DocumentId[]
  }

  export interface Leave {
    type: 'Leave'
    documentIds: DocumentId[]
  }

  export type ServerToClient = Introduction

  export interface Introduction {
    type: 'Introduction'
    userName: ClientId // the other peer we're introducing this client to
    documentIds: DocumentId[]
  }
}

export type ClientId = string

export type DocumentId = string
