# applyAppearance 订阅中心化 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把外观主题注入的 5 处直调收敛为 TopBar 单订阅 + 生效四元组 diff，`applyAppearance` 并发改 token 弃单（last-INITIATED 胜），`loadSettings` 补外观槽格式白名单。

**Architecture:** theme.ts 为注入管线唯一归属：`applyAppearance` 内嵌 monotonic token（每个 await 恢复后比对，被超越即弃单）与 `lastAppearanceSig` 签名记录；新增 `applyAppearanceFromSettings(settings)` 作订阅触发入口（diff `(mode, appearance, codeTheme)` 四元组，无变化不注入）。TopBar 的 onSettingsChanged / onSystemModeChange / onMount 全部走该入口，cycleTheme 与 onCodeThemeChange 经 saveSettings 自触发；SettingsPanel 直调整体拆除。

**Tech Stack:** Svelte 5 runes（apps/web）、vitest + fake-indexeddb（theme.test.ts 既有基建）、svelte-check（0E/0W 新门禁）、Playwright（默认通道 e2e）。

**Spec:** `docs/superpowers/specs/2026-10-12-appearance-subscription-design.md`

## Global Constraints

- 注入文本形态零变更：default 路径须与 `legacyExpectedText(name, mode)`（theme.test.ts:44-47）逐字节等价；现有 388 行断言不得改动。
- e2e 断言零变更（t-theme / b-theme-system 只回归不改断言）。
- 禁止 `any`；运行时存在但类型缺失的 API 用受控断言 + 注释（viewer.ts:152 先例）。
- `vsixImport.test.ts` 迁移用例保持在文件最前、`stores/session.test.ts` onversionchange 用例保持在最后（文件内注释声明顺序耦合，本轮不触碰这两个文件）。
- 每个任务完成即 commit（Angular 规范，先 why 后 what）。

---

### Task 1: applyAppearance token 弃单（last-INITIATED 胜）

**Files:**
- Modify: `apps/web/src/lib/theme.ts:263-288`（applyAppearance 函数体）
- Test: `apps/web/src/lib/theme.test.ts`（新增 describe，置于现有 `applyAppearance` describe 之后）

**Interfaces:**
- Consumes: 现有 `applyAppearance(appearance: AppearanceRef, mode: 'light' | 'dark', codeTheme: string): Promise<void>`（签名不变）；`resolveAppearance` / `injectAppearance` / `injectCodeTheme`（均为 theme.ts 内部既有函数，不动）。
- Produces: 模块级 `lastAppearanceSig: string | null`（Task 2 的 diff 消费）；`applyAppearance` 语义升级——被更新调用超越的调用不写 style 节点、不落签名。

- [ ] **Step 1: 写失败测试（交错弃单）**

在 `apps/web/src/lib/theme.test.ts` 现有 `describe('applyAppearance…')` 块后新增（`putTheme`/`ImportedTheme`/`legacyExpectedText`/`styleEl` 均为该文件既有导入与辅助）：

```ts
describe('applyAppearance 并发弃单（spec：last-INITIATED 胜）', () => {
  it('先发慢调用（IndexedDB 宏任务）被后发快调用（缓存微任务）超越：终态=后发', async () => {
    // putTheme 写真库（fake-indexeddb）：imported 路径经 listImportedThemes 的
    // IndexedDB 回调（宏任务）恢复，必然晚于 default 路径的缓存 tablesPromise
    //（纯微任务）——token 规则下后发 p2 胜与完成顺序无关，断言确定性成立
    const theme: ImportedTheme = {
      id: 'imp-race',
      name: 'Race Theme',
      addedAt: 1,
      json: { colors: { 'editor.background': '#101010' } }
    };
    await putTheme(theme);
    const p1 = applyAppearance('imported:imp-race', 'dark', 'serika-dark');
    const p2 = applyAppearance('default', 'dark', 'onelight');
    await Promise.all([p1, p2]);
    expect(styleEl()?.textContent).toBe(await legacyExpectedText('onelight', 'dark'));
  });
});
```

- [ ] **Step 2: 跑测试确认红**

Run: `cd /share/rw/repo/server/vviewer/apps/web && pnpm exec vitest run src/lib/theme.test.ts -t "并发弃单"`
Expected: FAIL——textContent 为 imported 主题形态（p1 后完成并覆写），不等于 default 期望文本。

- [ ] **Step 3: 实现 token 弃单 + 签名记录**

