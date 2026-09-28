# 插件架构现状盘点 (Step 1 · 实测)

对象: `C:/Users/zhang/.vscode/extensions/eyanlin.hermes-agent-vscode-0.2.53/`
来源: https://github.com/eyan-ai/hermes-agent-vs-code
HEAD: `89d88cc` (含本轮 A2/A6/A7 修复)

**证据分级**: [实测] = 本轮直接读码/统计得出; [推断] = 由实测推论, 说明依据; [推测] = 机制猜测未验证。

---

## 1. 规模与文件分布 [实测]

```
extension.js     152.3 KB   3774 行
media/main.js     98.3 KB   2225 行
media/styles.css  50.7 KB    506 行
lib/background-client.js  22.2 KB
background/host.js        21.6 KB
lib/acp-render.js         20.6 KB
lib/diff-preview.js       15.3 KB
lib/node-runtime.js        9.4 KB
lib/chat-parser.js         8.5 KB
lib/hermes-sessions.js     8.4 KB
lib/acp-client.js          8.1 KB
(其余 lib/* 与 media/* 均 <7 KB)
```

**js 文件数 26, js 总行数 10779。**
**`extension.js` + `media/main.js` = 5,999 行, 占总行数约 56%。**

---

## 2. 核心病灶: 一个 3,396 行的 God Class [实测]

```js
class HermesSidebarProvider {   // :240
  ...
}                               // :3635
```

- **跨度 3,396 行, 占 `extension.js` 的 90%**
- **约 150 个方法**
- 全文件仅此一个 class (`grep '^\s*class'` = 1 命中); 其余为 16 个顶层小工具函数 (`resolveHermesHome`/`hermesSkills`/`buildInvocationArgs` 等)

### 2.1 职责混装清单 (按代码位置分组) [实测]

| # | 职责域 | 代码位置 | 方法数 |
|---|--------|----------|--------|
| 1 | Webview 生命周期 + 消息路由 | `:295`, `:381`, `:695` (`onMessage` 122 行 switch), `:3609` `html()` | ~6 |
| 2 | 会话 CRUD + 持久化 | `:393-509`, `:817`, `:933`, `:1292`, `:3646` | ~14 |
| 3 | **编辑器列/标签搬迁** | `:509-694` | **11** |
| 4 | 附件 / 文档打开 | `:984-1097`, `:3215` | ~8 |
| 5 | 模型 / 设置 | `:828-931`, `:1950` | ~6 |
| 6 | 队列 / steering | `:1112-1150`, `:1454-1541` | ~6 |
| 7 | ACP 传输与生命周期 | `:1192-1290`, `:1599-2170`, `:2616-2839`, `:3329-3448` | ~40 |
| 8 | **权限审批 + diff 预览** | `:2170-3233` | **~38 (1,063 行)** |
| 9 | CLI 直连 (第二套后端) + mock | `:3299-3497`, `:3367` `handleCliEvent` | ~7 |

### 2.2 关键观察 [实测 → 推断]

**观察 A [实测]**: 存在**两套后端通道** — ACP 全链路 (`ensureAcp`/`startAcpClient`/`runAcp`, 约 40 个方法) 与 CLI 直连 (`runCli`/`handleCliEvent`/`createCliTurn`/`finishCliTurn`/`terminateProcess`), 外加 `mockStream` (`:3299`)。
**推断**: 三者未收敛到统一抽象 ⇒ 同一语义 (一轮对话的生命周期) 有三份实现, 行为不一致风险结构性存在。依据: 两套各自维护独立状态 (`cliTurns`/`cliClient` vs `acp`/`acpSessions`/`activeTurns`), 无共享接口。

**观察 B [实测]**: 权限审批 + diff 预览占 1,063 行、约 38 个方法, 是**单块最大**职责, 且深度耦合 `pendingPermission` 单例状态。
**推断**: 这是最该优先独立成模块的部位 — 它同时持有 UI 状态 (`docDiffDecorations`/`diffPreviewDocuments`/`_diffPreviewProvider`)、生命周期 (过期/取消/提醒定时器)、与 ACP 传输 (client/turn) 三层关注点。

