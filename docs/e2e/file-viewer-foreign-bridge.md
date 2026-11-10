# file-viewer 桥接渲染器跨边界 e2e — FOM 域场景

> 来源：spec `2026-11-04-file-viewer-integration` §6.1（桥接契约）/ §6.3（20 组桥接渲染器装配）/ §6.4（嵌套附件、远端确认门、归档条目、CDN 资产降级、边车组）与 `docs/superpowers/plans/` 计划 3 Task 2/Task 5、计划 4 Task 2 的装配实现。
> 脚本：`apps/web/e2e/b-foreign-office-3.spec.ts`（FOM-NEST-01~05、FOM-REMOTE-01、FOM-CONFIRM-01、FOM-ZIP-01、FOM-CDN-01、FOM-SHP-01；chromium project）。
> 域定位：**钉 foreign 桥与 vviewer 自有面之间的边界**（嵌套附件回流、foreign × 远端 R1、foreign × 确认门、归档条目 × foreign 路由、CDN 资产失败收口），**不是**钉 foreign 引擎自身出图——后者由 `b-foreign-office.spec.ts`（FO-01~09，含 FO-08 csv 转移锚与 FO-09 ctrl+滚轮缩放锚）与 `b-foreign-office-2.spec.ts`（FO2 系）覆盖。
> 本轮（复核返工轮）新增 FOM-NEST-04/05 两场景、并把七个既有场景的断言从「容器可见」升级为「内容级 + 可打红」，详见 §6。

## 1. 目的与来源

`apps/web/src/lib/foreignRenderers.ts` 把 20 组 `@file-viewer/*` 渲染器经 `packages/vviewer-render-foreign/src/bridge.ts` 的 `wrapFileViewerRenderer` 桥接为 vviewer `Renderer`，与 vviewer 自有渲染器（pdf/docx/xlsx/image/code/hex/archive…）共处同一注册表与同一派发器。这条装配线引入了四类**跨边界**行为，既有锚一条都没盖：

1. **嵌套附件回流**（spec §6.4）——上游 email 渲染器解析出附件后回调 `context.renderNestedBuffer`，桥接层把它交回 vviewer 派发器按扩展名重新路由（pdf/image/docx 等 vviewer 本地强项走自有面），无 byExtension 命中者落下载兜底，有渲染器但渲染失败者落 nested target 内的错误卡，并以显式深度参数强制「嵌套深度限 3」（第四层落下载）。
2. **foreign × 远端 R1**——foreign 一律声明 `streaming:false`（`bridge.ts:156`），远端来源下 dispatcher 必须**全量物化**后再交给桥接引擎；既有 FO/FO2 全部走本地 `injectDir` 注入，远端面零锚。
3. **foreign × 确认门**——远端大文件在泵启动前被确认卡拦截，确认后才泵。
4. **CDN 资产失败收口**——foreign 引擎的 worker/wasm 资产走 jsdelivr CDN，跨域 `new Worker(URL)` 被同源硬约束拒绝，故经 `apps/web/src/lib/foreignWorkerBridge.ts` 的 blob 引导桥改写；引导失败此前只有单测锚（`foreignWorkerBridge.test.ts:58-84`），e2e 零锚。

### 1.1 内容级断言纪律（本域的硬要求）

**`.email-viewer` 容器可见不证明邮件渲染成功。** 上游先建 root 再解析（`@file-viewer/renderer-email` dist `email.js:251-253` `target.replaceChildren(style, root)`）；一份解析不出内容的邮件同样满足「`.email-viewer` 可见 + 零 code/hex + 零错误卡」。故本域每个 foreign 出图锚都另钉**内容级**信号：

| 信号 | 定位 | 语义 |
| --- | --- | --- |
| Subject 文本 | `.email-header h2` | 上游 `parsed.subject`（`email.js:337`）——证明解析出了我们注入的那封邮件 |
| From 文本 | `.email-meta` 含 `probe@example.invalid` | 上游 `addressText(parsed.from)`（`email.js:339` `appendMeta(meta, from, addressText(parsed.from))`） |
| 内部错误 | `.email-error` 计数 0 | 上游 `showError` 的错误条（`email.js:276`） |
| 附件项存在 + 体积标签 | `.attachment-item strong` / `.attachment-item em` | 上游 `formatBytes(附件字节数)`（`email.js:565` 建项 / `email.js:522` 回填实测字节数）——附件负载被完整送达 |

`.vv-code-pre` / `.vv-hex` 的否定面**鉴别力有限**（eml 扩展名路由唯一命中 foreign-email 组，只能证伪「eml 绑定被改」），本域仅在「嵌套附件落哪个面」这一处使用，不作为「邮件已渲染」的证据。

### 1.2 与既有锚的边界（含重叠的如实记账）

| 既有锚 | 覆盖内容 | 本域的关系 |
| --- | --- | --- |
| FO-02（`b-foreign-office.spec.ts:175-176`） | **本地** eml 顶层渲染：`.email-viewer` 可见 + `.vv-code-pre` 计数 0 | **重叠部分**：FO-02 已覆盖本地 eml 顶层三连断言。本域首轮曾逐字重复该三连，本轮**已删除**（改为内容级断言）；FOM-NEST-01 的起始步骤只保留「邮件面可见」作为作用域锚，核心断言是嵌套回流 |
| FO-01/03/04/05/07、FO2 系 | foreign 引擎自身出图（`.msdoc-stage`/`.email-viewer`/`.wpd-viewer`/`.excel-wrapper` 等容器类） | 不重复。本域 FOM-REMOTE-01/FOM-CONFIRM-01/FOM-ZIP-01 虽同样观察 `.email-viewer`，但数据来源分别是远端 R1、远端 R1+确认门、归档条目，且均配内容级断言与**跨边界专属断言**（请求形态 / 门→泵序列 / 条目字节路由）——不是「引擎出图」重复 |
| DL-PROG-01/02、DL-CONF-01a/01b/02/03、DL-SAVE-01（`b-save-as.spec.ts`） | 进度卡字段全锚、确认门双路（对象为 `.png` 原生扩展名）、阈值生效、孤儿清偿、tee 直写 | **重叠部分**：确认卡的 `name`/`size` 两字段断言与「改阈值」路径与 DL-CONF-01a/02 同款。本域**已删除** `.vv-dl-confirm-renderer` 的中性文案断言（扩展名无关、与 DL-CONF-01a 逐字重复、对 foreign 零贡献）；FOM-CONFIRM-01 的 foreign 专属增量在**门后两请求序列**与**内容级接管宿主** |
| SA-02（`b-save-as.spec.ts:332-359`） | zip 条目开 tab 机制（对象为 `hello.txt`） | 机制步骤重叠；本域 FOM-ZIP-01 的 foreign 增量在**条目字节按扩展名派发到 foreign 桥 + 内容级断言 + 条目字节数标签** |
| CDN-02/03/04（`b-cdn-diagram-engines.spec.ts`） | 图表 CDN 引擎回退链（markdown 围栏面） | 本域 FOM-CDN-01 钉的是 **foreign 跨域 worker 引导**（blob 引导桥）失败后的错误卡收口 |

