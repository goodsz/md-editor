import { renderExportHtml } from '../syntax/markdown';

/**
 * 打印文档构建（方案 A）：直接从 Markdown 源码生成自包含静态 HTML，
 * 完全不依赖编辑器实时 DOM（无虚拟化、无 .md-token 标记 span、无深克隆）。
 * 数学块 KaTeX、代码高亮在源码渲染阶段物化；mermaid 图在此处异步替换为内联 SVG。
 *
 * 版式来源：复用页面已加载的样式表（dev 内联 cssText / dist 外链绝对 URL），
 * 由此免费获得 KaTeX 与 highlight.js 配色；本文件补充标准标签排版。
 */

interface CollectedStyles {
  /** 内联 <style> 的 cssText */
  inline: string;
  /** 外链样式表绝对 URL（file:///…/assets/index-xxx.css 等） */
  links: string[];
}

/** 收集页面样式表：dev 为注入的 <style>（内联 cssText），dist 为 <link>（绝对 URL） */
function collectStyles(): CollectedStyles {
  const inline: string[] = [];
  const links: string[] = [];
  for (const sheet of Array.from(document.styleSheets)) {
    const owner = sheet.ownerNode as HTMLElement | null;
    if (owner && owner.tagName === 'STYLE') {
      try {
        inline.push(Array.from(sheet.cssRules).map((r) => r.cssText).join('\n'));
      } catch {
        // 跨源样式表读不到规则：忽略
      }
    } else if (sheet.href) {
      links.push(sheet.href);
    }
  }
  return { inline: inline.join('\n'), links };
}

/** 打印版式补充（标准标签排版；导出元素用 md-export-* 专属类名避免与编辑器规则冲突） */
const PRINT_CSS =
  '*{box-sizing:border-box}' +
  'html,body{margin:0;padding:0;background:#fff}' +
  '@page{size:A4}' +
  'body{color:#24292f;-webkit-font-smoothing:antialiased;' +
  "font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC','Hiragino Sans GB','Microsoft YaHei',sans-serif;" +
  'font-size:16px;line-height:1.75;padding:0 8px}' +
  'h1,h2,h3,h4,h5,h6{font-weight:600;line-height:1.3;margin:0.9em 0 0.5em;break-after:avoid}' +
  'h1{font-size:1.9em;border-bottom:1px solid #d0d7de;padding-bottom:0.25em}' +
  'h2{font-size:1.5em;border-bottom:1px solid #d0d7de;padding-bottom:0.2em}' +
  'h3{font-size:1.25em}h4{font-size:1.1em}h5{font-size:1em}h6{font-size:0.95em;color:#57606a}' +
  'p{margin:0 0 0.8em}' +
  'a{color:#0969da;text-decoration:none}' +
  'strong{font-weight:600}' +
  'del{text-decoration:line-through}' +
  'ul,ol{margin:0 0 0.8em;padding-left:1.6em}li{margin:0.15em 0}li>ul,li>ol{margin:0.2em 0}' +
  'blockquote{margin:0 0 0.8em;padding:0.2em 1em;border-left:4px solid #d0d7de;color:#57606a}' +
  'blockquote>:last-child{margin-bottom:0}' +
  'hr{border:none;height:2px;background:#d0d7de;margin:1.2em 0}' +
  "code{font-family:'SFMono-Regular',Consolas,'Liberation Mono',Menlo,monospace;font-size:0.9em}" +
  ':not(pre)>code{background:#f6f8fa;color:#cf222e;padding:0.15em 0.4em;border-radius:4px}' +
  'pre.md-export-pre{background:#f6f8fa;border-radius:6px;padding:12px 16px;overflow:auto;margin:0 0 0.8em}' +
  'pre.md-export-pre code{display:block;line-height:1.6;color:#24292f;white-space:pre}' +
  'table{border-collapse:collapse;margin:0 0 0.8em}' +
  'table th,table td{border:1px solid #d0d7de;padding:6px 13px}' +
  'table th{background:#f6f8fa;font-weight:600}' +
  'img{max-width:100%;vertical-align:middle;border-radius:4px;break-inside:avoid}' +
  '.md-export-task{vertical-align:middle;margin:0 0.5em 0 0.1em}' +
  '.md-export-math{margin:0 0 0.8em;text-align:center;overflow-x:auto}' +
  '.md-export-mermaid{margin:0 0 1em;text-align:center}' +
  '.md-export-mermaid svg{max-width:100%;height:auto}' +
  '.md-export-mermaid-error,.md-export-math-error{color:#cf222e;font-size:0.9em}' +
  // highlight.js 浅色配色（页面样式表未加载时的兜底）
  '.hljs-keyword,.hljs-selector-tag{color:#d73a49}' +
  '.hljs-string,.hljs-regexp{color:#032f62}' +
  '.hljs-comment,.hljs-quote{color:#6a737d;font-style:italic}' +
  '.hljs-number,.hljs-literal,.hljs-built_in{color:#005cc5}' +
  '.hljs-title,.hljs-title.function_,.hljs-title.class_,.hljs-function{color:#6f42c1}' +
  '.hljs-attr,.hljs-attribute,.hljs-variable,.hljs-template-variable{color:#e36209}' +
  '.hljs-tag .hljs-name,.hljs-tag{color:#22863a}' +
  '.hljs-meta,.hljs-symbol,.hljs-bullet{color:#005cc5}' +
  '.hljs-section,.hljs-name{color:#22863a}' +
  '.hljs-type,.hljs-class .hljs-title{color:#6f42c1}' +
  '.hljs-addition{color:#22863a;background:#f0fff4}' +
  '.hljs-deletion{color:#b31d28;background:#ffeef0}' +
  '.hljs-emphasis{font-style:italic}.hljs-strong{font-weight:600}';

