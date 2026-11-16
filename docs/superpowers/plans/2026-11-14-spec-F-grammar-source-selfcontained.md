# tree-sitter 构建源头化：helix pin + gen-sources 自解析源清单 + 生成物出库 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 消灭 grammar 生态源清单再生链对本地固定检出目录的依赖（spec F）：①`tools/grammar-builder/helix-pin.json` 单一 commit 锚点（master HEAD，语言与 tags 同 pin）；②新生成器 `gen-sources.mjs` 从 helix 源头自拉——languages.toml@pin 解析派生（build-list / server manifest+cSymbol / languages.json / generated-extensions）+ queries@pin 整树拉取（QUERY_PATCHES 迁入、tags 补源同 pin 收编）+ themes@pin + `--refresh` 一键刷新带差异报告；③生成物出库（.gitignore 扩 + git rm --cached）+ 旧三脚本（build-list/gen-server-manifest/gen-code-extensions）与 tools/helix-assets 退役；④CI 重排——setup-grammars gen 前置（缓存键换 pin hash）、grammar.yml ≥264 硬门禁与 server `full_registry_count_is_301` 改动态期望、publish-npm artifact 契约扩展（queries/licenses 随包）、publish-packages 供链补 gen。

**Architecture:** 单脚本 `gen-sources.mjs`（缺省=按 pin 全量 gen；`--refresh`=resolve master HEAD → 更新 pin → 重 gen → 差异报告；首跑/无 pin 时 `--refresh` 自动初始化）合并现三脚本+helix-assets 职责；纯函数面（parseLanguages/parseTheme/collectThemes/QUERY_PATCHES/collectExtensions/parseGrammarSources）从旧脚本签名不变整迁，网络面单通道（trees API recursive 一次列全 + raw.githubusercontent 逐文件并发 8，truncated/失败显式报错不静默）。build.mjs 与 setup-grammars 既有工艺零重构（wasm 自建/vendored 短路/失败清单/单飞预热全维持），仅加 gen 产物前置检查与 cSymbol 交叉验证两个缝。生成物全部 gitignored，缓存恢复不覆盖入库文件（helix-pin.json/aliases.json 不进 cache paths）。实施顺序上 gen + `--fetch` 严格先于 cargo（server/core/build.rs 源码编译依赖 out/grammars 源树 + grammars-manifest.json + assets/queries 三个生成物）。

**Tech Stack:** Node 22 ESM 工具脚本（smol-toml 已是根 devDep）+ vitest（仓库根跑）+ Rust cargo test/clippy + GitHub Actions YAML + Conventional Commits。本计划零 `.svelte`/`.svelte.ts` 改动（纯构建链 + Rust + CI + e2e 注释级订正）。

**Spec:** `docs/superpowers/specs/2026-11-12-grammar-source-selfcontained-design.md`（本计划从 spec 论证；实现者两份都读——spec §3 设计、§4 目标/非目标/反目标、§5 风险与验证、§6 验收锚点、§7 裁量与 §8 builder check 订正节同样有效）

## 基线与实施顺序

- **基线**：当前 HEAD `f673b42`（main；工作树 clean——spec C/E/A/B/D/I 已全部落地含评审修订）。spec F 此前零落地（`tools/grammar-builder/` 无 gen-sources.mjs、无 helix-pin.json 实查）；本计划全部工作基于该 HEAD 展开。
- **实施顺序**：Task 1 → Task 2 → Task 3 → Task 4 → Task 5 → Task 6，**严格串行**。理由：**gen-sources 与 `build.mjs --fetch` 是 cargo 编译的先行步骤**（spec F 指令明载）——server/core/build.rs 的 include_str(manifest)/copy_queries(assets/queries)/cc 编译（out/grammars 源树）三个输入在 T2 gen 实跑 + `--fetch` 后才在盘；T3（server 门禁动态化）的 cargo test 依赖该盘面；T4（CI）把 T1/T2 的本地链重排进 workflow；T5 收 e2e 锚与文档；T6 全量门禁收尾。
- **触及 server/（Rust）**：`server/core/src/compute/queries.rs`（301 硬门禁 → manifest 动态对齐，:299-306）与 `server/core/build.rs`（生成物缺失显式报错指向 gen 命令 + 头注释/警告文案订正）。build.rs 的 serde 结构零改动（manifest 形态保持）。
- **UI 文案/i18n/交互组件/a11y 触及面**：**零**——本计划无任何 `.svelte` 组件、i18n 目录键、浮层/菜单/确认通道或样式 token 改动，无 `docs/design/frontend-conventions.md`/`docs/design/semantic-components.md` 前置阅读项（唯一位近 UI 的文件是 `apps/web/e2e/b-code-outline.spec.ts` 的注释级溯源更新，无断言/文案变化）。
- **e2e 定向锚文件**：`apps/web/e2e/b-code-outline.spec.ts`（OUT-05「无 tags 语言」载体 ocaml 在新 pin 下经真网实证仍 404 无 tags.scm——断言零改动，注释补新 pin 溯源；tags 覆盖 58→~77 目录扩张是大纲语言集特性，OUT 域其余用例零翻转为本计划回归判据）。

## Global Constraints

- **拍板项不得偏离**（spec §3/§7/§8 落定）：
  - **pin 目标终拍=master commit 锚定**（§3.1，2026-11-14 用户拍板，替代 release tag 拍板）：单一 commit 锚点同时供 languages.toml 与 tags.scm；`--refresh` = fetch origin/master → HEAD commit 更新 pin → 全量重生成 + 差异报告；**release 信息不再作为锚**（可选参考展示）；每次构建自动拉最新 release 是反目标。
  - **gen 层不做语言集裁剪**（§4 反目标）：新清单集合 = helix `[[grammar]]` 全集 − `use-grammars.except`（wren/gemini 语义照抄）；选择面仍由 aliases.json + `--lite`/`--languages` 表达；aliases.json 保留入库（vviewer 自有资产）。
  - **反目标**：改 wasm 自建工艺（tree-sitter-cli 0.27/wasi-sdk/单飞预热/失败清单机制全部维持）、改 npm 打包布局（spec③ 另行处理）、aliases.json 派生化、QUERY_PATCHES 机制改形（唯一命中替换、命中≠1 抛错原样保留）。
  - **cSymbol 派生规约**（§8 落定）：`tree_sitter_<name，-→_>` 推导 + fetch 后从 parser.c 交叉验证（不符进 fetch-failures 失败清单，无例外表——spec 实测现 301 条全合规）。
  - **publish-npm artifact 契约**（§8 落定）：grammar job 上传附带 queries/ + GRAMMAR_LICENSES.md（+ wasm manifest 原有）；publish-npm 不跑 gen，pack-npm 从 artifact 解包目录读全部输入；publish-packages 供链补 gen 见 Errata ④。
  - **门禁动态化**（§5）：`full_registry_count_is_301` 与 grammar.yml `≥264` 断言改动态期望数（registry/manifest 自身一致，gen-sources 产出即真相）。
