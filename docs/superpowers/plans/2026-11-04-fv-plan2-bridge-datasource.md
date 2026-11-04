# file-viewer 引入 · 计划 2（桥接基建 + 数据源机制）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 建立 file-viewer 桥接契约层（vviewer-render-foreign 包：桥接渲染器工厂 + 嵌套附件回调 + resolveSibling 边车回调）；实现远端全量物化的下载进度卡（无分级全显示：地址/进度/速度/ETA/已下载/完整大小/取消）、可设阈值的确认门（settings「远端下载确认阈值」默认 512MB）与另存为管线（saveAs 统一管线 + TabContextMenu 第七动作 + 进度卡双动作）。

**Architecture:** 桥接层对 file-viewer 零依赖（mount 函数注入式——npm 引入发生在计划 3/4，本计划只钉契约与机制）。远端全量物化泵 = dispatcher 全量拉取路径的 4MB 分块循环 + `onReadProgress` 可选钩子（abort signal 贯穿，取消落既有 `abortReadError` 身份层）；进度卡走 ViewerPane 加载态区（`showErrorCard` 同域，新增 loading-progress 形态）；确认门在泵启动前拦截（settings 阈值，size 未知不适用）；saveAs 管线单源（ensure 全量字节[实例在手直用/经泵+确认门] → FS Access picker 主 / blob+download 兜底 → 写盘；「下载并另存为」= 泵直写 FS Access writable + getFile 回填）。

**Tech Stack:** TypeScript / Svelte 5（$state）/ vitest（仓库根）/ Playwright。

**Spec:** `docs/superpowers/specs/2026-11-04-file-viewer-integration-design.md` §6.1（桥接层方案 A）、§6.4（数据源对接+进度卡+确认门+另存为）、§7（settings 接入）。

## Global Constraints

- 本计划零 npm 依赖变更（file-viewer 包是计划 3/4 的事）。
- abort 语义统一：取消落 `abortReadError`（`packages/vviewer-core/src/dispatch/errors.ts` 既有身份层），不得新造错误类型。
- 进度事件节流 ~200ms；速度=滑动窗口均值（~5s 窗）；ETA 速度未稳显示「计算中」。
- 确认阈值：settings 字段「远端下载确认阈值」MB 计，默认 512，clamp 1–4096；走既有 settingsDraft normalizeSettings 白名单 + SettingsCenter 注册表 + 导入导出（`apps/web/src/lib/settingsDraft.ts`、`apps/web/src/lib/settings/`）。
- size 未知：不适用确认门（无前置数字），进度卡不定态（「已下载 N MB（总大小未知）」）。
- FS Access 不可用环境（SHELL-07 同域）：saveAs 降级 blob URL + `download` 属性；「下载并另存为」降级为普通下载路径。
- 样式单一来源 `apps/web/src/app.css`；vitest 仓库根跑；e2e 前 `pnpm --filter web build:e2e`；e2e 命令 `pnpm --filter web exec playwright test <spec>`（web 无 test:e2e 脚本，计划 1 实测）。
- 每任务原子 commit；Conventional Commits 中文。

## Review Focus

1. **abort 竞态**：泵在飞时取消/重渲染（tab 关闭/reload）→ 在飞 read 必须随 signal 取消且进度卡卸载，不得孤儿 interval/计时器——T2/T4 测试锚。
2. **进度卡生命周期**：完成态自动让位渲染、失败落错误卡、重复打开 tab 各自独立进度——T4 锚。
3. **确认门边界**：total===阈值 不拦（> 才拦）、本地来源（L1-L3）永不拦、size null 永不拦、阈值改动即时生效——T5/T6 锚。
4. **saveAs 取数路径**：已物化实例零下载直写；远端未物化走泵+确认门；zip 条目经 zipStore——T7 锚。
5. **picker 权限拒绝**：showSaveFilePicker 用户 abort（NotAllowedError/AbortError）不得落错误卡（静默返回）——T7 锚。

---

### Task 1: vviewer-render-foreign 包骨架 + 桥接契约（resolveSibling + 嵌套回调类型）

