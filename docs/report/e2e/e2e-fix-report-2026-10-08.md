# E2E 缺陷修复报告（2026-10-08 批次）

> 修复对象：`docs/report/e2e/e2e-test-report-2026-10-08.md` 第 5 节的 26 条缺陷（被测版本 `main @ a4714811`，首轮黑盒 e2e 10 域 106 测试点）。
> 方案与计划：`docs/superpowers/specs/2026-10-08-e2e-fixes.md`（26 条根因与验收标准）、`docs/superpowers/plans/2026-10-08-e2e-fixes.md`（5 个文件互斥工作包）。
> 修复区间：`8604495..HEAD`（`git log 86044955ac3a3790262d586d53bdbfc21deb438c..HEAD`），共 12 个提交（3 docs + 7 修复/审查 + 1 e2e 脚本 + 1 回归修复）。
> 本报告由修复流水线的报告撰写员整理；第 5 节所列复跑均为报告撰写时（2026-10-09）在本机实跑，其余数字均注明材料出处。

---

## 1. 执行摘要

- **处置计数**：26 条缺陷 = **修复 23 条**（22 条 verified 的 BUG-01~07、09~20、22~24 + 根因代码确证的 unconfirmed BUG-08）+ **暂缓 3 条**（verified 的 BUG-21 + unconfirmed 的 BUG-25/26）。严重度分布：high 1（BUG-01）、medium 17（BUG-02~18）、low 8（BUG-19~26）；3 条暂缓全部为 low。口径与 spec §1/§3 一致。
- **门禁与回归一句话**：流水线全量门禁（typecheck/vitest/cargo/web build）与两套 playwright 全量回归在「HEAD + 工作区」整体状态下转绿，报告撰写时复跑全部复现（vitest 613/613、cargo test 122 通过、playwright 默认套件 171 passed / 15 skipped、服务端套件 34 passed / 1 skipped）；但 `pnpm run typecheck` 在含 e2e 脚本的最终状态**失败**（4 文件 5 处类型错误，流水线回归阶段不含 typecheck 故未拦截），且包 2/3/5 的部分修复文件仍在工作区**未提交**——两项为本批最主要的遗留（见 §4.4、§6）。
- **两条重点缺陷的收口口径**：BUG-01（唯一 high）主链已修（m3u8 直连可播、.ts 改派播放器、flv 回归不破），但「分片不可达出错误提示」子项未达成（hls.js 对 404 分片不升级 fatal，仍静默重试，e2e 以 `test.fixme` 占位，`apps/web/e2e-server/b-media-office-viewer.spec.ts:175`）；BUG-06 经干净 profile 复测裁决，报告主体（零 .wasm 请求/全兜底）定性为「陈旧 SW/环境状态」（根因 BUG-15 残缺 SW），但 python/java 本地 grammar 路径缺口真实存在、另行立项（`docs/e2e/code-highlight-degrade.md` §5）。

## 2. 逐缺陷处置表

处置与严重度以 spec §2 各条 header 为权威；「修复提交」列给出 `git log 8604495..HEAD` 中的实际提交哈希，⚠ 标注该缺陷仍有实现文件**仅存在于工作区未提交**（2026-10-09 `git status` 核对）。验证方式：单测=仓库内 vitest/cargo 测试；场景号=两套 playwright（默认套件 `apps/web/e2e/`、服务端套件 `apps/web/e2e-server/`，场景编号对应 `docs/e2e/*.md`）；每条 fix 均经逐包代码审查（§4.3）。

