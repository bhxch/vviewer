# VSCode 图标主题支持 + Open VSX 安装更新 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 支持 VSCode icon theme 格式（解析/校验/存储/渲染），预置 Seti；设置项含出现范围（默认仅文件树）；Open VSX 安装与更新通道（颜色主题+图标主题共用管线内核）。

**Architecture:** 纯函数校验与字形匹配落 vviewer-highlight 包（仿 vscode.ts 先例）；存储走 session.ts v5 新 store；运行时为 apps/web 的 runes 模块（iconTheme.svelte.ts：FontFace 注册 + 匹配器 + 签名联动）+ `<FileIcon>` 单组件五消费点；Open VSX 通道仿 fontsStore 的 https/CORS fetch 先例 + vsixImport 管线内核复用。

**Tech Stack:** Svelte 5 runes、vitest（fake-indexeddb/jszip 先例）、playwright（settings-center 装置）、FontFace API。

**Spec:** `docs/superpowers/specs/2026-10-31-icon-themes-design.md`

## Global Constraints

- 所有迁移/新增 UI 遵循 ui-design-system 令牌；aria-label 中文。
- `iconThemes` 设置节：`{ theme: 'none'|'seti'|'imported:<id>', scopes: { tree: true, tabs: false, quickOpen: false, search: false } }`（默认值逐字）。
- settings 新节六处登记：Settings 接口/DEFAULTS/defaults()/normalizeSettings（仿 fonts 节 L154-160）/notify 深拷贝/settingsDraft 的 validateSettings 节块 + collectUnknownPaths.allowed 键（SETTINGS_KEYS 自 DEFAULTS 派生自动兼容）。
- 图标主题单选、不随亮暗切换；无匹配回退 `_file`/`_folder`/`_folder_open` 保留键；语言映射**反向表**（vscode id → 扩展名集合，纯扩展名匹配零 detect 依赖）。
- JSON 直导必须字体同批选中（fonts[].src 按文件名关联，缺任一字体 → 拒绝入库报错）。
- caret 规则：主题有 folder 图标且 hidesExplorerArrows=true → caret 由 folder/folderExpanded 替代；有 folder 图标但 false → 并存；无 → 纯 caret 现状。
- IndexedDB 升级：DB_VERSION 4→5，onupgradeneeded 补 `iconThemes` store（仿 MOUNTS 行）；记录 `ImportedIconTheme { id:'imported:<随机8>', name, manifest（归一化实体）, fonts:[{path,format,data:ArrayBuffer}], source:'json'|'vsix', origin?:{publisher,extension,version,checkedAt}, addedAt }`。
- Open VSX v1 固定 `https://open-vsx.org`（base 单点常量）；API/文件端点 CORS `*` 已实测（三跳）；更新 = 同 id 覆盖写入（引用零断链）；不做自动后台更新；ms marketplace 不做。
- 工作树 server/core/build.rs 属并行会话——提交一律 scoped add。

## Review Focus

- 无匹配 glyph 时**零 DOM 位移**：FileIcon 返回 null 不渲染元素（防占位空 span 撑行高）。
- FontFace 生命周期：主题切换/删除后旧字体注销（document.fonts.delete），字体名带主题 id 防撞车；同一 ArrayBuffer 可重复注册不同名。
- Open VSX 拉取全程显式用户动作触发（无启动期/后台请求）；下载 30MB 上限（仿 fontsStore L150 文案形态）。
- 预置 Seti 校验必须过 validateVscodeIconTheme（vendor 件入库前 JSONC 规范化，与 dark_modern 同例）——单测直接 import vendor JSON 断言 ok。
- 设置应用时序：图标注入走 AppShell onSettingsChanged 单订阅链追加（与 fonts 并列），不走 AppearanceSection 直调——`applyIconsFromSettings` diff 签名（theme+scopes 序列化），无变化零操作。

---

### Task 1: vscodeIcon.ts 校验与字形匹配（纯函数 + 单测）

