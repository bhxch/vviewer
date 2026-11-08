# SSE/手动刷新后的 size 回填与回落 — e2e 场景（STR 域）

> 来源：文件查看器集成 spec `docs/superpowers/specs/2026-11-04-file-viewer-integration-design.md` §「已知接缝属性」①（`FileSource.size` 为打开时快照 → **残余 A1 修复**，2026-11-07，代码提交 `e8bbdd6`）：SSE changed / 手动刷新时，≤1MB 面**失效** size 快照走不定态泵，>1MB 流式面经**树面 listChildren 拉新鲜 size 回填** `source.size` 后再 `rev++`（重渲染恰一轮、按新鲜 size 收口，检出增长附状态条「文件已变更」提示；**回填失败回落快照语义**）。
>
> 脚本：`apps/web/e2e/b-sse-size-backfill.spec.ts`（域内自建装置，未改动任何既有 spec）。
>
> 计划来源：`plan-e2e-strengthen` 工作流的 STR 域 focus 段（`.temp/e2e-workflow/plan-e2e-strengthen.dwf.ts` STR 条目）——四条零锚缺口与既有锚的落点见本文件 §4 与 §3.2。
>
> 源码锚点（只读核实）：`apps/web/src/lib/tabsModel.svelte.ts`（`refreshPaths` :429、`FULL_LIMIT_BYTES` :541、`backfillStreamingSizes` :566-603、提示钩子 :548-552）、`apps/web/src/lib/serverConnect.svelte.ts`（SSE 帧入口 :88、`showStatusNotice` 4s TTL、autoRefresh 过滤 :87）、`apps/web/src/lib/openFlow.svelte.ts`（提示钩子注入 :52）、`apps/web/src/lib/TabBarMenu.svelte`（手动刷新入口 :212）、`packages/vviewer-core/src/dispatch/dispatcher.ts`（`HEAD_SIZE` :63、`FULL_LIMIT` :64、`FULL_CHUNK` :66、size 未知分支 :399-406、探针读 :403、pumpFull :83-121）、`packages/vviewer-render-binary/src/hex.ts`（`formatSize` :78、size 未知全量回退读 :795-800、结构尾窗 :696、状态文案 :742/:750）、`packages/vviewer-core/src/tree/remote.ts`（`listChildren` :362-375 条目 size 仅在存在时携带、`read` :377-397 Range 透传）、`apps/web/src/lib/AppShell.svelte`（treeKey :715、`{#key treeKey}` :1271）。

## 1. 目的与来源

`FileSource.size` 是**打开时快照**（来自 tree 条目 / File 响应 / 直连列表），不是 remote 的实时 Content-Length。远端文件在 tab 打开后可能变化（增长或缩小）；变化若不被察觉：

- 增长时，hex/pdf 等流式面仍按旧 size 收口 —— 读窗永不越过旧边界，**新增字节永不上屏**，且用户**无任何「文件已改」提示**，看起来像「文件读完了」；
- 缩小时，仍按旧 size 收口 —— 读窗越过新边界，会拉到 404/短读，尾部呈现垃圾或报错。

本域把「刷新后 size 何时被更新、何时被放弃、何时提示用户」三条契约钉成可执行判据：

1. **≤1MB 面（失效域）**：size 快照直接作废（`source.size → undefined`），重渲染时 dispatcher 视 size 为未知 → 走不定态泵 / 全量回退读，**增长字节自然上屏**；该面**不进回填通道**（不发父目录 tree 请求、不发增长提示）。
2. **>1MB 面（回填域）**：refresh 时按**父目录分组**向树面拉一次 `listChildren`，用新鲜条目的 size **回填** `source.size`，随后 `rev++` 触发**恰一轮**重渲染并按新鲜 size 收口；检出**增长**时附状态条「文件已变更：<文件名>」提示；**回填失败**（父目录列举 500 / 条目缺 size）时**放弃回填、即时重渲染**，仍按陈旧 size 收口且**不发提示**。
3. **通道等价**：手动刷新（TabBarMenu「刷新当前文件」）与 SSE changed 同走 `refreshPaths`，两通道的父目录拉取、回填、提示语义一致。

