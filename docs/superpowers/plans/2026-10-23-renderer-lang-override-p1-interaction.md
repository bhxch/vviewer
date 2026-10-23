# 渲染器/语言手动指定 P1 交互补全（阶段 A/B/C）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 打开方式候选集 markdown 恒兜底 + MetaPanel 下拉常驻（A）、高亮语言手动指定全链（B）、语言徽标即复制（C）。

**Architecture:** 全部前端改动。候选集扩容只动 `openWithOf` 一处（三入口单机制不变量）；语言走 `Tab.overrideLang` 新字段 → `DispatchOptions.langOverride` → code 渲染器 `opts.lang` 注入口（`code.ts:698` 现成，有值跳过 `detectLanguage`）；徽标复制把 `runCopyCode` 的双入口收敛为徽标单按钮。

**Tech Stack:** Svelte 5（runes）、TypeScript、vitest（仓库根跑）、Playwright（apps/web/e2e）。

**Spec:** `docs/superpowers/specs/2026-10-23-renderer-lang-override-markpad-alignment-design.md` §3/§4/§5（executors 读 spec+plan 两份）。

## Global Constraints

- 回复中文；commit Angular 规范原子化；临时产物放 .temp/（已 gitignore）。
- svelte-check 门禁在 apps/web 下跑（`pnpm --filter web typecheck`）；vitest 必须仓库根跑；重建一律 `build:e2e`（裸 build 冲掉 CDN 注入）。
- 三入口单机制：状态栏浮层 / Tab 右键 / MetaPanel 下拉同源 `openWithOf`，本计划只改 `openWithOf` 候选构造。
- 持久化链同款：快照写 `openFlow.svelte.ts:90` / 恢复读回 `:414` / duplicate 继承 `:356` / 类型 `stores/session.ts:15`。
- e2e 锚：OWX-01..09、TAX-12/13 零翻转（候选集 +markdown 属预期翻转，逐锚更新并注记）。
- openWith 手选作用于激活 tab——e2e 开序错会假阴性（TAX-13 教训在案）。

---

### Task 1: openWithOf 候选集 +markdown 恒兜底

**Files:**
- Modify: `apps/web/src/lib/openWith.ts:32-33`
- Test: `apps/web/src/lib/openWith.test.ts`（已存在）

**Interfaces:**
- Consumes: `openWithOf(registry, overrideRenderer, rendererId, detExt): FileOpenWith`（签名不变）。
- Produces: 候选序规则——`.md` 类 `[自动, Markdown, 代码, 二进制]`（不变）；`.txt`/未知扩展名 `[自动, 代码, Markdown, 二进制]`（+Markdown）；无扩展名同 .txt。下游 Task 6/8 依赖此序。

- [ ] **Step 1: 写 RED 用例**

在 `openWith.test.ts` 追加（registry 桩沿用文件内既有构造方式）：

```ts
it('恒兜底序列含 markdown：.txt 候选 [自动, 代码, Markdown, 二进制]', () => {
  const res = openWithOf(reg, undefined, 'code', 'txt');
  expect(res.options.map((o) => o.id)).toEqual(['', 'code', 'markdown', 'hex']);
});
it('markdown 兜底去重：.md 候选 [自动, Markdown, 代码, 二进制]', () => {
  const res = openWithOf(reg, undefined, 'markdown', 'md');
  expect(res.options.map((o) => o.id)).toEqual(['', 'markdown', 'code', 'hex']);
});
it('无扩展名同样带 markdown 兜底', () => {
  const res = openWithOf(reg, undefined, 'code', '');
  expect(res.options.map((o) => o.id)).toEqual(['', 'code', 'markdown', 'hex']);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run apps/web/src/lib/openWith.test.ts`（仓库根）
Expected: 新增 3 用例 FAIL（markdown 缺席）。

- [ ] **Step 3: 改恒兜底序列**

`openWith.ts:32-33` 改：

```ts
  push('code');
  push('markdown'); // markdown 恒兜底（spec §3.1）：任何文件值得试 markdown 渲染，先例=hex 对 .md 出现
  push('hex');
```

同步函数头注释（`:8-12`）兜底描述 `code/hex` → `code/markdown/hex`。

- [ ] **Step 4: 跑测试确认通过 + 回归既有用例**

