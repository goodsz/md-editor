import { describe, expect, it } from 'vitest';
import {
  deleteRange,
  indentItem,
  mergeWithNext,
  mergeWithPrev,
  outdentItem,
  pasteText,
  removeBlock,
  splitBlock,
  textLeafIds,
  tryPrefixConvert,
} from '../../src/engine/input/commands';
import { DocumentModel } from '../../src/engine/model/document';

function setup(md: string) {
  const model = new DocumentModel();
  model.fromMarkdown(md);
  return model;
}

function rootTexts(model: DocumentModel): string[] {
  return model.getRoot().map((b) => ('text' in b ? b.text : b.type));
}

describe('commands/splitBlock', () => {
  it('段落中间回车：拆为两段，光标到新段首', () => {
    const model = setup('前后文');
    const p = model.getRoot()[0];
    const tx = splitBlock(model, p.id, 1);
    model.apply(tx);
    expect(rootTexts(model)).toEqual(['前', '后文']);
    const insertOp = tx.ops.find((o) => o.type === 'insert');
    expect(tx.selection.focus).toEqual({
      blockId: (insertOp && 'block' in insertOp ? (insertOp.block as { id: string }).id : ''),
      offset: 0,
    });
  });

  it('段落末尾回车：新空段落', () => {
    const model = setup('内容');
    const p = model.getRoot()[0];
    const tx = splitBlock(model, p.id, 2);
    model.apply(tx);
    expect(rootTexts(model)).toEqual(['内容', '']);
  });

  it('标题中间回车：尾段转普通段落', () => {
    const model = setup('# 大标题内容');
    const h = model.getRoot()[0];
    const tx = splitBlock(model, h.id, 3);
    model.apply(tx);
    expect(rootTexts(model)).toEqual(['大标题', '内容']);
    expect(model.getRoot()[0].type).toBe('heading');
    expect(model.getRoot()[1].type).toBe('paragraph');
  });

  it('列表项回车：续项', () => {
    const model = setup('- 甲项');
    const list = model.getRoot()[0];
    if (list.type !== 'list') throw new Error('应为 list');
    const tx = splitBlock(model, list.items[0].id, 1);
    model.apply(tx);
    const after = model.getRoot()[0];
    if (after.type !== 'list') throw new Error('应为 list');
    expect(after.items.map((i) => i.text)).toEqual(['甲', '项']);
    expect(tx.selection.focus.blockId).toBe(after.items[1].id);
  });

  it('空列表项回车：退出列表', () => {
    const model = setup('- 甲\n- ');
    const list = model.getRoot()[0];
    if (list.type !== 'list') throw new Error('应为 list');
    const tx = splitBlock(model, list.items[1].id, 0);
    model.apply(tx);
    expect(rootTexts(model)).toEqual(['list', '']);
  });

  it('唯一空列表项回车：列表转段落', () => {
    const model = setup('- ');
    const list = model.getRoot()[0];
    if (list.type !== 'list') throw new Error('应为 list');
    const tx = splitBlock(model, list.items[0].id, 0);
    model.apply(tx);
    expect(rootTexts(model)).toEqual(['']);
    expect(model.getRoot()[0].type).toBe('paragraph');
  });

  it('段落文本为 ``` 时回车转代码块', () => {
    // ``` 只能由用户键入产生（fromMarkdown 会直接解析为围栏），先经 updateText 构造
    const model = setup('段落');
    const p = model.getRoot()[0];
    model.apply({
      ops: [{ type: 'updateText', id: p.id, text: '```ts' }],
      selection: { anchor: { blockId: p.id, offset: 5 }, focus: { blockId: p.id, offset: 5 } },
    });
    const tx = splitBlock(model, p.id, 5);
    model.apply(tx);
    expect(model.getRoot()[0]).toMatchObject({ type: 'code', lang: 'ts', code: '' });
  });

  it('引用块内段落回车：新段留在引用内', () => {
    const model = setup('> 内文');
    const quote = model.getRoot()[0];
    if (quote.type !== 'quote') throw new Error('应为 quote');
    const inner = quote.children[0];
    const tx = splitBlock(model, inner.id, 1);
    model.apply(tx);
    const after = model.getRoot()[0];
    if (after.type !== 'quote') throw new Error('应为 quote');
    expect(after.children.map((c) => ('text' in c ? c.text : ''))).toEqual(['内', '文']);
  });
});

