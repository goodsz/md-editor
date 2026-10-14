import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BlockEngine } from '../../src/engine';
import { OutlinePanel } from '../../src/ui/outline';

describe('ui/OutlinePanel 分界线拖拽调宽', () => {
  let outlineEl: HTMLElement;
  let resizer: HTMLElement;
  let engine: BlockEngine;
  let panel: OutlinePanel;

  beforeEach(() => {
    document.body.innerHTML = '';
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      cb(performance.now());
      return 0;
    });
    vi.stubGlobal('cancelAnimationFrame', () => {});
    // jsdom 未实现 scrollIntoView
    Element.prototype.scrollIntoView = vi.fn();
    const root = document.createElement('div');
    document.body.appendChild(root);
    engine = new BlockEngine(root, '# 甲\n\n## 乙');
    outlineEl = document.createElement('aside');
    resizer = document.createElement('div');
    document.body.append(outlineEl, resizer);
    panel = new OutlinePanel(outlineEl, engine, resizer);
  });

  function drag(from: number, to: number): void {
    resizer.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: from }));
    document.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: to }));
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  }

  it('拖拽改变宽度', () => {
    drag(300, 380); // 默认 230 + 80
    expect(outlineEl.style.width).toBe('310px');
  });

  it('宽度钳制在 160–440', () => {
    drag(300, 900); // 远超上限
    expect(outlineEl.style.width).toBe('440px');
    drag(300, 0); // 远低于下限
    expect(outlineEl.style.width).toBe('160px');
  });

  it('拖拽结束持久化宽度', () => {
    outlineEl.style.width = ''; // 复位到默认 230（模拟全新会话）
    drag(300, 380);
    expect(localStorage.getItem('md-editor:outline-w')).toBe('310px');
  });

  it('双击分界线复位宽度', () => {
    drag(300, 380);
    resizer.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    expect(outlineEl.style.width).toBe('');
    expect(localStorage.getItem('md-editor:outline-w')).toBeNull();
  });

  it('outline 隐藏时拖拽不生效', () => {
    outlineEl.hidden = true;
    drag(300, 380);
    expect(outlineEl.style.width).toBe('');
  });

  it('标题树构建与跳转选择', () => {
    outlineEl.hidden = false;
    panel.refresh();
    const items = outlineEl.querySelectorAll('.outline-item');
    expect(items.length).toBe(2);
    (items[1] as HTMLElement).click();
    const sel = window.getSelection()!;
    expect(sel.rangeCount).toBe(1);
  });
});
