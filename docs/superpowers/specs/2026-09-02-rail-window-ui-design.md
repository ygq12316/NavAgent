# navAgent 窗口化 UI 重构设计（rail + 自由窗口区）

- 日期：2026-09-02
- 状态：已与用户逐节确认定稿
- 关联：`docs/design.md`（权威系统设计）、`CLAUDE.md`（项目约束 R1：手写原则）

## 1. 目标与范围

把现有固定布局（Sidebar | TopBar/Transcript/Composer/StatusBar）重构为「**固定会话左栏 + 右侧自由窗口区**」的平铺窗口体系，视觉从新拟物（Neumorphism）暗色切换为 Notion 式扁平双主题。

**做什么**：五类窗口（会话管理/聊天/Files 目录/File 内容/Terminal）、自由平铺布局引擎（手写）、双主题、Composer 底部信息条（模型/思考/上下文/附件）、真 PTY 终端、可编辑文件查看器。

**不做什么（v1 明确排除）**：OS 级多窗口、File 窗口多实例（全部单例）、停靠库（dockview 等）、Monaco、fs.watch、图片预览、文本/任意文件附件、模型行内下拉切换（点击跳设置面板）、跨区拖拽、浮动叠加窗口。

## 2. 视觉规范（定稿）

### 2.1 双主题令牌

语义令牌双层：组件只引用语义变量，主题 = 一组变量值，沿用现有 `data-theme` 机制（`<html data-theme>`）。**明亮为默认**。

| 令牌 | 明亮（B） | 暗色（C） |
|---|---|---|
| `--desk`（桌面区底） | `#d2cfc8` | `#1d2126` |
| `--win`（窗口底） | `#f6f5f2` | `#2a2f37` |
| `--content`（内容区底） | `#fbfaf8` | `#23272e` |
| `--bd`（窗口边框） | `#c8c5be` | `#3a404a` |
| `--wbd`（窗口内分隔） | `#dddad4` | `#343a43` |
| `--inner`（内嵌元件底） | `#e9e7e1` | `#31373f` |
| `--tx` / `--dim` / `--faint` | `#33312c` / 60% / 38% | `#d7dce6` / 62% / 38% |
| `--hov`（悬停底） | `rgba(51,49,44,.06)` | `rgba(215,220,230,.07)` |
| `--acc`（accent） | `#2383e2` | `#7c93ff` |
| `--ok` / `--warn` | `#0f7b6c` / `#b58a2e` | `#5cba8c` / `#d9a441` |

补充规则：

- 窗口圆角 **14px 四角全圆**，窗口间 8px 沟槽露出 `--desk` 底色；窗口内部容器圆角 13px（底部）
- 零新拟物：删除 `.raised/.sunken` 与全部 box-shadow 阴影体系；窗口仅保留一层 `--sh` 浅投影；分隔一律 1px 边框
- 悬停 = `--hov` 底色渐现（约 120ms），无位移无阴影
- 主题切换按钮在 TopBar（☾/☀），选择记忆在 localStorage
- `styles.css` 重写为三层结构：令牌 → 原语（按钮/输入/滚动条）→ 组件；删除 `[data-theme='light']` 旧变体

## 3. 窗口体系（五类，全部单例）

| 窗口 | 初始 | 位置约束 | 移动 | 调大小 | 最小化 — | 关闭 ✕ |
|---|---|---|---|---|---|---|
| 会话管理 | 在 | 固定最左、满高（左栏） | ✕ 禁止 | ✓ 仅宽度，160–320px 限位 | ✓（塌缩 44px 细条） | ✕ 禁止 |
| 聊天 | 在 | 右侧自由区 | ✓ | ✓ | ✓ | ✕ 禁止 |
| Files | 不在 | 自由区 | ✓ | ✓ | ✓ | ✓ |
| File | 不在 | 自由区 | ✓ | ✓ | ✓ | ✓（脏内容先确认） |
| Terminal | 不在 | 自由区 | ✓ | ✓ | ✓ | ✓ |

- **首启**：只有会话管理左栏 + 聊天满宽。Files/File/Terminal 由聊天标题条右上「＋Files ＋File ＋Terminal」唤出，落入默认槽（Files→左、File→右、Terminal→下）。
- **单例**：每类至多一个。Files 树点文件 / `＋File`（系统文件选择器）/ 聊天工具块里的文件路径 → 都作用于唯一 File 窗口：已关则开、已最小化则恢复、已在显示则替换内容（有未保存修改先弹确认）。
- **聊天最小化边界**：＋按钮长在聊天标题条上，聊天隐藏期间 TopBar 出现「＋聊天」唤回按钮。
- **Terminal 多终端**：窗口单例，内部标签条多终端（每标签一个 PTY 会话）；标签 ✕ = kill 单个，窗口 ✕ = kill 全部，**最小化 = PTY 继续运行**。