## 2. 场景清单

公共装置：域内自建假 vviewer 文件服务器（`/api/health`、`/api/ticket`、`/api/events` SSE 挂连登记 + 帧注入、`/api/tree` 条目 size 可汇报/可省略 + 按父目录精确路径 500 失败门、`/api/file` 206 精确切片并钳 `end=min(req.end, len-1)`），服务器侧自记请求日志（pathname / `?path=` / Range 头 / HTTP 状态 / 响应体字节数 / JSON 响应体文本）。文件置于**子目录**（如 `sub/`）——父目录可寻址是回填通道的前提，置于根目录时回填请求与树重建根列举不可分辨。

| 编号 | 前置条件 | 步骤 | 期望 | 关联缺陷 |
| --- | --- | --- | --- | --- |
| STR-NEST-01 | 假服务器；`sub/small.bin` = 65536B 全 0x41，树面 size=65536 | ① 连接服务器→树中打开 `sub/small.bin`；② 状态行见 `64.0 KB`；③ **前提判据**：变更前业务读恰 1 条且 `Range: bytes=0-65535`（≤1MB 且 size 已知 → pumpFull 单窗读）；④ 实体换 98304B（新增区 0x42），树面 size 同步；⑤ SSE 推 `changed: [sub/small.bin]` | ① 状态行改见 `96.0 KB`（不再见 `64.0 KB`）；② 变更后业务 `/api/file` 响应体恰有 **1** 条长度 = 98304，且无任何业务读响应体 > 98304（未按旧 size 窗口化）；③ 变更后 `/api/tree` 请求集合**不含** `path=sub`（不进回填通道），但含 `path=`（树重建根列举在场）；④ 滚到底：`.vv-hex-row` 末行（偏移 `00017ff0` = 98304-16）文本含 `42`（增长字节上屏）；⑤ 状态条**不含**「文件已变更」；⑥ `.vv-error-card` 计数 = 0；⑦ **收尾复核**：变更后探针读（`bytes=0-8191`）恰 1 条 → 恰一轮重渲染 | —（A1 修复回归锚：≤1MB 失效域） |
| STR-BACKFILL-01 | 假服务器；`sub/big.bin` = 2MB，树面 size=2097152 | ① 打开文件（状态行 `2.0 MB`）；② 实体换 3MB、树面 size=3145728；③ 对 `/api/tree?path=sub` 精确布防 500；④ SSE 推 changed | ① 变更后 `/api/tree` 请求中恰有 **1** 条 `path=sub` 且状态 500（回填通道确实发起并失败）；② 状态行**仍**含 `2.0 MB`、**不含** `3.0 MB`（放弃回填、按陈旧 size 收口）；③ 变更后全部业务 `/api/file` 请求 Range 终点 < 2097152（增长区从未被读取）；④ 变更后**恰一轮**重渲染：探针读恰 1 条（回落即时 rev++，刷新通道未被阻塞）；⑤ 状态条**不含**「文件已变更」、**不含**「加载失败」（树重建根列举仍 200）；⑥ `.vv-error-card` 计数 = 0；⑦ **收尾复核**探针读仍恰 1 条 | —（A1 修复回归锚：回填失败回落） |
| STR-BACKFILL-02 | 假服务器；`sub/big.bin` = 2MB，树面 size=2097152 | ① 打开文件；② 实体换 3MB，树面条目改为**省略 size 字段**；③ SSE 推 changed | ① 变更后 `/api/tree` 请求中恰有 **1** 条 `path=sub` 且状态 200，其响应体解析后 `big.bin` 条目**不含 `size` 键**；② 状态行**仍**含 `2.0 MB`、**不含** `3.0 MB`（size 未知 → 不回填、只 rev++）；③ 变更后全部业务读 Range 终点 < 2097152；④ 变更后**恰一轮**重渲染：探针读恰 1 条；⑤ 状态条**不含**「文件已变更」；⑥ `.vv-error-card` 计数 = 0 | —（A1 修复回归锚：条目缺 size） |
| STR-BACKFILL-03 | 假服务器；`sub/a.bin`、`sub/b.bin`、`other/c.bin` 各 2MB → 3MB | ① 依次打开三个文件（三个 tab）；② 三文件实体与树面 size 同步换 3MB；③ SSE 推 changed（三个路径） | ① 变更后 `/api/tree` 请求中 `path=sub` 恰 **1** 条、`path=other` 恰 **1** 条（同父目录多 tab 合并为一次 listChildren）；② 活动 tab（c.bin）变更轮**恰一轮**重渲染：探针读恰 1 条；③ 切到 `a.bin`/`b.bin`/`c.bin` 三个 tab，各自状态行含 `3.0 MB`（不含 `2.0 MB`）、各自 `.vv-error-card` 计数 = 0（三个 tab 各自完成回填）、**每次激活该 tab 的探针读增量恰 1**；④ 状态条文本匹配 `/文件已变更：(a\|b\|c)\.bin/`（检出增长附提示；提示顺序随 tab 列表序，不写死文件名） | —（A1 修复回归锚：分组 + 多 tab 回填） |
| STR-SHRINK-01 | 假服务器；`sub/big.bin` = 3MB，树面 size=3145728 | ① 打开文件（状态行 `3.0 MB`）；② 实体换 2MB、树面 size=2097152；③ SSE 推 changed | ① 变更后 `/api/tree` 含 `path=sub` 且 200（回填确实执行过）；② 状态行改见 `2.0 MB`、**不含** `3.0 MB`（回填照常生效、按新 size 收口）；③ 变更后业务读 Range 终点**最大恰为 2MB-1**（既不越新边界、也不未按新边界收口）；④ 变更后**恰一轮**重渲染：探针读恰 1 条；⑤ 状态条**不含**「文件已变更」（增长谓词不成立故不发提示）；⑥ `.vv-error-card` 计数 = 0 | —（A1 修复回归锚：缩小面） |
| STR-CHANNEL-01 | 假服务器；`sub/big.bin` = 2MB → 3MB；**全程不推 SSE 帧** | ① 打开文件（状态行 `2.0 MB`）；② 实体换 3MB、树面 size=3145728；③ TabBarMenu →「刷新当前文件」 | ① 点击后 `/api/tree` 请求含 `path=sub` 且 200（手动通道同样发起父目录拉取）；② 状态行含 `3.0 MB`（不含 `2.0 MB`）；③ 变更后业务读存在 Range 终点 == 3145727 的请求（按新鲜 size 取到尾部）；④ 变更后**恰一轮**重渲染：探针读恰 1 条；⑤ `path=sub` 恰 **1** 条（手动刷新与 SSE 同为一次 refreshPaths → 一次父目录列举）；⑥ 状态条含「文件已变更：big.bin」；⑦ `.vv-error-card` 计数 = 0 | —（通道等价锚） |

