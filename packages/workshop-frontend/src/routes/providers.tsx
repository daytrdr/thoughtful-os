import { createFileRoute } from '@tanstack/react-router'
import { useState, useEffect, useRef } from 'react'
import { DropdownMenu, useKumoToastManager } from '@cloudflare/kumo'
import { useAuthenticatedApi } from '../AuthContext'
import {
  AiChatAuthorInfo,
  AiGatewayInfo,
  AiModelProvider,
  ChatGptSubscriptionInfo,
  SUGGESTED_MODELS,
} from '@gadgets/workshop-shared/api'
import { useChatGptSubscriptionLogin } from '../ServerConfigContext'
import {
  Plus,
  Trash,
  Lightning,
  MagnifyingGlass,
  DotsThreeVertical,
} from '@phosphor-icons/react'
import AddModelModal from '../AddModelModal'
import { useDocumentTitle } from '../useDocumentTitle'
import { MENU_CONTENT, MENU_ITEM, MENU_ITEM_DANGER } from '../components/menuStyles'

export const Route = createFileRoute('/providers')({ component: ProvidersPage })

// ─── constants ────────────────────────────────────────────────────────────────

const PROVIDER_ORDER = Object.keys(SUGGESTED_MODELS) as AiModelProvider[]

const PRIMARY_BTN =
  'press inline-flex h-9 shrink-0 cursor-pointer items-center justify-center gap-1.5 rounded-lg bg-kumo-brand px-3.5 text-[13px] font-medium tracking-[-0.25px] text-white transition-colors hover:bg-kumo-brand-hover'

// ─── model row ─────────────────────────────────────────────────────────────────

// Rows mirror the Blueprints list: a clickable row (here, clicking sets/clears the quick model)
// plus a kebab for the rest. The whole row is the primary affordance, so it shows a pointer.
function ModelRow({
  model,
  isQuick,
  isBuiltIn,
  isChatGpt,
  onDelete,
  onSetQuick,
}: {
  model: AiChatAuthorInfo
  isQuick: boolean
  isBuiltIn: boolean
  isChatGpt: boolean
  onDelete: () => void
  onSetQuick: () => void
}) {
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onSetQuick}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onSetQuick()
        }
      }}
      title={isQuick ? 'Quick model. Click to clear' : 'Click to set as quick model'}
      className="group flex cursor-pointer items-center gap-3 rounded-lg px-3 py-2.5 transition-colors duration-150 ease-out hover:bg-kumo-tint"
    >
      {/* Neutral monogram — matches the sidebar/workspaces treatment */}
      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-kumo-fill text-[12px] font-medium text-kumo-subtle">
        {model.name[0]?.toUpperCase()}
      </div>

      {/* Info */}
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-medium tracking-[-0.25px] text-kumo-default">
            {model.name}
          </span>
          {isBuiltIn && (
            <span className="shrink-0 rounded-full bg-kumo-tint px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-[0.4px] text-kumo-subtle">
              built-in
            </span>
          )}
          {isChatGpt && (
            <span className="shrink-0 rounded-full bg-kumo-tint px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-[0.4px] text-kumo-subtle" title="Billed to your ChatGPT plan">
              chatgpt
            </span>
          )}
          {isQuick && (
            <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-[rgba(255,72,1,0.10)] px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-[0.4px] text-kumo-brand">
              <Lightning size={9} weight="fill" />
              quick
            </span>
          )}
        </div>
        <span className="mt-0.5 block truncate font-mono text-[12px] tracking-[-0.1px] text-kumo-inactive">
          {model.id}
        </span>
      </div>

      {/* Actions */}
      <div onClick={(e) => { e.stopPropagation() }}>
        <DropdownMenu>
          <DropdownMenu.Trigger
            render={
              <button
                aria-label="Provider actions"
                className="cursor-pointer rounded-md p-1.5 text-kumo-subtle transition-colors hover:bg-kumo-fill hover:text-kumo-default focus:opacity-100 sm:opacity-0 sm:group-hover:opacity-100"
              >
                <DotsThreeVertical size={16} />
              </button>
            }
          />
          <DropdownMenu.Content className={MENU_CONTENT}>
            <DropdownMenu.Item onClick={onSetQuick} className={MENU_ITEM}>
              <Lightning size={13} className="mr-2" weight={isQuick ? 'fill' : 'regular'} />
              {isQuick ? 'Clear quick model' : 'Set as quick model'}
            </DropdownMenu.Item>
            {!isBuiltIn && (
              <DropdownMenu.Item variant="danger" onClick={onDelete} className={MENU_ITEM_DANGER}>
                <Trash size={13} className="mr-2" />
                Delete provider
              </DropdownMenu.Item>
            )}
          </DropdownMenu.Content>
        </DropdownMenu>
      </div>
    </div>
  )
}

