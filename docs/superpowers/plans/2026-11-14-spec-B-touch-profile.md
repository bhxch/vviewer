# 触屏适配批（自动感应 + 三态设置 + 触屏档案）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 三层落地：①检测与生效态——新单源响应式模块 `touchProfile.svelte.ts`（`any-pointer: coarse` + `maxTouchPoints > 0` 感知 + matchMedia change 热更新），输出 `isTouchActive` 派生并以 `html[data-touch='on']` 单点传导；②设置面——`layout.touchMode: 'auto'|'touch'|'desktop'` 三态字段（layout 节内字段，settingsDraft allowed 表零改动）+ 布局节三态 select 控件 + i18n 双目录；③触屏档案行为清单——hover 依赖控件常显（FileTree 源行删除钮 `@media(hover:none)` 迁移为 data-touch、工作区操作钮、wspanel 关闭钮、菜单触发钮/条目 8px 触控档）+ 抽屉浮钮 32→40px，强制档语义（desktop 回收常显 / touch 强启）由同一传导面承担。

**Architecture:** 纯逻辑与 runes 分层——`touchProfile.ts`（纯 .ts：`resolveTouchActive(mode, coarse, touchPoints)` 三态×coarse/fine 矩阵，vitest 直测）+ `touchProfile.svelte.ts`（runes 单例：`touchProfileState` $state + 幂等 matchMedia 探测 + `applyTouchDataset` 单写点）；AppShell 以「启动 + 设置订阅 + $effect 热更新」三通道接线（镜像 applyLocaleAndReduceMotion/themeMode 既有三写点形态），CSS 侧以属性选择器**替代**（非叠加）媒介查询——desktop 强制档需在 coarse 设备回收常显，媒介查询挡死回收路径，替代是 spec §3.4 语义的前提；触屏笔记本核心场景（primary pointer fine → 现行 `hover:none` 不触发）正由 `any-pointer` 落定覆盖。

**Tech Stack:** Svelte 5 runes（全局强制）、vitest（仓库根 jsdom）、Playwright 双 project、Conventional Commits。

**Spec:** `docs/superpowers/specs/2026-11-12-touch-profile-design.md`（本计划从 spec 论证；实现者两份都读——spec §3 拍板、§3.3 行为清单、§4 验收锚、§5 裁量与 §6 builder check 订正节同样有效）

## 基线与实施顺序

- **基线**：当前 HEAD `e3f6a58`（main；工作树 clean——spec A/C/E 已全部落地，最近五 commit 即 A 批壳层目录/zen 入口实现与 TOC 域锚）。spec B 此前零落地（`rg "touchMode|data-touch" apps/web/src apps/web/e2e packages` 零命中实查）；本计划全部工作基于该 HEAD 展开。
- **实施顺序**：Task 1 → Task 2 → Task 3 → Task 4 → Task 5，**严格串行**。理由：T1 的 `layout.touchMode` 字段是 T2 检测模块的设置单源（模块读 `s.layout.touchMode`，先落字段后落消费）；T2 的 `data-touch` 传导面是 T3 全部 CSS 迁移的触发信号（T2 落地时零 CSS 消费——既有 `hover:none` 块原样保留，行为零变化，可独立验证；T3 才换挂选择器）；T3 的触屏档案 CSS 是 T4 e2e 锚批的运行时前提；T4 锚批依赖 T1–T3 全部就位（且 T4 兑现 spec §4 ③「既有 hover:none 断言迁移后保持」的 e2e 侧订正）；T5 收尾。
- **grammar 构建链（spec F）条件核查**：本计划触及面为 layout.ts、touchProfile 两模块、AppShell.svelte、FileTree.svelte、app.css、LayoutSection.svelte、i18n catalogs、e2e——**不触及** `tools/grammar-builder`、`build.mjs`、gen-sources 与任何 cargo 生成物，**无需 gen-sources 与 build.mjs --fetch 先行步骤**（无 cargo 依赖；`pnpm gen:grammars` 既有产物已在 apps/web/static/grammars/，本计划不消费 grammar 域）。
- **不触及 server/（Rust）**：本计划零 server/ 改动（纯前端触屏感知与 CSS 面）。

## Global Constraints

- **拍板项不得偏离**（spec §1/§3.1/§3.2/§3.4/§6）：
  - 触屏档案 ≠ 移动布局——布局仍按宽度断点判定，触屏感知后**叠加交互优化**；三态设置 auto / 强制触屏 / 强制桌面。
  - 感知公式：`matchMedia('(any-pointer: coarse)').matches` **且** `navigator.maxTouchPoints > 0`；**落定用 `any-pointer`**（触屏笔记本核心场景 primary pointer 是 fine 的触摸板/鼠标 + coarse 触屏，`pointer:` 检测会漏报）；matchMedia change 监听承担外接键鼠切换热更新。
  - 字段归属：`layout.touchMode` 落 **layout 节内**（`LayoutSettings/DEFAULT_LAYOUT/sanitizeLayout` 同步，先例 zen 字段）——settingsDraft layout 节 allowed 表由 `Object.keys(sanitizeLayout({}))` 派生（settingsDraft.ts:547 实查），字段进 LayoutSettings 即零 allowed 改动；spec §3.2 的两种归属矛盾以 layout 节内为准。
  - 强制档语义（spec §3.4）：`desktop` 在 coarse 设备恢复 hover 语义（常显类全部回收）；`touch` 在 fine pointer 设备强行启用常显与加大目标。
  - 反目标红线：不做 UA 嗅探、不做触摸事件首次命中启发；宽度断点布局任何改变；抽屉浮钮在 >900px 触屏设备上出现（抽屉仍按宽度触发——T3 的 40px 档只作用于断点内已可见实例）；滑动手势/长按菜单（后续候选）。