## 3. 验收行为

本域无既有缺陷编号（STR 为新增规格行为域），故本节以「修复后应有行为（回归验收判据）」形式给出契约清单，逐条对应上表场景。

### 3.1 契约清单

1. **≤1MB 面：失效而非回填**（STR-NEST-01）
   - SSE changed / 手动刷新命中 ≤1MB 且 size 快照已知时，`source.size` 被置为失效（`undefined`），重渲染不再以旧 size 收口；
   - 渲染结果按实际字节长度物化，增长字节**上屏**（末行布点可见）；
   - 该路径**不得**发起父目录 `listChildren`（否则就是回填域而非失效域），**不得**发「文件已变更」提示；
   - **前提判据**：打开时 size 快照必须已知（变更前业务读恰 1 条 `bytes=0-65535` 的泵化单窗读）——否则用例会因「打开即 size 未知全量回退读」这一错误原因通过，失效域分支并未被证明；
   - 回归护栏：树重建（`storeRevisions` 自增 → 左栏树重挂）仍只列举根目录，不因 size 失效而多打父目录请求。
2. **>1MB 面：回填成功路径**（STR-BACKFILL-03、STR-SHRINK-01、STR-CHANNEL-01）
   - 回填以**父目录**为单位聚合：同一父目录下的多个 tab **合并为一次** `listChildren`（不得按 tab 逐个拉取）；
   - 新鲜条目 size 与快照不同即 copy-on-write 回填 `source.size`，**先回填、后 `rev++`**，确保只发生**恰一轮**重渲染且该轮按新鲜 size 收口；「恰一轮」的判据是**探针读计数**（`Range: bytes=0-8191`，dispatcher 每渲染轮恰发一次 head 探测读，dispatcher.ts:63/:403；≤1MB 且 size 已知时该轮走 pumpFull 单窗读、不发探针读）——实现若退化为「先 rev++ → 回填 → 再 rev++」双轮渲染，探针读计数为 2 即红；
   - 检出**增长**时提示「文件已变更：<文件名>」；检出**缩小**时回填照常生效但**不发**增长提示（提示谓词只认增长）。
