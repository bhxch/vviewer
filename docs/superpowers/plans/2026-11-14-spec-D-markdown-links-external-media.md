# markdown 外链媒体三档放行 + 相对链接站内导航 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修用户报的两个 md 渲染面缺陷：①外链图片三档可控放行——新 `settings.markdown` 节（`externalImages: 'blocked'|'manual'|'auto'` 默认 `manual` + `externalImagesAllowlist` 域名白名单），sanitize IMG 分支按档位分流（blocked=现行剥除 / manual=src 迁 `data-vv-external-src` + 占位「加载图片」按钮点击回填 / auto=放行），白名单任意档位按 auto；BUG-40 五类等价向量与音视频/poster 任何档位维持既有防线；html/docx 直调点同步注入。②markdown 相对链接站内导航——渲染出口对内容区 `a[href]` 分类接管：相对路径经注入 resolver（decode/剥 query-hash/`resolveInStorePath` join/store 存在性探测）命中 file 新 tab 打开、directory 开目录 tab、missing 状态栏提示；`[[file]]` 死链 wikilink 升级走同一通道（resolver 未注入维持降级形态）。

**Architecture:** sanitize 包内纯函数分流（`SanitizeOptions.externalImage` + 模块级 provider 缝 `setExternalImagePolicyProvider`——setDiagramOptions provider 形态先例，一次装配统一服务 markdown/html/docx 三消费面；钩子逐调用经 config 键透传，`SERVER_DIAGRAM_CONFIG_KEY` 同款机制）；manual 占位构建在 vviewer-markdown enrich（sanitize 保持零交互反目标；包内模块级 Set 承担同 src 会话免确认）；相对链接接管在 renderMarkdownInto 渲染出口（enrich 后、灯箱监听同代——逐元素绑定随节点收养/销毁，免解绑簿记），resolver/opener 双注入缝（任一缺席不接管=standalone 安全缺省）；app 侧 `markdownLinks.ts` 纯解析（复用 `resolveInStorePath` join + `listChildren().find` 存在性探测 + read 失败兜底）+ `addTab`/`addDirStoreTab`/`showStatusNotice` 打开通道装配。

**Tech Stack:** Svelte 5 runes（全局强制）、vitest（仓库根 jsdom）、Playwright 双 project、Conventional Commits。

**Spec:** `docs/superpowers/specs/2026-11-12-markdown-links-and-external-images-design.md`（本计划从 spec 论证；实现者两份都读——spec §3 拍板、§4 验收锚、§5 裁量与 §6 builder check 订正节同样有效）

## 基线与实施顺序

- **基线**：当前 HEAD `38e17bf`（main；工作树 clean——spec C/E/A/B 已全部落地，最近 commit 为 B 批 TP 域 e2e 锚）。spec D 此前零落地（`rg "externalImages|resolveRelativeLink|data-vv-external-src" packages apps/web/src` 零命中实查）；本计划全部工作基于该 HEAD 展开。
- **实施顺序**：Task 1 → Task 2 → Task 3 → Task 4 → Task 5 → Task 6 → Task 7，**严格串行**。理由：T1 settings 节是 T2 sanitize 档位装配的数据单源（viewer.ts provider 读 `s.markdown.*`，先落字段后落消费）；T2 的 sanitize 分流产出 `data-vv-external-src` 标记是 T3 enrich 占位构建的输入（T2 落地时无消费面——manual 档 img 呈现行 blocked 占位形态，行为面由 T3 补齐）；T3 的占位面与 T4 的链接面分触 enrich.ts/css.ts 两处共享文件，串行保 commit 原子性；T4 的 resolver/opener 契约是 T5 app 装配的接口前提；T5 装配（provider/resolver/opener/直调点）是 T6 e2e 锚批的运行时前提；T7 收尾。
- **grammar 构建链（spec F）条件核查**：本计划触及面为 sanitize/markdown/render-text/render-doc 包、apps/web settings 装配与 e2e——**不触及** `tools/grammar-builder`、`build.mjs`、gen-sources 与任何 cargo 生成物，**无需 gen-sources 与 build.mjs --fetch 先行步骤**（无 cargo 依赖）。
- **不触及 server/（Rust）**：spec §3.2 落定「server 通道一致性：远程 comrak 输出同样汇入 sanitize→enrich→管线（markdownRenderer.ts:563-574 单出口），行为一致，无 server 侧改动」——远程链零改动（`rg -n "markdown" server/core/src/compute/` 仅 comrak 透传，实查），本计划零 server/ 文件。

## Global Constraints

- **拍板项不得偏离**（spec §3.1/§3.2/§4/§6 落定七条）：
  - 三档矩阵作用面**收窄为 img 与 srcset**：`blocked`=现行（剥 src+srcset、占位、title 域名）；`manual`=src 迁 `data-vv-external-src`（§6 落定 1：DOM 无 src 即不发请求，BUG-17 防线真实维持）+ 占位「加载图片」按钮点击回填；`auto`=钩子 IMG 分支直接放行。
  - **白名单优先于档位**：命中域名任意档位（含 blocked）按 auto。
  - **音视频/poster 维持剥除是定案**（§6 落定 5）：AV/preload=none 防线（MD-13）与 poster/SVG image/use href/行内 style url()/background/input type=image 五类向量**任何档位（含白名单）都不放行**——白名单作用面=img 与 srcset；SVG image/use href 外域放行不做。
  - **manual 档媒体扩展名交点**（§6 落定 2）：enrich 的 img→video/audio 转换在 manual 档不发生（src 已迁 data 属性）→ 按钮文案按目标扩展名区分（.mp4/.webm/.ogg→「加载视频」，.mp3/.wav/.flac/.m4a→「加载音频」，enrich.ts:44-45 既有集合），点击按扩展名创建 video/audio 元素（preload=none 无 autoplay）替换占位，而非回填进 img。
  - **html/docx 直调点同步注入**（§6 落定 3）：html.ts:41 与 docx.ts:47 直调 sanitizeHtml 同样消费档位，装配从 app 侧 settings 取值。
  - **跨文件 fragment**（§6 落定 4）：`./other.md#section` 打开目标文件后 MVP 不自动定位（hash 丢弃，注记）；hash 剥离前先做纯 `#` 页内锚判定（不接管）。
  - **存在性探测**（§6 落定 6）：TreeStore 无 `exists`（core types.ts:39-63 实查）——仿 `resolveImageBlobUrl` 用 `listChildren(dir).find(...)`，平铺 store 退化按 read 失败兜底。
  - 反目标红线：sanitize 包内零交互/DOM 事件（纯函数单出口）；对白名单域名放宽 BUG-40 等价向量；默认档 `auto`；外域音视频自动播放；导出侧外域图片强拉（markdownExport.ts:31-33 维持不强拉零改动）；`/` 开头链接的站点根语义变更（只改解析基准为 store 根）；跨 store 链接。
