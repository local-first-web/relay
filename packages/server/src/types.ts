import WebSocket from 'ws'

export type ConnectRequestParams = {
  peerA: WebSocket
  A: ClientID
  B: ClientID
  key: DocumentID
}

export type KeySet = string[]

export namespace Message {
  export type ClientToServer = Join

  export interface Join {
    type: 'Join' | 'Leave'
    join?: string[] // document IDs
    leave?: string[]
  }

  export type ServerToClient = Introduction

  export interface Introduction {
    type: 'Introduction'
    id: string // the other peer we're introducing this client to
    keys: string[] // document IDs
  }
}

export type ClientID = string

export type DocumentID = string
