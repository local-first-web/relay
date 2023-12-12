import { Client } from "../../Client.js"
import { DocumentId } from "../../index.js"
import { WebSocket } from "isomorphic-ws"

export const connection = (a: Client, b: Client, documentId?: DocumentId) =>
  new Promise<WebSocket>(resolve =>
    a.on("peer-connect", ({ userName, documentId: d, socket }) => {
      if (
        userName === b.userName &&
        // are we waiting to connect on a specific document ID?
        (documentId === undefined || documentId === d)
      )
        resolve(socket)
    })
  )