type Mermaid = typeof import('mermaid')['default'];

let mermaidLoader: Promise<Mermaid> | null = null;

/** mermaid 懒加载（导出固定浅色主题） */
function loadMermaid(): Promise<Mermaid> {
  if (!mermaidLoader) {
    mermaidLoader = import('mermaid').then((m) => {
      const mermaid = m.default;
      mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: 'default' });
      return mermaid;
    });
  }
  return mermaidLoader;
}

/** 单张 mermaid 图 → SVG 字符串（失败降级为错误占位，不阻塞导出） */
async function renderMermaid(code: string, seq: number): Promise<string> {
  try {
    const mermaid = await loadMermaid();
    const { svg } = await mermaid.render('md-export-mm-' + seq + '-' + Date.now(), code);
    return svg;
  } catch {
    return '<pre class="md-export-mermaid-error">[图表语法错误]</pre>';
  }
}

const MERMAID_PLACEHOLDER_RE = /<div class="md-export-mermaid" data-mermaid-idx="(\d+)"><\/div>/g;

/** 组装自包含打印文档 */
function wrapDocument(bodyHtml: string, styles: CollectedStyles): string {
  const linksHtml = styles.links
    .map((h) => '<link rel="stylesheet" href="' + h.replace(/"/g, '%22') + '">')
    .join('\n');
  return (
    '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>print</title>' +
    '<style>' + styles.inline + '</style>' +
    linksHtml +
    '<style>' + PRINT_CSS + '</style>' +
    '</head><body>' + bodyHtml + '</body></html>'
  );
}

/**
 * Markdown 源码 → 自包含打印 HTML。mermaid 占位由内联 SVG 一次性替换
 * （单次正则替换，O(n)，避免逐图字符串扫描的平方级开销）。
 * @param onMermaid 逐张图表渲染进度回调（done/total），用于进度条
 */
export async function buildPrintHtml(
  md: string,
  onMermaid?: (done: number, total: number) => void,
): Promise<string> {
  const styles = collectStyles();
  const { html, mermaid } = renderExportHtml(md);
  if (mermaid.length === 0) return wrapDocument(html, styles);
  const svgs = new Array<string>(mermaid.length);
  for (let i = 0; i < mermaid.length; i++) {
    svgs[i] = await renderMermaid(mermaid[i], i);
    onMermaid?.(i + 1, mermaid.length);
  }
  const body = html.replace(MERMAID_PLACEHOLDER_RE, (full, idx) => svgs[Number(idx)] ?? full);
  return wrapDocument(body, styles);
}
