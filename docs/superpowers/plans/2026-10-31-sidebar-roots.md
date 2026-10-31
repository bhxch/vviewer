# 侧栏多根形态统一 + 重叠修复 + tab 徽标消歧 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 侧栏源头行统一升级（chevron 折叠整源树 + hover ✕ + 修复与侧栏折叠钮的重叠）、0 目录空态升级为引导区（含 `ServerConnectForm` 共享组件抽取）、tab 来源徽标改为同名冲突消歧。

**Architecture:** 纯前端三块独立改动：FileTree 源头行（组件内折叠 state，不持久化）；AppShell 空态分支（动作复用 openFlow façade 现有函数，连接表单从 TopBar 抽共享组件）；tabBadge 纯函数（冲突判定需要 tab 名册，签名扩参 TabBar 注入）。

**Tech Stack:** Svelte 5 runes、vitest（纯函数单测；无 runes 组件测试先例，FileTree 行为锚走 playwright e2e）、playwright（双 project chromium/mobile）。

**Spec:** `docs/superpowers/specs/2026-10-31-sidebar-roots-design.md`

## Global Constraints

- 折叠态不持久化：不进会话快照、不进 settings；FileTree 组件局部 state（`{#key treeKey}` 重建即重置 = TreeNodeRow 展开态同先例，知情接受，勿"修复"）。
- 「打开文件夹」不做禁用态：`openDirectoryViaPicker` 已内建 `openDirectoryViaInputFallback` 自动回落，按钮恒可用。
- `ServerConnectForm` 由本 spec 抽取（共享组件），spec 顶栏退役（`2026-10-31-topbar-retirement-design.md`）后续只消费不重建。
- 视觉遵循 `docs/design/ui-design-system.md`（令牌 `--vv-sp-*`/`--vv-fs-*`/`--ui-*`）；不新增公共层 CSS 令牌。
- 既有 a11y 惯例：hover 显隐的元素必须保留 `:focus-visible`/`:focus-within` 可达性；图标按钮带 `aria-label`。
- 门禁命令（仓库根）：`pnpm typecheck`、`pnpm test`（vitest run）、`pnpm --filter web build:e2e` 后 `pnpm --filter web exec playwright test`。vitest 必须仓库根跑（包目录缺 jsdom）。

## Review Focus

- 首个源头行 ✕ 与左栏折叠钮几何重叠（本 spec 的 bug 本体）：桌面断点（≥901px）必须无包围盒相交——e2e 几何断言锁定（Task 4 SRC-03）。
- 同源同名（duplicate tab，spec F 有复制功能）不得触发徽标：冲突计数按**不同 storeId**——单测锁定（Task 1）。
- 未登记来源的单文件 tab（openFiles 通道）不参与冲突名册、也不获得徽标（无 storeLabel 可显）——单测锁定（Task 1）。
- hover 才显的 ✕ 对 playwright 仍可点击（opacity:0 非 display:none），既有 FTSRC 锚不得翻转——Task 4 复跑验证。
- 键盘用户：chevron 与 ✕ 均 Tab 可达，✕ 在 `:focus-within` 下强制可见——e2e 键盘聚焦断言（Task 4 SRC-02）。

---

### Task 1: tabBadge 同名冲突消歧（纯函数 + TabBar 接线）

**Files:**
- Modify: `apps/web/src/lib/tabBadge.ts`
- Modify: `apps/web/src/lib/tabBadge.test.ts`
- Modify: `apps/web/src/lib/TabBar.svelte:38-40`（`badgeOfFor`）

**Interfaces:**
- Consumes: 现有 `Tab`（`./openFlow.svelte`，`tab.source.{storeId,name,path}`）、`WorkspaceSource`（`./workspaceStore`，`storeId/storeLabel/kind`）。
- Produces: `badgeOf(sources: WorkspaceSource[], tabs: Tab[], tab: Tab): string | null`（签名扩参，TabBar 注入本组 `tabs`）。

- [ ] **Step 1: 重写 `tabBadge.test.ts` 用例（先红）**

