import type { CodeBlock } from '../../model/types';
import { highlightCode } from '../../../syntax/highlight';

// mermaid 懒加载：首次遇到 mermaid 代码块才拉取模块
let mermaidLoader: Promise<typeof import('mermaid')['default']> | null = null;

function loadMermaid(): Promise<typeof import('mermaid')['default']> {
  if (!mermaidLoader) {
    mermaidLoader = import('mermaid').then((m) => {
      const mermaid = m.default;
      const dark = document.documentElement.dataset['theme'] === 'dark';
      mermaid.initialize({
        startOnLoad: false,
        securityLevel: 'strict',
        theme: dark ? 'dark' : 'default',
      });
      return mermaid;
    });
  }
  return mermaidLoader;
}

let mermaidSeq = 0;

/** 异步渲染 mermaid → SVG 注入占位节点；块被重渲染后结果自动废弃 */
function renderMermaidInto(placeholder: HTMLElement, code: string): void {
  const id = `md-mermaid-svg-${++mermaidSeq}`;
  void loadMermaid()
    .then((m) => m.render(id, code))
    .then(({ svg }) => {
      if (!placeholder.isConnected) return;
      placeholder.innerHTML = svg;
      placeholder.classList.remove('md-mermaid-error');
    })
    .catch(() => {
      if (!placeholder.isConnected) return;
      placeholder.textContent = '[图表语法错误]';
      placeholder.classList.add('md-mermaid-error');
    });
}

export function renderCode(block: CodeBlock): HTMLElement {
  const pre = document.createElement('pre');
  pre.className = 'md-block md-code-block';
  pre.dataset.blockId = block.id;
  pre.contentEditable = 'true';
  pre.spellcheck = false;
  const code = document.createElement('code');
  if (block.lang) code.dataset.lang = block.lang;
  code.className = 'md-code';
  // 空代码也要有行高与落点
  if (block.code === '') {
    code.textContent = '\n';
    pre.appendChild(code);
    return pre;
  }

  // mermaid 代码块：双态（激活显源码 / 非激活显图表），懒加载渲染
  if (block.lang.trim().toLowerCase() === 'mermaid') {
    pre.classList.add('md-mermaid');
    code.textContent = block.code;
    const render = document.createElement('div');
    render.className = 'md-mermaid-render';
    render.contentEditable = 'false';
    render.textContent = '[图表渲染中…]';
    pre.append(code, render);
    renderMermaidInto(render, block.code);
    return pre;
  }

  const frag = highlightCode(block.code, block.lang);
  if (frag) code.appendChild(frag);
  else code.textContent = block.code;
  pre.appendChild(code);
  return pre;
}