describe('commands/mergeWithPrev', () => {
  it('段首退格：并入前段', () => {
    const model = setup('前段\n\n后段');
    const p2 = model.getRoot()[1];
    const tx = mergeWithPrev(model, p2.id)!;
    model.apply(tx);
    expect(rootTexts(model)).toEqual(['前段后段']);
    expect(tx.selection.focus.offset).toBe(2);
  });

  it('标题块首退格：降级', () => {
    const model = setup('## 二级');
    const h = model.getRoot()[0];
    model.apply(mergeWithPrev(model, h.id)!);
    expect(model.getRoot()[0]).toMatchObject({ type: 'heading', level: 1 });
    model.apply(mergeWithPrev(model, h.id)!);
    expect(model.getRoot()[0].type).toBe('paragraph');
  });

  it('段首退格且前面是列表：并入最后列表项', () => {
    const model = setup('- 甲\n\n续段');
    const p = model.getRoot()[1];
    const tx = mergeWithPrev(model, p.id)!;
    model.apply(tx);
    const list = model.getRoot()[0];
    if (list.type !== 'list') throw new Error('应为 list');
    expect(list.items[0].text).toBe('甲续段');
    expect(rootTexts(model)).toEqual(['list']);
  });

  it('非首项块首退格：与前项合并', () => {
    const model = setup('- 甲\n- 乙');
    const list = model.getRoot()[0];
    if (list.type !== 'list') throw new Error('应为 list');
    const tx = mergeWithPrev(model, list.items[1].id)!;
    model.apply(tx);
    const after = model.getRoot()[0];
    if (after.type !== 'list') throw new Error('应为 list');
    expect(after.items.map((i) => i.text)).toEqual(['甲乙']);
  });

  it('空首项退格：退出列表', () => {
    const model = setup('- \n- 甲');
    const list = model.getRoot()[0];
    if (list.type !== 'list') throw new Error('应为 list');
    const tx = mergeWithPrev(model, list.items[0].id)!;
    model.apply(tx);
    const after = model.getRoot()[0];
    if (after.type !== 'list') throw new Error('应为 list');
    expect(after.items.map((i) => i.text)).toEqual(['甲']);
  });

  it('引用首块退格：移出引用', () => {
    const model = setup('> 引用\n\n后续');
    const quote = model.getRoot()[0];
    if (quote.type !== 'quote') throw new Error('应为 quote');
    const inner = quote.children[0];
    const tx = mergeWithPrev(model, inner.id)!;
    model.apply(tx);
    expect(model.getRoot()[0].type).toBe('paragraph');
    expect(rootTexts(model)).toEqual(['引用', '后续']);
  });
});

describe('commands/mergeWithNext', () => {
  it('段尾 Delete：并下一段', () => {
    const model = setup('前段\n\n后段');
    const p1 = model.getRoot()[0];
    const tx = mergeWithNext(model, p1.id)!;
    model.apply(tx);
    expect(rootTexts(model)).toEqual(['前段后段']);
  });
});

