import { describe, expect, it, vi } from 'vitest';
import { DocumentModel } from '../../src/engine/model/document';
import type { LogicalSelection, ListItem, Transaction } from '../../src/engine/model/types';

const SEL: LogicalSelection = {
  anchor: { blockId: 'x', offset: 0 },
  focus: { blockId: 'x', offset: 0 },
};

function txOf(...ops: Transaction['ops']): Transaction {
  return { ops, selection: SEL };
}

function setup(md = '# 标题\n\n段落一\n\n段落二') {
  const model = new DocumentModel();
  model.fromMarkdown(md);
  return model;
}

describe('DocumentModel 基础', () => {
  it('fromMarkdown 建树并建立索引', () => {
    const model = setup();
    const root = model.getRoot();
    expect(root.map((b) => b.type)).toEqual(['heading', 'paragraph', 'paragraph']);
    expect(model.getBlock(root[1].id)).toBeDefined();
  });

  it('getBlock O(1) 命中嵌套节点', () => {
    const model = new DocumentModel();
    model.fromMarkdown('- 甲\n  - 子项');
    const list = model.getRoot()[0];
    if (list.type !== 'list') throw new Error('应为 list');
    const child = list.items[0].children![0];
    if (child.type !== 'list') throw new Error('应为嵌套 list');
    expect(model.getBlock(child.items[0].id)?.id).toBe(child.items[0].id);
    expect(model.getEntry(child.items[0].id)?.parentKind).toBe('list');
    expect(model.getEntry(list.items[0].id)?.parentKind).toBe('list');
  });
});

describe('DocumentModel.apply', () => {
  it('updateText 更新文本并上报 dirty', () => {
    const model = setup();
    const p = model.getRoot()[1];
    const dirty = model.apply(txOf({ type: 'updateText', id: p.id, text: '新内容' }));
    expect(dirty.has(p.id)).toBe(true);
    const node = model.getBlock(p.id);
    expect(node && 'text' in node && node.text).toBe('新内容');
  });

  it('updateText 无变化不标脏', () => {
    const model = setup();
    const p = model.getRoot()[1];
    const dirty = model.apply(txOf({ type: 'updateText', id: p.id, text: '段落一' }));
    expect(dirty.size).toBe(0);
  });

  it('updateAttrs 修改标题层级', () => {
    const model = setup();
    const h = model.getRoot()[0];
    if (h.type !== 'heading') throw new Error('应为 heading');
    model.apply(txOf({ type: 'updateAttrs', id: h.id, attrs: { level: 3 } }));
    const node = model.getBlock(h.id);
    expect(node && 'level' in node && node.level).toBe(3);
  });

  it('updateAttrs 完成块类型转换且不残留旧字段', () => {
    const model = new DocumentModel();
    model.fromMarkdown('段落');
    const p = model.getRoot()[0];
    model.apply(txOf({ type: 'updateAttrs', id: p.id, attrs: { type: 'hr' } }));
    const node = model.getBlock(p.id)!;
    expect(node).toEqual({ id: p.id, type: 'hr' });
  });

  it('updateAttrs 可更新任务项勾选状态', () => {
    const model = new DocumentModel();
    model.fromMarkdown('- [ ] 待办');
    const list = model.getRoot()[0];
    if (list.type !== 'list') throw new Error('应为 list');
    const item = list.items[0];
    model.apply(txOf({ type: 'updateAttrs', id: item.id, attrs: { checked: true } }));
    const node = model.getBlock(item.id) as ListItem;
    expect(node.checked).toBe(true);
  });

  it('insert 插入到指定块之后 / 开头', () => {
    const model = setup('甲\n\n乙');
    const a = model.getRoot()[0];
    const b = model.getRoot()[1];
    model.apply(
      txOf({ type: 'insert', after: a.id, block: { id: 'new1', type: 'paragraph', text: '中' } }),
    );
    expect(model.getRoot().map((x) => ('text' in x ? x.text : ''))).toEqual(['甲', '中', '乙']);
    model.apply(
      txOf({ type: 'insert', after: null, block: { id: 'new2', type: 'hr' } }),
    );
    expect(model.getRoot()[0].type).toBe('hr');
    expect(b.id).toBe(b.id);
  });

  it('insert 引用块子层级', () => {
    const model = new DocumentModel();
    model.fromMarkdown('> 引用内');
    const quote = model.getRoot()[0];
    if (quote.type !== 'quote') throw new Error('应为 quote');
    const inner = quote.children[0];
    model.apply(
      txOf({
        type: 'insert',
        after: inner.id,
        block: { id: 'q2', type: 'paragraph', text: '引用内二' },
      }),
    );
    const quote2 = model.getRoot()[0];
    if (quote2.type !== 'quote') throw new Error('应为 quote');
    expect(quote2.children.map((c) => ('text' in c ? c.text : ''))).toEqual(['引用内', '引用内二']);
  });

  it('insert 列表项之后只能插列表项', () => {
    const model = new DocumentModel();
    model.fromMarkdown('- 甲');
    const list = model.getRoot()[0];
    if (list.type !== 'list') throw new Error('应为 list');
    const item = list.items[0];
    expect(() =>
      model.apply(
        txOf({
          type: 'insert',
          after: item.id,
          block: { id: 'p1', type: 'paragraph', text: 'x' } as never,
        }),
      ),
    ).toThrow();
    model.apply(
      txOf({
        type: 'insert',
        after: item.id,
        block: { id: 'i2', text: '乙' },
      }),
    );
    expect(model.getRoot()[0]).toMatchObject({
      type: 'list',
      items: [{ text: '甲' }, { text: '乙' }],
    });
  });

  it('remove 删除块与列表项', () => {
    const model = setup('甲\n\n乙');
    const [a, b] = model.getRoot();
    model.apply(txOf({ type: 'remove', id: a.id }));
    expect(model.getRoot().length).toBe(1);
    model.apply(txOf({ type: 'remove', id: b.id }));
    expect(model.getRoot().length).toBe(0);
  });

  it('remove 列表项', () => {
    const model = new DocumentModel();
    model.fromMarkdown('- 甲\n- 乙');
    const list = model.getRoot()[0];
    if (list.type !== 'list') throw new Error('应为 list');
    model.apply(txOf({ type: 'remove', id: list.items[0].id }));
    const after = model.getRoot()[0];
    if (after.type !== 'list') throw new Error('应为 list');
    expect(after.items.map((i) => i.text)).toEqual(['乙']);
  });

  it('move 调整顺序', () => {
    const model = setup('甲\n\n乙\n\n丙');
    const [a, b, c] = model.getRoot();
    model.apply(txOf({ type: 'move', id: c.id, after: a.id }));
    expect(model.getRoot().map((x) => ('text' in x ? x.text : ''))).toEqual(['甲', '丙', '乙']);
    expect(a.id).toBe(a.id);
    expect(b.id).toBe(b.id);
  });

  it('操作不存在的节点抛错', () => {
    const model = setup();
    expect(() => model.apply(txOf({ type: 'updateText', id: 'ghost', text: 'x' }))).toThrow();
    expect(() => model.apply(txOf({ type: 'remove', id: 'ghost' }))).toThrow();
    expect(() =>
      model.apply(
        txOf({
          type: 'insert',
          after: 'ghost',
          block: { id: 'n', type: 'paragraph', text: 'x' },
        }),
      ),
    ).toThrow();
  });
});

