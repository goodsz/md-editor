import {
  deleteRange,
  indentItem,
  insertParagraphAfter,
  mergeWithNext,
  mergeWithPrev,
  outdentItem,
  pasteText,
  splitBlock,
  textLeafIds,
  topLevelIdOf,
  tryPrefixConvert,
} from '../input/commands';
import {
  enterNextRow,
  horizontalCellMove,
  replaceCellRange,
  tabNextCell,
  tabPrevCell,
  verticalCellMove,
} from '../input/table';
import type { LogicalPosition, LogicalSelection, Transaction } from '../model/types';
import { isListItem, isTable } from '../model/types';
import type { DocumentModel } from '../model/document';
import type { SelectionMapper } from '../selection/mapper';

/** 引擎对外能力（避免 controller ↔ engine 循环依赖） */
export interface EngineFacade {
  readonly composing: boolean;
  applyTransaction(tx: Transaction): void;
  undo(): void;
  redo(): void;
  /** IME 合成状态标记 */
  setComposing(v: boolean): void;
}

/** 点击后难以自然脱离、需在下方"另起一段"的块类型 */
const STUCK_BLOCK_TYPES = new Set(['code', 'math', 'table', 'hr', 'html']);

/**
 * InputController：编辑器根节点统一监听，按分流表处理输入。
 * 分流表见 DEVELOPMENT.md 6.4，是唯一事实来源。
 *
 * IME 铁律：composing === true 期间不做任何 DOM 写操作（渲染冻结）。
 */
export class InputController {
  private writeBackRaf = 0;
  private detachFns: Array<() => void> = [];
  private activeBlockId: string | null = null;
  private activeCb: ((blockId: string | null) => void) | null = null;

  constructor(
    private engine: EngineFacade,
    private model: DocumentModel,
    private mapper: SelectionMapper,
    private engineHooks: {
      prevLeaf(blockId: string): string | null;
      nextLeaf(blockId: string): string | null;
    },
  ) {}

  attach(root: HTMLElement): () => void {
    const on = <K extends keyof HTMLElementEventMap>(
      target: HTMLElement | Document,
      type: K | string,
      fn: EventListener,
      opts?: AddEventListenerOptions,
    ) => {
      target.addEventListener(type, fn, opts);
      this.detachFns.push(() => target.removeEventListener(type, fn, opts));
    };

    on(root, 'beforeinput', (e) => this.onBeforeInput(e as InputEvent));
    on(root, 'compositionstart', () => this.engine.setComposing(true));
    on(root, 'compositionupdate', () => this.engine.setComposing(true));
    on(root, 'compositionend', () => this.onCompositionEnd());
    on(root, 'keydown', (e) => this.onKeyDown(e as KeyboardEvent));
    on(document, 'selectionchange', () => this.onSelectionChange());
    // 点击数学/mermaid 渲染子树：光标移入该块源码区（Typora 行为：进入即显源码）
    on(root, 'click', (e) => this.onClickOnRender(e as MouseEvent));
    // 点击代码块等"整体删除型"块底部空白：另起一段（Typora 行为）
    on(root, 'click', (e) => this.onClickBelowContainer(e as MouseEvent));
    // 任务列表复选框勾选 / 链接点击（普通点击落光标，Ctrl/Cmd+点击打开）
    on(root, 'click', (e) => this.onClickAux(e as MouseEvent));
    // 点击块间/文档末尾空白：光标落到最近块（Typora 行为）
    on(root, 'click', (e) => this.onClickBlank(e as MouseEvent));

    return () => {
      this.detachFns.forEach((fn) => fn());
      this.detachFns = [];
      if (this.writeBackRaf) cancelAnimationFrame(this.writeBackRaf);
    };
  }

  // ------------------------------------------------------------
  // beforeinput 分流
  // ------------------------------------------------------------

  /** 事务提交兜底：异常不中断事件流（避免整编辑器假死） */
  private applyTx(tx: Transaction | null): void {
    if (!tx) return;
    try {
      this.engine.applyTransaction(tx);
    } catch (err) {
      console.error('[md-editor] 事务提交失败', err);
    }
  }