- **出库边界**（§3.4）：gitignore 扩 = `tools/grammar-builder/languages.toml`、`tools/grammar-builder/build-list.json`、`packages/vviewer-highlight/assets/{languages.json,themes.json,queries/}`、`server/grammars-manifest.json`、`server/GRAMMAR_LICENSES.md`、`packages/vviewer-core/src/registry/generated-extensions.ts`。入库保留 = `aliases.json`、`helix-pin.json`、全部脚本、测试、README。**cache paths 只收 gitignored 产物**（helix-pin.json/aliases.json 入库文件进 cache paths 会被缓存版本覆盖 checkout 版本——红线）。
- **grep 门**（§6）：仓内 `/share/rw/repo/markpad-aio` 与 `/share/rw/repo/github/helix-editor` 字面量清零（`docs/superpowers/**` 历史叙述除外）——T2 退役后由 T5/T6 复跑。
- **网络纪律**：gen-sources 全部网络失败显式报错不静默（pin 解析失败、trees truncated、raw 单文件失败重试 1 次后仍败即抛错带失败清单）；api.github.com 匿名 60/h（gen 恒 1-2 次调用，refresh 1 次；可选 GITHUB_TOKEN），raw.githubusercontent.com 走 CDN 无 API 限速（~1800 文件/全量）。
- **门禁口径**：vitest 一律在**仓库根**跑（包目录直跑缺 jsdom）；typecheck 仓库根 `pnpm run typecheck`；重建 web 一律 `pnpm --filter web build:e2e`（裸 build 冲掉 CDN 注入）；cargo 命令带 `--manifest-path server/Cargo.toml`。
- **commit 纪律**：Conventional Commits（feat/fix/test/docs… 中文主题）、原子化；`git status --porcelain` 自查净空再 add（不按记忆清单——尤其 T2 的 `git rm --cached` 后必须核对暂存面恰为预期清单）；**一律不得 git push**。
- **CI 验证的诚实边界**：workflow YAML 只能本地静态自查（语法解析 + 步序走查），GitHub Actions 真跑验证在 push 之后、不在本计划内完成——相关验收锚如实标注「静态自查 + 待 CI」。

## Review Focus

1. **manifest 集合公式与 vue 特例（Errata ①）**：`303 [[grammar]] − use-grammars.except(wren/gemini) = 301`，与现 `server/grammars-manifest.json` 逐位吻合；**vue 保持入 manifest**（实查 vue=true、server/core/build.rs:195-210 vue scanner.cc 改名特化——server 从源码编译 vue，出清单即 server 语言集回退）。spec §7.3 字面「− vendored 特例（vue 不入清单）」订正为「vue 的 **wasm** 走 fixtures 短路（build.mjs `listVendoredPrebuilts` 既有机制，不动）」——单测锁定 manifest 含 vue、不含 wren/gemini。
2. **queries 拉取=runtime/queries 整树，不得按语言清单逐目录过滤**：`_typescript`/`_jsx`/`ecma`/`_javascript`/`php-only` 等 inherits 父目录与变体目录必须入资产树（三消费面按目录形态工作：core-parse.ts:510 目录名即语言键、queries.ts:43 `; inherits` 指令展开、build.rs `generated_parents` 非语言目录收编）——逐语言过滤会断 inherits 链、编译期翻红。gjs/gts 若上游出现同 `_typescript` 形态自然入树（Errata ⑤）。
3. **动态门禁防双计**：grammar.yml 断言落定 `wasm manifest 键数 + self-build 失败清单数 == server/grammars-manifest.json 条目数`（fetch 失败被 self-build 的 parser.c-missing 失败条目吸收，单门收敛；fetch-failures 仅打印不参与等式）；Rust 侧 `generated_count() == manifest.grammars.len()`（partial 跳过形态保持）。
4. **gen 缺产物报错指向 gen 命令**（§5）：build.mjs `--fetch`/`--self-build` 读 build-list.json/languages.toml 前置存在性检查；build.rs 对 manifest 与 assets/queries 各显式检查——报错文案统一指向 `pnpm gen:sources`（本地首跑/CI 冷缓存漏 gen 即确定性报错，不静默 ENOENT）。
5. **aliases 一致性门禁边界（Errata ③）**：gen 校验 aliases 每键 ∈ manifest 名集 ∪ `_`/`-` 变体命中；未命中即报错，**白名单 `ALIASES_KNOWN_MISSING = ['objc','systemrdl']` 告警放行**（现状合法差异，硬 fail 会翻转既有 README 记录的行为）。单测锁白名单内外两态。
6. **盘态守门测试迁移后仍咬合**：ecma/injections.scm O(n²) 锚点守门、typescript inherits 头声明、queries 目录数基线、tags 目录数基线、_javascript tags 死资产不复活——从 tools/helix-assets/test/generate.test.ts 原断言迁至 gen-sources.test.ts（对 gen 后资产盘面继续生效），T2 删旧文件后断言面不断档。

---

### Task 1: gen-sources.mjs 单源生成器——pin 解析/派生/themes/queries 拉取/--refresh + 单测迁移落位

