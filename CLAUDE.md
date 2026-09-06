# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目定位

navAgent：从零手写的桌面端 coding agent harness（Electron + TypeScript，Windows 优先）。核心约束 R1：agent loop、工具系统、上下文管理全部手写——**不引入 agent 框架、openai/anthropic 官方 SDK、状态库、UI 组件库**，provider 协议直接以 HTTP/SSE 实现。参照物是 pi（badlogic/earendil-works），冻结源码副本在 `docs/references/`，多处代码注释以"对齐 pi 的 xxx"标注对应关系。

`docs/design.md` 是权威系统设计（数据模型、事件协议、分阶段计划均以此为准），改架构前先读它。

## 常用命令

包管理器是 pnpm。

```bash
pnpm dev          # Electron 开发（electron-vite dev，热更）
pnpm dev:web      # 仅浏览器跑 renderer（UI 迭代用，无 Electron 壳）
pnpm build        # electron-vite build（产物在 out/）
pnpm typecheck    # 两个 tsconfig 各跑一次 tsc --noEmit
pnpm test         # vitest run（全部测试）
```

单个测试文件：

```bash
pnpm exec vitest run src/main/agent/__tests__/engine.test.ts
```

按名称过滤：`pnpm exec vitest run -t "关键词"`。测试与源码同目录放在 `__tests__/`，优先覆盖纯函数（SSE 拼装、路径约束、reducer、压缩切分）。

另有独立可视化页 `tools/agent-loop-flow.html`，用 `.claude/launch.json` 的 `flow` 配置起 8931 端口预览。

## 架构

### Electron 进程模型

- **Main 进程 = harness**（受信）：agent 引擎、provider、工具、权限、session 存储、config，全部在 `src/main/`。
- **Renderer = 纯 UI**（不受信）：React，对 agent 的全部认知来自事件流；`src/renderer/src/state/reducer.ts` 以 `AgentEvent` 为 action 增量构建视图模型（事件即 action，协议复用）。
- **Preload = 唯一桥**：`src/preload/index.ts` 经 contextBridge 暴露窄接口 `window.navagent`（invoke 白名单 channel + 单向 `onEvent`）。往 renderer 加任何新能力都必须走这个接口。

### 核心契约（src/shared/types.ts）

`AgentMessage` / `AgentEvent` / 工具模型是 main/preload/renderer 三方共享的"宪法"。事件协议**只增不改**：已发出的事件不撤回，UI 靠增量拼接还原状态；取消与错误是显式事件（`aborted`/`error`/`done(stopReason)`），不走异常。

### 引擎与编排分层（关键）

- `src/main/agent/engine.ts`：**只管循环机制**（流式组装、工具批次、事件发射），对齐 pi 的 agent-loop。
- `src/main/agent/agent.ts`：**编排器**，持有 transcript 与双队列（steering/follow-up），把一切策略装配成 `EngineHooks` 注入引擎：压缩（`compaction.ts`）、审批（`permissions.ts`）、消息清洗（`replay-clean.ts`）、轮数上限、overflow 恢复（检测到上下文溢出错误 → 剔除失败消息 → 压缩 → `agentLoopContinue` 续跑）。
- `stream-fn.ts`：provider 流包装 + 指数退避重试，仅在"零内容失败"时重试。

**关键不变量：`EngineHooks` 与 `StreamFn` 禁止 throw**——失败必须编码进事件流（`done` 事件带 `stopReason: 'error'`）或 isError 工具结果，否则打断引擎的事件序列。工具执行失败同样永不中断 loop（校验失败/权限拒绝/执行异常都归一为 isError 的 tool_result 回填）。

### Provider 层（src/main/providers/）

统一 `ProviderEvent`（text/thinking/tool_call 增量、usage、done），协议差异在此层抹平。`openai-compat.ts` 覆盖 DeepSeek/Qwen/Kimi/Ollama 等一切兼容端点，SSE 跨 chunk 分帧与 `delta.tool_calls` 按 index 归并拼装是国产 API 兼容性的主要修整点（拼装保持纯函数）。`anthropic.ts` 走 Messages API。`pickProvider`（main/index.ts）按模型名/网关地址自动选协议。thinking 块（含 signature/redacted）有独立处理，跨模型清洗时判定签名有效性。

