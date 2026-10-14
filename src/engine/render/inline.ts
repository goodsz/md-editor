import { parseInlineTokens, type MdToken } from '../../syntax/markdown';

/**
 * 行内渲染：text → markdown-it inline tokens → DOM 片段。
 * 标记符号（**、`、[ 等）渲染为 .md-token span 常驻 DOM，
 * 显隐由 CSS 控制（见 styles/tokens.css），保证 textContent 与块 text 一致。
 *
 * html_inline：白名单标签（font/span/u/b/i/mark 等）真实生效——
 * 开/闭标签源码放进 .md-token（显隐同其他标记），内容包裹进安全元素
 * （属性经白名单清洗，无 innerHTML 注入）；textContent 与源码一致，回写无损。
 */

/** 行内渲染上下文：parent 随容器/html 标签动态变化 */
interface InlineCtx {
  parent: Node;
  htmlStack: HTMLElement[];
  base: Node;
}

const HTML_ALLOWED = new Set([
  'font', 'span', 'u', 'b', 'i', 'em', 'strong', 'mark',
  'sub', 'sup', 'small', 'big', 's', 'strike', 'tt',
]);

export function renderInline(text: string): DocumentFragment {
  const frag = document.createDocumentFragment();
  const ctx: InlineCtx = { parent: frag, htmlStack: [], base: frag };
  const tokens = parseInlineTokens(text);
  walkTokens(tokens, 0, ctx);
  return frag;
}

/** 追加行内内容；空文本用 <br> 撑起空块高度 */
export function appendInline(el: HTMLElement, text: string): void {
  if (text === '') {
    const br = document.createElement('br');
    br.className = 'md-caret-anchor';
    el.appendChild(br);
    return;
  }
  el.appendChild(renderInline(text));
}

/** marker：标记符号 span */
function marker(text: string, tokenType?: string): HTMLElement {
  const span = document.createElement('span');
  span.className = 'md-token';
  span.textContent = text;
  if (tokenType) span.dataset.token = tokenType;
  return span;
}

function closeTypeOf(openType: string): string {
  return openType.replace(/_open$/, '_close');
}

/** 遍历 token 流构建 DOM；遇到 stopAtClose 时返回其下标（不消费） */
function walkTokens(
  tokens: readonly MdToken[],
  start: number,
  ctx: InlineCtx,
  stopAtClose?: string,
): number {
  let i = start;
  while (i < tokens.length) {
    const t = tokens[i];
    if (stopAtClose && t.type === stopAtClose) return i;
    i = emitToken(tokens, i, ctx);
  }
  return i;
}

function emitToken(tokens: readonly MdToken[], i: number, ctx: InlineCtx): number {
  const t = tokens[i];
  const parent = ctx.parent;
  switch (t.type) {
    case 'text':
      parent.appendChild(document.createTextNode(t.content));
      return i + 1;
    case 'softbreak':
    case 'hardbreak':
      // 统一渲染为换行符文本节点，配合 pre-wrap 展示，textContent 可无损回写
      parent.appendChild(document.createTextNode('\n'));
      return i + 1;
    case 'code_inline': {
      parent.appendChild(marker(t.markup || '`', 'code_inline_open'));
      const code = document.createElement('code');
      code.className = 'md-inline-code';
      code.textContent = t.content;
      parent.appendChild(code);
      parent.appendChild(marker(t.markup || '`', 'code_inline_close'));
      return i + 1;
    }
    case 'strong_open':
    case 'em_open':
    case 's_open':
      return emitContainer(tokens, i, ctx);
    case 'link_open':
      return emitLink(tokens, i, ctx);
    case 'image':
      return emitImage(t, parent);
    case 'html_inline':
      return emitHtmlInline(t, i, ctx);
    case 'link_close':
    case 'strong_close':
    case 'em_close':
    case 's_close':
      // 未配对的 close（防御）：跳过
      return i + 1;
    default: {
      // 未知 token：若有 children 递归展开，否则跳过
      if (t.children) {
        walkTokens(t.children, 0, ctx);
      } else if (t.content) {
        parent.appendChild(document.createTextNode(t.content));
      }
      return i + 1;
    }
  }
}

// ------------------------------------------------------------
// html_inline：白名单标签真实生效
// ------------------------------------------------------------

