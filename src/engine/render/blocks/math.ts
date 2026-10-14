import katex from 'katex';
import type { MathBlock } from '../../model/types';

/**
 * 数学块双态渲染（Typora 行为）：
 * - 非激活态：显示 KaTeX 渲染结果（.md-math-render）
 * - 激活态（光标进入）：显示 $$ 源码（.md-token + .md-math-src）
 * 两个子树互补显隐由 CSS 控制；可编辑范围只有 src span，
 * textOf/回写均取自 .md-math-src，渲染子树不参与文本流。
 */
export function renderMath(block: MathBlock): HTMLElement {
  const div = document.createElement('div');
  div.className = 'md-block md-math';
  div.dataset.blockId = block.id;
  div.contentEditable = 'true';

  const open = document.createElement('span');
  open.className = 'md-token';
  open.dataset.token = 'math_open';
  open.textContent = '$$';

  const tex = document.createElement('span');
  tex.className = 'md-math-src';
  tex.textContent = block.tex;

  const close = document.createElement('span');
  close.className = 'md-token';
  close.dataset.token = 'math_close';
  close.textContent = '$$';

  div.append(open, tex, close);

  if (block.tex.trim() !== '') {
    const render = document.createElement('div');
    render.className = 'md-math-render';
    render.contentEditable = 'false';
    try {
      render.innerHTML = katex.renderToString(block.tex, {
        throwOnError: false,
        displayMode: true,
      });
    } catch {
      render.textContent = '[公式渲染失败]';
      render.classList.add('md-math-error');
    }
    div.appendChild(render);
  }
  return div;
}
