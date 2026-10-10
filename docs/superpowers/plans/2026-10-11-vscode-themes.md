# VSCode Dark/Light Modern 集成与主题导入（JSON/VSIX） 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 内置 VSCode Dark/Light Modern 外观主题（UI+代码配色一物两用），支持导入 VSCode 主题 JSON 与 VSIX 扩展包，存 IndexedDB，设置面板亮暗双槽管理。

**Architecture:** `packages/highlight/src/vscode.ts` 纯函数层（主题 JSON 校验、colors→UI token 映射表、tokenColors→capture 移植 Markpad 算法：精确表+最长前缀 starts_with+先到先得）；`theme.ts` 的 `applyAppearance` 把 UI vars + code vars + hljs vars 组装进既有 `style#vv-code-theme` 单节点（THEME_ROOT_SELECTOR 亮暗 specificity 设施复用）；IndexedDB 升版 2 加 `themes` store；设置面板新增「界面主题」区；VSIX 经 `@vviewer/render-archive/zipStore` 的 createZipStore 解包。

**Tech Stack:** TypeScript（highlight 纯函数 + Svelte 5 设置面板）、jszip（已有依赖，经 zipStore）、IndexedDB（v1→v2）、vitest（Markpad 内置值当快照基准）、Playwright。

**Spec:** `docs/superpowers/specs/2026-10-11-vscode-themes-design.md`

## Global Constraints

- **注入设施**：复用 `style#vv-code-theme` 单节点（`THEME_ROOT_SELECTOR` 四形态 specificity 是唯一现成亮暗机制；双节点禁）。注入文本形态变化必须同步 `theme.test.ts` 精确断言（L61-84）与 `t-theme.spec.ts` THEME-06/2、`b-theme-system` 的 style 文本断言。
- **既有观感零变化**：app.css 三块（L2-28）的 default 值不动；新 token 只增不改；appearance='default' 时注入内容与现状逐字节等价（不含 UI vars 时与旧文本全等）。
- **UI token 扩展**：现 8 个 `--ui-*` 之外新增 6 个：`--ui-input-bg`、`--ui-hover-bg`、`--ui-selection-bg`、`--ui-statusbar-bg`、`--ui-danger`（现仅 fallback 使用，app.css L232/275/280/287）、`--ui-warning`；亮暗 default 值取现观感近似。
- **colors→UI token 映射表**（12 条）：`editor.background→--ui-bg`、`editor.foreground→--ui-fg`、`sideBar.background→--ui-side-bg`、`editorWidget.background→--ui-tab-bg`、`tab.activeBackground→--ui-tab-active-bg`、`input.background→--ui-input-bg`、`list.hoverBackground→--ui-hover-bg`、`editor.selectionBackground→--ui-selection-bg`、`statusBar.background→--ui-statusbar-bg`、`focusBorder→--ui-accent`、`editorError.foreground→--ui-danger`、`editorWarning.foreground→--ui-warning`；缺键回退 default（不推断），注释说明。
- **tokenColors→capture 算法**（移植 Markpad `vscode.rs` L129-198，**不解析 scope selector 语法**）：逐规则取 `settings.foreground`（空则 skip）；scope 为 string 或 array（逗号数组按 array 拆）；每 scope 先精确查 `TEXTMATE_TO_CAPTURE` 表（后写覆盖先写），未命中则全表线性 `scope.startsWith(tm)` 取**最长字符匹配**（前缀命中仅当该 capture 尚未写入——先到先得）；目标 capture 集 = theme.ts `CODE_CAPTURES`（53）。
- **校验**（JSON 导入）：`name` 必填非空；`type ∈ {dark, light, hc-black, hc-light}`（hc-* 归 dark）；`colors`/`tokenColors` 至少其一非空；单主题 JSON ≤1MB；VSIX 无总额外限额（zipStore 自带 200MB 输入闸），单主题 JSON 同 1MB。
- **代码主题槽语义**：appearance 为 vscode/imported 型时代码配色由其 tokenColors 接管；`codeThemeLight/Dark` 选择器仅 default 槽生效（UI 分区展示）。设置持久化仍走 `saveSettings`（appearanceLight/appearanceDark 新字段）；导入主题本体存 IndexedDB。
- **vendor**：两主题 JSON vendor 进 `packages/highlight/assets/vscode/`，文件头注释记录来源（microsoft/vscode 仓库 stable tag + 相对路径 extensions/theme-defaults/themes/）；THIRD_PARTY_NOTICES.md 增 MIT 条目（格式仿 L24 helix 行）。降级路径（无网络）：从 Markpad `dark_modern.rs`/`light_modern.rs` 的 capture 色值反向构造等效 JSON，文件头注明。
- 中文注释讲 why；TDD；每任务独立 commit（Angular 中文 message）。
- 门禁：`pnpm test`、`pnpm typecheck`、svelte-check 基线 12E/2W 不新增；e2e `t-theme.spec.ts` 回归 + 新增用例。

