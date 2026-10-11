# hex 查看器自研增强（跳转/搜索/检查器） 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** hex 视图三块增量能力——跳转 offset（0x/dec 消歧）、文件内搜索（hex/UTF-8 双模式、worker 增量分块、进度/取消/导航/高亮）、数据检查器（MetaPanel 区块、int/uint/float/bool/UTF-8 解码 + 字节序切换）。

**Architecture:** 三阶段独立交付——①工具条 + 跳转（scrollTo + 短暂高亮）；②binary.worker 新搜索任务（1MB 分块 + needle 长度-1 重叠、进度上报、取消 token、1000 截断）+ 两档命中高亮（renderHexBytes 增可选高亮区间参数，无区间输出与现状逐字节一致）；③cursor 状态 + worker 8 字节窗口解码 + MetaPanel「数据检查器」区块（经 metaStore 上行）。

**Tech Stack:** TypeScript（render-binary hex.ts/hexBytes.ts/binary.worker.ts/client.ts）；vitest（fakeWorker 先例 client.test.ts）；Playwright（fixture 已知字节布点）。

**Spec:** `docs/superpowers/specs/2026-10-11-hex-viewer-enhancement-design.md`

## Global Constraints

- **零回归护栏**：`renderHexBytes` 增可选高亮参数，**无区间时输出与现状逐字节一致**（锁定测试）；工具条出现不改行高/滚动数学（HEX_ROW_BYTES=16、HEX_LINE_HEIGHT=18 不动）。
- **性能锚点**：复用 BUG-16 口径（t-pwa.spec.ts installPaintProbe）——搜索期间与跳转后 hex 首帧不劣化（桌面 <200ms 预算回归）；200MB 文件发起搜索后 100ms 内首个进度帧（该锚点 200MB 构造不现实，降格为「1MB 文件搜索启动即有进度帧」e2e，报告说明偏差）。
- **命中上限**：1000 + `truncated`（对齐全局搜索 MAX_MATCHES 惯例）；新搜索/实例销毁/文件重载 → 取消旧任务；跨块重叠 = needle 长度-1。
- **搜索语义**：hex 模式接受空格分隔或连写字节串（`de ad 09`/`dead09`），奇数 hex 位 → 输入框内联错误（`aria-invalid` + 提示文本，非弹层）；文本模式按 UTF-8 编码；大小写开关默认敏感（仅文本模式有效）。
- **检查器语义**：类型集 int8/16/32/64、uint8/16/32/64、float32/64、bool（非零即真）、UTF-8 片段（16 字节截断）、原始 hex 回显；字节序 little/big 切换（默认 little）；cursor 处剩余字节不足 → 显示 `—`；float 遵循 IEEE 754（NaN/Inf 原样显示）。
- **检查器位置**：MetaPanel 新「数据检查器」区块（hex 实例激活且 cursor 存在时显示）——数据经 hex 实例新鸭子接口 `getInspector?()` 由 ViewerPane readInstanceMeta 通道上行（复用既有 `'getMeta' in inst` 探测模式，metaStore 增 `inspector` 字段）；MetaPanel 无 props 约束不变。
- **cursor**：点击 hex 列或 ASCII 列任意字节 → 按 x 坐标定位字节（整行字符串渲染下计算）；方向键 ±1（面板容器 keydown）；光标字节高亮（span 切分仅光标行/命中行启用，其余行整串零开销）。
- 中文注释讲 why；TDD；每任务独立 commit（Angular 中文 message）。
- 门禁：`pnpm test`、`pnpm typecheck`；e2e `t-hex*.spec.ts`/`m4.spec.ts` 回归 + 新增用例。

---

### Task 1: 工具条 + 跳转 offset

**Files:**
- Modify: `packages/render-binary/src/hex.ts`（工具条 DOM + 跳转 + 短暂高亮 + RenderedInstance 扩展）
- Create: `packages/render-binary/test/hexGoto.test.ts`（跳转语法解析纯函数——从 hex.ts 导出 `parseGotoInput(input: string): number | null`：`0x` 前缀 hex、其余 dec、非法/负/空 → null）

