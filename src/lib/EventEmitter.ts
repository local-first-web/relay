import { EventEmitter as _EventEmitter } from "eventemitter3"
import debug from "debug"

/** EventEmitter with built-in logging */
export class EventEmitter<
  T extends _EventEmitter.ValidEventTypes,
> extends _EventEmitter<T> {
  /** The `log` method is meant to be overridden, e.g.
   * ```ts
   *  this.log = debug(`lf:tc:conn:${context.user.userName}`)
   * ```
   */
  log: debug.Debugger = debug(`EventEmitter`)

  public emit(
    event: _EventEmitter.EventNames<T>,
    ...args: _EventEmitter.EventArgs<T, _EventEmitter.EventNames<T>>
  ) {
    this.log(`${event.toString()} %o`, ...args)
    return super.emit(event, ...args)
  }
}