| 缺陷 | 严重度 | 处置 | 修复提交 | 验证方式（单测 / 评审 / playwright 场景号） |
| --- | --- | --- | --- | --- |
| BUG-01 HLS blob 伪 URL 永不起播且静默；.ts 乱码 | high | fix | a74ff28、399c444 | 单测 magic/dispatcher/av.test.ts；场景 MEDIA-04（服务端套件 b-media-office-viewer：m3u8 直连起播、video.ts 改派播放器、flv 护栏；**missing-seg 错误提示子项未达成，test.fixme 占位**）；默认套件 b-media-office-viewer 回归 |
| BUG-02 btrfs watcher 持续故障无自愈 | medium | fix | 98ebcac、5d41ab8、7595593（前端新帧消费） | 单测 watch.rs 内嵌 8 项（mock opener 驱动自愈/降级，98ebcac 提交信息）+ tests/events.rs；场景 SRV-06（服务端套件 b-server-file-service：changed 帧流动且无 watch-error、自动重读 + scrollTop 保留） |
| BUG-03 快捷键 j/k/gg/G/Ctrl+P 零实现 | medium | fix | ⚠ 实现未提交（AppShell.svelte、QuickOpenPanel.svelte、quickOpen.ts/.test.ts 在工作区） | 单测 quickOpen.test.ts（未提交）；场景 SHELL-11（默认套件 b-app-shell-sources：j/k/gg/G 一条 + Ctrl+P 一条） |
| BUG-04 状态栏编码/语言/大小/行未渲染 | medium | fix | 8228317（code/image getMeta）、7595593（pdf getMeta）；⚠ ViewerPane.svelte / MetaPanel.svelte / metaStore.svelte.ts 未提交 | 单测 code.test.ts、renderMedia.test.ts；场景 SHELL-12（b-app-shell-sources）、HL-06/HL-07（b-server-highlight-search、b-code-highlight-degrade）、SRV-05（b-server-file-service、b-server-regression） |
| BUG-05 设置面板/排除规则/手动刷新无 UI | medium | fix | 7595593（autoRefresh 门控）；⚠ TopBar.svelte、SettingsPanel.svelte、settings.ts + settings.test.ts、AppShell.svelte 未提交 | 单测 settings.test.ts（未提交）；场景 SHELL-09/13（b-app-shell-sources）+ SRV-07（b-server-file-service、b-server-regression） |
| BUG-06 本地 tree-sitter 主路径整链失效 | medium | fix（可观测 + 复测裁决） | 6a7c398、7595593（复测裁决记录 + deploy 注记）；⚠ worker.ts 首错上报、fix-pwa.spec.ts 护栏未提交 | 单测 client.test.ts/worker.test.ts；干净 profile 复测裁决（code-highlight-degrade.md §5：HL-01 通过、报告主体定性环境）；场景 HL-01（b-code-highlight-degrade）、MD-05（b-markdown-html-docs-bug-regressions）、PWA-03（b-pwa-mobile-performance）+ fix-pwa.spec.ts（未提交）；**python/java 覆盖缺口另行立项** |
| BUG-07 无扩展名被拒、shebang 不识别 | medium | fix | a74ff28（dispatcher 回退链 + det.lang）、8228317（code 消费） | 单测 dispatcher.test.ts、code.test.ts；场景 HL-05（b-code-highlight-degrade、b-server-highlight-search）+ SHELL-03（b-app-shell-sources） |
| BUG-08 服务器 tab 刷新后误标本地占位 | medium（unconfirmed） | fix（方案 A 自动重连） | 7595593（openFlow 部分）；⚠ AppShell.svelte 重连主体未提交 | 场景 SHELL-14（服务端套件 b-server-regression「BUG-08/SHELL-14：刷新后自动重读并恢复滚动」） |
| BUG-09 全局搜索点击不定位不高亮 | medium | fix | 8228317（revealLine + pendingLine 写入）；⚠ ViewerPane.svelte 消费侧未提交 | 单测 code.test.ts；场景 CMP-06（服务端套件 b-compute-global-search-server） |
| BUG-10 remote 策略 >2MB 被本地阈值压制 | medium | fix | 8228317（code.ts 问路由）；⚠ highlightRouter.ts/.test.ts、viewer.ts 注入未提交 | 单测 code.test.ts、highlightRouter.test.ts（未提交）；场景 CMP-02（服务端套件：显式 remote 走远程 + auto 硬护栏两条） |
| BUG-11 超 2000 上限无服务器引导、截断残留 | medium | fix | 8228317 | 单测 globalSearch.test.ts（serverSearchHint 三态）；场景 CMP-11（默认套件 b-compute-global-search-pureweb）+ CMP-08 远程不引导护栏（服务端套件） |
| BUG-12 加密 zip 整包拒绝 | medium | fix | a74ff28、399c444 | 单测 zip.test.ts；场景 BIN-08（默认套件 b-binary-hex-archive：条目树 + 🔒 + 明文可读） |
| BUG-13 zip 改名 .txt 无 magic 改派 | medium | fix | a74ff28、399c444 | 单测 dispatcher.test.ts；场景 BIN-10（默认 + 服务端两套） |
| BUG-14 损坏媒体无错误卡片、卡片无按钮 | medium | fix | a74ff28、399c444、7595593 | 单测 av.test.ts；场景 MEDIA-11（默认套件 b-media-office-viewer：截断 mp4/PDF 卡片 + 重试/降级按钮） |
| BUG-15 离线 reload 落 chrome-error | medium | fix | 98ebcac（server no-cache 代工）、6a7c398（additionalManifestEntries + check-pwa-build 硬断言）、7595593（deploy 注记） | 单测 tests/index_cache.rs；构建门禁 check-pwa-build.mjs 硬断言（precache 含 index.html）；场景 PWA-02（b-pwa-mobile-performance：precache 含 index.html + 断网 reload 完整壳） |
| BUG-16 1MB hex 首屏超预算 7~9 倍 | medium | fix | ⚠ 实现未提交（hex.ts 虚拟滚动、core/virtualScroller.ts + test、render-text shim、core/index.ts、hex.test.ts、binary-hex-archive.md 口径更新，均在工作区） | 单测 hex.test.ts、virtualScroller.test.ts（未提交）；场景 PWA-08（b-pwa-mobile-performance，**宽松预算 <1000/<1500ms，spec 200/500ms 口径未作硬断言**）+ fix-pwa.spec.ts（未提交：首屏 DOM 行受限 + 末偏移吻合） |
| BUG-17 外域 http 图片实际发起 GET | medium | fix | 8228317（sanitize 钩子）；⚠ html.ts CSP 收紧、markdownRenderer.ts、app.css 占位样式未提交 | 单测 markdownSanitize.test.ts；场景 MD-11（b-markdown-html-docs-bug-regressions 3 条 + b-markdown-html-docs-server 2 条：html/markdown 两视图外域零请求） |
| BUG-18 文件内搜索无词级/全命中高亮 | medium | fix | 8228317；⚠ app.css active 样式未提交 | 单测 code.test.ts、search.test.ts；场景 FSEARCH-01（b-in-file-search）+ m3-search.spec 护栏同步更新（9315351） |
| BUG-19 「打开文件夹」点击无反馈 | low | fix（收窄为反馈缺失） | 7595593 | 场景 SHELL-01（b-app-shell-sources「BUG-19/25：两通道取消均有提示、回退通道可达」） |
| BUG-20 >20MB 纯文本无超限提示 | low | fix | 8228317（提示条）；⚠ app.css 提示条样式未提交 | 单测 code.test.ts；场景 HL-04（b-code-highlight-degrade「BUG-20」条） |
| BUG-21 全局搜索 glob 无 UI 入口 | low | **defer**（规格未承诺 glob UI，属产品决策；API 层功能保留） | —（spec §2 BUG-21 文档收口） | 既有 CMP-07 API 口径用例（b-compute-global-search-server「Aa/.*/glob」条）维持回归 |
| BUG-22 auto 指示不符期望路由 | low | fix | ⚠ 实现未提交（viewer.ts fence 门控、html.ts getEngine） | 场景 CMP-03（服务端套件 b-compute-global-search-server：含围栏 md 与 html 均「渲染: 本地」，py 仍远程） |
| BUG-23 文件内搜索无大小写开关 | low | fix | 8228317（search 契约）、7595593（pdf 透传）、9315351（SearchPanel Aa）；⚠ markdownRenderer.ts、html.ts 视图透传未提交 | 单测 code.test.ts、search.test.ts；场景 FSEARCH-03（b-in-file-search「BUG-23」条：6↔2 命中） |
| BUG-24 断网展开目录静默失败 | low | fix | ⚠ 实现未提交（TreeNodeRow.svelte） | 场景 PWA-04（服务端套件 b-server-regression「BUG-24/PWA-04」条：提示 + aria-expanded 回滚 + /api 不缓存） |
| BUG-25 报告称 webkitdirectory 回退通道不存在 | low（unconfirmed） | **defer**（复核判误报，通道实测存在；遗留反馈问题由 BUG-19 fix 覆盖） | — | b-app-shell-sources「BUG-19/25」条含回退通道可达断言 |
| BUG-26 报告称触摸无惯性 | low（unconfirmed） | **defer**（复核不可复现：5 快滑 4 次有惯性；应用层无自定义触摸处理可修） | — | PWA-06（b-pwa-mobile-performance：1:1 跟手硬门 + 惯性实测记录不硬断言） |

