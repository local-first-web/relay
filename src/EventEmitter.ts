import { EventEmitter as _EventEmitter } from "eventemitter3"
import debug from "debug"

/** EventEmitter with built-in logging */
export class EventEmitter extends _EventEmitter {
  /** The `log` method is meant to be overridden, e.g.
   * ```ts
   *  this.log = debug(`lf:tc:conn:${context.user.userName}`)
   * ```
   */
  log: debug.Debugger = debug(`EventEmitter`)

  public emit(event: string | symbol, ...args: any[]) {
    this.log(`${event.toString()} %o`, ...args)
    return super.emit(event, ...args)
  }
}
