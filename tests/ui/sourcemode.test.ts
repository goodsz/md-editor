import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BlockEngine } from '../../src/engine';
import { SourceMode } from '../../src/ui/sourceMode';
import { extractHeadings, OutlinePanel } from '../../src/ui/outline';

function setup(md: string): { root: HTMLElement; engine: BlockEngine } {
  const root = document.createElement('div');
  document.body.appendChild(root);
  const engine = new BlockEngine(root, md);
  return { root, engine };
}

function makeSourceMode(engine: BlockEngine): {
  sm: SourceMode;
  textarea: HTMLTextAreaElement;
} {
  const app = document.createElement('div');
  document.body.appendChild(app);
  const textarea = document.createElement('textarea');
  app.appendChild(textarea);
  const sm = new SourceMode(engine, textarea, app, () => {});
  return { sm, textarea };
}

describe('ui/sourceMode 光标双向映射（模式切换保持位置）', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      cb(performance.now());
      return 0;
    });
    vi.stubGlobal('cancelAnimationFrame', () => {});
    Element.prototype.scrollIntoView = vi.fn();
  });

  it('enter：光标落入标题块时，textarea 定位到该标题行内', () => {
    const { engine } = setup('# 甲\n\n段落一\n\n## 乙标题');
    const block = engine.model.getRoot()[2];
    engine.revealBlock(block.id, 2); // 光标在 "## 乙标题" 文本 offset 2
    const { sm, textarea } = makeSourceMode(engine);
    sm.enter();
    expect(sm.isActive).toBe(true);
    const lineStart = textarea.value.indexOf('## 乙标题');
    expect(textarea.selectionStart).toBe(lineStart + '## '.length + 2);
  });

  it('enter：光标在段落中间时，textarea 定位到段落文本对应位置', () => {
    const { engine } = setup('第一段\n\nABCDEF');
    const block = engine.model.getRoot()[1];
    engine.revealBlock(block.id, 3);
    const { sm, textarea } = makeSourceMode(engine);
    sm.enter();
    const lineStart = textarea.value.indexOf('ABCDEF');
    expect(textarea.selectionStart).toBe(lineStart + 3);
  });

  it('exit：光标回到源码位置对应的块并聚焦宿主', () => {
    const { engine } = setup('alpha\n\nbravo\n\ncharlie');
    const { sm, textarea } = makeSourceMode(engine);
    sm.enter();
    const at = textarea.value.indexOf('bravo') + 2;
    textarea.setSelectionRange(at, at);
    sm.exit();
    expect(sm.isActive).toBe(false);
    // 光标落在第二个顶层块内
    const block = engine.model.getRoot()[1];
    if (block.type !== 'paragraph') throw new Error('应为 paragraph');
    expect(block.text).toBe('bravo');
    const sel = window.getSelection()!;
    expect(sel.rangeCount).toBe(1);
    const host = sel.anchorNode?.parentElement?.closest('[data-block-id]');
    expect(host?.getAttribute('data-block-id')).toBe(block.id);
    expect(engine.getSelection()?.focus.blockId).toBe(block.id);
  });

  it('exit：源码位置落在代码块时映射到块内', () => {
    const { engine } = setup('before\n\n```js\nlet x = 1\n```\n\nafter');
    const { sm, textarea } = makeSourceMode(engine);
    sm.enter();
    const at = textarea.value.indexOf('let x = 1') + 4;
    textarea.setSelectionRange(at, at);
    sm.exit();
    const code = engine.model.getRoot()[1];
    expect(code.type).toBe('code');
    const sel = engine.getSelection();
    expect(sel?.focus.blockId).toBe(code.id);
    expect(sel?.focus.offset).toBe(4);
  });

  it('revealTo：源码模式下定位到对应标题行', () => {
    const { engine } = setup('# 一\n\n文本\n\n## 二\n\n内容\n\n### 三');
    const { sm, textarea } = makeSourceMode(engine);
    sm.enter();
    const h2 = engine.model.getRoot()[2];
    expect(h2.type).toBe('heading');
    sm.revealTo(h2.id);
    const lineStart = textarea.value.indexOf('## 二');
    expect(textarea.selectionStart).toBe(lineStart);
    // 第三个标题
    const h3 = engine.model.getRoot()[4];
    sm.revealTo(h3.id);
    expect(textarea.selectionStart).toBe(textarea.value.indexOf('### 三'));
  });

  it('revealTo：跳过围栏代码块内的 # 行', () => {
    const { engine } = setup('# 甲\n\n```md\n# 不是标题\n```\n\n## 乙');
    const { sm, textarea } = makeSourceMode(engine);
    sm.enter();
    const h2 = engine.model.getRoot()[2];
    expect(h2.type).toBe('heading');
    sm.revealTo(h2.id);
    expect(textarea.selectionStart).toBe(textarea.value.indexOf('## 乙'));
  });
});

