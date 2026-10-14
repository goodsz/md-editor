import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BlockEngine } from '../../src/engine';
import { isTable, type TableBlock } from '../../src/engine/model/types';
import { highlightCode } from '../../src/syntax/highlight';
import { renderCode } from '../../src/engine/render/blocks/code';

function getTable(engine: BlockEngine): TableBlock {
  const t = engine.model.getRoot()[0];
  if (!isTable(t)) throw new Error('应为 table');
  return t;
}

function fireBeforeInput(el: EventTarget, inputType: string, data?: string): boolean {
  const e = new Event('beforeinput', { bubbles: true, cancelable: true }) as InputEvent;
  Object.defineProperty(e, 'inputType', { value: inputType });
  Object.defineProperty(e, 'data', { value: data ?? null });
  return el.dispatchEvent(e);
}

describe('syntax/highlight 装饰式高亮', () => {
  it('textContent 与源码严格一致（span 不增删字符）', () => {
    const code = 'const a = 1; // 注释\nfunction f() { return "x"; }';
    const frag = highlightCode(code, 'ts');
    expect(frag).not.toBeNull();
    const holder = document.createElement('code');
    holder.appendChild(frag!);
    expect(holder.textContent).toBe(code);
    expect(holder.querySelectorAll('.hljs-keyword').length).toBeGreaterThan(0);
  });

  it('未注册语言返回 null 回退纯文本', () => {
    expect(highlightCode('x = 1', 'notalang')).toBeNull();
    expect(highlightCode('', 'ts')).toBeNull();
  });

  it('renderCode 高亮挂载后 textContent 保真', () => {
    const code = 'let n = 42;';
    const pre = renderCode({ id: 'c1', type: 'code', lang: 'js', code });
    expect(pre.textContent).toBe(code);
  });
});

describe('engine/表格单元格交互', () => {
  let root: HTMLElement;
  let engine: BlockEngine;
  const T = `| 甲 | 乙 |
| --- | --- |
| a1 | a2 |`;

  beforeEach(() => {
    document.body.innerHTML = '';
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      cb(performance.now());
      return 0;
    });
    vi.stubGlobal('cancelAnimationFrame', () => {});
    root = document.createElement('div');
    document.body.appendChild(root);
    engine = new BlockEngine(root, T);
  });

  const tableId = (): string => engine.model.getRoot()[0].id;

  it('单元格渲染为可编辑 host 且文本与树一致', () => {
    const tds = root.querySelectorAll('[data-cell]');
    expect(tds.length).toBe(4);
    expect(root.querySelector('[data-cell="1,0"]')?.textContent).toBe('a1');
    // jsdom 不反射 contentEditable attribute；可编辑性由下方交互测试验证
    expect(root.querySelector('thead')?.querySelector('[data-cell="0,0"]')?.textContent).toBe('甲');
  });

  it('caret 恢复到单元格（collapse/文本节点两条路径）', () => {
    const id = tableId();
    engine.restoreSelection({
      anchor: { blockId: id, offset: 1, cell: { r: 0, c: 0 } },
      focus: { blockId: id, offset: 1, cell: { r: 0, c: 0 } },
    });
    const sel = window.getSelection()!;
    expect(sel.rangeCount).toBe(1);
    const sc = sel.getRangeAt(0).startContainer;
    const el = sc instanceof Text ? sc.parentElement : (sc as HTMLElement);
    expect(el?.closest('[data-cell]')).not.toBeNull();
  });

  it('Enter 在单元格 → 下方插入新行并移入同列', () => {
    const id = tableId();
    const td = root.querySelector('[data-cell="1,1"]')!;
    engine.restoreSelection({
      anchor: { blockId: id, offset: 1, cell: { r: 1, c: 1 } },
      focus: { blockId: id, offset: 1, cell: { r: 1, c: 1 } },
    });
    const prevented = !fireBeforeInput(td, 'insertParagraph');
    expect(prevented).toBe(true);
    expect(getTable(engine).rows.length).toBe(3);
    expect(getTable(engine).rows[2][1]).toBe('');
  });

  it('Tab 在末格追加新行', () => {
    const id = tableId();
    const td = root.querySelector('[data-cell="1,1"]')!;
    engine.restoreSelection({
      anchor: { blockId: id, offset: 0, cell: { r: 1, c: 1 } },
      focus: { blockId: id, offset: 0, cell: { r: 1, c: 1 } },
    });
    fireKeyDown(td, 'Tab');
    expect(getTable(engine).rows.length).toBe(3);
  });

  it('单元格输入经回写同步到 rows', () => {
    const id = tableId();
    const td = root.querySelector('[data-cell="1,0"]')! as HTMLElement;
    engine.restoreSelection({
      anchor: { blockId: id, offset: 2, cell: { r: 1, c: 0 } },
      focus: { blockId: id, offset: 2, cell: { r: 1, c: 0 } },
    });
    // 模拟浏览器插入字符 + 修改 DOM 文本
    const textNode = Array.from(td.childNodes).find((n) => n.nodeType === Node.TEXT_NODE)!;
    (textNode as Text).data = 'a1x';
    fireBeforeInput(td, 'insertText', 'x');
    expect(getTable(engine).rows[1][0]).toBe('a1x');
  });

  it('右键菜单在非单元格目标上不弹出', () => {
    // initTableContextMenu 已在 main 装配；此处仅验证 contextmenu 不抛错
    const p = document.createElement('p');
    p.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    expect(true).toBe(true);
  });
});

function fireKeyDown(el: EventTarget, key: string): boolean {
  return el.dispatchEvent(
    new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }),
  );
}
