# CI e2e 并行分片提速（e2e-prep 前置产物共享 + matrix 4 分片 + merge-reports 聚合）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 ci.yml e2e job 从单 job 串行（~40.5m wall，run 42340634377 权威口径）改为分片并行（spec G）：①新独立前置 job `e2e-prep`——setup-grammars + svgbob wasm + web build（mock CDN env）+ 语料 fetch + PDF 夹具一次产出，`apps/web/.svelte-kit/output`（build 产物 preview 伺服面）与 corpus 两个 artifact 下发（retention 1 天）；②e2e job 改 matrix `['1/4','2/4','3/4','4/4']`——`playwright test --shard=`、workers 保持 1、fail-fast false、shards `needs: [web, e2e-prep]`（prep 与 web/rust 并行起跑，spec §7 builder check 落定）；③reporter CI 分支 `[['blob'], ['line']]`——blob 每 shard `if: always()` 上传、trace 分 shard 上传（`if: failure()`）并存；④新聚合 job `e2e-report`（`needs: e2e`、失败也聚合）`playwright merge-reports --reporter=html` 出 HTML artifact 供失败分诊。目标：e2e job wall ≤10m、CI 总时长 ~45m → ~25m 量级。

**Architecture:** 三 job 流水——`e2e-prep`（无 needs，与 web/rust 并行）一次完成全部重前置（构建 ~10m 级 + 语料/PDF），产物经 artifact 传递；`e2e`（matrix 4 分片）各自 checkout → download artifact → 浏览器缓存命中 → 直接 `playwright test --shard=…`（webServer 每 shard 独立起 vite preview 伺服下载的 `.svelte-kit/output`，语义与现单 job 同面——playwright.config.ts:18-30 零改动）；`e2e-report` 聚合 blob 出 HTML。playwright.config.ts 仅动 reporter 一处（CI 分支 blob+line、本地维持缺省 list——spec §6 裁量落定）；workers=1/retries=1/trace retain-on-failure/webServer/projects 全部不动（§3.4 稳定性约束继承）。系统级前置（apt ripgrep、playwright --with-deps 的系统依赖）不过 artifact——留在各 shard（Errata ⑦⑧）。

**Tech Stack:** GitHub Actions YAML（upload-artifact@v7 / download-artifact@v8 / actions/cache@v6——仓内既有版本先例）+ Playwright 1.64.0 原生 `--shard` 与 blob/merge-reports 机制 + Conventional Commits。本计划零 `.svelte`/`.svelte.ts`/`.ts` 源码改动（仅 playwright.config.ts reporter 一处 + .gitignore 一行 + ci.yml 重排）。

**Spec:** `docs/superpowers/specs/2026-11-12-e2e-sharding-design.md`（本计划从 spec 论证；实现者两份都读——spec §3 设计、§4 目标/非目标/反目标、§5 验收锚点、§6 裁量与 §7 builder check 落定节同样有效）

## 基线与实施顺序

- **基线**：当前 HEAD `4b5a4c1`（main；工作树 clean——本计划文档自身以 docs(plan) 提交于其上，docs-only 差异、源码面等价；实施者核基线以 4b5a4c1 为准）。spec C/E/A/B/D/I/F 已全部落地含评审修订；spec G 此前零落地（ci.yml:125-195 实查仍为单 e2e job、无 matrix 无 shard；`rg -n "shard" .github/workflows/` 零命中）；本计划全部工作基于该 HEAD 展开。
- **实施顺序**：Task 1 → Task 2 → Task 3，**严格串行**。理由：T1 的 blob reporter 是 T2 分片 blob 上传与 merge-reports 聚合的供体（T2 先落而 blob 未开，merge job 对每个 CI run 空跑翻红）；T2 的 ci.yml 重排消费 T1 落定的 blob 面且是一份 YAML 的原子重构（prep/shards/report 三 job 拆开提交会出现「blob 有上传无聚合」或「merge needs 悬空」的中间态）；T3 收全量门禁与待 CI 台账。
- **grammar 构建链（spec F）条件核查**：本计划**不触及** `tools/grammar-builder`、`build.mjs`、gen-sources 与任何 cargo 生成物——e2e-prep job 仅原样复用 setup-grammars composite action（`.github/actions/setup-grammars/action.yml`，spec F 落定形态：gen 前置 + pin hash 缓存键）与现 e2e job 同输入（ci.yml:147-149 的 11 语言清单逐字保留），无新增构建步。**无需 gen-sources 与 build.mjs --fetch 先行步骤**（零 cargo 依赖、零 grammar 链改动）。
- **不触及 server/（Rust）**：e2e 分片是纯 CI 编排改动，`server/` 零文件改动。
- **UI 文案/i18n/交互组件/a11y 触及面**：**零**——无任何 `.svelte` 组件、i18n 目录键、浮层/菜单/确认通道或样式 token 改动，无 `docs/design/frontend-conventions.md`/`docs/design/semantic-components.md` 前置阅读项。
- **e2e 定向锚文件**：**无**——零 e2e spec 文件改动（机制面改动：config reporter + workflow 编排）。定向验证面=本地分片/blob/merge 机制冒烟（T1）+ 全量回归（T3）。