describe('commands/tryPrefixConvert', () => {
  // '#''-''> ' 等会被 fromMarkdown 直接解析为对应块，
  // 因此先建普通段落再经 updateText 构造"用户键入中"的前缀文本
  function modelWithTyped(text: string): DocumentModel {
    const model = setup('段落');
    const p = model.getRoot()[0];
    model.apply({
      ops: [{ type: 'updateText', id: p.id, text }],
      selection: { anchor: { blockId: p.id, offset: text.length }, focus: { blockId: p.id, offset: text.length } },
    });
    return model;
  }

  it('# 转一级标题', () => {
    const model = modelWithTyped('#');
    const p = model.getRoot()[0];
    const tx = tryPrefixConvert(model, p.id)!;
    model.apply(tx);
    expect(model.getRoot()[0]).toMatchObject({ type: 'heading', level: 1, text: '' });
  });

  it('- 转无序列表', () => {
    const model = modelWithTyped('-');
    const p = model.getRoot()[0];
    const tx = tryPrefixConvert(model, p.id)!;
    model.apply(tx);
    const list = model.getRoot()[0];
    expect(list.type).toBe('list');
    if (list.type === 'list') {
      expect(list.ordered).toBe(false);
      expect(list.items[0].id).toBe(tx.selection.focus.blockId);
    }
  });

  it('1. 转有序列表', () => {
    const model = modelWithTyped('1.');
    const p = model.getRoot()[0];
    const tx = tryPrefixConvert(model, p.id)!;
    model.apply(tx);
    const list = model.getRoot()[0];
    if (list.type !== 'list') throw new Error('应为 list');
    expect(list.ordered).toBe(true);
  });

  it('> 转引用块', () => {
    const model = modelWithTyped('>');
    const p = model.getRoot()[0];
    const tx = tryPrefixConvert(model, p.id)!;
    model.apply(tx);
    const quote = model.getRoot()[0];
    expect(quote.type).toBe('quote');
    if (quote.type === 'quote') {
      expect(quote.children[0].id).toBe(tx.selection.focus.blockId);
    }
  });

  it('任务标记 [x] 转勾选项', () => {
    const model = setup('- [x]');
    const list = model.getRoot()[0];
    if (list.type !== 'list') throw new Error('应为 list');
    const item = list.items[0];
    const tx = tryPrefixConvert(model, item.id)!;
    model.apply(tx);
    const after = model.getRoot()[0];
    if (after.type !== 'list') throw new Error('应为 list');
    expect(after.items[0]).toMatchObject({ checked: true, text: '' });
  });

  it('普通文本前缀不命中', () => {
    const model = setup('普通文字');
    const p = model.getRoot()[0];
    expect(tryPrefixConvert(model, p.id)).toBeNull();
  });
});

describe('commands/indent & outdent', () => {
  it('Tab：项缩进为前项子列表', () => {
    const model = setup('- 甲\n- 乙');
    const list = model.getRoot()[0];
    if (list.type !== 'list') throw new Error('应为 list');
    const tx = indentItem(model, list.items[1].id)!;
    model.apply(tx);
    const after = model.getRoot()[0];
    if (after.type !== 'list') throw new Error('应为 list');
    expect(after.items.length).toBe(1);
    const nested = after.items[0].children![0];
    if (nested.type !== 'list') throw new Error('应为嵌套 list');
    expect(nested.items[0].text).toBe('乙');
  });

  it('Shift+Tab：子项提出', () => {
    const model = setup('- 甲\n  - 乙\n  - 丙');
    const list = model.getRoot()[0];
    if (list.type !== 'list') throw new Error('应为 list');
    const nested = list.items[0].children![0];
    if (nested.type !== 'list') throw new Error('应为嵌套 list');
    const tx = outdentItem(model, nested.items[1].id)!;
    model.apply(tx);
    const after = model.getRoot()[0];
    if (after.type !== 'list') throw new Error('应为 list');
    expect(after.items.map((i) => i.text)).toEqual(['甲', '丙']);
  });
});