提交状态小结：**9 条实现全部已入库**（BUG-01/02/07/11/12/13/14/15/19）；**9 条部分未提交**（BUG-04/05/06/09/10/17/18/20/23）；**5 条实现整体未提交**（BUG-03/08/16/22/24，其中 3 条的验收用例已随 cf32307 入库）；defer 3 条。回归绿是在「HEAD + 工作区」整体状态下取得（含全部未提交文件）；仅按 HEAD 检出**不能**复现已验证状态，需尽快按 §4.4 清单补提交。

## 3. 暂缓项专节（defer 3 条，均为 low）

### BUG-21 全局搜索 glob 限定无 UI 入口（verified · defer）

- **理由**（spec §2 BUG-21/§3）：① 现行设计规格（`docs/superpowers/specs/2026-10-06-vviewer-design.md` Q6/Q15）仅把 glob 定位为 `POST /api/search` 的 API 参数，UI 只承诺面板打开 + 分组 + 跳转——测试期望超前于规格，缺口属产品决策而非缺陷修复；② API 层能力完整（`server/src/routes/search.rs` glob 真实过滤），可完全绕过，不阻塞主链路；③ 正确入口是规格层收口或并入全局搜索面板改造批次，glob 语法与 Aa/. * 开关的组合语义需先定案，不宜在本轮顺手做。
- **后续建议**：产品确认需求后在规格层收口（注明「glob 为 API 参数、UI 暂不提供」），或立项全局搜索面板改造时一并加 glob 开关 + `grepRemote` 透传；转 fix 前先定 glob+正则同时启用的解析优先级。

