export interface ShortcutHandlers {
  isSourceMode(): boolean;
  toggleSource(): void;
  newDoc(): void;
  save(): void;
  open(): void;
  print(): void;
  selectAll(): void;
  format(kind: 'bold' | 'italic' | 'link'): void;
  /** 段落转换：0=段落 1-6=标题级别 */
  paragraph(level: 0 | 1 | 2 | 3 | 4 | 5 | 6): void;
}

export interface ShortcutOptions {
  /** 原生菜单承载的键位（当前原生菜单已移除，预留扩展） */
  nativeMenuKeys?: boolean;
}

/**
 * 应用级快捷键（capture 阶段，先于浏览器默认行为）：
 * Ctrl+N 新建、Ctrl+S 保存、Ctrl+O 打开、Ctrl+P 打印导出、
 * Ctrl+/ 源码模式、Ctrl+B 加粗、Ctrl+I 斜体、Ctrl+K 链接、Ctrl+A 全选。
 * Ctrl+Z/Y 由引擎 InputController 处理；源码模式内保留 textarea 原生行为。
 */
export function initShortcuts(
  handlers: ShortcutHandlers,
  opts: ShortcutOptions = {},
): () => void {
  const skipNative = opts.nativeMenuKeys === true;
  const onKey = (e: KeyboardEvent): void => {
    if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
    const key = e.key.toLowerCase();

    if (key === '/') {
      e.preventDefault();
      handlers.toggleSource();
      return;
    }
    if (!skipNative) {
      if (key === 'n') {
        e.preventDefault();
        handlers.newDoc();
        return;
      }
      // 段落快捷键：Ctrl+0 段落 / Ctrl+1..6 标题
      if (key === '0' || (key >= '1' && key <= '6')) {
        e.preventDefault();
        handlers.paragraph(key === '0' ? 0 : (Number(key) as 1 | 2 | 3 | 4 | 5 | 6));
        return;
      }
      if (key === 's') {
        e.preventDefault();
        handlers.save();
        return;
      }
      if (key === 'o') {
        e.preventDefault();
        handlers.open();
        return;
      }
      if (key === 'p') {
        e.preventDefault();
        handlers.print();
        return;
      }
    }
    if (handlers.isSourceMode()) return;
    const target = e.target as HTMLElement | null;
    if (target && (target.tagName === 'TEXTAREA' || target.tagName === 'INPUT')) return;

    if (key === 'b') {
      e.preventDefault();
      handlers.format('bold');
      return;
    }
    if (key === 'i') {
      e.preventDefault();
      handlers.format('italic');
      return;
    }
    if (key === 'k') {
      e.preventDefault();
      handlers.format('link');
      return;
    }
    if (key === 'a') {
      e.preventDefault();
      handlers.selectAll();
    }
  };

  window.addEventListener('keydown', onKey, true);
  return () => window.removeEventListener('keydown', onKey, true);
}
