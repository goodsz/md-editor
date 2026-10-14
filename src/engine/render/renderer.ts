import type { DocumentModel } from '../model/document';
import type { AnyNode, BlockId, ListBlock, QuoteBlock } from '../model/types';
import { isListItem } from '../model/types';
import { HeightIndex, getKernel, loadKernel } from '../wasm/kernel';
import type { BlockBuilder } from './builder';
import { appendInline } from './inline';
import { renderCode } from './blocks/code';
import { renderHeading } from './blocks/heading';
import { renderHr } from './blocks/hr';
import { renderHtml } from './blocks/html';
import { renderList, renderListItem } from './blocks/list';
import { renderMath } from './blocks/math';
import { renderParagraph } from './blocks/paragraph';
import { renderQuote } from './blocks/quote';
import { renderTable } from './blocks/table';

/**
 * BlockRenderer：块树 → DOM 的增量渲染器。
 * 每个块节点挂 data-block-id，作为增量更新与光标恢复的锚点。
 *
 * 长文档虚拟化（顶层块数 > 阈值时启用）：
 * - 视口外的块渲染为等高占位符（.md-spacer），DOM 常驻规模恒定（约等于窗口 + 缓冲）
 * - 高度缓存：真实块测量值优先，未渲染块用粗略估算，卸载时以实测回填
 * - 滚动 / 窗口 resize / 增量渲染均经 refreshWindow 换入换出
 */
export class BlockRenderer {
  private rootEl: HTMLElement | null = null;
  private scrollEl: HTMLElement | null = null;
  private virtual = false;
  private heights = new Map<BlockId, number>();
  /** 当前以真实 DOM 挂载的块（= 虚拟窗口） */
  private realMounted = new Set<BlockId>();
  private winScheduled = false;

  /** 高度前缀索引（WASM 内核优先，TS 同算法回退） */
  private index = new HeightIndex(null);
  /** 顶层块 id → 下标（高度增量更新定位用） */
  private vIndex = new Map<BlockId, number>();
  private structureDirty = false;
  private kernelReady = false;
  private pinnedId: BlockId | null = null;
  /** 打印/导出模式：禁用虚拟化，全量真实渲染（printToPDF 截取当前 DOM，
   *  spacer 占位会导致视口外内容导出为空白页） */
  private printMode = false;

  private static readonly VIRTUAL_THRESHOLD = 300;
  private static readonly BUFFER = 8;
  private static readonly SPACER_CLASS = 'md-spacer';

  constructor(private model: DocumentModel) {}

  /** 绑定滚动容器（虚拟化窗口计算依据）；传入 null 解绑 */
  setViewport(el: HTMLElement | null): void {
    this.scrollEl?.removeEventListener('scroll', this.onViewportScroll);
    window.removeEventListener('resize', this.onViewportScroll);
    this.scrollEl = el;
    if (el) {
      el.addEventListener('scroll', this.onViewportScroll, { passive: true });
      window.addEventListener('resize', this.onViewportScroll);
    }
    // WASM 内核懒加载：成功后重建索引切换到 Rust 实现
    void this.ensureKernel();
  }

  /** 光标所在块 sticky：拖动滚动条时不被换出（滚动位置与光标保持一致） */
  setPinnedBlock(id: BlockId | null): void {
    if (this.pinnedId === id) return; // 幂等
    this.pinnedId = id;
    if (this.virtual && id) this.refreshWindow();
  }

  private async ensureKernel(): Promise<void> {
    if (this.kernelReady) return;
    const ok = await loadKernel();
    if (ok && !this.kernelReady) {
      this.kernelReady = true;
      this.index = new HeightIndex(getKernel());
      if (this.virtual) this.rebuildIndex();
    }
  }

  /** 外部请求刷新虚拟窗口（滚动容器就绪 / 结构变化后调用） */
  refreshVirtual(): void {
    this.refreshWindow();
  }

  private onViewportScroll = (): void => {
    if (!this.virtual || this.winScheduled) return;
    this.winScheduled = true;
    requestAnimationFrame(() => {
      this.winScheduled = false;
      this.refreshWindow();
    });
  };