## 2. 场景清单

公共环境：chromium project（桌面 1280×720；本域十锚均为桌面交互面，mobile 375px 复跑无增量覆盖，`test.beforeEach` + `testInfo.skip` 跳过）。
注入通道：`injectDir + openTreeFile`（`./b-markdown-html-docs-helpers`，只读引用）+ 单文件注入 `injectSingleFile/dropSingleFiles`（本文件自建，合成 DataTransfer drop → `openFiles` 单文件通道，FOM-SHP-01 专用）。远端面：`seedRemoteTabs` + 本文件自建 mini 假 vviewer 服务器（127.0.0.1）。

| 编号 | 前置条件 | 步骤 | 期望 | 关联缺陷 |
| --- | --- | --- | --- | --- |
| FOM-NEST-01 | 本地注入 `probe.eml`（合成 multipart/mixed 邮件，附件 `leaf.pdf` = `samples/m4/sample.pdf` 620B） | 打开 `probe.eml` → 点击附件项 `leaf.pdf` | **内容级**：`.email-header h2` = `FOM NEST-01`、`.email-meta` 含 `probe@example.invalid`、`.email-error` 计数 0、附件项 `leaf.pdf` 存在且体积标签 = `620 B`；**回流**：`.email-attachment-render .vv-pdf` 可见、`.vv-pdf-page` 计数 ≥ 1 且其内 `canvas` 计数 ≥ 1（canvas 宽高均 > 0）；**否定面**：`.email-attachment-render` 内 `.email-viewer`/`.vv-code-pre`/`.vv-hex` 计数皆 0 | — |
| FOM-NEST-02 | 本地注入 `probe2.eml`（附件 `mystery.zzz`，无任何渲染器绑定；负载 35B 定长串） | 打开 → 点击附件项 `mystery.zzz` | **内容级**：Subject = `FOM NEST-02`、附件项 `mystery.zzz` 存在；**兜底**：触发 1 次 page `download` 事件，落盘名 = **附件原名** `mystery.zzz`，`download.path()` 读回字节与注入负载逐字节等值（`Buffer.equals`）；**否定面**：同宿主 `.vv-error-card` 计数 0（回落下载不落错误卡片），`.email-attachment-render` 的 `childElementCount` = 0（上游先建空容器，兜底不落渲染内容） | FOM-EX-08（**已修**，见 §3.1） |
| FOM-NEST-03 | 本地注入四层邮件 `level1.eml`（level1→level2→level3→level4 逐层以 `message/rfc822` 附件段承载，`leaf.pdf` 挂在最深层 level4 上；注入件 = 深度 0） | 逐层点击附件下钻至 4 层邮件面，再点击最深层 `leaf.pdf` | **逐层**：宿主内 `.email-viewer` 计数 1→2→3→4（深度 0..3），每层 Subject 分别为 `FOM level1..4`（内容级）；**深度闸**：深度 3 的 `leaf.pdf` 不渲染（`.email-attachment-render .vv-pdf` 计数 0）且 `.email-viewer` 计数仍 = 4（限深是「落下载」而非整链失败）；触发 1 次 `download` 事件，落盘名 = **附件原名** `leaf.pdf`，落盘字节与 `samples/m4/sample.pdf` 逐字节等值；同宿主 `.vv-error-card` 计数 0 | FOM-EX-08（**已修**，见 §3.1）、FOM-EX-12 |
| FOM-NEST-04 | 本地注入 `probe4.eml`（附件 `broken.pdf` = 非 PDF 字节，**有** pdf 渲染器命中） | 打开 → 点击附件项 `broken.pdf` | **内容级**：Subject = `FOM NEST-04`、附件项 `broken.pdf` 存在；**渲染失败收口**：`.email-attachment-render .vv-error-card` 可见且 `.vv-error-title` = 「无法预览此文件」、同容器内 `.vv-pdf` 计数 0；**不冒泡**：宿主的直接子级 `.vv-error-card` 计数 0（错误卡落在 nested target 内）；**零下载**：1s 静默窗后 page `download` 事件数 = 0（有渲染器命中 → 不走 downloadNestedAttachment） | — |
| FOM-NEST-05 | 本地注入 `probe5.eml`（两个附件：`pic.png` = 1×1 PNG、`word.docx` = `samples/m4/sample.docx`） | 打开 → 依次点击 `pic.png`、`word.docx` | **内容级**：Subject = `FOM NEST-05`、两个附件项均存在；**png → 自有 image 面**：`.email-attachment-render .vv-image` 可见、其内 `img` 可见且 `naturalWidth`/`naturalHeight` 均 > 0（`vviewer-render-media/src/image.ts:104`）；**docx → 自有 docx 面**：`.email-attachment-render .vv-docx` 可见、`.vv-docx-content` 含「vviewer docx 样例」（`vviewer-render-doc/src/docx.ts:40`）；单激活槽：切换后 `.vv-image` 计数 0 | — |
| FOM-REMOTE-01 | mini 假 vviewer 服务器（`/api/health|tree|file|ticket/events`，file 端点按 Range 回 206 + Content-Range 切片）+ IndexedDB `tabs` 快照预置（来源 `remote:<hash8(base:e2e-fake)>`，含 `path===''` 目录项与 `remote.eml` 项且**带 size**）；文件为 **>1MB** 的合成 eml（正文 + 1.1MB `pad.bin`） | 打开远端 `remote.eml` | **请求形态**：对 `remote.eml` 的 `/api/file` 请求恰 2 条且依次为 `bytes=0-8191`（8KB head 探测）+ `bytes=0-(size-1)`（全量窗）——非流式全量物化的形态；foreign 若改声明 `streaming:true` 则只发 1 条 head 请求、引擎只拿到 8KB → 本锚双红；**内容级**：`.email-header h2` = `FOM REMOTE-01`、`.email-meta` 含 From、附件项 `pad.bin` 存在且体积标签 = `1.0 MB`（附件字节数）；**无门**：`.vv-dl-confirm` 计数 0；**完成态卡**：`.vv-dl-progress-title` = 「下载完成」、`.vv-dl-progress-cancel` 计数 0（下载中卡才有取消钮）、`.vv-dl-progress-saveas` 计数 1、`.vv-dl-progress-address` = `remote.eml` | — |
| FOM-CONFIRM-01 | 同 FOM-REMOTE-01 的假服务器与快照预置；文件为 >1MB 的合成 eml，**声明体积 = 真实字节数**（不脱钩）；阈值经设置面板「存储与数据 → 远端下载确认阈值」改 1MB（改写后轮询 localStorage 确认已落盘） | 打开远端 `gate.eml` → 观察确认卡 → 点「开始下载」 | **门字段**：`.vv-dl-confirm` 可见，`.vv-dl-confirm-name` = `gate.eml`，`.vv-dl-confirm-size` = 按真实字节数算出的体积文案（本夹具为「大小 1.4 MB」）；**门拦截**：1s 静默窗内对 `gate.eml` 的 `/api/file` 请求计数 = 0（泵未启动，无静默窗的直接计数会假绿）；**门后泵**：请求序列恰 2 条 `bytes=0-8191` + `bytes=0-(size-1)`（观测到后再等静默窗复断言，防第 3 条迟达假绿）；**内容级接管**：`.email-header h2` = `FOM CONFIRM-01`、附件项 `pad.bin` 存在且体积标签 = `1.0 MB`；**完成态卡**：标题「下载完成」/ 无取消钮 / 有另存为钮 / 文件名 `gate.eml` | — |
| FOM-ZIP-01 | 本地注入 `bundle.zip`（jszip 内存生成，条目 `inner.eml` = 合成 eml） | 打开 zip → 点击归档条目行 `inner.eml` | **归档面**：`.vv-archive` 可见，其内 `.vv-tree-row` 含 `inner.eml（<eml 字节数> B）`（标签的大小后缀即条目字节数）；**新 tab**：`.vv-tab.active` 文本含 `inner.eml`；**foreign 增量**：激活 tab 宿主内 `.email-header h2` = `FOM ZIP-01`、`.email-meta` 含 From、附件项 `leaf.pdf` 存在且体积标签 = `620 B`（条目字节按扩展名派发到 foreign-email 桥接管）；**不在归档面内渲染**：`.vv-viewer-host .vv-archive` 计数 0 | — |
| FOM-CDN-01 | `test.use({ serviceWorkers: 'block' })`（`page.route` 拦不到经 SW 的请求——SW runtimeCaching 的 jsdelivr CacheFirst 会吞掉拦截面，仓内先例 `b-cdn-diagram-engines.spec.ts:125`（SW block）与 `:29-32`（备案注记））+ `page.route('**/*wordperfect.worker.js*')` 与 `page.route('**/cdn.jsdelivr.net/**')` → `abort('failed')`（路由按**资产文件名**匹配，跟随应用实际资产基座，不写死 CDN 域名/版本字面量）；本地注入 `broken.wpd`（纯文本负载） | 打开 `broken.wpd` | `.vv-viewer-host .vv-error-card` 在 90s 内可见；`.vv-error-title` = 「无法预览此文件」；`.vv-error-detail` 含 `foreign worker bootstrap failed`（跨域 worker 引导失败经桥接层转 error 事件 → 渲染器 reject → 错误卡收口，不悬挂）；`.vv-error-meta` = `broken.wpd`；**归因锚**：被拦截的请求 URL 含 `wordperfect.worker.js`（决定性证据，不依赖浏览器错误文案措辞，也不依赖 CDN 域名/版本字面量）；错误卡三动作按集合断言 = {「重试」,「以纯文本打开」,「以 hex 打开」}；宿主内 `.wpd-viewer` 计数 0（引擎壳未挂载）、`.vv-code-pre` 计数 0 | — |
| FOM-SHP-01 | 单文件注入通道（合成 DataTransfer drop → `openFiles` → `createSingleFileStore`，storeId `single:` 前缀——`injectDir` 目录通道造不出裸单文件形态，见 §2.1）：`points.shp`（真 .shp 头 100 字节，file code 999 / version 1000 / shape type 1；负载内容与断言无关——拦截发生在任何解析之前） | 注入 `points.shp`（tab 自动激活）→ 再注入 `map.geojson`（单点 FeatureCollection，对照面） | **主面（错误卡）**：`.vv-viewer-host .vv-error-card` 在 90s 内可见；`.vv-error-title` = 「无法预览此文件」；`.vv-error-meta` = `points.shp`；`.vv-error-detail` 含「Shapefile 需同目录」（装配层前置拦截文案，spec §6.4「裸单文件维持降级错误卡」）；错误卡三动作 = {「重试」,「以纯文本打开」,「以 hex 打开」}（≥1 且重试在）；**否定面**（先等错误卡在场信号再断言，缺席断言不单飞）：`.geo-viewer` 计数 0（拦截在桥接 mount 之前，引擎 DOM 从未产出）；**对照面（扩展名特异非通道特异）**：同通道注入 `.geojson`（同样 single: 来源、单文件自足格式）→ `.geo-viewer` 可见且 `.vv-error-card` 计数 0（旧卡随 tab 切换销毁——共享单 host，内容随活动 tab 替换） | ②（**已闭**，见 §3.4） |