## Global Constraints

- **拍板项不得偏离**（spec §3/§4/§7 落定）：
  - **matrix 分片**：`shard: ['1/4', '2/4', '3/4', '4/4']`；命令 `playwright test --shard=${{ matrix.shard }}`；**workers 保持 1**（2026-10-14 时序收敛裁决不翻案，playwright.config.ts:9 不动）；`fail-fast: false`（各 shard 独立出真失败面）。
  - **prep/shards 依赖边**（§7 builder check 落定）：**e2e-prep 无 needs**（与 web/rust 并行起跑）；shards `needs: [web, e2e-prep]`。代价=web 失败时 prep 白跑一个 runner 的构建成本，**知情接受**（spec §7 原文）。
  - **artifact 传递**（§3.2 拍板 retention 1 天）：构建产物与语料一次产出、分片共享，retention-days: 1；shard 内**无重复 build/无语料 fetch**（§5 验收锚）。
  - **blob/trace 上传并存**（§7 落定）：blob 每 shard `if: always()` 上传（merge 聚合依赖）；trace 保持 `retain-on-failure` + `if: failure()` 分 shard 上传（名称带 shard 后缀防冲突）。
  - **聚合 job**（§3.3）：needs 全部 shard、失败也聚合出 HTML artifact；trace 分片上传保持不变。
  - **非目标**（§4）：e2e-server 通道 CI 化（playwright.server.config.ts 在 workflows 零命中实查维持）、workers>1、测试集裁剪/跳过策略调整、自建 runner。
  - **反目标**（§4）：为并行引入用例级顺序依赖或全局状态共享——现有用例独立 profile/独立端口、webServer 每 shard 独立实例，**零改造**。
  - **稳定性约束**（§3.4）：shard 均衡不特殊处理（Playwright 按文件体积均衡分配——规划期实测四片 443/~442/~442/441，见 Errata ③）；`--shard` 前显式目录分组等重均衡列为后续优化非本期。
- **裁量落定**（spec §6 三项，全部内联）：
  - **浏览器安装**：prep 不装浏览器（无测试执行面）；各 shard `actions/cache` 恢复 `~/.cache/ms-playwright`（key 与现 e2e job :140-141 逐字一致）+ `playwright install --with-deps chromium`（缓存命中省二进制下载；`--with-deps` 的 apt 系统依赖每 shard 必装——系统级变更不过 artifact，Errata ⑦）。artifact 不传浏览器（体积大，spec §3.2 倾向落定）。
  - **blob reporter 本地影响**：本地（无 `CI` env）维持缺省 reporter（playwright 1.64 缺省 = `process.env.CI ? 'dot' : 'list'`，lib/runner/index.js:573）——config 三元分支本地落 `[['list']]` 显式等价现状，**不产 blob**；`blob-report/` 目录仅 CI 运行写盘，gitignore 收编防误提交。
  - **merge job artifact 命名与保留期**：HTML 报告 `e2e-html-report` retention **14 天**（失败分诊主载体，比 trace 的 7 天长——分诊面常回头查）；blob `blob-report-<shard>` retention **1 天**（合并原料，合并后无用）。
- **门禁口径**：vitest 一律在**仓库根**跑（包目录直跑缺 jsdom）；typecheck 仓库根 `pnpm run typecheck`；重建 web 一律 `pnpm --filter web build:e2e`（裸 build 冲掉 CDN 注入——**仅本地门禁语境**；CI prep job 的 build 步保留现 e2e job :167-169 的 env 内联形态，与 build:e2e 等值）；playwright 一律 `pnpm --filter web exec playwright test …`（根 package.json 无 playwright devDep）。
- **commit 纪律**：Conventional Commits（feat/test/docs… 中文主题）、原子化；`git status --porcelain` 自查净空再 add（不按记忆清单）；**一律不得 git push**。
- **CI 验证的诚实边界**：workflow YAML 只能本地静态自查（PyYAML 解析 + 步序走查）；GitHub Actions 真跑（4 片全绿 / e2e wall ≤10m / artifact 传递 / merge HTML 可打开 / trace 分片下载 / 用例守恒 CI 侧复核 / 缓存命中语义）**须 push 后验证、不在本计划内**——相关验收锚如实标注「静态自查 + 待 CI」（spec F Errata ⑪ 同款边界，不造假通过）。

## Review Focus