- **runes 纪律**：`.svelte`/`.svelte.ts` 一律 runes 写法（`$state`/`$derived`/`$props`/`$effect`），legacy 语法编译报错；`touchProfile.svelte.ts` 模块级 `$state` 单例（iconTheme.svelte.ts:33-37 `iconThemeState` 先例）；纯逻辑保持 `.ts` 后缀供 vitest 直测（根 vitest 无 svelte 插件）。
- **i18n 纪律**：新文案键落 `catalogs/{zh-CN,en}/settings.ts`（域=settings），key 三段 `{域}.{模块}.{语义}`；en 键集==zh 键集由聚合机检硬断言（catalogs.aggregate.test.ts）；select 控件 aria-label 走 t() 键（AppearanceSection themeMode select 先例 :417）。
- **门禁口径**：vitest 一律在**仓库根**跑（包目录直跑缺 jsdom）；typecheck 仓库根 `pnpm run typecheck`；重建 web 一律 `pnpm --filter web build:e2e`（裸 build 冲掉 CDN 注入）；playwright 一律 `pnpm --filter web exec playwright test …`（根 package.json 无 playwright devDep）。
- **commit 纪律**：Conventional Commits（feat/fix/test/docs… 中文主题）、原子化；`git status --porcelain` 自查净空再 add（不按记忆清单）；**一律不得 git push**。
- **UI 文案/交互组件/a11y 任务前置阅读**（Task 1/3 开工前全文加载，不凭记忆转述）：`docs/design/frontend-conventions.md`（§3 i18n 纪律 + §4 a11y 基线（触控目标档/对比度/减少动效）+ §6 评审必查清单）、`docs/design/semantic-components.md`（设置节 select 控件形态先例核对——表单控件非浮层/菜单，不入 OVERLAY 册、无新 z-index 成员）、`docs/design/ui-design-system.md`（间距/字号 token——40px 触控档与 8px padding 档取既有值，零新 token）。
- **e2e 装置既有先例**（Task 4 直接复用，不新造）：目录注入 `openLocalDir`（b-filetree-src-remove.spec.ts:27-34，`__vvOpenDirImpl` + webkitRelativePath）；抽屉开合 `openDrawerIfNarrow`/`closeDrawerIfOpened`/`isDrawerViewport`（e2e/drawer.ts:22/:61/:72）；设置中心管线 `openSettings`/`gotoGroup`/`applySettings`/`closeSettings`（e2e/settings-center.ts:23/:30/:35/:41）；落盘断言 `savedSettings`（b-settings-center.spec.ts:44-46 localStorage 直读，TP spec 内 inline 同款四行）；CDP 触摸模拟 `newCDPSession` + `Emulation.setTouchEmulationEnabled`（b-sidebar-roots.spec.ts:310-314 先例）；selectOption 通道 `getByLabel('亮暗模式').selectOption('dark')`（b-settings-center.spec.ts:138 themeMode 先例）。
- **规划期触屏模拟通道探针实证**（2026-11-14，`/tmp/touchprobe/probe.mjs`，playwright-core 1.64.0 + chromium 缓存实跑，spec §6 疑点的裁决面）：
  1. **mobile project 形态（`newContext({ hasTouch: true })`）天然翻转**：`(any-pointer: coarse)=true`、`(pointer: coarse)=true`、`(hover: none)=true`、`navigator.maxTouchPoints=1`——spec §6「mobile project 下 coarse 模拟值未验证」**解除**：mobile project 的 auto 档直接吃触屏档案，e2e 无需任何额外模拟。
  2. **CDP `Emulation.setTouchEmulationEnabled({maxTouchPoints:5})` 全翻**：any-pointer/pointer/hover 特征全翻转 + maxTouchPoints=5——chromium 桌面 project 的触屏形态通道（SRC-08 ③ 同款）迁移后保持可行。
  3. **`page.emulateMedia({ pointer: 'coarse' })` 无效**：@playwright/test 1.64.0 调用不抛错（types.d.ts emulateMedia 签名仅 media/colorScheme/contrast/forcedColors/reducedMotion），但 `any-pointer: coarse` 与 `pointer: coarse` **均不翻转**——spec §6 备选通道在本仓库版本下**不成立**（实测订正），auto 档 e2e 证据通道改用上述 1/2 双通道；真机行为另列真机补测备案照旧（BUG-26 先例）。
  4. 模拟通道有特征残留迹象（disable 后 `(hover: none)` 仍 true）——CDP 模拟用例须独立 test/独立 page 隔离，防污染后续断言。

## Review Focus

1. **data-touch 单写点纪律**：`applyTouchDataset()` 是 dataset 唯一写函数（`on` 置 `data-touch='on'`，off **删属性**——镜像 reduceMotion 双态口径 AppShell:133-134），公式唯一来源 `resolveTouchActive`；AppShell 三通道（init 直调/订阅回调/$effect）全部只调它，禁止各写各的公式（themeMode 三写点 :381/:832/:868 是「同公式多点」先例，本计划收口为「单函数多点调用」）。`$effect` 内读 `touchProfileState` 三字段（经 isTouchActive）建立依赖——外接键鼠切换（matchMedia change → coarse 翻转）即热更新。
2. **hover:none 必须「替代」而非「叠加」**（T3 最大语义面）：FileTree `@media (hover: none)` 块（FileTree.svelte:152-156）删除后换 `:global(html[data-touch='on'])` 选择器（scoped 文件 :global 形态是**编译生效前提**——裸 `html[data-touch='on']` 祖先被判 css_unused_selector 死代码，Task 3 门禁全不拦、失败推迟到 Task 4 中途红，见 Task 3 Interfaces 首条纪律，规划评审 F1）。叠加形态下 forced-desktop 档在真 coarse 设备（hover:none 恒真）无法回收常显，直接违背 spec §3.4「常显类全部回收」。迁移后 SRC-08 ③（CDP 触摸模拟 → 删除钮 opacity 1）的驱动信号变为 data-touch='on'——探针实证 ② 通道全翻，该锚保持绿；SRC-08 ①②（桌面 hover 揭示/移出回零）不受影响（fine 环境 data-touch 缺席，hover/focus-within 揭示原样）。
3. **mobile project 全量 e2e 的隐性翻转面**：T2 落地后 mobile project（hasTouch）即打 `data-touch='on'`，T3 迁移后触屏档案在该 project 全面生效——抽屉浮钮 32→40px、菜单条目 padding 8px（≤600px 本就生效，无增量）、删除钮恒显（原 hover:none 语义等价）。既有锚均断可见性/点击不断尺寸（mobile.spec:45/:76、b-layout-zen-deep:428/:448 实查），零翻转预期；T3 Step 3 必须跑 mobile.spec + b-tabbar-menu（MOB-01）+ b-filetree-src-remove 兑现。
4. **TabBar 滚动箭头无迁移项（spec §3.3.1 描述订正，记档）**：spec 描述「SCRL 箭头 hover/focus 显隐」与现状不符——箭头显隐由 `arrowVisibility(scrollLeft, clientWidth, scrollWidth)` 滚动态驱动（TabBar.svelte:318-324 `vis` $state + `{#if}` 门 :522/:621），可滚即显、全设备一致，非 hover 门控——触屏档案下**已常显**，无代码改动。触屏形态裁量落定：保持 24px（触屏主通道为原生 touch 滑动横移，SCRL-08 已锚；箭头居中 absolute 于条内，放大有溢出/盖行风险且无可达性增益）。spec §3.3.3「TabBar wheel 横移触屏无 wheel」确认项：SCRL-08 触屏滑动横移即补口（b-tabbar-scroll.spec.ts:302），确认即记档，零改动。`.vv-colhandle` 已 `touch-action:none`（app.css:376-377），零改动。
5. **settingsDraft 零改动但有测试面**：validateSettings layout 分支（settingsDraft.ts:250-265）按 `sanitizeLayout` 归位差异报 `layoutSanitized`——`touchMode` 脏值（如 "finger"）被 sanitizeLayout 归位 'auto' 后自动标红，无需新枚举表；但 settingsDraft.test.ts 需补用例钉住该报告面（spec §4 单测锚「settings 归位/校验用例」），LayoutSection 契约测试（settingsCenter.test.ts:366-380 键字面 + zh 目录值双锁）同步扩展。
6. **SC-01 十三组序零影响**：新控件加在布局节**内部**（右栏宽度行之后、zen 标签之前），组注册表/组序/组名不动（settingsCenter.test.ts:33 组序契约、b-settings-center.spec.ts:56 SC-01 零翻转）。

