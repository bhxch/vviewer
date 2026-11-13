# 代码渲染器引擎修复批（open-as 语言回填 + 切语言引擎路由 + worker 毒化重建）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修三层根因：①open-as（override）路径补 det.lang shebang 回填（extless 文件切到 code 不再恒 hljsAuto）；②langOverride/det.lang 的清单感知引擎路由（清单外 + 无远程 → 直接 hljs + 状态栏结构化降级原因，不再无声）与 MetaPanel 候选 grammar 前置排序；③HighlightClient 单例毒化后经显式动作（切渲染器/切语言）门控重建（recreate({force?})），worker「健康但清单全空」纳入 failed-态判定。

**Architecture:** dispatcher override 分支就地复用文本探测链抽出的 shebang 探测 helper（auto 路径逐字节不变）→ 清单感知门落在注入侧（apps/web withDebug 包装 localFn：清单外跳过注定失败的 worker 往返；远程可用不拦——router 裁决不动）→ 降级原因由 renderCode 就地计算（`client.hasLocalGrammar?.(lang)` + computeWhere + 结果分支），经 `CodeFileMeta.engineNote` 结构化上行 → ViewerPane 既有 getMeta 250ms 轮询通道渲染状态栏注记（不新增回调/浮层/toast）→ 重建走 neutral hook 模块（tabsModel 不直 import highlightClient，避 tabsModel→highlightClient→openFlow→tabsModel 导入环），failed-态门控 + 代际计数 + detach(pending) 防 HL-09 族竞态。

**Tech Stack:** Svelte 5 runes（全局强制）、vitest（仓库根 jsdom）、Playwright 双 project、Conventional Commits。

**Spec:** `docs/superpowers/specs/2026-11-12-code-renderer-engine-fixes-design.md`（本计划从 spec 论证；实现者两份都读——spec §5 裁量项与 §6 builder check 订正节同样有效）

## 基线与实施顺序

- **基线**：当前 HEAD `0baaf92`（main；spec C 已全部落地含其勘误修复——rebuildHighlightClient/cdnProfiles/CdnSection 在位）。spec E 此前零落地；本计划全部工作基于该 HEAD 展开。
- **实施顺序**：Task 1 → Task 2 → Task 3 → Task 4 → Task 5，**严格串行**。理由：T2/T3 均触及 `apps/web/src/lib/highlightClient.ts`（T2 加 hasGrammar 与包装门，T3 加 recreate 门控与触发面），串行保 commit 原子性与接口先定后消费；T4 e2e 锚批依赖 T1/T2/T3 运行时行为全部就位；T5 收尾。
- **grammar 构建链（spec F）条件核查**：本计划触及 dispatcher（core）、render-text code/、highlight client、apps/web lib——**不触及** `tools/grammar-builder`、`build.mjs`、gen-sources 与任何 cargo 生成物，**无需 gen-sources 与 build.mjs --fetch 先行步骤**（无 cargo 依赖；`pnpm gen:grammars` 既有产物已在 apps/web/static/grammars/，e2e 直接消费）。
- **不触及 server/（Rust）**：远程 compute 链（router/advertised）零改动；清单外+远程可用的放行完全复用既有路由裁决（spec §6 落定第 1 条）。

## Global Constraints

- **拍板项不得偏离**（spec §2/§6）：override 路径只补 shebang lang、不做签名/扩展名重判（BUG-13 预检跳过语义维持）；`Tab.overrideLang` 优先级不变（langOverride > det.lang，code/index.ts:89 现序）；hasGrammar 门只作用本地 worker 链、远程可用时远程优先；降级原因两态（「本地无 grammar，已用远程 tree-sitter」/「本地与远程均无 grammar，已用 hljs 兜底」）；重建 API 形态 `recreate({ force? })`——CDN 档位变更传 force、切渲染器/切语言走 failed-态门控；「worker 健康、清单全空」纳入 failed-态；自动路径（det.lang 清单外的 open-as/extless）与手动 langOverride 同样注记原因；hljs 兜底**不进错误卡片**（降级非失败）；重建后首次 highlight 失败回落 hljs 不二次自动重建。
- **兼容红线**：BUG-35（init-ok ack 置活，t-hl.spec.ts:584 锚 + client.test.ts:353 describe）与 BUG-34/37 相关既有锚不翻转——**worker init-ok ack 路径零改动**（packages/vviewer-highlight/src/worker.ts 不动；client.ts 仅加只读访问器）；15s 看门狗阈值不动；`failWorker` initFailed 语义保留为「当前实例不可用」。
- **runes 纪律**：`.svelte`/`.svelte.ts` 一律 runes 写法；vitest 直测纯逻辑用 `.ts`（根 vitest 无 svelte 插件）。tabsModel.svelte.ts 仍不可 vitest 直测——其触发面行为由源码契约测试（metaPanelLang.test.ts 先例）与 e2e 收口。
- **i18n 纪律**：新文案键落 `catalogs/{zh-CN,en}/viewer.ts`（域=viewer），key 三段 `{域}.{模块}.{语义}`；en 键集==zh 键集由聚合机检硬断言（catalogs.aggregate.test.ts）；占位符 `{lang}` zh/en 一致。
- **门禁口径**：vitest 一律在**仓库根**跑（包目录直跑缺 jsdom）；typecheck 仓库根 `pnpm run typecheck`；重建 web 一律 `pnpm --filter web build:e2e`（裸 build 冲掉 CDN 注入致 GRF 域假红）；playwright 一律 `pnpm --filter web exec playwright test …`（根 package.json 无 playwright devDep，ci.yml:171 同形态）。
- **commit 纪律**：Conventional Commits（feat/fix/test/docs… 中文主题）、原子化；`git status --porcelain` 自查净空再 add（不按记忆清单）；**一律不得 git push**。
- **UI 文案/交互组件/a11y 任务前置阅读**（Task 2 开工前全文加载，不凭记忆转述）：`docs/design/frontend-conventions.md`（§3 i18n 纪律 + §4 a11y 基线 + §6 评审必查清单）、`docs/design/semantic-components.md`（状态栏段/提示通道——引擎注记 span 为既有 `.vv-statusbar` role="status" 区域内新增被动文本段，**若该文档清单要求登记则先登记后使用**；本计划无新浮层/菜单/确认通道，不触发 OVERLAY 入册）。
- **e2e 装置既有先例**（Task 4 直接复用，不新造）：目录注入 `__vvOpenDirImpl`（b-override-lang.spec.ts:58 openDir）；MetaPanel 打开方式切换 `.meta-openwith` selectOption('code')（t-open-with.spec.ts:416）；语言行提交 fill+blur（fill 只派 input 不派 change，b-override-lang setLang :164）；e2e 构建单基 CDN 注入 `https://cdn.grammars.test/grammars/` 恒失败为既有噪音（override-lang.md §4），清单判定以 same-origin lite manifest（34 语言）为准。

