import { docToMarkdown, tokensToDoc } from '../model/convert';
import { parseTokens } from '../../syntax/markdown';
import type { Block, Doc } from '../model/types';

/**
 * 文档 Worker 客户端：请求-响应封装。
 * Worker 构造失败（无 Worker 环境/测试环境）自动回退为主线程同步执行，
 * 两条路径输出完全一致（同模块实现）。
 */

type Req =
  | { id: number; type: 'parse'; md: string }
  | { id: number; type: 'serialize'; blocks: Doc };

let worker: Worker | null | undefined; // undefined=未尝试
let seq = 0;
const pending = new Map<
  number,
  { resolve: (v: { blocks?: Doc; md?: string }) => void; reject: (e: Error) => void }
>();

function getWorker(): Worker | null {
  if (worker !== undefined) return worker;
  try {
    const w = new Worker(new URL('./doc.worker.ts', import.meta.url), { type: 'module' });
    w.onmessage = (e: MessageEvent<{ id: number; ok: boolean; blocks?: Doc; md?: string; error?: string }>) => {
      const p = pending.get(e.data.id);
      if (!p) return;
      pending.delete(e.data.id);
      if (e.data.ok) p.resolve({ blocks: e.data.blocks, md: e.data.md });
      else p.reject(new Error(e.data.error ?? 'worker error'));
    };
    w.onerror = () => {
      // Worker 崩溃：拒绝全部在途请求，后续回退主线程
      worker = null;
      for (const [, p] of pending) p.reject(new Error('worker crashed'));
      pending.clear();
    };
    worker = w;
    return w;
  } catch {
    worker = null;
    return null;
  }
}

/** 解析 markdown → 块树（Worker 优先，回退主线程） */
export async function parseDocAsync(md: string): Promise<Doc> {
  const w = getWorker();
  if (!w) return tokensToDoc(parseTokens(md));
  const id = ++seq;
  return new Promise((resolve, reject) => {
    pending.set(id, {
      resolve: (r) => resolve((r.blocks ?? []) as Doc),
      reject,
    });
    w.postMessage({ id, type: 'parse', md } satisfies Req);
  });
}

/** 块树序列化 → markdown（Worker 优先，回退主线程） */
export async function serializeDocAsync(blocks: Block[]): Promise<string> {
  const w = getWorker();
  if (!w) return docToMarkdown(blocks);
  const id = ++seq;
  return new Promise((resolve, reject) => {
    pending.set(id, {
      resolve: (r) => resolve(r.md ?? ''),
      reject,
    });
    w.postMessage({ id, type: 'serialize', blocks } satisfies Req);
  });
}