  /** 全量首渲染：小文档直接构建；打印模式全量；大文档全量 spacer + 视口窗口 */
  mount(root: HTMLElement): void {
    this.rootEl = root;
    root.textContent = '';
    this.heights.clear();
    this.realMounted.clear();
    this.virtual = !this.printMode && this.model.getRoot().length > BlockRenderer.VIRTUAL_THRESHOLD;
    const blocks = this.model.getRoot();
    const frag = document.createDocumentFragment();
    if (!this.virtual) {
      for (const block of blocks) frag.appendChild(this.build(block));
    } else {
      for (const block of blocks) frag.appendChild(this.buildSpacer(block));
    }
    root.appendChild(frag);
    if (this.virtual) {
      this.rebuildIndex();
      this.refreshWindow();
    }
  }

  /** 导出/打印准备：全量真实渲染（替代 spacer），并等待 mermaid/图片/字体等
   *  异步内容就绪。完成后必须调用 finishPrint 恢复虚拟化。
   *  大文档分块渲染并回报进度，避免长时间冻结 UI */
  async preparePrint(onProgress?: (fraction: number) => void): Promise<void> {
    if (!this.rootEl) return;
    this.printMode = true;
    const blocks = this.model.getRoot();
    if (this.virtual) {
      // 分块全量重建：让出主线程刷新进度条，页面不至长时间无响应
      this.rootEl.textContent = '';
      this.heights.clear();
      this.realMounted.clear();
      this.virtual = false;
      const CHUNK = 200;
      for (let i = 0; i < blocks.length; i += CHUNK) {
        const frag = document.createDocumentFragment();
        for (let j = i; j < Math.min(i + CHUNK, blocks.length); j++) {
          frag.appendChild(this.build(blocks[j]));
        }
        this.rootEl.appendChild(frag);
        onProgress?.(Math.min(1, (i + CHUNK) / blocks.length));
        await new Promise<void>((r) => setTimeout(r, 0));
      }
    }
    await this.waitForAssets();
  }

  /** 打印结束：恢复虚拟化与滚动位置（幂等：未进入打印模式时为空操作） */
  finishPrint(): void {
    if (!this.printMode || !this.rootEl) return;
    this.printMode = false;
    const scroll = this.scrollEl?.scrollTop ?? 0;
    this.mount(this.rootEl);
    if (this.scrollEl) this.scrollEl.scrollTop = scroll;
    this.refreshVirtual();
  }

  /** 等待异步渲染内容就绪（mermaid 占位消失 / 图片加载 / 字体）。
   *  各项均有超时上限：坏图/挂起的外链资源不允许卡死导出流程 */
  private async waitForAssets(): Promise<void> {
    if (!this.rootEl) return;
    const root = this.rootEl;
    const withTimeout = (p: Promise<void>, ms: number): Promise<void> =>
      Promise.race([
        p,
        new Promise<void>((r) => setTimeout(r, ms)),
      ]);

    // mermaid 渲染占位消失（整体 8s 上限）
    const mermaidDone = (async (): Promise<void> => {
      for (;;) {
        const pending = Array.from(root.querySelectorAll('.md-mermaid-render')).some((el) =>
          (el.textContent ?? '').includes('图表渲染中'),
        );
        if (!pending) return;
        await new Promise<void>((r) => setTimeout(r, 120));
      }
    })();
    await withTimeout(mermaidDone, 8000);

    // 图片：单张 8s 上限（挂起的外链图不再阻塞导出）
    await Promise.all(
      Array.from(root.querySelectorAll('img')).map((img) => {
        if (img.complete) return Promise.resolve();
        return withTimeout(
          new Promise<void>((res) => {
            img.addEventListener('load', () => res(), { once: true });
            img.addEventListener('error', () => res(), { once: true });
          }),
          8000,
        );
      }),
    );

    try {
      const fonts = (document as Document & { fonts?: { ready: Promise<unknown> } }).fonts;
      if (fonts) await withTimeout(Promise.resolve(fonts.ready.then(() => undefined)), 3000);
    } catch {
      // 忽略
    }
    await new Promise<void>((r) => requestAnimationFrame(() => r()));
  }

  /** 重建高度前缀索引与顶层下标表（结构变更 / 首次虚拟挂载） */
  private rebuildIndex(): void {
    const blocks = this.model.getRoot();
    const arr: number[] = new Array(blocks.length);
    this.vIndex.clear();
    for (let i = 0; i < blocks.length; i++) {
      arr[i] = this.heightFor(blocks[i]);
      this.vIndex.set(blocks[i].id, i);
    }
    this.index.rebuild(arr);
    this.structureDirty = false;
  }

