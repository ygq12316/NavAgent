import { useEffect, useState } from 'react'
import type { ApiConfig, CatalogSnapshot, CredentialInfo, CustomProviderFull, CustomProviderWriteResult, ExtensionInfo, McpServerDef, McpServerStatus, ToolInfo } from '@shared/types'
import { registerExtraCatalog } from '@shared/model-catalog'
import { getApi } from '../api'
import { useOutsideClose } from './dock/WindowFrame'
import { IconCheck, IconClose, IconCrosshair, IconHouse, IconLightning, IconPencil, IconPlug, IconPlus, IconRefresh, IconTrash, IconWrench } from './icons'

interface Props {
  config: ApiConfig
  onSave: (p: Partial<ApiConfig>) => void
  /** 供应商启用/禁用等“面板内即时生效”的配置变更（不关闭设置面板） */
  onConfigChange: (c: ApiConfig) => void
  onClose: () => void
  onPickFolder: () => void
}

/** 设置分区（对标 CC 桌面端：左侧导航 + 右侧内容 + 底部操作条） */
type TabId = 'providers' | 'tools' | 'mcp' | 'general'

const TABS: { id: TabId; label: string; icon: typeof IconPlug }[] = [
  { id: 'providers', label: '模型供应商', icon: IconPlug },
  { id: 'tools', label: '工具与扩展', icon: IconWrench },
  { id: 'mcp', label: 'MCP 服务', icon: IconPlug },
  { id: 'general', label: '通用', icon: IconHouse }
]

function toNumberOrUndefined(s: string): number | undefined {
  if (s.trim() === '') return undefined
  const n = Number(s)
  return Number.isFinite(n) ? n : undefined
}

/** 上下文徽标：1_000_000 → 100万；200_000 → 20万 */
function fmtCtx(n: number): string {
  return n >= 10_000 ? (Math.round(n / 10_000) + '万') : String(n)
}

function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url.replace(/^https?:\/\//, '').split('/')[0] || 'custom'
  }
}

