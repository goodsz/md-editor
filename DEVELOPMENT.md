# md-editor 开发说明文档

> 技术路线：C —— 自研块编辑引擎（Typora 同构架构）
> 文档版本：v0.5　|　更新日期：2026-10-13
> 本文档是项目开发的唯一基准，实现与文档冲突时，先改文档再改代码。
>
> v0.2：应用层壳（菜单/工具栏/状态栏、本地文件打开保存、源码模式 Ctrl+/、主题切换）提前至 M1.5。
> v0.3（M2）：代码块 highlight.js 装饰式高亮；表格单元格编辑（逻辑选区扩展 cell）；大纲面板；导出/打印提前。
> v0.4：表格单元格行内渲染修复；大纲打开刷新修复；数学块 `$$` 解析规则 + KaTeX 双态；Mermaid 双态；行内公式暂缓。
>
> v0.5 变更（M4 桌面端启动）：
>
> 1. 桌面壳选型定案 **Electron**（纯 Node 工具链即可；Tauri 2 需 Rust，暂缓）：窗口壳 + 原生菜单 + IPC
> 2. 桌面文件 IO：原生对话框打开/保存/另存为（FileIO 自动路由 window.desktop 桥，浏览器行为不变）
> 3. **真 PDF 导出**：主进程 webContents.printToPDF（替代浏览器打印方案，浏览器端仍走打印）
> 4. 原生菜单承载 Ctrl+N/O/S/P（渲染层快捷键自动避让，防双触发）
> 5. 安全基线：contextIsolation + sandbox，Preload 仅暴露 contextBridge 白名单
> 6. 打包：electron-builder（win nsis），脚本 electron:dev / electron:build
> 7. 修复（客户端反馈）：移除原生菜单消除双菜单栏（Ctrl+N/O/S/P 全部由渲染层接管，新增 Ctrl+N）；编辑区宽度随窗口响应式自适应（max-width min(1080px, 96%)）
> 8. 仍未做：文件树、最近文件、自动更新、代码签名
>
> v0.6 变更（长文档性能）：
>
> 1. **视口虚拟化落地**（M3 长文档优化提前，ADR-0001）：顶层块 > 300 时视口外块渲染为等高 spacer，真实 DOM 块数恒定；高度实测缓存 + 估算回退；滚动/resize rAF 合并换窗
> 2. 跳转统一 `engine.revealBlock`：大纲点击、undo/redo 远跳自动滚动渲染后落光标（修复目录跳转无响应/视口不动）
> 3. spacer `pointer-events: none`（防止选区落在未渲染块导致误编辑）
> 4. **WASM 优化方案定案**（docs/decisions/ADR-0001）：解析/序列化/索引迁 Rust WASM + Worker，分四阶段（虚拟化 P0 已完成 → P1 解析序列化 → P2 Worker 化 → P3 索引），TS 实现永久保留为回退与对拍基准
>
> v0.7 变更（WASM 方案实施，ADR-0001 §5）：
>
> 1. **Rust 数值内核 `md-kernel` 落地**：Fenwick 前缀和 + 二分定位（零依赖、extern "C"、无需 wasm-bindgen），虚拟化窗口定位 O(n) → O(log n)；`npm run wasm:build` 一键构建 + Node 真实领域硬校验（verify-kernel）
> 2. **内核分发**：base64 内嵌 TS 模块（12KB），atob 解码三端原生可用，规避四类运行环境资源 URL 差异
> 3. **P2 Worker 化落地**：大文件（>200K 字符）打开解析与自动保存序列化移至 `doc.worker`（不可用自动回退主线程），主线程零阻塞
> 4. 引擎新增 `loadMarkdownAsync` / `toMarkdownAsync`；自动保存与文件打开按文档大小自动路由
> 5. 实施环境坑记录（Node 22 单步 instantiate 空导出、vitest 沙箱 WebAssembly 替换）见 ADR §5；P1b 文本内核缓期（触发条件见 ADR）
>
> v0.8 变更（客户端反馈修复）：
>
> 1. **滚动与光标一致**：虚拟化光标块 sticky——拖动滚动条时光标所在块永不被换出；setActiveBlock/setPinnedBlock 幂等化（消除 selectionchange→refreshWindow 循环）
> 2. **暗色主题同步**：滚动条（WebKit/Firefox 双轨）按主题变量着色；桌面端 `nativeTheme.themeSource` + 窗口背景经 IPC 随主题切换
> 3. **末行空白可点**：块间/文档末尾空白点击经 `caretRangeFromPoint` 落光标，未命中回退到最后叶子末尾
> 4. **任务列表**：checkbox 边距加大 + cursor: pointer；点击勾选后光标自动落入该项文本末尾（可直接继续编辑）
> 5. **html_inline 白名单渲染**：`<font color>`/`<span style>`/`<u>`/`<mark>` 等真实生效——开闭标签源码放 md-token（textContent 保真回写无损），属性白名单清洗（script 等非白名单标签纯文本降级，无 XSS）
> 6. **段落快捷键**：Ctrl+0 段落 / Ctrl+1..6 标题（此前菜单标注但未实现）
> 7. 代码块聚焦边框改半透明（亮/暗两套）
> 8. 已知问题：jsdom 下 undo 远跳快照恢复死锁（1 用例 skip 待查；浏览器路径 revealBlock 同机制用例通过）
>
> v0.9 变更（客户端反馈修复第二轮）：
>
> 1. **空代码/公式块可退出**：块首 Backspace / 块尾 Delete 转回普通段落（Typora 拆围栏行为）；空代码渲染的幻影 `\n`（offset 1）同样按块首/块尾处理，一次按键即删除
> 2. **代码块自然脱离**：末尾空行处回车 → 退出代码块另起新段落；点击代码/表格/HTML 块内容区下方空白且其后无文本叶子时自动另起一段（onClickBelowContainer + onClickBlank 兜底）
> 3. **块下方空白点击可输入**：程序化落光标后统一 `mapper.focusCurrent()` 聚焦编辑宿主（此前只设 DOM 选区不聚焦，键盘输入失效）；空段落聚焦经 rAF 渲染后补挂
> 4. **Ctrl+A 全选修复**：mapper.restore 空块端点回退到块/单元格内容边界（edgeDomPos）；selectAll 先聚焦末端宿主再设跨块选区（Chrome 聚焦会重置既有选区，顺序不能反）
> 5. **跨块删除重写（deleteRange）**：支持任意块型端点——表格/分割线/HTML 作为端点或中间块整体删除、单元格端点按格清空、代码/公式端点按源码合并（updateAttrs）；清空的 list/quote 容器级联移除（子先于父逆序 remove）；文档被清空时补空段落保底。修复端点含非文本块时 `updateText: 节点无 text 字段` 抛错导致删除失效
> 6. **链接插入修复**：`window.prompt` 在 Electron 不支持（直接抛错）→ 新增应用内输入对话框（ui/dialog.ts，Esc/Enter/遮罩关闭）；打开对话框前捕获逻辑选区、确认后恢复再插入；跨块选区收敛到焦点位置
> 7. **链接点击落光标**：普通点击链接 → 光标落入链接文本内（caretRangeFromPoint 命中 a 内即采用）；Ctrl/Cmd+点击打开不变
> 8. **源码模式**：exit 空文档兜底插入空段落（此前 0 块无焦点无法输入）；enter 无法映射光标时落到文首（光标可见）
> 9. **事务兜底**：controller 事务提交 try/catch（applyTx），单次异常不再中断事件流
> 10. 表格右键菜单新增「删除表格」；engine 新增 `focusCurrent` 公共 API
> 11. **桌面端关闭假死修复**：渲染层 beforeunload 在 dirty 时拦截关闭，导致主进程选「不保存」后的 win.close() 被静默中止（窗口假死、再点无反应）——关闭确认职责收敛到主进程弹窗，渲染层拦截仅在浏览器端生效（localStorage 落盘仍无条件执行）
>
> v0.10 变更（外链浏览器 + PDF 导出修复）：
>
> 1. **链接唤起本地浏览器**：`setWindowOpenHandler` 将 window.open / 新窗口请求一律路由到 `shell.openExternal`（仅 http/https/mailto 白名单）并拒绝新窗口；`will-navigate` 防主窗口被外链导航。Ctrl/Cmd+点击链接直接打开系统默认浏览器（浏览器端仍 window.open）
> 2. **PDF 导出空白页修复**：长文档虚拟化下视口外块渲染为等高 spacer，`printToPDF` 截取当前 DOM → 空白页。新增渲染器打印模式（preparePrint/finishPrint）：导出前全量真实渲染并等待异步内容就绪（mermaid 占位消失 / 图片加载 / 字体 ready，8s 超时兜底），导出后恢复虚拟化、滚动位置与光标选区（engine.withPrintRendering 包装）
> 3. **导出进度条**：ui/progress.ts 模态进度条（渲染全部内容 → 生成 PDF 文件 → 完成，复用 dialog 样式，打印输出中隐藏）
> 4. **导出后自动打开文件夹**：主进程 exportPdf 写盘成功后 `shell.showItemInFolder` 定位到 PDF 所在文件夹并选中文件
> 5. fileIO.exportPdf 改为返回 Promise（导出完成时序对齐进度条）
>
> v0.10.1 修复（导出无反应 / 页面空白）：
>
> 1. **waitForAssets 挂起修复**：图片等待无超时上限——文档含加载挂起的外链图（如不可达主机）时导出永远卡在"渲染全部内容"，进度遮罩盖住全页。图片单张 8s、mermaid 轮询 8s、字体 3s 全部加超时上限，坏资源不再阻塞导出
> 2. **printMode 卡死修复**：preparePrint 原在 withPrintRendering 的 try 之外，中途抛错则 finishPrint 永不执行——虚拟化永久失效、DOM 半重建（页面残缺空白、滚动懒加载失效）。现移入 try，finally 无条件 finishPrint（幂等）
> 3. **大文档分块渲染**：preparePrint 全量重建改为 200 块/片 + setTimeout 让出主线程，进度条实时推进（10%→50%），不再长时间白屏冻结
> 4. **进度条可取消**：取消按钮仅前置渲染阶段可点（保存对话框弹出后锁定）；取消后跳过导出并立即恢复渲染状态
> 5. 导出结束后按光标块重新定位滚动（全量重建后高度为估算值，raw scrollTop 可能越界）
>
> v0.10.2 修复（4 万字文档导出卡死）：
>
> 1. **打印排版移出主窗口**：此前 printToPDF 对编辑器完整 DOM（含海量 .md-token span）做打印排版，数万字文档渲染进程冻结数十秒。现改为：编辑器全量渲染（KaTeX/mermaid/高亮物化）→ 克隆为自包含静态打印 HTML（ui/printExport.ts，收集页面样式表：dev 内联 cssText / dist 绝对 file:// URL；净化编辑态：去 block-active/contenteditable，硬隐藏 .md-token）→ 写临时文件 → **隐藏 BrowserWindow** loadFile + printToPDF（独立渲染进程）→ 写 PDF → showItemInFolder → 清理临时文件与窗口
> 2. 主窗口全程响应（分块渲染 + 打印在后台窗口），进度条阶段：渲染全部内容 → 准备打印文档 → 生成 PDF 文件 → 完成
> 3. IPC 变更：desktop:exportPdf → desktop:export-pdf-html（payload 含 html）；preload/desktop 桥 exportPdf → exportPdfHtml；fileIO.exportPdf 拆分为 exportPdfViaHtml（桌面）+ printBrowser（浏览器 window.print）
> 4. A4 页边距显式指定（margins 英寸），静态文档无滚动容器 → 分页干净
>
> v0.11 变更（PDF 导出重构：方案 A 源码直渲）：
>
> 1. **导出彻底脱离编辑器实时 DOM**：此前导出需先"打爆虚拟化"全文真实渲染，再深克隆整棵编辑 DOM（含海量 .md-token 标记 span）→ 序列化 → IPC → 隐藏窗口打印；数万字文档在渲染/克隆阶段阻塞渲染进程、页面卡死。现改为从 **Markdown 源码直接生成干净自包含 HTML**（syntax/markdown.ts `renderExportHtml`）：数学块经 KaTeX 物化、代码块经 hljs 高亮、任务列表插入禁用态复选框、mermaid 图先输出占位再异步内联 SVG；编辑器 DOM 完全不参与导出。
> 2. **流式写入本地文件**：新增 IPC 协议 begin/chunk/end/abort——保存对话框确认后主进程创建临时 HTML 写入流，渲染层把打印 HTML 分块（256KB）经 IPC 送入并等待 write 回调（背压），全部写入后隐藏窗口 printToPDF。避免一次性大字符串与单条巨型 IPC；取消/异常走 abort 清理临时文件。
> 3. **版式复用页面样式表**：dev 内联 cssText / dist 外链绝对 URL，免费获得 KaTeX 与 highlight.js 配色；导出元素统一使用 `md-export-*` 专属类名，标准标签排版由打印补充 CSS 处理，避免与编辑器规则冲突。
> 4. 浏览器端打印改由隐藏 iframe 承载打印 HTML 后调起打印，同样不再依赖编辑器 DOM。
> 5. 引擎 `withPrintRendering`/printMode 保留为通用能力（导出路径已不再调用）；FileIO 桌面桥 `exportPdfHtml` 拆分为 `pdfBegin/pdfChunk/pdfEnd/pdfAbort`。
> 6. 实测（真实 Electron，41k 字含文本/代码/表格/列表/公式/25 张 mermaid）：端到端约 4.5s，PDF 94 页 1.25MB，主窗口全程响应。

