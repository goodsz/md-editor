import MarkdownIt from 'markdown-it';
import type { Env, MarkdownIt as MarkdownItInstance, StateCore } from 'markdown-it';
import katex from 'katex';
import { highlightToHtml } from './highlight';

/**
 * 语法层唯一入口（依赖红线）：渲染层不得直接操作 markdown-it 实例，
 * 必须经由本模块导出的函数。
 */
const mdOptions = { html: true, linkify: false, typographer: false };

/** 块级状态的窄化视图（避免依赖 markdown-it 内部模块路径） */
interface BlockStateLike {
  src: string;
  bMarks: number[];
  eMarks: number[];
  tShift: number[];
  blkIndent: number;
  line: number;
  push(
    type: string,
    tag: string,
    nesting: number,
  ): { block?: boolean; markup?: string; content: string; map?: [number, number] | null };
}

/**
 * 数学块规则：$$ … $$（单行或独立行围栏），插在 fence 之前。
 * 产出 math_block token，content 为公式源码。
 */
function mathBlockRule(
  state: BlockStateLike,
  startLine: number,
  endLine: number,
  silent: boolean,
): boolean {
  const startPos = state.bMarks[startLine] + state.tShift[startLine];
  const startMax = state.eMarks[startLine];
  if (startPos + 2 > startMax) return false;
  if (
    state.src.charCodeAt(startPos) !== 0x24 /* $ */ ||
    state.src.charCodeAt(startPos + 1) !== 0x24
  ) {
    return false;
  }

  const firstRaw = state.src.slice(startPos + 2, startMax);

  // 单行：$$ tex $$
  if (firstRaw.trimEnd().endsWith('$$')) {
    const content = firstRaw.trimEnd().slice(0, -2).trim();
    if (silent) return true;
    const token = state.push('math_block', 'math', 0);
    token.block = true;
    token.markup = '$$';
    token.content = content;
    token.map = [startLine, startLine + 1];
    state.line = startLine + 1;
    return true;
  }

  // 多行：$$ / … / $$
  let found = false;
  let next = startLine + 1;
  let lastLine: string | null = null;
  for (; next < endLine; next++) {
    const pos = state.bMarks[next] + state.tShift[next];
    const max = state.eMarks[next];
    const line = state.src.slice(pos, max);
    if (line.trimEnd().endsWith('$$')) {
      lastLine = line.slice(0, line.trimEnd().length - 2);
      found = true;
      next += 1;
      break;
    }
  }
  if (!found) return false;
  if (silent) return true;

  const parts: string[] = [];
  if (firstRaw.trim() !== '') parts.push(firstRaw.trim());
  for (let l = startLine + 1; l < next - 1; l++) {
    const p = state.bMarks[l] + state.tShift[l];
    const m = state.eMarks[l];
    parts.push(state.src.slice(p, m));
  }
  if (lastLine !== null && lastLine.trim() !== '') parts.push(lastLine.trimEnd());

  const token = state.push('math_block', 'math', 0);
  token.block = true;
  token.markup = '$$';
  token.content = parts.join('\n');
  token.map = [startLine, next];
  state.line = next;
  return true;
}

/** 为实例挂载数学块规则（编辑器解析实例与导出渲染实例共用） */
function addMathBlockRule(m: MarkdownItInstance): void {
  m.block.ruler.before('fence', 'math_block', mathBlockRule, {
    alt: ['paragraph', 'reference', 'blockquote', 'list'],
  });
}

/** 编辑器解析实例（只用于解析，不参与渲染） */
const md = new MarkdownIt(mdOptions);
addMathBlockRule(md);

export type MdToken = ReturnType<typeof md.parse>[number];

/** 解析 markdown 源码为顶层 token 流 */
export function parseTokens(src: string): MdToken[] {
  return md.parse(src, {});
}

/** 解析行内文本为行内 token 流（供行内渲染器构建 DOM 使用） */
export function parseInlineTokens(text: string): MdToken[] {
  const tokens = md.parseInline(text, {});
  return tokens[0]?.children ?? [];
}

