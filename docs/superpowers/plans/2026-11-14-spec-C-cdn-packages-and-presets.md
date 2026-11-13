# CDN 体系（grammar 拆包 + CDN 档位设置 + 预设网络字体）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 恢复 grammar CDN 默认全球档可用（jsdelivr 150MB 准入 403 → 50MB 子包拆分）；三作用面（grammars/engines/foreign）运行时 CDN 档位切换（全球默认 / unpkg / npmmirror-cn / 自定义）；预设开源网络字体一键添加（single 单文件 + css 切片两型）。

**Architecture:** pack-npm 拆分模式（体积均衡装箱，每包 ≤50MB）→ release/pages 双链路多基注入（`|` 分隔，单值兼容）→ settings.cdn 节驱动三处运行时消费（highlightClient 重建 / cdnEngines host 参数化 / foreignAssets base 参数化）→ SW 缓存按路径型规则天然跨域（grammars），custom 域起步语义=在线直取；字体预设走 fontsStore 双通道（single 入库离线 / css 节点插拔在线）。

**Tech Stack:** Svelte 5 runes（全局强制）、vitest（仓库根 jsdom）、Playwright 双 project、node.mjs 工具链（grammar-builder）、GitHub Actions（OIDC trusted publishing）。

**Spec:** `docs/superpowers/specs/2026-11-12-cdn-packages-and-presets-design.md`（本计划从 spec 论证；实现者两份都读——spec §3 拍板项与 §7 builder check 订正节同样有效）

## 基线与实施顺序

- **基线**：当前 HEAD `75cc652`（main；= 规划 commit `827693f` + 本计划 docs commit，无代码差异）。spec C 此前零落地；本计划全部工作基于该 HEAD 展开。
- **实施顺序**：Task 1 → Task 2 → Task 3 → Task 4 → Task 5 → Task 6，**严格串行**。理由：T2 发布链依赖 T1 的拆分模式与聚合 hash 口径；T3 运行时消费依赖 T1/T2 定型的包数约定（`VV_GRAMMAR_PACK_COUNT`）与多基格式；T4 触同一 i18n 目录与设置中心（与 T3 串行保原子性）；T5 e2e 锚批依赖 T3/T4 的运行时行为全部就位；T6 收尾。
- **grammar 构建链（spec F）条件核查**：本计划触及 grammar-builder 的**打包面**（pack-npm.mjs），不触及 `build.mjs` wasm 编译链与 gen-sources——pack 单测走 fixture（`tools/grammar-builder/test/pack-npm.test.ts` 的假 wasm 字节先例，pack-npm.test.ts:24-49），release 消费 grammar.yml 既产 artifact，**无需 gen-sources 与 build.mjs --fetch 先行步骤**（无 cargo 生成物依赖）。
- **仓外前置（用户操作，首发硬门，非本计划实施面）**：npm 包页逐包配置 Trusted Publisher（owner=bhxch/repo=vviewer/workflow=release.yml，勾选 npm publish）——`@bhxch/vviewer-grammars-full-p1..pN` 逐包配置，N 随 Task 1 装箱结果定稿后补齐（spec §7；OIDC 首发 absence 即 E403/E404）。

## Global Constraints

- **拍板项不得偏离**：包名 `@bhxch/vviewer-grammars-full-p1..pN`；每包解包体积门禁 **50MB**；engines/foreign 两档 `default|custom`、grammars 四档 `default|unpkg|cn|custom`；cn 档仅 grammars（npmmirror 白名单申请中，落地前不可用）；css 型字体**不做离线**（切片不入库不进 SW 缓存，断网回退缺省；UI 标注「在线字体」）；反目标——不做 CDN 健康探测自动选路、不为 kroki/plantuml/open-vsx 提供档位、grammars 不做版本范围浮动（钉死纪律维持，foreignAssets.ts:15-16 先例）。
- **多基格式**：`VV_GRAMMAR_CDN` 值改为 `|` 分隔多基（每基以 `/grammars/` 结尾）；**解析器必须兼容无分隔符单值**——build:e2e/ci.yml/GRF/t-hl/ICON 等大量既有 spec 依赖单基注入 `https://cdn.grammars.test/grammars/`（apps/web/package.json:9、ci.yml:168），单值=单层，零回归。
- **布局契约红线**：`manifest.json 与 *.wasm 同目录`、`/grammars/` 结尾 env 约定、contentHash 归一化（sha256 前 16 hex 剔 generatedAt，pack-npm.mjs:81-100）不破坏。
- **runes 纪律**：`.svelte`/`.svelte.ts` 一律 runes 写法；vitest 直测纯逻辑用 `.ts`（根 vitest 无 svelte 插件，导入含 `$state` 的 `.svelte.ts` 即 ReferenceError）。
- **i18n 纪律**：新文案键落 `catalogs/{zh-CN,en}/settings.ts`（域=settings），key 三段 `{域}.{模块}.{语义}`；en 键集==zh 键集由聚合机检硬断言（`catalogs.aggregate.test.ts`）；zh 值逐字节等价职责不适用本计划（全是新增键，无既有字面量迁移）；非翻译数据值（预置字体 displayName 含 CJK）以 `\u` 转义形态保留（fonts.ts family 名先例，D8）。
- **门禁口径**：vitest 一律在**仓库根**跑（包目录直跑缺 jsdom）；typecheck 仓库根 `pnpm run typecheck`；重建 web 一律 `pnpm --filter web build:e2e`（裸 build 冲掉 CDN 注入致 GRF 域假红）。
- **commit 纪律**：Conventional Commits（feat/fix/test/ci/docs… 中文主题）、原子化；`git status --porcelain` 自查净空再 add（不按记忆清单）；**一律不得 git push**。
- **UI 文案/交互组件/a11y 任务前置阅读**（Task 3/4 开工前全文加载，不凭记忆转述）：`docs/design/frontend-conventions.md`（§3 i18n 纪律 + §4 a11y 基线 + §6 评审必查 B3/B4/B5）、`docs/design/semantic-components.md`（§4 反馈三通道——预设字体错误行复用既有 `role="status"` 通道、删除确认走表 2 已登记的 `window.confirm` 轻确认成员形态；**本计划无新浮层**——CDN 节与预设字体区都在 `.vv-settings-center` 面板内，不触发 OVERLAY 入册）。

