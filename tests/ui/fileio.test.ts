import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FileIO, type DesktopBridge } from '../../src/ui/fileIO';

function makeInput(): HTMLInputElement {
  const input = document.createElement('input');
  input.type = 'file';
  document.body.appendChild(input);
  return input;
}

describe('ui/FileIO 桌面桥接路由', () => {
  let input: HTMLInputElement;

  beforeEach(() => {
    document.body.innerHTML = '';
    input = makeInput();
    vi.stubGlobal('window', window); // 保持真实 window（无 desktop）
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete (window as unknown as { desktop?: DesktopBridge }).desktop;
  });

  function fakeBridge(): DesktopBridge & {
    calls: string[];
  } {
    const calls: string[] = [];
    return {
      calls,
      isDesktop: true,
      openFile: vi.fn(async () => {
        calls.push('open');
        return { name: '桌面文档.md', content: '# 桌面' };
      }),
      saveFile: vi.fn(async (p) => {
        calls.push(`save:${p.name}:${p.content}`);
        return { name: p.name };
      }),
      saveFileAs: vi.fn(async (p) => {
        calls.push(`saveAs:${p.name}`);
        return { name: '另存.md' };
      }),
      pdfExportBegin: vi.fn(async (p: { name: string }) => {
        calls.push(`begin:${p.name}`);
        return { id: 'id-1' };
      }),
      pdfExportChunk: vi.fn(async (id: string, chunk: string) => {
        calls.push(`chunk:${id}:${chunk.length}`);
      }),
      pdfExportEnd: vi.fn(async (id: string) => {
        calls.push(`end:${id}`);
        return { path: 'C:/x/未命名.pdf' };
      }),
      pdfExportAbort: vi.fn(async (id: string) => {
        calls.push(`abort:${id}`);
      }),
      onMenu: vi.fn(),
    } as never;
  }

  it('桌面端 open 走桥接并触发 onLoaded', async () => {
    const bridge = fakeBridge();
    const io = new FileIO(() => '', input, bridge);
    expect(io.isDesktop).toBe(true);
    let loaded: string | null = null;
    io.onLoaded = (name) => (loaded = name);
    await io.open();
    expect(bridge.calls).toEqual(['open']);
    expect(loaded).toBe('桌面文档.md');
    expect(io.fileName).toBe('桌面文档.md');
  });

  it('桌面端 save 走桥接（浏览器句柄/下载不触发）', async () => {
    const bridge = fakeBridge();
    const io = new FileIO(() => '内容', input, bridge);
    const dl = vi.spyOn(io, 'download');
    await io.save();
    expect(bridge.calls[0]).toBe('save:未命名.md:内容');
    expect(dl).not.toHaveBeenCalled();
  });

  it('桌面端 PDF 导出走流式桥接（begin/chunk/end）', async () => {
    const bridge = fakeBridge();
    const io = new FileIO(() => '', input, bridge);
    const id = await io.pdfBegin('未命名.md');
    expect(id).toBe('id-1');
    await io.pdfChunk('id-1', '<p>a</p>');
    await io.pdfChunk('id-1', '<p>b</p>');
    expect(await io.pdfEnd('id-1')).toBe(true);
    expect(bridge.calls).toEqual(['begin:未命名.md', 'chunk:id-1:8', 'chunk:id-1:8', 'end:id-1']);
  });

  it('桌面端 PDF 中止走 abort，浏览器端 printBrowser 以隐藏 iframe 承载打印', async () => {
    const bridge = fakeBridge();
    const io = new FileIO(() => '', input, bridge);
    await io.pdfAbort('id-2');
    expect(bridge.calls).toEqual(['abort:id-2']);

    const io2 = new FileIO(() => '', input, null);
    io2.printBrowser('<html>print</html>');
    const frame = document.querySelector('iframe');
    expect(frame).not.toBeNull();
    expect(frame!.getAttribute('srcdoc')).toBe('<html>print</html>');
  });

  it('浏览器端（无桥）open 回退到 input[type=file]', async () => {
    const io = new FileIO(() => '', input, null);
    const click = vi.spyOn(input, 'click');
    await io.open();
    expect(click).toHaveBeenCalled();
  });

  it('rename 同步文件名与标题', () => {
    const io = new FileIO(() => '', input, null);
    io.rename('新名字.md');
    expect(io.fileName).toBe('新名字.md');
    expect(document.title).toBe('新名字.md - md-editor');
  });
});
