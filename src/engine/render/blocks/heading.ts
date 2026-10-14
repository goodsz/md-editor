import type { HeadingBlock } from '../../model/types';
import { appendInline } from '../inline';

export function renderHeading(block: HeadingBlock): HTMLElement {
  const h = document.createElement(`h${block.level}`);
  h.className = `md-block md-heading md-heading-${block.level}`;
  h.dataset.blockId = block.id;
  h.contentEditable = 'true';
  appendInline(h, block.text);
  return h;
}
