import { useCallback, useState, type KeyboardEvent, type RefObject } from 'react'
import type { SourceInfo } from '../api/papers'
import {
  findActiveMention,
  mentionInsertion,
  mentionItemCount,
} from '../utils/mentions'

export interface ActiveMention {
  start: number
  query: string
}

export interface UseMentionPicker {
  mention: ActiveMention | null
  highlight: number
  setHighlight: (n: number | ((prev: number) => number)) => void
  /** Re-scan the textarea around the caret; opens/refreshes/closes accordingly. */
  refresh: () => void
  close: () => void
  /** Insert the chosen completion in place of the current @… token. */
  applyInsertion: (insertion: string) => void
  /**
   * Key handler for the textarea. Returns `true` if the event was consumed
   * (caller should NOT also handle Enter/Tab as send).
   */
  handleKey: (e: KeyboardEvent<HTMLTextAreaElement>) => boolean
}

/**
 * Manages the @mention popover state attached to a controlled textarea.
 *
 * `setInput` must update the same textarea's controlled value — we depend on
 * the caller propagating the new string so the next render carries our caret
 * position.
 */
export function useMentionPicker(
  textareaRef: RefObject<HTMLTextAreaElement | null>,
  sources: SourceInfo[],
  setInput: (s: string) => void
): UseMentionPicker {
  const [mention, setMention] = useState<ActiveMention | null>(null)
  const [highlight, setHighlight] = useState(0)

  const refresh = useCallback(() => {
    const el = textareaRef.current
    if (!el) return
    const caret = el.selectionStart ?? el.value.length
    const found = findActiveMention(el.value, caret)
    setMention((prev) => {
      if (!found) return null
      if (prev && prev.start === found.start && prev.query === found.query) {
        return prev
      }
      setHighlight(0)
      return found
    })
  }, [textareaRef])

  const close = useCallback(() => {
    setMention(null)
    setHighlight(0)
  }, [])

  const applyInsertion = useCallback(
    (insertion: string) => {
      const el = textareaRef.current
      if (!el || !mention) return
      const value = el.value
      const caret = el.selectionStart ?? value.length
      const before = value.slice(0, mention.start)
      const after = value.slice(caret)
      const next = `${before}@${insertion}${after}`
      setInput(next)
      close()
      // Place caret right after the inserted text and re-run detection so the
      // popover progresses (e.g. type → file step).
      const nextCaret = before.length + 1 + insertion.length
      queueMicrotask(() => {
        const node = textareaRef.current
        if (!node) return
        node.focus()
        node.setSelectionRange(nextCaret, nextCaret)
        refresh()
      })
    },
    [mention, textareaRef, setInput, close, refresh]
  )

  const handleKey = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>): boolean => {
      if (!mention) return false
      const count = mentionItemCount(mention.query, sources)
      if (e.key === 'Escape') {
        e.preventDefault()
        close()
        return true
      }
      if (e.key === 'ArrowDown' && count > 0) {
        e.preventDefault()
        setHighlight((h) => (h + 1) % count)
        return true
      }
      if (e.key === 'ArrowUp' && count > 0) {
        e.preventDefault()
        setHighlight((h) => (h - 1 + count) % count)
        return true
      }
      if ((e.key === 'Enter' || e.key === 'Tab') && count > 0) {
        const insertion = mentionInsertion(mention.query, sources, highlight)
        if (insertion !== null) {
          e.preventDefault()
          applyInsertion(insertion)
          return true
        }
      }
      return false
    },
    [mention, sources, highlight, close, applyInsertion]
  )

  return { mention, highlight, setHighlight, refresh, close, applyInsertion, handleKey }
}
