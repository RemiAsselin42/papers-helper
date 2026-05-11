import { ArrowUp, Bot, RotateCcw, User } from 'lucide-react'
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  getStoredExternalModel,
  getStoredOllamaModel,
  type LLMProvider,
  setStoredExternalModel,
  setStoredOllamaModel,
  setStoredProvider,
} from '../api/llm'
import { useChatStream } from '../hooks/useChatStream'
import { useConversationStore } from '../hooks/useConversationStore'
import styles from './ChatView.module.scss'
import { ConversationList } from './ConversationList'

interface Props {
  projectId: string
  provider: LLMProvider
  /** Increments when the user picks a new Ollama model in the header — used
   *  to re-read the stored value here. */
  ollamaModelBump: number
  /** Notify App when a saved conversation pins a different provider. */
  onResumeProvider: (p: LLMProvider) => void
  /** Bump the header ModelSelector so it re-reads the stored Ollama model. */
  onResumeOllamaModel: () => void
}

// Backend default — must match OLLAMA_GENERATION_MODEL in app/config.py.
const OLLAMA_FALLBACK_MODEL = 'llama3'

/** Strip a `:tag` suffix for comparison. `llama3:latest` and `llama3` are the
 *  same underlying model for our purposes. */
function modelBase(name: string): string {
  return name.split(':')[0]
}

export function ChatView({
  projectId,
  provider,
  ollamaModelBump,
  onResumeProvider,
  onResumeOllamaModel,
}: Props) {
  const chat = useChatStream()
  const store = useConversationStore(projectId)
  const [saveError, setSaveError] = useState<string | null>(null)

  const bottomRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  // Auto-grow textarea: reset then snap to scrollHeight. CSS `max-height`
  // caps it at 10 lines and switches to scroll. We add `offsetHeight -
  // clientHeight` (= border height with box-sizing: border-box) so a
  // single-line textarea doesn't show a 1–2px phantom scrollbar.
  useLayoutEffect(() => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    const borderDelta = el.offsetHeight - el.clientHeight
    el.style.height = `${el.scrollHeight + borderDelta}px`
  }, [chat.input])

  const resolvedModel = useMemo(() => {
    if (provider !== 'ollama') {
      return getStoredExternalModel(provider)
    }
    return getStoredOllamaModel() ?? OLLAMA_FALLBACK_MODEL
    // ollamaModelBump is read indirectly via getStoredOllamaModel(); listing
    // it in deps forces useMemo to refresh when the header selection changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [provider, ollamaModelBump])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [chat.messages])

  // Reset chat when the project changes.
  useEffect(() => {
    chat.clear()
    setSaveError(null)
    // chat.clear is stable per render but not deeply memoized — intentional reset.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId])

  function applyPin(p: LLMProvider, model: string) {
    setStoredProvider(p)
    if (p === 'ollama') {
      setStoredOllamaModel(model)
      onResumeOllamaModel()
    } else {
      setStoredExternalModel(p, model)
    }
    onResumeProvider(p)
  }

  async function handleSelect(id: string) {
    if (chat.streaming) return
    try {
      const conv = await store.load(id)
      chat.resetMessages(conv.messages)
      setSaveError(null)
      applyPin(conv.provider, conv.model)
    } catch {
      store.refresh()
    }
  }

  function handleNew() {
    if (chat.streaming) return
    chat.clear()
    store.clear()
    setSaveError(null)
  }

  async function handleDelete(id: string) {
    if (chat.streaming) return
    const wasActive = store.pinned?.id === id
    await store.remove(id)
    if (wasActive) {
      chat.clear()
      setSaveError(null)
    }
  }

  const pinnedMismatch =
    store.pinned !== null &&
    (store.pinned.provider !== provider ||
      modelBase(store.pinned.model) !== modelBase(resolvedModel))

  function restorePinned() {
    if (!store.pinned) return
    applyPin(store.pinned.provider, store.pinned.model)
  }

  async function send() {
    const text = chat.input.trim()
    if (!text || !resolvedModel || chat.streaming || pinnedMismatch) return

    const turnProvider = provider
    const turnModel = resolvedModel
    setSaveError(null)

    const result = await chat.send(projectId, text, turnModel)
    if (result.status !== 'ok') return

    try {
      await store.persist({
        provider: turnProvider,
        model: turnModel,
        messages: result.messages,
      })
    } catch (err) {
      console.error('Failed to persist conversation', err)
      setSaveError(
        'Échec de l’enregistrement de la conversation — votre dernier message ne sera peut-être pas restauré.',
      )
    }
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      send()
    }
  }

  return (
    <div className={styles.layout}>
      <ConversationList
        conversations={store.conversations}
        currentId={store.pinned?.id ?? null}
        onSelect={handleSelect}
        onNew={handleNew}
        onDelete={handleDelete}
        onRename={store.rename}
      />
      <div className={styles.root}>
        <div className={styles.messages}>
          {chat.messages.length === 0 && (
            <div className={styles.empty}>
              Commencez la conversation — le modèle est défini dans l’en-tête.
            </div>
          )}
          {chat.messages.map((msg, i) => (
            <div
              key={i}
              className={`${styles.message} ${msg.role === 'user' ? styles.user : styles.assistant}`}
            >
              <span className={styles.avatar}>
                {msg.role === 'user' ? <User size={16} /> : <Bot size={16} />}
              </span>
              <div className={styles.bubble}>
                {msg.content ||
                  (chat.streaming && i === chat.messages.length - 1 ? (
                    <span className={styles.cursor} />
                  ) : null)}
              </div>
            </div>
          ))}
          <div ref={bottomRef} />
        </div>

        {pinnedMismatch && store.pinned && (
          <div className={styles.pinnedBanner}>
            <span>
              Modèle initial <code>{store.pinned.model}</code> ({store.pinned.provider}) — la
              sélection actuelle de l’en-tête ne correspond pas.
            </span>
            <button
              type="button"
              className={styles.pinnedRestoreBtn}
              onClick={restorePinned}
              title="Restaurer le modèle initial"
            >
              <RotateCcw size={14} />
              <span>Restaurer</span>
            </button>
          </div>
        )}

        {saveError && (
          <div className={styles.saveErrorBanner} role="alert">
            <span>{saveError}</span>
            <button
              type="button"
              className={styles.saveErrorDismiss}
              onClick={() => setSaveError(null)}
              aria-label="Fermer"
            >
              ×
            </button>
          </div>
        )}

        <div className={styles.inputBar}>
          <textarea
            ref={textareaRef}
            className={styles.textarea}
            value={chat.input}
            onChange={e => chat.setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Écrivez votre message… (Entrée pour envoyer, Maj+Entrée pour un saut de ligne)"
            rows={1}
            disabled={chat.streaming}
          />
          <button
            className={styles.sendBtn}
            onClick={send}
            disabled={!chat.input.trim() || chat.streaming || !resolvedModel || pinnedMismatch}
            aria-label="Envoyer"
          >
            <ArrowUp size={18} />
          </button>
        </div>
      </div>
    </div>
  )
}