**Interfaces:**
- Produces:
  - 工具条：`.vv-hex-toolbar`（pre 兄弟节点，防 scroller 清空——code.ts 提示条先例）：跳转 input（`.vv-hex-goto`，placeholder「跳转 (0x10 或 16)」+ Enter 提交）+ 搜索 input（Task 2 启用，本任务先渲染占位 disabled？——不：占位会误导，Task 1 只渲染跳转框，Task 2 再增搜索框）+ 状态位（Task 2 用）。
  - 跳转行为：`row = floor(offset / 16)` → 经既有虚拟滚动定位（目标行居中偏好——scroller 若无居中 API 则 scrollTop = row*18 - viewport/2）；超界 clamp 到最后字节 + 状态位提示「已跳至文件尾」；目标字节 1s 衰减高亮（`.vv-hex-cursor-glow` 或复用 Task 3 cursor 高亮机制的瞬时态）。
  - render 返回实例仍满足 RenderedInstance（destroy 级联）。

- [ ] **Step 1: 写失败测试**（hexGoto.test.ts：parseGotoInput——'0x1A'→26、'16'→16、'abc'→null、'-5'→null、''→null、'0xZZ'→null）
- [ ] **Step 2: 跑测试确认失败**
- [ ] **Step 3: 实现**（parseGotoInput 导出 + 工具条 + 定位 + 瞬时高亮；虚拟滚动定位以 hex.ts 现有 scroller 用法为准——hex.ts L76-95 先例）
- [ ] **Step 4: 跑测试确认通过 + `pnpm test && pnpm typecheck`**
- [ ] **Step 5: Commit**

```bash
git add packages/render-binary/src/hex.ts packages/render-binary/test/hexGoto.test.ts
git commit -m "feat(render-binary): hex 工具条与跳转 offset

why: hex 增强第一块（spec H §2.1）——0x/dec 消歧定位与超界 clamp。
what: parseGotoInput 纯函数 + .vv-hex-toolbar + 虚拟滚动定位 +
目标字节 1s 衰减高亮。"
```

---

### Task 2: worker 搜索（分块/进度/取消/截断）+ 高亮与导航

**Files:**
- Modify: `packages/render-binary/src/binary.worker.ts`（新任务类型 search）
- Modify: `packages/render-binary/src/client.ts`（search API + 进度/完成/取消回调）
- Modify: `packages/render-binary/src/hexBytes.ts`（renderHexBytes 高亮区间参数——纯函数先测）
- Modify: `packages/render-binary/src/hex.ts`（搜索 UI + 命中消费 + 导航 + 两档高亮）
- Modify: `packages/render-binary/test/`（hexBytes/renderHexBytes 高亮锁定测试 + worker 搜索分块纯函数测试——分块数学抽 `searchScan.ts` 纯模块）

**Interfaces:**
- Produces:
  - `packages/render-binary/src/searchScan.ts` 纯函数：`scanChunk(data: Uint8Array, needle: Uint8Array, baseOffset: number, overlap: number): number[]`（返回绝对 offset 列表；overlap 处理跨块——由调用方传入前块尾部重叠区）。分块调度：worker 内 `CHUNK = 1MB`、`overlap = needle.length - 1`、每块后 `postMessage({type:'search-progress', scanned, total, hits: 本块新增})`；累计 1000 → 提前终止 `{type:'search-done', truncated:true}`；cancel token（搜索 id）失效即停。
  - client.ts：`search(needle, opts: { onProgress, onDone }): void` + `cancelSearch()`（id 失效语义——与既有 worker id 配对机制协同，fakeWorker 先例测试）。
  - hexBytes：`renderHexBytes(row, data, highlights?: { start: number; end: number; active: boolean }[])`——命中区与当前命中两档类（`.vv-hex-hit` / `.vv-hex-hit-active`），hex 列与 ASCII 列对应字节同档；无 highlights 参数时输出与现状逐字节一致（锁定测试：`renderHexBytes(row, data) === renderHexBytes(row, data, undefined)`）。
  - hex.ts UI：工具条搜索 input（Enter 发起；奇数 hex 位内联 `aria-invalid`）+ 大小写开关（文本模式）+ 状态位（「n 处命中（截断）」/ 进度 scanned/total / 取消按钮——新搜索自动取消旧任务）+ 上/下命中导航（Enter/Shift+Enter 与按钮，当前命中滚动定位）+ 命中列表驻 worker 侧主线程镜像（数组）。
  - 高亮渲染：仅命中行走 span 切分（行号集合查询 O(1)——命中行 Set），其余行整串。