**Files:**
- Create: `packages/vviewer-highlight/src/vscodeIcon.ts`
- Modify: `packages/vviewer-highlight/src/index.ts`（vscode 导出块后追加 export 块）
- Test: `packages/vviewer-highlight/test/vscodeIcon.test.ts`

**Interfaces:**
- Produces: `NormalizedIconTheme`（预编译查表：fileNames/fileExtensions/languageIds/folderNames/folderNamesExpanded 五 Map + `_file`/`_folder`/`_folder_open` 回退键 + `hidesExplorerArrows` + fonts 元数据 + name）；`validateVscodeIconTheme(raw): {ok:true; theme: NormalizedIconTheme} | {ok:false; reason:string}`；`matchIconTheme(t: NormalizedIconTheme, target: { kind:'file'|'folder'|'folderExpanded'; name: string }): { char: string; color?: string; fontSize?: string } | null`；`normalizeIconTheme(raw): NormalizedIconTheme`（从 IndexedDB 记录重建——manifest 存原始 JSON、记录端存归一化形态两可，裁决：**记录存归一化后的查表结构 + 保留 fonts**，put/get 免重建）。

- [ ] **Step 1: 写失败单测**（仿 test/vscode.test.ts 风格）——用例集：①完整主题（iconDefinitions/fonts/fileExtensions/fileNames/languageIds/folderNames/hidesExplorerArrows）validate ok 且查表正确；②缺 iconDefinitions 拒；③fontColor 非法色值剔（COLOR_VALUE_RE 同口径）；④fontCharacter 非单字符拒该定义；⑤fonts.src 绝对路径/协议前缀拒；⑥匹配优先级 fileNames > fileExtensions > languageIds（反向表）> _file 回退；⑦多级后缀 `.d.ts` 全后缀尝试；⑧folder/folderExpanded 各自命中；⑨languageIds 反向表命中/表外静默；⑩无 _file 且无匹配 → null。
- [ ] **Step 2: 跑红**——`pnpm vitest run packages/vviewer-highlight/test/vscodeIcon.test.ts`
- [ ] **Step 3: 实现**——validate 仿 validateVscodeTheme 结构（L77-96 容错优先口径：坏条目剔除，全空才拒）；languageIds 反向表 vendored 常量 `VSCODE_LANG_EXT`（~40 主流 id：typescript [ts,tsx? 不含 tsx]、javascript、python、rust、go、java、c、cpp、csharp、shell、html、css、json、yaml、markdown 等，实现时逐 id 核对 VSCode 官方 language id→extensions 映射填表）。
- [ ] **Step 4: 跑绿 + `pnpm typecheck` 0E**
- [ ] **Step 5: Commit**——`feat(highlight): vscodeIcon 校验与字形匹配纯函数——icon theme 数据面`

### Task 2: session v5 iconThemes store + 导入管线

**Files:**
- Modify: `apps/web/src/lib/stores/session.ts`（v5 + CRUD + 类型）
- Modify: `apps/web/src/lib/vsixImport.ts`（importIconThemeFiles + icon manifest 读取）
- Test: `apps/web/src/lib/vsixImport.test.ts`（扩用例）/ `apps/web/src/lib/stores/session.test.ts`（扩用例）

**Interfaces:**
- Produces: `ImportedIconTheme`（Global Constraints 形状）；`listIconThemes(): Promise<ImportedIconTheme[]>`；`putIconTheme(t)`（同 putTheme 无 keyPath 自管 id）；`deleteIconTheme(id)`；`importIconThemeFiles(files: File[]): Promise<{ imported: ImportedIconTheme[]; errors: string[] }>`（.json/.vsix 分派同 importThemeFiles；vsix 读 `contributes.iconThemes[].path`，主题 JSON 的 `fonts[].src` 相对路径在同批 zip/文件中按基名关联，**缺任一字体 → 该主题拒绝入库并记 errors**；单文件失败不中断同批；尺寸上限复用 MAX_THEME_JSON_BYTES 1MB/字体 30MB）。

