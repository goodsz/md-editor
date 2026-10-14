import { docToMarkdown } from '../engine/model/convert';
import { newId, type Transaction } from '../engine/model/types';
import type { BlockEngine } from '../engine';
import type { AnyNode, Block, ListItem } from '../engine/model/types';

/** 顶层块在源码文本中的字符区间 */
interface BlockRange {
  id: string;
  start: number;
  end: number;
}

/**
 * 源码模式（Ctrl+/）：整页 textarea 编辑 markdown 源码，
 * 退出时整树重载。textarea 内保留原生 undo。
 *
 * 光标映射（enter/exit 双向）：以"顶层块 → 源码字符区间"为锚，
 * 顶层段落/标题/代码/数学块可精确换算（序列化前缀 + 逻辑偏移），
 * 引用子块/列表项按块文本在区间内搜索定位。
 */
export class SourceMode {
  private active = false;
  /** enter 时构建；exit 时清空。源码编辑后区间会漂移，仅作近似定位 */
  private ranges: BlockRange[] = [];

  constructor(
    private engine: BlockEngine,
    private textarea: HTMLTextAreaElement,
    private app: HTMLElement,
    private onChange: (active: boolean) => void,
  ) {
    // Tab 缩进两个空格，避免焦点跳出
    this.textarea.addEventListener('keydown', (e) => {
      if (e.key === 'Tab') {
        e.preventDefault();
        const el = this.textarea;
        const start = el.selectionStart;
        const end = el.selectionEnd;
        el.value = el.value.slice(0, start) + '  ' + el.value.slice(end);
        el.selectionStart = el.selectionEnd = start + 2;
      }
    });
  }

  get isActive(): boolean {
    return this.active;
  }

  getText(): string {
    return this.textarea.value;
  }

  toggle(): void {
    if (this.active) this.exit();
    else this.enter();
  }

  enter(): void {
    this.textarea.value = this.engine.getMarkdown();
    this.buildRanges();
    this.app.classList.add('source-mode');
    this.active = true;
    // 切换模式保持光标：逻辑选区 → 源码字符位置（无法定位时落到文首，保证光标可见）
    const pos = this.caretFromEngine();
    this.textarea.focus();
    this.textarea.setSelectionRange(pos >= 0 ? pos : 0, pos >= 0 ? pos : 0);
    this.onChange(true);
  }

  exit(): void {
    const value = this.textarea.value;
    const pos = this.textarea.selectionStart;
    const rangeIdx = this.rangeIndexAt(pos);
    const range = this.ranges[rangeIdx];
    this.engine.loadMarkdown(value);
    this.app.classList.remove('source-mode');
    this.active = false;
    this.ranges = [];
    // 空文档兜底：至少保留一个可编辑段落，否则无块可聚焦、无法输入
    if (this.engine.model.getRoot().length === 0) {
      const id = newId();
      const tx: Transaction = {
        ops: [{ type: 'insert', after: null, block: { id, type: 'paragraph', text: '' } }],
        selection: { anchor: { blockId: id, offset: 0 }, focus: { blockId: id, offset: 0 } },
      };
      this.engine.applyTransaction(tx);
    }
    // 切换模式保持光标：源码位置 → 新树对应块（区间按位置对应，与块 id 无关）
    const block = this.engine.model.getRoot()[rangeIdx];
    if (block) {
      const leaf = firstTextLeafOf(block);
      const len = this.engine.getLeafLength(leaf.id);
      let offset = range ? pos - range.start : 0;
      if (range && leaf.id === block.id) {
        offset -= exactPrefixOf(block) ?? 0; // 顶层块扣除序列化前缀（# 、``` 等）
      }
      offset = Math.max(0, Math.min(offset, len));
      this.engine.revealBlock(leaf.id, offset);
    } else {
      this.engine.focusStart();
    }
    this.onChange(false);
  }

  /** 大纲跳转（源码模式）：定位到 textarea 中对应的标题行 */
  revealTo(blockId: string): void {
    if (!this.active) return;
    const nth = this.headingOrdinal(blockId);
    if (nth < 0) return;
    const pos = this.nthHeadingPos(nth);
    this.textarea.focus();
    this.textarea.setSelectionRange(pos, pos);
  }

  // ------------------------------------------------------------

  /** 逐顶层块序列化累计偏移，构建源码区间表 */
  private buildRanges(): void {
    this.ranges = [];
    const blocks = this.engine.model.getRoot();
    let off = 0;
    for (let i = 0; i < blocks.length; i++) {
      const md = docToMarkdown([blocks[i]]);
      this.ranges.push({ id: blocks[i].id, start: off, end: off + md.length });
      off += md.length + (i < blocks.length - 1 ? 2 : 0); // docToMarkdown 以 \n\n 连接
    }
  }

