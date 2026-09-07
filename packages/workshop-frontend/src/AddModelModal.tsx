import { useState, useEffect, useRef } from 'react'
import { Dialog, Button, Input, Select, SensitiveInput, Collapsible, useKumoToastManager } from '@cloudflare/kumo'
import {
  AiChatAuthorInfo, AiModelConfig, AiModelProvider, AiGatewayInfo, SUGGESTED_MODELS,
  SUBSCRIPTION_PROVIDERS, ChatGptDeviceLogin, ChatGptSubscriptionInfo,
} from '@gadgets/workshop-shared/api'
import { RpcStub } from 'capnweb'
import { AuthenticatedApi } from '@gadgets/workshop-shared/api'
import { useChatGptSubscriptionLogin } from './ServerConfigContext'

interface AddModelModalProps {
  visible: boolean
  onCancel: () => void
  onSuccess: () => void
  authenticatedApi: RpcStub<AuthenticatedApi>
  aiConfig: AiGatewayInfo | null
  /** Open on the ChatGPT sign-in panel instead of the model picker. */
  initialView?: 'model' | 'chatgpt'
  /** The user's connected ChatGPT plan, when the page has loaded it. */
  chatGptSubscription?: ChatGptSubscriptionInfo | null
}

type SelectionType =
  | { type: 'suggested', provider: AiModelProvider, modelId: string, displayName: string }
  | { type: 'custom', provider: AiModelProvider }

const PROVIDER_LABELS: Record<AiModelProvider, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  google: 'Google',
  cloudflare: 'Cloudflare Workers AI',
  ollama: 'Ollama',
  'openai-codex': 'ChatGPT',
}

// Placeholder hinting at the shape of each provider's API token.
const API_TOKEN_PLACEHOLDERS: Record<AiModelProvider, string> = {
  anthropic: 'sk-ant-...',
  openai: 'sk-...',
  google: 'AIza...',
  cloudflare: 'Cloudflare API token',
  ollama: '(optional)',
  'openai-codex': '',   // never shown: subscription models have no token field
}

// Example used in the custom-model placeholders for providers that have no suggested models
// (currently Ollama, which serves whatever the user has pulled locally).
const FALLBACK_EXAMPLE_MODEL = { modelId: 'gemma4:31b', name: 'Gemma 4 31B' }

// Pick an example model to show in the custom-model placeholders for the given provider.
function exampleModel(provider: AiModelProvider): { modelId: string, name: string } {
  const first = Object.entries(SUGGESTED_MODELS[provider])[0]
  return first ? { modelId: first[0], name: first[1].name } : FALLBACK_EXAMPLE_MODEL
}

// Encode a selection into a string value for the Select component.
function encodeSelection(provider: AiModelProvider, modelId?: string): string {
  return modelId ? `${provider}:${modelId}` : `other-${provider}`
}

// Decode a Select value back into a SelectionType.
function decodeSelection(value: string): SelectionType {
  if (value.startsWith('other-')) {
    return { type: 'custom', provider: value.substring(6) as AiModelProvider }
  }
  const colonIndex = value.indexOf(':')
  const provider = value.substring(0, colonIndex) as AiModelProvider
  const modelId = value.substring(colonIndex + 1)
  const displayName = SUGGESTED_MODELS[provider][modelId].name
  return { type: 'suggested', provider, modelId, displayName }
}

// Build the flat list of options for the Select dropdown.
function buildOptions(gatewayMode: boolean, enabledProviders: Set<string> | null) {
  const options: { value: string; label: string; provider: string }[] = []
  const providerOrder = Object.keys(SUGGESTED_MODELS) as AiModelProvider[]

  for (const provider of providerOrder) {
    // Subscription providers are reached through the sign-in panel, not an API key.
    if (SUBSCRIPTION_PROVIDERS.has(provider)) continue
    if (enabledProviders && !enabledProviders.has(provider)) continue

    // In gateway mode, suggested models are already built-in, so don't list them.
    if (!gatewayMode) {
      for (const [modelId, model] of Object.entries(SUGGESTED_MODELS[provider])) {
        options.push({
          value: encodeSelection(provider, modelId),
          label: model.name,
          provider,
        })
      }
    }

    options.push({
      value: encodeSelection(provider),
      label: `Other ${PROVIDER_LABELS[provider] || provider}...`,
      provider,
    })
  }

  return options
}