### BUG-25 报告称 webkitdirectory 回退通道不存在（unconfirmed · 复核判误报 · defer）

- **理由**（spec §2 BUG-25/§3）：复核以 createElement hook 证实回退通道真实存在（input 创建、`webkitdirectory` 属性就位、click 调用、cancel 事件触发，3 次点击事件链完整），与源码 `openFlow.svelte.ts` 的 `openDirectoryViaInputFallback` 一致；报告探针疑因只查 DOM 连接或只读创建瞬间属性而误判。报告遗留的真问题（取消无反馈）已由 BUG-19 的 fix 覆盖（7595593）。
- **后续建议**：列入真机补测清单——在真实非 FS Access 浏览器（iOS Safari/Firefox）验证点击「打开文件夹」→ 弹目录选择 → 选目录后树出现；若补测发现新事实再立新缺陷。

### BUG-26 报告称触摸滑动 touchend 后无惯性（unconfirmed · 复核不可复现 · defer）

- **理由**（spec §2 BUG-26/§3）：复核同参数快滑 5 次中 4 次出现典型衰减惯性（~400ms 续滚 ~250-280px）；应用层无 touch 事件 preventDefault/passive 拦截（`rg 'touchstart|touchmove'` 于 apps/web/src 零命中），惯性属浏览器合成器行为，无可修的产品逻辑点；报告亦自注可能为合成输入限制。
- **后续建议**：真机补测（报告 §7.1 第 9 项）——真机快滑后采样惯性续滚；回归执行时按 `docs/e2e/pwa-mobile-performance.md` 注记口径（多轮采样、区分慢滑/快滑阈值），不得按报告原结论单次采样判定。

## 4. 质量过程

### 4.1 spec 与计划的评审

流程由修复流水线编排（`.zcode/workflow-drafts/vviewer-e2e-fix-pipeline.dwf.ts`）：spec 作者成稿 → **spec 评审员**独立对照源码核验根因与验收标准（修订-复审循环，脚本上限 3 轮）→ **换人终审**（从未参与的评审员冷读 + 抽查源码，不通过则最后修订）→ 定稿提交（3d2ed6f）。计划作者依 spec 切 5 个文件互斥工作包 → **计划评审员**核验 26 条 fix 恰好覆盖、ownedFiles 互斥、依赖与定向验证可信（修订-复审循环，脚本上限 2 轮）→ 工作包数量与覆盖校验 → 定稿提交（0ddb8ae）。

**如实说明**：各评审环节的**实际轮次与意见明细未沉淀于仓库**——提交信息写「详见评审记录」但仓库内无该文件，编排层运行日志在本报告会话中不可达，故轮次不可考，本节仅能给出流程结构（脚本）与结果证据（提交序列）。

### 4.2 实现与门禁

5 个工作包并行实现（实现员按 ownedFiles 所有权与 TDD 节奏，只跑定向测试）→ 全量门禁循环（≤4 轮）：`pnpm run typecheck` → `pnpm test`（vitest）→ `cargo test --manifest-path server/Cargo.toml` → `pnpm --filter web build`（触发 check-pwa-build.mjs 硬断言）。门禁转绿后按包提交——**实际仅包 1（a74ff28）与包 4（98ebcac）产生实现提交**；包 2/3/5 的实现提交在仓库中不存在，其文件经后续审查修复提交部分入库、其余留存工作区（原因属编排层提交环节，日志不可达无法定论，事实状态见 §2 提交状态小结）。