### 2.1 装置说明（全部自建于本 spec 文件，不抽公共 helper）

| 装置 | 规格 | 用于场景 |
| --- | --- | --- |
| MIME 合成器 `buildEml` | RFC822 头（From/To/Subject/Date/MIME-Version）+ `multipart/mixed; boundary=…` + `text/plain` 正文段 + `application/*` 附件段（`Content-Transfer-Encoding: base64`，76 列折行，`Content-Disposition: attachment; filename="…"`）。零语料依赖；`postal-mime` 实跑核过（`subject`/`from`/`attachments` 全中；嵌套 `message/rfc822` 段保留原始字节，多层链逐层可解析） | FOM-NEST-01~05、FOM-REMOTE-01、FOM-CONFIRM-01、FOM-ZIP-01 |
| 嵌套四层邮件 | 自底向上构造：`level4`（挂 `leaf.pdf`）→ `level3`（挂 `level4.eml`）→ `level2`（挂 `level3.eml`）→ `level1`（挂 `level2.eml`），各层 boundary 唯一 | FOM-NEST-03 |
| mini 假 vviewer 服务器 | 127.0.0.1 随机端口；`/api/health`（`capabilities:['file-server']`）、`/api/tree`（带 size）、`/api/file`（按 `Range` 回 206 + `Content-Range` 切片，记录 `${path} :: ${range}`）、`/api/ticket`、`/api/events`（SSE 挂起无数据帧） | FOM-REMOTE-01、FOM-CONFIRM-01 |
| 远端 tab 快照预置 | IndexedDB `vviewer`/`kv` 的旧键 `'tabs'`；条目形如 `{id, storeId:'remote:<hash8(base:e2e-fake)>', storeLabel:'e2e-fake', storeBase, kind:'rename-only', path, name, size, active}`；另写 `sessionStorage['vviewer-last-server']`（形态沿 `b-save-as.spec.ts:187-223`）。**目录项（`path===''`）必需**——快照的 remote 来源只从目录项派生（`workspaceStore.ts:81` `migrateLegacyTabs`）；写库完成置 `window.__vvSeedReady`（诊断用） | FOM-REMOTE-01、FOM-CONFIRM-01 |
| 下载捕获器 | `page.on('download')`（blob 兜底通道 `<a download>` 点击）；`download.path()` 回读落盘字节 | FOM-NEST-02/03/04 |
| `formatBytesLike` | 与 `apps/web/src/lib/storageHealth.ts:260` `formatBytes` 同口径的字节格式化（确认卡体积与附件项体积标签的期望值由此算出，不写死字面量） | FOM-NEST-01/05、FOM-REMOTE-01、FOM-CONFIRM-01、FOM-ZIP-01 |
| 单文件注入通道 `injectSingleFile`/`dropSingleFiles` | 页面内构造 `File` → 合成 `DataTransfer`（`dt.items.add(file)`）→ `window.dispatchEvent(new DragEvent('drop', { dataTransfer }))`（`+page.svelte` 的 `svelte:window ondrop`）→ `openFiles` 单文件通道 → `createSingleFileStore`（storeId `single:<name>:<size>:<lastModified>`）。程序化 DataTransfer 条目 `webkitGetAsEntry()` 为 null → `collectDirectoryFiles` 兜 null → 落 `e.dataTransfer.files` 单文件分支（即便造出 file entry，非目录条目同样兜 null，两分支殊途同归）。与既有 `injectDir` 目录通道（`__vvOpenDirImpl` → `openDirectoryViaInput`，localfiles 来源）互斥：目录通道 storeId 不带 `single:` 前缀，原理上造不出裸单文件。可追加注入（不重载页面），多文件各自成独立 single: tab，后注入者激活 | FOM-SHP-01 |

