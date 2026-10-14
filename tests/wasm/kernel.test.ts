// 纯数值内核对拍：不依赖 DOM。
// 说明：vitest vm 沙箱会替换全局 WebAssembly（instantiate 返回空导出），
// WASM 内核的正确性由构建期 scripts/verify-kernel.mjs（Node 真实领域）硬校验；
// 本文件回归 TS Fenwick 实现的算法正确性 + WASM 加载冒烟（沙箱可用时）。
import { describe, expect, it } from 'vitest';
import { getKernel, HeightIndex, loadKernel } from '../../src/engine/wasm/kernel';

/** 朴素 O(n) 前缀和参照实现 */
class NaiveIndex {
  private h: number[] = [];
  rebuild(heights: number[]): void {
    this.h = [...heights];
  }
  update(i: number, delta: number): void {
    this.h[i] += delta;
  }
  locate(offset: number): number {
    let acc = 0;
    for (let i = 0; i < this.h.length; i++) {
      if (acc + this.h[i] > offset) return i;
      acc += this.h[i];
    }
    return this.h.length;
  }
  total(): number {
    return this.h.reduce((a, b) => a + b, 0);
  }
}

function compareIndex(k: HeightIndex, naive: NaiveIndex): void {
  expect(k.total()).toBeCloseTo(naive.total(), 6);
  for (let off = 0; off <= naive.total() + 40; off += Math.max(1, Math.floor(naive.total() / 40))) {
    expect(k.locate(off)).toBe(naive.locate(off));
  }
}

describe('Fenwick 高度索引（虚拟化窗口定位）', () => {
  it('与朴素前缀和对拍（随机数据 + 随机增量）', () => {
    const idx = new HeightIndex(null);
    const naive = new NaiveIndex();
    let seed = 7;
    const rand = (): number => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    const n = 500;
    const heights = Array.from({ length: n }, () => 20 + rand() * 90);
    idx.rebuild(heights);
    naive.rebuild(heights);
    compareIndex(idx, naive);

    for (let step = 0; step < 400; step++) {
      const i = Math.floor(rand() * n);
      const newH = 20 + rand() * 90;
      const delta = newH - heights[i];
      heights[i] = newH;
      idx.update(i, delta);
      naive.update(i, delta);
      if (step % 40 === 0) compareIndex(idx, naive);
    }
    compareIndex(idx, naive);
  });

  it('空索引与单块边界', () => {
    const idx = new HeightIndex(null);
    idx.rebuild([]);
    expect(idx.locate(0)).toBe(0);
    expect(idx.total()).toBe(0);
    idx.rebuild([50]);
    expect(idx.locate(0)).toBe(0);
    expect(idx.locate(50)).toBe(1);
    expect(idx.locate(9999)).toBe(1);
  });

  it('WASM 内核加载冒烟（沙箱内不可用时跳过，构建期已由 verify-kernel 硬校验）', async () => {
    const ok = await loadKernel();
    if (!ok) {
      console.warn('[wasm] 当前测试沙箱内内核不可用——跳过对拍（构建期 verify-kernel 已硬校验）');
      return;
    }
    const k = new HeightIndex(getKernel());
    const naive = new NaiveIndex();
    const heights = Array.from({ length: 300 }, (_, i) => 25 + ((i * 53) % 80));
    k.rebuild(heights);
    naive.rebuild(heights);
    compareIndex(k, naive);
  });
});