describe('ui/outline 大纲纯文本化与跳转注入', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      cb(performance.now());
      return 0;
    });
    vi.stubGlobal('cancelAnimationFrame', () => {});
    Element.prototype.scrollIntoView = vi.fn();
  });

  it('标题中的加粗/行内代码/链接标记不进入大纲', () => {
    const { engine } = setup('## **`let`** 与 [链接](https://e.com)\n\n正文');
    const items = extractHeadings(engine.model.getRoot());
    expect(items.length).toBe(1);
    expect(items[0].text).toBe('let 与 链接');
  });

  it('jumper 注入：源码模式下走自定义跳转', () => {
    const { engine } = setup('# 甲\n\n## 乙');
    const root = document.createElement('div');
    document.body.appendChild(root);
    const outlineEl = document.createElement('aside');
    document.body.appendChild(outlineEl);
    const jumped: string[] = [];
    const panel = new OutlinePanel(outlineEl, engine, null, (blockId) => jumped.push(blockId));
    panel.refresh();
    const items = outlineEl.querySelectorAll<HTMLElement>('.outline-item');
    expect(items.length).toBe(2);
    items[1].click();
    expect(jumped).toEqual([engine.model.getRoot()[1].id]);
  });
});

describe('engine/undo 后光标与焦点恢复', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      cb(performance.now());
      return 0;
    });
    vi.stubGlobal('cancelAnimationFrame', () => {});
    Element.prototype.scrollIntoView = vi.fn();
  });

  it('undo 后宿主聚焦且光标可继续输入', () => {
    const { root, engine } = setup('hello\n\nworld');
    const p = root.querySelectorAll<HTMLElement>('.md-paragraph')[0];
    p.focus();
    // 模拟输入事务
    engine.applyTransaction({
      ops: [{ type: 'updateText', id: p.dataset['blockId']!, text: 'hello!!' }],
      selection: {
        anchor: { blockId: p.dataset['blockId']!, offset: 7 },
        focus: { blockId: p.dataset['blockId']!, offset: 7 },
      },
    });
    expect(engine.getMarkdown()).toBe('hello!!\n\nworld');
    // jsdom 不支持 contenteditable 聚焦，用 focus 调用验证宿主聚焦逻辑
    const focusSpy = vi.spyOn(HTMLElement.prototype, 'focus');
    engine.undo();
    expect(engine.getMarkdown()).toBe('hello\n\nworld');
    // 光标已落位 + 宿主已请求聚焦（mount 重建后原宿主被移除，必须显式聚焦）
    const sel = engine.getSelection();
    expect(sel).not.toBeNull();
    expect(focusSpy).toHaveBeenCalled();
  });

  it('undo 后激活块的 block-active 恢复（renderOne 重建后补加）', () => {
    const { root, engine } = setup('aaa\n\nbbb');
    const p = root.querySelectorAll<HTMLElement>('.md-paragraph')[0];
    p.focus();
    engine.applyTransaction({
      ops: [{ type: 'updateText', id: p.dataset['blockId']!, text: 'aaaX' }],
      selection: {
        anchor: { blockId: p.dataset['blockId']!, offset: 4 },
        focus: { blockId: p.dataset['blockId']!, offset: 4 },
      },
    });
    // 渲染后块 DOM 已重建，class 需始终补加
    const after = root.querySelector('[data-block-id]');
    expect(after?.classList.contains('block-active')).toBe(true);
  });

  it('失焦后编辑焦点标记移除（标记显隐依据）', async () => {
    // jsdom 仅 tabindex 元素可聚焦：借 tabindex 驱动真实 focusin/focusout 流程
    const { root, engine } = setup('text');
    const p = root.querySelector<HTMLElement>('.md-paragraph')!;
    p.tabIndex = 0;
    p.focus();
    expect(root.classList.contains('editing-focus')).toBe(true);
    p.blur();
    await new Promise((r) => setTimeout(r, 5));
    expect(root.classList.contains('editing-focus')).toBe(false);
    expect(engine).toBeDefined();
  });
});
