import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BlockEngine } from '../../src/engine';

/**
 * 引擎集成测试：jsdom 中模拟完整输入循环
 * （beforeinput 事件 → 块树 → 渲染 → 光标恢复）。
 * rAF 打补丁为同步执行，保证断言确定性。
 */

function fireBeforeInput(el: EventTarget, inputType: string, data?: string): boolean {
  const e = new Event('beforeinput', { bubbles: true, cancelable: true }) as InputEvent;
  Object.defineProperty(e, 'inputType', { value: inputType });
  Object.defineProperty(e, 'data', { value: data ?? null });
  return el.dispatchEvent(e);
}

function fireKeyDown(el: EventTarget, key: string, opts: KeyboardEventInit = {}): boolean {
  return el.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...opts }));
}

describe('engine/BlockEngine 集成', () => {
  let root: HTMLElement;
  let engine: BlockEngine;

  beforeEach(() => {
    document.body.innerHTML = '';
    // rAF 同步化：writeback 与渲染在同一次事件派发内完成
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      cb(performance.now());
      return 0;
    });
    vi.stubGlobal('cancelAnimationFrame', () => {});
    root = document.createElement('div');
    document.body.appendChild(root);
    engine = new BlockEngine(root, '第一段\n\n第二段');
  });

  it('首渲染：块级 DOM 就位', () => {
    const els = root.querySelectorAll('[data-block-id]');
    expect(els.length).toBe(2);
    expect(root.querySelector('p')?.textContent).toBe('第一段');
  });

  it('纯文本输入：DOM 修改经回写同步到块树', () => {
    const p = root.querySelector('p')!;
    const textNode = p.firstChild as Text;
    // 模拟浏览器默认行为：插入字符
    textNode.data = '第一段x';
    // 光标在 x 后（offset 4）
    engine.focusStart();
    const mapper = (engine as unknown as { mapper: { restore(sel: unknown): void; textOf(id: string): string | null } }).mapper;
    mapper.restore({ anchor: { blockId: p.dataset['blockId']!, offset: 4 }, focus: { blockId: p.dataset['blockId']!, offset: 4 } });
    fireBeforeInput(p, 'insertText', 'x');
    expect((engine.model.getRoot()[0] as { text: string }).text).toBe('第一段x');
    // 重渲染后 DOM 与树一致
    expect(root.querySelector('p')?.textContent).toBe('第一段x');
  });

  it('Enter 拆段：块树与 DOM 同步，光标在新块', () => {
    const p = root.querySelector('p')!;
    const blockId = p.dataset['blockId']!;
    const mapper = (engine as unknown as { mapper: { restore(sel: unknown): void } }).mapper;
    mapper.restore({ anchor: { blockId, offset: 2 }, focus: { blockId, offset: 2 } });
    const prevented = !fireBeforeInput(p, 'insertParagraph');
    expect(prevented).toBe(true);
    expect(root.querySelectorAll('[data-block-id]').length).toBe(3);
    expect((engine.model.getRoot()[0] as { text: string }).text).toBe('第一');
    expect((engine.model.getRoot()[1] as { text: string }).text).toBe('段');
    // 光标在新块
    const sel = window.getSelection()!;
    expect(sel.rangeCount).toBe(1);
    const active = root.querySelector('.block-active');
    expect(active?.getAttribute('data-block-id')).toBe(engine.model.getRoot()[1].id);
  });

  it('前缀转换：输入 # 后空格变标题', () => {
    const blockId = root.querySelector('p')!.dataset['blockId']!;
    const mapper = (engine as unknown as { mapper: { restore(sel: unknown): void } }).mapper;
    // 树中预置 "#"
    engine.applyTransaction({
      ops: [{ type: 'updateText', id: blockId, text: '#' }],
      selection: { anchor: { blockId, offset: 1 }, focus: { blockId, offset: 1 } },
    });
    // 渲染后 DOM 已重建，重新查询
    const p = root.querySelector('p')!;
    mapper.restore({ anchor: { blockId, offset: 1 }, focus: { blockId, offset: 1 } });
    const prevented = !fireBeforeInput(p, 'insertText', ' ');
    expect(prevented).toBe(true);
    expect(engine.model.getRoot()[0].type).toBe('heading');
    const h1 = root.querySelector('h1');
    expect(h1).not.toBeNull();
  });

  it('IME 冻结：合成期间事务不触发 DOM 写操作', () => {
    const p = root.querySelector('p')!;
    const elBefore = root.querySelector('[data-block-id]')!;
    // 进入合成
    p.dispatchEvent(new Event('compositionstart', { bubbles: true }));
    engine.applyTransaction({
      ops: [{ type: 'updateText', id: elBefore.getAttribute('data-block-id')!, text: '合成中的文本' }],
      selection: { anchor: { blockId: elBefore.getAttribute('data-block-id')!, offset: 0 }, focus: { blockId: elBefore.getAttribute('data-block-id')!, offset: 0 } },
    });
    // 树已更新，但 DOM 冻结
    expect((engine.model.getRoot()[0] as { text: string }).text).toBe('合成中的文本');
    expect(elBefore.textContent).toBe('第一段');
    // 合成结束 → 渲染恢复
    p.dispatchEvent(new Event('compositionend', { bubbles: true }));
    expect(root.querySelector('[data-block-id]')!.textContent).toBe('合成中的文本');
  });

  it('undo/redo：恢复文档与光标', () => {
    const p = root.querySelector('p')!;
    const blockId = p.dataset['blockId']!;
    engine.applyTransaction({
      ops: [{ type: 'updateText', id: blockId, text: '改动后的第一段' }],
      selection: { anchor: { blockId, offset: 7 }, focus: { blockId, offset: 7 } },
    });
    expect(root.querySelector('p')?.textContent).toBe('改动后的第一段');
    engine.undo();
    expect((engine.model.getRoot()[0] as { text: string }).text).toBe('第一段');
    expect(root.querySelector('p')?.textContent).toBe('第一段');
    engine.redo();
    expect((engine.model.getRoot()[0] as { text: string }).text).toBe('改动后的第一段');
  });

  it('连续输入 800ms 内合并为一条 undo 记录', () => {
    const p = root.querySelector('p')!;
    const blockId = p.dataset['blockId']!;
    for (const ch of ['a', 'b', 'c']) {
      engine.applyTransaction({
        ops: [{ type: 'updateText', id: blockId, text: `第一段${ch}` }],
        selection: { anchor: { blockId, offset: 4 }, focus: { blockId, offset: 4 } },
      });
    }
    expect((engine.model.getRoot()[0] as { text: string }).text).toBe('第一段c');
    engine.undo();
    expect((engine.model.getRoot()[0] as { text: string }).text).toBe('第一段');
  });

  it('跨块删除合并', () => {
    const [p1, p2] = Array.from(root.querySelectorAll('p'));
    const mapper = (engine as unknown as { mapper: { restore(sel: unknown): void } }).mapper;
    const id1 = p1.dataset['blockId']!;
    const id2 = p2.dataset['blockId']!;
    // 选中第一段尾部到第二段开头：'第一|段' + '第|二段' → 合并 '第一二段'，插入 X
    mapper.restore({ anchor: { blockId: id1, offset: 2 }, focus: { blockId: id2, offset: 1 } });
    const prevented = !fireBeforeInput(p1, 'insertText', 'X');
    expect(prevented).toBe(true);
    expect((engine.model.getRoot()[0] as { text: string }).text).toBe('第一二段X');
    expect(engine.model.getRoot().length).toBe(1);
  });

  it('块激活样式随选区切换', () => {
    const [p1] = Array.from(root.querySelectorAll('p'));
    const mapper = (engine as unknown as { mapper: { restore(sel: unknown): void } }).mapper;
    mapper.restore({
      anchor: { blockId: p1.dataset['blockId']!, offset: 0 },
      focus: { blockId: p1.dataset['blockId']!, offset: 0 },
    });
    p1.dispatchEvent(new Event('compositionstart', { bubbles: true }));
    p1.dispatchEvent(new Event('compositionend', { bubbles: true }));
    // selectionchange 派发
    document.dispatchEvent(new Event('selectionchange'));
    expect(root.querySelector('.block-active')).not.toBeNull();
  });

  it('ArrowLeft 在块首跳到上一块末尾', () => {
    const [, p2] = Array.from(root.querySelectorAll('p'));
    const mapper = (engine as unknown as { mapper: { restore(sel: unknown): void; capture(): { focus: { blockId: string } } | null } }).mapper;
    const id2 = p2.dataset['blockId']!;
    mapper.restore({ anchor: { blockId: id2, offset: 0 }, focus: { blockId: id2, offset: 0 } });
    fireKeyDown(p2, 'ArrowLeft');
    const captured = mapper.capture()!;
    expect(captured.focus.blockId).not.toBe(id2);
    expect((captured.focus as { blockId: string; offset: number }).offset).toBe(3);
  });
});