export default function AddModelModal({
  visible, onCancel, onSuccess, authenticatedApi, aiConfig, initialView, chatGptSubscription,
}: AddModelModalProps) {
  const toasts = useKumoToastManager()
  const chatGptEnabled = useChatGptSubscriptionLogin()

  // Which panel is showing; the ChatGPT one is only reachable when the deployment offers it.
  const [view, setView] = useState<'model' | 'chatgpt'>('model')
  useEffect(() => {
    if (visible) setView(chatGptEnabled && initialView === 'chatgpt' ? 'chatgpt' : 'model')
  }, [visible, initialView, chatGptEnabled])

  const [loading, setLoading] = useState(false)
  const [selection, setSelection] = useState<SelectionType | null>(null)
  const [selectValue, setSelectValue] = useState<string | undefined>(undefined)

  // Form fields (used for custom models)
  const [modelId, setModelId] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [apiToken, setApiToken] = useState('')
  const [accountId, setAccountId] = useState('')
  const [apiUrl, setApiUrl] = useState('')

  // Validation errors
  const [errors, setErrors] = useState<Record<string, string>>({})

  // Advanced settings collapsible state
  const [advancedOpen, setAdvancedOpen] = useState(false)

  const gatewayMode = aiConfig?.enabled === true
  const enabledProviders: Set<string> | null = gatewayMode
    ? new Set(aiConfig.enabledProviders)
    : null

  // Reset all state when dialog closes
  useEffect(() => {
    if (!visible) {
      setSelection(null)
      setSelectValue(undefined)
      setModelId('')
      setDisplayName('')
      setApiToken('')
      setAccountId('')
      setApiUrl('')
      setErrors({})
      setAdvancedOpen(false)
    }
  }, [visible])

  const handleModelSelect = (value: string) => {
    setSelectValue(value)
    setErrors({})
    const sel = decodeSelection(value)
    setSelection(sel)

    if (sel.type === 'custom') {
      setModelId('')
      setDisplayName('')
    } else {
      setModelId(sel.modelId)
      setDisplayName(sel.displayName)
    }
    setApiToken('')
    setAccountId('')
    setApiUrl(sel.provider === 'ollama' ? 'http://localhost:11434' : '')
  }

  const validate = (): boolean => {
    const newErrors: Record<string, string> = {}

    if (!selection) {
      newErrors.selection = gatewayMode ? 'Please select a provider' : 'Please select a model'
    }

    if (selection?.type === 'custom') {
      if (!modelId.trim()) newErrors.modelId = 'Please enter the model ID'
      if (!displayName.trim()) newErrors.displayName = 'Please enter a display name'
    }

    const isOllama = selection?.provider === 'ollama'
    const isCloudflare = selection?.provider === 'cloudflare'
    const showCredentials = !gatewayMode

    if (showCredentials && selection && !isOllama && !apiToken.trim()) {
      newErrors.apiToken = 'Please enter your API token'
    }

    if (showCredentials && isCloudflare && !accountId.trim()) {
      newErrors.accountId = 'Please enter your Cloudflare account ID'
    }

    if (showCredentials && isOllama && !apiUrl.trim()) {
      newErrors.apiUrl = 'Please enter the Ollama API URL'
    }

    setErrors(newErrors)
    return Object.keys(newErrors).length === 0
  }

  const handleSubmit = async () => {
    if (!validate()) return

    setLoading(true)
    try {
      const isSuggested = selection!.type === 'suggested'
      const finalModelId = isSuggested ? selection!.modelId : modelId.trim()
      const finalDisplayName = isSuggested ? selection!.displayName : displayName.trim()

      const profile: AiChatAuthorInfo = {
        type: 'agent',
        id: finalModelId,
        name: finalDisplayName,
      }

      const config: AiModelConfig = {
        provider: selection!.provider,
        model: finalModelId,
        apiToken: gatewayMode ? '' : apiToken.trim(),
        ...(!gatewayMode && accountId.trim() && { accountId: accountId.trim() }),
        ...(!gatewayMode && apiUrl.trim() && { apiUrl: apiUrl.trim() }),
      }

      await authenticatedApi.addModel(profile, config)
      toasts.add({ title: 'AI model added successfully', variant: 'success' })
      onSuccess()
    } catch (error: any) {
      console.error('Failed to add model:', error)
      toasts.add({ title: 'Failed to add model', variant: 'error' })
    } finally {
      setLoading(false)
    }
  }

  const options = buildOptions(gatewayMode, enabledProviders)
  const showCustomFields = selection?.type === 'custom'
  const example = selection ? exampleModel(selection.provider) : null
  const isOllama = selection?.provider === 'ollama'
  const isCloudflare = selection?.provider === 'cloudflare'
  const showCredentials = !gatewayMode

  // Group options by provider for rendering with visual separators.
  const groupedOptions: { provider: string; items: typeof options }[] = []
  for (const opt of options) {
    const last = groupedOptions[groupedOptions.length - 1]
    if (last && last.provider === opt.provider) {
      last.items.push(opt)
    } else {
      groupedOptions.push({ provider: opt.provider, items: [opt] })
    }
  }

  if (view === 'chatgpt') {
    return (
      <Dialog.Root open={visible} onOpenChange={(open) => { if (!open) onCancel() }}>
        <Dialog className="responsive-dialog overflow-y-auto p-6" size="lg">
          <Dialog.Title className="text-lg font-semibold mb-4">
            Use your ChatGPT plan
          </Dialog.Title>
          <ChatGptPanel
            authenticatedApi={authenticatedApi}
            subscription={chatGptSubscription ?? null}
            onAdded={onSuccess}
            onBack={initialView === 'chatgpt' ? undefined : () => setView('model')}
          />
        </Dialog>
      </Dialog.Root>
    )
  }

  return (
    <Dialog.Root open={visible} onOpenChange={(open) => { if (!open) onCancel() }}>
      <Dialog className="responsive-dialog overflow-y-auto p-6" size="lg">
        <Dialog.Title className="text-lg font-semibold mb-4">
          Add AI Model
        </Dialog.Title>

        <div className="space-y-4">
          {/* Subscription route, offered above the API-key picker when the deployment allows it */}
          {chatGptEnabled && (
            <button
              type="button"
              onClick={() => setView('chatgpt')}
              className="flex w-full cursor-pointer items-start gap-3 rounded-xl border border-kumo-line bg-kumo-tint px-4 py-3 text-left transition-colors hover:bg-kumo-fill"
            >
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-kumo-brand text-[13px] font-semibold text-white">C</span>
              <span className="min-w-0">
                <span className="block text-sm font-medium text-kumo-default">
                  {chatGptSubscription ? 'Add a model from your ChatGPT plan' : 'Sign in with ChatGPT instead'}
                </span>
                <span className="mt-0.5 block text-[12px] leading-[17px] text-kumo-subtle">
                  {chatGptSubscription
                    ? 'Your plan is connected. Pick a GPT model billed to it, with no API key.'
                    : 'Approve a short code once; models are billed to your plan, not to an API key.'}
                </span>
              </span>
            </button>
          )}

          {/* Model / Provider selection */}
          <Select
            label={gatewayMode ? 'Select Provider' : 'Select Model'}
            className="w-full text-sm"
            placeholder={gatewayMode ? 'Choose a provider...' : 'Choose an AI model...'}
            value={selectValue}
            onValueChange={(v) => handleModelSelect(v as string)}
            error={errors.selection}
            renderValue={(v) => {
              const opt = options.find(o => o.value === v)
              return opt?.label ?? String(v)
            }}
          >
            {groupedOptions.map((group, groupIndex) => (
              <div key={group.provider}>
                {groupIndex > 0 && (
                  <div className="h-px bg-kumo-line my-1 mx-2" />
                )}
                <div className="px-3 py-1.5 text-xs font-medium text-kumo-subtle select-none">
                  {PROVIDER_LABELS[group.provider as AiModelProvider] || group.provider}
                </div>
                {group.items.map(opt => (
                  <Select.Option key={opt.value} value={opt.value}>
                    {opt.label}
                  </Select.Option>
                ))}
              </div>
            ))}
          </Select>

          {/* Custom model fields */}
          {showCustomFields && (
            <>
              <Input
                label="Model ID"
                placeholder={`e.g., ${example!.modelId}`}
                description={`The model identifier as specified by the provider (e.g., '${example!.modelId}')`}
                value={modelId}
                onChange={(e) => { setModelId(e.target.value); setErrors(prev => ({ ...prev, modelId: '' })) }}
                error={errors.modelId}
                variant={errors.modelId ? 'error' : 'default'}
              />

              <Input
                label="Display Name"
                placeholder={`e.g., ${example!.name}`}
                description="Human-readable name shown in the UI"
                value={displayName}
                onChange={(e) => { setDisplayName(e.target.value); setErrors(prev => ({ ...prev, displayName: '' })) }}
                error={errors.displayName}
                variant={errors.displayName ? 'error' : 'default'}
              />
            </>
          )}

          {/* Cloudflare account ID (the Workers AI REST endpoint is account-scoped) */}
          {showCredentials && isCloudflare && (
            <Input
              label="Cloudflare Account ID"
              placeholder="e.g., 0123456789abcdef0123456789abcdef"
              description="The Cloudflare account to bill for Workers AI usage"
              value={accountId}
              onChange={(e) => { setAccountId(e.target.value); setErrors(prev => ({ ...prev, accountId: '' })) }}
              error={errors.accountId}
              variant={errors.accountId ? 'error' : 'default'}
            />
          )}

          {/* API Token */}
          {showCredentials && selection && (
            <SensitiveInput
              label="API Token"
              placeholder={API_TOKEN_PLACEHOLDERS[selection.provider]}
              description={
                isOllama
                  ? 'Optional for local Ollama access'
                  : isCloudflare
                  ? 'An API token with Workers AI Read + Edit permissions (in the dashboard: Workers AI > Use REST API > Create a Workers AI API Token)'
                  : `Your ${PROVIDER_LABELS[selection.provider]} API token for billing`
              }
              value={apiToken}
              onValueChange={(v) => { setApiToken(v); setErrors(prev => ({ ...prev, apiToken: '' })) }}
              error={errors.apiToken}
              variant={errors.apiToken ? 'error' : 'default'}
            />
          )}

          {/* Ollama API URL (always visible for Ollama) */}
          {showCredentials && isOllama && (
            <Input
              label="API URL"
              placeholder="http://localhost:11434"
              description="URL of your Ollama server"
              value={apiUrl}
              onChange={(e) => { setApiUrl(e.target.value); setErrors(prev => ({ ...prev, apiUrl: '' })) }}
              error={errors.apiUrl}
              variant={errors.apiUrl ? 'error' : 'default'}
            />
          )}

          {/* Advanced Settings for non-Ollama, non-Cloudflare providers */}
          {showCredentials && selection && !isOllama && !isCloudflare && (
            <Collapsible.Root
              open={advancedOpen}
              onOpenChange={setAdvancedOpen}
            >
              <Collapsible.DefaultTrigger>Advanced Settings</Collapsible.DefaultTrigger>
              <Collapsible.DefaultPanel>
                <Input
                  label="API URL"
                  placeholder="https://..."
                  description="Override the default API endpoint (useful for proxies like Cloudflare AI Gateway)"
                  value={apiUrl}
                  onChange={(e) => setApiUrl(e.target.value)}
                />
              </Collapsible.DefaultPanel>
            </Collapsible.Root>
          )}
        </div>

        {/* Footer */}
        <div className="mt-6 flex justify-end gap-2">
          <Dialog.Close render={(props) => (
            <Button variant="secondary" {...props} disabled={loading}>
              Cancel
            </Button>
          )} />
          <Button
            variant="primary"
            onClick={handleSubmit}
            loading={loading}
            disabled={!selection}
          >
            Add Model
          </Button>
        </div>
      </Dialog>
    </Dialog.Root>
  )
}