1. **artifact 伺服面 = `.svelte-kit/output` 而非 `build/`**（规划期机制订正，Errata ①——spec §3.2 字面「上传 artifact：apps/web/build」照办则分片 webServer 起不来）：kit 3 的 `vite preview` 伺服 `.svelte-kit/output/{client,server}`（`@sveltejs/kit/src/exports/vite/preview/index.js:40-41` 启动即检查 `output/server/manifest.js` 存在、缺失直接 `preview_build_missing` 报错；:81-92 sirv 伺服 `output/client`；:109-113 伺服 `output/prerendered/{dependencies,pages}`——本项目无 prerendered 目录，sirv 对缺目录恒 404 属现状形态零变化），`apps/web/build/` 是 adapter-static 的**部署产物**、非 preview 输入。换静态伺服面（sirv build/ 等）被 playwright.config.ts:19-26「残余 A10 处置备案」明确排除（换面需 1228 锚全量重验）。**上传与下载双侧同路径**（upload `apps/web/.svelte-kit/output` ↔ download `path: apps/web/.svelte-kit/output`）保证 artifact 根布局约定无关性。
2. **merge job 的 `if` 守卫**（spec §3.3 字面 `if: always()` 的形式细化，Errata ⑤）：`always()` 在上游 **skipped/cancelled** 时也让聚合 job 起跑——无 blob artifact 可下载必然翻红，给 web/prep 失败的 run 添噪声。落定 `if: ${{ !cancelled() && needs.e2e.result != 'skipped' }}`——保留 spec 意图（**shard 失败也聚合**，failure 结果不被 cancelled/skip 吞）同时去掉两种空跑面。
3. **artifact 名合法性**（Errata ⑥）：`matrix.shard` 值含 `/`，GitHub artifact name 不允许——shard job 首步经 bash `tr` 归一 `SHARD_NAME`（`1/4`→`1-4`）写入 `GITHUB_ENV`，blob/trace 两个上传名用 `${{ env.SHARD_NAME }}` 后缀；`--shard=` 参数用原值 `matrix.shard`。
4. **blob 产物机制锚**（Errata ④，playwright@1.64.0 源码实证）：blob reporter 默认 outputDir = `blob-report`（相对 config 目录 = apps/web → `apps/web/blob-report/`）、文件名 = `report[-<commandHash>]-<shard 补零>.zip`（`_defaultReportName`：shard 段按 `shard.total` 位数补零——四分片即 `report-1.zip`…`report-4.zip`；**commandHash 段仅在有过滤参数时存在**——`computeCommandHash`（lib/runner/index.js:5444）在 projectFilter/locations/grep/tags 全空时 hash 为 undefined → 无 hash 段）；**每跑先 `removeFolders([outputDir])`**——本地四连跑累积需 `PWTEST_BLOB_DO_NOT_REMOVE=1`（lib/runner/index.js:3147 实锚），CI 每 runner 单跑无此需求。merge-reports 从目录聚合多 zip（`extractAndParseReports`），html 输出经 `PLAYWRIGHT_HTML_OUTPUT_DIR` env 钉绝对路径（lib/runner/index.js:3684）。
5. **shard 内零重复前置**（§5 缓存语义锚）：shard 步序中**不得出现** setup-grammars / `pnpm --filter web build` / fetch-e2e-corpus / gen pdf / gen:svgbob-wasm 任何一步——wasm 与引擎产物已随 `.svelte-kit/output/client` 下发（build 期 static/ 拷贝：grammars/tree-sitter.wasm/queries 均在 client 树内），语料经 corpus artifact 下发（运行时消费面=spec 进程 readFileSync `apps/web/e2e/fixtures/corpus/` 相对路径——b-md-corpus-markpad.spec.ts:42/:91 实锚，artifact 还原路径与现单 job 完全一致）。步序走查逐条核对（T2 验收锚）。
   **实施期订正（Errata ⑩）**：本条盘点只覆盖「运行时消费面 = corpus 相对路径」，漏了三类 spec 进程直读面（仓库树生成物 / adapter-static 产物目录 / 预编译 server 二进制）——「零重复前置」的正确形态不是「分片内什么都不产出」，而是「分片内不产出**任何 spec 进程会直读的东西**」；三类漏配面的补齐与护栏见 Errata ⑩ 与 spec §8。
6. **既有 e2e 运行语义零变化**：workers=1（CI）、retries=1、trace retain-on-failure、webServer vite preview :4173 strictPort、chromium+mobile 双 project、`reuseExistingServer: !process.env.CI`——playwright.config.ts 除 reporter 外逐字节不动；T3 全量回归（无分片本地全量跑）为本判据的兑现面。

---

### Task 1: playwright.config reporter CI 分支（blob+line）+ gitignore + 本地分片/blob/merge 机制冒烟

**Files:**
- Modify: `apps/web/playwright.config.ts`（新增 `reporter` 一处三元分支 + 注释；其余配置逐字节不动）
- Modify: `.gitignore`（`apps/web/blob-report/` 一行，贴近既有 `apps/web/test-results/`（:10）/`apps/web/playwright-report/`（:11）块——merge html 本地冒烟产物已被 :11 覆盖，无需新增）

