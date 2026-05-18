import { ArrowUp, History, Info, Settings, X } from 'lucide-react'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  getStoredApiKey,
  getStoredGlobalRag,
  getStoredNeighborChunks,
  getStoredPlainText,
  type LLMProvider,
  PROVIDER_LABELS,
  setStoredGlobalRag,
  setStoredNeighborChunks,
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

interface SettingsToggleProps {
  title: string
  hint: string
  checked: boolean
  onChange: () => void
}

function SettingsToggle({ title, hint, checked, onChange }: SettingsToggleProps) {
  return (
    <label className={styles.settingsRow}>
      <span className={styles.settingsLabel}>
        <span className={styles.settingsTitle}>{title}</span>
        <InfoTooltip text={hint} />
      </span>
      <span className={styles.settingsSwitch}>
        <input
          type="checkbox"
          className={styles.settingsSwitchInput}
          checked={checked}
          onChange={onChange}
        />
        <span className={styles.settingsSwitchTrack} aria-hidden="true" />
      </span>
    </label>
  )
}

/**
 * Hover/focus tooltip rendered via a React Portal into `document.body`.
 * The settings panel's ancestors (`.panel`, `.wrapper`) use `overflow: hidden`
 * for the slide animation, and `.panel` has a `transform` that traps even
 * `position: fixed` descendants — only a portal can reliably escape both.
 *
 * Anchored to the trigger's right edge (icon sits near the right edge of the
 * panel which sits at the right edge of the viewport, so the bubble extends
 * leftward to avoid clipping past the viewport's right boundary).
 */
