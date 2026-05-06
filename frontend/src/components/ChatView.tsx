import { ArrowUp, Bot, User } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { type ChatMessage, listModels, streamChat } from '../api/projects'
import styles from './ChatView.module.scss'

interface Props {
  projectId: string
}

export function ChatView({ projectId }: Props) {
  const [models, setModels] = useState<string[]>([])
  const [selectedModel, setSelectedModel] = useState<string>('')
  const [modelsError, setModelsError] = useState<string | null>(null)

  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [input, setInput] = useState('')
  const [streaming, setStreaming] = useState(false)

  const bottomRef = useRef<HTMLDivElement>(null)
  const abortRef = useRef<AbortController | null>(null)

  useEffect(() => {
    listModels()
      .then(list => {
        setModels(list)
        if (list.length > 0) setSelectedModel(list[0])
      })
      .catch(() => setModelsError('Impossible de contacter Ollama. Vérifiez qu\'il est démarré.'))
  }, [])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  async function send() {
    const text = input.trim()
    if (!text || !selectedModel || streaming) return

    const userMsg: ChatMessage = { role: 'user', content: text }
    const nextMessages = [...messages, userMsg]
    setMessages(nextMessages)
    setInput('')
    setStreaming(true)

    const assistantIndex = nextMessages.length
    setMessages(prev => [...prev, { role: 'assistant', content: '' }])

    abortRef.current = new AbortController()
    try {
      const res = await streamChat(projectId, selectedModel, nextMessages, abortRef.current.signal)
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
            const { token } = JSON.parse(raw) as { token: string }
            setMessages(prev => {
              const copy = [...prev]
              copy[assistantIndex] = {
                ...copy[assistantIndex],
                content: copy[assistantIndex].content + token,
              }
              return copy
            })
          } catch {
            // malformed SSE line, skip
          }
        }
      }
    } catch (err) {
      if ((err as Error).name !== 'AbortError') {
        setMessages(prev => {
          const copy = [...prev]
          copy[assistantIndex] = { role: 'assistant', content: '⚠ Erreur lors de la génération.' }
          return copy
        })
      }
    } finally {
      setStreaming(false)
      abortRef.current = null
    }
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      send()
    }
  }

  return (
    <div className={styles.root}>
      <div className={styles.topBar}>
        <label className={styles.modelLabel} htmlFor="model-select">Modèle</label>
        {modelsError ? (
          <span className={styles.modelError}>{modelsError}</span>
        ) : models.length === 0 ? (
          <span className={styles.modelLoading}>Chargement…</span>
        ) : (
          <select
            id="model-select"
            className={styles.modelSelect}
            value={selectedModel}
            onChange={e => setSelectedModel(e.target.value)}
            disabled={streaming}
          >
            {models.map(m => (
              <option key={m} value={m}>{m}</option>
            ))}
          </select>
        )}
      </div>

      <div className={styles.messages}>
        {messages.length === 0 && (
          <div className={styles.empty}>
            Sélectionnez un modèle et commencez la conversation.
          </div>
        )}
        {messages.map((msg, i) => (
          <div key={i} className={`${styles.message} ${msg.role === 'user' ? styles.user : styles.assistant}`}>
            <span className={styles.avatar}>
              {msg.role === 'user' ? <User size={16} /> : <Bot size={16} />}
            </span>
            <div className={styles.bubble}>
              {msg.content || (streaming && i === messages.length - 1 ? (
                <span className={styles.cursor} />
              ) : null)}
            </div>
          </div>
        ))}
        <div ref={bottomRef} />
      </div>

      <div className={styles.inputBar}>
        <textarea
          className={styles.textarea}
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Écrivez votre message… (Entrée pour envoyer, Maj+Entrée pour un saut de ligne)"
          rows={1}
          disabled={streaming || !!modelsError}
        />
        <button
          className={styles.sendBtn}
          onClick={send}
          disabled={!input.trim() || streaming || !!modelsError || !selectedModel}
          aria-label="Envoyer"
        >
          <ArrowUp size={18} />
        </button>
      </div>
    </div>
  )
}
