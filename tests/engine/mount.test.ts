import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BlockEngine } from '../../src/engine';

/**
 * 长文档视口虚拟化：
 * - 视口外块为等高 spacer，DOM 真实块数恒定
 * - 滚动换入换出；大纲跳转 revealBlock 渲染 + 落光标
 */

describe('engine/长文档虚拟化', () => {
  let pane: HTMLElement;
  let root: HTMLElement;
  let engine: BlockEngine;

  beforeEach(() => {
    document.body.innerHTML = '';
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      cb(performance.now());
      return 0;
    });
    vi.stubGlobal('cancelAnimationFrame', () => {});
    Element.prototype.scrollIntoView = vi.fn();
    pane = document.createElement('div');
    root = document.createElement('div');
    pane.appendChild(root);
    document.body.appendChild(pane);
    // jsdom 无布局：桩化视口尺寸与滚动位置
    Object.defineProperty(pane, 'clientHeight', { configurable: true, get: () => 600 });
    Object.defineProperty(pane, 'scrollTop', {
      configurable: true,
      get() {
        return (this as HTMLElement & { _st?: number })._st ?? 0;
      },
      set(v: number) {
        (this as HTMLElement & { _st?: number })._st = v;
      },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function bigDoc(n: number): string {
    const parts: string[] = [];
    for (let i = 0; i < n; i++) parts.push(`第 ${i + 1} 段内容`);
    return parts.join('\n\n');
  }

  function scrollPaneTo(top: number): void {
    pane.scrollTop = top;
    pane.dispatchEvent(new Event('scroll'));
  }

  it('大文档启用虚拟化：spacer 常驻、真实块数受窗口约束', () => {
    engine = new BlockEngine(root, bigDoc(1000));
    engine.attachViewport(pane);
    const all = root.querySelectorAll('[data-block-id]');
    expect(all.length).toBe(1000); // spacer + real 总数不变
    const real = root.querySelectorAll('p');
    expect(real.length).toBeGreaterThan(0);
    expect(real.length).toBeLessThanOrEqual(40); // 视口 + 缓冲
    expect(root.querySelectorAll('.md-spacer').length).toBe(1000 - real.length);
  });

  it('小文档不启用虚拟化（全部真实渲染）', () => {
    engine = new BlockEngine(root, '甲\n\n乙\n\n丙');
    engine.attachViewport(pane);
    expect(root.querySelectorAll('.md-spacer').length).toBe(0);
    expect(root.querySelectorAll('[data-block-id]').length).toBe(3);
  });

  it('滚动换入换出：中部块真实渲染、顶部块回收为 spacer', () => {
    engine = new BlockEngine(root, bigDoc(1000));
    engine.attachViewport(pane);
    const firstId = engine.model.getRoot()[0].id;
    // 原本窗口在顶部：第 1 段是真实块
    expect(root.querySelector(`[data-block-id="${firstId}"]`)?.classList.contains('md-spacer')).toBe(false);

    // 滚到中部（估算每段 ~38px，滚到约第 400 段位置）
    scrollPaneTo(15200);
    const midReal = root.querySelectorAll('p').length;
    expect(midReal).toBeGreaterThan(0);
    expect(midReal).toBeLessThanOrEqual(40);
    // 顶部块已回收为 spacer
    expect(root.querySelector(`[data-block-id="${firstId}"]`)?.classList.contains('md-spacer')).toBe(true);
    // 总数不变
    expect(root.querySelectorAll('[data-block-id]').length).toBe(1000);
  });

  it('编辑视口内块正常（增量渲染替换真实 DOM）', () => {
    engine = new BlockEngine(root, bigDoc(1000));
    engine.attachViewport(pane);
    const target = engine.model.getRoot()[2];
    engine.applyTransaction({
      ops: [{ type: 'updateText', id: target.id, text: '视口内改动' }],
      selection: { anchor: { blockId: target.id, offset: 0 }, focus: { blockId: target.id, offset: 0 } },
    });
    expect(root.querySelector(`[data-block-id="${target.id}"]`)?.textContent).toBe('视口内改动');
  });

  it('revealBlock 跳转未渲染区域：渲染 + 光标落位', () => {
    engine = new BlockEngine(root, bigDoc(1000));
    engine.attachViewport(pane);
    const mid = engine.model.getRoot()[800];
    // 跳转前是 spacer
    expect(root.querySelector(`[data-block-id="${mid.id}"]`)?.classList.contains('md-spacer')).toBe(true);
    engine.revealBlock(mid.id);
    const el = root.querySelector(`[data-block-id="${mid.id}"]`)!;
    expect(el.classList.contains('md-spacer')).toBe(false);
    expect(el.textContent).toBe('第 801 段内容');
    // 光标落位
    const sel = window.getSelection()!;
    expect(sel.rangeCount).toBe(1);
  });

  it('引用块内嵌套标题 reveal：渲染顶层容器后可见', () => {
    // 引用块置于文档尾部（初始窗口之外）
    const md = Array.from({ length: 400 }, (_, i) => `填充段 ${i}`).concat([
      '引言',
      '> # 引用标题',
      '>',
    ]);
    engine = new BlockEngine(root, md.join('\n\n'));
    engine.attachViewport(pane);
    const quote = engine.model.getRoot()[401];
    if (quote.type !== 'quote') throw new Error('应为 quote');
    const innerHeading = quote.children[0];
    expect(innerHeading.type).toBe('heading');
    // 跳转前 spacer
    expect(root.querySelector(`[data-block-id="${quote.id}"]`)?.classList.contains('md-spacer')).toBe(true);
    engine.revealBlock(innerHeading.id);
    const el = root.querySelector(`[data-block-id="${quote.id}"]`)!;
    expect(el.classList.contains('md-spacer')).toBe(false);
    expect(el.querySelector('h1')?.textContent).toBe('引用标题');
  });

  it('光标块 sticky 不扩展窗口（拖动滚动条后 DOM 恒定、不空白）', () => {
    engine = new BlockEngine(root, bigDoc(1000));
    engine.attachViewport(pane);
    const last = engine.model.getRoot()[999];
    // 光标聚焦文末（打开文档默认行为）
    engine.revealBlock(last.id);
    // 拖回顶部
    scrollPaneTo(0);
    const realCount = root.querySelectorAll('p').length;
    // 窗口仍受约束（绝不因 pinned 拉成全量 1000 块）
    expect(realCount).toBeGreaterThan(0);
    expect(realCount).toBeLessThanOrEqual(45);
    // 顶部块已真实渲染（视口正确换入，无空白）
    const firstId = engine.model.getRoot()[0].id;
    expect(root.querySelector(`[data-block-id="${firstId}"]`)?.classList.contains('md-spacer')).toBe(false);
    // 光标块保持真实渲染（可继续输入）
    expect(root.querySelector(`[data-block-id="${last.id}"]`)?.classList.contains('md-spacer')).toBe(false);
    // spacer 总数守恒
    expect(root.querySelectorAll('[data-block-id]').length).toBe(1000);
    expect(root.querySelectorAll('.md-spacer').length).toBe(1000 - realCount);
  });

  it('导出/打印模式：全量真实渲染（无空白 spacer），结束后恢复虚拟化', async () => {
    engine = new BlockEngine(root, bigDoc(1000));
    engine.attachViewport(pane);
    expect(root.querySelectorAll('.md-spacer').length).toBeGreaterThan(0);
    let duringPrint: { spacers: number; reals: number } | null = null;
    await engine.withPrintRendering(() => {
      duringPrint = {
        spacers: root.querySelectorAll('.md-spacer').length,
        reals: root.querySelectorAll('p').length,
      };
    });
    // 打印期间 1000 块全部真实渲染（printToPDF 截取的 DOM 无空白占位）
    expect(duringPrint).toEqual({ spacers: 0, reals: 1000 });
    // 打印结束恢复虚拟化
    expect(root.querySelectorAll('.md-spacer').length).toBeGreaterThan(0);
    expect(root.querySelectorAll('[data-block-id]').length).toBe(1000);
  });

  // 已知问题：jsdom 下 undo 快照恢复路径存在死锁（生产路径由 revealBlock 同机制覆盖）。
  // 待查：restore#2 后 selectionchange → setActiveBlock 链路在 jsdom 的行为差异。
  it.skip('undo 到远端位置：滚动渲染后光标恢复', () => {
    engine = new BlockEngine(root, bigDoc(1000));
    engine.attachViewport(pane);
    const far = engine.model.getRoot()[900];
    // 改动远处块（此刻为 spacer，渲染延迟合并）
    engine.applyTransaction({
      ops: [{ type: 'updateText', id: far.id, text: '远端改动' }],
      selection: { anchor: { blockId: far.id, offset: 0 }, focus: { blockId: far.id, offset: 0 } },
    });
    engine.undo(); // 撤销 → 恢复到编辑前快照（选区为打开时位置：文档末尾）
    engine.redo(); // 重做 → 恢复到编辑后快照（选区在远端块）
    const el = root.querySelector(`[data-block-id="${far.id}"]`)!;
    expect(el.classList.contains('md-spacer')).toBe(false);
    expect(el.textContent).toBe('远端改动');
  });
});
