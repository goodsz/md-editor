import './styles/base.css';
import './styles/tokens.css';
import './styles/theme.css';
import './styles/app.css';
import 'katex/dist/katex.min.css';

import { BlockEngine } from './engine';
import { createActions } from './ui/actions';
import { buildMenubar, buildToolbar } from './ui/menubar';
import { buildStatusbar } from './ui/statusbar';
import { SourceMode } from './ui/sourceMode';
import { FileIO } from './ui/fileIO';
import { initShortcuts } from './ui/shortcuts';
import { OutlinePanel } from './ui/outline';
import { initTableContextMenu } from './ui/tableMenu';
import { askText } from './ui/dialog';

// v2：废弃 v1 缓存（v1 默认文档含外链图片会挂起 load 事件）
const STORE_KEY = 'md-editor:doc:v2';
const THEME_KEY = 'md-editor:theme';
const OUTLINE_KEY = 'md-editor:outline';

const DEFAULT_DOC = `# md-editor

Typora 风格的**所见即所得** Markdown 编辑器。

## 快速上手

- 输入 "# " 变标题，"- " 变列表，"> " 变引用
- 输入 \`\`\` 后回车创建代码块
- **加粗** *斜体* ~~删除线~~ \`行内代码\`
- [链接](https://example.com) 与 ![示例图片](data:image/svg+xml,%3Csvg%20xmlns='http://www.w3.org/2000/svg'%20width='160'%20height='80'%3E%3Crect%20width='100%25'%20height='100%25'%20rx='6'%20fill='%230969da'/%3E%3Ctext%20x='50%25'%20y='50%25'%20fill='white'%20text-anchor='middle'%20dominant-baseline='middle'%20font-size='14'%3E%E7%A4%BA%E4%BE%8B%E5%9B%BE%E7%89%87%3C/text%3E%3C/svg%3E)
- [x] 任务列表项
- [ ] 另一个任务

> 引用块支持多段内容
>
> 二级嵌套引用

1. 有序列表
2. 继续编号

数学块（光标进入显示源码，移开即渲染）：

$$c^2 = a^2 + b^2$$

\`\`\`mermaid
graph LR
  A[输入] --> B[解析]
  B --> C[渲染]
  C --> D[导出]
\`\`\`

---

普通段落，支持软换行（Shift+Enter）。
第二行内容。
`;

