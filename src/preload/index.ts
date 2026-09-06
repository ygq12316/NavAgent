import { contextBridge, ipcRenderer } from 'electron'
import type { IpcRendererEvent } from 'electron'
import type {
  AddressedEvent,
  ApiConfig,
  CatalogSnapshot,
  CommandInfo,
  CredentialInfo,
  CustomProviderInput,
  CustomProviderWriteResult,
  DiffResult,
  ContextBreakdown,
  DiffSummary,
  DirEntry,
  ExtensionInfo,
  ExtensionOpResult,
  FileReadResult,
  FileWriteResult,
  GitStatusResult,
  ImageContent,
  NavAgentApi,
  PermissionDecision,
  PermissionMode,
  ReloadResult,
  SessionLoadResult,
  SessionMeta,
  SessionSearchHit,
  SessionTreeNode,
  ModelListResult,
  ToolInfo,
  TreeSummaryResult,
  UiEvent
} from '@shared/types'

const api: NavAgentApi = {
  getConfig: (): Promise<ApiConfig> => ipcRenderer.invoke('config:get'),
  setConfig: (partial: Partial<ApiConfig>): Promise<ApiConfig> => ipcRenderer.invoke('config:set', partial),
  setOverlayTheme: (theme: 'light' | 'dark'): Promise<'ok'> => ipcRenderer.invoke('win:overlay', theme),
  pickWorkspace: (): Promise<string | null> => ipcRenderer.invoke('dialog:pickWorkspace'),
  send: (sessionId: string, text: string, images?: ImageContent[]): Promise<'ok'> =>
    ipcRenderer.invoke('agent:send', sessionId, text, images),
  steer: (sessionId: string, text: string): Promise<'ok' | 'queued'> =>
    ipcRenderer.invoke('agent:steer', sessionId, text),
  followUp: (sessionId: string, text: string): Promise<'ok' | 'queued'> =>
    ipcRenderer.invoke('agent:followUp', sessionId, text),
  cancel: (sessionId: string): Promise<string[]> => ipcRenderer.invoke('agent:cancel', sessionId),
  compact: (sessionId: string): Promise<'ok' | 'busy'> => ipcRenderer.invoke('agent:compact', sessionId),
  respondPermission: (requestId: string, decision: PermissionDecision): Promise<void> =>
    ipcRenderer.invoke('agent:respondPermission', requestId, decision),
  onEvent: (cb: (e: AddressedEvent) => void): (() => void) => {
    const handler = (_e: IpcRendererEvent, payload: AddressedEvent): void => cb(payload)
    ipcRenderer.on('agent:event', handler)
    return () => ipcRenderer.removeListener('agent:event', handler)
  },
  newSession: (projectPath: string): Promise<string> => ipcRenderer.invoke('session:new', projectPath),
  listSessions: (projectPath: string): Promise<SessionMeta[]> => ipcRenderer.invoke('session:list', projectPath),
  loadSession: (id: string): Promise<SessionLoadResult> => ipcRenderer.invoke('session:load', id),
  searchSessions: (query: string, opts?: { sessionIds?: string[]; limit?: number }): Promise<SessionSearchHit[]> =>
    ipcRenderer.invoke('session:search', query, opts),
  deleteSession: (id: string): Promise<'ok' | 'not-found'> => ipcRenderer.invoke('session:delete', id),
  setSessionMode: (id: string, mode: PermissionMode): Promise<void> =>
    ipcRenderer.invoke('session:setMode', id, mode),
  setSessionModel: (id: string, model: string): Promise<SessionMeta | null> =>
    ipcRenderer.invoke('session:setModel', id, model),
  diffGet: (id: string): Promise<DiffResult> => ipcRenderer.invoke('diff:get', id),
  diffSummary: (id: string): Promise<DiffSummary | null> => ipcRenderer.invoke('diff:summary', id),
  contextBreakdown: (sessionId: string): Promise<ContextBreakdown> => ipcRenderer.invoke('context:breakdown', sessionId),
  injectFile: (sessionId: string, rel: string): Promise<'ok' | 'not-found'> => ipcRenderer.invoke('fs:injectFile', sessionId, rel),
  saveAttachment: (sessionId: string, name: string, dataB64: string): Promise<{ ok: boolean; path?: string; error?: string }> =>
    ipcRenderer.invoke('fs:saveAttachment', sessionId, name, dataB64),
  uninjectFile: (sessionId: string, rel: string): Promise<'ok' | 'not-found'> =>
    ipcRenderer.invoke('context:uninject', sessionId, rel),
  listInjectedFiles: (sessionId: string): Promise<string[]> => ipcRenderer.invoke('context:injectedList', sessionId),
  absPath: (sessionId: string, rel: string): Promise<string> => ipcRenderer.invoke('fs:absPath', sessionId, rel),
  gitBranches: (sessionId: string): Promise<{ current: string | null; branches: string[] }> =>
    ipcRenderer.invoke('git:branches', sessionId),
  gitStatus: (sessionId: string): Promise<GitStatusResult> => ipcRenderer.invoke('git:status', sessionId),
  gitSwitch: (sessionId: string, branch: string): Promise<{ ok: boolean; message?: string }> =>
    ipcRenderer.invoke('git:switch', sessionId, branch),
  readFile: (sessionId: string, rel: string): Promise<FileReadResult> =>
    ipcRenderer.invoke('fs:read', sessionId, rel),
  listDir: (sessionId: string, path: string): Promise<DirEntry[]> =>
    ipcRenderer.invoke('fs:listDir', sessionId, path),
  writeFile: (sessionId: string, rel: string, content: string, baseMtime?: number): Promise<FileWriteResult> =>
    ipcRenderer.invoke('fs:write', sessionId, rel, content, baseMtime),
  globFiles: (sessionId: string, pattern: string): Promise<string[]> =>
    ipcRenderer.invoke('fs:glob', sessionId, pattern),
  revealPath: (sessionId: string, rel: string): Promise<void> => ipcRenderer.invoke('fs:reveal', sessionId, rel),
  listTree: (id: string): Promise<SessionTreeNode[]> => ipcRenderer.invoke('session:tree', id),
  switchLeaf: (id: string, nodeId: string, summarize: boolean): Promise<TreeSummaryResult | 'busy'> =>
    ipcRenderer.invoke('session:switchLeaf', id, nodeId, summarize),
  forkSession: (id: string, nodeId: string): Promise<string | null> =>
    ipcRenderer.invoke('session:fork', id, nodeId),
  cloneSession: (id: string): Promise<string | null> => ipcRenderer.invoke('session:clone', id),
  listTools: (): Promise<ToolInfo[]> => ipcRenderer.invoke('tools:list'),
  setToolEnabled: (name: string, enabled: boolean): Promise<void> => ipcRenderer.invoke('tools:setEnabled', name, enabled),
  reloadExtensions: (): Promise<ReloadResult> => ipcRenderer.invoke('extensions:reload'),
  listExtensions: (): Promise<ExtensionInfo[]> => ipcRenderer.invoke('extensions:list'),
  installExtension: (): Promise<ExtensionOpResult> => ipcRenderer.invoke('extensions:install'),
  removeExtension: (id: string): Promise<ExtensionOpResult> => ipcRenderer.invoke('extensions:remove', id),
  setExtensionEnabled: (id: string, enabled: boolean): Promise<ExtensionInfo[]> =>
    ipcRenderer.invoke('extensions:setEnabled', id, enabled),
  listCommands: (): Promise<CommandInfo[]> => ipcRenderer.invoke('commands:list'),
  dispatchCommand: (sessionId: string, name: string, args: string): Promise<'ok' | 'unknown'> =>
    ipcRenderer.invoke('commands:dispatch', sessionId, name, args),
  trustProject: (): Promise<void> => ipcRenderer.invoke('project:trust'),
  trustProjectOnce: (): Promise<void> => ipcRenderer.invoke('project:trustOnce'),
  exportSession: (id: string, format: 'jsonl' | 'html'): Promise<string | null> =>
    ipcRenderer.invoke('session:export', id, format),
  importSession: (): Promise<string | null> => ipcRenderer.invoke('session:import'),
  respondUi: (requestId: string, value: string | boolean | null): Promise<void> =>
    ipcRenderer.invoke('agent:respondUi', requestId, value),
  panelInvoke: (panelId: string, op: string, params?: Record<string, unknown>): Promise<unknown> =>
    ipcRenderer.invoke('panel:invoke', panelId, op, params),
  panelClose: (panelId: string): Promise<void> => ipcRenderer.invoke('panel:close', panelId),
  ptyCreate: (sessionId: string): Promise<string | null> => ipcRenderer.invoke('pty:create', sessionId),
  ptyList: (sessionId: string): Promise<string[]> => ipcRenderer.invoke('pty:list', sessionId),
  ptyReplay: (id: string): Promise<string> => ipcRenderer.invoke('pty:replay', id),
  ptyWrite: (id: string, data: string): Promise<void> => ipcRenderer.invoke('pty:write', id, data),
  ptyResize: (id: string, cols: number, rows: number): Promise<void> =>
    ipcRenderer.invoke('pty:resize', id, cols, rows),
  ptyKill: (id: string): Promise<void> => ipcRenderer.invoke('pty:kill', id),
  ptyRunCommand: (sessionId: string, command: string): Promise<'ok' | 'no-terminal'> =>
    ipcRenderer.invoke('pty:runCommand', sessionId, command),
  onUiEvent: (cb: (e: UiEvent) => void): (() => void) => {
    const handler = (_e: IpcRendererEvent, event: UiEvent): void => cb(event)
    ipcRenderer.on('navagent:uiEvent', handler)
    return () => ipcRenderer.removeListener('navagent:uiEvent', handler)
  },
  listCatalog: (): Promise<CatalogSnapshot> => ipcRenderer.invoke('catalog:merged'),
  listModels: (): Promise<ModelListResult> => ipcRenderer.invoke('models:list'),
  listCredentials: (): Promise<CredentialInfo[]> => ipcRenderer.invoke('auth:list'),
  saveCredential: (providerId: string, key: string): Promise<void> =>
    ipcRenderer.invoke('auth:set', providerId, key),
  clearCredential: (providerId: string): Promise<void> => ipcRenderer.invoke('auth:clear', providerId),
  saveCustomProvider: (input: CustomProviderInput): Promise<CustomProviderWriteResult> =>
    ipcRenderer.invoke('providers:save', input),
  deleteCustomProvider: (id: string): Promise<CustomProviderWriteResult> => ipcRenderer.invoke('providers:delete', id),
  probeModels: (input: { baseUrl: string; protocol: 'openai-compat' | 'anthropic'; apiKey?: string; providerId?: string }): Promise<{ ok: boolean; models: string[]; error?: string }> =>
    ipcRenderer.invoke('providers:probeModels', input),
  renameSession: (id: string, title: string): Promise<SessionMeta | null> => ipcRenderer.invoke('session:rename', id, title),
  setSessionArchived: (id: string, archived: boolean): Promise<SessionMeta | null> =>
    ipcRenderer.invoke('session:archive', id, archived),
  setSessionProject: (id: string, projectPath: string): Promise<SessionMeta | null> =>
    ipcRenderer.invoke('session:setProject', id, projectPath)
}

contextBridge.exposeInMainWorld('navagent', api)