## 3. 验收行为

### 3.1 FOM-EX-08：嵌套附件下载兜底丢失原文件名（产品缺陷，**已修**，锚转绿）

- **缺陷现状（修前）**：上游 email 渲染器调用 `context.renderNestedBuffer(attachmentBuffer, extension, child, { ...context, filename: attachment.name })`（`@file-viewer/renderer-email` dist `email.js:527`）——**原文件名在第 4 参**；而桥接层的 `renderNested` 只消费前三参（`apps/web/src/lib/foreignRenderers.ts` 的 `renderNestedBuffer` 适配器），装配层再经 `nestedName(type)` 把裸扩展名派生成 `attachment.<ext>`。故深度闸与无渲染器两条下载兜底路径落盘名为 `attachment.zzz` / `attachment.pdf`，**原名 `mystery.zzz` / `leaf.pdf` 丢失**。
- **修复后行为**：落盘文件名恢复为附件原名。
- **验收锚**：FOM-NEST-02 断言 `download.suggestedFilename() === 'mystery.zzz'`、FOM-NEST-03 断言 `=== 'leaf.pdf'`。（首轮曾把断言写成扩展名正则 `/\.zzz$/`、`/\.pdf$/`，修复前后都通过 → 缺陷不可检出、修复不可回归，已在上一轮返工中收紧到原名。）
- **修复落点（2026-11-08 第 1 轮分诊后已实施）**：`apps/web/src/lib/foreignRenderers.ts`
  - 适配器接第 4 参 `nestedCtx`，取 `nestedCtx?.filename`（上游 email 的原名面）；
  - 新增 `fileNameOnly` / `nestedDispatchName`：原名经**文件名化**（取 basename、拒 `'.'`/`'..'`/空/纯空白）后作派发名；原名不可用时回落 `nestedName(type)` 且该派生名同样经文件名化；
  - 单测锚 `apps/web/src/lib/foreignRenderers.test.ts` 的 `nestedDispatchName` 组（原名可用/缺失回落/含路径成分取 basename/仅路径成分回落四条）。
  - **跨域顺带修复**：`docs/e2e/path-normalization.md` 的 **PAT-EX-01**（`b-path-normalize.spec.ts` 的 PAT-08 红锚「兜底下载名含路径成分」）同根因——恶意附件名 `x.z/evil` 的派发名经文件名化后为 `evil`（不含 `/`、`\`、`..` 段），该红锚随之转绿。
- **回归不破坏**：字节等值锚（两锚的 `Buffer.equals`）与「不落错误卡」「不落渲染内容」「深度链四层可达」「零下载（渲染失败分支）」不变。

### 3.1b FOM-EX-09：渲染器 transfer 走 buffer 底层 → detached 异常吃掉嵌套错误卡（产品缺陷，**已修**，锚转绿）

- **缺陷现状（修前）**：pdf 渲染器在 `packages/vviewer-render-doc/src/pdf.ts` 的 **data 分支**以零拷贝 `pdfjs.getDocument({ data: buffer })` 交付字节，pdfjs 会 **transfer 该 ArrayBuffer**（主线程副本 detach 归零）。**buffer 直传**路径（嵌套附件派发：派发器把同一份字节交给渲染器，调用方不重新 read）下，detach 打穿调用方手里的字节面 → pdfjs 打开失败后进 `packages/vviewer-core/src/dispatch/dispatcher.ts` 的 catch，`buildRenderErrorActions` 执行 `looksTextual(buffer.slice(0, HEAD_SIZE))` 对 detached buffer 抛 `TypeError: Cannot perform %TypedArray%.prototype.slice on a detached ArrayBuffer` → **异常逃出 dispatch** → 嵌套错误卡整个不落地（上游 email 渲染器的 catch 把它吞成自己的提示，nested target 内既无错误卡也无内容）。同文件 `pdf.ts` 的 transport 分支**已有**该防护（`head: transport.head.slice()`），data 分支漏了；顶层不暴露是因为顶层走 `memoizedFullRead` 的拷贝路径。
- **修复后行为**：`.email-attachment-render .vv-error-card` 落地（标题「无法预览此文件」），宿主顶层不冒泡错误卡，且不触发下载兜底。
- **修复落点（2026-11-08 第 1 轮分诊后已实施，三处配套）**：
  1. `packages/vviewer-render-doc/src/pdf.ts`：data 分支改为 `pdfjs.getDocument({ data: buffer.slice() })`——与同文件 transport 分支的 `head: transport.head.slice()` 同款，也与 `memoizedFullRead` 的「消费即拷贝」契约（该文件 `:48-55`）一致：**getDocument transfer 的是副本，持有体不 detach**（决定性一处）。
  2. `packages/vviewer-core/src/dispatch/dispatcher.ts`：错误卡动作构建与 open-as 重入的字节面统一经 `safeBytes()`——可切片则用原字节面（契约不变），已 detach 则回落渲染前的 8KB `head` 副本（`head` 恒为独立副本，不与 `full` 共享底层）；`buildRenderErrorActions` 内 `looksTextual` 切片另加 try/catch 兜底（重试路径的重建卡亦同）。
  3. `apps/web/src/lib/foreignRenderers.ts`：嵌套字节**恒拷贝**（`new Uint8Array(nestedBuffer).slice()`），落实本文件 `toArrayBuffer` 注释自述的不变量「绝不与 dispatcher 持有的全量 buffer 共享底层 ArrayBuffer」——避免 vviewer 渲染器 detach/改写上游 email 的附件 buffer。
- **回归锚**：单测 `packages/vviewer-core/test/dispatcher.test.ts` 的「渲染器 transfer 走 buffer 底层后抛错：错误卡仍落地且带动作钮（detached 防御）」（**实测**：临时回退三处防御后该用例以与分诊同一句 `TypeError: ... on a detached ArrayBuffer` 打红，回退修复后转绿）；单测 `packages/vviewer-render-doc/test/pdf-render.test.ts` 的两条 data 路径用例由「引用同一」改为「字节等值但非同一引用」。
- **顺带影响面**：`pdf.ts` data 分支的零拷贝对任何「buffer 直传 + pdf」路径同样适用（嵌套附件、派发器直传），修复一并覆盖；顶层路径的 `memoizedFullRead` 拷贝路径本就不受影响（分诊实跑 MEDIA-11 验证顶层错误卡仍正常）。

### 3.2 FOM-EX-12：深层嵌套附件项无法真实点击（e2e 约束，非产品缺陷）

- **现象（实测口径）**：邮箱侧栏是独立滚动容器，第 2 层起的附件项不在视口内。1280×720 实测：`level2.eml` y=274.5、`level3.eml` y=674.5 仍在视口内（真实 click 成功）；`level4.eml` y=995.5 完全在视口外，真实 click 被 `.attachment-preview-head` 的「Download attachment」按钮与 `.vv-statusbar` 的**命中测试拦截**（非 `scrollIntoView` 不可靠——后者对嵌套滚动容器是可用的）。
- **处置**：FOM-NEST-03 中视口内的第 1~2 层用常规 click，第 3 层起改用 `dispatchEvent('click')` 仅作驱动；驱动后一律用 `expect.poll` / locator 自动等待等 DOM 更新（`dispatchEvent` 不自动等待）。
- **更正**：首轮文档写「blob 下载兜底依赖页面 sticky user activation，故必须真手势」——**不成立**：纯合成 click（全程无真实手势）同样触发了 blob 下载（实测 `attachment.zzz` 落盘）。blob 下载在本域不依赖用户激活，深度闸下载由合成 click 触发亦可。
- **回归不破坏**：该处置不改变被测行为——点击仍由上游 `email.js:566-568` 的 `click` 监听消费，深度链与深度闸语义完全一致。

### 3.3 本域未覆盖的已知缺口（逐条核对后登记，交分诊阶段处置）

**既有四条（本轮复核逐条核对，全部仍开）**：

| 缺口 | 核验结论与依据 |
| --- | --- |
| ① 兄弟边车（sibling）是死缝 | **仍开（知情记档，不做拦截）**：`apps/web/src/lib/foreignRenderers.ts:133-152` 构造 `FileRenderContext` 只给 `filename`/`sourceFile`/`signal`/`renderNestedBuffer`，`args.resolveSibling`（桥接层 `bridge.ts:182` 白造的入参）从未进入上游上下文；上游 `@file-viewer/core` 的 `FileRenderContext` 契约亦无 sibling 字段。`.shp` 的 `.shx`/`.dbf`/`.prj` 边车链路端到端不通——**resolveSibling 边车链路死缝（上游 FileRenderContext 无 sibling 字段）→ .shp 边车不被上游消费，目录/远端/zip 来源静默出无属性几何 = 现状语义**（这些来源的 sibling 读取面存在，边车能否取到取决于用户数据里是否真有边车文件，属数据问题不该由装配层一刀切拒绝）；**裸单文件（single: 来源）例外——边车原理上不可能存在（单文件来源没有「同目录」），落降级错误卡（FOM-SHP-01 钉死，见 §3.4）** |
| ② 裸单文件 `.shp` 的错误卡未实现 | **已闭（2026-11-08，见 §3.4）**：装配层前置拦截落地，FOM-SHP-01 钉死；此前为静默出无属性几何（spec §6.4:239 要求落错误卡） |
| ③ 组宽度零锚 | **仍开**：presentation 组（`foreignRenderers.ts:321-325`）无任何 e2e 锚；signature 的 OpenPGP 族 `pgp`/`gpg`/`jws`（`:407`）零锚；image 的 `heic`/`heif`（`:379`）零锚 |
| ④ 语料一致性锚脆弱 | **仍开**：FO-00（`b-foreign-office.spec.ts:118-137`）的 `FIXTURES ⊆ manifest.files` 在两侧同空时恒真；缺「manifest 必须覆盖本组绑定扩展名全集」断言（注册面会变，不得写成硬编码数量） |

**本轮复核新登记的六条**：

| 缺口 | 现状 |
| --- | --- |
| ⑤ 取消/销毁链 | spec §6.1:123「opts.signal 透传 … abort 语义对齐 abortReadError」零锚：切 tab/关 tab 时 foreign 实例须经 `foreignRenderers.ts:167` `disposeForeignRendered`（`bridge.ts:124-130`、`186-188`）销毁上游实例，且不留错误卡/不悬挂 |
| ⑥ SSE 变更重渲染链 | spec §6.4:228「SSE watch 命中变更 → 桥接实例 destroy → 重渲染」零锚（远端 watch 命中 → 桥接实例销毁重建） |
| ⑦ 512MB 全局防线一致性 | spec §6.4:241「512MB 全局防线对全部桥接渲染器一致生效」对 foreign 侧零锚 |
| ⑧ R2（direct S3/WebDAV）来源面 | spec §6.4:191/214-223 明写 R2 与 R1 同构；本域只覆盖 R1，R2 面既无锚也未登记——本轮补登 |
| ⑨ 挂载串行队列面 | `foreignRenderers.ts:100-116` 的资产基座切换原子性（已知残余「并发兄弟嵌套同时跨组的基座交叉」`:114-115`）零锚 |
| ⑩ 检索入口禁用态 | spec §6.1:122 要求桥接渲染器 tab 显示「当前渲染器不支持检索」禁用态；仓内**无该文案**（`grep -rn "不支持检索" apps/web/src packages` 无命中），实际 `'/'` 键无条件开面板（`ViewerPane.svelte:372`），SearchPanel 对无 search 的实例降级为「无结果」（`SearchPanel.svelte:79`）→ 既无锚也未登记——本轮补登 |

**附：可借本域装置覆盖但因 ① 未通的缺口**——L3 归档面的 sibling 读（`.shp` 与 `.shx`/`.dbf`/`.prj` 同处一 zip 的边车读取，spec §6.4:239）：FOM-ZIP-01 已搭好归档装置（jszip 内存 zip → 注入 → 条目点击开 tab），但 ① 的死缝使该链路端到端不通，故本域未落锚。

### 3.4 FOM-SHP-01：裸单文件 `.shp` 落降级错误卡（spec §6.4:239 补齐，**已实现**，2026-11-08）

- **修前现状**：单文件来源（`single:` storeId，拖拽/文件 picker 单选）的 `.shp` 照常进入 foreign-geo 桥，上游 renderer-geo 只解 `.shp` 本体——静默渲染出无属性几何，与 spec §6.4「裸单文件维持降级错误卡（『Shapefile 需同目录 .shx/.dbf/.prj』）」相悖。
- **实现落点**：`apps/web/src/lib/foreignRenderers.ts` 的 `withSingleFileShpGuard`——foreign-geo 组装配时套在 `Renderer.render` 包装层（桥接契约 `ForeignMountArgs` 不携带 storeId，只有 render 的 `FileSource` 实参有，此处为能拿到判定所需来源形态的最小侵入点，桥接包零改动）。打开 `.shp` 且 `source.storeId` 以 `single:` 前缀（`createSingleFileStore` 的 id 形态 `single:<name>:<size>:<lastModified>`）→ render 以 rejection 抛「Shapefile 需同目录的 .shx/.dbf/.prj 边车文件，单文件来源无法读取；请改用包含这些文件的文件夹方式打开」→ dispatcher 的 render catch 承接为错误卡（重试/纯文本/hex 三动作）。async 包装是有意的：错误卡「重试」动作走 `render(...).then().catch()` 链，同步 throw 会绕过该链直接逃逸。
- **只拦 `single:` 的理由**：单文件来源在模型上只有孤零零一个 File，**不存在「同目录」**，边车原理上无法取得——不拦则静默出无属性几何，比报错更误导。目录/远端/zip 来源不拦：这些来源的 sibling 读取面存在，边车「能否取到」取决于用户数据（数据问题不该由装配层一刀切拒绝），且目录来源静默出无属性几何是既有语义（① 的死缝所致，知情记档）——本拦截只兜「边车原理上不可能存在」的形态。
- **单测回归锚**：`apps/web/src/lib/foreignRenderers.test.ts` 的「foreign-geo 裸单文件 .shp 前置拦截」组（single .shp 抛错且上游 handler 零调用 / 非 single .shp 回落渲染路径 / single .geojson 不受影响；`@file-viewer/renderer-geo` 以带 definition/handler 的最小插件 mock，真 core registry/dispatcher 路由）。
- **e2e 锚**：FOM-SHP-01（§2 场景表；装置=单文件注入通道）。

## 4. 环境与数据

### 4.1 环境

| 项 | 值 |
| --- | --- |
| 套件 | `apps/web/e2e/b-foreign-office-3.spec.ts`（playwright `testDir: apps/web/e2e`） |
| project | `chromium`（桌面 1280×720 默认视口）；mobile project 由 `test.beforeEach` + `testInfo.skip` 跳过 |
| 预览面 | `pnpm vite preview --host 127.0.0.1 --port 4173 --strictPort`（playwright.config `webServer` 自动拉起，`baseURL=http://127.0.0.1:4173`） |
| 外网依赖 | **零**。全部语料本地合成；远端面走 127.0.0.1 假服务器；CDN 面由 `page.route` 本地 `abort('failed')` 兜底 + `serviceWorkers:'block'`，不裸依赖真网 |