---

## 1. 项目概述

### 1.1 目标

实现一个与 Typora 功能一致的**所见即所得（WYSIWYG）Markdown 编辑器**：

- 输入 `# ` 立即变为标题样式，无需切换预览窗格
- `**加粗**` 等行内标记在光标移开后自动隐藏
- 单一编辑区，源码与渲染浑然一体

### 1.2 与传统分栏编辑器的本质区别

|          | 分栏编辑器（VS Code / 通用 MD 编辑器） | 本项目（Typora 模式）            |
| -------- | -------------------------------------- | -------------------------------- |
| 架构     | 文本编辑器 + 独立预览                  | 单一 contenteditable 块编辑区    |
| 光标所见 | 源码文本                               | 最终渲染结果                     |
| 核心难点 | 无                                     | 光标保持 / IME / 增量渲染 / undo |

### 1.3 成败判据（M1 验收标准）

1. 中文输入法连续输入不断词、不丢字
2. 任意结构转换（段落↔标题、列表回车续行）后光标位置正确
3. 200 个段落文档中，单次击键到绘制完成 < 16ms
4. undo/redo 全场景正确，粒度符合直觉

---

## 2. 功能范围

| 优先级         | 功能                                                                                                       | 里程碑 |
| -------------- | ---------------------------------------------------------------------------------------------------------- | ------ |
| **P0**   | 段落 / 标题(H1-H6) / 粗体 / 斜体 / 删除线 / 行内代码 / 链接 / 图片                                         | M1     |
| **P0**   | 有序 / 无序 / 任务列表，引用块，分割线                                                                     | M1     |
| **P0**   | 光标保持、IME 兼容、undo/redo、自动保存                                                                    | M1     |
| **P0.5** | 应用层壳：菜单栏/格式工具栏/状态栏(字数)、打开/保存/另存为/拖拽本地 .md、源码模式(Ctrl+/)、主题切换(亮/暗) | M1.5   |
| **P1**   | 代码块(CodeMirror 6 高亮)、表格编辑、数学公式(KaTeX)、Mermaid                                              | M2     |
| **P1**   | 大纲面板、源码模式行号、文件树                                                                             | M3     |
| **P2**   | 导出 PDF/HTML、字数高级统计、专注/打字机模式、查找替换、脚注、粘贴图片本地化                               | M3/M4  |

