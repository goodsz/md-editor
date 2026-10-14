import { parseTokens } from '../../syntax/markdown';
import { docToMarkdown, tokensToDoc } from './convert';
import type {
  AnyNode,
  Block,
  BlockId,
  Doc,
  ListItem,
  Op,
  Transaction,
} from './types';
import { isListItem, normalizeBlock } from './types';

/** 父容器类型：root = 顶层文档，quote = 引用块 children，list = 列表 items，item = 列表项 children */
export type ParentKind = 'root' | 'quote' | 'list' | 'item';

export interface IndexEntry {
  node: AnyNode;
  parentId: BlockId | null;
  parentKind: ParentKind;
  index: number;
}

/**
 * 块树是唯一数据源。DOM 只是投影。
 * apply 采用不可变结构共享：只有目标节点到根路径上的节点被复制。
 */
export class DocumentModel {
  private root: Doc = [];
  private index = new Map<BlockId, IndexEntry>();
  private dirtyCbs = new Set<(ids: Set<BlockId>) => void>();

  /** 解析 markdown 并替换当前文档 */
  fromMarkdown(md: string): Doc {
    this.root = tokensToDoc(parseTokens(md));
    this.reindex();
    return this.getRoot();
  }

  toMarkdown(doc?: Doc): string {
    return docToMarkdown(doc ?? this.root);
  }

  getBlock(id: BlockId): AnyNode | undefined {
    return this.index.get(id)?.node;
  }

  getEntry(id: BlockId): IndexEntry | undefined {
    return this.index.get(id);
  }

  /** 加载外部快照（undo/redo 用），不做解析 */
  loadDoc(doc: Doc): void {
    this.root = doc;
    this.reindex();
  }

  /** 同父容器内的相邻节点 id；delta 为 -1（前一个）或 1（后一个） */
  getSiblingId(id: BlockId, delta: number): BlockId | null {
    const e = this.index.get(id);
    if (!e) return null;
    let siblings: readonly AnyNode[];
    if (e.parentId === null) {
      siblings = this.root;
    } else {
      const parent = this.index.get(e.parentId);
      if (!parent) return null;
      const p = parent.node;
      if (isListItem(p)) siblings = p.children ?? [];
      else if (p.type === 'quote') siblings = p.children;
      else if (p.type === 'list') siblings = p.items;
      else siblings = this.root;
    }
    const target = siblings[e.index + delta];
    return target ? target.id : null;
  }

  getRoot(): Doc {
    return this.root;
  }

  /** 提交事务，返回 dirtyIds（结构变更块 + 内容变更块 + 被移除块） */
  apply(tx: Transaction): Set<BlockId> {
    let working: Doc = this.root;
    const dirty = new Set<BlockId>();
    for (const op of tx.ops) {
      working = this.applyOp(working, op, dirty);
    }
    this.root = working;
    this.reindex();
    this.notify(dirty);
    return dirty;
  }

  onDirty(cb: (dirtyIds: Set<BlockId>) => void): () => void {
    this.dirtyCbs.add(cb);
    return () => {
      this.dirtyCbs.delete(cb);
    };
  }

  private notify(dirty: Set<BlockId>): void {
    this.dirtyCbs.forEach((cb) => cb(dirty));
  }

  private applyOp(root: Doc, op: Op, dirty: Set<BlockId>): Doc {
    switch (op.type) {
      case 'updateText': {
        const node = findNode(root, op.id);
        if (!node) throw new Error(`updateText: 节点不存在 ${op.id}`);
        if (!('text' in node)) throw new Error(`updateText: 节点无 text 字段 ${op.id}`);
        if (node.text === op.text) return root;
        dirty.add(op.id);
        return replaceAndReturn(root, op.id, { ...node, text: op.text });
      }
      case 'updateAttrs': {
        const node = findNode(root, op.id);
        if (!node) throw new Error(`updateAttrs: 节点不存在 ${op.id}`);
        if ('id' in op.attrs && op.attrs['id'] !== node.id) {
          throw new Error('updateAttrs: 禁止修改节点 id');
        }
        let next: AnyNode;
        if (isListItem(node)) {
          next = { ...node, ...op.attrs } as ListItem;
        } else {
          next = normalizeBlock({ ...node, ...op.attrs } as unknown as Record<string, unknown>);
        }
        if (JSON.stringify(next) === JSON.stringify(node)) return root;
        dirty.add(op.id);
        return replaceAndReturn(root, op.id, next);
      }
      case 'insert': {
        if (op.into !== undefined && op.after === null) {
          return insertIntoContainer(root, op.into, op.block, dirty);
        }
        if (op.after === null) {
          if (isListItem(op.block)) throw new Error('insert: 根层级只能插入块');
          dirty.add(op.block.id);
          return [op.block, ...root];
        }
        return insertAfter(root, op.after, op.block, dirty);
      }
      case 'remove': {
        const r = removeFromTree(root, op.id);
        if (!r.found) throw new Error(`remove: 节点不存在 ${op.id}`);
        dirty.add(op.id);
        return r.root;
      }
      case 'move': {
        if (op.id === op.after) return root;
        const r = removeFromTree(root, op.id);
        if (!r.found || !r.node) throw new Error(`move: 节点不存在 ${op.id}`);
        dirty.add(op.id);
        if (op.after === null) {
          if (isListItem(r.node)) throw new Error('move: 根层级只能放置块');
          return [r.node, ...r.root];
        }
        return insertAfter(r.root, op.after, r.node, dirty);
      }
    }
  }