- [ ] **Step 1: 写失败测试**：
  - searchScan.test.ts：needle 恰跨块边界（两块拼接处命中）、首尾命中、1000 截断、overlap 不重复计（重叠区命中只算一次）。
  - hexBytes 高亮锁定：无参数逐字节一致；两档区间正确切分（hex 列与 ASCII 列）。
  - client.test.ts：fakeWorker 注入 search 进度/完成/取消回调序列。
- [ ] **Step 2: 跑测试确认失败**
- [ ] **Step 3: 实现**（worker 消息协议扩展注意向后兼容——现有任务类型不动；hex.ts 滚动回调中按命中行 Set 决定切分渲染）
- [ ] **Step 4: 跑测试确认通过 + `pnpm test && pnpm typecheck`**
- [ ] **Step 5: Commit**

```bash
git add packages/render-binary/src packages/render-binary/test
git commit -m "feat(render-binary): worker 增量搜索与两档命中高亮

why: hex 增强第二块（spec H §2.2）——大文件搜索保持响应性。
what: searchScan 分块纯函数（跨块重叠/截断）+ worker 协议扩展 +
renderHexBytes 可选高亮（无区间逐字节一致锁定）+ 导航与取消。"
```

---

### Task 3: 数据检查器（cursor + MetaPanel 区块）

**Files:**
- Create: `packages/render-binary/src/inspector.ts`（纯函数解码表）
- Create: `packages/render-binary/test/inspector.test.ts`
- Modify: `packages/render-binary/src/hex.ts`（cursor 状态 + 点击定位 + 键盘 ±1 + 光标高亮 + `getInspector` 鸭子接口）
- Modify: `apps/web/src/lib/metaStore.svelte.ts`（FileMetaState 增 `inspector` 字段）
- Modify: `apps/web/src/lib/ViewerPane.svelte`（readInstanceMeta 探测 `getInspector`）
- Modify: `apps/web/src/lib/MetaPanel.svelte`（「数据检查器」区块：值表 + 字节序 select）
- Modify: `apps/web/src/app.css`

**Interfaces:**
- Produces:
  - inspector.ts 纯函数：`decodeAt(data: Uint8Array, offset: number, little: boolean): InspectorRow[]`——InspectorRow `{ label: string; value: string; available: boolean }`；类型集按 Global Constraints；字节不足 available=false（value='—'）；UTF-8 片段 16 字节截断；bool 非零即真；float NaN/Inf 原样（`String(v)`）。
  - hex.ts：cursor 状态（offset 或 null）；点击 hex/ASCII 列定位（整行字符串下按 x 坐标 → 字节 index——事件坐标/单元格宽换算，实现自证并注释）；±1 键盘（容器 keydown）；光标字节高亮（复用 Task 2 span 切分，单区间）；实例 `getInspector?: () => { offset: number; little: boolean; rows: InspectorRow[] }`；MetaPanel 字节序切换回调 → hex 实例经鸭子接口 `setLittle?: (v: boolean) => void`（ViewerPane 透传——MetaPanel 无 props 约束下经 metaStore 上行 offset/rows，字节序切换回调需要下行通道：ViewerPane 已持 live 实例，MetaPanel onchange 经新增 onopenwith 同款 prop？——**否**，MetaPanel 无 props 是 C 项约束；落点：viewer 侧 `inspectorBus`（同 fileMeta 模式的模块级 $state + setter），MetaPanel 写 `inspectorBus.little` → hex.ts 消费。实现选最简并报告）。
  - MetaPanel 区块：`{#if fileMeta.inspector}` 表格式行（label/value；available=false 灰显）；字节序 select（小端/大端）。