## Review Focus

1. **auto 路径逐字节不变**（修 1 最大风险）：`resolveInitialRenderer` :345-355 是**唯一写 det.lang 的地方**——抽 helper 时必须只做「解码+shebangLangOf+?? undefined」的等价搬移；回归锚=dispatcher.test.ts 既有直开用例全绿 + LANG/HL 域定向 e2e 零回归。
2. **清单门误伤面**：hasGrammar 门若拦到远程可用路径即违背 spec §6 第 1 条——门只放 localFn 闭包内（routeHighlight 裁决先于门）；`grammarTableHas(null)=true` fail-open（清单未就绪不拦，交 worker 链既有裁决）；fake client 无 hasLocalGrammar 时 `?? true` 零行为变化（code.test.ts 既有 fake 全数走旧语义）。
3. **重建竞态（HL-09 同族）**：切语言/切渲染器 rev++ 重渲染与 recreate 异步 create 并发——recreate 必须先 detachHighlightClient()（相位回 pending）再 dispose 旧实例，使重渲染的 waitForAttachedClient 等到**新** client；否则在途重渲染拿到已 dispose 旧 client → highlight reject HighlightCanceledError → engine 停 'pending' 永不落定。
4. **清单外自动路径（spec §6 第 3 条）**：修 2 的注记必须覆盖 det.lang 清单外的自动降级（open-as/extless shebang 命中但清单无该语言）——只覆盖手动 langOverride 等于没修全（用户原始 bug 正是自动路径静默）。单测与 e2e 锚两态都要有。
5. **导入环**：tabsModel.svelte.ts **不得**直接 import highlightClient.ts（highlightClient:26 → openFlow.svelte:42 → tabsModel 环）——经 neutral hook 模块 `highlightRecreate.ts` 反转（Task 3）。
6. **LANG-01/02/04 与 BUG-35 锚零翻转**：rust 在 lite manifest 内（hasLocal=true 门不触发）；init-ok ack 路径零改动。全量 e2e 对比基线：新增 ENG 域锚外零回归。

---

### Task 1: 修 1——dispatcher override 分支 det.lang shebang 回填

**Files:**
- Modify: `packages/vviewer-core/src/dispatch/dispatcher.ts`（shebang 探测抽公共 helper + override 分支回填）
- Test: `packages/vviewer-core/test/dispatcher.test.ts`（override 回填用例扩展；既有 :609-616 override 用例旁）

**Interfaces:**
- Produces（dispatcher.ts 模块内私有 helper，不导出、不扩 detect 包 API——两调用点同文件，裁量落定）：
  ```ts
  /** shebang 语言探测（文本探测链 ：354 与 override 回填共用）：head 解码后取 shebang 语言；无命中 undefined。 */
  function shebangLangOfHead(head: Uint8Array): string | undefined {
    return shebangLangOf(new TextDecoder().decode(head)) ?? undefined;
  }
  ```