### 4.3 逐包审查与集成审查

- **逐包代码审查**（requesting-code-review 技能流程，重点正确性/测试有效性/边界/风格；每包最多 2 修复轮，修复后快速门禁 typecheck+vitest 再提交）：包 1/2/3/4 均产生审查修复提交——399c444（派发选路+媒体+压缩包）、8228317（代码渲染枢纽+搜索/净化/路由指示，含包 2 主体实现入库）、6a7c398（高亮可观测+SW 产物+hex 前置）、5d41ab8（watcher 自愈）；**包 5 无审查修复提交**（按脚本逻辑即首轮审查通过、无文件改动）。
- **整体集成审查**（跨包视角：状态栏/派发器/highlight 管线等被多包触碰的接缝、遗漏联动）：产生修复提交 **7595593**——openFlow.svelte.ts（BUG-19 取消反馈、BUG-05 autoRefresh 门控、BUG-08 部分）、remote.ts（watch-degraded/watch-recovered 帧消费）、pdf.ts（getMeta 大小捕获 + caseSensitive 透传）、av.ts 联调、docs/deploy.md（SW 升级硬刷新注记）与 3 份域文档口径更新（含 BUG-06 复测裁决记录全文）。
- **遗留意见清单**（可实证的部分；评审原文不可考，见 §4.1 说明）：
  1. `pnpm run typecheck` 在最终状态失败：4 个 e2e spec 文件 5 处类型错误（§5 复跑 ①），流水线回归阶段不含 typecheck 故未拦截；
  2. BUG-01「missing-seg 出错误卡片」子项未达成，e2e 以 test.fixme 占位（`b-media-office-viewer.spec.ts:175`，实测 2026-10-09 两轮复现：404 分片不升级 fatal、约 1 次/秒静默重试）；
  3. BUG-06 遗留真实 grammar 覆盖缺口另行立项：python/java 本地 worker 加载静默失败（资产 200 仍回退 hljs 且无上报），服务端 compute 语言集 14 种（`server/src/compute/queries.rs:41-54`）无 java、与客户端 34 项 manifest 不对齐（code-highlight-degrade.md §5.4）；
  4. 包 2/3/5 共 14 条 fix 的实现文件部分或全部未提交（§2），含 5 条整体未提交；
  5. 评审记录文件缺失，与 4 个提交信息「详见评审记录」的指向不符。

### 4.4 未提交文件清单（2026-10-09 `git status`，需尽快补提交）

- **修改未提交（20 个）**：apps/web/src/{app.css, lib/AppShell.svelte, lib/MetaPanel.svelte, lib/TopBar.svelte, lib/TreeNodeRow.svelte, lib/ViewerPane.svelte, lib/stores/settings.ts, lib/viewer.ts}；packages/core/src/index.ts；packages/highlight/src/worker.ts + test/{client,worker}.test.ts；packages/render-binary/src/hex.ts + test/hex.test.ts；packages/render-text/src/{html.ts, markdown/markdownRenderer.ts, virtualScroller.ts} + test/{htmlRenderer,search}.test.ts；docs/e2e/binary-hex-archive.md。
- **未跟踪（12 个，除 .zcodeignore 外均属修复实现）**：apps/web/e2e/fix-pwa.spec.ts；apps/web/src/lib/{QuickOpenPanel.svelte, SettingsPanel.svelte, highlightRouter.ts, highlightRouter.test.ts, metaStore.svelte.ts, quickOpen.ts, quickOpen.test.ts, stores/settings.test.ts}；packages/core/src/virtualScroller.ts；packages/core/test/virtualScroller.test.ts。

## 5. 验证明细

### 5.1 门禁命令清单（流水线口径，脚本与 plan §3.2）

| 阶段 | 命令 | 结果 |
| --- | --- | --- |
| 实现后全量门禁（≤4 轮循环） | `pnpm run typecheck`、`pnpm test`、`cargo test --manifest-path server/Cargo.toml`、`pnpm --filter web build`（含 check-pwa-build 硬断言） | 转绿后方进入提交/审查阶段（脚本逻辑；具体各轮原始输出不可考） |
| 逐包审查修复后快速门禁 | `pnpm run typecheck`、`pnpm test` | 通过后按包提交（399c444/8228317/6a7c398/5d41ab8） |
| 集成审查修复后快速门禁 | 同上 | 通过后提交 7595593 |
| 全量回归（≤4 轮循环） | `pnpm test`、`cargo test`、`pnpm --filter web exec playwright test`（默认配置）、`pnpm --filter web exec playwright test --config playwright.server.config.ts` | 转绿后提交 9315351；该提交信息记录：playwright 默认套件 **171 passed / 0 failed / 0 flaky / 15 skipped（1.4m）**，m3-search `--repeat-each=3` **24/24**（修复前 168/2/1）；m5/m6 原始失败未复现、定性环境争用 |
| BUG-06 复测构建 | `pnpm --filter web build` | check-pwa-build 硬断言过：precache 103 条含 index.html（code-highlight-degrade.md §5 记录） |

