import { Bot, User } from 'lucide-react'
import { useEffect, useRef } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { ChatMessage } from '../../api/chat'
import styles from './ChatView.module.scss'

interface Props {
  messages: ChatMessage[]
  streaming: boolean
  plainText: boolean
}

export function ChatMessages({ messages, streaming, plainText }: Props) {
  const bottomRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  return (
    <div className={styles.messages}>
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
