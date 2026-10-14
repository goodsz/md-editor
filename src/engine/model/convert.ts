import type { MdToken } from '../../syntax/markdown';
import type {
  Align,
  Block,
  Doc,
  HeadingLevel,
  ListBlock,
  ListItem,
} from './types';
import { newId } from './types';

// ============================================================
// 解析：markdown-it 顶层 token 流 → 块树
// 映射表见 DEVELOPMENT.md 5.4
// ============================================================

export function tokensToDoc(tokens: MdToken[]): Doc {
  const doc: Doc = [];
  let i = 0;
  while (i < tokens.length) {
    const [block, next] = parseAnyBlock(tokens, i);
    if (block) doc.push(block);
    i = next > i ? next : i + 1; // 防御：保证游标前进
  }
  return doc;
}

function inlineText(tokens: readonly MdToken[], i: number): string {
  const t = tokens[i];
  return t && t.type === 'inline' ? t.content : '';
}

function langOf(info: string): string {
  return info.trim().split(/\s+/)[0] ?? '';
}

/** 解析单个块，返回 [块, 下一个游标] */
function parseAnyBlock(tokens: readonly MdToken[], i: number): [Block | null, number] {
  const t = tokens[i];
  if (!t) return [null, i + 1];
  switch (t.type) {
    case 'paragraph_open':
      return [{ id: newId(), type: 'paragraph', text: inlineText(tokens, i + 1) }, i + 3];
    case 'heading_open': {
      const level = Number(t.tag.slice(1)) as HeadingLevel;
      return [{ id: newId(), type: 'heading', level, text: inlineText(tokens, i + 1) }, i + 3];
    }
    case 'fence':
    case 'code':
      return [{ id: newId(), type: 'code', lang: langOf(t.info), code: t.content }, i + 1];
    case 'math_block':
      return [{ id: newId(), type: 'math', tex: t.content }, i + 1];
    case 'hr':
      return [{ id: newId(), type: 'hr' }, i + 1];
    case 'html_block':
      return [{ id: newId(), type: 'html', raw: t.content }, i + 1];
    case 'table_open':
      return parseTable(tokens, i);
    case 'blockquote_open':
      return parseQuote(tokens, i);
    case 'bullet_list_open':
    case 'ordered_list_open':
      return parseList(tokens, i, t.type === 'ordered_list_open');
    default:
      // 孤立的 close 类 token：跳过
      return [null, i + 1];
  }
}

function parseQuote(tokens: readonly MdToken[], i: number): [Block, number] {
  let depth = 1;
  let j = i + 1;
  while (j < tokens.length && depth > 0) {
    if (tokens[j].type === 'blockquote_open') depth++;
    else if (tokens[j].type === 'blockquote_close') depth--;
    j++;
  }
  // j-1 为配对的 blockquote_close
  const children = tokensToDoc(tokens.slice(i + 1, j - 1));
  return [{ id: newId(), type: 'quote', children }, j];
}

function parseList(tokens: readonly MdToken[], i: number, ordered: boolean): [Block, number] {
  let depth = 1;
  let j = i + 1;
  while (j < tokens.length && depth > 0) {
    const ty = tokens[j].type;
    if (ty === 'bullet_list_open' || ty === 'ordered_list_open') depth++;
    else if (ty === 'bullet_list_close' || ty === 'ordered_list_close') depth--;
    j++;
  }
  const body = tokens.slice(i + 1, j - 1);
  const items = parseItems(body);
  const startAttr = tokens[i].attrGet('start');
  const start = startAttr !== null ? Number(startAttr) : undefined;
  const block: ListBlock = { id: newId(), type: 'list', ordered, items };
  if (start !== undefined && !Number.isNaN(start) && start !== 1) block.start = start;
  return [block, j];
}

/** body 为 list_open 与 list_close 之间的 token，由若干 list_item_open…close 组成 */
function parseItems(body: readonly MdToken[]): ListItem[] {
  const items: ListItem[] = [];
  let i = 0;
  while (i < body.length) {
    if (body[i].type !== 'list_item_open') {
      i++;
      continue;
    }
    let depth = 1;
    let j = i + 1;
    while (j < body.length && depth > 0) {
      if (body[j].type === 'list_item_open') depth++;
      else if (body[j].type === 'list_item_close') depth--;
      j++;
    }
    items.push(parseItemContent(body.slice(i + 1, j - 1)));
    i = j;
  }
  return items;
}

