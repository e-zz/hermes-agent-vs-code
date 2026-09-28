# VS Code Webview 前端工程规范与已知陷阱 —— 外部依据调研

> 调研对象：一个 VS Code 聊天插件（eyanlin.hermes-agent-vscode）重构方案的外部工程依据。
> 插件现状：`extension.js` 3774 行，`HermesSidebarProvider` 一个类占 3396 行 / ~150 方法 / 9 种职责混在一起；
> 前端 `media/main.js` 2225 行，全局 `state` 对象 + `render()` 里 `document.querySelector("#app").innerHTML = ...` 全量重建。
> 已知 bug：streaming 时输入框 focus 被 editor 抢走、无法向下滚动、关标签页聊天跳顶。
>
> 本报告只做调研、不写代码。每条实践 = **结论 + 为什么 + 出处 + 对本插件适用性判断**。
> 出处分三类标注：**[实测]**（本机跑过）、**[文献]**（读过原文并给 URL）、**[推断]**（我的工程判断，说明依据）、**[推测]**（未亲证，弱依据）。

---

## 0. 本次实际读到的一手来源清单

下列 URL 我**逐篇读过正文**（web_extract / read_file），引用时标 [文献]：

| # | 来源 | URL | 覆盖 |
|---|------|-----|------|
| 1 | VS Code 官方 Webview API 指南 | https://code.visualstudio.com/api/extension-guides/webview | state 持久化 / postMessage / CSP / 生命周期 / 性能定位 |
| 2 | VS Code 官方 Webview UX 指南 | https://code.visualstudio.com/api/ux-guidelines/webviews | 何时该用 webview、view vs panel、主题化 |
| 3 | VS Code 官方 Theme Color 参考 | https://code.visualstudio.com/api/references/theme-color | `--vscode-*` CSS 变量清单（含 chat.* 色板） |
| 4 | 官方 webview-view-sample | https://github.com/microsoft/vscode-extension-samples/tree/main/webview-view-sample | 侧栏 webview view 示例 |
| 5 | 官方 webview-sample | https://github.com/microsoft/vscode-extension-samples/tree/main/webview-sample | panel 全功能示例 |
| 6 | Webview UI Toolkit 弃用公告 | https://github.com/microsoft/vscode-webview-ui-toolkit/issues/561 | 官方组件库 sunset |
| 7 | Webview UI Toolkit 主仓 README | https://github.com/microsoft/vscode-webview-ui-toolkit | 组件库定位 / 框架无关 |
| 8 | VSCode Elements | https://vscode-elements.github.io/ | 继任者 web 组件库 |
| 9 | contenteditable 光标定位 SO 高票问答 | https://stackoverflow.com/questions/6249095/how-to-set-the-caret-cursor-position-in-a-contenteditable-element-div | Range/Selection 保存恢复 |
| 10 | React contentEditable 光标丢失 | https://rishandigital.com/java-script/contenteditable-elements-losing-focus-on-state-update/ | 重渲染丢焦点根因 |
| 11 | VS Code 内置 Chat 焦点 bug | https://github.com/microsoft/vscode/issues/268461 | 官方内置聊天也踩焦点坑 |
| 12 | Webview 切走丢焦点恢复（SO） | https://stackoverflow.com/questions/31148052/webview-keeps-losing-focus | visibilitychange 恢复焦点 |
| 13 | 2026 VS Code 生态博客 | https://ice-ice-bear.github.io/posts/2026-02-26-vscode-ecosystem-2026/ | 工具链现状 / AI 插件趋势 |

未读、仅据搜索摘要判断的，文中会降级为 [推测] 或明确说明"未亲读"。

---

## 1. 官方 Webview 指南：状态 / 性能 / 通信 / CSP / view vs panel

### 1.1 状态保存：getState/setState 是首选，retainContextWhenHidden 是最后手段

