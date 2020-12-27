import { DocumentID } from '../types'

export const deduplicate = (acc: DocumentID[], key: string) =>
  acc.includes(key) ? acc : acc.concat(key)