## Review Focus

1. **单基兼容回归面**（最大风险）：多基解析器/运行时消费改造若破坏单基注入契约，GRF-01~08、t-hl HL-02、ICON-07、b-grammar-layers 两用例与 b-md-corpus-markpad GRF-05 全线假红——每任务收尾跑 grammar 域定向 e2e。
2. **档位变更重建竞态**：highlightClient 单例 create() 在途时切档——重建入口必须处理 clientPromise 未决态（引用 HL-09 前科：CDN 构建秒级创建窗口，排队 cancel 误杀合法请求，highlightClient.ts:111-125）。dispose+create 需代际计数防旧 promise 落袋覆盖新 client。
3. **queries 全局同源契约**：应用侧 worker 恒从同源 `queriesBase` 取查询（见 Task 1 builder check 结论）——拆包装箱误把某语言 queries 放错子包不影响应用（应用不取 CDN queries），但破坏 standalone 包消费契约（deriveQueriesBase per-子包），装箱单测必须锁 queries 跟随。
4. **DiagramRenderOptions 透传断点**：cdnEnginesHost 有两个调用面（pipeline.ts:537 markdown 围栏、diagramFile.ts render-text 图表文件）——漏一个即该面 custom 档静默失效。
5. **css 型字体与 SW/离线边界**：css 切片不入库不进缓存是落定项——实现误走 FontFace 入库通道会悄悄破坏「断网回退缺省」语义与 30MB/https 门禁适用面。
6. **SC-01 有意翻转**：设置中心 12 组 → 13 组，翻转面在计划内明示列举（D20 口径），en 目录同步，聚合机检必须绿。

---

### Task 1: pack-npm 拆分模式——50MB 体积均衡装箱 + 单测

**Files:**
- Modify: `tools/grammar-builder/pack-npm.mjs`（新增拆分模式；单包模式缺省保留、行为逐字节不变）
- Modify: `tools/grammar-builder/GRAMMARS-NPM-README.md`（子包布局与 CDN 引用注记——README 参与内容哈希，pack-npm.mjs:160）
- Test: `tools/grammar-builder/test/pack-npm.test.ts`（拆分用例扩展）

**Interfaces:**
- Produces: `packNpmSplit({ grammarsDir, queriesDir, outDir, name, version, packLimitBytes, ... })` → `Array<{ outDir, name, contentHash, bytes, langs }>`（**outDir 参数名对齐既有 `packNpm` 的 outDir**——语义为拆分产物根，子包落 `outDir/p<i>/`）；包名 `${name}-p${i}`（i 从 1）；每包布局与单包契约同构（`grammars/manifest.json` 仅本包语言条目 + 本包 wasm + `queries/<lang>/` 仅本包语言目录 + GRAMMAR_LICENSES.md + README.md）。
- 门禁（**两段语义，拍板落定**）：
  1. **单件前提**：单语言载荷（该语言 wasm + 其 queries 目录字节）> packLimitBytes 时**整体抛错**（fail-fast，不产任何包——独占成包放行即破 50MB 门禁本意：门禁保护的是镜像站低准入线，60MB 独占包照样超限）。现实数据远离该线：全量集最大单 wasm 为 python.wasm 4.5MB（spec §1.1），抛错不误伤；未来单 wasm 超限应显式失败立项而非静默放行。
  2. **装箱门禁**：单件前提通过后，每包**解包总字节**（wasm+queries+manifest+license+README）≤ packLimitBytes（生产缺省 `50 * 1024 * 1024`；env `VV_NPM_SPLIT_LIMIT_MB` 可覆写供测试注入小阈值）。
- **验收锚 / e2e**：验收=`pnpm vitest run tools/grammar-builder`（拆分新用例 + 单包回归）；不触 e2e 锚文件（工具层，间接护 GRF/t-hl/ICON 既有契约——单包模式零变化）。

**builder check 落定（spec §3.1 worker 端 queries 路径核实点，本次规划已核实）**：
- worker 查询走**全局同源 queriesBase**：`core-parse.ts:159`（`remoteQueryLoader(opts.queriesBase, …)`）、`highlightClient.ts:279`（`queriesBase: ${baseUrl}queries/`）；wasm 走 **per-entry base**：`core-parse.ts:393`（`Language.load(joinPath(entry.base ?? this.grammarsBase, entry.file))`）；`b-grammar-layers.spec.ts:20` 注释明载「CDN 层只供 wasm，queriesBase 恒同源——分层链契约」。
- **结论**：**应用侧零改动**（无需按语言条目 base 解析 queries——worker 查询恒从同源 `queriesBase` fetch，highlightClient.ts:279）；但 **standalone 多基合并消费面存在缺口**：queries fetch 用引擎级闭包 base，不走 entry.base——`core-parse.ts:159`（`remoteQueryLoader(opts.queriesBase, …)`）与 `:449-470`（内部 `dir = joinPath(base, lang)`）；wasm 才走 per-entry base（`:393`）。`highlightDefault.ts:120-126` 传 `queriesBase: deriveQueriesBase(base)` 单值——多基合并后非首子包语言从错误子包取 queries → 404 → highlights.scm 缺失 → 查询加载失败。`deriveQueriesBase` 的 per-子包替换语义只对**单包独立消费**成立。该缺口的改造项在 Task 2 Step 3（highlight 包 queriesBaseResolver；应用侧仍零改动）。
- 装箱规则：语言条目（含其 `queries/<lang>/` 全部 .scm）必须与其 wasm 落**同一子包**。

- [ ] **Step 1: TDD 先写拆分单测（RED）**

