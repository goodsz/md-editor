interface WritableLike {
  write(data: string): Promise<void>;
  close(): Promise<void>;
}

interface FileHandleLike {
  getFile(): Promise<File>;
  createWritable(): Promise<WritableLike>;
}

interface PickerWindow {
  showOpenFilePicker?(options?: unknown): Promise<FileHandleLike[]>;
  showSaveFilePicker?(options?: unknown): Promise<FileHandleLike>;
}

/** Electron 桥（preload.cjs 暴露的 window.desktop） */
export interface DesktopBridge {
  isDesktop: boolean;
  openFile(): Promise<{ name: string; content: string } | null>;
  saveFile(payload: { name: string; content: string }): Promise<{ name: string } | null>;
  saveFileAs(payload: { name: string; content: string }): Promise<{ name: string } | null>;
  /** 启动时经命令行/「打开方式」传入的文档（无则 null） */
  getLaunchFile(): Promise<{ name: string; content: string } | null>;
  /** 订阅运行中经「打开方式」推送的文档 */
  onOpenFile(cb: (payload: { name: string; content: string }) => void): void;
  /** 开始 PDF 导出：弹保存对话框并创建临时 HTML 写入流；取消返回 null */
  pdfExportBegin(payload: { name: string }): Promise<{ id: string } | null>;
  /** 追加一段打印 HTML 到临时文件（流式写入，避免一次性大字符串） */
  pdfExportChunk(id: string, chunk: string): Promise<void>;
  /** 结束写入并生成 PDF；失败返回 null */
  pdfExportEnd(id: string): Promise<{ path: string } | null>;
  /** 中止导出并清理临时文件 */
  pdfExportAbort(id: string): Promise<void>;
  setTheme(theme: 'light' | 'dark'): void;
  onMenu(cb: (action: 'new' | 'open' | 'save' | 'print') => void): void;
  /** 脏状态同步到主进程（关闭时决定是否弹保存确认） */
  setDirty(dirty: boolean): void;
  /** 主进程请求保存（关闭确认弹窗选"保存"后触发） */
  onRequestSave(cb: () => void): void;
  /** 保存流程结束回报（true=已保存可继续关闭，false=已取消） */
  saveResult(ok: boolean): void;
}

declare global {
  interface Window {
    desktop?: DesktopBridge;
  }
}

const OPEN_OPTIONS = {
  types: [
    {
      description: 'Markdown 文档',
      accept: {
        'text/markdown': ['.md', '.markdown'],
        'text/plain': ['.txt'],
      },
    },
  ],
};

const SAVE_OPTIONS = (suggestedName: string) => ({
  suggestedName,
  types: [
    {
      description: 'Markdown 文档',
      accept: { 'text/markdown': ['.md'] },
    },
  ],
});

/**
 * 本地文件 IO：桌面端走 Electron 原生对话框（window.desktop），
 * 浏览器端优先 File System Access API（可回写原文件），
 * 再回退 <input type=file> + 下载。
 */
export class FileIO {
  fileName = '未命名.md';
  private fileHandle: FileHandleLike | null = null;

  /** 打开/拖拽完成后的回调（由应用层注入 loadDoc） */
  onLoaded: ((name: string, text: string) => void) | null = null;

  /** 保存成功后的回调（由应用层注入：清除 dirty 标记） */
  onSaved: (() => void) | null = null;

  constructor(
    private getContent: () => string,
    private fallbackInput: HTMLInputElement,
    private desktop: DesktopBridge | null = window.desktop ?? null,
  ) {
    this.fallbackInput.addEventListener('change', () => {
      const file = this.fallbackInput.files?.[0];
      if (file) void this.readFile(file);
      this.fallbackInput.value = '';
    });
  }

  get isDesktop(): boolean {
    return this.desktop !== null;
  }

  /** 桌面桥（主进程菜单订阅用）；浏览器为 null */
  getBridge(): DesktopBridge | null {
    return this.desktop;
  }

  /** 桌面端：启动时经命令行/「打开方式」传入的文档（无则 null） */
  getLaunchFile(): Promise<{ name: string; content: string } | null> {
    return this.desktop ? this.desktop.getLaunchFile() : Promise.resolve(null);
  }

  /** 桌面端：订阅运行中经「打开方式」推送的文档 */
  onOpenFile(cb: (payload: { name: string; content: string }) => void): void {
    this.desktop?.onOpenFile(cb);
  }

  /** 打开对话框 */
  async open(): Promise<void> {
    if (this.desktop) {
      const r = await this.desktop.openFile();
      if (r) {
        this.fileName = r.name;
        this.fileHandle = null;
        this.onLoaded?.(r.name, r.content);
      }
      return;
    }
    const w = window as unknown as PickerWindow;
    if (w.showOpenFilePicker) {
      try {
        const [handle] = await w.showOpenFilePicker(OPEN_OPTIONS);
        this.fileHandle = handle;
        const file = await handle.getFile();
        this.onLoaded?.(file.name, await file.text());
        return;
      } catch (e) {
        if ((e as { name?: string }).name === 'AbortError') return;
        // 其他异常走 fallback
      }
    }
    this.fallbackInput.click();
  }