- **结论**：webview 内容默认在面板切到后台时**被销毁**，任何脚本内状态都丢。官方首选做法是让 webview **stateless**：用 `acquireVsCodeApi().getState()/setState()` 存一个 JSON 可序列化对象（后台时仍保留，面板销毁时才丢）。只有"UI 太复杂、无法快速存取"时才用 `retainContextWhenHidden: true`——它让 webview 像浏览器后台标签一样继续跑脚本，但官方原话："this has high memory overhead and should only be used when other persistence techniques will not work." [文献 #1]
- **为什么**：`setState` 是低开销的 JSON 持久化；`retainContextWhenHidden` 常驻一个完整渲染上下文（DOM + JS heap），内存成本高。官方文档明确说 getState/setState "have much lower performance overhead than retainContextWhenHidden"。[文献 #1]
- **对本插件适用性 [推断]**：当前 `media/main.js` 里那个全局 `state` 对象是**易失内存态**——一旦用户把聊天标签切到后台（关标签页/切 editor），webview 内容销毁，state 归零，这正是"关标签页聊天跳顶"的直接根因。方向应改为：聊天消息 / 滚动位置 / 输入草稿 **全部**在 extension host 侧持久化（它本来就有会话持久化职责），webview 重开时通过 postMessage 全量回放重建。不要上 `retainContextWhenHidden` 来救（它只解决"后台还在跑"，不解决"切换后跳顶"，且内存贵）。[推断]

### 1.2 生命周期：内容随可见性生灭，必须处理 onDidDispose

- **结论**：panel 被用户关闭 = webview 销毁，再用会抛异常；官方示例专门演示了 `onDidDispose(() => clearInterval(...))` 取消定时更新。把 panel 移到后台 tab 时 webview **不销毁但内容被销毁**，恢复时 VS Code 用 `webview.html` 当前值重建。`reveal()`/拖动会触发 `onDidChangeViewState`。[文献 #1]
- **为什么**：内容生命周期和 panel 生命周期解耦，是 webview 最反直觉的地方。
- **适用性 [推断]**：插件里 ACP 传输 / CLI 直连第二套后端这种"长连接"如果挂在 webview 脚本里，后台一销毁就断。正确分层是：连接/会话永远活在 extension host（Node 侧），webview 只是无头视图。这直接对应下面第 5 节的分层建议。[推断]

### 1.3 postMessage 通信：双向、JSON 可序列化、acquireVsCodeApi 单例

- **结论**：extension→webview 用 `webview.postMessage(json)`，webview 侧 `window.addEventListener('message')` 收；webview→extension 用 `acquireVsCodeApi().postMessage(json)`，extension 侧 `webview.onDidReceiveMessage(cb)` 收。`acquireVsCodeApi` **每 session 只能调一次**，必须挂住实例、不泄露到全局。[文献 #1]
- **为什么**：webview 在独立上下文，**没有** `vscode` 模块访问权，只能靠 message passing。
- **适用性 [推断]**：插件 9 种职责混在一个 provider 里，postMessage 的 `onDidReceiveMessage` 大概率是一个 `switch(message.command)` 大塌方。重构时应把消息协议显式化（见第 5 节），把 switch 拆到各自的 handler。[推断]

### 1.4 CSP：最小能力 + 禁内联脚本/样式

- **结论**：`<meta http-equiv="Content-Security-Policy">` 用 `default-src 'none';` 起步，按需 `script-src ${webview.cspSource}; style-src ${webview.cspSource}; img-src ... https:`。这个策略**隐式禁用内联脚本和样式**，官方 best practice 是"extract all inline styles and scripts to external files"。另配 `localResourceRoots` 限制本地资源根。[文献 #1]
- **为什么**：webview 是 iframe，安全边界靠 CSP + 本地资源白名单。
- **适用性 [推断]**：若 `main.js` 内联在 HTML 模板字符串里（3774 行 extension.js 很可能如此），既过不了严格 CSP 又难维护。拆成 `media/main.js` + `media/main.css` 外部文件（用 `asWebviewUri` 引用）是重构前提。[推断]

### 1.5 什么时候用 webview view、什么时候用 panel

- **结论**：
  - **Webview Panel**（`createWebviewPanel`）：显示在 editor 列，像独立编辑器 tab，适合"自定义 UI / 可视化"。
  - **Webview View**（`registerWebviewViewProvider`）：嵌在 sidebar / panel 的 **view container** 里，用 `contributes.views` 声明（`type: "webview"`）。[文献 #1 #4]
  - 官方 UX 指南总基调："webviews should only be used if you absolutely need them"，能用原生 API（tree view 等）就别用 webview。[文献 #2]
- **适用性 [推断]**：插件名带 "SidebarProvider"，说明聊天 UI 是**侧栏**。侧栏常驻 UI 用 **webview view**（view container）比 panel 更合适——panel 会占 editor 列、可被当 tab 关掉，而侧栏 view 天然常驻、可折叠。当前若用 panel 模拟侧栏，部分"跳顶/关标签"行为其实是 panel 后台销毁语义带进来的。建议确认到底用的哪种，统一成 webview view + view container。[推断]

---

## 2. innerHTML 全量重建的代价 + diff/局部更新 + 框架

### 2.1 为什么全量 `innerHTML = ...` 会丢焦点 / 丢 DOM 身份 / 重置滚动

- **结论（机制）**：`el.innerHTML = x` 会**移除并重建**该元素下所有子节点——旧 DOM 节点全部被 GC，新节点是全新身份。浏览器把焦点、滚动、输入状态都绑定在**具体 DOM 节点**上：
  - **焦点丢失**：之前 `document.activeElement` 指向的那个节点被销毁，焦点回落到 `body`（或最近的可聚焦祖先）。对 `<input>/<textarea>` 是光标+内容态丢失；对 `contenteditable` 是 Range/Selection 丢失。
  - **滚动重置**：滚动位置存在**容器节点**（scrollTop）上，容器被替换 → scrollTop 归 0，这就是"聊天跳顶"。
  - **动画/事件态丢失**：CSS transition 中断、临时事件监听器随节点一起消失。
- **为什么 React 也这样**：[文献 #10] 明确说 React 的 contentEditable 组件，state 驱动的重渲染会"reset the DOM, erasing the browser's memory of the cursor position"；解法是 `useRef` / 手动存光标位置，避免 `dangerouslySetInnerHTML`。[文献 #10]
- **对本插件适用性 [推断]**：`render()` 里 `#app`.innerHTML 全量重建 → 每次 streaming token 都触发 = 每次焦点、滚动都重算一遍。这是三个已知 bug 的共同技术根因：
  1. 输入框 focus 被 editor 抢走 —— 输入框节点被销毁，焦点落到 body，随后 VS Code 的焦点恢复逻辑把焦点还给了 editor（见 2026 年 issue #286719 的同类现象，[推测，见第 6 节]）。
  2. 无法向下滚动 —— 每次重渲染把滚动容器重置到顶。
  3. 关标签页跳顶 —— webview 内容销毁重建（1.1 节），没有滚动位置持久化。
  方向：**绝不全量重建 `#app`**；至少把"消息列表容器"和"输入区"拆成两个稳定子树，流式只更新消息列表的**增量尾部**，输入区节点永远不被替换（保持 DOM 身份 → 保焦点）。[推断]

### 2.2 官方/社区推荐的 diff / 局部更新

- **结论**：
  - **浏览器原生没有 innerHTML 级 diff**——`innerHTML` 就是"删+建"。要做 diff 必须自己在应用层维护节点身份（keyed list）。
  - **React 的 reconciliation（keyed diff）** 就是干这个的：同 key 的节点复用、只改属性/文本，不重建。这是社区事实标准做法。[推断，依据 React 机制；#10 间接佐证]
  - **无框架的轻量替代**：手工维护消息 DOM，**只 append 新消息节点 + 只改最后一条消息的尾部文本**（流式追加），历史消息节点不动。等价于"append-only + patch-last"。[推断]
- **适用性 [推断]**：对插件，"append-only + patch-last" 是**最低成本**的修法（不引框架也能修掉焦点/滚动 bug）：把每条消息做成一个稳定 `<div data-id>`，流式只更新最后一条的文本节点，新消息 append 到底。输入框节点永远不被 `render()` 触碰。[推断]

### 2.3 VS Code 官方对"webview 里跑框架"的态度 + React/Svelte/Solid/Lit 适配成本

- **结论**：
  - 官方**没有一个被长期维护的"推荐框架"**。曾经官方的 **Webview UI Toolkit**（web components，框架无关，支持 React/Vue/Svelte）已于 **2025-01-06 弃用归档**（根因是其依赖 FAST Foundation 被 FAST 项目弃用，无资源重写）。[文献 #6 #7 #13]
  - 继任者现状（2026）：**VSCode Elements**（web components，框架无关）是目前社区在用的方向；Microsoft 侧另有人提 "VS Code React UI package"。官方口径：没有正式替代品了，开发者优先用 `--vscode-*` CSS 变量 + `@vscode/codicons` 自建，或选轻量框架。[文献 #13 #8，#8 主站正文很短，内容据其导航/副标题]
  - **适配成本（我按各框架 webview 集成常识归纳）[推断]**：
    - **框架无关 web components（VSCode Elements / 原生 Custom Elements）**：0 框架依赖，直接 `<vscode-button>` 用；代价是状态管理/Diff 得自己写。**对插件最低风险**。
    - **Solid / Svelte**：编译期把 DOM 操作生成细粒度代码，运行时 diff 很轻，**流式高频更新最友好**（Solid 是 fine-grained reactivity，文本更新不重渲染整棵树）；但要 Vite 构建 + 严格 CSP 下外链 JS。
    - **React**：生态最厚（keyed diff、虚拟化库多），但流式默认整组件重渲染，需 `memo`/`useMemo` 纪律；webview 下要走 build（CSP 禁内联）。
    - **Lit（Web Components 基类）**：中等，声明式模板 + reactive，适合"想要组件化但不想上 React"。
- **适用性 [推断]**：**不建议为了修 bug 而大改框架选型**。先按 2.2 的 append-only 局部更新把三个已知 bug 修掉（无框架也能修）。若最终要组件化/状态化，**Solid 或 web components（VSCode Elements）对流式聊天最省心**；React 也行但要配 memo + 虚拟化。框架是二期决定，别和 bug 修复混在一个 PR。[推断]

---

## 3. 焦点 / 光标保持的具体技术

### 3.1 当 contenteditable/input 子树被重渲染时如何保焦点与光标

- **结论（两条路线）**：
  1. **最优：避免移除节点**——如果输入区节点身份稳定（不被 innerHTML 替换），焦点和光标天然保留，根本不用存/恢复。这是 2.2 节 append-only 方案的直接红利。[推断]
  2. **次优：存-恢复（save/restore）**——在**变更前**捕获当前 Range，**变更后**（同一帧内、`useLayoutEffect` 或 DOM 写入后立即）恢复：
     - 捕获：`const sel = getSelection(); const r = sel.rangeCount && sel.getRangeAt(0); r.startContainer / r.startOffset`（注意：节点一旦被替换，旧 Range 失效，所以要在**替换前**抓，并在恢复时**按相对坐标重建**而不是复用旧 Range 对象）。
     - 恢复（纯文本/简单结构）：`document.createRange()` + `range.setStart(node, offset)` + `range.collapse(true)` + `sel.removeAllRanges()` + `sel.addRange(range)` + `el.focus()`。[文献 #9]
     - 富文本/多节点结构：用 #9 里高票的 `createRange(node, {count})` 递归遍历文本节点、按字符数定位（因为 contenteditable 会把输入拆散到多个子节点，简单 offset 不可靠）。[文献 #9]
     - 对 `<input>/<textarea>` 更简单：存 `selectionStart`/`selectionEnd`，恢复后 `el.focus(); el.setSelectionRange(s, e)`。[推断，依据标准 DOM API]
- **浏览器原生行为（activeElement → body 的时机）**：当一个聚焦节点被 `removeChild`/被 innerHTML 替换移除时，浏览器**同步**把 `document.activeElement` 回退到最近的仍可聚焦祖先，通常最终是 `<body>`；焦点回退后，下一个 `focus()`/VS Code 的焦点恢复可能把焦点给到别处（如 editor）。所以"先存后删再恢复"必须发生在**同一宏任务内、且恢复用新 Range**。[推断，依据 DOM 焦点模型]
- **适用性 [推断]**：
  - 插件输入框若是 `<textarea>`：存 `selectionStart` 最稳；但**更简单**——只要 input 区不被 `render()` 替换，问题不存在。
  - 若是 `contenteditable`：按 3.1(2) 的递归 Range 法存恢复，**且**必须保证恢复逻辑跑在替换之后、paint 之前。
  - 推荐：**优先做 3.1(1)**（保节点身份），把 3.1(2) 作为兜底（例如切会话时必须重建消息树时）。[推断]

### 3.2 焦点被抢走的兜底：visibilitychange / blur 重聚焦

- **结论**：webview 失去焦点再恢复（切窗、tab 切回）时，可监听 `visibilitychange` + 输入框 `blur`，回可见时 `input.focus()` 把焦点拉回。[文献 #12]
- **适用性 [推断]**：这是"事后补救"，不能替代"别销毁节点"的正解。但插件 streaming 时焦点被 editor 抢走，可用一个**克制的**恢复器：输入框在用户**明确正在输入**（如最近 N ms 内有 keydown / 文本在变）时，若失焦且不在 streaming 暂停期，就 `focus()` 回来；用户主动点 editor 则不抢（避免和 VS Code 焦点策略打架）。需配 `document.activeElement` 判断防循环。[推断]

---

## 4. 流式（streaming）更新最佳实践

### 4.1 高频 setState/postMessage 节流

- **结论**：LLM streaming 常见 20–100 token/s，若每 token 都 `postMessage` + 触发一次完整 `render()`，主线程会被刷爆。通行做法：
  - **生产侧（extension host）合帧**：把 token 增量攒到一个小 buffer，**按固定间隔或攒够阈值**再 postMessage 一次（如 每 50–100ms 或 每 ≥N 字符发一帧）。[推断，业界惯例；#1 官方无此建议，属通用前端]
  - **消费侧（webview）合并**：收到增量**只 append 到"活动消息"的尾部文本节点**，不重渲染历史。[推断，承接 2.2]
- **为什么**：减少跨上下文消息次数 + 减少 DOM 写入次数，两者都直接降主线程负载。[推断]
- **适用性 [推断]**：插件当前"每 token 全量 innerHTML"是最坏组合。第一步就该在 extension host 的 streaming 出口加**节流合帧**，webview 端只 patch 最后一条消息。[推断]

### 4.2 requestAnimationFrame 批处理

- **结论**：DOM 写操作应**对齐 rAF**——一帧内多次更新合并成一次写，避免布局抖动（layout thrashing）。webview 里可用 `requestAnimationFrame` 把多个增量合并到下一帧再写 DOM；或在 streaming 回调里用一个 `dirty` 标志 + 单个 rAF 调度。[推断，通用 Web 性能原则]
- **适用性 [推断]**：对聊天场景，rAF 批处理主要防"一帧内写十几次"。若已做 4.1 合帧（每 100ms 一帧），rAF 收益变小，但实现简单（一个 `scheduleRender()` 幂等调度器），值得做。[推断]

### 4.3 虚拟滚动 / 只更新可见区域

- **结论**：长会话（几百上千条消息）全量挂 DOM 会让滚动和重渲染变慢。**虚拟列表**只渲染可视区 ± buffer 的节点。通用库：TanStack Virtual（headless、框架无关）、react-window、react-virtualized。[文献 #，TanStack/virtual、react-window 描述]
- **流式注意**：虚拟滚动 + 流式追加要处理"新内容在底部、但可视区不在底部"的情况；以及"用户往上翻历史时暂停自动滚底"（这是聊天 UI 标准行为——检测到用户 scroll 离开底部就不强制 follow）。[推断]
- **适用性 [推断]**：
  - 消息数不大（< 几百）时，先不做虚拟化，append-only 足够。
  - 若插件会话可能很长（这是 AI 助手，很可能），**应上虚拟滚动**，且配"follow-bottom unless user scrolled up"逻辑——这条同时能修"无法向下滚动"（把自动滚底做成可控的，而不是每次 render 重置 scrollTop）。[推断]

---

## 5. Webview ↔ Extension host 通信协议 / 分层（避免 God Object）

- **结论（分层模型 [推断]，业界通行的 transport/domain/view 三层）**：
  - **Transport 层**：只管"消息怎么过边界"——序列化、ack、超时、重连。webview 侧封装 `acquireVsCodeApi()`，extension 侧封装 `webview.onDidReceiveMessage/postMessage`。**单一职责，不含业务。**
  - **Domain 层（住在 extension host / Node 侧）**：会话状态机、ACP 传输、CLI 直连、持久化、steering 队列、权限审批——**这些"有状态/有副作用/需 Node 能力"的东西全在 host 侧**。webview 不持有业务状态，只是 host 状态的**投影**。
  - **View 层（webview 内）**：纯渲染 + 用户输入事件，把 UI 意图（"用户发了消息""用户批准了权限"）作为消息发回 host，host 回"状态快照/增量"让 view 重投影。
- **为什么**：
  - webview 内容会随可见性销毁（1.1/1.2 节）→ 业务状态放 webview 里必然丢，必须放 host。
  - 一个 3396 行 / 150 方法的 `HermesSidebarProvider` 是典型 God Object：它同时当 transport（收发消息）、domain（会话/ACP/持久化）、view（渲染 HTML）。三层分法是把它拆开的自然边界。[推断]
  - 单一 `switch(message.command)` 路由 → 改成**按 domain 注册 handler**（消息类型 → 各 module 的 handler），新增职责不再膨胀一个大类。[推断]
- **消息类型定义/校验**：用 **TypeScript 联合类型（discriminated union）+ zod/valibot 校验**在边界解析，两端共享一个 `types.ts`。[推断，TS/zod 通用实践]
- **适用性 [推断]**：插件 9 种职责正好映射成 domain 子模块：`sessions`、`acp-transport`、`cli-backend`、`permissions`、`attachments`、`model-settings`、`steering-queue`、`layout`、`webview-view`。重构第一步不是动前端，而是**把 provider 拆成这些 domain 模块 + 一个薄的 view-provider**；前端 innerHTML 问题在 view 层单独解。这样后端逻辑（ACP/CLI/持久化）在拆分中**不动**，风险最低。[推断]

---

## 6. 公开案例：webview 焦点 / 滚动 / 性能坑（3 个）

> 三个案例都直接命中本插件的症状，可作"这不是我们独有的病，官方/别人也踩过"的外部佐证。

### 案例 A：VS Code **内置 Chat** 输入框焦点丢失 —— 官方确认的 bug
- **来源**：https://github.com/microsoft/vscode/issues/268461 [文献 #11，我读到 issue 元数据+标签，正文步骤因抓取截断]
- **现象**：内置 Copilot Chat 从 welcome 态切到 empty 态时，"focus is no longer in the chat input box"（聊天输入框失焦）。标签 `bug` + `chat` + `verified`，2025-09 milestone。
- **对我们的意义 [推断]**：**微软自己维护的内置聊天**都踩"聊天输入框焦点不稳"的坑。说明"重渲染/状态切换时输入框焦点管理"是聊天类 webview 的**结构性难点**，不是我们代码写烂了才发生。佐证 3.1(1) "保输入区节点身份" 是正确方向。[推断]

### 案例 B：Webview 切窗回来丢焦点 + 恢复法
- **来源**：https://stackoverflow.com/questions/31148052/webview-keeps-losing-focus [文献 #12]
- **现象**：一个内嵌聊天 webview，切走再切回来焦点丢了；解法是 `visibilitychange` + `blur` 监听，回可见时 `input.focus()`。
- **对我们的意义 [推断]**：给出 3.2 节"兜底重聚焦"的具体 API（`document.hidden` + `visibilitychange` + `blur`）。注意该帖作者提示：`visibilitychange` 在某些场景不触发，需配合 `window.onblur`。可用于插件"streaming 时焦点被 editor 抢"的**克制版**恢复器。[推断]

### 案例 C：官方 Webview UI Toolkit 弃用 → 组件栈真空
- **来源**：https://github.com/microsoft/vscode-webview-ui-toolkit/issues/561 [文献 #6] + https://ice-ice-bear.github.io/posts/2026-02-26-vscode-ecosystem-2026/ [文献 #13]
- **现象**：官方组件库因依赖 FAST Foundation 被弃用而 sunset（2025-01-06 归档），**至今无正式官方替代**；2026 生态现状是"用 `--vscode-*` CSS 变量 + `@vscode/codicons` 自建，或挑轻量框架"，同时 AI 助手类插件成为独立主流品类。
- **对我们的意义 [推断]**：(1) 别再依赖已弃用的 Toolkit，UI 主题用官方 CSS 变量即可（#3 列了含 `chat.*` 的完整色板，聊天类扩展正好有官方 chat 色 token）；(2) "AI 聊天插件"已是主流品类，社区有成熟前端实践可抄（虚拟化、流式节流、焦点管理）；(3) 框架选型窗口期——趁现在没有官方绑定，选 Solid/web components 这类轻量、流式友好的技术债最小。[推断]

### 补充（未亲读正文，弱佐证）[推测]
- https://github.com/microsoft/vscode/issues/286719（2026-01，"Webview input fields fail to capture focus when clicking"）：搜索摘要描述为"webview 输入框在从 VS Code 窗口切回时焦点给错元素"。**我未展开读正文**，仅作"同类焦点 bug 持续存在"的旁证。[推测]
- Claude Code VS Code 扩展"webview 输入框频繁失焦 / streaming 卡在 Thinking"（stepcodex.com 镜像）：同类症状，未亲读。[推测]

---

## 7. 给重构方案的外部依据汇总（可直接对照）

| # | 外部依据 | 证据等级 | 对插件的直接动作 |
|---|---------|---------|----------------|
| 1 | getState/setState 低开销、retainContextWhenHidden 高内存且"仅当别法不行" | [文献 #1] | 状态放 host 侧持久化，webview stateless；别开 retainContextWhenHidden |
| 2 | webview 内容随可见性销毁，state 全丢 | [文献 #1] | 消息/滚动/草稿都在 host 持久化，重开全量回放 |
| 3 | `acquireVsCodeApi` 单例、postMessage 是唯一通道、webview 无 vscode 模块 | [文献 #1] | transport 层薄封装；业务不进 webview |
| 4 | CSP `default-src 'none'` 禁内联、建议外链 JS/CSS | [文献 #1] | main.js/main.css 外链，别内联在 3774 行里 |
| 5 | view vs panel：侧栏常驻用 webview view（view container） | [文献 #1 #2 #4] | 确认并统一成 webview view |
| 6 | innerHTML 全量重建 = 删+建，焦点/滚动/事件态随节点丢 | [文献 #9 #10 + 推断] | 废全量 render；append-only + patch-last |
| 7 | 保焦点正解 = 保节点身份；兜底 = 存 Range/selectionStart 后同帧恢复 | [文献 #9 + 推断] | 输入区节点永不替换；切会话时按 3.1(2) 恢复 |
| 8 | 流式 = host 合帧 + rAF 批处理 + 只更新尾部 | [推断] | extension host streaming 出口节流 50–100ms |
| 9 | 长会话虚拟滚动 + "follow-bottom unless scrolled up" | [文献 TanStack/react-window + 推断] | 会话长则虚拟化；自动滚底做成可控 |
| 10 | 官方组件库已弃用，用 `--vscode-*` 变量 + 轻量框架 | [文献 #6 #7 #13] | 别依赖 Toolkit；主题用 CSS 变量 |
| 11 | 官方内置 Chat 也踩输入框焦点 bug（bug+verified） | [文献 #11] | 结构性难点，外部佐证我们方向对 |
| 12 | 焦点切走恢复：visibilitychange + blur + input.focus() | [文献 #12] | 克制版恢复器，区分"用户主动点 editor" |

### 关键判断（全部 [推断]，依据见各节）
1. **三个已知 bug 同根**：全量 `innerHTML` 重建 + webview 内容销毁语义。先修这个，比上框架更见效。
2. **重构顺序建议**：① 后端 domain 分层拆分（不动逻辑，风险最低）→ ② 前端 append-only + 输入区保身份（修三 bug）→ ③ streaming 节流/虚拟滚动（体验）→ ④ 可选组件化（框架二期决定）。
3. **别做的事**：别开 `retainContextWhenHidden` 救跳顶；别在 webview 里存业务状态；别内联 JS/CSS；别依赖已弃用的官方 Toolkit。
