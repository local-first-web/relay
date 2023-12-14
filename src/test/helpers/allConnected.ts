import { Client } from "../../Client.js"
import { DocumentId } from "../../types.js"
import { connection } from "./connection.js"
import WebSocket from "isomorphic-ws"

export const allConnected = (a: Client, b: Client, documentId?: DocumentId) =>
  Promise.all<WebSocket>([
    connection(a, b, documentId),
    connection(b, a, documentId),
  ])