---

### Task 1: settings 面——layout.touchMode 三态字段 + 布局节三态控件（无行为变化）

**前置阅读（触发词条款，开工前全文加载）：** `docs/design/frontend-conventions.md`（§3 i18n 纪律 + §6 评审必查清单）、`docs/design/semantic-components.md`（设置节表单控件形态核对——select 非浮层不入册）、`docs/design/ui-design-system.md`。

**Files:**
- Modify: `apps/web/src/lib/layout.ts`（`TOUCH_MODES`/`TouchMode` 导出 + `LayoutSettings.touchMode` + `DEFAULT_LAYOUT.touchMode: 'auto'` + `sanitizeLayout` 枚举归位）
- Test: `apps/web/src/lib/layout.test.ts`（touchMode 三态用例，:52-84 既有 sanitizeLayout 用例旁；**既有 :52-62「合法值原样通过」用例连锁修改**——其 `l` 字面量无 touchMode 键，加字段后 `toEqual(l)` 双侧失衡即断，需给 `l` 补 `touchMode: 'auto'`（规划评审 F3；其余既有全等断言已排查安全：:80/:84-87 toEqual(DEFAULT_LAYOUT) 双侧同步、settingsDraft.test.ts 全走 `{...DEFAULT_LAYOUT}` 展开 :63/:251/:254/:279/:335、stores/settings.test.ts :291/:341 双侧派生））
- Modify: `apps/web/src/lib/settingsDraft.test.ts`（validateSettings layout.touchMode 脏值报告面用例，:125-131 layout 镜像用例旁）
- Modify: `apps/web/src/lib/settings/LayoutSection.svelte`（三态 select 控件 + onchange 写 draft + touch）
- Test: `apps/web/src/lib/settingsCenter.test.ts`（:366-380 LayoutSection 契约扩展：新键字面 + zh 目录值双锁）
- Modify: `apps/web/src/lib/i18n/catalogs/zh-CN/settings.ts`、`apps/web/src/lib/i18n/catalogs/en/settings.ts`（6 新键）

**Interfaces:**
- layout.ts（枚举单源在本模块，touchProfile.ts 反向消费——runtime 依赖方向 touchProfile → layout 单向无环；stores/settings.ts:283 `s.layout = sanitizeLayout(s.layout)` 归位接线零改动）：
  ```ts
  /** 触屏适配三态（spec B §3.2）：'auto'=any-pointer:coarse + maxTouchPoints>0 感知，
   * 'touch'=强制启用，'desktop'=强制回收（spec §3.4）。 */
  export const TOUCH_MODES = ['auto', 'touch', 'desktop'] as const;
  export type TouchMode = (typeof TOUCH_MODES)[number];
  export interface LayoutSettings { …; touchMode: TouchMode; } // zen 后追加
  export const DEFAULT_LAYOUT: LayoutSettings = { …, touchMode: 'auto' };
  // sanitizeLayout 返回值追加：
  touchMode: (TOUCH_MODES as readonly string[]).includes(o.touchMode as string)
    ? (o.touchMode as TouchMode)
    : DEFAULT_LAYOUT.touchMode
  ```
- LayoutSection 控件（镜像 AppearanceSection themeMode select :415-421 形态，插在 rightWidth 行 :98 之后、zenLabel :99 之前）：
  ```svelte
  <label class="vv-settings-theme-row">
    <span>{t('settings.layout.touchRow')}</span>
    <select value={draft.layout.touchMode} onchange={onTouchModeChange} aria-label={t('settings.layout.touchAria')}>
      <option value="auto">{t('settings.layout.touchAuto')}</option>
      <option value="touch">{t('settings.layout.touchOn')}</option>
      <option value="desktop">{t('settings.layout.touchOff')}</option>
    </select>
  </label>
  <div class="vv-settings-hint">{t('settings.layout.touchHint')}</div>
  ```
  handler 镜像 AppearanceSection :127 强转形态：`draft.layout.touchMode = (e.currentTarget as HTMLSelectElement).value as Settings['layout']['touchMode']; touch();`
- i18n（zh 定稿 → en 对译；聚合机检 en==zh 自动覆盖；无占位符）：
  - `settings.layout.touchRow`：zh `触屏适配`；en `Touch adaptation`
  - `settings.layout.touchAria`：zh `触屏适配模式`；en `Touch adaptation mode`
  - `settings.layout.touchAuto`：zh `自动感应`；en `Auto detect`
  - `settings.layout.touchOn`：zh `强制触屏`；en `Force touch`
  - `settings.layout.touchOff`：zh `强制桌面`；en `Force desktop`
  - `settings.layout.touchHint`：zh `自动：检测到触屏输入时常显悬浮控件并加大触控目标，布局仍按宽度断点判定；强制触屏/强制桌面覆盖自动检测。外接鼠标为主的混合设备选强制桌面，触屏笔记本保持自动。`；en `Auto: detected touch input keeps floating controls visible and enlarges touch targets; layout still follows width breakpoints. Force touch / force desktop override auto detection. Choose force desktop for mouse-first hybrid devices; touch-screen laptops can stay on auto.`
