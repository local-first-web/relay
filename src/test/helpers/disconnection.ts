import { Client } from "../../Client.js"

export const disconnection = (a: Client, b: Client) =>
  new Promise<void>(resolve =>
    a.on("peer-disconnect", ({ peerId = "" }) => {
      if (peerId === b.peerId) resolve()
    })
  )
