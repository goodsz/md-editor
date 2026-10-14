import { describe, expect, it } from 'vitest';
import { parseInlineTokens, parseTokens, renderExportHtml } from '../../src/syntax/markdown';

describe('syntax/markdown-it 封装', () => {
  it('段落 → paragraph_open + inline + paragraph_close', () => {
    const tokens = parseTokens('hello world');
    expect(tokens.map((t) => t.type)).toEqual([
      'paragraph_open',
      'inline',
      'paragraph_close',
    ]);
    expect(tokens[1].content).toBe('hello world');
  });

  it('标题 → heading_open（携带 tag 层级）', () => {
    const tokens = parseTokens('## 标题二');
    expect(tokens[0].type).toBe('heading_open');
    expect(tokens[0].tag).toBe('h2');
  });

  it('fence → 代码块（info 携带语言）', () => {
    const tokens = parseTokens('```ts\nconst a = 1;\n```');
    const fence = tokens.find((t) => t.type === 'fence');
    expect(fence).toBeDefined();
    expect(fence!.info).toBe('ts');
    expect(fence!.content).toBe('const a = 1;\n');
  });

  it('行内文本解析出 strong/em/code_inline 骨架', () => {
    const children = parseInlineTokens('**粗** *斜* `码`');
    const types = children.map((t) => t.type);
    expect(types).toContain('strong_open');
    expect(types).toContain('strong_close');
    expect(types).toContain('em_open');
    expect(types).toContain('em_close');
    expect(types).toContain('code_inline');
  });

  it('链接解析为 link_open / text / link_close', () => {
    const children = parseInlineTokens('[例子](https://example.com)');
    const types = children.map((t) => t.type);
    expect(types).toEqual(['link_open', 'text', 'link_close']);
    expect(children[0].attrGet('href')).toBe('https://example.com');
  });

  it('软换行保留在 inline token 内容中', () => {
    const tokens = parseTokens('第一行\n第二行');
    const inline = tokens[1];
    expect(inline.content).toBe('第一行\n第二行');
  });
});

describe('syntax/导出渲染（源码 → 静态 HTML）', () => {
  it('文本/标题/表格/列表 输出干净标签（无编辑器类名）', () => {
    const { html } = renderExportHtml('# 标题\n\n段落**加粗**\n\n| A | B |\n| - | - |\n| 1 | 2 |\n\n- 甲\n- 乙');
    expect(html).toContain('<h1>标题</h1>');
    expect(html).toContain('<strong>加粗</strong>');
    expect(html).toContain('<table>');
    expect(html).toContain('<li>甲</li>');
    expect(html).not.toContain('md-token');
    expect(html).not.toContain('contenteditable');
  });

  it('数学块经 KaTeX 物化；代码块经 hljs 高亮', () => {
    const { html } = renderExportHtml('$$c^2 = a^2 + b^2$$\n\n```js\nconst a = 1;\n```');
    expect(html).toContain('class="katex"');
    expect(html).toContain('md-export-pre');
    expect(html).toContain('hljs-keyword');
  });

  it('mermaid 围栏输出占位并登记源码（按序）', () => {
    const { html, mermaid } = renderExportHtml('```mermaid\ngraph LR\n  A --> B\n```');
    expect(html).toContain('<div class="md-export-mermaid" data-mermaid-idx="0">');
    expect(mermaid).toEqual(['graph LR\n  A --> B\n']);
  });

  it('任务列表插入禁用态复选框', () => {
    const { html } = renderExportHtml('- [x] 已完成\n- [ ] 未完成');
    expect(html).toContain('<input class="md-export-task" type="checkbox" disabled checked>');
    expect(html).toContain('<input class="md-export-task" type="checkbox" disabled>');
  });
});