3. **>1MB 面：回填失败 / size 未知路径**（STR-BACKFILL-01、STR-BACKFILL-02）
   - 父目录列举失败（HTTP 500）或新鲜条目缺 `size` → **放弃回填、即时重渲染**，仍按陈旧 size 收口；不产生增长提示、不产生错误卡片；
   - 回落不得**阻塞**刷新（重渲染照常发生：探针 + 结构尾窗读），读窗不得越过陈旧边界。
4. **通道等价**（STR-CHANNEL-01）：手动刷新与 SSE changed 走同一 `refreshPaths` 入口，父目录拉取次数、回填结果、提示语义三者一致。
5. **提示可见性**：增长提示为状态条瞬时提示（`showStatusNotice` 默认 4s TTL），验收须覆盖整个变更窗口（见 §6.4 录制器），不得以「点检时恰好不在」判否。

### 3.2 与既有锚 IO-03 / IO-03a 的分工

既有锚 `apps/web/e2e/b-io-streaming.spec.ts`：`:410 IO-03`（SSE changed 重渲染免全量重读——增量 < 2MB 窗口级）、`:449 IO-03a`（>1MB 面四判据：提示文案「文件已变更：big.bin」/ 状态栏 `11.0 MB` / ≥10MB 起点 Range / 末尾字节 `0xaffff0` 上屏）。

| 面 | 既有锚（IO-03 / IO-03a） | STR 域（本文件） |
| --- | --- | --- |
| 「新鲜 size 收口」语义 | IO-03a（单文件、根目录 `big.bin`、10MB→11MB） | 不重复该形态；STR 域在多 tab / 分组 / 手动刷新语境下复用同一语义 |
| 「文件已变更」提示文案 | IO-03a（点检式，等待窗口内命中） | STR 域用状态条**历史录制器**判在场/缺席（覆盖 4s 瞬时窗，见 §6.4） |
| 免全量重读（增量 < 2MB） | IO-03 | STR 域以「读窗不越陈旧边界」「尾窗终点恰为新边界」等更细判据替代 |
| **STR 域新增面** | —— | ①≤1MB 失效域（含前提判据）；②回填失败回落；③条目缺 size 不回填；④**父目录分组合并计数**与多 tab 各自回填；⑤缩小面回填不发提示；⑥**手动刷新入口**与 SSE 通道等价；⑦**恰一轮重渲染**（探针读计数） |

**后续维护口径**：改「增长提示」或「新鲜 size 收口」语义时，**以 IO-03a 为主锚**，STR 域在该语义变更下只校验分组 / 回落 / 入口 / 恰一轮面；若 IO-03a 与 STR 域断言冲突，以 IO-03a 的语义为准并同步两处断言（避免双头维护漂移）。

## 4. 计划缺口对照（STR focus 段四条零锚缺口）

计划来源：`.temp/e2e-workflow/plan-e2e-strengthen.dwf.ts` STR 条目 focus 段「【零锚缺口】」四条。**下表逐条给出覆盖状态；未闭合项显式留白，不默认视为已闭合。**

