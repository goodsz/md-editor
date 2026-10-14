import type { HtmlBlock } from '../../model/types';

export function renderHtml(block: HtmlBlock): HTMLElement {
  const div = document.createElement('div');
  div.className = 'md-block md-html-block';
  div.dataset.blockId = block.id;
  div.contentEditable = 'false';
  // M1 安全策略：不注入原始 HTML，原样以文本展示（与 textContent 往返一致）
  div.textContent = block.raw;
  return div;
}