- auto 路径改造：:354 `det.lang = shebangLangOf(new TextDecoder().decode(head)) ?? undefined;` → `det.lang = shebangLangOfHead(head);`（**逐字节等价搬移**，looksTextual 门与 extless/reclassifiedFrom 置位逻辑原样保留在外层）。
- override 分支（:496-501）追加（sniff 补齐之后）：
  ```ts
  // spec E 修 1：code 渲染器 override（open-as）补 det.lang shebang 回填——code 无
  // sniff 字段，override 重派时 det 全新构建、det.lang 恒 undefined → lang null 走
  // hljsAuto（用户 bug 主诉：从其他渲染器切到 code 恒 hljs）。复用文本探测链同源
  // 探测；只补 lang 不做签名/扩展名重判（BUG-13 预检跳过语义维持）；不加
  // looksTextual 门——shebang 首行 `#!` 本身是强信号，且「NUL 内容落 hex 后
  // open-as code」是 extless 主诉求的真实到达路径（裁量落定，e2e OWX-E1 依赖）。
  if (override.id === 'code' && det.lang === undefined) det.lang = shebangLangOfHead(head);
  ```
- **验收锚**：dispatcher.test.ts 新用例全绿 + 既有全绿（auto 路径回归）；所触 e2e 锚文件=`apps/web/e2e/b-code-engine-recovery.spec.ts`（OWX-E1 用例，Task 4 落）。

- [ ] **Step 1: TDD 先写 override 回填单测（RED）**

dispatcher.test.ts 新增四例（override=code 装置沿既有 :609 用例形态）：①extless shebang head（`#!/usr/bin/env python\n…`）override=code → 返回 det.lang === 'python'（现状 RED：恒 undefined）；②override=code 无 shebang head → det.lang 仍 undefined（不误报）；③override=非 code 渲染器（如 markdown/hex）+ shebang head → det.lang 不回填（范围门）；④**auto 路径回归**：extless shebang 直开（无 override）→ det.lang 'python' 与既有值逐字节相等（helper 抽取等价性锚）。Run: `pnpm vitest run packages/vviewer-core`（仓库根）→ Expected: ① FAIL（②③④现状即绿）。

- [ ] **Step 2: 抽 helper + override 分支回填**

按 Interfaces 落地（先 auto 调用点等价替换，再 override 分支追加）。

- [ ] **Step 3: GREEN + 门禁**

Run: `pnpm vitest run packages/vviewer-core && pnpm run typecheck` → Expected: PASS（新用例全绿 + 既有用例零回归）。

- [ ] **Step 4: 提交**

```bash
git add packages/vviewer-core && git commit -m "fix(dispatcher): override 分支补 code 渲染器 det.lang shebang 回填——open-as extless 不再恒 hljsAuto（探测链抽公共 helper，auto 路径逐字节不变）"
```

---

### Task 2: 修 2——hasGrammar 清单门 + 结构化降级原因 + 状态栏注记 + 候选 grammar 前置

**前置阅读（触发词条款，开工前全文加载）：** `docs/design/frontend-conventions.md`（§3 i18n 纪律、§4 a11y 基线、§6 评审必查清单）、`docs/design/semantic-components.md`（状态栏段/提示通道登记核对）。

**Files:**
- Modify: `apps/web/src/lib/grammarLayers.ts`（`grammarTableHas` 纯判定导出）+ `apps/web/src/lib/grammarLayers.test.ts`（扩展）
- Modify: `apps/web/src/lib/highlightClient.ts`（导出 `hasGrammar(lang)`；withDebug 包装加 `hasLocalGrammar` 方法 + localFn 清单门）
- Modify: `packages/vviewer-render-text/src/code/client.ts`（`EngineNote` 类型 + `CodeFileMeta.engineNote?` + `CodeHighlightClient.hasLocalGrammar?`）
- Modify: `packages/vviewer-render-text/src/code/renderCode.ts`（全量 start() tree-sitter 分支与 lazy chunk 路径的就地原因计算 + getMeta 透出）
- Modify: `packages/vviewer-render-text/src/code/renderCodeWindowed.ts`（窗口 chunk 路径同款注记 + getMeta 透出，评审 F2 同面覆盖）
- Test: `packages/vviewer-render-text/test/code.test.ts`（note 两态 + 门跳过 worker 用例）+ `packages/vviewer-render-text/test/code-window-pump.test.ts`（窗口注记用例）
- Modify: `apps/web/src/lib/ViewerPane.svelte`（watchMeta 读 engineNote → 状态栏注记段）
- Modify: `apps/web/src/lib/MetaPanel.svelte`（langNames grammar 前置单次排序）+ `apps/web/src/lib/metaPanelLang.test.ts`（契约 ② 同步）
- Modify: `apps/web/src/lib/i18n/catalogs/{zh-CN,en}/viewer.ts`（2 新键）

**Interfaces:**
- `grammarLayers.ts`（纯 .ts，vitest 直测）：
  ```ts
  /** 清单感知判定：lang（canonical 或别名）在合并表内。table null（create 在途/rebuild
   * 清窗）→ true fail-open——不拦，交 worker 链既有裁决（Review Focus 2）。 */
  export function grammarTableHas(table: MergedGrammarTable | null, lang: string): boolean
  ```
