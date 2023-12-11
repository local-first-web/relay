import type { DocumentId } from "./types.js"

export const deduplicate = (acc: DocumentId[], documentId: string) =>
  acc.includes(documentId) ? acc : acc.concat(documentId)