**Files:**
- Create: `packages/vviewer-render-foreign/package.json`（name `@bhxch/vviewer-render-foreign`，workspace 协议依赖 `@bhxch/vviewer-core`；exports "./bridge"）、`src/index.ts`、`src/bridge.ts`
- Modify: 根 `pnpm-workspace.yaml` 无需改（packages/* 已覆盖）；`apps/web/package.json` 加 workspace 依赖（装配在计划 3 使用，此处先接线可编译）
- Test: `packages/vviewer-render-foreign/test/bridge.test.ts`

**Interfaces:**
- Consumes: `Renderer`/`RenderedInstance`/`FileSource`（core types）；`FileStore.read(path, {range?, signal?})`（types.ts:51）。
- Produces（计划 3/4 消费）:
  - `export interface ForeignMount { (args: ForeignMountArgs): Promise<ForeignMountResult>; }`
  - `export interface ForeignMountArgs { data: Uint8Array; file: File; name: string; target: HTMLElement; signal: AbortSignal; renderNested: NestedRender; resolveSibling: SiblingResolver; assetBaseUrl?: string; }`
  - `export interface NestedRender { (data: Uint8Array, name: string, target: HTMLElement): Promise<void>; }`
  - `export interface SiblingResolver { (name: string): Promise<Uint8Array | null>; }`
  - `export function wrapFileViewerRenderer(spec: { id: string; label: string; extensions: readonly string[]; mount: ForeignMount; }): Renderer;`
  - `export function createSiblingResolver(source: FileSource): SiblingResolver;`——`store.read(join(dirname(source.path), name))`，store 缺失或目录型来源返回 null（不抛）；路径拼接用 core 既有 path 工具（rg 'dirname|joinPath' packages/vviewer-core/src，若无则本地实现 POSIX 语义并注明）。

- [ ] **Step 1: 失败测试**：wrapFileViewerRenderer 产出 Renderer（id/label/extensions 逐字、streaming:false）；resolveSibling——R1 形 store stub（read 命中返回 bytes）、store 无 read（本地 File 形）返回 null、目录条目（source.path 带尾段）正确 join、read 抛错→null 不抛。
- [ ] **Step 2: 红**（`pnpm vitest run packages/vviewer-render-foreign`）→ Step 3: 实装 → Step 4: 绿 + 根 `pnpm --filter web typecheck` 0E → Step 5: Commit `feat(web): vviewer-render-foreign 桥接契约层——wrapFileViewerRenderer+resolveSibling（spec §6.1）`

### Task 2: dispatcher onReadProgress 钩子（远端全量物化泵）

**Files:**
- Modify: `packages/vviewer-core/src/dispatch/dispatcher.ts:293-305`（全量拉取路径：store-backed 远端来源改 4MB 分块循环，逐块上报；`size===null` 走不定态循环至 EOF）；`packages/vviewer-core/src/types.ts`（DispatchOptions 增 `onReadProgress?: (p: { loaded: number; total: number | null }) => void`）
- Test: `packages/vviewer-core/test/dispatcher*.test.ts`（既有文件就近加；rg 定位）

**Interfaces:**
- Consumes: `FileStore.read(range, signal)`（types.ts:36）；dispatch 既有 signal 贯穿。
- Produces: 分块泵——chunk 4MiB、Range 请求 `read({start: loaded, end: min(loaded+4MiB, size)-1})`、每块后上报 `{loaded, total: size}`（size 未知上报 `{loaded, total: null}` 至 EOF）；**节流在 UI 层做（Task 4），dispatcher 每块都上报**；`onReadProgress` 缺省零行为变化（既有测试全部不动）。

- [ ] **Step 1: 失败测试**：stub store read 逐 Range 断言（4MiB 对齐、末块收口、loaded 累计、total 正确/未知 null）；abort 中途 → read 收到 signal 且异常落 `abortReadError` 身份（isAbortError）；小文件（≤4MiB）单块路径与现行为逐字节等价（既有用例零翻转）。
- [ ] **Step 2: 红** → Step 3: 实装（仅 store-backed 全量路径；本地 File slice 路径不加泵）→ Step 4: 绿（全 core 套件零翻转）→ Step 5: Commit `feat(core): dispatcher 全量物化分块泵+onReadProgress 钩子（spec §6.4）`

### Task 3: downloadProgress 纯函数层（速度/ETA/格式化）

**Files:**
- Create: `packages/vviewer-core/src/download/progress.ts`（或 apps/web/src/lib/downloadProgress.ts——选 apps/web：纯 UI 伴生逻辑，不进 core 公共面；最终落位 `apps/web/src/lib/downloadProgress.ts` + `downloadProgress.test.ts`）
- Test: `apps/web/src/lib/downloadProgress.test.ts`

**Interfaces:**
- Produces: `createProgressTracker(onTick: (snapshot: ProgressSnapshot) => void, opts?: { throttleMs?: number })` → `{ update(loaded: number, total: number | null): void; done(): void; }`；`ProgressSnapshot = { loadedText: string; totalText: string | null; speedText: string | null; etaText: string | null; ratio: number | null }`；字节格式化复用既有 helper（rg 'formatBytes|humanBytes' apps/web/src，无则本地实现并注明）。

- [ ] **Step 1: 失败测试**：滑动窗速度（注入假时钟——tracker 接 `now?: () => number`）、ETA 稳定前「计算中」、不定态 totalText null、节流（200ms 内多 update 单 tick）、done() 触发完成 tick。
- [ ] **Step 2: 红** → Step 3: 实装 → Step 4: 绿 → Step 5: Commit `feat(web): 下载进度纯函数层——滑窗速度/ETA/节流（spec §6.4）`

### Task 4: 下载进度卡 UI（ViewerPane loading-progress 形态）

**Files:**
- Modify: `apps/web/src/lib/ViewerPane.svelte`（加载态区：远端下载中显示进度卡——地址（脱敏 display endpoint + path）、进度条/ratio、已下载/完整大小、速度、ETA、取消按钮；完成态自动卸载让位渲染；取消经 AbortController.abort()）
- Modify: `apps/web/src/app.css`（.vv-dl-progress 系样式，单一来源）
- Test: `apps/web/src/lib/downloadProgressUi.test.ts`（组件级：rg 既有 apps/web 组件测试先例——settingsCenter.test.ts 形态；若 ViewerPane 难直测则抽 DownloadProgressCard.svelte 子组件直测）

**Interfaces:**
- Consumes: Task 2 钩子（装配点：ViewerPane 调 dispatch 处传 onReadProgress）、Task 3 tracker。
- Produces: 取消 → abort → dispatcher 落 `abortReadError` → 既有错误身份层消化（不落错误卡，视作用户取消静默收场——与既有 abort 分类一致）。

- [ ] **Step 1: 失败测试**：进度卡渲染快照字段（mock tracker 快照序列 3 帧：不定态→有 total→速度稳）；取消按钮触发 abort 回调；完成 tick 卸卡。
- [ ] **Step 2: 红** → Step 3: 实装 → Step 4: 绿 + typecheck 0E → Step 5: Commit `feat(web): 远端下载进度卡——地址/进度/速度/ETA/取消（spec §6.4）`

### Task 5: 确认门 settings（远端下载确认阈值）

**Files:**
- Modify: `apps/web/src/lib/settingsDraft.ts`（settings 增字段，路径按既有 Settings 形状——rg 'krokiHost' 定位 diagrams 节形态后同构新节或挂既有节；normalizeSettings 白名单 + clamp(1, 4096) + 默认 512）
- Modify: `apps/web/src/lib/settings/StorageSection.svelte`（或「存储与数据」节实名——rg -l '存储' apps/web/src/lib/settings/）加一行数字输入（clamp 即时回写，字体字号渐进输入先例：oninput 不写 DOM）
- Test: `apps/web/src/lib/settingsDraft.test.ts` 就近加（默认值/clamp 双界/白名单三类问题收集/导入导出含新字段）

- [ ] **Step 1: 失败测试**（四锚：默认 512、clamp 下上界、非法值收集、导出回环）→ Step 2: 红 → Step 3: 实装（normalize + UI 控件）→ Step 4: 绿 → Step 5: Commit `feat(web): 设置新增「远端下载确认阈值」（默认 512MB，clamp 1-4096；spec §6.4）`

### Task 6: 确认门接线（泵前置确认卡）

**Files:**
- Modify: `apps/web/src/lib/ViewerPane.svelte`（远端来源 + size 已知 + size>阈值 → 泵启动前显示确认卡：文件名/大小/目标渲染器名/内存影响文案 + 「开始下载」「取消」；确认后落进度卡形态；阈值读 settings 现值即时生效）
- Test: `apps/web/src/lib/downloadConfirm.test.ts`（决策纯函数 `shouldConfirm(size: number | null, thresholdBytes: number): boolean` 单源抽出的四边界锚——null false、≤阈值 false、>阈值 true、阈值 1 时 1MB true；组件级确认/取消流转锚）

- [ ] **Step 1: 失败测试**（Review Focus 3 四边界 + 确认后泵才启动的流转）→ Step 2: 红 → Step 3: 实装 → Step 4: 绿 + typecheck → Step 5: Commit `feat(web): 确认门接线——超阈值先确认后下载（spec §6.4）`

### Task 7: saveAs 管线 + TabContextMenu 第七动作 + 进度卡双动作

**Files:**
- Create: `apps/web/src/lib/saveAs.ts` + `saveAs.test.ts`
- Modify: `apps/web/src/lib/TabContextMenu.svelte` + `apps/web/src/lib/tabsModel.svelte.ts`（第七动作「另存为」：占位/错误 tab 置灰 disabled；动作分发进 saveAs 管线）
- Modify: `apps/web/src/lib/ViewerPane.svelte`（进度卡完成态「另存为」按钮 + 确认卡「下载并另存为」次动作）
- Test: `apps/web/src/lib/saveAs.test.ts` + e2e `apps/web/e2e/b-save-as.spec.ts`

**Interfaces:**
- Produces:
  - `saveAsBlob(blob: Blob, suggestedName: string): Promise<'saved' | 'cancelled'>`——`showSaveFilePicker` 主（suggestedName；NotAllowedError/AbortError → 'cancelled' 静默）、blob URL+download 兜底；
  - `saveAsStreamToDisk(source: FileSource, name: string, pump: (writable: WritableStream) => Promise<File>): Promise<'saved'|'cancelled'>`——FS Access writable 直写 + `handle.getFile()` 回填（供渲染器复用盘 backed File）；
  - `saveAsTab(tab)`——ensure 全量字节（已物化实例在手直用/远端经 Task 2 泵+Task 6 确认门/zip 条目 zipStore 读全量）→ saveAsBlob。

- [ ] **Step 1: 失败测试**：saveAsBlob picker 桩（saved/cancelled 双路 + 权限拒绝静默）、兜底分支（mock 无 showSaveFilePicker → download 属性锚）；saveAsTab 三取数路径（在手/泵 mock/zipStore mock）；TabContextMenu 动作置灰锚（tabsModel 层：占位/错误 tab 返回 disabled）。
- [ ] **Step 2: 红** → Step 3: 实装 → Step 4: 绿 + typecheck → Step 5: e2e（b-save-as.spec.ts：远端 mock store 另存为下载事件锚 + zip 条目另存为锚 + 菜单项置灰锚；desktop only）→ Step 6: 门禁（vitest 根 exit0/typecheck 0E/e2e 新 spec 绿/porcelain 净空）→ Step 7: Commit `feat(web): 另存为统一管线+TabContextMenu 第七动作+进度卡双动作（spec §6.4）`

### 收口

- [ ] 全量门禁：`pnpm vitest run`（根）exit0；`pnpm --filter web typecheck` 0E；e2e b-save-as + 计划 1 的 b-diagram-file 零翻转；porcelain 净空。
