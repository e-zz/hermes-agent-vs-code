# hermes-agent-vscode 全链路缺陷报告（弹窗 / 会话卡死 / 附件路径）

> 来源：用户安装 `eyanlin.hermes-agent-vscode@0.2.53`（上游 https://github.com/eyan-ai/hermes-agent-vs-code ）后，
> 逐层排查「空白控制台窗口弹出」「插件会话永久卡在 running」「关闭 editor tab 时聊天跳到顶部」三个症状。
> 性质：本报告分两部分 —— **A 部分为扩展侧缺陷**（需 fork 或上游修复），**B 部分为 hermes 后端侧缺陷**（已本地修复并提交）。
> 目的：逐条给出证据与可核验点，供上游或后续维护者复核。
> 日期：2026-09-28。提交人：Hermes agent（本文件即调查原始记录）。
> 归因说明：每条均标注 **实测 / 推断 / 推测**。`shell:false` 相关两条见 §A4 caveat。
> 修订：A6（关闭 tab 跳顶）为后续新增，与本报告首版同日。

---

## 环境事实（核验前提）

- 扩展安装目录：`C:\Users\zhang\.vscode\extensions\eyanlin.hermes-agent-vscode-0.2.53\`（多 profile 共享同一份代码）
- 后端源码：`C:\Users\zhang\AppData\Local\hermes\hermes-agent\`（branch `main`）
- 两个 VS Code profile：`default`（有历史 `globalStorage`）与 `typst` = `5905eff6`（全新）
- 后端 ACP 适配层：`acp_adapter/`（`server.py` / `content.py`）
- 关键事实：扩展的 `globalStorage` 是 **per-profile** 的，代码目录是 **共享** 的
- 提交基线：扩展侧本地 git `d616d85`（vendor baseline）/ `f79e1aa`（本地修复）；后端侧 `d92a72909b`

---

# A 部分 — 扩展侧缺陷

## A1 — 弹出空白控制台窗口：三处 `spawn` 用 `shell:true` 且无 `windowsHide`

**现象（实测）**：每次插件启动后端时，Windows 上弹出一个**空白 cmd.exe 控制台窗口**，且不自动关闭。用户实测确认为「空白控制台窗口」。

**代码证据**：三处 `child_process.spawn` 使用 `shell: true` 且未设 `windowsHide`：
- `lib/acp-client.js:68`
- `lib/reasoning-config.js:43`
- `background/host.js:417`

`shell:true` 会让 Node 通过 `cmd.exe /c` 启动子进程；Windows 上 `cmd.exe` 默认**创建控制台窗口**。未设 `windowsHide:true` 时不隐藏。

**旁证**：`host.log` 中出现 `DEP0190` 警告（`shell:true` 下 args 仅拼接不转义）。

**结论**：确认。修法 = 三处统一 `shell:false` + `windowsHide:true`（`lib/node-runtime.js:60-62` 已是正确样本）。

**修复后实测**：用户确认弹窗消失（`it's gone this time`）；`node --check` 5 文件通过；全扩展 `shell:true` 归零；ACP 握手成功（`session/new` 返回真实 id，无 ENOENT）。

**可核验点**：读三处 spawn；在 Windows 上启动插件观察是否出现 cmd 窗口；grep `shell:\s*true` 应为零命中。

---

## A2 — 会话永久卡在 `running`：runtime 解析失败被静默吞掉（**最重要的一条**）

**现象（实测）**：在新 profile 中发消息后，会话**永久停在 running**，无任何错误提示。UI 无输出，用户感知为「卡住」。raw `state.vscdb` 中该消息为：

```
{role:"assistant", text:"", status:"running", thinking:[], backgroundRunId:"9zldmptk4ckmukjh1ui"}
```

**关键判别证据（实测）**：该 profile 下 `globalStorage/eyanlin.hermes-agent-vscode/background-host/` **根本不存在**。
而 `lib/background-client.js` 的 `_start()` **第一件事是 `mkdir(storageDir)`** —— 目录不存在 ⇒ `_start()` 从未被调用过 ⇒ host 从未启动。

**根因（实测复现）**：`lib/node-runtime.js` 的 `validateProbeResult` 中：

```js
if (samePath(realPath, currentExecPath) || samePath(executablePath, currentExecPath)) {
  throw new Error("The extension host executable cannot own the Hermes background host");
}
```

