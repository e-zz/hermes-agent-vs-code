# 同类扩展调研：AI 聊天面板 + agent 后端（重构模仿对象档案）

> 任务：为 `eyanlin.hermes-agent-vscode` 的重构找公开、成熟的「AI 对话面板 + agent 后端」类 VS Code 扩展作为模仿对象。只做调研，不写代码。
> 日期：2026-09-28。调研者：Hermes agent（子代理）。
> 纪律：每条事实标 **[文献]**（附真实 URL）/ **[实测]**（本地亲测）/ **[推断]**（说明依据）/ **[推测]**（弱依据）。没能亲自打开验证的仓库/文件，明说「未验证」。Star 数除非来自第三方聚合站，否则标「未核实」。
> 所有 URL 均为本次真实访问或搜索返回；未访问到的内容不以事实呈现。

---

## 0. 被重构对象（本地基线，用于对照）

**[实测]** 本机安装目录 `C:\Users\zhang\.vscode\extensions\eyanlin.hermes-agent-vscode-0.2.53\`，上游 `https://github.com/eyan-ai/hermes-agent-vs-code`（README 自述，未逐一打开验证上游源）。

| 文件 | 行数 | 角色 |
|---|---|---|
| `extension.js` | 3774 | God Class `HermesSidebarProvider`（约 150 方法），extension host 侧全部逻辑 |
| `media/main.js` | 2225 | 前端单文件，全局状态 + `innerHTML` 全量重建 |
| `media/styles.css` | ~1500 行 / 52KB | 样式 |
| `lib/*.js` | 28 个文件，合计 ~3.7k 行 | 已做的部分拆分（acp-client / acp-render / background-client / chat-parser 等） |
| `background/host.js` | 603 | 后台 ACP host |

**与本任务直接相关的、已在本仓库被确认的缺陷（来自本地 `docs/hermes-agent-vscode-defects-2026-09-28.md`，实测读源）**：

1. **焦点被抢**：后台 `openDocumentTab` / `openDocumentUri` 用 `preserveFocus:false` → 用户正在 webview composer 打字时，后台 `reveal`/`open` 把键盘焦点抢给 editor。本地已有补丁 `patches/08-focus-preservation.patch` 改成 `preserveFocus:true`（仅后台重定位路径）。
2. **滚动跳顶**：`media/main.js` 的 `resize` 处理器首行 `window.scrollTo(0,0)`（与「重算 composer 内边距」职责无关）→ 关闭 editor tab 触发 `panel.reveal` → resize → 聊天跳顶。本地补丁 `patches/06-chat-scroll-no-jump-to-top.patch` 已删该行。
3. **流式渲染**：`media/main.js` 用 `innerHTML` 全量重建，每次渲染都销毁/重建 DOM → 输入框 DOM 身份不保留，是焦点/滚动问题的底层放大器。

> 对照目标：下面每个 peer 重点回答三问 —— ①前端框架/状态管理 ②host↔webview 通信协议与类型层 ③**流式更新时如何保住输入框焦点与 DOM 身份 / 滚动位置**。

---

## 1. 模仿对象总览（档案表）