describe('commands/deleteRange & pasteText', () => {
  it('跨块删除：合并首尾、移除中间', () => {
    const model = setup('甲乙\n\n中间\n\n丙丁');
    const [a, b, c] = model.getRoot();
    const tx = deleteRange(
      model,
      { blockId: a.id, offset: 1 },
      { blockId: c.id, offset: 1 },
    );
    model.apply(tx);
    expect(rootTexts(model)).toEqual(['甲丁']);
    expect(model.getBlock(b.id)).toBeUndefined();
  });

  it('块内删除：原地拼接', () => {
    const model = setup('甲乙丙');
    const a = model.getRoot()[0];
    const tx = deleteRange(model, { blockId: a.id, offset: 1 }, { blockId: a.id, offset: 3 });
    model.apply(tx);
    expect(rootTexts(model)).toEqual(['甲']);
  });

  it('粘贴多行文本拆段', () => {
    const model = setup('开头');
    const p = model.getRoot()[0];
    const tx = pasteText(model, { blockId: p.id, offset: 2 }, '第一行\n第二行\n第三行');
    model.apply(tx);
    expect(rootTexts(model)).toEqual(['开头第一行', '第二行', '第三行']);
  });

  it('textLeafIds 深度优先顺序', () => {
    const model = setup('# 标题\n\n- 甲\n  - 子\n\n> 引用');
    const ids = textLeafIds(model);
    const texts = ids.map((id) => {
      const n = model.getBlock(id)!;
      return 'text' in n ? n.text : '';
    });
    expect(texts).toEqual(['标题', '甲', '子', '引用']);
  });

  it('表格作为端点：整体删除并落点后继叶', () => {
    const model = setup('前文\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n\n后文');
    const [p, table, after] = model.getRoot();
    const tx = deleteRange(model, { blockId: table.id, offset: 0 }, { blockId: table.id, offset: 4 });
    model.apply(tx);
    expect(model.getBlock(table.id)).toBeUndefined();
    expect(model.getRoot().length).toBe(2);
    expect(tx.selection.focus.blockId).toBe(after.id);
    expect(rootTexts(model)).toEqual([('text' in p ? p.text : ''), '后文']);
  });

  it('跨块选区含表格：中间表格随删除移除', () => {
    const model = setup('甲乙\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n\n丙丁');
    const [a, table, c] = model.getRoot();
    const tx = deleteRange(model, { blockId: a.id, offset: 1 }, { blockId: c.id, offset: 1 });
    model.apply(tx);
    expect(rootTexts(model)).toEqual(['甲丁']);
    expect(model.getBlock(table.id)).toBeUndefined();
  });

  it('单元格到块尾选区删除：表格整体移除不抛错', () => {
    const model = setup('前文\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n\n后文');
    const [, table] = model.getRoot();
    const tx = deleteRange(
      model,
      { blockId: table.id, offset: 1, cell: { r: 0, c: 0 } },
      { blockId: model.getRoot()[2].id, offset: 1 },
    );
    expect(() => model.apply(tx)).not.toThrow();
    expect(model.getBlock(table.id)).toBeUndefined();
  });

  it('全选删除（表格到分割线）：清空后补空段落', () => {
    const model = setup('| a |\n| --- |\n| 1 |\n\n---');
    const [table, hr] = model.getRoot();
    const tx = deleteRange(model, { blockId: table.id, offset: 0 }, { blockId: hr.id, offset: 0 });
    model.apply(tx);
    expect(model.getRoot().length).toBe(1);
    expect(model.getRoot()[0].type).toBe('paragraph');
  });

  it('端点为代码块的跨块删除：段落并入代码块', () => {
    const model = setup('```\n甲乙\n```\n\n丙丁');
    const [code, c] = model.getRoot();
    if (code.type !== 'code') throw new Error('应为 code');
    const tx = deleteRange(model, { blockId: code.id, offset: 2 }, { blockId: c.id, offset: 1 });
    model.apply(tx);
    expect(model.getBlock(c.id)).toBeUndefined();
    const after = model.getRoot()[0];
    if (after.type !== 'code') throw new Error('应为 code');
    expect(after.code).toBe('甲乙丁');
  });

  it('removeBlock：整块删除表格并保证落点', () => {
    const model = setup('前文\n\n| a |\n| --- |\n| 1 |\n\n后文');
    const [, table] = model.getRoot();
    const tx = removeBlock(model, table.id)!;
    model.apply(tx);
    expect(model.getBlock(table.id)).toBeUndefined();
    expect(rootTexts(model)).toEqual(['前文', '后文']);
  });

  it('跨块删除清空引用块：空引用一并移除', () => {
    const model = setup('甲乙\n\n> 引用\n\n丙丁');
    const [a, quote, c] = model.getRoot();
    if (quote.type !== 'quote') throw new Error('应为 quote');
    const tx = deleteRange(
      model,
      { blockId: a.id, offset: 1 },
      { blockId: quote.children[0].id, offset: 1 },
    );
    model.apply(tx);
    expect(model.getBlock(quote.id)).toBeUndefined();
    expect(model.getBlock(c.id)).toBeDefined();
    expect(rootTexts(model)).toEqual(['甲用', '丙丁']);
  });
});