该检查的意图是排除 VS Code / Electron 自身，**但上一行的 `APPLICATION_RUNTIME_PATTERN`（`/code helper|visual studio code|electron/i`）已经覆盖了这些情况** —— 因此这行等式检查只剩误伤：当扩展宿主的 `process.execPath` 恰好是某个真实 `node.exe` 时，**唯一可用的 Node 被当作"自己"排除**。

**复现方法（实测，可独立复核）**：
- 用 `C:\Program Files\nodejs\node.exe` 作为**当前进程**调用 `resolveNodeRuntime` → **失败**，错误即上面那句
- 改用任何一个**其它** Node 作为当前进程 → **同一个候选解析成功**（`source: path`）
- 即：失败与否**只取决于被测对象是否等于当前进程**，与 Node 是否存在无关。

**失败为何静默（实测）**：错误只被写入 `assistantMessage.thinking`，不冒泡到 UI。用户看到的就是「永久 running」。

**结论**：确认。**这是新 profile / 新机器上的必现缺陷** —— 因为新 profile 无 `background-host/`，必须走完整 runtime 解析。

**推断（未直接验证）**：`default` profile 之所以正常，是因为其 `background-host/` 已存在（含 `runtime/` 与 `endpoint.json`），**绕过了 runtime 解析**。未读到 VS Code 进程环境（需提权），故未能直接证据化。

**用户采取的绕法**：在 typst profile 显式配置 `hermesAgent.nodePath` 指向一个**不等于宿主 execPath** 的 Node。用户确认 `fixed now`。

**干净修法**：删除那句冗余的等式检查（`APPLICATION_RUNTIME_PATTERN` 已足够）。

**可核验点**：读 `lib/node-runtime.js` 的 `validateProbeResult`；按上述"换进程即复现/消失"方法复现；在新 profile 首次启动观察 `background-host/` 是否被创建。

---

## A3 — 后台 host 30 秒空闲即被 kill，短于后端冷启动时间

**现象（实测）**：后台 host 的 idle 超时原为 30s。

**代码证据**：`background/host.js` 的 `_scheduleIdleExit`（约 `:508-535`）。

**对比数据（实测）**：本机后端冷启动约 **13s**（4 个 MCP server + 62 个插件 + WAL 恢复）。30s 窗口与 13s 启动叠加 detach 延迟，易造成「刚起就被回收」。

**结论**：确认。已改为 `IDLE_EXIT_MS = 10 * 60 * 1000`。

**可核验点**：读 `background/host.js` 的 `_scheduleIdleExit` 与 `IDLE_EXIT_MS`。

---

## A4 — caveat：`shell:false` 改变了 `where.exe node` fallback 的宽容度（**修 A1 引入的副作用**）

**说明（推断）**：修 A1 去掉 `shell:true` 后，`lib/node-runtime.js:132` 的 `loginShellCandidates`（`runCapture("where.exe", ["node"])`）行为也随之改变 —— `cmd.exe` 解析 PATH 比 Node 的直接 spawn **更宽容**。

**影响边界（明确）**：这**不会制造** A2 的缺陷（A2 是原生 bug，在 `shell:true` 时代即存在）；但它**可能让 A2 从「潜伏」变为「显形」**。

**行动建议**：**A1 与 A2 的改动必须独立测试，不要当成一件事**。若重视兼容性，A1 可退为「只加 `windowsHide:true`，保留 `shell:true`」。

**归因**：本条为分析者（agent）在修复 A1 时引入的副作用，非上游缺陷，特此标注。

**可核验点**：分别在 `shell:true` / `shell:false` 下跑 `resolveNodeRuntime`，对比 `loginShellCandidates` 的候选命中情况。

---

## A5 — `_installRuntime` 每次无条件覆盖 runtime 缓存

**现象（实测）**：`lib/background-client.js` 的 `_installRuntime` **无存在性检查**，每次调用都 `copyFile`。

**影响（推断）**：每次启动都重写 runtime 目录，属多余 I/O；在文件被占用（如上一次 host 未完全退出）时可能成为失败点。

**结论**：确认（无存在性检查为实测）。影响程度未实测。

**可核验点**：读 `lib/background-client.js` 的 `_installRuntime`。

---

# B 部分 — hermes 后端侧缺陷（已修复并提交 `d92a72909b`）