`theme.ts` 改造模块级状态（置于 applyAppearance 上方）：

```ts
// 外观注入并发序号与上次生效签名（spec 2026-10-12 §2.2）：monotonic token 弃单——
// 每个 await 恢复后比对序号，被更新调用超越即静默放弃（last-INITIATED 胜）；
// 签名仅在未被弃单、真正完成注入的同步段写入，供 applyAppearanceFromSettings diff。
let appearanceCallSeq = 0;
let lastAppearanceSig: string | null = null;

function appearanceSig(mode: 'light' | 'dark', appearance: string, codeTheme: string): string {
  return `${mode}|${appearance}|${codeTheme}`;
}
```

`applyAppearance` 函数体改为（注释更新并发段）：

```ts
export async function applyAppearance(
  appearance: AppearanceRef,
  mode: 'light' | 'dark',
  codeTheme: string
): Promise<void> {
  const token = ++appearanceCallSeq;
  const json = appearance === 'default' ? null : await resolveAppearance(appearance);
  if (token !== appearanceCallSeq) return; // 已被更新调用超越：弃单，不写 style 不落签名
  if (json && injectAppearance(appearance, mode, json)) {
    lastAppearanceSig = appearanceSig(mode, appearance, codeTheme);
    return;
  }
  if (appearance !== 'default') console.warn(`未知外观主题：${appearance}，回退 default`);
  await injectCodeTheme(codeTheme, mode);
  if (token !== appearanceCallSeq) return; // loadTables 等待期被超越：注入文本已被更新调用覆写，只补签名
  lastAppearanceSig = appearanceSig(mode, 'default', codeTheme);
}
```

语义说明（写进代码注释或 commit message）：fallback 路径签名记 `effective='default'`（注入文本的真实形态）；订阅 diff 用「请求槽值」比对，非法槽值每次都会重注入一次 default 文本（幂等无害），换取签名恒等于注入真相。第二个 token 检查只护签名簿记——style 写点在 `injectCodeTheme` 内部，被超越调用的中间态写入会被新调用的注入覆盖，终态仍为 last-INITIATED。

- [ ] **Step 4: 跑测试确认绿（含全文件回归）**

Run: `pnpm exec vitest run src/lib/theme.test.ts`
Expected: 全部 PASS（新增弃单用例 + 既有 388 行断言不动全绿——applyCodeTheme 薄包装路径的签名记录对其无影响）。

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/lib/theme.ts apps/web/src/lib/theme.test.ts
git commit -m "feat(web): applyAppearance 并发 token 弃单——last-INITIATED 胜修快速切槽覆写竞态

两处 await（IndexedDB/动态 import）交错时 last-resolved 胜：旧槽慢调用恢复后
整体覆写 style#vv-code-theme 且无自愈（spec 2026-10-12 §2.2）。monotonic
token：await 恢复后比对序号，被超越即弃单；lastAppearanceSig 记录生效签名
（供订阅 diff），弃单者不写。"
```

### Task 2: applyAppearanceFromSettings 订阅入口（diff 四元组）

**Files:**
- Modify: `apps/web/src/lib/theme.ts`（文件尾部，effectiveMode 旁）
- Test: `apps/web/src/lib/theme.test.ts`（新增 describe）

**Interfaces:**
- Consumes: Task 1 的 `lastAppearanceSig` / `appearanceSig` / `applyAppearance`；既有 `effectiveMode(themeMode)`（theme.ts:305-310）；`Settings` 类型（theme.ts 已 `import type { Settings } from './stores/settings'`——effectiveMode 签名在用，若无则补）。
- Produces: `export function applyAppearanceFromSettings(settings: Settings): void`——Task 4 的 TopBar 接线唯一入口。

- [ ] **Step 1: 写失败测试（首次注入 / 无关变化跳过 / 槽变化注入 / system 解析）**

```ts
import {
  applyAppearanceFromSettings,
  // …并入上方既有 import 块
} from './theme';
import type { Settings } from './stores/settings';