  private onBeforeInput(e: InputEvent): void {
    // IME 合成期间：一切放行，冻结渲染
    if (this.engine.composing || e.inputType === 'insertCompositionText') return;

    const logical = this.mapper.capture();
    if (!logical) return;
    const inCell = logical.focus.cell !== undefined;
    const sameCell =
      logical.anchor.cell !== undefined &&
      logical.focus.cell !== undefined &&
      logical.anchor.cell.r === logical.focus.cell.r &&
      logical.anchor.cell.c === logical.focus.cell.c;

    switch (e.inputType) {
      case 'insertText': {
        // 跨格选区输入
        if (inCell && !sameCell) {
          e.preventDefault();
          const tx = replaceCellRange(
            this.model,
            logical.focus.blockId,
            logical.anchor,
            logical.focus,
            e.data ?? '',
          );
          if (tx) this.applyTx(tx);
          return;
        }
        if (logical.anchor.blockId !== logical.focus.blockId) {
          // 跨块选区输入：拦截，删除范围后插入文本
          e.preventDefault();
          const tx = deleteRange(this.model, logical.anchor, logical.focus);
          const first = tx.ops[0];
          if (first && first.type === 'updateText' && e.data) {
            (first as { text: string }).text += e.data;
          }
          this.applyTx(tx);
          return;
        }
        if (e.data === ' ' && !inCell) {
          const tx = tryPrefixConvert(this.model, logical.focus.blockId);
          if (tx) {
            e.preventDefault();
            this.applyTx(tx);
            return;
          }
        }
        // 放行浏览器原生插入，rAF 后回写块树
        this.scheduleWriteBack();
        return;
      }
      case 'insertParagraph': {
        e.preventDefault();
        // 表格单元格：回车 = 下方插入新行并移入同列
        if (inCell) {
          const tx = enterNextRow(
            this.model,
            logical.focus.blockId,
            logical.focus.cell!.r,
            logical.focus.cell!.c,
          );
          if (tx) this.applyTx(tx);
          return;
        }
        this.applyTx(
          splitBlock(this.model, logical.focus.blockId, logical.focus.offset),
        );
        return;
      }
      case 'insertLineBreak': {
        // Shift+Enter：块内软换行
        e.preventDefault();
        this.insertTextInBlock(logical, '\n');
        return;
      }
      case 'deleteContentBackward': {
        if (inCell && !sameCell) {
          e.preventDefault();
          const tx = replaceCellRange(
            this.model,
            logical.focus.blockId,
            logical.anchor,
            logical.focus,
            '',
          );
          if (tx) this.applyTx(tx);
          return;
        }
        const collapsed =
          logical.anchor.blockId === logical.focus.blockId &&
          logical.anchor.offset === logical.focus.offset;
        if (collapsed && (logical.focus.offset === 0 || this.onPhantomNewline(logical.focus))) {
          e.preventDefault();
          if (inCell) return; // 格首退格：不动
          const tx = mergeWithPrev(this.model, logical.focus.blockId);
          if (tx) this.applyTx(tx);
          return;
        }
        if (collapsed) {
          this.scheduleWriteBack();
          return;
        }
        e.preventDefault();
        this.applyTx(deleteRange(this.model, logical.anchor, logical.focus));
        return;
      }
      case 'deleteContentForward': {
        if (inCell && !sameCell) {
          e.preventDefault();
          const tx = replaceCellRange(
            this.model,
            logical.focus.blockId,
            logical.anchor,
            logical.focus,
            '',
          );
          if (tx) this.applyTx(tx);
          return;
        }
        const collapsed =
          logical.anchor.blockId === logical.focus.blockId &&
          logical.anchor.offset === logical.focus.offset;
        if (
          collapsed &&
          (logical.focus.offset >= this.textLen(logical.focus.blockId) ||
            this.onPhantomNewline(logical.focus))
        ) {
          e.preventDefault();
          if (inCell) return; // 格尾 Delete：不动
          const tx = mergeWithNext(this.model, logical.focus.blockId);
          if (tx) this.applyTx(tx);
          return;
        }
        if (collapsed) {
          this.scheduleWriteBack();
          return;
        }
        e.preventDefault();
        this.applyTx(deleteRange(this.model, logical.anchor, logical.focus));
        return;
      }
      case 'deleteByCut': {
        if (inCell && !sameCell) {
          e.preventDefault();
          const tx = replaceCellRange(
            this.model,
            logical.focus.blockId,
            logical.anchor,
            logical.focus,
            '',
          );
          if (tx) this.applyTx(tx);
          return;
        }
        if (logical.anchor.blockId !== logical.focus.blockId) {
          e.preventDefault();
          this.applyTx(deleteRange(this.model, logical.anchor, logical.focus));
          return;
        }
        this.scheduleWriteBack();
        return;
      }
      case 'historyUndo':
        e.preventDefault();
        this.engine.undo();
        return;
      case 'historyRedo':
        e.preventDefault();
        this.engine.redo();
        return;
      case 'insertFromPaste': {
        e.preventDefault();
        const text = e.dataTransfer?.getData('text/plain') ?? '';
        if (!text) return;
        // 单元格内粘贴：压成单行文本
        if (inCell) {
          const tx = replaceCellRange(
            this.model,
            logical.focus.blockId,
            logical.focus,
            logical.focus,
            text.replace(/\r\n?/g, ' ').replace(/\n/g, ' '),
          );
          if (tx) this.applyTx(tx);
          return;
        }
        this.applyTx(pasteText(this.model, logical.focus, text));
        return;
      }
      default:
        // 其余输入类型放行 + 回写兜底
        this.scheduleWriteBack();
        return;
    }
  }