### 4.2 数据清单

| 数据 | 规格 | 用于场景 |
| --- | --- | --- |
| `samples/m4/sample.pdf` | 仓内样本，620B 真 PDF（嵌套附件渲染面用真 PDF——伪字节会在 pdfjs 打开阶段失败，测不出「嵌套附件真渲染」语义） | FOM-NEST-01/03/05、FOM-ZIP-01 |
| `samples/m4/sample.docx` | 仓内样本，1787B 最小 OOXML 包，内含文本「vviewer docx 样例」「此文件由 tools/gen-samples.mjs 手工构造…」「列表项一/二」 | FOM-NEST-05 |
| 1×1 PNG | `PIXEL_PNG_B64`（`b-markdown-html-docs-helpers.ts` 内既有常量，只读引用） | FOM-NEST-05 |
| 坏 PDF 负载 | 39B 文本 `this is definitely not a PDF document, no header here`（**有** pdf 渲染器命中，内容不可解析） | FOM-NEST-04 |
| 合成 eml（单附件） | `buildEml` 产物：`From/To/Subject/Date/MIME-Version` + `multipart/mixed; boundary=FOMBOUNDxx` + `text/plain` 正文段 + `application/pdf` 附件段（`leaf.pdf`，base64 76 列折行） | FOM-NEST-01、FOM-ZIP-01 |
| 合成 eml（无绑定附件） | 同上，附件名 `mystery.zzz`、`application/octet-stream`、负载 `attachment-payload-bytes-0123456789`（35B） | FOM-NEST-02 |
| 合成 eml（坏 pdf 附件） | 同上，附件名 `broken.pdf`、`application/pdf`、负载为非 PDF 字节 | FOM-NEST-04 |
| 合成 eml（双附件） | 同上，附件 `pic.png`（1×1 PNG）+ `word.docx`（仓内 docx 样本） | FOM-NEST-05 |
| 合成 eml（四层） | `level4`（挂 `leaf.pdf`）→ `level3`（挂 `level4.eml`，`message/rfc822`）→ `level2`（挂 `level3.eml`）→ `level1`（挂 `level2.eml`）；各层 boundary 唯一（`FOMBOUND1..4`） | FOM-NEST-03 |
| 合成 eml（远端大文件） | 正文 + `application/octet-stream` 附件 `pad.bin`（1,100,000B 填充 `0x5a`）→ 合成后 ~1.5MB（>1MB FULL_LIMIT，故走 head 探测 + 全量窗两请求；亦 >1MB 确认门阈值）；快照声明体积 = 真实字节数 | FOM-REMOTE-01、FOM-CONFIRM-01 |
| `broken.wpd` | 纯文本 `this is definitely not a WordPerfect document`（`application/octet-stream`）；worker 引导失败先于内容校验 | FOM-CDN-01 |
| `bundle.zip` | jszip 内存生成（`generateAsync({type:'nodebuffer'})`），单条目 `inner.eml` = 合成 eml | FOM-ZIP-01 |
| `points.shp` | 真 .shp 头 100 字节（file code 999 大端 / version 1000 小端 / shape type 1 点 + 64B 空 bbox）。负载内容与断言无关——拦截发生在任何解析之前，取真头部只为失败归因不失真 | FOM-SHP-01 |
| `map.geojson` | 单点 FeatureCollection（内联合成，零语料依赖；geo 组单文件自足格式的对照面） | FOM-SHP-01 |
| 假服务器文件表 | `{ 'remote.eml': 合成 eml }` / `{ 'gate.eml': 合成 eml }`，树条目带 `size`（size 缺失会改走 head 探测路径，请求形态随之改变） | FOM-REMOTE-01、FOM-CONFIRM-01 |

