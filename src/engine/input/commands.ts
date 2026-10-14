import type { DocumentModel } from '../model/document';
import type {
  AnyNode,
  Block,
  BlockId,
  ListItem,
  ListBlock,
  LogicalPosition,
  LogicalSelection,
  Op,
  Transaction,
} from '../model/types';
import { isListItem, newId } from '../model/types';
import { replaceCellRange } from './table';

// ============================================================
// 结构性操作 → 事务（纯函数：不改树，只产出 ops）
// ============================================================

function sel(blockId: BlockId, offset: number): LogicalSelection {
  const pos = { blockId, offset };
  return { anchor: pos, focus: pos };
}

function textOfNode(node: AnyNode): string {
  return 'text' in node ? node.text : '';
}

/**
 * 文档顺序收集所有可承载光标的文本叶子（段落/标题/代码/公式/列表项）。
 * 用于跨块导航与跨块删除。
 */
export function textLeafIds(model: DocumentModel): BlockId[] {
  const out: BlockId[] = [];
  const walk = (list: readonly AnyNode[]): void => {
    for (const node of list) {
      if (isListItem(node)) {
        out.push(node.id);
        if (node.children) walk(node.children);
      } else if (node.type === 'quote') {
        walk(node.children);
      } else if (node.type === 'list') {
        walk(node.items);
      } else {
        out.push(node.id);
      }
    }
  };
  walk(model.getRoot());
  return out;
}

// ------------------------------------------------------------
// Enter：段落拆分 / 列表续项 / 空项退出
// ------------------------------------------------------------