**明确不做**：多人协同、云同步、插件市场（超出 Typora 对标范围）。

---

## 3. 技术选型

| 项            | 选择                                 | 版本要求                     | 选型理由                       |
| ------------- | ------------------------------------ | ---------------------------- | ------------------------------ |
| 语言          | TypeScript（strict 模式）            | ~5.9                         | 块树/AST 映射必须类型安全      |
| 构建          | Vite                                 | ^7                           | 快速 HMR，零配置 ESM           |
| 运行时        | Node.js                              | >= 20.19（本机 v22.22.0 ✓） | Vite 7 要求                    |
| Markdown 解析 | markdown-it                          | ^14                          | AST 规整、插件生态最好         |
| 代码块编辑    | CodeMirror 6                         | ^6 (M2 引入)                 | 模块化、可嵌入 contenteditable |
| 数学渲染      | KaTeX                                | ^0.16 (M3)                   | 比 MathJax 快一个量级          |
| 图表          | Mermaid                              | ^11 (M3)                     | 事实标准                       |
| 单元测试      | Vitest                               | ^3                           | 与 Vite 同生态                 |
| E2E 测试      | Playwright                           | ^1 (M2 引入)                 | 可模拟真实键击序列             |
| 桌面壳        | 暂不引入；M4 评估 Tauri 2 / Electron | —                           | 开发期纯 Web 迭代最快          |

