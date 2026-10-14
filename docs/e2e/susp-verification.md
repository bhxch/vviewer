# 上轮存疑观察 e2e 复核（SUSP 定档探针）— e2e 场景

> 来源：`docs/report/e2e/e2e-test-report-2026-10-13.md` §4.2（10 条 unconfirmed 存疑观察）与 §7.1（复核计划：修复或关闭均需运行期复现证据；SUSP-06/07 目前均为读码观察，不作定档依据）。本域为第二轮富化的复核轮：把每条存疑观察的「记录的现状」落成可执行的定档探针（e2e/b-susp-verify.spec.ts），探针绿 = 现象确认（记录与实跑一致），探针红 = 未复现（属预期有效结果，交分诊环节定档）。
>
> **复核口径（硬性规则）**：探针断言写「记录的现状」（§2 期望列即断言目标），不写「应有行为」——本域不是回归锚而是现状固化器；现象确认 ≠ 缺陷定档，定档（改实现 / 改文档 / 裁决为设计）由门禁实跑后的分诊环节出。
>
> **SUSP-08 不设探针**：损坏图片无错误卡片现象与既有 BUG-53 fixme（`e2e/t-media.spec.ts:319`）同源，报告已裁决并入 BUG-53 修复验收，不重复布点。

## 1. 目的与来源

上一轮（2026-10-13）6 域 52 场景全部实跑锚定，域材料 suspects 记录了 10 条「现象记录与读码推断」（全部 unconfirmed、未定档、未复核）。其中 8 条有运行期可达的触发面，本轮为其布定档探针；SUSP-08 并入既有 BUG-53；SUSP-10 为行为正确性记录（buffer 恒全量在手，行为正确、绕过 hex streaming 能力），同样以计量探针固化现状供对照。

- **证据等级差异**：SUSP-02/03/04/05 来自上轮实跑观测（SCAN-08/JVL-03/DEG-05/一次性临时 spec）；SUSP-01/06/07/09/10 来自读码定位（报告撰写时核对源码在位）——后者的探针若红，优先怀疑记录的机制推断有误而非环境。
- **与既有锚点的关系**：SUSP-02 复现 SCAN-08 布点但断言面不同（SCAN-08 断言扫描面不重读，本探针断言视口块的回看补拉次数）；SUSP-09 与 OWX-01/03 同链路但口径不同（OWX 锚「open-as 临时查看不落 override」的承诺面，本探针固化「内构链上位不写 override → 打开方式无生效态标识」的现状记录）；SUSP-04 正式化上轮一次性临时 spec（DEG-02 的「探针即全量零后续请求」承诺仅 LRU 界内成立，本探针固化超界形态）。
- **编号**：SUSP-01~10 沿用报告 §4.2，与既有锚点（SCAN-01~11 / JVL-01~08 / DEG-01~09 / GRF-01~08 / OWX-01~08 / MRF-01~08）不重叠。

## 2. 场景清单

公共环境（构造见第 4 节）：vite preview :4173 纯前端页面；远端来源由 spec 内假服务器模拟（复用 `apps/web/e2e/b-stream-resilience-helpers.ts` 的 `startStreamFakeServer` + `IoStats`，SUSP-07 为 spec 内专用 mini 服务器）；本地来源经 `__vvOpenDirImpl` 注入。全部 9 个探针 chromium + mobile（375×667）双 project 跑（树行点击经 drawer.ts 窄视口适配；右栏 MetaPanel 经 openRightIfNarrow 适配），无 desktop-only skip 项。

