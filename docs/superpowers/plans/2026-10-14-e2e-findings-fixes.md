# e2e 两轮发现问题的修复计划（TDD）

- 日期：2026-10-14
- 输入：`docs/report/e2e/e2e-test-report-2026-10-13.md`（补充轮：SUSP-01~10 存疑）、`docs/report/e2e/e2e-enrichment-report-2026-10-13.md`（富化轮：SUSP 定档、BUG-201、回归分诊 §5.2、缺陷候选 §4.3）
- 流程：superpowers TDD——每项先有失败测试（看着它红、确认失败原因正确），再写最小实现转绿，重构不引入新行为；每项原子提交（Angular 规范中文 message）。

## 1. 范围

### 1.1 产品缺陷（verified）

| # | 缺陷 | 位置 | 修复方向 | RED 载体 |
| --- | --- | --- | --- | --- |
| F1 | **BUG-201**：code 窗口流式行索引无自动后台推进通道，>2MB 文件状态栏行数冻结首块值（3640≠338770），既有 BUG-20 契约锚确定性双红 | `packages/render-text/src/code.ts:1734-1736`（start() 排空仅 atEnd 形态可达）、`:1697-1698`（maybeContinue 距尾 20 行闸是唯一推进通道） | 增加后台索引泵：空闲期逐块 `pullBlock()` 推进至 EOF/防线停机，尊重全部既有停机条件（indexFinished/limitReached/encodingBroken/destroyed/continueFailed/pulling）与取消语义；与搜索扫描（SCAN_POLL_MS 轮询）、滚动续读互斥不双拉（块在途判据复用）。推进节奏用空闲调度（requestIdleCallback 回退 setTimeout），避免与滚动/搜索争 IO | 既有 `b-code-highlight-degrade.spec.ts:179` BUG-20 锚（chromium+mobile，先复跑取证红） |
| F2 | **SUSP-07**：FileTree 来源根目录 listChildren 失败被 `.catch(() => [])` 静默吞掉，与 TreeNodeRow 子目录失败有 showStatusNotice 提示（BUG-24 通道）不成对 | `apps/web/src/lib/FileTree.svelte:35` | 根级加载失败复用 showStatusNotice 按源提示「来源 X 加载失败」，保留失败隔离语义（单源失败不拖垮其他源） | 翻转 `b-susp-verify.spec.ts` SUSP-07 探针为正向断言（提示在场）——现状静默必红 |
| F3 | **SUS-TAX-1**（缺陷候选）：同 base 换 token 重连清扫不彻底——关目录 tab 使旧 store 实例终结，循环走到文件 tab 时 getRemoteBase 已 undefined，幸存文件 tab 丢 SSE watch | `apps/web/src/lib/openFlow.svelte.ts:868-874` + `packages/core/src/tree/remote.ts` | 按 `docs/e2e/tab-actions-enrichment.md` §3.1 预写改法执行（先收集匹配 tab 列表再统一关闭，或先匹配后释放）；改法以该文档为准 | 按 §3.1 回改 TAX-09 期望后跑红 |

### 1.2 记录在案的现象（本轮一并修复）

| # | 现象 | 位置 | 修复方向 | RED 载体 |
| --- | --- | --- | --- | --- |
| F4 | TabContextMenu「任意滚动即关」在 TabBar 溢出（mobile 375px）时被右键自身 scrollIntoView 的尾随 scroll 秒关（WSX-08 确定性复现面） | `apps/web/src/lib/TabContextMenu.svelte:67-69`（window capture scroll 监听） | 打开菜单后对**自身触发的滚动**豁免关闭（时间窗或来源过滤，读码定实现）；保留「用户滚动即关」设计意图 | 新用例：溢出 TabBar 右键后不做静默等待、立即断言菜单在场可点——现状秒关必红 |
| F5 | search.rs parser_roots 越界 400 分支文案 `root index {i} out of range` 不可达，可达文案为 guard 的 `root index out of range: {idx}`，两处不一致 | `server/src/routes/search.rs:293-299` 对照 `server/src/guard.rs:37-38` | 对齐文案为 guard 形态（最小改动；死分支保留作防御），补/改 cargo 单测锁文案 | cargo 单测：直接调用该分支（构造越界 root 绕过前置 guard 的路径若不可达，则以「文案常量/格式化函数单测」锁两处一致——读码后定 RED 形态） |

### 1.3 测试断言时代差（回归 5 条，改测试不改产品）

