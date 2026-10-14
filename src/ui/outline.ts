import type { BlockEngine } from '../engine';
import { parseInlineTokens, type MdToken } from '../syntax/markdown';
import type { Block } from '../engine/model/types';

export interface OutlineItem {
  level: number;
  text: string;
  blockId: string;
}

/** 标题源码 → 纯文本：剔除 **、`、[]() 等行内标记，保留文字/代码/图片描述 */
function headingPlainText(src: string): string {
  let out = '';
  const walk = (tokens: readonly MdToken[]): void => {
    for (const t of tokens) {
      if (
        t.type === 'text' ||
        t.type === 'code_inline' ||
        t.type === 'softbreak' ||
        t.type === 'hardbreak' ||
        t.type === 'html_inline' ||
        t.type === 'image'
      ) {
        out += t.content;
      }
      if (t.children) walk(t.children);
    }
  };
  walk(parseInlineTokens(src));
  return out.trim();
}

/** 按文档顺序收集标题（含引用块内标题） */
export function extractHeadings(blocks: readonly Block[]): OutlineItem[] {
  const out: OutlineItem[] = [];
  const walk = (list: readonly Block[]): void => {
    for (const b of list) {
      if (b.type === 'heading') {
        out.push({ level: b.level, text: headingPlainText(b.text) || '（空标题）', blockId: b.id });
      } else if (b.type === 'quote') {
        walk(b.children);
      }
    }
  };
  walk(blocks);
  return out;
}

/** 左侧大纲面板：标题树 + 点击跳转 + 可拖拽调宽 */
export class OutlinePanel {
  private listEl: HTMLElement;
  private static readonly WIDTH_KEY = 'md-editor:outline-w';
  private static readonly MIN_W = 160;
  private static readonly MAX_W = 440;
  private static readonly DEFAULT_W = 230;

  constructor(
    private container: HTMLElement,
    private engine: BlockEngine,
    resizer?: HTMLElement | null,
    /** 自定义跳转（源码模式定位到 textarea 对应标题行）；缺省用引擎 revealBlock */
    private jumper?: (blockId: string) => void,
  ) {
    container.classList.add('outline-panel');
    const title = document.createElement('div');
    title.className = 'outline-title';
    title.textContent = '大纲';
    this.listEl = document.createElement('div');
    this.listEl.className = 'outline-list';
    container.append(title, this.listEl);
    if (resizer) this.setupResize(resizer);
  }

  /** 分界线拖拽调宽：钳制范围、持久化、双击复位 */
  private setupResize(handle: HTMLElement): void {
    const cls = OutlinePanel;
    let startX = 0;
    let startW = cls.DEFAULT_W;

    const onMove = (e: MouseEvent): void => {
      const w = Math.min(cls.MAX_W, Math.max(cls.MIN_W, startW + e.clientX - startX));
      this.container.style.width = w + 'px';
    };
    const onUp = (): void => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.body.classList.remove('resizing-col');
      try {
        localStorage.setItem(cls.WIDTH_KEY, this.container.style.width);
      } catch {
        // 忽略
      }
    };
    handle.addEventListener('mousedown', (e) => {
      if (this.container.hidden) return;
      e.preventDefault();
      startX = e.clientX;
      startW =
        parseFloat(this.container.style.width) || this.container.offsetWidth || cls.DEFAULT_W;
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
      document.body.classList.add('resizing-col');
    });
    handle.addEventListener('dblclick', () => {
      this.container.style.width = '';
      try {
        localStorage.removeItem(cls.WIDTH_KEY);
      } catch {
        // 忽略
      }
    });

    // 恢复上次宽度
    try {
      const saved = localStorage.getItem(cls.WIDTH_KEY);
      if (saved) this.container.style.width = saved;
    } catch {
      // 忽略
    }
  }

  refresh(): void {
    this.listEl.textContent = '';
    const items = extractHeadings(this.engine.model.getRoot());
    if (items.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'outline-empty';
      empty.textContent = '暂无标题';
      this.listEl.appendChild(empty);
      return;
    }
    for (const item of items) {
      const row = document.createElement('div');
      row.className = `outline-item outline-h${item.level}`;
      row.textContent = item.text;
      row.title = item.text;
      row.addEventListener('click', () => {
        // 源码模式定位到 textarea 对应标题行；WYSIWYG 滚动渲染后落光标
        if (this.jumper) this.jumper(item.blockId);
        else this.engine.revealBlock(item.blockId);
      });
      this.listEl.appendChild(row);
    }
  }
}
