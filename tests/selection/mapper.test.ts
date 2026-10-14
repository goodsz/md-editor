import { beforeEach, describe, expect, it } from 'vitest';
import { DocumentModel } from '../../src/engine/model/document';
import { BlockRenderer } from '../../src/engine/render/renderer';
import { SelectionMapper } from '../../src/engine/selection/mapper';

function setup(md: string) {
  const model = new DocumentModel();
  model.fromMarkdown(md);
  const renderer = new BlockRenderer(model);
  const root = document.createElement('div');
  document.body.appendChild(root);
  renderer.mount(root);
  const mapper = new SelectionMapper();
  mapper.setRoot(root);
  return { model, renderer, root, mapper };
}

/** 把光标放到块的 DOM 文本节点偏移处 */
function placeCaret(mapper: SelectionMapper, blockId: string, offset: number): void {
  mapper.restore({
    anchor: { blockId, offset },
    focus: { blockId, offset },
  });
}

describe('selection/mapper', () => {
  let env: ReturnType<typeof setup>;

  beforeEach(() => {
    document.body.innerHTML = '';
    env = setup('# 标题\n\n含 **加粗** 的段落');
  });

  it('纯文本块 capture/restore 往返一致', () => {
    const heading = env.model.getRoot()[0];
    placeCaret(env.mapper, heading.id, 1);
    const captured = env.mapper.capture();
    expect(captured?.focus).toEqual({ blockId: heading.id, offset: 1 });
    // restore 后 DOM 选区落在文本节点内
    const dom = window.getSelection()!;
    expect(dom.rangeCount).toBe(1);
  });

  it('含行内标记的块：offset 覆盖标记字符', () => {
    const p = env.model.getRoot()[1];
    // 文本 "含 **加粗** 的段落"，偏移 3 = "含 [" 之后
    placeCaret(env.mapper, p.id, 3);
    const captured = env.mapper.capture();
    expect(captured?.focus).toEqual({ blockId: p.id, offset: 3 });
  });

  it('重渲染后 restore 光标位置语义不变', () => {
    const p = env.model.getRoot()[1];
    placeCaret(env.mapper, p.id, 6);
    const before = env.mapper.capture()!;
    // 全量重渲染（模拟 dirty 渲染）
    env.renderer.mount(env.root);
    env.mapper.restore(before);
    const after = env.mapper.capture()!;
    expect(after.focus).toEqual(before.focus);
  });

  it('越界 offset 收敛到块尾', () => {
    const p = env.model.getRoot()[1];
    const len = env.mapper.textOf(p.id)!.length;
    env.mapper.restore({
      anchor: { blockId: p.id, offset: len + 100 },
      focus: { blockId: p.id, offset: len + 100 },
    });
    const captured = env.mapper.capture()!;
    expect(captured.focus.offset).toBe(len);
  });

  it('textOf 对列表项排除嵌套子块', () => {
    document.body.innerHTML = '';
    const env2 = setup('- 甲项\n  - 嵌套项');
    const list = env2.model.getRoot()[0];
    if (list.type !== 'list') throw new Error('应为 list');
    expect(env2.mapper.textOf(list.items[0].id)).toBe('甲项');
    const child = list.items[0].children?.[0];
    if (!child || child.type !== 'list') throw new Error('应为嵌套 list');
    expect(env2.mapper.textOf(child.items[0].id)).toBe('嵌套项');
  });

  it('选区在编辑器外时 capture 返回 null', () => {
    const outside = document.createElement('p');
    document.body.appendChild(outside);
    outside.textContent = '外部';
    const range = document.createRange();
    range.selectNodeContents(outside);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);
    expect(env.mapper.capture()).toBeNull();
  });

  it('端点含空块（br 撑行）时 restore 回退块边界（Ctrl+A 场景）', () => {
    document.body.innerHTML = '';
    const env2 = setup('甲\n\n乙');
    const [a, b] = env2.model.getRoot();
    // 模拟编辑中产生的首部空段落
    env2.model.apply({
      ops: [{ type: 'insert', after: null, block: { id: 'empty-p', type: 'paragraph', text: '' } }],
      selection: { anchor: { blockId: a.id, offset: 0 }, focus: { blockId: a.id, offset: 0 } },
    });
    env2.renderer.mount(env2.root);
    const ok = env2.mapper.restore({
      anchor: { blockId: 'empty-p', offset: 0 },
      focus: { blockId: b.id, offset: 1 },
    });
    expect(ok).toBe(true);
    const dom = window.getSelection()!;
    expect(dom.rangeCount).toBe(1);
    expect(dom.isCollapsed).toBe(false);
  });
});
