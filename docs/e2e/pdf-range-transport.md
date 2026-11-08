# PDFX 域（pdf Range transport 补强） — e2e 场景

> 来源：pdf Range transport 域补强（实现侧 `packages/vviewer-render-doc/src/pdf.ts` 的 streaming 分流 + `packages/vviewer-core/src/dispatch/dispatcher.ts` 的读策略镜像）。既有锚 `apps/web/e2e/b-pdf-range.spec.ts`（PDF-RANGE-00~07）依赖库外 binary 夹具（`apps/web/e2e/fixtures/corpus/pdf-linearized/progressive.pdf`，`.gitignore` 内），**其中 6 个用例仍受夹具门禁**（PDF-RANGE-01/02/03/05/06/07 逐用例 `test.skip(!hasFixture, FIXTURE_HINT)`），缺夹具环境静默 skip。
>
> **本域的结论边界（不夸大）**：本域**只保证自身新锚不空心化**（夹具全部代码内合成，无条件 skip）；域正主既有锚的 4 个面（PDF-RANGE-01 渐进 / 03 非 Range store 退化 / 05 取消 / 07 S3 直连）**仍仅由库外夹具门禁**，本域未提供替代锚，CI 缺夹具环境这 4 例仍静默空心化。另 2 个被门禁的面（PDF-RANGE-02 size 未知请求形态 / 06 M1 读失败错误卡）在本域有**夹具自持的等价锚**（PDFX-MEMO-01/02、PDFX-M1-01）。
>
> 脚本：`apps/web/e2e/b-pdf-range-2.spec.ts`（PDFX-LOCAL-01/02、PDFX-MEMO-01~05、PDFX-CARD-01/02、PDFX-M1-01/02、PDFX-FIX-01，chromium project）。装置自建在本文件内（迷你假 vviewer 服务器 / 合成 PDF / Blob 读切片计量 / 进度卡观察器 / pdfjs worker 协议桩），不抽公共 helper 文件；只读复用 `./helpers` 的 `waitAppMounted` / `openFile`。

## 1. 目的与来源

pdf 渲染器的 streaming 形态由三处分流决定（`pdf.ts:180-196`）：

| 前提 | 分支 | 数据面 |
| --- | --- | --- |
| `ctx.size` 已知 ∧ store `rangeCapable` ∧ `buffer.byteLength < ctx.size` | transport（`PDFDataRangeTransport` + `ctx.read` 窗段读） | 按需窗段读，零整文件物化 |
| `ctx.size === null`（远端 size 未知） | `memoizedFullRead` 单发全量补拉（`pdf.ts:56-67`） | 全量 `getDocument({data})`，补拉按 ctx 记忆 |
| 其余（`!rangeCapable` / 本地 ≤1MB / ctx 缺失） | data 路径 | 全量 `getDocument({data})`，字节面零变化 |

既有锚只钉了「渲染面 + 请求形态」的少数点位，以下分支面此前零锚：