**Files:**
- Create: `tools/grammar-builder/gen-sources.mjs`
- Test: `tools/grammar-builder/test/gen-sources.test.ts`（fixture：`tools/grammar-builder/test/fixtures/gen-sources/*.toml` 小型 languages.toml/themes 片段）
- 无 Modify（旧脚本本 task 不动，过渡并存；盘态守门断言在新旧两测试文件暂时并存——断言同真，T2 删旧）

**Interfaces:**
- pin 文件 `tools/grammar-builder/helix-pin.json`（T2 实跑落地，本 task 定义读写与校验）：
  ```json
  { "ref": "master", "commit": "<40hex>", "release": "", "refreshedAt": "<ISO8601>" }
  ```
  `readPin/validatePin`：缺文件/缺字段/commit 非 40hex → 显式报错指向 `node tools/grammar-builder/gen-sources.mjs --refresh`（首跑初始化语义）。
- 纯函数整迁（签名不变，零语义漂移）：
  - `parseLanguages`/`normalizeHex`/`normalizePalette`/`stylesFromDoc`/`parseTheme`/`collectThemes`/`BUILTIN_PALETTE`（helix-assets/generate.mjs:29-202 原样迁）；
  - `QUERY_PATCHES`/`applyQueryPatches`（generate.mjs:253-276 原样迁——solidity 尾锚 1 条 + 命中≠1 抛错）；
  - `collectExtensions`/`toModule`/`verify`（gen-code-extensions.mjs 原样迁；`toModule` 头注释改「由 tools/grammar-builder/gen-sources.mjs 生成；生成物不入库，消费端缺失时报错指向 pnpm gen:sources」）；
  - `parseGrammarSources`（build.mjs:337-347 原样迁——输入参数化为 toml 文本）。
- 新增派生函数（TDD 主体）：
  ```js
  // [[grammar]] 派生：全集 − use-grammars.except；形态与现 build-list.json 逐字段一致
  // （parserCExists 恒 true——语义改注「信任 helix 清单，实探在 fetch/self-build 失败清单」
  // ——spec §3.2.1 裁量落定=信任上游不预探测；helixLang=name。零 build.mjs resolveTargets 改动）
  deriveBuildList(grammarDoc, exceptList) -> [{ name, subpath, parserCExists: true, helixLang }]
  // server manifest 派生：{note, generatedAt, grammars:[{name, dir: name, subpath, cSymbol}]}——
  // 形态零变化（build.rs serde 不动）；cSymbol = tree_sitter_<name，-→_> 单源函数；note 更新为
  // 「由 gen-sources.mjs 从 helix pin 派生；期望条目数=grammars 数组长度（动态门禁真相源）」
  deriveServerManifest(grammarDoc, exceptList) -> object
  // languages.json 派生 = parseLanguages(doc)（实查 Errata ⑦：值域 6 字段零 Markpad 增补，派生即真相）
  // generated-extensions 派生 = toModule(collectExtensions(languagesJson))
  // 差异报告：语言集 ±（新旧 manifest 名集 diff）、rev 变更数（新旧 build-list join）、queries 差异文件数
  diffReport(oldProducts, newProducts) -> { added, removed, revChanged, queriesChanged }
  ```
- 网络面（fetch 参数可注入供单测 mock）：
  - `resolveMasterHead()`：`GET api.github.com/repos/helix-editor/helix/commits/master` → sha（GITHUB_TOKEN 可选 Bearer）；非 200 显式报错；
  - `fetchPinLanguagesToml(commit)`：`raw.githubusercontent.com/helix-editor/helix/<commit>/languages.toml`；非 200 显式报错；
  - `fetchHelixTree(commit)`：`GET api.github.com/repos/helix-editor/helix/git/trees/<commit>?recursive=1` → `{ truncated: true }` 即抛错（显式不静默——§3.2.2 corpus 算法同源，fetch-e2e-corpus.mjs 先例）；
  - `pullQueries(treeFiles, commit, outDir)`：filter `runtime/queries/**/*.scm` → raw 逐文件（并发 8、单文件失败重试 1 次、仍败抛错带失败清单）→ 临时目录 → `applyQueryPatches` → rename 到 `packages/vviewer-highlight/assets/queries/`（**整树含变体/父目录——Review Focus 2**）；tags.scm 随整树天然覆盖（TAGS_SOURCES 独立 pin 退役，Errata ⑨）；
  - `pullThemes(treeFiles, commit, outDir)`：filter `runtime/themes/*.toml` → raw 拉取 → `collectThemes`（跳 theme.toml/base16_ 规则内含）→ `themes.json`。
- 主流程 `main(argv)`：
  - 缺省：`readPin` → `fetchPinLanguagesToml` → 派生四产物 → `fetchHelixTree` → `pullQueries`/`pullThemes` → 原子落盘（单文件 tmp+rename；queries/ 整目录 tmp+rename，同盘假设跨盘退化 copy+rm）→ aliases 一致性校验（Review Focus 5）→ 打印变更摘要（语言集 ±、rev 变更数、queries 差异文件数——对盘上旧产物对比）；
  - `--refresh`：`resolveMasterHead` → 与 pin.commit 对比 → 写新 pin（refreshedAt 更新）→ 同缺省流程 → 差异报告（pin 缺失时自动初始化）。
- 产物路径常量：`tools/grammar-builder/languages.toml`（=build.mjs PATHS.languagesToml 同路径，出库后由 gen 写）、`tools/grammar-builder/build-list.json`、`packages/vviewer-highlight/assets/{languages.json,themes.json}`、`server/grammars-manifest.json`、`packages/vviewer-core/src/registry/generated-extensions.ts`。