fixture 扩展（假 wasm 字节可任意放大，pack-npm.test.ts:25 fixture() 先例）：多语言 + 大小悬殊的 wasm，`VV_NPM_SPLIT_LIMIT_MB=40` 注入小阈值，断言：
1. **单件超限抛错**：`{60,30,0.1}` @40MB → `packNpmSplit` reject（60MB 单语言 > 阈值，不产任何包——门禁第 1 段语义）；
2. **装箱均衡**：`{35,30,0.1}` @40MB → 2 包（35 独占 + 30+0.1 同包），且**每包总字节 ≤ 阈值**（门禁第 2 段语义——全部包逐一断言，无例外）；
3. 每包 manifest 键集 == 包内 wasm 文件集（dangling 断言，单包先例 pack-npm.mjs:125-126 同源）；
4. queries `<lang>/` 跟随语言所在子包（跨包无该语言目录）；
5. 聚合 hash 稳定：同输入两次运行全包 contentHash 序列逐字节相等；单语言内容变化仅影响其所在包 hash；
6. 包名 `p1..pN` 连续、版本同 tag；
7. 单包模式（不传 split 参数）回归不变（既有用例全绿即回归锚）。

Run: `pnpm vitest run tools/grammar-builder`（仓库根）→ Expected: FAIL（拆分模式不存在）。

- [ ] **Step 2: 实装 packNpmSplit**

装箱算法（裁量落定）：**first-fit-decreasing 体积均衡**——按 manifest 条目 wasm 字节降序逐语言放入首个能容纳的子包（queries 目录字节计入该语言载荷），放不下开新包；**单语言载荷 > packLimitBytes 即整体抛错**（门禁第 1 段，装箱前逐语言预检）；包数 N 最小化由 FFD 近似达成（不追求最优装箱 NP 完全解）。子包 manifest 顶层元数据（note/source/generatedAt）与单包同源同值，`grammars` 键仅本包条目、`base: './'` 注入同款（pack-npm.mjs:145-148）。outDir fail-fast 语义沿单包（H8，对根目录按「含 p* 子目录即拒跑」同口径）。每包独立跑既有 `packNpm` 尾段（packNpmSplit 复用 packNpm 的布局组装/哈希逻辑，抽公共函数不复制实现）。

- [ ] **Step 3: GREEN + 门禁**

Run: `pnpm vitest run tools/grammar-builder && pnpm run typecheck`
Expected: PASS（新用例全绿 + 既有单包用例零回归）。

- [ ] **Step 4: 提交**

```bash
git add tools/grammar-builder && git commit -m "feat(grammar-builder): pack-npm 拆分模式——first-fit-decreasing 体积均衡装箱（50MB 包门禁）+ queries 跟随子包单测"
```

---

### Task 2: release N 包发布 + web/pages 多基注入 + highlightDefault 拆包缺省

**Files:**
- Modify: `.github/workflows/release.yml`（publish-npm：N 子包 + 全量包双发布面；聚合 hash 单门；包数一致性 fail-fast；outputs 增 `packages`）
- Modify: `.github/workflows/pages-deploy.yml`（CDN env 多基拼接 + 探测上限告警，:93-98 单包形态改多基）
- Modify: `packages/vviewer-markdown/src/highlightDefault.ts`（DEFAULT_GRAMMARS_BASE_URL 多基缺省 + createEngine 多 manifest 合并 + queries 路由）
- Modify: `packages/vviewer-highlight/src/core-parse.ts`（queriesBaseResolver 可选入参 + remoteQueryLoader base 解析函数形态）+ `packages/vviewer-highlight/src/worker.ts`（options 类型）
- Test: Create `packages/vviewer-markdown/src/highlightDefault.test.ts`（**markdown 包 src/ 现无任何 *.test.ts——`ls packages/vviewer-markdown/src/*.test.ts` 零匹配实查，「既有单测」不存在**）+ highlight 包 core-parse 既有测试面扩展（如有）或新增