**依赖红线**：编辑引擎（`src/engine/`）不得依赖任何 UI 框架；渲染层不得直接操作 `markdown-it` 实例，必须经 `src/syntax/` 封装。

---

## 4. 总体架构

### 4.1 分层

```
┌─────────────────────────────────────────────────────┐
│ 应用层  main.ts / ui/：文件树、大纲、导出、主题、设置       │
├─────────────────────────────────────────────────────┤
│ 引擎层  engine/：BlockEngine（本项目灵魂，可独立测试）      │
│   DocumentModel   Markdown AST ↔ 块树 双向映射           │
│   BlockRenderer   按块增量渲染（data-block-id 锚定 DOM）  │
│   SelectionMapper DOM 选区 ↔ 逻辑位置互转                │
│   InputController beforeinput / composition 拦截分流     │
│   HistoryManager  事务化 undo/redo                     │
├─────────────────────────────────────────────────────┤
│ 语法层  syntax/：markdown-it 封装 + 插件注册              │
├─────────────────────────────────────────────────────┤
│ 嵌入层  (M2+) CodeMirror 6 / KaTeX / Mermaid            │
└─────────────────────────────────────────────────────┘
```

**依赖方向**：`应用层 → 引擎层 → 语法层`，单向依赖，禁止反向引用。

