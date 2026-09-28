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

该检查的意图是排除 VS Code / Electron 自身。

**⚠️ 更正（本报告首版在此处判断有误）**：首版称「上一行的 `APPLICATION_RUNTIME_PATTERN` 已经覆盖了这些情况，故该等式检查纯属冗余」。**该说法错误，已实测推翻。**

实测 `APPLICATION_RUNTIME_PATTERN = /(?:code helper|visual studio code|electron)/i` 对 Windows 的 `Code.exe` **不匹配**（`pass`）：

```
  pass  C:\Program Files\Microsoft VS Code\Code.exe     ← 未被阻挡
  BLOCK /Applications/.../Code Helper                    ← macOS 形态可挡
  BLOCK C:\app\node_modules\electron\dist\electron.exe   ← 裸 electron 可挡
```

即：该路径正则只覆盖 macOS 的 `Code Helper` 与未打包的 `electron.exe`，**漏掉 Windows 上打包后的 `Code.exe` / `Code - Insiders.exe`**（其路径既不含 "visual studio code" 也不含 "electron"）。

**但等式检查依然是可以移除的 —— 理由与首版不同（实测）**：真正拦住 `Code.exe` 的不是路径正则，而是 **probe 响应解析**。实测把 `Code.exe` 当作候选去 probe：

```
=== VS Code Code.exe ===
  status: 0   stdout: (空)
  stderr: Warning: 'p' is not in the list of known options...
          [main ...] Conflict in settings file vscode-userdata:...
  => JSON.parse 失败 → validateProbeResult 首行（:33 版本校验之前）即拒绝
```

**注意 `Code.exe` 的实际行为**：它不把 `-p` 当 Node 参数，而是**启动了一个完整的 VS Code 实例**（stderr 显示在加载 userdata settings）。因此它**不可能**通过 probe，也就**永远到不了等式检查那一行**。

**三层防线实测归属**：

| 候选 | 被哪一层拦下 | 等式检查参与？ |
|---|---|---|
| VS Code `Code.exe` | probe 响应无法解析（`:33` 之前） | ❌ 不参与 |
| Electron 伪装成 node（`ELECTRON_RUN_AS_NODE`） | `:36` `electronVersion`（probe 已先 `delete env.ELECTRON_RUN_AS_NODE`） | ❌ 不参与 |
| 老版 Node 缺 `randomUUID` | `:39` `supportsBackgroundHost` | ❌ 不参与 |
| **系统 `node.exe`（合法候选）** | **等式检查** | ✅ **唯一受害者** |

**结论**：等式检查是**不可达防御** —— 它唯一能拦下的对象（真实 Node），恰好是唯一合法的对象。`Code.exe` / Electron 在到达该行之前已被 probe 层拒绝。

**复现方法（实测，可独立复核）**：
- 用 `C:\Program Files\nodejs\node.exe` 作为**当前进程**调用 `resolveNodeRuntime` → **失败**，错误即上面那句
- 改用任何一个**其它** Node 作为当前进程 → **同一个候选解析成功**（`source: path`）
- 即：失败与否**只取决于被测对象是否等于当前进程**，与 Node 是否存在无关。

**失败为何静默（实测）**：错误只被写入 `assistantMessage.thinking`，不冒泡到 UI。用户看到的就是「永久 running」。

**结论**：确认。**这是新 profile / 新机器上的必现缺陷** —— 因为新 profile 无 `background-host/`，必须走完整 runtime 解析。

**推断（未直接验证）**：`default` profile 之所以正常，是因为其 `background-host/` 已存在（含 `runtime/` 与 `endpoint.json`），**绕过了 runtime 解析**。未读到 VS Code 进程环境（需提权），故未能直接证据化。

**用户采取的绕法**：在 typst profile 显式配置 `hermesAgent.nodePath` 指向一个**不等于宿主 execPath** 的 Node。用户确认 `fixed now`。**该绕法现已成为历史 —— 代码已修，配置不再需要。**

**已实施的修法（实测验证）**：