- **验收锚**：layout.test.ts 新用例全绿（三合法值原样通过 / 脏字符串归 'auto' / 缺省字段回落 'auto'）+ settingsDraft.test.ts 报告面（field `layout.touchMode`、message 含目标值 'auto'）+ settingsCenter 契约扩展绿 + 聚合机检绿；本 task 零行为变化（字段落地无消费面），所触 e2e 锚文件=`apps/web/e2e/b-settings-center.spec.ts`（布局组渲染回归，Step 3 定向）。

- [ ] **Step 1: TDD layout.ts 三态归位（RED→GREEN）**

layout.test.ts 三用例：①三合法值原样通过；②`touchMode: 'finger'`（脏枚举）→ 'auto' 字段级归位（其余字段原值——镜像 :71-82 布尔脏值用例口径）；③入参无 touchMode 键 → 回落 DEFAULT_LAYOUT.touchMode。**既有用例连锁修改（规划评审 F3）**：:52-62「合法值原样通过」的 `l` 字面量补 `touchMode: 'auto'`——sanitize 输出加字段后与无键字面量 toEqual 失衡，不改则本步 GREEN run 即刻红。Run: `pnpm vitest run apps/web/src/lib/layout`（仓库根）→ RED → 实装 TOUCH_MODES/type/字段/sanitize + 连锁修改 → GREEN。

- [ ] **Step 2: settingsDraft 报告面用例**

settingsDraft.test.ts：`validateSettings({ layout: { touchMode: 'finger', …其余键合法 } })` → issues 含 `{ field: 'layout.touchMode' }` 且 message 含 `'auto'`（layoutSanitized 报告形态）；合法三值零 issue。Run: `pnpm vitest run apps/web/src/lib/settingsDraft` → 合法值用例现状即绿、脏值用例现状即绿（sanitizeLayout 未收枚举时 'finger' 原样通过 vs 不报差异——实查：sanitizeLayout 未加枚举归位时 sanitized.touchMode === l.touchMode 恒真，脏值**不**报 issue → 用例 RED）→ Step 1 已实装归位后 GREEN。

- [ ] **Step 3: LayoutSection 控件 + i18n 双目录 + 契约扩展**

按 Interfaces 落控件/handler/i18n 六键（zh 先定稿 → en 翻译）；settingsCenter.test.ts :366 块扩展（`t('settings.layout.touchRow')` 等键字面在场 + `zhSettings['settings.layout.touchRow']` 值锁）。Run: `pnpm vitest run apps/web/src/lib && pnpm run typecheck && pnpm lint` → 全绿（聚合机检含新键）。

- [ ] **Step 4: 提交**

```bash
git add apps/web/src/lib/layout.ts apps/web/src/lib/layout.test.ts apps/web/src/lib/settingsDraft.test.ts apps/web/src/lib/settings/LayoutSection.svelte apps/web/src/lib/settingsCenter.test.ts apps/web/src/lib/i18n && git commit -m "feat(settings): layout.touchMode 三态字段+布局节触屏适配控件——枚举单源 TOUCH_MODES（sanitizeLayout 归位+settingsDraft 报告面镜像，零行为变化）"
```

---

### Task 2: touchProfile 检测模块 + AppShell html data-touch 接线（零 CSS 消费，行为零变化）

**Files:**
- Create: `apps/web/src/lib/touchProfile.ts`（纯 .ts：`resolveTouchActive` 纯函数）
- Test: `apps/web/src/lib/touchProfile.test.ts`（三态×coarse/fine×touchPoints 矩阵）
- Create: `apps/web/src/lib/touchProfile.svelte.ts`（runes 单例：state + 探测 + dataset 写点）
- Modify: `apps/web/src/lib/AppShell.svelte`（import + init 通道 + 订阅通道 + $effect 热更新通道）

**Interfaces:**
- `touchProfile.ts`（纯 .ts，vitest 直测；仅 type import 自 layout.ts——runtime 单向依赖）：
  ```ts
  import { type TouchMode } from './layout';
  /** 生效判定（spec B §3.1 拍板公式）：auto = (any-pointer:coarse) 且 maxTouchPoints>0；
   * touch 恒 true（fine pointer 强启，spec §3.4）；desktop 恒 false（coarse 在场回收）。 */
  export function resolveTouchActive(mode: TouchMode, coarse: boolean, touchPoints: number): boolean {
    if (mode === 'touch') return true;
    if (mode === 'desktop') return false;
    return coarse && touchPoints > 0;
  }
  ```
- `touchProfile.svelte.ts`（runes；iconTheme.svelte.ts 单例先例形态）：
  ```ts
  // resolveTouchActive 在本任务新建的 ./touchProfile（规划评审 F4 订正：原片段误写
  // from './layout'——layout.ts 不导出该函数，照抄 typecheck 即红）；TouchMode 类型
  // 单源在 ./layout（touchProfile.ts 不 re-export）。
  import { resolveTouchActive } from './touchProfile';
  import type { TouchMode } from './layout';
  import type { Settings } from './stores/settings';

  /** 触屏档案单例（spec B §3.1）：mode 由 syncTouchProfile 从 settings.layout.touchMode
   * 同步（落定归 layout 节）；coarse/touchPoints 由 matchMedia 探测初始化。 */
  export const touchProfileState = $state<{ mode: TouchMode; coarse: boolean; touchPoints: number }>({
    mode: 'auto', coarse: false, touchPoints: 0
  });

  export function isTouchActive(): boolean {
    return resolveTouchActive(touchProfileState.mode, touchProfileState.coarse, touchProfileState.touchPoints);
  }

  let probeStarted = false;
  /** matchMedia 探测初始化（幂等；SSR/jsdom 无 matchMedia 空转——theme.ts:292 onSystemModeChange
   * 守卫先例）：any-pointer:coarse 单查询（落定 any-pointer——触屏笔记本 primary fine 不漏报，
   * spec §3.1）；change 监听承担外接键鼠切换热更新（maxTouchPoints 无事件面，随 change 同步
   * 重读，热插拔残余误差备案记档）。 */
  export function initTouchProfileProbe(): void {
    if (probeStarted || typeof window === 'undefined' || typeof matchMedia === 'undefined') return;
    probeStarted = true;
    const mq = matchMedia('(any-pointer: coarse)');
    const sync = (): void => {
      touchProfileState.coarse = mq.matches;
      touchProfileState.touchPoints = navigator.maxTouchPoints;
    };
    sync();
    mq.addEventListener('change', sync);
  }

  /** html[data-touch] 单写点（Review Focus 1）：on='on'，off 删属性——reduceMotion 双态
   * 口径（AppShell:133-134）。SSR 无 document 空转（applyLocaleAndReduceMotion :128 守卫先例）。 */
  export function applyTouchDataset(): void {
    if (typeof document === 'undefined') return;
    if (isTouchActive()) document.documentElement.dataset.touch = 'on';
    else delete document.documentElement.dataset.touch;
  }

  /** 设置→档案同步（AppShell 启动+订阅双通道；layout.touchMode 单源）。 */
  export function syncTouchProfile(s: Settings): void {
    touchProfileState.mode = s.layout.touchMode;
  }
  ```
