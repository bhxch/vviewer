# CI e2e 并行分片提速 — 设计

日期：2026-11-12　状态：待用户审阅

## 1. 背景与动机（用户诉求）

「e2e 并行，最好能大幅减少 CI 时长」。实测基线：ci.yml e2e job（needs: web 串行门）单 job 跑 95 个 spec × chromium/mobile 双 project = 1228 passed，**40.5 分钟**（run 42340634377 权威口径，`.superpowers/sdd/ci-stabilize-report.md`）；其中纯测试 ~33m，其余为构建/语料/夹具前置。

## 2. 现状锚点

- e2e job 步骤（ci.yml:128-194）：checkout/pnpm/node+cache → Playwright 浏览器缓存 → setup-grammars（11 语言 wasm）→ wasm-bindgen CLI 缓存+svgbob wasm → `pnpm --filter web build`（VV_GRAMMAR_CDN mock env 内联）→ apt ripgrep → `playwright install --with-deps chromium` → 语料 fetch（tools/fetch-e2e-corpus.mjs，幂等可重跑）→ PDF 夹具（setup-uv + gen 脚本）→ `pnpm --filter web exec playwright test` → 失败 trace artifact 上传。
- playwright.config.ts：`workers: process.env.CI ? 1 : 3`（:9）——CI 单 worker 是 2026-10-14 时序收敛裁决（2 核 runner 多 worker 争抢致流式/扫描断言漂红 28 failed→3-4），**保持不动**；retries 1；trace retain-on-failure；webServer vite preview :4173；projects chromium+mobile 全量双跑（10+ 处桌面专属 skip）。
- e2e-server 通道（playwright.server.config.ts，19 文件/91 用例）**不在 CI**（grep 全 workflows 零命中），维持不入。
- Playwright 原生 `--shard=n/m` 与 workers 语义正交：只切用例子集，不改 per-worker 并发——2 核 runner 上 shard×workers1 是稳定并行形态。

## 3. 设计

### 3.1 matrix 分片

- e2e job 改 matrix：`shard: ['1/4','2/4','3/4','4/4']`；命令 `playwright test --shard=${{ matrix.shard }}`；workers 保持 1；`fail-fast: false`（各 shard 独立出真失败面，trace artifact 分 shard 上传目录不冲突）。
- 4 shard 预估：~8m 纯测试 + 前置；若前置不共享则每 shard 各 ~12-14m wall——**配合 §3.2 产物传递后预估 e2e job wall ≤10m**，CI 总时长（web/rust 并行 ~15m + e2e）从 ~45m 压到 ~25m 量级。

### 3.2 前置产物一次构建、分片共享

- 新前置步骤（同 job 内首 leg 或独立 prep job，**裁量**：倾向独立 `e2e-prep` job + artifact 传递，职责清晰且不占 shard 槽）：
  - setup-grammars（11 语言）+ svgbob wasm + `pnpm --filter web build`（mock CDN env）+ **server 二进制预编译** + ripgrep + 语料 fetch + PDF 夹具 + `playwright install --with-deps chromium`（浏览器仍走每 shard 缓存或 prep 传 artifact——**裁量**：浏览器缓存 per-shard 各自命中即可，artifact 体积大不传）；
  - 上传 artifact：**preview 伺服面** `apps/web/.svelte-kit/output`（kit 3 `vite preview` 的实际输入，见 §8 ①）+ **adapter-static 部署产物** `apps/web/build`（产物层断言面与 server `--web-dist` 面，见 §8 ①）+ **仓库树生成物**（§8 ②）+ **预编译 server 二进制**（§8 ③）+ corpus 目录 + PDF 夹具 + **用例清单基线**（§8 ④），retention 1 天。
- 各 shard：checkout/pnpm → download artifact → **消费面自检 + 用例清单守恒校验** → playwright 缓存命中 → 直接 `playwright test --shard=…`（webServer 由 config 自启 preview 伺服下载的 build）。

### 3.3 报告合并