export function SettingsOverlay({ config, onSave, onConfigChange, onClose, onPickFolder }: Props) {
  const [tab, setTab] = useState<TabId>('providers')
  const [providerId, setProviderId] = useState(config.providerId ?? '')
  const [baseUrl, setBaseUrl] = useState(config.baseUrl)
  const [model, setModel] = useState(config.model)
  const [contextWindow] = useState(config.contextWindow?.toString() ?? '')
  /** 联网搜索（web_search/web_fetch 后端）；key 为空 = 不注册这两个工具 */
  const [webSearchKey, setWebSearchKey] = useState(config.webSearch?.apiKey ?? '')
  const [tools, setTools] = useState<ToolInfo[]>([])
  const [extHint, setExtHint] = useState<string | null>(null)
  /** 已加载扩展（设置页扩展卡片） */
  const [exts, setExts] = useState<ExtensionInfo[]>([])
  const [extBusy, setExtBusy] = useState(false)
  // ── MCP 服务（stdio JSON-RPC；配置 userData/mcp.json）──
  const [mcpStatuses, setMcpStatuses] = useState<McpServerStatus[]>([])
  const [mcpForm, setMcpForm] = useState<{ name: string; command: string; env: string }>({ name: '', command: '', env: '' })
  const [mcpBusy, setMcpBusy] = useState(false)
  const [mcpHint, setMcpHint] = useState<string | null>(null)
  // 供应商目录（内置 + models.json 自定义）与凭据状态
  const [catalog, setCatalog] = useState<CatalogSnapshot | null>(null)
  const [creds, setCreds] = useState<CredentialInfo[]>([])
  // ── 供应商页（主-从式改版）：selected=null 添加表单 / 内置详情 / 自定义编辑 ──
  const [selected, setSelected] = useState<string | null>(null)
  const [fBaseUrl, setFBaseUrl] = useState('')
  const [fKey, setFKey] = useState('')
  const [fKeyDirty, setFKeyDirty] = useState(false)
  const [fProtocol, setFProtocol] = useState<'openai-compat' | 'anthropic'>('openai-compat')
  const [fModels, setFModels] = useState<{ id: string; contextWindow?: number }[]>([])
  const [pvError, setPvError] = useState<string | null>(null)
  const [pvBusy, setPvBusy] = useState(false)
  const [showKey, setShowKey] = useState(false)
  const [probing, setProbing] = useState(false)
  /** 探测结果选择面板：null=关闭；数组=端点返回的模型 id（勾选后批量加入） */
  const [probePanel, setProbePanel] = useState<string[] | null>(null)
  const [probeSel, setProbeSel] = useState<Set<string>>(new Set())
  const probePopRef = useOutsideClose(() => setProbePanel(null))
  const [renaming, setRenaming] = useState(false)
  const [fName, setFName] = useState('')
  const [editIdx, setEditIdx] = useState<number | null>(null)
  /** 行内“测试模型”结果：按模型 id 记录（增删行不错位）；该 id 是否存在于端点 /models 列表 */
  const [testResult, setTestResult] = useState<Record<string, 'ok' | 'bad'>>({})
  const [testingId, setTestingId] = useState<string | null>(null)

  useEffect(() => {
    void getApi().listCatalog().then((snap) => {
      setCatalog(snap)
      // 自定义模型进 renderer 成本计价（lookupModel 合并查询）
      registerExtraCatalog(snap.models)
    })
    void getApi().listCredentials().then(setCreds)
    void getApi()
      .listTools()
      .then((list) => setTools([...list].sort((a, b) => a.source.localeCompare(b.source) || a.name.localeCompare(b.name))))
    void getApi()
      .listExtensions()
      .then(setExts)
      .catch(() => undefined)
  }, [])

  const refreshExtsAndTools = async (): Promise<void> => {
    setExts(await getApi().listExtensions().catch(() => []))
    setTools([...(await getApi().listTools())].sort((a, b) => a.source.localeCompare(b.source) || a.name.localeCompare(b.name)))
  }

  // ── MCP 服务 ──
  const loadMcp = async (): Promise<void> => {
    const r = await getApi().mcpList().catch(() => null)
    if (r) setMcpStatuses(r.statuses)
  }
  useEffect(() => {
    if (tab === 'mcp') void loadMcp()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab])

  const saveMcp = async (): Promise<void> => {
    const name = mcpForm.name.trim()
    const line = mcpForm.command.trim()
    setMcpHint(null)
    if (!name) { setMcpHint('名称必填'); return }
    if (!line) { setMcpHint('启动命令必填'); return }
    let env: Record<string, string> | undefined
    if (mcpForm.env.trim()) {
      try {
        const v = JSON.parse(mcpForm.env) as unknown
        if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('环境变量需为 JSON 对象')
        env = v as Record<string, string>
      } catch (e) {
        setMcpHint(`环境变量格式错误：${e instanceof Error ? e.message : String(e)}`)
        return
      }
    }
    const parts = line.split(/\s+/)
    const def: McpServerDef = { command: parts[0] ?? line, args: parts.slice(1), env, enabled: true }
    setMcpBusy(true)
    const r = await getApi().mcpSave(name, def).catch((e) => ({ ok: false as const, error: String(e) }))
    setMcpBusy(false)
    if (!r.ok) {
      setMcpHint(r.error ?? '保存失败')
      return
    }
    setMcpForm({ name: '', command: '', env: '' })
    await loadMcp()
  }
  const toggleMcp = async (name: string, on: boolean): Promise<void> => {
    await getApi().mcpSetEnabled(name, on)
    await loadMcp()
  }
  const delMcp = async (name: string): Promise<void> => {
    if (!window.confirm(`删除 MCP 服务器「${name}」？`)) return
    await getApi().mcpRemove(name)
    await loadMcp()
  }

  const toggleTool = (name: string, enabled: boolean) => {
    void getApi().setToolEnabled(name, enabled).then(() =>
      getApi()
        .listTools()
        .then((list) => setTools([...list]))
    )
  }

  /** 从文件夹安装扩展：弹系统目录选择框，复制到全局目录并热重载 */
  const installExt = async (): Promise<void> => {
    setExtBusy(true)
    const r = await getApi().installExtension()
    setExtBusy(false)
    setExtHint(r.ok ? '扩展已安装' : (r.canceled ? null : (r.error ?? '安装失败')))
    await refreshExtsAndTools()
  }

  const toggleExt = async (id: string, enabled: boolean): Promise<void> => {
    setExts(await getApi().setExtensionEnabled(id, enabled))
    await refreshExtsAndTools()
  }

  const delExt = async (ext: ExtensionInfo): Promise<void> => {
    if (!window.confirm(`删除扩展「${ext.name}」？文件将从磁盘移除。`)) return
    const r = await getApi().removeExtension(ext.id)
    setExtHint(r.ok ? '扩展已删除' : (r.error ?? '删除失败'))
    await refreshExtsAndTools()
  }

  const reloadExtensions = async () => {
    const r = await getApi().reloadExtensions()
    setExtHint(`已重载：扩展工具 ${r.tools} 个，自定义命令 ${r.commands} 条`)
    await refreshExtsAndTools()
    setCatalog(await getApi().listCatalog())
  }

  const customs: CustomProviderFull[] = catalog?.customs ?? []
  const selectedCustom = customs.find((c) => c.id === selected)

  const handleSave = () => {
    onSave({
      providerId: providerId || undefined,
      baseUrl,
      model,
      contextWindow: toNumberOrUndefined(contextWindow),
      webSearch: webSearchKey.trim() ? { provider: 'tavily', apiKey: webSearchKey.trim() } : undefined
    })
  }

  const resetForm = (): void => {
    setEditIdx(null)
    setFBaseUrl('')
    setFKey('')
    setFKeyDirty(false)
    setFProtocol('openai-compat')
    setFModels([])
    setPvError(null)
  }

  const openAdd = (): void => {
    setSelected(null)
    resetForm()
  }

  /** 打开自定义供应商编辑：表单回填 + 同步「当前使用」端点（底部保存生效） */
  const openCustom = (id: string, list: CustomProviderFull[]): void => {
    const c = list.find((x) => x.id === id)
    setSelected(id)
    setEditIdx(null)
    setPvError(null)
    if (!c) return
    setFBaseUrl(c.baseUrl)
    setFProtocol(c.protocol)
    // 内联 key 原文回显（$ENV/!command 值语法原样显示）；用户清空并保存 = 清除
    setFKey(c.apiKeyValue ?? '')
    setFKeyDirty(false)
    setFModels(c.models.length > 0 ? c.models.map((m) => ({ id: m.id, contextWindow: m.contextWindow })) : [])
    setProviderId(c.id)
    setBaseUrl(c.baseUrl)
    setModel(c.models[0]?.id ?? '')
  }

  const applySnapshot = (snap: CatalogSnapshot): void => {
    setCatalog(snap)
    registerExtraCatalog(snap.models)
  }

  /** 保存自定义供应商（名称缺省时由 Base URL host 推导）；返回写入结果供“设为当前使用” */
  const saveCustomForm = async (modelsOverride?: { id: string; contextWindow?: number }[], protocolOverride?: 'anthropic' | 'openai-compat'): Promise<CustomProviderWriteResult | null> => {
    const models = (modelsOverride ?? fModels).filter((m) => m.id.trim().length > 0)
    if (!fBaseUrl.trim() || !/^https?:\/\//.test(fBaseUrl.trim())) {
      setPvError('Base URL 需以 http(s):// 开头')
      return null
    }
    if (models.length === 0) {
      setPvError('至少添加一个模型')
      return null
    }
    setPvBusy(true)
    setPvError(null)
    const r = await getApi().saveCustomProvider({
      id: selectedCustom?.id,
      name: hostOf(fBaseUrl),
      protocol: protocolOverride ?? fProtocol,
      baseUrl: fBaseUrl.trim(),
      apiKey: fKey.trim() ? fKey.trim() : fKeyDirty ? '' : undefined,
      models: models.map((m) => ({ id: m.id.trim(), ...(m.contextWindow ? { contextWindow: m.contextWindow } : {}) }))
    })
    setPvBusy(false)
    if (!r.ok || !r.snapshot) {
      setPvError(r.error ?? '保存失败')
      return null
    }
    applySnapshot(r.snapshot)
    if (r.id) openCustom(r.id, r.snapshot.customs ?? [])
    return r
  }

  /** 保存并设为当前使用（providerId/baseUrl/默认模型一并对齐）；面板保持打开 */
  const useThisProvider = async (): Promise<void> => {
    const r = await saveCustomForm()
    if (!r?.ok || !r.id) return
    const c = await getApi().setConfig({ providerId: r.id, baseUrl: fBaseUrl.trim(), model: fModels.find((m) => m.id.trim())?.id.trim() ?? config.model })
    onConfigChange(c)
  }

  /** 勾选面板：批量加入探测到的模型（跳过已在列表的） */
  const toggleProbeSel = (id: string): void =>
    setProbeSel((t) => {
      const next = new Set(t)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  const addProbedModels = (): void => {
    setFModels((arr) => {
      const have = new Set(arr.map((mm) => mm.id.trim()))
      const add = [...probeSel].filter((id) => !have.has(id)).map((id) => ({ id }))
      return [...arr, ...add]
    })
    setProbePanel(null)
    setProbeSel(new Set())
  }

  /** 重命名供应商（连同当前表单一并保存） */
  const confirmRename = async (): Promise<void> => {
    if (!selectedCustom || !fName.trim()) {
      setRenaming(false)
      setFName('')
      return
    }
    const r = await getApi().saveCustomProvider({
      id: selectedCustom.id,
      name: fName.trim(),
      protocol: selectedCustom.protocol,
      baseUrl: selectedCustom.baseUrl,
      models: fModels.map((m) => ({ id: m.id.trim(), ...(m.contextWindow ? { contextWindow: m.contextWindow } : {}) }))
    })
    if (r.ok && r.snapshot) applySnapshot(r.snapshot)
    setRenaming(false)
  }

  /** 禁用：取消当前使用（不删除定义）；面板保持打开 */
  const disableProvider = async (): Promise<void> => {
    if ((config.providerId ?? '') !== selectedCustom?.id) return
    const c = await getApi().setConfig({ providerId: undefined })
    onConfigChange(c)
  }

  const delCustom = async (): Promise<void> => {
    if (!selectedCustom) return
    if (!window.confirm(`删除自定义供应商「${selectedCustom.name}」？`)) return
    setPvBusy(true)
    const r = await getApi().deleteCustomProvider(selectedCustom.id)
    setPvBusy(false)
    if (!r.ok || !r.snapshot) {
      setPvError(r.error ?? '删除失败')
      return
    }
    applySnapshot(r.snapshot)
    if ((config.providerId ?? '') === selectedCustom.id) onSave({ providerId: undefined })
    openAdd()
  }

  /** 探测模型：从端点拉取可用模型列表并填入（保留已有条目填写的上下文窗口） */
  const probeModels = async (): Promise<void> => {
    if (!/^https?:\/\//.test(fBaseUrl.trim())) {
      setPvError('探测前请先填写 Base URL（http(s):// 开头）')
      return
    }
    setProbing(true)
    setPvError(null)
    const r = await getApi().probeModels({ baseUrl: fBaseUrl.trim(), protocol: fProtocol, apiKey: fKey.trim() || undefined, providerId: selectedCustom?.id ?? config.providerId })
    setProbing(false)
    if (!r.ok || r.models.length === 0) {
      setPvError(r.error ?? '探测失败：端点未返回可用模型')
      return
    }
    // 回退命中：实际成功的协议与表单不同 → 纠正表单并按纠正值落盘
    const finalProtocol = r.protocolUsed ?? fProtocol
    if (r.protocolUsed && r.protocolUsed !== fProtocol) setFProtocol(r.protocolUsed)
    // 合并进列表（保留已有条目的上下文窗口），并连同表单里的 Key 一起持久化
    const merged = (() => {
      const prev = new Map(fModels.map((m) => [m.id.trim(), m]))
      return r.models.map((id) => ({ id, contextWindow: prev.get(id)?.contextWindow }))
    })()
    setFModels(merged)
    await saveCustomForm(merged, finalProtocol)
    // 打开勾选面板（默认全选未添加的），由用户确认后批量加入
    setProbePanel(r.models)
    setProbeSel(new Set(r.models.filter((id) => !merged.some((m) => m.id.trim() === id))))
  }

  /** 行内测试：该模型 id 是否在端点 /models 列表中（结果按模型 id 记录，增删行不错位） */
  const testModel = async (id: string): Promise<void> => {
    const trimmed = id.trim()
    if (!trimmed || testingId !== null) return
    setTestingId(trimmed)
    const r = await getApi().probeModels({ baseUrl: fBaseUrl.trim(), protocol: fProtocol, apiKey: fKey.trim() || undefined, providerId: selectedCustom?.id ?? config.providerId })
    if (r.ok && r.protocolUsed && r.protocolUsed !== fProtocol) setFProtocol(r.protocolUsed)
    setTestResult((t) => ({ ...t, [trimmed]: r.ok && r.models.includes(trimmed) ? 'ok' : 'bad' }))
    setTestingId(null)
  }

  /** 行编辑辅助：更新 / 确认（空 id 行确认即移除）/ 删除 */
  const updateModel = (i: number, patch: Partial<{ id: string; contextWindow?: number }>): void =>
    setFModels((arr) => arr.map((x, j) => (j === i ? { ...x, ...patch } : x)))
  const confirmEdit = (i: number): void => {
    if (!fModels[i]?.id.trim()) removeModel(i)
    setEditIdx(null)
  }
  const removeModel = (i: number): void => {
    setFModels((arr) => arr.filter((_, j) => j !== i))
    setEditIdx(null)
  }

  const dotOkCustom = (p: CustomProviderFull): boolean => Boolean(creds.find((c) => c.id === p.id)?.stored) || p.hasInlineKey
  return (
    <div
      className="overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className="settings settings-app raised">
        <aside className="settings-nav">
          <h2>设置</h2>
          {TABS.map(({ id, label, icon: Icon }) => (
            <button key={id} className={`settings-nav-item${tab === id ? ' on' : ''}`} onClick={() => setTab(id)}>
              <Icon size={14} />
              {label}
            </button>
          ))}
        </aside>

        <div className="settings-body">
          {tab === 'providers' && (
            <div className="provider-layout">
              {/* 左：自定义供应商列表（内置预设不再提供；旧配置指向预设时显示只读提示） */}
              <div className="provider-list">
                <div className="pv-group-label">自定义供应商</div>
                {customs.map((p) => (
                  <button key={p.id} className={`pv-item${selected === p.id ? ' on' : ''}`} onClick={() => openCustom(p.id, customs)} title={p.baseUrl}>
                    <span className="pv-avatar">{p.name.slice(0, 1).toUpperCase()}</span>
                    <span className="pv-item-name">{p.name}</span>
                    <span className={`pv-dot${dotOkCustom(p) ? ' ok' : ''}`} title={dotOkCustom(p) ? '凭据已配置' : '未配置凭据'} />
                    {(config.providerId ?? '') === p.id && <span className="pv-cur">当前</span>}
                  </button>
                ))}
                {customs.length === 0 && <div className="pv-group-empty">（尚无，点击下方添加）</div>}
                <button className="pv-add" onClick={openAdd}>
                  <IconPlus size={12} />
                  添加供应商
                </button>
              </div>

              {/* 右：编辑器（自上而下：Base URL → API 格式 → API Key → 模型列表 → 添加模型） */}
              <div className="provider-detail pv-detail">
                <div className="pv-head">
                  {!selectedCustom ? (
                    <span className="pv-title">添加自定义供应商</span>
                  ) : renaming ? (
                    <span className="pv-rename">
                      <input
                        className="sunken"
                        autoFocus
                        value={fName}
                        onChange={(e) => setFName(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') void confirmRename()
                          if (e.key === 'Escape') setRenaming(false)
                        }}
                      />
                      <button className="pv-tool" title="确认" onClick={() => void confirmRename()}>
                        <IconCheck size={12} />
                      </button>
                      <button className="pv-tool" title="取消" onClick={() => setRenaming(false)}>
                        <IconClose size={11} />
                      </button>
                    </span>
                  ) : (
                    <>
                      <span className="pv-title">{selectedCustom.name}</span>
                      <button className="pv-tool" title="重命名" onClick={() => { setFName(selectedCustom.name); setRenaming(true) }}>
                        <IconPencil size={11} />
                      </button>
                      {(config.providerId ?? '') === selectedCustom.id && <span className="pv-badge-on">已启用</span>}
                      {(config.providerId ?? '') === selectedCustom.id && (
                        <button className="btn" onClick={() => void disableProvider()} title="停止使用此供应商（保留配置）">
                          禁用
                        </button>
                      )}
                    </>
                  )}
                  {selectedCustom && (
                    <button className="pv-tool pv-del" title="删除该供应商" disabled={pvBusy} onClick={() => void delCustom()}>
                      <IconTrash size={13} />
                    </button>
                  )}
                </div>
                <div className="pv-desc">
                  {selectedCustom ? '编辑此自定义供应商；保存写入 userData/models.json。' : '配置一个完全自定义的 API 端点；名称将自动取自 Base URL。'}
                </div>

                <label className="field">
                  <span>Base URL</span>
                  <input className="sunken mono" placeholder="https://api.example.com/v1" value={fBaseUrl} onChange={(e) => setFBaseUrl(e.target.value)} />
                </label>
                <label className="field">
                  <span>API 格式</span>
                  <select className="sunken" value={fProtocol} onChange={(e) => setFProtocol(e.target.value as 'openai-compat' | 'anthropic')}>
                    <option value="openai-compat">OpenAI Chat Completions (/v1/chat/completions)</option>
                    <option value="anthropic">Anthropic Messages (/v1/messages)</option>
                  </select>
                </label>
                <label className="field">
                  <span>API Key</span>
                  <div className="field-row">
                    <input
                      className="sunken mono"
                      type={showKey ? 'text' : 'password'}
                      placeholder={selectedCustom?.hasInlineKey ? '已内联存储（留空保持不变）' : '输入 API Key（支持 $ENV / !command）'}
                      value={fKey}
                      onChange={(e) => {
                        setFKey(e.target.value)
                        setFKeyDirty(true)
                      }}
                    />
                    <button className="btn" onClick={() => setShowKey((v) => !v)} title={showKey ? '隐藏' : '显示'}>
                      {showKey ? '隐藏' : '显示'}
                    </button>
                  </div>
                </label>

                <div className="field">
                  <span>
                    模型列表
                    <span className="pv-model-tools pv-probe-anchor" ref={probePopRef}>
                      <button
                        className="pv-tool wide"
                        title="从端点拉取可用模型列表（需要 Base URL，Key 可选）"
                        disabled={probing}
                        onClick={() => void probeModels()}
                      >
                        <IconLightning size={11} />
                        {probing ? '探测中…' : '探测模型'}
                      </button>
                      {probePanel && (
                        <div className="pv-probe-pop">
                          <div className="pv-probe-head">
                            <span className="pv-probe-title">探测结果</span>
                            <span className="pv-probe-count mono">{probePanel.length} 个模型</span>
                            <button className="pv-probe-close" title="关闭" onClick={() => setProbePanel(null)}>
                              <IconClose size={11} />
                            </button>
                          </div>
                          <div className="pv-probe-list">
                            {probePanel.map((id) => {
                              const already = fModels.some((mm) => mm.id.trim() === id)
                              return (
                                <label key={id} className={`pv-probe-row${already ? ' dup' : ''}`}>
                                  <input
                                    type="checkbox"
                                    checked={!already && probeSel.has(id)}
                                    disabled={already}
                                    onChange={() => toggleProbeSel(id)}
                                  />
                                  <span className="mono pv-probe-id">{id}</span>
                                  {already && <span className="pv-probe-dup">已在列表</span>}
                                </label>
                              )
                            })}
                            {probePanel.length === 0 && <div className="pv-probe-empty">端点未返回模型</div>}
                          </div>
                          <div className="pv-probe-foot">
                            <button className="btn" onClick={() => setProbePanel(null)}>
                              取消
                            </button>
                            <button className="btn btn-primary" disabled={probeSel.size === 0} onClick={() => void addProbedModels()}>
                              添加所选{probeSel.size > 0 ? ` ${probeSel.size} 个` : ''}
                            </button>
                          </div>
                        </div>
                      )}
                    </span>
                  </span>
                  <div className="pv-models">
                    {fModels.map((m, i) =>
                      editIdx === i ? (
                        <div key={`edit-${i}`} className="pv-model-row">
                          <input
                            className="sunken mono"
                            autoFocus
                            placeholder="模型 id，如 glm-5.2"
                            value={m.id}
                            onChange={(e) => updateModel(i, { id: e.target.value })}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') confirmEdit(i)
                              if (e.key === 'Escape') { setEditIdx(null); if (!m.id.trim()) removeModel(i) }
                            }}
                          />
                          <input
                            className="sunken mono pv-ctx-input"
                            placeholder="上下文"
                            title="上下文窗口 token，如 1000000"
                            value={m.contextWindow ?? ''}
                            onChange={(e) => updateModel(i, { contextWindow: toNumberOrUndefined(e.target.value) })}
                          />
                          <button className="pv-tool ok" title="完成编辑" onClick={() => confirmEdit(i)}>
                            <IconCheck size={12} />
                          </button>
                          <button className="pv-tool" title="取消" onClick={() => { setEditIdx(null); if (!m.id.trim()) removeModel(i) }}>
                            <IconClose size={11} />
                          </button>
                        </div>
                      ) : (
                        <div key={`view-${i}`} className="pv-model-row">
                          <span className="mono pv-model-id">{m.id}</span>
                          {m.contextWindow ? <span className="pv-ctx-badge mono">{fmtCtx(m.contextWindow)}</span> : null}
                          {testResult[m.id] && (
                            <span className={`pv-test mono ${testResult[m.id]}`} title={testResult[m.id] === 'ok' ? '端点 /models 列表中存在该模型' : '端点 /models 列表中未找到该模型'}>
                              {testResult[m.id] === 'ok' ? '可用' : '未收录'}
                            </span>
                          )}
                          <span className="pv-model-tools">
                            <button
                              className="pv-tool"
                              title="测试该模型是否可用于当前端点"
                              disabled={testingId === m.id}
                              onClick={() => void testModel(m.id)}
                            >
                              <IconCrosshair size={11} />
                            </button>
                            <button className="pv-tool" title="编辑模型配置" onClick={() => setEditIdx(i)}>
                              <IconPencil size={11} />
                            </button>
                            <button className="pv-tool danger" title="删除该模型" onClick={() => removeModel(i)}>
                              <IconTrash size={11} />
                            </button>
                          </span>
                        </div>
                      )
                    )}
                    {fModels.length === 0 && !probing && (
                      <div className="catalog-hint">尚无模型：点「添加模型」手动录入，或点「探测模型」从端点拉取后勾选添加。</div>
                    )}
                  </div>
                  <button className="pv-add" onClick={() => { setFModels((arr) => [...arr, { id: '', contextWindow: undefined }]); setEditIdx(fModels.length) }}>
                    <IconPlus size={11} />
                    添加模型
                  </button>
                </div>

                {pvError && <div className="pv-error">{pvError}</div>}
                <div className="pv-actions">
                  <span className="meta-spacer" />
                  {selectedCustom && (config.providerId ?? '') !== selectedCustom.id && (
                    <button className="btn" disabled={pvBusy} onClick={() => void useThisProvider()} title="保存并切换到此供应商">
                      设为当前使用
                    </button>
                  )}
                  <button className="btn btn-primary" disabled={pvBusy} onClick={() => void saveCustomForm()}>
                    {pvBusy ? '保存中…' : selectedCustom ? '保存修改' : '添加供应商'}
                  </button>
                </div>
              </div>
            </div>
          )}

          {tab === 'tools' && (
            <div>
              {/* 扩展卡片管理 */}
              <div className="ext-head">
                <span className="tools-title">
                  扩展 <span className="tools-count mono">{exts.length}</span>
                </span>
                <span className="meta-spacer" />
                <button className="btn btn-ghost" disabled={extBusy} title="选择包含 index.mjs 的目录，复制到全局扩展目录" onClick={() => void installExt()}>
                  <IconPlus size={12} />
                  从文件夹安装…
                </button>
                <button
                  className="btn btn-ghost"
                  title="重载扩展与工具（扩展目录：userData/extensions 与工作区 .navagent/extensions，需信任）"
                  onClick={() => void reloadExtensions()}
                >
                  <IconRefresh size={12} />
                  重载
                </button>
              </div>
              <div className="ext-list">
                {exts.length === 0 ? (
                  <div className="ext-empty">
                    尚未安装扩展
                    <span>点击「从文件夹安装…」选择包含 index.mjs 的扩展目录</span>
                  </div>
                ) : (
                  exts.map((ext, i) => (
                    <div key={`${ext.source}:${ext.id}`} className={`ext-card${ext.disabled ? ' off' : ''}`} style={{ '--i': String(i) } as React.CSSProperties}>
                      <span className="ext-avatar">{ext.name.slice(0, 1).toUpperCase()}</span>
                      <div className="ext-main">
                        <div className="ext-name-row">
                          <span className="ext-name">{ext.name}</span>
                          {ext.version && <span className="ext-ver mono">v{ext.version}</span>}
                          <span className={`proto-chip mono ext-src ${ext.source}`}>{ext.source === 'global' ? '全局' : '项目'}</span>
                          {ext.disabled && <span className="ext-off-tag">已停用</span>}
                        </div>
                        {ext.description && <div className="ext-desc">{ext.description}</div>}
                        {ext.error && <div className="ext-error">加载失败：{ext.error}</div>}
                        <div className="ext-meta mono">
                          工具 {ext.tools.length} · 命令 {ext.commands.length}
                        </div>
                      </div>
                      <div className="ext-actions">
                        <input
                          type="checkbox"
                          className="switch"
                          checked={!ext.disabled}
                          onChange={(e) => void toggleExt(ext.id, e.target.checked)}
                        />
                        {ext.source === 'global' && (
                          <button className="ext-del" title="删除扩展（从磁盘移除）" onClick={() => void delExt(ext)}>
                            <IconTrash size={13} />
                          </button>
                        )}
                      </div>
                    </div>
                  ))
                )}
              </div>
              {extHint && <div className="catalog-hint" style={{ marginBottom: 12 }}>{extHint}</div>}

              {/* 工具开关（扩展自带工具不在此列出，由扩展卡片总开关管理；MCP 工具按前缀单列） */}
              <div className="tools-head" title="只读模式下，可变更类工具强制关闭">
                <span className="tools-title">
                  工具 <span className="tools-count mono">{tools.filter((t) => t.source === 'builtin' || t.name.startsWith('mcp_')).length}</span>
                </span>
              </div>
              {(['builtin', 'mcp'] as const).map((src) => {
                const list = tools.filter((t) => (src === 'builtin' ? t.source === 'builtin' : t.name.startsWith('mcp_')))
                if (list.length === 0) return null
                return (
                  <div key={src} className="tools-group">
                    <div className="tools-group-label">{src === 'builtin' ? '内置' : 'MCP'}</div>
                    {list.map((t) => (
                      <div key={t.name} className="tool-card" title={t.hint ?? (t.mutating ? '可变更工作区的工具' : '只读工具')}>
                        <span className="tool-card-name mono">{t.name}</span>
                        {t.mutating && <span className="mut-badge">写</span>}
                        {t.hint && <span className="tool-hint">{t.hint}</span>}
                        <input
                          type="checkbox"
                          className="switch"
                          checked={t.enabled}
                          disabled={(t.mutating && config.readOnly) || Boolean(t.hint)}
                          onChange={(e) => toggleTool(t.name, e.target.checked)}
                        />
                      </div>
                    ))}
                  </div>
                )
              })}
              {tools.length === 0 && <div className="catalog-hint">（载入中…）</div>}
            </div>
          )}

          {tab === 'mcp' && (
            <div>
              <div className="ext-head">
                <span className="tools-title">
                  MCP 服务 <span className="tools-count mono">{mcpStatuses.length}</span>
                </span>
                <span className="meta-spacer" />
                <button className="btn btn-ghost" title="重连全部启用的服务器" onClick={() => void loadMcp()}>
                  <IconRefresh size={12} />
                  刷新
                </button>
              </div>
              <div className="ext-desc" style={{ marginBottom: 10 }}>
                MCP 服务器经 stdio 提供额外工具（注册为 mcp_名称_工具，默认需审批）。配置存于 userData/mcp.json。
              </div>
              <div className="ext-list">
                {mcpStatuses.map((s) => (
                  <div key={s.name} className={`ext-card${s.status === 'disabled' ? ' off' : ''}`}>
                    <span className="ext-avatar">M</span>
                    <div className="ext-main">
                      <div className="ext-name-row">
                        <span className="ext-name mono">{s.name}</span>
                        <span className={`proto-chip mono ext-src ${s.status === 'ready' ? 'ok' : s.status}`}>
                          {s.status === 'ready' ? '就绪' : s.status === 'disabled' ? '已停用' : '错误'}
                        </span>
                      </div>
                      <div className="ext-desc mono">{s.command}</div>
                      {s.error && <div className="ext-error">{s.error}</div>}
                      <div className="ext-meta mono">工具 {s.tools ?? 0}</div>
                    </div>
                    <div className="ext-actions">
                      <input
                        type="checkbox"
                        className="switch"
                        checked={s.status !== 'disabled'}
                        onChange={(e) => void toggleMcp(s.name, e.target.checked)}
                      />
                      <button className="ext-del" title="删除 MCP 服务器" onClick={() => void delMcp(s.name)}>
                        <IconTrash size={13} />
                      </button>
                    </div>
                  </div>
                ))}
                {mcpStatuses.length === 0 && (
                  <div className="ext-empty">
                    尚未添加 MCP 服务器
                    <span>在下方填写启动命令，如：npx -y @modelcontextprotocol/server-everything</span>
                  </div>
                )}
              </div>

              {/* 添加表单：命令整行粘贴（首 token = 命令，其余 = 参数） */}
              <div className="tools-head">
                <span className="tools-title">添加服务器</span>
              </div>
              <label className="field">
                <span>名称</span>
                <input
                  className="sunken"
                  value={mcpForm.name}
                  placeholder="如 fetch（小写字母/数字/-/_）"
                  onChange={(e) => setMcpForm({ ...mcpForm, name: e.target.value })}
                />
              </label>
              <label className="field">
                <span>启动命令（整行粘贴）</span>
                <input
                  className="sunken mono"
                  value={mcpForm.command}
                  placeholder="npx -y @modelcontextprotocol/server-everything"
                  onChange={(e) => setMcpForm({ ...mcpForm, command: e.target.value })}
                />
              </label>
              <label className="field" title='JSON 对象，如 {"API_KEY":"xxx"}（可选）'>
                <span>环境变量（JSON 对象，可选）</span>
                <input
                  className="sunken mono"
                  value={mcpForm.env}
                  placeholder='{"API_KEY":"sk-..."}'
                  onChange={(e) => setMcpForm({ ...mcpForm, env: e.target.value })}
                />
              </label>
              {mcpHint && <div className="ext-error">{mcpHint}</div>}
              <div className="pv-actions">
                <span className="meta-spacer" />
                <button className="btn btn-primary" disabled={mcpBusy} onClick={() => void saveMcp()}>
                  {mcpBusy ? '启动中…' : '添加并启动'}
                </button>
              </div>
            </div>
          )}

          {tab === 'general' && (
            <>
              <label className="field" title="新会话的默认项目，不影响运行中的会话">
                <span>工作目录</span>
                <div className="field-row">
                  <input className="sunken mono" value={config.workspacePath} readOnly />
                  <button className="btn" onClick={onPickFolder}>
                    选择文件夹…
                  </button>
                </div>
              </label>
              <label className="field" title="Tavily 联网搜索的 API Key（tavily.com 免费注册，1000 次/月）；留空 = 不注册 web_search/web_fetch 工具">
                <span>联网搜索 Tavily Key</span>
                <input
                  className="sunken mono"
                  type="password"
                  value={webSearchKey}
                  onChange={(e) => setWebSearchKey(e.target.value)}
                  placeholder="tvly-…（留空禁用联网工具）"
                />
              </label>
            </>
          )}
        </div>

        <div className="settings-footer">
          <button className="btn" onClick={onClose}>
            取消
          </button>
          <button className="btn btn-primary" onClick={handleSave}>
            保存
          </button>
        </div>
      </div>
    </div>
  )
}
