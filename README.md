# md-editor

Typora 风格的**所见即所得（WYSIWYG）Markdown 编辑器**，同一套内核可在浏览器与 Electron 桌面端运行。

单一编辑区里源码与渲染浑然一体：输入 `# ` 立即变成标题，`**加粗**` 等行内标记在光标移开后自动隐藏——没有独立预览窗格，光标所见即最终渲染结果。

---

## 特性

**编辑体验**

- 单一 contenteditable 块编辑区，光标保持、IME（中文输入法）连续输入不断词
- 块类型：段落 / 标题 H1–H6 / 有序·无序·任务列表 / 引用块 / 分割线 / 代码块 / 表格 / 数学块 / HTML 块 / Mermaid 图
- 行内标记：加粗 / 斜体 / 删除线 / 行内代码 / 链接 / 图片，以及白名单内联 HTML（`<font color>`、`<u>`、`<mark>` 等）
- 代码块 **highlight.js** 装饰式高亮；数学块 **KaTeX** 双态（编辑时显源码、非激活显公式）；**Mermaid** 双态图表
- 表格单元格直接编辑 + 右键菜单；任务列表复选框可点击
- 事务化 undo/redo，符合直觉的合并粒度

**应用壳**

- 菜单栏 / 格式工具栏 / 状态栏（字数）；大纲面板（可拖拽调宽，支持跳转）
- 源码模式（`Ctrl+/`）整页编辑 Markdown 源码，与所见即所得视图双向切换并保持光标
- 亮 / 暗主题切换（桌面端同步原生标题栏与窗口背景）
- 本地文件：打开 / 保存 / 另存为 / 拖拽 `.md`；桌面端走原生对话框，关闭时弹保存确认
- 自动保存（localStorage，500ms 防抖），关闭前同步落盘防丢失
- 导出 **PDF** 与 **HTML**；外链点击唤起系统默认浏览器

**长文档性能**

- 视口虚拟化：顶层块 > 300 时视口外渲染为等高 spacer，真实 DOM 规模恒定
- 大文档（> 200K 字符）解析 / 序列化移至 Web Worker，主线程零阻塞
- Rust WASM 数值内核：Fenwick 前缀和 + 二分定位，虚拟化窗口定位由 O(n) 降到 O(log n)

---

## 技术栈

| 项                | 选择                                 |
| ----------------- | ------------------------------------ |
| 语言              | TypeScript（strict）                 |
| 构建 / 开发服务器 | Vite                                 |
| Markdown 解析     | markdown-it                          |
| 代码高亮          | highlight.js                         |
| 数学渲染          | KaTeX                                |
| 图表              | Mermaid                              |
| 桌面壳            | Electron + electron-builder          |
| 单元测试          | Vitest（jsdom 环境）                 |
| 性能内核          | Rust → WebAssembly（`md-kernel`） |

生产依赖见 [package.json](package.json)。

---

## 目录结构

```
md-editor/
├─ index.html              应用入口（Web 与 Electron 共用）
├─ src/
│  ├─ main.ts              应用装配：引擎、UI 壳、文件 IO、快捷键
│  ├─ engine/              ★ 编辑引擎（不依赖任何 UI 框架，可独立测试）
│  │  ├─ model/            块树 DocumentModel、Markdown ↔ 块树映射
│  │  ├─ render/           按块增量渲染 BlockRenderer、行内渲染、各块渲染器
│  │  ├─ input/            InputController（按键分流）、format（结构转换）、commands
│  │  ├─ selection/        DOM 选区 ↔ 逻辑位置映射
│  │  ├─ history/          事务化 undo/redo
│  │  ├─ wasm/             Rust 内核加载与高度索引（kernel.ts / kernel-bytes.ts）
│  │  └─ workers/          大文档解析/序列化 Worker
│  ├─ syntax/              markdown-it 封装 + 导出渲染（唯一允许操作 markdown-it 的层）
│  │  ├─ markdown.ts       解析 tokens、行内 tokens、导出静态 HTML（renderExportHtml）
│  │  └─ highlight.ts      highlight.js 装饰式高亮
│  ├─ ui/                  应用层：菜单/工具栏/状态栏/大纲、文件 IO、源码模式、
│  │                       快捷键、对话框、导出进度、打印文档构建
│  └─ styles/              base / tokens / theme / app 样式
├─ electron/
│  ├─ main.cjs             主进程：窗口、原生菜单 IPC、文件 IO、PDF 导出、关闭确认
│  └─ preload.cjs          contextBridge 安全白名单桥（window.desktop）
├─ tests/                  Vitest 用例（引擎 / 语法 / 选区 / 输入 / UI / 性能 / WASM）
├─ scripts/                WASM 内核拷贝与校验脚本
├─ wasm/md-kernel/         Rust 内核源码（Fenwick + 二分）
├─ docs/decisions/         ADR 架构决策记录
└─ DEVELOPMENT.md          ★ 开发基准文档（实现与文档冲突时先改文档）
```