describe('applyAppearanceFromSettings（订阅触发入口，spec 2026-10-12 §2.1）', () => {
  // DEFAULTS 是 settings.ts 模块私有：fixture 显式内联（同 settings.test.ts BASE 先例）
  const base = (): Settings => ({
    themeMode: 'dark',
    appearanceLight: 'default',
    appearanceDark: 'default',
    codeThemeLight: 'onelight',
    codeThemeDark: 'onelight',
    excludedPatterns: [],
    autoRefresh: true,
    computePolicy: 'auto'
  });

  it('首次调用必注入（签名初值 null）', async () => {
    applyAppearanceFromSettings(base());
    await vi.waitFor(() => expect(styleEl()).not.toBeNull());
    expect(styleEl()?.textContent).toBe(await legacyExpectedText('onelight', 'dark'));
  });

  it('槽无关字段变化（excludedPatterns）不注入——style 节点零变动', async () => {
    applyAppearanceFromSettings(base());
    await vi.waitFor(() => expect(styleEl()).not.toBeNull());
    const before = styleEl()?.textContent;
    const mutations: unknown[] = [];
    const mo = new MutationObserver((m) => mutations.push(...m));
    mo.observe(styleEl()!, { characterData: true, childList: true, subtree: true });
    applyAppearanceFromSettings({ ...base(), excludedPatterns: ['node_modules'] });
    await new Promise((r) => setTimeout(r, 20));
    expect(mutations).toHaveLength(0);
    expect(styleEl()?.textContent).toBe(before);
    mo.disconnect();
  });

  it('代码主题槽变化 → diff 命中重注入', async () => {
    applyAppearanceFromSettings(base());
    await vi.waitFor(() => expect(styleEl()).not.toBeNull());
    applyAppearanceFromSettings({ ...base(), codeThemeDark: 'serika-dark' });
    await vi.waitFor(() =>
      expect(styleEl()?.textContent).toBe(await legacyExpectedText('serika-dark', 'dark'))
    );
  });

  it('themeMode=system 按 effectiveMode 解析槽（stub matchMedia dark → dark 槽）', async () => {
    vi.stubGlobal('matchMedia', (q: string) => ({
      matches: q.includes('dark'),
      addEventListener: () => {},
      removeEventListener: () => {}
    }));
    const s: Settings = { ...base(), themeMode: 'system', codeThemeDark: 'serika-dark' };
    applyAppearanceFromSettings(s);
    await vi.waitFor(() => expect(styleEl()?.textContent).toBe(await legacyExpectedText('serika-dark', 'dark')));
  });
});
```

注意：`afterEach`（:49-53）已统一清 style 节点与 stub，`lastAppearanceSig` 是模块级状态跨用例残留——首例「首次必注入」若前面用例已注入过同签名文本会假绿。对策：用例内先用一次**必然不同**的注入（如先 `await applyCodeTheme('serika-dark', 'dark')`）把签名推离，再走 FromSettings 路径断言；四个用例各自保证签名起点不同。

- [ ] **Step 2: 跑测试确认红**

Run: `pnpm exec vitest run src/lib/theme.test.ts -t "applyAppearanceFromSettings"`
Expected: FAIL——`applyAppearanceFromSettings` 未导出（TS 编译错）。

- [ ] **Step 3: 实现入口**

`theme.ts` 尾部（effectiveMode 旁）：

```ts
/**
 * 订阅触发入口（spec 2026-10-12 §2.1）：按 settings 计算生效四元组
 * (mode, appearance, codeTheme)，与上次注入签名 diff——仅槽相关变化才注入。
 * 口径为「生效值」而非「原始槽值」：system 的亮暗解析在 effectiveMode 内完成，
 * OS 亮暗切换（不经 saveSettings）同样命中 diff；excludedPatterns 等无关字段
 * 变化零注入。非法槽值注入期回退 default（applyAppearance 既有行为）后落
 * effective 签名——同一非法槽值重复触发会幂等重注入一次，无害。
 */
export function applyAppearanceFromSettings(settings: Settings): void {
  const mode = effectiveMode(settings.themeMode);
  const appearance = mode === 'dark' ? settings.appearanceDark : settings.appearanceLight;
  const codeTheme = mode === 'dark' ? settings.codeThemeDark : settings.codeThemeLight;
  const sig = appearanceSig(mode, appearance, codeTheme);
  if (sig === lastAppearanceSig) return;
  void applyAppearance(appearance, mode, codeTheme);
}
```

- [ ] **Step 4: 跑测试确认绿（全文件）**

Run: `pnpm exec vitest run src/lib/theme.test.ts`
Expected: 全 PASS。

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/lib/theme.ts apps/web/src/lib/theme.test.ts
git commit -m "feat(web): applyAppearanceFromSettings 订阅入口——生效四元组 diff

按 settings 计算 (mode, appearance, codeTheme) 与 lastAppearanceSig 比对，
槽无关变化（excludedPatterns 等）零注入；口径为生效值——system 亮暗切换
不经 saveSettings 同样命中（spec 2026-10-12 §2.1）。"
```

