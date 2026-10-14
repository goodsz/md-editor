# ADR-0001：长文档性能优化 —— 视口虚拟化 + WASM 方案

> 状态：P0/P3 已落地（虚拟化 + Rust 数值内核）；P2 已落地（Worker 化）；P1b 文本内核缓期
> 日期：2026-10-13（v0.7 实施更新）
> 关联：DEVELOPMENT.md v0.6/v0.7

## 1. 背景与根因

打开数千块的大文档后出现三类症状：交互卡顿、跳转/懒渲染异常、滚动条移动但视口无变化。

根因分析（按贡献度排序）：

| 瓶颈 | 量级 | WASM 能否解决 |
|---|---|---|
| **DOM 规模**：数千个 contenteditable 块常驻，布局/绘制/事件命中成本随块数线性增长 | 主因 | ❌（WASM 无法操作 DOM） |
| **渲染路径**：朴素全量挂载一次性建树，滚动期间布局抖动 | 主因 | ❌ |
| 解析/序列化 CPU（markdown-it parse + toMarkdown） | 次因（MB 级文档数百 ms） | ✅ |
| 块树索引重建（每次 apply O(n)） | 次因 | ✅ |

结论：**DOM 规模问题只能靠视口虚拟化解决**；WASM 的收益点在纯计算（解析/序列化/索引）。两者互补，缺一不可。

## 2. 已落地：视口虚拟化（本轮）

- 顶层块数 > 300 启用；视口外块渲染为等高占位符 `.md-spacer`（`pointer-events: none`）
- DOM 真实块数恒定 ≈ 视口块数 + 前后 8 块缓冲
- 高度策略：真实块测量值缓存 → 卸载时回填 spacer（总高稳定，滚动不跳动）；从未渲染的块用类型+文本量粗估
- 窗口换算：scroll/resize 触发（rAF 合并），按前缀高度和定位可见区间
- 跳转统一走 `engine.revealBlock(id)`：解析顶层祖先 → spacer `scrollIntoView` → `refreshWindow` 渲染 → 落光标；undo/redo 远跳在 `loadSnapshot` 内自动重试
- 以顶层块为虚拟化单元（quote/list 内部随容器整体渲染），spacer 锚点保证 `findEl` 永远命中

已知取舍：键盘方向键跨入未渲染区域时光标停在窗口边缘（先滚动再操作）；spacer 区域点击不产生选区（防误编辑）。

## 3. WASM 优化方案（分阶段）

### 3.1 范围：只迁"纯计算"，不迁 DOM

| 模块 | 现实现 | 目标 | 预期收益 |
|---|---|---|---|
| Markdown 解析（tokens → 块树） | markdown-it + convert.ts | Rust `md-wasm`（pulldown-cmark 改造/自研），输出块树 JSON | 1MB 文档 ~300ms → ~40ms |
| 序列化（块树 → markdown） | convert.ts docToMarkdown | 同上 | 自动保存/导出 O(n) 快 5-8× |
| 索引重建（reindex） | document.ts 递归遍历 | WASM 扁平化遍历 | 大文档 apply 路径收益 30-50% |
| 事务/选区/渲染 | document.ts / controller / renderer | **保留 TS**（与 DOM 强耦合、逻辑复杂） | — |

### 3.2 架构

```
┌─ 主线程 ─────────────────────────────────────────┐
│ engine/model → wasmBridge（TS）                    │
│   接口与 syntax/markdown.ts 对齐：                 │
│   parse(md) → DocJSON  /  serialize(doc) → md     │
└──────────────┬────────────────────────────────────┘
               │ Web Worker（transferable / Structured Clone）
┌─ Worker ─────▼────────────────────────────────────┐
│ md-wasm.wasm（wasm-bindgen）                       │
│   parse / serialize / reindex（零拷贝字节数组进出） │
└────────────────────────────────────────────────────┘
```

