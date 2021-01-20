import { DocumentId } from '../types'

export const deduplicate = (acc: DocumentId[], documentId: string) =>
  acc.includes(documentId) ? acc : acc.concat(documentId)
