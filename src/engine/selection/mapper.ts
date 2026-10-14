import type { BlockId, LogicalPosition, LogicalSelection } from '../model/types';

/**
 * DOM 选区 ↔ 逻辑位置互转。
 * offset 定义：块可编辑区内所有文本节点按文档顺序累加的字符索引，
 * 与 block.text（含行内标记字符）一致，渲染前后语义不变。
 */
export class SelectionMapper {
  private rootEl: HTMLElement | null = null;

  setRoot(el: HTMLElement): void {
    this.rootEl = el;
  }

  getRoot(): HTMLElement | null {
    return this.rootEl;
  }

  /** DOM 选区 → 逻辑选区；选区不在编辑器内时返回 null */
  capture(): LogicalSelection | null {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return null;
    const anchor = this.capturePos(sel.anchorNode, sel.anchorOffset);
    const focus = this.capturePos(sel.focusNode, sel.focusOffset);
    if (!anchor || !focus) return null;
    return { anchor, focus };
  }

  /** 逻辑选区 → DOM 选区；越界 offset 自动收敛到块内合法位置；
   *  空块（无文本节点）端点回退到块/单元格内容边界。
   *  返回是否成功落位（失败多为目标块未渲染/已移除，调用方可先滚动渲染再重试） */
  restore(sel: LogicalSelection): boolean {
    const a =
      this.offsetToDom(sel.anchor.blockId, sel.anchor.offset, sel.anchor.cell) ??
      this.edgeDomPos(sel.anchor.blockId, sel.anchor.cell, true);
    const f =
      this.offsetToDom(sel.focus.blockId, sel.focus.offset, sel.focus.cell) ??
      this.edgeDomPos(sel.focus.blockId, sel.focus.cell, false);
    const dom = window.getSelection();
    if (!dom) return false;
    if (!a || !f) {
      // 空单元格等场景：直接折叠到定位目标
      if (sel.anchor.blockId === sel.focus.blockId) {
        const sameCell =
          JSON.stringify(sel.anchor.cell) === JSON.stringify(sel.focus.cell) && sel.anchor.cell;
        if (sameCell && this.collapseToCell(sel.anchor.blockId, sameCell.r, sameCell.c)) return true;
        if (!sel.anchor.cell && this.collapseToBlock(sel.anchor.blockId)) return true;
      }
      return false;
    }
    const range = document.createRange();
    range.setStart(a.node, a.offset);
    range.setEnd(f.node, f.offset);
    dom.removeAllRanges();
    dom.addRange(range);
    return true;
  }

  /** 空块（无文本节点）端点兜底：定位到块/单元格内容的起始或末尾边界 */
  private edgeDomPos(
    blockId: BlockId,
    cell: { r: number; c: number } | undefined,
    atStart: boolean,
  ): { node: Node; offset: number } | null {
    const scope = cell ? this.cellEl(blockId, cell.r, cell.c) : this.editableScope(blockId);
    if (!scope || scope.classList.contains('md-spacer')) return null;
    return { node: scope, offset: atStart ? 0 : scope.childNodes.length };
  }

  /** 逻辑偏移 → DOM 文本节点位置 */
  offsetToDom(
    blockId: BlockId,
    offset: number,
    cell?: { r: number; c: number },
  ): { node: Text; offset: number } | null {
    const scope = cell ? this.cellEl(blockId, cell.r, cell.c) : this.editableScope(blockId);
    if (!scope) return null;
    const nodes = textNodesOf(scope);
    let remaining = Math.max(0, offset);
    for (const tn of nodes) {
      if (remaining <= tn.length) return { node: tn, offset: remaining };
      remaining -= tn.length;
    }
    if (nodes.length > 0) {
      const last = nodes[nodes.length - 1];
      return { node: last, offset: last.length };
    }
    return null; // 空块：交给 collapseToBlock
  }

  /** 块内纯文本内容（列表项排除嵌套子块与复选框） */
  textOf(blockId: BlockId): string | null {
    const scope = this.editableScope(blockId);
    return scope ? scope.textContent : null;
  }

  /** 单元格文本（cell 定位） */
  cellText(blockId: BlockId, r: number, c: number): string | null {
    const td = this.cellEl(blockId, r, c);
    return td ? td.textContent : null;
  }

  /** 焦点落入当前 DOM 选区所在的编辑宿主（块或表格单元格）；
   *  程序化落光标后调用，保证后续键盘输入生效 */
  focusCurrent(): boolean {
    const sel = this.capture();
    if (!sel) return false;
    const { blockId, cell } = sel.focus;
    if (cell) {
      const td = this.cellEl(blockId, cell.r, cell.c);
      if (td) {
        td.focus();
        return true;
      }
      return false;
    }
    return this.focusBlock(blockId);
  }