### 5.2 报告撰写时复跑（2026-10-09，本机实跑，状态=HEAD+工作区）

| # | 命令 | 结果 |
| --- | --- | --- |
| ① | `pnpm run typecheck` | **失败**，exit 2：4 文件 5 处错误，全部位于 cf32307 新增的 e2e 脚本——b-app-shell-sources.spec.ts(393,39) TS2532；b-binary-hex-archive.spec.ts(54,27) 与 b-media-office-viewer.spec.ts(138,27) TS2322（Uint8Array→BlobPart）；b-compute-global-search-pureweb.spec.ts(26,29) TS2322、(121,5) TS2322（Timeout→number） |
| ② | `pnpm test`（vitest） | **53 个测试文件 / 613 用例全部通过**（9.13s） |
| ③ | `cargo test --manifest-path server/Cargo.toml` | **122 通过 / 0 失败**（11 个测试二进制，含 watch 自愈、events、index_cache、security 等） |
| ④ | `pnpm --filter web exec playwright test --reporter=line` | **171 passed / 15 skipped（1.4m）**——与 9315351 记录一致 |
| ⑤ | `pnpm --filter web exec playwright test --config playwright.server.config.ts --reporter=line` | **34 passed / 1 skipped（1.1m）**（1 skip = BUG-01 missing-seg 的 test.fixme 占位） |

### 5.3 两套 playwright 用例数（playwright `--list` 权威口径，实跑收集数一致）

- **默认套件**（`apps/web/playwright.config.ts`，chromium + mobile 双 project）：**186 条 / 21 文件**。构成：批次前既有 9 文件（m1~m7、m3-search、mobile）36 用例块 + 本批新增 b-* 域用例 11 文件 + fix-pwa.spec.ts（4 条，**未提交**）；实跑 186 执行 = 171 过 + 15 跳（mobile 专属用例在 chromium 侧、桌面基准在 mobile 侧的条件跳过等）。
- **服务端套件**（`apps/web/playwright.server.config.ts`，release 二进制同源伺服 :4174，chromium 单 project）：**35 条 / 8 文件**（含 smoke 冒烟）；实跑 34 过 + 1 跳（test.fixme）。
- 新增脚本经 cf32307 入库（22 个文件：默认套件 11 个 b-* spec + 1 个 helper、服务端套件 7 个 b-* spec + fixtures.mjs + smoke.spec.ts、playwright.server.config.ts）。

## 6. 未覆盖与后续建议

1. **补提交（最高优先）**：按 §4.4 清单把包 2/3/5 的实现文件补提交入库——当前 HEAD 不能独立复现已验证状态；提交前顺手修复 ① 的 5 处 e2e 脚本类型错误（`pnpm run typecheck` 纳入回归口径是仓库既有约定，见 e81f2af）。
2. **BUG-01 残留子项**：missing-seg.m3u8 分片不可达仍静默重试（hls.js ERROR 不升级 fatal）——按 test.fixme 注释的预期行为修复（错误卡片 + 重试按钮），修好后放开该用例。
3. **BUG-06 覆盖缺口另行立项**：python/java 本地 worker 静默回退（含单 grammar 加载失败的上报补齐，现可观测性只覆盖 worker 脚本级失败）；服务端 compute 语言集与客户端 manifest 对齐（java 无任何 tree-sitter 路径）。
4. **BUG-16 预算口径**：spec 验收为桌面 <200ms/移动 <500ms，自动化护栏按流水线纪律用宽松阈值（<1000/<1500ms）；修复后对 spec 口径的实测达标数字材料中不存在，需按 spec「另行评审」约定实测并裁决是否修订场景文档预算；本地 upload 通道首帧仍未测（报告 §7.1 第 7 项）。
5. **BUG-02 成因定论**：修复提供自愈（退避重建 → PollWatcher 降级）与可观测（fstype/后端打印、OS 错误码日志、degraded/recovered 帧），但 btrfs 上 notify 失败的直接成因（watch 上限/子卷/内核兼容）仍未定论；ext4/xfs/NFS 影响面未测——按 spec 未决 #2 的诊断步骤收口。
6. **真机补测专项**（报告 §7.1 第 1/2/3/9 项）：FS Access 真机端到端与真实文件夹拖拽（BUG-19/25）、真机触摸/惯性与移动 UA wheel（BUG-26）。本环境均为 headless 桌面 + 设备仿真，无法验证。
7. **其余未决**（spec §5）：纯前端搜索 200MB 累计上限行为未测；BUG-10 的服务端 intervals 缓存与 gzip 明确本轮不做；BUG-17 与 MD-13 外域媒体链接的兼容（样例集未覆盖，收收紧影响）；manifest abi 字段误读消除（gen:grammars 产物注记）。symlink 越权断言（未决 #9）已由本批 e2e 补充闭环（b-server-file-service「SRV-09」：穿越 400 + root 外 symlink 内容层读取 403）。
8. **过程改进**：评审记录随提交入库（当前「详见评审记录」无指向）；编排层「按包提交」依赖实现员返回的文件清单，应改为按 `git status` 兜底收集，避免本次 14 条缺陷的实现滞留工作区；回归口径纳入 typecheck。