### 4.3 断言纪律与已知易踩面（写/改本 spec 前必读）

1. **无恒真断言**：每条断言都能被一处具体产品改动打红。判据举例——FOM-NEST-01 的 `.email-attachment-render .vv-pdf` 在「嵌套附件不再回流 vviewer 派发器」时变红；FOM-REMOTE-01 的两请求序列在「foreign 改声明 `streaming:true`」或「泵改多窗」时变红；FOM-CDN-01 的被拦截 URL 指纹在「资产基座切换导致路由失配」时变红。注册面数量（20 组 / 116 扩展名）不写死——注册面会变，改用「归属到正确渲染器容器类名」这类语义断言。
2. **内容级断言是硬要求**：`.email-viewer` 可见不证明邮件渲染成功（见 §1.1）；每个 foreign 出图锚都要有 Subject/From/附件项/体积标签之一。
3. **结构性恒真的写法一律不收**：进度卡与完成态卡互斥挂载（`DownloadProgressCard.svelte:38` 同根不同分支）曾写成「`.vv-dl-progress` 计数 1 + `:not(.vv-dl-progress-done)` 计数 0」——那两条由模板结构恒真，已改为**随卡形态变化而变红**的写法：`.vv-dl-progress-title` = 「下载完成」、`.vv-dl-progress-cancel` 计数 0（下载中卡才有取消钮）、`.vv-dl-progress-saveas` 计数 1（完成态卡才有另存为钮）、`.vv-dl-progress-address` = 文件名。
4. **完成态卡 TTL 4s**（`ViewerPane.svelte:181`）：逐条 locator 断言在 TTL 边界会抖红——改用**一次 evaluate 取全量快照 + `expect.poll` 等待其出现**，并在内容断言之前取快照（早取早得）。
5. **请求序列断言须带静默窗**：一次性快照对「迟到的第 N+1 条请求」假绿。故观测到期望序列后再等 1s 静默窗并复断言条数与内容；确认门拦截期的「零请求」同样先等 1s 静默窗再断言（DL-CONF-01b 的 500ms 静默窗同款思路，`b-save-as.spec.ts:480`）。
6. **阈值改写须等落盘**：`applySettings` 只等「应用」钮复位（草稿脏态清除），设置真正落盘在其后——门若读到旧阈值则确认卡不出现。故改写后轮询 `localStorage['vviewer:settings'].storage.remoteDownloadConfirmMb` 直到等于目标值。
7. **快照恢复竞态**：远端 tab 快照靠 `page.addInitScript` 的异步 IndexedDB 事务落库，与应用启动时的 restore 读同一键。init script 的 `indexedDB.open` 请求先于应用脚本发起（init script 在页面任何脚本之前跑），写事务先于应用的读事务入队（b-save-as 长期沿用的仓内惯例）；写库完成置 `window.__vvSeedReady` 供失败诊断。
8. **`page.route` 拦不到经 SW 的请求**：FOM-CDN-01 必配 `serviceWorkers: 'block'`；SW 开启时外域计数恒 0，据此写「零请求」断言会假绿。
9. **CDN 归因锚不写死域名/版本**：应用的实际资产基座由 `foreignAssets.ts` 的三层链决定（构建期 `VV_FOREIGN_ASSETS` 注入镜像基座、上游 assets 包版本升级都会改变 URL 形态）。故路由按**资产文件名**匹配（`**/*wordperfect.worker.js*`），归因断言只认文件名指纹 `wordperfect.worker.js`，不认 `cdn.jsdelivr.net` 与 `assets-wordperfect@3.3.3` 字面量。
10. **邮件面挂 `.email-state` 加载遮罩**（上游 `email.js` 的 `showLoading`，`position:absolute; inset:0` 覆盖整个邮件面，解析/渲染期间在位）：常规 `click()` 的 hit-target 校验会被遮罩拦下 → 常规 click 前必须先确认遮罩撤除（spec 内 `waitEmailIdle` 等 `.email-state` 计数为 0）。
11. **`.email-viewer` 早于解析完成即在 DOM**：断言「邮件面可见」不等于「附件项已就绪」；附件项的定位靠 `clickAttachment` 内的 `toHaveCount(1)` 自同步。
12. **轮询一律 `expect.poll`**：不写「派发事件 + 立即断言」（`dispatchEvent` 不自动等待）。
13. **同一 tab 的第二次激活会清空预览**：本域不依赖重复激活，每次触发都重新打开。
14. **深度闸与无渲染器兜底都走 blob 下载**（`bridge.ts:110-117` `downloadNestedAttachment`）：`<a download>` 点击触发 page `download` 事件，落盘字节用 `download.path()` 回读比对；该通道**不依赖用户激活**（合成 click 亦可触发，见 §3.2 更正）。
15. **确认卡体积文案**用 `formatBytesLike` 按真实字节数算出（不写死 `'1.4 MB'`），夹具体量一变即假红的风险消除；本夹具下恰为「大小 1.4 MB」。
16. **确认卡「目标渲染器」中性文案分支是扩展名无关的**（`ViewerPane.svelte:781-787`）：任何命中扩展名路由的文件都出同一文案，对 foreign 零贡献 → 本域**不设该断言**（且与 DL-CONF-01a 逐字重复）。
17. **远端 store 具备 Range 能力**（`packages/vviewer-core/src/tree/remote.ts:399` `rangeCapable: true`）：>1MB 走 head 探测 + 全量窗两请求；≤1MB 走单窗。**故 FOM-REMOTE-01 的夹具必须是 >1MB**——≤1MB 形态下 dispatcher 在进入 streaming/非流式分支之前就全量物化（`dispatcher.ts:397-404`），改 `streaming:false` 为 `true` 也不改变请求形态与结果，锚失去鉴别力。
18. **快照来源派生依赖目录项**：远端 tab 快照必须含 `path===''` 的目录项，否则 `migrateLegacyTabs` 派生不出 remote 来源、tab 落占位。

