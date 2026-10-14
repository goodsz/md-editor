/**
 * 应用内输入对话框：替代 window.prompt（Electron 沙箱不支持 prompt，会直接抛错）。
 * 确认返回输入值（去空白），取消/空值返回 null。
 */
export function askText(message: string, defaultValue = ''): Promise<string | null> {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'dialog-overlay';

    const box = document.createElement('div');
    box.className = 'dialog';
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-label', message);

    const label = document.createElement('div');
    label.className = 'dialog-msg';
    label.textContent = message;

    const input = document.createElement('input');
    input.className = 'dialog-input';
    input.type = 'text';
    input.value = defaultValue;

    const row = document.createElement('div');
    row.className = 'dialog-row';
    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'dialog-btn';
    cancelBtn.textContent = '取消';
    const okBtn = document.createElement('button');
    okBtn.type = 'button';
    okBtn.className = 'dialog-btn primary';
    okBtn.textContent = '确定';
    row.append(cancelBtn, okBtn);

    box.append(label, input, row);
    overlay.appendChild(box);
    document.body.appendChild(overlay);

    const close = (value: string | null): void => {
      document.removeEventListener('keydown', onKey, true);
      overlay.remove();
      resolve(value);
    };
    const confirm = (): void => {
      const v = input.value.trim();
      close(v === '' ? null : v);
    };

    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        close(null);
      }
    }

    okBtn.addEventListener('click', confirm);
    cancelBtn.addEventListener('click', () => close(null));
    overlay.addEventListener('mousedown', (e) => {
      if (e.target === overlay) close(null);
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        confirm();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        close(null);
      }
    });

    input.focus();
    input.select();
    document.addEventListener('keydown', onKey, true);
  });
}
