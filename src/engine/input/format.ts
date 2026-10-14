import { replaceBlockOps } from './commands';
import type { DocumentModel } from '../model/document';
import type {
  Block,
  BlockId,
  HeadingLevel,
  LogicalSelection,
  ListItem,
  Transaction,
} from '../model/types';
import { isListItem, newId } from '../model/types';

// ============================================================
// 格式化命令（菜单栏 / 工具栏 / 快捷键共用）
// 约定：仅作用于单个文本块；跨块选区在 actions 层收敛后再调用
// ============================================================

function collapsed(blockId: BlockId, offset: number): LogicalSelection {
  const pos = { blockId, offset };
  return { anchor: pos, focus: pos };
}

type TextBlock = { id: BlockId; text: string };

function asTextBlock(node: ReturnType<DocumentModel['getBlock']>): TextBlock | null {
  if (!node) return null;
  if (isListItem(node) || node.type === 'paragraph' || node.type === 'heading') {
    return node as TextBlock;
  }
  return null;
}

/**
 * 行内标记切换（加粗 **、斜体 *、删除线 ~~、行内代码 `）。
 * 已包裹选区 → 取消标记；空选区 → 插入一对标记；选区 → 包裹。
 */
export function toggleInlineMark(
  model: DocumentModel,
  selection: LogicalSelection,
  mark: string,
): Transaction | null {
  const node = asTextBlock(model.getBlock(selection.focus.blockId));
  if (!node || selection.anchor.blockId !== selection.focus.blockId) return null;

  const text = node.text;
  const start = Math.min(selection.anchor.offset, selection.focus.offset);
  const end = Math.max(selection.anchor.offset, selection.focus.offset);

  // 已被同一标记包裹 → 取消
  if (
    start >= mark.length &&
    text.startsWith(mark, start - mark.length) &&
    text.startsWith(mark, end)
  ) {
    const next =
      text.slice(0, start - mark.length) + text.slice(start, end) + text.slice(end + mark.length);
    return {
      ops: [{ type: 'updateText', id: node.id, text: next }],
      selection: {
        anchor: { blockId: node.id, offset: Math.max(0, start - mark.length) },
        focus: { blockId: node.id, offset: Math.max(0, end - mark.length) },
      },
    };
  }

  if (start === end) {
    // 空选区：插入成对标记，光标落在中间
    const next = text.slice(0, start) + mark + mark + text.slice(start);
    return {
      ops: [{ type: 'updateText', id: node.id, text: next }],
      selection: collapsed(node.id, start + mark.length),
    };
  }

  const next = text.slice(0, start) + mark + text.slice(start, end) + mark + text.slice(end);
  const shift = (offset: number): number => (offset >= start ? offset + mark.length : offset);
  return {
    ops: [{ type: 'updateText', id: node.id, text: next }],
    selection: {
      anchor: { blockId: node.id, offset: shift(selection.anchor.offset) },
      focus: { blockId: node.id, offset: shift(selection.focus.offset) },
    },
  };
}

/** 插入链接：选中文本 → [文本](url)；空选区 → [链接](url) */
export function insertLink(
  model: DocumentModel,
  selection: LogicalSelection,
  url: string,
): Transaction | null {
  const node = asTextBlock(model.getBlock(selection.focus.blockId));
  if (!node || selection.anchor.blockId !== selection.focus.blockId) return null;
  const text = node.text;
  const start = Math.min(selection.anchor.offset, selection.focus.offset);
  const end = Math.max(selection.anchor.offset, selection.focus.offset);
  const inner = end > start ? text.slice(start, end) : '链接';
  const inserted = '[' + inner + '](' + url + ')';
  const next = text.slice(0, start) + inserted + text.slice(end);
  return {
    ops: [{ type: 'updateText', id: node.id, text: next }],
    selection: collapsed(node.id, start + 1 + inner.length),
  };
}

