const { app, BrowserWindow, ipcMain, dialog, Menu, nativeTheme, shell } = require('electron');
const fs = require('fs/promises');
const { createWriteStream, existsSync, readFileSync } = require('fs');
const path = require('path');

const DEV_URL = 'http://localhost:5173/';
const SMOKE = process.argv.includes('--smoke');
const MD_FILTERS = [{ name: 'Markdown 文档', extensions: ['md', 'markdown', 'txt'] }];

let win = null;
let lastSavedPath = null;
let dirty = false; // 渲染层经 desktop:setDirty 同步（关闭确认依据）
let forceClose = false; // 已确认关闭（不保存/已保存）后放行
let waitingSaveResult = false; // 已请求渲染层保存，等待回报
let currentName = '未命名.md';
let pendingLaunch = null; // 启动时经命令行传入的文档（渲染层加载后经 IPC 取用）

/** 从命令行参数提取待打开的文档路径（Windows「打开方式」/ 拖到图标上） */
function extractOpenPath(argv) {
  for (const a of argv.slice(1)) {
    if (typeof a === 'string' && /\.(md|markdown|txt)$/i.test(a) && existsSync(a)) return a;
  }
  return null;
}

function setTitle(name) {
  currentName = name || '未命名.md';
  if (win) win.setTitle(name + ' - md-editor');
}

/** 关闭拦截：有未保存更改时弹原生确认框（保存 / 不保存 / 取消） */
function requestClose(e) {
  if (forceClose || !dirty) return;
  e.preventDefault();
  if (waitingSaveResult) return; // 保存流程进行中，等回报
  const r = dialog.showMessageBoxSync(win, {
    type: 'warning',
    title: '保存更改',
    message: '是否保存对 ' + currentName + ' 的更改？',
    detail: '未保存的更改在关闭后将丢失。',
    buttons: ['保存', '不保存', '取消'],
    defaultId: 0,
    cancelId: 2,
    noLink: true,
  });
  if (r === 1) {
    forceClose = true;
    win.close();
    return;
  }
  if (r === 2) return;
  // 保存：通知渲染层执行保存，完成后经 app:save-result 回报
  waitingSaveResult = true;
  win.webContents.send('app:request-save');
}

/** 外链白名单：仅 http/https/mailto 允许唤起系统浏览器 */
function openInSystemBrowser(url) {
  try {
    const u = new URL(url);
    if (u.protocol === 'http:' || u.protocol === 'https:' || u.protocol === 'mailto:') {
      void shell.openExternal(url).catch(() => {});
    }
  } catch {
    // 非法 URL 忽略
  }
}

function createWindow() {
  win = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 720,
    minHeight: 480,
    title: '未命名.md - md-editor',
    backgroundColor: '#ffffff',
    icon: path.join(__dirname, 'icon.png'),
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.once('ready-to-show', () => win.show());
  // 链接直接唤起本地浏览器：window.open / 新窗口请求一律路由到系统默认浏览器
  win.webContents.setWindowOpenHandler(({ url }) => {
    openInSystemBrowser(url);
    return { action: 'deny' };
  });
  // 防止主窗口被导航到外链
  win.webContents.on('will-navigate', (e, url) => {
    if (/^https?:/i.test(url) && !url.startsWith(DEV_URL)) {
      e.preventDefault();
      openInSystemBrowser(url);
    }
  });
  win.on('close', requestClose);
  win.on('closed', () => {
    win = null;
  });
  void loadContent();
}

/** 开发期优先加载 Vite 服务（就绪探测），失败回退 dist 产物 */
async function loadContent() {
  if (!win) return;
  const useDev = !app.isPackaged;
  if (useDev) {
    for (let i = 0; i < 48; i++) {
      try {
        await win.loadURL(DEV_URL);
        if (SMOKE) console.log('[smoke] renderer loaded');
        return;
      } catch {
        await new Promise((r) => setTimeout(r, 250));
      }
    }
  }
  try {
    await win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
    if (SMOKE) console.log('[smoke] renderer loaded (file)');
  } catch (e) {
    console.error('[smoke] load failed:', e && e.message);
    if (SMOKE) app.exit(1);
  }
}

async function saveAs(name, content) {
  const r = await dialog.showSaveDialog(win, {
    defaultPath: name || '未命名.md',
    filters: MD_FILTERS,
  });
  if (r.canceled || !r.filePath) return null;
  await fs.writeFile(r.filePath, content, 'utf-8');
  lastSavedPath = r.filePath;
  const base = path.basename(r.filePath);
  setTitle(base);
  return { name: base };
}