**观察 C [实测]**: `_movingEditorTabs` 是**只有 4 处引用**的布尔锁 (`:287` 初始化, `:640` 早退, `:643` 置位, `:672` 经 `setTimeout(..., 75)` 复位)。
**推断**: 用 75 ms 定时器复位的重入锁是竞态来源 — 搬迁未完成时锁被定时器提前放开, 或搬迁慢于 75 ms 时下一次事件误判可进入。依据: 复位与真实搬迁完成之间无因果关联, 纯时间赌注。

---

## 3. 状态爆炸: 一个 `this` 装 9 个域 [实测]

`constructor` (`:241-294`) 内声明的可变实例字段 (完整枚举):

```
会话域      sessions, activeSessionId, runningSessionIds, workspaceAgentState
CLI 域      cliTurns, cliClient, mockTurns
ACP 域      acp, acpSessions, acpRenderers, acpAvailableCommands,
            acpCommandCaptures, retiredAcpSessions, activeTurns,
            _sessionRefreshPromise, _ensureAcpPromise
队列域      promptQueue, steeringQueueItems, drainingSessions, cancellationBarriers
权限域      pendingPermission, permissionQueue, permissionBatchState,
            permissionSessionGrants, _permissionReminderTimer
Diff 域     docDiffDecorations, diffPreviewDocuments, _diffPreviewProvider
窗口布局域  view, panels, lastActiveEditor, _movingEditorTabs
运行时域    _nodeRuntimePromise, _nodeRuntimeErrorKey
其他        context, disposing, _queueSave, _stoppingPromise,
            recoveredBackgroundRuns, _backgroundRecoveryPromise
```

**40+ 可变字段, 无任何访问边界。**

### 3.1 跨域访问计数 [实测]

在 `:240-3635` 范围内 (`grep -c`):

| 字段 | 出现次数 |
|------|----------|
| `this.sessions` | 41 |
| `this.acpSessions` | 27 |
| `this.pendingPermission` | 27 |
| `this.promptQueue` | 20 |
| `this.acp` | 17 |

### 3.2 跨域越界实例 [实测]

**`dispatchCommand()` (`:1386`) — 命令分发放手直取权限域与队列域拼状态串:**
```js
await this.appendCommandNotice(sessionId, command,
  `状态：${this.isSessionRunning(sessionId) ? "running" : "idle"}\n` +
  `队列：${this.promptQueue.snapshot(sessionId).length}\n` +
  `待审批：${this.pendingPermission?.uiSessionId === sessionId ? "yes" : "no"}`);
```

**`acpStop()` (`:2757`) 与 `resolveDiffPermission()` (`:3064`) 同时操作权限域 + diff 域**, 且持有的 `pending` 对象被 27 处引用点中的任意一处置空。

**推断**: 无封装边界 ⇒ 任一域改状态都可影响另一域观察到的值 ⇒ 「腾挪布局的代码导致输入焦点丢失」这类**跨域症状**是结构必然, 非偶发。依据: 流式路径 (`runAcp`→`applyAcpSessionState`→`post`) 与布局路径 (`ensureEditorIsolation`) 共享同一个 `this`, 中间无防火墙。

---

## 4. Streaming 焦点丢失的因果链 [实测 → 置信推断]

### 4.1 事件回环 [实测]

```js
// :208-213
vscode.window.onDidChangeActiveTextEditor(editor => {
  if (editor && editor.document.uri.scheme !== "hermes-diff-preview")
    provider.lastActiveEditor = editor;
  provider.refreshEditorContext();     // → postMessage → webview 重渲染
  provider.ensureEditorIsolation();    // → 可能搬迁 editor 标签 → 夺焦点
})
```

`ensureEditorIsolation` 调用点全集 [实测]: `:213` (activeTextEditor 变化)、`:215` (`onDidChangeTabs`)、`:216` (`onDidChangeTabGroups`)、`:431` (`restoreWorkspaceAgentState`)、`:504` (`newSession`)、`:639` (定义处)。

`onDidChangeTextEditorSelection` (`:222`) 亦调 `refreshEditorContext()`。

### 4.2 闭环 [置信推断]

```
焦点移到 editor
      ↓
onDidChangeActiveTextEditor
      ↓
ensureEditorIsolation()  →  判定存在 misplacedDocument  →  搬迁
      ↓
vscode.open(..., { preserveFocus })   ← A7 只给「后台搬迁」那条路传了 true
      ↓
焦点再变  →  再次触发同一 handler  →  再评估 isolation
```