  private onCompositionEnd(): void {
    this.engine.setComposing(false);
    // 合成结束：立即回写块树（候选文本已落在 DOM 中）
    this.writeBackNow();
  }

  /** 点击 KaTeX / mermaid 渲染子树 → 光标落到该块源码末尾并激活 */
  private onClickOnRender(e: MouseEvent): void {
    const target = e.target as HTMLElement | null;
    if (!target) return;
    const render = target.closest('.md-math-render, .md-mermaid-render');
    if (!render) return;
    const blockEl = render.closest<HTMLElement>('[data-block-id]');
    const blockId = blockEl?.getAttribute('data-block-id');
    if (!blockId) return;
    e.preventDefault();
    e.stopPropagation();
    this.mapper.collapseToBlock(blockId);
    this.mapper.focusCurrent();
    this.onSelectionChange();
  }

  /**
   * 点击代码块 / 表格 / HTML 块的内容区底部空白 → 另起一段。
   * 仅当该块之后没有可承载正文的文本叶子时触发（否则无法脱离该块输入）。
   */
  private onClickBelowContainer(e: MouseEvent): void {
    const target = e.target as HTMLElement | null;
    if (!target) return;
    if (target.closest('.md-math-render, .md-mermaid-render')) return; // 由 onClickOnRender 处理
    const blockEl = target.closest<HTMLElement>('[data-block-id]');
    if (!blockEl || blockEl.classList.contains('md-spacer')) return;
    const blockId = blockEl.getAttribute('data-block-id') ?? '';
    const node = this.model.getBlock(blockId);
    if (!node || isListItem(node) || !STUCK_BLOCK_TYPES.has(node.type)) return;
    if (node.type === 'code' && blockEl.classList.contains('md-mermaid')) return;
    // 以块内最后一个可见内容子元素的底边为界（代码块取 code、公式取渲染/源码层）
    const visible = Array.from(blockEl.children).filter((c) => (c as HTMLElement).offsetHeight > 0);
    const inner = (visible[visible.length - 1] as HTMLElement | undefined) ?? blockEl;
    const bounds = inner.getBoundingClientRect();
    if (e.clientY <= bounds.bottom + 2) return; // 命中内容区，走原生光标
    if (this.hasTextLeafAfter(blockId)) return;
    e.preventDefault();
    e.stopPropagation();
    this.appendTrailingParagraph();
  }

