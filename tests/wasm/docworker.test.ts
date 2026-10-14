// @vitest-environment jsdom
// Worker 化文档处理（ADR-0001 P2）：解析/序列化可在 Worker 执行；
// 测试环境无 Worker 时自动回退主线程，两条路径输出一致。
import { describe, expect, it } from 'vitest';
import { BlockEngine } from '../../src/engine';
import { parseDocAsync, serializeDocAsync } from '../../src/engine/workers/docWorkerClient';
import { tokensToDoc } from '../../src/engine/model/convert';
import { parseTokens } from '../../src/syntax/markdown';
import type { Doc } from '../../src/engine/model/types';

describe('engine/Worker 化文档处理', () => {
  it('parseDocAsync 与主线程解析一致', async () => {
    const md = '# 标题\n\n段落 **加粗**\n\n- 甲\n- 乙\n\n> 引用';
    const doc = await parseDocAsync(md);
    const ref = tokensToDoc(parseTokens(md));
    const strip = (blocks: Doc): unknown[] =>
  JSON.parse(JSON.stringify(blocks, (k, v) => (k === 'id' ? undefined : v)));
    expect(strip(doc)).toEqual(strip(ref as Doc));
  });

  it('serializeDocAsync 与主线程序列化一致', async () => {
    const md = '# 标题\n\n- 甲\n- 乙\n\n> 引用';
    const blocks = tokensToDoc(parseTokens(md));
    const md2 = await serializeDocAsync(blocks);
    expect(md2).toBe(md);
  });

  it('loadMarkdownAsync 与 loadMarkdown 结果一致', async () => {
    document.body.innerHTML = '';
    const md = '# 标题\n\n段落 **加粗**\n\n- 甲\n- 乙\n\n> 引用';
    const root1 = document.createElement('div');
    const root2 = document.createElement('div');
    document.body.append(root1, root2);
    const e1 = new BlockEngine(root1, '占位');
    const e2 = new BlockEngine(root2, '占位');
    await e1.loadMarkdownAsync(md);
    e2.loadMarkdown(md);
    expect(e1.getMarkdown()).toBe(e2.getMarkdown());
    expect(root1.querySelectorAll('[data-block-id]').length).toBe(
      root2.querySelectorAll('[data-block-id]').length,
    );
    e1.destroy();
    e2.destroy();
  });
});
