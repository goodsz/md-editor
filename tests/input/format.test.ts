import { describe, expect, it } from 'vitest';
import {
  clearFormatting,
  insertCodeBlock,
  insertHr,
  insertLink,
  makeList,
  setHeading,
  toggleInlineMark,
  wrapQuote,
} from '../../src/engine/input/format';
import { docStats } from '../../src/ui/statusbar';
import { DocumentModel } from '../../src/engine/model/document';
import type { LogicalSelection, Transaction } from '../../src/engine/model/types';

function setup(md = '前后文本') {
  const model = new DocumentModel();
  model.fromMarkdown(md);
  return model;
}

function caretSel(model: DocumentModel, blockIndex: number, anchor: number, focus: number): LogicalSelection {
  const block = model.getRoot()[blockIndex];
  return {
    anchor: { blockId: block.id, offset: anchor },
    focus: { blockId: block.id, offset: focus },
  };
}

function apply(model: DocumentModel, tx: Transaction | null): void {
  if (!tx) throw new Error('事务为空');
  model.apply(tx);
}

describe('format/toggleInlineMark', () => {
  it('选区包裹：加粗', () => {
    const model = setup();
    const p = model.getRoot()[0];
    const tx = toggleInlineMark(model, caretSel(model, 0, 0, 4), '**')!;
    apply(model, tx);
    expect(p).toMatchObject({ type: 'paragraph' });
    const node = model.getBlock(p.id) as { text: string };
    expect(node.text).toBe('**前后文本**');
    expect(tx.selection.anchor.offset).toBe(2);
    expect(tx.selection.focus.offset).toBe(6);
  });

  it('再次执行同标记选区 → 取消包裹', () => {
    const model = setup('**前后文本**');
    const p = model.getRoot()[0];
    apply(model, toggleInlineMark(model, caretSel(model, 0, 2, 6), '**')!);
    const node = model.getBlock(p.id) as { text: string };
    expect(node.text).toBe('前后文本');
  });

  it('空选区插入成对标记，光标居中', () => {
    const model = setup();
    const p = model.getRoot()[0];
    const tx = toggleInlineMark(model, caretSel(model, 0, 2, 2), '*')!;
    apply(model, tx);
    const node = model.getBlock(p.id) as { text: string };
    expect(node.text).toBe('前后**文本');
    expect(tx.selection.focus.offset).toBe(3);
  });

  it('行内代码包裹', () => {
    const model = setup('代码');
    apply(model, toggleInlineMark(model, caretSel(model, 0, 0, 2), '`')!);
    expect((model.getRoot()[0] as { text: string }).text).toBe('`代码`');
  });
});

describe('format/insertLink & clearFormatting', () => {
  it('选中文本转链接', () => {
    const model = setup('看这里');
    const tx = insertLink(model, caretSel(model, 0, 1, 3), 'https://e.com')!;
    apply(model, tx);
    expect((model.getRoot()[0] as { text: string }).text).toBe('看[这里](https://e.com)');
    // 光标落在 ]( 之前：1 + 1 + 2
    expect(tx.selection.focus.offset).toBe(4);
  });

  it('清除格式：标记、链接、图片', () => {
    const model = setup('**粗** *斜* `码` [链](https://e.com) ![图](data:x)');
    apply(model, clearFormatting(model, caretSel(model, 0, 0, 0))!);
    expect((model.getRoot()[0] as { text: string }).text).toBe('粗 斜 码 链 图');
  });
});

describe('format/块转换', () => {
  it('setHeading 段落 → 二级标题 → 段落', () => {
    const model = setup('内容');
    const p = model.getRoot()[0];
    apply(model, setHeading(model, p.id, 2)!);
    expect(model.getRoot()[0]).toMatchObject({ type: 'heading', level: 2 });
    apply(model, setHeading(model, p.id, 0)!);
    expect(model.getRoot()[0].type).toBe('paragraph');
  });

  it('wrapQuote 段落 → 引用', () => {
    const model = setup('内容');
    const p = model.getRoot()[0];
    const tx = wrapQuote(model, p.id)!;
    apply(model, tx);
    const quote = model.getRoot()[0];
    expect(quote.type).toBe('quote');
    if (quote.type === 'quote') {
      expect(quote.children[0].id).toBe(p.id);
    }
    expect(tx.selection.focus.blockId).toBe(p.id);
  });

  it('makeList 有序 / 任务', () => {
    const model = setup('内容');
    const p = model.getRoot()[0];
    const tx = makeList(model, p.id, true)!;
    apply(model, tx);
    const list = model.getRoot()[0];
    expect(list).toMatchObject({ type: 'list', ordered: true });
    if (list.type !== 'list') throw new Error('应为 list');
    expect(tx.selection.focus.blockId).toBe(list.items[0].id);
  });

  it('insertHr 插入分割线与空段落', () => {
    const model = setup('甲\n\n乙');
    apply(model, insertHr(model, model.getRoot()[0].id)!);
    expect(model.getRoot().map((b) => b.type)).toEqual(['paragraph', 'hr', 'paragraph', 'paragraph']);
  });

  it('insertCodeBlock：空段落原位转换，非空后插', () => {
    // fromMarkdown('') 是空文档，先构造一个空段落
    const model = setup('占位');
    const p0 = model.getRoot()[0];
    model.apply({
      ops: [{ type: 'updateText', id: p0.id, text: '' }],
      selection: { anchor: { blockId: p0.id, offset: 0 }, focus: { blockId: p0.id, offset: 0 } },
    });
    apply(model, insertCodeBlock(model, p0.id)!);
    expect(model.getRoot()[0]).toMatchObject({ type: 'code', code: '' });

    const model2 = setup('有内容');
    apply(model2, insertCodeBlock(model2, model2.getRoot()[0].id)!);
    expect(model2.getRoot().map((b) => b.type)).toEqual(['paragraph', 'code']);
  });
});

describe('ui/docStats', () => {
  it('CJK 逐字计数 + 拉丁词计数', () => {
    const s = docStats('你好 worldabc 123');
    expect(s.words).toBe(2 + 2);
    expect(s.chars).toBe('你好 worldabc 123'.length);
  });
});
