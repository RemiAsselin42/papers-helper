/** How node fill colour is derived: by node type (the default — papers,
 * authors, categories, concepts each get their own colour) or by Louvain
 * community (each detected cluster gets a distinct hue). */
export type ColorMode = 'type' | 'community'

export interface FilterState {
  paper: boolean
  author: boolean
  category: boolean
  concept: boolean
  semanticThreshold: number
  colorBy: ColorMode
}

export const DEFAULT_FILTERS: FilterState = {
  paper: true,
  author: true,
  category: true,
  concept: true,
  semanticThreshold: 0.6,
  colorBy: 'type',
}
