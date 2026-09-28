# hermes-agent-vscode 重构计划

对象: `eyanlin.hermes-agent-vscode` 0.2.53 (fork 自 https://github.com/eyan-ai/hermes-agent-vs-code)
基线 HEAD: `89d88cc` (含 A2/A6/A7 修复)
产出日期: 2026-09-28
性质: **计划文档 — 本文件不含代码改动, 实施为后续独立任务**

---

## 0. 一句话结论

**这个插件的病不是「没选对框架」, 是四个结构性缺陷: ①host 侧一个 3,396 行的 God Class ②前端渲染模型是「状态→全量重建 DOM」 ③流式更新无降频 ④输入框(composer)与消息流耦合在同一条渲染路径上。**
**模仿对象已选定: `formulahendry/vscode-acp` —— 同协议(ACP)、同后端(Hermes 在它的支持列表里)、同 UI 形态(聊天 webview), 且已按职责拆好模块。这是唯一「直接同构」的范本。**

**证据分级**: `[实测]` 本轮直接读码/统计; `[文献]` 外部文档/源码, 附 URL; `[推断]` 有依据的推论; `[推测]` 未验证的机制猜测。

---

## 1. 模仿对象档案 (Step 2 产出)

调研方法: 2 个并行子代理独立调研 (模仿对象 + Webview 规范), 结论收敛后由主 agent 逐条复核关键声称。
原始报告: `cache/scratch/refactor-research/{01-peer-implementations.md, 02-webview-best-practices.md}`

| 对象 | 仓库 | 同构度 | 抄什么 |
|------|------|--------|--------|
| **vscode-acp** | `formulahendry/vscode-acp` | **最高 — 直接同构** | **整体模块切分 + StreamAdapter** |
| Kilo Code | `Kilo-Org/kilocode` | 中 — 大规模 VS Code agent 扩展 | **host 侧流式 coalesce** |
| Cline | `cline/cline` | 中 — 同域但已 SDK-first | **typed 消息层设计思路** |
| vscode-copilot-chat | `microsoft/vscode-copilot-chat` | 低 — **已归档**, 依 40+ 私有 API | 仅 feature 分层命名 |
| Continue | `continuedev/continue` | 低 — 通用 AI 助手 | **反例: 它也有同样的 `preserveFocus:false`** |
| ACP 官方 (Zed) | `agentclientprotocol/*` | 权威 | **官方 SDK `client()` + 类型** |

### 1.1 为什么 vscode-acp 是首选 — 主 agent 亲自核实 [实测]

**主 agent 直接抓取 https://github.com/formulahendry/vscode-acp 与 https://zed.dev/acp/editor/vscode 核实 (未依赖子代理转述):**

- **README 标题逐字**: "connect to any ACP-compatible AI coding agent (Claude, Codex, Copilot, Qwen, Gemini, OpenCode, Kiro, OpenClaw, **Hermes** and more)" [实测]
- **预置 agent 表内逐字**: `| [Hermes Agent](https://hermes-agent.nousresearch.com/docs/user-guide/features/acp) | hermes acp |` [实测] —— **它跑的就是我们这套后端**
- **Zed 官方 VS Code 页**明确 "View Documentation → github.com/formulahendry/vscode-acp" [实测]
- **README「Architecture」节逐字给出模块切分** [实测]:
  ```
  Core:     AgentManager, ConnectionManager, SessionManager, AcpClientImpl
  Handlers: FileSystemHandler, TerminalHandler, PermissionHandler, SessionUpdateHandler
  UI:       SessionTreeProvider, ChatWebviewProvider, StatusBarManager
  Config:   AgentConfig, RegistryClient
  Utils:    Logger, StreamAdapter
  ```
- **技术栈**: 原生 TS + webpack, 依赖仅 `@agentclientprotocol/sdk` + `marked`, **无 React** [实测: README Development 节]

**关键负面事实 (主 agent 实测, 子代理未报)**: README「Known Issues」明写 **"File attachment feature is not yet functional"**。
⇒ **不可整体照搬**, 尤其附件链路 —— 我们的 B1/B2 修复恰好在附件上, 比它完整。**照搬范围限定为「模块切分 + 流式适配」, 排除附件实现。**

### 1.2 独立收敛的结论 (两个子代理各自得出, 未互相通气) [推断·高置信]

**两条独立调研线在核心判断上撞车, 这是本次最强的证据形态:**

- 子代理 A (模仿对象): 「composer 应是独立长生命周期 DOM 节点, 绝不进消息流渲染路径」— 依据: React key 隔离(Cline/Kilo) 与原生模块隔离(vscode-acp) **殊途同归**
- 子代理 B (Webview 规范): 「全量 `innerHTML` 重建是本插件三个 bug 的同根; 输入区保身份是首选解法; host 侧合帧节流 50–100ms」

**收敛点 = 病灶 ④(composer 耦合) + ③(流式无降频)。** 两条独立路径同时指向同一处 ⇒ 该结论可信度高于任一单线结论。

---

## 2. 重构部位 (Step 3 产出) — 具体病灶 + 目标形态

### 病灶 ① God Class — 3,396 行 / ~150 方法 [实测]

**现状**
```
extension.js        3774 行
class HermesSidebarProvider   :240 → :3635   = 3,396 行 (占 90%)
方法数               ~150
全文件 class 数       1
构造函数可变字段      40+
```

**职责混装 (9 域)** [实测]:
| # | 职责域 | 代码位置 | 方法数 |
|---|--------|----------|--------|
| 1 | Webview 生命周期 + 消息路由 | `:295/:381/:695`(`onMessage` 122 行 switch)`/:3609` | ~6 |
| 2 | 会话 CRUD + 持久化 | `:393-509/:817/:933/:1292` | ~14 |
| 3 | **编辑器列/标签搬迁** | `:509-694` | **11** |
| 4 | 附件/文档打开 | `:984-1097/:3215` | ~8 |
| 5 | 模型/设置 | `:828-931/:1950` | ~6 |
| 6 | 队列/steering | `:1112-1150/:1454-1541` | ~6 |
| 7 | ACP 传输与生命周期 | `:1192-1290/:1599-2170/:2616-2839/:3329-3448` | ~40 |
| 8 | **权限审批 + diff 预览** | `:2170-3233` | **~38 (1,063 行)** |
| 9 | CLI 直连(第二套后端)+ mock | `:3299-3497/:3367` | ~7 |

**跨域越界实证** [实测] — `dispatchCommand()` `:1386`:
```js
await this.appendCommandNotice(sessionId, command,
  `状态：${this.isSessionRunning(sessionId) ? "running" : "idle"}\n` +
  `队列：${this.promptQueue.snapshot(sessionId).length}\n` +      // ← 伸手进队列域
  `待审批：${this.pendingPermission?.uiSessionId === sessionId ? "yes" : "no"}`);  // ← 伸手进权限域
```
**命令分发方法直接读权限域与队列域内部状态拼字符串** — 无接口、无封装。

**跨域字段访问计数** [实测, `:240-3635` 内 `grep -c`]: `this.sessions` 41 · `this.acpSessions` 27 · `this.pendingPermission` 27 · `this.promptQueue` 20 · `this.acp` 17

**目标形态** — 对齐 vscode-acp 的 5 目录命名 (保留现有 `lib/` 作为迁移落点):
```
extension.js                 → 仅 activate/deactivate + 组装 (目标 <150 行)
lib/core/
    session-manager.js       ← 会话域 (:393-509, :817, :933, :1292)
    acp-connection.js        ← ACP 传输 (:1192-1290, :1599-2170, :2616-2839)
    editor-layout.js         ← 窗口布局 (:509-694) 【病灶 ① 的 A7 属地】
lib/handlers/
    permission-handler.js    ← 权限审批 (:2170-2600)
    diff-handler.js          ← diff 预览 (:2886-3233)
    attachment-handler.js    ← 附件/文档 (:984-1097, :3215)
lib/ui/
    chat-provider.js         ← Webview 宿主 + 消息路由 (:295-393, :695-817)
    status.js                ← 面板标题/编辑器上下文 (:553-575, :3516-3590)
lib/transport/
    stream-adapter.js        ← 流式合帧 【病灶 ③ 的落点】
    message-contract.js      ← typed 消息层 【病灶 ② 的一半】
```
**关键约束**: 拆分必须是**纯搬迁 + 显式依赖注入**, 不允许顺手改逻辑。每个模块接收它需要的状态 (如 `sessionManager`), 而不是 `this`。**判据: 拆分后任一模块不得持有 `pendingPermission` 与 `acpSessions` 两者。**

---

### 病灶 ② 前端渲染模型 — 全量重建 [实测]

**现状**: `media/main.js` 2,225 行单文件; 全局可变 `state`; `render()` 内 `document.querySelector("#app").innerHTML = ...` **全量重建**。

**作者已感知代价并打了补丁** [实测]: 自写 morph (`morphLiveChildren`/`morphLiveNode`/`liveKey`, `:435-484`) 试图在重建后恢复节点身份。

**主 agent 实测结论 (本轮 probe, 8 场景)**: 手写 morph **语义正确** — 6/6 场景节点身份保持 (含 contenteditable 存活、thinking `hasText` 翻转、折叠态变化)。
**唯一边界**: 同 key 节点若 `tagName` 变化会被替换而非原地更新 (`probe.js` D1 FAIL)。

> **主 agent 自我更正 (方法论)**: 我本轮**曾断言 morph 是焦点丢失的机制, 实测推翻 (6/6 PASS)**。这与上一轮把 `:634` 错判为真凶是同类错误 —— **读代码觉得有道理 ≠ 事实**。故排除。

**目标形态**: 不改渲染哲学 (风险过高), 而是**把 composer 从重建路径里摘出来**:
- `#prompt` 容器**建一次、长期持有**, 消息流渲染只更新消息列表容器 —— 对齐 vscode-acp 的模块隔离与 Cline/Kilo 的 React key 隔离 (**两者殊途同归的那条原则**)
- 保留 morph 作为消息列表的过渡手段 (它经实测可用), 但**新增动态结构时必须显式给 `data-live-key`**

---

### 病灶 ③ 流式更新无降频 [文献 + 推断]

**现状** [实测]: ACP `session/update` 到达后逐条 `post()` 给 webview, 无合帧。

**为什么这是流式专属症状的来源** [推断, 依据见 §4.2]: 高频 postMessage ⇒ 高频 webview 重渲染 ⇒ 丢焦点的**时间窗口每轮被踩数百次**而非几次。

**目标形态** (抄 Kilo Code): host 侧在 `lib/transport/stream-adapter.js` 内**合帧 16–50 ms** 再 post。**证据**: 子代理 A 引 kilo.ai 架构页「coalesce high-frequency stream updates before posting UI messages」[文献]; 子代理 B 独立给出「host 侧合帧节流 50–100ms + rAF 批处理」[文献]。

---

### 病灶 ④ composer 与消息流耦合 [实测 + 推断]

**现状** [实测]: `renderPromptLine()` (`:1342`) 产出 `contenteditable` 输入框, 由 `renderComposer()` (`:1276`) 调用, 由 `render()` 调用 ⇒ **composer 处于全量重建路径上**。

**实测边界**: 主 agent probe 证明**在现有 morph 下 composer 未被打断** (6/6 PASS)。因此这不是当前已证实的故障源, 而是**结构性风险**: 一旦 morph 判断失误 (如 tagName 变化、key 缺失), composer 就会被替换。

**目标形态**: 同病灶 ② —— composer 移出重建路径, 独立长生命周期。

---

### 病灶 ⑤ 双后端未收敛 [实测]

**现状** [实测]: 存在 **3 条**对话通道 — ACP 全链路 (~40 方法) / CLI 直连 (`runCli`/`handleCliEvent`/`createCliTurn`/`finishCliTurn`/`terminateProcess`) / `mockStream` (`:3299`)。各自维护独立状态 (`cliTurns`/`cliClient` vs `acp`/`acpSessions`/`activeTurns`), **无共享接口**。

**推断**: 同一语义 (一轮对话生命周期) 有三份实现 ⇒ 行为不一致风险结构性存在。依据: 无共同抽象层, 状态彼此独立。

**目标形态**: 抽取 `TurnRunner` 接口, 三通道各出一个 adapter; 或**明确废弃 CLI 直连与 mock**, 只留 ACP (需先确认 CLI 通道是否仍被使用 —— **未验证, 见 §6**)。

---

### 病灶 ⑥ `_movingEditorTabs` 时间赌注锁 [实测]

**现状** [实测]: 全库仅 4 处引用 —— `:287` 初始化 false, `:640` 早退, `:643` 置 true, `:672` 经 `setTimeout(..., 75)` 复位。

**推断**: 复位与真实搬迁完成之间**无因果关联**, 纯时间赌注; 搬迁慢于 75 ms 时锁被提前放开。依据: 复位是定时器而非搬迁完成的回调。

**目标形态**: 改为 Promise/状态机, 由搬迁完成事件释放。

---

## 3. 分期计划 (Step 4 产出)

> 排序原则: **先止血 → 再治本 → 后升级**。第一期的共同特征是「不依赖架构拆分」。

### 第 0 期 — 定音 (前置, 必须先做)

**在动任何架构之前, 先拿到运行时日志证实 §4.2 的因果闭环。**
理由: 前三轮我猜了三次机制 (`:634` / morph / 回环), 前两次被实测推翻。**架构重构耗资巨大, 必须建立在已证实的根因上, 而非第三个未经证实的推断。**

交付: 临时诊断补丁 (仅加日志, 不改行为) —— webview 侧 `focusin`/`focusout`/`window.blur` + host 侧 `onDidChangeActiveTextEditor` 与 `ensureEditorIsolation` 调用记录, 两侧时间戳对账。
**验收**: 用户复现一次, 日志显示「焦点先丢给 editor, 再触发 isolation」或证伪。
**用户已同意此方案** (选择「要 —— 加日志, 你复现后我看 Output 面板定音」)。

### 第 1 期 — 止血 (1–2 天, 不动架构)

| 项 | 内容 | 依据 |
|----|------|------|
| 1.1 | **切断事件回环**: `:208-213` 把 `ensureEditorIsolation()` 从 `onDidChangeActiveTextEditor` 里摘出, 或加「流式中不搬迁」守卫 | §4.2 [推断] |
| 1.2 | 后台操作一律 `preserveFocus:true` 全量审查 (A7 只覆盖了搬迁一条路) | C5 [文献] + Continue 反例 [实测] |
| 1.3 | 滚动: 删无条件归零 + 贴底检测 + Jump-to-latest | C6 [文献] microsoft/vscode #330811 |

**验收**: 每个修复配 1–2 条 **INVARIANT 行为契约测试** (依 AGENTS.md:316-345, 须 base 上红、修后绿), 走 `scripts/run_tests.sh`。

### 第 2 期 — 治本 (1 周量级)

| 项 | 内容 | 抄谁 |
|----|------|------|
| 2.1 | **拆 God Class** 为 §2 病灶① 目标形态 (纯搬迁 + 依赖注入) | vscode-acp |
| 2.2 | **host 侧流式合帧** (16–50 ms) | Kilo Code |
| 2.3 | **composer 移出重建路径** | vscode-acp 模块隔离 |

**验收**: ①拆完后 `extension.js` < 150 行 ②任一模块不同时持有 `pendingPermission` + `acpSessions` ③流式期间 postMessage 频率下降一个量级 (需实测计数) ④输入框节点在整轮流式中 `isSameNode` 恒定。

### 第 3 期 — 升级 (可选)

| 项 | 内容 |
|----|------|
| 3.1 | typed 消息层 (`shared/message-contract.js`) |
| 3.2 | 改用官方 `@agentclientprotocol/sdk` 的 `client()` 替换手写 JSON-RPC (`lib/acp-client.js`) |
| 3.3 | 处理病灶 ⑤ 双后端收敛 与 病灶 ⑥ 时间赌注锁 |

---

## 4. Streaming 焦点丢失 — 根因分析 (主 agent 产出, 最高价值项)

### 4.1 事件回环 [实测]

```js
// extension.js :208-213
vscode.window.onDidChangeActiveTextEditor(editor => {
  if (editor && editor.document.uri.scheme !== "hermes-diff-preview")
    provider.lastActiveEditor = editor;
  provider.refreshEditorContext();     // → postMessage → webview 重渲染
  provider.ensureEditorIsolation();    // → 可能搬迁 editor 标签 → 夺焦点
})
```

`ensureEditorIsolation` 调用点全集 [实测]: `:213`(activeTextEditor 变化) · `:215`(`onDidChangeTabs`) · `:216`(`onDidChangeTabGroups`) · `:431`(`restoreWorkspaceAgentState`) · `:504`(`newSession`) · `:639`(定义)
`onDidChangeTextEditorSelection` (`:222`) 亦调 `refreshEditorContext()`。

**同源问题**: `refreshEditorContext()` (**高频重渲染路径**) 与 `ensureEditorIsolation()` (**夺焦点路径**) 被焊在同一个 handler 上 —— 这就是病灶 ④ 在 host 侧的对应物。

### 4.2 闭环 [推断·待第 0 期定音]

```
焦点移到 editor
      ↓
onDidChangeActiveTextEditor
      ↓
ensureEditorIsolation() → 判定 misplacedDocument → 搬迁
      ↓
vscode.open(..., { preserveFocus })   ← A7 只给「后台搬迁」传了 true
      ↓
焦点再变 → 再次触发同一 handler → 再评估 isolation
```

**为什么「只在 streaming 时」** [实测支撑]: 插件作者自己的注释 **`:209-210` 逐字承认**:
```js
// Track the last active document across focus changes (the webview
// steals focus when typing, so activeTextEditor goes undefined there).
```
流式期间额外高频触发 `refreshEditorContext()` 与 `postState()` (`:3520`)。**推断**: 非流式每轮踩几次, 流式每轮踩数百次 ⇒ 概率从偶发变常发。**依据**: 事件源数量与触发频率; **实际频率未测**。

### 4.3 与 A7 的关系 [实测]

**A7 修的是同一根因的一个出口, 不是根除。** A7 给后台搬迁路径传了 `preserveFocus:true` (`:668`); 但 `:213` 这条**回环本身未被切断**。⇒ 症状缓解, 未根除。

> **主 agent 自我更正 (三轮诊断史, 必须记录)**: ① 首判 `:634 panel.reveal(...,false)` 为真凶 → 被 gpt-6-luna 推翻 (方向反了, 它夺的是「焦点给 webview」) ② 次判 streaming morph 破坏节点身份 → **本轮实测 6/6 PASS 推翻** ③ 现判事件回环 → 有代码路径支撑, **仍缺运行时日志**。**前两次均为「读代码觉得有道理」而未验证。第 0 期存在的唯一理由就是不让第三次重蹈覆辙。**

---

## 5. 风险与边界

| 风险 | 说明 | 缓解 |
|------|------|------|
| **架构改动收益不确定** | 第 2 期耗 1 周, 若根因是第 1 期就能解决的小问题, 则重构投入产出比差 | **第 0 期定音 + 第 1 期止血先行**; 第 1 期若已消除症状, 第 2 期降为「可选的长期健康度投资」 |
| 照搬 vscode-acp 的附件实现 | 它 README 明写附件功能未完成, 而我们的 B1/B2 更完整 | **照搬范围限定为模块切分 + StreamAdapter**, 排除附件 [实测] |
| God Class 拆分引入回归 | 3,396 行搬迁, 触碰面极大 | 纯搬迁不改逻辑; 每步跑 INVARIANT 测试; 分批提交 |
| 改 upstream 的边界 | `eyan-ai/hermes-agent-vs-code` 是他人仓库 | **改动留在本地 fork** (`D:/Action/hermes-agent-vscode`), 未经授权不 push 上游 |
| 前端上框架 (React) 的诱惑 | Cline/Kilo 都用 React, 看起来「更对」 | **不推荐**: vscode-acp 用原生已证明可行; 上框架是大工程, 且现有 morph 经实测可用。**先做 composer 隔离** |

---

## 6. 未验证事项 (诚实登记)

- [ ] **§4.2 回环是否在真机被触发** — 无运行时日志 (第 0 期解决)
- [ ] 流式期间 `refreshEditorContext`/`ensureEditorIsolation` 实际触发频率 — 未测
- [ ] **CLI 直连通道与 `mockStream` 是否仍被使用** — 未查; 影响病灶 ⑤ 的处理方式 (收敛 vs 删除)
- [ ] `lib/acp-render.js` (20.6 KB) 与媒体侧渲染的分工边界 — 未查
- [ ] `lib/chat-parser.js` 与后端 ACP event 的契约 — 未查
- [ ] `background/host.js` (21.6 KB) 与 `lib/background-client.js` (22.2 KB) 的关系 — 未查
- [ ] `media/styles.css` 50.7 KB 的布局策略 — 未查
- [ ] 26 个 js 文件中约 10 个 `lib/*` 未读
- [ ] vscode-acp 前端如何具体 diff/局部更新 — 其 README 未述, `src/ui/` 未逐文件读 [子代理标注]
- [ ] `@agentclientprotocol/sdk` 是否自带节流 — 文档未述 [推测: 不带]
- [ ] 各 peer 的 star 数 — 部分来自第三方聚合站, 标「未核实」

---

## 7. 外部依据汇总

**模仿对象**
- https://github.com/formulahendry/vscode-acp (Zed 官方推荐, 直接同构) **[主 agent 实测]**
- https://zed.dev/acp/editor/vscode **[主 agent 实测]**
- https://github.com/Kilo-Org/kilocode
- https://github.com/cline/cline
- https://github.com/microsoft/vscode-copilot-chat (已归档)
- https://github.com/continuedev/continue

**官方规范与已知 bug**
- VS Code Webview 指南: https://code.visualstudio.com/api/extension-guides/webview
- 官方 chat 滚动修复指引: microsoft/vscode **#330811**
- 官方 chat 滚动 UX: microsoft/vscode **#274099**
- 官方内置 chat 输入框焦点丢失 (**bug+verified**): microsoft/vscode **#268461**
- Webview UI Toolkit 弃用公告 (2025-01-06 归档)
- ACP 官方: https://agentclientprotocol.com/ · https://github.com/agentclientprotocol/agent-client-protocol

**本插件自身证据**
- 架构现状盘点: `cache/scratch/refactor-research/00-architecture-baseline.md` [实测]
- 缺陷报告 (A2/A6/A7/A8): `D:/Action/hermes-agent-vscode-defects/hermes-agent-vscode-defects-2026-09-28.md`
- 焦点补丁: `D:/Action/hermes-agent-vscode/patches/08-focus-preservation.patch`
- morph 探针: `cache/scratch/morph-probe/probe.js` · `probe2.js` [实测]

---

## 8. 建议的下一步

**第 0 期 (定音) 应立即执行** —— 用户已同意加日志方案。
**在拿到运行时日志之前, 不启动第 2 期架构重构。**
