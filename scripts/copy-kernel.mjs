import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const wasmPath = path.join(root, '..', 'wasm', 'md-kernel', 'target', 'wasm32-unknown-unknown', 'release', 'md_kernel.wasm');
const destDir = path.join(root, '..', 'src', 'engine', 'wasm');
const dest = path.join(destDir, 'kernel-bytes.ts');

const bytes = readFileSync(wasmPath);
const b64 = bytes.toString('base64');
mkdirSync(destDir, { recursive: true });

// 生成内嵌 base64 模块：atob 解码在浏览器 / Electron / Node 全原生可用，
// 避免 wasm 资源 URL 在不同运行环境（vite dev/build/ssr）下的加载差异
const ts = `// 自动生成：npm run wasm:build（请勿手改）
// 来源：wasm/md-kernel（Rust Fenwick 高度索引内核，${bytes.length} 字节）

/** wasm 二进制（base64） */
export const KERNEL_BASE64 = '${b64}';
`;

writeFileSync(dest, ts);
console.log(`[wasm] kernel-bytes.ts generated (${bytes.length} bytes wasm -> ${b64.length} chars b64)`);
