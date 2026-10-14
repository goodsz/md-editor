import type { DocumentModel } from '../model/document';
import type {
  Align,
  LogicalPosition,
  LogicalSelection,
  TableBlock,
  Transaction,
} from '../model/types';
import { isTable } from '../model/types';

// ============================================================
// 表格操作：行列增删 / 对齐 / 单元格导航（纯函数，产出事务）
// 约定：rows[0] 为表头行；最少保留 1 行 1 列
// ============================================================

interface TableCtx {
  table: TableBlock;
  rows: string[][];
  align: Align[];
  colCount: number;
}

function tableCtx(model: DocumentModel, tableId: string): TableCtx | null {
  const node = model.getBlock(tableId);
  if (!node || !isTable(node)) return null;
  const colCount = node.rows[0]?.length ?? 0;
  return { table: node, rows: node.rows.map((r) => [...r]), align: [...node.align], colCount };
}

function cellPos(tableId: string, r: number, c: number, offset = 0): LogicalPosition {
  return { blockId: tableId, offset, cell: { r, c } };
}

function collapsed(tableId: string, r: number, c: number, offset = 0): LogicalSelection {
  const pos = cellPos(tableId, r, c, offset);
  return { anchor: pos, focus: pos };
}

/** 事务入口统一校验：cell 是否越界 */
function clamp(ctx: TableCtx, r: number, c: number): { r: number; c: number } {
  return {
    r: Math.min(Math.max(0, r), ctx.rows.length - 1),
    c: Math.min(Math.max(0, c), ctx.colCount - 1),
  };
}

/** 在 afterRow 之后插入行（afterRow=-1 表示首行前）；返回新行下标 */
export function insertRow(
  model: DocumentModel,
  tableId: string,
  afterRow: number,
): Transaction | null {
  const ctx = tableCtx(model, tableId);
  if (!ctx || ctx.colCount === 0) return null;
  const insertAt = afterRow + 1;
  ctx.rows.splice(insertAt, 0, new Array(ctx.colCount).fill(''));
  return {
    ops: [{ type: 'updateAttrs', id: tableId, attrs: { rows: ctx.rows } }],
    selection: collapsed(tableId, insertAt, 0),
  };
}

export function deleteRow(model: DocumentModel, tableId: string, row: number): Transaction | null {
  const ctx = tableCtx(model, tableId);
  if (!ctx || ctx.rows.length <= 1 || row < 0 || row >= ctx.rows.length) return null;
  ctx.rows.splice(row, 1);
  const at = clamp(ctx, row, 0);
  return {
    ops: [{ type: 'updateAttrs', id: tableId, attrs: { rows: ctx.rows } }],
    selection: collapsed(tableId, at.r, at.c),
  };
}

export function insertCol(
  model: DocumentModel,
  tableId: string,
  afterCol: number,
): Transaction | null {
  const ctx = tableCtx(model, tableId);
  if (!ctx) return null;
  const insertAt = afterCol + 1;
  ctx.rows.forEach((row) => row.splice(insertAt, 0, ''));
  ctx.align.splice(insertAt, 0, 'left');
  return {
    ops: [{ type: 'updateAttrs', id: tableId, attrs: { rows: ctx.rows, align: ctx.align } }],
    selection: collapsed(tableId, 0, insertAt),
  };
}

export function deleteCol(model: DocumentModel, tableId: string, col: number): Transaction | null {
  const ctx = tableCtx(model, tableId);
  if (!ctx || ctx.colCount <= 1 || col < 0 || col >= ctx.colCount) return null;
  ctx.rows.forEach((row) => row.splice(col, 1));
  ctx.align.splice(col, 1);
  const at = clamp(ctx, 0, col);
  return {
    ops: [{ type: 'updateAttrs', id: tableId, attrs: { rows: ctx.rows, align: ctx.align } }],
    selection: collapsed(tableId, at.r, at.c),
  };
}

export function setColAlign(
  model: DocumentModel,
  tableId: string,
  col: number,
  align: Align,
): Transaction | null {
  const ctx = tableCtx(model, tableId);
  if (!ctx || col < 0 || col >= ctx.colCount) return null;
  ctx.align[col] = align;
  return {
    ops: [{ type: 'updateAttrs', id: tableId, attrs: { align: ctx.align } }],
    selection: collapsed(tableId, 0, col),
  };
}

// ------------------------------------------------------------
// 单元格导航
// ------------------------------------------------------------