- [ ] **Step 1: 写失败测试**（inspector.test.ts：已知字节序列逐类型断言——`00 01 02 03 04 05 06 07 08` 处 little/big 两向 int16/uint32/float32；字节不足 available=false；bool；UTF-8 中文截断；NaN/Inf）
- [ ] **Step 2: 跑测试确认失败**
- [ ] **Step 3: 实现**（inspector 纯函数 → hex.ts cursor/高亮/鸭子接口 → metaStore/ViewerPane 上行 → MetaPanel 区块与 inspectorBus 下行）
- [ ] **Step 4: 跑测试确认通过 + `pnpm test && pnpm typecheck` + e2e（Task 4）前先跑 m4 回归**
- [ ] **Step 5: Commit**

```bash
git add packages/render-binary apps/web/src/lib/metaStore.svelte.ts apps/web/src/lib/ViewerPane.svelte apps/web/src/lib/MetaPanel.svelte apps/web/src/app.css
git commit -m "feat(render-binary,web): hex 数据检查器

why: hex 增强第三块（spec H §2.3）——光标处类型解码。
what: inspector 解码表（int/uint/float/bool/UTF-8+字节序）+ cursor
点击/键盘定位 + MetaPanel 区块（inspectorBus 双向通道）。"
```

---

### Task 4: e2e + 性能锚点 + 全量门禁

**Files:**
- Create: `apps/web/e2e/t-hex-enhance.spec.ts`
- Modify: `apps/web/e2e/t-pwa.spec.ts`（可选：hex 首帧锚点在搜索期间回归——若改动面小）

**Interfaces:** 验证性。

- [ ] **Step 1: e2e 用例**（t-hex-enhance.spec.ts；fixture 已知字节布点——samples/m4/sample.bin 或页内构造 Uint8Array 注入）：
  1. 跳转：输入 `0x10` Enter → 滚动定位（断言首行 offset 文本）；输入超界值 → 状态位「已跳至文件尾」。
  2. 搜索 hex 模式：`de ad` 命中数与导航（下一处滚动）；奇数位输入 → aria-invalid。
  3. 搜索文本模式 + 大小写开关。
  4. 两档高亮：当前命中 vs 其他命中类名断言。
  5. 检查器：点击某字节 → MetaPanel 区块显示各类型值（与 fixture 已知值断言）；字节序切换值翻转。
  6. 搜索期间滚动流畅（首帧探针 < 预算）。
- [ ] **Step 2: 全量门禁**：`pnpm test && pnpm typecheck`；重建 build；`pnpm playwright test e2e/t-hex-enhance.spec.ts e2e/m4.spec.ts`（新增+hex 回归）+ 按需扩到全量
- [ ] **Step 3: Commit**

```bash
git add apps/web/e2e/t-hex-enhance.spec.ts
git commit -m "test(e2e): hex 增强端到端锚点

why: 三块能力的端到端固化（spec H §3/§5）。
what: 跳转/搜索两模式/高亮两档/检查器解码与字节序/性能探针用例。"
```

---

## Self-Review 结论

- **Spec 覆盖**：§2.1 跳转→T1；§2.2 搜索→T2；§2.3 检查器→T3；§3 测试→各任务；§5 验收→T4。无缺口。
- **占位扫描**：inspectorBus 下行通道给了两个候选落点并指定选最简+报告；性能锚点 200MB 构造不现实的降格已声明；「实现自证并注释」处均为语义锚非悬空引用。
- **类型一致性**：parseGotoInput/scanChunk/renderHexBytes(highlights)/decodeAt/InspectorRow/getInspector/setLittle/inspectorBus 贯通一致；零回归护栏（无区间逐字节一致）为 T2 硬测试。
- **性能护栏**：200MB/100ms 进度帧锚点降格为 1MB 版本（e2e 现实性）；BUG-16 首帧口径复用。