function InfoTooltip({ text }: { text: string }) {
  const triggerRef = useRef<HTMLSpanElement>(null)
  const [pos, setPos] = useState<{ top: number; right: number } | null>(null)

  function show() {
    const el = triggerRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    // If the trigger is off the right edge of the viewport (which happens
    // briefly while the settings panel slides in), `innerWidth - rect.right`
    // is negative — applying that as CSS `right` would push the tooltip past
    // the viewport edge, widen the document, and trigger a horizontal
    // scrollbar that visually shifts the chat under the panel. Clamping to
    // a small margin keeps the tooltip on-screen and the chat layout stable.
    const right = Math.max(8, window.innerWidth - rect.right)
    setPos({ top: rect.top - 6, right })
  }

  function hide() {
    setPos(null)
  }

  return (
    <>
      <span
        ref={triggerRef}
        className={styles.settingsInfo}
        aria-label={text}
        role="img"
        tabIndex={0}
        onMouseEnter={show}
        onMouseLeave={hide}
        onFocus={show}
        onBlur={hide}
        // Clicking the info icon inside a label would otherwise toggle the
        // checkbox; preventing default keeps the icon purely informational.
        onClick={(e) => e.preventDefault()}
      >
        <Info size={16} aria-hidden="true" />
      </span>
      {pos &&
        createPortal(
          <div
            className={styles.settingsTooltip}
            style={{ top: pos.top, right: pos.right }}
            role="tooltip"
          >
            {text}
          </div>,
          document.body
        )}
    </>
  )
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
  const [neighborChunks, setNeighborChunks] = useState<boolean>(() => getStoredNeighborChunks())
  const [globalRag, setGlobalRag] = useState<boolean>(() => getStoredGlobalRag())
  const [titleDraft, setTitleDraft] = useState<string>('')

  function togglePlainText() {
    setPlainText((prev) => {
      const next = !prev
      setStoredPlainText(next)
      return next
    })
  }

  function toggleNeighborChunks() {
    setNeighborChunks((prev) => {
      const next = !prev
      setStoredNeighborChunks(next)
      return next
    })
  }

  function toggleGlobalRag() {
    setGlobalRag((prev) => {
      const next = !prev
      setStoredGlobalRag(next)
      return next
    })
  }

  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const settingsPanelRef = useRef<HTMLDivElement>(null)
  const settingsOpenerRef = useRef<HTMLButtonElement>(null)
  const [sources, setSources] = useState<SourceInfo[]>([])
  const mentionPicker = useMentionPicker(textareaRef, sources, chat.setInput)

  // Focus management for the settings panel: when it opens, move focus
  // inside; trap Tab/Shift+Tab so keyboard users can't escape into the
  // underlying chat surface while it's overlaid; Escape closes. On close
  // we restore focus to the toolbar button that opened it.
  //
  // Every focus() call passes `preventScroll: true`. The panel itself starts
  // off-screen (transform: translateX(100%)) and animates in over 150ms; if
  // we focused an element inside it without preventScroll, the browser would
  // scroll the document horizontally to bring the off-screen target into
  // view, shifting the chat sideways for ~150ms before the panel slides
  // over. The same issue applies to focusable info-icon spans inside the
  // panel during Tab cycling.
  useEffect(() => {
    if (!settingsOpen) return
    const panel = settingsPanelRef.current
    if (!panel) return

    const focusableSelector =
      'button:not([disabled]), [href], input:not([disabled]), [tabindex]:not([tabindex="-1"])'

    const focusables = (): HTMLElement[] =>
      Array.from(panel.querySelectorAll<HTMLElement>(focusableSelector)).filter(
        (el) => !el.hasAttribute('aria-hidden')
      )

    const first = focusables()[0]
    first?.focus({ preventScroll: true })

    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.preventDefault()
        setOpenPanel(null)
        return
      }
      if (e.key !== 'Tab') return
      const items = focusables()
      if (items.length === 0) return
      const firstEl = items[0]
      const lastEl = items[items.length - 1]
      const active = document.activeElement as HTMLElement | null
      if (e.shiftKey && active === firstEl) {
        e.preventDefault()
        lastEl.focus({ preventScroll: true })
      } else if (!e.shiftKey && active === lastEl) {
        e.preventDefault()
        firstEl.focus({ preventScroll: true })
      }
    }

    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      // Restore focus to whatever button toggled the panel open. Skipping
      // when focus has already moved elsewhere (e.g. user clicked outside)
      // avoids stealing focus from another interactive target.
      if (document.activeElement === document.body) {
        settingsOpenerRef.current?.focus({ preventScroll: true })
      }
    }
  }, [settingsOpen])

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
        chat.window.resetMessages(
          conv.messages,
          conv.messages_offset,
          conv.last_variants,
          conv.last_variant_index
        )
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
      chat.window.resetMessages(
        conv.messages,
        conv.messages_offset,
        conv.last_variants,
        conv.last_variant_index
      )
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

  async function handleRegenerate() {
    if (chat.streaming) return
    if (chat.load.state !== null) return

    const msgs = chat.messages
    const lastIndex = msgs.length - 1
    if (lastIndex < 1 || msgs[lastIndex].role !== 'assistant') return
    // The user turn that prompted the answer — its mentions drive retrieval,
    // so we re-resolve them for the regenerated request.
    const lastUser = [...msgs.slice(0, lastIndex)].reverse().find((m) => m.role === 'user')
    if (!lastUser) return

    if (!model.resolvedModel) return
    const turnProvider = model.provider
    const turnModel = model.resolvedModel

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

    const mentions = resolveMentions(parseMentions(lastUser.content, sources), sources)
    const result = await chat.regenerate(projectId, turnModel, mentions, turnProvider, sources)
    // On failure the hook has already restored the previous answer; surface
    // the error (an aborted regeneration is a deliberate user action).
    if (result.status === 'aborted') return
    if (result.status === 'error') {
      setSaveError('Échec de la régénération de la réponse. Réessayez.')
      return
    }

    // A regenerate on a chat that was never saved is a throwaway debug
    // re-roll (the model bugged or hallucinated) — don't create a
    // conversation on disk for it. Persist the new variant only when the
    // conversation already exists.
    if (!store.pinned) return

    try {
      const regenerated = result.messages[result.messages.length - 1]
      // Record the answer as a new variant, then reconcile local state with
      // the server-authoritative result.
      const state = await store.addVariant(regenerated.content)
      chat.variants.sync(state.last_variants, state.last_variant_index)
      chat.window.markSynced()
    } catch (err) {
      console.error('Failed to persist regenerated message', err)
      setSaveError(
        'Échec de l’enregistrement de la réponse régénérée — elle ne sera peut-être pas restaurée.'
      )
    }
  }

  async function handleSelectVariant(index: number) {
    if (chat.streaming) return
    if (chat.load.state !== null) return
    if (index === chat.variants.index) return
    // Update the displayed answer immediately, then persist the choice and
    // reconcile with the server-authoritative variant state.
    chat.variants.select(index)
    if (!store.pinned) return
    try {
      const state = await store.selectVariant(index)
      chat.variants.sync(state.last_variants, state.last_variant_index)
    } catch (err) {
      console.error('Failed to persist variant selection', err)
      setSaveError('Échec de l’enregistrement de la variante sélectionnée.')
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
        id="chat-settings-panel"
        ref={settingsPanelRef}
        className={`${styles.panel} ${styles.panelRight} ${settingsOpen ? styles.panelOpen : ''}`}
        role="dialog"
        aria-modal={settingsOpen}
        aria-label="Paramètres du chat"
        aria-hidden={!settingsOpen}
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
          <SettingsToggle
            title="Texte brut"
            hint="Demande au modèle de répondre sans mise en page (pas de gras, titres, listes…)."
            checked={plainText}
            onChange={togglePlainText}
          />
          <SettingsToggle
            title="Chunks voisins pour les mentions"
            hint="Inclut les passages adjacents aux extraits pertinents d’un document mentionné avec @. Améliore la continuité de lecture, consomme plus de contexte."
            checked={neighborChunks}
            onChange={toggleNeighborChunks}
          />
          <SettingsToggle
            title="Recherche automatique dans tout le corpus"
            hint="À chaque message, cherche les passages pertinents dans l’ensemble des documents du projet (RAG). Utile quand aucun document n’est mentionné explicitement."
            checked={globalRag}
            onChange={toggleGlobalRag}
          />
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
            ref={settingsOpenerRef}
            type="button"
            className={`${styles.toolbarBtn} ${settingsOpen ? styles.toolbarBtnActive : ''}`}
            onClick={() => togglePanel('settings')}
            aria-label="Paramètres du chat"
            aria-pressed={settingsOpen}
            aria-expanded={settingsOpen}
            aria-controls="chat-settings-panel"
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
          onRegenerate={handleRegenerate}
          variantCount={chat.variants.items.length}
          variantIndex={chat.variants.index}
          onSelectVariant={handleSelectVariant}
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