## 4. 布局数据模型（手写，无布局库）

```ts
type FreeKind = 'chat' | 'files' | 'file' | 'terminal'

interface LayoutState {
  rail:  number                                 // 左栏宽，clamp 到 [160, 320]
  free:  FreeNode | null                        // 右侧自由区分割树；null = 只剩聊天满宽
  min:   Partial<Record<'sessions'|FreeKind, MinRec>>  // 最小化窗口暂存的原树挂载路径
  theme: 'light' | 'dark'
}

/** free 树窗口的暂存挂载路径（自根到叶的 child 索引序列）；sessions 的最小化只是布尔态（rail 塌缩），不需要路径 */
type MinRec = { at: number[] }

type FreeNode =
  | { t: 'split'; dir: 'row' | 'col'; ratio: number; children: FreeNode[] }
  | { t: 'leaf'; kind: FreeKind }
```

不变量（reducer 内校验，非法操作静默忽略）：

1. 每个 kind 至多一个 leaf；`sessions` 不进 `free` 树
2. `rail` 恒在区间内；`ratio` ∈ (0,1) 且每个 split 子树有最小像素限位（拖拽 clamp）
3. split 重平衡：摘除 leaf 后只剩一个孩子的 split 坍缩为该孩子；`free` 树为空 → `null`（聊天满宽）
4. **聊天为自由区唯一可见窗口时禁止最小化**（否则自由区空白无物可显）；此规则在 reducer 拒绝该操作

交互语义：

- **调大小**：窗口间分隔条 7px 热区，悬停变 accent 色；拖动改相邻 `ratio`（左栏边界拖动改 `rail`）
- **换位**：拖窗口标题条 → 落点预览（目标窗口边缘半区 = 插入分栏，正中 = 两窗互换）；自由区内自由拖，拖到左栏 = 🚫 拒绝
- **最小化**：leaf 从树摘除，挂载路径记入 `min`；恢复时优先插回原位，路径失效落默认槽
- **持久化**：LayoutState 序列化存 `localStorage['navagent.layout.v1']`；启动恢复，解析/校验失败 → 重置默认

实现形态：`src/renderer/src/state/layout.ts`（纯函数 reducer + 动作）+ `src/renderer/src/components/dock/`（DockRoot/WindowFrame/Splitter/DragLayer 组件）。拖拽用 pointer events（非 HTML5 DnD，避免拖影与 iframe/xterm 兼容问题）。

## 5. 五窗口数据流

### 5.1 会话管理（左栏）

- 沿用 `listSessions / newSession / switchSession`；新增 `session.delete(id)`
- 删除规则：悬停 🗑 → 确认 → 删 `<id>.jsonl + .meta.json`；Agent 运行中禁止删当前会话（busy）；删的是当前会话 → 自动切列表下一个

### 5.2 聊天

- 现有 reducer 与事件流**一行不动**；三处接线：
  - 思考 chip：`off/low/medium/high` 四档 → `setConfig({ modelParams: { thinkingLevel } })`（链路已存在）；模型不支持 thinking 时 chip 置灰（复用 thinkingFormat 判定）
  - 附件：📎 选图（v1 仅图片）→ chip 列表可删 → `send(text, images)`（现有 ImageContent）
  - 上下文条：usage 累计 / `config.contextWindow`，**>80% 数字与进度条转 `--warn`** 并提示 `/compact`
- Composer 底部信息条布局：`[模型 ▾] [🧠 ●●○ ▾] [▓ 12.4k/128k] [📎] [发送]`；模型 chip 点击 → 打开设置面板（v1 不做行内切换）
- 工具块中 read-file/edit-file/write-file 的文件路径渲染为可点 → 唤起 File 窗口；不自动弹窗

### 5.3 Files（目录）

- `listDir`（现有 API）懒加载树，展开缓存；手动刷新按钮
- 搜索两层：① 输入即前端过滤已加载节点；② 回车 → `fs.glob(pattern)` IPC（复用 main 已有 `tools/builtin/glob.ts` 实现）→ 相对路径结果列表 → 点击开 File
- ⧉ 复制相对路径 → `navigator.clipboard`（无需 IPC）

### 5.4 File（内容）

