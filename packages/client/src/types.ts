export interface ClientOptions {
  id?: ClientId
  url: string
}

export interface PeerOptions {
  id: ClientId
  url: string
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