function main(): void {
  const app = document.getElementById('app');
  const root = document.getElementById('editor-root');
  const workspace = document.getElementById('workspace');
  const editorPane = document.getElementById('editor-pane');
  const outlineEl = document.getElementById('outline');
  const menubarEl = document.getElementById('menubar');
  const toolbarEl = document.getElementById('toolbar');
  const statusbarEl = document.getElementById('statusbar');
  const modeBtn = document.getElementById('mode-btn');
  const sourceEl = document.getElementById('source-editor') as HTMLTextAreaElement | null;
  const fileInput = document.getElementById('file-fallback') as HTMLInputElement | null;
  if (
    !app ||
    !root ||
    !workspace ||
    !editorPane ||
    !outlineEl ||
    !menubarEl ||
    !toolbarEl ||
    !statusbarEl ||
    !modeBtn ||
    !sourceEl ||
    !fileInput
  ) {
    throw new Error('应用壳 DOM 缺失');
  }

  // 主题
  try {
    const theme = localStorage.getItem(THEME_KEY);
    if (theme === 'dark' || theme === 'light') {
      document.documentElement.dataset['theme'] = theme;
    }
  } catch {
    // 忽略
  }

  // 初始内容
  let initial = DEFAULT_DOC;
  try {
    const saved = localStorage.getItem(STORE_KEY);
    if (saved !== null) initial = saved;
  } catch {
    // 忽略
  }

  const engine = new BlockEngine(root, initial);
  // 长文档虚拟化：绑定编辑区滚动容器
  engine.attachViewport(editorPane);

  // 源码模式
  const sourceMode = new SourceMode(engine, sourceEl, app, (active) => {
    modeBtn.textContent = active ? '退出源码模式' : '源码模式';
    status.refresh(active ? 'source' : 'wysiwyg', active ? sourceEl.value : undefined);
    if (active) {
      sourceEl.addEventListener('input', onSourceInput);
    } else {
      sourceEl.removeEventListener('input', onSourceInput);
      outline.refresh();
    }
  });
  const onSourceInput = (): void => {
    setDirty(true);
    status.refresh('source', sourceEl.value);
  };

  // 大纲面板（含拖拽调宽分界线）：源码模式下定位到 textarea 对应标题行
  const outline = new OutlinePanel(
    outlineEl,
    engine,
    document.getElementById('outline-resizer'),
    (blockId) => {
      if (sourceMode.isActive) sourceMode.revealTo(blockId);
      else engine.revealBlock(blockId);
    },
  );
  try {
    if (localStorage.getItem(OUTLINE_KEY) === '1') outlineEl.hidden = false;
  } catch {
    // 忽略
  }
  const toggleOutline = (): void => {
    outlineEl.hidden = !outlineEl.hidden;
    try {
      localStorage.setItem(OUTLINE_KEY, outlineEl.hidden ? '0' : '1');
    } catch {
      // 忽略
    }
  };

  // 当前编辑内容统一出口（源码模式下 model 尚未回写，必须读 textarea）
  const currentText = (): string =>
    sourceMode.isActive ? sourceMode.getText() : engine.getMarkdown();

  // 文件 IO
  const fileIO = new FileIO(currentText, fileInput);

  // 脏状态跟踪：编辑置脏，保存/打开后清除；同步到桌面主进程用于关闭确认
  let dirty = false;
  const setDirty = (v: boolean): void => {
    if (dirty === v) return;
    dirty = v;
    fileIO.getBridge()?.setDirty(v);
  };
  fileIO.onSaved = () => setDirty(false);

  // 状态栏（同时驱动大纲刷新：loadMarkdown 不走 onDirty，必须在此挂钩）
  const status = buildStatusbar(statusbarEl, engine);
  const refreshStatus = (): void => {
    if (!sourceMode.isActive) {
      status.refresh('wysiwyg');
      outline.refresh();
    }
  };

  // 动作注册（prompt 用应用内对话框：桌面端不支持 window.prompt）
  const actions = createActions({
    engine,
    fileIO,
    sourceMode,
    prompt: (message, defaultValue) => askText(message, defaultValue ?? ''),
    refreshStatus,
    toggleOutline,
  });
  fileIO.onLoaded = (name, text) => {
    setDirty(false); // 打开新文件即视为干净状态
    // 大文件（>200K 字符）走 Worker 异步解析，避免阻塞主线程
    if (text.length > 200_000) void actions.loadDocAsync(name, text);
    else actions.loadDoc(name, text);
  };
  void actions.loadDoc(fileIO.fileName, initial, true);

  // 菜单栏 / 工具栏 / 快捷键 / 右键菜单
  buildMenubar(menubarEl, (id) => actions.run(id));
  buildToolbar(toolbarEl, (id) => actions.run(id));
  initShortcuts(
    {
      isSourceMode: () => sourceMode.isActive,
      toggleSource: () => sourceMode.toggle(),
      newDoc: () => actions.run('file.new'),
      save: () => void fileIO.save(),
      open: () => void fileIO.open(),
      print: () => actions.run('file.print'),
      selectAll: () => actions.run('edit.selectAll'),
      format: (kind) => actions.runFormat(kind),
      paragraph: (level) =>
        actions.run(level === 0 ? 'p.paragraph' : (`p.h${level}` as string)),
    },
    { nativeMenuKeys: false },
  );
  modeBtn.addEventListener('click', () => sourceMode.toggle());
  initTableContextMenu(root, engine);

  // 拖拽打开本地 .md
  workspace.addEventListener('dragover', (e) => {
    e.preventDefault();
    workspace.classList.add('dragover');
  });
  workspace.addEventListener('dragleave', () => workspace.classList.remove('dragover'));
  workspace.addEventListener('drop', (e) => {
    e.preventDefault();
    workspace.classList.remove('dragover');
    const file = e.dataTransfer?.files?.[0];
    if (file && /\.(md|markdown|txt)$/i.test(file.name)) {
      fileIO.adoptFromFile(file);
    }
  });

  // 自动保存 + 大纲刷新（500ms 防抖；大文档序列化在 Worker 执行）
  let saveTimer: ReturnType<typeof setTimeout> | undefined;
  engine.model.onDirty((dirtyIds) => {
    if (dirtyIds.size > 0) setDirty(true);
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      const write = (md: string): void => {
        try {
          localStorage.setItem(STORE_KEY, md);
        } catch {
          // 忽略写入失败
        }
        if (!sourceMode.isActive) {
          outline.refresh();
          status.refresh('wysiwyg');
        }
      };
      if (sourceMode.isActive) {
        // 源码模式下 model 尚未回写：直接缓存 textarea 内容（意外关闭可恢复）
        write(sourceMode.getText());
        return;
      }
      engine
        .toMarkdownAsync()
        .then(write)
        .catch(() => write(engine.getMarkdown()));
    }, 500);
  });

  // 关闭保护：关闭前同步落盘（防抖窗口内的编辑不丢失）。
  // 注意：仅浏览器端在此拦截未保存关闭；桌面端由主进程原生弹窗确认
  // （渲染层拦截会让主进程选"不保存"后的 win.close() 被静默中止 → 窗口假死）
  window.addEventListener('beforeunload', (e) => {
    try {
      localStorage.setItem(STORE_KEY, currentText());
    } catch {
      // 忽略写入失败
    }
    if (dirty && !fileIO.getBridge()) {
      e.preventDefault();
      e.returnValue = '';
    }
  });

  // 桌面端：主进程关闭确认弹窗选"保存"后触发保存，回报结果决定是否继续关闭
  const bridge = fileIO.getBridge();
  bridge?.onRequestSave(() => {
    void fileIO.save().then((ok) => bridge.saveResult(ok));
  });

  document.title = fileIO.fileName + ' - md-editor';
  engine.focusStart();
  refreshStatus();
  outline.refresh();
  (window as unknown as { __engine?: BlockEngine }).__engine = engine;
}

main();