export function cellAt(
  model: DocumentModel,
  tableId: string,
  r: number,
  c: number,
): LogicalPosition | null {
  const ctx = tableCtx(model, tableId);
  if (!ctx) return null;
  if (r < 0 || r >= ctx.rows.length || c < 0 || c >= ctx.colCount) return null;
  return cellPos(tableId, r, c);
}

/** Tab：下一格；末格则追加新行并移入新行首格（Typora 行为） */
export function tabNextCell(
  model: DocumentModel,
  tableId: string,
  r: number,
  c: number,
): Transaction | null {
  const ctx = tableCtx(model, tableId);
  if (!ctx) return null;
  const nextC = c + 1;
  if (nextC < ctx.colCount) {
    return { ops: [], selection: collapsed(tableId, r, nextC) };
  }
  // 末格 → 新行
  ctx.rows.push(new Array(ctx.colCount).fill(''));
  return {
    ops: [{ type: 'updateAttrs', id: tableId, attrs: { rows: ctx.rows } }],
    selection: collapsed(tableId, ctx.rows.length - 1, 0),
  };
}

/** Shift+Tab：上一格（首格不动；首列则到上一行末格） */
export function tabPrevCell(
  model: DocumentModel,
  tableId: string,
  r: number,
  c: number,
): LogicalPosition | null {
  const ctx = tableCtx(model, tableId);
  if (!ctx) return null;
  if (c > 0) return cellPos(tableId, r, c - 1);
  if (r > 0) return cellPos(tableId, r - 1, ctx.colCount - 1);
  return null;
}

/** Enter：当前行下方插入新行，移入同列 */
export function enterNextRow(
  model: DocumentModel,
  tableId: string,
  r: number,
  c: number,
): Transaction | null {
  const tx = insertRow(model, tableId, r);
  if (!tx) return null;
  return { ops: tx.ops, selection: collapsed(tableId, r + 1, c) };
}

/** 上下方向键跨行（同列）；返回 null 表示已到边界 */
export function verticalCellMove(
  model: DocumentModel,
  tableId: string,
  r: number,
  c: number,
  delta: number,
): LogicalPosition | null {
  return cellAt(model, tableId, r + delta, c);
}

/** 水平方向键跨格（行内）；返回 null 表示已到边界 */
export function horizontalCellMove(
  model: DocumentModel,
  tableId: string,
  r: number,
  c: number,
  delta: number,
): LogicalPosition | null {
  const ctx = tableCtx(model, tableId);
  if (!ctx) return null;
  const next = c + delta;
  if (next < 0 || next >= ctx.colCount) return null;
  // 目标格取末尾（←）或开头（→）偏移由调用方按目标格文本长度决定
  return cellPos(tableId, r, next);
}

/**
 * 跨格选区替换（删除/输入/粘贴）：首格并尾格、中间格清空。
 * insertText 为空时即纯删除。
 */
export function replaceCellRange(
  model: DocumentModel,
  tableId: string,
  a: LogicalPosition,
  f: LogicalPosition,
  insertText: string,
): Transaction | null {
  const ctx = tableCtx(model, tableId);
  if (!ctx || !a.cell || !f.cell) return null;
  const order = (p: LogicalPosition): number => p.cell!.r * 1e6 + p.cell!.c;
  const [start, end] = order(a) <= order(f) ? [a, f] : [f, a];
  const sc = start.cell!;
  const ec = end.cell!;
  const startText = ctx.rows[sc.r]?.[sc.c] ?? '';
  const endText = ctx.rows[ec.r]?.[ec.c] ?? '';

  let selection: LogicalSelection;
  if (sc.r === ec.r && sc.c === ec.c) {
    ctx.rows[sc.r][sc.c] =
      startText.slice(0, start.offset) + insertText + startText.slice(end.offset);
    selection = collapsed(tableId, sc.r, sc.c, start.offset + insertText.length);
  } else {
    for (let r = sc.r; r <= ec.r; r++) {
      const cFrom = r === sc.r ? sc.c : 0;
      const cTo = r === ec.r ? ec.c : ctx.colCount - 1;
      for (let c = cFrom; c <= cTo; c++) {
        if (r === sc.r && c === sc.c) {
          ctx.rows[r][c] = startText.slice(0, start.offset) + insertText;
        } else if (r === ec.r && c === ec.c) {
          ctx.rows[r][c] = endText.slice(end.offset);
        } else {
          ctx.rows[r][c] = '';
        }
      }
    }
    selection = collapsed(tableId, sc.r, sc.c, start.offset + insertText.length);
  }
  return {
    ops: [{ type: 'updateAttrs', id: tableId, attrs: { rows: ctx.rows } }],
    selection,
  };
}
