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
import { CONVERSATION_PAGE_SIZE, useConversationStore } from '../../hooks/useConversationStore'
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

  // Tracks the projectId we've already auto-loaded for, so we don't re-fire
  // the effect when the user explicitly starts a fresh chat (which would
  // otherwise look like the same "no pinned, no messages" state we use as a
  // trigger). Resets implicitly on remount (e.g. leaving and returning to
  // the Chat section), which is exactly when we want to auto-load again.
  const autoLoadedRef = useRef<string | null>(null)

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
    autoLoadedRef.current = null
    // chat.clear and model.reset are stable references but not memoized
    // against `provider` — intentional reset on project change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId])

  // Auto-load the most recent conversation when the Chat view mounts (or
  // when switching to a project for the first time). Lets the user resume
  // their last conversation after navigating away from the section and back.
  // Skipped if the user has already pinned/started something or there's
  // nothing saved for this project.
  useEffect(() => {
    if (autoLoadedRef.current === projectId) return
    if (store.loading) return
    if (store.pinned) return
    if (chat.streaming) return
    if (chat.messages.length > 0) return
    if (store.conversations.length === 0) {
      autoLoadedRef.current = projectId
      return
    }
    // Mark BEFORE the await so subsequent state changes (pinned, conversations
    // list refreshed mid-load) don't re-fire this effect.
    autoLoadedRef.current = projectId
    const latestId = store.conversations[0].id
    chat.load.begin('initial')
    store
      .load(latestId)
      .then((conv) => {
        chat.window.resetMessages(conv.messages, conv.messages_offset)
        model.loadFromConversation(conv)
      })
      .catch(() => {
        // Conversation may have been deleted in another tab; clear our flag
        // and refresh the list so the next render can try the new top entry.
        autoLoadedRef.current = null
        store.refresh()
      })
      .finally(() => {
        chat.load.end()
      })
    // chat.resetMessages, store.load, store.refresh, model.loadFromConversation
    // are stable callbacks but not memoized — listing them would re-run the
    // effect on every render via fresh references.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    projectId,
    store.loading,
    store.pinned,
    store.conversations,
    chat.streaming,
    chat.messages.length,
  ])

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
    // Close the panel + show the skeleton **before** the network round-trip
    // so the click feels instant. The chat hook's load.begin swaps the
    // message list for a placeholder until resetMessages lands.
    setOpenPanel(null)
    setSaveError(null)
    chat.load.begin('initial')
    try {
      const conv = await store.load(id)
      chat.window.resetMessages(conv.messages, conv.messages_offset)
      model.loadFromConversation(conv)
    } catch {
      store.refresh()
    } finally {
      chat.load.end()
    }
  }

  async function handleLoadOlder() {
    if (!store.pinned) return
    if (chat.window.offset === 0) return
    if (chat.load.state !== null) return
    if (chat.streaming) return
    chat.load.begin('older')
    try {
      const newOffset = Math.max(0, chat.window.offset - CONVERSATION_PAGE_SIZE)
      const limit = chat.window.offset - newOffset
      const older = await store.loadOlder(store.pinned.id, newOffset, limit)
      chat.window.prependOlder(older.messages)
    } catch (err) {
      // Network failure here is non-critical; the existing window stays put
      // and the sentinel will re-fire if the user scrolls again. Log so a
      // flaky network is at least visible in DevTools.
      console.warn('Failed to load older messages', err)
    } finally {
      chat.load.end()
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

    const mentions = resolveMentions(parseMentions(text, sources), sources)
    const result = await chat.send(projectId, text, turnModel, mentions, turnProvider, sources)
    if (result.status !== 'ok') return

    try {
      // For an already-pinned conversation the store appends `result.newMessages`
      // (just the freshly produced turn). For a brand-new chat with no pinned
      // id yet, the store still calls create with the full local window —
      // newMessages and messages are equal in that case.
      const payloadMessages = store.pinned ? result.newMessages : result.messages
      await store.persist({
        provider: turnProvider,
        model: turnModel,
        messages: payloadMessages,
      })
      chat.window.markSynced()
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

  const currentTitle = store.conversations.find((c) => c.id === store.pinned?.id)?.title ?? ''

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

        <ChatMessages
          messages={chat.messages}
          streaming={chat.streaming}
          plainText={plainText}
          messagesOffset={chat.window.offset}
          loadingState={chat.load.state}
          onLoadOlder={handleLoadOlder}
        />

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
