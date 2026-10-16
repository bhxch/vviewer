# 卫生与 worker 健壮性批设计（minor/nit 清偿 + GRF env 固化 + BUG-35 + CI 探针蹲守）

- 日期：2026-10-16
- 状态：待用户审阅
- 来源：SDD ledger 全量盘点（28 条 minor/nit 记档：16 已清偿、6 无仓库载体，余 11 条行动面）
  + GRF env 固化三档裁决 + worker init 挂起取证机制复核
- 文中行号为 2026-10-16 HEAD（49cbc26）参考，实施时以符号定位为准。

## 1. 背景与动机

1. **ledger 盘点结论**：四阶段（grammar 全量对齐）SDD ledger 记档的 minor/nit 经逐条现状
   核实，大半已被终审修复波次顺带清偿（gen-licenses LICENCE 拼写、缓存键 fetch-only、
   SPA-fallback 嗅探、CORS expose、noBase 断言钉语义等）；余下 11 条行动面见 §2 清单，
   用户拍板全做（含 1 条 M 级）。
2. **GRF env 固化**：GRF-01/02 两条用例即构建注入守卫（无 `VV_GRAMMAR_CDN` 注入时 CDN 层
   不发请求，断言必假红）。CI 侧已固化（ci.yml:90），但 `apps/web/package.json` build 脚本
   无 env——本地任何一次无 env 重建即假红，已两次先例（最近 2026-10-14 10:08:47 重建）。
   三档选项裁决取 **②（build:e2e 脚本）**。
3. **worker init 挂起取证机制复核**：原口径「待 CI artifact 取证后立项」走不通——
   `?vvWorkerDebug=1` 探针仅打页面 console.debug，**无任何 e2e 带此参数**，CI trace 又仅在
   用例失败时上传，挂起即便发生也不会留下探针帧；CI 最近多轮全绿，挂起未显现。复核中
   发现同区域已知 fixme 缺陷 **BUG-35**（`t-hl.spec.ts:515-571`）：init 成功路径零回包
   （`worker.ts:135-138` 只排空队列），页面静置 >15s 再开文件被 15s 看门狗
   （`client.ts:18,95-103`）**误杀健康 worker** → 全会话静默降级 hljs + 一条误导性
   console.error。修复方向已写在 fixme 注释：init 成功回 ack 置 workerAlive。

## 2. 卫生清单（H1-H12）

| # | 条目（ledger 出处） | 动作 |
|---|---|---|
| H1 | 全量对齐 spec §7.2 门控粒度表述过时（spec:150-152 仍写「两 job 均以 vars.NPM_SCOPE != '' 门控」；实际 release.yml web job 无 job 级门，CDN 注入为 step 级，且管线已被 npm 方案 B 重写） | 两段式勘误注记（保留原文 + 勘误段，沿该 spec §7.3 先例） |
| H2 | e2e-server/ 从不被 typecheck（tsconfig.e2e.json:18 include 仅 `e2e/**/*.ts + playwright.config.ts`，ledger 自评「既有缺口」） | include 追加 `e2e-server/**/*.ts`，清暴露的类型错；typecheck 门禁自此覆盖 server e2e |
| H3 | ImportMetaEnv 声明未补（app.d.ts 无 env 接口，highlightClient.ts:246 靠 cast） | app.d.ts 补 `ImportMetaEnv`（`VV_GRAMMAR_CDN?: string`），cast 收敛 |
| H4 | local-grammars.test.ts:53-54 前缀匹配断言弱于精确名（`startsWith('keyword')`） | 钉死具体 capture 名；「与 theme.ts 最长前缀回退同构」设计注释保留 |
| H5 | PERF-LAZY 零裕量硬门的 CI 波动固有属性（阶段 4 ledger :44③，保留挂账带理由） | 本地预算加裕量（CI×4 既有）；锚点与断言口径不变 |
| H6 | 简报「6 纯父目录」散文估算与实际 307 不符（阶段 1 ledger :35，历史计划文档原句） | spec-deviations.md 补一行勘误（不改历史计划原文） |
| H7 | grammar.yml server-full job 无 timeout-minutes（默认 360 兜底；self-build 有 120） | 显式补 timeout-minutes（plan 阶段按 self-build 对齐或实测定值） |
| H8 | pack-npm queries/ 混入 5 个非 scm（~60KB）+ outDir 不清理（info，已文档化） | 收紧：queries 拷贝过滤仅 `.scm`；outDir 已含 manifest.json 时 fail-fast（防陈旧混包）；pack-npm.test.ts 补用例 |
| H9 | code.ts pumpChunk 未兜 hljs 动态 import 异常（low：`hljs ??= await import('highlight.js')` 抛错即 unhandled rejection） | pumpChunk 补 catch：warn 留痕、该块停留 plain（与 hljs 缺席同形态）；取消语义不变 |
| H10 | 展开合并后的 injections/locals 编译失败 → HighlightConfiguration::new Err 剔整语言（阶段 1 ledger :51，「严格化留待后续需求」，M 级） | server/src/compute/queries.rs：合并配置构建失败 → 降级重试（仅主 queries 重建配置、剔除 injections/locals）+ warn，不再剔整语言；ENTRIES 层既有逐文件预校验保留 |
| H11 | GRF env 固化三档（2026-10-13 报告 §7.3） | 档②：package.json 增 `build:e2e` 脚本（`VV_GRAMMAR_CDN` 与 ci.yml:90 同参）+ 域文档/README 注记本地构建口径；忘走它时 GRF-01/02 假红即守卫报警（语义保留） |
| H12 | 双缓存最坏 2× 旧预算（info，报告声明的设计取舍） | 不动，本 spec 记录确认（保留观察） |

