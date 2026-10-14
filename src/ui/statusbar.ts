import type { BlockEngine } from '../engine';

/** 字数统计：CJK 字符逐字计 + 拉丁词计数 */
export function docStats(md: string): { words: number; chars: number } {
  const chars = [...md].length;
  const cjk = (md.match(/[\u3400-\u4dbf\u4e00-\u9fff]/g) ?? []).length;
  const latin = (md.match(/[A-Za-z0-9_'-]+/g) ?? []).length;
  return { words: cjk + latin, chars };
}

export function buildStatusbar(
  container: HTMLElement,
  engine: BlockEngine,
): { refresh(mode: 'wysiwyg' | 'source', text?: string): void } {
  const modeEl = document.createElement('span');
  modeEl.id = 'status-mode';
  const countEl = document.createElement('span');
  countEl.id = 'status-count';
  container.append(modeEl, countEl);

  const render = (mode: 'wysiwyg' | 'source', text?: string): void => {
    modeEl.textContent = mode === 'source' ? '源码模式' : '所见即所得';
    const md = mode === 'source' ? (text ?? '') : engine.getMarkdown();
    const { words, chars } = docStats(md);
    countEl.textContent = `字数 ${words}　字符 ${chars}`;
  };
  render('wysiwyg');
  return { refresh: render };
}