| 对象 | 仓库 | Star 量级 | 活跃度 | 前端框架 | 状态管理 | host↔webview 通信 | extension host 侧模块切分 | 单文件最大行数 | 与本任务相关度 |
|---|---|---|---|---|---|---|---|---|---|
| **vscode-acp**（Zed 官方推荐） | `formulahendry/vscode-acp` | 未核实 | 活跃（v0.2.0, 2026-02 发布） | **原生 TS + webpack**，无 React（deps 仅 `@agentclientprotocol/sdk` + `marked`） | 未验证（README 未述，[推测] 轻量集中 state） | **ACP JSON-RPC 2.0 over stdio**；webview↔host 走 `postMessage`，有 typed 消息 | `core/ handlers/ ui/ utils/ config/` + `extension.ts`（5 模块，见源码树） | 未核实 | **最高 —— 直接同构**（同为「ACP 客户端 + Hermes Agent 后端」） |
| **Cline** | `cline/cline` | ~64.7k（第三方 fast.io，未核实） | **大改**：已重构为 SDK-first，VS Code 扩展「WIP migrating」 | **React**（`webview-ui/`） | `ExtensionStateContext`（React Context） | **gRPC-over-postMessage** 信封（`src/shared/ExtensionMessage.ts`，`.proto` 定义 state） | `src/core/controller/...` 分层（state / settings / sdk） | 未核实 | 高（状态同步模式可抄） |
| **Kilo Code**（Cline/Roo 继承者） | `Kilo-Org/kilocode` | **27.3k**（GitTrend, 2026-09） | **活跃**（CLI+VS Code+JetBrains+SDK） | **React**（`webview-ui/src/index.tsx`） | `ContextProxy` + `ExtensionStateContext`（DeepWiki 2.9 文档） | **host 中转消息桥 + SSE**；**「coalesce high-frequency stream updates before posting」** | `services/cli-backend/`（server-manager / connection-service / sdk-sse-adapter）、`agent-manager/` 等（kilo.ai 架构页 source map） | 未核实 | 高（**流式合并 = 直接对症**） |
| **vscode-copilot-chat**（官方） | `microsoft/vscode-copilot-chat` | 未核实 | **已归档**（2026-05-20 read-only；移入 `microsoft/vscode` 的 `extensions/copilot`） | **原生 VS Code DOM**（非 React/Lit/Svelte；`package.json` 无 react/lit/preact） | `IChatService` / `ChatModel`（状态持久）/ `ChatWidget`（渲染） | 深度耦合 VS Code 内置 chat API（`enabledApiProposals: interactive, defaultChatParticipant@4...`） | `src/extension/<feature>/vscode-node|vscode|common/` 三层（feature：authentication/completions-core/git/githubMcp...） | 未核实（但已拆到多 feature 子目录） | 中（官方参考但**无法直接复用**，依赖未公开的 chat API） |
| **Continue** | `continuedev/continue` | ~33.8k（marketplace 徽章，未核实） | **只读**（「no longer actively maintained」，final 2.0.0） | **React + Redux**（本机 `gui/assets/index.js` 3.9MB，实测含 `createContext`/`useState`/redux） | Redux store | `ContinueGUIWebviewViewProvider`（React GUI 嵌入 webview，双向 postMessage） | `extensions/vscode/src/`（adapter 层）+ 独立 `core/`（跨平台业务逻辑） | 未核实 | 中（**host 侧也用了 `preserveFocus:false`**，证明该坑不是 hermes 独有） |
| **Roo Code** | `RooCodeInc/Roo-Code` | 未核实 | **已停**（README：「shut down on May 15th」；社区 fork `Zoo-Code`） | React（Cline 系） | `ExtensionStateContext` | 同 Cline 系 | 同 Cline 系 | 未核实 | 低（停更，**仅 Cline/Kilo 的祖先后代链参考**） |
| **ACP 官方 TS SDK** | `agentclientprotocol/agent-client-protocol` | 未核实 | 活跃（v1.5.0） | 库（非 UI） | — | **JSON-RPC 2.0 over stdio**；流式 `session/update` 通知 | —（库） | — | **最高 —— 类型层/流式契约权威** |

---

## 2. 各对象详细档案

### 2.1 `formulahendry/vscode-acp` —— **首选模仿对象（直接同构）**

- 仓库：https://github.com/formulahendry/vscode-acp **[文献]**
- **Zed 官方 VS Code ACP 客户端页直接指向它**：https://zed.dev/acp/editor/vscode （「View Documentation → github.com/formulahendry/vscode-acp」）**[文献]**
- 功能（README 自述）：11 个预置 agent（含 **Hermes Agent `hermes acp`**）、per-agent 会话树、session config options 动态渲染、Markdown 渲染、thinking 折叠块带流式动画、slash 命令自动补全、协议流量日志（可看所有 ACP JSON-RPC request/response/notification）**[文献]**
- **依赖（package.json 实测读源）**：`@agentclientprotocol/sdk@^0.21.1`、`marked@^15`、`@vscode/extension-telemetry`；dev 依赖 webpack + TypeScript。**无 React/Svelte/Solid/Lit** ⇒ 前端是**原生 TS + 手写 DOM**，用 `marked` 渲染 Markdown **[实测·文献：README+package.json]**
- **extension host 侧模块切分（README「Architecture」节 + 源码树实测读源）**：
  ```
  src/
    core/      → AgentManager, ConnectionManager, SessionManager, AcpClientImpl
    handlers/  → FileSystemHandler, TerminalHandler, PermissionHandler, SessionUpdateHandler
    ui/        → SessionTreeProvider, ChatWebviewProvider, StatusBarManager
    config/    → AgentConfig, RegistryClient
    utils/     → Logger, StreamAdapter
    extension.ts
  ```
  **[文献]** —— **注意 `utils/StreamAdapter`**：专门一个模块处理流式更新，这是对症「流式渲染」的模块级隔离。
- **通信**：与 agent 用 ACP（JSON-RPC 2.0 over stdio）；webview↔host 用 `postMessage` **[文献：README「ACP protocol (JSON-RPC 2.0 over stdio)」+「ChatWebviewProvider」]**
- **未验证**：前端具体如何 diff/局部更新（README 未述，源码 `src/ui/` 未逐文件读）；star 数未核实。
- **与本任务对照**：它和 hermes 扩展是**同一问题域**（ACP 客户端 + 聊天 webview + Hermes 后端），但把「God Class」拆成了 5 个模块（core/handlers/ui/config/utils）。**这是「拆 extension.js」最直接的范本。**

> **[推断]** 由于 vscode-acp 用原生 DOM（非 React），它对「保住输入框焦点」的解法大概率是**保守的局部更新 + 稳定的 composer DOM 节点**，而不是框架 diff。这正好对应 hermes 现有 `media/main.js` 的「原生 + 全量重建」路线 —— 区别在于 vscode-acp 把渲染收敛到 `ChatWebviewProvider`/`SessionUpdateHandler`/`StreamAdapter` 几个模块，而不是散在一个 2225 行文件里。**依据**：其模块切分（上）+ 无 React 依赖（package.json）+ 流式能力（README 述「collapsible block with streaming animation」）。