- `highlightClient.ts`：`export function hasGrammar(lang: string): boolean`（读模块内 `grammarManifest` 快照委托 grammarTableHas）；withDebug 返回对象增 `hasLocalGrammar(lang) { return hasGrammar(lang); }`；**清单门落 localFn 闭包内**（routeHighlight 裁决先于门——远程可用不拦，spec §6 第 1 条）：
  ```ts
  const localFn = () => {
    if (!hasGrammar(lang)) {
      // 清单外：跳过注定失败的 worker 往返（worker manifest=同一合并表，ok:false 必然），
      // 折叠为普通本地失败 → resolveHighlightResult 抛普通 Error → renderCode 走 hljs 兜底
      return Promise.reject(new Error(`[vviewer] 语言 ${lang} 不在 grammar 清单，跳过本地 worker（清单感知门）`));
    }
    return client.highlight(text, lang, ctx?.chunk ? { chunk: ctx.chunk } : undefined).catch(…);
  };
  ```
  markdown 围栏高亮共用同一注入面——清单外围栏语言自动获益（跳过 doomed worker 调用），markdownRenderer 侧零改动。
- `render-text code/client.ts`：
  ```ts
  export type EngineNote = { kind: 'no-grammar-remote'; lang: string } | { kind: 'no-grammar-hljs'; lang: string };
  // CodeFileMeta 增可选字段：engineNote?: EngineNote
  // CodeHighlightClient 增可选方法：hasLocalGrammar?(lang: string): boolean
  ```
- **renderCode 就地原因计算（裁量落定：不走 onEngineNote 回调——hasLocal + computeWhere + 结果分支足以判定，契约面最小化）**：实例闭包增 `engineNote: EngineNote | null = null`；全量 start() tree-sitter 分支（:479-538）在 client 就绪后 `const hasLocal = client.hasLocalGrammar?.(lang) ?? true;`：
  - 成功（engine='tree-sitter'）且 `!hasLocal && computeWhere === 'remote'` → note `{ kind: 'no-grammar-remote', lang }`（本地无 grammar，已用远程）；
  - catch 非 cancel 非 RemoteComputeError 且 `!hasLocal` → note `{ kind: 'no-grammar-hljs', lang }` 后 `hljsWholeFile(lang)`（本地与远程均无 grammar；RemoteComputeError 显式远程失败仍走既有错误卡、无注记）；hasLocal=true 的 catch 语义逐字节不变；
  - **lazy chunk 路径 hasLocal 获取点（评审 F1 落定——router 分支 ：351-355 先于 client 等待 ：410-414 执行、作用域内无 client，原「请求前一次性取」不成立）**：①本地 worker 分支——client 等待（:410-414）之后、client.highlight 调用前取 `hasLocal = client.hasLocalGrammar?.(lang) ?? true`，chunk catch 且 `!hasLocal` → note no-grammar-hljs（置一次即可）；②远程 chunk 分支（getHighlightRouter :351-355，经注入 router 不经包装门、router 自有硬护栏零改动）——**注记为尽力而为**：router 命中成功点非阻塞读 `getHighlightClient()?.hasLocalGrammar?.(lang)`，仅 client 已 attach 时可判 `!hasLocal` → note no-grammar-remote；**记档窗口**：attach 竞态窗口内（getHighlightClient() 返回 null）远程 chunk 成功不注记——不为此提前等待 client（动既有竞态语义代价不成比例），窗口自愈于后续本地 chunk/重渲染，状态栏「执行: 远程」段已有位置指示兜底。
  - `getMeta()` 返回值增 `engineNote`（:573-580）。
- **窗口流式模式同面覆盖（评审 F2 落定——renderCodeWindowed.ts 有同构 chunk 选择链（:44-49 import、:485-500 router→等待 client→本地 worker→hljs）与独立 getMeta（:1236-1244），且同样消费 withDebug 包装 client（清单门对其生效），不补则清单外 >2MB 文件（手动或自动路径）降级仍无声，违 spec §6 第 3 条覆盖面）**：`renderCodeWindowed.ts` 同款三处——chunk 本地分支 client 等待后取 hasLocal + catch 注记 no-grammar-hljs、远程 chunk 命中点非阻塞读注记 no-grammar-remote（同上记档 attach 窗口）、`getMeta()`（:1236-1244）返回值增 `engineNote`；降级转投全量实例分支（`fullInst !== null`）直接透传全量实例的 engineNote，零改动。**记档：e2e 不加窗口专项锚**——spec §4 锚面无此项，窗口注记由单测（code-window-pump.test.ts 装置先例 :64-73：renderCode+ctx+getMeta 断言同款）承接，ENG-N1 全量路径已钉状态栏可见面。
- ViewerPane：watchMeta 读 `m.engineNote` → `engineNoteLabel = m.engineNote ? t(key, { lang }) : ''`（键映射 noteNoGrammarRemote/noteNoGrammarHljs）；状态栏在 computeWhere 段后追加 `{#if engineNoteLabel}&nbsp;·&nbsp;<span class="vv-status-engine-note" title={engineNoteLabel}>{engineNoteLabel}</span>{/if}`——**裁量落定：可见短文案 + 同文案 hover title，不做 toast**（降级非失败，spec 反目标边缘；无新交互元素，axe 域 b-a11y-axe 预期零翻转）。
- MetaPanel：grammar 前置单次排序（保持顶层 const 契约；**评审 F3 落定：引入中间名 `all`——在 `const langNames = [...grammarFirst, ...rest]` 前引用 `langNames` 是 TDZ 自引编译错，且 `const langNames = detectableLanguageNames();` 原行（MetaPanel.svelte:100）保留则重复声明，metaPanelLang.test.ts:46 契约②按原字面 `/const langNames = detectableLanguageNames\(\);/` 断言必红**）：
  ```ts
  const all = detectableLanguageNames();
  const grammarFirst: string[] = [], rest: string[] = [];
  all.forEach((n) => (hasGrammar(n) ? grammarFirst : rest).push(n));
  const langNames = [...grammarFirst, ...rest]; // 组内字典序不变
  ```
  （datalist 无富文本能力，**不做文字标注**——任何后缀都会污染提交值，裁量落定排序置前即终态；清单未就绪时退化为原字典序，无害）。`hasGrammar` 从 `./highlightClient` import（组件侧，无环）。metaPanelLang.test.ts 契约②同步：字面改 `/const all = detectableLanguageNames\(\);/`，防回归三断言（非 $derived/$state 包裹）保留。