- reporter 改 `[['blob'], ['line']]`（blob 供合并，line 保留实时可读输出）；新增聚合步骤 job（needs: 全部 shard，`if: always()`）：`playwright merge-reports --reporter=html` 输出 HTML artifact；trace 上传保持分 shard（retain-on-failure 不变）。
- 失败分诊面：merge 报告让「哪 shard 哪用例」聚合可见，替代现单 job 全量日志翻找。

### 3.4 稳定性约束（继承既有裁决，不翻案）

- workers=1 维持——分片已提供并行度，不冒时序回归风险（2026-10-14 教训）；PERF-LAZY/IO 类计时预算的 CI 系数不动。
- shard 均衡不特殊处理：Playwright 默认按文件体积均衡分配；首轮实测若某 shard 显著长尾（>1.5× 均值）再调（如 `--shard` 前显式按目录分组，列为后续优化非本期）。

## 4. 目标 / 非目标 / 反目标

- 目标：CI e2e wall ≤10m；总流水线时长大幅下降；失败可分诊（merge 报告）。
- 非目标：e2e-server 通道 CI 化；workers>1；测试集裁剪/跳过策略调整；自建 runner。
- 反目标：为并行引入用例级顺序依赖或全局状态共享假设（现有用例均为独立 profile/独立端口，webServer 每 shard 独立实例——语义天然隔离，无需改造）。

## 5. 验收锚点

- CI 实跑：4 shard 全绿；e2e job wall ≤10m；merge-reports HTML artifact 可打开；失败场景（人为造一红）trace artifact 分 shard 可下载。
- 用例守恒：总 passed+skipped 数与单 job 基线一致（1228p+118s 口径复核）。**自动化形态**（2026-11-17 实施期补，§8 ④）：prep 侧采全量 + 四分片 `--list` 计数并断言 Σ(分片)==全量，分片侧再采本片 `--list` 计数与基线逐项比对（`--list` 会加载全部 spec 文件，生成物/资产表缺失即此步确定性报错）。
- 前置 job 缓存语义：grammars/浏览器缓存 key 不变仍命中；artifact 传递后 shard 内无重复 build/语料 fetch/cargo 编译。
- 仓库树消费面齐备（2026-11-17 实施期补，§8 ②）：prep 侧与分片侧各跑一次 `tools/check-e2e-surfaces.mjs`（同一份清单），缺件即在上传/执行用例前红——而非整文件用例集体 error。

## 6. 留给 builder 的裁量

- 浏览器安装放 prep 还是各 shard；blob reporter 对本地 `pnpm test:e2e` 工作流的影响（本地保持 line/html 即可，config 按 CI 分支）；merge job 的 artifact 命名与保留期。

## 7. builder check 落定（2026-11-13）

- **prep job 不保留 `needs: web` 串行门**（落定，builder check 指出的时长账开关）：prep 与 web/rust 并行起跑（e2e-prep 独立 job），shards `needs: [web, e2e-prep]`——否则总 wall ≈ web+prep+shard ≈ 30m+，§1 目标不可达；代价=web 门失败时 prep 白跑一个 runner 的构建成本，知情接受。
- blob 报告每 shard `if: always()` 上传（merge job 聚合依赖），与 trace 分 shard 上传并存。

## 8. 实施期订正（2026-11-17，分片落地后的 review 定损）

本节记录 spec 实施后 review 实测得出的订正，**spec 正文（§3.2/§3.3/§5）已按本节同步**。来源：spec G 实施期全量 review（分片拓扑首轮 CI 前静态定损）。

① **artifact 伺服面订正**：`apps/web/build` 不是 preview 的输入面。kit 3 的 `vite preview` 伺服 `.svelte-kit/output/{client,server}`（启动即校验 `output/server/manifest.js`），`apps/web/build` 是 adapter-static 的**部署产物**。故两类产物**都需下发**，语义不同：
- `e2e-web-build`（`.svelte-kit/output`）= preview 伺服面（浏览器侧 wasm/queries 等 static 拷贝物在内）；
- `e2e-web-static`（`apps/web/build`）= 部署产物面（`b-sw-runtime-cache` 的 `sw.js` / `_app/immutable` 产物层断言与构建期 env 反查、`b-ext-bindings` 的 env 镜像域反查、`m5`/`m6`/`b-git-panel` 的 server `--web-dist`）。
  两者内容高度重叠但不可互相替代——preview 不读 `build/`（无 `output/server/manifest.js` 即 `preview_build_missing`），而断言面只认 `build/`。

