import { DocumentId } from 'types'

export const intersection = (a: DocumentId[] = [], b: DocumentId[] = []) =>
  a.filter((key) => b.includes(key))