### 2.2 `cline/cline` —— 状态同步 + 类型层范本（注意大改）

- 仓库：https://github.com/cline/cline **[文献]**
- **重要现状（README 实测读源）**：Cline 已重构为 **SDK-first**（`@cline/sdk`），提供 CLI/桌面/VS Code/JetBrains 多形态；**VS Code 扩展标注「WIP migrating」**（正在迁移中）。⇒ **不要直接照抄 Cline 当前 VS Code 扩展代码**，它在动 **[文献：README Index 表]**
- **前端框架**：React（`webview-ui/src/...`）**[文献：.clinerules + DeepWiki]**
- **状态管理**：`webview-ui/src/context/ExtensionStateContext.tsx` —— React Context 包裹一份「comprehensive state payload」`ExtensionMessage` 在 host↔webview 间同步 **[文献：DeepWiki 2.4 指向的源文件路径]**
- **通信协议**：**gRPC-over-postMessage** —— webview 发「对象」（gRPC envelope），host 回「对象」；`request_id` 做 correlation；状态广播走 `.proto` 定义的专用流式订阅（`apps/vscode/proto/cline/state.proto`）**[文献：DeepWiki 2.4，含 `src/shared/ExtensionMessage.ts` 的 `ExtensionMessage`/`GrpcResponse` 接口片段]**
  - 接口形态（DeepWiki 引源）：
    ```ts
    export interface ExtensionMessage { type: "grpc_response"; grpc_response?: GrpcResponse }
    export type GrpcResponse = { message?: any; request_id: string; error?: string; is_streaming?: boolean; sequence_number?: number }
    ```
    ⇒ **有 `is_streaming` 与 `sequence_number` 字段**，显式区分流式增量 **[文献]**
- **extension host 侧切分**：`src/core/controller/state/`（`getStateToPostToWebview.ts` / `updateSettings.ts`）、`src/sdk/`（`sdk-followup-coordinator.ts` / `message-translator.ts`）、`src/shared/`（`ExtensionMessage.ts` / `state-keys.ts`）—— **shared/ 目录放「host 与 webview 共用的类型定义」** **[文献：DeepWiki 2.4 源文件清单]**
- **已知 issue**：`cline/cline#617`「Chat input seemingly does not trigger inputFocus」（输入框焦点相关 bug）**[文献：搜索返回]** —— 证明即便 React 项目也踩过焦点坑。
- **未验证**：star 数（~64.7k 来自第三方 fast.io，未核实）；`webview-ui` 内组件级渲染策略未逐文件读。
- **可抄**：`shared/` 类型层 + `ExtensionMessage` 信封（带 `is_streaming`/`sequence_number`）+ `ExtensionStateContext` 中央状态。**这正是 hermes `media/main.js`「无类型层、无中央 state」缺的两样。**

### 2.3 `Kilo-Org/kilocode` —— **流式合并（coalesce）的对症范本**

