import type { ListBlock, ListItem } from '../../model/types';
import { appendInline } from '../inline';
import type { BlockBuilder } from '../builder';

export function renderList(block: ListBlock, build: BlockBuilder): HTMLElement {
  const el = document.createElement(block.ordered ? 'ol' : 'ul');
  el.className = 'md-block md-list';
  el.dataset.blockId = block.id;
  el.contentEditable = 'false';
  if (block.ordered && block.start !== undefined) {
    (el as HTMLOListElement).start = block.start;
  }
  for (const item of block.items) {
    el.appendChild(renderListItem(item, build));
  }
  return el;
}

export function renderListItem(item: ListItem, build: BlockBuilder): HTMLElement {
  const li = document.createElement('li');
  li.className = 'md-list-item';
  li.dataset.blockId = item.id;
  li.contentEditable = 'false';

  if (item.checked !== undefined) {
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.className = 'md-task-check';
    cb.checked = item.checked;
    cb.dataset.taskItem = item.id;
    cb.tabIndex = -1;
    li.appendChild(cb);
  }

  // 行内内容隔离在 span 中，textContent 不含嵌套子块
  const span = document.createElement('span');
  span.className = 'md-item-text';
  span.contentEditable = 'true';
  appendInline(span, item.text);
  li.appendChild(span);

  if (item.children) {
    for (const child of item.children) {
      li.appendChild(build(child));
    }
  }
  return li;
}