- i18n（zh 定稿 → en 对译，占位符一致）：
  - `viewer.engine.noteNoGrammarRemote`：zh `语言 {lang} 本地无 grammar，已用远程 tree-sitter`；en `No local grammar for {lang}; used remote tree-sitter`
  - `viewer.engine.noteNoGrammarHljs`：zh `语言 {lang} 无 tree-sitter grammar（当前资源清单），已用 hljs 兜底`；en `No tree-sitter grammar for {lang} in current asset manifest; fell back to hljs`
- **验收锚**：grammarLayers.test.ts grammarTableHas（canonical/别名/null fail-open/空表 false）+ code.test.ts note 用例（两态/零回归/真失败不注记）+ code-window-pump.test.ts 窗口注记用例（评审 F2）+ metaPanelLang 契约②同步（评审 F3 字面）+ 聚合机检绿；所触 e2e 锚文件=`apps/web/e2e/b-code-engine-recovery.spec.ts`（ENG-N1/N2，Task 4 落）、`apps/web/e2e/b-override-lang.spec.ts`（LANG-01/02/04 回归，hasLocal=true 门不触发）、`apps/web/e2e/t-hl.spec.ts`（HL 域回归）。

- [ ] **Step 1: TDD grammarTableHas（RED→GREEN）**

grammarLayers.test.ts 扩展：canonical 命中 / 别名命中 / null true / 空表 false / 未知 false。Run: `pnpm vitest run apps/web/src/lib/grammarLayers` → RED→GREEN。

- [ ] **Step 2: TDD renderCode note 两态（RED）**

code.test.ts 新用例（attachHighlightClient fake 注入先例 :356-464）：①fake `{ highlight: reject(普通 Error), hasLocalGrammar: () => false }` + lang='haskell' → getMeta().engineNote == {kind:'no-grammar-hljs', lang:'haskell'} 且 engine 'hljs'；②fake `{ highlight: resolve(intervals) 且 onWhere('remote'), hasLocalGrammar: () => false }` + computeSrc → engineNote {kind:'no-grammar-remote'} 且 engine 'tree-sitter'；③fake 无 hasLocalGrammar（旧形态 fake）+ highlight reject → engineNote undefined 且既有 hljs 兜底行为逐字节不变（零回归锚）；④hasLocalGrammar true + reject → engineNote undefined（worker 真失败静默语义不变——只注记清单外，不注记运行期失败）；⑤窗口模式（code-window-pump.test.ts 装置先例 :64-73：renderCode(buffer, host, {ctx, …})+getMeta 断言同款）fake 同① → 窗口实例 getMeta().engineNote {kind:'no-grammar-hljs'}（评审 F2 窗口注记锚）。Run: `pnpm vitest run packages/vviewer-render-text` → Expected: FAIL。

- [ ] **Step 3: 实装 render-text 契约与 renderCode/renderCodeWindowed 门消费**

按 Interfaces 落 client.ts 类型、renderCode 就地计算与 getMeta 透出、renderCodeWindowed 同款三处（chunk 本地分支注记 / 远程命中非阻塞读 / getMeta 透出）。Run: Step 2 命令 → GREEN。

- [ ] **Step 4: app 侧注入面（hasGrammar + 包装门 + hasLocalGrammar）**

highlightClient.ts 按 Interfaces 落地（门在 localFn 内）。Run: `pnpm vitest run packages/vviewer-render-text`（fake 直连路径不受影响）+ `pnpm run typecheck`。

- [ ] **Step 5: 状态栏注记 + MetaPanel 排序 + i18n 双目录**

ViewerPane watchMeta + 状态栏段；MetaPanel 排序 + metaPanelLang.test.ts 契约 ② 扩展（排序形态源码契约：grammar 前置两组拼装）；i18n 双目录逐键落（zh 先定稿 → en 翻译；`{lang}` 占位符两侧一致）。Run: `pnpm vitest run apps/web/src/lib && pnpm run typecheck && pnpm lint` → 全绿（聚合机检含新键）。

- [ ] **Step 6: 提交**

```bash
git add apps/web/src/lib packages/vviewer-render-text && git commit -m "feat(code): 切语言清单感知引擎路由——hasGrammar 门跳过 doomed worker 调用+降级两态结构化注记（状态栏可见+title）+MetaPanel 候选 grammar 前置"
```

---

### Task 3: 修 3——client 毒化重建通道（recreate({force?}) 门控 + 显式动作触发面）