1. **本地来源 1MB 阈值两侧的读形态**（LOCAL-01/02）——`localFiles.ts:70` 与 `localFs.ts:75` 均 `rangeCapable:true`，本地 >1MB 时 dispatcher 走探测块 + transport 窗段读；既有 PDF-RANGE-04 只覆盖 ≤1MB 小体量（钉渲染面 + 零远端请求），不钉读形态。小件夹具贴近阈值下侧（1MB-1 字节）以使「阈值向下漂移」可被发现。
2. **懒渲染路径**（LOCAL-01）——夹具 5 页 > `IMMEDIATE_PAGES=3`（`pdf.ts:26`），第 4+ 页走 IO 懒渲染，此前 3 页夹具只覆盖「文档打开 + 立即渲染」段。
3. **memo 记忆 + transfer 毒化防护链**（MEMO-01）——`getDocument` 会 transfer `data.buffer`（主线程副本 detach），memo 必须存字节本体、每次消费返回 `.slice()` 副本；失败不记忆故可重试。此前只有单测（`packages/vviewer-render-doc/test/pdf-render.test.ts`）覆盖，无「渲染失败 → 重试 → 成功且零重复下载」的端到端链锚。
4. **全量补拉读失败面**（MEMO-02）——补拉读失败经 dispatcher 归类 `read` 上抛（`dispatcher.ts:539`），落 ViewerPane 读取失败卡片（该卡片**不带动作钮**），此前零锚。
5. **pdfjs worker 三条失败分支**（MEMO-03/04/05）——资产不可达（abort）、资产 404（装配失败）、握手 data 非 Uint8Array（`pdf.mjs:16305` 的 ready 门）→ fake worker 回落（同 URL 动态 import）→ 文档开启 reject。此前零锚。
6. **进度卡缺席面与正向对照**（CARD-01/02）——transport 路径零 `tracker.update` → `tracker.pumped=false` → 完成态卡门（`ViewerPane.svelte:936`）与进度卡门同时不成立；缺席断言须有对照面（远端 ≤1MB 泵路径出卡）方能排除「该分支本就不产卡」。
7. **M1 收口的资源面与静默分支**（M1-01/02）——`loadingTask.destroy()` 在 setup 段 `await` 永挂（pdfjs `pdf.mjs:15557-15575`），`pdf.ts:279` 的 `_worker?.destroy()` 是唯一可达的终止路径；既有 PDF-RANGE-06 只钉「错误卡片出现而非悬挂」，不钉 worker 零泄漏与请求流停止。另一侧（文档已开后的懒页读失败 → 静默）此前零锚。
8. **夹具自持守卫**（FIX-01）——禁夹具条件 skip、禁库外夹具依赖、合成夹具结构与确定性锚。

## 2. 场景清单

公共环境：default 套件（chromium project，桌面视口）；PDFX-MEMO-01/03/04/05 额外挂 `test.use({ serviceWorkers: 'block' })`（page.route 拦不到经 SW 的请求——`b-cdn-diagram-engines.spec.ts:118-120` 先例；pdf worker 资产为 `.mjs`（`build/_app/immutable/assets/pdf.worker.min.<hash>.mjs`）且 precache globPatterns 只覆盖 js/css/woff2/json（`apps/web/vite.config.ts:593`）故不入 precache，阻断 SW 只为让请求必经页面网络栈）。

