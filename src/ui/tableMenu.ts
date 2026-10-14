import type { BlockEngine } from '../engine';
import { removeBlock } from '../engine/input/commands';
import {
  deleteCol,
  deleteRow,
  insertCol,
  insertRow,
  setColAlign,
} from '../engine/input/table';
import { isTable } from '../engine/model/types';
import type { Align } from '../engine/model/types';

interface CellRef {
  tableId: string;
  r: number;
  c: number;
}

/**
 * 表格右键菜单：行列增删与对齐。
 * 在 [data-cell] 上 contextmenu 时弹出，阻止浏览器默认菜单。
 */
export function initTableContextMenu(root: HTMLElement, engine: BlockEngine): () => void {
  const menu = document.createElement('div');
  menu.className = 'ctx-menu';
  menu.hidden = true;
  document.body.appendChild(menu);

  const build = (ref: CellRef): void => {
    menu.textContent = '';
    const items: Array<{ label: string; run: () => void } | 'sep'> = [
      { label: '上方插入行', run: () => runTx(insertRow(engine.model, ref.tableId, ref.r - 1)) },
      { label: '下方插入行', run: () => runTx(insertRow(engine.model, ref.tableId, ref.r)) },
      {
        label: '删除行',
        run: () => {
          const t = engine.model.getBlock(ref.tableId);
          if (t && isTable(t) && t.rows.length > 1) {
            runTx(deleteRow(engine.model, ref.tableId, ref.r));
          }
        },
      },
      'sep',
      { label: '左侧插入列', run: () => runTx(insertCol(engine.model, ref.tableId, ref.c - 1)) },
      { label: '右侧插入列', run: () => runTx(insertCol(engine.model, ref.tableId, ref.c)) },
      {
        label: '删除列',
        run: () => {
          const t = engine.model.getBlock(ref.tableId);
          if (t && isTable(t) && t.rows[0]?.length > 1) {
            runTx(deleteCol(engine.model, ref.tableId, ref.c));
          }
        },
      },
      'sep',
      { label: '此列左对齐', run: () => runTx(setColAlign(engine.model, ref.tableId, ref.c, 'left')) },
      { label: '此列居中', run: () => runTx(setColAlign(engine.model, ref.tableId, ref.c, 'center')) },
      { label: '此列右对齐', run: () => runTx(setColAlign(engine.model, ref.tableId, ref.c, 'right')) },
      'sep',
      { label: '删除表格', run: () => runTx(removeBlock(engine.model, ref.tableId)) },
    ];
    for (const item of items) {
      if (item === 'sep') {
        const sep = document.createElement('div');
        sep.className = 'menu-sep';
        menu.appendChild(sep);
        continue;
      }
      const row = document.createElement('div');
      row.className = 'menu-item';
      row.textContent = item.label;
      row.addEventListener('click', () => {
        hide();
        item.run();
      });
      menu.appendChild(row);
    }
  };

  const runTx = (tx: ReturnType<typeof insertRow>): void => {
    if (tx) engine.applyTransaction(tx);
  };

  const hide = (): void => {
    menu.hidden = true;
  };

  const onContextMenu = (e: MouseEvent): void => {
    const cell = (e.target as HTMLElement | null)?.closest<HTMLElement>('[data-cell]');
    if (!cell) {
      hide();
      return;
    }
    const tableEl = cell.closest<HTMLElement>('[data-block-id]');
    if (!tableEl) return;
    e.preventDefault();
    const [r, c] = (cell.dataset['cell'] ?? '0,0').split(',').map(Number);
    build({ tableId: tableEl.getAttribute('data-block-id')!, r, c });
    menu.hidden = false;
    const x = Math.min(e.clientX, window.innerWidth - menu.offsetWidth - 8);
    const y = Math.min(e.clientY, window.innerHeight - menu.offsetHeight - 8);
    menu.style.left = x + 'px';
    menu.style.top = y + 'px';
  };

  const onDocClick = (e: MouseEvent): void => {
    if (!menu.contains(e.target as Node)) hide();
  };

  root.addEventListener('contextmenu', onContextMenu);
  document.addEventListener('click', onDocClick);
  return () => {
    root.removeEventListener('contextmenu', onContextMenu);
    document.removeEventListener('click', onDocClick);
    menu.remove();
  };
}

export type { Align };