### 会话中心模型（并行会话，对标 Claude Code 桌面端）

UI 范式是**会话为中心、面板（pane）从属**（官方参考已存 `docs/references/claude-code-desktop.md`）：侧栏会话列表 → 并行会话各自独立运行（git 仓库的会话各跑独立 worktree，`src/main/services/worktree.ts`，落 `<root>/.claude/worktrees/<短码>`）；会话内 pane（chat 锚点 / file / terminal / diff）从 Views 菜单唤出、可拖可缩、关闭即摘除（`state/pane-layout.ts` 二叉分割树），**无最小化**；文件触达 = `@mention` 补全 + 路径点击/右键菜单；Diff 面板由 `src/main/services/diff.ts` 提供（git 会话走 `git diff HEAD`，非 git 会话靠引擎 beforeToolCall/afterToolCall 钩子抓写类工具基线）。

main 侧按会话多实例：`SessionManager`（`agent/session-manager.ts`）持 `Map<sessionId, {agent, pm}>`，会话首次 prompt 惰性建实例；**一切 agent/文件/终端 IPC 显式携带 sessionId**。事件经 IPC 信封 `{ sessionId, event: AgentEvent }` 广播（`AgentEvent` 本体契约不变），renderer reducer 按 sessionId 路由进各自的会话桶（`state/reducer.ts` 的 `AppState.sessions`），hydrate 走 `session:load`（读 message 行构建，不依赖 turn_start 重放）。

### 权限模式

三档（`PermissionMode`，存 SessionMeta 持久化、Composer 信息条切换）：`manual`=逐工具审批（L0 现状）；`acceptEdits`=write_file/edit_file 自动放行（PM 的 autoApprovable 短路，bash 照常审批）；`plan`=adaptTools 装配时剔除 mutating 工具 + 系统提示词加只读约束。config 的 `readOnly` 仍是全局级开关，与会话级 plan 模式独立。

### 事件流向与持久化

引擎 emit → `Agent.consume`（message_end 并入 transcript，assistant 打 model 标）→ index.ts 每会话的 `emitFor` 闭包 → ① `webContents.send`（信封）② SessionStore 写 SQLite（`agent/session-store.ts` 门面 + `agent/session-db.ts` 存储层）。**`message_update` 过重不落盘**；message_end 经 `appendMessage` 落 nodes 表（消息唯一事实源，`message_end` 事件不再重复入 events 表）；恢复 = `session:load` 沿 parent 链重放活动路径，`snapshot` 节点出现时丢弃此前累积（压缩标记）。

权威存储 = `userData/sessions.db`（node:sqlite，WAL；sessions/nodes/events/ext_state 四表 + seq 会话内单调行号；**单写者 = main 进程，无跨进程锁**）。meta 全字段在 sessions 表（单行 UPDATE 原子）；全文检索走 nodes.txt 派生列（IPC `session:search`）；JSONL 为导入/导出格式（`importFrom`/`exportJsonl` 互逆），旧 JSONL+meta.json 布局构造期一次性迁移（目录改名备份，绝不删除）。**无 busy 锁**：并行会话是常态；删除会话时 main 侧中止实例、清改动日志并回收 worktree。

### 工具与权限

内置工具在 `src/main/tools/builtin/`，经 `registry.ts` 的 `resolveWithin` 统一做工作区路径约束（Windows 大小写不敏感）；约束的 workspace 来自**会话级** workspace（worktreePath ?? projectPath），`fs:*`/PTY cwd 同源。权限是 L0 审批制：工具的 `requiresApproval` 返回 detail → 每会话的 `PermissionManager` 挂起等 renderer 决定，"always" 记入会话级白名单；`abort()` 时所有 pending 一律 deny。TerminalService 的 PTY 带 200KB 环形缓冲，pane 关闭后 PTY 继续跑、重开 `pty:replay` 回放。

### 其他

- 路径别名 `@shared` → `src/shared`（tsconfig paths + vite/vitest resolve 同步维护）。
- UI 风格：Notion 式扁平双主题（token 见 `styles/theme.css`），transcript-first 范式（`❯` 用户行、工具行+折叠结果），非聊天气泡；transcript 视图模式 Normal/Verbose/Summary（Ctrl+O）。
- 代码注释与 UI 文案使用中文；测试描述也是中文。