- AppShell 接线（三通道，Review Focus 1 单函数多点调用）：
  - import 区（:64 i18n 接线 import 旁）：`import { applyTouchDataset, initTouchProfileProbe, syncTouchProfile, touchProfileState } from './touchProfile.svelte';`
  - init 通道（:139 `applyLocalePrefsAtStartup();` 后，镜像「首帧前生效」口径）：`initTouchProfileProbe(); syncTouchProfile(settings); applyTouchDataset();`
  - 订阅通道（:852 `applyLocaleAndReduceMotion(s);` 后）：`syncTouchProfile(s);`
  - 热更新 $effect（既有 $effect 族邻位，如 gitInfo 清空 effect :771-774 旁）：
    ```ts
    // 触屏档案热更新（spec B §3.1）：matchMedia change → coarse 翻转 → 本 effect 重跑
    // 重打标（mode 同步亦经 touchProfileState 响应式抵达）；读面在 isTouchActive 内，
    // 零自读自写环（写点 documentElement 非响应式）。
    $effect(() => {
      applyTouchDataset();
    });
    ```
- **验收锚**：touchProfile.test.ts 矩阵全绿（auto+coarse+tp>0 → true；auto+coarse+tp=0 → false——双条件缺一不可；auto+!coarse → false；touch 恒 true（coarse=false/tp=0 也 true）；desktop 恒 false（coarse=true 也 false）——spec §4 单测锚三态×coarse/fine 矩阵）；typecheck+lint 绿。**零 CSS 消费记档**：本 task data-touch 已打标但无任何选择器消费（T3 才换挂），既有 `hover:none` 块原样保留 → 行为零变化；`.svelte.ts` 单例不可 vitest 直测（runes 模块，iconTheme.svelte.ts 先例），其运行时面（打标/热更新）由 typecheck + Task 4 TP 域 e2e 收口。所触 e2e 锚文件=`apps/web/e2e/mobile.spec.ts`、`apps/web/e2e/b-filetree-src-remove.spec.ts`（mobile project 打标零翻转定向，Step 3）。

- [ ] **Step 1: TDD resolveTouchActive 矩阵（RED→GREEN）**

touchProfile.test.ts 六例（三态 × coarse/fine × touchPoints 边界）。Run: `pnpm vitest run apps/web/src/lib/touchProfile`（仓库根）→ RED（文件不存在/函数未导出）→ 实装 → GREEN。

- [ ] **Step 2: runes 单例 + AppShell 三通道接线**

按 Interfaces 落 touchProfile.svelte.ts 与 AppShell 三处（import/init/订阅/effect）。Run: `pnpm run typecheck && pnpm lint` → 绿。

- [ ] **Step 3: 定向回归（打标零行为变化兑现）**

Run: `pnpm --filter web build:e2e && pnpm --filter web exec playwright test mobile b-filetree-src-remove` → 全绿（mobile project 打标后既有抽屉/树行为零翻转；chromium project data-touch 缺席零影响——SRC-08 ①② hover 揭示原样）。

- [ ] **Step 4: 提交**

```bash
git add apps/web/src/lib/touchProfile.ts apps/web/src/lib/touchProfile.test.ts apps/web/src/lib/touchProfile.svelte.ts apps/web/src/lib/AppShell.svelte && git commit -m "feat(touch): touchProfile 检测模块——any-pointer:coarse+maxTouchPoints 感知（matchMedia 热更新）+html data-touch 单点打标接线（三通道镜像 reduceMotion 形态）"
```

---

### Task 3: 触屏档案 CSS 落地——hover 依赖控件迁移 + 点击目标加大

**前置阅读（触发词条款，开工前全文加载）：** `docs/design/frontend-conventions.md`（§4 a11y 基线（触控目标档）+ §6 评审必查清单）、`docs/design/ui-design-system.md`（token——零新 token，40px/8px 既有档位）。

**Files:**
- Modify: `apps/web/src/lib/FileTree.svelte`（:152-156 `@media (hover: none)` 块 → `:global(html[data-touch='on'])` 替代 + 注释改写——scoped 文件必须 :global 包裹祖先，见 Interfaces 首条纪律）
- Modify: `apps/web/src/app.css`（三组 data-touch 变体：`.vv-ws-actions`（:472-476 旁）、`.vv-wspanel-close`（:523-528 旁）、菜单触发钮/条目 8px 档（:611-619 旁）——全局层裸属性选择器免 scoping 死代码问题，不需要 :global）
- Modify: `apps/web/src/lib/AppShell.svelte`（scoped style 抽屉浮钮 40px 触控档：`.vv-drawer-toggle`/`.vv-right-toggle` 的 `:global(html[data-touch='on'])` 变体，:1931 嵌套块之后追加）