### Task 3: loadSettings 外观槽格式白名单

**Files:**
- Modify: `apps/web/src/lib/stores/settings.ts:36-47`
- Test: `apps/web/src/lib/stores/settings.test.ts`

**Interfaces:**
- Consumes: 既有 `Settings`/`DEFAULTS`/`loadSettings`。
- Produces: `loadSettings` 对 `appearanceLight/appearanceDark` 做格式白名单——`'default'` 或 `'vscode:'`/`'imported:'` 前缀，违规归位 `'default'`（存在性校验仍由注入期 warn+回退兜底）。

- [ ] **Step 1: 写失败测试**

在 `settings.test.ts` 新增（BASE fixture 已对齐 DEFAULTS，含 appearanceLight/appearanceDark）：

```ts
describe('loadSettings 外观槽格式白名单（spec 2026-10-12 §2.3）', () => {
  it('非法格式（无前缀的任意串）归位 default', () => {
    localStorage.setItem(
      'vviewer:settings',
      JSON.stringify({ ...BASE, appearanceLight: 'javascript:dark', appearanceDark: '42' })
    );
    const s = loadSettings();
    expect(s.appearanceLight).toBe('default');
    expect(s.appearanceDark).toBe('default');
  });

  it('合法形态原样通过：default / vscode: 内置名 / imported:<id>', () => {
    localStorage.setItem(
      'vviewer:settings',
      JSON.stringify({ ...BASE, appearanceLight: 'vscode:Dark Modern', appearanceDark: 'imported:abc123' })
    );
    const s = loadSettings();
    expect(s.appearanceLight).toBe('vscode:Dark Modern');
    expect(s.appearanceDark).toBe('imported:abc123');
  });
});
```

- [ ] **Step 2: 跑测试确认红**

Run: `pnpm exec vitest run src/lib/stores/settings.test.ts`
Expected: 第一例 FAIL（'javascript:dark' 原样通过）。

- [ ] **Step 3: 实现白名单**

`settings.ts` loadSettings 内（computePolicy 校验旁同模式）：

```ts
// computePolicy 白名单校验：旧版本/手改 localStorage 的非法值回落默认
if (!POLICIES.includes(s.computePolicy)) s.computePolicy = DEFAULTS.computePolicy;
// 外观槽格式白名单（spec 2026-10-12 §2.3）：'default' 或 'vscode:'/'imported:'
// 前缀；存在性校验（内置名单/imported id）由注入期 warn+回退兜底，此处只挡格式
for (const key of ['appearanceLight', 'appearanceDark'] as const) {
  const v = s[key];
  if (v !== 'default' && !v.startsWith('vscode:') && !v.startsWith('imported:')) {
    s[key] = DEFAULTS[key];
  }
}
```

- [ ] **Step 4: 跑测试确认绿**

Run: `pnpm exec vitest run src/lib/stores/settings.test.ts`
Expected: 全 PASS。

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/lib/stores/settings.ts apps/web/src/lib/stores/settings.test.ts
git commit -m "fix(web): loadSettings 外观槽格式白名单——脏 localStorage 归位 default