**Interfaces:**
- release outputs：`version`（N 包同 tag 同版本，语义不变）+ `packages`（JSON 数组 `["<scope>/vviewer-grammars-full-p1", … "-pN"]`，web job 直接消费）。
- 聚合 hash 口径（spec §3.1 裁量落定：全部子包 hash 聚合单门）：`sha256(逐包 contentHash 按包名字典序拼接换行)前 16 hex`，与全量包 contentHash 并列作为 SKIP_PUBLISH 判据——任一子包内容变化即整包集重发（版本对齐简单化，N 包同版本号）。
- `highlightDefault.ts`：`DEFAULT_GRAMMARS_BASE_URL` 改为**多基**（jsdelivr 子包 URL，`|` 分隔；版本钉死纪律维持——实施期以显式 TODO 注释占位，首发 tag 定稿后校准，闭环归 Task 6 台账④）；`createEngine` 支持多 manifest 逐层 fetch + first-wins 合并（`grammarLayers.ts:29-38` mergeGrammarLayers 同语义移植——highlightDefault **不依赖应用侧代码**（`highlightDefault.ts:15` 实 import `@bhxch/vviewer-highlight`，包内既有依赖），合并逻辑就地实现不引新依赖）；每条目 base 为其所在子包 base。
- queries 多基路由（缺口改造，Task 1 builder check 结论承接）：highlight 包 `TreeSitterEngine.create` 增可选 `queriesBaseResolver?: (lang: string, entry: { file: string; base?: string }) => string`；`remoteQueryLoader` 的 base 入参扩 `string | ((lang: string) => string)` 形态（内部 `joinPath` 处分支解析，:449-457，per-lang 缓存键下互不冲突）；**缺省 undefined 时单值 queriesBase 语义逐字节不变**（应用侧不传 resolver，零行为变化）；highlightDefault 多基时传 resolver（按条目所在子包 base 派生 `deriveQueriesBase`）。
- **验收锚 / e2e**：验收=highlightDefault 新建单测（多基合并/跳层/单基兼容/**非首子包语言 queries 落正确子包**）+ highlight 包既有单测零回归 + `pnpm run typecheck`；不直接触 e2e 锚文件（CI workflow 面无单测基建——release.yml 不属 vitest 面，「release dry 逻辑单测（若有）」的 spec 门如实落定为：聚合 hash 口径由 Task 1 的 pack 单测锚（装箱与 contentHash 稳定性）+ 本任务 CI 步骤语义走读承接；e2e 回归面=GRF 域构建注入契约不变）。

- [ ] **Step 1: release.yml publish-npm 多包化**

逐包打包步（`for i in $(seq 1 $N)`；N 由 Task 1 产物定稿——本任务开工时以 `VV_NPM_PACKAGE_COUNT` env 形态写入 workflow，值与 Task 1 装箱结果一致）；逐包 `pack-npm.mjs` 拆分模式（`VV_NPM_PACKAGE_NAME=<scope>/vviewer-grammars-full` + `VV_NPM_SPLIT=1`）产 `dist-npm/p<i>/`；全量包照旧产 `dist-npm/`（存量 0.1.0 用户/standalone 兼容，spec §3.1）。**包数一致性 fail-fast**（防后续重装箱时 workflow N 与实际包数漂移致发布缺包/漏包）：publish 前断言 `dist-npm` 下 `p*` 包实际计数 == `VV_NPM_PACKAGE_COUNT`，不等即 fail。gate 步改聚合 hash 单门（上述口径；SKIP_PUBLISH 三分支语义保留：内容零变化复用线上 latest / 同版本已存在 tag 重跑幂等 / 否则发布）。publish 步逐包 `npm publish ./dist-npm/p<i> --access public --provenance`（OIDC 形态不变）+ 全量包同款。

- [ ] **Step 2: web job 与 pages-deploy 多基注入**

release.yml:72-78 CDN calc 改多基：读 `needs['publish-npm'].outputs.packages` 拼管道分隔 URL（`https://cdn.jsdelivr.net/npm/${pkg}@${VERSION}/grammars/|…`）；scope 未配置门控语义不变（空=第 3 层整体缺席）。pages-deploy.yml:93-98 改多基（pages 独立 checkout 无 outputs——逐包 `npm view <scope>/vviewer-grammars-full-p<i> version` 探测，i 自 1 递增至首个 404，**上限 8**防漂移死循环；**p8 仍 200 即显式 warn「包数超探测上限，pages 注入面不完整」**——预计 5-6 包留余量但超限不得静默缺席；全 404 时 warn 缺席语义保留）。

- [ ] **Step 3: highlightDefault 多基缺省 + queries 路由**

`DEFAULT_GRAMMARS_BASE_URL` 改子包多基。**首发版本闭环（实施时点不可实查——npm 实查 `versions = ['0.0.0-stage','0.1.0','0.1.1']`、latest=`0.1.1`（本计划修订会话 curl 实证）；子包 p1..pN 未发布、首发 tag 未定，且全量包 0.1.1 已占版——首发 tag 必然 >0.1.1）**：实施期版本段以**显式 TODO 注释占位**（注释明载「首发 tag 定稿后同步校准——缺省 URL 版本段与首发版本错位即全子包 404，校准项归 Task 6 台账④」），不在实施期臆造版本号。`createEngine` 多基逐层 fetch（SPA-fallback 嗅探沿用 highlightDefault.ts:105-111 同款）+ first-wins 合并；单基 URL（无 `|`）行为不变（直入单层）。`normalizeGrammarsBase` 的 `/grammars/` 结尾契约逐基校验（highlightDefault.ts:57-63）。**queries 多基路由**：多基形态下 `TreeSitterEngine.create` 传 `queriesBaseResolver`（按语言条目所在子包 base 派生 `deriveQueriesBase`，Task 1 builder check 缺口结论承接）——非首子包语言的 queries 从其所在子包取，不再落错误 base 404。

- [ ] **Step 4: 单测 + 门禁（先建测试文件再跑）**

markdown 包 highlightDefault 单测（**新建文件——vitest 对无匹配路径报 No test files found 退出码 1，必须先建 `highlightDefault.test.ts` 再跑门禁**）：多基两子包 manifest 合并（A 语言落 p1 base / B 语言落 p2 base）、某层 403 跳层、单基兼容、**非首子包语言 queries 落正确子包**（mock 双子包 queries 伺服逐语言校验 fetch URL）；highlight 包 core-parse resolver 分支单测（缺省 undefined 零变化 + resolver 传参生效）。Run: `pnpm vitest run packages/vviewer-markdown packages/vviewer-highlight && pnpm run typecheck`（仓库根）。

- [ ] **Step 5: 提交**

```bash
git add .github/workflows packages/vviewer-highlight packages/vviewer-markdown && git status --porcelain 自查后 commit -m "ci(release): grammar 子包 N 包发布与多基 CDN 注入（聚合 hash 单门+包数 fail-fast）+ highlightDefault 拆包多基缺省+queries 子包路由"
```

---

### Task 3: settings.cdn 档位 + 三处运行时消费改造 + 设置 UI「网络资源」组 + i18n

**前置阅读（触发词条款，开工前全文加载）：** `docs/design/frontend-conventions.md`（§3 i18n 纪律、§4 a11y 基线、§6 B3/B4/B5）、`docs/design/semantic-components.md`（§4 反馈通道——本节错误/提示复用既有 `role="status"` 行形态）。

**Files:**
- Create: `apps/web/src/lib/cdnProfiles.ts`（纯 .ts，vitest 直测）+ `apps/web/src/lib/cdnProfiles.test.ts`
- Modify: `apps/web/src/lib/stores/settings.ts`（cdn 节 6 字段 + DEFAULTS + normalizeSettings 白名单）、`apps/web/src/lib/settingsDraft.ts`（validateSettings cdn 白名单镜像，settingsDraft.ts:110 起）
- Modify: `apps/web/src/lib/highlightClient.ts`（cdnBase 读 settings + 档位变更重建）
- Modify: `packages/vviewer-markdown/src/markdownRenderer.ts`（DiagramRenderOptions 增 `cdnEnginesHost?`，:157）、`packages/vviewer-markdown/src/pipeline.ts`（:537 透传）、`packages/vviewer-render-text/src/diagramFile.ts`（第二调用面透传）、`packages/vviewer-render-diagram/src/markdown/diagramEngines.ts`（opts 扩 host，:74/:88-101）、`packages/vviewer-render-diagram/src/markdown/cdnEngines.ts`（CDN 常量参数化，:5）
- Modify: `apps/web/src/lib/viewer.ts`（setDiagramOptions 注入 cdnEnginesHost，:296-315）、`apps/web/src/lib/foreignRenderers.ts`（foreign base 读 settings，:167/:182/:221）、`apps/web/src/lib/foreignAssets.ts`（resolveForeignAssetBase 参数化运行时覆写，保持零 $app/零 store import 的纯度）、`apps/web/src/lib/AppShell.svelte`（settings 订阅接线 + 重画派发 diff 扩展，:766 单订阅点）
- Create: `apps/web/src/lib/settings/CdnSection.svelte`（「网络资源」节）
- Modify: `apps/web/src/lib/SettingsCenter.svelte`（组注册，:63-76）、`apps/web/src/lib/i18n/catalogs/{zh-CN,en}/settings.ts`（`settings.cdn.*` + `settings.nav.cdn`）
- Modify: `apps/web/vite.config.ts`（define 增 `import.meta.env.VV_GRAMMAR_PACK_COUNT`；SW 面见 Step 4）

**Interfaces:**
- `settings.cdn`（spec §3.2 落定字段集，6 键）：`{ grammars: 'default'|'unpkg'|'cn'|'custom', grammarsCustom: string, engines: 'default'|'custom', enginesCustom: string, foreign: 'default'|'custom', foreignCustom: string }`；DEFAULT 全 default / custom 全空串；normalizeSettings 枚举白名单脏值归位（settings.ts:174-269 逐节先例）；validateSettings 镜像校验（custom 值校验：grammarsCustom 允许多基、逐基以 `/grammars/` 结尾（spec §3.2）；enginesCustom/foreignCustom 以 `/` 结尾的 https URL）。
- `cdnProfiles.ts`（纯函数）：
  - `parseMultiBase(value: string): string[]`——`|` 分隔 + trim + 逐基尾斜杠校验；**无分隔符单值=单元素数组**（Global Constraints 兼容锚）。
  - `resolveGrammarCdnBases(settings, env): string[] | null`——default=parseMultiBase(构建期 env)；unpkg=`https://unpkg.com/${pkg}-p<i>/grammars/`×N（N=`VV_GRAMMAR_PACK_COUNT`，缺省 '1'）；cn=`https://registry.npmmirror.com/${pkg}-p<i>/latest/files/grammars/`×N；custom=parseMultiBase(grammarsCustom)（校验失败返回 null + UI 错误态，不静默吞）。
  - `resolveEnginesHost(settings): string | undefined` / `resolveForeignBase(settings, env): string`——两档解析（undefined/缺省链尾=jsdelivr 缺省形态）。
- 重建原语：`highlightClient.ts` 导出 `rebuildHighlightClient(): void`——dispose 旧 client（`client.ts:196` 起 dispose: cancelAll+worker.terminate）+ 重置单例 + `ensureHighlightClient()` 重create；**代际计数**防在途旧 promise 落袋（Review Focus 2）。AppShell 单订阅点 `AppShell.svelte:766` `onSettingsChanged((s) => {…})`：grammars 两字段（cdn.grammars/grammarsCustom）diff 变化即触发重建；**engines 两字段（cdn.engines/enginesCustom）扩入 `vv:diagram-settings-applied` 派发 diff 集**（现 diff 仅 `diagrams.mermaidTheme`，AppShell.svelte:775「旧值捕获须先于副本赋值」同法扩捕获——不补则 engines 档切换无重画触发，闭包现读静默等下次手动渲染）。与 spec⑤ 的 failed-态门控重建共享 destroy/create 单例原语、两入口无先后依赖（spec §3.2 落定注记——本任务的 rebuild 即该共享原语的第二消费者）。
- **foreign 生效语义（拍板：切档需刷新）**：foreign 资产基座是**装配级快照**——`foreignRenderers.ts:132` 模块级 `appliedAssetBase` + `:164-168` 装配级幂等护栏（`appliedAssetBase === null` 仅首次装配解析），运行时改 settings 后无重读触发点；且 per-package 派生基座 save/restore（:181-182/:221）绑旧值。运行中重读+重设会破坏在途 mount 的资产引用一致性——落定 **foreign 切档保存后提示刷新页面生效**（CdnSection hint 明示；与 SW 裁量的「提示刷新」语义统一）。`resolveForeignAssetBase` 参数化改造保留：消费点传 settings 解析值，**装配时读当下 settings**，刷新后重新装配即读到新档。
- **验收锚 / e2e**：验收=`pnpm vitest run`（cdnProfiles/settings/settingsDraft/foreignAssets/cdnEngines 单测）+ grammar 域定向 e2e（`b-grammar-layers` / `b-grammar-spa-fallback` / `t-hl` 零回归——单基兼容护栏）；所触 e2e 锚文件=`apps/web/e2e/b-cdn-profiles.spec.ts`（新建，锚步在 Task 5 落）、`apps/web/e2e/b-settings-center.spec.ts`（SC-01 翻转，Task 5 落）。

**builder check 落定（SW 缓存一致性，spec §3.2 裁量项裁决）**：grammars 面的 CacheFirst 规则是**路径型**（`/\/grammars\/.*\.wasm$/` vite.config.ts:662、`/\/queries\//` :702，不锚 host）——unpkg/npmmirror/custom 任何域的 grammar wasm/queries 天然命中，**无需三族正则注册**（spec 原文「三族全量注册」按现规则实测为 moot，如实落定不盲加）。foreign/engines 规则是 **host 锚定**（:750 jsdelivr foreign、:795 jsdelivr 通配）——两档无 unpkg/cn 预设族，custom 域构建期不可知：**起步语义=custom 域在线直取不入运行时缓存 + 档位变更提示刷新页面**（spec 推荐起步项；message 动态注册列增强项不做）；该边界在 CdnSection 自定义输入旁 hint 文案明示。manifest.json fetch 无缓存规则（小文件，直取）——三作用面一致，无需补。

- [ ] **Step 1: settings 节 + cdnProfiles（TDD）**

先写 `cdnProfiles.test.ts`：多基解析（`|`/单值/空串 null/尾斜杠归一）、四档 grammars URL 构造（N=1 单基兼容 + N>1 多基）、两档 engines/foreign、custom 校验失败 null。再实装 + settings.ts/settingsDraft.ts 节字段（normalize 白名单与 validateSettings 镜像双面，settings.test.ts / settingsDraft 既有单测同步扩展）。Run: `pnpm vitest run apps/web/src/lib` → RED→GREEN。

- [ ] **Step 2: grammar 消费面 + 重建**

`highlightClient.ts` create() 的 cdnBase 改 `resolveGrammarCdnBases(loadSettings(), import.meta.env.VV_GRAMMAR_CDN)` 拼接为多层候选（`assembleGrammarLayers` 的 cdnBase 单基形态扩为多基——`grammarLayers.ts:71-91` candidates 数组 push 多个 cdn 层，层名 `cdn-p<i>` 或统一 `cdn`，warn 语义不变）；`rebuildHighlightClient` + AppShell `:766` 订阅内 grammars 两字段 diff 接线（Interfaces「重建原语」段口径）。unpkg/cn 版本解析固化（spec §3.2 落定注记）：**起步直用缺省重定向形态**（builder check 实测：`unpkg.com/@bhxch/vviewer-grammars-full/package.json` 经 `-L` 重定向 200 + `access-control-allow-origin: *`，本计划 2026-11-14 curl 实证；且实测线上 latest=0.1.1 ≠ 构建钉版 0.1.0——重定向不确定性真实存在）；设置 UI 显示解析值 + 手动重解析（unpkg meta API / npmmirror registry 解析，结果缓存独立 localStorage 键 `vviewer:cdn-versions`——**不扩 settings.cdn 钉死 6 字段集**，记档裁量）；解析失败回退重定向形态并 warn。

- [ ] **Step 3: engines / foreign 消费面**

cdnEngines.ts：`const CDN` 改缺省常量 + 各 `renderXxxCdn(source, host?)` 尾参（缺省 jsdelivr）；diagramEngines.ts opts 增 host 透传；pipeline.ts:537 与 diagramFile.ts 调用面透传 `ctx.diagram?.cdnEnginesHost`；viewer.ts setDiagramOptions 注入 `cdnEnginesHost: resolveEnginesHost(loadSettings())`；**AppShell :775 旧值捕获集扩 cdn.engines/enginesCustom 两字段**（实际变化才派发 `vv:diagram-settings-applied`——engines 档切换的即时重画触发通道，不补则静默等下次手动渲染）。foreignAssets.ts：`resolveForeignAssetBase(env?, runtimeBase?)` 尾参（链序：env → 同源 → **运行时覆写** → 缺省 CDN——覆写插在缺省 CDN 前，custom 值空串=未启用走缺省）；foreignRenderers.ts 三消费点传 settings 解析值（**装配时读当下值——生效时机=刷新后重新装配**，Interfaces「foreign 生效语义」段拍板，不做运行中热切换）。两包单测（cdnEngines.test.ts host 注入、foreignAssets.test.ts 覆写链序）。

- [ ] **Step 4: SW 面核实 + e2e 构建锚（仅 vite.config define）**

vite.config.ts define 增 `VV_GRAMMAR_PACK_COUNT`（env 缺省 '1'）；SW runtimeCaching 按 Step 4 builder check 结论**零新规则**（路径型已覆盖），但在 :750/:795 注释补记「grammars 拆包多基路径型覆盖 / custom 域在线直取」边界，防止后人误判为漏配。

- [ ] **Step 5: CdnSection.svelte + SettingsCenter 注册 + i18n**

节控件：三作用面各一行档位 select + custom 输入框（grammars 四值 / engines·foreign 两值）；cn 档 option 带「白名单申请中，落地前不可用」标注（disabled 或激活后警告行——裁量取**可选但显示警示行**，白名单落地即用）；custom 输入实时校验错误态（复用节内 `role="status"` 行形态）；unpkg/cn 激活时显示版本解析值 + 重解析钮；**foreign 档位行 hint 明示「保存后刷新页面生效」**（Interfaces「foreign 生效语义」段拍板，与 custom 域 SW 提示文案并存——两处刷新语义统一在 hint 中一次讲清）。SettingsCenter groups 注册（`{ id: 'cdn', label: t('settings.nav.cdn'), content: CdnSection }`，位置插在「存储与数据」之后、「关于」之前——网络资源属基础设施类，与存储相邻合理；**SC-01 十二组 → 十三组是有意翻转**，翻转面：b-settings-center SC-01 toEqual 列表 +1，en 同步）。i18n 双目录逐键落（zh 先定稿 → en 翻译；词汇表沿 frontend-conventions 计划 Global Constraints 清单）。组件形态沿三层纪律（draft + 回调上行，SettingsCenter 节先例），runes 写法。

- [ ] **Step 6: 门禁 + 提交**

Run: `pnpm lint && pnpm run typecheck && pnpm vitest run`（全绿）
```bash
git add apps/web packages/vviewer-markdown packages/vviewer-render-diagram packages/vviewer-render-text && git commit -m "feat(cdn): 三作用面 CDN 档位运行时切换——settings.cdn 节+grammar 重建+engines host 参数化+foreign base 覆写+网络资源设置组"
```

---

### Task 4: 预设网络字体（single + css 双通道一键添加）

**前置阅读（触发词条款，开工前全文加载）：** 同 Task 3 两份设计文档；另核对 `semantic-components.md` 表 2（FontsSection.svelte:208 网络字体删除已是登记成员——预设字体删除沿用同通道，不新增形态）。

**Files:**
- Create: `apps/web/src/lib/fontPresets.ts`（预置清单纯 .ts）+ `apps/web/src/lib/fontPresets.test.ts`
- Modify: `apps/web/src/lib/stores/fontsStore.ts`（css 型通道 + kind 扩展）、`apps/web/src/lib/stores/fontsStore.test.ts`
- Modify: `apps/web/src/lib/settings/FontsSection.svelte`（「预设字体」区块，:346 webLabel 区附近）
- Modify: `apps/web/src/lib/i18n/catalogs/{zh-CN,en}/settings.ts`（`settings.fonts.presetWeb.*`）

**Interfaces:**
- 预置清单条目（spec §3.3 落定形态）：`{ family: string, displayName: string, kind: 'single'|'css', sources: [{ label: string, url: string }] }`；displayName 是显示数据值（含 CJK 以 `\u` 转义，D8）。
- `fontsStore.ts` 扩展（spec §7 落定：css 型不做离线）：
  - `FontRecord.kind` 联合扩 `'css'`——IndexedDB **记录字段扩展无 schema 升版**（spec §3.3 裁量确认维持；builder check 实测：`session.ts:71` `DB_VERSION = 5`、FONTS store 无 keyPath 自管记录 `session.ts:76-81`，加字段天然兼容。spec 原文「IndexedDB v3」的 v3 是陈旧标签，实质结论不变——记档）。
  - css 型记录形态：`{ kind: 'css', family, name=displayName, cssUrl, sourceLabel, size: 0, enabled, … }`——**无 data 字段**（不入库二进制）；添加=记录校验（重名/https 门禁沿用）→ 落库 → `<link rel="stylesheet">` 插入 `document.head`（启停=节点插拔，删除=移除节点+删记录）；`setEnabledFont`/`deleteFont`/`loadEnabledFontFaces` 按 kind 分支（css 分支不走 faceCache/FontFace）；断网回退缺省是自然语义（无 FontFace 注入，css 拉不到即无字形），无需专门代码。
  - single 型预设添加：复用 `addFontFromUrl` 尾段（重名/30MB/https/装载验证，fontsStore.ts:140-172）——UI 层按 sources[label] 取 URL 调用，不新造门禁。
- FontsSection「预设字体」区块：条目行（displayName 样张 + 来源标签组——每源一个添加钮，label jsdelivr/unpkg/中文源可见）+ css 型条目「在线字体」标注（spec §7 落定）+ 已添加态（该 family 已在 fontRecords 中时按钮禁用/已添加）。
- **验收锚 / e2e**：验收=`pnpm vitest run apps/web/src/lib`（fontPresets/fontsStore css 通道单测）；所触 e2e 锚文件=`apps/web/e2e/b-fonts.spec.ts`、`apps/web/e2e/b-fonts-deep.spec.ts`（预设锚步在 Task 5 落，本任务保既有 FONT 锚零回归）。

**builder check 落定（预置清单与来源 URL 实测选定，spec §3.3 裁量项）**：以 spec 建议清单为基线——中文 css 型：霞鹜文楷（lxgw-wenkai-webfont npm 包切片 css）、Noto Sans SC / Noto Serif SC（@fontsource 系）；西文 single 型：JetBrains Mono / Fira Code / Iosevka（等宽）、Inter（UI）。**builder 开工时逐 URL curl 实测**（200 + content-type + ACAO；每条 ≥2 源：jsdelivr + unpkg，中文源可追加 npmmirror files 白名单包——当前 403 不做第 3 源硬门），实测台账记入任务报告；URL 失效条目替换为实测可用等价物（family 语义不变）。npmmirror files 通道布局契约已实证（本计划 2026-11-14 curl：`registry.npmmirror.com/lodash/4.17.21/files/package.json` 200，`files/<包内路径>` 形态成立；本仓包 403 白名单门禁同日复现）。

- [ ] **Step 1: builder 实测门（前置）**——逐候选 URL curl（jsdelivr/unpkg 双源 × 7 条目），台账落任务报告；选定终版清单写入 fontPresets.ts。
- [ ] **Step 2: TDD fontsStore css 通道**——fake-indexeddb + DOM 桩（fontsStore.test.ts 先例 jsdom 缺 FontFace 同法）：css 添加落库无 data / link 插拔 / 删除回落 / 重名拒收 / https 门禁。Run: `pnpm vitest run apps/web/src/lib/stores` → RED→GREEN。
- [ ] **Step 3: FontsSection 预设区块 + i18n 双目录**——a11y：条目钮 aria-label 走 `t()` 且含可见文本词形（label-content-name-mismatch 前科）；错误/提示走既有 `role="status"` 行（FontsSection.svelte:373 通道复用）；删除确认沿 `window.confirm` 表 2 通道。
- [ ] **Step 4: 门禁 + 提交**

Run: `pnpm lint && pnpm run typecheck && pnpm vitest run`
```bash
git add apps/web/src/lib && git commit -m "feat(fonts): 预设网络字体一键添加——single 入库离线/css 切片在线双通道+多源实测清单"
```

---

### Task 5: e2e 锚批（多基合并 / 档位切换 / SW 多域 / 真网 / 字体预设 / a11y 态）

**Files:**
- Modify: `apps/web/e2e/b-grammar-layers.spec.ts`（多基合并用例 + grammar 真网锚）
- Create: `apps/web/e2e/b-cdn-profiles.spec.ts`（CDNP- 域：档位切换）
- Modify: `apps/web/e2e/b-sw-runtime-cache.spec.ts`（SWR-ROUTE 多域）
- Modify: `apps/web/e2e/b-fonts.spec.ts` + `apps/web/e2e/b-fonts-deep.spec.ts`（预设字体锚）
- Modify: `apps/web/e2e/b-a11y-axe.spec.ts`（「网络资源」组扫描态 +1，先例=languageA11y 组态）
- Modify: `apps/web/e2e/b-settings-center.spec.ts`（SC-01 十三组定稿序）

**spec §5 ③ 记档（字面不成立，按最合理解读落）**：spec 写「CDN-01 真网锚更新至子包 URL」——实查 `b-cdn-diagram-engines.spec.ts:103` CDN-01 是 excalidraw 图表引擎 jsdelivr +esm 真网锚（engines 档位不动 jsdelivr 缺省，URL 无子包概念），字面更新无对象。落地为：**b-grammar-layers 新增 grammar 子包真网锚**（SWR-ROUTE-05/06 同款 skipIf offline/不可达），断言 jsdelivr/unpkg 子包 manifest 可达且为 JSON（子包首发前 404 → skip，不假红）。

**验收锚 / e2e**：本任务即 e2e 锚批——所触锚文件全列于上方 Files；验收=`pnpm --filter web build:e2e` 后 Step 6 的七域定向 playwright 全绿 + A11Y/SC-01 两处有意翻转在 commit message 与 PR 描述明示列举（D20 口径）。

- [ ] **Step 1: b-grammar-layers 多基用例**——custom 档两 mock 子包 base（page.route 双 origin）：两子包 manifest 合并（A 语言 p1 / B 语言 p2，各落其 base 的 wasm）、p2 manifest 403 跳层仅 warn 一条、p1 语言 tree-sitter 生效；真网锚（skipIf）。既有两用例（单基）零改动。
- [ ] **Step 2: b-cdn-profiles.spec.ts（CDNP-）**——CDNP-01 档位切换 default→custom：设置中心改档应用 → CDN 层请求 URL 断言（page.route 计数新 origin）；CDNP-02 custom 输入校验（非 `/grammars/` 结尾错误态）；CDNP-03 engines custom host 注入（markdown 围栏 excalidraw 改档应用后**无需刷新**请求命中 custom 域——AppShell diff 扩展的重画触发正是本锚的验证对象）；CDNP-04 foreign custom base 注入（**保存→刷新→** foreign 资产请求命中 custom 域——foreign 基座装配级快照，切档需刷新生效，Interfaces「foreign 生效语义」段拍板——route 伺服最小假资产）；CDNP-05 档位切换后重建生效（切档前 hljs / 切档后 tree-sitter 或请求面翻转）。装置入口带就绪锚（B6）。
- [ ] **Step 3: SWR-ROUTE 多域**——mock unpkg 形态 grammar wasm URL 断言落 `vv-grammars-*` 族（路径型覆盖的运行期锚）；foreign/engines custom 域在线直取（无缓存族）断言。SWR-ROUTE-05/06 真网锚不动。
- [ ] **Step 4: 字体预设锚**——预设条目一键添加（single：route 伺服 woff2 → 样张/下拉生效；css：route 伺服切片 css → link 节点在位 + 字形生效）、**启停翻转断言**（single：FontFace 启停 → 样张/下拉生效↔失效；css：link 节点插拔 → 字形生效↔回退——spec §5 ⑤「启停/删除回落」两态齐锚）、css 条目「在线字体」标注、删除回落（槽位引用回落语义沿 FONT 既有锚）。
- [ ] **Step 5: SC-01 + axe 态**——SC-01 toEqual 列表插入「网络资源」（**有意翻转列举：本任务唯一 UI 断言翻转点**）；axe 状态矩阵加「设置中心-网络资源组」态（双 project）。
- [ ] **Step 6: 门禁 + 提交**

Run: `pnpm --filter web build:e2e && pnpm --filter web exec playwright test b-grammar-layers b-cdn-profiles b-sw-runtime-cache b-fonts b-fonts-deep b-a11y-axe b-settings-center`（**playwright 仅在 apps/web devDeps——根 package.json 无 playwright，`pnpm exec` 直跑 ENOENT；ci.yml:171 同 `--filter web exec` 形态**）
```bash
git add apps/web/e2e && git commit -m "test(e2e): CDN 拆包多域锚批——grammar 多基合并/档位切换 CDNP 域/SW 多域/字体预设双通道/a11y 网络资源态"
```

---

### Task 6: 全量门禁与收尾（控制器执行）

- [ ] `node tools/fetch-e2e-corpus.mjs`（语料）→ `pnpm lint && pnpm run typecheck && pnpm vitest run`（仓库根全量）→ `pnpm --filter web build:e2e` → playwright 全量双 project（`pnpm --filter web exec playwright test`——根无 playwright devDep，ci.yml:171 同形态；对比基线：SC-01 十三组与 b-cdn-profiles 新域外零回归）→ `pnpm --filter web exec playwright test --config playwright.server.config.ts`（server 档零翻转；config 位于 apps/web/ 下，相对该包工作目录解析）→ `git status --porcelain` 净空。
- [ ] 全量 review（superpowers:requesting-code-review，范围=本计划全部 commit），修复全部 C/I/M 后复审；**不 push**（用户留待首发窗口手动触发——Trusted Publisher 配齐后打 tag）。
- [ ] 台账汇总（实施期全部记档项随任务报告归集）：①真子包 CORS 实测门（unpkg/npmmirror 各拉一个子包 manifest+wasm）只能在首发 release 后执行——实施期已以通道级实测替代（unpkg 200+CORS / npmmirror 白名单门禁与布局契约，见 Task 4 Step 1）；②npmmirror cn 档 `<latest>/files/` tag 形态是否被 files 通道支持未实测（白名单落地后核对）；③cnpm/unpkg-white-list PR 申请是独立跟进项不入本计划实施面（spec §4）；**④首发 tag 定稿后校准 `highlightDefault.ts:19-20` `DEFAULT_GRAMMARS_BASE_URL` 版本段**（Task 2 Step 3 TODO 占位的闭环——npm 实查 latest=0.1.1 已占版、首发 tag 必然 >0.1.1，实施期不可实查；错位即 standalone 缺省全子包 404；校准同时核对 Trusted Publisher 逐包配置与首发包数对齐，spec §7 前置）。

## Errata（执行期勘误）

- 2026-11-14 计划评审修订（12 条意见，全部实查复现后内联落定）：①Task 1 单件超限拍板=整体抛错（门禁两段语义，测试断言改写）；②Task 2 补 highlight 包 queriesBaseResolver 多基路由（standalone 非首子包语言 queries 缺口）+ 包数一致性 fail-fast + pages 探测超限 warn + 首发版本 TODO 占位闭环归台账④；③Task 3 foreign 切档拍板=保存后刷新生效（装配级快照实锚 foreignRenderers.ts:132/:164-168）+ AppShell :766 订阅与 ：775 diff 捕获集扩 cdn.engines 两字段入 Files/Steps；④playwright 命令口径改 `pnpm --filter web exec`（根无 playwright devDep）；⑤client.ts dispose 行号订正 ：196；⑥Task 5 补启停翻转锚；⑦命名 outDir 对齐/基线 HEAD 75cc652/「不依赖应用侧代码」措辞。无模板原文作废项——执行期发现新失配时在此登记。