| # | 计划缺口原文 | 覆盖状态 | 落点 / 未覆盖原因 |
| --- | --- | --- | --- |
| ① | 「≤1MB 失效分支无直接锚（IO-03 只覆盖 >1MB 面）」 | **已闭合** | STR-NEST-01（另含「变更前 size 快照已知」前提判据，确保走的是失效域而非 size 未知全量回退读这一错误原因） |
| ② | 「backfillStreamingSizes 失败回落分支（store 缺失/无 listChildren/listChildren 抛错 → 放弃回填、即时 rev++，:568-571,584-587）无锚」 | **部分闭合**：`listChildren` 抛错子分支已覆盖；**`store 缺失 / 无 listChildren` 子分支（tabsModel.svelte.ts:568-571）未覆盖** | 已覆盖：STR-BACKFILL-01（父目录 tree 500 → 抛错 → 放弃回填、即时 rev++、按陈旧 size 收口、无增长提示）。未覆盖原因：e2e 的 UI 路径上 store 必然存在（remote store 由 `connectServer` 建，serverConnect.svelte.ts:104-175），且 remote store 必带 `listChildren`（remote.ts:362）——该子分支在 UI 路径**不可触发**；唯一可覆盖面是模型层单测，而 `tabsModel.svelte.ts` 是 **runes 模块（.svelte.ts）不可 vitest 直测** → **该子分支全域无锚**（非本域可闭合，须换装置或改模块形态） |
| ③ | 「size 未知不回填（树面条目缺 size → 仅 rev++）无锚」 | **部分闭合**：「条目缺 size 键」已覆盖；**非有限数 / null 子分支（tabsModel.svelte.ts:592-594 的 `typeof fresh.size === 'number' && Number.isFinite(fresh.size)` 守卫另两路）未覆盖** | 已覆盖：STR-BACKFILL-02（树面条目省略 size → 不回填、只 rev++、按陈旧 size 收口、无增长提示）。未覆盖原因：`remote.ts:370` 只在 `e.size !== undefined` 时透传 size，而树面 JSON 无 `null` 产出路径、`NaN/Infinity` 非合法 JSON 值 → 该子分支**无法经装置构造**（夹具只能省略 size 键）→ **该子分支全域无锚** |
| ④ | 「提示钩子未注入时静默（:552）无锚」 | **未覆盖** | 钩子 `setSseChangedNotice`（声明 tabsModel.svelte.ts:548、注入函数 :551）由 `openFlow.svelte.ts:52` 在**模块加载期**注入 → e2e 页面必然已注入，「未注入」态**不可经 UI 构造**（静默调用点为 :598 的 `sseChangedNotice?.(...)`）；且 `tabsModel.svelte.ts` 为 runes 模块不可 vitest 直测 → **该缺口全域无覆盖**（既非本域，也无其他域；后续若要闭合，须引入可注入钩子的模型层单测面） |

## 5. 域外零锚项登记（本域未覆盖，显式留白）

以下项在计划 STR focus 或源码核查中被指出为「零锚」，**本域未覆盖**，登记以免读者误以为已闭合：

| 项 | 源码位置 | 未覆盖原因 |
| --- | --- | --- |
| 第三个 `refreshPaths` 调用点：direct 挂载 S3/DAV 的 watch | openFlow.svelte.ts:261 | 本域只覆盖 `serverConnect.svelte.ts:88`（SSE 帧）与 `TabBarMenu.svelte:212`（手动刷新）两个入口；direct 通道需 S3/DAV 装置，超出本域装置范围 |
| `autoRefresh` 关闭时 SSE changed 整条丢弃（不刷新/不回填/不提示） | serverConnect.svelte.ts:87 | 需改设置并复位的额外装置；连带「手动刷新不受 autoRefresh 限制」的**通道不对称**（TabBarMenu.svelte:210 明文）同样未覆盖 |
| `paths` 过滤分支：changed 帧路径与已开 tab 不匹配 → 该 tab 不刷新/不回填/不提示 | tabsModel.svelte.ts:437 | 本域的 SSE 帧均命中已开 tab；未覆盖「不匹配路径」的过滤行为 |
| 手动刷新且活动 tab 是**目录 tab** → `refreshPaths(storeId, [])` → 全 store 刷新 + 多父目录分组回填 | TabBarMenu.svelte:212 注释 | 本域手动刷新场景的活动 tab 恒为文件 tab；目录 tab 活动态的全 store 刷新语义未覆盖 |
| **跨 1MB 分支边界**：≤1MB 文件经失效域后 `source.size` 被置 undefined，此后即便实体长到 >1MB，该 tab 也不再入 streaming 队列（`size` 判定落空 → 只 rev++）→「失效域吃掉 size 快照后 >1MB 面永久失去回填与增长提示」 | tabsModel.svelte.ts:454 / :462-463 | 本域夹具**刻意让变更前后两端都在同一侧**（不跨 `FULL_LIMIT_BYTES`=1_048_576 边界），故该后果未被本域钉死——属**刻意留白**（跨边界会同时改变失效域/回填域两条分支的判定，混入本域会削弱各场景的分支纯度）；该后果需单列场景（且需澄清「失效域是否应恢复 size 快照」的产品口径）后再补 |

