import { ArrowUp, Bot, History, Settings, User, X } from 'lucide-react'
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import {
  getStoredApiKey,
  getStoredExternalModel,
  getStoredOllamaModel,
  getStoredPlainText,
  type LLMProvider,
  PROVIDER_LABELS,
  setStoredPlainText,
} from '../api/llm'
import { listSources, type SourceInfo } from '../api/projects'
import { useChatStream } from '../hooks/useChatStream'
import { useConversationStore } from '../hooks/useConversationStore'
import {
  findActiveMention,
  mentionInsertion,
  mentionItemCount,
  parseMentions,
  resolveMentions,
} from '../utils/mentions'
import { ModelSelector } from './ModelSelector'
import styles from './ChatView.module.scss'
import { ConversationList } from './ConversationList'
import { MentionPopover } from './MentionPopover'

interface Props {
  projectId: string
  provider: LLMProvider
  onConfigureOllama: () => void
  onRequestApiKey: (provider: Exclude<LLMProvider, 'ollama'>) => void
}

// Backend default — must match OLLAMA_GENERATION_MODEL in app/config.py.
const OLLAMA_FALLBACK_MODEL = 'llama3'

type ExternalModelOverrides = Partial<Record<Exclude<LLMProvider, 'ollama'>, string>>

export function ChatView({ projectId, provider, onConfigureOllama, onRequestApiKey }: Props) {
  const chat = useChatStream()
  const store = useConversationStore(projectId)
  const [saveError, setSaveError] = useState<string | null>(null)
  type OpenPanel = 'history' | 'settings' | null
  const [openPanel, setOpenPanel] = useState<OpenPanel>(null)
  const historyOpen = openPanel === 'history'
  const settingsOpen = openPanel === 'settings'
  const [plainText, setPlainText] = useState<boolean>(() => getStoredPlainText())

  // Per-chat provider/model. Independent of localStorage — only affects this
  // conversation. New chats seed from the header (`provider` prop + stored
  // defaults); loaded conversations seed from their persisted values.
  const [chatProvider, setChatProvider] = useState<LLMProvider>(provider)
  const [chatOllamaModel, setChatOllamaModel] = useState<string | null>(() =>
    getStoredOllamaModel()
  )
  const [chatExternalModel, setChatExternalModel] = useState<ExternalModelOverrides>({})

  const [titleDraft, setTitleDraft] = useState<string>('')

  function togglePlainText() {
    setPlainText((prev) => {
      const next = !prev
      setStoredPlainText(next)
      return next
    })
  }

  const bottomRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  // Source list + @mention popover state.
  const [sources, setSources] = useState<SourceInfo[]>([])
  const [mention, setMention] = useState<{ start: number; query: string } | null>(null)
  const [mentionHighlight, setMentionHighlight] = useState(0)

  useEffect(() => {
    let cancelled = false
    listSources(projectId)
      .then((list) => {
        if (!cancelled) setSources(list)
      })
      .catch(() => {
        if (!cancelled) setSources([])
      })
    return () => {
      cancelled = true
    }
  }, [projectId])

  function refreshMentionFromCaret() {
    const el = textareaRef.current
    if (!el) return
    const caret = el.selectionStart ?? el.value.length
    const found = findActiveMention(el.value, caret)
    setMention((prev) => {
      if (!found) return null
      if (prev && prev.start === found.start && prev.query === found.query) {
        return prev
      }
      setMentionHighlight(0)
      return found
    })
  }

  function closeMention() {
    setMention(null)
    setMentionHighlight(0)
  }

  function applyMentionInsertion(insertion: string) {
    const el = textareaRef.current
    if (!el || !mention) return
    const value = el.value
    const caret = el.selectionStart ?? value.length
    const before = value.slice(0, mention.start)
    const after = value.slice(caret)
    const next = `${before}@${insertion}${after}`
    chat.setInput(next)
    closeMention()
    // Place caret right after the inserted text and re-run detection so the
    // popover progresses (e.g. type → file step).
    const nextCaret = before.length + 1 + insertion.length
    queueMicrotask(() => {
      const node = textareaRef.current
      if (!node) return
      node.focus()
      node.setSelectionRange(nextCaret, nextCaret)
      refreshMentionFromCaret()
    })
  }

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
    if (chatProvider === 'ollama') return chatOllamaModel ?? OLLAMA_FALLBACK_MODEL
    return chatExternalModel[chatProvider] ?? getStoredExternalModel(chatProvider)
  }, [chatProvider, chatOllamaModel, chatExternalModel])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [chat.messages])

  // Reset chat when the project changes.
  useEffect(() => {
    chat.clear()
    setSaveError(null)
    setChatProvider(provider)
    setChatOllamaModel(getStoredOllamaModel())
    setChatExternalModel({})
    setTitleDraft('')
    // chat.clear is stable per render but not deeply memoized — intentional reset.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId])

  // Sync the editable title with the pinned conversation's stored title.
  useEffect(() => {
    if (!store.pinned) {
      setTitleDraft('')
      return
    }
    const summary = store.conversations.find((c) => c.id === store.pinned!.id)
    if (summary) setTitleDraft(summary.title)
  }, [store.pinned, store.conversations])

  function togglePanel(panel: 'history' | 'settings') {
    setOpenPanel((prev) => (prev === panel ? null : panel))
  }

  async function handleSelect(id: string) {
    if (chat.streaming) return
    try {
      const conv = await store.load(id)
      chat.resetMessages(conv.messages)
      setSaveError(null)
      setChatProvider(conv.provider)
      if (conv.provider === 'ollama') {
        setChatOllamaModel(conv.model)
      } else {
        setChatExternalModel((prev) => ({ ...prev, [conv.provider]: conv.model }))
      }
      setOpenPanel(null)
    } catch {
      store.refresh()
    }
  }

  function handleNew() {
    if (chat.streaming) return
    chat.clear()
    store.clear()
    setSaveError(null)
    setChatProvider(provider)
    setChatOllamaModel(getStoredOllamaModel())
    setChatExternalModel({})
    setTitleDraft('')
  }

  async function handleDelete(id: string) {
    if (chat.streaming) return
    const wasActive = store.pinned?.id === id
    await store.remove(id)
    if (wasActive) {
      chat.clear()
      setSaveError(null)
      setChatProvider(provider)
      setChatOllamaModel(getStoredOllamaModel())
      setChatExternalModel({})
      setTitleDraft('')
    }
  }

  async function commitTitle() {
    if (!store.pinned) return
    const next = titleDraft.trim()
    const current = store.conversations.find((c) => c.id === store.pinned!.id)?.title ?? ''
    if (!next || next === current) {
      setTitleDraft(current)
      return
    }
    try {
      await store.rename(store.pinned.id, next)
    } catch {
      setTitleDraft(current)
    }
  }

  function handleModelChange(p: LLMProvider, ollama: string | null) {
    setChatProvider(p)
    if (p === 'ollama') {
      setChatOllamaModel(ollama)
    }
  }

  async function send() {
    const text = chat.input.trim()
    if (!text || !resolvedModel || chat.streaming) return

    const turnProvider = chatProvider
    const turnModel = resolvedModel

    // Pre-send guard: surface a friendly message rather than letting the
    // request fail with an opaque 401 / fallback model not found.
    if (turnProvider !== 'ollama' && !getStoredApiKey(turnProvider)) {
      setSaveError(`Clé API manquante pour ${PROVIDER_LABELS[turnProvider]}.`)
      return
    }
    if (turnProvider === 'ollama' && !chatOllamaModel) {
      setSaveError('Aucun modèle Ollama sélectionné.')
      return
    }

    setSaveError(null)
    closeMention()

    const mentions = resolveMentions(parseMentions(text), sources)
    const result = await chat.send(projectId, text, turnModel, mentions, turnProvider)
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
        'Échec de l’enregistrement de la conversation — votre dernier message ne sera peut-être pas restauré.'
      )
    }
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (mention) {
      const count = mentionItemCount(mention.query, sources)
      if (e.key === 'Escape') {
        e.preventDefault()
        closeMention()
        return
      }
      if (e.key === 'ArrowDown' && count > 0) {
        e.preventDefault()
        setMentionHighlight((h) => (h + 1) % count)
        return
      }
      if (e.key === 'ArrowUp' && count > 0) {
        e.preventDefault()
        setMentionHighlight((h) => (h - 1 + count) % count)
        return
      }
      if ((e.key === 'Enter' || e.key === 'Tab') && count > 0) {
        const insertion = mentionInsertion(mention.query, sources, mentionHighlight)
        if (insertion !== null) {
          e.preventDefault()
          applyMentionInsertion(insertion)
          return
        }
      }
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      send()
    }
  }

  return (
    <div className={styles.wrapper}>
      {(historyOpen || settingsOpen) && (
        <div className={styles.backdrop} onClick={() => setOpenPanel(null)} />
      )}

      <div className={`${styles.panel} ${styles.panelLeft} ${historyOpen ? styles.panelOpen : ''}`}>
        <button
          type="button"
          className={styles.panelClose}
          onClick={() => setOpenPanel(null)}
          aria-label="Fermer le panneau"
          title="Fermer"
        >
          <X size={20} />
        </button>
        <ConversationList
          conversations={store.conversations}
          loading={store.loading}
          currentId={store.pinned?.id ?? null}
          onSelect={handleSelect}
          onNew={handleNew}
          onDelete={handleDelete}
          onRename={store.rename}
        />
      </div>

      <div
        className={`${styles.panel} ${styles.panelRight} ${settingsOpen ? styles.panelOpen : ''}`}
      >
        <button
          type="button"
          className={styles.panelClose}
          onClick={() => setOpenPanel(null)}
          aria-label="Fermer le panneau"
          title="Fermer"
        >
          <X size={20} />
        </button>
        <div className={styles.settingsList}>
          <label className={styles.settingsRow}>
            <span className={styles.settingsLabel}>
              <span className={styles.settingsTitle}>Texte brut</span>
              <span className={styles.settingsHint}>
                Demande au modèle de répondre sans mise en page (pas de gras, titres, listes…).
              </span>
            </span>
            <input
              type="checkbox"
              className={styles.settingsToggle}
              checked={plainText}
              onChange={togglePlainText}
            />
          </label>
        </div>
      </div>

      <div className={styles.root}>
        <div className={styles.toolbar}>
          <button
            type="button"
            className={`${styles.toolbarBtn} ${historyOpen ? styles.toolbarBtnActive : ''}`}
            onClick={() => togglePanel('history')}
            aria-label="Historique des conversations"
            aria-pressed={historyOpen}
            title="Historique des conversations"
          >
            <History size={20} />
          </button>
          <input
            type="text"
            className={styles.toolbarTitle}
            value={titleDraft}
            onChange={(e) => setTitleDraft(e.target.value)}
            onBlur={commitTitle}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                ;(e.target as HTMLInputElement).blur()
              } else if (e.key === 'Escape') {
                e.preventDefault()
                const current =
                  store.conversations.find((c) => c.id === store.pinned?.id)?.title ?? ''
                setTitleDraft(current)
                ;(e.target as HTMLInputElement).blur()
              }
            }}
            placeholder="Nouvelle conversation"
            disabled={!store.pinned || chat.streaming}
            title={titleDraft || 'Nouvelle conversation'}
            aria-label="Nom de la conversation"
          />
          <ModelSelector
            provider={chatProvider}
            ollamaModel={chatProvider === 'ollama' ? chatOllamaModel : null}
            onChange={handleModelChange}
            onConfigureOllama={onConfigureOllama}
            onRequestApiKey={onRequestApiKey}
            disabled={chat.streaming}
          />
          <button
            type="button"
            className={`${styles.toolbarBtn} ${settingsOpen ? styles.toolbarBtnActive : ''}`}
            onClick={() => togglePanel('settings')}
            aria-label="Paramètres du chat"
            aria-pressed={settingsOpen}
            title="Paramètres du chat"
          >
            <Settings size={20} />
          </button>
        </div>

        <div className={styles.messages}>
          {chat.messages.length === 0 && (
            <div className={styles.empty}>
              Commencez la conversation
              <br />
              Ctrl + Entrée pour un saut de ligne
              <br />@ pour mentionner une source
            </div>
          )}
          {chat.messages.map((msg, i) => {
            const isAssistant = msg.role === 'assistant'
            const renderMarkdown = isAssistant && !plainText
            const showCursor = !msg.content && chat.streaming && i === chat.messages.length - 1
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
          {mention && (
            <MentionPopover
              query={mention.query}
              sources={sources}
              highlight={mentionHighlight}
              onHighlightChange={setMentionHighlight}
              onSelect={applyMentionInsertion}
            />
          )}
          <textarea
            ref={textareaRef}
            className={styles.textarea}
            value={chat.input}
            onChange={(e) => {
              chat.setInput(e.target.value)
              refreshMentionFromCaret()
            }}
            onKeyDown={handleKeyDown}
            onKeyUp={refreshMentionFromCaret}
            onClick={refreshMentionFromCaret}
            onBlur={closeMention}
            placeholder="Écrivez votre message…"
            rows={1}
            disabled={chat.streaming}
          />
          <button
            className={styles.sendBtn}
            onClick={send}
            disabled={!chat.input.trim() || chat.streaming || !resolvedModel}
            aria-label="Envoyer"
          >
            <ArrowUp size={20} />
          </button>
        </div>
      </div>
    </div>
  )
}
