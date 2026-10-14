import { describe, expect, it } from 'vitest';
import { HistoryManager, type Snapshot } from '../../src/engine/history/history';
import { DocumentModel } from '../../src/engine/model/document';

function snap(md: string, offset = 0): Snapshot {
  const model = new DocumentModel();
  model.fromMarkdown(md);
  const leaves = model.getRoot();
  const last = leaves[leaves.length - 1];
  const pos = { blockId: last.id, offset };
  return { doc: model.getRoot(), selection: { anchor: pos, focus: pos } };
}

describe('history/HistoryManager', () => {
  it('undo/redo 基本闭环', () => {
    const h = new HistoryManager();
    h.reset(snap('v1'));
    h.push(snap('v2'));
    h.push(snap('v3'));
    expect(h.canUndo).toBe(true);
    const u1 = h.undo()!;
    expect(u1.doc[0]).toMatchObject({ text: 'v2' });
    const u2 = h.undo()!;
    expect(u2.doc[0]).toMatchObject({ text: 'v1' });
    expect(h.canUndo).toBe(false);
    const r1 = h.redo()!;
    expect(r1.doc[0]).toMatchObject({ text: 'v2' });
    const r2 = h.redo()!;
    expect(r2.doc[0]).toMatchObject({ text: 'v3' });
    expect(h.canRedo).toBe(false);
  });

  it('新操作清空 redo 栈', () => {
    const h = new HistoryManager();
    h.reset(snap('v1'));
    h.push(snap('v2'));
    h.undo();
    h.push(snap('v3'));
    expect(h.canRedo).toBe(false);
    const u = h.undo()!;
    expect(u.doc[0]).toMatchObject({ text: 'v1' });
  });

  it('栈上限 200 条，超出丢最旧', () => {
    const h = new HistoryManager();
    h.reset(snap('s0'));
    for (let i = 1; i <= 250; i++) h.push(snap(`s${i}`));
    expect(h.canUndo).toBe(true);
    // 一路 undo 到底：栈内保留 200 条（含初始 s0），可 undo 199 次，最旧为 s51
    let last = '';
    let count = 0;
    while (h.canUndo) {
      const s = h.undo()!;
      last = (s.doc[0] as { text: string }).text;
      count++;
    }
    expect(count).toBe(199);
    expect(last).toBe('s51');
  });
});