---

### Task 1: vendor 两主题 + vscode.ts 解析映射纯函数

**Files:**
- Create: `packages/highlight/assets/vscode/dark_modern.json`、`packages/highlight/assets/vscode/light_modern.json`
- Create: `packages/highlight/src/vscode.ts`
- Create: `packages/highlight/test/vscode.test.ts`
- Modify: `packages/highlight/src/index.ts`（re-export）

**Interfaces:**
- Produces:
  - `export interface VscodeThemeJson { name?: string; type?: string; colors?: Record<string, string>; tokenColors?: { scope?: string | string[]; settings?: { foreground?: string } }[] }`
  - `export function validateVscodeTheme(raw: unknown): { ok: true; theme: VscodeThemeJson & { name: string; kind: 'dark' | 'light' } } | { ok: false; reason: string }`（name 必填；type 白名单 hc-*→dark；colors/tokenColors 至少一非空）
  - `export const TEXTMATE_TO_CAPTURE: Record<string, string>`（移植 Markpad vscode.rs L10-126 全表）
  - `export function tokenColorsToThemeTable(tokenColors, captures: readonly string[]): ThemeTable`（算法见 Global Constraints；仅输出 captures 内的 capture）
  - `export function colorsToUiVars(colors: Record<string, string>): string[]`（12 条映射，CSS 变量赋值行 `--ui-bg: #1e1e1e;`；缺键跳过）
  - `export function themeKind(raw: VscodeThemeJson): 'dark' | 'light'`

- [ ] **Step 1: vendor 两主题 JSON**（`curl -fsSL https://raw.githubusercontent.com/microsoft/vscode/main/extensions/theme-defaults/themes/dark_modern.json -o packages/highlight/assets/vscode/dark_modern.json` 同 light_modern.json；main 不稳定则用任一近期 release tag；无网络时按 Global Constraints 降级路径构造并在文件头注明）。文件头各加注释行（JSON 无注释则放同目录 `README.md` 说明来源与许可）。
- [ ] **Step 2: 写失败测试**（vscode.test.ts）：

```ts
import { describe, expect, it } from 'vitest';
import { validateVscodeTheme, tokenColorsToThemeTable, colorsToUiVars, TEXTMATE_TO_CAPTURE } from '../src/vscode';

describe('validateVscodeTheme', () => {
  it('accepts dark_modern shape and normalizes hc to dark', () => {
    const r = validateVscodeTheme({ name: 'Dark Modern', type: 'hc-black', colors: { 'editor.background': '#1f1f1f' } });
    expect(r).toMatchObject({ ok: true });
    if (r.ok) expect(r.theme.kind).toBe('dark');
  });
  it('rejects missing name / empty colors+tokenColors / bad shape', () => {
    expect(validateVscodeTheme({ type: 'dark' }).ok).toBe(false);
    expect(validateVscodeTheme({ name: 'x', type: 'dark' }).ok).toBe(false);
    expect(validateVscodeTheme(null).ok).toBe(false);
  });
});

describe('tokenColorsToThemeTable（Markpad 快照基准）', () => {
  it('maps Markpad dark_modern capture values exactly', () => {
    // 来源：markpad-aio/Markpad/src-tauri/src/highlight/themes/dark_modern.rs create_color_map()
    const tokenColors = [
      { scope: ['comment'], settings: { foreground: '#6A9955' } },
      { scope: ['keyword.control'], settings: { foreground: '#C586C0' } },
      { scope: 'keyword', settings: { foreground: '#569CD6' } },
      { scope: 'string', settings: { foreground: '#CE9178' } },
      { scope: 'entity.name.function', settings: { foreground: '#DCDCAA' } },
    ];
    const t = tokenColorsToThemeTable(tokenColors, ['comment', 'keyword', 'keyword.control', 'string', 'function']);
    expect(t.comment).toEqual({ fg: '#6A9955' });
    expect(t['keyword.control']).toEqual({ fg: '#C586C0' }); // 精确表优先于 keyword 前缀
    expect(t.keyword).toEqual({ fg: '#569CD6' });
    expect(t.function).toEqual({ fg: '#DCDCAA' }); // entity.name.function 精确查表
  });
  it('prefix fallback takes longest starts_with and first-write wins per capture', () => {
    const tokenColors = [
      { scope: 'string.quoted.single', settings: { foreground: '#AAA' } },  // 前缀→string（先到）
      { scope: 'string', settings: { foreground: '#BBB' } },                // string 已写→不覆盖
      { scope: 'constant.numeric', settings: { foreground: '#CCC' } },
    ];
    const t = tokenColorsToThemeTable(tokenColors, ['string', 'constant.numeric']);
    expect(t.string).toEqual({ fg: '#AAA' });
    expect(t['constant.numeric']).toEqual({ fg: '#CCC' });
  });
  it('drops captures outside the requested set', () => {
    const t = tokenColorsToThemeTable([{ scope: 'comment', settings: { foreground: '#fff' } }], ['keyword']);
    expect(t.comment).toBeUndefined();
  });
});

describe('colorsToUiVars', () => {
  it('maps the 12 known keys and skips unknown/missing', () => {
    const vars = colorsToUiVars({ 'editor.background': '#1e1e1e', 'focusBorder': '#0078d4', 'made.up.key': '#000' });
    expect(vars).toContain('--ui-bg: #1e1e1e;');
    expect(vars).toContain('--ui-accent: #0078d4;');
    expect(vars.join('\n').split('\n').length).toBe(2);
  });
});
```