/** 解析单个列表项内容（首段文本 + 子块） */
function parseItemContent(ts: readonly MdToken[]): ListItem {
  let text = '';
  const children: Block[] = [];
  let firstParagraph = true;
  let i = 0;
  while (i < ts.length) {
    const t = ts[i];
    if (t.type === 'paragraph_open') {
      const content = inlineText(ts, i + 1);
      if (firstParagraph) {
        text = content;
        firstParagraph = false;
      } else {
        children.push({ id: newId(), type: 'paragraph', text: content });
      }
      i += 3;
    } else if (t.type === 'bullet_list_open' || t.type === 'ordered_list_open') {
      const [block, next] = parseList(ts, i, t.type === 'ordered_list_open');
      children.push(block);
      i = next;
    } else {
      const [block, next] = parseAnyBlock(ts, i);
      if (block) children.push(block);
      i = next;
    }
  }
  const item: ListItem = { id: newId(), text };
  const task = parseTaskMarker(text);
  if (task) {
    item.checked = task.checked;
    item.text = task.text;
  }
  if (children.length) item.children = children;
  return item;
}

/** 任务列表标记 `- [ ] foo` / `- [x] foo`（markdown-it 原生不解析，此处自定义约定） */
function parseTaskMarker(text: string): { checked: boolean; text: string } | null {
  const m = /^\[([ xX])\][ \t]+([\s\S]*)$/.exec(text);
  if (!m) return null;
  return { checked: m[1] !== ' ', text: m[2] };
}

function parseAlign(style: string | number | null): Align {
  const s = style === null ? '' : String(style);
  if (s.includes('center')) return 'center';
  if (s.includes('right')) return 'right';
  return 'left';
}

function parseTable(tokens: readonly MdToken[], i: number): [Block, number] {
  let depth = 1;
  let j = i + 1;
  while (j < tokens.length && depth > 0) {
    if (tokens[j].type === 'table_open') depth++;
    else if (tokens[j].type === 'table_close') depth--;
    j++;
  }
  const body = tokens.slice(i + 1, j - 1);
  const align: Align[] = [];
  const rows: string[][] = [];
  let row: string[] | null = null;
  let cell: string | null = null;
  for (const t of body) {
    switch (t.type) {
      case 'tr_open':
        row = [];
        break;
      case 'th_open':
        cell = '';
        align.push(parseAlign(t.attrGet('style')));
        break;
      case 'td_open':
        cell = '';
        break;
      case 'inline':
        if (cell !== null) cell = t.content;
        break;
      case 'th_close':
      case 'td_close':
        row?.push(cell ?? '');
        cell = null;
        break;
      case 'tr_close':
        if (row) rows.push(row);
        row = null;
        break;
      default:
        break;
    }
  }
  return [{ id: newId(), type: 'table', align, rows }, j];
}

// ============================================================
// 序列化：块树 → markdown 源码（上表的逆过程）
// ============================================================

export function docToMarkdown(doc: readonly Block[]): string {
  return doc.map(serializeBlock).join('\n\n');
}

function serializeBlock(b: Block): string {
  switch (b.type) {
    case 'paragraph':
      return b.text;
    case 'heading':
      return '#'.repeat(b.level) + ' ' + b.text;
    case 'code':
      return '```' + b.lang + '\n' + b.code + (b.code === '' || b.code.endsWith('\n') ? '' : '\n') + '```';
    case 'math':
      return '$$\n' + b.tex + (b.tex.endsWith('\n') ? '' : '\n') + '$$';
    case 'hr':
      return '---';
    case 'html':
      return b.raw.trimEnd();
    case 'quote': {
      const inner = docToMarkdown(b.children);
      return inner
        .split('\n')
        .map((l) => (l.length ? '> ' + l : '>'))
        .join('\n');
    }
    case 'list':
      return serializeList(b);
    case 'table':
      return serializeTable(b);
  }
}

function serializeList(b: ListBlock): string {
  const lines: string[] = [];
  b.items.forEach((item, i) => {
    const marker = b.ordered ? `${(b.start ?? 1) + i}. ` : '- ';
    const taskPrefix = item.checked === undefined ? '' : item.checked ? '[x] ' : '[ ] ';
    const bodyLines = (taskPrefix + item.text).split('\n');
    lines.push(marker + (bodyLines[0] ?? ''));
    const indent = ' '.repeat(marker.length);
    for (let k = 1; k < bodyLines.length; k++) {
      lines.push(bodyLines[k] ? indent + bodyLines[k] : '');
    }
    if (item.children?.length) {
      // 空行分隔：避免续段被解析为惰性续行、子块结构被并回正文
      lines.push('');
      const childMd = item.children.map(serializeBlock).join('\n\n');
      for (const l of childMd.split('\n')) lines.push(l ? indent + l : '');
    }
  });
  return lines.join('\n');
}

function serializeTable(b: Block & { type: 'table' }): string {
  if (b.rows.length === 0) return '';
  const alignSeq = (a: Align): string =>
    a === 'center' ? ':---:' : a === 'right' ? '---:' : '---';
  const header = b.rows[0];
  const lines: string[] = ['| ' + header.join(' | ') + ' |'];
  lines.push('| ' + header.map((_, i) => alignSeq(b.align[i] ?? 'left')).join(' | ') + ' |');
  for (let r = 1; r < b.rows.length; r++) {
    lines.push('| ' + b.rows[r].join(' | ') + ' |');
  }
  return lines.join('\n');
}
