import { HistoryManager, type Snapshot } from './history/history';
import { InputController, type EngineFacade } from './input/controller';
import { textLeafIds } from './input/commands';
import { DocumentModel } from './model/document';
import type { BlockId, LogicalSelection, Transaction } from './model/types';
import { BlockRenderer } from './render/renderer';
import { SelectionMapper } from './selection/mapper';
import { parseDocAsync, serializeDocAsync } from './workers/docWorkerClient';

/**
 * BlockEngine：装配 DocumentModel / BlockRenderer / SelectionMapper /
 * InputController / HistoryManager，对外提供应用层 API。
 * 渲染调度：rAF 合并同帧多次标脏；IME 合成期间冻结。
 */
export class BlockEngine implements EngineFacade {
  readonly model = new DocumentModel();
  readonly history = new HistoryManager();

  private renderer: BlockRenderer;
  private mapper = new SelectionMapper();
  private controller: InputController;
  private detachFn: () => void;

  private composingState = false;
  private pendingDirty = new Set<string>();
  private rafScheduled = false;
  private rafId: number | null = null;
  private pendingSelection: LogicalSelection | null = null;
  private onFocusIn: () => void = () => {};
  private onFocusOut: () => void = () => {};

  // undo 合并窗口
  private lastTextBlockId: string | null = null;
  private lastPushAt = 0;

  constructor(
    private root: HTMLElement,
    initialMarkdown: string,
  ) {
    this.root = root;
    root.classList.add('md-editor-root');
    root.contentEditable = 'false'; // 根节点不可编辑，各块独立 editing host
    this.mapper.setRoot(root);
    this.renderer = new BlockRenderer(this.model);
    this.model.fromMarkdown(initialMarkdown);
    this.renderer.mount(root);
    this.history.reset({
      doc: this.model.getRoot(),
      selection: this.startSelection(),
    });
    this.controller = new InputController(this, this.model, this.mapper, {
      prevLeaf: (id) => this.siblingLeaf(id, -1),
      nextLeaf: (id) => this.siblingLeaf(id, 1),
    });
    this.detachFn = this.controller.attach(root);
    this.controller.onActiveBlockChange((id) => this.setActiveBlock(id));
    this.model.onDirty((dirty) => this.scheduleRender(dirty));
    // 编辑焦点跟踪：失焦时通过 .editing-focus 强制隐藏行内标记（防 block-active 残留）
    this.onFocusIn = () => root.classList.add('editing-focus');
    this.onFocusOut = () => {
      setTimeout(() => {
        if (!root.contains(document.activeElement)) root.classList.remove('editing-focus');
      }, 0);
    };
    root.addEventListener('focusin', this.onFocusIn);
    root.addEventListener('focusout', this.onFocusOut);
  }

  get composing(): boolean {
    return this.composingState;
  }

  /** 编辑器根元素（导出/打印文档构建用） */
  get rootElement(): HTMLElement {
    return this.root;
  }

  setComposing(v: boolean): void {
    this.composingState = v;
    if (!v) {
      // 合成结束：恢复渲染调度
      this.scheduleRender(new Set());
    }
  }

  /** 提交事务：标记目标光标 → 入 undo 栈（带合并规则）→ 标脏 → 渲染调度恢复光标 */
  applyTransaction(tx: Transaction): void {
    if (tx.ops.length === 0) {
      this.pendingSelection = tx.selection;
      this.scheduleRender(new Set());
      return;
    }
    // pendingSelection 必须先于 apply 设置：
    // model.apply 同步触发 onDirty → 渲染调度可能立即消费该值
    this.pendingSelection = tx.selection;
    this.model.apply(tx);
    this.pushHistory(tx);
  }

  undo(): void {
    const snap = this.history.undo();
    if (snap) this.loadSnapshot(snap);
  }

  redo(): void {
    const snap = this.history.redo();
    if (snap) this.loadSnapshot(snap);
  }

  getMarkdown(): string {
    return this.model.toMarkdown();
  }

  /** 当前 DOM 选区 → 逻辑选区 */
  getSelection(): LogicalSelection | null {
    return this.mapper.capture();
  }

  /** 恢复逻辑选区到 DOM */
  restoreSelection(sel: LogicalSelection): void {
    this.mapper.restore(sel);
  }