### 4.2 核心数据流

```
击键
 │
 ▼
InputController 分流（编辑器根节点统一监听）
 ├─ compositionupdate 期间 → 完全放行，冻结渲染器（IME 铁律）
 ├─ inputType=insertText 等纯文本 → 放行浏览器默认行为
 │    compositionend / 输入防抖后 → 回写块树，标脏当前块
 ├─ 结构性按键（Enter / Backspace / Tab / "# "/"- "/"1. " 前缀）
 │    → preventDefault()，转为事务
 ▼
Transaction 提交到 DocumentModel
 ├─ 块树变更，产出 dirtyIds: Set<BlockId>
 ├─ HistoryManager 入栈快照（结构共享）
 ▼
BlockRenderer.renderBlocks(dirtyIds)   ← 只重渲染受影响块
 ▼
SelectionMapper.restore(captured)      ← 恢复光标到新 DOM
```

---

## 5. 核心数据模型

定义位置：`src/engine/model/types.ts`

### 5.1 块树

```ts
type BlockId = string; // nanoid 生成，全局唯一

type Align = 'left' | 'center' | 'right';

interface ListItem {
  id: BlockId;
  text: string;          // 行内内容（纯文本，标记由行内渲染器解析）
  checked?: boolean;     // 仅任务列表
  children?: Block[];    // 嵌套列表
}

type Block =
  | { id: BlockId; type: 'paragraph'; text: string }
  | { id: BlockId; type: 'heading'; level: 1 | 2 | 3 | 4 | 5 | 6; text: string }
  | { id: BlockId; type: 'code'; lang: string; code: string }
  | { id: BlockId; type: 'math'; tex: string }                     // $$...$$
  | { id: BlockId; type: 'hr' }
  | { id: BlockId; type: 'quote'; children: Block[] }
  | { id: BlockId; type: 'list'; ordered: boolean; start?: number; items: ListItem[] }
  | { id: BlockId; type: 'table'; align: Align[]; rows: string[][] }
  | { id: BlockId; type: 'html'; raw: string };                    // 原样保留
```

约定：

- **块树是唯一数据源**。DOM 只是块树的投影，任何时刻两者必须可互相推导
- 每个块节点的 DOM 容器挂 `data-block-id` 属性，是增量渲染与光标恢复的锚点
- `text` 存纯文本；`**bold**` 等行内标记属于**文本内容本身**，由行内渲染器解析成带 `data-token` 的 span，不进块树结构

### 5.2 事务与操作

```ts
type Op =
  | { type: 'updateText'; id: BlockId; text: string }
  | { type: 'updateAttrs'; id: BlockId; attrs: Record<string, unknown> } // 如 heading level
  | { type: 'insert'; after: BlockId | null; block: Block }              // null = 插入开头
  | { type: 'remove'; id: BlockId }
  | { type: 'move'; id: BlockId; after: BlockId | null };

interface Transaction {
  ops: Op[];
  selection: LogicalSelection;   // 事务完成后的目标光标位置
}
```