| 编号 | 前置条件 | 步骤 | 期望（= 记录的现状，探针断言目标） | 关联缺陷 |
| --- | --- | --- | --- | --- |
| SUSP-01 | 假服务器 10MB js（40 块，布点行 1000/21000 分属块 0/5）；已打开进 code 窗口模式 | ① 输入布点词等全文扫描收场（计数 1/2）；② 对照面：面板保持开启重派发同值 input 事件（等价全选重贴同词）→ 短路零扫描 IO；③ **清空输入框**（fill('')，等计数转「无结果」= `search('')` 已执行）；④ **重输同一布点词**；⑤ 等计数再度 1/2，对照 ④ 起点的 /api/file 计量增量 | ③ 走换键重置分支（`SearchPanel.svelte:105` 空 query 调 `search('')` → `code.ts:2118-2128` 清空 lastQuery/命中集/游标）；④ **必然触发全新全文扫描**：计量增量含末块 39 的 Range 且块级请求 ≥20 条（对照面 ② ≤1 条——扫描缓存实际存在但被清空动作作废，不复用）。全程无全量 200 | SUSP-01（设计裁决项：清空重搜同词是否应复用扫描缓存） |
| SUSP-02 | 同 SCAN-08 布点：fail 门（块 3 起 500 直至放行）、布点行 5000/21000 分属块 1（门前）/块 5（门后）；另加 206 应答延迟 60ms（撑开续扫窗，回拉可观测） | ① 触发扫描 → 块 3 失败部分收场（计数 1/1，自动定位行 5000，视口驻块 1）；② releaseFail + 同键重搜（同值 input 事件）续扫自块 3；③ 等计数 1/2 收场后读块 1 的计量 | 续扫期间视口所在块 1 被块表 LRU（16×256KB）逐出，经 pendingReload 回看重拉（`code.ts:1677-1696`）——**同一次续扫内块 1 的 Range 出现 ≥2 次**（上轮 SCAN-08 实测恰 2 次：逐出→回拉→再逐出→再回拉），伴随可见闪烁；扫描面本身不变形（块 2 不重读、前沿块 3..39 各恰一次、末块 39 在列） | SUSP-02（占位兜底契约内的行为，闪烁面待裁决） |
| SUSP-03 | 假服务器 gbk-nosize.jsonl（前 512KB 纯 ASCII 均匀行 + 自 524288 起 GBK 中文行补至 ~900KB+）；条目**省略 size**（size 未知窗口流式）；已打开（状态「已加载 2048 行」） | ① 滚动到已加载区中部（scrollTop = scrollHeight/2，记录位置 >0）；② 继续滚动到加载前沿触发续读喂入脏块（块 2 起 GBK）→ 流内嗅探判非 UTF-8 → 降级重渲（`jsonl/index.ts:891-898`）；③ 等降级完成（状态转「共 N 行」+ 状态栏「编码: gb18030」）；④ 读 `.vv-jsonl-scroll` 的 scrollTop | 降级重渲对 target **整体 replaceChildren 换全量视图**——**视口回到顶部（scrollTop = 0）、用户滚动位置丢失**（JVL-03 实跑中降级收口后须重新贴底才能让 GBK 卡片入窗的同现象）；降级本身非失败态（无错误卡片） | SUSP-03（罕见降级路径的 UX 粗糙面） |
| SUSP-04 | 假服务器 10MB jsonl（40960 行×256B 恰 40 块 > LRU 16 块）；`rangeless: 'all'`（200-only，忽略 Range 回 200 全量）；size 已知；已打开 | ① 等首屏收口（状态「共 40960 行」）；② settleStats 后读 /api/file 全部计量；③ 滚到底再滚回顶，再次 settleStats 读增量 | 首屏**恰 3 条请求、共 3×文件字节（每条响应体均 10485760 B）**：探针 `bytes=0-8191`（200）→ 被逐 head 预置块 `bytes=0-262143`（200，超长 → 200-回退）→ 全量重取 `bytes=0-9007199254740991`（200）（`blockStream.ts:130-138` evictOverflow + `:169-190` fullReload 单飞去重）；③ **滚动零新增**（全量底座就绪后零 IO）。「探针即全量零后续请求」（DEG-02 承诺）仅 LRU 界内成立，超界形态即本记录 | SUSP-04（medium 候选：3 倍传输放大；io spec §2.3「停在该块」语义差的定档依据） |
| SUSP-05 | 假服务器 aligned-900kb.jsonl（921600 B = 3600 行×256B，**非 256KB 块对齐**，恰 4 块）；标准 206 通道；size 已知 ≤1MB（FULL_LIMIT 含）；已打开 | ① 等首屏收口（状态「共 3600 行」）；② settleStats 后读 /api/file 全部计量；③ 静置 + 滚动后再次读增量 | **恰 2 条请求**：1 条**无 Range 全量 read**（200，921600 B，dispatcher `dispatcher.ts:277-281` `size ≤ FULL_LIMIT → full = await read!()`）+ 1 条**tail 部分块整块重拉** `bytes=786432-921599`（206，135168 B——head 预置末块 135168 B 非整块，首屏喂入按「未 ensure 不得进索引」纪律重拉整块）；③ 零新增（全量已喂、EOF 锁定）。「≤1MB 全量直读恰 1 请求」在非块对齐 size 下不成立 | SUSP-05（DEG-05 恰界夹具按块对齐规避的形态差） |
| SUSP-06 | 同源 manifest mock 为**剥离 java 条目**的真实清单（GRF-01 同款手法）；CDN 全域 abort；`__vvOpenDirImpl` 注入 Hello.java；page.on('response') 预挂计数 `/queries/java/` 与 `/grammars/java.wasm` | ① 打开 java 文件等高亮落定（状态栏「高亮: hljs 兜底」= doPrepare 已跑且失败兜底）；② 读两个计数 | **`/queries/java/**` 请求 ≥1（空打发生）**且 **java.wasm 请求 = 0**（manifest 无条目 → resolveGrammarEntry 短路）——即 `core-parse.ts:266-273` doPrepare 先 `expandQueryAsync` 后 `resolveGrammarEntry` 的执行顺序实证：语言不在合并 manifest 时查询 .scm 仍被请求（results 含 404/HTML 兜底，均计空打） | SUSP-06（low；读码观察的首次运行期实测） |
| SUSP-07 | spec 内专用 mini 假服务器：/api/health、/api/ticket、/api/events 正常，**/api/tree 一律 500**（服务器侧计数）；已连接（来源 tab 在场） | ① 连接成功等来源 tab 可见（listChildren('') 已失败，服务器计数 ≥1）；② 开抽屉（窄视口）观察文件树区；③ 静置 1.5s 后全文检索「加载失败」文案与错误卡片 | 来源**标签行渲染**（`.vv-tree-src-label` 可见）但**树区零行**（`.vv-tree-row` count 0）且**零错误提示**（页面无「加载失败」文案、无错误卡片——`FileTree.svelte:35-36` `.catch(() => [])` 静默吞掉；对照：TreeNodeRow 子目录展开失败有状态栏提示 BUG-24 通道，不成对） | SUSP-07（medium 候选：断网/权限失败下多根来源「静默空树」） |
| SUSP-09 | `__vvOpenDirImpl` 注入截断 mp4（sample.mp4 前 300B，moov 损坏 → av 内构错误卡片「无法播放此媒体」）；已打开 | ① 等错误卡片（2 动作：重试 / 以 hex 打开）；② 点「以 hex 打开」等 `.vv-hex` 上位（状态行含 300 B）；③ 开右栏（窄视口开抽屉）读打开方式下拉与手动标记 | hex **上位渲染原字节**、原卡片级联替换无残留（OWX-01 同链）；**打开方式下拉维持「自动」（value=''）且无「（手动）」标记**（`.meta-openwith` value ''、`.meta-openwith-manual` count 0）——av.ts:456-464 直调 `hex.render(buffer)` + takeOver 不经 dispatch 重入、不写 override，ViewerPane 不感知上位：与 dispatcher openAsAction（rendererOverride 重入）同按钮不同语义的现状记录 | SUSP-09（low；OWX-03 同观察的定档探针） |
| SUSP-10 | 假服务器伺服远端截断 mp4（同 SUSP-09 字节，300 B）；IoStats 预挂；已打开出卡片 | ① settleStats 记打开期基线；② 点卡片「以 hex 打开」等 `.vv-hex` 上位（状态行含 300 B）；③ settleStats 后读基线后增量 | **零新增请求**（无任何 Range 窗口流式读）——av.ts:457 内构链 hex 动作以手头全量 buffer 渲染（无 StreamCtx）：远端截断 mp4 卡片上位 hex 不产生窗口 Range 读，hex streaming 能力被绕过（av 非 streaming 故 buffer 恒全量在手，行为正确性无疑，现状计量固化） | SUSP-10（行为正确性记录，非疑点） |