  /** 将焦点落到当前 DOM 选区所在的编辑宿主（块或单元格），保证键盘输入生效 */
  focusCurrent(): void {
    this.mapper.focusCurrent();
  }

  /** 叶子块文本长度（全选等场景用） */
  getLeafLength(blockId: string): number {
    return this.mapper.textOf(blockId)?.length ?? 0;
  }

  loadMarkdown(md: string): void {
    this.model.fromMarkdown(md);
    this.renderer.mount(this.root);
    this.history.reset({
      doc: this.model.getRoot(),
      selection: this.startSelection(),
    });
    this.pendingSelection = null;
  }

  /** 大文档异步加载：解析在 Worker 执行（回退主线程），不阻塞 UI */
  async loadMarkdownAsync(md: string): Promise<void> {
    const doc = await parseDocAsync(md);
    this.model.loadDoc(doc);
    this.renderer.mount(this.root);
    this.history.reset({
      doc: this.model.getRoot(),
      selection: this.startSelection(),
    });
    this.pendingSelection = null;
  }

  /** 大文档异步序列化（自动保存用），不阻塞 UI */
  toMarkdownAsync(): Promise<string> {
    return serializeDocAsync(this.model.getRoot());
  }

  /** 导出/打印包装：先全量真实渲染（修复虚拟化文档导出空白页），执行 run，
   *  结束后恢复虚拟化、滚动位置与光标选区。
   *  preparePrint 抛错同样恢复（finishPrint 幂等），防止 printMode 卡死导致
   *  虚拟化失效、页面残缺 */
  async withPrintRendering<T>(
    run: () => Promise<T> | T,
    onPrepareProgress?: (fraction: number) => void,
  ): Promise<T> {
    const sel = this.getSelection();
    try {
      await this.renderer.preparePrint(onPrepareProgress);
      return await run();
    } finally {
      this.renderer.finishPrint();
      if (sel && this.mapper.restore(sel)) {
        this.mapper.focusCurrent();
        this.setActiveBlock(sel.focus.blockId);
        // 全量重建后高度为估算值，按光标块重新定位滚动
        const top = this.topLevelIdOf(sel.focus.blockId);
        if (top) this.renderer.scrollToBlock(top);
      }
    }
  }

  /** 绑定编辑区滚动容器（长文档虚拟化窗口计算依据） */
  attachViewport(el: HTMLElement): void {
    this.renderer.setViewport(el);
    this.renderer.refreshVirtual();
  }

  /** 滚动并渲染指定块（大纲跳转 / 撤销远跳恢复用），随后落光标并聚焦该块 */
  revealBlock(blockId: BlockId, offset = 0): void {
    const top = this.topLevelIdOf(blockId) ?? blockId;
    this.renderer.scrollToBlock(top);
    this.mapper.restore({
      anchor: { blockId, offset },
      focus: { blockId, offset },
    });
    this.mapper.focusBlock(blockId);
    this.setActiveBlock(blockId);
  }

  /** 解析嵌套块所属的顶层块 id（虚拟化以顶层块为窗口单元） */
  private topLevelIdOf(blockId: BlockId): BlockId | null {
    let cur = this.model.getEntry(blockId);
    let last = blockId;
    let guard = 0;
    while (cur && cur.parentId !== null && guard < 64) {
      last = cur.parentId;
      cur = this.model.getEntry(cur.parentId);
      guard++;
    }
    return cur && cur.parentId === null ? last : null;
  }

  /** 焦点落入第一个文本叶子（同时聚焦宿主，保证可直接键入） */
  focusStart(): void {
    const leaves = textLeafIds(this.model);
    if (leaves.length > 0) {
      const first = leaves[0];
      this.mapper.restore({
        anchor: { blockId: first, offset: 0 },
        focus: { blockId: first, offset: 0 },
      });
      this.mapper.focusCurrent();
      this.setActiveBlock(first);
    }
  }

  destroy(): void {
    this.detachFn();
    this.renderer.setViewport(null);
    if (this.rafId !== null) cancelAnimationFrame(this.rafId);
    this.root.removeEventListener('focusin', this.onFocusIn);
    this.root.removeEventListener('focusout', this.onFocusOut);
  }
  // ------------------------------------------------------------