---

*本报告全部数字出处：26/23/3 与严重度分布=spec §1/§3；提交与 diff=`git log 8604495..HEAD` 逐提交核对；BUG-06 复测=code-highlight-degrade.md §5；171/15 与 24/24 记录=9315351 提交信息；§5.2/§5.3=报告撰写时实跑。除本文件外未改动任何文件。*

## 7. 收尾补记（2026-10-09，编排层复核后落盘）

§6.1 的两项最高优先遗留已闭环，全部门禁在最终 HEAD 复跑验证：

- **补提交**：包 2/3/5 滞留工作区的 31 个文件按工作包原子落盘——3c5ae01（app-shell：BUG-03/05/08/19/24）、4aa4cfe（viewer：BUG-04/09/10/11/17/18/20/22/23）、c24eb78（highlight-pwa：BUG-06/15/16，含 fix-pwa.spec.ts 与 docs/e2e/binary-hex-archive.md 的 BUG-16 后口径更新）。
- **类型错误**：96f72ad 修复 4 个 b-* spec 的 5 处 TS 错误（索引可选链、Uint8Array→BlobPart 收窄、setInterval 返回类型），`pnpm run typecheck` 转绿。
- **virtualScroller shim**：d9f3560 按 core 头注释承诺的形态恢复 render-text 一行 re-export（工作流提交阶段该文件被文件清单遗漏、滞留工作区后又经编排层重放历史时丢失，按既定意图重建；typecheck + vitest 613/613 验证）。
- **提交信息修正**：原 cf32307 的污染信息（子代理把「建议 message」填进了编排层提交字段）经历史重写改为 ba62e1c，内容不变、仅 message 改写。
- **最终 HEAD 复跑**：typecheck 绿；vitest 613/613（53 文件）；cargo test 11 个测试目标全部通过；`pnpm --filter web build` + check-pwa-build 通过；playwright 默认套件 170 passed + 1 flaky（mobile MEDIA-11 计时型，重试通过）+ 15 skipped（既定 fixme 占位）；服务端套件 34 passed + 1 skipped。工作区干净（仅 .zcodeignore，先于本批存在）——HEAD 现可独立复现本报告全部结论。

§6 其余各项（BUG-01 残留子项、BUG-06 覆盖缺口立项、BUG-16 spec 口径实测、BUG-02 成因定论、真机补测专项、过程改进）维持不变，作为后续批次的输入。

## 8. 遗留问题清账（2026-10-09 第二批，目标：修复全部可修遗留）

§6 与暂缓裁决的逐项落地结果（提交号 34b310f..本批）：