Run: `pnpm vitest run apps/web/src/lib/openWith.test.ts apps/web/src/lib/rendererPickerMenu.test.ts`
Expected: 全 PASS（rendererPickerMenu.test.ts 若有候选集断言翻转，按新序更新并注记「spec §3.1」）。

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/lib/openWith.ts apps/web/src/lib/openWith.test.ts apps/web/src/lib/rendererPickerMenu.test.ts
git commit -m "feat(web): 打开方式候选集 markdown 恒兜底——.txt 强制 markdown 渲染缺口（spec §3.1）"
```

---

### Task 2: MetaPanel「打开方式」下拉常驻

**Files:**
- Modify: `apps/web/src/lib/MetaPanel.svelte`（模板 `:149-166` 门控段 + script）
- Test: `apps/web/src/lib/metaStore.test.ts`（回归）；svelte-check

**Interfaces:**
- Consumes: `rendererCandidatesOfTab(registry, tab)`（`RendererPickerMenu.ts:48-63`，TabBar 同款，内部回退 `extOfName`）；`tabStore`（openFlow 单例）。
- Produces: 下拉在无 meta 实例路径（store.read 失败卡片、清理空态）恒可用；`fileMeta.openWith` 上行通道保留仅作回显。

- [ ] **Step 1: 核对依赖面**

Run: `rg -n 'export const registry|export function rendererCandidatesOfTab|lastRendererId' apps/web/src/lib/viewer.ts apps/web/src/lib/RendererPickerMenu.ts`
确认 `registry` 单例导出名与 `rendererCandidatesOfTab(registry, tab)` 签名；MetaPanel 顶部 import 补：

```ts
import { rendererCandidatesOfTab } from './RendererPickerMenu';
import { registry } from './viewer';
```

- [ ] **Step 2: 改模板——去门控、候选改 tab 侧计算**

`:149-166` 的 `{#if fileMeta.openWith}` 块改为常驻（dt 保留），script 加派生：

```ts
/** 打开方式候选（spec §3.2 常驻）：自激活 tab 直接计算（TabBar 同款），不随
 * meta 实例出现/消失——metaStore 上行仅作回显兜底。 */
const openWithUi = $derived.by(() => {
  const tab = tabStore.list.find((t) => t.active);
  return tab ? rendererCandidatesOfTab(registry, tab) : null;
});
```

模板（`select` 的 onchange 仍走既有 `onOpenWith`）：

```svelte
<dt>打开方式</dt>
<dd>
  {#if openWithUi}
    <select value={openWithUi.current} onchange={(e) => onOpenWith(e.currentTarget.value)}>
      {#each openWithUi.options as opt (opt.id)}<option value={opt.id}>{opt.label}</option>{/each}
    </select>
    {#if openWithUi.manual}<span class="meta-openwith-manual">（手动）</span>{/if}
  {/if}
</dd>
```

- [ ] **Step 3: 门禁**

Run: `pnpm --filter web typecheck && pnpm vitest run apps/web/src/lib/metaStore.test.ts`
Expected: 0 错误 / 全 PASS。

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/lib/MetaPanel.svelte
git commit -m "feat(web): MetaPanel 打开方式下拉常驻——去 meta 实例门控改 tab 侧候选（spec §3.2）"
```

---

### Task 3: Tab.overrideLang 状态与持久化链

**Files:**
- Modify: `apps/web/src/lib/stores/session.ts:15-16`、`apps/web/src/lib/openFlow.svelte.ts`（Tab 声明、snapshot `:90`、duplicate `:356`、restore `:414`、新 setter）
- Test: `apps/web/src/lib/openFlow.test.ts` 或既有覆盖 snapshot/duplicate 的单测文件（先 `rg -l 'overrideRenderer' apps/web/src --glob '*.test.ts'` 定位，缺则新建 `apps/web/src/lib/overrideLang.test.ts`）

**Interfaces:**
- Produces: `Tab.overrideLang?: string`（canonical 语言名）；`tabStore.setHighlightLang(tabId: string, lang: string | null): void`（null=清）；快照字段 `overrideLang?`。Task 4/5/6 消费。

- [ ] **Step 1: 写 RED 用例**（快照回环 + duplicate 继承 + setHighlightLang 语义，镜像既有 overrideRenderer 用例形态）：

```ts
it('setHighlightLang 写 overrideLang，null 清除且 rev 自增', () => {
  const tab = /* 沿用既有用例的建 tab 装置 */;
  const rev0 = tab.rev;
  tabStore.setHighlightLang(tab.id, 'rust');
  expect(tab.overrideLang).toBe('rust');
  expect(tab.rev).toBe(rev0 + 1);
  tabStore.setHighlightLang(tab.id, null);
  expect(tab.overrideLang).toBeUndefined();
});
it('快照含 overrideLang（仅置位写入），恢复/duplicate 读回', () => {
  /* snapshot() 断言含字段；restore+duplicate 后 overrideLang === 'python' */
});
```

- [ ] **Step 2: RED 确认** — `pnpm vitest run <测试文件>`，FAIL（字段/方法不存在）。

- [ ] **Step 3: 实现**——`session.ts` TabSnapshot `overrideRenderer` 旁加：

```ts
  /** spec §4.1：手动高亮语言（canonical 名，code 渲染器消费）；仅置位写入，restore 侧读回。 */
  overrideLang?: string;
```

`openFlow.svelte.ts`：Tab 声明同位加 `overrideLang?: string`；snapshot `:90` 加 `...(t.overrideLang !== undefined ? { overrideLang: t.overrideLang } : {}),`；`:356`（duplicate）与 `:414`（restore）镜像 overrideRenderer 的读回行加 `if (snap.overrideLang !== undefined) tab.overrideLang = snap.overrideLang;`；`setRendererOverride`（`:495-509`）旁加同款 `setHighlightLang`（null → `delete tab.overrideLang`，写后 `tab.rev++` + `void persist()`）。

- [ ] **Step 4: GREEN + 全量相关回归** — `pnpm vitest run apps/web/src/lib`；Commit：

```bash
git commit -am "feat(web): Tab.overrideLang 状态与持久化链——快照/恢复/复制同款 overrideRenderer（spec §4.1）"
```

---

### Task 4: langOverride 消费链（dispatch → code 渲染器）

**Files:**
- Modify: `packages/core/src/dispatch/dispatcher.ts:28-43`（DispatchOptions）、`:299-306`（renderOpts/redisplay）
- Modify: `packages/render-text/src/code.ts:2571`（render 签名 opts）、`:2585`（lang 组装）
- Modify: `apps/web/src/lib/ViewerPane.svelte:312`（dispatch 调用）
- Test: `packages/core/src/dispatch/dispatcher.test.ts`（先 `rg -l 'rendererOverride' packages/core/src --glob '*.test.ts'` 定位）

**Interfaces:**
- Consumes: Task 3 的 `Tab.overrideLang`。
- Produces: `DispatchOptions.langOverride?: string`；code 渲染 `opts.langOverride` 优先级 `langOverride ?? meta?.lang ?? det.lang`。

- [ ] **Step 1: RED 用例**（镜像既有 rendererOverride dispatch 用例）：

```ts
it('langOverride 透传至 code 渲染 opts：优先于服务端检测头', async () => {
  /* dispatch(..., { langOverride: 'python' }) → render 收到的第 6 参含 langOverride==='python'，
     且 code.ts 组装的 renderOpts.lang === 'python'（meta.lang 桩为 'rust' 时仍 python） */
});
```

- [ ] **Step 2: RED 确认** → **Step 3: 实现**：

dispatcher.ts DispatchOptions 追加（rendererOverride 注释后）：

```ts
  /** 手动高亮语言（spec §4.1）：仅 code 渲染器消费（opts.lang 注入口，有值跳过
   * detectLanguage）；其余渲染器不读即零感知。 */
  langOverride?: string;
```

renderOpts 组装（`:299-302`）加 langOverride 分支；redisplay（`:303-306`）两分支 spread 加 `langOverride: opts?.langOverride`。

code.ts render 签名（`:2571`）opts 类型加 `langOverride?: string`；`:2585` 改：

```ts
      lang: opts?.langOverride ?? meta?.lang ?? det.lang ?? undefined,
```

ViewerPane.svelte `:312` dispatch 调用加 `langOverride: current.overrideLang,`。

- [ ] **Step 4: GREEN + 回归** — `pnpm vitest run packages/core packages/render-text`；Commit：

```bash
git commit -am "feat(core/render-text): langOverride dispatch 透传——code 渲染语言手动指定注入口（spec §4.1）"
```

---

### Task 5: MetaPanel 语言行升级（input + datalist）

**Files:**
- Modify: `packages/highlight/src/langdetect.ts`（尾部新导出）+ 包出口（若 langdetect 未在 index 导出则补 re-export，`rg -n 'langdetect' packages/highlight/src/index.ts packages/highlight/package.json` 核对）
- Modify: `apps/web/src/lib/MetaPanel.svelte`（「语言」行 `:173-175`）
- Test: `packages/highlight/src/langdetect.test.ts`（先 `rg -l 'detectLanguage' packages/highlight --glob '*.test.ts'` 定位）

**Interfaces:**
- Produces: `detectableLanguageNames(): string[]`（canonical 名集合，字典序）。

- [ ] **Step 1: RED**：

```ts
it('detectableLanguageNames 返回 canonical 名字典序去重集', () => {
  const names = detectableLanguageNames();
  expect(names).toContain('rust');
  expect(names).toEqual([...new Set(names)].sort());
});
```

- [ ] **Step 2: 实现**（langdetect.ts 尾部）：

```ts
/** 语言手动指定候选集（spec §4.2）：canonical 名（grammar 字段优先，缺省键名），
 * 字典序去重——datalist 建议用，非校验用（宽松透传，引擎链自兜底）。 */
export function detectableLanguageNames(): string[] {
  const names = new Set<string>();
  for (const [name, entry] of Object.entries(languagesTable as Record<string, LangEntry>)) {
    names.add(entry.grammar ?? name);
  }
  return [...names].sort();
}
```

- [ ] **Step 3: MetaPanel UI**——「语言」行改（script 加 `langNames = detectableLanguageNames()` 一次性取值 + `onLangCommit` 走 Task 3 的 `tabStore.setHighlightLang`）：

```svelte
<dt>语言</dt>
<dd>
  <input
    list="vv-lang-datalist"
    value={fileMeta.langOverrideDisplay ?? ''}
    placeholder={fileMeta.lang ? `自动（${fileMeta.lang}）` : '自动'}
    onchange={(e) => onLangCommit((e.currentTarget as HTMLInputElement).value)}
    aria-label="高亮语言（留空自动检测）"
    spellcheck="false"
  />
  <datalist id="vv-lang-datalist">{#each langNames as n (n)}<option value={n} />{/each}</datalist>
  {#if langOverrideActive}<span class="meta-openwith-manual">（手动）</span>{/if}
</dd>
```

`onLangCommit`：`trim() === '' → setHighlightLang(tab.id, null)`，否则原值透传（不校验）；`langOverrideActive`/显示值自激活 tab 的 `overrideLang` 派生。注：highlightAuto 嗅探结果不回写 fileMeta.lang 为既有现状（spec 注记，不动）。

- [ ] **Step 4: 门禁** — `pnpm vitest run packages/highlight && pnpm --filter web typecheck`；Commit：

```bash
git commit -am "feat(web/highlight): 语言行可编辑 datalist——手动高亮语言主入口（spec §4.2）"
```

---

### Task 6: 状态栏 + Tab 右键语言轻入口

**Files:**
- Modify: `apps/web/src/lib/ViewerPane.svelte:470-483`（状态栏浮层底部加项）
- Modify: `apps/web/src/lib/TabBar.svelte:85-93`（ctxActions 加单项）

**Interfaces:**
- Consumes: Task 5 的 MetaPanel 聚焦目标（`#vv-lang-datalist` 所属 input；MetaPanel 由 AppShell 渲染——跳转经事件总线 `document.dispatchEvent(new CustomEvent('vv:focus-meta-lang'))`，AppShell 侧确保右栏展开 + MetaPanel input focus；移动端开抽屉同通道）。

- [ ] **Step 1: 状态栏浮层加项**（`.vv-status-picker` 菜单尾部，role=menuitem）：

```svelte
<button role="menuitem" class="vv-status-picker-lang" onclick={focusMetaLang}>
  语言：{langOverrideText}
</button>
```

`langOverrideText`：激活 tab 有 `overrideLang` → `rust（手动）`；否则 `自动（检测 ${detLabel === '—' ? '—' : fileMeta.lang ?? '—'}）`（检测语言从 `fileMeta.lang` 读，缺省「自动」）。

- [ ] **Step 2: Tab 右键加项**（ctxActions，「打开方式」项旁）：

```ts
{ label: `语言：${langLabelOf(tab)}（在属性面板中修改）`, onClick: () => focusMetaLang() },
```

- [ ] **Step 3: AppShell 侧消费**（`rg -n 'MetaPanel' apps/web/src/lib/AppShell.svelte` 定位挂载处）——监听 `vv:focus-meta-lang`：右栏折叠则展开 → `document.querySelector<HTMLInputElement>('input[list="vv-lang-datalist"]')?.focus()`（移动端先开抽屉再 focus，`rg -n 'drawer|抽屉' apps/web/src/lib/AppShell.svelte` 复用既有开启函数）。

- [ ] **Step 4: 门禁 + Commit** — `pnpm --filter web typecheck`；手测桌面+移动形态跳转；Commit：

```bash
git commit -am "feat(web): 状态栏/Tab 右键语言轻入口——跳转属性面板聚焦语言行（spec §4.2）"
```

---

### Task 7: 徽标即复制 + 右下角复制钮退役

**Files:**
- Modify: `packages/render-text/src/markdown/pipeline.ts:465-511`（runCopyCode 重构）
- Modify: `apps/web/src/app.css`（codeLang 点击态样式；rg 'codeLang\|copyBtn' 定位既有规则）
- Modify: `packages/render-text/src/markdown/export.ts`（导出剥离面，`rg -n 'codeBar|copyBtn' packages/render-text/src/markdown/export.ts` 核对既有剥离清单）

**Interfaces:**
- Produces: `.md-code-bar` 单按钮结构（`button.codeLang`，有语言=语言词、无语言=「复制」二字）；复制反馈 1.5s（成功「已复制」/失败「复制失败」，回还原词）。data-md-lang 属性与取词逻辑不变。

- [ ] **Step 1: RED 用例**（pipeline 既有测试文件 `rg -l 'runCopyCode\|md-copy' packages/render-text/src/markdown --glob '*.test.ts'` 定位，镜像其 DOM 断言装置）：

```ts
it('徽标即复制：bar 为单 button，点击复制代码且 1.5s 后回原词', async () => {
  const { bar } = await renderWithFence('```rust\nfn main() {}\n```');
  const btn = bar.querySelector('button');
  expect(btn?.textContent).toBe('rust');
  expect(bar.querySelectorAll('button')).toHaveLength(1); // 复制钮退役
  /* clipboard 桩（沿用既有测试的 navigator.clipboard mock；无则 Object.defineProperty 注入 writeText 桩） */
  btn!.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  expect(btn?.textContent).toBe('已复制');
  vi.advanceTimersByTime(1500);
  expect(btn?.textContent).toBe('rust');
});
it('无语言块徽标显示「复制」且可点', async () => { /* ``` 围栏无语言 → textContent '复制' */ });
```

- [ ] **Step 2: RED 确认** → **Step 3: 重构 runCopyCode**——label 由 span 改 button、点击处理并入（copy 回调/feedback 逻辑复用既有 `:493-507` 代码，反馈对象从 btn 换 label 本体、还原词=记录的原始 label）、删除独立 copyBtn 段（`:488-508`）；模块头拍板注释（`:465-470`）改写为「spec 2026-10-23 §5 重开拍板：徽标即复制单入口，markpad copyCode.ts 对齐」。

```ts
const bar = root.createElement('span');
bar.className = cls(ctx, 'codeBar');
const code = pre.querySelector('code');
const langClass = code ? Array.from(code.classList).find((c) => c.startsWith('language-')) : undefined;
const lang = code?.getAttribute('data-md-lang') ?? (langClass ? langClass.slice('language-'.length).toLowerCase() : '');
const btn = root.createElement('button');
btn.type = 'button';
btn.className = cls(ctx, 'codeLang');
btn.title = '点击复制代码';
const baseLabel = lang || '复制';
btn.textContent = baseLabel;
let revertTimer: ReturnType<typeof setTimeout> | null = null;
const feedback = (text: string): void => {
  btn.textContent = text;
  if (revertTimer !== null) clearTimeout(revertTimer);
  revertTimer = setTimeout(() => { revertTimer = null; btn.textContent = baseLabel; }, 1500);
};
btn.addEventListener('click', () => {
  const text = (pre.querySelector('code')?.textContent ?? '').replace(/\n$/, '');
  const p = navigator.clipboard?.writeText(text);
  if (p) void p.then(() => feedback('已复制'), () => feedback('复制失败'));
  else feedback('复制失败');
});
bar.appendChild(btn);
pre.insertBefore(bar, pre.firstChild);
```

- [ ] **Step 4: CSS + 导出剥离**——app.css 给 `.vv-md-codeLang`（cls 实际产物名以既有规则为准）加 `cursor:pointer; user-select:none;`；export.ts 交互剥离清单确认 button→span 转换（若既有清单按标签通用剥 button 则补语言词保留：replace button 为 span 且 innerText 保留）。

- [ ] **Step 5: GREEN + 回归 + Commit** — `pnpm vitest run packages/render-text`；既有断言 copyBtn 的用例改徽标锚：

```bash
git commit -am "feat(render-text): 语言徽标即复制单入口——右下角复制钮退役，markpad copyCode 对齐（spec §5）"
```

---

### Task 8: e2e 锚更新与新增（OWX/LANG/MD 徽标）

**Files:**
- Modify: `apps/web/e2e/b-error-card-open-as.spec.ts` 及 OWX 系（`rg -l '自动（按扩展名）' apps/web/e2e`）
- Create: `apps/web/e2e/b-override-lang.spec.ts`
- Modify: 复制钮 e2e（`rg -l '复制' apps/web/e2e --glob '*.spec.ts'` 定位 MD 域既有复制断言）
- Create: `docs/e2e/override-lang.md`（域文档，项目惯例）

- [ ] **Step 1: OWX 候选集锚更新**——`.md` 类序不变；`.txt`/未知/二进制类在 code 与 hex 之间插 Markdown。逐处断言更新并加行注 `// spec 2026-10-23 §3.1 markdown 恒兜底`。OWX-09 错误卡 open-as 排序锚核对「重试恒排首、组内排序」语义不受影响。

- [ ] **Step 2: 新建 b-override-lang.spec.ts**（共享装置参考既有 b-*.spec.ts 的 openFile helper；开序先开后设，防 TAX-13 假阴性）：

```ts
test('LANG-01 属性面板设语言→重渲染按指定语言高亮', async ({ page }) => {
  /* 打开 .txt（内容 rust 代码）→ 右栏语言行填 rust → 断言 pre code 含 language-rust 树Span */
});
test('LANG-02 置空回自动', async ({ page }) => { /* 填空 → 无（手动）徽标 */ });
test('LANG-03 快照恢复：reload 后 overrideLang 仍在且生效', async ({ page }) => { /* reload → language-rust 仍现 */ });
test('LANG-04 duplicate 继承 overrideLang', async ({ page }) => { /* 复制 tab → 新 tab 语言行值 rust */ });
test('LANG-05 状态栏轻入口跳转聚焦语言输入框', async ({ page }) => { /* 点浮层语言项 → input 聚焦 */ });
```

断言细节：设置语言后需触发渲染 effect（`overrideLang` 经 setHighlightLang rev++ 即时生效）；clipboard 类断言grant `clipboard-read/clipboard-write`（`rg -n 'grantPermissions' apps/web/e2e` 复用既有写法）。

- [ ] **Step 3: MD 徽标复制 e2e 改锚**——既有「复制钮点击→剪贴板」断言改选 `button`（codeBar 内唯一 button），补无语言块「复制」词断言；删除/改写对旧 copyBtn 选择器的引用。

- [ ] **Step 4: 重建 + 双通道门禁**

```bash
pnpm build:e2e && pnpm --filter web exec playwright test --project=chromium
pnpm --filter web exec playwright test --project=chromium b-override-lang.spec.ts b-error-card-open-as.spec.ts
```

（具体 script 名以根 package.json/`apps/web/package.json` 实际为准：`rg -n '"e2e' package.json apps/web/package.json`。）
Expected: 全绿零翻转（OWX 更新处按注记翻转）。

- [ ] **Step 5: Commit**

```bash
git add apps/web/e2e docs/e2e/override-lang.md
git commit -m "test(e2e): OWX 候选集 +markdown 锚更新与 LANG-01..05 overrideLang 全链（spec §3/§4）"
```