另加一条 vendor 资产锚点：`import dark from '../assets/vscode/dark_modern.json'` → `validateVscodeTheme(dark).ok === true` 且 `colorsToUiVars(dark.colors)` 含 `--ui-bg`。**注意**：若 `TEXTMATE_TO_CAPTURE` 移植全表后 `entity.name.function` 不在表内（以 Markpad 原表为准逐键核对），测试相应 capture 改用表内真实键——以「移植 Markpad L10-126 全表」为硬要求。

- [ ] **Step 3: 跑测试确认失败** → `pnpm vitest run packages/highlight/test/vscode.test.ts`（模块不存在）
- [ ] **Step 4: 实现 vscode.ts + index.ts re-export**（TEXTMATE_TO_CAPTURE 逐键移植 Markpad vscode.rs L10-126；算法按 Global Constraints）
- [ ] **Step 5: 跑测试确认通过 + 全量门禁** `pnpm vitest run packages/highlight/ && pnpm test && pnpm typecheck`
- [ ] **Step 6: Commit**

```bash
git add packages/highlight/assets/vscode packages/highlight/src/vscode.ts packages/highlight/test/vscode.test.ts packages/highlight/src/index.ts
git commit -m "feat(highlight): VSCode 主题解析映射纯函数与两主题 vendor

why: B 项地基——colors→UI token 与 tokenColors→capture 双映射需可独立单测。
what: validateVscodeTheme/TEXTMATE_TO_CAPTURE 全表（移植 Markpad）/
tokenColorsToThemeTable/colorsToUiVars + vendor dark/light_modern.json。"
```

---

### Task 2: applyAppearance 注入 + UI token 扩展 + settings 字段

**Files:**
- Modify: `apps/web/src/app.css`（L2-28 三块各加 6 个新 token 的 default 值；default 亮/暗观感近似值）
- Modify: `apps/web/src/lib/theme.ts`（applyCodeTheme → applyAppearance 扩展）
- Modify: `apps/web/src/lib/stores/settings.ts`（appearanceLight/appearanceDark 字段，默认 'default'）
- Modify: `apps/web/src/lib/TopBar.svelte`（三处调用点镜像）
- Modify: `apps/web/src/lib/theme.test.ts`（注入文本断言更新）

**Interfaces:**
- Consumes: Task 1 vscode.ts；`loadTables()`；现 `applyCodeTheme` 结构。
- Produces:
  - `type AppearanceRef = string`（'default' | 'vscode:Dark Modern' | 'imported:<id>'）
  - `async function applyAppearance(appearance: AppearanceRef, mode: 'light' | 'dark', codeTheme: string): Promise<void>`——'default' 时注入文本与**现状 applyCodeTheme 逐字节等价**（不含 UI vars 段）；vscode/imported 时注入 `UI vars 段 + themeToCssVars(tokenColorsToThemeTable(...)) 段 + hljsThemeVars 段`；未知 ref 回退 'default'（console.warn 一次）。
  - Settings 新字段 `appearanceLight: string; appearanceDark: string`（默认 'default'，向后兼容旧 localStorage）。

