# 渲染器自选展开 × 签名扩表 × 编码探测升级 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 三议题一次收口「文件内容与扩展名/识别结果不符」：①打开方式三入口「更多渲染器」展开；②magic 签名表扩容（av/image/archive 强签名族）；③编码探测升级（UTF-32 BOM + chardet 精判分层）。

**Architecture:** 议题一纯 web 候选面（数据单点 `openWithOf` + 三壳交互，零新机制）；议题二 core 探测表扩列（`sniffSignature` + `SIGNATURE_ROUTES` 同步，选路链零改动）；议题三快路径不动、重探测懒加载（`redetectWithFull` async 化内联精判，6 处调用点机械 await）。

**Tech Stack:** Svelte 5（runes）/ TypeScript / vitest（仓库根跑）/ Playwright / chardet@^2.2.0（新增依赖，MIT）。

**Spec:** `docs/superpowers/specs/2026-10-28-renderer-picker-signature-encoding-design.md`（计划从 spec 论证，执行者两份都读）。

## Global Constraints

- 每任务独立 commit，message 用 Conventional Commits 中文（why 在前，见各任务 Step-commit）。
- vitest 一律在**仓库根**跑（包目录直跑缺 jsdom）；playwright 在 `apps/web/` 下跑，跑前必须 `pnpm build:e2e` 重建（裸 `pnpm --filter web build` 会冲掉 CDN 注入使 GRF 系假红——历史教训）。
- typecheck 门禁 = 仓库根 `pnpm typecheck`（tsc -b 全包）；apps/web 另有 `svelte-check`（在 apps/web 下跑）。
- `Encoding` 联合扩列后 `DECODERS` 编译错是**预期机制**（单源强制补表），不是要绕过的障碍。
- e2e 文件注入惯例 = 页内构造 File 经 `__vvOpenDirImpl`（`apps/web/e2e/b-binary-hex-archive.spec.ts` 的 `openDir` 装置），fixture 程序化构造，不引入二进制入库文件。
- chardet v2 API 实测锚（2026-10-28 probe）：`import('chardet')` 命名空间导出 `detect/analyse`；`analyse(bytes)` 返回 `{ confidence, name, lang }[]`，**confidence 为 0–10 量纲**（实测 `confidence:10`），spec 阈值 0.90 折算 **≥9.0**；`detect` 返回名称字符串（如 `"Shift_JIS"`）。
- 全程不 push（完成后统一由用户流程推送）。

---

## 议题一：渲染器自选「更多」就地展开

### Task 1: `FileOpenWith.all` 数据面

**Files:**
- Modify: `apps/web/src/lib/openWith.ts`（`openWithOf` 返回值）
- Modify: `apps/web/src/lib/metaStore.svelte.ts:7-13`（`FileOpenWith` 接口）
- Modify: `apps/web/src/lib/RendererPickerMenu.ts`（哨兵常量）
- Test: `apps/web/src/lib/openWith.test.ts`

**Interfaces:**
- Consumes: `registry.all()`（core Registry 既有方法）。
- Produces: `FileOpenWith.all: { id: string; label: string }[]`（registry 注册序全量）；哨兵常量 `MORE_RENDERER_ID = '__more__'`、`LESS_RENDERER_ID = '__less__'`（Task 2/3 消费）。

- [ ] **Step 1: 写失败测试**

在 `apps/web/src/lib/openWith.test.ts` 既有 `describe` 内追加：

```ts
it('all = registry 全量（注册序），与受限 options 同点算出', () => {
  const res = openWithOf(makeRegistry(), undefined, 'image', 'png');
  // makeRegistry 安装序：code, markdown, image, hex
  expect(res.all.map((o) => o.id)).toEqual(['code', 'markdown', 'image', 'hex']);
  // 受限 options 不变（.png 命中 image，markdown/hex 恒兜底）
  expect(res.options.map((o) => o.id)).toEqual(['', 'image', 'code', 'markdown', 'hex']);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run apps/web/src/lib/openWith.test.ts`
Expected: FAIL（`res.all` 为 undefined）

- [ ] **Step 3: 最小实现**

`metaStore.svelte.ts` 的 `FileOpenWith` 接口（:7-13）追加字段：

```ts
  /** 全量渲染器候选（议题一 §2.1）：registry.all() 注册序，与受限 options 同点
   * 算出；「更多渲染器」展开面数据源。error 未注册天然不在。 */
  all: { id: string; label: string }[];
```

`openWith.ts` 的 `openWithOf` 返回语句改为：

```ts
  const all = registry.all().map((r) => ({ id: r.id, label: r.label }));
  return { current: overrideRenderer ?? '', manual: overrideRenderer !== undefined, options, all };
```

`RendererPickerMenu.ts` 顶部（import 后）追加哨兵常量：

```ts
/** 「更多/收起附加候选」哨兵 id（议题一）：纯 UI 语义项，不进 FileOpenWith 数据面，
 * 三壳渲染「更多渲染器…」/「收起」时作 option id 使用，选择处拦截面见各壳。 */
export const MORE_RENDERER_ID = '__more__';
export const LESS_RENDERER_ID = '__less__';
```

- [ ] **Step 4: 跑测试确认通过 + 全量 typecheck**

