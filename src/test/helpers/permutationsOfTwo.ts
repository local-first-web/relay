import { factorial } from "./factorial.js"

export const permutationsOfTwo = (n: number) => factorial(n) / factorial(n - 2)
