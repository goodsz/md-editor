import { BlockEngine } from '../engine';
import { newId, type LogicalSelection, type Transaction } from '../engine/model/types';
import {
  clearFormatting,
  insertCodeBlock,
  insertHr,
  insertLink,
  insertMathBlock,
  insertTable,
  makeList,
  setHeading,
  toggleInlineMark,
  wrapQuote,
} from '../engine/input/format';
import { textLeafIds } from '../engine/input/commands';
import { renderToHtml } from '../syntax/markdown';
import { showProgress } from './progress';
import { buildPrintHtml } from './printExport';
import type { SourceMode } from './sourceMode';
import type { FileIO } from './fileIO';

export interface ActionDeps {
  engine: BlockEngine;
  fileIO: FileIO;
  sourceMode: SourceMode;
  /** 应用内输入对话框（替代 window.prompt：桌面端不支持） */
  prompt: (message: string, defaultValue?: string) => Promise<string | null>;
  refreshStatus: () => void;
  toggleOutline: () => void;
}

export interface ActionRegistry {
  run(actionId: string): void;
  runFormat(kind: 'bold' | 'italic' | 'link'): void;
  /** 文件打开/拖拽后的加载入口；adoptState=true 时接管文件状态 */
  loadDoc(name: string, md: string, adoptState?: boolean): void;
  /** 大文件异步加载（解析在 Worker） */
  loadDocAsync(name: string, md: string, adoptState?: boolean): Promise<void>;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

const EXPORT_CSS =
  "body{max-width:820px;margin:40px auto;padding:0 20px;font-family:system-ui,-apple-system,'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif;line-height:1.7;color:#24292f}pre{background:#f6f8fa;padding:12px;border-radius:6px;overflow:auto}code{background:#f6f8fa;padding:2px 5px;border-radius:3px;font-size:.9em}blockquote{border-left:4px solid #d0d7de;margin:0;padding:0 1em;color:#57606a}table{border-collapse:collapse}th,td{border:1px solid #d0d7de;padding:6px 12px}img{max-width:100%}h1,h2{border-bottom:1px solid #d0d7de;padding-bottom:.25em}";

/** PDF 打印 HTML 分块写入尺寸（256KB，限制单次 IPC 消息与内存峰值） */
const PDF_CHUNK = 256 * 1024;

export function createActions(deps: ActionDeps): ActionRegistry {
  const { engine, fileIO, sourceMode, prompt, refreshStatus, toggleOutline } = deps;

  /** 空文档兜底：保证至少一个可编辑段落 */
  const ensureNonEmpty = (): void => {
    if (engine.model.getRoot().length === 0) {
      const id = newId();
      engine.applyTransaction({
        ops: [{ type: 'insert', after: null, block: { id, type: 'paragraph', text: '' } }],
        selection: { anchor: { blockId: id, offset: 0 }, focus: { blockId: id, offset: 0 } },
      });
    }
  };

  /**
   * 加载文档内容。
   * @param adoptState true 时同时接管文件状态（新建/拖拽场景）；
   *                   false 表示文件状态已由 FileIO（打开对话框）设置，保留回写句柄。
   */
  const loadDoc = (name: string, md: string, adoptState = false): void => {
    if (sourceMode.isActive) sourceMode.exit();
    if (adoptState) fileIO.adopt(name);
    engine.loadMarkdown(md);
    ensureNonEmpty();
    engine.focusStart();
    document.title = fileIO.fileName + ' - md-editor';
    refreshStatus();
  };

  /** 大文件：解析移至 Worker，加载完成后与 loadDoc 相同的收尾；
   *  Worker 解析失败自动回退主线程同步解析（防打开空白） */
  const loadDocAsync = async (name: string, md: string, adoptState = false): Promise<void> => {
    if (sourceMode.isActive) sourceMode.exit();
    if (adoptState) fileIO.adopt(name);
    try {
      await engine.loadMarkdownAsync(md);
    } catch {
      engine.loadMarkdown(md);
    }
    ensureNonEmpty();
    engine.focusStart();
    document.title = fileIO.fileName + ' - md-editor';
    refreshStatus();
  };

  const apply = (tx: Transaction | null): void => {
    if (!tx) return;
    engine.applyTransaction(tx);
    refreshStatus();
  };

  const withSelection = (fn: (sel: LogicalSelection) => Transaction | null): void => {
    const selection = engine.getSelection();
    if (selection) apply(fn(selection));
  };

  const withFocusBlock = (fn: (blockId: string) => Transaction | null): void => {
    withSelection((sel) => fn(sel.focus.blockId));
  };

  const setTheme = (theme: 'light' | 'dark'): void => {
    document.documentElement.dataset['theme'] = theme;
    // 桌面端同步原生标题栏/窗口背景
    fileIO.getBridge()?.setTheme(theme);
    try {
      localStorage.setItem('md-editor:theme', theme);
    } catch {
      // 忽略
    }
  };

  const handlers: Record<string, () => void> = {
    // 文件
    'file.new': () => loadDoc('未命名.md', '', true),
    'file.open': () => void fileIO.open(),
    'file.save': () => void fileIO.save(),
    'file.saveAs': () => void fileIO.saveAs(),
    'file.exportHtml': () => {
      const name = fileIO.fileName.replace(/\.(md|markdown|txt)$/i, '') + '.html';
      const md = sourceMode.isActive ? sourceMode.getText() : engine.getMarkdown();
      const html =
        '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>' +
        escapeHtml(fileIO.fileName) +
        '</title><style>' +
        EXPORT_CSS +
        '</style></head><body>' +
        renderToHtml(md) +
        '</body></html>';
      fileIO.download(name, html);
    },
    'file.print': () => {
      void (async () => {
        // 方案 A：从 Markdown 源码直接生成自包含打印 HTML，不经编辑器实时 DOM。
        // 源码模式下无需退出：直接读 textarea 最新内容
        const md = sourceMode.isActive ? sourceMode.getText() : engine.getMarkdown();
        const progress = showProgress('导出 / 打印（PDF）');
        let cancelled = false;
        progress.onCancel(() => {
          cancelled = true;
        });
        const mermaidLabel = (done: number, total: number): string =>
          '渲染图表 ' + done + '/' + total + '…';
        try {
          if (fileIO.isDesktop) {
            // 桌面端：源码渲染 → 分块流式写入临时 HTML → 隐藏窗口 printToPDF
            progress.set(4, '准备导出…');
            const id = await fileIO.pdfBegin(fileIO.fileName);
            if (!id) {
              progress.set(100, '已取消');
              return;
            }
            let finished = false;
            try {
              progress.set(10, '渲染文档 HTML…');
              const html = await buildPrintHtml(md, (done, total) => {
                if (!cancelled) progress.set(10 + Math.round((done / total) * 50), mermaidLabel(done, total));
              });
              if (cancelled) return;
              progress.lockCancel(); // 已开始写临时文件，无法安全中止
              progress.set(65, '写入临时文件…');
              for (let i = 0; i < html.length; i += PDF_CHUNK) {
                await fileIO.pdfChunk(id, html.slice(i, i + PDF_CHUNK));
              }
              progress.set(85, '生成 PDF 文件…');
              await fileIO.pdfEnd(id);
              finished = true;
            } finally {
              if (!finished) await fileIO.pdfAbort(id);
            }
          } else {
            // 浏览器端：源码渲染 → 隐藏 iframe 承载打印 HTML 后调起打印
            progress.set(10, '渲染文档 HTML…');
            const html = await buildPrintHtml(md, (done, total) => {
              if (!cancelled) progress.set(10 + Math.round((done / total) * 50), mermaidLabel(done, total));
            });
            if (cancelled) return;
            progress.lockCancel();
            progress.set(75, '调起打印…');
            fileIO.printBrowser(html);
          }
          if (!cancelled) progress.set(100, '导出完成');
        } catch (err) {
          console.error('[md-editor] 导出失败', err);
          if (!cancelled) progress.set(100, '导出失败，请重试');
        } finally {
          setTimeout(() => progress.close(), cancelled ? 0 : 400);
        }
      })();
    },
    // 编辑
    'edit.undo': () => {
      engine.undo();
      refreshStatus();
    },
    'edit.redo': () => {
      engine.redo();
      refreshStatus();
    },
    'edit.selectAll': () => {
      const leaves = textLeafIds(engine.model);
      if (leaves.length === 0) return;
      const first = leaves[0];
      const last = leaves[leaves.length - 1];
      // 先聚焦选区末端宿主再设跨块选区：聚焦会重置既有选区，顺序不能反
      engine.restoreSelection({
        anchor: { blockId: last, offset: 0 },
        focus: { blockId: last, offset: 0 },
      });
      engine.focusCurrent();
      engine.restoreSelection({
        anchor: { blockId: first, offset: 0 },
        focus: { blockId: last, offset: engine.getLeafLength(last) },
      });
    },
    // 段落
    'p.paragraph': () => withFocusBlock((id) => setHeading(engine.model, id, 0)),
    'p.h1': () => withFocusBlock((id) => setHeading(engine.model, id, 1)),
    'p.h2': () => withFocusBlock((id) => setHeading(engine.model, id, 2)),
    'p.h3': () => withFocusBlock((id) => setHeading(engine.model, id, 3)),
    'p.h4': () => withFocusBlock((id) => setHeading(engine.model, id, 4)),
    'p.h5': () => withFocusBlock((id) => setHeading(engine.model, id, 5)),
    'p.h6': () => withFocusBlock((id) => setHeading(engine.model, id, 6)),
    'p.quote': () => withFocusBlock((id) => wrapQuote(engine.model, id)),
    'p.bullet': () => withFocusBlock((id) => makeList(engine.model, id, false)),
    'p.ordered': () => withFocusBlock((id) => makeList(engine.model, id, true)),
    'p.task': () => withFocusBlock((id) => makeList(engine.model, id, false, false)),
    'p.code': () => withFocusBlock((id) => insertCodeBlock(engine.model, id)),
    'p.math': () => withFocusBlock((id) => insertMathBlock(engine.model, id)),
    'p.table': () => withFocusBlock((id) => insertTable(engine.model, id)),
    'p.hr': () => withFocusBlock((id) => insertHr(engine.model, id)),
    // 格式
    'f.bold': () => withSelection((sel) => toggleInlineMark(engine.model, sel, '**')),
    'f.italic': () => withSelection((sel) => toggleInlineMark(engine.model, sel, '*')),
    'f.strike': () => withSelection((sel) => toggleInlineMark(engine.model, sel, '~~')),
    'f.code': () => withSelection((sel) => toggleInlineMark(engine.model, sel, '`')),
    'f.link': () => {
      // 对话框会夺走编辑焦点：先捕获逻辑选区，确认后恢复再插入
      const captured = engine.getSelection();
      void prompt('链接地址：', 'https://').then((url) => {
        if (!url || !captured) return;
        engine.restoreSelection(captured);
        engine.focusCurrent();
        // 跨块选区收敛到焦点位置（链接作用于单块）
        const sel: LogicalSelection =
          captured.anchor.blockId === captured.focus.blockId
            ? captured
            : { anchor: captured.focus, focus: captured.focus };
        apply(insertLink(engine.model, sel, url));
      });
    },
    'f.clear': () => withSelection((sel) => clearFormatting(engine.model, sel)),
    // 视图 / 主题
    'view.source': () => sourceMode.toggle(),
    'view.outline': () => toggleOutline(),
    'theme.light': () => setTheme('light'),
    'theme.dark': () => setTheme('dark'),
  };

  return {
    run(actionId: string): void {
      handlers[actionId]?.();
    },
    runFormat(kind): void {
      if (kind === 'bold') handlers['f.bold']();
      else if (kind === 'italic') handlers['f.italic']();
      else handlers['f.link']();
    },
    loadDoc,
    loadDocAsync,
  };
}