  private startSelection(): LogicalSelection {
    const leaves = textLeafIds(this.model);
    const pos = leaves.length
      ? { blockId: leaves[leaves.length - 1], offset: this.leafLen(leaves[leaves.length - 1]) }
      : { blockId: '', offset: 0 };
    return { anchor: pos, focus: pos };
  }

  private leafLen(blockId: string): number {
    return this.mapper.textOf(blockId)?.length ?? 0;
  }

  private pushHistory(tx: Transaction): void {
    const now = Date.now();
    const first = tx.ops[0];
    const isTextOnly =
      tx.ops.length === 1 && first.type === 'updateText' && first.id === this.lastTextBlockId;
    if (isTextOnly && now - this.lastPushAt < 800) {
      // 同块连续输入合并为一条
      this.lastPushAt = now;
      return;
    }
    this.history.push({ doc: this.model.getRoot(), selection: tx.selection });
    this.lastPushAt = now;
    this.lastTextBlockId =
      tx.ops.length === 1 && tx.ops[0].type === 'updateText' ? (tx.ops[0].id as string) : null;
  }

  private loadSnapshot(snap: Snapshot): void {
    this.model.loadDoc(snap.doc);
    this.renderer.mount(this.root);
    this.pendingSelection = null;
    const focusId = snap.selection.focus.blockId || null;
    // 光标恢复兜底链（undo 后目标块可能未渲染/偏移越界/已不存在）：
    // 1) 直接恢复 2) 滚动渲染后重试 3) 焦点块块首 4) 末文本叶子 5) 文首
    let restored = this.mapper.restore(snap.selection);
    if (!restored && focusId) {
      const top = this.topLevelIdOf(focusId);
      if (top) this.renderer.scrollToBlock(top);
      restored =
        this.mapper.restore(snap.selection) ||
        this.mapper.restore({
          anchor: { blockId: focusId, offset: 0 },
          focus: { blockId: focusId, offset: 0 },
        });
    }
    let hostId = focusId;
    if (!restored) {
      const leaves = textLeafIds(this.model);
      hostId = leaves[leaves.length - 1] ?? null;
      if (!hostId || !this.mapper.restore({
        anchor: { blockId: hostId, offset: 0 },
        focus: { blockId: hostId, offset: 0 },
      })) {
        this.focusStart();
        hostId = hostId ?? null;
      }
    }
    // mount 全量重建会移除原焦点宿主：显式聚焦，否则 undo 后无法继续键入
    if (hostId) this.mapper.focusBlock(hostId);
    this.setActiveBlock(hostId);
  }

  private scheduleRender(dirty: Set<string>): void {
    for (const id of dirty) this.pendingDirty.add(id);
    if (this.composingState) return; // IME 铁律：合成期间冻结渲染
    if (this.rafScheduled) return;
    this.rafScheduled = true;
    this.rafId = requestAnimationFrame(() => {
      this.rafScheduled = false;
      this.rafId = null;
      const dirty = this.pendingDirty;
      this.pendingDirty = new Set();
      if (dirty.size === 0) return;
      const logical = this.pendingSelection ?? this.mapper.capture();
      this.pendingSelection = null;
      this.renderer.renderBlocks(dirty);
      if (logical) {
        this.mapper.restore(logical);
        this.setActiveBlock(logical.focus.blockId);
      }
    });
  }

  private setActiveBlock(blockId: string | null): void {
    const root = this.root;
    const el = blockId
      ? root.querySelector<HTMLElement>(`[data-block-id="${blockId}"]`)
      : null;
    const prev = root.querySelector<HTMLElement>('.block-active');
    if (prev && prev !== el) prev.classList.remove('block-active');
    // 编辑会使块 DOM 重建（renderOne replaceWith）：class 需始终补加，
    // 否则 .md-token 显隐失据（标记不显示 / 残留显示 ****）
    if (el) el.classList.add('block-active');
    // 虚拟化：光标所在块 sticky（拖动滚动条时不被换出）；setPinnedBlock 幂等
    this.renderer.setPinnedBlock(blockId);
  }

  private siblingLeaf(blockId: string, delta: number): string | null {
    const leaves = textLeafIds(this.model);
    const idx = leaves.indexOf(blockId);
    if (idx < 0) return null;
    return leaves[idx + delta] ?? null;
  }
}

export { DocumentModel } from './model/document';
export type { Doc, Block, ListItem, Transaction, LogicalSelection } from './model/types';