- **runes 纪律**：`.svelte`/`.svelte.ts` 一律 runes 写法（`$state`/`$derived`/`$props`/`$effect`），legacy 语法编译报错；纯逻辑保持 `.ts` 后缀供 vitest 直测（根 vitest 无 svelte 插件）。本计划新前端逻辑均为纯 `.ts`/包内 `.ts`，唯一新 `.svelte` 是 T1 设置节组件（`$props`/`$derived` 写法，镜像 DiagramsSection）。
- **i18n 纪律**：新文案键落 `catalogs/{zh-CN,en}/settings.ts`（settings 域）与 `catalogs/{zh-CN,en}/notice.ts`（missing 提示，域=notice），key 三段 `{域}.{模块}.{语义}`；en 键集==zh 键集由聚合机检硬断言（catalogs.aggregate.test.ts）；select/按钮 aria-label 走 t() 键（DiagramsSection krokiVia select :90 先例）。**markdown 包内占位按钮文案为包内中文常量**（与 DEFAULT_UI_TEXTS 缺省中文同源形态——app 的 Renderer 路径不传 ui、复制徽标等既有包内文案同为中文缺省，实查 viewer.ts 无 ui 装配），不入 catalogs。
- **门禁口径**：vitest 一律在**仓库根**跑（包目录直跑缺 jsdom）；typecheck 仓库根 `pnpm run typecheck`；重建 web 一律 `pnpm --filter web build:e2e`（裸 build 冲掉 CDN 注入）；playwright 一律 `pnpm --filter web exec playwright test …`（根 package.json 无 playwright devDep）。
- **commit 纪律**：Conventional Commits（feat/fix/test/docs… 中文主题）、原子化；`git status --porcelain` 自查净空再 add（不按记忆清单）；**一律不得 git push**。
- **UI 文案/交互组件/a11y/CSS 任务前置阅读**（Task 1/3/4/5 开工前全文加载，不凭记忆转述）：`docs/design/frontend-conventions.md`（§3 i18n 纪律 + §4 a11y 基线 + §6 评审必查清单）、`docs/design/semantic-components.md`（设置节 select/输入控件形态核对——表单控件非浮层/菜单不入 OVERLAY 册；manual 占位按钮为文档内容区元素非应用级浮层，同复制徽标先例不入册；**若该文档清单要求登记则先登记后使用**）、`docs/design/ui-design-system.md`（间距/字号/色 token——占位框沿用 BLOCKED_EXTERNAL_CSS 既有 #b58900 档，零新 token）。
- **e2e 装置既有先例**（Task 6 直接复用，不新造）：目录注入 `injectDir` + 树内打开 `openTreeFile`（b-markdown-html-docs-helpers.ts:36/:54）；外域请求监听为 spec 内 inline `page.on('request')` 四行（t-md.spec.ts:486 BUG-40 同款、b-markdown-html-docs-bug-regressions.spec.ts:53 trackRequests 局部先例）；设置三档/白名单应用走设置中心管线 `openSettings`/`gotoGroup`/`applySettings`/`closeSettings`（e2e/settings-center.ts:23/:30/:35/:41）或 `savedSettings` localStorage 直读（b-settings-center.spec.ts:44-46）；状态栏提示断言 `.vv-statusbar` role=status（ViewerPane.svelte:1285，statusNotice.text 内联渲染 :1291）。
- **规划期实查订正**（2026-11-14，规划师 D，基于 HEAD 38e17bf）：
  1. **`sanitizeHtml(html, opts?)` 第二参已存在**（sanitize.ts:476，`SanitizeOptions = { wholeDocument?, serverDiagram? }`）——spec「扩第二参」实为**扩展现有 SanitizeOptions**（加 `externalImage?` 字段），钩子逐调用透传机制已有同款（`SERVER_DIAGRAM_CONFIG_KEY`/`SANITIZE_SCOPE_CONFIG_KEY` 经 config 注入、钩子第 3 参读回 :227-251/:316-319），新档位照此加 `__vvExternalImagePolicy` config 键，钩子侧不持模块级可变状态。
  2. **spec §3.1「新 PipelineCtx 字段」机械上不成立**：sanitize 先于 runPipeline（markdownRenderer.ts:574-585，PipelineCtx 是 runPipeline 的入参而非上游）——落定为 **sanitize 包模块级 provider 缝**（`setExternalImagePolicyProvider(fn | null)`，setDiagramOptions 的 provider 形态先例 markdownRenderer.ts:197-207）+ `SanitizeOptions.externalImage` 逐调用显式优先；renderMarkdownInto 的 sanitize 调用点不传 opts → provider 现读（settings 变更下一渲染即时生效，viewer.ts getDiagramOptions 闭包现读同款口径）。markdown/html/docx 三消费面一次装配统一服务（html/docx 本就不经 markdown 管线，spec 的「两处装配从 app 侧 settings 取值」由同一 provider 满足）；standalone 包消费者经 `SanitizeOptions.externalImage` 自传（spec「standalone 包消费者自行传」字面满足）。行为面与 spec 一致，机制偏差记档（Errata ②）。
  3. **posixJoin 不复用**（spec §5 裁量项落定）：`posixJoin` 在 vviewer-render-foreign/src/bridge.ts:204 为包内私有且 A4 加固后拒绝 `../` 与前导 `/`（docs/e2e/path-normalization.md:13）；本次需要的是「允许合法 `../` 上级」的解析——**复用 apps/web/src/lib/markdownImages.ts:22-35 的 `resolveInStorePath`**（`./`/`../` 逐段规范、`..` 弹空越根返回 null、前导 `/` 天然归一根相对——img 相对路径解析的现役同款），链接解析式 = decodeURIComponent（try/catch 保留原串）→ 剥 query/hash → `resolveInStorePath`。
  4. **html 沙箱 CSP 是 auto 档在 html 文档生效的前置门**：html.ts:27-28 `CSP_CONTENT = "…img-src data: blob:; media-src data: blob:;…"`——仅注入 sanitize 档位不解除 CSP 拦截（BUG-40 复核记录：html 档外域请求 failures='csp' 网络栈之前拦截，t-md.spec.ts:445-448 注释实证）。「体验一致」落定=T5 为 html.ts 增加 **img-src 的 CSP 联动**（auto → 加 `https: http:`；白名单条目任意档 → 逐条加 `https://<host>` 与 `https://*.<base>` 两条——CSP `*.` 不覆盖 apex，发双条；media-src 不动=AV 不放行落定）。
  5. **manual 档在 html/docx 面无「加载图片」按钮**（知情差异，Errata ③）：enrich 占位构建不在两面（docx.ts:47 直填 innerHTML、html.ts srcdoc 独立文档无 enrich）——manual 档下 img src 迁 data 属性后呈裸占位（html 面沿用 ：62-67 的 data-vv-blocked-external 行内虚线样式；docx 面呈无 src img）。auto/白名单/blocked 三态在两面完整一致，manual 的逐张确认仅 markdown 面提供；记档后续增强（可复用 T3 占位构建器）。
  6. **SC-01 十三组序明示翻转**：新增「Markdown」组使设置组十三→十四（b-settings-center.spec.ts:55 SC-01 labels 全列断言 :69-83）——D20「网络资源」十二→十三组同款明示翻转先例（SC-01 :66-68 注释在案），T1 同 commit 内改写。
  7. **img→AV 转换的 `a[href]` 分支**（enrich.ts:70-84）先于链接接管运行：相对媒体链接（`[x](./clip.mp4)`）在 enrich 即转 video/audio 元素（现行行为，不在本次链接接管面）——链接接管只处理存活下来的 `a[href]`，与 enrich 无冲突。

## Review Focus

1. **BUG-17 防线真实维持（T2 最大风险面）**：manual 档下 DOM 必须无 `src` 属性（src 值迁 `data-vv-external-src`）——若任何路径把 src 留在 DOM（哪怕 hidden img），浏览器照发请求，防线形同虚设。单测断言形态固定为「`not.toHaveAttribute('src')` + `toHaveAttribute('data-vv-external-src', …)`」（§6 落定 1 的断言基准）；e2e 以 `page.on('request')` 监听外域请求为终极判据（占位态零请求）。srcset 同口径：manual 下外域候选不得留在 DOM srcset（整串迁 `data-vv-external-srcset`）。
2. **三档对既有锚零翻转的兑现**：默认档 manual 下，既有 BUG-40 基线护栏（t-md.spec.ts:487-494 `not.toHaveAttribute('src')`+`data-vv-blocked-external`）与 b-markdown-html 的 MD-11/BUG-17 markdown 断言（blocked count/title/`img[src^=http]` count 0）**字面全部继续成立**（manual 也产 data-vv-blocked-external 标记 + title，src 同样缺失）——规划期逐条核对成立；T6 必须实跑两文件兑现并在 t-md 基线护栏补 `data-vv-external-src` 在场断言（钉住 manual 语义，防未来悄悄退化回 blocked）。五类向量断言（五类 img/svg/style/poster/input 剥除 + 零外域请求）三档不变。
3. **接管条件双注入（standalone 安全缺省）**：`resolveRelativeLink` 与 `openRelativeLink` **任一缺席即不接管**（wire pass 整体跳过，原生导航语义维持）——spec「解析器未注入/返回 null → 不接管」落定为双缝同时在场才绑定点击；resolver 返回 null → 当次点击放行原生行为。
4. **wikilink 升级的幂等与降级**：enrich 侧死链 span 恒写 `data-wikilink-path`（纯元数据，零行为变化——resolver 不在场的 standalone 消费者维持不可点死链原样）；出口升级仅当 resolver+opener 在场且路径分类为站内相对（`isRelativeLinkHref`，外域嵌入 `![[https://…]]` 的 path 不升级）；升级换元素后原 span 的「已处理跳过」契约（convertWikilinks walker 对 `.md-wikilink-dead` 的 FILTER_REJECT，enrich.ts:260）不破坏——升级发生在 enrich 之后，`[[` 文本已定型无二次改写面。
5. **点击代理生命周期**：逐元素绑定（灯箱 runLightbox/复制徽标 runCopyCode 同款先例——监听随节点在挂载收养时保留、随 `destroy()` 的 `target.replaceChildren()` 与节点同灭），**不引入容器级委托**（裁量落定：委托需在 target 上挂监听并处理重渲解绑簿记，BUG-52 收口语义更重；spec §5 两形态中取逐链接绑定）。
6. **设置面零漂移**：Settings 顶层新键 `markdown` **追加在 reduceMotion 之后**（键序尾部追加——DEFAULTS 注释 :135-138 的「键序与手工清单逐键一致、落盘字节面零漂移」契约维持）；notify() 深拷贝清单（:351-364）必须同步加 markdown 节（allowlist 数组拷贝），否则订阅方拿到共享数组引用回灌。

---

### Task 1: settings 面——markdown 节（三档 + 白名单）+ 设置中心「Markdown」组（零行为变化）

**前置阅读（触发词条款，开工前全文加载）：** `docs/design/frontend-conventions.md`（§3 i18n 纪律 + §4 a11y 基线 + §6 评审必查清单）、`docs/design/semantic-components.md`（设置节表单控件形态核对——select/输入非浮层不入册）、`docs/design/ui-design-system.md`。

**Files:**
- Modify: `apps/web/src/lib/stores/settings.ts`（`MARKDOWN_EXTERNAL_IMAGE_POLICIES`/`MARKDOWN_ALLOWLIST_ENTRY_RE` 导出 + `MarkdownSettings` 接口 + `Settings.markdown` + `DEFAULTS.markdown` + `defaults()` 拷贝 + `normalizeSettings` markdown 白名单块 + `notify()` markdown 深拷贝）
- Test: `apps/web/src/lib/stores/settings.test.ts`（markdown 节白名单用例扩展）
- Modify: `apps/web/src/lib/settingsDraft.ts`（validateSettings markdown 分支镜像，diagrams 分支 :153-196 旁）
- Test: `apps/web/src/lib/settingsDraft.test.ts`（markdown 脏值报告面用例）
- Create: `apps/web/src/lib/settings/MarkdownSection.svelte`（三态 select + 白名单 chip 列表编辑）
- Modify: `apps/web/src/lib/SettingsCenter.svelte`（groups 注册 `{ id: 'markdown', label: t('settings.nav.markdown'), content: MarkdownSection }`，插在 renderers :70 之后、layout :71 之前）
- Test: `apps/web/src/lib/settingsCenter.test.ts`（:33 组序契约的 nav 键序扩展 + MarkdownSection 契约：键字面 + zh 目录值双锁）
- Modify: `apps/web/src/lib/i18n/catalogs/zh-CN/settings.ts`、`apps/web/src/lib/i18n/catalogs/en/settings.ts`（`settings.nav.markdown` + `settings.markdown.*` 7 键 + `settings.issue.*` 2 键）
- Modify: `apps/web/e2e/b-settings-center.spec.ts`（SC-01 十三→十四组明示翻转：labels 列表 :69-83 插 'Markdown' + 测试名/注释订正）