describe('commands/空块转换与退出', () => {
  it('空代码块块首退格：转回段落', () => {
    const model = setup('```\n```');
    const code = model.getRoot()[0];
    if (code.type !== 'code') throw new Error('应为 code');
    const tx = mergeWithPrev(model, code.id)!;
    model.apply(tx);
    expect(model.getRoot()[0].type).toBe('paragraph');
    expect(rootTexts(model)).toEqual(['']);
  });

  it('非空代码块块首退格：不动作', () => {
    const model = setup('```\n内容\n```');
    const code = model.getRoot()[0];
    if (code.type !== 'code') throw new Error('应为 code');
    expect(mergeWithPrev(model, code.id)).toBeNull();
  });

  it('空公式块块首退格：转回段落', () => {
    const model = setup('$$\n$$');
    const math = model.getRoot()[0];
    if (math.type !== 'math') throw new Error('应为 math');
    const tx = mergeWithPrev(model, math.id)!;
    model.apply(tx);
    expect(model.getRoot()[0].type).toBe('paragraph');
  });

  it('空代码块块尾 Delete：转回段落', () => {
    const model = setup('```\n```');
    const code = model.getRoot()[0];
    if (code.type !== 'code') throw new Error('应为 code');
    const tx = mergeWithNext(model, code.id)!;
    model.apply(tx);
    expect(model.getRoot()[0].type).toBe('paragraph');
  });

  it('代码块末尾空行回车：退出代码块另起新段落', () => {
    const model = setup('```\nx\n```');
    const code0 = model.getRoot()[0];
    if (code0.type !== 'code') throw new Error('应为 code');
    model.apply({
      ops: [{ type: 'updateAttrs', id: code0.id, attrs: { code: 'const a = 1\n' } }],
      selection: { anchor: { blockId: code0.id, offset: 0 }, focus: { blockId: code0.id, offset: 0 } },
    });
    const codeRaw = model.getBlock(code0.id)!;
    if (!('type' in codeRaw) || codeRaw.type !== 'code') throw new Error('应为 code');
    // code = 'const a = 1\n'（末尾空行），光标在末尾回车 → 新段落
    const tx = splitBlock(model, codeRaw.id, codeRaw.code.length);
    model.apply(tx);
    expect(model.getRoot().length).toBe(2);
    expect(model.getRoot()[1].type).toBe('paragraph');
    expect(tx.selection.focus.blockId).toBe(model.getRoot()[1].id);
  });

  it('代码块中间回车：仍为块内换行', () => {
    const model = setup('```\nab\n```');
    const code0 = model.getRoot()[0];
    if (code0.type !== 'code') throw new Error('应为 code');
    const tx = splitBlock(model, code0.id, 1);
    model.apply(tx);
    const after = model.getRoot()[0];
    if (after.type !== 'code') throw new Error('应为 code');
    expect(after.code).toBe('a\nb\n');
  });
});
