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
  - setup-grammars（11 语言）+ svgbob wasm + `pnpm --filter web build`（mock CDN env）+ ripgrep + 语料 fetch + PDF 夹具 + `playwright install --with-deps chromium`（浏览器仍走每 shard 缓存或 prep 传 artifact——**裁量**：浏览器缓存 per-shard 各自命中即可，artifact 体积大不传）；
  - 上传 artifact：`apps/web/build`（+static/grammars 产物已含其中）+ corpus 目录 + PDF 夹具，retention 1 天。
- 各 shard：checkout/pnpm → download artifact → playwright 缓存命中 → 直接 `playwright test --shard=…`（webServer 由 config 自启 preview 伺服下载的 build）。

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
- 用例守恒：总 passed+skipped 数与单 job 基线一致（1228p+118s 口径复核）。
- 前置 job 缓存语义：grammars/浏览器缓存 key 不变仍命中；artifact 传递后 shard 内无重复 build/语料 fetch。

## 6. 留给 builder 的裁量

- prep job vs 首 leg 内联；浏览器安装放 prep 还是各 shard；blob reporter 对本地 `pnpm test:e2e` 工作流的影响（本地保持 line/html 即可，config 按 CI 分支）；merge job 的 artifact 命名与保留期。
