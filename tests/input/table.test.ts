import { describe, expect, it } from 'vitest';
import { DocumentModel } from '../../src/engine/model/document';
import { isTable, type TableBlock } from '../../src/engine/model/types';
import {
  deleteCol,
  deleteRow,
  enterNextRow,
  insertCol,
  insertRow,
  replaceCellRange,
  setColAlign,
  tabNextCell,
  tabPrevCell,
} from '../../src/engine/input/table';

const T = `| 甲 | 乙 | 丙 |
| --- | --- | --- |
| a1 | a2 | a3 |
| b1 | b2 | b3 |`;

function setup(md = T) {
  const model = new DocumentModel();
  model.fromMarkdown(md);
  const table = model.getRoot()[0];
  if (!isTable(table)) throw new Error('应为 table');
  return { model, tableId: table.id };
}

function tableOf(model: DocumentModel, tableId: string): TableBlock {
  const t = model.getBlock(tableId);
  if (!t || !isTable(t)) throw new Error('应为 table');
  return t;
}

function rows(model: DocumentModel, tableId: string): string[][] {
  return tableOf(model, tableId).rows;
}

function apply(model: DocumentModel, tx: ReturnType<typeof insertRow> | null): void {
  if (!tx) throw new Error('事务为空');
  model.apply(tx);
}

describe('table/行列增删', () => {
  it('insertRow 在指定行后插入空行', () => {
    const { model, tableId } = setup();
    apply(model, insertRow(model, tableId, 1));
    expect(rows(model, tableId)).toEqual([
      ['甲', '乙', '丙'],
      ['a1', 'a2', 'a3'],
      ['', '', ''],
      ['b1', 'b2', 'b3'],
    ]);
  });

  it('deleteRow 保留至少一行', () => {
    const { model, tableId } = setup('| 甲 |\n| --- |\n| a |');
    apply(model, deleteRow(model, tableId, 1)); // 删数据行
    expect(rows(model, tableId)).toEqual([['甲']]);
    expect(deleteRow(model, tableId, 0)).toBeNull(); // 仅剩表头，不可删
  });

  it('insertCol / deleteCol 与对齐数组同步', () => {
    const { model, tableId } = setup();
    // afterCol=1 → 在下标 2 处插入（其之后）
    apply(model, insertCol(model, tableId, 1));
    expect(rows(model, tableId)[0]).toEqual(['甲', '乙', '', '丙']);
    expect(tableOf(model, tableId).align.length).toBe(4);
    apply(model, deleteCol(model, tableId, 2));
    expect(rows(model, tableId)[0]).toEqual(['甲', '乙', '丙']);
  });

  it('setColAlign 修改列对齐', () => {
    const { model, tableId } = setup();
    apply(model, setColAlign(model, tableId, 1, 'center'));
    expect(tableOf(model, tableId).align[1]).toBe('center');
  });
});

describe('table/单元格导航', () => {
  it('Tab 下一格；末格追加新行', () => {
    const { model, tableId } = setup();
    // (0,2) 是第 0 行末格（非表末）→ 追加新行，光标进新行首格
    const tx = tabNextCell(model, tableId, 0, 2)!;
    apply(model, tx);
    expect(rows(model, tableId).length).toBe(4);
    expect(tx.selection.focus).toMatchObject({
      blockId: tableId,
      offset: 0,
      cell: { r: 3, c: 0 },
    });
    // 行内 Tab：仅移动
    const tx2 = tabNextCell(model, tableId, 0, 1)!;
    apply(model, tx2);
    expect(tx2.selection.focus).toMatchObject({ cell: { r: 0, c: 2 } });
  });

  it('Shift+Tab 上一格；首列到上一行末格', () => {
    const { model, tableId } = setup();
    expect(tabPrevCell(model, tableId, 1, 1)).toMatchObject({ cell: { r: 1, c: 0 } });
    expect(tabPrevCell(model, tableId, 1, 0)).toMatchObject({ cell: { r: 0, c: 2 } });
    expect(tabPrevCell(model, tableId, 0, 0)).toBeNull();
  });

  it('Enter 下方插入新行并移入同列', () => {
    const { model, tableId } = setup();
    const tx = enterNextRow(model, tableId, 1, 2)!;
    apply(model, tx);
    expect(rows(model, tableId).length).toBe(4);
    expect(tx.selection.focus).toMatchObject({ cell: { r: 2, c: 2 } });
  });
});

describe('table/跨格范围替换', () => {
  it('同格替换', () => {
    const { model, tableId } = setup();
    const tx = replaceCellRange(
      model,
      tableId,
      { blockId: tableId, offset: 1, cell: { r: 1, c: 0 } },
      { blockId: tableId, offset: 2, cell: { r: 1, c: 0 } },
      'X',
    )!;
    apply(model, tx);
    expect(rows(model, tableId)[1][0]).toBe('aX');
    expect(tx.selection.focus).toMatchObject({ cell: { r: 1, c: 0 }, offset: 2 });
  });

  it('同行跨格：首格并尾格、中间清空', () => {
    const { model, tableId } = setup();
    apply(
      model,
      replaceCellRange(
        model,
        tableId,
        { blockId: tableId, offset: 1, cell: { r: 1, c: 0 } },
        { blockId: tableId, offset: 1, cell: { r: 1, c: 2 } },
        '',
      ),
    );
    expect(rows(model, tableId)[1]).toEqual(['a', '', '3']);
  });

  it('跨行范围替换', () => {
    const { model, tableId } = setup();
    apply(
      model,
      replaceCellRange(
        model,
        tableId,
        { blockId: tableId, offset: 1, cell: { r: 0, c: 2 } },
        { blockId: tableId, offset: 1, cell: { r: 1, c: 1 } },
        'Z',
      ),
    );
    expect(rows(model, tableId)[0]).toEqual(['甲', '乙', '丙Z']);
    expect(rows(model, tableId)[1]).toEqual(['', '2', 'a3']);
  });

  it('反向选区自动归一', () => {
    const { model, tableId } = setup();
    apply(
      model,
      replaceCellRange(
        model,
        tableId,
        { blockId: tableId, offset: 1, cell: { r: 1, c: 2 } },
        { blockId: tableId, offset: 1, cell: { r: 0, c: 2 } },
        'Q',
      ),
    );
    expect(rows(model, tableId)[0]).toEqual(['甲', '乙', '丙Q']);
    // 行主序矩形：r1 的 c0..c2 均在范围内
    expect(rows(model, tableId)[1]).toEqual(['', '', '3']);
  });
});