**Files:**
- Modify: `packages/vviewer-highlight/src/client.ts`（公开只读 `isInitFailed(): boolean`；initFailed 语义零改动）+ `packages/vviewer-highlight/test/client.test.ts`（扩展）
- Modify: `packages/vviewer-render-text/src/code/client.ts`（`detachHighlightClient()`：attachedClient=null + 相位回 pending——**区别于** attachHighlightClient(null) 的 failed 终态）
- Create: `apps/web/src/lib/highlightRecreate.ts`（neutral hook + 门控纯谓词，纯 .ts vitest 直测）+ `apps/web/src/lib/highlightRecreate.test.ts`
- Modify: `apps/web/src/lib/highlightClient.ts`（creationFailed 标志 + `recreateHighlightClient(opts?: { force?: boolean })` + hook 注册；`rebuildHighlightClient` 更名——调用面仅 AppShell :59/:803 一处）
- Modify: `apps/web/src/lib/AppShell.svelte`（:803 CDN 档位改 `recreateHighlightClient({ force: true })`）
- Modify: `apps/web/src/lib/tabsModel.svelte.ts`（setHighlightLang :505 / setRendererOverride :487 写入成功后 `requestHighlightRecreate()`——unchanged 早退之后，rev++ 同段）

**Interfaces:**
- `HighlightClient.isInitFailed(): boolean`（返回私有 initFailed；只读视图，无副作用——failWorker/dispose 语义零改动；dispose 后新建实例天然全新状态，即「destroy 清除」语义）。
- `detachHighlightClient(): void`（render-text）：`attachedClient = null; attachPhase = { phase: 'pending' };`（**不**放行 attachWaiters——等新 client attach 时统一放行；`__resetAttachPhaseForTest` 保留不动）。重建窗口语义：在途渲染的 waitForAttachedClient 等到新 client（≤10s 超时放行既有兜底）；create 失败经既有 catch → attachHighlightClient(null) → failed 相位放行 → hljs（Review Focus 3）。
- `highlightRecreate.ts`（纯 .ts，无任何 import）：
  ```ts
  export type RecreateFn = (opts?: { force?: boolean }) => void;
  export function registerRecreateHighlightClient(fn: RecreateFn): void; // highlightClient.ts 模块加载时注册
  export function requestHighlightRecreate(): void; // 显式动作面（非 force）：impl?.() 无注册 no-op
  /** failed-态门控谓词（纯函数）：force 无条件真；否则 creationFailed（创建期失败，attach null 终态）/
   *  clientInitFailed（实例 failWorker 毒化，isInitFailed()）/ grammarTableEmpty（worker 健康、
   *  三层 manifest 全失败——layers.length===0 的不 reject 形态，spec §6 第 2 条）任一为真。 */
  export function shouldRecreateHighlightClient(state: {
    force?: boolean; creationFailed: boolean; clientInitFailed: boolean; grammarTableEmpty: boolean;
  }): boolean;
  ```
- `highlightClient.ts`：
  - 模块标志 `creationFailed = false`（ensureHighlightClient catch 置 true；成功落定置 false——现有 catch :122-138 内加一行）；
  - `recreateHighlightClient(opts?: { force?: boolean }): void`——**非 force 先过门**：`if (!shouldRecreateHighlightClient({ force, creationFailed, clientInitFailed: currentClient?.isInitFailed() ?? false, grammarTableEmpty: grammarManifest !== null && Object.keys(grammarManifest).length === 0 })) return;`（健康 client + 显式动作 = no-op，门即限流器——单飞闸沿用代际计数既有竞态防线，Review Focus 3）；过门后执行**现 rebuildHighlightClient 全部主体**（generation++ → remoteAbort 中止 → prevPromise 消费 → dispose 旧实例 → 清 flags）**加一步前置 `detachHighlightClient()`**（dispose 之前，相位回 pending）；**force 直接过门**（CDN 档位变更 manifest 快照语义，spec §6 第 2 条）；`grammarManifest = null` 清空后 grammarTableEmpty 判定自然失效于下一代际；
  - `rebuildHighlightClient` 更名为 `recreateHighlightClient`（AppShell :59/:803 同步 `{ force: true }`；仓库内无其它引用——rg 实查 2 文件）；模块尾 `registerRecreateHighlightClient(recreateHighlightClient)`；
  - **hook 反转记档（裁量）**：tabsModel 不直 import highlightClient——导入环 tabsModel→highlightClient:26→openFlow.svelte:42→tabsModel 实查成立，neutral hook 是唯一无环单点接线（5 个显式动作调用点收口为 store 内 2 处）。