保留文件既有测试风格（直接 import `badgeOf`，手工构造 `sources`/`tab` 最小对象）。用例集：
1. `sources.length < 2` → `null`（不变）。
2. 两来源、两 tab 名不同 → 双双 `null`（**翻转现行行为**：现行恒显 label——旧断言删除）。
3. 两来源、同名文件各一 tab → 双方均返回各自 `storeLabel`。
4. 三来源、同名只出现在其中两源 → 仅那两个 tab 有徽标，第三源同源外 tab `null`。
5. 同一来源内 duplicate 两个同名 tab（同 storeId 同 name）→ `null`（同源不算冲突）。
6. 同名冲突 + remote 单文件来源抑制（`kind==='remote' && path!=='' && label===name`）→ 该 tab `null`、对手 tab 正常徽标（不对称成立）。
7. 目录 tab（`path===''`）同名跨源 → 参与冲突、有徽标。
8. 名册只含已登记来源的 tab：未登记 storeId 的 tab（openFiles 单文件）同名不触发冲突，自身恒 `null`。

- [ ] **Step 2: 跑测试确认红**

Run: `pnpm vitest run apps/web/src/lib/tabBadge.test.ts`（仓库根）
Expected: FAIL（签名不符/断言翻转）

- [ ] **Step 3: 实现 `badgeOf(sources, tabs, tab)`**

```ts
export function badgeOf(sources: WorkspaceSource[], tabs: Tab[], tab: Tab): string | null {
  if (sources.length < 2) return null;
  const eligible = tabs.filter((t) => sources.some((s) => s.storeId === t.source.storeId));
  const conflict = eligible.some((t) => t.source.name === tab.source.name && t.source.storeId !== tab.source.storeId);
  if (!conflict) return null;
  const src = sources.find((s) => s.storeId === tab.source.storeId);
  const label = src?.storeLabel ?? null;
  if (src?.kind === 'remote' && tab.source.path !== '' && label === tab.source.name) return null;
  return label;
}
```
头部 JSDoc 注释改写：消歧语义（同名跨源才显）+ 保留原 remote 抑制说明。

- [ ] **Step 4: TabBar 接线**

`badgeOfFor(tab)` 改为 `badgeOf(sources, tabs, tab)`（props 已有 `tabs`/`sources`，零新传参）。

- [ ] **Step 5: 跑测试绿 + typecheck**

Run: `pnpm vitest run apps/web/src/lib/tabBadge.test.ts && pnpm typecheck`
Expected: PASS / 0E

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/lib/tabBadge.ts apps/web/src/lib/tabBadge.test.ts apps/web/src/lib/TabBar.svelte
git commit -m "feat(sidebar): tab 来源徽标改同名跨源消歧——恒显造成拥挤，仅歧义时区分"
```

### Task 2: FileTree 源头行升级（chevron 折叠 + hover ✕ + 重叠让位）

**Files:**
- Modify: `apps/web/src/lib/FileTree.svelte`

**Interfaces:**
- Consumes: `roots`（组件内既有 `$state`，键 `src.storeId`）。
- Produces: DOM 契约（e2e 依赖）——`.vv-tree-src-toggle`（aria-expanded）、`.vv-tree-src` 保持、`.vv-tree-src-remove` 保持类名与 click 语义、折叠时该源 `.vv-tree-group` 不渲染。

- [ ] **Step 1: 折叠 state + 标记改动**

组件 script 增：
```ts
/** 源级折叠（本 spec §2.1）：storeId → 是否折叠；局部 state 不持久化，
 *  {#key treeKey} 整树重建时随组件重建重置（TreeNodeRow 展开态同先例） */
let collapsed = $state<Record<string, boolean>>({});
function toggleCollapse(storeId: string): void {
  collapsed = { ...collapsed, [storeId]: !collapsed[storeId] };
}
```
每个源的 markup 改为：`.vv-tree-src` 内首列加
```svelte
<button type="button" class="vv-tree-src-toggle" aria-label="折叠/展开 {src.label}"
  aria-expanded={!collapsed[src.storeId]}
  onclick={() => toggleCollapse(src.storeId)}>{collapsed[src.storeId] ? '▸' : '▾'}</button>