**Interfaces:**
- **scoped CSS 传导纪律（规划评审 F1 落定，执行前必读）**：`data-touch` 打标在 `html`（documentElement）上，不在组件模板内——scoped style 里裸 `html[data-touch='on']` 祖先选择器会被 Svelte 5 判 `css_unused_selector`、编译产物整条规则变 `/* (unused) … */` 注释**死代码**（仓库 svelte 5.57.2 编译探针实证：bare 形态 warnings=['css_unused_selector']、产物 `/* (unused) html[data-touch='on'] .vv-drawer-toggle {…}*/`；`:global(html[data-touch='on'])` 形态零告警、产物为生效规则 `html[data-touch='on'] .vv-drawer-toggle.svelte-xxx`——末位选择器仍获 scoping class，语义不变）。Task 3 门禁全不拦（svelte-check warning 不失败、eslint/vitest 不涉、build:e2e 不中断），失败会推迟到 Task 4 TP-04（mobile boundingBox 实测 32px 不到线）与 TP-02/SRC-08 ③（opacity 0 常显失效）——**两个 scoped 文件（FileTree/AppShell）一律 `:global(html[data-touch='on'])` 形态**；全仓 `.svelte` 此前无裸 `html[data…]` 先例（rg 实查仅 MetaPanel.svelte:161 注释一条）、亦无 `:global(html` 先例（本批为首个，先例即本任务建立）。
- FileTree.svelte（**替代**非叠加——Review Focus 2，forced-desktop 回收路径前提）：
  ```css
  /* 触屏档案恒显（spec B §3.3.1）：替代原 @media(hover:none)——强制桌面档需在
     coarse 设备回收常显，媒介查询挡死回收路径；触屏笔记本（primary pointer fine、
     hover:none 不触发）正由 data-touch 覆盖。hover 设备仍走上方 hover/focus-within 揭示。
     祖先打标在 html 上必须 :global 包裹——裸 html[...] 祖先被判 css_unused_selector
     死代码（规划评审 F1 编译探针实证） */
  :global(html[data-touch='on']) .vv-tree-src-remove { opacity: 1; }
  ```
- app.css（追加在各自 ≤600px 媒介查询行旁，同注释风格；全局层裸属性选择器直接可用）：
  ```css
  /* 触屏档案常显（spec B §3.3.1）：≤600px 媒介查询的 data-touch 等价通道——
     触屏笔记本（>600px 视口）与强制触屏档（任意视口）同吃；强制桌面档
     （data-touch 缺席）走 hover 语义零新增 */
  html[data-touch='on'] .vv-ws-actions { opacity: 1; }
  html[data-touch='on'] .vv-wspanel-close { opacity: 1; }
  /* 触屏档案触控目标（spec B §3.3.2）：菜单触发钮/条目 padding-block 8px 档
     （§6.4/§10-G1 同款）在触屏档案下全视口生效 */
  html[data-touch='on'] .vv-tabbar-menu .vv-tbmenu-trigger,
  html[data-touch='on'] .vv-tbmenu-item { padding-block: 8px; }
  ```
- AppShell scoped style（40px 档——**裁量落定**：直升 min 尺寸而非热区扩展（::after 机制无先例、收益同）；基态 display:none（:1864-1867）不受影响——规则只作用于断点内可见实例，>900px 触屏设备零浮钮出现（spec 反目标）；`:global(html[data-touch='on'])` 形态缘由见 Interfaces 首条纪律）：
  ```css
  /* 触屏档案浮钮触控目标（spec B §3.3.2，32→40px 升档；WCAG 2.2 2.5.8 AAA 44px
     档——.vv-zen-exit 已 44px 零改动，抽屉浮钮取 40px 档位与 §3.3.2 拍板下限一致）：
     基态 display:none 不受影响——>900px 触屏设备浮钮不出现（spec 反目标红线）；
     祖先在 html 上须 :global 包裹（裸形态编译死代码，评审 F1 探针实证） */
  :global(html[data-touch='on']) .vv-drawer-toggle,
  :global(html[data-touch='on']) .vv-right-toggle { min-width: 40px; min-height: 40px; }
  ```
- 检查项（零改动确认，实施报告记档）：`.vv-zen-exit` 44×44（AppShell:2026-2033，宽高 :2032-2033）已达标；`.vv-colhandle` `touch-action:none`（app.css:376-377）已就位；TabBar 箭头无迁移项（Review Focus 4 记档）。
- **验收锚**：typecheck+lint+vitest 全绿；**build:e2e 后定向回归全绿**——b-sidebar-roots（SRC-08 ③ CDP 通道迁移后保持 + SRC-01/02 hover 揭示零翻转）、b-filetree-src-remove（FTSRC mobile 恒显面）、mobile.spec（触屏档案全生效面零翻转）、b-tabbar-menu（MOB-01 + 触控档）、b-layout-zen（zen 退出钮/浮钮面零翻转）、t-shell（SHELL-10 断点段）。所触 e2e 锚文件=上述既有文件（本 task 不新增 spec 文件，TP 域锚 Task 4 落）。

- [ ] **Step 1: FileTree hover:none 迁移 + app.css 三组变体**

按 Interfaces 落地（每处紧邻原媒介查询，注释声明替代缘由）。

- [ ] **Step 2: 抽屉浮钮 40px 档 + 检查项核验**

AppShell scoped style 追加；zen 退出钮/colhandle/箭头三检查项核验（读样式确认零改动，结果记入任务报告）。

- [ ] **Step 3: 门禁与定向回归**

Run: `pnpm vitest run apps/web/src/lib && pnpm run typecheck && pnpm lint`（仓库根）→ **`pnpm --filter web build:e2e`**（先重建——playwright webServer 是 `pnpm vite preview` 纯静态服务 dist，无 build 步骤，不重建则被测 bundle 仍是上一 task 产物）→ `pnpm --filter web exec playwright test b-sidebar-roots b-filetree-src-remove mobile b-tabbar-menu b-layout-zen t-shell` → 全绿。

- [ ] **Step 4: 提交**

```bash
git add apps/web/src/lib/FileTree.svelte apps/web/src/app.css apps/web/src/lib/AppShell.svelte && git commit -m "feat(touch): 触屏档案 CSS 落地——hover:none 替代为 data-touch 传导（forced-desktop 回收路径前提）+浮钮 40px/菜单 8px 触控档"
```

---

### Task 4: e2e 锚批 b-touch-profile（spec §4 ①②③ + SRC-08 ③ 订正）

**Files:**
- Create: `apps/web/e2e/b-touch-profile.spec.ts`（TP- 域）
- Modify: `apps/web/e2e/b-sidebar-roots.spec.ts`（SRC-08 ③ 注释与探针订正：驱动信号 hover:none → any-pointer:coarse（新传导面），:303-307 注释行号/机制改写，探针 :313 换 `matchMedia('(any-pointer: coarse)').matches`，③ 内增 `data-touch='on'` 属性断言）