- **CodeMirror 6** + 自写薄 React 包装（不用 @uiw 封装）；语言包按扩展名懒加载（ts/js/json/md/py 起步）
- `fs.read(path)` → `{content, mtime}` 作为基线；编辑 → dirty（标题 ●）
- Ctrl+S → `fs.write(path, content, baseMtime)`；**mtime 不一致（agent 已改过）→ 冲突三选：覆盖 / 重新加载 / 取消**
- 外部变更检测：无 fs.watch；窗口聚焦时复查 mtime，变更提示重载
- 文件内查找：CM6 官方 search 扩展（Ctrl+F）；复制：选区/全文 → clipboard
- 二进制 / >1MB：只读提示，不进编辑器

### 5.5 Terminal

- 主进程新增 `TerminalService`（`src/main/terminal.ts`）：node-pty（Windows ConPTY，默认 powershell.exe）；session map `id → {pty, exit}`
- 渲染 xterm.js；配色跟随主题令牌；窗口尺寸变化 → `pty.resize`
- 多标签：窗口内 tab 条，每标签绑一个 pty id；`＋` 新建
- **最小化 = PTY 继续跑**，输出进环形缓冲（≈1000 行），恢复时回放

## 6. IPC 与事件通道

preload 白名单新增（全部路径过 `resolveWithin` 工作区约束，复用现有函数）：

| 通道 | 方向 | 说明 |
|---|---|---|
| `fs.read(path)` | invoke | `{content, mtime}`；二进制/超限返回错误标记 |
| `fs.write(path, content, baseMtime)` | invoke | mtime 冲突返回 `conflict` |
| `fs.glob(pattern)` | invoke | 相对路径列表（复用 glob 工具实现） |
| `pty.create()` | invoke | `{ptyId}` |
| `pty.write(id, data)` | invoke | |
| `pty.resize(id, cols, rows)` | invoke | |
| `pty.kill(id)` | invoke | |
| `file.pick()` | invoke | 系统文件选择器（dialog.showOpenDialog，限工作区） |
| `session.delete(id)` | invoke | busy 时返回 `busy` |
| `onUiEvent(cb)` | 事件 | `pty.data(id, chunk)` / `pty.exit(id, code)` |

**`onUiEvent` 与 `AgentEvent` 分通道**：AgentEvent 是 agent 契约（只增不改），PTY 等 UI 事件走独立通道，避免污染事件协议。

依赖新增：`node-pty`（原生模块，electron-vite 需 externalize 配置 + Windows 构建验证）、`xterm.js`（@xterm/xterm + @xterm/addon-fit）、CodeMirror 6 各包。均为运行时依赖，不引入框架/UI 库（R1 不破坏）。

## 7. 错误处理

对齐现有契约：**IPC 与 hooks 永不 throw**，失败编码进返回值/事件。

- PTY spawn 失败 → Terminal 窗口内错误态 + 重试按钮
- `fs.write` mtime 冲突 → 三选对话框（覆盖 / 重新加载 / 取消）
- `fs.read` 二进制/超限 → File 窗口只读提示
- 布局持久化解析失败/不变量校验不过 → 重置默认布局
- `session.delete` busy → toast 提示，不动数据

## 8. 测试策略

- **布局树纯函数**（单测主战场，`state/layout.ts`）：插入默认槽/摘叶重平衡/ratio 与 rail clamp/最小化恢复（原位与失效回退）/不变量校验/序列化往返
- mtime 冲突判定纯函数
- PTY 输出分帧与环形缓冲回放（mock 流，思路对齐 openai-compat SSE 跨 chunk 测试）
- fs 路径约束：复用/扩展现有 `resolveWithin` 测试
- 拖拽/DnD/键盘（Ctrl+S、Esc）→ 实现计划中列手动验收清单（dev:web + Electron 双环境）

## 9. 实施阶段建议（供 writing-plans 展开）

1. 令牌与主题系统重写（styles.css 三层 + 双主题 + 删新拟物）
2. 布局引擎：LayoutState reducer 纯函数 + 单测
3. 窗口壳层组件：DockRoot/WindowFrame/Splitter + 分隔条拖拽
4. 拖拽换位 + 最小化/恢复 + 持久化
5. 现有聊天迁移进自由区窗口 + TopBar 改造（主题切换/＋聊天）
6. 会话管理左栏 + `session.delete`
7. Files 窗口（树 + 过滤 + glob 搜索 + 复制）
8. File 窗口（CM6 + fs.read/write + 冲突对话框）
9. Terminal（node-pty + xterm + 多标签 + 环形缓冲）
10. Composer 信息条（模型/思考/上下文/附件）

每阶段可独立 typecheck + test 通过；阶段 9 之前全部功能可在 `pnpm dev:web` 验证（PTY 相关需 `pnpm dev` Electron 环境）。