// ─── notice ────────────────────────────────────────────────────────────────────

function Notice({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-3 rounded-xl border border-kumo-line bg-kumo-tint px-4 py-3 text-[13px] leading-[18px] tracking-[-0.25px] text-kumo-subtle">
      {children}
    </div>
  )
}

// ─── main page ────────────────────────────────────────────────────────────────

function ProvidersPage() {
  useDocumentTitle('AI Providers')

  const { authenticatedApi } = useAuthenticatedApi()
  const toasts = useKumoToastManager()
  const chatGptEnabled = useChatGptSubscriptionLogin()
  const [models, setModels] = useState<AiChatAuthorInfo[]>([])
  const [quickModel, setQuickModel] = useState<string | null>(null)
  const [aiConfig, setAiConfig] = useState<AiGatewayInfo | null>(null)
  const [chatGpt, setChatGpt] = useState<ChatGptSubscriptionInfo | null>(null)
  const [search, setSearch] = useState('')
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(false)
  // Which panel the add dialog opens on; null when closed.
  const [sheet, setSheet] = useState<'model' | 'chatgpt' | null>(null)
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [disconnecting, setDisconnecting] = useState(false)

  const fetchAll = async () => {
    setLoadError(false)
    try {
      const [modelList, qm, cfg, plan] = await Promise.all([
        authenticatedApi.listModels(),
        authenticatedApi.getQuickModel(),
        authenticatedApi.getAiConfig(),
        chatGptEnabled ? authenticatedApi.getChatGptSubscription() : Promise.resolve(null),
      ])
      setModels(modelList)
      setQuickModel(qm)
      setAiConfig(cfg)
      setChatGpt(plan)
    } catch (err) {
      console.error('Failed to load providers:', err)
      setLoadError(true)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { fetchAll() }, [authenticatedApi, chatGptEnabled])

  const handleDisconnectChatGpt = async () => {
    const count = chatGpt?.modelIds.length ?? 0
    if (!confirm(`Disconnect ChatGPT?${count ? ` This deletes the ${count} model${count === 1 ? '' : 's'} that run on it.` : ''}`)) return
    setDisconnecting(true)
    try {
      await authenticatedApi.disconnectChatGpt()
      await fetchAll()
    } catch (err) {
      console.error('Failed to disconnect ChatGPT:', err)
      toasts.add({ title: 'Failed to disconnect ChatGPT', variant: 'error' })
    } finally {
      setDisconnecting(false)
    }
  }

  const gatewayMode = aiConfig?.enabled === true

  const isBuiltIn = (modelId: string): boolean => {
    if (!aiConfig?.enabled) return false
    const enabled = new Set((aiConfig as Extract<AiGatewayInfo, { enabled: true }>).enabledProviders)
    return PROVIDER_ORDER.some((p) => enabled.has(p) && modelId in SUGGESTED_MODELS[p])
  }

  const handleDelete = async (model: AiChatAuthorInfo) => {
    if (!confirm(`Delete "${model.name}"? This cannot be undone.`)) return
    setDeletingId(model.id)
    try {
      await authenticatedApi.deleteModel(model.id)
      await fetchAll()
    } catch (err) {
      console.error('Failed to delete model:', err)
      toasts.add({ title: 'Failed to delete provider', variant: 'error' })
    } finally {
      setDeletingId(null)
    }
  }

  // Overlapping setQuickModel calls have no ordering guarantee, so ignore clicks while one is
  // in flight.
  const quickInFlight = useRef(false)
  const handleSetQuick = async (modelId: string) => {
    if (quickInFlight.current) return
    quickInFlight.current = true
    const next = quickModel === modelId ? null : modelId
    setQuickModel(next)
    try {
      await authenticatedApi.setQuickModel(next)
    } catch (err) {
      console.error('Failed to set quick model:', err)
      setQuickModel(quickModel) // revert
      toasts.add({ title: 'Failed to update default model', variant: 'error' })
    } finally {
      quickInFlight.current = false
    }
  }

  const filtered = models.filter((m) => {
    if (!search) return true
    const q = search.toLowerCase()
    return m.name.toLowerCase().includes(q) || m.id.toLowerCase().includes(q)
  })

  return (
    <div className="mx-auto flex h-full w-full max-w-4xl flex-col px-3 sm:px-10">
      <header className="flex flex-col items-stretch gap-4 px-3 pb-3 pt-6 sm:flex-row sm:items-end sm:justify-between sm:pt-10">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-tight text-kumo-default">AI providers</h1>
          <p className="mt-1 text-[13px] leading-[18px] tracking-[-0.25px] text-kumo-subtle">
            Configure the AI models available to your workspaces.
          </p>
        </div>
        <button type="button" onClick={() => setSheet('model')} className={`${PRIMARY_BTN} h-11 justify-center text-[14px] sm:h-9 sm:text-[13px]`}>
          <Plus size={14} weight="bold" />
          Add provider
        </button>
      </header>

      {/* Search — hidden when the user has no models */}
      {!loading && !loadError && models.length > 0 && (
        <div className="mb-3 px-3">
          <div className="relative">
            <MagnifyingGlass size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-kumo-inactive" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search providers…"
              className="h-9 w-full rounded-lg border border-kumo-line bg-kumo-base pl-9 pr-4 text-[13px] tracking-[-0.25px] text-kumo-default placeholder:text-kumo-inactive transition-[border-color,box-shadow] duration-150 ease-out focus:border-kumo-ring focus:outline-none focus:ring-[3px] focus:ring-kumo-ring/15"
            />
          </div>
        </div>
      )}

      <div className="chat-panel flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto pt-1 pb-16">
        {/* Notices */}
        {(gatewayMode || chatGptEnabled || (!gatewayMode && models.length > 0)) && !loading && !loadError && (
          <div className="flex flex-col gap-2.5 px-3 pb-2">
            {chatGptEnabled && (
              <Notice>
                <span className="mt-px flex h-4 w-4 shrink-0 items-center justify-center rounded bg-kumo-brand text-[10px] font-bold text-white">C</span>
                <span className="min-w-0 flex-1">
                  {chatGpt ? (
                    <>
                      <strong className="font-medium text-kumo-default">ChatGPT plan connected.</strong>{' '}
                      Account <span className="font-mono text-[12px]">{chatGpt.accountId}</span>, since{' '}
                      {new Date(chatGpt.connectedAt).toLocaleDateString()}. The access token renews on its own
                      (current one until {new Date(chatGpt.expiresAt).toLocaleString()}).{' '}
                      {chatGpt.modelIds.length === 0 ? 'No models use it yet.' : `${chatGpt.modelIds.length} model${chatGpt.modelIds.length === 1 ? '' : 's'} run on it.`}
                    </>
                  ) : (
                    <>
                      <strong className="font-medium text-kumo-default">ChatGPT plan:</strong> sign in once
                      with a short code and add GPT models billed to your plan instead of an API key.
                    </>
                  )}
                </span>
                <span className="flex shrink-0 gap-3 text-[13px]">
                  <button type="button" onClick={() => setSheet('chatgpt')} className="cursor-pointer font-medium text-kumo-brand hover:underline">
                    {chatGpt ? 'Add model' : 'Sign in'}
                  </button>
                  {chatGpt && (
                    <button type="button" onClick={handleDisconnectChatGpt} disabled={disconnecting} className="cursor-pointer text-kumo-subtle hover:text-kumo-danger hover:underline disabled:opacity-50">
                      Disconnect
                    </button>
                  )}
                </span>
              </Notice>
            )}
            {gatewayMode && (
              <Notice>
                <Lightning size={15} className="mt-px shrink-0 text-kumo-brand" />
                <span>
                  <strong className="font-medium text-kumo-default">AI Gateway mode:</strong> built-in
                  models are managed by your deployment. You can still add custom models with your own
                  API tokens.
                </span>
              </Notice>
            )}

            {!gatewayMode && models.length > 0 && (
              <Notice>
                <Lightning size={15} className="mt-px shrink-0 text-kumo-brand" />
                <span>
                  <strong className="font-medium text-kumo-default">Quick model:</strong>{' '}
                  {quickModel
                    ? `${models.find((m) => m.id === quickModel)?.name ?? quickModel}.`
                    : 'none set.'}{' '}
                  Used for fast tasks like generating chat titles. Click a model to set it.
                </span>
              </Notice>
            )}
          </div>
        )}

        {/* Model list */}
        {loading ? (
          <div className="flex flex-col gap-0.5 px-3">
            {[1, 2, 3].map((i) => (
              <div key={i} className="h-[56px] animate-pulse rounded-xl bg-kumo-elevated" />
            ))}
          </div>
        ) : loadError ? (
          <div className="py-12 text-center text-sm">
            <p className="text-kumo-danger">Something went wrong loading your providers.</p>
            <button type="button" onClick={fetchAll} className="mt-1 cursor-pointer text-kumo-brand underline">
              Try again
            </button>
          </div>
        ) : models.length === 0 ? (
          <div className="flex flex-col items-center gap-3 px-3 py-16 text-center">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-kumo-fill text-kumo-subtle">
              <Lightning size={18} />
            </div>
            <div>
              <p className="text-sm font-medium text-kumo-default">No AI providers yet</p>
              <p className="mt-1 text-[13px] leading-[18px] text-kumo-subtle">
                Add a provider to start building workspaces with AI.
              </p>
            </div>
            <button type="button" onClick={() => setSheet('model')} className={PRIMARY_BTN}>
              <Plus size={14} weight="bold" />
              Add your first provider
            </button>
          </div>
        ) : filtered.length === 0 ? (
          <div className="py-12 text-center text-sm text-kumo-inactive">No providers found</div>
        ) : (
          filtered.map((model) => (
            <div
              key={model.id}
              className={deletingId === model.id ? 'pointer-events-none opacity-50' : ''}
            >
              <ModelRow
                model={model}
                isQuick={quickModel === model.id}
                isBuiltIn={isBuiltIn(model.id)}
                isChatGpt={chatGpt?.modelIds.includes(model.id) ?? false}
                onDelete={() => handleDelete(model)}
                onSetQuick={() => handleSetQuick(model.id)}
              />
            </div>
          ))
        )}
      </div>

      {/* Add model dialog */}
      <AddModelModal
        visible={sheet !== null}
        onCancel={() => { setSheet(null); fetchAll() }}
        onSuccess={() => {
          setSheet(null)
          fetchAll()
        }}
        authenticatedApi={authenticatedApi}
        aiConfig={aiConfig}
        initialView={sheet ?? 'model'}
        chatGptSubscription={chatGpt}
      />
    </div>
  )
}
