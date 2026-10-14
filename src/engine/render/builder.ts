import type { AnyNode } from '../model/types';

/** 块构建回调签名：容器块渲染器用它递归渲染子块 */
export type BlockBuilder = (node: AnyNode) => HTMLElement;