分层依赖方向：`应用层(src/ui, main.ts) → 引擎层(src/engine) → 语法层(src/syntax)`，禁止反向引用；渲染层不得直接操作 markdown-it 实例。

---

## 快速开始

### 环境要求

- Node.js ≥ 20.19
- 桌面端打包另需：Electron（随依赖安装）、electron-builder
- 重新构建 WASM 内核（可选）另需：Rust 工具链 + `wasm32-unknown-unknown` target

### 安装

```bash
npm install
```

### Web 开发

```bash
npm run dev        # 启动 Vite（http://localhost:5173），带 HMR
npm run build      # 类型检查 + 生产构建（产物在 dist/）
npm run preview    # 预览生产构建
```

### 桌面端（Electron）

```bash
npm run electron:dev     # 并行启动 Vite 与 Electron（开发）
npm run electron:smoke   # 构建后冒烟启动（自动退出，CI 用）
npm run electron:build   # 构建并打包 Windows 安装包（产物在 release/）
```

### 测试

```bash
npm test           # Vitest 单次运行
npm run test:watch # 监听模式
```

### 重建 WASM 内核（可选）

```bash
npm run wasm:build # cargo 构建 md-kernel → 拷贝内嵌 → Node 校验
```

---

## 使用与快捷键

| 快捷键                               | 功能                   |
| ------------------------------------ | ---------------------- |
| `Ctrl+N`                           | 新建                   |
| `Ctrl+O`                           | 打开                   |
| `Ctrl+S`                           | 保存                   |
| `Ctrl+P`                           | 导出 / 打印（PDF）     |
| `Ctrl+/`                           | 切换源码模式           |
| `Ctrl+B` / `Ctrl+I` / `Ctrl+K` | 加粗 / 斜体 / 插入链接 |
| `Ctrl+A`                           | 跨块全选               |
| `Ctrl+1`–`Ctrl+6` / `Ctrl+0`  | 设为 H1–H6 / 段落     |
| `Ctrl+Z` / `Ctrl+Y`              | 撤销 / 重做            |

其他：`Enter` 续列表、`Tab` 列表缩进、输入 `# ` / `- ` / `> ` / ```` ` 等前缀即时转换结构。

---

## 架构概览

核心数据流（详见 [DEVELOPMENT.md](DEVELOPMENT.md) 第 4 节）：

```
击键 → InputController 分流（IME 合成期间冻结渲染）
     → Transaction 提交 DocumentModel（块树变更 + 历史入栈）
     → BlockRenderer.renderBlocks(dirtyIds)  只重渲染受影响块
     → SelectionMapper.restore(captured)     光标恢复到新 DOM
```

约定：**块树是唯一数据源**，DOM 只是它的投影；每个块节点挂 `data-block-id` 作为增量渲染与光标恢复的锚点；一次用户操作 = 一个事务 = 一次渲染调度 + 一条 undo 记录。

---

## 导出 PDF / HTML

- **HTML**：由 Markdown 源码经 `syntax/markdown.ts` 渲染为自包含 HTML 后下载。
- **PDF（桌面端）**：从 Markdown 源码直接渲染出干净的自包含打印 HTML（数学块经 KaTeX、代码块经 highlight.js、Mermaid 内联为 SVG，**不经编辑器实时 DOM**），分块流式写入临时文件，再由隐藏窗口 `printToPDF` 生成，最后定位到输出文件。大文档不再阻塞主窗口。
- **PDF（浏览器端）**：同上生成打印 HTML，由隐藏 iframe 承载后调起系统打印。

---

## 文档

- [DEVELOPMENT.md](DEVELOPMENT.md)：开发基准文档——功能范围、技术选型、架构、数据模型、里程碑与完整变更记录（截至 v0.11）。
- [docs/decisions/](docs/decisions)：架构决策记录（ADR），例如 WASM 优化方案。
