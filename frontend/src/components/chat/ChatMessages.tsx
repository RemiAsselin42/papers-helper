import { Bot, User } from 'lucide-react'
import { useEffect, useLayoutEffect, useRef } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { ChatMessage } from '../../api/chat'
import type { ChatLoadingState } from '../../hooks/useChatStream'
import { ChatMessagesSkeleton } from './ChatMessagesSkeleton'
import styles from './ChatView.module.scss'

interface Props {
  messages: ChatMessage[]
  streaming: boolean
  plainText: boolean
  /**
   * Index of `messages[0]` in the full conversation; > 0 means older
   * messages exist on the server and the top sentinel should arm
   * `onLoadOlder`.
   */
  messagesOffset: number
  loadingState: ChatLoadingState
  onLoadOlder: () => void
}

export function ChatMessages({
  messages,
  streaming,
  plainText,
  messagesOffset,
  loadingState,
  onLoadOlder,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const topSentinelRef = useRef<HTMLDivElement>(null)
  const bottomRef = useRef<HTMLDivElement>(null)

  // Snapshot of the last-known head identity so we can tell whether the
  // messages array changed via append (tail growth → scroll to bottom) or
  // via prepend (head growth → preserve viewport).
  const lastHeadRef = useRef<ChatMessage | null>(null)
  const lastLengthRef = useRef(0)

  // Captured BEFORE a prepend so we can restore scroll position AFTER the
  // DOM grows at the top.
  const pendingAnchorRef = useRef<number | null>(null)

  // Auto-scroll behaviour: only when the TAIL grew (a new message arrived
  // or a token streamed in). Prepends (older messages loaded via scroll-up)
  // must leave the user's viewport alone.
  useEffect(() => {
    const prevHead = lastHeadRef.current
    const prevLength = lastLengthRef.current
    const head = messages[0] ?? null
    const grewAtHead = prevHead !== null && head !== prevHead
    const grewAtTail = messages.length > prevLength && !grewAtHead

    lastHeadRef.current = head
    lastLengthRef.current = messages.length

    if (grewAtTail || (messages.length > 0 && prevLength === 0)) {
      bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
    }
  }, [messages])

  // Capture anchor at the moment we know a prepend is coming (loadingState
  // flips to 'older'); restore it once the new content has rendered and the
  // skeleton has been removed.
  useLayoutEffect(() => {
    const container = containerRef.current
    if (!container) return
    if (loadingState === 'older' && pendingAnchorRef.current === null) {
      pendingAnchorRef.current = container.scrollHeight - container.scrollTop
    }
    if (loadingState === null && pendingAnchorRef.current !== null) {
      container.scrollTop = container.scrollHeight - pendingAnchorRef.current
      pendingAnchorRef.current = null
    }
  }, [loadingState, messages])

  // Top sentinel: when it scrolls into view AND older messages still exist
  // on the server AND nothing else is loading, fire `onLoadOlder`.
  useEffect(() => {
    const target = topSentinelRef.current
    if (!target) return
    if (messagesOffset === 0) return
    if (loadingState !== null) return
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            onLoadOlder()
            break
          }
        }
      },
      { root: containerRef.current, threshold: 0 }
    )
    observer.observe(target)
    return () => observer.disconnect()
  }, [messagesOffset, loadingState, onLoadOlder])

  // `role="log"` + `aria-live="polite"` tells screen readers this is an
  // append-only message region; most SRs avoid spamming on every streamed
  // token in a log region and instead announce on settle. `aria-busy` while
  // loading defers any announcement until the skeleton resolves. A separate
  // visually-hidden status announces transitions explicitly in French.
  const loadingStatus =
    loadingState === 'initial'
      ? 'Chargement de la conversation…'
      : loadingState === 'older'
        ? 'Chargement des messages précédents…'
        : ''

  if (loadingState === 'initial') {
    return (
      <div
        className={styles.messages}
        ref={containerRef}
        role="log"
        aria-live="polite"
        aria-relevant="additions"
        aria-busy="true"
      >
        <span className={styles.srOnly} role="status" aria-live="polite">
          {loadingStatus}
        </span>
        <ChatMessagesSkeleton kind="initial" />
      </div>
    )
  }

  return (
    <div
      className={styles.messages}
      ref={containerRef}
      role="log"
      aria-live="polite"
      aria-relevant="additions"
      aria-busy={loadingState !== null}
    >
      <span className={styles.srOnly} role="status" aria-live="polite">
        {loadingStatus}
      </span>
      <div ref={topSentinelRef} aria-hidden />
      {loadingState === 'older' && <ChatMessagesSkeleton kind="older" />}
      {messages.length === 0 && (
        <div className={styles.empty}>
          Commencez la conversation
          <br />
          Ctrl + Entrée pour un saut de ligne
          <br />@ pour mentionner une source
        </div>
      )}
      {messages.map((msg, i) => {
        const isAssistant = msg.role === 'assistant'
        const renderMarkdown = isAssistant && !plainText
        const showCursor = !msg.content && streaming && i === messages.length - 1
        return (
          <div
            key={i}
            className={`${styles.message} ${msg.role === 'user' ? styles.user : styles.assistant}`}
          >
            <span className={styles.avatar}>
              {msg.role === 'user' ? <User size={20} /> : <Bot size={20} />}
            </span>
            <div className={`${styles.bubble} ${renderMarkdown ? styles.bubbleMarkdown : ''}`}>
              {showCursor ? (
                <span className={styles.cursor} />
              ) : renderMarkdown ? (
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{msg.content}</ReactMarkdown>
              ) : (
                msg.content
              )}
            </div>
          </div>
        )
      })}
      <div ref={bottomRef} />
    </div>
  )
}
