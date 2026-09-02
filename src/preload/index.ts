import { contextBridge, ipcRenderer } from 'electron'
import type { IpcRendererEvent } from 'electron'
import type {
  AgentEvent,
  ApiConfig,
  CommandInfo,
  DirEntry,
  FileReadResult,
  FileWriteResult,
  ImageContent,
  NavAgentApi,
  PermissionDecision,
  ReloadResult,
  SessionMeta,
  SessionTreeNode,
  ToolInfo,
  TreeSummaryResult,
  UiEvent
} from '@shared/types'

const api: NavAgentApi = {
  getConfig: (): Promise<ApiConfig> => ipcRenderer.invoke('config:get'),
  setConfig: (partial: Partial<ApiConfig>): Promise<ApiConfig> => ipcRenderer.invoke('config:set', partial),
  pickWorkspace: (): Promise<string | null> => ipcRenderer.invoke('dialog:pickWorkspace'),
  send: (text: string, images?: ImageContent[]): Promise<'ok' | 'busy'> => ipcRenderer.invoke('agent:send', text, images),
  steer: (text: string): Promise<'ok' | 'queued'> => ipcRenderer.invoke('agent:steer', text),
  followUp: (text: string): Promise<'ok' | 'queued'> => ipcRenderer.invoke('agent:followUp', text),
  cancel: (): Promise<string[]> => ipcRenderer.invoke('agent:cancel'),
  compact: (): Promise<'ok' | 'busy'> => ipcRenderer.invoke('agent:compact'),
  respondPermission: (requestId: string, decision: PermissionDecision): Promise<void> =>
    ipcRenderer.invoke('agent:respondPermission', requestId, decision),
  onEvent: (cb: (e: AgentEvent) => void): (() => void) => {
    const handler = (_e: IpcRendererEvent, event: AgentEvent): void => cb(event)
    ipcRenderer.on('agent:event', handler)
    return () => ipcRenderer.removeListener('agent:event', handler)
  },
  newSession: (): Promise<string> => ipcRenderer.invoke('session:new'),
  listSessions: (projectPath: string): Promise<SessionMeta[]> => ipcRenderer.invoke('session:list', projectPath),
  switchSession: (id: string): Promise<void> => ipcRenderer.invoke('session:switch', id),
  deleteSession: (id: string): Promise<'ok' | 'busy' | 'not-found'> => ipcRenderer.invoke('session:delete', id),
  listDir: (path: string): Promise<DirEntry[]> => ipcRenderer.invoke('fs:listDir', path),
  readFile: (rel: string): Promise<FileReadResult> => ipcRenderer.invoke('fs:read', rel),
  writeFile: (rel: string, content: string, baseMtime?: number): Promise<FileWriteResult> =>
    ipcRenderer.invoke('fs:write', rel, content, baseMtime),
  globFiles: (pattern: string): Promise<string[]> => ipcRenderer.invoke('fs:glob', pattern),
  pickFile: (): Promise<string | null> => ipcRenderer.invoke('file:pick'),
  listTree: (id: string): Promise<SessionTreeNode[]> => ipcRenderer.invoke('session:tree', id),
  switchLeaf: (id: string, nodeId: string, summarize: boolean): Promise<TreeSummaryResult> =>
    ipcRenderer.invoke('session:switchLeaf', id, nodeId, summarize),
  forkSession: (id: string, nodeId: string): Promise<string> => ipcRenderer.invoke('session:fork', id, nodeId),
  cloneSession: (id: string): Promise<string> => ipcRenderer.invoke('session:clone', id),
  listTools: (): Promise<ToolInfo[]> => ipcRenderer.invoke('tools:list'),
  setToolEnabled: (name: string, enabled: boolean): Promise<void> => ipcRenderer.invoke('tools:setEnabled', name, enabled),
  reloadExtensions: (): Promise<ReloadResult> => ipcRenderer.invoke('extensions:reload'),
  listCommands: (): Promise<CommandInfo[]> => ipcRenderer.invoke('commands:list'),
  dispatchCommand: (name: string, args: string): Promise<'ok' | 'unknown'> =>
    ipcRenderer.invoke('commands:dispatch', name, args),
  trustProject: (): Promise<void> => ipcRenderer.invoke('project:trust'),
  trustProjectOnce: (): Promise<void> => ipcRenderer.invoke('project:trustOnce'),
  exportSession: (id: string, format: 'jsonl' | 'html'): Promise<string | null> =>
    ipcRenderer.invoke('session:export', id, format),
  importSession: (): Promise<string | null> => ipcRenderer.invoke('session:import'),
  ptyCreate: (): Promise<string | null> => ipcRenderer.invoke('pty:create'),
  ptyWrite: (id: string, data: string): Promise<void> => ipcRenderer.invoke('pty:write', id, data),
  ptyResize: (id: string, cols: number, rows: number): Promise<void> => ipcRenderer.invoke('pty:resize', id, cols, rows),
  ptyKill: (id: string): Promise<void> => ipcRenderer.invoke('pty:kill', id),
  onUiEvent: (cb: (e: UiEvent) => void): (() => void) => {
    const handler = (_e: IpcRendererEvent, event: UiEvent): void => cb(event)
    ipcRenderer.on('navagent:uiEvent', handler)
    return () => ipcRenderer.removeListener('navagent:uiEvent', handler)
  }
}

contextBridge.exposeInMainWorld('navagent', api)