② **仓库树消费面（plan Review Focus 5 的漏盘点）**：plan 只盘了「运行时消费面 = spec 进程读 corpus 相对路径」，漏了三类 spec 进程直读面——①**仓库树生成物**（spec F 出库不入库：`packages/vviewer-core/src/registry/generated-extensions.ts`（9 个 spec 顶层 import 的 barrel 依赖）、`packages/vviewer-highlight/assets/themes.json`（`t-theme` 顶层 `readFileSync`）、`assets/languages.json`（highlight 包 `langdetect` 静态 JSON import））；②**构建产物目录**（`apps/web/build`，见 ①）；③**预编译 server 二进制**（`server/target/debug/vviewer`，`m5`/`m6`/`b-git-panel` 经 `serverHarness` spawn）。
  漏配的后果不是断言红而是**整文件用例 error**（spec 模块求值期抛错）——190 + 26 + 34 + 42 ≈ 292 用例在分片 runner 上加载失败。故三类面固化为显式清单 `tools/check-e2e-surfaces.mjs`，prep 侧（产出面）与分片侧（消费面）各跑一次。

③ **server 二进制预编译下发（分片零 Rust 编译）**：`serverHarness` 原本在 `beforeAll` 跑 `cargo build`——分片内若各自编译即 4 片全量 Rust 编译（grammar 源树全量 1.9GB，且分片无 cargo 缓存），冲掉 §5「e2e job wall ≤10m」锚。故 server 二进制改由 `e2e-prep` 一次编译（**11 语言源集，与旧单 e2e job 内 `cargo build` 逐字一致**）后经 artifact 下发；分片侧 `VV_SERVER_BIN_PREBUILT=1` → `serverHarness` 跳过 `cargo build` 直 spawn。
  分片侧**刻意不下发** `server/grammars-manifest.json` 与 `packages/vviewer-highlight/assets/queries`（二者是 `cargo build.rs` 的编译期输入，分片内不编译 Rust）——下发而无 grammar 源树会让误触发的 `cargo build` 静默产出「0 grammar」partial 构建（无声降级），缺件时 `build.rs` 的 panic（显式指向 `pnpm gen:sources`）才是正确形态。

④ **用例守恒锚的自动化**：§5 的「用例守恒」原为纯人工 CI 侧复核项（plan 诚实边界标「待 push 后验证」，本仓不 push → 长期悬空）。实施期补两道自动门：prep 侧采全量 + 四分片 `--list` 计数并断言 Σ(分片)==全量，分片侧再采本片 `--list` 计数与基线逐项比对。`--list` 会**加载全部 spec 文件**（playwright listMode 任务表不含 plugin setup，webServer 不启动），故任一 spec 模块加载失败在计数比对前即确定性报错——把「整文件用例集体 error」挡在用例执行之前。

⑤ **§3.3 聚合 job 的 `if` 守卫细化**：spec 字面 `if: always()` 在上游 skipped/cancelled 时仍起跑聚合 job（无 blob 可下载必翻红添噪声）。落定 `if: ${{ !cancelled() && needs.e2e.result != 'skipped' }}`——保留 spec 意图（shard 失败也聚合）同时剔除两种空跑面。

⑥ **聚合 job 的 HTML 上传步 `if-no-files-found: warn`（不 error）**：合并步失败即无 `playwright-report` 目录，用 `error` 会以「No files were found」二次翻红——与「合并失败也上传已合成面」的兜底意图相反（兜底不该制造第二个错误）。合并失败的真信号在合并步本身。