| 编号 | 前置条件 | 步骤 | 期望 | 关联缺陷 |
| --- | --- | --- | --- | --- |
| PDFX-LOCAL-01 | 本地注入 5 页合成 PDF，总长 1,300,796B（> dispatcher `FULL_LIMIT`=1MB）；Blob 读/切片计量已装 | 树行点击打开 → **滚 `.vv-pdf-pages` 到底**（PDF 自身的滚动容器，见 §4.3） | 渲染面：`.vv-pdf` 可见、`.vv-pdf-page` 计数 5、首个 `.vv-pdf canvas` 可见、`.vv-pdf-page-indicator` = `第 1 / 5 页`；**立即渲染面**：画布计数 === 3（`IMMEDIATE_PAGES`）；**懒渲染面**：滚 `.vv-pdf-pages` 到底后画布计数 > 3（IO 路径可达）；读形态：实读条数 ≥2、首条 8192B（探测块）、最大条长 ≤65536（`rangeChunkSize=2**16`）、存在 65536B 整窗读、**不存在**等于夹具总长的读（零整文件物化）；切片计量：存在父 Blob = 夹具总长且长度 ≤65536 的切片；缺席面：`.vv-dl-progress-done` 与 `.vv-dl-progress:not(.vv-dl-progress-done)` 计数均 0（**归因：本地来源非远端来源 → 无 tracker**，非 transport 因果） | 既有 PDF-RANGE-04 未覆盖本地 >1MB 分支与懒渲染路径 |
| PDFX-LOCAL-02 | 本地注入 2 页合成 PDF，**1,048,575B**（1MB-1 字节，贴近阈值下侧） | 树行点击打开 | 渲染面：`.vv-pdf-page` 计数 2、首个 canvas 可见、指示器 = `第 1 / 2 页`；读形态：实读**恰 1 条**且长度 = 夹具总长（`dispatcher.ts:401-404` 直读全量）；切片计量：父 Blob = 夹具总长的切片数 = 0（未进 transport，`pdf.ts:189` 的 `buffer.byteLength < ctx.size` 不成立） | 与 LOCAL-01 构成 1MB 阈值两侧的分支对照；贴近阈值使 FULL_LIMIT 向下漂移可被发现 |
| PDFX-MEMO-01 | 远端树条目与快照**双缺 size**（`ctx.size === null`）；pdf worker 由协议桩接管（握手成功、文档开启失败） | 打开文件 → 观察失败面 → 放行真 worker → 点「重试」 | 拦截自检：桩命中 ≥1；首次失败面：`.vv-error-card` 可见、`.vv-error-detail` 含 `PDFX worker stub: forced doc-open failure`（错误身份锁定）、首个 `.vv-error-action` 文本 = `重试`；请求面：目标文件恰 2 条（①探测块 `bytes=0-8191`/8192B ②全量补拉 `bytes=0-<MAX_SAFE_INTEGER>`/夹具总长）；重试成功面：错误卡片计数 0、首个 `.vv-pdf canvas` 可见、指示器 = `第 1 / 3 页`；**零重复下载**：5 次采样观察窗内目标文件请求恒为 2（memo 命中；毒化防护为双层，端到端面以行为面为准——见 §3.2） | memo 记忆此前无端到端锚；与被夹具门禁的 PDF-RANGE-02 请求形态等价（夹具自持版） |
| PDFX-MEMO-02 | 远端树条目与快照双缺 size；服务端首个「全量补拉」请求返 HTTP 500（其后 206 全量） | 打开文件 → 再点树行同文件（新 tab） | 不挂起：`.vv-error-card` 可见、`.vv-error-detail` 含 `HTTP 500`（读取失败面而非渲染失败面）、**`.vv-error-action` 计数 === 0**（读失败卡不带动作钮；渲染失败卡有 3 个——见 MEMO-03）；请求计量：探测块恰 1 条 + 全量补拉恰 1 条（`served=false`）；零污染：新 tab 渲染成功（canvas 可见、指示器 `第 1 / 3 页`、错误卡片计数 0）；计量收口：目标文件请求计数 = 4 且末条 `servedLen` = 夹具总长（失败尝试未留缓存/闩锁） | 读取失败卡片不带动作钮（见 §3 EX-PDFX-MEMO-RETRY 记账） |
| PDFX-MEMO-03 | 远端树条目与快照双缺 size；pdf worker 脚本请求被 abort（资产不可达） | 打开文件 | 拦截自检：worker 请求命中 **≥2**（worker 脚本 + fake worker 动态 import 两次——回落链确已触发）；不挂起：`.vv-error-card` 可见、`.vv-error-detail` 含 `Setting up fake worker failed` 与 `Failed to fetch dynamically imported module`（回落链失败原文，错误身份锁定）、首个动作钮 = `重试`、**动作钮计数 === 3**（渲染失败面）；读面未被污染：目标文件恰 2 条（探测块 + 全量补拉/夹具总长） | pdfjs fake worker 回落路径此前零锚 |
| PDFX-MEMO-04 | 同上；pdf worker 资产 **404**（装配失败分支） | 打开文件 | 拦截自检：命中 ≥2；不挂起：`.vv-error-card` 可见、`.vv-error-detail` 含 `Setting up fake worker failed`、首个动作钮 = `重试`；读面未被污染：目标文件恰 2 条 | 与 MEMO-03 的差别仅在失败原因文案（404 vs 网络失败），回落链相同 |
| PDFX-MEMO-05 | 同上；pdf worker 桩握手失败（`ready` 的 data 非 Uint8Array → 主线程 ready 门 `pdf.mjs:16305` 判失败 → terminateEarly → fake worker 回落） | 打开文件 | 拦截自检：命中 ≥2（worker 脚本 + 页侧动态 import 回落）；不挂起：`.vv-error-card` 可见、`.vv-error-detail` 含 `Setting up fake worker failed`、首个动作钮 = `重试`；读面未被污染：目标文件恰 2 条 | pdfjs 握手门分支此前零锚 |
| PDFX-CARD-01 | 远端树条目带 size（1,300,796B → transport 分支）；进度卡观察器已装（`MutationObserver` 双旗 + 活性计数） | 打开文件 | 前提：目标文件请求含探测块 `bytes=0-8191` + ≥1 条 `start ≥ 8192` 的窗段请求；渲染成功：canvas 可见、指示器 = `第 1 / 5 页`；缺席断言（双旗分列）：`__vvDlSeenDone === false` 且 `__vvDlSeenLoading === false`（完成态卡自身带 `.vv-dl-progress` 类，合并计数会把完成态误判为下载中卡）；观察器活性 `__vvMutCount > 0`；DOM 复核：两类卡计数均 0 | transport 渐进装载期零进度卡此前零锚 |
| PDFX-CARD-02 | 远端树条目带 size（20,000B ≤1MB → dispatcher 泵路径）；进度卡观察器已装 | 打开文件 | 前提：目标文件**恰 1 条**请求 `bytes=0-19999`（≤1MB 直读泵，单条全量窗，无探测块——与 transport 路径形态可区分）；渲染成功：canvas 可见、指示器 = `第 1 / 3 页`；**正向对照**：观察器记 `__vvDlSeenLoading === true` 且 `__vvDlSeenDone === true`，完成态卡文本含 `card2.pdf`（完成态 TTL=4s，DOM 复核会与 TTL 竞态，故以观察器记录为准） | CARD-01 缺席断言的正向对照面（否则无法区分「因 transport 零卡」与「该分支本就不产卡」） |
| PDFX-M1-01 | 远端树条目带 size（transport 分支）；`/api/file` 路由：放行探测块与无 Range 请求，abort 其余带 Range 窗段请求 | 打开文件 | 前提：pdf worker 创建数 ≥1、被 abort 的窗段请求 ≥1；收口：`.vv-error-card` 可见、`.vv-error-detail` 含 `Failed to fetch`（读失败身份）；**零泄漏**：`page.workers()` 中 pdf worker 数归零且其 `close` 事件已触发；请求流停止：先等计数自然静止（连续 3 次采样不变）取基线，再于 1.6s 观察窗内计数恒为基线 | `pdf.ts:279` `_worker?.destroy()` 私有字段兜底此前零锚 |
| PDFX-M1-02 | 远端树条目带 size；**mid 布局**合成 PDF（填充置于 pages 树之后、page 对象之前——probe 实测：文档打开只读「首块 + 尾块」，页面内容读中段块）；路由放行首块与尾块、abort 中段块 | 打开文件 | 文档已开信号：`.vv-pdf-page` 计数 5、指示器 = `第 1 / 5 页`；渲染期窗段读被 abort ≥1；**静默分支**（docOpened 门控，`pdf.ts:239-247`）：读失败不落错误卡（`.vv-error-card` 计数 0）、该页画布不出（`.vv-pdf canvas` 计数 0——渲染 promise 因缺块永久 pending → 画布不挂载） | 文档已开后的静默分支此前零锚 |
| PDFX-FIX-01 | 无（纯源码/夹具守卫） | 读自身源码 + 域正主既有锚源码 + 合成夹具 | 守卫 1a：本文件所有 skip/fixme 调用行（含 `test.describe.skip`/`test.fixme` 等异体）必须含 `project.name`；守卫 1b：域正主既有锚的夹具条件 skip 必须带**可再生命令**（禁静默空心化）；守卫 2：本文件只允许读仓内 `.ts` 源文件（自身 + 域正主），且代码面（去注释）不得出现语料/夹具目录字面量；守卫 3：三档合成夹具字节数与结构（1,300,796 / 1,048,575 / 20,000；`%PDF-1.4` 头 / `%%EOF\n` 尾 / `/Count N` 页数；小件贴近 1MB 阈值、memo 件 > 探测块 8KB）；守卫 4：同参两次合成 sha256 摘要相等 | 本域新锚不空心化的自持证明 |

