// 构建后校验：在 Node 真实领域实例化内核并断言 Fenwick 行为
// （vitest vm 沙箱替换了全局 WebAssembly，无法在测试内验证）
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const bytes = new Uint8Array(
  readFileSync(path.join(root, '..', 'src', 'engine', 'wasm', 'md_kernel.wasm')),
);

const mod = new WebAssembly.Module(bytes);
const e = new WebAssembly.Instance(mod, {}).exports;
const keys = Object.keys(e);
if (!keys.includes('mdk_init') || !keys.includes('mdk_update') || !keys.includes('mdk_query')) {
  console.error('[wasm] 校验失败：导出缺失', keys);
  process.exit(1);
}

e.mdk_init(3);
e.mdk_update(0, 38);
e.mdk_update(1, 42);
e.mdk_update(2, 50);
// 前缀：38 / 80 / 130
const assert = (cond, msg) => {
  if (!cond) {
    console.error('[wasm] 校验失败：', msg);
    process.exit(1);
  }
};
assert(e.mdk_query(0) === 0, 'query(0) 应为 0 块');
assert(e.mdk_query(37) === 0, 'query(37) 应为 0 块（不足第 1 块）');
assert(e.mdk_query(38) === 1, 'query(38) 应为 1 块');
assert(e.mdk_query(80) === 2, 'query(80) 应为 2 块');
assert(e.mdk_query(130) === 3, 'query(130) 应为 3 块');
assert(e.mdk_query(99999) === 3, 'query(超界) 应为全部块');
assert(Math.abs(e.mdk_total() - 130) < 1e-9, 'total 应为 130');
assert(Math.abs(e.mdk_height_at(1) - 42) < 1e-9, 'heightAt(1) 应为 42');
// 增量更新
e.mdk_update(1, -20); // 42 → 22
assert(Math.abs(e.mdk_total() - 110) < 1e-9, '更新后 total 应为 110');
// 前缀 [38, 22, 50]：query(59) → 38≤59，60>59 → 1 块
assert(e.mdk_query(59) === 1, '更新后 query(59) 应为 1 块');
assert(e.mdk_query(60) === 2, '更新后 query(60) 应为 2 块');

console.log('[wasm] md_kernel 校验通过（exports:', keys.join(','), '）');