**规则**：一次用户操作 = 一个事务 = 一次渲染调度 + 一条 undo 记录。禁止绕过事务直接改 DOM 或改块树。

### 5.3 逻辑选区

```ts
interface LogicalPosition { blockId: BlockId; offset: number }  // 块内纯文本偏移
interface LogicalSelection { anchor: LogicalPosition; focus: LogicalPosition }
```

- `offset` 以块的**纯文本**（不含标记符号）计算，渲染前后语义不变
- DOM 恢复时由 SelectionMapper 将偏移反查为具体文本节点 + 节点内偏移

### 5.4 Markdown ↔ 块树映射表

| markdown-it 顶层 token               | 块类型    | 备注                              |
| ------------------------------------ | --------- | --------------------------------- |
| paragraph_open … paragraph_close    | paragraph | `inline` 子 token 的内容即 text |
| heading_open / heading_close         | heading   | tag 层级 → level                 |
| fence                                | code      | `info` → lang                  |
| math_block（插件）                   | math      | —                                |
| hr                                   | hr        | —                                |
| blockquote_open … close             | quote     | 递归解析 children                 |
| bullet_list_open / ordered_list_open | list      | 紧凑模式连续段落合并为一个 item   |
| table_open … close                  | table     | 对齐信息从 th 的 style 提取       |
| html_block                           | html      | 原样保存，渲染白名单过滤          |

序列化（toMarkdown）是上表的逆过程，**往返测试**（parse→serialize→parse 结果一致）是 M1 必测项。

---

## 6. 核心模块规格

### 6.1 DocumentModel

```ts
class DocumentModel {
  fromMarkdown(md: string): Doc;
  toMarkdown(doc?: Doc): string;
  getBlock(id: BlockId): Block | undefined;
  getRoot(): Doc;                          // 只读视图
  apply(tx: Transaction): Set<BlockId>;    // 返回 dirtyIds
  onDirty(cb: (dirtyIds: Set<BlockId>) => void): () => void;
}
```

要点：

- 块树节点用 `Map<BlockId, Block>` 建索引，O(1) 查找
- `apply` 内部做**结构共享**（不可变更新），为 HistoryManager 快照降成本
- 校验：`insert`/`remove`/`move` 必须维持树结构合法（如 quote 的 children 只能是块）

### 6.2 BlockRenderer

```ts
class BlockRenderer {
  mount(root: HTMLElement): void;              // 全量首渲染
  renderBlocks(dirtyIds: Set<BlockId>): void;  // 增量
}
```

要点：

- 单块渲染管线：`text → markdown-it.inline → DOM片段`，产出标记 span（`data-token`）
- **标记显隐完全由 CSS 控制**，不删除 DOM 节点：

```css
.md-token { display: none; }                  /* 默认隐藏 ** 、` 等标记 */
.block-active .md-token { display: inline; }  /* 光标所在块显示 */
.md-token.focused { display: inline; }        /* 光标贴着标记时显示 */
```

- 光标进入块 → 加 `.block-active`；离开 → 移除。切换瞬间渲染器才解析标记，实现"移开光标即渲染"
- 每块独立的 `contenteditable=true`；文档根节点 `contenteditable=false`
- 渲染调度用 `requestAnimationFrame` 合并同帧多次标脏

### 6.3 SelectionMapper

```ts
class SelectionMapper {
  capture(): LogicalSelection | null;            // DOM选区 → 逻辑位置
  restore(sel: LogicalSelection): void;          // 逻辑位置 → DOM选区
  offsetToDom(blockId: BlockId, offset: number): { node: Text; offset: number } | null;
}
```

要点：

- 渲染前 `capture`，渲染后 `restore`；只对 dirty 块做映射，未渲染块 DOM 未动、光标天然不丢
- `offsetToDom` 通过深度优先遍历块内文本节点累加长度实现，纯文本块走快路径
- 处理边界：块首/块尾、空块、选区跨块（M1 支持块级选区即可）

### 6.4 InputController

```ts
class InputController {
  attach(root: HTMLElement): () => void;   // 返回解绑函数
}
```

**分流表（唯一事实来源）**：

| 输入                                         | 处理                                             |
| -------------------------------------------- | ------------------------------------------------ |
| compositionstart/update/end                  | 置`composing=true`，冻结渲染器；end 后回写块树 |
| `insertText` 且非 composing                | 放行；rAF 回写当前块 text                        |
| `insertParagraph`（Enter）                 | 拦截 → 事务：段落拆分 / 列表续项 / 空引用块退出 |
| `deleteContentBackward`                    | 放行；若将删至块首 → 拦截 → 合并/转换事务      |
| 输入前缀命中（`# `/`- `/`1. `/`> `） | 拦截 → 块类型转换事务                           |
| `Tab` / `Shift+Tab`                      | 列表缩进 / 反缩进事务                            |
| 上下左右跨块边界                             | 拦截 → 移动焦点到相邻块对应位置                 |