- [ ] **Step 1: 失败单测**——session.test：v5 store round-trip + origin 字段保留；vsixImport.test：①json+woff 同批成功入库（fonts.data 为 ArrayBuffer）；②缺字体拒绝且 errors 文案含文件名；③vsix 内含 contributes.iconThemes 完整流；④vsix 只有 contributes.themes（颜色主题）→「扩展包内未找到图标主题」；⑤多主题 vsix 全导入并列。
- [ ] **Step 2: 跑红**
- [ ] **Step 3: 实现**——session.ts 仿 MOUNTS 升级行；readVsixManifest 泛化出 `readVsixContributions(store, key: 'themes'|'iconThemes')` 内部函数（颜色主题路径行为逐字不变）。
- [ ] **Step 4: 跑绿 + typecheck**
- [ ] **Step 5: Commit**——`feat(theme): iconThemes store v5+导入管线——json/vsix 双通道字体同批校验`

### Task 3: 运行时（iconTheme.svelte.ts + FileIcon + 设置节 + 联动）

**Files:**
- Create: `apps/web/src/lib/iconTheme.svelte.ts`、`apps/web/src/lib/FileIcon.svelte`、`apps/web/src/lib/iconReaction.ts`
- Modify: `apps/web/src/lib/stores/settings.ts`（六处登记）、`apps/web/src/lib/settingsDraft.ts`（validateSettings 节块 + allowed 键）、`apps/web/src/lib/AppShell.svelte`（订阅链追加 reactToIconsChange）
- Test: `apps/web/src/lib/iconReaction.test.ts`（仿 fontsReaction.test）、`apps/web/src/lib/settingsDraft.test.ts` 扩用例

**Interfaces:**
- `iconTheme.svelte.ts`：`export const iconThemeState = $state<{ sig: string; runtime: NormalizedIconTheme | null; ready: boolean }>(…)`；`applyIconsFromSettings(s: Settings): Promise<void>`（diff sig → 字体注册/注销 + runtime 换装；'none' → runtime null）；`iconReaction.ts`：`reactToIconsChange(s, onIconsChanged): Promise<boolean>`（changed 时调回调——tab rev++ 联动与 fonts 同款）。
- `FileIcon.svelte` props：`{ kind: 'file'|'folder'|'folderExpanded'; name: string }`——读 iconThemeState.runtime 调 matchIconTheme，null → 不渲染；命中 → `<span class="vv-file-icon" style:font-family style:color style:font-size>{char}</span>`。作用域开关由调用点门控（读 settings 的 scopes——经 props 传入 `enabled` 由消费点算，保持组件无 settings 依赖：`{#if settings.iconThemes.scopes.tree}<FileIcon …/>{/if}`）。

- [ ] **Step 1: 失败单测**——settingsDraft.test：iconThemes 节 normalize/校验三态（合法/脏 theme 归 none/脏 scopes 键剔除）+ 导出导入 round-trip；iconReaction.test：theme 变更→回调触发、scopes-only 变更→触发、无关字段→不触发。
- [ ] **Step 2: 跑红**
- [ ] **Step 3: 实现**——settings.ts 六处（仿 fonts 节）；iconTheme.svelte.ts 字体注册 `document.fonts.add(new FontFace('vv-iconfont-'+id, buffer))`，切换先加新后删旧，`document.fonts.delete` 注销；AppShell 订阅链 :546-549 旁追加 `void reactToIconsChange(s, () => tabStore.touchActiveTab())` + onMount 首调。
- [ ] **Step 4: 跑绿 + typecheck**
- [ ] **Step 5: Commit**——`feat(theme): 图标主题运行时与 FileIcon 组件——settings 六处登记+单订阅联动`

### Task 4: Seti 预置 + 外观组 UI + 消费点 + e2e ICON

