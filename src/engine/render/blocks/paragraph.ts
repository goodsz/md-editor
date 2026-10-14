import type { ParagraphBlock } from '../../model/types';
import { appendInline } from '../inline';

export function renderParagraph(block: ParagraphBlock): HTMLElement {
  const p = document.createElement('p');
  p.className = 'md-block md-paragraph';
  p.dataset.blockId = block.id;
  p.contentEditable = 'true';
  appendInline(p, block.text);
  return p;
}