**验收锚**：`pnpm vitest run tools/grammar-builder/test/gen-sources`（仓库根）全绿——①pin 校验（缺字段/40hex/报错指向 --refresh）；②[[grammar]] 多形态解析 fixture（subpath 有无、except 剔除 wren/gemini、**manifest 含 vue**——Review Focus 1）；③cSymbol 规约（`c-sharp→tree_sitter_c_sharp` 等）；④build-list 形态逐字段锚（name/subpath/parserCExists/helixLang）；⑤languages.json/generated-extensions/manifest 快照锚（fixture 派生输出断言）；⑥QUERY_PATCHES 命中≠1 抛错（迁移用例）；⑦parseTheme/collectThemes inherits 链（迁移用例）；⑧盘态守门迁移断言全绿（现盘资产：queries 目录数 ≥280、ecma O(n²) 锚点、typescript inherits 头、tags 目录数 ≥58、_javascript tags 死资产不复活、bash @definition.function 抽查）；⑨diffReport 三计数；⑩aliases 白名单内外两态；⑪网络面 mock（trees truncated 抛错、raw 失败清单抛错、refresh 写 pin）。+ 旧脚本测试仍全绿（过渡并存）+ `pnpm run typecheck && pnpm lint` 绿。所触 e2e 锚文件=无（工具层）。

- [ ] **Step 1: TDD 纯函数与派生面（RED→GREEN）**

fixture toml 落位（subpath 有无/except 段/[[language]]×[[grammar]] 差集形态）；gen-sources.test.ts 先落 ①-⑤ describe → RED（模块不存在）→ 整迁纯函数 + 落派生函数 → GREEN。

- [ ] **Step 2: 盘态守门迁移 + themes/tags 断言（GREEN on 现盘）**

⑧ 盘态断言按 generate.test.ts:124-245 原语义迁入（路径不改，对现入库资产跑）→ GREEN。

- [ ] **Step 3: 网络面 + 主流程 + --refresh（mock 注入）**

⑪ 网络用例（fetch 参数注入 mock 响应）→ RED → 落网络面/主流程/原子落盘/校验门 → GREEN。Run: `pnpm vitest run tools/grammar-builder && pnpm run typecheck && pnpm lint` → 全绿。

- [ ] **Step 4: 提交**

```bash
git add tools/grammar-builder/gen-sources.mjs tools/grammar-builder/test && git commit -m "feat(tools): gen-sources 单源生成器——helix-pin 解析/languages.toml@pin 派生（build-list/manifest+cSymbol/languages.json/generated-extensions）/queries@pin 整树拉取（QUERY_PATCHES+tags 同 pin 收编）/themes@pin/--refresh 差异报告（旧脚本过渡并存，纯函数签名不变整迁）"
```

---

### Task 2: 出库切换——gitignore+git rm --cached、旧脚本退役、build.mjs 适配、gen 实跑与 --fetch 源树落地

**Files:**
- Modify: `.gitignore`（§3.4 六类生成物 + `tools/grammar-builder/languages.toml`、`build-list.json`——注释同步「构建源头化：gen-sources 产物不入库」）
- Delete: `tools/grammar-builder/build-list.mjs`、`tools/grammar-builder/gen-server-manifest.mjs`、`tools/grammar-builder/gen-code-extensions.mjs`、`tools/grammar-builder/test/gen-server-manifest.test.ts`、`tools/grammar-builder/test/gen-code-extensions.test.ts`、`tools/helix-assets/`（generate.mjs/test/package.json/README.md 整目录——纯函数与盘态守门已在 T1 迁移；溯源叙述并入 tools/grammar-builder/README.md，T5 落文）
- Modify: `tools/grammar-builder/build.mjs`（两个缝，见 Interfaces）
- Modify: `tools/grammar-builder/test/build.test.ts`（剥离 `build-list.mjs` import 与其 describe——`buildList/detectParserC/SOURCES` 随脚本退役；build.mjs 侧用例全保留）
- Create: `tools/grammar-builder/helix-pin.json`（gen 实跑产物）
- Modify: `package.json`（`gen:sources` 新脚本；`gen:grammars` 链改）
- git rm --cached（工作树保留，untracked 后由 .gitignore 收编）：`tools/grammar-builder/languages.toml`、`tools/grammar-builder/build-list.json`、`packages/vviewer-highlight/assets/languages.json`、`packages/vviewer-highlight/assets/themes.json`、`packages/vviewer-highlight/assets/queries/`（960 文件）、`server/grammars-manifest.json`、`server/GRAMMAR_LICENSES.md`、`packages/vviewer-core/src/registry/generated-extensions.ts`

**Interfaces:**
- build.mjs 缝 ①——gen 产物前置检查（`--fetch` 与 `--self-build` 两分支入口各一次，错误指向 gen）：
  ```js
  function ensureGenProducts() {
    for (const p of [PATHS.buildListJson, PATHS.languagesToml]) {
      if (!fs.existsSync(p)) throw new Error(`gen 产物缺失: ${p}——先跑 pnpm gen:sources（或 node tools/grammar-builder/gen-sources.mjs --refresh）`);
    }
  }
  ```
- build.mjs 缝 ②——cSymbol 交叉验证（`--fetch` 分支，fetch 完成后对成功条目逐一校验，不符 push 进 failures 随既有 fetch-failures.json 落盘）：
  ```js
  function cSymbolOf(name) { return `tree_sitter_${name.replace(/-/g, '_')}`; }
  // 校验 out/grammars/<name>[/<subpath>]/src/parser.c 含 cSymbolOf(name)；不符 →
  // failures.push({ name, reason: `cSymbol mismatch: 期望 ${sym} 未见于 parser.c（spec F §8 交叉验证）` })
  ```
- package.json scripts：
  ```json
  "gen:sources": "node tools/grammar-builder/gen-sources.mjs",
  "gen:grammars": "pnpm gen:sources && node tools/grammar-builder/build.mjs --fetch --lite && node tools/grammar-builder/build.mjs --self-build"
  ```
  build.mjs 头注释与 PATHS 注释同步（「vendored languages.toml」→「gen-sources 产物 languages.toml@helix-pin」）。
- **gen 实跑（本 task 核心，spec §3.5 验证步骤）**：`node tools/grammar-builder/gen-sources.mjs --refresh`（首跑自动初始化 pin）→ 差异报告对照预期锚（Errata ⑦，2026-11-17 实测）：语言集 ±0、[[grammar]] 303/[[language]] 342、rev 变更 3（yaml→ikatyang 仓指回 / haskell / qmljs）、languages.json 值域 6 字段零增补；随后 `node tools/grammar-builder/build.mjs --fetch`（**全量源树落地——cargo 编译依赖生成物，T3 前置步骤**）；`pnpm gen:grammars`（新链）冒烟 lite 自建。
- 出库后 README 计数面最小订正（tools/grammar-builder/README.md 头部退役提示一段——全面重写归 T5）：「build-list/gen-server-manifest/gen-code-extensions 与 tools/helix-assets 已退役，源清单再生见 gen-sources.mjs」。