  /** 任务复选框勾选切换；链接点击落光标；Ctrl/Cmd+点击链接打开 */
  private onClickAux(e: MouseEvent): void {
    const target = e.target as HTMLElement | null;
    if (!target) return;

    const checkbox = target.closest<HTMLInputElement>('input[data-task-item]');
    if (checkbox) {
      // 不 preventDefault：浏览器已原生翻转 checked，直接采用新值
      const itemId = checkbox.dataset['taskItem']!;
      const node = this.model.getBlock(itemId);
      if (node && isListItem(node)) {
        const logical = this.mapper.capture() ?? {
          anchor: { blockId: itemId, offset: 0 },
          focus: { blockId: itemId, offset: 0 },
        };
        this.applyTx({
          ops: [{ type: 'updateAttrs', id: itemId, attrs: { checked: checkbox.checked } }],
          selection: logical,
        });
        // 光标落入该项文本末尾：后续可直接点击/输入继续编辑
        const len = this.mapper.textOf(itemId)?.length ?? 0;
        this.mapper.restore({
          anchor: { blockId: itemId, offset: len },
          focus: { blockId: itemId, offset: len },
        });
        this.mapper.focusCurrent();
        this.onSelectionChange();
      }
      return;
    }

    const link = target.closest<HTMLAnchorElement>('a[data-inline="link"]');
    if (link) {
      if (e.ctrlKey || e.metaKey) {
        const href = link.getAttribute('href');
        if (href) {
          e.preventDefault();
          window.open(href, '_blank', 'noopener,noreferrer');
        }
        return;
      }
      // 普通点击：确保光标落入链接文本内（Typora 行为）
      const doc = document as Document & {
        caretRangeFromPoint?(x: number, y: number): Range | null;
      };
      const range = doc.caretRangeFromPoint?.(e.clientX, e.clientY) ?? null;
      const dom = window.getSelection();
      if (dom && range && link.contains(range.startContainer)) {
        e.preventDefault();
        dom.removeAllRanges();
        dom.addRange(range);
        this.mapper.focusCurrent();
        this.onSelectionChange();
      }
    }
  }

  /** 该块之后（文档序）是否还存在可承载正文的文本叶子 */
  private hasTextLeafAfter(blockId: string): boolean {
    const leaves = textLeafIds(this.model);
    const idx = leaves.indexOf(blockId);
    if (idx < 0) return true; // 未知块：保守不插入
    return leaves.slice(idx + 1).some((id) => {
      const n = this.model.getBlock(id);
      return !!n && (isListItem(n) || n.type === 'paragraph' || n.type === 'heading');
    });
  }

  /** 文档末尾另起一段：在最后一个叶子所属顶层块后插入空段落（渲染后聚焦） */
  private appendTrailingParagraph(): void {
    const leaves = textLeafIds(this.model);
    const last = leaves[leaves.length - 1];
    if (!last) return;
    const top = topLevelIdOf(this.model, last);
    this.applyTx(insertParagraphAfter(top));
    this.onSelectionChange();
    // 空段落经 rAF 渲染出 DOM 后再聚焦（渲染 rAF 先注册先执行）
    requestAnimationFrame(() => this.mapper.focusCurrent());
  }