  /** 拖拽接入 */
  adoptFromFile(file: File): void {
    void this.readFile(file);
  }

  /** 保存（Ctrl+S）：桌面回写原文件（无路径则弹保存框），浏览器走句柄/下载 */
  async save(): Promise<boolean> {
    const content = this.getContent();
    if (this.desktop) {
      const r = await this.desktop.saveFile({ name: this.fileName, content });
      if (r) {
        this.fileName = r.name;
        document.title = this.fileName + ' - md-editor';
        this.onSaved?.();
        return true;
      }
      return false;
    }
    if (this.fileHandle) {
      try {
        const writable = await this.fileHandle.createWritable();
        await writable.write(content);
        await writable.close();
        this.onSaved?.();
        return true;
      } catch {
        // 回写失败 → 下载兜底
      }
    }
    this.download(this.fileName, content);
    this.onSaved?.();
    return true;
  }

  /** 另存为 */
  async saveAs(): Promise<boolean> {
    const content = this.getContent();
    if (this.desktop) {
      const r = await this.desktop.saveFileAs({ name: this.fileName, content });
      if (r) {
        this.fileName = r.name;
        document.title = this.fileName + ' - md-editor';
        this.onSaved?.();
        return true;
      }
      return false;
    }
    const w = window as unknown as PickerWindow;
    if (w.showSaveFilePicker) {
      try {
        const handle = await w.showSaveFilePicker(SAVE_OPTIONS(this.fileName));
        this.fileHandle = handle;
        const file = await handle.getFile();
        this.fileName = file.name;
        const writable = await handle.createWritable();
        await writable.write(content);
        await writable.close();
        document.title = this.fileName + ' - md-editor';
        this.onSaved?.();
        return true;
      } catch (e) {
        if ((e as { name?: string }).name === 'AbortError') return false;
      }
    }
    this.download(this.fileName, content);
    this.onSaved?.();
    return true;
  }

  /** 浏览器下载兜底（也用于导出 HTML） */
  download(name: string, content: string): void {
    const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.click();
    URL.revokeObjectURL(url);
  }

  /** 桌面端：开始 PDF 导出（保存对话框 + 临时 HTML 写入流），返回流 id；取消返回 null */
  pdfBegin(name: string): Promise<string | null> {
    if (!this.desktop) return Promise.resolve(null);
    return this.desktop.pdfExportBegin({ name }).then((r) => (r ? r.id : null));
  }

  /** 桌面端：把一段打印 HTML 流式写入临时文件 */
  pdfChunk(id: string, chunk: string): Promise<void> {
    if (!this.desktop) return Promise.resolve();
    return this.desktop.pdfExportChunk(id, chunk);
  }

  /** 桌面端：结束写入并生成 PDF（隐藏窗口 printToPDF）；失败返回 false */
  pdfEnd(id: string): Promise<boolean> {
    if (!this.desktop) return Promise.resolve(false);
    return this.desktop.pdfExportEnd(id).then((r) => r !== null);
  }

  /** 桌面端：中止导出并清理临时文件 */
  pdfAbort(id: string): Promise<void> {
    if (!this.desktop) return Promise.resolve();
    return this.desktop.pdfExportAbort(id);
  }

  /** 浏览器端打印：隐藏 iframe 加载自包含打印 HTML 后调起打印（不依赖编辑器 DOM） */
  printBrowser(html: string): void {
    const iframe = document.createElement('iframe');
    iframe.setAttribute('aria-hidden', 'true');
    iframe.style.cssText =
      'position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden';
    const cleanup = (): void => {
      window.setTimeout(() => iframe.remove(), 500);
    };
    iframe.addEventListener('load', () => {
      const w = iframe.contentWindow;
      if (!w) {
        cleanup();
        return;
      }
      w.addEventListener('afterprint', cleanup, { once: true });
      w.focus();
      w.print();
    });
    iframe.srcdoc = html;
    document.body.appendChild(iframe);
  }

  /** 仅更新内部状态（loadDoc 用），不触发读取 */
  adopt(name: string): void {
    this.fileName = name;
    this.fileHandle = null;
    document.title = name + ' - md-editor';
  }

  /** 仅重命名（桌面保存后同步标题用） */
  rename(name: string): void {
    this.fileName = name;
    document.title = name + ' - md-editor';
  }

  private async readFile(file: File): Promise<void> {
    this.fileName = file.name;
    this.fileHandle = null;
    const text = await file.text();
    this.onLoaded?.(file.name, text);
  }
}
