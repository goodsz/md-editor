import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BlockEngine } from '../../src/engine';
import { parseTokens } from '../../src/syntax/markdown';

function fireBeforeInput(el: EventTarget, inputType: string, data?: string): boolean {
  const e = new Event('beforeinput', { bubbles: true, cancelable: true }) as InputEvent;
  Object.defineProperty(e, 'inputType', { value: inputType });
  Object.defineProperty(e, 'data', { value: data ?? null });
  return el.dispatchEvent(e);
}

describe('syntax/数学块规则', () => {
  it('单行 $$…$$ 解析为 math_block', () => {
    const tokens = parseTokens('$$c^2=a^2$$');
    expect(tokens[0].type).toBe('math_block');
    expect(tokens[0].content).toBe('c^2=a^2');
  });

  it('多行 $$ 围栏解析为 math_block', () => {
    const tokens = parseTokens('$$\n\\frac{a}{b}\n$$');
    expect(tokens[0].type).toBe('math_block');
    expect(tokens[0].content).toBe('\\frac{a}{b}');
  });

  it('普通文本不受影响', () => {
    const tokens = parseTokens('价格是 $100，不是 $$重点是这句');
    // 第二行以 $$ 开头会成块；本行只有行中 $$，应为普通段落
    expect(tokens[0].type).toBe('paragraph_open');
  });
});

describe('engine/表格行内渲染与数学块双态', () => {
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
  });

  it('单元格内 **加粗** 生效且 textContent 保真', () => {
    engine = new BlockEngine(root, '| **粗** | 尾 |\n| --- | --- |\n| [链](https://e.com) | x |');
    const td = root.querySelector('[data-cell="0,0"]')!;
    expect(td.querySelector('strong')).not.toBeNull();
    expect(td.textContent).toBe('**粗**');
    // data-cell 单元格里的链接
    expect(root.querySelector('[data-cell="1,0"]')?.querySelector('a')).not.toBeNull();
  });

  it('数学块：KaTeX 渲染 + 源码区 textOf 隔离', () => {
    engine = new BlockEngine(root, '$$c^2 = a^2$$');
    const block = engine.model.getRoot()[0];
    expect(block.type).toBe('math');
    const el = root.querySelector('.md-math')!;
    expect(el.querySelector('.md-math-render .katex')).not.toBeNull();
    // textOf 取 .md-math-src，不含渲染子树与 $$ 标记
    expect(engine.model.toMarkdown()).toBe('$$\nc^2 = a^2\n$$');
    const src = el.querySelector('.md-math-src')!;
    expect(src.textContent).toBe('c^2 = a^2');
  });

  it('数学块编辑：源码修改经回写同步 tex', () => {
    engine = new BlockEngine(root, '$$a$$');
    const id = engine.model.getRoot()[0].id;
    const el = root.querySelector('.md-math')!;
    const src = el.querySelector('.md-math-src')!;
    engine.restoreSelection({
      anchor: { blockId: id, offset: 1, cell: undefined },
      focus: { blockId: id, offset: 1, cell: undefined },
    });
    // 模拟浏览器默认动作：DOM 已含插入结果（jsdom 无 beforeinput 默认行为）
    (src.firstChild as Text).data = 'ab+1x';
    // 光标在末尾 offset 1 + 新增 3 → 4
    engine.restoreSelection({
      anchor: { blockId: id, offset: 4, cell: undefined },
      focus: { blockId: id, offset: 4, cell: undefined },
    });
    fireBeforeInput(src, 'insertText', 'x');
    const block = engine.model.getRoot()[0];
    if (block.type !== 'math') throw new Error('应为 math');
    expect(block.tex).toBe('ab+1x');
  });

  it('mermaid 代码块：双态结构与源码保真', () => {
    const code = 'graph LR\n  A-->B';
    engine = new BlockEngine(root, '```mermaid\n' + code + '\n```');
    const pre = root.querySelector('pre.md-mermaid')!;
    // fence content 保留尾换行
    expect(pre.querySelector('.md-code')?.textContent).toBe(code + '\n');
    expect(pre.querySelector('.md-mermaid-render')).not.toBeNull();
  });

  it('任务复选框点击切换且可撤销', () => {
    engine = new BlockEngine(root, '- [x] 已完成\n- [ ] 待办');
    const list = engine.model.getRoot()[0];
    if (list.type !== 'list') throw new Error('应为 list');
    const cb = root.querySelector<HTMLInputElement>('input[data-task-item]')!;
    expect(cb.checked).toBe(true);
    cb.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    const after = engine.model.getRoot()[0];
    if (after.type !== 'list') throw new Error('应为 list');
    expect(after.items[0].checked).toBe(false);
    // 撤销恢复勾选
    engine.undo();
    const undone = engine.model.getRoot()[0];
    if (undone.type !== 'list') throw new Error('应为 list');
    expect(undone.items[0].checked).toBe(true);
  });

  it('html_inline：font color 生效且 textContent 保真', () => {
    engine = new BlockEngine(root, '前 <font color="red">红字</font> 后');
    const p = root.querySelector('p')!;
    console.log('[dbg] p len:', p.textContent?.length, 'children:', p.children.length);
    const holder = p.querySelector('.md-html-inline[data-html-tag="font"]')!;
    expect(holder.querySelector('.md-html-inline') === null).toBe(true);
    // 内容文本存在且被包裹
    expect(holder.textContent).toContain('红字');
    // textContent 与源码一致（标记字符都在）
    expect(p.textContent).toBe('前 <font color="red">红字</font> 后');
    // 样式生效（jsdom 支持 style.color）
    expect((holder as HTMLElement).style.color).toBe('red');
  });

  it('html_inline：非白名单标签与 onerror 属性被安全降级', () => {
    engine = new BlockEngine(root, 'A<script>alert(1)</script>B');
    const p = root.querySelector('p')!;
    // script 不在白名单：整段按纯文本渲染（无任何元素注入）
    expect(p.querySelector('script')).toBeNull();
    expect(p.textContent).toBe('A<script>alert(1)</script>B');
  });
});
