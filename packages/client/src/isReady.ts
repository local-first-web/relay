import { pause } from './pause'

export const isReady = async (socket: WebSocket) =>
  new Promise<void>(async (resolve, reject) => {
    while (socket.readyState !== WebSocket.OPEN) await pause(100)
    resolve()
  })