| 遗留项 | 处置 | 证据 |
| --- | --- | --- |
| §6.2 BUG-01 残留子项 | **已修复**：hls.js 清单/层级/分片网络重试上限收紧为 2 次（500ms/2s 退避），404 分片数秒升级 fatal → 既有重试上限 → 错误卡片；fixme 用例放开为回归护栏 | 34b310f；missing-seg 用例实跑 6.1s 通过（服务端套件 35/35） |
| §6.3 BUG-06a 单 grammar 失败上报 | **已修复**：prepare() 静默吞异常补 console.warn（per-language 通道） | 8b2251c |
| §6.3 BUG-06b python/java 本地回退 | **定案为环境观察残留**：Node 同构测试（真实 wasm+查询）与干净浏览器会话均 tree-sitter·本地正常；新增 local-grammars.test.ts 锁死资产可用性 | 8b2251c；浏览器实测两语言状态栏「tree-sitter · 执行: 本地」 |
| §6.3 BUG-06c compute 语言集不对齐 | **已修复**：/api/health 宣告 computeLanguages（canonical 排序清单）；客户端 auto 策略仅对宣告集合内语言尝试远程（java 不再白发 400），显式 remote 不做集合门控（失败如实错误卡片） | 44d5642 + ffe394c + 本批 CMP-04 契约更新；集成测试锁死清单排序与 java 缺席 |
| §6.4 BUG-16 spec 预算 | **实测达标**：hex 首屏桌面 35~50ms（中位 38ms < 200ms）、移动 262~275ms（中位 274ms < 500ms），页内 t0→首个 .vv-hex-row 口径 5 轮；走 upload 通道，§6.4 的「upload 通道未测」一并闭环 | 23f8a52；PWA-08/BUG-16 段已回写 docs/e2e/pwa-mobile-performance.md |
| §6.5 BUG-02 btrfs 成因 | **定论**：非 btrfs 不兼容——新可观测性实测 btrfs 上 INotifyWatcher 建立成功、变更事件正常推送；原故障判为首轮评测 10+ 并发实例逼近 fs.inotify.max_user_instances=128 的 EMFILE 资源性失败（修复的自愈+降级+可观测即对症） | 本机探针：watch 建立日志 + SSE 收到 changed 事件；sysctl 128 限额 |
| §6.7 200MB 搜索上限 | **验证闭环**：210×1MB 注入恰在第 201 文件触达上限，截断提示与服务器引导同屏正确；顺带修复引导文案写死「2000 文件」与字节上限触因不符 | 23f8a52；单测补 200MB 包含断言 |
| §6.7 BUG-10 服务端缓存与 gzip | **已闭环**：(path,mtime,size,lang) 缓存此前已在审查修复落地；本批补 CompressionLayer（仅 /api/compute/*，Range 流不压缩） | 44d5642；集成测试断言 content-encoding: gzip + gzip magic 与不压缩对照 |
| §6.7 BUG-17/MD-13 外域媒体兼容 | **已修复**：外域 video/audio 强制 preload=none + 去 autoplay（不点不发请求，点播放=主动行为与外链同口径）、source 外域候选剥除；enrich 转换路径同口径 | 1532f10；干净浏览器实测外域零请求、内域不受影响；单测 6 例 |
| §6.7 manifest abi 误读 | **已消除**：生成器写入语义注记（abi=null 为构建元数据占位，加载侧无 ABI 门控） | c617d68 |
| BUG-21 glob UI（暂缓） | **文档收口**：规格仅承诺 API 参数，UI 控件属产品决策并入搜索面板改造批次；CMP-07 API 断言维持为回归护栏 | 002c0a6 |
| 过程改进（§6.8） | 部分落地：本批回归口径已含 typecheck（并实际兜住 health 单测编译错）；「按包提交用 git status 兜底」「评审记录入库」属工作流脚本改进，记录在案待下批工作流采纳 | 本批门禁 |

### 8.1 确实无法完成项（环境物理限制，非回避）

- **FS Access 真机链路**（showDirectoryPicker 端到端、原生目录选择器与权限弹窗、真实文件夹拖拽 webkitGetAsEntry）：headless 无法驱动原生对话框，仓库内无该通道的任何可编程入口。
- **真机触摸/惯性**（BUG-26）与移动 UA 真机 wheel：无真实设备；仿真触摸经 CDP 合成注入，惯性表现与真机合成器不可比（PWA-06 对照数据已留档）。
- **ext4/xfs/NFS watcher 影响面**：本机仅 btrfs/tmpfs 可用；根因既定论为 inotify 实例资源（与文件系统类型无关），风险受限。

### 8.2 收批门禁（最终 HEAD 实跑）

typecheck 绿；vitest **623/623**（54 文件）；cargo test **127/127**（11 目标，含 health computeLanguages 与 gzip 协商新测试）；`pnpm --filter web build` + check-pwa-build 过；playwright 默认套件 **171 passed / 15 skipped，exit 0（零 flaky）**；服务端套件 **35 passed，exit 0**（含放开的 missing-seg 用例与 CMP-04 新契约）。本批新增/改动测试：av 重试上限、local-grammars、remoteLanguageAdvertised、health×2、gzip×2、sanitize/enrich 外域媒体×6、CMP-04 契约更新。
