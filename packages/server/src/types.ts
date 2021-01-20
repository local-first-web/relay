import { WebSocketDuplex } from 'websocket-stream'

export type ConnectRequestParams = {
  socket: WebSocketDuplex
  A: ClientId
  B: ClientId
  key: DocumentId
}

export namespace Message {
  export type ClientToServer = Join | Leave

  export interface Join {
    type: 'Join'
    keys: DocumentId[]
  }

  export interface Leave {
    type: 'Leave'
    keys: DocumentId[]
  }

  export type ServerToClient = Introduction

  export interface Introduction {
    type: 'Introduction'
    id: ClientId // the other peer we're introducing this client to
    keys: DocumentId[]
  }
}

export type ClientId = string

export type DocumentId = string