  /**
   * 点击块间/文档末尾空白：光标落到最近可编辑块（Typora 行为）。
   * caretRangeFromPoint 命中"整体删除型"块（代码/公式/表格/分割线/HTML）且其后
   * 无文本叶子时另起一段；未命中（文档末尾空白）且最后叶子不可承载正文时同理。
   */
  private onClickBlank(e: MouseEvent): void {
    const target = e.target as HTMLElement | null;
    if (!target || target.closest('[data-block-id]')) return;
    if (target.closest('.md-spacer')) return;
    const doc = document as Document & {
      caretRangeFromPoint?(x: number, y: number): Range | null;
    };
    if (doc.caretRangeFromPoint) {
      const range = doc.caretRangeFromPoint(e.clientX, e.clientY);
      const node = range?.startContainer ?? null;
      const el =
        node && node.nodeType === Node.TEXT_NODE
          ? (node as Text).parentElement
          : (node as HTMLElement | null);
      const blockEl = el?.closest<HTMLElement>('[data-block-id]');
      if (blockEl && !blockEl.classList.contains('md-spacer')) {
        const blockId = blockEl.getAttribute('data-block-id') ?? '';
        const bn = this.model.getBlock(blockId);
        if (bn && !isListItem(bn) && STUCK_BLOCK_TYPES.has(bn.type) && !this.hasTextLeafAfter(blockId)) {
          this.appendTrailingParagraph();
          return;
        }
        const dom = window.getSelection();
        if (dom && range) {
          dom.removeAllRanges();
          dom.addRange(range);
          this.mapper.focusCurrent();
          this.onSelectionChange();
        }
        return;
      }
    }
    // 文档末尾兜底：最后叶子不可承载正文 → 另起一段；否则光标到最后叶子末尾
    const leaves = textLeafIds(this.model);
    const last = leaves[leaves.length - 1];
    if (!last) return;
    const lastNode = this.model.getBlock(last);
    if (lastNode && !isListItem(lastNode) && STUCK_BLOCK_TYPES.has(lastNode.type)) {
      this.appendTrailingParagraph();
      return;
    }
    const len = this.mapper.textOf(last)?.length ?? 0;
    this.mapper.restore({
      anchor: { blockId: last, offset: len },
      focus: { blockId: last, offset: len },
    });
    this.mapper.focusCurrent();
    this.onSelectionChange();
  }

  // ------------------------------------------------------------
  // 回写：DOM 文本 → 块树
  // ------------------------------------------------------------

  private scheduleWriteBack(): void {
    if (this.writeBackRaf) return;
    this.writeBackRaf = requestAnimationFrame(() => {
      this.writeBackRaf = 0;
      this.writeBackNow();
    });
  }

  private writeBackNow(): void {
    if (this.engine.composing) return; // IME 铁律
    const logical = this.mapper.capture();
    if (!logical) return;
    this.syncBlockFromDom(logical);
  }

  /** 将当前焦点块 DOM 文本回写为块树 text，并恢复光标 */
  private syncBlockFromDom(logical: LogicalSelection): void {
    const blockId = logical.focus.blockId;
    const node = this.model.getBlock(blockId);
    if (!node) return;

    // 表格单元格回写：格内 DOM 文本 → rows[r][c]
    if (logical.focus.cell) {
      if (!isTable(node)) return;
      const { r, c } = logical.focus.cell;
      const cellText = this.mapper.cellText(blockId, r, c);
      if (cellText === null) return;
      const rows = node.rows.map((row) => [...row]);
      if (rows[r]?.[c] === cellText) return;
      rows[r][c] = cellText;
      this.applyTx({
        ops: [{ type: 'updateAttrs', id: blockId, attrs: { rows } }],
        selection: logical,
      });
      return;
    }

    const text = this.mapper.textOf(blockId);
    if (text === null) return;

    let tx: Transaction | null = null;
    if (isListItem(node) || node.type === 'paragraph' || node.type === 'heading') {
      if (node.text !== text) {
        tx = { ops: [{ type: 'updateText', id: blockId, text }], selection: logical };
      }
    } else if (node.type === 'code') {
      // 渲染时空代码显示为单个 \n，回写时归一为 ''
      const code = text === '\n' ? '' : text;
      if (node.code !== code) {
        tx = { ops: [{ type: 'updateAttrs', id: blockId, attrs: { code } }], selection: logical };
      }
    } else if (node.type === 'math') {
      // textOf 已隔离到 .md-math-src，直接就是 tex
      if (node.tex !== text) {
        tx = { ops: [{ type: 'updateAttrs', id: blockId, attrs: { tex: text } }], selection: logical };
      }
    }
    if (tx) this.applyTx(tx);
  }

