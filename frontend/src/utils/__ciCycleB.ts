// DEMO CI Gate 1 — cycle volontaire (sera reverte). Prouve que la CI bloque.
import { ciA } from './__ciCycleA'

export const ciB = (): string => `B -> ${ciA()}`
