// Cached source count per project. Used to pick the right initial render
// (empty CTA vs. skeletons) before the network fetch resolves — avoids both
// the empty-flash-then-list and the skeleton-flash-then-empty UX glitches.
const SOURCE_COUNT_CACHE_PREFIX = 'sourceCount:'

export function readCachedSourceCount(projectId: string): number | null {
  try {
    const raw = localStorage.getItem(SOURCE_COUNT_CACHE_PREFIX + projectId)
    if (raw === null) return null
    const n = parseInt(raw, 10)
    return Number.isFinite(n) && n >= 0 ? n : null
  } catch {
    return null
  }
}

export function setCachedSourceCount(projectId: string, count: number): void {
  try {
    localStorage.setItem(SOURCE_COUNT_CACHE_PREFIX + projectId, String(count))
  } catch {
    // Storage is best-effort; skip silently on quota / disabled storage.
  }
}

export function clearCachedSourceCount(projectId: string): void {
  try {
    localStorage.removeItem(SOURCE_COUNT_CACHE_PREFIX + projectId)
  } catch {
    // Same rationale as setCachedSourceCount.
  }
}