  /** 增量渲染：只处理 dirty 块；祖先也在 dirty 中时跳过（随父块整体重建） */
  renderBlocks(dirtyIds: ReadonlySet<BlockId>): void {
    if (!this.rootEl) return;
    for (const id of dirtyIds) {
      const el = this.findEl(id);
      if (el) {
        const ancestor = el.parentElement?.closest('[data-block-id]');
        if (ancestor && dirtyIds.has(ancestor.getAttribute('data-block-id') ?? '')) continue;
      }
      this.renderOne(id);
    }
    // 结构变更（插入/删除）：重建高度索引并刷新窗口
    if (this.virtual && this.structureDirty) {
      this.rebuildIndex();
      this.refreshWindow();
    }
  }

  private renderOne(id: BlockId): void {
    if (!this.rootEl) return;
    const node = this.model.getBlock(id);
    const existing = this.findEl(id);
    if (!node) {
      existing?.remove();
      this.realMounted.delete(id);
      this.heights.delete(id);
      if (this.virtual) this.structureDirty = true;
      return;
    }
    // 虚拟窗口外：维持 spacer 形态并刷新估算高度
    if (this.virtual && !this.realMounted.has(id)) {
      const spacer = this.buildSpacer(node);
      if (existing) existing.replaceWith(spacer);
      else this.insertAtTreePosition(id, spacer);
      this.heights.delete(id);
      this.structureDirty = true;
      return;
    }
    const oldH = this.heights.get(id) ?? estimateHeight(node);
    const fresh = this.build(node);
    if (existing) existing.replaceWith(fresh);
    else this.insertAtTreePosition(id, fresh);
    this.realMounted.add(id);
    const newH = fresh.offsetHeight || estimateHeight(node);
    this.heights.set(id, newH);
    // 高度增量同步到前缀索引
    const vi = this.vIndex.get(id);
    if (this.virtual) {
      if (vi !== undefined) this.index.update(vi, newH - oldH);
      else this.structureDirty = true;
    }
  }

  /** 滚动到指定顶层块（虚拟化下 spacer 锚点始终存在）：
   *  用前缀高度和直接定位 scrollTop，随后 refreshWindow 渲染窗口 */
  scrollToBlock(blockId: BlockId): void {
    const blocks = this.model.getRoot();
    const idx = blocks.findIndex((b) => b.id === blockId);
    if (idx >= 0 && this.scrollEl) {
      let y = 0;
      for (let i = 0; i < idx; i++) y += this.heightFor(blocks[i]);
      this.scrollEl.scrollTop = Math.max(0, y - this.scrollEl.clientHeight / 3);
    } else {
      this.findEl(blockId)?.scrollIntoView({ block: 'center' });
    }
    if (this.virtual) this.refreshWindow();
  }

  /** 重新计算视口窗口：换入视口内块、换出视口外块。
   *  窗口边界经 Fenwick 前缀索引二分定位（WASM 内核 / TS 回退），O(log n) */
  refreshWindow(): void {
    if (!this.virtual || !this.rootEl || !this.scrollEl) return;
    const blocks = this.model.getRoot();
    if (this.structureDirty || this.vIndex.size !== blocks.length) this.rebuildIndex();
    const viewTop = this.scrollEl.scrollTop;
    const viewBottom = viewTop + this.scrollEl.clientHeight;
    const start = this.index.locate(viewTop);
    const end = Math.min(blocks.length, this.index.locate(viewBottom));
    const wa = Math.max(0, start - BlockRenderer.BUFFER);
    const wb = Math.min(blocks.length - 1, Math.max(end - 1, start) + BlockRenderer.BUFFER);

    // 换入：窗口内尚未真实挂载的块
    for (let i = wa; i <= wb; i++) {
      const b = blocks[i];
      if (this.realMounted.has(b.id)) continue;
      const existing = this.findEl(b.id);
      const oldH = this.heightFor(b); // 估算值（换入前）
      const fresh = this.build(b);
      if (existing) existing.replaceWith(fresh);
      else this.insertAtTreePosition(b.id, fresh);
      this.realMounted.add(b.id);
      const newH = fresh.offsetHeight || oldH; // 实测回填（jsdom/不可见时保持估算）
      this.heights.set(b.id, newH);
      const vi = this.vIndex.get(b.id);
      if (vi !== undefined) this.index.update(vi, newH - oldH);
    }
    // 换出：窗口外的真实块 → spacer（以实测高度，保持总高稳定）。
    // 光标所在块（pinned）不换出：保持在原树位置真实渲染，
    // 保证滚走后光标/输入仍有效，且 DOM 增量恒为 1 块（不会把窗口拉成全量）。
    for (const id of [...this.realMounted]) {
      if (id === this.pinnedId) continue;
      const i = this.vIndex.get(id);
      if (i === undefined || i < wa || i > wb) {
        const el = this.findEl(id);
        const b = this.model.getBlock(id);
        if (el && b) el.replaceWith(this.buildSpacer(b));
        this.realMounted.delete(id);
      }
    }
  }