## 3. 验收行为（关联产品行为的验收判据）

以下判据是本域各锚「红了即产品行为变了」的对照面；实现阶段不得为迁就测试改产品代码。

### 3.1 transport 分流判据（LOCAL-01 / LOCAL-02 / CARD-01 / CARD-02）

- **数据面判据**：本地 >1MB 的 PDF 打开时，store 侧不得出现「一次读完整个文件」的读；实读条长上界 = pdfjs 窗段大小 64KB，且至少一条整窗读。
- **退化判据**：本地 ≤1MB 的 PDF 打开时，store 侧恰一次整读，且零窗段切片。两者构成 1MB 阈值两侧的分支对照；小件夹具贴近阈值下侧（1MB-1 字节），阈值**向下**漂移（1MB→512KB/256KB）时 LOCAL-02 的读形态判据即红。
- **懒渲染判据**：页数 > `IMMEDIATE_PAGES` 时，第 4+ 页须由 IO 触发的按需窗段读出（画布数增长），且增长过程不引入整文件物化。
- **进度面判据（成对）**：transport 路径（远端、tracker 在场、零 update → `pumped=false`）**不产生**「正在下载」卡与「下载完成」卡；远端 ≤1MB 泵路径（tracker 收到 update → `pumped=true`）**产生**两类卡。缺席断言方（PDFX-CARD-01）由对照面（PDFX-CARD-02）兜底——若 dispatcher 的 streaming 分支改为泵全量、或完成态卡门去掉 `tracker.pumped` 条件，CARD-01 打红。
- **本地来源归因（非远端）**：本地来源 storeId 前缀为 `localfiles:`，`isRemoteDownload`（`apps/web/src/lib/downloadProgress.ts:85`）恒 false → 无 tracker（`ViewerPane.svelte:826-831`）→ 本就不产卡。LOCAL-01 的零卡断言归因是「无 tracker」，不是「transport 零 update」；后者归 CARD-01。

