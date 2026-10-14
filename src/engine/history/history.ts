import type { Doc, LogicalSelection } from '../model/types';

export interface Snapshot {
  doc: Doc;
  selection: LogicalSelection;
}

/**
 * 事务化 undo/redo：全程接管，弃用 contenteditable 原生 undo。
 * 栈中保存变更后的完整快照（结构共享使成本近似 O(改动块数)）。
 */
export class HistoryManager {
  private undoStack: Snapshot[] = [];
  private redoStack: Snapshot[] = [];
  private readonly limit = 200;

  get canUndo(): boolean {
    return this.undoStack.length > 1;
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  /** 记录变更后的状态；超限丢最旧；新操作清空 redo 栈 */
  push(snapshot: Snapshot): void {
    this.undoStack.push(snapshot);
    if (this.undoStack.length > this.limit) this.undoStack.shift();
    this.redoStack = [];
  }

  /** 初始化（入栈首状态，清空历史） */
  reset(snapshot: Snapshot): void {
    this.undoStack = [snapshot];
    this.redoStack = [];
  }

  /** 返回应恢复到的快照（上一个状态），无则 null */
  undo(): Snapshot | null {
    if (!this.canUndo) return null;
    const current = this.undoStack.pop()!;
    this.redoStack.push(current);
    return this.undoStack[this.undoStack.length - 1];
  }

  redo(): Snapshot | null {
    const next = this.redoStack.pop();
    if (!next) return null;
    this.undoStack.push(next);
    return next;
  }
}
