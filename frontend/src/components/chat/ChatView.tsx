import { ArrowUp, History, Settings, X } from 'lucide-react'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import {
  getStoredApiKey,
  getStoredPlainText,
  type LLMProvider,
  PROVIDER_LABELS,
  setStoredPlainText,
} from '../../api/llm'
import { listSources, type SourceInfo } from '../../api/papers'
import { useChatStream } from '../../hooks/useChatStream'
import { useConversationStore } from '../../hooks/useConversationStore'
import { useMentionPicker } from '../../hooks/useMentionPicker'
import { usePerChatModel } from '../../hooks/usePerChatModel'
import { parseMentions, resolveMentions } from '../../utils/mentions'
import { ChatMessages } from './ChatMessages'
import { ChatTitleEditor } from './ChatTitleEditor'
import styles from './ChatView.module.scss'
import { ConversationList } from './ConversationList'
import { MentionPopover } from './MentionPopover'
import { ModelSelector } from './ModelSelector'

interface Props {
  projectId: string
  provider: LLMProvider
  onConfigureOllama: () => void
  onRequestApiKey: (provider: Exclude<LLMProvider, 'ollama'>) => void
}

export function ChatView({ projectId, provider, onConfigureOllama, onRequestApiKey }: Props) {
  const chat = useChatStream()
  const store = useConversationStore(projectId)
  const model = usePerChatModel(provider)
  const [saveError, setSaveError] = useState<string | null>(null)
  type OpenPanel = 'history' | 'settings' | null
  const [openPanel, setOpenPanel] = useState<OpenPanel>(null)
  const historyOpen = openPanel === 'history'
  const settingsOpen = openPanel === 'settings'
  const [plainText, setPlainText] = useState<boolean>(() => getStoredPlainText())
  const [titleDraft, setTitleDraft] = useState<string>('')

  function togglePlainText() {
    setPlainText((prev) => {
      const next = !prev
      setStoredPlainText(next)
      return next
    })
  }

  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const [sources, setSources] = useState<SourceInfo[]>([])
  const mentionPicker = useMentionPicker(textareaRef, sources, chat.setInput)

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

  // Reset chat when the project changes.
  useEffect(() => {
    chat.clear()
    setSaveError(null)
    model.reset(provider)
    setTitleDraft('')
    // chat.clear and model.reset are stable references but not memoized
    // against `provider` — intentional reset on project change.
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
      model.loadFromConversation(conv)
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
    model.reset(provider)
    setTitleDraft('')
  }

  async function handleDelete(id: string) {
    if (chat.streaming) return
    const wasActive = store.pinned?.id === id
    await store.remove(id)
    if (wasActive) {
      chat.clear()
      setSaveError(null)
      model.reset(provider)
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

  async function send() {
    const text = chat.input.trim()
    if (!text || !model.resolvedModel || chat.streaming) return

    const turnProvider = model.provider
    const turnModel = model.resolvedModel

    // Pre-send guard: surface a friendly message rather than letting the
    // request fail with an opaque 401 / fallback model not found.
    if (turnProvider !== 'ollama' && !getStoredApiKey(turnProvider)) {
      setSaveError(`Clé API manquante pour ${PROVIDER_LABELS[turnProvider]}.`)
      return
    }
    if (turnProvider === 'ollama' && !model.ollamaModel) {
      setSaveError('Aucun modèle Ollama sélectionné.')
      return
    }

    setSaveError(null)
    mentionPicker.close()

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
    if (mentionPicker.handleKey(e)) return
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      send()
    }
  }

  const currentTitle =
    store.conversations.find((c) => c.id === store.pinned?.id)?.title ?? ''

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
          <ChatTitleEditor
            value={titleDraft}
            currentTitle={currentTitle}
            onChange={setTitleDraft}
            onCommit={commitTitle}
            disabled={!store.pinned || chat.streaming}
          />
          <ModelSelector
            provider={model.provider}
            ollamaModel={model.provider === 'ollama' ? model.ollamaModel : null}
            onChange={model.handleChange}
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

        <ChatMessages messages={chat.messages} streaming={chat.streaming} plainText={plainText} />

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
          {mentionPicker.mention && (
            <MentionPopover
              query={mentionPicker.mention.query}
              sources={sources}
              highlight={mentionPicker.highlight}
              onHighlightChange={mentionPicker.setHighlight}
              onSelect={mentionPicker.applyInsertion}
            />
          )}
          <textarea
            ref={textareaRef}
            className={styles.textarea}
            value={chat.input}
            onChange={(e) => {
              chat.setInput(e.target.value)
              mentionPicker.refresh()
            }}
            onKeyDown={handleKeyDown}
            onKeyUp={mentionPicker.refresh}
            onClick={mentionPicker.refresh}
            onBlur={mentionPicker.close}
            placeholder="Écrivez votre message…"
            rows={1}
            disabled={chat.streaming}
          />
          <button
            className={styles.sendBtn}
            onClick={send}
            disabled={!chat.input.trim() || chat.streaming || !model.resolvedModel}
            aria-label="Envoyer"
          >
            <ArrowUp size={20} />
          </button>
        </div>
      </div>
    </div>
  )
}
