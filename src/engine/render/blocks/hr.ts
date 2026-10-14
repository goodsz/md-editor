import type { HrBlock } from '../../model/types';

export function renderHr(block: HrBlock): HTMLElement {
  const hr = document.createElement('hr');
  hr.className = 'md-block md-hr';
  hr.dataset.blockId = block.id;
  hr.contentEditable = 'false';
  return hr;
}
