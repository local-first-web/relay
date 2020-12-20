export interface ClientOptions {
  id?: string
  url: string
}

export interface PeerOptions {
  id: string
  url: string
}

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
