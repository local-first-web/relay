import { DocumentID } from 'types'

export const intersection = (a: DocumentID[] = [], b: DocumentID[] = []) =>
  a.filter((key) => b.includes(key))