/** 导出用：渲染完整 HTML（不经编辑器渲染管线；不含 KaTeX/mermaid/高亮物化） */
export function renderToHtml(src: string): string {
  return md.render(src, {});
}

// ------------------------------------------------------------
// 导出渲染（方案 A）：Markdown 源码 → 自包含静态 HTML
// 完全不依赖编辑器实时 DOM；数学块经 KaTeX 物化，代码块经 hljs 高亮，
// mermaid 图输出占位节点由 UI 层异步替换为 SVG。
// ------------------------------------------------------------

/** 导出渲染环境：收集 mermaid 图源码（供 UI 层异步物化） */
interface ExportEnv extends Env {
  mermaid: string[];
  mermaidSeq: number;
}

/** 导出占位：UI 层按 data-mermaid-idx 顺序替换为内联 SVG */
function mermaidPlaceholder(index: number): string {
  return '<div class="md-export-mermaid" data-mermaid-idx="' + index + '"></div>\n';
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

const exportMd = new MarkdownIt(mdOptions);
addMathBlockRule(exportMd);

// 围栏代码：mermaid 出占位；其余经 hljs 高亮（未注册语言回退纯文本）
exportMd.renderer.rules.fence = (tokens, idx, _options, env) => {
  const token = tokens[idx];
  const lang = (token.info || '').trim().split(/\s+/)[0].toLowerCase();
  if (lang === 'mermaid') {
    const e = env as ExportEnv;
    const i = e.mermaidSeq++;
    e.mermaid.push(token.content);
    return mermaidPlaceholder(i);
  }
  const safeLang = lang.replace(/[^a-z0-9_+#.-]/gi, '');
  const body = highlightToHtml(token.content, lang) ?? escapeHtml(token.content);
  const cls = safeLang ? ' class="language-' + safeLang + '"' : '';
  return '<pre class="md-export-pre"><code' + cls + '>' + body + '</code></pre>\n';
};

// 数学块：KaTeX 物化为静态 HTML（失败降级为源码文本）
exportMd.renderer.rules.math_block = (tokens, idx) => {
  const tex = tokens[idx].content;
  try {
    return (
      '<div class="md-export-math">' +
      katex.renderToString(tex, { throwOnError: false, displayMode: true }) +
      '</div>\n'
    );
  } catch {
    return '<div class="md-export-math"><pre>' + escapeHtml(tex) + '</pre></div>\n';
  }
};

/** 任务列表：列表项以 [ ] / [x] 开头时插入禁用态复选框（对齐编辑器观感） */
function taskListRule(state: StateCore): void {
  const tokens = state.tokens;
  for (let i = 2; i < tokens.length; i++) {
    const inline = tokens[i];
    if (inline.type !== 'inline') continue;
    const itemOpen = tokens[i - 2];
    if (!itemOpen || itemOpen.type !== 'list_item_open') continue;
    const m = /^\[([ xX])\]\s/.exec(inline.content);
    if (!m) continue;
    const checked = m[1].toLowerCase() === 'x';
    const first = inline.children?.[0];
    if (first && first.type === 'text') {
      first.content = first.content.replace(/^\[[ xX]\]\s/, '');
    }
    inline.content = inline.content.replace(/^\[[ xX]\]\s/, '');
    const box = new state.Token('html_inline', '', 0);
    box.content =
      '<input class="md-export-task" type="checkbox" disabled' + (checked ? ' checked' : '') + '> ';
    (inline.children ?? []).unshift(box);
  }
}

exportMd.core.ruler.after('inline', 'export_task_list', taskListRule);

export interface ExportHtml {
  /** 自包含静态 HTML（含占位节点，未含 mermaid SVG） */
  html: string;
  /** mermaid 图源码（按占位 data-mermaid-idx 顺序） */
  mermaid: string[];
}

/** 导出渲染：Markdown 源码 → 静态 HTML + mermaid 源码清单 */
export function renderExportHtml(src: string): ExportHtml {
  const env: ExportEnv = { mermaid: [], mermaidSeq: 0 };
  const html = exportMd.render(src, env);
  return { html, mermaid: env.mermaid };
}