## 3. worker 健壮性（W1-W2）

### W1 BUG-35 修复：init 成功 ack 置活

- worker 侧：`serveWorker` 在 `initWorker` 成功后回一帧 `{ kind: 'init-ok' }`（**无论 debug
  开关**——这是修复本体，非探针）；init 失败路径维持现状（onerror/请求报错通道已覆盖）。
- client 侧：onmessage 现行路径天然处理——非 `init-progress` 帧先 `markWorkerAlive()`
  （client.ts:62），`pending.get(res.id)` 落空即 return；仅需 types 联合类型补 `init-ok` 帧。
  进度帧不计存活的既有断言（client.test.ts:278+）保持不变——看门狗语义变为「init 完成
  ack 前静默 15s 才杀」，静置页面不再被误杀，真挂起（无 ack）照样 15s 触发。
- 误导性 console.error（highlightClient.ts:277-279）随误杀消失自然收敛。
- 测试：client.test.ts 新增「init-ok 置活 + 看门狗解除」用例；「无 ack 静默 15s 仍超时」
  既有用例保持绿；t-hl BUG-35 fixme 转正（静置 >15s 后开文件，tree-sitter 高亮正常、
  状态栏非 hljs 兜底、无「worker 加载失败」console.error）。

### W2 CI 探针蹲守：环境级挂起的证据通道

- 新增一条专用 e2e（导航带 `?vvWorkerDebug=1`）：断言 tree-sitter init ready（状态栏或
  `__vvLastHighlight*` 调试字段口径，plan 阶段定）；用例内挂 console 收集器收集
  `[vviewer-worker]` 探针帧，**失败时 `testInfo.attach` 全量帧**（不依赖 trace 对 debug 级
  console 的收录，证据确定性优先）。
- 效果：挂起若在 CI 复现 → 用例超时红 → artifact 含阶段化帧（停在 wasm-fetch 还是
  parser-init 一目了然）；CI 持续绿则挂起未复现。
- 处置：环境级挂起本体**保持挂账**（根因修复仍需证据）；CI 绿满 10 轮后向用户提请
  「未复现关闭」裁决。

## 4. 非目标

- worker init 挂起根因修复（无证据，等 W2 取证）。
- BUG-27（QuickOpen 403 一票否决——缺陷修复归 e2e-server 通道后续立项）。
- grammar.yml 全量首跑时长观测、ci.yml 缓存命中实测（既有 CI 观察项，不属本批）。
- H2 引入的类型错若暴露 e2e-server 侧大面积存量问题，仅修类型面，不改测试逻辑。

## 5. 验收

- typecheck（含新纳入的 e2e-server 工程）+ svelte-check 0E0W；vitest 全量绿；cargo 全套件
  绿（H10）；playwright 双通道既有锚零翻转。
- H8：pack-npm.test.ts 新增过滤与 fail-fast 用例；H11：本地以 `build:e2e` 构建后 GRF 域
  用例绿（模拟 CI 注入链）。
- W1：t-hl 转正用例 + client.test.ts 新用例；W2：新探针用例在本地与 CI 双跑绿。

## 6. 裁决记录

- 2026-10-16 用户拍板：minor/nit 清单 11 条全做（含 H10 M 级严格化、H12 确认不动）；
  GRF 三档取②（build:e2e 脚本；①非根治、③与②冗余）；worker 处置重构为
  「BUG-35 修复 + CI 探针蹲守 + 挂起挂账待证据」三步。