**Interfaces:**
- playwright.config.ts（:9 workers 行后、`use` 块前插入）：
  ```ts
  // spec G §3.3：CI 双 reporter——blob 供 e2e-report job merge-reports 聚合（每分片
  // 落 apps/web/blob-report/report-0X.zip，随分片 artifact 上传），line 保留实时可读
  // 输出（原 CI 缺省为 dot，playwright lib/runner/index.js:573）；本地维持缺省 list
  // 不产 blob——blob 落盘/上传是纯 CI 消费面（spec §6 裁量：本地不承担合并供体）。
  reporter: process.env.CI ? [['blob'], ['line']] : [['list']],
  ```
- 本地机制冒烟协议（验证步骤非断言面——全部命令在本 task 执行并记录输出）：
  1. 分片过滤与均衡锚：`pnpm --filter web exec playwright test --list --shard=1/4 | tail -1`（规划期锚 443 tests / 46 files）与 `--shard=4/4`（441 / 55 files）——四片和 = 全量 1768（规划期实锚，见 Errata ②③；实施期若 HEAD 有变则以当次 `--list` 全量为守恒分母重记）。
  2. blob 落盘 + shard 过滤语义：`CI=true pnpm --filter web exec playwright test --shard=1/4 m1` → 输出 `Running 1 test using 1 worker, shard 1 of 4`（m1 全量 2 用例、shard 1 恰跑 1 个——过滤语义实锚）且 `apps/web/blob-report/report-1.zip` 在盘（四分片：shard 段按 total 位数补零 → 单数字；无过滤参数 → 无 hash 段）。规划期预跑已验证 running 行与 1 passed（blob 尚未实现故无 zip——本 task 落 config 后 zip 必在盘，为 RED→GREEN 判据）。
  3. 四片累积：`PWTEST_BLOB_DO_NOT_REMOVE=1` 依次 `--shard=2/4 m1`、`--shard=3/4 m1`、`--shard=4/4 m1`（CI=true）→ `apps/web/blob-report/` 四个 zip 共存（Review Focus 4 的 removeFolders 语义）。
  4. 聚合冒烟：`pnpm --filter web exec playwright merge-reports --reporter=html blob-report`（cwd=apps/web 经 --filter exec）→ `apps/web/playwright-report/index.html` 在盘（gitignore :11 已覆盖）。
  5. 本地形态不变锚：清空 `apps/web/blob-report/` 后跑非 CI 形态 `pnpm --filter web exec playwright test --shard=1/4 m1`（无 CI env）→ blob-report 目录**不再**出现（本地工作流零变化判据）。

**验收锚**：冒烟协议 1-5 全部执行且结果与预期逐条吻合（zip 在盘/四 zip 共存/html 产出/本地无 blob）；`pnpm run typecheck` 绿（config 改动类型面）；`pnpm lint` 绿；`git status --porcelain` 仅含本 task 两文件（blob-report 未进 untracked 区=gitignore 生效核验）。所触 e2e 锚文件=无。

- [ ] **Step 1: config reporter 分支 + .gitignore**

按 Interfaces 落 config 三元与注释；.gitignore 加 `apps/web/blob-report/`。

- [ ] **Step 2: 冒烟协议 1-5 逐条执行并记录**

RED 判据=Step 2.2 先跑（blob 缺 config 时无 zip）→ 落 config → 复跑 GREEN。所有输出原样记入任务报告（诚实纪律：命令与输出成对记录）。

- [ ] **Step 3: 提交**

```bash
git add apps/web/playwright.config.ts .gitignore && git commit -m "test(e2e): playwright reporter CI 分支——blob（分片合并供体，report-0X.zip 落 apps/web/blob-report）+line（实时输出）双 reporter 替代 CI 缺省 dot，本地维持缺省 list 不产 blob；blob-report 目录 gitignore（spec G §3.3/§6）"
```

---

### Task 2: ci.yml 重排——e2e-prep 独立前置 job + e2e matrix 4 分片（artifact 消费）+ e2e-report 聚合 job

**Files:**
- Modify: `.github/workflows/ci.yml`（单 e2e job（:125-195）重构为 e2e-prep / e2e（matrix）/ e2e-report 三 job；头注释（:1-5）补分片描述；web/rust 两 job 零改动）