- [ ] **Step 1: 写失败测试**（theme.test.ts 追加；既有 L61-84 精确断言若因函数更名/签名变化需同步更新——'default' 路径文本必须保持全等）

```ts
describe('applyAppearance（B 项）', () => {
  it('default keeps legacy text identical', async () => {
    await applyAppearance('default', 'light', 'onelight');
    const el = document.getElementById('vv-code-theme')!;
    // 与 applyCodeTheme 时代文本逐字节等价（沿用既有精确断言文本）
    expect(el.textContent).toBe(legacyExpectedText('onelight', 'light'));
  });
  it('vscode ref injects UI vars + capture vars', async () => {
    await applyAppearance('vscode:Dark Modern', 'dark', 'serika-dark');
    const el = document.getElementById('vv-code-theme')!;
    expect(el.textContent).toContain('--ui-bg: #1f1f1f');      // dark_modern editor.background
    expect(el.textContent).toContain('--vv-ts-comment: #6A9955');
  });
  it('unknown ref falls back to default with warn', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await applyAppearance('imported:ghost', 'light', 'onelight');
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
```

（`legacyExpectedText` = 现测试的期望文本提取为共享 helper；'vscode:Dark Modern' 的解析需 theme.ts 能取到 vendor JSON——loadTables 同款动态 import `import('../@vviewer/highlight/assets/vscode/dark_modern.json')`，或 theme.ts 内置 VSCode 内置清单 `['vscode:Dark Modern', 'vscode:Light Modern']` → 对应 asset 路径。）

- [ ] **Step 2: 跑测试确认失败**
- [ ] **Step 3: 实现**（app.css 六 token；theme.ts applyAppearance——内部组装顺序：注释头 → UI vars（vscode 型才有）→ ts vars → hljs vars；settings 两字段 + DEFAULTS；TopBar 三处调用点改为 applyAppearance(settings 当前槽, mode, codeTheme 槽)——appearance 非 default 时代码槽由 appearance 接管）
- [ ] **Step 4: 跑测试确认通过 + 全量门禁** `pnpm test && pnpm typecheck`
- [ ] **Step 5: Commit**

```bash
git add apps/web/src/app.css apps/web/src/lib/theme.ts apps/web/src/lib/theme.test.ts apps/web/src/lib/stores/settings.ts apps/web/src/lib/TopBar.svelte
git commit -m "feat(web): 外观主题注入管线与 UI token 扩展

why: vscode/imported 主题需 UI+代码一物两用注入（spec B §2.1/2.2）。
what: applyAppearance（default 逐字节等价/vscode 注入 UI+code+hljs vars）
+ 6 新 UI token default 值 + appearanceLight/Dark 双槽 + TopBar 镜像。"
```

---

### Task 3: IndexedDB themes store + 主题库 CRUD + JSON/VSIX 导入解析

**Files:**
- Modify: `apps/web/src/lib/stores/session.ts`（DB 版本 1→2，onupgradeneeded 补建 `themes` store；新增 themes CRUD：`listThemes(): Promise<ImportedTheme[]>`、`putTheme(t)`、`deleteTheme(id)`）
- Create: `apps/web/src/lib/vsixImport.ts`（VSIX 解包列举 + 主题 JSON 读取校验）
- Create: `apps/web/src/lib/vsixImport.test.ts`
- Modify: `apps/web/package.json`（若 `@vviewer/render-archive` 未依赖则加——已依赖，无需）