```
`<ul class="vv-tree-group">` 包 `{#if !collapsed[src.storeId]}`。

- [ ] **Step 2: 样式（scoped）**

`.vv-tree-src` 加 `padding-right: 34px`（右侧让位侧栏折叠钮 24px 命中区 + 10px 间隙——重叠修复本体，注释写明根因：`app.css` `.vv-collapse-left` absolute top:6 right:6 24×24）；`.vv-tree-src-toggle`（border:0/background:none/font:inherit 载入字形、`flex:none`、`padding:0`、cursor:pointer、与 label 同色）；`.vv-tree-src-remove` 加 `opacity: 0; transition: opacity .12s`，`.vv-tree-src:hover .vv-tree-src-remove, .vv-tree-src:focus-within .vv-tree-src-remove { opacity: 1 }`（键盘等价）。

- [ ] **Step 3: 验证（本任务无组件测试先例，行为锚在 Task 4 e2e）**

Run: `pnpm typecheck`
Expected: 0E

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/lib/FileTree.svelte
git commit -m "feat(sidebar): 源头行 chevron 折叠整源树+hover 显移除钮——行右让位修折叠钮重叠"
```

### Task 3: ServerConnectForm 抽取 + 0 目录空态引导区

**Files:**
- Create: `apps/web/src/lib/ServerConnectForm.svelte`
- Modify: `apps/web/src/lib/TopBar.svelte`（删内联表单，改消费共享组件）
- Modify: `apps/web/src/lib/AppShell.svelte`（空态分支 + imports + 挂载 state）

**Interfaces:**
- Produces: `ServerConnectForm` props `{ onconnected?: () => void }`——内部自持 `serverUrl/serverToken/connecting/serverError` state、`onMount` 时 `loadLastServer()` 预填、提交调 `connectServer(url, token)` 成功后清空并调 `onconnected?.()`。DOM 契约：`form.vv-server-form` + 两个 input（aria-label 服务器地址/访问令牌）+ 提交钮 + `.vv-server-error[role=alert]`。
- Consumes: `connectServer`/`loadLastServer`（`./openFlow.svelte` 与 `./serverConnect.svelte` 按 TopBar 现行 import 路径）；`openDirectoryViaPicker`/`openUrl`（`./openFlow.svelte`，AppShell 空态用）。

- [ ] **Step 1: 建 `ServerConnectForm.svelte`**

迁移 TopBar 的 `connect()`（`TopBar.svelte:239-258`）与 `toggleServerPanel` 的预填半段（`serverUrl===''` 时 `loadLastServer()` 填 url/token）为组件内逻辑；markup 迁移 `.vv-server-form` 表单块（`TopBar.svelte:352-368`，aria-label 原样保留）。样式零迁移（`.vv-server-form` 在 `app.css:345-347` 全局）。

- [ ] **Step 2: TopBar 改消费**

删 `serverUrl/serverToken/connecting/serverError` state 与 `connect()`/预填段；`{#if serverOpen}` 内替换为 `<ServerConnectForm onconnected={() => (serverOpen = false)} />`；`toggleServerPanel` 收敛为纯开合。

- [ ] **Step 3: AppShell 空态分支**

`{:else}` 分支（AppShell `:1030`）替换为引导区：
```svelte
<div class="vv-side-empty">
  <p class="vv-side-empty-title">未打开文件夹</p>
  <button type="button" onclick={() => openDirectoryViaPicker()}>打开文件夹</button>
  <button type="button" onclick={() => (emptyServerOpen = !emptyServerOpen)}>连接服务器</button>
  {#if emptyServerOpen}<ServerConnectForm onconnected={() => (emptyServerOpen = false)} />{/if}
  <form class="vv-side-empty-url" onsubmit={submitEmptyUrl}>
    <input placeholder="粘贴文件 URL" bind:value={emptyUrl} aria-label="文件 URL" />
    <button type="submit">打开</button>
  </form>
  <p class="vv-side-empty-hint">也可直接拖入文件/文件夹</p>
</div>
```
`submitEmptyUrl`：`e.preventDefault()` → `emptyUrl.trim()` 非空 `openUrl(url)` 并清空。imports 增 `openDirectoryViaPicker`/`openUrl`/`ServerConnectForm`。样式落 `.vv-side-empty` 现有定义处（现无 app.css 命中，落 AppShell scoped style）：竖排居中、按钮体系用 ui-design-system 令牌、hint 用 muted 色。空态引导按钮**不加禁用态**（Global Constraints）。

- [ ] **Step 4: 验证**

Run: `pnpm typecheck`
Expected: 0E

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/lib/ServerConnectForm.svelte apps/web/src/lib/TopBar.svelte apps/web/src/lib/AppShell.svelte
git commit -m "feat(sidebar): 0 目录空态引导区+ServerConnectForm 共享组件抽取——顶栏退役前置"
```

### Task 4: e2e 锚（新 SRC 域 + 既有锚复跑）

**Files:**
- Create: `apps/web/e2e/b-sidebar-roots.spec.ts`
- Modify: `apps/web/e2e/b-filetree-src-remove.spec.ts`（补 hover 揭示断言）

**Interfaces:**
- Consumes: `b-filetree-src-remove.spec.ts` 既有装置（本地源 + fake server remote 源的构造方式照抄该文件）；`waitAppMounted` 装置（`apps/web/e2e/` 共享 helper，先例同文件）。
- Produces: SRC-01..04 用例（双 project 惯例遵循 playwright.config 现状）。

- [ ] **Step 1: `b-sidebar-roots.spec.ts` 四用例**

1. **SRC-01 折叠**：本地源树展开 → 点击 `.vv-tree-src-toggle` → `aria-expanded=false` 且该源 `.vv-tree-group` 数为 0 → 再点恢复。折叠后另一源不受影响（多源装置时）。
2. **SRC-02 键盘可达**：`page.keyboard` Tab 聚焦 `.vv-tree-src-remove` → 断言其 computed opacity 为 `1`（`:focus-within` 揭示）。
3. **SRC-03 几何不重叠**：桌面视口，取 `.vv-collapse-btn.vv-collapse-left` 与首个 `.vv-tree-src-remove` 的 `boundingBox()`，断言两矩形不相交（手写相交判定，无断言库依赖）。
4. **SRC-04 空态引导**：无来源会话（清 IndexedDB/新 context）→ `.vv-side-empty` 可见 → 点「连接服务器」出现 `.vv-server-form` → 「打开文件夹」按钮可见且 enabled → URL 行 input 可见。断言不含真实连接/打开。

- [ ] **Step 2: `b-filetree-src-remove.spec.ts` 补断言**

FTSRC-01 点击移除前加一行：hover `.vv-tree-src` 后 `.vv-tree-src-remove` 可见（opacity 揭示不破坏既有点击路径的显式锚）。

- [ ] **Step 3: 重建 + 定向跑**

Run: `pnpm --filter web build:e2e && pnpm --filter web exec playwright test b-sidebar-roots b-filetree-src-remove t-workspace b-wsx-recovery`
Expected: 全绿（t-workspace/b-wsx-recovery 为受 Task 1 徽标翻转影响的回归面；若 t-workspace 有恒显徽标断言翻转，按消歧新语义更新锚：无冲突不显 + 构造同名冲突显示，修改须在提交说明列明逐锚理由）。
注意：跑前确认语料已在（`node tools/fetch-e2e-corpus.mjs` 幂等），且本任务改动过产品代码必须 `build:e2e` 重建（H11 铁律）。

- [ ] **Step 4: 全量门禁**

Run: `pnpm typecheck && pnpm test && pnpm --filter web build:e2e && pnpm --filter web exec playwright test`
Expected: typecheck 0E / vitest 全绿（既有恒显断言已在 Task 1 翻转）/ playwright 双 project 零翻转（计时型既有 flaky 除外，复跑定性）。

- [ ] **Step 5: Commit**

```bash
git add apps/web/e2e/b-sidebar-roots.spec.ts apps/web/e2e/b-filetree-src-remove.spec.ts apps/web/e2e/t-workspace.spec.ts
git commit -m "test(sidebar): SRC-01..04 锚+徽标消歧回归面——几何断言锁重叠修复"
```

## Self-Review 记录

- 规格覆盖：§2.1 源头行（Task 2）、§2.2 重叠（Task 2 样式 + Task 4 SRC-03）、§2.3 空态（Task 3 + SRC-04）、§2.4 徽标（Task 1 + Task 1 用例集）——全覆盖；folder 图标位属 spec ①（消费点），本计划不预置（YAGNI）。
- 类型一致：`badgeOf(sources, tabs, tab)` 三处一致（test/impl/TabBar）；`ServerConnectForm` props 单一 `onconnected` 两消费点一致。
- Review Focus 五条均有归属测试（SRC-03/Task1-用例5/Task1-用例8/FTSRC 补断言/SRC-02）。
- 比例：4 任务、计划长度 < spec 2 倍，无转录体。