### 3.2 memo 记忆与 transfer 毒化防护链（MEMO-01）

- **记忆判据**：同一 ctx 的全量补拉只发生一次；错误卡片「重试」重入 render 时经 memo 命中，零重复下载（观察窗多次采样：晚到的第 3 条请求亦被抓，而非固定等待后放行）。
- **毒化防护判据（双层，端到端面不区分层）**：`getDocument` 会 transfer `data.buffer`（主线程副本 detach 归零）。memo 必须存字节本体、每次消费返回 `.slice()` 副本（`pdf.ts:56-67`）；data 分支另交副本给 `getDocument`（`getDocument({ data: buffer.slice() })`）。两层皆为拷贝时，端到端面无法区分是哪一层在挡毒化，故本锚以**行为面**（重试成功 + 零重复下载）为准；「消费即拷贝」的拷贝契约本身由 `packages/vviewer-render-doc/test/pdf-render.test.ts` 单测锁。
- **失败不记忆判据**：补拉**读**失败不写 memo，后续打开重新取数（MEMO-02 计量收口段）。

### 3.3 读失败面与渲染失败面的分界（MEMO-02 / MEMO-03）

- 补拉读失败经 dispatcher 归类 `read` 向上 reject（`dispatcher.ts:539`），落 ViewerPane 的**读取失败卡片**（`.vv-error-detail` 含服务端状态码），与渲染失败卡片（带「重试」动作钮）分属两面。
- **动作钮判据（分界的可测面）**：读失败卡片动作钮数 = **0**（ViewerPane 的 catch 走 `showErrorCard(host, message, source)`，未传 actions）；渲染失败卡片动作钮数 = **3**（`重试` / `以 hex 打开` / `以纯文本打开`，`dispatcher.ts:266-276`）。若读失败被误分类为渲染失败，MEMO-02 的零动作钮判据即红。
- EX-PDFX-MEMO-RETRY（**记账项，本域不锚**）：读取失败卡片不带动作钮，用户无「原地重试」通道；本域不为此写产品改动，也不弱化断言迁就——后续如需该面，另立场景。

