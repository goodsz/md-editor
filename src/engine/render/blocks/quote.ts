import type { QuoteBlock } from '../../model/types';

import type { BlockBuilder } from '../builder';

export function renderQuote(block: QuoteBlock, build: BlockBuilder): HTMLElement {
  const el = document.createElement('blockquote');
  el.className = 'md-block md-quote';
  el.dataset.blockId = block.id;
  el.contentEditable = 'false';
  for (const child of block.children) {
    el.appendChild(build(child));
  }
  return el;
}