1. 删除等式检查（`:47`）—— 见上文「三层防线实测归属」，它拦不下 `Code.exe`/Electron，只会误伤真 Node。
2. **补强** `APPLICATION_RUNTIME_PATTERN`，使其真正覆盖 Windows 形态：
   ```
   /(?:code helper|visual studio code|electron|(?:^|[\\/])code(?: - insiders)?\.exe$)/i
   ```
   （首版误以为它已覆盖，实测证明未覆盖；补上后路径层与 probe 层各司其职。）
3. 顺带删除因之成为死代码的 `samePath()`（定义后无任何调用者）。
4. `validateProbeResult` 的 `currentExecPath` 形参**保留**（它是导出函数的签名，删掉是 API 变更；以 `void currentExecPath;` 显式标注不再参与判定）。

**改动量**：`lib/node-runtime.js` +16 / −9 行。

**红蓝验证（实测）**：同一组输入，baseline `d616d85` 与修复后对比 ——

| 场景（`resolveNodeRuntime`，`configuredPath` = 系统 node） | baseline | 修复后 |
|---|---|---|
| `currentExecPath` **等于**该系统 node | ❌ 抛错（即 A2 症状） | ✅ 解析成功 `24.16.0` |
| `currentExecPath` 为无关进程 | ✅ 解析成功 | ✅ 解析成功 |

即：**red-on-base 成立** —— baseline 拒绝的唯一候选正是唯一合法的候选。

**回归验证（实测，12 项全通过）**：
- 系统 node 作为自身 execPath → 解析成功（回归项）
- `Code.exe` 作为候选 → 仍被拒绝（`INVALID_CONFIGURED_NODE`）
- 无关 execPath 的正常场景 → 不受影响
- 扩展后的正则：`Code.exe` / `Code - Insiders.exe` / `/usr/share/code/code.exe` 全部阻挡；`node.exe` / `nodejs\node` 全部放行
- `validateProbeResult` 直调：同路径 runtime 接受；`electronVersion` 非空仍拒绝

**应用补丁**：`patches/07-node-runtime-identity-check.patch`（51 行）。从 `d616d85` 干净应用合并补丁后，7 个修复文件逐字节一致。

**可核验点**：读 `lib/node-runtime.js` 的 `validateProbeResult`（等式检查应已不在）；按上述"换进程即复现/消失"方法复现 baseline 行为；在新 profile 首次启动观察 `background-host/` 是否被创建。

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

**用户实测确认**：重载窗口后关闭 editor tab，**聊天位置保持**（原话 "now it stays when I close an editor tab"）。此前标注的「webview 重排是否还会自行归零」这一待观察点由该实测结果关闭。

**可核验点**：读 `media/main.js` 的 resize 处理器（约 `:678`）；关闭一个 editor tab 观察聊天位置是否保持；`grep -n "window.scrollTo" media/main.js` 应只命中注释。

**与 A2 的关系**：两者都因 `ensureEditorIsolation` 的 `panel.reveal` 而起，但**是独立缺陷** —— A2 是 host 起不来（后端进程层），A6 是纯前端滚动位置。

---

## A7 — 编辑文件时键盘焦点被 editor 抢走：后台搬迁无条件 `preserveFocus: false`

**现象（用户报告，原文）**：

> 编辑行为的focus 容易被 editor 抢去，prompt 输入失败。方向键到删除、所有正常输入似乎都被劫持到 editor

即：在 webview 的 prompt 框里打字时，字符 / 方向键 / 退格删除键被送到 editor。

**首版诊断（后被推翻）**：曾判定 `extension.js:634` 的 `panel.reveal(panel.viewColumn, false)` 为主因。**该判断在焦点方向上错误** —— `reveal(..., false)` 夺取的是「焦点给 webview 面板」，不可能解释「输入落到 editor」。**由 `gpt-6-luna`（cpa provider）独立复核推翻。**

**实际机制（当前认定）**：

