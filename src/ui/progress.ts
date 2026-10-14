/**
 * 导出进度条：轻量模态覆盖层（复用 dialog 样式变量）。
 * 打印/导出输出中隐藏（app.css @media print）。支持取消（前置阶段安全中止）。
 */
export interface ProgressHandle {
  /** 设置进度（0-100）与阶段文案 */
  set(percent: number, label?: string): void;
  /** 注册取消回调（点击取消按钮触发） */
  onCancel(cb: () => void): void;
  /** 进入不可取消阶段（如已弹保存对话框）时禁用取消按钮 */
  lockCancel(): void;
  close(): void;
}

export function showProgress(title: string): ProgressHandle {
  const overlay = document.createElement('div');
  overlay.className = 'dialog-overlay progress-overlay';

  const box = document.createElement('div');
  box.className = 'dialog progress-box';
  box.setAttribute('role', 'status');

  const titleEl = document.createElement('div');
  titleEl.className = 'dialog-msg progress-title';
  titleEl.textContent = title;

  const track = document.createElement('div');
  track.className = 'progress-track';
  const bar = document.createElement('div');
  bar.className = 'progress-bar';
  bar.style.width = '0%';
  track.appendChild(bar);

  const step = document.createElement('div');
  step.className = 'progress-step';

  const row = document.createElement('div');
  row.className = 'dialog-row';
  const cancelBtn = document.createElement('button');
  cancelBtn.type = 'button';
  cancelBtn.className = 'dialog-btn';
  cancelBtn.textContent = '取消';
  row.appendChild(cancelBtn);

  box.append(titleEl, track, step, row);
  overlay.appendChild(box);
  document.body.appendChild(overlay);

  let cancelCb: (() => void) | null = null;
  cancelBtn.addEventListener('click', () => {
    cancelCb?.();
  });

  return {
    set(percent, text) {
      const p = Math.max(0, Math.min(100, percent));
      bar.style.width = p + '%';
      if (text) step.textContent = text;
    },
    onCancel(cb) {
      cancelCb = cb;
    },
    lockCancel() {
      cancelBtn.disabled = true;
    },
    close() {
      overlay.remove();
    },
  };
}