**验收锚 / e2e**：本任务即 e2e 锚批——`pnpm --filter web build:e2e` 后本域全绿 + 定向回归（b-sidebar-roots / b-filetree-src-remove / mobile / b-settings-center / b-layout-zen / b-tabbar-scroll（SCRL-08））零翻转。装置复用见 Global Constraints「e2e 装置既有先例」。**spec §6 备选通道订正兑现**（Global Constraints 探针实证 3）：auto 档证据走 mobile project 天然 hasTouch + CDP setTouchEmulationEnabled 双通道，emulateMedia({pointer}) 通道弃用（1.64.0 翻不动 any-pointer）；真机补测备案照旧。

- [ ] **Step 1: TP-01——auto 档双 project 分流（spec §4 ②）**

单用例按 `testInfo.project.name` 分流：chromium → `page.goto('/')` 后 `expect(page.locator('html')).not.toHaveAttribute('data-touch')`（fine 指针不吃档案）；mobile → `expect(page.locator('html')).toHaveAttribute('data-touch', 'on')`（探针实证 hasTouch 天然翻转——Global Constraints 探针 1）。前置探针守卫：mobile 分支先 `page.evaluate(() => matchMedia('(any-pointer: coarse)').matches)` 为 true 才断（环境异常时 skip 备案——BUG-26 先例形态）。

- [ ] **Step 2: TP-02——设置三态切换翻转（spec §4 ①，chromium project）**

注入单文件目录（openLocalDir 装置）→ `openSettings` → `gotoGroup('布局')` → `getByLabel('触屏适配模式').selectOption('touch')` → `applySettings` → `closeSettings` → `html` `toHaveAttribute('data-touch','on')` + FileTree 删除钮**无 hover** `toHaveCSS('opacity','1')`（常显类翻转）；重复走 desktop 档 → 属性消失（`not.toHaveAttribute`）+ 删除钮回 hover 语义（移出后 opacity 0——SRC-08 ② 同款断言）；`savedSettings` 断言 `layout.touchMode` 落盘 'desktop'。

- [ ] **Step 3: TP-03——强制桌面档语义（spec §3.4，chromium project + CDP，独立 test 隔离）**

CDP `setTouchEmulationEnabled({maxTouchPoints:5})`（goto 前安装——残留防护见 Global Constraints 探针 4）→ auto 档 `toHaveAttribute('data-touch','on')`（coarse 在场吃档案——探针实证 2）→ 设置切 desktop → 属性**消失**（coarse 在场仍回收——强制桌面档核心语义）→ 删除钮无 hover opacity 0（hover 语义恢复）→ 设置切回 auto → 属性回归 'on'。

- [ ] **Step 4: TP-04——点击目标加大（spec §3.3.2）**

chromium project + 强制 touch 档（TP-02 装置复用）：**先 `openMenu(page)`**（e2e/tabbar-menu.ts:39 装置——`.vv-tbmenu-item` 全部条目在 TabBarMenu.svelte:245 `{#if menuOpen}` 门内条件挂载，不开菜单 locator 落空，规划评审 F2）→ `.vv-tbmenu-item` `getComputedStyle` paddingTop '8px'（>600px 视口下 data-touch 生效——媒介查询等价通道实证）；mobile project：`.vv-drawer-toggle` boundingBox width/height ≥ 40（32→40 升档实证，抽屉浮钮 ≤900px 恒显无需开门）。

- [ ] **Step 5: TP-05——FileTree 删除钮 mobile 恒显（spec §4 ③）**

mobile project：注入目录 → `openDrawerIfNarrow` → `.vv-tree-src-remove` 无 hover `toHaveCSS('opacity','1')`（hover:none 断言迁移后保持的 mobile 直证版；FTSRC-01/03 的既有 opacity 断言在该 project 下继续承载同面）。

- [ ] **Step 6: SRC-08 ③ 订正 + 定向回归 + 提交**

b-sidebar-roots.spec.ts SRC-08 ③ 按上方 Files 注记改写（探针换 any-pointer:coarse + data-touch 断言 + 注释行号/机制订正——原 :303-307 注释引 FileTree.svelte:151-153 与 hover:none 机制，迁移后过期）。Run: `pnpm --filter web build:e2e && pnpm --filter web exec playwright test b-touch-profile b-sidebar-roots b-filetree-src-remove mobile b-settings-center b-layout-zen b-tabbar-scroll` → 全绿。

```bash
git add apps/web/e2e && git commit -m "test(e2e): 触屏档案批 TP 域锚——auto 双 project 分流/三态切换翻转/强制桌面档回收/触控目标加大/删除钮 mobile 恒显（SRC-08 ③ 探针订正 any-pointer 传导）"
```

---

### Task 5: 全量门禁与收尾（控制器执行）

- [ ] `node tools/fetch-e2e-corpus.mjs`（语料）→ `pnpm lint && pnpm run typecheck && pnpm vitest run`（仓库根全量）→ `pnpm --filter web build:e2e` → playwright 全量双 project（`pnpm --filter web exec playwright test`；对比基线：新增 b-touch-profile TP 域外零回归）→ `pnpm --filter web exec playwright test --config playwright.server.config.ts`（server 档零翻转）→ `git status --porcelain` 净空。
- [ ] 全量 review（superpowers:requesting-code-review，范围=本计划全部 commit），修复全部 C/I/M 后复审；**不 push**。
- [ ] 台账汇总（实施期记档项随任务报告归集；本计划规划期记档项五条——①TabBar 滚动箭头无迁移项：spec §3.3.1「hover/focus 显隐」描述与现状不符，显隐由滚动态驱动全设备常显，触屏形态保持 24px（Review Focus 4）；②spec §6 emulateMedia({pointer}) 备选通道在 @playwright/test 1.64.0 实测无效（翻不动 any-pointer:coarse），auto 档 e2e 证据改走 mobile project 天然 hasTouch + CDP 双通道（均探针实证），真机补测备案照旧（Global Constraints 探针实证）；③maxTouchPoints 无事件面——matchMedia change 时随查重读，外接触屏热插拔存在残余误差窗口（Task 2 Interfaces 注释内记档）；④touchProfile.svelte.ts runes 单例不可 vitest 直测——矩阵面由 touchProfile.test.ts（纯函数）承接，运行时面由 TP 域 e2e 收口（iconTheme 先例）；⑤抽屉浮钮 40px 取「直升 min 尺寸」而非热区扩展（Task 3 Interfaces 裁量））。

