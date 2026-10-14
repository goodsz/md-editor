import { describe, expect, it } from 'vitest';
import { docToMarkdown, tokensToDoc } from '../../src/engine/model/convert';
import { parseTokens } from '../../src/syntax/markdown';
import type { Doc } from '../../src/engine/model/types';

/** 去掉 id 后的结构快照，用于忽略生成 id 比较树结构 */
function stripIds(doc: Doc): unknown {
  return JSON.parse(
    JSON.stringify(doc, (key, value) => (key === 'id' ? undefined : value)),
  );
}

/** 往返判据：parse → serialize → parse 结构一致，且序列化结果幂等 */
function expectRoundTrip(md: string): string {
  const doc1 = tokensToDoc(parseTokens(md));
  const md1 = docToMarkdown(doc1);
  const doc2 = tokensToDoc(parseTokens(md1));
  expect(stripIds(doc2)).toEqual(stripIds(doc1));
  const md2 = docToMarkdown(doc2);
  expect(md2).toBe(md1);
  return md1;
}

describe('model/convert 往返测试', () => {
  it('空文档', () => {
    expectRoundTrip('');
  });

  it('段落与软换行', () => {
    expectRoundTrip('第一段第一行\n第一段第二行\n\n第二段');
  });

  it('六级标题', () => {
    expectRoundTrip(
      '# 一级\n## 二级\n### 三级\n#### 四级\n##### 五级\n###### 六级',
    );
  });

  it('行内标记：粗体/斜体/删除线/行内代码/链接/图片', () => {
    expectRoundTrip(
      '普通 **加粗** *斜体* ~~删除~~ `代码` [链接](https://example.com) ![图片](https://img.png)',
    );
  });

  it('围栏代码块（含语言与空代码）', () => {
    expectRoundTrip('```ts\nconst a = 1;\n```\n\n```\n```\n\n```python\nprint(1)\n```');
  });

  it('分割线', () => {
    expectRoundTrip('上\n\n---\n\n下');
  });

  it('引用块（含嵌套与段落）', () => {
    expectRoundTrip('> 一层\n>\n> > 二层\n>\n> 回到一层');
  });

  it('无序列表', () => {
    expectRoundTrip('- 甲\n- 乙\n- 丙');
  });

  it('有序列表（自定义起始编号）', () => {
    expectRoundTrip('3. 甲\n4. 乙');
  });

  it('任务列表', () => {
    expectRoundTrip('- [x] 已完成\n- [ ] 未完成');
  });

  it('嵌套列表', () => {
    expectRoundTrip('- 甲\n  - 子一\n  - 子二\n- 乙\n  1. 序一\n  2. 序二');
  });

  it('松散列表（项内多段落）', () => {
    expectRoundTrip('- 甲\n\n  续段\n- 乙');
  });

  it('列表项内代码块', () => {
    expectRoundTrip('- 甲\n\n  ```js\n  let x = 1;\n  ```\n- 乙');
  });

  it('数学块（单行与多行）', () => {
    expectRoundTrip('$$c^2 = a^2$$\n\n$$\n\\frac{a}{b}\n$$');
  });

  it('表格（含对齐）', () => {
    expectRoundTrip(
      '| 左 | 中 | 右 |\n| --- | :---: | ---: |\n| a | b | c |\n| d | e | f |',
    );
  });

  it('HTML 块原样保留', () => {
    expectRoundTrip('<div class="x">\n  <p>hello</p>\n</div>');
  });

  it('混合文档', () => {
    expectRoundTrip(
      [
        '# 标题',
        '',
        '开头一段，含 **加粗** 与 `代码`。',
        '',
        '## 子标题',
        '',
        '- 列表一',
        '- 列表二',
        '  - 嵌套项',
        '',
        '> 引用内容',
        '> 多行引用',
        '',
        '```',
        'plain code',
        '```',
        '',
        '---',
        '',
        '| A | B |',
        '| --- | --- |',
        '| 1 | 2 |',
        '',
        '结尾段落',
      ].join('\n'),
    );
  });

  it('任务标记不误伤普通方括号文本', () => {
    const doc = tokensToDoc(parseTokens('- [foo] bar'));
    const list = doc[0];
    if (list.type !== 'list') throw new Error('应为 list');
    expect(list.items[0].checked).toBeUndefined();
    expect(list.items[0].text).toBe('[foo] bar');
  });
});