```
用户在 webview prompt 里打字
  → 焦点在 webview 与 editor 间切换
  → onDidChangeActiveTextEditor            extension.js:208-213
     或 onDidChangeTabs                    extension.js:215
     或 onDidChangeTabGroups               extension.js:216
  → provider.ensureEditorIsolation()       extension.js:639
  → :645-647 判定「非 agent 列 且含 document tab」的列
  → :657-661 判定 agent 列内混入的 document tabs  ← 见下方「结构性判定过宽」
  → :663 ensureDocumentColumn()
  → :664 openDocumentTab(tab, targetColumn)   ← 后台搬迁（非用户点击）
  → :672-689 openDocumentTab：两个出口都是 preserveFocus: false
       :678  vscode.diff({ ..., preserveFocus: false })
       :688  → openDocumentUri({ preview:false, viewColumn })
  → :1038-1051 openDocumentUri
       :1043 vscode.open(uri, { preview, preserveFocus: false, viewColumn })
  → 焦点落到被打开的 editor  ⇒ 后续按键全部进入 editor
```

**结构性判定过宽（实测读码）**：

- `isDocumentTab()`（`:581-590`）把 `TabInputText` 算作 document → **任何打开的文本文件都算**
- `agentColumns()`（`:603-613`）= `this.panels` 所在列 **∪** 含 Hermes webview tab 的列

因此当 Hermes 面板与普通文本编辑器**处于同一列组**时，该文件被判为 `misplacedDocument`，每次 tab 变化 / 焦点切换都会触发一次 `:664` 搬迁。

**为什么 `:634` 不是重复原因（实测读码）**：`ensureDocumentColumn()`（`:630-637`）开头即有 `:632 if (existing !== undefined) return existing;` —— **只要已存在文档列，`:634` 根本执行不到**。它仍是焦点扰动点，但非重复触发源。

**修法（已实施）**：把 `preserveFocus` 做成参数并只在后台搬迁路径传 `true`：

- `:1042` `openDocumentUri(uri, { preview = true, viewColumn, preserveFocus = false })`；`:1047` 的 options 改用该变量
- `:676` `openDocumentTab(tab, viewColumn, { preserveFocus = false })`；`:682`（diff 分支）与 `:692`（透传给 `openDocumentUri`）均改用该变量
- `:668` 搬迁调用点显式传 `{ preserveFocus: true }`
- **用户主动打开的四处保持默认 `false`**（`:1012` 附件、`:1034` 生成的文档、`:1093` memory doc、`:3221` 已应用文件）—— 那里把焦点给 editor 是**正确行为**，不动

**测试**：`test_focus_preservation.js` 12 项断言（背景路径必须 `true`、两条出口必须透传变量、用户路径必须保持默认、无遗留硬编码 `preserveFocus: false`）。
**red-on-base 实测**：baseline `d616d85` = **8 FAIL / 4 PASS**；修复后 = **12 PASS / 0 FAIL**。

**一处尚未修复的关联缺陷（见 A8）**：`:635` 的 `workbench.action.newGroupLeft` 会创建并激活新列，**焦点在 `:664` 之前就已被带走**；此时 `preserveFocus: true` 只保证「焦点留在新列内」，不会把它还给 webview。**由 `gpt-6-luna` 指出。** 故本次修复覆盖「已存在目标列」的情形，**未覆盖「需要新建列」的情形**。

**证据分级**：

| 结论 | 分级 |
|---|---|
| `:678` / `:1043` 传 `preserveFocus: false`；`:664` 是后台调用、其余四处是用户点击 | **实测**（读码 + 调用点上下文） |
| `vscode.open(..., preserveFocus:false)` 把键盘焦点给 editor | **文献/API 语义**（VS Code API 文档），非本机实测 |
| 该路径即用户症状的根因 | **推断**（与复核者一致标注 INFERRED）——「打字时必然触发」未真机复现 |
| `:635 newGroupLeft` 亦夺焦点 | **推断**（复核者提出，未独立验证） |
| 打字时输入被劫持到 editor | **实测**（用户报告） |

**可核验点**：读 `extension.js` 的 `openDocumentTab` / `openDocumentUri` / `ensureEditorIsolation`；重载窗口后在 webview prompt 打字并在 editor 侧编辑，观察输入是否仍被劫持。

---

## A8 — 生成中无法直接向下滚动，需先向上再向下（**未修复**）

**现象（用户报告，原文）**：

> 当对话正在生成，无法直接向下滚动，需要先向上再向下

**当前状态：根因定位未完成，未改动任何代码。** 已排除若干假设，但**未能在模拟中稳定复现全部症状**。

**已定位的两个机制（均为实测读码）**：