## 3. 复核判定口径（对应既有域文档「关联缺陷的验收行为」节）

本域场景全部是**存疑观察的定档探针**，不是缺陷回归锚。每条给出三段：现象（报告 §4.2 转录）、探针断言（§2 期望列的可执行形态）、判定标准。**判定本身由门禁实跑后的定档环节出**，本节只定义判读规则：

### 通则

- **探针绿 = 现象确认**：实跑与记录的现状一致。确认只代表「现象真实存在」，是否缺陷、修不修、怎么修（改实现 / 改 spec 文字 / 裁决为设计）仍待定档。
- **探针红 = 未复现**：实跑与记录不符。绝不改断言凑绿——红灯连同失败信息里的实测证据（计量 JSON / scrollTop 实值 / 请求计数）交分诊环节，分类为 probe-negative，属预期有效结果。读码推断型记录（SUSP-01/06/07/09/10）探针红时优先怀疑机制推断有误。
- **探针不设 fixme/skip**：现状固化器在现状改变（修复落地）时应当转红，提示同步改写为修复后的回归锚（届时按对应裁决出口改写断言，并回填本表）。

### 逐条判定出口（转录报告 §7.1/§7.4，探针结果只是输入）

| 编号 | 现象确认后的建议出口（报告 §7.1） | 回归改写方向（确认→若裁决修复） |
| --- | --- | --- |
| SUSP-01 | 产品/设计裁决「清空重搜同词是否复用扫描缓存」——现状已实证：缓存存在（同键短路 ≤1 条）但被 `search('')` 换键重置作废 | 若裁决复用：断言改为「清空→重输同词零全文扫描（命中集/游标保留）」，保留对照面不动 |
| SUSP-02 | low 批量复核或随相邻缺陷顺带验证；行为本身是占位兜底契约，闪烁面是否需优化待裁决 | 若裁决消除闪烁（如视口块免逐出）：断言改为「续扫内块 1 回拉 = 0 次」 |
| SUSP-03 | low；是否需滚动位置恢复待复核裁决 | 若裁决恢复位置：断言改为「降级后 scrollTop 保持降级前值（±视口行差）」 |
| SUSP-04 | 二选一裁决（§7.4）：io spec §2.3 文字对齐实现（「200-回退=重取全量+单飞去重」）或实现改「停在该块」；触发面仅「Range-less + size 已知 >4MB」 | 改 spec 文字→本探针原地转正锚；改实现→断言改为「恰 2 请求（探针 + 停在该块的单块 200 全量）且不触发全量重取」 |
| SUSP-05 | low；「≤1MB 全量直读零额外读」口径是否收窄待裁决（DEG-05 恰界夹具按块对齐规避的现状记录） | 若实现改零额外读（head 预置整块语义补齐）：断言改为「恰 1 请求（无 Range 全量）」 |
| SUSP-06 | low；空打影响评估后裁决是否调换 doPrepare 内 expand/resolve 顺序 | 若调序：断言改为「/queries/java/** = 0 且 java.wasm = 0」 |
| SUSP-07 | 修复（对齐 TreeNodeRow.svelte:32-38 的状态栏提示通道）→ 补 MRF 域正/负锚；或裁决静默为设计后记录并关闭 | 若修复：断言改为「来源标签行在场且出现『加载失败』状态栏提示（BUG-24 通道）」 |
| SUSP-09 | low；「同按钮不同语义」是否需统一（内构链改写 override 或 UI 加生效态标识）待裁决 | 若统一：断言改为「打开方式下拉显示 hex（或等效生效态标识）」 |
| SUSP-10 | 行为正确性记录，无修复对象；若后续 hex 支持从 StreamCtx 上位再补窗口 Range 计量正锚 | —（现状锚即终态；探针「零新增请求」转常规回归护栏） |

### SUSP-08（不设探针，随 BUG-53 出口）

损坏图片渲染失败无错误卡片与 open-as 兜底（`packages/render-media/src/image.ts:57-85`，`rg "addEventListener\('error'|onerror" packages/render-media/src/image.ts` 零命中）与既有 BUG-53 fixme（`e2e/t-media.spec.ts:319`）同现象，报告 §4.2 已裁决**并入 BUG-53（medium）修复验收，不独立定档**。BUG-53 修复 PR 落地时按 t-media 既有 fixme 转正式断言，本域不重复布点。

### 附带修订记录（非探针）

`b-grammar-spa-fallback.spec.ts` GRF-05 用例标题与本轮同步如实化：原标题写「同源不 mock（真实清单）」而用例体实为 `mockCdnManifest(page, { grammars: {} })`（CDN manifest mock 为合法空 JSON，避免不 mock 时打真实 socket；同源清单不 mock 走真实产物）——偏差由 2026-10-13 报告修订轮记录（§5.4 缺口③），本轮只改标题为如实描述，**断言不动**；改后 GRF-01~08 全组实跑验证不破坏。

## 4. 环境与数据

### 4.1 套件与 helper

- default 套件（`apps/web/playwright.config.ts`：vite preview :4173，chromium+mobile 双 project，workers 3，retries 1）。
- spec：`apps/web/e2e/b-susp-verify.spec.ts`；复用 `b-stream-resilience-helpers.ts`（只 import 不修改）：`startStreamFakeServer`（rangeless 'all' / fail 门 / slowMs 均为既有能力）、`IoStats`、`makeCodeFile`/`codeBlockRange`/`openRemoteFile`/`settleStats`、`MB`；`drawer.ts` 的 `openDrawerIfNarrow`/`closeDrawerIfOpened`。
- spec 内自含（先例 b-io-streaming / t-workspace / b-multiroot-file 的自包含惯例）：code/搜索面板装置（openCode/panelSearch/replaceSearchQuery/retriggerSameQuerySearch，与 b-code-scan-resilience 同款复制）、jsonl GBK 嗅探夹具（与 b-jsonl-degrade-chain 同款构造）、SUSP-07 专用 /api/tree-500 mini 服务器、`__vvOpenDirImpl` 本地目录注入、错误卡片/MetaPanel 定位装置（与 b-error-card-open-as 同款）。
- GRF-05 标题修订对象：`apps/web/e2e/b-grammar-spa-fallback.spec.ts:419`（本轮唯一允许的既有文件改动）。

### 4.2 夹具构造

| 夹具 | 规格 | 用于场景 |
| --- | --- | --- |
| susp-10mb.js | 10MB（40 块 = 163840 行×64B 定长 js 行），布点词行 1000/21000（分属块 0/5） | SUSP-01/02 |
| susp-gbk-nosize.jsonl | 前 512KB 纯 ASCII 均匀行（2048 行×256B，恰块 0/1）+ 自 524288 起 GBK 中文行补至 ~900KB+（脏块 = 块 2 起）；tree 条目省略 size | SUSP-03 |
| susp-rangeless-10mb.jsonl | 10MB（40960 行×256B 恰 40 块 > LRU 16），合法 JSON 均匀行；服务器 `rangeless: 'all'` | SUSP-04 |
| susp-900kb.jsonl | 921600 B（3600 行×256B，非块对齐恰 4 块），合法 JSON 均匀行 | SUSP-05 |
| Hello.java | 短 java 源码（tree-sitter/hljs 均可识别；manifest 剥离 java 后降级 hljs） | SUSP-06 |
| broken.mp4 | `samples/m4/sample.mp4` 前 300B（moov 损坏 → av 内构「无法播放此媒体」卡片，MEDIA-11/OWX 同口径） | SUSP-09（本地注入）/ SUSP-10（远端伺服） |
| （专用服务器） | /api/health、/api/ticket、/api/events 正常 + /api/tree 一律 500（计数） | SUSP-07 |

### 4.3 边界与注意事项

1. 计量 attach 先于 goto（openRemoteFile 内置），读数前必经 `settleStats`（settled → 300ms 静置 → settled）。
2. SUSP-01 的对照面（同值 input 重派发 = 同键重搜）与被测面（fill 清空 = 换键）不可混用：面板计数为完成制，清空后以计数转「无结果」作为 `search('')` 已执行的唯一信号，再重输。
3. SUSP-02 的 fail 门一次性放行（releaseFail）不复闭；slowMs=60 只放慢直答应答，门应答不受影响（helper 既有语义）。
4. SUSP-04 的 3 条请求形状断言依赖 LRU 16×256KB 与 head 预置超限逐出（blockStream.ts:131-138）：夹具必须 >4MB 且恰为块对齐整倍数（40 块），Range 期望串含 `bytes=0-9007199254740991`（MAX_SAFE_INTEGER 原样透传，b-io-streaming:752 同口径）。
5. SUSP-06 的计数用 `page.on('response')`（不用 page.route 拦改，避免干扰资产链）；manifest mock 需在 goto 前布置；查询 .scm 在 vite preview 下应答 404 或兜底 HTML，均计入空打（remoteQueryLoader 对两者同样视为缺失）。CDN 注入构建与否不影响本探针（blockCdn 兜底，同源面两种构建下行为一致）。
6. SUSP-07 的「静默」是负向断言：状态栏提示（BUG-24 通道）持续 4s 自动清除，观察窗静置 1.5s 后检索全文无「加载失败」文案；服务器侧 /api/tree 计数 ≥1 证明失败真实发生。
7. SUSP-09/10 的 mp4 卡片是 av 软失败链（render 恒 resolve、video error 异步触发 showMediaError）：断言入口统一等错误卡片可见，不依赖时序。
8. 全程负向护栏：窗口模式路径不得出现全量 200（SUSP-04 的 200-only 场景除外——该场景记录的正是 200 形态）。
