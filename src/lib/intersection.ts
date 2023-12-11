import type { DocumentId } from "./types.js"

export const intersection = (a: DocumentId[] = [], b: DocumentId[] = []) =>
  a.filter(documentId => b.includes(documentId))