  private insertTextInBlock(logical: LogicalSelection, text: string): void {
    const node = this.model.getBlock(logical.focus.blockId);
    if (!node) return;
    if (isListItem(node) || node.type === 'paragraph' || node.type === 'heading') {
      const base = node.text;
      const offset = logical.focus.offset;
      this.applyTx({
        ops: [{ type: 'updateText', id: node.id, text: base.slice(0, offset) + text + base.slice(offset) }],
        selection: {
          anchor: { blockId: node.id, offset: offset + text.length },
          focus: { blockId: node.id, offset: offset + text.length },
        },
      });
    } else if (node.type === 'code') {
      const offset = logical.focus.offset;
      this.applyTx({
        ops: [{ type: 'updateAttrs', id: node.id, attrs: { code: node.code.slice(0, offset) + text + node.code.slice(offset) } }],
        selection: {
          anchor: { blockId: node.id, offset: offset + text.length },
          focus: { blockId: node.id, offset: offset + text.length },
        },
      });
    }
  }

  // ------------------------------------------------------------
  // keydown：快捷键与跨块导航
  // ------------------------------------------------------------

  private onKeyDown(e: KeyboardEvent): void {
    if (this.engine.composing) return;
    const mod = e.ctrlKey || e.metaKey;

    if (mod && !e.shiftKey && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      this.engine.undo();
      return;
    }
    if ((mod && e.shiftKey && e.key.toLowerCase() === 'z') || (mod && e.key.toLowerCase() === 'y')) {
      e.preventDefault();
      this.engine.redo();
      return;
    }

    if (e.key === 'Tab') {
      const logical = this.mapper.capture();
      if (!logical) return;
      // 表格：Tab 在单元格间移动，末格追加新行
      if (logical.focus.cell) {
        e.preventDefault();
        if (e.shiftKey) {
          const prev = tabPrevCell(
            this.model,
            logical.focus.blockId,
            logical.focus.cell.r,
            logical.focus.cell.c,
          );
          if (prev) {
            this.mapper.restore({
              anchor: { blockId: prev.blockId, offset: prev.offset, cell: prev.cell },
              focus: { blockId: prev.blockId, offset: prev.offset, cell: prev.cell },
            });
          }
          return;
        }
        const tx = tabNextCell(
          this.model,
          logical.focus.blockId,
          logical.focus.cell.r,
          logical.focus.cell.c,
        );
        if (tx) this.applyTx(tx);
        return;
      }
      const node = this.model.getBlock(logical.focus.blockId);
      if (!node || !isListItem(node)) {
        e.preventDefault(); // 非列表项：吞掉 Tab 防止焦点丢失
        return;
      }
      e.preventDefault();
      const tx = e.shiftKey
        ? outdentItem(this.model, node.id)
        : indentItem(this.model, node.id);
      if (tx) this.applyTx(tx);
      return;
    }

    if (
      e.key === 'ArrowLeft' ||
      e.key === 'ArrowRight' ||
      e.key === 'ArrowUp' ||
      e.key === 'ArrowDown'
    ) {
      if (this.navigateCellArrow(e)) return;
      this.navigateArrow(e);
      return;
    }
  }

  /** 表格单元格方向键导航；返回 true 表示已处理 */
  private navigateCellArrow(e: KeyboardEvent): boolean {
    const logical = this.mapper.capture();
    if (!logical?.focus.cell) return false;
    if (logical.anchor.cell && !this.sameCellPos(logical.anchor, logical.focus)) return false; // 跨格选区：交给浏览器
    const { blockId, offset, cell } = logical.focus;
    const { r, c } = cell!;
    const cellLen = this.mapper.cellText(blockId, r, c)?.length ?? 0;
    const restoreCell = (pos: LogicalPosition, atEnd: boolean): void => {
      const target =
        this.mapper.cellText(pos.blockId, pos.cell!.r, pos.cell!.c)?.length ?? 0;
      const off = atEnd ? target : Math.min(offset, target);
      this.mapper.restore({
        anchor: { blockId: pos.blockId, offset: off, cell: pos.cell },
        focus: { blockId: pos.blockId, offset: off, cell: pos.cell },
      });
    };

    if (e.key === 'ArrowLeft' && offset === 0) {
      const prev = horizontalCellMove(this.model, blockId, r, c, -1);
      if (prev) {
        e.preventDefault();
        restoreCell(prev, true);
        return true;
      }
      return false; // 表格首格左边界：交给上一块导航
    }
    if (e.key === 'ArrowRight' && offset >= cellLen) {
      const next = horizontalCellMove(this.model, blockId, r, c, 1);
      if (next) {
        e.preventDefault();
        restoreCell(next, false);
        return true;
      }
      return false;
    }
    if (e.key === 'ArrowUp') {
      const up = verticalCellMove(this.model, blockId, r, c, -1);
      if (up) {
        e.preventDefault();
        restoreCell(up, false);
        return true;
      }
      return false;
    }
    if (e.key === 'ArrowDown') {
      const down = verticalCellMove(this.model, blockId, r, c, 1);
      if (down) {
        e.preventDefault();
        restoreCell(down, false);
        return true;
      }
    }
    return false;
  }

