import { useEffect, useRef, useState } from 'react'
import type { LLMProvider } from '../api/llm'
import { type ChatMessage, streamChat } from '../api/projects'

export type StreamStatus = 'ok' | 'aborted' | 'error'

export interface StreamResult {
  status: StreamStatus
  messages: ChatMessage[]
}

export interface UseChatStream {
  messages: ChatMessage[]
  /** Replace the entire message list (used when loading a saved conversation). */
  resetMessages: (next: ChatMessage[]) => void
  /** Clear the message list (new chat). */
  clear: () => void
  input: string
  setInput: (s: string) => void
  streaming: boolean
  abort: () => void
  /**
   * Append a user message, stream an assistant reply, and resolve with the
   * final message list. The returned `messages` is authoritative — read it
   * instead of reading state, which won't be flushed yet.
   */
  send: (
    projectId: string,
    text: string,
    model: string,
    mentions?: string[],
    provider?: LLMProvider
  ) => Promise<StreamResult>
}

export function useChatStream(): UseChatStream {
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [input, setInput] = useState('')
  const [streaming, setStreaming] = useState(false)

  // Mirrors `messages`. Lets send() read the post-stream content synchronously
  // (the setMessages(prev => ...) trick races against React's update queue).
  const messagesRef = useRef<ChatMessage[]>([])
  const abortRef = useRef<AbortController | null>(null)

  useEffect(() => () => abortRef.current?.abort(), [])

  function commit(updater: (prev: ChatMessage[]) => ChatMessage[]): void {
    const next = updater(messagesRef.current)
    messagesRef.current = next
    setMessages(next)
  }

  function resetMessages(next: ChatMessage[]): void {
    messagesRef.current = next
    setMessages(next)
  }

  function clear(): void {
    resetMessages([])
  }

  function abort(): void {
    abortRef.current?.abort()
  }

  async function send(
    projectId: string,
    text: string,
    model: string,
    mentions: string[] = [],
    provider?: LLMProvider
  ): Promise<StreamResult> {
    const userMsg: ChatMessage = { role: 'user', content: text }
    const nextMessages = [...messagesRef.current, userMsg]
    commit(() => nextMessages)
    setInput('')
    setStreaming(true)

    const assistantIndex = nextMessages.length
    commit((prev) => [...prev, { role: 'assistant', content: '' }])

    let status: StreamStatus = 'ok'
    abortRef.current = new AbortController()
    try {
      const res = await streamChat(
        projectId,
        model,
        nextMessages,
        abortRef.current.signal,
        mentions,
        provider
      )
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      if (!res.body) throw new Error('No response body')

      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buf = ''

      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buf += decoder.decode(value, { stream: true })
        const lines = buf.split('\n')
        buf = lines.pop() ?? ''
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue
          const raw = line.slice(6)
          if (raw === '[DONE]') break
          try {
            const evt = JSON.parse(raw) as { token?: string; error?: string }
            if (evt.error) {
              throw new Error(evt.error)
            }
            const token = evt.token
            if (typeof token !== 'string') continue
            commit((prev) => {
              const copy = [...prev]
              copy[assistantIndex] = {
                ...copy[assistantIndex],
                content: copy[assistantIndex].content + token,
              }
              return copy
            })
          } catch (parseErr) {
            // Re-throw real provider errors; swallow only SyntaxError from
            // malformed SSE lines.
            if (parseErr instanceof SyntaxError) continue
            throw parseErr
          }
        }
      }
    } catch (err) {
      if ((err as Error).name === 'AbortError') {
        status = 'aborted'
      } else {
        status = 'error'
        const detail = (err as Error).message?.trim()
        const body = detail
          ? `⚠ Erreur lors de la génération : ${detail}`
          : '⚠ Erreur lors de la génération.'
        commit((prev) => {
          const copy = [...prev]
          copy[assistantIndex] = { role: 'assistant', content: body }
          return copy
        })
      }
    } finally {
      setStreaming(false)
      abortRef.current = null
    }

    return { status, messages: messagesRef.current }
  }

  return {
    messages,
    resetMessages,
    clear,
    input,
    setInput,
    streaming,
    abort,
    send,
  }
}