**Interfaces:**
- settings.ts（枚举本地单源——不 import sanitize 包，包侧 T2 独立定义 `EXTERNAL_IMAGE_POLICIES`，两侧字面一致性由各自单测锁 + 本计划 Errata ④ 记档；先例：POLICIES 本地常量 ：161）：
  ```ts
  /** 外链图片三档白名单（spec D §3.1）：blocked=剥除占位（BUG-17 现行）；manual=src 迁
   * data 属性+占位「加载图片」点击放行（默认档——相较旧版默认拦截为放行诉求的知情
   * 取舍，hint 文案标注防线语义变化）；auto=直接放行。与 vviewer-sanitize 包的
   * EXTERNAL_IMAGE_POLICIES 字面一致（包零 app 依赖，两侧各自单测锁字面）。 */
  export const MARKDOWN_EXTERNAL_IMAGE_POLICIES = ['blocked', 'manual', 'auto'] as const;
  export type MarkdownExternalImagePolicy = (typeof MARKDOWN_EXTERNAL_IMAGE_POLICIES)[number];
  ```
  —— 白名单条目校验落定为**程序化判定**（不用单一正则）：`normalizeMarkdownAllowlist(v: unknown): string[]` 纯函数（导出，settings.ts 内单源）——入参数组逐条 string → trim → lowercase → 拒空串/含空白/含 `/`/含 `:`（端口不参与匹配，见 T2 Interfaces）→ 去重保序；供 normalizeSettings/settingsDraft/MarkdownSection 三处同源消费。
  ```ts
  export interface MarkdownSettings {
    externalImages: MarkdownExternalImagePolicy;
    externalImagesAllowlist: string[];
  }
  // Settings 接口尾部（reduceMotion :130 之后）追加： markdown: MarkdownSettings;
  // DEFAULTS 尾部追加： markdown: { externalImages: 'manual', externalImagesAllowlist: [] },
  // defaults() 追加： markdown: { externalImages: DEFAULTS.markdown.externalImages, externalImagesAllowlist: [...DEFAULTS.markdown.externalImagesAllowlist] },
  // normalizeSettings 尾部（rendererDefaults 块 :309-314 后）追加 markdown 白名单块：
  //   节脏值回落 DEFAULTS.markdown；externalImages 枚举外归位 'manual'；
  //   allowlist = normalizeMarkdownAllowlist（逐条 trim→lowercase→拒空/空白/':'/'/'→去重保序）
  // notify() 追加： markdown: { ...s.markdown, externalImagesAllowlist: [...s.markdown.externalImagesAllowlist] },
  ```
- settingsDraft validateSettings markdown 分支（镜像 diagrams :153-196 形态：节脏值 mustBeObject → 键级 unknownField → externalImages 枚举 issue（message 列三枚举值）→ allowlist mustBeStringArray → 逐条 `normalizeMarkdownAllowlist` 单条归一前后不一致（含 trim/大小写归一不报，含空白/`/`/`:`/空串报）→ field `markdown.externalImagesAllowlist[i]`）。settingsDraft 白名单键集 `SETTINGS_KEYS` 自 `Object.keys(DEFAULTS)` 派生（:36）——新节键自动入白名单，**键级零改动**。
- MarkdownSection.svelte（镜像 DiagramsSection :90 select 形态 + SearchSection chip 列表先例 :11/:21/:26）：
  ```svelte
  <label class="vv-settings-theme-row">
    <span>{t('settings.markdown.extImagesRow')}</span>
    <select value={draft.markdown.externalImages} onchange={onExternalImagesChange} aria-label={t('settings.markdown.extImagesAria')}>
      <option value="blocked">{t('settings.markdown.extImagesBlocked')}</option>
      <option value="manual">{t('settings.markdown.extImagesManual')}</option>
      <option value="auto">{t('settings.markdown.extImagesAuto')}</option>
    </select>
  </label>
  <div class="vv-settings-hint">{t('settings.markdown.extImagesHint')}</div>
  <!-- 白名单 chip 列表：input(aria=allowlistAria)+添加钮 + 逐条 chip 移除钮（aria=allowlistRemove {domain}）+ hint -->
  ```
  handler 镜像 AppearanceSection 强转形态（`as Settings['markdown']['externalImages']`）+ `touch()`。
- i18n（zh 定稿 → en 对译；聚合机检 en==zh 自动覆盖；占位符 `{domain}` 两侧一致）：
  - `settings.nav.markdown`：zh `Markdown`；en `Markdown`
  - `settings.markdown.extImagesRow`：zh `外链图片`；en `External images`
  - `settings.markdown.extImagesAria`：zh `外链图片加载策略`；en `External image loading policy`
  - `settings.markdown.extImagesBlocked`：zh `禁止`；en `Blocked`
  - `settings.markdown.extImagesManual`：zh `手动确认`；en `Ask each time`
  - `settings.markdown.extImagesAuto`：zh `自动加载`；en `Auto load`
  - `settings.markdown.extImagesHint`：zh `默认「手动确认」：外链图片不自动加载，占位框内点「加载图片」逐张放行，同一地址本次会话免重复确认；「禁止」维持拦截占位；「自动加载」直接放行。白名单中的域名不受档位限制直接加载。注意：默认档由旧版的拦截改为逐张确认，跟踪像素防线的语义随之变化。`；en `Default "ask each time": external images do not load automatically; click the load button per image (same source skips re-confirmation this session). "Blocked" keeps stripping; "auto load" allows directly. Allowlisted domains load regardless of the policy. Note: the default changed from always-block to per-image confirmation; the tracker-pixel defense semantics changed accordingly.`
  - `settings.markdown.allowlistRow`：zh `域名白名单`；en `Domain allowlist`
  - `settings.markdown.allowlistAria`：zh `白名单域名输入`；en `Allowlist domain input`
  - `settings.markdown.allowlistAdd`：zh `添加`；en `Add`
  - `settings.markdown.allowlistRemove`：zh `移除 {domain}`；en `Remove {domain}`
  - `settings.markdown.allowlistHint`：zh `白名单域名不受上方档位限制直接加载。example.com 精确匹配；.example.com 或 *.example.com 含该域与其全部子域。端口不参与匹配。`；en `Allowlisted domains load regardless of the policy. example.com matches exactly; .example.com or *.example.com covers the domain and all its subdomains. Ports are not matched.`
  - `settings.issue.externalImages`：zh `外链图片档位必须是：{values}`；en `External image policy must be one of: {values}`
  - `settings.issue.allowlistEntry`：zh `白名单条目必须是域名（不含路径、空白或端口）`；en `Allowlist entries must be domain names (no paths, whitespace or ports)`
- **验收锚**：settings.test.ts 新用例全绿（三合法值原样通过 / 脏枚举归 'manual' / allowlist 归一：trim、大小写、去重、拒空/含 `/` 条目）+ settingsDraft.test.ts 报告面（field `markdown.externalImages` / `markdown.externalImagesAllowlist[i]`）+ settingsCenter 契约扩展绿（组序 nav 键序插入 markdown）+ 聚合机检绿 + SC-01 十四组 e2e 绿；本 task 零行为变化（字段落地无消费面）。所触 e2e 锚文件=`apps/web/e2e/b-settings-center.spec.ts`（SC-01 翻转 + 定向）。

- [ ] **Step 1: TDD settings.ts markdown 节白名单（RED→GREEN）**

settings.test.ts 新用例（diagrams 白名单 describe 旁）：①三合法值原样通过；②`externalImages: 'always'`（脏枚举）→ 'manual'；③allowlist `[' Example.com ', 'example.com', 'bad/../x', '', '.EXAMPLE.COM']` → `['example.com', '.example.com']`（trim+lowercase+去重+拒非法，保序）；④节脏值（数字）回落默认形态。Run: `pnpm vitest run apps/web/src/lib/stores/settings`（仓库根）→ RED → 实装（接口/DEFAULTS/defaults/normalize/notify 五处）→ GREEN。

- [ ] **Step 2: settingsDraft 报告面用例**

settingsDraft.test.ts：`validateSettings({ markdown: { externalImages: 'always', externalImagesAllowlist: ['a b'], … } })` → issues 含 `{ field: 'markdown.externalImages' }` 与 `{ field: 'markdown.externalImagesAllowlist[0]' }`；合法输入零 issue。Run: `pnpm vitest run apps/web/src/lib/settingsDraft` → RED → 实装分支 → GREEN。

- [ ] **Step 3: MarkdownSection 组件 + 组注册 + i18n 双目录 + SC-01 翻转**

按 Interfaces 落组件/组注册/13 个 i18n 键（zh 先定稿 → en 对译）；settingsCenter.test.ts 契约扩展（组序键序 + 组件键字面 + zh 值锁）；b-settings-center.spec.ts SC-01 labels 列表插 `'Markdown'`（renderers 打开方式之后）+ 测试名「十三组定稿序」改「十四组定稿序」+ 注释追加「markdown 组插在打开方式之后（spec D §3.1，十三→十四组为 spec D 明示翻转——D20 先例同款）」。Run: `pnpm vitest run apps/web/src/lib && pnpm run typecheck && pnpm lint` → 全绿（聚合机检含新键）。

- [ ] **Step 4: 定向 e2e + 提交**

Run: `pnpm --filter web build:e2e && pnpm --filter web exec playwright test b-settings-center` → 全绿（SC-01 十四组 + SC-02 JSON 视图含 markdown 节往返零翻转）。

```bash
git add apps/web/src/lib/stores/settings.ts apps/web/src/lib/stores/settings.test.ts apps/web/src/lib/settingsDraft.ts apps/web/src/lib/settingsDraft.test.ts apps/web/src/lib/settings/MarkdownSection.svelte apps/web/src/lib/SettingsCenter.svelte apps/web/src/lib/settingsCenter.test.ts apps/web/src/lib/i18n apps/web/e2e/b-settings-center.spec.ts && git commit -m "feat(settings): markdown 节三档外链图片+域名白名单——枚举/归一纯函数单源（normalizeSettings+settingsDraft 镜像）+设置中心 Markdown 组（SC-01 十三→十四组明示翻转，零行为变化）"
```

---

### Task 2: sanitize 包——IMG 三档分流 + 域名白名单判定 + provider 注入缝