- **兼容红线**：worker.ts 零改动；client.ts 除只读访问器外零改动（init-ok ack/init-progress/看门狗路径不动）；BUG-34/35/37 既有锚（client.test.ts:142/:180/:353 describe、t-hl.spec.ts:584）不翻转。
- **单测覆盖面记档（评审 F4 落定——spec §4 单测锚「client destroy/recreate 代际（failWorker 后显式动作重建成功，单飞/代际用例）」无 highlightClient 直测兑现，属知情策略延续而非缺漏）**：highlightClient.ts 依赖 `$app/env`/`$app/paths`/`openFlow.svelte`（runes 模块）不可 vitest 直测（根 vitest 无 svelte 插件）；既有 rebuildHighlightClient 同样零单测、由 b-cdn-profiles e2e 承接（策略先例）。故重建成功/单飞（门即限流器——健康态显式动作 no-op）/代际防旧实例回魂的行为面由三层拼合覆盖：e2e ENG-R1/R2/R3（Task 4）钉端到端行为 + highlightRecreate.test.ts 钉门控判定面（纯函数）+ client.test.ts 钉 isInitFailed 状态面；全量 review 按 spec §4 字面核时以本记档为口径，不按缺漏开 M。
- **验收锚**：client.test.ts（isInitFailed 初始 false / failWorker 后 true / dispose 不复活已终态实例）+ highlightRecreate.test.ts（谓词四态 + hook 注册/请求/no-op）+ 既有 client.test.ts 全绿；所触 e2e 锚文件=`apps/web/e2e/b-code-engine-recovery.spec.ts`（ENG-R1/R2/R3，Task 4 落）、`apps/web/e2e/t-hl.spec.ts`（BUG-35 红线）。

- [ ] **Step 1: TDD client.test.ts isInitFailed（RED→GREEN）**

三用例（沿 :60 describe 装置）：初始 false；failWorker（onerror 帧）后 true；dispose 后仍 true（终态不复活）。Run: `pnpm vitest run packages/vviewer-highlight` → RED（方法不存在）→ 实装访问器 → GREEN。

- [ ] **Step 2: TDD highlightRecreate.test.ts（RED→GREEN）**

谓词：force true 恒真；全 false 假；三 failed 态逐一真；组合真。hook：注册后请求透传 opts；未注册 no-op 不抛；重复注册后签者生效。Run: `pnpm vitest run apps/web/src/lib/highlightRecreate` → RED→GREEN（先建测试文件再跑，vitest 无匹配路径退出码 1）。

- [ ] **Step 3: 实装 detach + recreate 门控 + 触发面接线**

render-text detachHighlightClient；highlightClient 更名/标志/门/hook 注册（Interfaces 全量）；AppShell :803 改 force 形态；tabsModel 两方法接线（写入成功段尾）。Run: `pnpm vitest run packages/vviewer-highlight packages/vviewer-render-text apps/web/src/lib && pnpm run typecheck && pnpm lint` → 全绿。

- [ ] **Step 4: 提交**

```bash
git add packages/vviewer-highlight packages/vviewer-render-text apps/web/src/lib && git commit -m "feat(highlight): client 毒化门控重建——recreate({force?}) failed-态判定（含清单全空）+detach pending 防竞态+切渲染器/切语言显式动作触发面（neutral hook 避导入环）"
```

---

### Task 4: e2e 锚批 b-code-engine-recovery（①③④⑤ + 回归定向）

**Files:**
- Create: `apps/web/e2e/b-code-engine-recovery.spec.ts`（ENG- 域）

**验收锚 / e2e**：本任务即 e2e 锚批——`pnpm --filter web build:e2e` 后本域全绿 + 定向回归（b-override-lang / t-hl）零翻转。spec §4 ②（overrideLang 清单内语言 → tree-sitter）由既有 LANG-01 承接，本批不重写。

- [ ] **Step 1: OWX-E1——extless shebang 文件 open-as code → ts-\*（spec §4 ①，RED 现状=hljs）**

装置：`__vvOpenDirImpl` 注入无扩展名文件，内容 = `#!/usr/bin/env python\n` + 含 NUL 的正文（NUL 判非文本 → looksTextual false → 自动落 hex，magic.ts:55 NUL 即二进制口径、looksTextual :49）→ 打开 tab（hex 视图）→ MetaPanel `.meta-openwith` selectOption('code')（override 重派）→ `expect.poll` `.vv-code-pre span[class^="ts-"]` count > 0（修 1 回填 python → tree-sitter；现状 RED=ts-* 恒 0 走 hljsAuto）。断言不写 overrideRenderer（open-as 临时查看语义，b-error-card-open-as 先例）。

- [ ] **Step 2: ENG-N1/N2——清单外降级原因可见 / 清单内无注记**

ENG-N1：注入 .txt（rust 样例内容）→ setLang（fill+blur，b-override-lang 同款）'haskell'（languages.json:934 可候选、lite manifest 34 语言不含——rg 实查）→ `expect.poll` 状态栏 `.vv-status-engine-note` 可见且 toContainText('haskell')，引擎段为 hljs 兜底（ts-* 恒 0）；**断言不进错误卡**（`.vv-error-card` count 0——降级非失败）。ENG-N2：同装置 setLang 'rust' → ts-* > 0 且 `.vv-status-engine-note` count 0（清单内无注记）。

- [ ] **Step 3: ENG-R1/R2——worker 毒化 → 显式切语言恢复 tree-sitter（spec §4 ④⑤）**

