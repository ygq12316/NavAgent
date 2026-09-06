# navAgent

从零手写的桌面端 coding agent harness（Electron + TypeScript，Windows 优先）。不引入任何 agent 框架与官方 SDK——agent loop、工具系统、上下文管理、SSE 流式协议全部手写，参照 [pi coding agent](https://github.com/badlogic/pi-mono) 的架构逐层对齐。

## 功能

- **手写 agent loop**：流式事件驱动（`message_start/update/end` + `tool_execution_*`）、工具批次并行/串行调度、steering / follow-up 双队列插话、上下文溢出自动恢复（压缩后续跑）
- **多 Provider**：OpenAI 兼容协议（DeepSeek / Qwen / Kimi / 智谱 / Ollama 等）与 Anthropic Messages API 双适配，thinking 块跨模型清洗，429/5xx 指数退避重试
- **工具系统**：`read_file` / `write_file` / `edit_file` / `glob` / `grep` / `ls` / `bash`，工作区路径约束，编辑含 diff 视图
- **并行会话**：多会话独立运行，git 仓库的会话各自落在独立 worktree；SQLite 节点树持久化，支持 rewind / fork / 切换分支（带分支摘要）
- **上下文管理**：手动 `/compact` 与自动压缩（结构化摘要 + token 预算切点），文件注入，图片与文档附件
- **权限审批**：审批 / 自动编辑 / 计划 / 跳过审批四档模式，会话级持久化
- **扩展系统**：`registerTool` / `registerCommand` / 事件订阅 / `pi.state` 持久化 / `ctx.ui` GUI 原语 / `ctx.sessions` 会话树能力面；扩展面板以沙箱 iframe 宿主（`navagent-ext://` 只读协议 + postMessage 桥）
- **会话地图**（内置示例扩展 `/graph`）：以 fork 派生关系连线的会话树画布——左上悬浮列表选会话，卡片可拖动、画布可缩放，删除断线提升子会话为根
- **桌面 UI**：transcript-first 对话流、可拖拽 dock 面板（文件 / 终端 PTY / Diff / Git 面板）、会话 rail、HTML 导出

## 快速开始

```bash
# 前置：Node 20+，pnpm
pnpm install
pnpm dev        # 启动桌面应用（electron-vite dev，热更）
```

首次启动后在 **设置 → 模型供应商** 填入 baseUrl / apiKey（默认预置 DeepSeek，支持任意 OpenAI 兼容端点与 Anthropic），选择模型即可对话。

## 常用命令

```bash
pnpm dev          # Electron 开发（热更）
pnpm dev:web      # 仅浏览器跑 renderer（UI 迭代，mock 数据）
pnpm build        # 生产构建（产物在 out/）
pnpm typecheck    # 双 tsconfig 严格检查
pnpm test         # vitest 全量测试
```

## 架构

```
┌─ Renderer（React，不受信）──────────────────────────┐
│ transcript 对话流 / dock 面板 / 设置 / 会话地图      │
└──────────────△──────────────────┬──────────────────┘
        事件流（AddressedEvent）   │ invoke（白名单 channel）
┌──────────────┴──────────────────▽──────────────────┐
│ Main 进程 = harness（受信）                          │
│  agent/    引擎（engine.ts 只管机制）+ 编排（agent.ts）│
│  providers/ OpenAI 兼容 + Anthropic 双协议适配       │
│  tools/    工具注册表 + 内置工具                     │
│  services/ 终端 PTY / worktree / auth / skills …    │
│  extensions/ 扩展加载器 + 面板宿主 + UI 请求         │
└────────────────────────────────────────────────────┘
```

设计原则（源自 pi 的三个启发）：

1. **边界转换**——内部全程自有消息模型 `AgentMessage`，仅在调用 LLM 处做一次 `convertToLlm`
2. **事件流**——loop 是事件的唯一生产者，UI / 持久化 / 遥测都只是订阅者；事件协议只增不改
3. **状态外置**——会话状态 = 消息数组，持久化 = 追加式记录，恢复 = 重放

关键约束：`EngineHooks` 与 `StreamFn` 禁止 throw——一切失败编码进事件流（`stopReason: 'error'`）或 isError 工具结果，循环永不中断。

## 扩展

扩展是导出 `pi(api)` 函数的 ESM 模块（`index.mjs` 或 `<name>/index.mjs`，可带 `manifest.json`）：

```js
export default function pi(api) {
  api.registerTool({ name, description, parameters, execute })
  api.registerCommand('hello', { description, handler: (args, ctx) => '你好' })
  api.on('turn_end', async (payload, ctx) => { /* 观察会话 */ })
  api.state.set('k', 'v')            // 持久化（userData/ext-state/<extId>.json）
  const handle = api.openPanel({ title, entry: 'panel/index.html' }, {
    onMessage: (op, params, ctx) => ctx.sessions.getTree(ctx.sessionId)
  }, ctx.sessionId)                   // 沙箱 iframe 面板 + postMessage 桥
}
```

放入「设置 → 工具与扩展 → 从文件夹安装」，或直接拷到 `userData/extensions/`（全局）与 `<项目>/.navagent/extensions/`（项目级，需信任）。

内置示例 [`examples/session-graph`](examples/session-graph)：`/graph` 打开会话地图——项目会话按 fork 派生关系连线成树，可拖动、缩放，删除断线提升子会话为根。

## 目录

```
src/
├── main/        # harness：agent 引擎 / providers / 工具 / 服务 / 扩展
├── preload/     # contextBridge 窄接口（唯一桥）
├── renderer/    # React UI（transcript-first）
└── shared/      # 三方共享契约（types / model-catalog / providers）
examples/        # 内置扩展示例（会话地图）
tools/           # 本地开发辅助
```

配置与数据存于 `%APPDATA%/navagent/`（config.json、models.json、auth.json、sessions.db、extensions/）。