### 3.4 pdfjs worker 回落链（MEMO-03 / MEMO-04 / MEMO-05）

- 三条失败分支（资产 abort / 资产 404 / 握手 data 非 Uint8Array）均须落到**渲染失败卡片**（带「重试」）而非挂起。
- **错误身份判据**：回落链失败的原文含 `Setting up fake worker failed`（`pdf.mjs:16319-16338` 的 `#setupFakeWorker` catch）；资产不可达时另含 `Failed to fetch dynamically imported module`。文案变了即上游口径变更（预期复核面，非 flaky）。
- **读面未污染**：worker 失败发生在读面之后——探测块 + 全量补拉两条请求已正常完成。
- **上游锚（复核用，码锚以 pdfjs-dist 6.4.299 为准）**：ready 门 `!(data instanceof Uint8Array)` 在 `pdf.mjs:16305`；`terminateEarly` 在 `:16285`（其内 `:16292` 调 `#setupFakeWorker()`）；`PDFWorker.#isWorkerDisabled` 声明 `:16208`、读 `:16270`、置位 `:16322`（粘滞静态位：回落一旦触发，后续实例恒走回落路径，重试回不到真 worker——故 MEMO-01 的重试恢复链用协议桩而非「拦掉 worker 脚本」实现）。

### 3.5 M1 收口的资源面与静默分支（M1-01 / M1-02）

- mid-load 非 abort 读失败且文档未开 → `onReadFailure` → 竞速门 reject → render reject → 错误卡片（渲染失败面）。
- `loadingTask.destroy()` 在 setup 段 `await` 永挂（pdfjs `pdf.mjs:15557-15575`），`pdf.ts:279` 的 `_worker?.destroy()` 是唯一可达的 worker 终止路径；该行直访 pdfjs 私有字段 `_worker`（无公开销毁缝），升级 pdfjs-dist 时必须复核两存亡与可达性（`pdf.ts:270-278` 升级复核点）。
- 收口后：pdf worker 归零（`page.workers()`）且 `close` 事件已触发；在飞/后继窗段请求停止（先等计数静止取基线，再观察不再增长——不用固定窗口，避免慢机误判）。
- 另一侧：文档**已开**后的渲染期读失败按 `docOpened` 门控维持静默（`pdf.ts:239-247`）——不落错误卡、该页画布不出。

### 3.6 夹具自持守卫（FIX-01）

- 本 spec 不得出现夹具条件 skip（`test.skip(` / `test.describe.skip(` / `test.fixme(` / `test.describe.fixme(` / `testInfo.skip(` / `testInfo.fixme(` 且不含 `project.name`）——否则 CI 在缺夹具环境静默空心化。
- 域正主既有锚（`b-pdf-range.spec.ts`）的夹具条件 skip 必须带**可再生命令**（禁「无提示的空心化」）。
- 本 spec 只允许读仓内 `.ts` 源文件（自身 + 域正主），代码面（去注释后）不得出现语料/夹具目录字面量——即不得依赖库外 binary 夹具。
- 合成夹具须落在 1MB~2MB（大件）、贴近 1MB 阈值下侧（小件）、大于探测块 8KB（memo 件），结构可被 pdfjs 解析（`%PDF-1.4` 头 / `%%EOF\n` 尾 / `/Count N` 页数），且同参两次合成字节级确定（sha256 相等）。

### 3.7 与既有锚 / 邻域的分工（去重说明）

