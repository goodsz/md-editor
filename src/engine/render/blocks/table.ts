import type { TableBlock } from '../../model/types';
import { appendInline } from '../inline';

/** 表格：表格本身不可编辑，单元格为独立 editing host（data-cell="r,c"）；
 *  单元格内容走行内渲染管线（**加粗** 等标记生效），textContent 保真回写无损 */
export function renderTable(block: TableBlock): HTMLElement {
  const table = document.createElement('table');
  table.className = 'md-block md-table';
  table.dataset.blockId = block.id;
  table.contentEditable = 'false';
  if (block.rows.length === 0) return table;

  const thead = document.createElement('thead');
  const headRow = document.createElement('tr');
  block.rows[0].forEach((cell, i) => {
    const th = renderCell('th', cell, 0, i, block.align[i] ?? 'left');
    headRow.appendChild(th);
  });
  thead.appendChild(headRow);
  table.appendChild(thead);

  if (block.rows.length > 1) {
    const tbody = document.createElement('tbody');
    for (let r = 1; r < block.rows.length; r++) {
      const tr = document.createElement('tr');
      block.rows[r].forEach((cell, c) => {
        tr.appendChild(renderCell('td', cell, r, c, 'left'));
      });
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
  }
  return table;
}

function renderCell(
  tag: 'th' | 'td',
  text: string,
  r: number,
  c: number,
  align: string,
): HTMLElement {
  const el = document.createElement(tag);
  el.dataset.cell = `${r},${c}`;
  el.contentEditable = 'true';
  if (align !== 'left') el.style.textAlign = align;
  // 行内渲染：**粗** *斜* [链接] 等生效；标记 span 常驻，textContent 与源码一致
  appendInline(el, text);
  return el;
}