function registerIpc() {
  ipcMain.handle('desktop:open', async () => {
    const r = await dialog.showOpenDialog(win, {
      properties: ['openFile'],
      filters: MD_FILTERS,
    });
    if (r.canceled || !r.filePaths[0]) return null;
    const p = r.filePaths[0];
    const content = await fs.readFile(p, 'utf-8');
    lastSavedPath = p;
    const name = path.basename(p);
    setTitle(name);
    return { name, content };
  });

  ipcMain.handle('desktop:save', async (_e, payload) => {
    if (!lastSavedPath) return saveAs(payload.name, payload.content);
    await fs.writeFile(lastSavedPath, payload.content, 'utf-8');
    setTitle(path.basename(lastSavedPath));
    return { name: path.basename(lastSavedPath) };
  });

  ipcMain.handle('desktop:saveAs', (_e, payload) => saveAs(payload.name, payload.content));

  // 「打开方式」/ 命令行传入的文档：渲染层启动后取用
  ipcMain.handle('desktop:get-launch-file', () => pendingLaunch);

  // PDF 导出（方案 A 流式写入）：渲染层把自包含打印 HTML 分块送入临时文件，
  // 全部写入后由隐藏窗口 printToPDF（独立渲染进程，主窗口不冻结）。
  // 进行中的流：id → { ws, tmp, filePath }
  const pdfStreams = new Map();

  ipcMain.handle('desktop:export-pdf-begin', async (_e, payload) => {
    if (!win) return null;
    const base = (payload?.name || '未命名').replace(/\.(md|markdown|txt)$/i, '');
    const r = await dialog.showSaveDialog(win, {
      defaultPath: base + '.pdf',
      filters: [{ name: 'PDF', extensions: ['pdf'] }],
    });
    if (r.canceled || !r.filePath) return null;
    const id = 'pdf-' + Date.now() + '-' + Math.floor(Math.random() * 1e6);
    const tmp = path.join(app.getPath('temp'), 'md-editor-print-' + id + '.html');
    const ws = createWriteStream(tmp, { encoding: 'utf-8' });
    try {
      await new Promise((resolve, reject) => {
        ws.once('open', resolve);
        ws.once('error', reject);
      });
    } catch {
      return null;
    }
    pdfStreams.set(id, { ws, tmp, filePath: r.filePath });
    return { id };
  });

  // 分块写入：等待 write 回调（背压），保证顺序与内存占用受控
  ipcMain.handle('desktop:export-pdf-chunk', (_e, payload) => {
    const s = pdfStreams.get(payload?.id);
    if (!s) return false;
    return new Promise((resolve) => s.ws.write(payload.chunk, () => resolve(true)));
  });

  ipcMain.handle('desktop:export-pdf-end', async (_e, payload) => {
    const s = pdfStreams.get(payload?.id);
    if (!s) return null;
    pdfStreams.delete(payload.id);
    const printWin = new BrowserWindow({
      show: false,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    try {
      await new Promise((resolve) => s.ws.end(resolve)); // 关闭并冲刷写入流
      await printWin.loadFile(s.tmp);
      // 等待图片等子资源加载（8s 上限，坏图不阻塞导出）
      await printWin.webContents
        .executeJavaScript(
          'new Promise(res => { const t = setTimeout(res, 8000); const done = () => { clearTimeout(t); res(1); }; ' +
            'const imgs = [...document.images]; ' +
            'Promise.all(imgs.map(i => i.complete ? 0 : new Promise(rr => { i.onload = i.onerror = () => rr(); }))).then(done); })',
        )
        .catch(() => {});
      const buf = await printWin.webContents.printToPDF({
        printBackground: true,
        pageSize: 'A4',
        margins: { top: 0.6, bottom: 0.6, left: 0.55, right: 0.55 },
      });
      await fs.writeFile(s.filePath, buf);
      shell.showItemInFolder(s.filePath); // 打开文件夹并选中 PDF
      return { path: s.filePath };
    } catch (e) {
      console.error('[md-editor] PDF 生成失败', e && e.message);
      return null;
    } finally {
      printWin.destroy();
      await fs.rm(s.tmp, { force: true }).catch(() => {});
    }
  });

  ipcMain.handle('desktop:export-pdf-abort', async (_e, payload) => {
    const s = pdfStreams.get(payload?.id);
    if (!s) return null;
    pdfStreams.delete(payload.id);
    s.ws.destroy();
    await fs.rm(s.tmp, { force: true }).catch(() => {});
    return { ok: true };
  });

  // 主题同步：原生标题栏/窗口背景跟随渲染层主题
  ipcMain.handle('desktop:setTheme', (_e, theme) => {
    nativeTheme.themeSource = theme === 'dark' ? 'dark' : 'light';
    if (win) win.setBackgroundColor(theme === 'dark' ? '#282c34' : '#ffffff');
  });

  // 脏状态同步（渲染层编辑置脏 / 保存打开后清除）
  ipcMain.on('desktop:setDirty', (_e, v) => {
    dirty = !!v;
  });

  // 渲染层保存流程回报：true=已保存，放行关闭；false=已取消，留在编辑器
  ipcMain.on('app:save-result', (_e, ok) => {
    if (!waitingSaveResult) return;
    waitingSaveResult = false;
    if (ok) {
      forceClose = true;
      win?.close();
    }
  });
}

function buildMenu() {
  // 网页内已有完整菜单栏（文件/编辑/段落/格式/视图/主题），
  // 原生菜单置空避免双菜单栏；Ctrl+N/O/S/P 由渲染层统一处理
  Menu.setApplicationMenu(null);
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  // 再次启动（如对另一文档选「打开方式」）：聚焦窗口并推送待打开文档
  app.on('second-instance', (_e, argv) => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.focus();
    const p = extractOpenPath(argv);
    if (!p) return;
    try {
      win.webContents.send('desktop:open-file', {
        name: path.basename(p),
        content: readFileSync(p, 'utf-8'),
      });
    } catch {
      // 读取失败忽略
    }
  });

  app.whenReady().then(() => {
    const launchPath = extractOpenPath(process.argv);
    if (launchPath) {
      try {
        pendingLaunch = { name: path.basename(launchPath), content: readFileSync(launchPath, 'utf-8') };
      } catch {
        pendingLaunch = null;
      }
    }
    registerIpc();
    buildMenu();
    createWindow();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}

// 冒烟模式：渲染层加载完成后自动退出（CI / 脚本验证用）
if (SMOKE) {
  win = null;
  app.whenReady().then(() => {
    setTimeout(() => {
      console.log('[smoke] ok');
      app.exit(0);
    }, 4000);
  });
}