**推断为真正机制** (依据: 4.1 的代码路径全部实测; 缺仅为「该循环在真机上被实际触发」的运行时日志)。**判定: 置信推断, 待运行时日志定音。**

### 4.3 为什么「只在 streaming 时」 [实测支撑]

- 插件作者自己的注释即承认机制存在:
  ```js
  // :209-210
  // Track the last active document across focus changes (the webview
  // steals focus when typing, so activeTextEditor goes undefined there).
  ```
- 流式期间高频触发两条重渲染路径: `refreshEditorContext()` (`:3516`) 与 `postState()` (`:3520`), 加上 `:222` 的选择变化监听。
- **推断**: 非流式时该回环每轮对话只被踩几次; 流式时**每轮被踩数百次** ⇒ 命中丢焦点窗口的概率从「偶发」变成「常发」。依据: 触发频率与事件源数量; 未测实际频率。

### 4.4 与 A7 的关系 [实测]

**A7 修的是同一根因的一个出口, 不是全部。** A7 把后台搬迁路径的 `preserveFocus` 参数化为 `true` (`:668`); 但 `:213` 这条回环本身未被切断 — 只要有任一路径以 `preserveFocus: false` 打开文档, 或 `panel.reveal(..., false)` 夺走 webview 焦点, 回环即可再次启动。**推断 A7 症状缓解但未根除。**

---

## 5. 前端侧 (media/main.js) 病灶 [实测]

```
- 2,225 行单文件
- 全局可变 state 对象
- render() 内 document.querySelector("#app").innerHTML = ...  ← 全量重建
- 自带手写 morph (morphLiveChildren/morphLiveNode/liveKey) 以缓解全量重建代价
```

**实测结论 (本轮 probe)**: 手写 morph **在语义上正确** — 6/6 场景节点身份保持 (含 contenteditable 存活、thinking 步骤 `hasText` 翻转、折叠态变化)。**唯一边界: 同一 key 的节点若 tagName 变化会被替换而非原地更新** (`probe.js` D1 FAIL)。

**推断**: morph 是**对全量重建的补偿性补丁**, 而非设计。它把「数据结构身份」压进 `data-live-key` 属性, 使渲染正确性依赖于作者手工维护每个节点的 key 与结构对应关系; 任一处新增动态结构 (如 `:969 hasText` 条件产出) 即引入身份断裂风险。**根因是「状态 → DOM 全量重算」这一渲染模型, 非 morph 的实现质量。** 依据: morph 正确性依赖 key 完整性, 而 key 由 100+ 处模板字符串手工书写 (`:923/:939/:973/:977` 等)。

---

## 6. 重构部位候选 (Step 4 详列, 此处先登记)

| 部位 | 依据 | 优先级 |
|------|------|--------|
| **A. 流式/布局事件耦合** (`:208-213` 回环) | §4 因果链 | P0 — 直接对应已知 bug |
| **B. God Class 拆分** (3,396 行 / 150 方法) | §2 | P0 — 结构性 |
| **C. 权限审批 + diff 域独立** (1,063 行) | §2.1 #8, §2.2 观察 B | P1 — 最大单块 |
| **D. 双后端收敛** (ACP + CLI + mock) | §2.1 #9, §2.2 观察 A | P1 — 语义重复 |
| **E. 前端渲染模型** (全量重建 + 手写 morph) | §5 | P1 — 焦点/滚动/性能 |
| **F. `_movingEditorTabs` 时间赌注锁** | §2.2 观察 C | P2 |

---

## 7. 未验证事项 (诚实登记)

- [ ] 无运行时日志证实 §4.2 回环在真机被触发 (需按用户同意方案加探针)
- [ ] 未测流式期间 `refreshEditorContext`/`ensureEditorIsolation` 实际触发频率
- [ ] `lib/acp-render.js` (20.6 KB) 与媒体侧渲染的分工边界未查
- [ ] `lib/chat-parser.js` 与后端 ACP event 的契约未查
- [ ] `background/host.js` (21.6 KB) 与 `lib/background-client.js` 的关系未查
- [ ] `media/styles.css` 506 行 (50.7 KB = 大量长行) 的布局策略未查
- [ ] 26 个 js 文件中尚余 ~10 个 lib/* 未读