## 6. 环境与数据

### 6.1 套件

- Playwright 套件：`apps/web/playwright.config.ts`（chromium + mobile 375×667 两项目，`baseURL http://127.0.0.1:4173`，vite preview 由 `webServer` 自起；`retries: 1`——CI 报告需另看 flake 计数，勿把「重试后绿」当通过）。
- 本域用例**不跳过 mobile**：交互路径（连接服务器菜单、树展开开文件、tab 切换、hex 滚到底）均已在移动视口下成立（抽屉断点由既有 `openDrawerIfNarrow` / `closeDrawerIfOpened` 适配）；末行断言取**文本**而非几何，避开窄视口几何脆弱面。

### 6.2 夹具规格

| 夹具 | 规格 | 用于场景 |
| --- | --- | --- |
| `sub/small.bin` | 变更前 65536B 全 0x41；变更后 98304B（前 65536B 0x41、新增区 0x42），树面 size 同步 | STR-NEST-01 |
| `sub/big.bin` | 2MB 或 3MB 全 0x41（>1MB，两端都不跨 `FULL_LIMIT_BYTES`=1_048_576 分支边界——跨边界后果见 §5 留白条目）；树面 size 同步 | STR-BACKFILL-01/02、SHRINK-01、CHANNEL-01 |
| `sub/a.bin`、`sub/b.bin` | 各 2MB → 3MB，同父目录 | STR-BACKFILL-03 |
| `other/c.bin` | 2MB → 3MB，另一父目录 | STR-BACKFILL-03 |

字节布点规则：前 `split` 字节 0x41、其后 0x42；`split` 取旧长度 → 增长区恰在 `[旧长度, 新长度)` 区间，末行偏移 = 新长度-16 必落增长区（98304-16 = 98288 = `0x17ff0`）。

### 6.3 假服务器能力与请求计量

- 路由：`/api/health`（capabilities 含 `file-server`）、`/api/ticket`、`/api/events`（SSE 长连接，登记 `res` 便于帧注入；首帧写 `: ping` 注释冲刷响应头）、`/api/tree`（按 `?path=` 聚合条目；文件条目**仅在 size 汇报时**带 `size` 字段，目录条目不带；失败门按**父目录精确路径**布防，其余路径照常 200）、`/api/file`（`Range: bytes=a-b` → 206 + `Content-Range`，`end=min(b, len-1)` 钳制）。
- 计量：请求日志在**服务器侧**自记（不依赖页面网络栈，SW 拦截面不影响计数）；「业务读」= `/api/file` 且**非 git 探测通道**（`probeGitAvailability` 逐级向上读 `.git/HEAD` 产生 404，须剥离，否则读数与尾窗判定被污染）。
- 帧注入：`changed` 帧体 `{"type":"changed","paths":[...]}`，与 `remote.ts` 的 watch 帧协议一致。

### 6.4 关键耦合与注意事项