> 本部分回答「对 hermes 的修复是否仍然必要」。**结论：两处均仍然必要**，且已用本机实测确认（见各条「实测」）。

## B1 — 原生 Windows 上附件路径被错误翻译为 `/mnt/<drive>/...`

**现象（实测）**：`acp_adapter/content.py` 的 `_path_from_file_uri` **无条件**把 Windows 盘符路径翻译成 WSL 形式：

```python
return Path("/mnt") / drive.lower() / rest.lstrip("/\\").replace("\\", "/")   # 基线 :94
```

在**原生 Windows** 上，`/mnt/c/...` 是不存在的路径 ⇒ 拖入附件后后端读不到文件。

**修复**：仅当 `is_wsl()` 为真时走 `/mnt` 分支，否则保留真实盘符。

**实测（本次，修复后）**：

| 输入 | 输出 |
|---|---|
| `file:///C:/Users/zhang/Downloads/a.pdf` | `C:\Users\zhang\Downloads\a.pdf` |
| `C:\Users\zhang\Downloads\a.pdf` | `C:\Users\zhang\Downloads\a.pdf` |
| `D:/Action/x.pdf` | `D:\Action\x.pdf` |
| `file:///D:/Action/x.pdf` | `D:\Action\x.pdf` |

**必要性判定：仍然必要。** 基线在原生 Windows 上必错；只要用 ACP 传附件就是坏的。

**可核验点**：跑 `_path_from_file_uri` 于上述四条输入；对照基线 `git show d92a72909b^:acp_adapter/content.py`。

---

## B2 — `resume_session` 对未知 session 静默新建，导致客户端握有失效 id

**现象（实测）**：对不存在的 `session_id` 调 `resume_session` 时，原实现**静默创建新会话**。而 `ResumeSessionResponse` 的 schema（`_meta`/`configOptions`/`models`/`modes`）**不携带 session id** ⇒ 客户端仍持有它请求的那个 id ⇒ **下一次 `session/prompt` 必失败**（`session not found`）。

**这是「会话卡住」的另一条独立路径**：与 A2 的 host 起不来不同，此路径下 host 正常，但会话 id 已经失效。

**修复**：改为抛 `RequestError.invalid_params`，让客户端自身的 recover-and-retry（`session/new`）逻辑接管 —— 这正是客户端在 `load_session` 返回 None 时已有的行为。

**实测（本次，修复后）**：
```
raises RequestError.invalid_params : True
  logger.warning("resume_session: session %s not found", session_id)
  raise RequestError.invalid_params({...})
```

**必要性判定：仍然必要。** 这是客户端「卡住」的一条真实路径。

**注意（范围外风险，未验证）**：改为抛错会影响**所有** ACP 客户端（Codex / Claude Code / OpenCode / Zed）对未知 session 的处理。**本次未做跨客户端验证。** 建议上游确认该错误码对这些客户端均能触发正确的恢复路径。

**可核验点**：读 `acp_adapter/server.py` 的 `resume_session`；跑 `tests/acp_adapter/test_windows_client_paths_and_resume.py`（6 passed，其中 5 条已验证在基线上为红）。

---

## A6 — 关闭 editor tab 时聊天跳到顶部：`resize` 处理器里一句无关的 `window.scrollTo(0, 0)`

**现象（用户报告）**：关闭任意一个 editor tab 时，聊天视图**跳到顶部**，丢失阅读位置。

**完整触发链（实测，逐环读出）**：

```
关闭 editor tab
  → vscode.window.tabGroups.onDidChangeTabs      extension.js:215
  → provider.ensureEditorIsolation()              extension.js:639
  → panel.reveal(targetAgentColumn, true)         ← 强制重排 webview
  → webview 触发 resize 事件
  → window.addEventListener("resize", ...)        media/main.js:678
  → window.scrollTo(0, 0)                         media/main.js:679   ← 缺陷点
```

**代码证据（缺陷点）**：`media/main.js` 的 resize 处理器里，第一行是：

```js
window.addEventListener("resize", () => {
  window.scrollTo(0, 0);       // ← 与「重算 composer 内边距」毫无关系
  positionSettingsPopover();
  const el = document.querySelector(".scroll");
  syncScrollPadding(el);
  ...
});
```

该处理器的职责是**在面板尺寸变化后重算 composer 高度对应的底部留白**（见其上方的 `watchComposerSize` / `syncScrollPadding` 注释）。`window.scrollTo(0, 0)` 不服务于该职责，是遗留语句。

