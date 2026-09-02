import { useEffect, useState } from 'react'
import type { ApiConfig, ModelParams, ThinkingLevel, ToolInfo } from '@shared/types'
import { PROVIDER_PRESETS, findPreset } from '@shared/providers'
import { catalogFor, lookupModel } from '@shared/model-catalog'
import { getApi } from '../api'

interface Props {
  config: ApiConfig
  onSave: (p: Partial<ApiConfig>) => void
  onClose: () => void
  onPickFolder: () => void
}

const THINKING_LEVELS: ThinkingLevel[] = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']

function toNumberOrUndefined(s: string): number | undefined {
  if (s.trim() === '') return undefined
  const n = Number(s)
  return Number.isFinite(n) ? n : undefined
}

export function SettingsOverlay({ config, onSave, onClose, onPickFolder }: Props) {
  const [providerId, setProviderId] = useState(config.providerId ?? '')
  const [baseUrl, setBaseUrl] = useState(config.baseUrl)
  const [apiKey, setApiKey] = useState(config.apiKey)
  const [model, setModel] = useState(config.model)
  const [thinkingLevel, setThinkingLevel] = useState<ThinkingLevel | ''>(config.modelParams?.thinkingLevel ?? '')
  const [temperature, setTemperature] = useState(config.modelParams?.temperature?.toString() ?? '')
  const [topP, setTopP] = useState(config.modelParams?.top_p?.toString() ?? '')
  const [maxTokens, setMaxTokens] = useState(config.modelParams?.max_tokens?.toString() ?? '')
  const [contextWindow, setContextWindow] = useState(config.contextWindow?.toString() ?? '')
  const [tools, setTools] = useState<ToolInfo[]>([])
  const [extHint, setExtHint] = useState<string | null>(null)

  useEffect(() => {
    void getApi()
      .listTools()
      .then((list) => setTools([...list].sort((a, b) => a.source.localeCompare(b.source) || a.name.localeCompare(b.name))))
  }, [])

  const toggleTool = (name: string, enabled: boolean) => {
    void getApi().setToolEnabled(name, enabled).then(() =>
      getApi()
        .listTools()
        .then((list) => setTools([...list]))
    )
  }

  const reloadExtensions = async () => {
    const r = await getApi().reloadExtensions()
    setExtHint(`已重载：扩展工具 ${r.tools} 个，自定义命令 ${r.commands} 条`)
    setTools(await getApi().listTools())
  }

  /** 切换厂商预设：自动填充 baseUrl / 默认模型 / 上下文窗口（均可再手改） */
  const handleProviderChange = (id: string) => {
    setProviderId(id)
    const preset = findPreset(id)
    if (!preset) return
    setBaseUrl(preset.baseUrl)
    setModel(preset.defaultModel)
    const entry = lookupModel(id, preset.defaultModel)
    if (entry) setContextWindow(String(entry.contextWindow))
  }

  // 厂商切换后模型列表跟随；保留手输任意模型的能力
  const suggestions = catalogFor(providerId || undefined)

  const buildModelParams = (): ModelParams | undefined => {
    const p: ModelParams = {}
    const t = toNumberOrUndefined(temperature)
    const tp = toNumberOrUndefined(topP)
    const mt = toNumberOrUndefined(maxTokens)
    if (t !== undefined) p.temperature = t
    if (tp !== undefined) p.top_p = tp
    if (mt !== undefined) p.max_tokens = mt
    if (thinkingLevel !== '') p.thinkingLevel = thinkingLevel
    return Object.keys(p).length > 0 ? p : undefined
  }

  const selectedEntry = lookupModel(providerId || undefined, model)

  return (
    <div
      className="overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className="settings raised">
        <h2>设置</h2>
        <label className="field">
          <span>厂商预设</span>
          <select className="sunken" value={providerId} onChange={(e) => handleProviderChange(e.target.value)}>
            <option value="">自定义</option>
            {PROVIDER_PRESETS.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>API Base URL</span>
          <input className="sunken mono" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} />
        </label>
        <label className="field">
          <span>API Key{findPreset(providerId)?.needsApiKey === false ? '（本地端点可留空）' : ''}</span>
          <input className="sunken mono" type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} />
        </label>
        <label className="field">
          <span>模型（可从目录选择或手输）</span>
          <input
            className="sunken mono"
            value={model}
            list="model-catalog-options"
            onChange={(e) => setModel(e.target.value)}
          />
          <datalist id="model-catalog-options">
            {suggestions.map((m) => (
              <option key={`${m.providerId}/${m.model}`} value={m.model}>
                {m.model}
              </option>
            ))}
          </datalist>
        </label>
        {selectedEntry && (
          <div className="catalog-hint">
            窗口 {Math.round(selectedEntry.contextWindow / 1000)}k · 价格 ≈ ${selectedEntry.inputPrice}/${selectedEntry.outputPrice} 每百万 token
            {selectedEntry.supportsThinking ? ' · 支持思考' : ''}
          </div>
        )}
        <label className="field">
          <span>思考档位（thinking）</span>
          <select
            className="sunken"
            value={thinkingLevel}
            onChange={(e) => setThinkingLevel(e.target.value as ThinkingLevel | '')}
          >
            <option value="">厂商默认</option>
            {THINKING_LEVELS.map((l) => (
              <option key={l} value={l}>
                {l}
              </option>
            ))}
          </select>
        </label>
        <div className="field-row-3">
          <label className="field">
            <span>Temperature（留空=默认）</span>
            <input
              className="sunken mono"
              inputMode="decimal"
              placeholder="0-2"
              value={temperature}
              onChange={(e) => setTemperature(e.target.value)}
            />
          </label>
          <label className="field">
            <span>Top P</span>
            <input
              className="sunken mono"
              inputMode="decimal"
              placeholder="0-1"
              value={topP}
              onChange={(e) => setTopP(e.target.value)}
            />
          </label>
          <label className="field">
            <span>Max Tokens</span>
            <input
              className="sunken mono"
              inputMode="numeric"
              placeholder="默认"
              value={maxTokens}
              onChange={(e) => setMaxTokens(e.target.value)}
            />
          </label>
        </div>
        <label className="field">
          <span>上下文窗口（token，压缩阈值 = 窗口 − 16384；留空 = 64000）</span>
          <input
            className="sunken mono"
            inputMode="numeric"
            placeholder="64000"
            value={contextWindow}
            onChange={(e) => setContextWindow(e.target.value)}
          />
        </label>
        <label className="field">
          <span>工作目录</span>
          <div className="field-row">
            <input className="sunken mono" value={config.workspacePath} readOnly />
            <button className="btn" onClick={onPickFolder}>
              选择文件夹…
            </button>
          </div>
        </label>
        <div className="field">
          <span>工具（只读模式下可变更类工具强制关闭）</span>
          <div className="tools-list">
            {tools.map((t) => (
              <label key={`${t.source}-${t.name}`} className="tool-row" title={t.mutating ? '可变更工作区的工具' : '只读工具'}>
                <input
                  type="checkbox"
                  checked={t.enabled}
                  disabled={t.mutating && config.readOnly}
                  onChange={(e) => toggleTool(t.name, e.target.checked)}
                />
                <span className="mono">{t.name}</span>
                <span className="tool-source">{t.source === 'extension' ? '扩展' : '内置'}</span>
              </label>
            ))}
            {tools.length === 0 && <div className="catalog-hint">（载入中…）</div>}
          </div>
          <div className="field-row" style={{ marginTop: 8 }}>
            <button className="btn" onClick={() => void reloadExtensions()}>
              重载扩展
            </button>
            {extHint && <span className="catalog-hint">{extHint}</span>}
          </div>
          <div className="catalog-hint">扩展目录：userData/extensions 与工作区 .navagent/extensions（需信任项目）</div>
        </div>
        <div className="settings-actions">
          <button className="btn" onClick={onClose}>
            取消
          </button>
          <button
            className="btn btn-primary"
            onClick={() =>
              onSave({
                providerId: providerId || undefined,
                baseUrl,
                apiKey,
                model,
                modelParams: buildModelParams(),
                contextWindow: toNumberOrUndefined(contextWindow)
              })
            }
          >
            保存
          </button>
        </div>
      </div>
    </div>
  )
}