  private heightFor(b: AnyNode): number {
    return this.heights.get(b.id) ?? estimateHeight(b);
  }

  private buildSpacer(b: AnyNode): HTMLElement {
    const div = document.createElement('div');
    div.className = BlockRenderer.SPACER_CLASS;
    div.dataset.blockId = b.id;
    div.style.height = this.heightFor(b) + 'px';
    div.setAttribute('aria-hidden', 'true');
    return div;
  }

  private findEl(id: BlockId): HTMLElement | null {
    if (!this.rootEl) return null;
    return this.rootEl.querySelector<HTMLElement>(`[data-block-id="${id}"]`);
  }

  /** 按树位置插入新块 DOM（无旧 DOM 时使用） */
  private insertAtTreePosition(id: BlockId, el: HTMLElement): void {
    if (!this.rootEl) return;
    const entry = this.model.getEntry(id);
    if (!entry) return;
    const container = this.containerEl(entry);
    if (!container) return;
    const prevId = this.model.getSiblingId(id, -1);
    const prevEl = prevId ? this.findEl(prevId) : null;
    if (prevEl) prevEl.after(el);
    else container.prepend(el);
  }

  private containerEl(entry: { parentId: BlockId | null; parentKind: string }): HTMLElement | null {
    if (!this.rootEl) return null;
    if (entry.parentId === null) return this.rootEl;
    return this.findEl(entry.parentId) ?? this.rootEl;
  }

  /** 构建任意节点的 DOM */
  build: BlockBuilder = (node: AnyNode): HTMLElement => {
    if (isListItem(node)) return renderListItem(node, this.build);
    switch (node.type) {
      case 'paragraph':
        return renderParagraph(node);
      case 'heading':
        return renderHeading(node);
      case 'code':
        return renderCode(node);
      case 'math':
        return renderMath(node);
      case 'hr':
        return renderHr(node);
      case 'quote':
        return renderQuote(node as QuoteBlock, this.build);
      case 'list':
        return renderList(node as ListBlock, this.build);
      case 'table':
        return renderTable(node);
      case 'html':
        return renderHtml(node);
    }
  };
}

/** 粗略高度估算（从未渲染块的类型与文本量推算；渲染后以实测回填） */
function estimateHeight(b: AnyNode): number {
  const lines = (s: string): number => {
    if (!s) return 1;
    let n = 0;
    for (const seg of s.split('\n')) n += Math.max(1, Math.ceil(seg.length / 70));
    return n;
  };
  if (isListItem(b)) {
    let h = lines(b.text) * 28 + 6;
    if (b.children) for (const c of b.children) h += estimateHeight(c);
    return h;
  }
  switch (b.type) {
    case 'paragraph':
      return lines(b.text) * 28 + 10;
    case 'heading':
      return lines(b.text) * (24 + b.level * 4) + 18;
    case 'code':
      return lines(b.code) * 23 + 26;
    case 'math':
      return lines(b.tex) * 24 + 40;
    case 'hr':
      return 40;
    case 'quote':
      return b.children.reduce((s, c) => s + estimateHeight(c), 0) + 14;
    case 'list': {
      let h = 8;
      for (const it of b.items) {
        h += lines(it.text) * 28 + 6;
        if (it.children) for (const c of it.children) h += estimateHeight(c);
      }
      return h;
    }
    case 'table':
      return b.rows.length * 38 + 10;
    case 'html':
      return lines(b.raw) * 20 + 16;
  }
}

export { appendInline };