- 仓库：https://github.com/Kilo-Org/kilocode **[文献]**
- Star：**27.3k**（GitTrend 2026-09 数据，第三方，未核实原始值）**[文献]**
- **活跃度**：高 —— CLI + `kilo serve` server + VS Code + JetBrains + SDK；是 **Cline/Roo 的活跃继承者**（morphllm 对比页称「Kilo Code combined Roo Code and Cline features」）**[文献]**
- **前端**：React（`webview-ui/src/index.tsx` → `dist/webview.js`）**[文献：kilo.ai 架构页 Builds 表]**
- **状态管理**：**`ContextProxy` 抽象层 + `ExtensionStateContext` React Context**，跨 extension host / webview / cloud 同步 **[文献：DeepWiki 2.9「State Management and Persistence」标题 + 摘要]**
- **通信（最关键的一段，架构页实测读源）**：
  ```
  webview vscode.postMessage() -> KiloProvider host handler -> generated SDK HTTP request
    -> CLI runtime -> /global/event SSE -> SdkSSEAdapter -> KiloConnectionService subscribers
    -> KiloProvider directory/session filtering and STREAM COALESCING -> webview postMessage()
  ```
  原文：「**Providers resolve session scope, maintain message-to-session lookup ... and coalesce high-frequency stream updates before posting UI messages**」 **[文献：https://kilo.ai/docs/contributing/architecture/vscode-extension]**
  ⇒ **Kilo 在 host 侧就做了「高频流式更新的合并/降频」，再 postMessage 给 webview。** 这是「流式渲染跳顶/抖屏」的**上游解法**：问题不在前端 diff，而在**消息频率**。
- **extension host 侧切分（source map 实测读源）**：`services/cli-backend/server-manager.ts` / `connection-service.ts` / `sdk-sse-adapter.ts`、`agent-manager/`、`esbuild.js` 多入口（sidebar / agent-manager / kiloclaw / diff-viewer / diff-virtual / shiki-worker）—— **每个 webview 面一个 build entry**，不挤一个 bundle **[文献]**
- **未验证**：`ContextProxy` 内部实现细节；前端 React 组件是否用 key 稳定 DOM。
- **可抄**：**「host 侧 coalesce 流式更新」** —— 这是 hermes 当前完全没有的一层。加上它，前端即使全量重建，频率也降下来了。

### 2.4 `microsoft/vscode-copilot-chat` —— 官方参考（但已归档，复用价值有限）

- 仓库：https://github.com/microsoft/vscode-copilot-chat **[文献]**
- **现状（README + package.json 实测读源）**：**已归档，read-only**（「archived on May 20, 2026」/「This project has been moved into the main VS Code repository」）。活跃开发在 `microsoft/vscode` 的 `extensions/copilot` **[文献：README + package.json 归档 banner]**
- **前端框架（推断，有证据）**：`package.json` 依赖里**无 react / lit / preact / svelte / solid**（全文 grep 实测）；DeepWiki 架构页描述其核心为 **`IChatService`（会话协调）/ `ChatModel`（状态持久）/ `ChatWidget`（渲染复杂多段 AI 响应）** ⇒ **原生 VS Code DOM + 自研渲染组件**，**不依赖任何 UI 框架** **[文献：DeepWiki microsoft/vscode/7.1「Chat Service and Widget」+ package.json 实测]**
- **架构**：深度耦合 VS Code 内置 chat API —— `enabledApiProposals` 含 `interactive`、`defaultChatParticipant@4`、`chatProvider@4`、`agentSessionsWorkspace` 等 **40+ 内部 API proposal** ⇒ **普通扩展无法复用**（这些是 VS Code 内部/私有 API）**[文献：package.json 实测读源]**
- **extension host 侧切分**：`src/extension/<feature>/vscode-node | vscode | common/` 三层，feature 维度拆（authentication / chatSessionContext / completions-core / contextKeys / extension / git / githubMcp ...）**[文献：DeepWiki 2-extension-architecture 源文件清单]**
- **对本任务的价值**：**不是「抄代码」对象**（依赖私有 API），而是「**官方怎么拆 feature**」的范本 —— 按 feature 子目录 + platform 三层（common/vscode/vscode-node）切分。hermes 的 `lib/` 已经部分这样做，可以对齐这个命名/分层习惯。
- **未验证**：`ChatWidget` 内部如何 diff 流式 token（DeepWiki 页面是动态加载，未抓到正文）。

### 2.5 `continuedev/continue` —— 只读，但本地可实测

- 仓库：https://github.com/continuedev/continue **[文献]**
- **现状（README 实测读源）**：「**no longer actively maintained and is read-only**」，做了 final 2.0.0（VS Code + CLI + JetBrains）⇒ **参考其架构，不追其更新** **[文献]**
- **前端框架（本机实测）**：本机 `C:\Users\zhang\.vscode\extensions\continue.continue-2.0.0-win32-x64\gui\assets\index.js`（3.9MB 主 bundle）grep 命中 `createContext`(19) / `useState`(8) / `redux`(6) ⇒ **React + Redux** **[实测]**
- **通信**：`extensions/vscode/src/ContinueGUIWebviewViewProvider.ts` —— React GUI 嵌入 webview，双向 postMessage **[文献：搜索返回的源文件路径]**
- **切分**：`extensions/vscode/`（adapter 层）+ 独立 `core/`（跨平台业务逻辑）+ `gui/`（React 前端）—— **前后端 + 核心 三仓分离** **[文献：DeepWiki 1.1 源文件清单]**
- **关键发现（本机实测，直接对症本任务）**：`out/extension.js` 里**也有 `preserveFocus:false`（2 处）**：
  ```
  out/extension.js:845220:  preserveFocus: false
  out/extension.js:845229:  preserveFocus: false
  ```
  ⇒ **「后台 open 用 preserveFocus:false 抢焦点」这个坑，Continue（成熟 React 项目）extension host 侧也存在**。**这证明该 bug 不是 hermes 代码风格问题，而是 VS Code `openDocument`/`reveal` 默认行为的共性陷阱** —— 任何「后台重定位/打开 tab」都要显式 `preserveFocus:true`。**[实测]**
- **可抄**：前后端 + core 三仓分离；Redux 中央 store（若 hermes 前端想上框架，Redux 是 Continue 验证过的选型）。
- **未验证**：Redux store 如何接收流式 token、是否做节流。

### 2.6 ACP 官方（Zed）—— **类型层 + 流式契约的权威**

- 协议文档：https://agentclientprotocol.com **[文献]**
- **通信模型（实测读源）**：JSON-RPC 2.0，两类消息 —— **Methods**（request-response）与 **Notifications**（单向）。典型流程：
  ```
  initialize → (authenticate) → session/new 或 session/load → session/prompt
  → Agent 发 session/update 通知（流式增量）→ session/cancel（可中断）→ prompt response + stop reason
  ```
  **[文献：https://agentclientprotocol.com/protocol/v1/overview]**
- **流式增量载体（关键）**：`session/update` 通知包含 **Message chunks (agent/user/thought) / Tool calls / Plans / Slash-commands / Mode changes** ⇒ **ACP 原生就把「流式」建模成细粒度 notification，客户端必须自己聚合** **[文献：同上]**
- **官方 TS SDK**：`@agentclientprotocol/sdk`（npm），**新版用 fluent `client()` / `agent()` API 注册 typed handlers**；旧 `AgentSideConnection`/`ClientSideConnection` 已废弃 **[文献：https://agentclientprotocol.com/libraries/typescript]**
  - 仓库：https://github.com/agentclientprotocol/agent-client-protocol **[文献]**
  - **生产级参考实现（agent 侧）**：Gemini CLI `packages/cli/src/acp` **[文献：SDK 页「Users」]**
  - **VS Code 侧参考**：`formulahendry/vscode-acp`（见 2.1）+ PoC `sotayamashita/agent-client-protocol-vscode`（ESM + `@zed-industries/agent-client-protocol/typescript/acp.ts` 打包）**[文献：搜索返回]**
- **官方 agent 清单（含 Hermes）**：https://agentclientprotocol.com/get-started/agents —— **Hermes Agent** 在列（`hermes acp`）**[文献]**
- **对本任务的价值**：hermes 后端 `acp_adapter/` 已是 agent 侧；**前端/客户端侧应改用 `@agentclientprotocol/sdk` 的 `client()`** 而不是手写 JSON-RPC 解析（hermes 现 `lib/acp-client.js` 是自写的）。SDK 提供 **typed handlers + `session/update` 的标准聚合点**，正好承载「coalesce + 局部更新」。
- **未验证**：SDK 是否自带节流/合并（文档未述，[推测] 不 —— 合并逻辑通常在客户端 handler 层，如 vscode-acp 的 `StreamAdapter`）。

### 2.7 Roo Code（停更，仅谱系参考）

- 仓库：https://github.com/RooCodeInc/Roo-Code **[文献]**
- **现状（README 实测读源）**：「**The Roo Code Extension was shut down on May 15th**」；社区 fork `Zoo-Code-Org/Zoo-Code`；Cline 是其源头 **[文献]**
- 价值：**Cline → Roo → Kilo 谱系链** 的证据点。架构同 Cline（React + `ExtensionStateContext`）。**不单独深究**，因为 Kilo 是其活跃继承者且文档更全（见 2.3）。

---

## 3. 专题：流式更新时「保住输入框焦点 + DOM 身份 + 滚动位置」

> 这是本任务最核心的调研点。结论先给，证据后列。

### 3.1 问题拆解（本扩展实测的三症状 → 三个独立根因）

| 症状 | 根因（本地实测） | 对应 peer 解法 |
|---|---|---|
| 打字时焦点被 editor 抢走 | 后台 `openDocumentTab`/`openDocumentUri` 用 `preserveFocus:false` | **host 侧显式 `preserveFocus:true`**（Continue 也踩过，见 2.5 实测） |
| 关闭 tab 聊天跳顶 | `resize` 处理器首行 `window.scrollTo(0,0)`（与职责无关） | **删掉无关 scroll；滚动只在「用户贴底」时跟随**（vscode #274099/#330811） |
| 流式时抖屏/丢 DOM 身份 | `media/main.js` `innerHTML` 全量重建 | **①host 侧 coalesce 降频**（Kilo，见 2.3）**②框架/稳定 key diff**（Cline/Kilo React）**③composer 独立于消息流渲染**（推断，见 3.3） |

### 3.2 peer 如何解决（证据）

**A. 「后台操作别抢焦点」—— host 侧 `preserveFocus:true`**
- **Continue（成熟 React 项目）extension host 也有 `preserveFocus:false`（2 处）**，证明这是 VS Code 默认陷阱，不是代码风格问题。**[实测·本机 `out/extension.js`]**
- hermes 本地补丁 `patches/08-focus-preservation.patch` 的方向**正确且必要**（后台重定位路径改 `preserveFocus:true`）。**[实测·本地补丁]**
- **[推断]** 通用规则：**任何「非用户点击触发」的 `executeCommand('vscode.open')` / `tabGroups` / `panel.reveal` 都必须传 `preserveFocus:true`**；只有用户显式点击的 open 才用默认。依据：VS Code `open` 命令默认抢焦点（行为常识）+ Continue 反例 + hermes 补丁注释（「Background relocation ... must not steal keyboard focus」）。

**B. 「滚动只跟随用户贴底，流式要 batch + 平滑」—— 官方 issue 已定调**
- **microsoft/vscode #330811「Chat: add a per-chat auto-scroll mode」**（Open，2026-08）**[文献]** 原文建议：
  > 「When **Follow latest** is enabled, scrolling should be **smooth and coalesced rather than jumping instantly for every streamed line or token**. **Batch streaming updates before adjusting the scroll position.** Animate the resulting movement smoothly instead of issuing a scroll jump for each output update. ... Add a **Reading mode**: ... Do not scroll further while the response continues streaming. ... Keep a **Jump to latest** action available.」
  ⇒ 官方方向 = **①batch 流式更新 ②平滑动画（尊重 reduced-motion）③用户滚动离开底部就停止跟随 ④Jump-to-latest 按钮**。
- **microsoft/vscode #274099「Chat scrolling behavior should be improved」**（Open，bug/ux 标签，assignee roblourens/justschen = 核心 VS Code 聊天作者）**[文献]** —— 证实**连官方 chat 的滚动行为都有未修的 UX 问题**，说明这是**共性硬骨头**，不是 hermes 独有。
- **shadcn/ui「Message Scroller」**组件：「anchors turns ... **follows streamed responses, loads history without jumping**」—— 社区已有成熟组件化方案（按 turn 锚定）**[文献：搜索返回]**。
- **[推断]** hermes 应实现「**用户是否贴底**」检测（scroll 到距底部 N px 内才算贴底），流式只在贴底时 `scrollToBottom`，否则不动；并把 `window.scrollTo(0,0)` 这类「无条件归零」彻底移除。依据：#330811 官方建议 + hermes 本地 A6 补丁（删 scrollTo(0,0) 后用户实测确认「now it stays」）。

**C. 「保 DOM 身份」—— 框架 diff 或稳定 key，且 composer 独立于消息流**
- **Cline / Kilo 用 React** ⇒ React reconciliation 按 **`key` 保 DOM 身份**；只要 composer 组件是稳定的、不在每次消息更新时被替换，焦点自然保留。**[文献：Cline/Kilo 前端为 React + React 文档「input losing focus when rerendering」SO 问题]**
- **React 焦点坑的根因（社区共识）**：整棵 form 被重渲染 / 组件 key 变化导致 input 被卸载重建 ⇒ 丢焦点。**解法 = 稳定 key + 把 input 从频繁变化的父节点中隔离**。**[文献：stackoverflow.com/questions/22573494 + 42573017，搜索返回]**
- **vscode-acp 用原生 DOM** ⇒ 它**必须**手工保证 composer 节点不被重建（否则更糟）。其 `utils/StreamAdapter` + `SessionUpdateHandler` 把流式更新收敛到**消息列表**，**不动 composer**。**[推断·README 模块切分]**
- **[推断·关键设计原则]** **composer（输入框）应是一个独立的、长生命周期的 DOM 节点/组件，绝不在「渲染一条新消息」的路径上被触碰**。消息流只更新「消息列表容器」，composer 永远在。这是 React（Cline/Kilo）和原生（vscode-acp）**殊途同归**的共同点。依据：React key 隔离原理（SO）+ vscode-acp 模块切分（README）+ hermes 现有结构里 composer 与消息流混在 `media/main.js` 同一渲染路径（实测读源）。

### 3.3 有没有「公开谈这个坑」的 issue/讨论/博客（清单）

| 来源 | 讲了什么 | 类型 | URL |
|---|---|---|---|
| microsoft/vscode #330811 | 官方 chat 流式滚动 UX：batch + 平滑 + reading mode + jump-to-latest | issue（官方建议） | https://github.com/microsoft/vscode/issues/330811 |
| microsoft/vscode #274099 | 官方 chat 滚动行为 bug（新消息滚到顶部/自动滚动停止） | issue（bug，核心作者认领） | https://github.com/microsoft/vscode/issues/274099 |
| cline/cline #617 | chat input 焦点/`inputFocus` 触发异常 | issue | https://github.com/cline/cline/issues/617 |
| StackOverflow 22573494 / 42573017 | React input 重渲染丢焦点的根因 + 解法 | 问答 | https://stackoverflow.com/questions/22573494 、 /42573017 |
| shadcn/ui Message Scroller | 社区组件：按 turn 锚定、流式跟随、历史加载不跳 | 组件文档 | https://ui.shadcn.com/docs/components/base/message-scroller |
| Obsidian Copilot #3328 | 「点击 agent chat 输入框会把焦点还回编辑器」（软换行边界）—— 同类「焦点回流」坑 | issue | https://github.com/logancyang/obsidian-copilot/issues/3328 |

> **[推断]** 没有一篇「VS Code webview 流式保焦点」的**权威博客**统一讲透；最接近权威的是 **vscode 官方 #330811 的建议 + React SO 的 key 隔离原理** 两条拼起来。这就是本扩展该走的两条腿：**host 侧 preserveFocus + 流式 batch/coalesce + 平滑跟随**，**前端 composer 独立 + 稳定 key**。

---

## 4. 「我们该抄什么」—— 具体结论（每条带证据）

> 按「改动收益 / 工作量」排序。`[证据]` 列给可核验出处。

| # | 结论 | 抄谁 | 具体做法 | 证据 |
|---|---|---|---|---|
| **C1** | **extension host 侧按职责拆模块**（治 God Class） | **vscode-acp** | 把 `extension.js`（3774 行 God Class）拆成 `core/`（AgentManager/ConnectionManager/SessionManager/AcpClientImpl）+ `handlers/`（FileSystem/Terminal/Permission/SessionUpdate）+ `ui/`（SessionTreeProvider/ChatWebviewProvider/StatusBar）+ `config/` + `utils/`（**StreamAdapter**）。hermes 已有 `lib/`，对齐此 5 目录命名即可。 | [文献] vscode-acp README「Architecture」+ 源码树 |
| **C2** | **host↔webview 加 typed 消息层**（治无契约） | **Cline** | 建 `shared/`（或 `common/`）目录放 host 与 webview 共用的消息类型；用信封格式 `{ type, request_id, is_streaming?, sequence_number? }`；webview 侧 `request_id` 做 correlation。 | [文献] Cline `src/shared/ExtensionMessage.ts`（DeepWiki 2.4 引源） |
| **C3** | **流式更新在 host 侧 coalesce 降频**（治抖屏/丢焦点的上游根因） | **Kilo Code** | 在 ACP `session/update` 到达 host 后，**合并高频增量**（如 16–50ms 窗口）再 `postMessage` 给 webview；不要每个 token 都 post。 | [文献] kilo.ai 架构页「coalesce high-frequency stream updates before posting UI messages」 |
| **C4** | **改用官方 `@agentclientprotocol/sdk` 的 `client()`**（治手写 JSON-RPC） | **ACP 官方** | 把 `lib/acp-client.js` 的自写解析换成 `@agentclientprotocol/sdk` 的 fluent `client()`，得到 typed handlers + 标准 `session/update` 聚合点。 | [文献] agentclientprotocol.com/libraries/typescript + github.com/agentclientprotocol/agent-client-protocol |
| **C5** | **后台操作一律 `preserveFocus:true`**（治焦点被抢，**最对症、最低成本**） | **Continue（反例）+ hermes 自身补丁** | 任何「非用户点击」触发的 `vscode.open`/`tabGroups`/`panel.reveal` 都传 `preserveFocus:true`；仅用户显式点击用默认。 | [实测] Continue `out/extension.js` 有 `preserveFocus:false`；[文献] hermes `patches/08-focus-preservation.patch` |
| **C6** | **滚动「只跟随用户贴底 + batch + 平滑」，删掉无条件归零**（治跳顶） | **vscode 官方 issue** | 删 `window.scrollTo(0,0)`；实现「贴底检测」，流式只在贴底时 `scrollToBottom`；加 Jump-to-latest；尊重 reduced-motion；提供 reading mode（用户滚走就停）。 | [文献] microsoft/vscode #330811 + #274099 |
| **C7** | **composer 独立长生命周期节点，绝不进消息流渲染路径**（治 DOM 身份丢失） | **Cline/Kilo（React key）+ vscode-acp（模块隔离）** | 若前端继续用原生 DOM：把 composer 从「每次 innerHTML 重建」的路径里摘出来，单独建一次、长期持有；消息流只更新「消息列表容器」。若上 React：composer 用稳定 `key` 隔离。 | [推断] React SO key 隔离原理 + vscode-acp 模块切分 + hermes `media/main.js` 实测 |
| **C8** | **前端框架选型：默认继续原生（低风险），想上就 React（生态成熟）** | **vscode-acp（原生）/ Cline+Kilo+Continue（React）** | 两条路都验证过。**原生**：必须配合 C7（composer 隔离）+ C6（滚动跟随）。**React**：用 `ExtensionStateContext`（Cline/Kilo）或 Redux（Continue）做中央 state，diff 自动保焦点。**最小改动 = 维持原生 + 做 C5–C7；最大收益 = 上 React + C2–C3。** | [文献] 各 peer 框架选择；[推断] 选型建议 |
| **C9** | **feature 分层命名对齐官方**（可选，长期） | **vscode-copilot-chat** | 按 `<feature>/common|vscode|vscode-node` 三层组织 `src/`；hermes 的 `lib/` 可渐进迁移到此约定。 | [文献] DeepWiki microsoft/vscode-copilot-chat/2-extension-architecture |
| **C10** | **别抄 copilot-chat 的代码**（依赖 40+ 私有 API proposal，普通扩展用不了） | —（规避项） | copilot-chat 仅作「官方怎么拆 feature」的命名参考，**不作代码移植对象**。 | [实测] package.json `enabledApiProposals` 40+ 私有 API |

### 推荐的「最小 → 完整」重构路径

1. **第一步（止血，1–2 天，不动架构）**：落 C5（`preserveFocus:true`，本地补丁已有方向）+ C6（删 `scrollTo(0,0)` + 贴底跟随）。这两个**不依赖前端重写**，直接消除用户报的「焦点被抢 / 跳顶」两大症状。**证据**：C5/C6 出处；hermes 本地补丁已验证用户实测确认。
2. **第二步（治本，1 周量级）**：落 C1（拆 God Class 成 5 目录）+ C3（host 侧 coalesce）+ C7（composer 独立节点）。**证据**：C1 抄 vscode-acp、C3 抄 Kilo、C7 是两者共同原则。
3. **第三步（可选升级）**：落 C2 + C4（typed 消息层 + 官方 ACP SDK）；C8 若决定上 React 再做 Cline/Kilo 式 `ExtensionStateContext`。**证据**：C2 抄 Cline、C4 抄 ACP 官方。

> **[推断·总体判断]** 本扩展的**架构病根**不是「没选框架」，而是**①host 侧 God Class ②前端无类型契约 ③流式更新无降频 ④composer 与消息流耦合**。**vscode-acp 是最佳整体范本**（同域、已拆好、原生路线可低风险迁移）；**Cline/Kilo 补「状态同步 + 流式合并」两块**；**vscode 官方 issue 补「滚动/焦点」两条铁律**。copilot-chat 因依赖私有 API，**只取命名分层，不取代码**。

---

## 5. 未验证 / 待人工确认清单（诚实边界）

| 项 | 状态 | 说明 |
|---|---|---|
| vscode-acp 前端如何具体 diff/局部更新 | **未验证** | README 未述；`src/ui/` 未逐文件读。[推断] 保守局部更新 + composer 稳定节点。 |
| vscode-acp / cline / kilocode 的 star 数 | **部分未核实** | Kilo 27.3k（GitTrend 第三方）、Continue ~33.8k（marketplace 徽章）、Cline ~64.7k（fast.io 第三方）均非 GitHub 一手，标注「未核实」。 |
| copilot-chat `ChatWidget` 内部流式 diff 机制 | **未验证** | DeepWiki 页动态加载未抓到正文；[推断] 原生 DOM 增量更新。 |
| `@agentclientprotocol/sdk` 是否自带节流/合并 | **未验证** | 文档未述；[推测] 不带，合并逻辑在客户端 handler 层（vscode-acp `StreamAdapter`）。 |
| Cline 当前「WIP migrating」的 VS Code 扩展最新代码 | **未验证** | 迁移中，结构可能变；本报告基于 DeepWiki 快照（`apps/vscode/...`）。 |
| hermes 上游仓库 `eyan-ai/hermes-agent-vs-code` 源 | **未逐一打开验证** | 本机安装版 + 本地补丁/缺陷报告为实测基线；上游源未单独核对。 |
| Roo Code 停更后 `Zoo-Code` 是否值得另做范本 | **未评估** | 本次未深究 Zoo-Code；Kilo 已是更活跃继承者。 |

---

## 6. 参考链接汇总（全部为本次真实访问/搜索返回）

**模仿对象仓库**
- https://github.com/formulahendry/vscode-acp （Zed 官方推荐，直接同构）
- https://github.com/cline/cline （SDK-first，React + gRPC-over-postMessage + ExtensionStateContext）
- https://github.com/Kilo-Org/kilocode （活跃继承者，SSE + stream coalescing + ContextProxy）
- https://github.com/microsoft/vscode-copilot-chat （已归档，官方参考）
- https://github.com/continuedev/continue （只读，React + Redux，本机可实测）
- https://github.com/RooCodeInc/Roo-Code （停更，谱系参考）
- https://github.com/agentclientprotocol/agent-client-protocol （官方 TS SDK）
- https://github.com/sotayamashita/agent-client-protocol-vscode （ACP VS Code PoC，ESM）

**ACP 文档**
- https://agentclientprotocol.com/protocol/v1/overview （通信模型 + 流式 session/update）
- https://agentclientprotocol.com/libraries/typescript （`client()`/`agent()` fluent API）
- https://agentclientprotocol.com/get-started/agents （agent 清单，含 Hermes）
- https://zed.dev/acp/editor/vscode （Zed 官方 VS Code ACP 客户端页 → vscode-acp）

**焦点/滚动/流式专题**
- https://github.com/microsoft/vscode/issues/330811 （官方 chat 流式滚动建议：batch + 平滑 + reading mode）
- https://github.com/microsoft/vscode/issues/274099 （官方 chat 滚动行为 bug）
- https://github.com/cline/cline/issues/617 （Cline 输入框焦点 issue）
- https://stackoverflow.com/questions/22573494 、 https://stackoverflow.com/questions/42573017 （React 重渲染丢焦点）
- https://ui.shadcn.com/docs/components/base/message-scroller （社区消息滚动组件）
- https://github.com/logancyang/obsidian-copilot/issues/3328 （同类焦点回流坑）

**架构文档**
- https://kilo.ai/docs/contributing/architecture/vscode-extension （Kilo host 消息桥 + SSE + coalesce + source map）
- https://deepwiki.com/cline/cline/2.4-webviewprovider （Cline gRPC-over-postMessage + ExtensionMessage 信封）
- https://deepwiki.com/microsoft/vscode-copilot-chat/2-extension-architecture （copilot-chat feature 分层）
- https://deepwiki.com/microsoft/vscode/7.1-chat-service-and-widget （VS Code 官方 IChatService/ChatModel/ChatWidget）

**本地实测基线**
- `C:\Users\zhang\.vscode\extensions\eyanlin.hermes-agent-vscode-0.2.53\` （extension.js 3774 / media/main.js 2225 / docs 缺陷报告 / patches 06+08）
- `C:\Users\zhang\.vscode\extensions\continue.continue-2.0.0-win32-x64\` （React+Redux GUI bundle + out/extension.js preserveFocus 实测）
