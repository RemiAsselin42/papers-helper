import { Bot, User } from 'lucide-react'
import styles from './ChatView.module.scss'

interface BubblePattern {
  role: 'user' | 'assistant'
  /** Bubble width as a percentage of the row's max content width. */
  widthPct: number
  /** Bubble height in pixels (drives apparent line count). */
  height: number
}

// Fixed patterns rather than random widths — keeps the silhouette stable
// across re-renders during the loading window so the layout doesn't flicker.
const INITIAL_PATTERN: BubblePattern[] = [
  { role: 'assistant', widthPct: 72, height: 56 },
  { role: 'user', widthPct: 48, height: 24 },
  { role: 'assistant', widthPct: 85, height: 88 },
  { role: 'user', widthPct: 38, height: 24 },
  { role: 'assistant', widthPct: 65, height: 56 },
  { role: 'user', widthPct: 55, height: 24 },
]

const OLDER_PATTERN: BubblePattern[] = [
  { role: 'assistant', widthPct: 80, height: 48 },
  { role: 'user', widthPct: 50, height: 24 },
]

interface Props {
  kind: 'initial' | 'older'
}

/**
 * Skeleton rendering of chat bubbles shown while messages are loading. The
 * bubble itself is the shimmer surface (the animated gradient is on
 * `.bubbleSkeleton`, not a nested element) — embedding a percentage-sized
 * skeleton inside an unsized flex bubble would collapse to zero width and
 * hide the animation.
 */
export function ChatMessagesSkeleton({ kind }: Props) {
  const pattern = kind === 'initial' ? INITIAL_PATTERN : OLDER_PATTERN
  return (
    <>
      {pattern.map((p, i) => (
        <div
          key={i}
          className={`${styles.message} ${p.role === 'user' ? styles.user : styles.assistant}`}
          aria-hidden
        >
          <span className={styles.avatar}>
            {p.role === 'user' ? <User size={20} /> : <Bot size={20} />}
          </span>
          <div
            className={styles.bubbleSkeleton}
            style={{ width: `${p.widthPct}%`, height: `${p.height}px` }}
          />
        </div>
      ))}
    </>
  )
}