**Interfaces:**
- **e2e-prep job**（插在 rust job 后；**无 needs**——§7 落定与 web/rust 并行起跑）：
  ```yaml
  e2e-prep:
    name: e2e-prep（构建 + 语料，供分片共享）
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - uses: pnpm/action-setup@v6
      - uses: actions/setup-node@v7
        with: { node-version: 22, cache: pnpm }
      - run: pnpm install --frozen-lockfile
      # 与现 e2e job（ci.yml:147-149）逐字一致的 11 语言输入（缓存键不变=仍命中，§5 锚）
      - uses: ./.github/actions/setup-grammars
        with:
          languages: javascript,typescript,bash,html,css,json,python,rust,java,yaml,ocaml
      # wasm-bindgen CLI 缓存 + svgbob wasm（现 e2e job :153-166 原样迁入——build 前置）
      - uses: actions/cache@v6
        with:
          path: ~/.cache/svgbob/wasm-bindgen-cli
          key: wasm-bindgen-cli-${{ runner.os }}-${{ hashFiles('packages/vviewer-render-diagram/tools/svgbob-wasm/Cargo.toml') }}
      - uses: dtolnay/rust-toolchain@stable
        with: { targets: wasm32-unknown-unknown }
      - uses: Swatinem/rust-cache@v2
        with: { workspaces: packages/vviewer-render-diagram/tools/svgbob-wasm }
      - run: pnpm gen:svgbob-wasm
      # build env 内联形态与现 e2e job :167-169 逐字一致（mock CDN，不依赖外网）
      - run: pnpm --filter web build
        env:
          VV_GRAMMAR_CDN: https://cdn.grammars.test/grammars/
      # 语料 fetch（幂等可重跑）+ PDF 夹具（现 e2e job :177-184 原样迁入）
      - run: node tools/fetch-e2e-corpus.mjs
        env:
          GITHUB_TOKEN: ${{ github.token }}
      - uses: astral-sh/setup-uv@v6
      - run: uv run tools/gen-e2e-pdf-linearized.py
      # artifact ①：preview 伺服面（Review Focus 1——Errata ① 订正自 spec 字面 build/）
      - uses: actions/upload-artifact@v7
        with:
          name: e2e-web-build
          path: apps/web/.svelte-kit/output
          retention-days: 1
          if-no-files-found: error
      # artifact ②：语料 + PDF 夹具（pdf-linearized 在 corpus 树内一并覆盖）
      - uses: actions/upload-artifact@v7
        with:
          name: e2e-corpus
          path: apps/web/e2e/fixtures/corpus
          retention-days: 1
          if-no-files-found: error
  ```
- **e2e job**（matrix 4 分片；原 :128-195 全量替换）：
  ```yaml
  e2e:
    name: e2e（Playwright chromium ${{ matrix.shard }}）
    runs-on: ubuntu-latest
    needs: [web, e2e-prep]
    strategy:
      fail-fast: false
      matrix:
        shard: ['1/4', '2/4', '3/4', '4/4']
    steps:
      - uses: actions/checkout@v7
      - uses: pnpm/action-setup@v6
      - uses: actions/setup-node@v7
        with: { node-version: 22, cache: pnpm }
      - run: pnpm install --frozen-lockfile
      # matrix.shard 含 '/' 不合法于 artifact name——归一为 SHARD_NAME（1/4→1-4）
      - name: 归一分片名（artifact name 合法化）
        run: echo "SHARD_NAME=$(printf '%s' '${{ matrix.shard }}' | tr '/' '-')" >> "$GITHUB_ENV"
      # 分片共享前置产物（Review Focus 5：零 setup-grammars/零 build/零语料步）
      - uses: actions/download-artifact@v8
        with:
          name: e2e-web-build
          path: apps/web/.svelte-kit/output
      - uses: actions/download-artifact@v8
        with:
          name: e2e-corpus
          path: apps/web/e2e/fixtures/corpus
      # 浏览器缓存 key 与原 e2e job :140-141 逐字一致（§5 缓存语义锚）
      - uses: actions/cache@v6
        with:
          path: ~/.cache/ms-playwright
          key: playwright-${{ runner.os }}-${{ hashFiles('pnpm-lock.yaml') }}
      - run: pnpm --filter web exec playwright install --with-deps chromium
      # 系统级前置不过 artifact：ripgrep 每分片自装（Errata ⑧）
      - run: sudo apt-get update && sudo apt-get install -y ripgrep
      # webServer 每 shard 独立起 vite preview（config 零改动伺服下载的 build）
      - run: pnpm --filter web exec playwright test --shard=${{ matrix.shard }}
      # blob 每 shard always 上传（§7 落定——merge 聚合依赖）；硬失败无 blob 时 ignore 防红噪声
      - uses: actions/upload-artifact@v7
        if: always()
        with:
          name: blob-report-${{ env.SHARD_NAME }}
          path: apps/web/blob-report
          retention-days: 1
          if-no-files-found: ignore
      # trace 保持 retain-on-failure + failure 上传，名称分片化防覆盖
      - uses: actions/upload-artifact@v7
        if: failure()
        with:
          name: playwright-traces-${{ env.SHARD_NAME }}
          path: apps/web/test-results/
          retention-days: 7
          if-no-files-found: ignore
  ```
