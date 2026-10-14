/**
 * WASM 数值内核加载器 + 高度前缀索引（ADR-0001 P3）。
 *
 * HeightIndex 用 Fenwick 树维护虚拟化各块高度的前缀和：
 * - 内核可用（md_kernel.wasm 加载成功）→ Rust 实现，O(log n) 定位
 * - 内核不可用 → TS 同算法回退（无 WASM 环境行为一致）
 * 两者经 tests/wasm/kernel.test.ts 随机数据对拍。
 *
 * 加载通道：内核二进制以 base64 内嵌于 kernel-bytes.ts（npm run wasm:build 生成），
 * atob 解码在浏览器 / Electron / Node 原生可用，无 URL/路径环境差异。
 */

import { KERNEL_BASE64 } from './kernel-bytes';

export interface KernelExports {
  memory: WebAssembly.Memory;
  mdk_init(n: number): void;
  mdk_update(i: number, delta: number): void;
  mdk_query(v: number): number;
  mdk_total(): number;
  mdk_height_at(i: number): number;
}

let instance: KernelExports | null | undefined; // undefined=未尝试加载，null=加载失败

function decodeBase64(b64: string): Uint8Array<ArrayBuffer> {
  const bin = atob(b64);
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** 懒加载内核；失败静默降级（返回 false，调用方走 TS 回退）。
 *  注意：用两步 Module+Instance 实例化——Node 22 的单步 instantiate
 *  (BufferSource) 在部分环境下会 resolve 出空导出。 */
export async function loadKernel(): Promise<boolean> {
  if (instance !== undefined) return instance !== null;
  try {
    const bytes = decodeBase64(KERNEL_BASE64);
    const mod = new WebAssembly.Module(bytes);
    const inst = new WebAssembly.Instance(mod, {});
    if (!inst.exports) throw new Error('内核 exports 为空');
    instance = inst.exports as unknown as KernelExports;
    return true;
  } catch (e) {
    console.error('[wasm] 内核加载失败，回退 TS 实现：', e);
    instance = null;
    return false;
  }
}

/** 当前内核实例（未加载/不可用为 null） */
export function getKernel(): KernelExports | null {
  return instance ?? null;
}

export class HeightIndex {
  private n = 0;
  private ts: number[] = []; // TS 回退 Fenwick（1-based）
  private logN = 0;
  private k: KernelExports | null;

  constructor(kernel: KernelExports | null) {
    this.k = kernel;
  }

  /** 以各块高度重建索引（O(n)） */
  rebuild(heights: number[]): void {
    this.n = heights.length;
    if (this.k) {
      this.k.mdk_init(this.n);
      for (let i = 0; i < this.n; i++) this.k.mdk_update(i, heights[i]);
      return;
    }
    this.ts = new Array(this.n + 1).fill(0);
    this.logN = 1;
    while ((this.logN << 1) <= this.n) this.logN <<= 1;
    for (let i = 0; i < this.n; i++) this.addTs(i, heights[i]);
  }

  /** 块 i 高度变化 delta（增量 O(log n)） */
  update(i: number, delta: number): void {
    if (this.n === 0 || i < 0 || i >= this.n) return;
    if (this.k) {
      this.k.mdk_update(i, delta);
      return;
    }
    this.addTs(i, delta);
  }

  /** 定位：前缀和 ≤ offset 的最大块数（视口边界处的块下标，0-based 排他） */
  locate(offset: number): number {
    if (this.k) return this.k.mdk_query(offset);
    let pos = 0;
    let rem = offset;
    let bit = this.logN;
    while (bit !== 0) {
      const np = pos + bit;
      if (np <= this.n && rem >= this.ts[np]) {
        pos = np;
        rem -= this.ts[np];
      }
      bit >>= 1;
    }
    return pos;
  }

  /** 全部高度总和 */
  total(): number {
    if (this.k) return this.k.mdk_total();
    let s = 0;
    for (let x = this.n; x > 0; x -= x & -x) s += this.ts[x];
    return s;
  }

  /** 单块高度（对拍用） */
  heightAt(i: number): number {
    if (this.k) return this.k.mdk_height_at(i);
    const top = Math.min(i + 1, this.n);
    let s = 0;
    for (let x = top; x > 0; x -= x & -x) s += this.ts[x];
    return s;
  }

  private addTs(i: number, delta: number): void {
    for (let x = i + 1; x <= this.n; x += x & -x) this.ts[x] += delta;
  }
}
