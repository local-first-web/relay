import { encode, decode } from "msgpackr"
import WebSocket from "isomorphic-ws"

export const pack = (data: any) => {
  return toArrayBuffer(encode(data))
}

export const unpack = (data: WebSocket.Data) => {
  return decode(fromArrayBuffer(data as ArrayBuffer))
}

const toArrayBuffer = (bytes: Uint8Array) => {
  const { buffer, byteOffset, byteLength } = bytes
  return buffer.slice(byteOffset, byteOffset + byteLength)
}

const fromArrayBuffer = (buffer: ArrayBuffer) => {
  return new Uint8Array(buffer)
}