  /** 字符位置 → 顶层块序（命中区间；越界收敛到最近块） */
  private rangeIndexAt(pos: number): number {
    for (let i = 0; i < this.ranges.length; i++) {
      if (pos < this.ranges[i].end) return i;
    }
    return Math.max(0, this.ranges.length - 1);
  }

  /** 当前逻辑光标 → 源码字符位置；无法定位返回 -1 */
  private caretFromEngine(): number {
    const sel = this.engine.getSelection();
    if (!sel || !sel.focus.blockId) return -1;
    const { blockId, offset } = sel.focus;
    if (sel.focus.cell) return -1; // 表格单元格暂不做精确映射
    const node = this.engine.model.getBlock(blockId);
    if (!node) return -1;
    const topId = this.topIdOf(blockId);
    const range = this.ranges.find((r) => r.id === topId);
    if (!range) return -1;

    // 顶层段落/标题/代码/数学：序列化前缀可精确换算
    const prefix = isListItemNode(node) ? null : exactPrefixOf(node);
    if (prefix !== null) {
      return clamp(range.start + prefix + offset, range.start, range.end);
    }
    // 嵌套（引用子块 / 列表项）：按块文本在顶层区间内搜索
    const text = nodeTextOf(node);
    if (text) {
      const at = this.textarea.value.indexOf(text, range.start);
      if (at >= 0 && at < range.end) return clamp(at + offset, range.start, range.end);
    }
    return range.start;
  }

  /** 解析嵌套节点所属顶层块 id */
  private topIdOf(blockId: string): string | null {
    let cur = this.engine.model.getEntry(blockId);
    let last = blockId;
    let guard = 0;
    while (cur && cur.parentId !== null && guard < 64) {
      last = cur.parentId;
      cur = this.engine.model.getEntry(cur.parentId);
      guard++;
    }
    return cur && cur.parentId === null ? last : null;
  }

  /** blockId 是文档中第几个标题（含引用块内标题，按文档序）；非标题返回 -1 */
  private headingOrdinal(blockId: string): number {
    let nth = -1;
    let i = 0;
    const walk = (list: readonly (Block | ListItem)[]): void => {
      for (const b of list) {
        if (isListItemNode(b)) {
          if (b.children) walk(b.children);
        } else if (b.type === 'heading') {
          if (b.id === blockId) nth = i;
          i++;
        } else if (b.type === 'quote') {
          walk(b.children);
        } else if (b.type === 'list') {
          walk(b.items);
        }
      }
    };
    walk(this.engine.model.getRoot());
    return nth;
  }

  /** textarea 中第 nth 个标题行的位置（跳过围栏代码块内的 # 行） */
  private nthHeadingPos(nth: number): number {
    const lines = this.textarea.value.split('\n');
    let pos = 0;
    let count = 0;
    let inFence = false;
    let fenceCh = '';
    for (const line of lines) {
      const fence = /^\s*(`{3,}|~{3,})/.exec(line);
      if (fence) {
        if (!inFence) {
          inFence = true;
          fenceCh = fence[1][0];
        } else if (fence[1][0] === fenceCh) {
          inFence = false;
        }
      } else if (!inFence && /^\s*(?:>\s*)*#{1,6}\s/.test(line)) {
        if (count === nth) break;
        count++;
      }
      pos += line.length + 1;
    }
    return Math.max(0, Math.min(pos, this.textarea.value.length));
  }
}

// ------------------------------------------------------------

function isListItemNode(n: AnyNode): n is ListItem {
  return !('type' in n);
}

/** 顶层块序列化前缀长度（逻辑偏移 → 源码偏移的换算量）；不可精确换算返回 null */
function exactPrefixOf(b: Block): number | null {
  switch (b.type) {
    case 'paragraph':
      return 0;
    case 'heading':
      return b.level + 1;
    case 'code':
      return 4 + b.lang.length; // ```lang\n
    case 'math':
      return 3; // $$\n
    default:
      return null;
  }
}

/** 块/列表项的源码正文文本（区间内搜索定位用） */
function nodeTextOf(n: AnyNode): string | null {
  if (isListItemNode(n)) return n.text;
  switch (n.type) {
    case 'paragraph':
    case 'heading':
      return n.text;
    case 'code':
      return n.code;
    case 'math':
      return n.tex;
    default:
      return null;
  }
}

/** 定位块内第一个可输入叶子（quote/list 取首个子节点的叶子） */
function firstTextLeafOf(n: Block | ListItem): Block | ListItem {
  if (isListItemNode(n)) return n;
  if (n.type === 'quote') return n.children.length ? firstTextLeafOf(n.children[0]) : n;
  if (n.type === 'list') return n.items.length ? firstTextLeafOf(n.items[0]) : n;
  return n;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(v, hi));
}