  private sameCellPos(a: LogicalPosition, b: LogicalPosition): boolean {
    return (
      a.cell !== undefined &&
      b.cell !== undefined &&
      a.cell.r === b.cell.r &&
      a.cell.c === b.cell.c
    );
  }

  private navigateArrow(e: KeyboardEvent): void {
    const logical = this.mapper.capture();
    if (!logical) return;
    if (logical.anchor.blockId !== logical.focus.blockId) return; // 跨块选区：交给浏览器
    const { blockId, offset } = logical.focus;
    const len = this.textLen(blockId);

    if (e.key === 'ArrowLeft' && offset === 0) {
      const prev = this.engineHooks.prevLeaf(blockId);
      if (prev) {
        e.preventDefault();
        this.mapper.restore({
          anchor: { blockId: prev, offset: this.textLen(prev) },
          focus: { blockId: prev, offset: this.textLen(prev) },
        });
      }
      return;
    }
    if (e.key === 'ArrowRight' && offset >= len) {
      const next = this.engineHooks.nextLeaf(blockId);
      if (next) {
        e.preventDefault();
        this.mapper.restore({
          anchor: { blockId: next, offset: 0 },
          focus: { blockId: next, offset: 0 },
        });
      }
      return;
    }
    if (e.key === 'ArrowUp' && offset === 0) {
      const prev = this.engineHooks.prevLeaf(blockId);
      if (prev) {
        e.preventDefault();
        this.mapper.restore({
          anchor: { blockId: prev, offset: this.textLen(prev) },
          focus: { blockId: prev, offset: this.textLen(prev) },
        });
      }
      return;
    }
    if (e.key === 'ArrowDown' && offset >= len) {
      const next = this.engineHooks.nextLeaf(blockId);
      if (next) {
        e.preventDefault();
        this.mapper.restore({
          anchor: { blockId: next, offset: 0 },
          focus: { blockId: next, offset: 0 },
        });
      }
    }
  }

  // ------------------------------------------------------------
  // 块激活样式：光标所在块 .block-active
  // ------------------------------------------------------------

  private onSelectionChange(): void {
    const logical = this.mapper.capture();
    const id = logical?.focus.blockId ?? null;
    if (id !== this.activeBlockId) {
      this.activeBlockId = id;
      this.activeCb?.(id);
    }
  }

  onActiveBlockChange(cb: (blockId: string | null) => void): void {
    this.activeCb = cb;
  }

  private textLen(blockId: string): number {
    return this.mapper.textOf(blockId)?.length ?? 0;
  }

  /** 空代码块渲染为单个 \n：光标在该幻影换行上（offset 1）时按块首/块尾处理 */
  private onPhantomNewline(pos: LogicalPosition): boolean {
    if (pos.offset !== 1 || pos.cell) return false;
    const node = this.model.getBlock(pos.blockId);
    return !!node && !isListItem(node) && node.type === 'code' && node.code === '';
  }

  getActiveBlockId(): string | null {
    return this.activeBlockId;
  }

  /** 暴露给引擎：叶子导航列表 */
  static leafIdsOf(model: DocumentModel): string[] {
    return textLeafIds(model);
  }
}