装置：`page.route('**/ts-worker*', …)` 先 goto 前安装，首个 worker 请求 abort（onerror → failWorker 毒化，秒级不候 15s 看门狗）、确认毒化后 `page.unroute`——worker 构建产物实为 `_app/immutable/workers/ts-worker-<hash>.js`（vite worker 产物，glob `**/ts-worker*` 匹配成立；vite.config.ts:237 纯哈希备案仅限 client chunks，不波及 worker 产物）。ENG-R1：毒化页开 .py 文件 → ts-* 恒 0（hljs 兜底；worker 不可用全链降级现状）；同 tab 开 .txt（rust 内容）→ setLang 'rust' → 门控重建（clientInitFailed=true）→ ts-* > 0（恢复 tree-sitter；route 已解除，新 worker 正常加载）。ENG-R2：续 ENG-R1 页面再开第二个 .py 文件 → ts-* > 0（毒化不再全会话永久——重建后新实例服务新 tab）。

- [ ] **Step 4: ENG-R3——worker 健康、清单全空 → 显式动作仍可恢复（spec §6 第 2 条）**

新页：`page.route('**/grammars/manifest.json', …)` goto 前安装，首个 abort（same-origin 层失败；CDN 层 e2e 恒失败为既有噪音）→ 三层全失败 → grammarManifest={} 不 reject → 开 .py 文件 → 清单门生效：ts-* 恒 0 + `.vv-status-engine-note` 可见（清单外自动路径注记——spec §6 第 3 条的 e2e 面之一）→ unroute → setLang 'rust' → 门控重建（grammarTableEmpty=true）→ manifest 重取 → ts-* > 0 且注记消失。

- [ ] **Step 5: 定向回归 + 提交**

Run: `pnpm --filter web build:e2e && pnpm --filter web exec playwright test b-code-engine-recovery b-override-lang t-hl` → 全绿（LANG-01~06 / HL-10 系 / BUG-35 零翻转）。
```bash
git add apps/web/e2e && git commit -m "test(e2e): 代码引擎修复批 ENG 域锚——open-as shebang 回填/清单外降级注记/毒化重建恢复/清单全空态"
```

---

### Task 5: 全量门禁与收尾（控制器执行）

- [ ] `node tools/fetch-e2e-corpus.mjs`（语料）→ `pnpm lint && pnpm run typecheck && pnpm vitest run`（仓库根全量）→ `pnpm --filter web build:e2e` → playwright 全量双 project（`pnpm --filter web exec playwright test`；对比基线：新增 b-code-engine-recovery ENG 域外零回归）→ `pnpm --filter web exec playwright test --config playwright.server.config.ts`（server 档零翻转）→ `git status --porcelain` 净空。
- [ ] 全量 review（superpowers:requesting-code-review，范围=本计划全部 commit），修复全部 C/I/M 后复审；**不 push**。
- [ ] 台账汇总（实施期记档项随任务报告归集；本计划规划期无 deferred 项——spec §5 五项裁量与 §6 三条落定已全部内联落定于上文 Interfaces/Global Constraints；计划内显式记档的知情裁量三处：远程 chunk 注记 attach 窗口缺失（评审 F1，Task 2 Interfaces）、窗口模式 e2e 不加专项锚——单测承接（评审 F2，Task 2 Interfaces）、重建成功/单飞/代际无 highlightClient 直测——e2e+谓词拼合（评审 F4，Task 3 Interfaces））。

## Errata（执行期勘误）

- 2026-11-14 初版（规划师 E 基于 HEAD 0baaf92 编写；规划期关键实查已内联：override 分支 dispatcher.ts:496-501 / 唯一 det.lang 写点 :345-355 / 路由折叠 router.ts:103-124 / 合并表快照 highlightClient.ts:66,347 / lite manifest 34 语言无 haskell / 重建调用面仅 AppShell:803 / 导入环 openFlow.svelte.ts:42）。
- 2026-11-14 计划评审修订（5 条意见，全部实查复现后内联落定）：①F1 chunk 路径 hasLocal 获取点明写——router 分支 renderCode.ts:351-355 先于 client 等待 :410-414、作用域内无 client，原「chunk 请求前一次性取」自相矛盾；落定=本地分支取点在 client 等待后、远程分支命中点非阻塞读 + attach 窗口不注记记档；②F2 窗口流式模式覆盖面补齐——renderCodeWindowed.ts 同构 chunk 链（:44-49/:485-500）与独立 getMeta（:1236-1244）纳入 Task 2 Files/Steps + code-window-pump.test.ts 窗口注记用例（装置先例 :64-73）；e2e 不加窗口专项锚记档（spec §4 锚面无此项）；③F3 MetaPanel 排序伪代码 TDZ 自引 + 与 metaPanelLang.test.ts:46 契约②字面断言 `/const langNames = detectableLanguageNames\(\);/` 的重复声明冲突——改中间名 `all`，契约②字面同步 `/const all = …/`；④F4 spec §4 重建单飞/代际单测锚无 highlightClient 直测兑现——记档知情策略延续（$app/openFlow 依赖不可 vitest 直测、b-cdn-profiles 先例），e2e ENG-R1/R2/R3 + 谓词/状态面单测三层拼合，review 口径以记档为准；⑤F5 行号锚订正——NUL 判定 magic.ts:32→:55（looksTextual 函数 :49 起，:32 为 ico 签名行）、setRendererOverride :490→:487；worker 构建产物形态补记 `_app/immutable/workers/ts-worker-<hash>.js`（route glob `**/ts-worker*` 匹配成立）。
