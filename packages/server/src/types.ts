import WebSocket from 'ws'

export type ConnectRequestParams = {
  socket: WebSocket
  A: UserName
  B: UserName
  documentId: DocumentId
}

export namespace Message {
  export type ClientToServer = Join | Leave | Heartbeat

  export interface Heartbeat {
    type: 'Heartbeat'
  }

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
    userName: UserName // the other peer we're introducing this client to
    documentIds: DocumentId[]
  }
}

export type UserName = string

export type DocumentId = string
