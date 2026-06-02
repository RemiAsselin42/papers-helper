// DEMO CI Gate 1 — cycle volontaire (sera reverte). Prouve que la CI bloque.
import { ciB } from './__ciCycleB'

export const ciA = (): string => `A -> ${ciB()}`