1. `media/main.js:426` —— `currentRenderState()` 每次 render 都跑：
   ```js
   if (!state.userScrolledUp) state.pinBottom = true;   // :426 每帧强制贴底
   ```
   只要 `userScrolledUp === false`，`pinBottom` 每帧被强制为 `true`，`render()` 随即 `el.scrollTop = el.scrollHeight`（`:511`）。

2. `media/main.js:610-621` —— wheel 处理器存在**状态更新的不对称**：
   ```js
   if (event.deltaY >= 0) return;     // :617  向下滚直接 return，不改任何状态
   state.userScrolledUp = true;       // :618  只有向上滚才同步置位
   state.pinBottom = false;           // :619
   ```
   **向上滚在 wheel 处理器内同步置位 `userScrolledUp`；向下滚不置位**，完全依赖 `:622` 的 `scroll` 事件来清除该 flag。

3. `media/main.js:511`（位于 `requestAnimationFrame` 内，`:494`）—— 用**过期值**覆盖滚动位置：
   ```js
   el.scrollTop = state.pinBottom ? el.scrollHeight : prevScrollTop;   // :511
   ```
   `prevScrollTop` 于 `:521` 在 DOM 变更**之前**捕获，可能使 `scroll` 事件观察不到有效变更。

**无法收敛的原因**：两轮状态机模拟中，第一版**未能复现**（`scroll` 事件正常触发时向下滚有效）；第二版在引入「`:511` 用 stale `prevScrollTop` 覆盖、致使 `scroll` 事件不宣告变更」后才复现用户描述。**但该第二版模型对 `:511` 的覆盖语义作了假设，未经真机验证**，故不能据此断言根因，**只能标为推断**。

**另有两处候选未排除**：

- `media/main.js:586-596` `syncRunningThinkingViewports()` 每次 render 都执行 `view.scrollTop = view.scrollHeight`（`:588`），且**每次调用都对同一元素重复 `addEventListener("scroll", ...)`（`:594`）** —— 存在监听器泄漏，可能是内层滚动框与用户下拉相争的来源。
- `media/main.js:666-672` 的 `ResizeObserver` 内含第三处「距底部 < 96px 则贴底」逻辑。

**建议的下一步（任一）**：① 用户真机描述更精确的症状边界（**完全滚不动** vs **动一点被弹回**）以区分 `:617` 主因与 `:511` 主因；② 加运行时日志记录 `pinBottom` / `userScrolledUp` 在流式期间的翻转序列；③ 直接按「向下滚也同步更新 `userScrolledUp`」修 wheel 处理器，观察是否消除症状。

**修法未实施的理由**：改动落在 `media/main.js` 滚动逻辑，属用户可立即感知的行为变更；且上述三种候选对应不同修法，**在未定位到单一主因前下刀有改错方向的风险**。

---

# 汇总

| # | 缺陷 | 归属 | 证据强度 | 状态 |
|---|---|---|---|---|
| A1 | 三处 `shell:true` → 空白控制台窗口 | 扩展 | 实测（用户确认消失） | 已本地修 |
| A2 | `validateProbeResult` 误杀系统 Node → 会话永久 running | 扩展 | **实测复现 + red-on-base** | **已修复**（含正则补强 + 死代码清理） |
| A3 | idle 30s 短于冷启动 13s | 扩展 | 实测 | 已本地修（10 min） |
| A4 | `shell:false` 削弱 `where.exe` fallback | 扩展（本调查引入） | 推断 | 已标注，需独立测试 |
| A5 | `_installRuntime` 无条件覆盖 | 扩展 | 实测（无检查）/ 影响推断 | 未修 |
| A6 | 关闭 tab 时聊天跳顶（`window.scrollTo(0,0)`） | 扩展（前端） | 触发链实测 / reveal→resize 推断 | **已修，用户实测确认位置保持** |
| A7 | 编辑时焦点被 editor 抢走（后台搬迁 `preserveFocus:false`） | 扩展 | 调用路径实测 / 焦点语义文献值 / 根因推断 | **已修 + red-on-base**（`:635` 新建列分支未覆盖） |
| A8 | 生成中无法直接下滚（需先上后下） | 扩展（前端） | 机制实测 / 根因**未收敛** | **未修**，三种候选待区分 |
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