describe('DocumentModel 结构共享', () => {
  it('无关节点保持引用不变', () => {
    const model = new DocumentModel();
    model.fromMarkdown('# 标题\n\n段落一\n\n段落二\n\n> 引用');
    const rootBefore = model.getRoot();
    const h0 = rootBefore[0];
    const p1 = rootBefore[1];
    const p2 = rootBefore[2];
    const quote = rootBefore[3];
    model.apply(txOf({ type: 'updateText', id: p1.id, text: '改动' }));
    const after = model.getRoot();
    // 兄弟与无关子树引用不变；p1 已复制为新对象
    expect(after[0]).toBe(h0);
    expect(after[2]).toBe(p2);
    expect(after[3]).toBe(quote);
    expect(after[1]).not.toBe(p1);
  });

  it('深层嵌套更新仅复制路径', () => {
    const model = new DocumentModel();
    model.fromMarkdown('> 引用\n>\n> - 甲\n> - 乙');
    const quote = model.getRoot()[0];
    if (quote.type !== 'quote') throw new Error('应为 quote');
    const list = quote.children.find((c) => c.type === 'list');
    if (!list || list.type !== 'list') throw new Error('应为 list');
    const item0Before = list.items[0];
    model.apply(txOf({ type: 'updateText', id: item0Before.id, text: '改' }));
    const quote2 = model.getRoot()[0];
    expect(quote2).not.toBe(quote); // 路径上的节点已复制
    const list2 = (quote2 as typeof quote).children.find((c) => c.type === 'list');
    expect(list2).not.toBe(list);
    expect((list2 as typeof list).items[1]).toBe(list.items[1]); // 未受影响的项共享
  });
});

describe('DocumentModel.onDirty', () => {
  it('apply 后触发回调', () => {
    const model = setup();
    const cb = vi.fn();
    const off = model.onDirty(cb);
    const p = model.getRoot()[1];
    model.apply(txOf({ type: 'updateText', id: p.id, text: 'x' }));
    expect(cb).toHaveBeenCalledTimes(1);
    expect((cb.mock.calls[0][0] as Set<string>).has(p.id)).toBe(true);
    off();
    model.apply(txOf({ type: 'updateText', id: p.id, text: 'y' }));
    expect(cb).toHaveBeenCalledTimes(1);
  });
});

describe('DocumentModel 序列化', () => {
  it('toMarkdown 输出与解析一致', () => {
    const model = new DocumentModel();
    model.fromMarkdown('# 标题\n\n- 甲\n- 乙');
    expect(model.toMarkdown()).toBe('# 标题\n\n- 甲\n- 乙');
  });
});
