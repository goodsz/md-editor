import { nanoid } from 'nanoid';

/** 块 / 列表项全局唯一 id */
export type BlockId = string;

export type Align = 'left' | 'center' | 'right';
export type HeadingLevel = 1 | 2 | 3 | 4 | 5 | 6;

/** 列表项（属于 list 块，不是独立块） */
export interface ListItem {
  id: BlockId;
  text: string; // 行内内容（含 **bold** 等标记，由行内渲染器解析）
  checked?: boolean; // 仅任务列表
  children?: Block[]; // 嵌套子块（子列表 / 续段等）
}

export interface ParagraphBlock {
  id: BlockId;
  type: 'paragraph';
  text: string;
}

export interface HeadingBlock {
  id: BlockId;
  type: 'heading';
  level: HeadingLevel;
  text: string;
}

export interface CodeBlock {
  id: BlockId;
  type: 'code';
  lang: string;
  code: string;
}

export interface MathBlock {
  id: BlockId;
  type: 'math';
  tex: string;
}

export interface HrBlock {
  id: BlockId;
  type: 'hr';
}

export interface QuoteBlock {
  id: BlockId;
  type: 'quote';
  children: Block[];
}

export interface ListBlock {
  id: BlockId;
  type: 'list';
  ordered: boolean;
  start?: number;
  items: ListItem[];
}

export interface TableBlock {
  id: BlockId;
  type: 'table';
  align: Align[];
  rows: string[][];
}

export interface HtmlBlock {
  id: BlockId;
  type: 'html';
  raw: string;
}

export type Block =
  | ParagraphBlock
  | HeadingBlock
  | CodeBlock
  | MathBlock
  | HrBlock
  | QuoteBlock
  | ListBlock
  | TableBlock
  | HtmlBlock;

/** 块树中任意节点（块或列表项） */
export type AnyNode = Block | ListItem;

/** 顶层文档：块数组 */
export type Doc = Block[];

export type Op =
  | { type: 'updateText'; id: BlockId; text: string }
  | { type: 'updateAttrs'; id: BlockId; attrs: Record<string, unknown> } // 如 heading level、list items
  | {
      type: 'insert';
      after: BlockId | null; // null = 插入开头（根或 into 容器）
      into?: BlockId; // 容器 id：插入其 children/items 首位（after=null 时生效）
      block: Block | ListItem;
    }
  | { type: 'remove'; id: BlockId }
  | { type: 'move'; id: BlockId; after: BlockId | null };

/** 逻辑位置：块内纯文本偏移（对 block.text 的字符索引）；
 *  表格单元格场景：blockId = 表格 id，cell 定位具体单元格，offset 为格内偏移 */
export interface LogicalPosition {
  blockId: BlockId;
  offset: number;
  cell?: { r: number; c: number };
}

export interface LogicalSelection {
  anchor: LogicalPosition;
  focus: LogicalPosition;
}

/** 一次原子性变更：渲染与 undo 的最小单位 */
export interface Transaction {
  ops: Op[];
  selection: LogicalSelection;
}

export function newId(): BlockId {
  return nanoid(10);
}

export function isListItem(n: AnyNode): n is ListItem {
  return !('type' in n);
}

export function isTable(n: AnyNode): n is TableBlock {
  return !isListItem(n) && n.type === 'table';
}

const BLOCK_FIELDS: Record<Block['type'], readonly string[]> = {
  paragraph: ['id', 'type', 'text'],
  heading: ['id', 'type', 'level', 'text'],
  code: ['id', 'type', 'lang', 'code'],
  math: ['id', 'type', 'tex'],
  hr: ['id', 'type'],
  quote: ['id', 'type', 'children'],
  list: ['id', 'type', 'ordered', 'start', 'items'],
  table: ['id', 'type', 'align', 'rows'],
  html: ['id', 'type', 'raw'],
};

/**
 * 按目标类型裁剪字段，用于块类型转换（updateAttrs 携带 type 时）。
 * 保证旧类型残留字段（如 paragraph 的 text 转成 hr）不会遗留在节点上。
 */
export function normalizeBlock(raw: Record<string, unknown>): Block {
  const type = raw['type'] as Block['type'];
  const fields = BLOCK_FIELDS[type];
  if (!fields) throw new Error(`未知块类型: ${String(type)}`);
  if (typeof raw['id'] !== 'string' || raw['id'] === '') {
    throw new Error('块节点缺少合法 id');
  }
  const out: Record<string, unknown> = {};
  for (const f of fields) {
    if (raw[f] !== undefined) out[f] = raw[f];
  }
  for (const required of fields.slice(2)) {
    if (out[required] === undefined && !(type === 'list' && required === 'start')) {
      throw new Error(`块类型 ${type} 缺少必需字段 ${required}`);
    }
  }
  return out as unknown as Block;
}
