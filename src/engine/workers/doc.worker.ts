import { docToMarkdown, tokensToDoc } from '../model/convert';
import { parseTokens } from '../../syntax/markdown';
import type { Block, Doc } from '../model/types';

/**
 * 文档解析/序列化 Worker（ADR-0001 P2）：
 * 大文档打开与自动保存的 CPU 工作移出主线程。
 * Worker 不可用（如测试环境）由客户端回退为主线程同步执行。
 */

type Req =
  | { id: number; type: 'parse'; md: string }
  | { id: number; type: 'serialize'; blocks: Doc };

type Res =
  | { id: number; ok: true; blocks?: Doc; md?: string }
  | { id: number; ok: false; error: string };

const ctx = self as unknown as Worker;

ctx.onmessage = (e: MessageEvent<Req>) => {
  const { id, type } = e.data;
  try {
    if (type === 'parse') {
      const blocks: Doc = tokensToDoc(parseTokens(e.data.md));
      (ctx as Worker).postMessage({ id, ok: true, blocks } satisfies Res);
    } else {
      const md = docToMarkdown(e.data.blocks as Block[]);
      (ctx as Worker).postMessage({ id, ok: true, md } satisfies Res);
    }
  } catch (err) {
    (ctx as Worker).postMessage({ id, ok: false, error: String(err) } satisfies Res);
  }
};
