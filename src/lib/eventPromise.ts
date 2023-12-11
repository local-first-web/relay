import { type EventEmitter } from "eventemitter3"
import { WebSocket } from "isomorphic-ws"

/** Returns a promise that resolves when the given event is emitted on the given emitter. */
export const eventPromise = async (emitter: Emitter, event: string) =>
  new Promise<any>(resolve => {
    emitter.once(event, d => resolve(d))
  })

export const eventPromises = async (emitters: Emitter[], event: string) => {
  const promises = emitters.map(async emitter => eventPromise(emitter, event))
  return Promise.all(promises)
}

type Emitter = EventEmitter | WebSocket