**Interfaces:**
- Consumes: Task 1 `validateVscodeTheme`；`createZipStore`（`@vviewer/render-archive/zipStore`，接口 `createZipStore(buffer) → { listChildren(path), read(path) }`）；`kvPut` 同款 db() 升版模式。
- Produces:
  - `interface ImportedTheme { id: string; name: string; kind: 'dark' | 'light'; colors: Record<string, string>; tokenColors: VscodeThemeJson['tokenColors']; source: 'json' | 'vsix'; addedAt: number }`（id=`imported:<随机8>`）
  - `themes` store（keyPath 无，自管 id 键）；`listThemes/putTheme/deleteTheme`
  - `async function importThemeFiles(files: File[]): Promise<{ imported: ImportedTheme[]; errors: string[] }>`——.json 单文件直读校验；.vsix 读 `extension/package.json` → `contributes.themes[]`（缺报错 '扩展包内未找到主题'）→ 逐个读 `extension/<path>`（剥 `./`、反斜杠转正斜杠，Markpad L614-623 同款）→ validateVscodeTheme；每主题 JSON >1MB 报错跳过。
  - `async function listVsixThemes(file: File): Promise<{ label: string; path: string }[]>`（多主题 VSIX 的预览列举，UI 勾选用——若实现复杂可与 importThemeFiles 合并为「全部导入」语义，二选一并报告）

- [ ] **Step 1: 写失败测试**（vsixImport.test.ts：用 jszip（devDependency 提升——若根/包内不可得则以 createZipStore 的真实 jszip 依赖构造 zip：`new (await import('jszip'))()` 生成内存 vsix buffer——jszip 是 render-archive 的 dependency 非 root，测试文件放 apps/web/src/ 则经 workspace 解析可行；若不可行则把 zip 构造 helper 放 render-archive/test/ 下并从那里导出——实施者按依赖可达性选择，报告说明）：

```ts
// 关键用例：
// 1) 合法 vsix（package.json contributes.themes 两条 + 主题 JSON）→ 两条列举/全部导入成功
// 2) 无 contributes.themes → errors 含「未找到主题」
// 3) 主题 JSON 超 1MB → 该条报错跳过其余成功
// 4) 坏 JSON 主题 → 报错跳过
// 5) importThemeFiles 对 .json 直读：合法入库（fake-indexeddb——根 devDependencies 已有 fake-indexeddb ^6.2.5，vitest setup 或测试内 indexedDB stub，参照既有 IndexedDB 测试先例；若无先例则 CRUD 测试放 render-archive/test 或标记 jsdom+fake-indexeddb 组合，实施者核实 fake-indexeddb 在 vitest 的可用性后落地，不可行则 CRUD 以 e2e 兜底并报告）
```

- [ ] **Step 2: 跑测试确认失败**
- [ ] **Step 3: 实现**（session.ts 升版 2 + CRUD；vsixImport.ts；限额与容错按 Markpad L14-19/L568-635 精神）
- [ ] **Step 4: 跑测试确认通过 + 全量门禁**
- [ ] **Step 5: Commit**

```bash
git add apps/web/src/lib/stores/session.ts apps/web/src/lib/vsixImport.ts apps/web/src/lib/vsixImport.test.ts
git commit -m "feat(web): 主题库存储与 JSON/VSIX 导入解析

why: 导入主题需持久化与扩展包解包（spec B §2.3）。
what: IndexedDB v2 themes store CRUD + importThemeFiles/listVsixThemes
（contributes.themes 解析、1MB 限额、容错跳过）。"
```

---

### Task 4: 设置面板「界面主题」区

**Files:**
- Modify: `apps/web/src/lib/SettingsPanel.svelte`（新增 `.vv-settings-sec` section；persist() 合并模式沿用）
- Modify: `apps/web/src/app.css`（新 section 最小样式，token 惯例同 D 项）

**Interfaces:**
- Consumes: Task 2 applyAppearance + settings 槽、Task 3 CRUD/导入。
- Produces: UI——
  - 「界面主题」section：亮色槽/暗色槽两个 select（候选项 = `默认` + `Dark Modern (VSCode)` + `Light Modern (VSCode)` + 已导入列表（`<name>（json/vsix）`））；「导入主题」按钮 → `<input type="file" multiple accept=".json,.vsix">`；导入后列出已导入（名称 + kind 徽标 + 删除按钮）。
  - 选中非 default 主题时代码主题区（TopBar 的代码主题 select）禁用态提示「由外观主题接管」——TopBar 加一行 `$derived` 禁用逻辑（appearance 槽非 default 时 disable 代码主题 select + title 说明）。
  - 槽切换 → saveSettings → TopBar 的 onSettingsChanged 订阅触发 applyAppearance（Task 2 已接，天然生效）。
  - VSIX 多主题：若 Task 3 实现 listVsixThemes 则弹二次勾选；否则全部导入（保持一致并报告）。

