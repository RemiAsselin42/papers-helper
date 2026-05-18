import { categorizeText } from '../api/categorize'
import { consumeCondenseStream, streamCondense, type CondenseProgress } from '../api/condense'
import type { LLMProvider } from '../api/llm'
import { ABSTRACT_PROMPT } from '../prompts/abstract'
import { CATEGORIES_FROM_ABSTRACT_PROMPT } from '../prompts/categories'
import { parseLlmStringArray } from './categories'

export interface EnrichConfig {
  projectId: string
  stem: string
  model: string
  provider: LLMProvider
  signal?: AbortSignal
  /** Optional progress sink — receives /condense phase events as they fire. */
  onProgress?: (p: CondenseProgress) => void
  /** Optional token sink — receives reduce-phase tokens as they stream in.
   * The abstract flow uses this to render the in-progress text live. */
  onToken?: (token: string) => void
}

// A leading paragraph is chatty preamble when it opens with one of these —
// small local models prepend it despite the prompt ("What a treasure trove…",
// "Here's a general overview…", "After carefully reviewing…").
const META_OPENER =
  /^(what a |here(?:'s| is)\b|here are\b|voici\b|après avoir |after (?:analy|carefully|reviewing|a careful|having)|based on (?:the|these|my|a)\b|i(?:'ve| have| )(?:noticed|identified|reviewed|analyzed|carefully)|j'ai (?:remarqué|identifié|analysé|noté|relevé)|let me \b|sure[!,.: ]|of course\b|bien sûr|d'accord|these (?:summaries|extracts|texts|notes)\b|ces (?:résumés|extraits|textes|notes)\b|the (?:following|summaries|extracts)\b)/i

// A trailing paragraph is a meta-conclusion when it opens with one of these.
const META_CLOSER =
  /^(overall[,.]?\s|in (?:conclusion|summary)\b|to (?:sum up|summari[sz]e)\b|en (?:conclusion|résumé)\b|pour (?:résumer|conclure)\b|finally[,.]?\s|enfin[,.]?\s|some common themes\b|i hope\b|j'espère\b)/i

/**
 * Strips the artefacts small local models (llama3) leave on a generated
 * abstract despite the prompt: a Markdown layer and chatty meta
 * preamble/conclusion paragraphs. The abstract field is plain text — Markdown
 * is never wanted. Exported for testing.
 */
export function cleanGeneratedAbstract(raw: string): string {
  let text = raw.trim()
  if (!text) return ''

  // Drop a fenced code-block wrapper if the whole answer was wrapped in ```.
  if (text.startsWith('```')) {
    text = text
      .replace(/^```[^\n]*\n?/, '')
      .replace(/\n?```\s*$/, '')
      .trim()
  }

  // Strip the Markdown the abstract field can't render.
  text = text
    .replace(/^\s{0,3}#{1,6}\s+/gm, '') // headings
    .replace(/^\s*>\s?/gm, '') // blockquotes
    .replace(/^\s*([-*+•·]|\d+[.)])\s+/gm, '') // list markers
    .replace(/^\s*([-*_])\1{2,}\s*$/gm, '') // horizontal rules
    .replace(/(\*\*|__)(.+?)\1/g, '$2') // bold
    .replace(/`([^`\n]+)`/g, '$1') // inline code

  // Drop leading preamble paragraphs and trailing meta-conclusions.
  const paras = text
    .split(/\n\s*\n+/)
    .map((p) => p.replace(/[ \t]*\n[ \t]*/g, ' ').replace(/\s{2,}/g, ' ').trim())
    .filter(Boolean)
  while (paras.length > 1 && META_OPENER.test(paras[0])) paras.shift()
  while (paras.length > 1 && META_CLOSER.test(paras[paras.length - 1])) paras.pop()

  return paras.join('\n\n').trim()
}

/**
 * Generates an abstract for a single stem via /condense map-reduce. Streams
 * raw tokens through onToken if provided (for a live preview), but the
 * returned value is run through `cleanGeneratedAbstract` so callers persist a
 * preamble-free, Markdown-free abstract.
 */
export async function generateAbstractForStem(cfg: EnrichConfig): Promise<string> {
  let acc = ''
  const res = await streamCondense(
    cfg.projectId,
    ABSTRACT_PROMPT,
    [cfg.stem],
    cfg.model,
    cfg.signal,
    cfg.provider
  )
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  if (!res.body) throw new Error('Pas de corps de réponse')
  await consumeCondenseStream(
    res.body,
    (token) => {
      acc += token
      cfg.onToken?.(token)
    },
    cfg.onProgress
  )
  return cleanGeneratedAbstract(acc)
}

export interface CategorizeFromAbstractConfig {
  projectId: string
  /** The document abstract — the LLM derives categories from this text. */
  abstract: string
  model: string
  provider: LLMProvider
  signal?: AbortSignal
}

/**
 * Derives a category list from a document's abstract via a single /categorize
 * call (no map-reduce). Far cheaper than re-summarising the whole document —
 * categories are high-level enough that the abstract is sufficient context.
 *
 * Throws if the LLM response cannot be parsed into any usable list.
 */
export async function generateCategoriesFromAbstract(
  cfg: CategorizeFromAbstractConfig
): Promise<string[]> {
  const raw = await categorizeText(
    cfg.projectId,
    CATEGORIES_FROM_ABSTRACT_PROMPT,
    cfg.abstract,
    cfg.model,
    cfg.provider,
    cfg.signal
  )
  const parsed = parseLlmStringArray(raw, 8)
  if (parsed.length === 0) {
    const preview = raw.trim().replace(/\s+/g, ' ').slice(0, 160)
    throw new Error(
      preview
        ? `Réponse IA inexploitable. Réponse brute : « ${preview}${raw.length > 160 ? '…' : ''} »`
        : 'Réponse IA inexploitable.'
    )
  }
  return parsed
}