## 5. 场景编号登记

本域独占编号段（全局唯一，跨域不撞号）：

| 编号 | 一句话意图 |
| --- | --- |
| FOM-NEST-01 | eml 内嵌 pdf 附件经桥接交回 vviewer 派发器，落自有 pdf 面而非 foreign/hex/code 面 |
| FOM-NEST-02 | 无 byExtension 命中的嵌套附件落 blob 下载兜底、字节等值、原名落盘且不落错误卡 |
| FOM-NEST-03 | 嵌套深度限 3 生效，第 4 层附件落下载兜底而非渲染 |
| FOM-NEST-04 | 嵌套附件有渲染器但渲染失败——错误卡落在 nested target 内、零下载兜底 |
| FOM-NEST-05 | 嵌套附件走其它 vviewer 自有扩展名——png 落自有 image 面、docx 落自有 docx 面 |
| FOM-REMOTE-01 | foreign 扩展名走远端按非流式全量物化（head+全量两请求）后桥接引擎接管宿主 |
| FOM-CONFIRM-01 | 远端大文件过确认门后泵全量物化，桥接引擎接管宿主 |
| FOM-ZIP-01 | 压缩包条目开新 tab，条目字节按扩展名派发到 foreign 桥接管 |
| FOM-CDN-01 | CDN 资产不可达时跨域 worker 引导失败收口成错误卡且归因可核验 |
| FOM-SHP-01 | 裸单文件 .shp（single: 来源）落降级错误卡提示补齐边车；同通道 .geojson 照常渲染（拦截扩展名特异） |