/** 清除当前块行内格式 */
export function clearFormatting(model: DocumentModel, selection: LogicalSelection): Transaction | null {
  const node = asTextBlock(model.getBlock(selection.focus.blockId));
  if (!node) return null;
  const text = node.text
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\*\*|__|~~|`/g, '')
    .replace(/\*([^*\n]+)\*/g, '$1')
    .replace(/_([^_\n]+)_/g, '$1');
  const offset = Math.min(selection.focus.offset, text.length);
  return {
    ops: [{ type: 'updateText', id: node.id, text }],
    selection: collapsed(node.id, offset),
  };
}

// ------------------------------------------------------------
// 块类型转换
// ------------------------------------------------------------

/** 标题转换：level 0 = 普通段落 */
export function setHeading(
  model: DocumentModel,
  blockId: BlockId,
  level: 0 | HeadingLevel,
): Transaction | null {
  const node = model.getBlock(blockId);
  if (!node || isListItem(node)) return null;
  if (level === 0) {
    if (node.type !== 'paragraph' && node.type !== 'heading') return null;
    return {
      ops: [{ type: 'updateAttrs', id: blockId, attrs: { type: 'paragraph' } }],
      selection: collapsed(blockId, 0),
    };
  }
  if (node.type !== 'paragraph' && node.type !== 'heading') return null;
  return {
    ops: [{ type: 'updateAttrs', id: blockId, attrs: { type: 'heading', level } }],
    selection: collapsed(blockId, 0),
  };
}

export function wrapQuote(model: DocumentModel, blockId: BlockId): Transaction | null {
  const node = model.getBlock(blockId);
  if (!node || isListItem(node)) return null;
  if (node.type !== 'paragraph' && node.type !== 'heading') return null;
  const quoteId = newId();
  return {
    ops: replaceBlockOps(model, blockId, { id: quoteId, type: 'quote', children: [node as Block] }),
    selection: collapsed(node.id, 0),
  };
}

/** 列表转换：段落 → 单项列表（checked 提供时为任务列表） */
export function makeList(
  model: DocumentModel,
  blockId: BlockId,
  ordered: boolean,
  checked?: boolean,
): Transaction | null {
  const node = model.getBlock(blockId);
  if (!node || isListItem(node)) return null;
  if (node.type !== 'paragraph' && node.type !== 'heading') return null;
  const itemId = newId();
  const item: ListItem = { id: itemId, text: node.text };
  if (checked !== undefined) item.checked = checked;
  const list: Block = { id: newId(), type: 'list', ordered, items: [item] };
  return {
    ops: replaceBlockOps(model, blockId, list),
    selection: collapsed(itemId, 0),
  };
}

// ------------------------------------------------------------
// 插入块（分割线 / 代码块 / 数学块 / 表格）
// ------------------------------------------------------------

/** 当前块为空段落时原位转换，否则在其后插入 */
export function insertCodeBlock(model: DocumentModel, blockId: BlockId): Transaction | null {
  const node = model.getBlock(blockId);
  if (!node || isListItem(node)) return null;
  if (node.type === 'paragraph' && node.text === '') {
    return {
      ops: [{ type: 'updateAttrs', id: blockId, attrs: { type: 'code', lang: '', code: '' } }],
      selection: collapsed(blockId, 0),
    };
  }
  const codeId = newId();
  return {
    ops: [
      { type: 'insert', after: blockId, block: { id: codeId, type: 'code', lang: '', code: '' } },
    ],
    selection: collapsed(codeId, 0),
  };
}

export function insertMathBlock(model: DocumentModel, blockId: BlockId): Transaction | null {
  const node = model.getBlock(blockId);
  if (!node || isListItem(node)) return null;
  if (node.type === 'paragraph' && node.text === '') {
    return {
      ops: [{ type: 'updateAttrs', id: blockId, attrs: { type: 'math', tex: '' } }],
      selection: collapsed(blockId, 2), // $$ 标记后
    };
  }
  const mathId = newId();
  return {
    ops: [{ type: 'insert', after: blockId, block: { id: mathId, type: 'math', tex: '' } }],
    selection: collapsed(mathId, 2),
  };
}

/** 分割线 + 后随空段落（光标落到段落） */
export function insertHr(model: DocumentModel, blockId: BlockId): Transaction | null {
  const node = model.getBlock(blockId);
  if (!node || isListItem(node)) return null;
  const hrId = newId();
  const pId = newId();
  return {
    ops: [
      { type: 'insert', after: blockId, block: { id: hrId, type: 'hr' } },
      { type: 'insert', after: hrId, block: { id: pId, type: 'paragraph', text: '' } },
    ],
    selection: collapsed(pId, 0),
  };
}

/** 3 列表格 + 后随空段落 */
export function insertTable(model: DocumentModel, blockId: BlockId): Transaction | null {
  const node = model.getBlock(blockId);
  if (!node || isListItem(node)) return null;
  const tableId = newId();
  const pId = newId();
  const table: Block = {
    id: tableId,
    type: 'table',
    align: ['left', 'left', 'left'],
    rows: [
      ['表头一', '表头二', '表头三'],
      ['单元格', '单元格', '单元格'],
      ['单元格', '单元格', '单元格'],
    ],
  };
  return {
    ops: [
      { type: 'insert', after: blockId, block: table },
      { type: 'insert', after: tableId, block: { id: pId, type: 'paragraph', text: '' } },
    ],
    selection: collapsed(pId, 0),
  };
}