**验收锚**：`pnpm vitest run`（仓库根，tools+packages+apps 全量）绿（退役后测试面 = build.test + gen-sources.test + pack-npm.test + highlight 域既有）；`pnpm install` 收敛（tools/* 非 workspace 成员，pnpm-workspace.yaml 实查仅 packages/*、apps/*——lockfile 零变化预期，若变化如实记录）；`git status --porcelain` 暂存面恰为 T2 清单（生成物不在 untracked 区——.gitignore 生效核验）；`rg -n "/share/rw/repo/markpad-aio|/share/rw/repo/github/helix-editor" --hidden -g '!.git' -g '!docs/superpowers/**'` **零命中（grep 门达成）**；`pnpm run typecheck && pnpm lint` 绿（generated-extensions.ts 工作树在位）；gen 差异报告与 Errata ⑦ 预期逐项对齐（超出预期即停，人工复核后更新 Errata 再继续）。所触 e2e 锚文件=无。

- [ ] **Step 1: .gitignore 扩 + git rm --cached + 旧脚本与旧测试删除**

先 `git rm --cached`（逐文件核对暂存面）再删脚本/测试；.gitignore 六类+两文件；build.test.ts 剥离退役 import。Run: `git status --porcelain` 核对。

- [ ] **Step 2: build.mjs 两缝 + package.json scripts + README 退役提示**

ensureGenProducts/cSymbol 校验/脚本链/头注释。

- [ ] **Step 3: gen 实跑 + 全量 --fetch + 门禁**

`node tools/grammar-builder/gen-sources.mjs --refresh` → 差异报告对照 Errata ⑦ → `node tools/grammar-builder/build.mjs --fetch`（全量）→ `pnpm gen:grammars` 冒烟 → `pnpm vitest run && pnpm run typecheck && pnpm lint` → grep 门复跑。

- [ ] **Step 4: 提交**

```bash
git add -A && git commit -m "feat(tools): grammar 构建源头化出库——生成物 .gitignore 出库（languages.toml/build-list/queries/themes/manifest/licenses/generated-extensions）+旧三脚本与 helix-assets 退役+build.mjs gen 前置检查与 cSymbol 交叉验证+gen:sources 脚本链+helix-pin 初始化实跑（gen→fetch 全量源树，cargo 前置就位）"
```

---

### Task 3: server 门禁动态化 + build.rs 缺产物报错（Rust）

**Files:**
- Modify: `server/core/src/compute/queries.rs`（:293-306 门禁测试改写）
- Modify: `server/core/build.rs`（manifest/queries 缺失显式报错 + 文案订正）

**Interfaces:**
- queries.rs 门禁改写（期望数动态——spec §5；partial 跳过形态保持）：
  ```rust
  /// CI 全量门禁（grammar.yml 全源环境断言；partial 本地构建跳过）。
  /// 期望数动态化（spec F §5）：gen-sources 产出即真相——registry 数 ==
  /// grammars-manifest.json 条目数（不再硬编码 301，随 pin refresh 自然增长）。
  #[test]
  fn full_registry_count_matches_manifest() {
      let manifest: serde_json::Value = serde_json::from_str(
          include_str!("../../../grammars-manifest.json"),
      ).expect("grammars-manifest.json 可解析");
      let expected = manifest["grammars"].as_array().expect("grammars 数组").len();
      if generated_count() < expected {
          eprintln!("partial 构建（{}/{expected}），跳过全量门禁", generated_count());
          return;
      }
      assert_eq!(supported_languages().len(), expected);
      assert_eq!(generated_count(), expected);
  }
  ```
  （路径核验：queries.rs 在 server/core/src/compute/ → `../../../grammars-manifest.json` = server/grammars-manifest.json；serde_json 已是 build.rs 依赖面，queries.rs 所在 crate 的 dev-deps 若缺 serde_json 则加。）
- build.rs 生成物缺失显式报错（main 入口、native 门控之后）：
  ```rust
  let manifest_path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../grammars-manifest.json");
  if !manifest_path.exists() {
      panic!("grammars-manifest.json 缺失（构建源头化后不入库）：先跑 pnpm gen:sources（或 node tools/grammar-builder/gen-sources.mjs --refresh）");
  }
  // copy_queries 入口同法：assets/queries 目录缺失 → panic 指向 pnpm gen:sources
  ```
- build.rs 文案订正：头注释（:1-9）「Markpad 301 验收集合」→「gen-sources 从 helix pin 派生的验收集合（期望条目数=manifest 数组长度，动态门禁）」；missing 警告（:72）补 `pnpm gen:sources` 前置指向。

**验收锚**：`cargo test --manifest-path server/Cargo.toml --workspace` 绿（全源环境——T2 的 `--fetch` 已落 out/grammars 全量源树，`full_registry_count_matches_manifest` 实跑非 skip 且 == manifest 条目数）；`cargo clippy --manifest-path server/Cargo.toml --workspace --all-targets -- -D warnings` 绿（CI 同款门禁）；manifest 临时改名模拟缺失 → cargo build 报错文案含 `pnpm gen:sources`（定向验证后复原）。所触 e2e 锚文件=无（server 档 e2e 归 T6 全量）。

- [ ] **Step 1: TDD queries.rs 门禁改写（RED→GREEN）**

临时在 manifest 追加伪造条目验证测试随 manifest 数走（验证后复原）→ RED（旧断言 301）→ 落动态比对 → GREEN。

- [ ] **Step 2: build.rs 缺产物报错 + 文案订正**

两处显式检查 + 头注释/警告文案。Run: `cargo test --manifest-path server/Cargo.toml --workspace && cargo clippy --manifest-path server/Cargo.toml --workspace --all-targets -- -D warnings` → 全绿。

- [ ] **Step 3: 提交**

```bash
git add server/core && git commit -m "feat(server): grammar 门禁动态化——full_registry_count_is_301 改 manifest 条目数对齐（gen-sources 产出即真相，随 pin refresh 自然增长）+build.rs 生成物缺失显式报错指向 pnpm gen:sources"
```

---

### Task 4: CI 重排——setup-grammars gen 前置 + 缓存键、grammar.yml 动态门禁与 artifact 契约、publish 链 gen 供给

**Files:**
- Modify: `.github/actions/setup-grammars/action.yml`（gen 步前置 + cache paths/key 重排）
- Modify: `.github/workflows/grammar.yml`（≥264 → 动态断言；artifact staging 扩 queries/licenses；server-full 测试名）
- Modify: `.github/workflows/ci.yml`（web job `gen-code-extensions.mjs --check` 步删除 + 注释）
- Modify: `.github/workflows/release.yml`（publish-npm 解包 env 两行；publish-packages gen 步）
- Modify: `tools/grammar-builder/pack-npm.mjs`（licenseFile 加 `VV_LICENSE_FILE` env 覆写）
- 核对零改动：`pages-deploy.yml`/`deploy-worker.yml`/`desktop-build-probe.yml`（均经 setup-grammars 自动获得 gen 步；实查无直接调 gen-code-extensions 面）

**Interfaces:**
- setup-grammars action（key 输入换 hash + gen 步）：
  ```yaml
  - name: 缓存 grammar 工具链/源树/产物/生成物
    id: grammars-cache
    uses: actions/cache@v6
    with:
      path: |
        ~/.cache/tree-sitter
        tools/grammar-builder/out/grammars
        tools/grammar-builder/languages.toml
        tools/grammar-builder/build-list.json
        packages/vviewer-highlight/assets/languages.json
        packages/vviewer-highlight/assets/themes.json
        packages/vviewer-highlight/assets/queries
        server/grammars-manifest.json
        server/GRAMMAR_LICENSES.md
        packages/vviewer-core/src/registry/generated-extensions.ts
        apps/web/static/grammars
        apps/web/static/tree-sitter.wasm
      key: grammars-${{ runner.os }}-${{ steps.key.outputs.languages }}-${{ inputs.fetch-only }}-${{ hashFiles('pnpm-lock.yaml', 'tools/grammar-builder/helix-pin.json', 'tools/grammar-builder/aliases.json', 'tools/grammar-builder/gen-sources.mjs', 'tools/grammar-builder/build.mjs') }}
  - name: gen-sources（缓存未命中时从 helix pin 重生成；命中跳）
    if: steps.grammars-cache.outputs.cache-hit != 'true'
    shell: bash
    run: node tools/grammar-builder/gen-sources.mjs
  ```
  **helix-pin.json/aliases.json 不进 cache paths**（入库文件被缓存覆盖即 checkout 失效——Global Constraints 红线）；key 段保留 os/languages/fetch-only（I2 语义不变）。裁量落定=并入现有单缓存不另立 gen 缓存层（spec §6）。头注释 vendored→pin 表述同步。
- grammar.yml 动态门禁（self-build job :39-51 步改写）：
  ```js
  const expected = JSON.parse(fs.readFileSync('server/grammars-manifest.json','utf8')).grammars.length;
  const count = Object.keys(manifest.grammars).length;
  // 单门防双计：fetch 失败被 self-build parser.c-missing 失败条目吸收，等式只算 build 失败清单
  if (count + buildFails.length !== expected) { console.error(`动态门禁不通过：wasm ${count} + build 失败 ${buildFails.length} ≠ manifest ${expected}（gen-sources 产出即真相）`); process.exit(1); }
  ```
  fetch-failures 恒打印；`≥264` 硬编码退役。
- grammar.yml server-full job：`cargo test … full_registry_count_is_301`（:79）→ `full_registry_count_matches_manifest`。
- grammar.yml artifact 契约（§8）：
  ```yaml
  - name: 归集 artifact（grammars + queries + GRAMMAR_LICENSES.md 同根布局）
    run: |
      mkdir -p artifacts/grammar-wasm
      cp -r apps/web/static/grammars/. artifacts/grammar-wasm/
      cp -r packages/vviewer-highlight/assets/queries artifacts/grammar-wasm/queries
      cp server/GRAMMAR_LICENSES.md artifacts/grammar-wasm/
  - uses: actions/upload-artifact@v7
    with:
      name: grammar-wasm
      path: artifacts/grammar-wasm
      if-no-files-found: error
  ```
  （多路径直传 upload-artifact 会按 LCA 重排根结构破坏 publish-npm 解包假设——staging 保布局。）
- release.yml publish-npm「归一版本号」步追加两行 env：
  ```yaml
  echo "VV_QUERIES_DIR=$GITHUB_WORKSPACE/artifacts/grammar-wasm/queries" >> "$GITHUB_ENV"
  echo "VV_LICENSE_FILE=$GITHUB_WORKSPACE/artifacts/grammar-wasm/GRAMMAR_LICENSES.md" >> "$GITHUB_ENV"
  ```
  job 头注释补「publish-npm 不跑 gen：queries/licenses 随 grammar-wasm artifact 下发（spec F §8）」。
- release.yml publish-packages job：逐包构建步（:440-444）之前加 `node tools/grammar-builder/gen-sources.mjs`（highlight npm 源码包 assets 整目录复制含 queries/——Errata ④；gen 无 wasm 依赖、网络面 1-2 次 API + raw 拉取，量级可承受）。
- pack-npm.mjs `resolvePathsFrom`（:54-61）：`licenseFile: env.VV_LICENSE_FILE ?? path.join(repoRoot, 'server/GRAMMAR_LICENSES.md')`；:132 报错文案补「或设 VV_LICENSE_FILE（publish-npm artifact 解包路径）」。

**验收锚**：本地链模拟 `pnpm gen:sources && node tools/grammar-builder/build.mjs --fetch --lite && node tools/grammar-builder/build.mjs --self-build` 绿（=新 setup-grammars 行为的本地等价物）；pack-npm.test.ts 全绿（VV_LICENSE_FILE 注入一例新锚）；全部改动 YAML 经解析器静态自查（`node -e` + 无 js-yaml 依赖时用 `python3 -c "import yaml; yaml.safe_load(open(f))"`）+ 步序走查（gen 在 fetch/self-build 与 typecheck/build 前、cache-hit 跳 gen、pin 不在 cache paths）；**GitHub Actions 真跑验证不在本计划内（不 push）——如实标注待 CI**。所触 e2e 锚文件=无。

- [ ] **Step 1: pack-npm VV_LICENSE_FILE 缝（TDD 小步）**

pack-npm.test.ts 加 env 注入用例 → RED → 落 resolvePathsFrom/env 文案 → GREEN。

- [ ] **Step 2: setup-grammars action 重排 + grammar.yml 两改**

cache id/paths/key + gen 步 + 动态门禁 + server-full 测试名 + artifact staging。

- [ ] **Step 3: ci.yml --check 步退役 + release.yml publish 链两供链**

web job `--check` 步删（门禁语义并入 gen 成功性——spec §3.4 裁量）+ 注释；publish-npm env 两行 + publish-packages gen 步；pages-deploy/deploy-worker/desktop-build-probe 零改动核对记录。

- [ ] **Step 4: 本地链模拟 + YAML 静态自查 + 提交**

```bash
git add .github tools/grammar-builder/pack-npm.mjs tools/grammar-builder/test/pack-npm.test.ts && git commit -m "feat(ci): grammar 构建链 gen 前置——setup-grammars 缓存键换 helix-pin hash+gen 步（命中跳）/grammar.yml ≥264 改 manifest 动态门禁+artifact 附 queries/licenses/publish-npm 解包 env/publish-packages 补 gen 供链/ci --check 步退役（产物不入库）"
```

---

### Task 5: e2e 定向锚注释溯源 + 文档同步 + grep 门复跑

**Files:**
- Modify: `apps/web/e2e/b-code-outline.spec.ts`（:18-19/:338-341 注释溯源更新——OUT-05 载体 ocaml 在新 pin（master HEAD）下 tags.scm 仍 404 实证；断言/选择器零改动）
- Modify: `README.md`（:26 功能行计数复核——「34 语言 lite 集」「301 语言」「342 语言/685 扩展名」与 gen 实产物对齐；gen 后扩展名数若变则同步）
- Modify: `tools/grammar-builder/README.md`（重写：gen-sources 单源 + pin + refresh 流程、生成物出库清单、退役脚本说明、:117「292 条」→ 动态计数、:16/:27/:45-55 服务端集 301→manifest 动态表述、QUERY_PATCHES 溯源迁移自 helix-assets）
- Modify: `docs/spec-deviations.md`（§10 :109-113「vendored languages.toml pinned rev」→「helix-pin commit 派生 gen-sources 产物」表述订正）
- Modify: `tools/grammar-builder/GRAMMARS-NPM-README.md`（若提及 gen-code-extensions/gen-licenses 时序——实查后最小订正）

**Interfaces:** 无代码面——本 task 全为注释/文档/数字对齐。

**验收锚**：`pnpm --filter web exec playwright test b-code-outline` 全绿（OUT 域零翻转——`pnpm --filter web build:e2e` 先行）；文档数字与 gen 实产物一致（`node -p "Object.keys(require('./packages/vviewer-highlight/assets/languages.json')).length"` 等对照）；grep 门两条字面量零命中复跑（T5 后仍零）；`pnpm run typecheck && pnpm lint` 绿。所触 e2e 锚文件=`apps/web/e2e/b-code-outline.spec.ts`。

- [ ] **Step 1: build:e2e + b-code-outline 定向跑（改前基线）→ 注释溯源更新 → 复跑零翻转**
- [ ] **Step 2: 文档四处同步（README 计数对齐 gen 实产物）+ grep 门复跑**

```bash
git add apps/web/e2e/b-code-outline.spec.ts README.md tools/grammar-builder/README.md docs/spec-deviations.md tools/grammar-builder/GRAMMARS-NPM-README.md && git commit -m "docs(tools): 构建源头化文档同步——grammar-builder README 重写（gen-sources/pin/refresh 流程+退役说明+计数动态化）/README 功能行计数对齐/spec-deviations §10 表述订正/b-code-outline OUT-05 注释补新 pin 溯源（ocaml 无 tags 载体不变）"
```

---

### Task 6: 全量门禁与集成验证收尾（控制器执行）

- [ ] **集成全链验证（spec §6，干净树模拟）**：临时 `git worktree add /tmp/vv-f-check HEAD` → worktree 内 `pnpm install --frozen-lockfile` → `pnpm gen:sources` → `node tools/grammar-builder/build.mjs --fetch --lite` → `node tools/grammar-builder/build.mjs --self-build` → `cargo build --manifest-path server/Cargo.toml` → `pnpm --filter web build:e2e` 全链绿（无 /share 依赖——构建源头化后天然成立；`--refresh` 差异报告 mock 形态已由 T1 单测锚 ⑪ 覆盖）；worktree 用后 `git worktree remove`。
- [ ] **全量门禁**：`pnpm lint && pnpm run typecheck && pnpm vitest run`（仓库根全量）→ `pnpm --filter web build:e2e` → playwright 全量双 project（`pnpm --filter web exec playwright test`）→ `pnpm --filter web exec playwright test --config playwright.server.config.ts`（server 档）→ `cargo test --manifest-path server/Cargo.toml --workspace` + `cargo clippy … -D warnings` → `git status --porcelain` 净空（生成物不入库核验）。
- [ ] **grep 门终验**：`rg -n "/share/rw/repo/markpad-aio|/share/rw/repo/github/helix-editor" --hidden -g '!.git' -g '!docs/superpowers/**'` 零命中。
- [ ] 全量 review（superpowers:requesting-code-review，范围=本计划全部 commit），修复全部 C/I/M 后复审；**不 push**（CI 真跑归 push 后，Errata 静态自查边界如实交接）。
- [ ] 台账汇总（规划期记档 ⑩条见 Errata；实施期新增记档随任务报告归集）。

## Errata（执行期勘误）

- 2026-11-17 规划期实查订正（规划师 F，基于 HEAD f673b42；下述每条均系本会话实查/实跑所得，非 spec 转述）：
- ①**manifest 集合公式与 vue 特例订正**（spec §7.3 字面与事实矛盾）：spec 字面「− vendored 特例（vue 走 fixtures 不入清单）」若照办则 manifest=300 ≠「当前值恰 301」。实查：`server/grammars-manifest.json` vue=true、build-list 301=parserC 301、vendored languages.toml 303 [[grammar]]、`use-grammars = { except = ["wren", "gemini"] }`（tools/grammar-builder/languages.toml:10）、server/core/build.rs:195-210 vue scanner.cc 改名特化（server 从源码编译 vue）——落定：**vue 保持入 manifest**，公式 = `[[grammar]] 全集 − use-grammars.except`（303−2=301 逐位吻合）；「vendored 特例」仅指 wasm 通道 fixtures 短路（build.mjs `listVendoredPrebuilts` 既有机制，本计划零改动）。Review Focus 1 锁 manifest 含 vue/不含 wren+gemini。
- ②**spec §3.4「README.md:118『292 条』」文件/行号勘误**：全仓 rg 无 `README.md` 292 命中；实查过时数字实际形态 = `tools/grammar-builder/README.md:117`（「build-list.json：markpad grammar 源快照（292 条…）」）+ `README.md:26` 功能行计数面（34/301/342/685）——T5 统一对齐 gen 实产物。
- ③**aliases 一致性门禁边界落定**（spec §7.3「含 lite 选择面完整性」的可行性收敛）：aliases 36 键中 `objc`/`systemrdl` 不在 helix 清单（现状合法差异，build.mjs:15-16 与 grammar-builder README 既有记录，lite 集产出 34 的口径）——gen 校验落定为「未命中即报错 + `ALIASES_KNOWN_MISSING=['objc','systemrdl']` 白名单告警放行」，硬 fail 会翻转现状。
- ④**publish-packages gen 供链补齐**（spec §8 只修 publish-npm 的漏面）：release.yml:435 注释明载 highlight npm 源码包复制「highlight assets/ 整目录」——出库后 clean checkout 无 queries/ → 包内容静默残缺且 contentHash 漂移无门可拦。落定 publish-packages job 逐包构建前加 gen 步。
- ⑤**queries 拉取范围落定=runtime/queries 整树**（spec §3.2.2「按语言清单拉取」字面不可行）：三消费面按目录形态工作（core-parse.ts:510 目录名即语言键、queries.ts:43 inherits 指令展开、build.rs generated_parents 非语言目录收编）——`ecma`/`_typescript`/`_jsx`/`_javascript`/`php-only` 等父目录必须入树，逐语言过滤断 inherits 链即编译翻红；spec §3.2.2 变体目录映射裁量落定=**整树保形零映射**（gjs/gts 若上游出现同型自然入树）。tags 补源随整树同 pin（TAGS_SOURCES 独立 pin ba40e547 退役）。
- ⑥**OUT-05 载体命运实证（真网探针）**：helix master HEAD `49986e6674e5658164a88f599ec8c822e62ad0db`（2026-11-17 实测 api.github.com）`runtime/queries/ocaml/tags.scm` HTTP 404——b-code-outline.spec.ts OUT-05「无 tags 语言」载体在新 pin 下依然成立，断言零改动仅注释溯源；zig tags.scm HTTP 200（整树拉取后 tags 覆盖扩张面真实）。
- ⑦**gen 实跑预期差异报告锚（真网实测预演 spec §3.5 验证步骤）**：master languages.toml（2026-11-17 下载比对）vs vendored：[[grammar]] 303/[[language]] 342 计数一致、语言集 ±0、rev 变更恰 3 处（yaml → `ikatyang/tree-sitter-yaml`@0e36bed1 仓指回、haskell、qmljs——逐行 diff 23 行）；languages.json 值域字段集 = `{fileTypes, globFileTypes, grammar, injections, scope, shebangs}`（无 aliases 字段、**零 Markpad 增补字段**——spec §3.2.1 builder 必查项落定：派生即真相零注入面）。T2 实跑差异超出此锚即停人工复核。
- ⑧**parserC 探测裁量落定**（spec §3.2.1 两案取后者）：信任 helix 清单不预探测——build-list.json 形态保持 `{name, subpath, parserCExists, helixLang}`（parserCExists 恒 true 语义改注、helixLang=name），build.mjs `resolveTargets`/`planFetch`/`fetchOneGrammar` 零改动（fetchOneGrammar:397/:407 既有 parser.c 探测 + fetch-failures 承接实探）。
- ⑨**tags.scm 同 pin 收编**：现资产树 tags 覆盖 58 目录（find 实测）来自 markpad 转载 + TAGS_SOURCES 8 语补源两层；queries 整树拉取后单层同 pin 覆盖（master ~77 目录），`copyTags`/`TAGS_SOURCES` 机制整体退役；highlight 域 tags 消费用例（queries-remote.test.ts:342 typescript inherits 链）在新树仍成立。
- ⑩**退役零 lockfile 波动 + build.test 依赖面**：pnpm-workspace.yaml 仅 `packages/*`、`apps/*`（tools/* 非 workspace 成员）——删 tools/helix-assets/package.json 不动 pnpm-lock.yaml；build.test.ts:11 `import { buildList, detectParserC, SOURCES } from '../build-list.mjs'`——退役时同步剥离该 import 与对应 describe（build.mjs 侧用例全保留）。
- ⑪**CI 真跑验证边界**：本计划对 workflow 改动仅静态自查（YAML 解析 + 步序走查）；GitHub Actions 真跑（gen 前置冷缓存首跑绿/命中跳 gen——spec §6 CI 锚）须 push 后验证，不 push 纪律下如实标注待 CI，不造假通过。
- ⑫**规划期未跑门禁声明**：本计划为规划产物，vitest/typecheck/cargo/playwright/build:e2e 门禁本体均未运行（规划阶段实查为读文件 + 只读探针 + /tmp 网络探针）；各 task 验收锚在实施期逐 task 兑现。