| 面 | 既有/邻域锚 | 本域锚 | 说明 |
| --- | --- | --- | --- |
| size 未知的请求形态（探测块 + 单条全量补拉 + 渲染后零新增） | PDF-RANGE-02（**受夹具门禁**） | PDFX-MEMO-01（夹具自持，另加「重试恢复 + 零重复下载」增量） | 语义等价，本域版不依赖库外夹具 |
| M1 读失败错误卡 | PDF-RANGE-06（**受夹具门禁**） | PDFX-M1-01（另加 worker 零泄漏 + 请求流停止增量） | 同上 |
| 本地小体量 PDF → data 路径 | PDF-RANGE-04（钉渲染面 + 零远端 `/api/file` 请求） | PDFX-LOCAL-02（钉**读形态**：恰一次整读 + 零窗段切片） | 断言面不同：前者钉「不触远端」，后者钉「读形态」 |
| 远端下载进度卡（下载中/完成态双形态） | SAV 域（`docs/e2e/save-as-pipeline.md`：24MiB/12MiB PNG 的确认门与另存为下载路） | PDFX-CARD-01/02（≤1MB **渲染直读泵**路的卡面） | 两条泵路不同：SAV 钉「另存为/确认门下载」路的卡，PDFX 钉「渲染直读」路的卡；PDFX 的作用是为 CARD-01 的缺席断言提供对照面 |

## 4. 环境与数据

### 4.1 套件与装置

| 项 | 规格 |
| --- | --- |
| 套件 | default（`apps/web/playwright.config.ts`，chromium + mobile 两 project；本域桌面专属，仅 chromium 跑） |
| 本地注入 | `window.__vvOpenDirImpl` 通道（`apps/web/src/lib/openFlow.svelte.ts:368`）→ `createLocalFilesStore`（`localFiles.ts`，`rangeCapable:true`）；字节以 base64 桥传入（1MB+ 夹具免百万级数组序列化），File 打 `Symbol.for('vv.pdfx.target-blob')` 标记供计量装置筛选 |
| 远端通道 | 迷你假 vviewer 服务器（端点集 `/api/health`、`/api/tree`、`/api/file`、`/api/ticket`、`/api/events`；`/api/file` 支持 Range 206 精确切片 + 逐请求日志；非目标 path 一律 404 以隔离 git 探测）+ 旧键 `'tabs'` 快照预置（IndexedDB `vviewer`/`kv` + `sessionStorage` 的 `vviewer-last-server`），形态照 `b-pdf-range.spec.ts` 同款 |
| 读形态计量 | `page.addInitScript` 打补丁 `Blob.prototype.slice` / `Blob.prototype.arrayBuffer`：采集目标 File 的实读字节数与切片（父尺寸/长度） |
| 读流结算 | 连续 3 次采样（间隔 250ms）计数不变方认定静止；20s 未静止即抛错（失败信号，不静默放行）——避免「两次窗段读之间 >250ms 间隙」被误判为静止 |
| 计数观察窗 | 「零重复下载」用多次采样恒值断言（5 次 × 400ms）；「请求流停止」先等计数自然静止（连续 3 次不变）取基线，再观察 1.6s 恒定——不用固定单窗口，避免慢机假红/假绿 |
| 进度卡观察 | `page.addInitScript` 注册 `MutationObserver`（document 根、`childList+subtree`）：完成态卡与下载中卡**双旗分列**记录 + 完成态卡文本留存 + mutation 活性计数；完成态 TTL=4s（`ViewerPane.svelte:181`），DOM 复核会与 TTL 竞态，故出卡面以观察器记录为准 |
| worker 观测 | Playwright `page.on('worker')` / `page.workers()` + worker `close` 事件（不依赖 pdfjs 私有字段名） |
| worker 故障注入 | 三支：① 协议桩（握手成功 + 文档开启失败，用于 MEMO-01 的可恢复失败）；② 协议桩（握手 data 非 Uint8Array → ready 门失败）；③ 资产不可达（abort）与资产 404（装配失败）。桩仅在 worker 全局作用域生效（页侧回落动态 import 时无副作用，否则会覆写页面 `window.onmessage`） |

### 4.2 夹具清单（全部 spec 内合成，零外部文件）