**Files:**
- Create: `packages/vviewer-highlight/assets/vscode-icons/seti/{seti-icon-theme.json,seti.woff}`（vendor vscode 1.141.0 extensions/theme-seti/icons/，MIT，README 注明出处——仿 assets/vscode/README.md 先例）+ `apps/web/src/lib/iconThemeBuiltins.ts`（BUILTIN_ICON_THEMES 动态 import 表，字体经 `?url` import）
- Modify: `apps/web/src/lib/settings/AppearanceSection.svelte`（图标主题分区：主题 select [无/Seti/已导入]、四 scopes 复选、导入 file input（accept .json,.woff,.ttf,.vsix multiple）、已导入列表+删除；复用 importNote/importErrors 通道）
- Modify: 五消费点——`TreeNodeRow.svelte`（L50 name span 前插 FileIcon，caret 规则适配）、`FileTree.svelte`（源头行 L72 前插 folder 图标位）、`TabBar.svelte`（L299/300 间插，文件 tab kind=file、目录 tab kind=folder）、`QuickOpenPanel.svelte`（L173 前插）、`GlobalSearchPanel.svelte`（L277 前插）；app.css `.vv-file-icon` 基线
- Test: e2e `apps/web/e2e/b-icon-themes.spec.ts`

- [ ] **Step 1: vendor**——下载 vscode@1.141.0 theme-seti icons 目录两件，JSONC 规范化（剥注释/尾逗号）入库；单测断言 `validateVscodeIconTheme(imported seti json).ok === true` 且 seti.json/woff 体积记入报告（woff 优先，>200KB 则报告字体子集化候选记档）。
- [ ] **Step 2: builtins + UI**——iconThemeBuiltins：`'seti': async () => ({ manifest: (await import('…/seti-icon-theme.json')).default, fontUrl: (await import('…/seti.woff?url')).default })`；applyIconsFromSettings 的 'seti' 分支 fetch fontUrl → ArrayBuffer → FontFace。AppearanceSection 分区落「代码主题」前（L230 前）。
- [ ] **Step 3: 消费点**——五处按 Review Focus（null 零位移）+ scopes 门控（tree→TreeNodeRow+FileTree 源头行；tabs→TabBar；quickOpen→QuickOpen；search→GlobalSearch 文件头行）。
- [ ] **Step 4: e2e ICON-01..**（settings-center 装置：openSettings/gotoGroup('外观')/applySettings）——ICON-01 启用 seti → 树行出现 .vv-file-icon 非空字形 + 源头行 folder 图标 + caret 替代（seti hidesExplorerArrows=true）；ICON-02 scopes：关 tree 开 tabs → 树无/tab 有；ICON-03 quickOpen/search 作用域；ICON-04 导入 json+字体同批（构造小主题夹具）生效+删除回退 none；ICON-05 无匹配文件零位移（行高断言不变）。运行前置 `node tools/fetch-e2e-corpus.mjs` + `pnpm --filter web build:e2e`；定向 `playwright test b-icon-themes b-settings-center b-theme-system b-fonts`。
- [ ] **Step 5: 全绿 + typecheck + Commit**——`feat(theme): Seti 预置+外观组图标主题分区+五消费点——默认仅文件树`

### Task 5: Open VSX 安装与更新通道

**Files:**
- Create: `apps/web/src/lib/openVsx.ts`、`apps/web/src/lib/openVsx.test.ts`
- Modify: `apps/web/src/lib/settings/AppearanceSection.svelte`（两处「从 Open VSX 安装」输入 + 已导入列表版本/检查更新/全部检查——图标主题分区先行落地，颜色主题列表同款 origin 更新 UI 一并接）
- Test: e2e `apps/web/e2e/b-openvsx.spec.ts`