## 6. 本轮复核返工要点（2026-11-08）

| 类别 | 返工内容 |
| --- | --- |
| 恒真断言 | 删「进度卡计数 1 + `:not(done)` 计数 0」两条结构性恒真，改写为随卡形态变红的标题/取消钮/另存为钮/文件名四条 |
| 恒真断言 | 删 `.email-viewer` 可见 + code/hex 计数 0 的「三连」作为渲染成功证据（乱码邮件同样满足），改为 Subject/From/`.email-error`/附件项/体积标签的内容级信号；与 FO-02 逐字重复的本地 eml 三连一并删除 |
| 恒真断言 | 删 `intercepted.length > 0`（被随后的 `some(...)` 完全包含） |
| 鉴别力 | FOM-REMOTE-01 夹具由 ≤1MB 改为 >1MB（head+全量两请求），使「foreign 声明 `streaming:false`」真正可被请求形态与内容级断言双打红 |
| 鉴别力 | FOM-EX-08 的落盘名断言由扩展名正则收紧到**附件原名**（`mystery.zzz` / `leaf.pdf`）→ 修复前必然变红（真实缺陷暴露），修复后转绿 |
| 假绿护栏 | 确认门拦截期的零请求断言加 1s 静默窗；请求序列断言在观测到期望序列后再等 1s 静默窗复断言 |
| 假绿护栏 | 请求序列断言由一次性快照改为「poll 命中 → 静默窗 → 全量 toEqual」 |
| 假红护栏 | 完成态卡改「单次 evaluate 快照 + poll」，且在内容断言之前取快照（TTL 4s） |
| 假红护栏 | 阈值改写后轮询 `localStorage` 确认已落盘；快照写库完成置 `__vvSeedReady` 供诊断；各锚 test.setTimeout 与步骤超时重新配平 |
| 假红护栏 | CDN 路由与归因断言去掉 CDN 域名与 `assets-wordperfect@3.3.3` 版本字面量，改为跟随实际资产基座的文件名匹配 |
| 事实更正 | 文档 §3.2 更正两处与实测不符的说明：blob 下载**不**依赖 sticky user activation；深层附件项真实 click 失败的原因是命中测试被 `.attachment-preview-head` 按钮与 `.vv-statusbar` 拦截，**不是** `scrollIntoView` 不可靠 |
| 覆盖补齐 | 新增 FOM-NEST-04（有渲染器但渲染失败 → nested target 内错误卡 + 零下载）与 FOM-NEST-05（png/docx 两种 vviewer 自有扩展名的嵌套回流） |
| 缺口登记 | 文档 §3.3 补登记六条（取消/销毁链、SSE 重渲染链、512MB 防线、R2 来源面、挂载串行队列、检索入口禁用态），并对既有四条逐条给出核验依据；另记「L3 归档 sibling 读可借 FOM-ZIP-01 装置但因死缝未通」 |
| 域索引 | `docs/e2e/README.md` §2.1 特性域文档表尚未列本文件——本轮受「只改本域两个文件」约束未登记，交控制器统一补 |

## 7. 第 1 轮失败分诊后的产品修复记录（2026-11-08）

第 1 轮实跑 FOM-NEST-02/03/04 三条红锚，分诊结论为**三条均 product-bug**（两次 retry 失败值完全一致，非时序抖动）。按分诊锚点实施的产品修复：

| 锚 | 根因锚 | 修复 | 单测回归锚 |
| --- | --- | --- | --- |
| FOM-NEST-02 | `apps/web/src/lib/foreignRenderers.ts` 的 `renderNestedBuffer` 适配器只取三参、丢弃上游第 4 参 `context.filename`（上游 email dist `email.js:526-533`） | 适配器接第 4 参并经新增 `fileNameOnly`/`nestedDispatchName` 取文件名化消毒后的附件原名；嵌套字节恒拷贝 | `apps/web/src/lib/foreignRenderers.test.ts` 的 `nestedDispatchName` 组（4 条新增） |
| FOM-NEST-03 | 同上（深度闸路径共用适配器交出的名字，`packages/vviewer-render-foreign/src/bridge.ts` 的深度闸分支无需改动） | 同上 | 同上 |
| FOM-NEST-04 | `packages/vviewer-render-doc/src/pdf.ts` data 分支零拷贝 `getDocument({data})` → pdfjs transfer 掉 buffer → `packages/vviewer-core/src/dispatch/dispatcher.ts` 的 `buildRenderErrorActions` 对 detached buffer 切片抛 TypeError，异常逃出 dispatch → 嵌套错误卡不落地 | ①pdf.ts data 分支交副本；②dispatcher 字节面经 `safeBytes()` + `looksTextual` 切片 try/catch；③foreignRenderers 嵌套字节恒拷贝 | `packages/vviewer-core/test/dispatcher.test.ts` 的「detached 防御」用例（临时回退修复后以同一句 TypeError 打红）+ `packages/vviewer-render-doc/test/pdf-render.test.ts` 两条 data 路径用例改为「字节等值但非同一引用」 |

**跨域顺带修复**：`docs/e2e/path-normalization.md` 的 PAT-EX-01（PAT-08 红锚「兜底下载名含路径成分」）与 FOM-EX-08 同根因——派发名文件名化后，恶意附件名 `x.z/evil` 的落盘名为 `evil`（不含 `/`、`\`、`..` 段），该红锚随之转绿。

**未在本轮改动**：`apps/web/e2e/b-foreign-office-3.spec.ts` 的断言一字未动（分诊判定三条均为承重断言，不得为转绿弱化）；FOM-NEST-02/03 的落盘名断言仍为原名口径（`toBe('mystery.zzz')` / `toBe('leaf.pdf')`），FOM-NEST-04 的 nested target 内错误卡断言不变。
