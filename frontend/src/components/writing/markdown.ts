import { marked } from 'marked'

/**
 * Convert the Markdown produced by the generation model into HTML for the
 * tiptap editor.
 *
 * Trust boundary — this output is NOT sanitised here. The safety assumption is
 * twofold:
 *  1. The Markdown comes from the project's own local Ollama model, never from
 *     third-party / network input — there is no untrusted author.
 *  2. tiptap re-parses the HTML into its own schema when it is inserted,
 *     keeping only nodes/marks the schema recognises and silently dropping the
 *     rest (`<script>`, event handlers, unknown tags). That re-parse — not this
 *     function — is the effective sanitiser.
 *
 * If either assumption changes (e.g. importing Markdown from an external
 * source), run the output through an HTML sanitiser before insertion.
 */
export function markdownToHtml(md: string): string {
  const html = marked.parse(md, { async: false, gfm: true })
  return typeof html === 'string' ? html : ''
}