  private reindex(): void {
    const index = new Map<BlockId, IndexEntry>();
    const walk = (list: readonly AnyNode[], parentId: BlockId | null, kind: ParentKind): void => {
      list.forEach((node, i) => {
        index.set(node.id, { node, parentId, parentKind: kind, index: i });
        if (isListItem(node)) {
          if (node.children) walk(node.children, node.id, 'item');
        } else if (node.type === 'quote') {
          walk(node.children, node.id, 'quote');
        } else if (node.type === 'list') {
          walk(node.items, node.id, 'list');
        }
      });
    };
    walk(this.root, null, 'root');
    this.index = index;
  }
}

// ============================================================
// 不可变树变换工具（结构共享：仅复制路径节点与目标所在数组）
// ============================================================

type MutateFn = (arr: AnyNode[], idx: number) => AnyNode[] | null;

/**
 * 在树中定位 targetId 所在数组与下标，执行 fn 得到新数组，
 * 沿祖先路径做拷贝-on-write 后返回新根。未找到时 found=false。
 */
function mutateArray(
  list: AnyNode[],
  targetId: BlockId,
  fn: MutateFn,
): { list: AnyNode[]; found: boolean } {
  for (let i = 0; i < list.length; i++) {
    const node = list[i];
    if (node.id === targetId) {
      const next = fn(list, i);
      return next ? { list: next, found: true } : { list, found: true };
    }
    let newNode: AnyNode = node;
    let hit = false;
    if (isListItem(node)) {
      if (node.children) {
        const r = mutateArray(node.children, targetId, fn);
        if (r.found) {
          newNode = { ...node, children: r.list as Block[] };
          hit = true;
        }
      }
    } else if (node.type === 'quote') {
      const r = mutateArray(node.children, targetId, fn);
      if (r.found) {
        newNode = { ...node, children: r.list as Block[] };
        hit = true;
      }
    } else if (node.type === 'list') {
      const r = mutateArray(node.items, targetId, fn);
      if (r.found) {
        newNode = { ...node, items: r.list as ListItem[] };
        hit = true;
      }
    }
    if (hit) {
      const next = list.slice();
      next[i] = newNode;
      return { list: next, found: true };
    }
  }
  return { list, found: false };
}

function findNode(root: Doc, id: BlockId): AnyNode | undefined {
  for (const node of root) {
    if (node.id === id) return node;
    if (isListItem(node)) {
      if (node.children) {
        const hit = findNode(node.children, id);
        if (hit) return hit;
      }
    } else if (node.type === 'quote') {
      const hit = findNode(node.children, id);
      if (hit) return hit;
    } else if (node.type === 'list') {
      for (const item of node.items) {
        if (item.id === id) return item;
        if (item.children) {
          const hit = findNode(item.children, id);
          if (hit) return hit;
        }
      }
    }
  }
  return undefined;
}

function replaceAndReturn(root: Doc, id: BlockId, nextNode: AnyNode): Doc {
  const r = mutateArray(root, id, (arr, idx) => {
    const next = arr.slice();
    next[idx] = nextNode;
    return next;
  });
  if (!r.found) throw new Error(`替换失败: 节点不存在 ${id}`);
  return r.list as Doc;
}

function insertAfter(
  root: Doc,
  afterId: BlockId,
  node: AnyNode,
  dirty: Set<BlockId>,
): Doc {
  const r = mutateArray(root, afterId, (arr, idx) => {
    const target = arr[idx];
    if (isListItem(target)) {
      if (!isListItem(node)) throw new Error('insert: 列表项之后只能插入列表项');
    } else if (isListItem(node)) {
      throw new Error('insert: 块之后不能插入列表项');
    }
    const next = arr.slice();
    next.splice(idx + 1, 0, node);
    return next;
  });
  if (!r.found) throw new Error(`insert: 锚点不存在 ${afterId}`);
  dirty.add(node.id);
  return r.list as Doc;
}

function removeFromTree(root: Doc, id: BlockId): { root: Doc; found: boolean; node?: AnyNode } {
  let removed: AnyNode | undefined;
  const r = mutateArray(root, id, (arr, idx) => {
    removed = arr[idx];
    const next = arr.slice();
    next.splice(idx, 1);
    return next;
  });
  return { root: r.list as Doc, found: r.found, node: removed };
}

/** 插入到容器（quote children / list items / item children）首位 */
function insertIntoContainer(
  root: Doc,
  containerId: BlockId,
  node: AnyNode,
  dirty: Set<BlockId>,
): Doc {
  const r = mutateArray(root, containerId, (arr, idx) => {
    const container = arr[idx];
    const next = arr.slice();
    if (isListItem(container)) {
      if (isListItem(node)) throw new Error('insert: 列表项 children 只能放块');
      next[idx] = { ...container, children: [node as Block, ...(container.children ?? [])] };
    } else if (container.type === 'quote') {
      if (isListItem(node)) throw new Error('insert: 引用块 children 只能放块');
      next[idx] = { ...container, children: [node as Block, ...container.children] };
    } else if (container.type === 'list') {
      if (!isListItem(node)) throw new Error('insert: 列表 items 只能放列表项');
      next[idx] = { ...container, items: [node, ...container.items] };
    } else {
      throw new Error(`insert: 节点 ${containerId} 不是容器`);
    }
    return next;
  });
  if (!r.found) throw new Error(`insert: 容器不存在 ${containerId}`);
  dirty.add(node.id);
  return r.list as Doc;
}