**Files:**
- Modify: `packages/vviewer-sanitize/src/sanitize.ts`（`EXTERNAL_IMAGE_POLICIES`/`ExternalImagePolicy`/`ExternalImagePolicyConfig`/`isExternalImageAllowlisted` 导出 + provider 缝三函数 + `SanitizeOptions.externalImage` + `__vvExternalImagePolicy` config 键 + afterSanitizeAttributes IMG 分支三档改造 + srcset 迁移分支）
- Test: `packages/vviewer-sanitize/test/sanitizeHtml.test.ts`（三档×白名单×srcset 矩阵 + provider 缝 + 五类向量档位不变用例）

**Interfaces:**
- 类型与判定（纯函数，vitest 直测）：
  ```ts
  /** 外链图片三档（spec D §3.1；与 apps/web settings 的 MARKDOWN_EXTERNAL_IMAGE_POLICIES
   * 字面一致——包零 app 依赖，两侧各自单测锁字面）。 */
  export const EXTERNAL_IMAGE_POLICIES = ['blocked', 'manual', 'auto'] as const;
  export type ExternalImagePolicy = (typeof EXTERNAL_IMAGE_POLICIES)[number];
  export interface ExternalImagePolicyConfig {
    policy: ExternalImagePolicy;
    allowlist: readonly string[];
  }
  /** 白名单命中判定（纯函数）：host 取 hostname（端口不参与——URL.hostname 已剥端口），
   * 大小写不敏感；条目三形态——`example.com` 精确（host 逐字相等）、`.example.com` 与
   * `*.example.com` 通配（host===base 或 host 以 '.'+base 结尾=apex 与全部子域）；解析
   * 失败/空表返回 false。 */
  export function isExternalImageAllowlisted(src: string, allowlist: readonly string[]): boolean
  ```
- provider 缝（模块级，setDiagramOptions provider 形态先例——markdownRenderer.ts:197-207）：
  ```ts
  let externalImagePolicyProvider: (() => ExternalImagePolicyConfig | null) | null = null;
  /** 注入外链图片档位提供器（启动时调用；每次 sanitize 现读——设置变更下一渲染即时生效；
   * 传 null 解绑回缺省 blocked）。 */
  export function setExternalImagePolicyProvider(fn: (() => ExternalImagePolicyConfig | null) | null): void
  export function getExternalImagePolicyProvider(): typeof externalImagePolicyProvider
  /** 当次生效档位：provider() 非空取之，否则缺省 { policy: 'blocked', allowlist: [] }（=现行行为）。 */
  export function currentExternalImagePolicy(): ExternalImagePolicyConfig
  ```
- `SanitizeOptions` 增可选字段：`externalImage?: ExternalImagePolicyConfig`（逐调用显式优先于 provider——standalone 消费者自传通道）。
- config 键注入与钩子读回（SERVER_DIAGRAM_CONFIG_KEY 同款机制 ：227-251）：
  ```ts
  const EXTERNAL_IMAGE_CONFIG_KEY = '__vvExternalImagePolicy';
  // sanitizeHtml config 组装点追加：
  [EXTERNAL_IMAGE_CONFIG_KEY]: opts.externalImage ?? currentExternalImagePolicy(),
  // SanitizeConfig 类型交叉 Record<typeof EXTERNAL_IMAGE_CONFIG_KEY, ExternalImagePolicyConfig>
  ```
- IMG 分支改造（钩子 afterSanitizeAttributes 内 `if (tag === 'IMG')`，现行 ：331-362；注释同步改写声明三档语义）：
  ```ts
  const policyCfg = (config as SanitizeConfig | undefined)?.[EXTERNAL_IMAGE_CONFIG_KEY]
    ?? { policy: 'blocked' as ExternalImagePolicy, allowlist: [] as readonly string[] };
  const src = el.getAttribute('src');
  const trimmed = src?.trim() ?? '';
  const srcExternal = src !== null && isExternalMediaSrc(trimmed);
  // 白名单优先于档位（spec §3.1 拍板）：命中按 auto；auto 档全放行；
  // blocked/manual 档未命中才拦
  const allowSrc = !srcExternal || isExternalImageAllowlisted(trimmed, policyCfg.allowlist) || policyCfg.policy === 'auto';
  if (!allowSrc) {
    if (policyCfg.policy === 'manual') {
      // spec §6 落定 1：src 迁 data-vv-external-src——DOM 无 src 即不发请求，
      // BUG-17 防线真实维持；点击放行由渲染管线层（enrich）按标记承接（sanitize 纯函数无交互）
      el.setAttribute('data-vv-external-src', src!);
    }
    el.removeAttribute('src');
    markBlockedExternal(el, hostOf(trimmed));
  }
  ```
- srcset 分支改造（现行 ：342-362 逐候选过滤之上分档）：
  - `auto` 或候选全部 allowlisted：srcset 原样保留（零改动）。
  - `manual`：存在未放行外域候选 → **整串迁移** `el.setAttribute('data-vv-external-srcset', srcset)` + `removeAttribute('srcset')`（裁量落定：混合候选罕见且占位语义本就是整图待确认——整串迁移使点击回填无需候选重组；含相对候选一并延迟到点击后，知情接受）；无未放行外域候选则 srcset 原样。
  - `blocked`：现行逐候选过滤逐字节不变（外域候选剔除、kept 空则移除属性 + 补标记）。
  - manual 迁移时若 `src === null || srcExternal`（无可用加载源）同样 `markBlockedExternal`（现行补标记语义对齐 ：358-360）。
- **五类向量/AV 分支零改动**：VIDEO/AUDIO/SOURCE（:369-378）、poster/SVG image+use/background/input type=image/行内 style（:381-416）在三档与白名单下维持既有行为——注释追加一句「spec D §6 落定 5：白名单作用面=img 与 srcset，本分支不放行」。
- 兼容红线：provider 未注入 + opts.externalImage 缺省 → policyCfg=blocked → IMG/srcset 分支产出与现行**逐字节一致**（既有 sanitizeHtml.test.ts 全量零改动通过=兼容锚）；mermaid 哨兵隔离不涉（外来调用无哨兵键，钩子体早退 ：319）；sanitizeDiagramFragment 经同 provider 吃档位（auto 档下图表产物内的 img 外链放行——产物来源为已配置引擎，知情接受，记档 Errata ⑤）。
- **验收锚**：sanitizeHtml.test.ts 新矩阵全绿 + 既有全量零回归；`pnpm run typecheck` 绿。所触 e2e 锚文件=`apps/web/e2e/t-md.spec.ts`、`apps/web/e2e/b-markdown-html-docs-bug-regressions.spec.ts`（三档对既有 BUG-17/BUG-40 锚零翻转——Review Focus 2，Task 6 定向实跑；本 task 自身不跑 e2e：app 尚未装配 provider，e2e 运行时档位恒缺省 blocked=现行）。

- [ ] **Step 1: TDD isExternalImageAllowlisted 纯函数（RED→GREEN）**

新 describe：精确命中/精确不碰子域（`example.com` 不匹配 `sub.example.com`）/`.x.com` 与 `*.x.com` 命中 apex 与子域/大小写不敏感/端口忽略（src 带 :8443 端口命中无端口条目）/空表 false/非法 src false。Run: `pnpm vitest run packages/vviewer-sanitize` → RED（未导出）→ 实装 → GREEN。

- [ ] **Step 2: TDD 三档矩阵（RED）**

sanitizeHtml.test.ts 新 describe「spec D 三档」（沿既有 BUG-17 describe 装置）：①manual：外域 img → `not.toHaveAttribute('src')` + `data-vv-external-src` 原值 + `data-vv-blocked-external` + title 域名；②manual srcset 外域候选 → `data-vv-external-srcset` 整串 + srcset 移除；③auto：src/srcset 原样零标记；④blocked 显式传入 = 现行（剥除+标记+无 data-vv-external-src）；⑤白名单命中在 blocked 下 src 保留（子域通配与精确各一例）；⑥白名单未命中 manual 照迁；⑦缺省（无 opts 无 provider）= blocked 现行逐字节（现行输出串全等断言）；⑧五类向量在 manual/auto/白名单下仍剥除（poster/svg-image/style/bg/input 五断言）；⑨AV preload=none 在 auto 档维持。Run: `pnpm vitest run packages/vviewer-sanitize` → Expected: ①-⑥ RED（未实现时 manual 不产 data 属性/auto 仍剥/白名单不生效）；⑦（缺省逐字节兼容）⑧（五类向量三档不变）⑨（AV 防线不变）为**现状即绿的回归锚**，实装后必须保持绿。

- [ ] **Step 3: 实装 IMG/srcset 三档 + provider 缝 + config 键**

按 Interfaces 落地（类型/判定/缝/SanitizeOptions/config 注入/IMG 分支/srcset 分档；五类向量与 AV 分支仅注释）。Run: Step 2 命令 → GREEN + `pnpm vitest run packages/vviewer-sanitize packages/vviewer-render-text`（render-text 既有 markdownSanitize/htmlRenderer 依赖面零回归）+ `pnpm run typecheck`。

- [ ] **Step 4: 提交**

```bash
git add packages/vviewer-sanitize && git commit -m "feat(sanitize): IMG 外链三档分流+域名白名单——blocked/manual(src 迁 data-vv-external-src 防线维持)/auto+白名单任意档按 auto（srcset manual 整串迁移）+provider 注入缝（缺省 blocked 逐字节兼容）"
```

---

### Task 3: markdown 包——manual 档占位构建（enrich）+ 会话免确认 + CSS

**前置阅读（触发词条款，开工前全文加载）：** `docs/design/frontend-conventions.md`（§4 a11y 基线（按钮可达性/焦点）+ §6 评审必查清单）、`docs/design/semantic-components.md`（文档内容区按钮——复制徽标同款不入册核对）、`docs/design/ui-design-system.md`。

**Files:**
- Modify: `packages/vviewer-markdown/src/enrich.ts`（`buildExternalMediaPlaceholders` 新 pass + 模块级会话 Set + `__resetExternalMediaSessionForTest` + `enrichMarkdownDom` 编排挂接）
- Test: `packages/vviewer-markdown/test/enrichExternalMedia.test.ts`（新建——owning 包直测）
- Modify: `packages/vviewer-markdown/src/css.ts`（`EXT_MEDIA_CSS` 新常量 + `MARKDOWN_CSS` 数组登记）+ `packages/vviewer-markdown/src/markdown.css`（镜像同步——cssMirror.test.ts 锁逐字节等价）

