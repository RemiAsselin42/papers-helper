import { Quote, RotateCcw, Search } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { searchCitations, type CitationHit } from '../../api/citations'
import { listSources, type SourceInfo } from '../../api/papers'
import { splitCategoriesCsv } from '../../utils/categories'
import { stripStopWords } from '../../utils/stopWords'
import { CitationResultCard } from './CitationResultCard'
import { FilterMultiSelect } from './FilterMultiSelect'
import { hasStrictMatch } from './snippetHighlight'
import styles from './CitationsView.module.scss'

// Results are paged client-side: each search asks for one page, "load more"
// widens the request by another. `_MAX_RESULTS` mirrors the backend's
// `_MAX_LIMIT` ceiling on a single response.
const _PAGE_SIZE = 20
const _MAX_RESULTS = 200

interface Props {
  projectId: string
  /** Opens the Sources view filtered onto a hit's source paper. */
  onOpenSource: (stem: string, title: string) => void
}

export function CitationsView({ projectId, onOpenSource }: Props) {
  const [query, setQuery] = useState('')
  // Strict mode: search the exact word sequence instead of each word.
  const [strict, setStrict] = useState(false)
  // The query + mode that produced `results` — pinned at search time so
  // editing the input / toggling the mode afterwards doesn't shift the
  // snippet highlighting until the next search.
  const [searchedQuery, setSearchedQuery] = useState('')
  const [searchedStrict, setSearchedStrict] = useState(false)
  // Multi-value metadata filters — each is OR-matched within its field, and
  // the three fields are AND-combined by the backend.
  const [selectedStems, setSelectedStems] = useState<string[]>([])
  const [selectedAuthors, setSelectedAuthors] = useState<string[]>([])
  const [selectedCategories, setSelectedCategories] = useState<string[]>([])
  const [sources, setSources] = useState<SourceInfo[]>([])
  // `null` = no search run yet (shows the prompt); `[]` = searched, no match.
  const [results, setResults] = useState<CitationHit[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Pagination: `limit` is the count the last search asked for; "load more"
  // bumps it by a page and re-runs. `hasMore` stays true while the backend
  // keeps filling the requested page (more hits may exist).
  const [limit, setLimit] = useState(_PAGE_SIZE)
  const [hasMore, setHasMore] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const abortRef = useRef<AbortController | null>(null)

  // Reset everything on project switch — filters and results are project-scoped.
  useEffect(() => {
    setQuery('')
    setStrict(false)
    setSearchedQuery('')
    setSearchedStrict(false)
    setSelectedStems([])
    setSelectedAuthors([])
    setSelectedCategories([])
    setResults(null)
    setError(null)
    setLimit(_PAGE_SIZE)
    setHasMore(false)
    listSources(projectId)
      .then(setSources)
      .catch(() => setSources([]))
  }, [projectId])

  useEffect(() => () => abortRef.current?.abort(), [])

  const sortedSources = useMemo(
    () =>
      [...sources].sort((a, b) =>
        (a.pdf_title || a.filename).localeCompare(b.pdf_title || b.filename)
      ),
    [sources]
  )
  const authors = useMemo(
    () => [...new Set(sources.map((s) => s.author).filter(Boolean))].sort(),
    [sources]
  )
  const categories = useMemo(() => {
    const set = new Set<string>()
    for (const s of sources) {
      for (const c of splitCategoriesCsv(s.categories)) set.add(c)
    }
    return [...set].sort()
  }, [sources])

  const hasFilters =
    selectedStems.length > 0 || selectedAuthors.length > 0 || selectedCategories.length > 0

  const resetFilters = useCallback(() => {
    setSelectedStems([])
    setSelectedAuthors([])
    setSelectedCategories([])
  }, [])

  const runSearch = useCallback(
    async (searchLimit: number, isLoadMore = false) => {
      const q = query.trim()
      if (!q) return
      // Cancel any in-flight search so a slow earlier request can't overwrite
      // the results of a newer one.
      abortRef.current?.abort()
      const ctrl = new AbortController()
      abortRef.current = ctrl
      if (isLoadMore) setLoadingMore(true)
      else setLoading(true)
      setError(null)
      // Strict mode searches the exact phrase; normal mode drops connective
      // words so only the meaningful terms drive the semantic search. Fall back
      // to the raw query if stripping leaves nothing (all connective words).
      const effectiveQuery = strict ? q : stripStopWords(q) || q
      try {
        const hits = await searchCitations(
          projectId,
          effectiveQuery,
          {
            stems: selectedStems,
            authors: selectedAuthors,
            categories: selectedCategories,
          },
          searchLimit,
          strict,
          ctrl.signal
        )
        // Vector search returns semantically-near chunks regardless of mode —
        // in strict mode, drop those that don't actually carry the exact
        // phrase, otherwise they'd render as cards with no highlight. Note an
        // exact phrase split across the ~500-word chunk boundary is invisible
        // here: strict matching is chunk-local, so such a hit is silently
        // dropped.
        setResults(strict ? hits.filter((h) => hasStrictMatch(h.text, q)) : hits)
        setSearchedQuery(q)
        setSearchedStrict(strict)
        setLimit(searchLimit)
        // A full page back means the backend may hold more hits; stop once a
        // short page comes back or the response ceiling is reached.
        setHasMore(hits.length >= searchLimit && searchLimit < _MAX_RESULTS)
      } catch (err) {
        if ((err as Error).name === 'AbortError') return
        setError(
          'La recherche a échoué. Vérifiez qu’Ollama est disponible et que le projet est indexé.'
        )
        setResults(null)
        setHasMore(false)
      } finally {
        if (abortRef.current === ctrl) {
          setLoading(false)
          setLoadingMore(false)
        }
      }
    },
    [projectId, query, strict, selectedStems, selectedAuthors, selectedCategories]
  )

  return (
    <div className={styles.root}>
      <form
        className={styles.searchForm}
        onSubmit={(e) => {
          e.preventDefault()
          void runSearch(_PAGE_SIZE)
        }}
      >
        <div className={styles.searchRow}>
          <Search size={18} className={styles.searchIcon} aria-hidden="true" />
          <input
            type="search"
            className={styles.searchInput}
            placeholder="Rechercher un concept, une phrase…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Rechercher des citations"
          />
          <button
            type="button"
            className={`${styles.strictToggle} ${strict ? styles.strictToggleActive : ''}`}
            onClick={() => setStrict((s) => !s)}
            aria-pressed={strict}
            title="Rechercher la suite de mots exacte"
          >
            <Quote size={16} aria-hidden="true" />
            Phrase exacte
          </button>
          <button
            type="submit"
            className={styles.searchBtn}
            disabled={loading || query.trim() === ''}
          >
            {loading ? 'Recherche…' : 'Rechercher'}
          </button>
        </div>

        <div className={styles.filterRow}>
          <FilterMultiSelect
            emptyLabel="Toutes les sources"
            ariaLabel="Filtrer par source"
            options={sortedSources.map((s) => ({
              value: s.stem,
              label: s.pdf_title || s.filename,
            }))}
            selected={selectedStems}
            onChange={setSelectedStems}
          />

          {authors.length > 0 && (
            <FilterMultiSelect
              emptyLabel="Tous les auteurs"
              ariaLabel="Filtrer par auteur"
              options={authors.map((a) => ({ value: a, label: a }))}
              selected={selectedAuthors}
              onChange={setSelectedAuthors}
            />
          )}

          {categories.length > 0 && (
            <FilterMultiSelect
              emptyLabel="Toutes les catégories"
              ariaLabel="Filtrer par catégorie"
              options={categories.map((c) => ({ value: c, label: c }))}
              selected={selectedCategories}
              onChange={setSelectedCategories}
            />
          )}

          {hasFilters && (
            <button
              type="button"
              className={styles.resetBtn}
              onClick={resetFilters}
              aria-label="Réinitialiser les filtres"
              title="Réinitialiser les filtres"
            >
              <RotateCcw size={16} />
            </button>
          )}
        </div>
      </form>

      <div className={styles.results}>
        {error && <p className={styles.error}>{error}</p>}

        {!error && loading && <p className={styles.hint}>Recherche en cours…</p>}

        {!error && !loading && results === null && (
          <div className={styles.empty}>
            <Search size={32} aria-hidden="true" />
            <p>Saisissez une requête pour retrouver les passages pertinents de vos sources.</p>
          </div>
        )}

        {!error && !loading && results !== null && results.length === 0 && (
          <p className={styles.hint}>Aucun passage ne correspond à cette requête.</p>
        )}

        {!error && !loading && results !== null && results.length > 0 && (
          <>
            <ul className={styles.list}>
              {results.map((hit) => (
                <li key={hit.chunk_id}>
                  <CitationResultCard
                    hit={hit}
                    projectId={projectId}
                    query={searchedQuery}
                    strict={searchedStrict}
                    onOpenSource={onOpenSource}
                  />
                </li>
              ))}
            </ul>
            {hasMore && (
              <button
                type="button"
                className={styles.loadMoreBtn}
                onClick={() => void runSearch(Math.min(limit + _PAGE_SIZE, _MAX_RESULTS), true)}
                disabled={loadingMore}
              >
                {loadingMore ? 'Chargement…' : 'Voir plus de résultats'}
              </button>
            )}
          </>
        )}
      </div>
    </div>
  )
}