appearance 字段此前无校验，任意串直达注入只靠 warn+回退兜底（spec
2026-10-12 §2.3）。与 computePolicy 同模式：default / vscode: / imported:
前缀之外归位 default；存在性校验仍在注入期。"
```

### Task 4: TopBar 单订阅收敛 + SettingsPanel 直调拆除

**Files:**
- Modify: `apps/web/src/lib/TopBar.svelte:50-54, 100-116, 164-182`
- Modify: `apps/web/src/lib/SettingsPanel.svelte:1-9(注释), 128-148, 174-199` 及 import 块

**Interfaces:**
- Consumes: Task 2 的 `applyAppearanceFromSettings(settings: Settings): void`。
- Produces: 全仓 `applyAppearance(` 直调仅剩 theme.ts 内部与测试；`reapplyAppearance` 不复存在。

- [ ] **Step 1: TopBar 改造**

1. import 块：`applyAppearance` → `applyAppearanceFromSettings`（applyAppearance 在本组件仅剩的三处调用全删后不再引用）。
2. 删 `applyCurrentAppearance` 函数（:50-54，连同注释）。
3. onMount（:100-116）：

```ts
onMount(() => {
  void themeOptions().then((opts) => (codeThemeOptions = opts));
  applyAppearanceFromSettings(settings); // 首次注入：签名初值 null 必命中
  // 订阅设置变更保持本副本最新（防本组件 saveSettings 写回旧值），同时作为
  // 注入的唯一触发通道：diff 四元组、槽相关变化才注入（spec 2026-10-12 §2.4）
  const offSettings = onSettingsChanged((s) => {
    settings = s;
    applyAppearanceFromSettings(s);
  });
  // themeMode=system：OS 亮暗切换不经 saveSettings，effectiveMode 随之变化命中
  // diff（UI 配色由 prefers-color-scheme 媒体查询自动跟随，JS 注入变量需要这步）
  const offSystem = onSystemModeChange(() => {
    if (settings.themeMode !== 'system') return;
    applyAppearanceFromSettings(settings);
  });
  // …以下不变
```

4. `cycleTheme`（:164-172）：删末行 `applyCurrentAppearance();`——saveSettings → 订阅 → effectiveMode 变化命中；`dataset.themeMode` 直写保留（CSS 侧即时性）。
5. `onCodeThemeChange`（:174-182）：删末行 `void applyAppearance(...)` 与注释——saveSettings → 订阅 → codeTheme 变化命中；函数体剩槽记忆 + saveSettings。

- [ ] **Step 2: SettingsPanel 拆除**

1. 删 `reapplyAppearance`（:128-139，连同注释）。
2. `onAppearanceChange`（:141-148）：删 `reapplyAppearance();` 调用，注释改为「槽切换：即时持久化——注入由 TopBar 的 onSettingsChanged 订阅 diff 触发（spec 2026-10-12 §2.4）」。
3. `removeImported`（:194-197）：`if (changed) { saveSettings(fresh); }`——删 `reapplyAppearance();`。
4. import 块：移除不再引用的 `applyAppearance`/`effectiveMode`（若 effectiveMode 仅 reapplyAppearance 在用）；文件头注释（:6-9「TopBar 的 onSettingsChanged 订阅只刷新响应式副本，不重触发注入」）改写为「TopBar 订阅即注入触发通道（spec 2026-10-12）」。

- [ ] **Step 3: 静态验证**

Run: `rg -n "applyAppearance\(" apps/web/src` → 仅 theme.ts（定义/内部）与 applyAppearanceFromSettings 定义行；`rg -n "reapplyAppearance" apps/web/src` → 零命中。
Run: `npx svelte-check`（apps/web）→ 0 ERRORS 0 WARNINGS（未用 import 会被类型门禁捕获）。
Run: `cd /share/rw/repo/server/vviewer && pnpm test` → 全绿。

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/lib/TopBar.svelte apps/web/src/lib/SettingsPanel.svelte
git commit -m "refactor(web): 外观注入收敛 TopBar 单订阅——拆除 5 处直调

T4 计划口径归还：onSettingsChanged 订阅即注入触发通道（diff 四元组），
cycleTheme/onCodeThemeChange 经 saveSettings 自触发，onMount 初始化与
onSystemModeChange 改调同一入口；SettingsPanel reapplyAppearance 整体
拆除（spec 2026-10-12 §2.4）。"
```

### Task 5: e2e 回归 + 验收

**Files:**
- 无新增修改（验收任务）

- [ ] **Step 1: 重建 + 定向 e2e**

Run: `cd /share/rw/repo/server/vviewer/apps/web && pnpm build`
Run: `pnpm exec playwright test e2e/t-theme.spec.ts`（B-THEME-1..4，桌面+mobile 双项目）
Expected: 全 PASS（断言零变更）。

Run: `pnpm exec playwright test -g "b-theme" 2>/dev/null || pnpm exec playwright test e2e/ --grep -i "theme"`
Expected: 主题相关既有用例全 PASS（b-theme-system 的 system 切换路径）。

- [ ] **Step 2: 验收清单（spec §5）**

1. `pnpm test` 全绿（新增 ≥7 用例）。
2. `npx svelte-check` 0E/0W。
3. Task 4 Step 3 的两条 rg 断言。
4. spec 状态行改「已实施」（`docs/superpowers/specs/2026-10-12-appearance-subscription-design.md:3`）。

- [ ] **Step 3: Commit（如 spec 状态有改）**

```bash
git add docs/superpowers/specs/2026-10-12-appearance-subscription-design.md
git commit -m "docs(spec): applyAppearance 中心化标记已实施"
```