**Interfaces:**
- enrich 编排（enrichMarkdownDom :326-331，convertMediaElements 之后插一行——manual img 无 src，媒体转换天然跳过 ：50-51 实查）：
  ```ts
  export function enrichMarkdownDom(root: Document): void {
    convertMediaElements(root);
    buildExternalMediaPlaceholders(root); // spec D §3.1：manual 档外域媒体占位（sanitize data-vv-external-src 标记承接）
    convertCallouts(root);
    convertWikilinks(root);
    normalizeTaskLists(root);
  }
  ```
- 会话免确认 Set（spec §5 裁量落定：**包内模块级**，页面生命周期——不持久化、不随渲染实例销毁/重渲清空；同 src 跨 tab/跨重渲一次确认）：
  ```ts
  const loadedExternalSrcs = new Set<string>();
  /** 测试专用：清空会话免确认集（render-text __resetAttachPhaseForTest 同款命名形态）。 */
  export function __resetExternalMediaSessionForTest(): void { loadedExternalSrcs.clear(); }
  ```
- 占位构建（每 img[data-vv-external-src]，幂等：已处理的挂 `data-md-ext-media` 代币防二次命中——runCopyCode :706 代币先例）：
  ```ts
  function buildExternalMediaPlaceholders(root: Document): void {
    for (const img of Array.from(root.querySelectorAll('img[data-vv-external-src]'))) {
      if (img.hasAttribute('data-md-ext-media')) continue;
      img.setAttribute('data-md-ext-media', '');
      const src = img.getAttribute('data-vv-external-src')!;
      const srcset = img.getAttribute('data-vv-external-srcset');
      if (loadedExternalSrcs.has(src)) { restoreExternalMedia(img, src, srcset); continue; } // 会话免确认：直接回填
      // 包裹占位：span.md-ext-media（虚线框语义沿用 BLOCKED_EXTERNAL_CSS 档）包 img（CSS 隐藏）
      // + button.md-ext-media-load；wrapper title 继承 img 的域名 title（悬停提示）
      const ext = mediaExtension(src); // enrich 既有 :38-42 同款
      const isVideo = ext !== null && VIDEO_EXTS.has(ext);
      const isAudio = ext !== null && AUDIO_EXTS.has(ext);
      // §6 落定 2：按钮文案按扩展名——加载视频/加载音频/加载图片（包内中文常量，
      // 与 DEFAULT_UI_TEXTS 缺省中文同源形态；app Renderer 路径不传 ui，记档）
      const label = isVideo ? '加载视频' : isAudio ? '加载音频' : '加载图片';
      const wrap = root.createElement('span'); wrap.className = 'md-ext-media';
      const btn = root.createElement('button'); btn.type = 'button'; btn.className = 'md-ext-media-load';
      btn.textContent = label; btn.setAttribute('aria-label', `${label}：${hostOf(src)}`);
      const title = img.getAttribute('title'); if (title) wrap.setAttribute('title', title);
      img.parentNode!.insertBefore(wrap, img); wrap.append(img, btn);
      btn.addEventListener('click', () => {
        if (btn.disabled) return; btn.disabled = true; // 双击防抖：回填是幂等的但按钮先禁
        loadedExternalSrcs.add(src);
        if (isVideo || isAudio) {
          // §6 落定 2：按扩展名创建 video/audio（controls+preload=none+无 autoplay=MD-13 语义，
          // maxWidth 100% 对齐 convertMediaElements :58-66），替换占位 wrapper
          const media = root.createElement(isVideo ? 'video' : 'audio');
          media.setAttribute('controls', ''); media.setAttribute('preload', 'none');
          media.setAttribute('src', src); (media as HTMLElement).style.maxWidth = '100%';
          const alt = img.getAttribute('alt'); if (alt) media.setAttribute('aria-label', alt);
          if (title) media.setAttribute('title', title);
          wrap.replaceWith(media);
        } else {
          restoreExternalMedia(img, src, srcset); // img src/srcset 回填 + 标记转已加载 + 解包
        }
      });
    }
  }
  function restoreExternalMedia(img: Element, src: string, srcset: string | null): void {
    img.setAttribute('src', src);
    if (srcset) img.setAttribute('srcset', srcset);
    img.removeAttribute('data-vv-external-src');
    img.removeAttribute('data-vv-external-srcset');
    img.removeAttribute('data-vv-blocked-external'); // 标记转已加载：占位 CSS 不再命中
    img.removeAttribute('data-md-ext-media');
    // 解包（点击路径）：闭包持 wrap 引用 wrap.replaceWith(img)；会话免确认路径
    // （构建时 img 尚未被包裹）无需解包——直接回填即可
  }
  ```
  灯箱互不干扰：img 隐藏（CSS `display:none`）用户不可点，runLightbox 的监听永不触发；collectGallery 收录与现行 blocked 占位一致（现状面）。