**IME 铁律**：`composing === true` 期间，全代码库任何模块不得执行 DOM 写操作。用 ESLint 自定义规则 + code review 双重保障。

### 6.5 HistoryManager

```ts
class HistoryManager {
  push(snapshot: { doc: Doc; selection: LogicalSelection }): void;
  undo(): { doc: Doc; selection: LogicalSelection } | null;
  redo(): { doc: Doc; selection: LogicalSelection } | null;
  canUndo / canRedo: boolean;
}
```

要点：

- 弃用 contenteditable 原生 undo（不可控、跨块错乱），全程接管
- 栈上限 200 条，超出丢最旧
- **合并规则**：同块连续 `insertText` 间隔 < 800ms 合并为一条；结构操作（Enter/Backspace跨块/转换）始终独立成条
- 快照基于结构共享，成本近似 O(改动块数)

---

## 7. 目录结构

```
md-editor/
├── index.html
├── package.json
├── tsconfig.json
├── vite.config.ts
├── DEVELOPMENT.md              # 本文档
├── src/
│   ├── main.ts                 # 应用入口（装配引擎 + UI）
│   ├── engine/
│   │   ├── index.ts            # BlockEngine 组装与对外 API
│   │   ├── model/
│   │   │   ├── types.ts        # Block / Transaction / LogicalSelection
│   │   │   ├── document.ts     # DocumentModel
│   │   │   └── convert.ts      # 块树 ↔ markdown-it AST
│   │   ├── render/
│   │   │   ├── renderer.ts     # BlockRenderer
│   │   │   ├── inline.ts       # 行内标记 → span 渲染
│   │   │   └── blocks/         # 各块类型渲染器（heading.ts 等）
│   │   ├── selection/
│   │   │   └── mapper.ts       # SelectionMapper
│   │   ├── input/
│   │   │   ├── controller.ts   # InputController
│   │   │   └── commands.ts     # 结构性操作 → 事务（拆段/续列表/转换…）
│   │   └── history/
│   │       └── history.ts      # HistoryManager
│   ├── syntax/
│   │   └── markdown.ts         # markdown-it 实例与插件注册（唯一入口）
│   ├── ui/                     # M2+：工具栏、大纲等
│   └── styles/
│       ├── base.css
│       ├── tokens.css          # 标记显隐规则
│       └── theme.css
├── tests/
│   ├── model/                  # DocumentModel 单测（含往返测试）
│   ├── history/
│   └── e2e/                    # M2+ Playwright
└── docs/
    └── decisions/              # 后续重大决策记录（ADR）
```

---

## 8. 环境准备与常用命令

```bash
# 已确认：Node v22.22.0 / npm 10.9.4，满足要求

npm create vite@latest . -- --template vanilla-ts   # 初始化（当前目录）
npm i markdown-it nanoid
npm i -D typescript vitest @types/markdown-it

npm run dev        # 开发服务器
npm run build      # 生产构建
npm run test       # Vitest 单测（watch: npm run test:watch）
```

---

## 9. 里程碑与任务分解

### M1 —— 核心验证（当前阶段，最难）