**为什么 `panel.reveal` 会触发 resize（推断）**：`ensureEditorIsolation` 会把 Hermes 面板 `reveal` 到目标列以维持「编辑器/Agent 分栏隔离」。`reveal` 导致 webview 重新布局 ⇒ resize。**本条为推断** —— 未直接抓取 VS Code 内部事件流；但触发链的每一环（`onDidChangeTabs` 绑 `ensureEditorIsolation`、其内部调 `panel.reveal`、webview 内存在无条件 `scrollTo(0,0)`）均为实测读出。

**一处需要澄清的细节（实测）**：真正的滚动容器是 `.scroll`（`styles.css:111`，`overflow-y: auto`），**不是 `window`**。因此 `window.scrollTo(0, 0)` 本身并不重置对话的 `scrollTop`。症状能表现为「跳到顶部」，说明另有环节被 resize 连带触发（例如面板重排后 webview 自身滚动位置被重置）。**缺陷语句被移除后该症状即失去触发点 —— 但「webview 重排是否还会自行归零」未单独隔离验证，此点标注为待观察。**

**修法**：删除该行。保留处理器其余职责。

**实测（修复后）**：`node --check media/main.js` 通过；`window.scrollTo` 归零（唯一命中为说明性注释）；处理器仍保留 `syncScrollPadding` / `positionOpenPicker` / 流式期间贴底逻辑。

**可核验点**：读 `media/main.js` 的 resize 处理器（约 `:678`）；关闭一个 editor tab 观察聊天位置是否保持；`grep -n "window.scrollTo" media/main.js` 应只命中注释。

**与 A2 的关系**：两者都因 `ensureEditorIsolation` 的 `panel.reveal` 而起，但**是独立缺陷** —— A2 是 host 起不来（后端进程层），A6 是纯前端滚动位置。

---

# 汇总

| # | 缺陷 | 归属 | 证据强度 | 状态 |
|---|---|---|---|---|
| A1 | 三处 `shell:true` → 空白控制台窗口 | 扩展 | 实测（用户确认消失） | 已本地修 |
| A2 | `validateProbeResult` 误杀系统 Node → 会话永久 running | 扩展 | **实测复现** | 用户以配置绕过；干净修法待上游 |
| A3 | idle 30s 短于冷启动 13s | 扩展 | 实测 | 已本地修（10 min） |
| A4 | `shell:false` 削弱 `where.exe` fallback | 扩展（本调查引入） | 推断 | 已标注，需独立测试 |
| A5 | `_installRuntime` 无条件覆盖 | 扩展 | 实测（无检查）/ 影响推断 | 未修 |
| A6 | 关闭 tab 时聊天跳顶（`window.scrollTo(0,0)`） | 扩展（前端） | 触发链实测 / reveal→resize 推断 | 已修（待用户实测） |
| B1 | 附件路径被译成 `/mnt/...` | hermes 后端 | **本次实测** | 已修并提交 |
| B2 | `resume_session` 静默新建 | hermes 后端 | **本次实测** | 已修并提交 |

## 对「hermes 改动是否必要」的直接回答

**必要。** 两处均非推测：
- **B1 是硬性的** —— 基线在原生 Windows 上把 `C:\...` 变成 `/mnt/c/...`，**只要用附件就是坏的**。本次实测四条路径全部正确。
- **B2 是「卡住」的独立根因之一** —— 与 A2（host 起不来）并列，二者症状相同、路径不同。

**若只保留一处**：保留 B1（确定性错误，无副作用）；B2 涉及跨客户端行为，建议上游确认后再合。

---

## 附：本地修复产物位置

- 扩展侧本地 git：`C:\Users\zhang\.vscode\extensions\eyanlin.hermes-agent-vscode-0.2.53\`
  - `d616d85` = vendor baseline（与 marketplace 0.2.53 逐字节一致）
  - `f79e1aa` = 本地修复（`git diff d616d85` 即全部改动）
  - **注意**：此仓库为纯本地，无 remote（**尚未 fork**）
- 后端侧提交：`hermes-agent` 的 `d92a72909b`（`content.py` +19/-3、`server.py` +14/-2、新测试 +97）
- 归档：`hermes\fixes-2026-09-27\`（patch / diff / pristine backups）
