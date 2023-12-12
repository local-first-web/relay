import { Client } from "../../Client.js"
import { disconnection } from "./disconnection.js"

export const allDisconnected = (a: Client, b: Client) =>
  Promise.all([disconnection(a, b), disconnection(b, a)])