| #    | 任务                                                          | 完成判据                        |
| ---- | ------------------------------------------------------------- | ------------------------------- |
| 1.1  | 工程初始化 + tsconfig strict + Vitest                         | `npm run dev` / `test` 可跑 |
| 1.2  | syntax/：markdown-it 封装 + 往返测试                          | parse↔serialize 无损           |
| 1.3  | model/：类型 + DocumentModel + 单测                           | apply/索引/结构共享覆盖         |
| 1.4  | render/：paragraph + heading 渲染                             | 首屏正确，data-block-id 就位    |
| 1.5  | selection/：mapper capture/restore + 单测                     | 重渲染后光标不丢                |
| 1.6  | input/：纯文本回写 + IME 冻结                                 | **中文连续输入不断词**    |
| 1.7  | commands/：Enter 拆段、Backspace 合并、`# `/`- ` 前缀转换 | 结构转换 + 光标正确             |
| 1.8  | history/：undo/redo                                           | 全操作可撤销，粒度正确          |
| 1.9  | 强调/行内代码/链接渲染 + 标记显隐 CSS                         | 观感对齐 Typora                 |
| 1.10 | 列表（有序/无序/任务）+ 引用                                  | 续项、缩进、退出                |
| 1.11 | 性能基准脚本                                                  | 200 段文档击键 < 16ms           |

**1.6 是最高风险项，提前到与 1.4 并行开发最小验证 demo。**

### M2 —— 块级补全：代码块(CM6)、表格、图片、粘贴清洗、自动保存、Playwright E2E

### M3 —— 体验对齐：数学/Mermaid、大纲、主题、源码模式、查找替换、长文档虚拟化

### M4 —— 产品化：导出 PDF/HTML、文件树、Tauri/Electron 打壳、发布流程

---

## 10. 编码规范

- TypeScript `strict: true`，禁用 `any`（确需时 `unknown` + 收窄）
- 引擎层零 DOM 依赖的模块（model/history/syntax）必须可在 Node 环境单测
- 命名：类 PascalCase；函数/变量 camelCase；类型/接口 PascalCase；常量 UPPER_SNAKE
- 注释与文档语言：中文；仅在逻辑不自明处注释
- Git：`main`（稳定）/ `dev`（集成）/ `feat/*`、`fix/*` 分支；commit 用 Conventional Commits（`feat: …` / `fix: …`）
- 每个引擎模块提交前必须通过对应单测

---

## 11. 测试策略

| 层         | 工具           | 重点                                                             |
| ---------- | -------------- | ---------------------------------------------------------------- |
| 逻辑层单测 | Vitest         | DocumentModel 增删改、往返序列化、undo 合并规则、offset 映射边界 |
| 引擎集成   | Vitest + jsdom | 完整输入循环：模拟 beforeinput 事件 → 断言块树 + DOM + 光标     |
| E2E（M2+） | Playwright     | 真实键击序列、IME 合成事件模拟、跨块操作                         |
| 性能       | 自写基准脚本   | 200/1000 段文档的击键延迟、重渲染块数统计                        |

**关键单测清单（M1 不得缺）**：中文合成输入不触发渲染、Enter 拆段光标位置、列表续项、undo 后光标恢复、空文档/空块边界。

---

## 12. 风险与对策

| 风险                   | 等级         | 对策                                                          |
| ---------------------- | ------------ | ------------------------------------------------------------- |
| 光标 + IME 组合问题    | **高** | 1.6 提前并行验证；若两周内打不通，降级评估 Milkdown（路线 A） |
| 表格编辑复杂度被低估   | 中           | 排期放 M2 末，先做只读渲染再做编辑                            |
| markdown-it 往返丢信息 | 中           | 1.2 即建立往返测试，信息缺失时用块级 raw 字段兜底             |
| 跨浏览器选区差异       | 低           | 开发期仅对齐 Chromium；M4 打壳前补 Firefox 验证               |
| 长文档性能             | 低           | M1 架构天然按块隔离，M3 虚拟化兜底                            |

---

## 13. 术语表

| 术语                        | 定义                                                     |
| --------------------------- | -------------------------------------------------------- |
| 块（Block）                 | 文档的基本结构单元（段落/标题/列表…），块树节点         |
| 事务（Transaction）         | 一次原子性的块树变更，渲染与 undo 的最小单位             |
| 逻辑位置（LogicalPosition） | `{blockId, offset}`，与 DOM 无关的光标坐标             |
| 标脏（Dirty）               | 块树已变、DOM 待同步的块集合                             |
| 标记（Token）               | `**`、`` ` `` 等行内语法符号，DOM 中常驻、CSS 控制显隐 |
| IME 合成（Composition）     | 输入法拼字过程，期间禁止一切 DOM 写操作                  |