| # | 用例 | 现状 | 处置 |
| --- | --- | --- | --- |
| F6a | `t-hl` HL-04/2（>200MiB plain 分支） | 断言旧「纯文本零着色+提示条」口径 | 泵落地后复跑定夺；仍红则按富化报告 §5.2 #3 改锚新提示条文案+保留虚拟滚动/行数/gutter 行为面；同步修订 `docs/e2e/code-highlight-degrade.md` §6 三态表 |
| F6b | `t-hl` HL-08 ×2（3MB 折返，「行： 48000」打在打开即终值） | 窗口流式行数渐进，期望落空 | 泵落地后复跑：后台推进至 EOF 后断言若能在超时内自然满足则不改；仍时序紧则改折返后/驱动式锚定 |
| F6c | `b-code-highlight-degrade` PERF-LAZY（25MB 跳滚锚） | 跳滚单次赋值落在流式 spacer，确定性红；锚点 3（longtask=0）从未被执行 | 泵落地后复跑；仍红则「等索引覆盖目标行后单次赋值」；**顺带首验锚点 3**；25MB 推进时长单独记录定档（泵速率参数的实证输入） |
| F6d | BUG-20 chromium 半 | 与 F1 同根因 | F1 修复后应自然转绿；不单独改断言 |

### 1.4 文档债（不改行为）

| # | 项 | 处置 |
| --- | --- | --- |
| F7a | io spec §2.3 回退语义文字（「停在该块」vs 实际「200-回退全量重取」） | `docs/superpowers/specs/2026-10-12-io-streaming-design.md` §2.3 措辞对齐实现（SUSP-04 定档附带的文档债） |
| F7b | `docs/e2e/susp-verification.md` | SUSP-07 修复后按其复核出口更新：探针已翻转、负向静默断言改正向提示断言 |
| F7c | `docs/e2e/code-highlight-degrade.md` | §6 三态表随 F6a 断言口径同步（若 F6a 免改则记录泵后实测口径） |

## 2. 范围外（明确不做，理由在案）

- SUSP-01/02/03/05/06/09/10：定档 confirmed-design（设计内/维持现状记录），其中 4 条优化立项候选（SUSP-01 跨清空缓存、SUSP-02 视口块豁免逐出、SUSP-03 降级滚动恢复、SUSP-06 queries 空打）另立项，不在「修复问题」范围。
- SUSP-08 / BUG-53（损坏图片无错误卡片）：既有挂账，早于本轮两份报告，不重复定档。
- m3-search mobile 已知计时型 flaky、2 条回归 env-flaky（复跑即绿）。
- PERF-LAZY 25MB 性能的独立定档报告（本计划只实测记录推进时长，性能优化另立项）。

## 3. 执行顺序与依赖

1. **F1 BUG-201 泵**先行——它是 F6b/F6c/F6d 三处断言定夺的前置（泵落地后这些锚可能自然绿）。
2. F6 复跑定夺（只改仍红的断言，逐条给红→绿证据）。
3. F2 SUSP-07 → F3 SUS-TAX-1 → F4 右键菜单 → F5 文案（互不依赖，可按此序逐项 TDD）。
4. F7 文档债三处。
5. 终局门禁：`pnpm typecheck`（apps/web 口径）、`pnpm test`（仓库根 vitest）、`cargo test`（server 全量——教训：health 单测编译错只有全量能抓）、定向 playwright（t-hl / b-code-highlight-degrade / t-tab-actions / b-tab-actions-enrichment / b-susp-verify / t-workspace / b-wsx-recovery + e2e-server b-wsx-root-channel / t-bin）、全量 default+server 回归。

## 4. 风险与护栏

- **泵的回归面**：code.ts 是近 20+ 条 fix 的高密区（残留角、续扫截断、游标回退、降级、进度节流）。泵必须复用既有停机闩与块在途判据，禁止绕过 `pulling`/`continueFailed`/reload 停机语义；vitest 层 `code.test.ts` 先补泵行为单测（推进至 EOF、停机条件逐一、与搜索扫描互斥）再动实现——单测先行即 RED。
- **SUS-TAX-1 改法**以 tab-actions-enrichment.md §3.1 预写为准，避免自由发挥；TAX-09 现状锚定期望的回改幅度以该文档为界。
- **F4 语义边界**：只豁免菜单打开自身触发的滚动，用户随后的滚动仍须关闭（用例要同时锚这两面，防止把设计意图一起修掉）。
- **WSX-08 既有静默等待**是 workaround——F4 落地后保留该 workaround 不动（它仍应绿），新用例证明不再需要；workshop 移除属后续清理。

## 5. 提交拆分（原子）

1. `fix(render-text): code 窗口流式行索引后台推进泵`（F1，含 vitest 单测）
2. `test(e2e): 窗口流式断言重定基`（F6，视复跑结果拆并；含 code-highlight-degrade.md §6）
3. `fix(web): FileTree 来源根加载失败显性提示`（F2，含探针翻转 + susp-verification.md）
4. `fix(web): 同 base 重连清扫覆盖文件 tab`（F3，含 TAX-09 期望回改）
5. `fix(web): 右键菜单豁免自身滚动关闭`（F4，含新用例）
6. `fix(server): search root 越界文案对齐 guard`（F5，含 cargo 单测）
7. `docs(spec): io 流式回退语义文字对齐实现`（F7a）
8. 收尾：全量门禁结果记录（若有遗留红，如实记录不虚报）