export function splitBlock(
  model: DocumentModel,
  blockId: BlockId,
  offset: number,
): Transaction {
  const node = model.getBlock(blockId);
  if (!node) throw new Error(`splitBlock: 节点不存在 ${blockId}`);
  if (isListItem(node)) return splitListItem(model, node, offset);
  const block = node;

  switch (block.type) {
    case 'paragraph':
    case 'heading': {
      // ``` 围栏转换：段落文本恰为 ```lang 时回车建代码块
      if (block.type === 'paragraph' && /^```[\w+-]*$/.test(block.text)) {
        return {
          ops: [
            {
              type: 'updateAttrs',
              id: blockId,
              attrs: { type: 'code', lang: block.text.slice(3), code: '' },
            },
          ],
          selection: sel(blockId, 0),
        };
      }
      const head = block.text.slice(0, offset);
      const tail = block.text.slice(offset);
      const newId1 = newId();
      const ops: Op[] = [];
      if (block.type === 'heading' && offset === block.text.length) {
        // 标题末尾回车 → 新空段落
        ops.push({ type: 'insert', after: blockId, block: { id: newId1, type: 'paragraph', text: '' } });
      } else {
        ops.push({ type: 'updateText', id: blockId, text: head });
        ops.push({ type: 'insert', after: blockId, block: { id: newId1, type: 'paragraph', text: tail } });
      }
      return { ops, selection: sel(newId1, 0) };
    }
    case 'code': {
      // 末尾空行回车：退出代码块，其后新建段落（Typora 行为）
      if (offset >= block.code.length && block.code.endsWith('\n')) {
        const exitId = newId();
        return {
          ops: [{ type: 'insert', after: blockId, block: { id: exitId, type: 'paragraph', text: '' } }],
          selection: sel(exitId, 0),
        };
      }
      // 代码块内回车：插入换行（M2 换 CodeMirror 后由其接管）
      const text = block.code.slice(0, offset) + '\n' + block.code.slice(offset);
      return {
        ops: [{ type: 'updateAttrs', id: blockId, attrs: { code: text } }],
        selection: sel(blockId, offset + 1),
      };
    }
    default: {
      // hr / math / table / html：其后插入新段落
      const newId1 = newId();
      return {
        ops: [{ type: 'insert', after: blockId, block: { id: newId1, type: 'paragraph', text: '' } }],
        selection: sel(newId1, 0),
      };
    }
  }
}

function splitListItem(model: DocumentModel, item: ListItem, offset: number): Transaction {
  const entry = model.getEntry(item.id);
  if (!entry?.parentId) throw new Error('splitListItem: 列表项不在列表中');
  const list = model.getBlock(entry.parentId) as ListBlock;

  // 空项回车 → 退出列表
  if (item.text === '' && !item.children?.length) {
    if (list.items.length === 1) {
      return {
        ops: [{ type: 'updateAttrs', id: list.id, attrs: { type: 'paragraph', text: '' } }],
        selection: sel(list.id, 0),
      };
    }
    const newId1 = newId();
    return {
      ops: [
        { type: 'remove', id: item.id },
        { type: 'insert', after: list.id, block: { id: newId1, type: 'paragraph', text: '' } },
      ],
      selection: sel(newId1, 0),
    };
  }

  const tail = item.text.slice(offset);
  const newItem: ListItem = { id: newId(), text: tail };
  if (item.checked !== undefined) newItem.checked = false;
  return {
    ops: [
      { type: 'updateText', id: item.id, text: item.text.slice(0, offset) },
      { type: 'insert', after: item.id, block: newItem },
    ],
    selection: sel(newItem.id, 0),
  };
}

// ------------------------------------------------------------
// Backspace（块首）：合并 / 降级 / 退出容器
// ------------------------------------------------------------

export function mergeWithPrev(
  model: DocumentModel,
  blockId: BlockId,
): Transaction | null {
  const node = model.getBlock(blockId);
  if (!node) return null;

  if (isListItem(node)) return mergeItemWithPrev(model, node);

  const entry = model.getEntry(blockId);
  if (!entry) return null;

  // 标题块首退格 → 降级（Typora 行为）
  if (node.type === 'heading') {
    if (node.level > 1) {
      return {
        ops: [{ type: 'updateAttrs', id: blockId, attrs: { level: (node.level - 1) as 1 | 2 | 3 | 4 | 5 | 6 } }],
        selection: sel(blockId, 0),
      };
    }
    return {
      ops: [{ type: 'updateAttrs', id: blockId, attrs: { type: 'paragraph' } }],
      selection: sel(blockId, 0),
    };
  }
  // 空代码块 / 空公式块块首退格 → 转回普通段落（Typora 行为：先拆围栏再合并）
  if (node.type === 'code' && node.code === '') {
    return {
      ops: [{ type: 'updateAttrs', id: blockId, attrs: { type: 'paragraph', text: '' } }],
      selection: sel(blockId, 0),
    };
  }
  if (node.type === 'math' && node.tex === '') {
    return {
      ops: [{ type: 'updateAttrs', id: blockId, attrs: { type: 'paragraph', text: '' } }],
      selection: sel(blockId, 0),
    };
  }
  if (node.type !== 'paragraph') return null;

  const prevId = model.getSiblingId(blockId, -1);
  if (!prevId) {
    // 引用块首块退格 → 移出引用
    if (entry.parentKind === 'quote') return unwrapFromQuote(model, blockId);
    return null; // 文档第一个段落
  }

  const prev = model.getBlock(prevId)!;
  if (isListItem(prev) || prev.type === 'list') {
    const leaf = lastTextLeaf(model, prevId);
    if (!leaf) return null;
    return {
      ops: [
        { type: 'updateText', id: leaf.id, text: textOfNode(leaf) + node.text },
        { type: 'remove', id: blockId },
      ],
      selection: sel(leaf.id, textOfNode(leaf).length),
    };
  }

  switch (prev.type) {
    case 'paragraph':
    case 'heading': {
      return {
        ops: [
          { type: 'updateText', id: prevId, text: prev.text + node.text },
          { type: 'remove', id: blockId },
        ],
        selection: sel(prevId, prev.text.length),
      };
    }
    case 'hr':
      return { ops: [{ type: 'remove', id: prevId }], selection: sel(blockId, 0) };
    case 'quote': {
      const last = prev.children[prev.children.length - 1];
      if (!last || isListItem(last)) return null;
      if (last.type !== 'paragraph' && last.type !== 'heading') return null;
      return {
        ops: [
          { type: 'updateText', id: last.id, text: last.text + node.text },
          { type: 'remove', id: blockId },
        ],
        selection: sel(last.id, last.text.length),
      };
    }
    default:
      // code / math / table / html 前退格：M1 不处理
      return null;
  }
}

function mergeItemWithPrev(model: DocumentModel, item: ListItem): Transaction | null {
  const entry = model.getEntry(item.id);
  if (!entry?.parentId) return null;
  const listId = entry.parentId;
  const list = model.getBlock(listId) as ListBlock;
  const prevItemId = model.getSiblingId(item.id, -1);

  if (!prevItemId) {
    // 首项块首退格
    if (item.text === '') {
      if (list.items.length === 1) {
        return {
          ops: [{ type: 'updateAttrs', id: listId, attrs: { type: 'paragraph', text: '' } }],
          selection: sel(listId, 0),
        };
      }
      return {
        ops: [{ type: 'remove', id: item.id }],
        selection: sel(list.items[1].id, 0),
      };
    }
    return promoteFirstItem(model, item, list);
  }

  // 与前一项合并：并入其最后一个文本叶子
  const leaf = lastTextLeaf(model, prevItemId);
  if (!leaf) return null;
  return {
    ops: [
      { type: 'updateText', id: leaf.id, text: textOfNode(leaf) + item.text },
      { type: 'remove', id: item.id },
    ],
    selection: sel(leaf.id, textOfNode(leaf).length),
  };
}

/** 首项非空退格：项提升为列表前段落，列表剩余项保留（有序列表起始号顺延） */
function promoteFirstItem(model: DocumentModel, item: ListItem, list: ListBlock): Transaction {
  const listEntry = model.getEntry(list.id)!;
  const ops: Op[] = [];
  const paragraphId = newId();

  if (list.items.length === 1) {
    ops.push({
      type: 'updateAttrs',
      id: list.id,
      attrs: { type: 'paragraph', text: item.text },
    });
    return { ops, selection: sel(list.id, item.text.length) };
  }

  const prevId = model.getSiblingId(list.id, -1);
  const paragraph: Block = { id: paragraphId, type: 'paragraph', text: item.text };
  if (prevId) {
    ops.push({ type: 'insert', after: prevId, block: paragraph });
  } else if (listEntry.parentId) {
    ops.push({ type: 'insert', after: null, into: listEntry.parentId, block: paragraph });
  } else {
    ops.push({ type: 'insert', after: null, block: paragraph });
  }
  ops.push({ type: 'remove', id: item.id });
  if (list.ordered) {
    ops.push({ type: 'updateAttrs', id: list.id, attrs: { start: (list.start ?? 1) + 1 } });
  }
  return { ops, selection: sel(paragraphId, item.text.length) };
}

function unwrapFromQuote(model: DocumentModel, blockId: BlockId): Transaction {
  const entry = model.getEntry(blockId)!;
  const quoteId = entry.parentId!;
  const quote = model.getBlock(quoteId) as { children: Block[]; id: BlockId; type: 'quote' };
  const ops: Op[] = [];
  if (quote.children.length === 1) {
    // 引用将变空：原位替换为该块（沿用 quote 的 id，禁止改 id）
    const child = quote.children[0];
    ops.push({
      type: 'updateAttrs',
      id: quoteId,
      attrs: { ...child, id: quoteId } as Record<string, unknown>,
    });
    return { ops, selection: sel(quoteId, 0) };
  }
  const targetId = newId();
  const copy: Block = { ...(model.getBlock(blockId) as Block), id: targetId };
  const quoteEntry = model.getEntry(quoteId)!;
  const prevId = model.getSiblingId(quoteId, -1);
  if (prevId) {
    ops.push({ type: 'insert', after: prevId, block: copy });
  } else if (quoteEntry.parentId) {
    ops.push({ type: 'insert', after: null, into: quoteEntry.parentId, block: copy });
  } else {
    ops.push({ type: 'insert', after: null, block: copy });
  }
  ops.push({ type: 'remove', id: blockId });
  return { ops, selection: sel(targetId, 0) };
}

/** 节点子树内最后一个文本叶子（深度优先最右） */
function lastTextLeaf(model: DocumentModel, nodeId: BlockId): AnyNode | null {
  let node = model.getBlock(nodeId);
  while (node) {
    if (isListItem(node)) {
      const children = node.children ?? [];
      if (children.length === 0) return node;
      const last = children[children.length - 1];
      if (last.type === 'list') {
        const items = last.items;
        if (items.length === 0) return node;
        node = items[items.length - 1];
      } else {
        node = last;
      }
      continue;
    }
    if (node.type === 'quote') {
      if (node.children.length === 0) return node;
      node = node.children[node.children.length - 1];
      continue;
    }
    if (node.type === 'list') {
      if (node.items.length === 0) return node;
      node = node.items[node.items.length - 1];
      continue;
    }
    if ('text' in node) return node;
    return null;
  }
  return null;
}

// ------------------------------------------------------------
// Delete（块尾）：向后合并
// ------------------------------------------------------------

export function mergeWithNext(model: DocumentModel, blockId: BlockId): Transaction | null {
  const node = model.getBlock(blockId);
  if (!node || isListItem(node)) return null;
  // 空代码块 / 空公式块块尾 Delete → 转回普通段落（与 Backspace 对称）
  if (node.type === 'code' && node.code === '') {
    return {
      ops: [{ type: 'updateAttrs', id: blockId, attrs: { type: 'paragraph', text: '' } }],
      selection: sel(blockId, 0),
    };
  }
  if (node.type === 'math' && node.tex === '') {
    return {
      ops: [{ type: 'updateAttrs', id: blockId, attrs: { type: 'paragraph', text: '' } }],
      selection: sel(blockId, 0),
    };
  }
  if (node.type !== 'paragraph') return null;
  const nextId = model.getSiblingId(blockId, 1);
  if (!nextId) return null;
  const next = model.getBlock(nextId)!;

  if (isListItem(next) || next.type === 'list') {
    const first = firstTextLeaf(model, nextId);
    if (!first) return null;
    return {
      ops: [
        { type: 'updateText', id: blockId, text: node.text + textOfNode(first) },
        { type: 'remove', id: first.id },
      ],
      selection: sel(blockId, node.text.length),
    };
  }

  switch (next.type) {
    case 'paragraph':
    case 'heading':
      return {
        ops: [
          { type: 'updateText', id: blockId, text: node.text + next.text },
          { type: 'remove', id: nextId },
        ],
        selection: sel(blockId, node.text.length),
      };
    case 'hr':
      return { ops: [{ type: 'remove', id: nextId }], selection: sel(blockId, node.text.length) };
    case 'quote': {
      const first = next.children[0];
      if (!first || first.type !== 'paragraph') return null;
      return {
        ops: [
          { type: 'updateText', id: blockId, text: node.text + first.text },
          { type: 'remove', id: first.id },
        ],
        selection: sel(blockId, node.text.length),
      };
    }
    default:
      return null;
  }
}

function firstTextLeaf(model: DocumentModel, nodeId: BlockId): AnyNode | null {
  let node = model.getBlock(nodeId);
  while (node) {
    if (isListItem(node)) return node;
    if (node.type === 'quote') {
      if (node.children.length === 0) return node;
      node = node.children[0];
      continue;
    }
    if (node.type === 'list') {
      if (node.items.length === 0) return node;
      node = node.items[0];
      continue;
    }
    if ('text' in node) return node;
    return null;
  }
  return null;
}

// ------------------------------------------------------------
// 跨块删除 / 粘贴
// ------------------------------------------------------------

/** 叶子块正文文本：段落/标题/列表项为 text，代码/公式为其源码，表格/分割线/HTML 无正文 */
function contentOf(node: AnyNode): string {
  if (isListItem(node)) return node.text;
  switch (node.type) {
    case 'paragraph':
    case 'heading':
      return node.text;
    case 'code':
      return node.code;
    case 'math':
      return node.tex;
    default:
      return '';
  }
}

/** 能否承载合并后的正文（表格/分割线/HTML 为整体删除型叶子） */
function isTextHost(node: AnyNode): boolean {
  return (
    isListItem(node) ||
    node.type === 'paragraph' ||
    node.type === 'heading' ||
    node.type === 'code' ||
    node.type === 'math'
  );
}

/** 节点子树内全部文本叶子 id（不含容器自身） */
function leafIdsUnder(node: AnyNode): BlockId[] {
  const out: BlockId[] = [];
  const walk = (n: AnyNode): void => {
    if (isListItem(n)) {
      out.push(n.id);
      if (n.children) n.children.forEach(walk);
    } else if (n.type === 'quote') {
      n.children.forEach(walk);
    } else if (n.type === 'list') {
      n.items.forEach(walk);
    } else {
      out.push(n.id);
    }
  };
  walk(node);
  return out;
}

/**
 * 跨块选区删除：合并首尾、移除中间。
 * 支持任意块型端点：表格/分割线/HTML 作为端点或中间块时整体删除；
 * 表格单元格端点按单元格区域清空；列表/引用容器被清空时一并移除。
 */
export function deleteRange(
  model: DocumentModel,
  anchor: LogicalPosition,
  focus: LogicalPosition,
): Transaction {
  const leaves = textLeafIds(model);
  const ai = leaves.indexOf(anchor.blockId);
  const fi = leaves.indexOf(focus.blockId);
  if (ai < 0 || fi < 0) throw new Error('deleteRange: 选区不在文档内');
  const reversed = ai > fi;
  const startIdx = reversed ? fi : ai;
  const endIdx = reversed ? ai : fi;
  const startPos = reversed ? focus : anchor;
  const endPos = reversed ? anchor : focus;

  const startNode = model.getBlock(startPos.blockId)!;
  const endNode = model.getBlock(endPos.blockId)!;

  // 同一叶子内
  if (startIdx === endIdx) {
    // 表格内选区（同格/跨格）：区域清空
    if (startPos.cell || endPos.cell) {
      const tx = replaceCellRange(model, startPos.blockId, startPos, endPos, '');
      return tx ?? { ops: [], selection: { anchor: startPos, focus: startPos } };
    }
    const content = contentOf(startNode);
    const lo = Math.min(startPos.offset, endPos.offset);
    const hi = Math.max(startPos.offset, endPos.offset);
    const next = content.slice(0, lo) + content.slice(hi);
    if (isListItem(startNode) || startNode.type === 'paragraph' || startNode.type === 'heading') {
      return { ops: [{ type: 'updateText', id: startPos.blockId, text: next }], selection: sel(startPos.blockId, lo) };
    }
    if (startNode.type === 'code') {
      return { ops: [{ type: 'updateAttrs', id: startPos.blockId, attrs: { code: next } }], selection: sel(startPos.blockId, lo) };
    }
    if (startNode.type === 'math') {
      return { ops: [{ type: 'updateAttrs', id: startPos.blockId, attrs: { tex: next } }], selection: sel(startPos.blockId, lo) };
    }
    // 表格（无 cell 定位）/ 分割线 / HTML：整体删除并保证落点
    const removeSet = new Set<BlockId>([startPos.blockId]);
    return buildWholeRemoveTx(model, leaves, startIdx, endIdx, removeSet, startIdx === endIdx);
  }

  const head = contentOf(startNode).slice(0, Math.max(0, startPos.offset));
  const tail = contentOf(endNode).slice(Math.max(0, endPos.offset));

  // 宿主：优先起点叶子，其次终点叶子（表格/分割线/HTML 端点不可承载正文）
  const hostIsStart = isTextHost(startNode);
  const hostIsEnd = !hostIsStart && isTextHost(endNode);
  const ops: Op[] = [];
  if (hostIsStart) {
    ops.push(makeHostUpdate(startNode, head + tail));
  } else if (hostIsEnd) {
    ops.push(makeHostUpdate(endNode, tail));
  }

  // 待删除叶子 = 选区内除宿主外的全部叶子：逆序（子先于父）防止先删父后找不到子
  const removeSet = new Set<BlockId>();
  for (let i = endIdx; i >= startIdx; i--) {
    if (hostIsStart && i === startIdx) continue;
    if (hostIsEnd && i === endIdx) continue;
    removeSet.add(leaves[i]);
  }
  // 被清空的 list/quote 容器一并删除（迭代至稳定）
  let grew = true;
  while (grew) {
    grew = false;
    for (const id of [...removeSet]) {
      const entry = model.getEntry(id);
      if (!entry || entry.parentId === null || removeSet.has(entry.parentId)) continue;
      const parent = model.getBlock(entry.parentId);
      if (!parent || isListItem(parent) || (parent.type !== 'list' && parent.type !== 'quote')) {
        continue;
      }
      const containerLeaves = leafIdsUnder(parent);
      if (containerLeaves.length > 0 && containerLeaves.every((l) => removeSet.has(l))) {
        removeSet.add(entry.parentId);
        grew = true;
      }
    }
  }
  // remove 统一在 collectRemoves 组装：叶子逆序（子先于父），容器最后
  const removeOps = collectRemoves(removeSet, leaves);
  if (hostIsStart) {
    return { ops: [...ops, ...removeOps], selection: sel(startNode.id, head.length) };
  }
  if (hostIsEnd) {
    return { ops: [...ops, ...removeOps], selection: sel(endNode.id, 0) };
  }
  return buildWholeRemoveTail(model, leaves, startIdx, endIdx, removeSet, ops);
}

/** 按宿主块类型产出正文更新 op（updateText 仅适用于含 text 字段的块） */
function makeHostUpdate(host: AnyNode, text: string): Op {
  if (!isListItem(host) && host.type === 'code') {
    return { type: 'updateAttrs', id: host.id, attrs: { code: text } };
  }
  if (!isListItem(host) && host.type === 'math') {
    return { type: 'updateAttrs', id: host.id, attrs: { tex: text } };
  }
  return { type: 'updateText', id: host.id, text };
}

/** 两端均为整体删除型叶子时的落点收敛：后继叶 → 前驱叶末尾 → 新建空段落 */
function buildWholeRemoveTail(
  model: DocumentModel,
  leaves: BlockId[],
  startIdx: number,
  endIdx: number,
  removeSet: Set<BlockId>,
  hostOps: Op[],
): Transaction {
  const ancestorRemoved = (id: BlockId): boolean => {
    let cur = model.getEntry(id);
    let guard = 0;
    while (cur && cur.parentId !== null && guard++ < 64) {
      if (removeSet.has(cur.parentId)) return true;
      cur = model.getEntry(cur.parentId);
    }
    return false;
  };
  const removeOps = collectRemoves(removeSet, leaves);
  const after = leaves[endIdx + 1];
  if (after && !removeSet.has(after) && !ancestorRemoved(after)) {
    return { ops: [...hostOps, ...removeOps], selection: sel(after, 0) };
  }
  const before = leaves[startIdx - 1];
  if (before && !removeSet.has(before) && !ancestorRemoved(before)) {
    return {
      ops: [...hostOps, ...removeOps],
      selection: sel(before, contentOf(model.getBlock(before)!).length),
    };
  }
  // 文档被清空：补一个空段落保证可继续输入
  const pId = newId();
  return {
    ops: [...hostOps, ...removeOps, { type: 'insert', after: null, block: { id: pId, type: 'paragraph', text: '' } }],
    selection: sel(pId, 0),
  };
}

function collectRemoves(removeSet: Set<BlockId>, leaves: BlockId[]): Op[] {
  const ops: Op[] = [];
  for (let i = leaves.length - 1; i >= 0; i--) {
    const id = leaves[i];
    if (removeSet.has(id)) ops.push({ type: 'remove', id });
  }
  for (const id of removeSet) {
    if (!leaves.includes(id)) ops.push({ type: 'remove', id });
  }
  return ops;
}

/** 单个整体删除型叶子（无 cell 定位的表格 / 分割线 / HTML）删除事务 */
function buildWholeRemoveTx(
  model: DocumentModel,
  leaves: BlockId[],
  startIdx: number,
  endIdx: number,
  removeSet: Set<BlockId>,
  _single: boolean,
): Transaction {
  return buildWholeRemoveTail(model, leaves, startIdx, endIdx, removeSet, []);
}

/** 粘贴纯文本：多行拆为段落 */
export function pasteText(
  model: DocumentModel,
  anchor: { blockId: BlockId; offset: number },
  text: string,
): Transaction {
  const node = model.getBlock(anchor.blockId);
  if (!node) throw new Error('pasteText: 节点不存在');
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const base = textOfNode(node);
  const head = base.slice(0, anchor.offset);
  const tail = base.slice(anchor.offset);

  if (isListItem(node) || node.type === 'paragraph' || node.type === 'heading') {
    const ops: Op[] = [];
    const firstId = node.id;
    let afterId: BlockId = node.id;
    ops.push({ type: 'updateText', id: firstId, text: head + lines[0] });
    if (lines.length > 1) {
      for (let i = 1; i < lines.length; i++) {
        const id = newId();
        const isLast = i === lines.length - 1;
        const content = isLast ? lines[i] + tail : lines[i];
        const block: Block = { id, type: 'paragraph', text: content };
        if (isListItem(node)) {
          // 列表项内粘贴多行：首行并入当前项，其余作为该列表的新项
          ops.push({
            type: 'insert',
            after: afterId,
            block: { id, text: content, ...(node.checked !== undefined ? { checked: false } : {}) } as ListItem,
          });
        } else {
          ops.push({ type: 'insert', after: afterId, block });
        }
        afterId = id;
      }
    }
    const endId = lines.length > 1 ? afterId : node.id;
    return {
      ops,
      selection: sel(endId, lines.length > 1 ? textOfNode(node).length + lines[lines.length - 1].length : anchor.offset + lines[0].length),
    };
  }

  // 非文本块：忽略（M2 再扩展）
  return { ops: [], selection: sel(anchor.blockId, anchor.offset) };
}

// ------------------------------------------------------------
// 前缀转换：# / - / 1. / > / [ ]
// ------------------------------------------------------------

const HEADING_RE = /^(#{1,6})$/;
const BULLET_RE = /^[-*+]$/;
const ORDERED_RE = /^(\d+)[.)]$/;
const QUOTE_RE = /^>$/;
const TASK_RE = /^\[([ xX])\]$/;

/** 输入空格后检查前缀，命中则返回转换事务 */
export function tryPrefixConvert(model: DocumentModel, blockId: BlockId): Transaction | null {
  const node = model.getBlock(blockId);
  if (!node) return null;

  if (isListItem(node)) {
    const m = TASK_RE.exec(node.text);
    if (m) {
      return {
        ops: [
          { type: 'updateText', id: blockId, text: '' },
          { type: 'updateAttrs', id: blockId, attrs: { checked: m[1] !== ' ' } },
        ],
        selection: sel(blockId, 0),
      };
    }
    return null;
  }
  if (node.type !== 'paragraph') return null;

  const text = node.text;
  let m: RegExpExecArray | null;

  if ((m = HEADING_RE.exec(text))) {
    return {
      ops: [{ type: 'updateAttrs', id: blockId, attrs: { type: 'heading', level: m[1].length as 1 | 2 | 3 | 4 | 5 | 6, text: '' } }],
      selection: sel(blockId, 0),
    };
  }
  if (BULLET_RE.test(text)) {
    return replaceWithList(model, blockId, { ordered: false });
  }
  if ((m = ORDERED_RE.exec(text))) {
    return replaceWithList(model, blockId, { ordered: true, start: Number(m[1]) });
  }
  if (QUOTE_RE.test(text)) {
    const quoteId = newId();
    const childId = newId();
    return {
      ops: [
        ...replaceBlockOps(model, blockId, {
          id: quoteId,
          type: 'quote',
          children: [{ id: childId, type: 'paragraph', text: '' }],
        }),
      ],
      selection: sel(childId, 0),
    };
  }
  return null;
}

function replaceWithList(
  model: DocumentModel,
  blockId: BlockId,
  opts: { ordered: boolean; start?: number },
): Transaction {
  const itemId = newId();
  const listId = newId();
  const list: ListBlock = {
    id: listId,
    type: 'list',
    ordered: opts.ordered,
    items: [{ id: itemId, text: '' }],
  };
  if (opts.start !== undefined && opts.start !== 1) list.start = opts.start;
  return {
    ops: replaceBlockOps(model, blockId, list),
    selection: sel(itemId, 0),
  };
}

/** 原位替换块：先移除旧块，再在同位置插入新块（顺序很重要：
 *  若先插入且新块内嵌旧节点（如 quote 包裹段落），后执行的 remove 会
 *  命中新容器内的同 id 副本，破坏结构） */
export function replaceBlockOps(model: DocumentModel, blockId: BlockId, newBlock: Block): Op[] {
  const entry = model.getEntry(blockId)!;
  const prevId = model.getSiblingId(blockId, -1);
  const ops: Op[] = [{ type: 'remove', id: blockId }];
  if (prevId) {
    ops.push({ type: 'insert', after: prevId, block: newBlock });
  } else if (entry.parentId) {
    ops.push({ type: 'insert', after: null, into: entry.parentId, block: newBlock });
  } else {
    ops.push({ type: 'insert', after: null, block: newBlock });
  }
  return ops;
}

/** 解析节点所属顶层块 id（根层级返回自身） */
export function topLevelIdOf(model: DocumentModel, blockId: BlockId): BlockId {
  let cur = model.getEntry(blockId);
  let id = blockId;
  let guard = 0;
  while (cur && cur.parentId !== null && guard++ < 64) {
    id = cur.parentId;
    cur = model.getEntry(cur.parentId);
  }
  return id;
}

/** 在块后插入空段落（点击块下方空白另起一行用） */
export function insertParagraphAfter(blockId: BlockId): Transaction {
  const id = newId();
  return {
    ops: [{ type: 'insert', after: blockId, block: { id, type: 'paragraph', text: '' } }],
    selection: sel(id, 0),
  };
}

/** 整块删除（表格 / 分割线 / HTML 等）：移除后保证仍有可编辑落点 */
export function removeBlock(model: DocumentModel, blockId: BlockId): Transaction | null {
  const node = model.getBlock(blockId);
  if (!node || isListItem(node)) return null;
  const leaves = textLeafIds(model);
  const idx = leaves.indexOf(blockId);
  if (idx < 0) return null;
  return buildWholeRemoveTail(model, leaves, idx, idx, new Set<BlockId>([blockId]), []);
}

// ------------------------------------------------------------
// Tab 缩进 / Shift+Tab 反缩进（列表项）
// ------------------------------------------------------------

export function indentItem(model: DocumentModel, itemId: BlockId): Transaction | null {
  const prevId = model.getSiblingId(itemId, -1);
  if (!prevId) return null; // 无前项不能缩进
  const prev = model.getBlock(prevId);
  if (!prev || !isListItem(prev)) return null;

  const item = model.getBlock(itemId) as ListItem;
  const parentId = model.getEntry(itemId)!.parentId!;
  const parentList = model.getBlock(parentId) as ListBlock;

  // 挂到前一项的子列表末尾
  const ops: Op[] = [{ type: 'remove', id: itemId }];
  const children = prev.children ?? [];
  const lastChild = children[children.length - 1];
  if (lastChild && lastChild.type === 'list' && lastChild.ordered === parentList.ordered) {
    const nested = lastChild as ListBlock;
    ops.push({
      type: 'updateAttrs',
      id: lastChild.id,
      attrs: { items: [...nested.items, item] },
    });
  } else {
    const nestedId = newId();
    const nested: ListBlock = {
      id: nestedId,
      type: 'list',
      ordered: parentList.ordered,
      ...(parentList.start !== undefined ? { start: parentList.start } : {}),
      items: [item],
    };
    ops.push({ type: 'updateAttrs', id: prevId, attrs: { children: [...children, nested] } });
  }
  return { ops, selection: sel(itemId, 0) };
}

export function outdentItem(model: DocumentModel, itemId: BlockId): Transaction | null {
  const entry = model.getEntry(itemId);
  if (!entry?.parentId) return null;
  const list = model.getBlock(entry.parentId) as ListBlock;
  const listEntry = model.getEntry(list.id);
  if (!listEntry || listEntry.parentKind !== 'item') return null; // 只支持从嵌套列表提出

  const hostItemId = listEntry.parentId!;
  const hostItem = model.getBlock(hostItemId) as ListItem;
  const item = model.getBlock(itemId) as ListItem;
  const idx = list.items.findIndex((i) => i.id === itemId);
  const before = list.items.slice(0, idx);
  const after = list.items.slice(idx + 1);

  const ops: Op[] = [];
  ops.push({ type: 'updateAttrs', id: list.id, attrs: { items: before } });
  if (after.length > 0) {
    const afterListId = newId();
    const afterList: ListBlock = {
      id: afterListId,
      type: 'list',
      ordered: list.ordered,
      ...(list.ordered ? { start: (list.start ?? 1) + idx + 1 } : {}),
      items: after,
    };
    ops.push({ type: 'insert', after: itemId, block: afterList });
  }
  ops.push({ type: 'insert', after: hostItemId, block: item });
  // 宿主项的子列表空了则移除
  if (before.length === 0) {
    ops.push({
      type: 'updateAttrs',
      id: hostItemId,
      attrs: { children: (hostItem.children ?? []).filter((c) => c.id !== list.id) },
    });
  }
  return { ops, selection: sel(itemId, 0) };
}