// ─── ChatGPT plan: device-code sign-in, then a model billed to it ───────────────────────────────

const CHATGPT_MODELS = Object.entries(SUGGESTED_MODELS['openai-codex'])

/**
 * Subscription models get their own profile ids so a ChatGPT "GPT 5.6 Sol" can sit beside an
 * API-key one (the models collection is keyed by profile id).
 */
export function chatGptModelProfileId(modelId: string): string {
  return `chatgpt:${modelId}`
}

function ChatGptPanel({ authenticatedApi, subscription: initial, onAdded, onBack }: {
  authenticatedApi: RpcStub<AuthenticatedApi>
  subscription: ChatGptSubscriptionInfo | null
  onAdded: () => void
  onBack?: () => void
}) {
  const toasts = useKumoToastManager()
  const [subscription, setSubscription] = useState<ChatGptSubscriptionInfo | null>(initial)
  const [phase, setPhase] = useState<'idle' | 'starting' | 'waiting' | 'error'>('idle')
  const [login, setLogin] = useState<ChatGptDeviceLogin | null>(null)
  const [error, setError] = useState('')
  const [modelId, setModelId] = useState<string>(CHATGPT_MODELS[0]?.[0] ?? '')
  const [adding, setAdding] = useState(false)
  const [copied, setCopied] = useState(false)
  const pollBusy = useRef(false)

  const start = async () => {
    setPhase('starting')
    setError('')
    setCopied(false)
    try {
      setLogin(await authenticatedApi.startChatGptDeviceLogin())
      setPhase('waiting')
    } catch (err: any) {
      setError(err?.message ?? 'Could not start the sign-in.')
      setPhase('error')
    }
  }

  // Poll at the interval OpenAI named until the code is approved, fails, or the panel closes.
  useEffect(() => {
    if (phase !== 'waiting' || !login) return
    let cancelled = false
    const tick = async () => {
      if (pollBusy.current) return
      pollBusy.current = true
      try {
        const result = await authenticatedApi.pollChatGptDeviceLogin()
        if (cancelled) return
        if (result.status === 'complete') {
          setLogin(null)
          setPhase('idle')
          setSubscription((prev) => ({
            accountId: result.accountId, expiresAt: result.expiresAt,
            connectedAt: Date.now(), modelIds: prev?.modelIds ?? [],
          }))
          toasts.add({ title: 'ChatGPT connected', variant: 'success' })
        } else if (result.status === 'failed') {
          setLogin(null)
          setError(result.message)
          setPhase('error')
        }
      } catch (err: any) {
        if (!cancelled) {
          setLogin(null)
          setError(err?.message ?? 'The sign-in could not be checked.')
          setPhase('error')
        }
      } finally {
        pollBusy.current = false
      }
    }
    const timer = setInterval(tick, Math.max(1, login.intervalSeconds) * 1000)
    return () => { cancelled = true; clearInterval(timer) }
  }, [phase, login, authenticatedApi, toasts])

  const add = async () => {
    const entry = SUGGESTED_MODELS['openai-codex'][modelId]
    if (!entry) return
    setAdding(true)
    try {
      await authenticatedApi.addModel(
        { type: 'agent', id: chatGptModelProfileId(modelId), name: entry.name },
        { provider: 'openai-codex', model: modelId, apiToken: '' },
      )
      toasts.add({ title: 'ChatGPT model added', variant: 'success' })
      onAdded()
    } catch (err) {
      console.error('Failed to add ChatGPT model:', err)
      toasts.add({ title: 'Failed to add the model', variant: 'error' })
    } finally {
      setAdding(false)
    }
  }

  const copyCode = async () => {
    if (!login) return
    try { await navigator.clipboard.writeText(login.userCode); setCopied(true) } catch { /* no clipboard */ }
  }

  const backLink = onBack && (
    <button type="button" onClick={onBack} className="cursor-pointer text-[13px] text-kumo-subtle underline-offset-2 hover:underline">
      Add with an API key instead
    </button>
  )

  if (phase === 'waiting' && login) {
    return (
      <div className="space-y-4">
        <p className="text-sm text-kumo-subtle">
          Enter this code at OpenAI, signed in to the ChatGPT account whose plan should pay. This
          page finishes on its own once the code is approved.
        </p>
        <div className="flex items-center justify-between gap-3 rounded-xl border border-kumo-line bg-kumo-tint px-4 py-3">
          <span className="font-mono text-2xl font-semibold tracking-[0.12em] text-kumo-default">{login.userCode}</span>
          <Button variant="secondary" onClick={copyCode}>{copied ? 'Copied' : 'Copy code'}</Button>
        </div>
        <a
          href={login.verificationUri}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex h-9 items-center rounded-lg bg-kumo-brand px-3.5 text-[13px] font-medium text-white hover:bg-kumo-brand-hover"
        >
          Open {login.verificationUri.replace(/^https:\/\//, '')}
        </a>
        <p className="text-[12px] text-kumo-inactive">
          Waiting for approval. The code expires at {new Date(login.expiresAt).toLocaleTimeString()}.
        </p>
        <div className="mt-6 flex items-center justify-between gap-2">
          <div>{backLink}</div>
          <Button variant="secondary" onClick={() => { setLogin(null); setPhase('idle') }}>Cancel</Button>
        </div>
      </div>
    )
  }

  if (phase === 'error') {
    return (
      <div className="space-y-4">
        <p className="text-sm text-kumo-danger">{error}</p>
        <div className="mt-6 flex items-center justify-between gap-2">
          <div>{backLink}</div>
          <div className="flex gap-2">
            <Dialog.Close render={(props) => <Button variant="secondary" {...props}>Close</Button>} />
            <Button variant="primary" onClick={start}>Try again</Button>
          </div>
        </div>
      </div>
    )
  }

  if (subscription) {
    return (
      <div className="space-y-4">
        <div className="rounded-xl border border-kumo-line bg-kumo-tint px-4 py-3 text-[13px] leading-[18px] text-kumo-subtle">
          <strong className="font-medium text-kumo-default">Connected.</strong>{' '}
          Account <span className="font-mono text-[12px]">{subscription.accountId}</span>.
          The access token renews on its own before each chat.{' '}
          <button type="button" onClick={start} className="cursor-pointer text-kumo-brand underline-offset-2 hover:underline" disabled={phase === 'starting'}>
            Reconnect
          </button>
        </div>
        <Select
          label="Model"
          className="w-full text-sm"
          value={modelId}
          onValueChange={(v) => setModelId(v as string)}
          renderValue={(v) => SUGGESTED_MODELS['openai-codex'][v as string]?.name ?? String(v)}
        >
          {CHATGPT_MODELS.map(([id, model]) => (
            <Select.Option key={id} value={id}>{model.name}</Select.Option>
          ))}
        </Select>
        <p className="text-[12px] leading-[17px] text-kumo-inactive">
          Usage counts against the plan's limits, as it does for the Codex CLI. These models are
          for chat; they cannot be bound to gadgets.
        </p>
        <div className="mt-6 flex items-center justify-between gap-2">
          <div>{backLink}</div>
          <div className="flex gap-2">
            <Dialog.Close render={(props) => <Button variant="secondary" {...props} disabled={adding}>Cancel</Button>} />
            <Button variant="primary" onClick={add} loading={adding} disabled={!modelId}>Add model</Button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-kumo-subtle">
        Sign in once and the agent runs on your ChatGPT plan: no API key, and usage counts against
        the plan's limits like the Codex CLI does. OpenAI has not sanctioned third-party clients on
        a plan, so this is a choice your team makes, not a supported billing route.
      </p>
      <div className="mt-6 flex items-center justify-between gap-2">
        <div>{backLink}</div>
        <div className="flex gap-2">
          <Dialog.Close render={(props) => <Button variant="secondary" {...props}>Cancel</Button>} />
          <Button variant="primary" onClick={start} loading={phase === 'starting'}>Sign in with ChatGPT</Button>
        </div>
      </div>
    </div>
  )
}