1. **树重建耦合**：`refreshPaths` 开头 `storeRevisions[storeId]++` → `AppShell` 的 `treeKey` 变化 → `{#key treeKey}` 重挂 `FileTree` → `TreeNodeRow` 展开态复位 → 树**只重新列举根目录**（`path=`）。故：≤1MB 面变更后 `/api/tree` 请求集合应含 `path=` 而**不含** `path=sub`；回填域的 `path=sub` 请求则**只可能**来自回填通道（可据此做「恰 1 条」计数）。
2. **「恰 1 条」计数前提（已知耦合）**：上述计数以「树重建后展开态复位、树只重列根目录」为前提（`TreeNodeRow.svelte:21` 局部 `$state` + `AppShell.svelte:715/1271` 的 `{#key treeKey}`）。若日后改为展开态持久化，该计数基线须同步重估（树会额外列一次 `path=sub`）。
3. **失败门只按父目录精确路径布防**：若连根列举也 500，左栏树会写「加载失败」状态提示，污染 STR-BACKFILL-01 的缺席断言；因此 500 只对 `?path=sub` 生效。
4. **状态条瞬时提示**：提示 TTL 4s（`showStatusNotice`），点检式断言会漏检。用例以 `MutationObserver` 录制 `.vv-statusbar` 的**历史文本**（`page.addInitScript` 注入，页面内数组），再用「历史中是否出现过」判定在场/缺席；所有**缺席**断言（「不含文件已变更」「不含加载失败」）先证状态条历史中**出现过**其它文本（如「二进制」渲染器标签），避免状态条整体缺席导致的恒真。
5. **首屏收口信号**：`.vv-hex-status` 带上结构解析结果（`· 未知二进制`）意味着首屏结构尾窗读已完成（hex 结构解析在尾窗 `ensure` 之后落），变更前后分界标记取在该信号之后，避免把首屏尾窗读误计到「变更后」。**耦合面**：该文案出自 `hex.ts:750`（结构解析失败时为 `· 结构解析失败`），文案变更需同步该门。
6. **探针读语义（`PROBE_RANGE = 'bytes=0-8191'`）**：dispatcher 每渲染轮恰发一次 head 探测读（`HEAD_SIZE`=8192，dispatcher.ts:63/:403）；≤1MB 且 size 已知时该轮走 pumpFull 单窗读（`bytes=0-65535`，dispatcher.ts:93-94）**不发**探针读 → 「探针读条数」= 「渲染轮数」，本域据此钉「恰一轮重渲染」（实现退化为双轮渲染时计数为 2 即红）。收尾复核而非中途快照，避免第二轮渲染晚到被判绿。
7. **SSE 就绪门（两段）**：① 服务端挂连计数 > 0；② 注入一条**不命中任何已开 tab** 的 changed 帧（心跳），待其引发的树重建（根列举 `path=''`）出现——该请求只可能由浏览器侧消费帧后触发，故是「帧已送达并被处理」的浏览器侧证据（只靠①可能把帧注入在 EventSource 就绪前 → 帧静默丢失）。
8. **读窗边界语义**：>1MB 面的结构尾窗为 65557 字节（`STRUCT_TAIL_BYTES`），故「变更后读窗不越陈旧边界」以 Range **终点**判定（探针 0-8191、尾窗块 30/31 等），而非以请求条数或响应体总量判定；STR-SHRINK-01 用「终点最大值恰为 2MB-1」同时钉住「不越新边界」与「确按新边界收口」。
9. **「恰 N 条」计数**：请求到达存在时序差，先用轮询证「通道确实发起」（≥1）并等重渲染证据到位，再在场景末尾做精确计数（==1）；不用单次 `waitForFunction` 判定。
10. **多 tab 同父目录**：树目录行点击是 **toggle**，同目录多文件只展开一次（二次点击会收起）；用例按「已展开目录集合」去重。

### 6.5 场景编号登记

本域场景编号共 6 个（脚本内 test 标题即以场景 ID 开头，便于由测试名反查本表）：

- `STR-NEST-01` — ≤1MB 面失效域（含「变更前 size 快照已知」前提判据）
- `STR-BACKFILL-01` — 回填失败回落（listChildren 抛错子分支）
- `STR-BACKFILL-02` — 新鲜条目缺 size 不回填
- `STR-BACKFILL-03` — 父目录分组 + 多 tab 各自回填
- `STR-SHRINK-01` — 缩小面回填（不发增长提示）
- `STR-CHANNEL-01` — 手动刷新与 SSE 通道等价

（编号前缀 `STR` = size 回填域；与首轮报告测试点编号不连续，属 spec 驱动续编域，登记口径同 `docs/e2e/README.md` §2.1。）