## Errata（执行期勘误）

- 2026-11-14 初版（规划师 B 基于 HEAD e3f6a58 编写；规划期关键实查已内联：hover:none 块 FileTree.svelte:152-156 / 常显两处 app.css:472-476、:523-528 / 菜单触控档 app.css:611-619（注释 :611-616 + 媒介块 :617-619） / 抽屉浮钮 32px AppShell:1894-1898、:1928-1931、基隐 :1864-1867 / zen 退出钮 44px :2026-2033（宽高 :2032-2033） / colhandle touch-action app.css:376-377 / TabBar 箭头滚动态显隐 TabBar.svelte:318-324+:522+:621、SCRL-08 b-tabbar-scroll.spec.ts:302 / layout.ts LayoutSettings:11-18、DEFAULT_LAYOUT:20-27、sanitizeLayout:51-62 / settingsDraft allowed 派生 :547、layout 分支 :250-265 / themeMode select 先例 AppearanceSection:415-421+:127 / reduceMotion 接线 AppShell:128-140、订阅 :852、themeMode 三写点 :381/:832/:868 / theme.ts matchMedia 守卫先例 :292 / LayoutSection 契约 settingsCenter.test.ts:366-380 / SC-01 组序 b-settings-center.spec.ts:56 / savedSettings :44-46 / 设置装置 e2e/settings-center.ts:23-41 / drawer 装置 e2e/drawer.ts:22/:61/:72 / CDP 触摸先例 b-sidebar-roots.spec.ts:310-314 / mobile project 定义 playwright.config.ts:33-46（hasTouch :41） / FTSRC hover 断言 b-filetree-src-remove.spec.ts:53-60）。
- 规划期裁量四项全部内联落定于上文 Interfaces（传导方式=html data-touch 单点属性 + CSS 集中选择器——推荐形态采纳，落 documentElement 对齐 reduceMotion/themeMode 既有 html dataset 打标先例而非 spec 例举的字面「body 级」；各 hover 控件常显样式归并=每控件保持既有视觉只换触发通道（opacity 1 / padding 8px 原值，零视觉漂移）；SCRL 箭头触屏形态=无迁移项 + 保持 24px（Review Focus 4）；抽屉浮钮=直升 40×40 非热区扩展），无 deferred 项。
- 2026-11-14 规划期探针订正两条（实跑 `/tmp/touchprobe/probe.mjs`，输出内联于 Global Constraints「规划期触屏模拟通道探针实证」）：①spec §6 对 mobile project `(any-pointer: coarse)` 模拟值的疑虑解除——hasTouch 上下文天然翻转（coarse=true + maxTouchPoints=1）；②spec §6 的 `page.emulateMedia({pointer:'coarse'})` 备选通道实测无效（@playwright/test 1.64.0 不翻 any-pointer/pointer），e2e 证据通道改定且记档于 Task 4——spec §6「若模拟不出 coarse」的条件分支以探针实证结果落定，未硬凑。
- 2026-11-14 计划评审修订（5 条意见，规划师 B 逐条实查复现后同文件落定，基于 HEAD adbed6f=初版计划 commit，代码基线 e3f6a58 不变）：①【阻塞】F1 scoped CSS 死代码——初版 Task 3 的 AppShell 与 FileTree 两段 `html[data-touch='on'] …` 裸祖先选择器在 scoped style 下被 Svelte 5.57.2 编译器判 `css_unused_selector`（复跑评审探针 /tmp/plan-review-b/css-probe.mjs + 自写 /tmp/plan-review-b/css-probe-2.mjs：bare_drawer/bare_filetree 两例 warnings=['css_unused_selector']、产物 `/* (unused) … */` 注释死代码；`:global(html[data-touch='on'])` 修正形态 global_drawer/global_filetree/global_multi 三例零告警、产物为生效规则且末位选择器仍获 scoping class）——Task 3 门禁全不拦（svelte-check warning 不失败/eslint/vitest 不涉），失败推迟到 Task 4 TP-04（boundingBox 32px 不到线）与 TP-02/SRC-08 ③（opacity 0）；两段已改 `:global(html[data-touch='on'])` 形态并在 Task 3 Interfaces 增「scoped CSS 传导纪律」首条（app.css 全局层三段不受影响，注明免 :global）；全仓 `.svelte` 无裸 `html[data…]` 先例（rg 实查仅 MetaPanel.svelte:161 注释一条）、`:global(html` 亦零先例（本批为首个）。②F2 TP-04 chromium 分支缺前置动作——`.vv-tbmenu-item` 全部条目在 TabBarMenu.svelte:245 `{#if menuOpen}` 门内条件挂载（实查 :245），不开菜单 locator 落空；Step 4 已补 `openMenu(page)` 前置（e2e/tabbar-menu.ts:39 装置）并注明 mobile 分支抽屉浮钮恒显无需开门。③F3 Task 1 未列既有用例连锁——layout.test.ts:52-62「合法值原样通过」的 `l` 字面量无 touchMode 键、加字段后 `toEqual(l)` 即断（实查 :52-62），Files 与 Step 1 已补连锁修改声明（补 `touchMode: 'auto'`；评审排查的其余全等断言安全性结论一并注明）。④F4 Task 2 Interfaces import 错源——`resolveTouchActive` 在同任务新建的 ./touchProfile，原片段误写 `from './layout'`（typecheck 即红）；已改两行 import（`resolveTouchActive` from './touchProfile' + `type TouchMode` from './layout'——类型单源仍在 layout.ts，touchProfile.ts 不 re-export）并注释缘由。⑤F5 行号锚订正五处：mobile project 定义 playwright.config.ts:28-39→:33-46（hasTouch :41）、TabBar 箭头 {#if} 门 :523/:622→:522/:621（原引到 <button> 行；vis $state :318-325→:318-324）、iconThemeState :36-41→:33-37、app.css 菜单触控档 :608-612→:611-619（注释 :611-616 + 媒介块 :617-619）、openLocalDir :32-44→:27-34（原 :32 恰为 __vvOpenDirImpl 行）——实质锚点全部成立，仅坐标校正。