- **e2e-report job**（聚合，Errata ⑤ 的 if 守卫）：
  ```yaml
  e2e-report:
    name: e2e 报告合并（merge-reports HTML）
    runs-on: ubuntu-latest
    needs: [e2e]
    # spec §3.3「失败也聚合」意图的形式细化（Errata ⑤）：failure 也跑，skipped/cancelled 不跑
    if: ${{ !cancelled() && needs.e2e.result != 'skipped' }}
    steps:
      - uses: actions/checkout@v7
      - uses: pnpm/action-setup@v6
      - uses: actions/setup-node@v7
        with: { node-version: 22, cache: pnpm }
      - run: pnpm install --frozen-lockfile
      # 四分片 blob 合流入一目录（pattern + merge-multiple：v4+ 能力，仓内 release.yml
      # 已有 download-artifact@v8 先例；静态自查覆盖此用法）
      - uses: actions/download-artifact@v8
        with:
          pattern: blob-report-*
          merge-multiple: true
          path: apps/web/blob-report
      # cwd=apps/web（--filter exec）——dir 参数相对 cwd；html 输出 env 钉绝对路径
      #（Review Focus 4：lib/runner/index.js:3684）
      - name: 合并分片 blob 报告为 HTML
        run: pnpm --filter web exec playwright merge-reports --reporter=html blob-report
        env:
          PLAYWRIGHT_HTML_OUTPUT_DIR: ${{ github.workspace }}/apps/web/playwright-report
      - uses: actions/upload-artifact@v7
        if: always()
        with:
          name: e2e-html-report
          path: apps/web/playwright-report
          retention-days: 14
          if-no-files-found: error
  ```
- 头注释（ci.yml:1-5）追加一行：`# E2E 分片（spec G）：e2e-prep 一次构建/语料 → 4 分片 artifact 共享 → e2e-report 聚合 HTML；workers=1 维持（2026-10-14 裁决）。`

**验收锚**：①PyYAML 全文件解析：`python3 -c "import yaml; yaml.safe_load(open('.github/workflows/ci.yml')); print('yaml ok')"` 通过（T2 后复跑）；②步序走查逐条核对（e2e-prep 无 needs / e2e needs 两值+fail-fast false+matrix 四值 / shard 步序零构建零语料步（Review Focus 5）/ artifact 双侧路径一致（upload=download）/ 浏览器与 rg 缓存与安装步在 shard / blob always+ignore、trace failure+7 天、html always+14 天+error / e2e-report if 守卫与 pattern+merge-multiple 用法）；③缓存键不变锚：setup-grammars 输入（11 语言清单逐字）与 playwright/wasm-bindgen 两个 cache key 与原文件 diff 对照逐字一致（`git diff .github/workflows/ci.yml` 人工走查）；④`git status --porcelain` 仅 ci.yml 一文件；⑤**待 CI 清单**（诚实边界）：4 片全绿、e2e wall ≤10m、artifact 传递成功（e2e-web-build ~35MB 压缩实测锚——Errata ②）、merge HTML artifact 可打开、人为造一红场景 trace 分片可下载、CI 侧用例守恒（merge 报告 total == 同 HEAD 单跑全量基线）、prep/shard 缓存命中复核——全部标注待 push 后验证。所触 e2e 锚文件=无。

- [ ] **Step 1: ci.yml 三 job 重构 + 头注释**

按 Interfaces 落三 job（原 e2e job :125-195 删除替换）；web/rust job 零触碰；头注释补分片描述。

- [ ] **Step 2: 静态自查 + 步序走查 + 提交**

PyYAML 解析 + 验收锚 ②③ 逐条走查（`git diff` 对照原文件核缓存键逐字一致）。全绿后提交：

```bash
git add .github/workflows/ci.yml && git commit -m "feat(ci): e2e 并行分片——e2e-prep 独立前置 job（setup-grammars+svgbob+build mock CDN+语料+PDF 一次产出，web-build/corpus 双 artifact retention 1 天，与 web/rust 并行起跑）+e2e matrix 4 分片（--shard/workers1/fail-fast false/零重复前置 artifact 消费/浏览器缓存每分片）+e2e-report 聚合（merge-reports HTML artifact 14 天，失败也聚合）+blob/trace 分片上传（spec G §3/§7）"
```

---

### Task 3: 全量门禁与收尾（控制器执行）

- [ ] **本地全量门禁**：`pnpm lint && pnpm run typecheck && pnpm vitest run`（仓库根全量）→ `pnpm --filter web build:e2e`（语料/PDF 夹具本地已在盘——`apps/web/e2e/fixtures/corpus/` 8.7M 与 `pdf-linearized/progressive.pdf` 实查；缺失时先 `node tools/fetch-e2e-corpus.mjs` + `uv run tools/gen-e2e-pdf-linearized.py`，均幂等）→ playwright 本地全量双 project **无分片**（`pnpm --filter web exec playwright test`——Review Focus 6 判据：reporter 分支后本地运行语义零变化 + 全量基线守恒分母，总用例数对比 T1 的 `--list` 锚 1768）。
- [ ] **分片机制终验（本地等价 CI 形态，定向小域）**：`CI=true pnpm --filter web exec playwright test --shard=1/4 m1 m2`（小域两文件——全量四片真跑 ≈ CI wall，不在本地复刻，归 CI）→ blob 落盘 + line 输出 + shard 行提示（`shard 1 of 4`）正常即收。
- [ ] `git status --porcelain` 净空（blob-report/playwright-report 均在 gitignore——生成物不入库核验）。
- [ ] 全量 review（superpowers:requesting-code-review，范围=本计划全部 commit），修复全部 C/I/M 后复审；**不 push**（CI 真跑归 push 后，待 CI 清单如实交接——Global Constraints 诚实边界）。
- [ ] 台账汇总（规划期记档 ⑨ 条见 Errata；实施期新增记档随任务报告归集）。