Run: `pnpm vitest run apps/web/src/lib/openWith.test.ts apps/web/src/lib/rendererPickerMenu.test.ts && pnpm typecheck`
Expected: PASS；typecheck 若在 ViewerPane/MetaPanel 处报 `FileOpenWith` 缺 `all` 的构造错，随 Task 2 修复——本任务先确认报错面仅限三壳的 ow 构造/透传处（openWithOf 是唯一生产点，透传处类型自动收窄，预期零报错；若出现其他报错当场修）。

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/lib/openWith.ts apps/web/src/lib/metaStore.svelte.ts apps/web/src/lib/RendererPickerMenu.ts apps/web/src/lib/openWith.test.ts
git commit -m "feat(web): FileOpenWith 增 all 全量候选——三入口「更多渲染器」展开的数据单点"
```

### Task 2: MetaPanel 下拉与状态栏浮层就地展开

**Files:**
- Modify: `apps/web/src/lib/MetaPanel.svelte`（`openWithUi` derived 约 :41-56、select 标记约 :201-215）
- Modify: `apps/web/src/lib/ViewerPane.svelte`（指示器状态约 :82-126、pickRenderer、候选浮层标记 `{#if pickerOpen}` 块）
- Test: `apps/web/e2e/b-open-with-more.spec.ts`（新建，Task 4 统一跑；本任务先保证 typecheck/svelte-check 绿）

**Interfaces:**
- Consumes: Task 1 的 `FileOpenWith.all`、`MORE_RENDERER_ID`/`LESS_RENDERER_ID`。
- Produces: 三壳中两壳的就地展开交互；展开态为组件局部 `$state`，不持久化。

- [ ] **Step 1: MetaPanel 实现展开态**

`MetaPanel.svelte`：

```ts
import { MORE_RENDERER_ID, LESS_RENDERER_ID } from './RendererPickerMenu';
// ...openWithUi derived 的返回对象补 all 字段（openWithUi 由 rendererCandidatesOfTab
// 聚合而来、没有 FileOpenWith.all，须就地补：registry 在本组件已入作用域）：
const openWithUi = $derived.by(() => {
  const tab = tabStore.list.find((t) => t.active);
  if (!tab) return null;
  const candidates = rendererCandidatesOfTab(registry, tab);
  return {
    options: candidates,
    current: candidates.find((c) => c.current)?.id ?? '',
    manual: tab.overrideRenderer !== undefined,
    all: registry.all().map((r) => ({ id: r.id, label: r.label }))
  };
});

/** 展开态（议题一 §2.2）：select 内就地切换受限候选 ↔ 全量候选，组件局部不持久化 */
let openWithExpanded = $state(false);

const openWithOptions = $derived.by(() => {
  const ow = openWithUi;
  if (!ow) return [];
  if (openWithExpanded) {
    return [
      { id: '', label: '自动（按扩展名）' },
      ...ow.all,
      { id: LESS_RENDERER_ID, label: '收起附加候选' }
    ];
  }
  return [...ow.options, { id: MORE_RENDERER_ID, label: '更多渲染器…' }];
});

function onOpenWithChange(id: string): void {
  if (id === MORE_RENDERER_ID) { openWithExpanded = true; return; }
  if (id === LESS_RENDERER_ID) { openWithExpanded = false; return; }
  onOpenWith(id);
}
```

select 标记（:201-215）改为：

```svelte
<select
  class="meta-openwith"
  aria-label="打开方式"
  value={openWithUi.current}
  onchange={(e) => onOpenWithChange(e.currentTarget.value)}
>
  {#each openWithOptions as opt (opt.id)}
    <option value={opt.id}>{opt.label}</option>
  {/each}
</select>
```

- [ ] **Step 2: ViewerPane 浮层实现展开态**

`ViewerPane.svelte`：候选状态旁（:86-89 附近）追加 `openWithFull` 全量持有与展开态：

```ts
import { MORE_RENDERER_ID, LESS_RENDERER_ID } from './RendererPickerMenu';
import type { FileOpenWith } from './metaStore.svelte';
// 候选浮层数据（议题一）：受限候选照旧，另持 openWithOf 全量结果供展开面
let openWithFull = $state<FileOpenWith | null>(null);
let pickerExpanded = $state(false);
```

在既有给 `openWithCandidates` 赋值的效果/回调处（`const ow = openWithOf(...)` 之后，约 :370），同步 `openWithFull = ow;`。

浮层项列表派生（放 pickRenderer 前）：

```ts
const pickerItems = $derived.by(() => {
  const ow = openWithFull;
  if (!ow) return [];
  const mark = (o: { id: string; label: string }) => ({
    id: o.id, label: o.label, current: o.id === ow.current
  });
  return pickerExpanded
    ? [...ow.all.map(mark), { id: LESS_RENDERER_ID, label: '收起附加候选', current: false }]
    : [...openWithCandidates, { id: MORE_RENDERER_ID, label: '更多渲染器…', current: false }];
});
```

`pickRenderer`（:120-127）改为哨兵拦截：

```ts
function pickRenderer(id: string): void {
  if (id === MORE_RENDERER_ID) { pickerExpanded = true; return; }
  if (id === LESS_RENDERER_ID) { pickerExpanded = false; return; }
  pickerOpen = false;
  const t = tab;
  if (!t) return;
  tabStore.setRendererOverride(t.id, id === '' ? null : id);
}
```

浮层标记 `{#if pickerOpen}` 块内，把遍历 `openWithCandidates` 渲染菜单项的 `{#each}` 数据源换成 `pickerItems`（其余结构/类名不动）。

- [ ] **Step 3: typecheck + svelte-check + 既有单测**

Run: `pnpm typecheck && cd apps/web && npx svelte-check --tsconfig ./tsconfig.json && cd ../.. && pnpm vitest run apps/web/src/lib/`
Expected: 全绿（哨兵不进数据面，既有单测零翻转）

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/lib/MetaPanel.svelte apps/web/src/lib/ViewerPane.svelte
git commit -m "feat(web): 打开方式 MetaPanel 下拉与状态栏浮层「更多渲染器」就地展开"
```

### Task 3: TabBar 右键嵌套子菜单

**Files:**
- Modify: `apps/web/src/lib/TabBar.svelte`（`ctxActions` derived 约 :82-100 的「打开方式」项）
- Modify: `apps/web/src/lib/TabContextMenu.svelte`（仅当二级嵌套不被支持时补递归渲染，见 Step 2）

**Interfaces:**
- Consumes: `registry.all()`（TabBar 已 import registry）。
- Produces: 壳 B 的「打开方式 ▸ 更多渲染器 ▸ 全量」二级子菜单。**形态裁决**：菜单项点击即关菜单，就地展开不可行——用 TabCtxEntry 原生 `children` 嵌套（语义不变：默认受限，更多=任意）。

- [ ] **Step 1: 核实 TabContextMenu 嵌套能力**

读 `apps/web/src/lib/TabContextMenu.svelte`（或 .ts）中 children 的渲染分支。若为递归渲染（children 里还可有 children）→ 直接 Step 3；若只渲染一层 → 按其既有 children 渲染分支补一层递归（同款样式类与 hover 展开），不引入新交互范式。

- [ ] **Step 2: （仅当需要）TabContextMenu 补二级递归渲染**

按 Step 1 读到的渲染结构，把 children 渲染抽成可递归片段（Svelte 5 用 `{#snippet}` 或提取子组件，随文件既有风格），确保 `entry.children?.length` 时渲染展开箭头 + hover 子菜单。

- [ ] **Step 3: ctxActions 打开方式项加嵌套子菜单**

`TabBar.svelte` 的「打开方式」项（约 :96-102）改为：

```ts
{
  label: '打开方式',
  children: [
    ...rendererCandidatesOfTab(registry, tab).map((c) => ({
      label: c.current ? `✓ ${c.label}` : c.label,
      onClick: () => tabStore.setRendererOverride(tab.id, c.id === '' ? null : c.id)
    })),
    {
      label: '更多渲染器',
      children: registry.all().map((r) => ({
        label:
          tab.overrideRenderer !== undefined && r.id === tab.overrideRenderer
            ? `✓ ${r.label}`
            : r.label,
        onClick: () => tabStore.setRendererOverride(tab.id, r.id)
      }))
    }
  ]
}
```

- [ ] **Step 4: typecheck + svelte-check**

Run: `pnpm typecheck && cd apps/web && npx svelte-check --tsconfig ./tsconfig.json`
Expected: 全绿

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/lib/TabBar.svelte apps/web/src/lib/TabContextMenu.svelte
git commit -m "feat(web): Tab 右键「打开方式」嵌套「更多渲染器」二级子菜单"
```

### Task 4: 议题一 e2e（新场景 + 既有锚回归）

**Files:**
- Create: `apps/web/e2e/b-open-with-more.spec.ts`
- Modify: 既有 OWX 系 spec 中被翻转的断言（如有）

**Interfaces:**
- Consumes: Task 1-3 全部产物；`openDir` 装置模式（`b-binary-hex-archive.spec.ts:52-64`）。

- [ ] **Step 1: 写新场景 spec**

`apps/web/e2e/b-open-with-more.spec.ts`（文件头注释注明域文档条目 OWM-01~03）：

```ts
import { test, expect, type Page } from '@playwright/test';

async function openTextFile(page: Page, name = 'aa.txt'): Promise<void> {
  await page.waitForFunction(
    () => typeof (window as unknown as { __vvOpenDirImpl?: unknown }).__vvOpenDirImpl === 'function'
  );
  await page.evaluate((n) => {
    const f = new File(['hello vviewer'], n, { type: 'text/plain' });
    Object.defineProperty(f, 'webkitRelativePath', { value: `owm/${n}` });
    return (window as unknown as { __vvOpenDirImpl: (f: File[]) => void }).__vvOpenDirImpl([f]);
  }, name);
}

test.describe('打开方式「更多渲染器」展开（OWM）', () => {
  test('OWM-01 MetaPanel：受限候选尾有「更多渲染器…」，激活后展开全量并可选 archive', async ({ page }) => {
    await page.goto('/');
    await openTextFile(page, 'aa.txt');
    const sel = page.locator('.meta-openwith');
    await expect(sel).toBeVisible();
    // .txt 受限候选：自动/code/markdown/hex + 更多渲染器…
    const more = sel.locator('option', { hasText: '更多渲染器…' });
    await expect(more).toHaveCount(1);
    await sel.selectOption('__more__');
    // 展开面 = 自动 + 全量 12 + 收起
    await expect(sel.locator('option')).toHaveCount(14);
    await expect(sel.locator('option', { hasText: '收起附加候选' })).toHaveCount(1);
    await sel.selectOption('archive');
    // 全量选择即时重渲染：override 生效 + （手动）徽标
    await expect(sel).toHaveValue('archive');
    await expect(page.locator('.meta-openwith-manual')).toBeVisible();
  });

  test('OWM-02 状态栏浮层：更多渲染器… 就地展开，选 jsonl 生效', async ({ page }) => {
    await page.goto('/');
    await openTextFile(page, 'aa.txt');
    // 指示器钮在状态栏内，候选浮层由点击弹出（既有壳 A 交互）
    await page.locator('.vv-statusbar [aria-label="渲染器"]').click();
    const more = page.getByRole('button', { name: '更多渲染器…' });
    await more.click();
    await page.getByRole('button', { name: 'jsonl-label' }).click(); // label 以 registry 实际为准，见 Step 3 校准
    const sel = page.locator('.meta-openwith');
    await expect(sel).toHaveValue('jsonl');
  });

  test('OWM-03 Tab 右键：打开方式 ▸ 更多渲染器 二级子菜单可选 pdf', async ({ page }) => {
    await page.goto('/');
    await openTextFile(page, 'aa.txt');
    await page.getByRole('tab', { name: /aa\.txt/ }).click({ button: 'right' });
    await page.getByRole('menuitem', { name: '打开方式' }).hover();
    await page.getByRole('menuitem', { name: '更多渲染器', exact: true }).hover();
    await page.getByRole('menuitem', { name: 'pdf-label', exact: true }).click(); // label 见 Step 3 校准
    await expect(page.locator('.meta-openwith')).toHaveValue('pdf');
  });
});
```

- [ ] **Step 2: 校准选择器与 label**

跑前先核对四处事实并就地修正上面标校准的占位：①状态栏指示器钮的真实 aria-label/类名与浮层项的元素形态（读 `ViewerPane.svelte` 状态栏/浮层标记段——OWM-02 的 `getByRole('button', ...)` 若与实况不符以实况为准）；②registry 中 jsonl/pdf 的真实 label 值（`packages/render-text/src/jsonl/index.ts` 与 `packages/render-doc/src/pdf.ts` 的 `label` 字段）；③菜单项 role（TabContextMenu 渲染的是 `role="menuitem"` 还是自定义——对照 `t-tab-actions.spec.ts` 既有 `menuitem` 用法）；④tab 定位装置复用 `t-tab-actions.spec.ts` 既有 helper（`tabNamed` 等），OWM-03 的 `getByRole('tab', ...)` 按实况替换。OWM-02 的 `jsonl-label`/OWM-03 的 `pdf-label` 替换为真实 label 字符串。

- [ ] **Step 3: 重建 + 跑新 spec + 回归 OWX 系**

Run: `pnpm build:e2e && cd apps/web && npx playwright test b-open-with-more && npx playwright test t-open-with b-error-card-open-as b-override-lang t-tab-actions`
Expected: 新 spec 3 用例绿；既有 spec 零翻转（selectOption 按 value 选择不受哨兵项影响；若个别锚断言了候选**全量数组/条数**，按「尾追哨兵项/展开面语义」更新期望值并在断言行尾注记 `// 议题一`）。

- [ ] **Step 4: Commit**

```bash
git add apps/web/e2e/b-open-with-more.spec.ts apps/web/e2e/
git commit -m "test(e2e): 打开方式「更多渲染器」三入口场景 OWM-01..03 + OWX 系锚更新"
```

---

## 议题二：magic 签名表扩容

### Task 5: sniffSignature 扩表 + SIGNATURE_ROUTES 同步

**Files:**
- Modify: `packages/core/src/types.ts:82`（signature 联合）
- Modify: `packages/core/src/detect/magic.ts`（`sniffSignature` + `startsWith` 加 offset 参）
- Modify: `packages/core/src/dispatch/dispatcher.ts:79-86`（`SIGNATURE_ROUTES`）
- Test: `packages/core/test/detect.test.ts`（追加）

**Interfaces:**
- Produces: signature 联合新值 `'mp4' | 'm4a' | 'avif' | 'webm' | 'webp' | 'wav' | 'ico' | 'gz' | '7z' | 'rar' | 'flac' | 'ogg' | 'bmp'`；`SIGNATURE_ROUTES` 对每个新值有路由（ole 维持无路由）。`signatureRouteOf` 既有导出不变。

- [ ] **Step 1: 写失败测试**

`packages/core/test/detect.test.ts` 追加（沿用文件既有 import；`sniffSignature`/`signatureRouteOf` 需要的话补 import，后者从 `@vviewer/core` 包根或 `../src/dispatch/dispatcher` 按文件既有导入风格取）：

```ts
describe('议题二：签名表扩容', () => {
  const head = (bytes: number[]): Uint8Array => new Uint8Array(bytes);

  it('ftyp 品牌分派：isom→mp4、M4A →m4a、avif→avif、未知品牌不命中', () => {
    const mk = (brand: string): Uint8Array => {
      const b = new Uint8Array(12);
      b.set([0x00, 0x00, 0x00, 0x18], 0);
      b.set(new TextEncoder().encode('ftyp'), 4);
      b.set(new TextEncoder().encode(brand), 8);
      return b;
    };
    expect(sniffSignature(mk('isom'))).toBe('mp4');
    expect(sniffSignature(mk('mp42'))).toBe('mp4');
    expect(sniffSignature(mk('M4A '))).toBe('m4a');
    expect(sniffSignature(mk('avif'))).toBe('avif');
    expect(sniffSignature(mk('avis'))).toBe('avif');
    expect(sniffSignature(mk('xxxx'))).toBeNull();
  });

  it('强签名族逐值命中', () => {
    expect(sniffSignature(head([0x1a, 0x45, 0xdf, 0xa3]))).toBe('webm');
    expect(sniffSignature(new TextEncoder().encode('RIFF0000WEBP') as unknown as Uint8Array)).toBe('webp');
    expect(sniffSignature(new TextEncoder().encode('RIFF0000WAVE') as unknown as Uint8Array)).toBe('wav');
    expect(sniffSignature(head([0, 0, 1, 0, 0, 0]))).toBe('ico');
    expect(sniffSignature(head([0x1f, 0x8b, 0x08, 0x00]))).toBe('gz');
    expect(sniffSignature(head([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]))).toBe('7z');
    expect(sniffSignature(head([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x00]))).toBe('rar');
    expect(sniffSignature(new TextEncoder().encode('fLaC') as unknown as Uint8Array)).toBe('flac');
    expect(sniffSignature(new TextEncoder().encode('OggS') as unknown as Uint8Array)).toBe('ogg');
  });

  it('bmp 保留字段强校验：BM+保留四字节非零不命中（文本 "BM…" 防误伤）', () => {
    const bmp = head([0x42, 0x4d, 0x46, 0x00, 0x00, 0x00, 0, 0, 0, 0, 0, 0]);
    expect(sniffSignature(bmp)).toBe('bmp');
    const fake = new TextEncoder().encode('BMW M4 文档') as unknown as Uint8Array;
    expect(sniffSignature(fake)).toBeNull();
  });

  it('SIGNATURE_ROUTES 全新值有路由且 ext 纠偏正确（ole 维持无路由）', () => {
    expect(signatureRouteOf('mp4')).toEqual({ rendererId: 'av', ext: 'mp4' });
    expect(signatureRouteOf('m4a')).toEqual({ rendererId: 'av', ext: 'm4a' });
    expect(signatureRouteOf('avif')).toEqual({ rendererId: 'image', ext: 'avif' });
    expect(signatureRouteOf('webm')).toEqual({ rendererId: 'av', ext: 'webm' });
    expect(signatureRouteOf('webp')).toEqual({ rendererId: 'image', ext: 'webp' });
    expect(signatureRouteOf('wav')).toEqual({ rendererId: 'av', ext: 'wav' });
    expect(signatureRouteOf('ico')).toEqual({ rendererId: 'image', ext: 'ico' });
    expect(signatureRouteOf('gz')).toEqual({ rendererId: 'archive', ext: 'gz' });
    expect(signatureRouteOf('7z')).toEqual({ rendererId: 'archive', ext: '7z' });
    expect(signatureRouteOf('rar')).toEqual({ rendererId: 'archive', ext: 'rar' });
    expect(signatureRouteOf('flac')).toEqual({ rendererId: 'av', ext: 'flac' });
    expect(signatureRouteOf('ogg')).toEqual({ rendererId: 'av', ext: 'ogg' });
    expect(signatureRouteOf('bmp')).toEqual({ rendererId: 'image', ext: 'bmp' });
    expect(signatureRouteOf('ole')).toBeNull();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run packages/core/test/detect.test.ts`
Expected: FAIL（新签名返回 null / signatureRouteOf 类型错）

- [ ] **Step 3: 实现**

`types.ts:82` signature 联合扩为：

```ts
  signature?: 'zip' | 'ole' | 'png' | 'jpeg' | 'gif' | 'pdf' | 'mpegts'
    | 'mp4' | 'm4a' | 'avif' | 'webm' | 'webp' | 'wav' | 'ico' | 'gz' | '7z' | 'rar' | 'flac' | 'ogg' | 'bmp' | null;
```

`magic.ts`：`startsWith` 助手加偏移参 `const startsWith = (head: Uint8Array, sig: readonly number[], at = 0): boolean => sig.every((v, i) => head[at + i] === v);`；`sniffSignature` 在 mpegts 判定之后追加（顺序无关，互斥前缀）：

```ts
  // —— 议题二扩表：全部映射到真有渲染器消费的格式（spec §3.2）；mp3 无稳定前缀不收 ——
  // mp4/m4a/avif：ftyp box 在 offset 4，品牌 [8..11] 收窄分派；未列品牌不命中（保守落探测链）
  if (startsWith(head, [0x66, 0x74, 0x79, 0x70], 4) && head.length >= 12) {
    const brand = String.fromCharCode(head[8]!, head[9]!, head[10]!, head[11]!);
    if (brand === 'M4A ') return 'm4a';
    if (brand === 'avif' || brand === 'avis') return 'avif';
    if (MP4_VIDEO_BRANDS.has(brand)) return 'mp4';
  }
  if (startsWith(head, [0x1a, 0x45, 0xdf, 0xa3])) return 'webm';
  if (startsWith(head, [0x52, 0x49, 0x46, 0x46], 0) && startsWith(head, [0x57, 0x45, 0x42, 0x50], 8)) return 'webp';
  if (startsWith(head, [0x52, 0x49, 0x46, 0x46], 0) && startsWith(head, [0x57, 0x41, 0x56, 0x45], 8)) return 'wav';
  if (startsWith(head, [0x00, 0x00, 0x01, 0x00])) return 'ico';
  if (startsWith(head, [0x1f, 0x8b, 0x08])) return 'gz'; // 第三字节 0x08=deflate 收窄
  if (startsWith(head, [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c])) return '7z';
  if (startsWith(head, [0x52, 0x61, 0x72, 0x21, 0x1a, 0x07])) return 'rar'; // v4/v5 共前缀
  if (startsWith(head, [0x66, 0x4c, 0x61, 0x43])) return 'flac'; // fLaC
  if (startsWith(head, [0x4f, 0x67, 0x67, 0x53])) return 'ogg'; // OggS
  // bmp：'BM' 2 字节弱 → 保留字段 [6..9] 全零强校验为 10 字节有效签名（文本 "BM…" 无 NUL 天然排除）
  if (head[0] === 0x42 && head[1] === 0x4d && head[6] === 0 && head[7] === 0 && head[8] === 0 && head[9] === 0) return 'bmp';
```

文件顶部（sniffSignature 前）加品牌表：

```ts
/** ftyp 视频品牌白名单（spec §3.2）：未列品牌不命中，保守落探测链 */
const MP4_VIDEO_BRANDS: ReadonlySet<string> = new Set(['isom', 'iso2', 'mp41', 'mp42', 'msnv', 'm4v ']);
```

`dispatcher.ts` `SIGNATURE_ROUTES`（:79-86）扩为：

```ts
const SIGNATURE_ROUTES: Partial<Record<NonNullable<Detection['signature']>, SignatureRoute>> = {
  zip: { rendererId: 'archive', ext: 'zip' },
  png: { rendererId: 'image', ext: 'png' },
  jpeg: { rendererId: 'image', ext: 'jpg' },
  gif: { rendererId: 'image', ext: 'gif' },
  pdf: { rendererId: 'pdf', ext: 'pdf' },
  mpegts: { rendererId: 'av', ext: 'ts' },
  // 议题二扩表（spec §3.2）：ext 为渲染器内部分派/错误文案纠偏值，与 av VIDEO_EXTS/
  // image/archive 扩展名声明对齐；ole 无专用渲染器维持不改派（既有裁决）
  mp4: { rendererId: 'av', ext: 'mp4' },
  m4a: { rendererId: 'av', ext: 'm4a' },
  avif: { rendererId: 'image', ext: 'avif' },
  webm: { rendererId: 'av', ext: 'webm' },
  webp: { rendererId: 'image', ext: 'webp' },
  wav: { rendererId: 'av', ext: 'wav' },
  ico: { rendererId: 'image', ext: 'ico' },
  gz: { rendererId: 'archive', ext: 'gz' },
  '7z': { rendererId: 'archive', ext: '7z' },
  rar: { rendererId: 'archive', ext: 'rar' },
  flac: { rendererId: 'av', ext: 'flac' },
  ogg: { rendererId: 'av', ext: 'ogg' },
  bmp: { rendererId: 'image', ext: 'bmp' }
};
```

- [ ] **Step 4: 跑测试确认通过 + 全量回归**

Run: `pnpm vitest run packages/core/ && pnpm typecheck`
Expected: PASS；既有 detect/dispatcher 测试零翻转（新签名只增不改既有判定）

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/types.ts packages/core/src/detect/magic.ts packages/core/src/dispatch/dispatcher.ts packages/core/test/detect.test.ts
git commit -m "feat(core): magic 签名表扩容——无扩展名/改名 mp4 族与 gz/7z/rar 直达真渲染器"
```

### Task 6: 议题二 e2e（改派路由实证）

**Files:**
- Create: `apps/web/e2e/b-file-detect-signature.spec.ts`

**Interfaces:**
- Consumes: Task 5；`openDir` 装置（`b-binary-hex-archive.spec.ts:52-64` 同款，本文件自带一份局部装置）。

- [ ] **Step 1: 写 spec**

断言口径 = **MetaPanel 打开方式 select 的 value**（dispatch 返回 rendererId 决定，播放/解码成败不影响——av 渲染垃圾字节的运行期错误卡片与本锚无关）：

```ts
import { test, expect, type Page } from '@playwright/test';

/** 最小 ftyp-isom 头（垃圾负载，仅锚选路） */
function mp4ish(): Uint8Array {
  const b = new Uint8Array(64);
  b.set([0, 0, 0, 0x18], 0);
  b.set(new TextEncoder().encode('ftypisom'), 4);
  return b;
}

test.describe('签名改派扩表（SIG）', () => {
  test.beforeEach(async ({}) => {});

  async function openAndAssert(page: Page, name: string, bytes: Uint8Array, rendererId: string): Promise<void> {
    await page.goto('/');
    await page.waitForFunction(
      () => typeof (window as unknown as { __vvOpenDirImpl?: unknown }).__vvOpenDirImpl === 'function'
    );
    await page.evaluate(({ n, b }) => {
      const f = new File([new Uint8Array(b)], n, { type: 'application/octet-stream' });
      Object.defineProperty(f, 'webkitRelativePath', { value: `sig/${n}` });
      return (window as unknown as { __vvOpenDirImpl: (f: File[]) => void }).__vvOpenDirImpl([f]);
    }, { n: name, b: Array.from(bytes) });
    await expect(page.locator('.meta-openwith')).toHaveValue(rendererId, { timeout: 15_000 });
  }

  test('SIG-01 无扩展名 mp4（ftyp isom）→ av', async ({ page }) => {
    await openAndAssert(page, 'video', mp4ish(), 'av');
  });

  test('SIG-02 无扩展名 webp → image', async ({ page }) => {
    const b = new TextEncoder().encode('RIFF0000WEBPVP8 ') as unknown as Uint8Array;
    await openAndAssert(page, 'photo', b, 'image');
  });

  test('SIG-03 无扩展名 gz → archive', async ({ page }) => {
    const b = new Uint8Array([0x1f, 0x8b, 0x08, 0x00, 0, 0, 0, 0, 0, 0xff, 1, 2, 3]);
    await openAndAssert(page, 'bundle', b, 'archive');
  });

  test('SIG-04 无扩展名 7z → archive', async ({ page }) => {
    const b = new Uint8Array([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c, 0x00, 0x40]);
    await openAndAssert(page, 'pack', b, 'archive');
  });
});
```

- [ ] **Step 2: 重建 + 跑**

Run: `pnpm build:e2e && cd apps/web && npx playwright test b-file-detect-signature`
Expected: 4 用例绿（首跑若 `.meta-openwith` 值时序不达，用 `expect.poll` 轮询替代 `toHaveValue` 单评估——历史教训：轮询断言一律 poll）

- [ ] **Step 3: Commit**

```bash
git add apps/web/e2e/b-file-detect-signature.spec.ts
git commit -m "test(e2e): 签名改派扩表场景 SIG-01..04——无扩展名 mp4/webp/gz/7z 直达真渲染器"
```

---

## 议题三：编码探测升级

### Task 7: UTF-32 BOM + `Encoding` 扩列 + `decodeText` 解码单源

**Files:**
- Modify: `packages/core/src/types.ts:67`（Encoding 联合）
- Modify: `packages/core/src/detect/encoding.ts`（BOM 判定）
- Modify: `packages/render-text/src/code/strategy.ts:116`（DECODERS 收窄 + 补表）
- Create: `packages/render-text/src/decodeText.ts`
- Modify（解码点机械替换）: `packages/render-text/src/code/renderCode.ts:72`、`packages/render-text/src/html.ts:114`、`packages/render-text/src/markdown/markdownRenderer.ts:510`、`packages/render-text/src/jsonl/index.ts:623`
- Test: `packages/core/test/detect.test.ts`（BOM 序）、`packages/render-text/test/decodeText.test.ts`（新建）

**Interfaces:**
- Produces: `Encoding = 'utf-8' | 'utf-16le' | 'utf-16be' | 'utf-32le' | 'utf-32be' | 'gb18030' | <Task 8 精判标签集>`；`decodeText(bytes: Uint8Array, encoding: Encoding | undefined): string`（render-text 单源）。**Task 8 会再次扩列 Encoding**（chardet 白名单标签），本任务把 DECODERS/decodeText 的结构立起来，Task 8 只加键。

- [ ] **Step 1: 写失败测试**

`packages/core/test/detect.test.ts` 追加：

```ts
describe('议题三：BOM 扩充', () => {
  it('UTF-32LE BOM 优先于 UTF-16LE（前缀包含）', () => {
    expect(detectEncoding(new Uint8Array([0xff, 0xfe, 0x00, 0x00, 0x41, 0, 0, 0]))).toBe('utf-32le');
  });
  it('UTF-32BE BOM 识别', () => {
    expect(detectEncoding(new Uint8Array([0x00, 0x00, 0xfe, 0xff, 0, 0, 0x41]))).toBe('utf-32be');
  });
  it('既有 BOM 判定不回归', () => {
    expect(detectEncoding(new Uint8Array([0xef, 0xbb, 0xbf, 0x41]))).toBe('utf-8');
    expect(detectEncoding(new Uint8Array([0xff, 0xfe, 0x41, 0]))).toBe('utf-16le');
    expect(detectEncoding(new Uint8Array([0xfe, 0xff, 0, 0x41]))).toBe('utf-16be');
  });
});
```

（`detectEncoding` 按文件既有导入风格引入。）

`packages/render-text/test/decodeText.test.ts` 新建：

```ts
import { describe, expect, it } from 'vitest';
import { decodeText } from '../src/decodeText';

describe('decodeText 单源（议题三 §4.2）', () => {
  it('utf-32le：BOM 剥离 + LE 码元解码', () => {
    // BOM(FF FE 00 00) + 'A'(41 00 00 00) + '中'(2D 4E 00 00)
    const b = new Uint8Array([0xff, 0xfe, 0x00, 0x00, 0x41, 0, 0, 0, 0x2d, 0x4e, 0x00, 0x00]);
    expect(decodeText(b, 'utf-32le')).toBe('A中');
  });
  it('utf-32be：BOM 剥离 + BE 码元解码', () => {
    // BOM(00 00 FE FF) + 'A'(00 00 00 41) + '中'(00 00 4E 2D)
    const b = new Uint8Array([0x00, 0x00, 0xfe, 0xff, 0, 0, 0, 0x41, 0, 0, 0x4e, 0x2d]);
    expect(decodeText(b, 'utf-32be')).toBe('A中');
  });
  it('非法码点/代理区 → U+FFFD 替换符（fatal:false 同语义）', () => {
    const b = new Uint8Array([0xff, 0xfe, 0x00, 0x00, 0x00, 0x00, 0x11, 0x00, 0x00, 0xd8, 0x00, 0x00]);
    expect(decodeText(b, 'utf-32le')).toBe('\u{FFFD}\u{FFFD}');
  });
  it('utf-8 缺省与 gb18030 透传 TextDecoder 不回归', () => {
    expect(decodeText(new TextEncoder().encode('abc'), undefined)).toBe('abc');
    expect(decodeText(new TextEncoder().encode('abc'), 'gb18030')).toBe('abc');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run packages/core/test/detect.test.ts packages/render-text/test/decodeText.test.ts`
Expected: FAIL（'utf-32le' 不在 Encoding / decodeText 不存在）

- [ ] **Step 3: 实现**

`types.ts:67`：

```ts
export type Encoding =
  | 'utf-8' | 'utf-16le' | 'utf-16be' | 'utf-32le' | 'utf-32be' | 'gb18030';
```

（Task 8 追加精判标签；此处先立 UTF-32，编译错面最小。）

`encoding.ts`：BOM 判定函数加 `hasUtf32leBom`（`[0xff,0xfe,0x00,0x00]`）与 `hasUtf32beBom`（`[0x00,0x00,0xfe,0xff]`）；`detectEncoding`（:31-37）改为——**UTF-32 两判必须在 UTF-16LE 之前**：

```ts
export function detectEncoding(bytes: Uint8Array): Encoding {
  if (hasUtf32leBom(bytes)) return 'utf-32le';
  if (hasUtf32beBom(bytes)) return 'utf-32be';
  if (hasUtf8Bom(bytes)) return 'utf-8';
  if (hasUtf16leBom(bytes)) return 'utf-16le';
  if (hasUtf16beBom(bytes)) return 'utf-16be';
  if (isStrictUtf8(bytes)) return 'utf-8';
  return 'gb18030';
}
```

`strategy.ts:116` DECODERS 改窄 + 注记：

```ts
/** Encoding → TextDecoder 标签（decodeText 消费；UTF-32 不在表内——WHATWG TextDecoder
 * 不支持，decodeText 自带定长解码器分流）。议题三扩列由本 Record 编译期强制同步。 */
export const DECODERS: Record<Exclude<Encoding, 'utf-32le' | 'utf-32be'>, string> = {
  'utf-8': 'utf-8',
  'utf-16le': 'utf-16le',
  'utf-16be': 'utf-16be',
  'gb18030': 'gb18030'
};
```

`packages/render-text/src/decodeText.ts` 新建：

```ts
// decodeText.ts — 文本解码单源（议题三 §4.2）：UTF-32 走自带定长解码器（WHATWG
// TextDecoder 不支持），其余透传 TextDecoder（fatal:false，坏字节替换符）。全部
// 文本渲染器的解码点只准经本函数（Task 7 替换 4 处直构点）。
import type { Encoding } from '@vviewer/core';
import { DECODERS } from './code/strategy';

export function decodeText(bytes: Uint8Array, encoding: Encoding | undefined): string {
  if (encoding === 'utf-32le') return decodeUtf32(bytes, true);
  if (encoding === 'utf-32be') return decodeUtf32(bytes, false);
  return new TextDecoder(DECODERS[encoding ?? 'utf-8'], { fatal: false }).decode(bytes);
}

/** UTF-32 定长解码：BOM 剥离（TextDecoder 对 utf-8/16 同样自动剥，语义对齐）；
 * 非法码点/代理区 → U+FFFD。 */
function decodeUtf32(b: Uint8Array, le: boolean): string {
  const hasBom = le
    ? b[0] === 0xff && b[1] === 0xfe && b[2] === 0 && b[3] === 0
    : b[0] === 0 && b[1] === 0 && b[2] === 0xfe && b[3] === 0xff;
  const start = hasBom ? 4 : 0;
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let out = '';
  for (let i = start; i + 4 <= b.length; i += 4) {
    const cp = view.getUint32(i, le);
    out += cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff) ? String.fromCodePoint(cp) : '\ufffd';
  }
  return out;
}
```

4 处解码点替换为 `decodeText(...)`（**传原始 `Encoding` 值，不是 DECODERS 映射后的标签字符串**——renderCode 的 `enc` 若已是标签字符串，取其来源的 Encoding 变量，类型错会当场暴露）：
- `renderCode.ts:72`：`const text = decodeText(buffer, <encoding 的原始 Encoding 变量>).replace(/\r\n?/g, '\n');`
- `html.ts:114`：`const raw = decodeText(buffer, det.encoding);`
- `markdownRenderer.ts:510`：`const text = decodeText(buffer, det.encoding);`
- `jsonl/index.ts:623`：`text = decodeText(buffer, det.encoding);`（:625 的字面 `'utf-8'` 行不动）

各文件补 `import { decodeText } from '../decodeText'`（相对路径按所在目录调整）。

- [ ] **Step 4: 跑测试 + 全量回归**

Run: `pnpm vitest run packages/core/ packages/render-text/ && pnpm typecheck`
Expected: PASS；typecheck 若报其他 DECODERS 消费点（如 code/index.ts 直读 DECODERS），一并改经 decodeText 或窄型化，注释说明

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/types.ts packages/core/src/detect/encoding.ts packages/render-text/src/code/strategy.ts packages/render-text/src/decodeText.ts packages/render-text/src/code/renderCode.ts packages/render-text/src/html.ts packages/render-text/src/markdown/markdownRenderer.ts packages/render-text/src/jsonl/index.ts packages/core/test/detect.test.ts packages/render-text/test/decodeText.test.ts
git commit -m "feat(core/render-text): UTF-32 BOM 识别与 decodeText 解码单源——BOM 映射范围扩充"
```

### Task 8: chardet 精判分层 + redetectWithFull async 化接线

**Files:**
- Modify: `packages/core/package.json`（`pnpm add chardet@^2.2.0 --filter @vviewer/core`）
- Modify: `packages/core/src/types.ts:67`（Encoding 追加精判标签）
- Create: `packages/core/src/detect/encodingRefine.ts`
- Modify: `packages/core/src/dispatch/dispatcher.ts`（`redetectWithFull` async 化 :60-69；两处调用点 :358/:375 加 await；初始精判 :293 后）
- Modify: `packages/render-text/src/code/index.ts:106,:128`、`packages/render-text/src/jsonl/index.ts:978,:996`（加 await）
- Modify: `THIRD_PARTY_NOTICES.md`（chardet 条目，格式随文件既有条目）
- Test: `packages/core/test/encodingRefine.test.ts`（新建）

**Interfaces:**
- Consumes: chardet `analyse()`（`{ confidence, name, lang }[]`，confidence 0–10）。
- Produces: `refineEncoding(bytes: Uint8Array, det: Detection): Promise<void>`；`redetectWithFull(...): Promise<void>`（签名从 sync void 改 async）。Encoding 新增标签：`'shift_jis' | 'euc-jp' | 'iso-2022-jp' | 'euc-kr' | 'big5' | 'windows-1250' | 'windows-1251' | 'windows-1252' | 'windows-1253' | 'windows-1254' | 'windows-1255' | 'windows-1256' | 'windows-1257' | 'windows-1258' | 'koi8-r' | 'ibm866' | 'iso-8859-2' | 'iso-8859-5' | 'iso-8859-7' | 'iso-8859-15' | 'x-mac-cyrillic'`。

- [ ] **Step 1: 依赖 + 失败测试**

```bash
pnpm add chardet@^2.2.0 --filter @vviewer/core
```

`packages/core/test/encodingRefine.test.ts` 新建：

```ts
import { describe, expect, it, vi } from 'vitest';
import { refineEncoding } from '../src/detect/encodingRefine';
import type { Detection } from '../src/types';

const det = (): Detection => ({ ext: 'txt', encoding: 'gb18030', binary: false, signature: null });

/** Shift-JIS「あ」×40（0x82 0x60）+ ASCII 前缀——2026-10-28 probe 实测 analyse
 * 返回 [{confidence:10, name:'Shift_JIS', lang:'ja'}] */
function sjisBytes(): Uint8Array {
  const head = new TextEncoder().encode('// comment\n');
  const b = new Uint8Array(head.length + 80);
  b.set(head, 0);
  for (let i = head.length; i < b.length; i += 2) { b[i] = 0x82; b[i + 1] = 0x60; }
  return b;
}

describe('refineEncoding 精判分层（议题三 §4.3）', () => {
  it('Shift-JIS 文本精判为 shift_jis', async () => {
    const d = det();
    await refineEncoding(sjisBytes(), d);
    expect(d.encoding).toBe('shift_jis');
  });

  it('UTF-8（严格校验通过）文件不被精判触碰', async () => {
    const d = det();
    d.encoding = 'utf-8';
    await refineEncoding(new TextEncoder().encode('plain ascii'), d);
    expect(d.encoding).toBe('utf-8');
  });

  it('二进制样本（looksTextual=false）门控跳过', async () => {
    const d = det();
    const bin = new Uint8Array(256).fill(0);
    bin[7] = 0x89; // 含 NUL 即非文本
    await refineEncoding(bin, d);
    expect(d.encoding).toBe('gb18030');
  });

  it('低置信不采纳（mock analyse confidence=5 < 9）', async () => {
    vi.resetModules(); // 先清模块缓存（连带 chardetPromise 单例），mock 才能注入
    vi.doMock('chardet', () => ({ analyse: () => [{ confidence: 5, name: 'Shift_JIS', lang: 'ja' }] }));
    const { refineEncoding: refineMocked } = await import('../src/detect/encodingRefine');
    const d = det();
    await refineMocked(sjisBytes(), d);
    expect(d.encoding).toBe('gb18030');
    vi.doUnmock('chardet');
    vi.resetModules();
  });

  it('映射白名单外不采纳（mock name=Unknown8bit）', async () => {
    vi.resetModules();
    vi.doMock('chardet', () => ({ analyse: () => [{ confidence: 10, name: 'Unknown8bit', lang: '' }] }));
    const { refineEncoding: refineMocked } = await import('../src/detect/encodingRefine');
    const d = det();
    await refineMocked(sjisBytes(), d);
    expect(d.encoding).toBe('gb18030');
    vi.doUnmock('chardet');
    vi.resetModules();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run packages/core/test/encodingRefine.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 encodingRefine.ts**

```ts
// encodingRefine.ts — chardet 精判分层（议题三 §4.3）：快路径（BOM/严格 UTF-8）零成本，
// 仅「严格 UTF-8 失败的文本」触发重探测。懒加载单例 + 置信度白名单双闸，任何失败
// 路径回落 gb18030 现状——永不比今天更差。chardet v2 置信度为 0–10 量纲（2026-10-28
// probe 实测 confidence:10），spec 阈值 0.90 折算 9.0。
import type { Detection, Encoding } from '../types';
import { looksTextual } from './magic';

const CONFIDENCE_MIN = 9;
const SAMPLE_LIMIT = 64 * 1024;

type ChardetModule = typeof import('chardet');
let chardetPromise: Promise<ChardetModule> | null = null;
function loadChardet(): Promise<ChardetModule> {
  chardetPromise ??= import('chardet');
  return chardetPromise;
}

/** detector 编码名 → TextDecoder 标签白名单（键小写查表）；映射外维持 gb18030。
 * MacCyrillic → WHATWG x-mac-cyrillic；ASCII/UTF-*/GB18030 不可达（UTF-8 被严格
 * 校验先行，UTF-16/32 被 BOM 先行，GB18030 为现状值）。 */
const LABELS: Readonly<Record<string, Encoding>> = {
  'shift_jis': 'shift_jis',
  'euc-jp': 'euc-jp',
  'iso-2022-jp': 'iso-2022-jp',
  'euc-kr': 'euc-kr',
  'big5': 'big5',
  'windows-1250': 'windows-1250',
  'windows-1251': 'windows-1251',
  'windows-1252': 'windows-1252',
  'windows-1253': 'windows-1253',
  'windows-1254': 'windows-1254',
  'windows-1255': 'windows-1255',
  'windows-1256': 'windows-1256',
  'windows-1257': 'windows-1257',
  'windows-1258': 'windows-1258',
  'koi8-r': 'koi8-r',
  'ibm866': 'ibm866',
  'iso-8859-2': 'iso-8859-2',
  'iso-8859-5': 'iso-8859-5',
  'iso-8859-7': 'iso-8859-7',
  'iso-8859-15': 'iso-8859-15',
  'maccyrillic': 'x-mac-cyrillic'
};

/** 精判：门控（gb18030 且文本性）→ chardet analyse → 置信度+白名单双闸 → 就地改写
 * det.encoding。只动 encoding 一字段（binary 判定属 detect 同步面，不回流）。 */
export async function refineEncoding(bytes: Uint8Array, det: Detection): Promise<void> {
  if (det.encoding !== 'gb18030') return;
  const sample = bytes.length > SAMPLE_LIMIT ? bytes.subarray(0, SAMPLE_LIMIT) : bytes;
  if (!looksTextual(sample)) return;
  try {
    const chardet = await loadChardet();
    const best = chardet.analyse(sample)[0];
    if (!best || best.confidence < CONFIDENCE_MIN) return;
    const label = LABELS[best.name.toLowerCase()];
    if (label !== undefined && label !== 'gb18030') det.encoding = label;
  } catch {
    // 探测器加载/分析失败：维持 gb18030（永不比今天更差）
  }
}
```

`types.ts:67` Encoding 扩为（Interfaces 节的完整清单）：

```ts
export type Encoding =
  | 'utf-8' | 'utf-16le' | 'utf-16be' | 'utf-32le' | 'utf-32be' | 'gb18030'
  | 'shift_jis' | 'euc-jp' | 'iso-2022-jp' | 'euc-kr' | 'big5'
  | 'windows-1250' | 'windows-1251' | 'windows-1252' | 'windows-1253' | 'windows-1254'
  | 'windows-1255' | 'windows-1256' | 'windows-1257' | 'windows-1258'
  | 'koi8-r' | 'ibm866' | 'iso-8859-2' | 'iso-8859-5' | 'iso-8859-7' | 'iso-8859-15'
  | 'x-mac-cyrillic';
```

- [ ] **Step 4: redetectWithFull async 化 + 7 处接线**

`dispatcher.ts:60-69` 改：

```ts
export async function redetectWithFull(
  source: FileSource,
  head: Uint8Array,
  full: Uint8Array,
  det: Detection
): Promise<void> {
  const redet = detect({ name: source.name, head, full });
  det.encoding = redet.encoding;
  det.binary = redet.binary;
  // 议题三：全量在手后精判（仍 gb18030 才触发，门控在 refineEncoding 内）
  await refineEncoding(full, det);
}
```

（import 加 `import { refineEncoding } from '../detect/encodingRefine';`；doc 注释同步补精判语义一句。）

7 处调用点机械加 `await`（全部已在异步上下文）：
- `dispatcher.ts:358`、`dispatcher.ts:375`（非流式补拉 / streaming 降级补拉后的 redetectWithFull）
- `dispatcher.ts:293`（`const det = detect(...)` 之后追加初始精判一行）：

```ts
    // 议题三初始精判：buffer 直传 >1MB 与 streaming-capable 永不补拉全量两路径的
    // 编码在此定案；head-only→补拉路径后续 redetectWithFull 会再精判（gb18030 门控
    // 抑制重复采纳，chardet 8KB 级毫秒成本）
    if (det.encoding === 'gb18030') await refineEncoding(full ?? probe, det);
```

- `code/index.ts:106`（onEncodingBroken 内）、`code/index.ts:128`（守卫补拉内）：`await redetectWithFull(...)`
- `jsonl/index.ts:978`、`jsonl/index.ts:996`：`await redetectWithFull(...)`

`strategy.ts` DECODERS 按 types.ts 新标签补表（编译错驱动，全部恒等映射值）：

```ts
export const DECODERS: Record<Exclude<Encoding, 'utf-32le' | 'utf-32be'>, string> = {
  'utf-8': 'utf-8',
  'utf-16le': 'utf-16le',
  'utf-16be': 'utf-16be',
  'gb18030': 'gb18030',
  'shift_jis': 'shift_jis',
  'euc-jp': 'euc-jp',
  'iso-2022-jp': 'iso-2022-jp',
  'euc-kr': 'euc-kr',
  'big5': 'big5',
  'windows-1250': 'windows-1250',
  'windows-1251': 'windows-1251',
  'windows-1252': 'windows-1252',
  'windows-1253': 'windows-1253',
  'windows-1254': 'windows-1254',
  'windows-1255': 'windows-1255',
  'windows-1256': 'windows-1256',
  'windows-1257': 'windows-1257',
  'windows-1258': 'windows-1258',
  'koi8-r': 'koi8-r',
  'ibm866': 'ibm866',
  'iso-8859-2': 'iso-8859-2',
  'iso-8859-5': 'iso-8859-5',
  'iso-8859-7': 'iso-8859-7',
  'iso-8859-15': 'iso-8859-15',
  'x-mac-cyrillic': 'x-mac-cyrillic'
};
```

`THIRD_PARTY_NOTICES.md` 追加 chardet 条目（读文件头部既有条目格式后同款追加：包名 chardet、版本 2.2.0、MIT、用途一句话）。

- [ ] **Step 5: 跑测试 + 全量回归 + typecheck**

Run: `pnpm vitest run packages/core/ packages/render-text/ && pnpm typecheck && cd apps/web && npx svelte-check --tsconfig ./tsconfig.json`
Expected: 全绿；既有 dispatcher/code/jsonl 编码测试零翻转（gb18030 现状路径不变，精判只在原误判面生效）

- [ ] **Step 6: Commit**

```bash
git add packages/core/package.json pnpm-lock.yaml packages/core/src/types.ts packages/core/src/detect/encodingRefine.ts packages/core/src/dispatch/dispatcher.ts packages/render-text/src/code/index.ts packages/render-text/src/jsonl/index.ts packages/render-text/src/code/strategy.ts THIRD_PARTY_NOTICES.md packages/core/test/encodingRefine.test.ts
git commit -m "feat(core): chardet 精判分层——严格 UTF-8 失败文本的编码重探测，永不比今天更差"
```

### Task 9: 议题三 e2e（编码样本实证）

**Files:**
- Create: `apps/web/e2e/b-encoding-detect.spec.ts`

**Interfaces:**
- Consumes: Task 7/8；`openDir` 装置同 Task 6。

- [ ] **Step 1: 写 spec**

```ts
import { test, expect, type Page } from '@playwright/test';

async function openFile(page: Page, name: string, bytes: Uint8Array): Promise<void> {
  await page.goto('/');
  await page.waitForFunction(
    () => typeof (window as unknown as { __vvOpenDirImpl?: unknown }).__vvOpenDirImpl === 'function'
  );
  await page.evaluate(({ n, b }) => {
    const f = new File([new Uint8Array(b)], n, { type: 'text/plain' });
    Object.defineProperty(f, 'webkitRelativePath', { value: `enc/${n}` });
    return (window as unknown as { __vvOpenDirImpl: (f: File[]) => void }).__vvOpenDirImpl([f]);
  }, { n: name, b: Array.from(bytes) });
}

test.describe('编码探测升级（ENC）', () => {
  test('ENC-01 Shift-JIS 文本：编码行 shift_jis + 无乱码', async ({ page }) => {
    // '# テキスト\n'（ASCII）+ Shift-JIS「あ」×40（0x82 0x60，probe 实测 analyse conf 10）
    const ascii = new TextEncoder().encode('# text\n');
    const b = new Uint8Array(ascii.length + 80);
    b.set(ascii, 0);
    for (let i = ascii.length; i < b.length; i += 2) { b[i] = 0x82; b[i + 1] = 0x60; }
    await openFile(page, 'sjis.txt', b);
    await expect(page.locator('.meta-panel')).toContainText('shift_jis', { timeout: 15_000 });
    // Shift-JIS 0x82 0x60 = 'あ'：正确解码必出现；gb18030 误判则为乱码字形
    await expect(page.locator('.vv-code-pre')).toContainText('あ');
  });

  test('ENC-02 UTF-32LE BOM 文件：编码行 utf-32le + 定长解码内容正确', async ({ page }) => {
    // BOM + 'AB'（41 00 00 00 42 00 00 00）
    const b = new Uint8Array([0xff, 0xfe, 0x00, 0x00, 0x41, 0, 0, 0, 0x42, 0, 0, 0]);
    await openFile(page, 'u32.txt', b);
    await expect(page.locator('.meta-panel')).toContainText('utf-32le', { timeout: 15_000 });
    await expect(page.locator('.vv-code-pre')).toContainText('AB');
  });
});
```

- [ ] **Step 2: 校准与跑**

先核对两个选择器事实并就地修正：①MetaPanel 编码行容器（`MetaPanel.svelte:221-222` 的 `.meta-row` 结构，断言锚 `.meta-panel` toContainText 已够宽，无需改）；②代码视图根类名（`.vv-code-pre` 从既有 code 域 e2e 用法核对，如 `t-md.spec.ts`/`t-hl.spec.ts` 中现值）。然后：

Run: `pnpm build:e2e && cd apps/web && npx playwright test b-encoding-detect`
Expected: 2 用例绿（首跑时序不达改 `expect.poll`）

- [ ] **Step 3: Commit**

```bash
git add apps/web/e2e/b-encoding-detect.spec.ts
git commit -m "test(e2e): 编码探测场景 ENC-01..02——Shift-JIS 精判与 UTF-32 BOM 定长解码"
```

---

## 收尾门禁（全部任务后）

- [ ] `pnpm typecheck && cd apps/web && npx svelte-check --tsconfig ./tsconfig.json && cd ../.. && pnpm vitest run`（全量）
- [ ] `pnpm build:e2e && cd apps/web && npx playwright test`（默认套件全量，server 套件不涉及可跳）
- [ ] spec §5 验收锚逐条对照（OWX 锚更新、SIG/ENC/OWM 场景、THIRD_PARTY_NOTICES）
