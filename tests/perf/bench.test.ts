import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BlockEngine } from '../../src/engine';

/**
 * 性能基准（M1.11）：200 段文档，单次击键（回写→增量渲染→光标恢复）耗时。
 * 判据：平均 < 16ms（一帧预算）。
 * 注：jsdom 性能低于真实浏览器，此结果为保守下界；浏览器实测应更快。
 */

const PARA_COUNT = 200;
const KEYSTROKES = 100;

function fireBeforeInput(el: EventTarget, inputType: string, data?: string): boolean {
  const e = new Event('beforeinput', { bubbles: true, cancelable: true }) as InputEvent;
  Object.defineProperty(e, 'inputType', { value: inputType });
  Object.defineProperty(e, 'data', { value: data ?? null });
  return el.dispatchEvent(e);
}

describe('perf/击键基准', () => {
  let root: HTMLElement;
  let engine: BlockEngine;

  beforeEach(() => {
    document.body.innerHTML = '';
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      cb(performance.now());
      return 0;
    });
    vi.stubGlobal('cancelAnimationFrame', () => {});
    root = document.createElement('div');
    document.body.appendChild(root);
    const paragraphs = Array.from({ length: PARA_COUNT }, (_, i) => `这是第 ${i + 1} 个段落的内容文本`).join('\n\n');
    engine = new BlockEngine(root, paragraphs);
  });

  it(`200 段文档：${KEYSTROKES} 次击键平均耗时 < 16ms`, () => {
    // 定位中间段落，模拟连续打字
    const midIndex = Math.floor(PARA_COUNT / 2);
    const all = Array.from(root.querySelectorAll('p'));
    const target = all[midIndex];
    const blockId = target.dataset['blockId']!;
    const mapper = (engine as unknown as { mapper: { restore(sel: unknown): void; textOf(id: string): string | null } }).mapper;
    mapper.restore({ anchor: { blockId, offset: 3 }, focus: { blockId, offset: 3 } });

    const samples: number[] = [];
    for (let i = 0; i < KEYSTROKES; i++) {
      const ch = String.fromCharCode(97 + (i % 26));
      // 模拟浏览器默认插入：修改 DOM 文本节点
      const textNode = target.firstChild as Text;
      textNode.data = textNode.data.slice(0, 3) + ch + textNode.data.slice(3);
      // 模拟光标位置后移
      mapper.restore({ anchor: { blockId, offset: 4 + i }, focus: { blockId, offset: 4 + i } });
      const t0 = performance.now();
      fireBeforeInput(target, 'insertText', ch);
      const t1 = performance.now();
      samples.push(t1 - t0);
    }

    const avg = samples.reduce((a, b) => a + b, 0) / samples.length;
    const sorted = [...samples].sort((a, b) => a - b);
    const p95 = sorted[Math.floor(sorted.length * 0.95)];
    const max = sorted[sorted.length - 1];

    // eslint-disable-next-line no-console
    console.log(
      `[perf] ${PARA_COUNT} 段文档 ${KEYSTROKES} 次击键：avg=${avg.toFixed(2)}ms p95=${p95.toFixed(2)}ms max=${max.toFixed(2)}ms`,
    );
    expect(avg).toBeLessThan(16);
  });

  it('Enter 拆段与 Backspace 合并耗时 < 16ms（预热后 20 轮取中位数）', () => {
    const all = Array.from(root.querySelectorAll('p'));
    const target = all[Math.floor(PARA_COUNT / 2)];
    const mapper = (engine as unknown as { mapper: { restore(sel: unknown): void } }).mapper;
    const blockIdOf = (el: Element) => el.getAttribute('data-block-id')!;

    const splits: number[] = [];
    const merges: number[] = [];
    // 预热 5 轮：消除 JIT 编译与首次路径开销
    for (let w = 0; w < 5; w++) {
      mapper.restore({ anchor: { blockId: blockIdOf(target), offset: 4 }, focus: { blockId: blockIdOf(target), offset: 4 } });
      fireBeforeInput(target, 'insertParagraph');
      const warm = root.querySelector('.block-active')!;
      fireBeforeInput(warm, 'deleteContentBackward');
    }
    for (let round = 0; round < 20; round++) {
      mapper.restore({ anchor: { blockId: blockIdOf(target), offset: 4 }, focus: { blockId: blockIdOf(target), offset: 4 } });
      const t0 = performance.now();
      fireBeforeInput(target, 'insertParagraph');
      splits.push(performance.now() - t0);

      const newEl = root.querySelector('.block-active')!;
      const t1 = performance.now();
      fireBeforeInput(newEl, 'deleteContentBackward');
      merges.push(performance.now() - t1);
    }
    const median = (arr: number[]) => [...arr].sort((a, b) => a - b)[Math.floor(arr.length / 2)];

    // eslint-disable-next-line no-console
    console.log(
      `[perf] Enter 拆段中位数=${median(splits).toFixed(2)}ms Backspace 合并中位数=${median(merges).toFixed(2)}ms`,
    );
    expect(median(splits)).toBeLessThan(16);
    expect(median(merges)).toBeLessThan(16);
  });
});