  /** 聚焦块的可编辑宿主（undo / 模式切换后 mount 重建 DOM 会丢失焦点）；
   *  返回是否成功。宿主不聚焦时仅设 DOM 选区，键盘输入不会生效 */
  focusBlock(blockId: BlockId): boolean {
    const scope = this.editableScope(blockId);
    if (!scope || scope.classList.contains('md-spacer')) return false;
    // 宿主 = contenteditable 块元素；jsdom 不反射该属性，回退按块锚点定位
    const host =
      scope.closest<HTMLElement>('[contenteditable="true"]') ??
      scope.closest<HTMLElement>('[data-block-id]');
    if (!host) return false;
    host.focus();
    return true;
  }

  /** 光标直接落到块首（空块或越界兜底用）；
   *  虚拟化占位符（md-spacer）不算落位成功，调用方需先滚动渲染 */
  collapseToBlock(blockId: BlockId): boolean {
    const scope = this.editableScope(blockId);
    if (!scope || scope.classList.contains('md-spacer')) return false;
    const range = document.createRange();
    range.selectNodeContents(scope);
    range.collapse(true);
    const dom = window.getSelection();
    if (!dom) return false;
    dom.removeAllRanges();
    dom.addRange(range);
    return true;
  }

  /** 光标落到单元格起始位置（空单元格兜底用） */
  collapseToCell(blockId: BlockId, r: number, c: number): boolean {
    const td = this.cellEl(blockId, r, c);
    if (!td) return false;
    const range = document.createRange();
    range.selectNodeContents(td);
    range.collapse(true);
    const dom = window.getSelection();
    if (!dom) return false;
    dom.removeAllRanges();
    dom.addRange(range);
    return true;
  }

  // ----------------------------------------------------------

  private cellEl(blockId: BlockId, r: number, c: number): HTMLElement | null {
    const table = this.findEl(blockId);
    if (!table || table.tagName !== 'TABLE') return null;
    return table.querySelector<HTMLElement>(`:scope [data-cell="${r},${c}"]`);
  }

  private capturePos(node: Node | null, offset: number): LogicalPosition | null {
    if (!node || !this.rootEl) return null;
    const el = node.nodeType === Node.TEXT_NODE ? node.parentElement : (node as HTMLElement);
    const blockEl = el?.closest<HTMLElement>('[data-block-id]');
    if (!blockEl || !this.rootEl.contains(blockEl)) return null;
    const blockId = blockEl.dataset['blockId'];
    if (!blockId) return null;

    // 表格单元格：cell 定位 + 格内偏移
    const cellHost = el?.closest<HTMLElement>('[data-cell]');
    let cell: { r: number; c: number } | undefined;
    let scope: HTMLElement | null;
    if (cellHost && cellHost.getAttribute('data-block-id') === null) {
      const [r, c] = (cellHost.dataset['cell'] ?? '').split(',').map(Number);
      if (Number.isNaN(r) || Number.isNaN(c)) return null;
      cell = { r, c };
      scope = cellHost;
    } else {
      scope = this.editableScope(blockId);
    }
    if (!scope) return null;

    if (node.nodeType === Node.TEXT_NODE) {
      const before = textBefore(scope, node);
      return { blockId, offset: before + offset, cell };
    }
    // 元素节点上的偏移：累加前 offset 个子树的文本量
    let inner = 0;
    const children = node.childNodes;
    for (let k = 0; k < offset && k < children.length; k++) {
      inner += (children[k].textContent ?? '').length;
    }
    const outer = node === scope ? 0 : textBefore(scope, node);
    return { blockId, offset: outer + inner, cell };
  }

  /**
   * 块的可编辑文本范围：
   * 列表项隔离在 .md-item-text（排除嵌套子块）；
   * 数学块隔离在 .md-math-src（排除 KaTeX 渲染子树）；
   * mermaid 代码块隔离在 code.md-code（排除图表 SVG）；
   * 其他块为块元素本身。
   */
  private editableScope(blockId: BlockId): HTMLElement | null {
    const el = this.findEl(blockId);
    if (!el) return null;
    if (el.tagName === 'LI') {
      return el.querySelector<HTMLElement>(':scope > .md-item-text');
    }
    if (el.classList.contains('md-math')) {
      return el.querySelector<HTMLElement>(':scope > .md-math-src');
    }
    if (el.classList.contains('md-mermaid')) {
      return el.querySelector<HTMLElement>(':scope > .md-code');
    }
    return el;
  }

  private findEl(blockId: BlockId): HTMLElement | null {
    return this.rootEl?.querySelector<HTMLElement>(`[data-block-id="${blockId}"]`) ?? null;
  }
}

/** 深度优先收集文本节点（文档顺序） */
function textNodesOf(scope: HTMLElement): Text[] {
  const out: Text[] = [];
  const walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT);
  let n = walker.nextNode();
  while (n) {
    out.push(n as Text);
    n = walker.nextNode();
  }
  return out;
}

/** scope 内 target 节点之前（文档顺序）的文本总长 */
function textBefore(scope: HTMLElement, target: Node): number {
  let sum = 0;
  const visit = (n: Node): boolean => {
    if (n === target) return true;
    if (n.nodeType === Node.TEXT_NODE) {
      sum += (n as Text).length;
      return false;
    }
    for (const child of Array.from(n.childNodes)) {
      if (visit(child)) return true;
    }
    return false;
  };
  visit(scope);
  return sum;
}