/** 解析标签属性（白名单内安全应用）；值中含危险字符一律丢弃 */
function applySafeAttrs(attrs: string, el: HTMLElement): void {
  const re = /([a-zA-Z-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(attrs)) !== null) {
    const name = m[1].toLowerCase();
    const val = (m[2] ?? m[3] ?? m[4] ?? '').slice(0, 80);
    if (/[<>"'`\\]/.test(val)) continue;
    if (name === 'color') el.style.color = val;
    else if (name === 'size' && /^[1-7]$/.test(val)) {
      el.style.fontSize = (16 + Number(val) * 4) + 'px';
    } else if (name === 'face') el.style.fontFamily = val;
    else if (name === 'style') {
      const color = /(?:^|;)\s*color\s*:\s*([^;{]{1,40})/i.exec(val);
      if (color && !/[<>{}()]/.test(color[1])) el.style.color = color[1].trim();
    }
  }
}

/**
 * html_inline：开/闭标签源码放 .md-token（显隐同其他标记），
 * 内容包裹进白名单安全元素（font color/size/face 等效果生效）。
 * textContent 恒等于源码，回写无损；不匹配/非白名单降级为纯文本。
 */
function emitHtmlInline(t: MdToken, i: number, ctx: InlineCtx): number {
  const src = t.content.trim();
  const m = /^<(\/?)([a-zA-Z][a-zA-Z0-9]*)((?:\s[^<>]*)?)\/?>$/.exec(src);
  if (!m) {
    ctx.parent.appendChild(document.createTextNode(t.content));
    return i + 1;
  }
  const closing = m[1] === '/';
  const tag = m[2].toLowerCase();
  const attrs = m[3] ?? '';

  if (!HTML_ALLOWED.has(tag)) {
    ctx.parent.appendChild(document.createTextNode(t.content));
    return i + 1;
  }

  // 自闭合 / br
  if (tag === 'br' || src.endsWith('/>')) {
    ctx.parent.appendChild(marker(t.content, 'html_inline'));
    ctx.parent.appendChild(document.createElement('br'));
    return i + 1;
  }

  if (!closing) {
    const holder = document.createElement('span');
    holder.className = 'md-html-inline';
    holder.dataset.htmlTag = tag;
    applySafeAttrs(attrs, holder);
    ctx.parent.appendChild(holder);
    holder.appendChild(marker(t.content, 'html_inline_open'));
    ctx.htmlStack.push(holder);
    ctx.parent = holder;
    return i + 1;
  }

  // 闭标签：回退到最近同名开标签
  for (let s = ctx.htmlStack.length - 1; s >= 0; s--) {
    if (ctx.htmlStack[s].dataset.htmlTag === tag) {
      const holder = ctx.htmlStack[s];
      holder.appendChild(marker(t.content, 'html_inline_close'));
      ctx.htmlStack.length = s; // 未配对的中间开标签一并闭合
      ctx.parent = ctx.htmlStack[ctx.htmlStack.length - 1] ?? ctx.base;
      return i + 1;
    }
  }
  // 无配对开标签：纯文本降级
  ctx.parent.appendChild(document.createTextNode(t.content));
  return i + 1;
}

function emitContainer(
  tokens: readonly MdToken[],
  i: number,
  ctx: InlineCtx,
  _stopAtClose?: string,
): number {
  const t = tokens[i];
  const parent = ctx.parent;
  const close = closeTypeOf(t.type);
  const tag = t.type === 'strong_open' ? 'strong' : t.type === 'em_open' ? 'em' : 'del';
  parent.appendChild(marker(t.markup, t.type));
  const el = document.createElement(tag);
  el.dataset.inline = tag;
  parent.appendChild(el);
  const closeIdx = walkTokens(tokens, i + 1, { ...ctx, parent: el }, close);
  parent.appendChild(marker(tokens[closeIdx]?.markup ?? t.markup, close));
  return (closeIdx >= i + 1 ? closeIdx : i) + 1;
}

function emitLink(tokens: readonly MdToken[], i: number, ctx: InlineCtx): number {
  const t = tokens[i];
  const parent = ctx.parent;
  const href = String(t.attrGet('href') ?? '');
  const title = t.attrGet('title');
  if (t.markup === 'autolink') {
    // <https://…> 形式：保留尖括号源码
    parent.appendChild(marker('<', 'link_open'));
    const a = document.createElement('a');
    a.dataset.inline = 'link';
    a.setAttribute('href', href);
    parent.appendChild(a);
    const closeIdx = walkTokens(tokens, i + 1, { ...ctx, parent: a }, 'link_close');
    parent.appendChild(marker('>', 'link_close'));
    return closeIdx + 1;
  }
  parent.appendChild(marker('[', 'link_open'));
  const a = document.createElement('a');
  a.dataset.inline = 'link';
  a.setAttribute('href', href);
  if (title !== null) a.setAttribute('title', String(title));
  parent.appendChild(a);
  const closeIdx = walkTokens(tokens, i + 1, { ...ctx, parent: a }, 'link_close');
  // ](url "title") 全部作为标记 span，textContent 与源码一致
  parent.appendChild(marker('](', 'link_close'));
  const urlText = href + (title ? ` "${title}"` : '');
  parent.appendChild(marker(urlText, 'link_url'));
  parent.appendChild(marker(')', 'link_url_end'));
  return closeIdx + 1;
}

function emitImage(t: MdToken, parent: Node): number {
  const src = String(t.attrGet('src') ?? '');
  const title = t.attrGet('title');
  parent.appendChild(marker('![', 'image_open'));
  parent.appendChild(marker(t.content, 'image_alt'));
  parent.appendChild(marker('](', 'image_src_open'));
  const srcText = src + (title ? ` "${title}"` : '');
  parent.appendChild(marker(srcText, 'image_src'));
  parent.appendChild(marker(')', 'image_src_end'));
  const img = document.createElement('img');
  img.className = 'md-inline-img';
  img.setAttribute('src', src);
  img.setAttribute('alt', t.content);
  if (title !== null) img.setAttribute('title', String(title));
  img.contentEditable = 'false';
  parent.appendChild(img);
  return 1; // image 为单 token
}