| 夹具 | 规格 | 用于场景 |
| --- | --- | --- |
| 大件 PDF（front 布局） | 5 页（`PDFX Page 1..5`），注释行填充至**精确** 1,300,796B（>1MB 阈值、<2MB）；填充在首个对象之前（对象全在尾块） | LOCAL-01 / CARD-01 / M1-01 / FIX-01 |
| 大件 PDF（mid 布局） | 5 页，1,300,796B；填充置于 pages 树之后、首个 page 对象之前（页面对象/内容流落中段块） | M1-02 |
| 小件 PDF（front 布局） | 2 页，填充至 **1,048,575B**（1MB-1 字节，贴近阈值下侧） | LOCAL-02 / FIX-01 |
| memo PDF | 3 页，填充至 20,000B（> 探测块 8KB：探测块不得吞掉全量，否则补拉计量失真） | MEMO-01~05 / CARD-02 / FIX-01 |
| 远端 500 形态 | 服务端首个「全量补拉」请求（Range end ≥ `MAX_SAFE_INTEGER`）返 HTTP 500（JSON 体），其后 206 全量 | MEMO-02 |

### 4.3 边界与注意事项

- **不做整文件物化的判据依赖读流静止**：LOCAL-01/02 的读形态断言在读流结算（连续 3 次 250ms 采样不变）后取样，避免把「慢」误判成「无」。
- **缺席断言先等稳定在场信号**：LOCAL-01/02 等 canvas 可见后再判；CARD-01/02 先等渲染完成；M1-02 先等「页容器就位 + 指示器更新 + 渲染期读被 abort」再判零错误卡。
- **完成态卡与下载中卡必须分判**：完成态卡自身带 `.vv-dl-progress` 类（`DownloadProgressCard.svelte:38`），合并计数会把完成态误判为下载中卡；观察器侧双旗、DOM 侧 `:not(.vv-dl-progress-done)` 双处同口径。
- **重试不复用同 tab 的重复激活**：PDFX-MEMO-02 的「再打开」走**树行点击开新 tab**（`AppShell.svelte:1044-1045`），不重复激活同 tab（重复激活会清空已挂载内容）。
- **每次 `new Worker` 皆新建 worker 侧模块表**：worker 脚本桩首轮失败后，重试可恢复（真 worker 重新取脚本）；页侧模块表对失败模块的缓存不影响 worker 侧——这正是 MEMO-01 的「重试恢复」链用协议桩而非「拦掉 worker 脚本」的原因。
- **上游口径变更会打红**：本域对 pdfjs 6.4.299 的 worker 握手/回调协议与 chunk 语义有耦合（`pdf.mjs:8664/8700/15557-15575/16285/16292/16305/16319-16338`），上游改口径时属**预期复核面**（非 flaky），按 `pdf.ts:270-278` 同款升级复核点处理。
- **PDF 视图的滚动容器是 `.vv-pdf-pages`（不是外层 `.vv-viewer-scroll`）**：PDF 面板定高自滚（`apps/web/src/app.css:191` `.vv-pdf{height:100%}` + `:198` `.vv-pdf-pages{flex:1;overflow:auto}`；容器由 `packages/vviewer-render-doc/src/pdf.ts:301-303` 建，IO 的 `root` 亦为该容器 `pdf.ts:417`）。在 PDF 视图下外层 `.vv-viewer-scroll` 的 `scrollHeight === clientHeight`（零溢出），对其设 `scrollTop` 是空操作 → IO 不触发 → 第 4+ 页永不渲染（LOCAL-01 首轮失败根因）。懒渲染面的滚动必须落在 `.vv-pdf-pages`（写法同既有锚 MEDIA-07，`apps/web/e2e/b-media-office-viewer.spec.ts:374-376`）。
- **本域结论的边界**：见文首「结论边界」——本域只保证自身新锚不空心化；域正主既有锚的 PDF-RANGE-01/03/05/07 四面仍仅由库外夹具门禁，CI 缺夹具环境仍空心化这 4 例（补齐需另行立项，属跨域改动）。