- [ ] **Step 1: 实现**（Svelte 5 runes，$state 副本 + onSettingsChanged 订阅刷新，风格对齐面板既有两 section；删除按钮带 confirm）
- [ ] **Step 2: 门禁** `pnpm test && pnpm typecheck` + svelte-check 基线对比（stash 法，12E/2W 不新增）
- [ ] **Step 3: Commit**

```bash
git add apps/web/src/lib/SettingsPanel.svelte apps/web/src/lib/TopBar.svelte apps/web/src/app.css
git commit -m "feat(web): 设置面板界面主题区（双槽/导入/删除/接管提示）

why: 用户需管理外观主题槽与导入（spec B §2.3 管理 UI）。
what: 界面主题 section（亮暗双槽+文件导入+已导入列表）+
代码主题 select 的接管禁用提示。"
```

---

### Task 5: e2e + THIRD_PARTY_NOTICES + 全量门禁

**Files:**
- Modify: `apps/web/e2e/t-theme.spec.ts`（新增 B 项用例）
- Modify: `THIRD_PARTY_NOTICES.md`（vscode MIT 条目，格式仿 L24）

**Interfaces:** 验证性。

- [ ] **Step 1: e2e 用例**（t-theme.spec.ts 追加；`uiBg` helper L103-111 复用）：

```ts
test('B-THEME-1：切换 Dark Modern → UI 变量与代码高亮联动', async ({ page }) => {
  // 打开设置面板 → 暗色槽选 vscode:Dark Modern → 断言 --ui-bg 变为 dark_modern 值
  // （#1f1f1f）+ style#vv-code-theme 含 --vv-ts-comment: #6A9955（Markpad 基准值）
  // + 打开代码文件时视口 span 计算色与变量一致（THEME-06/2 探针手法 L309-334）
});
test('B-THEME-2：导入 JSON 主题并应用 + 刷新恢复', async ({ page }) => {
  // setInputFiles 注入合法主题 JSON → 已导入列表出现 → 暗槽选它 → --ui-bg 等于注入值
  // → reload → 主题仍选中且生效（IndexedDB 持久化）
});
test('B-THEME-3：导入 VSIX（合成的最小 vsix zip）', async ({ page }) => {
  // e2e 内用 jszip 构造最小 vsix（extension/package.json + contributes.themes + 主题 JSON）
  // → 导入 → 已导入列表出现
});
test('B-THEME-4：default 回退观感零变化', async ({ page }) => {
  // 切 Dark Modern 再切回默认 → --ui-bg 回到 #ffffff（light）/注入文本与 legacy 等价
});
```

- [ ] **Step 2: THIRD_PARTY_NOTICES.md 增行**（`| microsoft/vscode | MIT | packages/highlight/assets/vscode/dark_modern.json、light_modern.json（theme-defaults 扩展主题，原样 vendor） | B |`）
- [ ] **Step 3: 门禁**：`pnpm test && pnpm typecheck`；重建 build 后 `pnpm playwright test e2e/t-theme.spec.ts`（新旧全过）
- [ ] **Step 4: Commit**

```bash
git add apps/web/e2e/t-theme.spec.ts THIRD_PARTY_NOTICES.md
git commit -m "test(e2e): 外观主题端到端锚点与 vscode MIT 署名

why: B 项行为需端到端固化；vendor 主题需许可署名（spec B §1）。
what: B-THEME-1..4（切换联动/JSON 导入持久化/VSIX 导入/default 回退
零变化）+ THIRD_PARTY_NOTICES 条目。"
```

---

## Self-Review 结论

- **Spec 覆盖**：§2.1 注入管线/token 扩展→T2；§2.2 双映射→T1；§2.3 导入/存储/管理 UI→T3/T4；§3 测试→各任务+T5；§5 验收→T5。vendor 来源与降级路径已声明。
- **占位扫描**：T3 的 jszip 测试可达性与 fake-indexeddb 可用性两处「实施者核实」点均有备选路径与报告要求；T2 的 vendor JSON 加载方式（动态 import 路径）给了明确选项；listVsixThemes 与全部导入二选一需报告。无悬空引用。
- **类型一致性**：AppearanceRef/applyAppearance/ImportedTheme/importThemeFiles/validateVscodeTheme/tokenColorsToThemeTable/colorsToUiVars 前后一致；TEXTMATE_TO_CAPTURE 全表移植为硬要求。
- **风险声明**：注入文本形态变化牵动 theme.test/t-theme/b-theme-system 三处精确断言（T2 明确要求同步）；svelte-check 盲区在 T4 有基线对比要求。