## Errata（执行期勘误）

- 2026-11-17 规划期实查订正（规划师 G，基于 HEAD 4b5a4c1；下述每条均系本会话实查/实跑所得，非 spec 转述；规划期门禁本体未运行——vitest/typecheck/build:e2e/playwright 全量均未跑，实查面=读文件 + 只读探针 + 三次本地 playwright 探针，各 task 验收锚在实施期逐 task 兑现）：
- ①**artifact 伺服面订正（spec §3.2 字面「上传 artifact：apps/web/build」不可行）**：kit 3 `vite preview` 伺服 `.svelte-kit/output/{client,server}`——实查 `node_modules/@sveltejs/kit/src/exports/vite/preview/index.js`：:40-41 启动即检查 `.svelte-kit/output/server/manifest.js` 存在（缺失 `preview_build_missing` 报错）、:81-92 sirv 伺服 `output/client`（含 static/ 拷贝物：grammars/tree-sitter.wasm/queries/icons）、:109-113 伺服 `output/prerendered/{dependencies,pages}`（本项目 output 下实查仅 client/server 两目录、无 prerendered——现状形态零变化）；`apps/web/build/`（108M）是 adapter-static 部署产物、preview 不读。换静态伺服面被 playwright.config.ts:19-26「残余 A10 处置备案」排除（换面需 1228 锚全量重验）。落定 artifact=`apps/web/.svelte-kit/output`（本地 tar czf 实测压缩 35MB——artifact 可承受），upload/download 双侧同路径保根布局约定无关。
- ②**基线计数订正（spec §1/§5「95 spec × 1228 passed + 118 skipped」为 run 42340634377 时点值，已过时）**：当前 HEAD 实测 `pnpm --filter web exec playwright test --list` = **1768 tests in 101 files**（chromium+mobile 双计；spec A/B/D/I 落地新增 b-shell-toc/b-touch-profile/b-markdown-links-media/b-git-remote-mounts/b-md-corpus-multisource 等域）。守恒锚语义不变、分母更新：**同 HEAD 单跑全量 = 四片和**（本地 `--list` 四片计数锚=T1 冒烟 1；CI 侧 merge 报告 total 对照，待 CI）。
- ③**shard 均衡已达标（§3.4 无需预留动作）**：`--list --shard=1/4` = 443 tests / 46 files、`--shard=4/4` = 441 / 55 files（实跑）——四片 441-443（2/4、3/4 各 ~442，和恒 1768），Playwright 文件体积均衡分配天然成立；首轮 CI 只需复核时长尾部（>1.5× 均值再触发 spec §3.4 预留的重均衡，非本期）。
- ④**blob/merge 机制源码锚（playwright@1.64.0 实查）**：blob reporter 默认 outputDir=`blob-report`（相对 config 目录=apps/web）、文件名 `report-<shard补零>.zip`（`_defaultReportName` 按 `config.shard.current`）；每跑 `removeFolders([outputDir])` 清空（:3147）——本地多片累积冒烟须 `PWTEST_BLOB_DO_NOT_REMOVE=1`，CI 每 runner 单跑无此需求；merge-reports 经 `extractAndParseReports(dir)` 聚合目录内多 zip；html 输出可用 `PLAYWRIGHT_HTML_OUTPUT_DIR` env 钉路径（lib/runner/index.js:3684）。缺省 reporter = `process.env.CI ? 'dot' : 'list'`（lib/runner/index.js:573）——T1 的 CI 分支把 dot 换 line+blob，本地显式 `[['list']]` 等价现状。
- ⑤**merge job `if` 守卫细化（spec §3.3 字面 `if: always()` 的空跑面）**：上游 skipped/cancelled 时 `always()` 仍起跑聚合 job——无 blob artifact 可下载必然翻红，给 web/prep 失败的 run 添红噪声。落定 `if: ${{ !cancelled() && needs.e2e.result != 'skipped' }}`：保留「shard 失败（failure）也聚合」的 spec 意图，剔除两种空跑面。
- ⑥**artifact 名合法性**：`matrix.shard` 值含 `/`，GitHub artifact name 禁 `/`——shard job 首步 `tr '/' '-'` 归一 `SHARD_NAME` 写 `GITHUB_ENV`，上传名后缀化（`blob-report-1-4`）；`--shard=` 参数保持原值 `matrix.shard`。
- ⑦⑧**系统级前置不过 artifact（prep/shard 分工依据）**：artifact 只传文件不传系统态——①浏览器：prep 不装（无测试面）；shard 各自 cache 恢复 + `playwright install --with-deps chromium`（缓存命中省二进制下载、apt 系统依赖每 shard 必装，spec §6 倾向落定）；②ripgrep：m6 远程 rg 通道健康断言依赖 runner 提供 rg（ci.yml:171-172 原注释）——apt 安装步留在各 shard。
- ⑨**本地分片机制探针（规划期实跑记录）**：①`--list` 全量 1768/101 files、`--list --shard=1/4|4/4` 443/441；②`CI=true pnpm --filter web exec playwright test --shard=1/4 m1` 真跑通过：输出 `Running 1 test using 1 worker, shard 1 of 4`、`1 passed (4.3s)`——m1 全量 2 用例 shard1 恰跑 1 个（--shard 过滤语义实证）+ 本地既有 `.svelte-kit/output`（spec F 期 build）被 vite preview 正常伺服（测试过=伺服链实证）；③该探针时点 blob 未实现（config 改动属 T1）故无 blob-report 落盘——T1 Step 2 以「config 落后 zip 必现」为 RED→GREEN 判据。
- ⑩**Review Focus 5 的漏盘点与补齐（2026-11-17 实施期 review 定损，重要级）**：Review Focus 5 把「shard 内零重复前置」推成硬约束（shard 步序不得出现 setup-grammars / build / 语料 fetch / gen pdf / gen:svgbob-wasm），并断言「artifact 还原路径与现单 job 完全一致」——但该盘点只覆盖「运行时消费面 = spec 进程 readFileSync `apps/web/e2e/fixtures/corpus/` 相对路径」，漏了三类 spec 进程直读面：
  - **仓库树生成物**（spec F 出库不入库）：`packages/vviewer-core/src/registry/generated-extensions.ts`（`@bhxch/vviewer-core` barrel 顶层导出，9 个 spec 顶层 import）、`packages/vviewer-highlight/assets/themes.json`（`t-theme.spec.ts` 顶层 `readFileSync`，模块求值期）、`assets/languages.json`（highlight 包 `langdetect.ts` 静态 JSON import）；
  - **构建产物目录**：`apps/web/build`（adapter-static 部署产物——`b-sw-runtime-cache` 产物层断言与构建期 env 反查、`b-ext-bindings` env 镜像域反查、`m5`/`m6`/`b-git-panel` 的 server `--web-dist`）；
  - **预编译 server 二进制**：`server/target/debug/vviewer`（`serverHarness` 的 `cargo build` + spawn）。

  实测后果（三类漏配合计量 ≈ 292/1768 ≈ 16.5% 用例）：缺生成物/资产表 → spec 模块求值期抛错 → **整文件用例 error**（9 个 spec 190 例 + t-theme 26 例）；缺 `apps/web/build` → 产物层断言 ENOENT/404（34 例）+ `b-ext-bindings` 的 env 层锚静默退化为「未注入」兜底；缺 manifest/queries → `server/core/build.rs` panic → `m5`/`m6`/`b-git-panel` 的 `beforeAll` 失败（42 例），且即便 manifest 在位，分片内各自全量编译 Rust 亦冲掉「e2e job wall ≤10m」锚。

  **补齐方案（落地形态）**：①「零重复前置」的正确形态是「分片内不产出任何 spec 进程会直读的东西」——三类漏配面各由一个 artifact 补齐：仓库树生成物（`e2e-repo-tree`）、adapter-static 产物（`e2e-web-static`）、预编译 server 二进制（`e2e-server-bin`，prep 侧 11 语言源集一次编译，与旧单 job 内 `cargo build` 逐字一致；分片侧 `VV_SERVER_BIN_PREBUILT=1` → `serverHarness` 跳过编译）；②三类面固化为显式清单 `tools/check-e2e-surfaces.mjs`，prep 侧（产出面）与分片侧（消费面）各跑一次，缺件即在上传/执行用例前红；③§5「用例守恒」锚自动化（`tools/e2e-list-guard.mjs`：prep 侧采全量 + 四分片 `--list` 计数并断言 Σ(分片)==全量，分片侧逐项比对——`--list` 会加载全部 spec 文件，模块加载失败即此步确定性报错）。详见 spec §8。

  **本条的教训面（供后续计划复用）**：凡「把某类产物从 job A 移到 job B 经 artifact 传递」的改造，必须盘点 **A 侧工作树里被 A 内进程直读的全部路径**（不止「构建产物」与「运行时输入」两类），并把该盘点固化成可执行清单——否则「产物传递」只覆盖了消费面的一部分，缺件形态是「整文件用例 error」而非断言红，人工从 CI 日志回查成本极高。