- CSS（css.ts 新常量 + MARKDOWN_CSS 数组登记于 BLOCKED_EXTERNAL_CSS 之后 + markdown.css 镜像同步；值沿用 BLOCKED_EXTERNAL_CSS 既有档 ：188-189，零新 token）：
  ```css
  /* 外链媒体 manual 档占位（spec D §3.1）：sanitize 迁 src 入 data 属性后的待确认
     形态——img 隐藏不发请求（BUG-17 防线），按钮承接逐张放行 */
  export const EXT_MEDIA_CSS = `.vv-markdown .md-ext-media { display: inline-block; min-width: 96px; min-height: 40px;
    border: 1px dashed #b58900; border-radius: 4px; background: rgb(181 137 0 / 8%); padding: 4px 8px; }
  .vv-markdown .md-ext-media img { display: none; }
  .vv-markdown .md-ext-media-load { font: inherit; font-size: .85em; color: var(--ui-fg, #1f2328);
    background: transparent; border: 1px solid var(--ui-border, #d0d7de); border-radius: 3px;
    padding: 2px 8px; cursor: pointer; }
  .vv-markdown .md-ext-media-load:focus-visible { outline: 2px solid var(--ui-accent, #0969da); outline-offset: 1px; }`;
  ```
- **验收锚**：enrichExternalMedia.test.ts 全绿（占位构建/按钮文案三分支/点击 img 回填解包/点击 AV 换 video+preload=none/会话免确认第二实例直接回填/幂等代币/无标记 img 不构建）+ cssMirror.test.ts 绿（MARKDOWN_CSS===markdown.css 逐字节）+ 既有 sanitize/renderer 测试零回归；`pnpm run typecheck && pnpm lint` 绿。所触 e2e 锚文件=`apps/web/e2e/t-md.spec.ts`（占位形态运行时面——Task 6 MDX-01/02 收口；本 task 不跑 e2e）。

- [ ] **Step 1: TDD 占位构建矩阵（RED→GREEN）**

enrichExternalMedia.test.ts（jsdom 直测 enrichMarkdownDom，输入=手工构造含 `data-vv-external-src` img 的 doc——sanitize 分流面在 T2 已测，本文件只测 enrich 承接）：①构建 wrapper+按钮+img 隐藏；②.mp4 → 「加载视频」/ .mp3 → 「加载音频」/ .png → 「加载图片」；③点击 img 分支：src 回填 + 三个 data 标记移除 + wrapper 解包；④点击 video 分支：video 元素（controls/preload=none/无 autoplay/src）替换 wrapper；⑤同 src 第二次 enrichMarkdownDom → 免确认直接回填（先 `__resetExternalMediaSessionForTest()` 装置隔离）；⑥幂等：二次调用不重复包裹；⑦无 data 标记 img 零改动。Run: `pnpm vitest run packages/vviewer-markdown` → RED → 实装 → GREEN。

- [ ] **Step 2: CSS 双写 + 门禁**

css.ts/markdown.css 同步落 EXT_MEDIA_CSS + 数组登记。Run: `pnpm vitest run packages/vviewer-markdown && pnpm run typecheck && pnpm lint` → 全绿（cssMirror 锁等价）。

- [ ] **Step 3: 提交**

```bash
git add packages/vviewer-markdown && git commit -m "feat(markdown): manual 档外链媒体占位——enrich 构建 wrapper+加载按钮（按扩展名分流图/视频/音频，MD-13 preload=none）+模块级会话免确认 Set+EXT_MEDIA_CSS（cssMirror 同步）"
```

---

### Task 4: markdown 包——相对链接站内导航接管 + wikilink 升级

**前置阅读（触发词条款，开工前全文加载）：** `docs/design/frontend-conventions.md`（§3 i18n 纪律——本 task 包内无新文案；§6 评审必查清单）、`docs/design/semantic-components.md`（链接语义变更核对——接管点击非浮层/菜单）、`docs/design/ui-design-system.md`。

**Files:**
- Create: `packages/vviewer-markdown/src/relativeLinks.ts`（`RelativeLinkTarget`/`RelativeLinkResolver`/`RelativeLinkOpener` 类型 + `isRelativeLinkHref` 分类纯函数 + `wireRelativeLinks` 接管绑定）
- Test: `packages/vviewer-markdown/test/relativeLinks.test.ts`（新建）
- Modify: `packages/vviewer-markdown/src/enrich.ts`（`buildWikilink` 死链分支补 `data-wikilink-path`——纯元数据零行为变化）
- Test: `packages/vviewer-markdown/test/enrichExternalMedia.test.ts`（追加 wikilink path 属性用例；或并入本 task 新 describe）
- Modify: `packages/vviewer-markdown/src/markdownRenderer.ts`（`setRelativeLinkResolver`/`setRelativeLinkOpener`/getter 模块缝 + `RenderRunOptions` 两字段 + `MarkdownViewOptions.resolveRelativeLink?/openRelativeLink?` + renderMarkdownInto 渲染出口接线）
- Modify: `packages/vviewer-markdown/src/index.ts`（类型与缝的 re-export）
- Modify: `packages/vviewer-markdown/src/css.ts`（WIKILINK_CSS 扩 `.md-wikilink` 链接形态）+ `packages/vviewer-markdown/src/markdown.css`（镜像同步）

**Interfaces:**
- 类型（spec §3.2 签名落定——resolver 增第二形参 `source`：Renderer 路径的当前文件上下文经实参透传（`setMarkdownImageResolver(fn(src, source))` 同款 ：135），view 路径闭包自持（spec 的 `(href)` 单参形态即 view 形态字面）；`missing` 扩展可选 `path` 供提示文案取解析后路径，spec `{ kind: 'missing' }` 的兼容扩展）：
  ```ts
  export type RelativeLinkTarget =
    | { kind: 'file'; storeId: string; path: string }
    | { kind: 'directory'; storeId: string; path: string }
    | { kind: 'missing'; path?: string };
  export type RelativeLinkResolver = (
    href: string,
    source: FileSourceLike
  ) => Promise<RelativeLinkTarget | null>;
  /** 打开与提示的 app 侧通道（file→新 tab、directory→目录 tab、missing→状态提示由
   * 装配方一体承接——包不感知 store/showStatusNotice）；source 供装配方取 store 引用。 */
  export type RelativeLinkOpener = (
    target: RelativeLinkTarget,
    href: string,
    source: FileSourceLike
  ) => void;
  ```
- 分类纯函数（spec §3.2 接管判据；`/` 开头=store 根相对属接管面——与 markdownRenderer.isAbsoluteSrc :150-152 的图片面「根相对不进 resolver」刻意不同权，spec §3.2 明示）：
  ```ts
  /** 接管候选分类：空串/页内锚(#)/协议相对(//host)/任意 scheme（http/https/mailto/
   * data/blob/tel…）不接管；其余（./x、../x、x.md、/x、裸名）为站内相对候选。 */
  export function isRelativeLinkHref(href: string): boolean {
    const h = href.trim();
    if (h === '' || h.startsWith('#') || h.startsWith('//')) return false;
    return !/^[a-z][a-z0-9+.-]*:/i.test(h);
  }
  ```
- 接线（渲染出口；渲染实例生命周期=逐元素绑定随节点收养/销毁——Review Focus 5，灯箱/复制徽标同款，无解绑簿记）：
  ```ts
  export function wireRelativeLinks(
    root: Document,
    opts: { resolver: RelativeLinkResolver; opener: RelativeLinkOpener; source: FileSourceLike }
  ): void {
    for (const a of Array.from(root.querySelectorAll('a[href]'))) {
      const href = a.getAttribute('href') ?? '';
      if (!isRelativeLinkHref(href)) continue; // 锚/绝对 URL/data:/blob: 不接管（spec §3.2）
      if (a.hasAttribute('data-vv-rel-link')) continue;
      a.setAttribute('data-vv-rel-link', '');
      a.addEventListener('click', (ev) => {
        ev.preventDefault(); // 接管：原生导航让位站内解析
        void opts.resolver(href, opts.source).then((t) => {
          // preventDefault 已同步生效（接管即拦原生导航）；t=null=resolver 显式弃权
          // →本次点击无动作（app 装配恒返回 target：失败=missing 不产 null，null 仅
          // standalone 契约形态）；reject 同口径（下方 Errata ⑨）
          if (t !== null) opts.opener(t, href, opts.source);
        });
      });
    }
    // wikilink 升级（Review Focus 4）：enrich 死链 span 恒写 data-wikilink-path，
    // resolver 在场且路径为站内相对时换 a.md-wikilink 同通道接管；未注入维持死链形态
    for (const span of Array.from(root.querySelectorAll('span.md-wikilink-dead[data-wikilink-path]'))) {
      const path = span.getAttribute('data-wikilink-path') ?? '';
      if (path === '' || !isRelativeLinkHref(path)) continue;
      const a = span.ownerDocument!.createElement('a');
      a.className = 'md-wikilink';
      a.setAttribute('href', path);
      a.setAttribute('data-wikilink-path', path);
      a.textContent = span.textContent ?? '';
      span.replaceWith(a);
      a.addEventListener('click', (ev) => {
        ev.preventDefault();
        void opts.resolver(path, opts.source).then((t) => { if (t !== null) opts.opener(t, path, opts.source); });
      });
    }
  }
  ```
  resolver reject（store 读抛错）由 `.then` 无第二参吞掉=当次点击无动作（与 resolveRelativeImages :231-233 抛错视同找不到同口径）——记档不另 catch。
- markdownRenderer 接线：
  - 模块缝五组 setter 旁追加（:140-147 形态）：`setRelativeLinkResolver(fn | null)` / `setRelativeLinkOpener(fn | null)` / 两 getter；`let relativeLinkResolver/relativeLinkOpener: … | null`。
  - `RenderRunOptions`（:501-522）追加 `resolveRelativeLink?: RelativeLinkResolver` / `openRelativeLink?: RelativeLinkOpener`。
  - `MarkdownViewOptions`（:822-854）追加同名两可选字段（视图路径装配：`resolveRelativeLink: options.resolveRelativeLink ?? relativeLinkResolver`，与 backend 双通道解析顺序 ：951 同款）。
  - renderMarkdownInto 渲染出口（runPipeline 完成后 ：585 与 resolveRelativeImages :588 之间——enrich 后、灯箱接线同代）：
    ```ts
    // 相对链接站内导航接管（spec D §3.2）：resolver+opener 双缝同时在场才绑定
    //（standalone 安全缺省=原生导航）；监听随节点收养/销毁（灯箱同款生命周期）
    const relResolver = opts.resolveRelativeLink ?? null;
    const relOpener = opts.openRelativeLink ?? null;
    if (relResolver !== null && relOpener !== null) {
      wireRelativeLinks(doc, {
        resolver: relResolver,
        opener: relOpener,
        source: opts.fileSource ?? { storeId: opts.sourceInfo.storeId, storeLabel: '', path: opts.sourceInfo.path, name: '' }
      });
    }
    ```
  - Renderer 路径装配（markdownRenderer.render :762-771）追加 `resolveRelativeLink: relativeLinkResolver, openRelativeLink: relativeLinkOpener`。
- enrich buildWikilink 死链分支（:248-253）补：
  ```ts
  const span = root.createElement('span');
  span.className = 'md-wikilink-dead';
  span.setAttribute('data-wikilink-path', (content.split('|')[0] ?? '').trim()); // spec D §3.2：路径元数据恒写（出口升级消费；纯属性零行为变化）
  span.setAttribute('title', '跨文件 wikilink 不支持');
  span.textContent = raw;
  ```
- CSS：WIKILINK_CSS（css.ts:180）扩展 `.vv-markdown a.md-wikilink { color: var(--ui-accent, #0969da); cursor: pointer; }`（markdown.css 镜像同步）。
- **验收锚**：relativeLinks.test.ts 全绿（分类矩阵：`./x`/`../x`/`x.md`/`/x`/裸名接管；`#a`/`http(s)`/`mailto:`/`data:`/`blob:`/`//host`/空串不接管；wire 后 a 有 data-vv-rel-link + click preventDefault + resolver fake file/directory/missing/null 四态 opener 调用面；resolver reject 无动作；wikilink span 升级为 a.md-wikilink + 外域 path 不升级；双缝缺一不绑定）+ enrichExternalMedia.test.ts wikilink path 属性用例绿 + cssMirror 绿 + markdown 包既有测试零回归；typecheck+lint 绿。所触 e2e 锚文件=`apps/web/e2e/t-md.spec.ts`（链接面回归—— wikilink 死链形态在 app 内 resolver 装配后变可点，既有死链断言若有须按新形态核对，Task 6 定向）。

- [ ] **Step 1: TDD isRelativeLinkHref 分类矩阵（RED→GREEN）**

relativeLinks.test.ts 分类 describe 八例。Run: `pnpm vitest run packages/vviewer-markdown` → RED → 实装 → GREEN。

- [ ] **Step 2: TDD wireRelativeLinks 接管与升级（RED）**

fake resolver/opener jsdom 直测（上述验收锚全例）。Run 同上 → RED → 实装 wireRelativeLinks → GREEN。

- [ ] **Step 3: enrich data-wikilink-path + markdownRenderer 双缝装配 + CSS**

按 Interfaces 落地（enrich 一行 + renderMarkdownInto/Renderer/ViewOptions 三处 + index.ts re-export + css 双写）。Run: `pnpm vitest run packages/vviewer-markdown packages/vviewer-render-text && pnpm run typecheck && pnpm lint` → 全绿。

- [ ] **Step 4: 提交**

```bash
git add packages/vviewer-markdown && git commit -m "feat(markdown): 相对链接站内导航接管——渲染出口 wire pass（双注入缝缺一不接管）+wikilink 死链升级同通道（data-wikilink-path 元数据恒写）+RelativeLinkTarget/Resolver/Opener 契约"
```

---

### Task 5: app 装配——provider/resolver/opener 接线 + markdownLinks 纯解析 + html/docx 直调注入与 CSP 联动

**前置阅读（触发词条款，开工前全文加载）：** `docs/design/frontend-conventions.md`（§3 i18n 纪律——notice 键）、`docs/design/semantic-components.md`（状态栏提示通道——BUG-24 showStatusNotice 既有通道复用，不新增浮层）。

**Files:**
- Create: `apps/web/src/lib/markdownLinks.ts`（链接解析纯函数：decode/剥 query-hash/`resolveInStorePath` join/存在性探测）——无 $app 依赖可 vitest 直测（markdownImages.ts:2 抽出模式同款）
- Test: `apps/web/src/lib/markdownLinks.test.ts`（解析式用例：同目录/上级/URL 编码/query-hash——spec §4 单测锚）
- Modify: `apps/web/src/lib/viewer.ts`（browser 块三接线：`setExternalImagePolicyProvider`（loadSettings 现读闭包，getDiagramOptions :289 同款口径）+ `setRelativeLinkResolver`/`setRelativeLinkOpener`）
- Modify: `apps/web/src/lib/i18n/catalogs/zh-CN/notice.ts`、`apps/web/src/lib/i18n/catalogs/en/notice.ts`（`notice.openflow.relativeMissing`）
- Modify: `packages/vviewer-render-text/src/html.ts`（sanitizeHtml 显式传档位 + CSP img-src 联动）
- Test: `packages/vviewer-render-text/test/htmlRenderer.test.ts`（CSP 三态 + manual 迁移断言扩展）
- Modify: `packages/vviewer-render-doc/src/docx.ts`（sanitizeHtml 显式传档位）+ `packages/vviewer-render-doc/test/office.test.ts`（档位透传用例）

**Interfaces:**
- markdownLinks.ts（纯 .ts；`resolveInStorePath` 复用自 ./markdownImages——链接与图片同一 join 语义单源）：
  ```ts
  import { resolveInStorePath } from './markdownImages';
  import type { TreeStore } from '@bhxch/vviewer-core';
  import type { RelativeLinkTarget } from '@bhxch/vviewer-markdown';

  /**
   * 相对 href → store 内路径（spec D §3.2 解析式）：query/hash 剥离（跨文件 fragment
   * hash 丢弃——§6 落定 4 MVP 不自动定位）→ URL 解码（markdown-it 对 CJK href 百分号
   * 编码，decode 失败保留原串）→ resolveInStorePath（`./`/`../` 逐段规范、越 store 根
   * 返回 null、前导 `/` 归 store 根相对——img 相对图片同款 join 语义单源）。
   */
  export function resolveRelativeLinkPath(sourcePath: string, href: string): string | null {
    const stripped = href.replace(/[?#][\s\S]*$/, '');
    if (stripped === '') return null;
    let decoded = stripped;
    try { decoded = decodeURIComponent(stripped); } catch { /* 非法百分号序列：保留原串 */ }
    const p = resolveInStorePath(sourcePath, decoded);
    return p === '' ? null : p; // 空结果（'./' 弹空等）非站内目标
  }

  /**
   * 相对 href → RelativeLinkTarget（存在性探测 §6 落定 6）：listChildren(父目录).find
   * 命中即按 TreeNode.kind 分流 file/dir；未命中且裸名无扩展名 → 试 `path+'.md'`
   * （wikilink `[[file]]` 无扩展名形态）；listChildren 失败（平铺 store）→ read 兜底
   * （成功=file；失败含目录目标=missing）。未命中返回 { kind: 'missing', path }。
   */
  export async function resolveRelativeLinkTarget(
    store: TreeStore, sourcePath: string, href: string
  ): Promise<RelativeLinkTarget>
  ```
  探测实现要点：`dir = path 含 '/' ? 前段 : ''`；命中节点 `n.path === path` 后 `n.kind === 'dir' ? directory : file`（core `Kind = 'file' | 'dir'` types.ts:1）——target.storeId 取 `store.id`；`.md` 变体探测同函数递归一次；read 兜底 try/catch（AbortError 等一律 missing——渲染取消不误报）。
- viewer.ts 三接线（browser 块内，:276-283 imageResolver 装配旁）：
  ```ts
  // spec D §3.1：外链图片档位 provider（loadSettings 现读——设置保存后下一渲染生效，
  // getDiagramOptions :289 同款口径；normalizeSettings 已归一 allowlist）
  setExternalImagePolicyProvider(() => {
    const s = loadSettings();
    return { policy: s.markdown.externalImages, allowlist: s.markdown.externalImagesAllowlist };
  });
  // spec D §3.2：相对链接解析 + 打开通道（source 窄取 FileSource.store——markdownImages :281 同款）
  setRelativeLinkResolver(async (href, source) =>
    resolveRelativeLinkTarget((source as FileSource).store, source.path, href)
  );
  setRelativeLinkOpener((target, _href, source) => {
    const store = (source as FileSource).store;
    if (target.kind === 'file') addTab(store, target.path, target.path.split('/').pop() ?? target.path);
    else if (target.kind === 'directory') addDirStoreTab(store); // 目录 tab（根）——子目录定位 MVP 不做（§5 裁量记档）
    else showStatusNotice(t('notice.openflow.relativeMissing', { path: target.path ?? _href }));
  });
  ```
  import 增：`setExternalImagePolicyProvider`（@bhxch/vviewer-sanitize）、`setRelativeLinkResolver/setRelativeLinkOpener`（@bhxch/vviewer-markdown，viewer.ts :8-14 既有 import 块）、`addTab` 与 `showStatusNotice`（均 ./openFlow.svelte façade——QuickOpenPanel.svelte:9 与 TreeNodeRow.svelte:4 同源先例）、`addDirStoreTab`（./tabsModel.svelte——serverConnect.svelte.ts:26 同源）。html.ts 的 `buildSandboxedSrcdoc` 已在 T2 后有 provider 兜底——此处**显式传参**（`sanitizeHtml(raw, { wholeDocument: true, externalImage: currentExternalImagePolicy() })`）与 CSP 联动同源取值（import `currentExternalImagePolicy`）。
- html.ts CSP 联动（:27-28 CSP_CONTENT 改构造函数；规划期实查 4——CSP 不联动则 auto/白名单在 html 沙箱被网络栈之前拦死，spec「体验一致」空转）：
  ```ts
  function buildCspContent(policy: ExternalImagePolicyConfig): string {
    const imgSrc = ['data:', 'blob:'];
    if (policy.policy === 'auto') imgSrc.push('https:', 'http:');
    for (const e of policy.allowlist) {
      const entry = e.trim().toLowerCase();
      if (entry === '') continue;
      if (entry.startsWith('*.') || entry.startsWith('.')) {
        const base = entry.replace(/^[*.]+/, '');
        imgSrc.push(`https://${base}`, `https://*.${base}`); // CSP *.{base} 不含 apex——双条
      } else imgSrc.push(`https://${entry}`);
    }
    return `default-src 'none'; img-src ${imgSrc.join(' ')}; media-src data: blob:; style-src 'unsafe-inline'; font-src data:`;
  }
  // media-src 不动：AV/poster 任何档位不放行（spec §6 落定 5）
  ```
  buildSandboxedSrcdoc 内 `const policy = currentExternalImagePolicy();` 一次取值同时喂 sanitizeHtml 与 CSP（同渲染帧一致性）。
- i18n：`notice.openflow.relativeMissing`：zh `目标不存在：{path}`；en `Target not found: {path}`（占位符两侧一致；openflow 域键序追加）。
- **验收锚**：markdownLinks.test.ts 全绿（同目录 `a/b/c.md`+`./d.md`→`a/b/d.md`；上级 `../d/e.md`→`a/d/e.md`；URL 编码 `%20`/CJK；query/hash 剥离与纯 `#` 不达此函数——分类在包侧；越根 `../../x`→null 探测后 missing；file/dir/missing/`.md` 变体/read 兜底五态）+ htmlRenderer.test.ts CSP 三态（auto 加 https:http: / blocked 无 allowlist 维持 `img-src data: blob:` / 白名单条目双条）+ manual 迁移断言 + office.test.ts 档位透传绿 + 聚合机检绿 + typecheck+lint 绿。所触 e2e 锚文件=`apps/web/e2e/t-md.spec.ts`、`apps/web/e2e/b-markdown-html-docs-bug-regressions.spec.ts`（装配后全行为面生效，Task 6 定向实跑）。

- [ ] **Step 1: TDD markdownLinks 解析式（RED→GREEN）**

markdownLinks.test.ts（resolveInStorePath 既有用例先例 markdownImages.test.ts）：解析式矩阵 + `resolveRelativeLinkTarget` 五态（fake store：listChildren/read stub——TreeStore 结构类型手写 fake）。Run: `pnpm vitest run apps/web/src/lib/markdownLinks` → RED → 实装 → GREEN。

- [ ] **Step 2: viewer.ts 三接线 + notice 键**

按 Interfaces 落装配与 i18n 两键。Run: `pnpm vitest run apps/web/src/lib && pnpm run typecheck && pnpm lint` → 全绿（聚合机检含 relativeMissing）。

- [ ] **Step 3: html/docx 直调注入 + CSP 联动 + 单测**

html.ts 构造函数化 CSP + 显式传参；docx.ts 显式传参；htmlRenderer.test.ts/office.test.ts 扩展（CSP 三态断言 `meta[http-equiv=Content-Security-Policy]` content 字面 + manual img 迁移）。Run: `pnpm vitest run packages/vviewer-render-text packages/vviewer-render-doc && pnpm run typecheck && pnpm lint` → 全绿。

- [ ] **Step 4: 提交**

```bash
git add apps/web/src/lib/markdownLinks.ts apps/web/src/lib/markdownLinks.test.ts apps/web/src/lib/viewer.ts apps/web/src/lib/i18n packages/vviewer-render-text packages/vviewer-render-doc && git commit -m "feat(web): markdown 链接/外链档位装配——provider 现读 settings+相对链接 resolver/opener（addTab/addDirStoreTab/showStatusNotice 通道）+html/docx 直调注入（html CSP img-src 三档联动）"
```

---

### Task 6: e2e 锚批 b-markdown-links-media（spec §4 ①-⑤ + 既有锚重定基）

**Files:**
- Create: `apps/web/e2e/b-markdown-links-media.spec.ts`（MDX- 外链媒体域 + MDL- 相对链接域）
- Modify: `apps/web/e2e/t-md.spec.ts`（BUG-40 基线护栏 :487-494 补 `data-vv-external-src` 在场断言——钉住默认 manual 语义（Review Focus 2），防未来静默退化回 blocked；其余既有断言零改动——manual 下字面全部继续成立，规划期逐条核对）

**验收锚 / e2e**：本任务即 e2e 锚批——`pnpm --filter web build:e2e` 后本域全绿 + 定向回归（t-md / b-markdown-html-docs-bug-regressions / b-settings-center）零翻转。装置复用见 Global Constraints「e2e 装置既有先例」。

- [ ] **Step 1: MDX-01——默认 manual 档占位与防线（spec §4 ①⑤）**

injectDir 注入含外域 img（`http://external.example.com/pic.png`）+ 五类向量的 md → 外域请求监听先于装载（t-md BUG-40 同款）→ 断言：外域请求 0 条（观察窗 1.5s）；`.md-ext-media` 占位可见 + `.md-ext-media-load` 按钮在 + img `not.toHaveAttribute('src')` + `toHaveAttribute('data-vv-external-src', …)` + `data-vv-blocked-external` + title 域名；五类向量元素照旧剥除（poster/SVG/style/bg/input 断言沿用 t-md 形态）。

- [ ] **Step 2: MDX-02——点击「加载图片」放行（spec §4 ②）**

`page.route('**external.example.com**/pic.png', fulfill PNG 1×1)`（goto 前安装）→ 点 `.md-ext-media-load` → `expect.poll` img `toHaveAttribute('src', …)` + img 可见 + `.md-ext-media` count 0（解包）+ 外域请求恰 1 条（放行前零/放行后一——防线时序判据）。

- [ ] **Step 3: MDX-03——blocked/auto 档与白名单优先（spec §4 ①）**

设置 JSON 应用（openSettings→JSON 视图或 applySettings 装置）：①blocked 档 → 占位仍在（BLOCKED_EXTERNAL_CSS 虚线 img）+ 按钮 count 0 + 零请求；②blocked + allowlist `['external.example.com']`（route fulfill）→ img src 在场直接可见（白名单优先于档位）；③auto 档 → src 在场零按钮零占位。每档独立 test（applySettings 后重开文件重渲染）。

- [ ] **Step 4: MDL-01/05——同目录互链与上级链接新 tab 打开（spec §4 ③）**

injectDir 注入 `a.md`（`[b](./b.md)`、`[up](../sub/b.md)`、`[c](c.md#frag)`）+ `sub/b.md` + `sub/a.md` → 打开 a.md → 点 `[b](./b.md)` → 新 tab 激活且渲染 b.md 内容（tab 计数 +1/激活 tab 名 b.md）；hash 形态 `c.md#frag` 打开后 hash 不定位（§6 落定 4——断言打开即成、无锚滚动行为断言仅记档不硬断）。

- [ ] **Step 5: MDL-02/03——缺失目标提示与不接管面（spec §4 ③）**

缺失：`[x](./missing.md)` 点击 → `.vv-statusbar` `toContainText('目标不存在：missing.md')`（showStatusNotice BUG-24 通道）。不接管：外域 `a[href^="http"]` 与页内锚 `a[href^="#"]` 无 `data-vv-rel-link` 属性（分类分类面断言，不实点外域防导航离场）。

- [ ] **Step 6: MDL-04——wikilink 可点打开（spec §4 ④）**

injectDir 注入含 `[[b]]` 与 `[[b|别名]]` 的 md + b.md → 死链 span 升级为 `a.md-wikilink` → 点击打开 b.md。standalone 降级形态不设 e2e 锚（app 内 resolver 恒装配；降级面由 relativeLinks.test.ts 双缝缺一不绑定用例承接——记档）。

- [ ] **Step 7: 既有锚重定基 + 定向回归 + 提交**

t-md 基线护栏补断言（Files 注记）；Run: `pnpm --filter web build:e2e && pnpm --filter web exec playwright test b-markdown-links-media t-md b-markdown-html-docs-bug-regressions b-settings-center` → 全绿（manual 档下既有 BUG-17/BUG-40/MD-11 断言零翻转——Review Focus 2 兑现）。

```bash
git add apps/web/e2e && git commit -m "test(e2e): markdown 外链媒体/相对链接批 MDX+MDL 域锚——manual 占位与防线时序/点击放行/三档+白名单分流/站内导航新 tab/缺失提示/不接管面/wikilink 可点（t-md 基线护栏补 manual 语义断言）"
```

---

### Task 7: 全量门禁与收尾（控制器执行）

- [ ] `node tools/fetch-e2e-corpus.mjs`（语料）→ `pnpm lint && pnpm run typecheck && pnpm vitest run`（仓库根全量）→ `pnpm --filter web build:e2e` → playwright 全量双 project（`pnpm --filter web exec playwright test`；对比基线：新增 b-markdown-links-media MDX/MDL 域外零回归——重点观察 md/html/docx 面与设置面既有锚）→ `pnpm --filter web exec playwright test --config playwright.server.config.ts`（server 档零翻转——远程 comrak 链零改动的一致性兑现）→ `git status --porcelain` 净空。
- [ ] 全量 review（superpowers:requesting-code-review，范围=本计划全部 commit），修复全部 C/I/M 后复审；**不 push**。
- [ ] 台账汇总（实施期记档项随任务报告归集；本计划规划期记档六条见 Errata——机制订正②、html/docx manual 无按钮③、包枚举与 app 枚举双单源④、sanitizeDiagramFragment 同吃 provider⑤、目录 tab 根定位 MVP⑥、包内占位文案不入 catalogs）。

## Errata（执行期勘误）

- 2026-11-14 初版（规划师 D 基于 HEAD 38e17bf 编写；规划期关键实查已内联：sanitizeHtml 已有 opts 第二参与钩子 config 透传机制 sanitize.ts:476/:227-251/:316-319 / IMG 分支 ：331-362、srcset :342-362、AV :369-378、五类向量 :381-416、markBlockedExternal :51-54 / enrich convertMediaElements :48-68（a[href] 分支 ：70-84）、VIDEO/AUDIO_EXTS :44-45、applyExternalMediaGuard :25-30、wikilink 死链 ：248-253、callout closest('a') 豁免 ：170-171 / pipeline PipelineCtx :23-56、runLightbox :752-774、五步注册 ：779-787 / markdownRenderer sanitize 调用点 ：574、enrich :575、runPipeline :576-585、resolveRelativeImages :588、isAbsoluteSrc :150-152、五组缝 ：115-207、Renderer 装配 ：762-771、ViewOptions :822-854 / index.ts re-export :31-41 / css.ts WIKILINK_CSS :180、BLOCKED_EXTERNAL_CSS :188-189、MARKDOWN_CSS 数组 ：197-211 / render-text 依赖 vviewer-markdown（package.json:11）、enrich shim、html.ts buildSandboxedSrcdoc :40-73+CSP :27-28+占位样式 ：62-67 / docx.ts sanitizeHtml :47 / settings.ts Settings :88-131、DEFAULTS :140-159、defaults() :172-190、normalizeSettings diagrams 块 ：232-251、notify :351-364 / settingsDraft SETTINGS_KEYS :36、diagrams 镜像 ：153-196、isObj :52 / SettingsCenter groups :64-79 / nav 组序契约 settingsCenter.test.ts:33 / SC-01 labels b-settings-center.spec.ts:55-90（十三组 ：69-83，D20 翻转注释 ：66-68）/ TreeStore core types.ts:39-63（无 exists）、TreeNode.kind types.ts:3-5、Kind='file'|'dir' types.ts:1 / resolveInStorePath markdownImages.ts:22-35、resolveImageBlobUrl :43-63 / viewer.ts resolver 装配 ：276-283、registry.install :138 / addTab tabsModel.svelte.ts:696（openFlow façade）、addDirStoreTab :785 / showStatusNotice serverConnect.svelte.ts:56、statusbar ViewerPane.svelte:1285 / posixJoin render-foreign bridge.ts:204（A4 拒 ../）/ markdownExport.ts:31-33 外域不强拉 / e2e 装置 b-markdown-html-docs-helpers.ts:36/:54、t-md BUG-40 基线护栏 ：487-494、CSP 实证注释 :445-448）。
- ①**spec §3.1 引用指向订正**：spec §2「五组 setter 先例 vviewer-markdown/src/index.ts:31-41」实为 re-export 面，setter 本体在 markdownRenderer.ts:115-207——本计划按本体行号引用。②**机制订正（spec §3.1「新 PipelineCtx 字段」）**：sanitize 先于 runPipeline（markdownRenderer.ts:574-585），PipelineCtx 是管线入参非上游——档位与链接两注入面落定为模块级 provider/setter（sanitize 包 provider + markdown 包 setter 双缝），`SanitizeOptions.externalImage` 逐调用显式优先；行为面（settings 现读即时生效、standalone 自传/缺省安全）与 spec 一致。③**html/docx manual 档知情差异**：占位按钮仅 markdown 面（enrich 不在 html srcdoc/docx innerHTML 两面）；auto/白名单/blocked 三态完整一致（html 面经 CSP 联动兑现「体验一致」的加载语义）；后续增强可复用 T3 占位构建器。④**枚举双单源**：`MARKDOWN_EXTERNAL_IMAGE_POLICIES`（app settings.ts）与 `EXTERNAL_IMAGE_POLICIES`（sanitize 包）字面一致由两侧单测锁——settings.ts 不 import sanitize 包（避免设置域对净化包新增依赖边；包零 app 依赖方向不变）。⑤**sanitizeDiagramFragment 同吃 provider**：图表产物 sanitize 走同 provider，auto 档下产物内 img 外链放行——产物来源为已配置引擎，知情接受；白名单/三档对 SVG image/use 向量不生效（落定 5 不放行）。⑥**目录 tab 打开=store 根**（spec §5 裁量落定）：`addDirStoreTab(store)` 现有通道只开根（tabsModel.svelte.ts:785-796 `addTab(store, '', …)`）——子目录直达 tab 为后续增强，MVP 目录链接开 store 目录 tab（目标目录树内可达）。⑦**占位按钮文案包内中文常量**（与 DEFAULT_UI_TEXTS 缺省同源形态）：app 的 Renderer 路径不传 ui、复制徽标等既有包内文案同为中文缺省（viewer.ts 无 ui 装配实查）；如需 i18n 参数化，后续经 enrichMarkdownDom 可选参扩展（本批无消费面不做）。⑧**manual srcset 整串迁移**（裁量落定）：混合候选（相对+外域）罕见且占位语义本就是整图待确认——整串迁 `data-vv-external-srcset` 使点击回填无需候选重组，相对候选一并延迟到点击后（知情接受）。⑨**resolver reject 吞错**：`.then` 无第二参——store 读抛错当次点击无动作（resolveRelativeImages :231-233 抛错视同找不到同口径）。⑩**规划期无 deferred 项**：spec §5 六项裁量（默认档/白名单归一/会话范围/委托落点/posixJoin/目录通道）与 §6 六条落定全部内联于上文 Interfaces/Global Constraints/Errata。
