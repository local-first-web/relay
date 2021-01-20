import { DocumentId } from '../types'

export const deduplicate = (acc: DocumentId[], key: string) =>
  acc.includes(key) ? acc : acc.concat(key)