**Interfaces:**
- `parseOpenVsxInput(input: string): { publisher: string; extension: string; version?: string } | { error: string }`（页面 URL `https://open-vsx.org/extension/{p}/{e}[/v]`、`{p}.{e}[@{v}]`、vsix 直链三形态）；`installFromOpenVsx(input): Promise<{ imported: …; errors: string[] }>`（GET `/api/{p}/{e}[/{v}]` → files.manifest 预检 contributes.themes/iconThemes 至少一项 → files.download 拉 vsix（30MB 上限）→ 转 File 走 importThemeFiles/importIconThemeFiles 内核 → 记录带 origin{publisher,extension,version,checkedAt}）；`checkUpdate(origin): Promise<{ latest: string; hasUpdate: boolean }>`；`updateTheme(record): Promise<ImportedIconTheme | ImportedTheme>`（重拉 → 校验 → 同 id putIconTheme/putTheme 覆盖）。

- [ ] **Step 1: 失败单测**——parseOpenVsxInput 三形态+非法输入；mock fetch（注入 loader 模式仿 cdnEngines `__setCdnLoaderForTest` → `__setFetchImplForTest`）：manifest 预检拒非主题/下载超限拒/origin 字段落库/同 id 覆盖更新（v1→v2 断言 id 不变 version 更新）。
- [ ] **Step 2: 跑红 → 实现 → 跑绿**（错误文案形态仿 fontsStore「字体下载失败…」句式：「Open VSX 安装失败（需网络与 CORS）：…」）。
- [ ] **Step 3: UI**——图标主题分区 + 颜色主题导入区各加单行输入（placeholder「从 Open VSX 安装：publisher.extension 或粘贴链接」）+ 安装钮；已导入列表行显示 origin.version + 「检查更新」（逐条）+ 有更新时「更新到 x.y.z」+ 列表头「全部检查」串行。
- [ ] **Step 4: e2e OVX-01..**——mock `page.route('**/open-vsx.org/**')` 假 API/文件响应 + 小 vsix 夹具（jszip 构造，Node 侧 buffer 转 path）；OVX-01 安装图标主题生效；OVX-02 非主题扩展快速报错（manifest 预检文案）；OVX-03 更新闭环（v1 装→路由改 v2→检查→更新→设置引用 id 不变）；OVX-04 超限错误卡；OVX-05 真网冒烟（skipIf offline 探测，仿 CDN-04 cdnReachable 先例：真拉一个小主题装成功）。
- [ ] **Step 5: 门禁 + Commit**——`feat(theme): Open VSX 安装与更新通道——颜色/图标主题共用管线，同 id 覆盖零断链`

### Task 6: 全量门禁（HEAD 口径）

- [ ] **Step 1**——`node tools/fetch-e2e-corpus.mjs` + `pnpm --filter web build:e2e`
- [ ] **Step 2**——`pnpm typecheck && pnpm test`
- [ ] **Step 3**——`pnpm --filter web exec playwright test`（双 project 全量）+ `--config playwright.server.config.ts`
- [ ] **Step 4**——预算门禁 `node tools/diagram-budget.mjs`（assets 面扫描含新增 woff）+ `pnpm --filter web build`（precache 面确认 seti 资产入册情况并记录）
- [ ] **Step 5**——任何翻红按 HEAD 口径处置（记台账教训），全绿后 Commit（如有零星修复）`fix(theme): 门禁收口`

## Self-Review 记录

- 规格覆盖：spec §2 数据面（T1/T2）、§3 消费面（T3/T4，scopes 四开关/caret 规则/零位移）、§6 Open VSX（T5，三形态/manifest 预检/origin/同 id 覆盖/批量检查）、e2e（T4/T5）、预算（T6 Step 4）——全覆盖。
- 类型一致：NormalizedIconTheme 三处（T1 定义/T3 消费/T4 builtins）一致；ImportedIconTheme origin 字段 T2/T5 一致；iconReaction 回调注入形态与 fontsReaction 先例一致。
- Review Focus 五条：零位移（T4 Step 3）、FontFace 生命周期（T3 Step 3）、显式用户动作（T5 接口面）、Seti vendor 过校验（T4 Step 1）、单订阅 diff（T3 AppShell 接线）。
- 顺序依赖：T1→T2（校验函数）→T3（消费 T1 类型+T2 CRUD）→T4（消费 T3 运行时）→T5（消费 T2 管线+T4 UI 骨架）→T6。
