export interface MenuEntry {
  label: string;
  shortcut?: string;
  action?: string;
  sep?: boolean;
}

export const MENUS: { label: string; items: MenuEntry[] }[] = [
  {
    label: '文件',
    items: [
      { label: '新建', action: 'file.new' },
      { label: '打开…', shortcut: 'Ctrl+O', action: 'file.open' },
      { sep: true, label: '' },
      { label: '保存', shortcut: 'Ctrl+S', action: 'file.save' },
      { label: '另存为…', action: 'file.saveAs' },
      { sep: true, label: '' },
      { label: '导出 HTML', action: 'file.exportHtml' },
      { label: '导出 / 打印（PDF）', shortcut: 'Ctrl+P', action: 'file.print' },
    ],
  },
  {
    label: '编辑',
    items: [
      { label: '撤销', shortcut: 'Ctrl+Z', action: 'edit.undo' },
      { label: '重做', shortcut: 'Ctrl+Y', action: 'edit.redo' },
      { sep: true, label: '' },
      { label: '全选', shortcut: 'Ctrl+A', action: 'edit.selectAll' },
    ],
  },
  {
    label: '段落',
    items: [
      { label: '一级标题', shortcut: 'Ctrl+1', action: 'p.h1' },
      { label: '二级标题', shortcut: 'Ctrl+2', action: 'p.h2' },
      { label: '三级标题', shortcut: 'Ctrl+3', action: 'p.h3' },
      { label: '四级标题', shortcut: 'Ctrl+4', action: 'p.h4' },
      { label: '五级标题', shortcut: 'Ctrl+5', action: 'p.h5' },
      { label: '六级标题', shortcut: 'Ctrl+6', action: 'p.h6' },
      { label: '段落', shortcut: 'Ctrl+0', action: 'p.paragraph' },
      { sep: true, label: '' },
      { label: '引用块', action: 'p.quote' },
      { label: '无序列表', action: 'p.bullet' },
      { label: '有序列表', action: 'p.ordered' },
      { label: '任务列表', action: 'p.task' },
      { sep: true, label: '' },
      { label: '代码块', action: 'p.code' },
      { label: '数学块', action: 'p.math' },
      { label: '表格', action: 'p.table' },
      { label: '水平分割线', action: 'p.hr' },
    ],
  },
  {
    label: '格式',
    items: [
      { label: '加粗', shortcut: 'Ctrl+B', action: 'f.bold' },
      { label: '斜体', shortcut: 'Ctrl+I', action: 'f.italic' },
      { label: '删除线', action: 'f.strike' },
      { label: '行内代码', action: 'f.code' },
      { label: '链接', shortcut: 'Ctrl+K', action: 'f.link' },
      { sep: true, label: '' },
      { label: '清除格式', action: 'f.clear' },
    ],
  },
  {
    label: '视图',
    items: [
      { label: '大纲面板', action: 'view.outline' },
      { label: '源码模式', shortcut: 'Ctrl+/', action: 'view.source' },
    ],
  },
  {
    label: '主题',
    items: [
      { label: 'Typora 默认（亮色）', action: 'theme.light' },
      { label: '暗色', action: 'theme.dark' },
    ],
  },
];

export const TOOLBAR: { label: string; title: string; action: string }[] = [
  { label: 'H1', title: '一级标题', action: 'p.h1' },
  { label: 'H2', title: '二级标题', action: 'p.h2' },
  { label: 'H3', title: '三级标题', action: 'p.h3' },
  { label: '¶', title: '段落', action: 'p.paragraph' },
  { label: 'B', title: '加粗 (Ctrl+B)', action: 'f.bold' },
  { label: 'I', title: '斜体 (Ctrl+I)', action: 'f.italic' },
  { label: 'S', title: '删除线', action: 'f.strike' },
  { label: '<>', title: '行内代码', action: 'f.code' },
  { label: '引用', title: '引用块', action: 'p.quote' },
  { label: '列表', title: '无序列表', action: 'p.bullet' },
  { label: '编号', title: '有序列表', action: 'p.ordered' },
  { label: '任务', title: '任务列表', action: 'p.task' },
  { label: '链接', title: '链接 (Ctrl+K)', action: 'f.link' },
  { label: '代码块', title: '代码块', action: 'p.code' },
  { label: '表格', title: '表格', action: 'p.table' },
  { label: '分割线', title: '水平分割线', action: 'p.hr' },
];

/** 防止点击按钮时编辑器选区丢失 */
function preserveSelection(btn: HTMLElement): void {
  btn.addEventListener('mousedown', (e) => e.preventDefault());
}

export function buildMenubar(container: HTMLElement, run: (id: string) => void): void {
  const closeAll = (): void => {
    container.querySelectorAll('.menu.open').forEach((m) => m.classList.remove('open'));
  };

  for (const menu of MENUS) {
    const li = document.createElement('div');
    li.className = 'menu';

    const label = document.createElement('span');
    label.className = 'menu-label';
    label.textContent = menu.label;

    const dropdown = document.createElement('div');
    dropdown.className = 'menu-dropdown';
    for (const item of menu.items) {
      if (item.sep) {
        const sep = document.createElement('div');
        sep.className = 'menu-sep';
        dropdown.appendChild(sep);
        continue;
      }
      const row = document.createElement('div');
      row.className = 'menu-item';
      preserveSelection(row);
      const name = document.createElement('span');
      name.textContent = item.label;
      row.appendChild(name);
      if (item.shortcut) {
        const sc = document.createElement('span');
        sc.className = 'sc';
        sc.textContent = item.shortcut;
        row.appendChild(sc);
      }
      row.addEventListener('click', () => {
        closeAll();
        if (item.action) run(item.action);
      });
      dropdown.appendChild(row);
    }

    label.addEventListener('click', (e) => {
      e.stopPropagation();
      const isOpen = li.classList.contains('open');
      closeAll();
      if (!isOpen) li.classList.add('open');
    });
    // 一个菜单展开时，悬停其他菜单直接切换
    label.addEventListener('mouseenter', () => {
      if (container.querySelector('.menu.open') && !li.classList.contains('open')) {
        closeAll();
        li.classList.add('open');
      }
    });

    li.appendChild(label);
    li.appendChild(dropdown);
    container.appendChild(li);
  }

  document.addEventListener('click', closeAll);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeAll();
  });
}

export function buildToolbar(container: HTMLElement, run: (id: string) => void): void {
  for (const btn of TOOLBAR) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'tb-btn';
    b.textContent = btn.label;
    b.title = btn.title;
    preserveSelection(b);
    b.addEventListener('click', () => run(btn.action));
    container.appendChild(b);
  }
}