- **加载**：`WebAssembly.instantiateStreaming` 懒加载（首次打开大文件才拉取），失败自动回退现有 TS 实现（接口一致，零业务侵入）
- **大文件路径**：打开/自动保存走 Worker（不阻塞主线程）；编辑路径的单块小事务保持主线程同步（避免 Worker 往返开销反噬）
- **数据边界**：块树 JSON 与现有 `Doc` 类型一一对应；Rust 侧 serde 结构镜像 `types.ts`

### 3.3 分阶段计划

| 阶段 | 内容 | 验收 |
|---|---|---|
| P0 | 虚拟化落地（本轮） | 1000 块文档滚动/跳转/编辑流畅；真实块数恒定 |
| P1 | Rust crate `md-wasm`：parse + serialize + 往返自检；与 TS 实现做**结构等价**对比测试（现有 18 组往返用例作金标准） | 基准：1MB 文档 parse < 50ms；往返结果与 TS 一致 |
| P2 | Worker 化 + 打开/自动保存路径切换 | 打开 5MB 文档主线程无可感知阻塞（>100ms 的任务为 0） |
| P3 | reindex 迁移 + 性能回归基线入库（perf/bench 扩展大文档场景） | apply 路径 p95 下降 ≥30% |

### 3.4 风险与回退

- 结构等价风险：以现有往返测试为金标准，双实现并行输出 diff（灰度开关 `md-editor:wasm`）
- 二进制体积：wasm 仅含解析器（预计 < 200KB gzip），懒加载不影响首屏
- 调试成本：保留 TS 路径作为永久回退与对拍基准

## 4. 验证

- 虚拟化：`tests/engine/mount.test.ts`（spacer/滚动/编辑/reveal/undo 远跳 7 组用例）
- WASM P1 起补充：`tests/wasm/parity.test.ts`（双实现等价）+ `tests/perf/bench.test.ts` 扩展 1MB/5MB 文档场景

## 5. 实施结果（v0.7）

### 已落地
- **P3 数值内核（Rust）**：`wasm/md-kernel`（零依赖、std alloc、`extern "C"` 直出无需 wasm-bindgen）——Fenwick 前缀和 + 二分窗口定位；`HeightIndex`（TS）双轨封装，内核可用走 WASM，否则 TS 同算法回退；渲染器虚拟化窗口定位 O(n) → O(log n)
- **构建链**：`npm run wasm:build` = cargo 编译 wasm32 → base64 内嵌 `kernel-bytes.ts` → **Node 真实领域硬校验**（`scripts/verify-kernel.mjs`：seed/update/query/total 断言）
- **P2 Worker 化**：`doc.worker` + 客户端（回退主线程）——大文件（>200K 字符）打开异步解析、自动保存异步序列化，主线程零阻塞

### 实施中发现的环境坑（已绕开，记录备查）
1. **Node 22.22 单步 `WebAssembly.instantiate(bufferSource, imports)`** 会 resolve 出 `exports: undefined` 的 Instance → 改用两步 `new WebAssembly.Module()` + `new WebAssembly.Instance()`
2. **vitest vm 沙箱替换全局 WebAssembly**（instantiate 返回空导出）→ 内核正确性由构建期 verify-kernel（真实领域）硬校验；vitest 内回归 TS Fenwick vs 朴素前缀对拍 + wasm 冒烟（沙箱可用时自动对拍，否则跳过）
3. 内核二进制以 **base64 内嵌 TS 模块**（12KB→16KB）分发：atob 解码在浏览器/Electron/Node 原生可用，规避 dev/build/worker/测试四类环境的资源 URL 差异

### 缓期项（触发条件）
- **P1b 文本内核（Rust 重写 markdown 解析/序列化）**：Worker 化后主线程已无该阻塞；仅当基准显示 Worker 往返与 JSON 序列化开销成为新瓶颈、且团队接受 markdown 语义移植风险时启动。触发方式：`tests/perf` 扩展 5MB 场景，p95 解析 > 100ms 时立项。
