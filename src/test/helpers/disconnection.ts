import { Client } from "../../Client.js"

export const disconnection = (a: Client, b: Client) =>
  new Promise<void>(resolve =>
    a.on("peer-disconnect", ({ userName = "" }) => {
      if (userName === b.userName) resolve()
    })
  )
