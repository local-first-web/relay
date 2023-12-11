import { encode, decode } from "msgpackr"

const { Buffer } = globalThis

export const pack = (data: any) => encode(data)

export const unpack = (data: Buffer | ArrayBuffer | Buffer[]) => {
  return decode(data as Buffer)
}
