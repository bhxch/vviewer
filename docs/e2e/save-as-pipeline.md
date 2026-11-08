# 另存为管线与下载确认门 — e2e 场景（SAV 域）

> 来源：spec `docs/superpowers/specs/2026-11-04-file-viewer-integration-design.md` §6.4「远端全量物化：下载进度卡 + 确认门 + 另存为（R1/R2，用户点名设计）」+ plan `docs/superpowers/plans/2026-11-04-fv-plan2-bridge-datasource.md`（Task 2 泵 / Task 3 进度卡 / Task 6 确认门 / Task 7 另存为双形态与 tab 级第七动作）+ 终审修复波 I-1~I-4 / M-1~M-5 / A2 残余（picker-first 翻转、Range 防线降级、tee 自持泵）。
> 现状脚本：`apps/web/e2e/b-save-as-2.spec.ts`（SAV 域 23 场景）；前序脚本 `apps/web/e2e/b-save-as.spec.ts`（SA-01/02/03、DL-PROG-01/02、DL-CONF-01a/01b/02/03、DL-SAVE-01 共 10 锚）。
> 本域定位：只补**前序锚未覆盖的行为面**（另存为管线与下载确认门的零锚缺口清单），不重复既有锚；既有 spec 文件不改动（域内一文件互斥约束）。
> 实跑记录（2026-11-08 本域自查）：`npx playwright test e2e/b-save-as-2.spec.ts --project=chromium --reporter=line` → **23 passed (1.3m)**；`npx tsc -b apps/web/tsconfig.e2e.json --noEmit` → exit 0。

## 1. 目的与来源

- **域定位**：远端全量物化（R1 `remote:` / R2 `s3direct:`/`davdirect:`）通路上的三条消费面——进度卡（下载中/完成态双形态）、下载确认门（阈值可设的知情确认）、另存为管线（`saveAsTab`：picker-first / blob 兜底 / tee 直写三形态）——的行为验收锚。产品实现面：`apps/web/src/lib/saveAs.ts`（另存为管线 + 置灰判定）、`apps/web/src/lib/downloadProgress.ts`（进度快照纯函数层）、`apps/web/src/lib/downloadConfirm.ts`（确认门决策纯函数）、`apps/web/src/lib/DownloadProgressCard.svelte`、`apps/web/src/lib/DownloadConfirmCard.svelte`、`apps/web/src/lib/ViewerPane.svelte`（三卡装配与渲染 effect 门）、`apps/web/src/lib/TabBar.svelte`（右键菜单第七动作）。
- **三个入口（不是四个）**：① Tab 右键菜单第七动作「另存为」（`TabBar.svelte:187-205`，置灰判定 `saveAsDisabledOf`）；② 进度卡完成态「另存为」（`DownloadProgressCard.svelte:47` → `ViewerPane.svelte:204-238` `saveAsCompleted`）；③ 确认卡「下载并另存为」（`DownloadConfirmCard.svelte:48` → `ViewerPane.svelte:255-271` `confirmSaveAsDownload`）。MetaPanel 无另存为**动作入口**（rg 核实：其「另存为」字样仅出现在打印提示文案 `MetaPanel.svelte:217/219`「请改用浏览器菜单打印并另存为 PDF」中，非管线入口）——本域不设该面断言（无面可断）。
- **编号分段**：SAV-PROBE-02（完成态卡点击链路主锚）/ SAV-DONE-CLOSE（完成态关闭）/ SAV-CANCEL（两种取消语义）/ SAV-PICKER-CANCEL（picker 取消静默分类）/ SAV-NOFSA + SAV-PICKER-FIRST（取数形态与顺序）/ SAV-NOFSA-CONF + SAV-CONF-LOCAL（确认门的降级面与本地来源边界）/ SAV-CONF（确认门非触发侧与作用域键）/ SAV-MENU-CONF + SAV-MENU-STATUS（菜单路原生确认与状态条反馈）/ SAV-DISABLED（置灰判定三条中的两条）/ SAV-DEGRADE（tee 降级面）/ SAV-LOCAL-NOFSA（在手/归档面兜底）/ SAV-NORANGE（非 rangeCapable 降级分支）。
- **既有锚的分工**：`b-save-as.spec.ts` 覆盖「菜单路 picker-first + 落盘字节等值（SA-01）」「zip 条目另存为（SA-02）」「占位 tab 置灰（SA-03）」「进度卡字段全锚与自动卸载（DL-PROG-01）」「不定态锚（DL-PROG-02）」「确认门双路与阈值生效与孤儿清偿（DL-CONF-01a/01b/02/03）」「tee 直写运行时锚（DL-SAVE-01）」；本域只做**其余行为面**，并在断言层去重（SAV-PICKER-FIRST-01 不重复 SA-01 的字节校验和，只留净增量的顺序判据）。
- **红线消费面**（只消费既有 UI，不布产品改动）：`.vv-dl-progress` / `.vv-dl-progress-done` / `.vv-dl-confirm` / `.vv-tabctx` / `.vv-error-card` / `.vv-statusbar` 类名与 `aria-disabled` 语义、`showSaveFilePicker` 契约面（suggestedName / createWritable / write / close / abort）。

## 2. 场景清单

公共环境：default 套件（`apps/web/playwright.config.ts`：vite preview :4173，chromium 1280×720 + mobile 375×667 双 project，retries=1）。**全场景桌面专属**（`test.beforeEach` + `testInfo.skip(testInfo.project.name !== 'chromium')`）——右键菜单/进度卡/确认卡均为桌面交互面，mobile 375px 复跑无增量覆盖。

### 2.1 完成态卡与取消语义（SAV-PROBE-02 / SAV-DONE-CLOSE-01 / SAV-CANCEL-* / SAV-PICKER-CANCEL-01）

| 编号 | 前置条件 | 步骤 | 期望 | 关联缺陷 |
| --- | --- | --- | --- | --- |
| SAV-PROBE-02 | 假 vviewer 服务器（24MiB 精确体量 PNG，单块响应延时 700ms）；旧键 `tabs` 快照预置（remote 来源 + 目录 tab + `big.png` 文件 tab，size=24MiB）；阈值预置 1MB（localStorage `vviewer:settings`）；`showSaveFilePicker` 桩（记录 suggestedName/写入块/close/abort） | ① 首开 → 确认门出现（24MiB > 1MB）→「开始下载」→ 进度卡 → **完成态卡**（`.vv-dl-progress-done`）；② 一次性取回完成态卡文案（TTL 4s → 卡出现到点击只留一次往返）并随即点「另存为」；③ 观察重下与落盘 | ① 完成态卡文案含文件名 `big.png` 与「24.0 MB」（size 已知证据）；② 完成态卡先卸载（与进度卡互斥挂载），重下期间**进度卡复用出现**；③ picker 桩恰被调 1 次且 suggestedName=`big.png`；落盘字节总数 = 24MiB 且逐块校验和与源等值（块边界 = 泵的 4MiB 窗）；`close`=1、`abort`=0；**原生对话框计数 0**（`hooks.confirm` 恒真钩子，不弹 `window.confirm`）；`/api/file` 请求数较点击前增长（远端重下确实发生） | —（完成态卡「另存为」点击链路零锚；覆盖残余 A2 翻转后的远端面 + 确认门恒真钩子面） |
| SAV-DONE-CLOSE-01 | 同上（阈值默认 512MB，24MiB 不触发确认门；单块延时 500ms） | ① 等完成态卡出现；② 记录 `/api/file` 请求数与已渲染 img 的 src；③ 点完成态卡「关闭」 | ① 完成态卡卸载（`.vv-dl-progress-done` 计数 0）；② **显式沉降窗 500ms 后** `/api/file` 请求数**零增长**（关闭不触发重下；沉降窗口径对齐既有 DL-CONF-01b 的 500ms，避免以「点击往返时延 > 请求下发时延」的隐式时序依赖立论）；③ picker 桩调用数 0（关闭不触发另存为）；④ **已渲染内容未被销毁重建**：关闭后 `.vv-viewer-host img` 的 src 与关闭前**同一**（非「仍可见」式恒真护栏——关闭若销毁实例则 src 消失/变更即红） | —（完成态卡「关闭」零锚；`clearDlDone` 只卸卡不牵动下载面） |
| SAV-CANCEL-PUMP-01 | 24MiB PNG（单块延时 700ms）+ picker 桩 + 默认阈值 | ① 等完成态卡出现；② 点「另存为」→ 重下（进度卡出现）；③ 记录取数计数 → 点进度卡「取消」 | ① 进度卡卸载；② picker 桩 `abort`=1、`close`=0（半成品丢弃、不落盘）；③ **判别证据：取数停增**——取消后沉降窗内 `/api/file` 计数零增长（若取消句柄错挂 `effectAbort`，重下泵会跑到结束并 close 落盘，此断言即红）；④ 已渲染内容存活（**护栏项**：取消前渲染早已收束，本条不单独判别两种句柄，判别证据是 ②③）；⑤ 状态条无「另存为失败」、原生对话框计数 0（泵取消落 abort 身份 → 静默收场） | —（两种 `dlAbort` 语义未区分：完成态重下路 `dlAbort=pumpAbort` vs 渲染 effect 路 `dlAbort=effectAbort`；本行钉前者） |
| SAV-CANCEL-RENDER-01 | 24MiB PNG（单块延时 700ms）+ 默认阈值（不装 picker 桩） | ① 等进度卡出现（下载中形态）；② 点「取消」；③ 观察沉降窗 | ① 进度卡立即卸载；② `/api/file` 请求数在沉降窗（2.5s > 单块延时 700ms）内**零增长** → 泵被 abort；③ **无错误卡**（`.vv-error-card` 计数 0——取消不是读失败，静默面）；④ 无渲染产出（`.vv-viewer-host img` 计数 0，abort 后实例被丢弃）；⑤ 不出现完成态卡 | —（渲染 effect 路 `dlAbort=effectAbort`：取消整个 dispatch，与 SAV-CANCEL-PUMP-01 的「只断本次重下泵」成对区分） |
| SAV-PICKER-CANCEL-01 | 2MiB 远端 PNG；picker 桩档位「抛 `NotAllowedError`」（用户取消/授权拒绝）；默认阈值 | ① 首开渲染；② 右键「另存为」（picker 在选目标处抛错） | ① picker 被调 1 次（取消点在选目标处）；② **零写入**：`createWritableCalls`=0、写入块 0、写入字节 0、`close`=0、`abort`=0（取消在开启 writable 之前）；③ **零取数**：沉降窗 500ms 后 `/api/file` 计数零增长；④ **静默**：状态条无「另存为失败」（`saveAs.ts:46-55` 的 `isPickerCancel` 分类命中 → 返回 `'cancelled'`；分类被破坏即由 `TabBar.svelte:196-203` 的 `.catch` 落失败提示而红） | —（picker 取消的静默分类在应用层零锚——此前仅有单元锚 `saveAs.test.ts:148/160`） |

### 2.2 取数形态与先后顺序（SAV-NOFSA-01 / SAV-PICKER-FIRST-01 / SAV-NORANGE-01 / SAV-LOCAL-NOFSA-01）

| 编号 | 前置条件 | 步骤 | 期望 | 关联缺陷 |
| --- | --- | --- | --- | --- |
| SAV-NOFSA-01 | 2MiB PNG 远端来源；`addInitScript` **显式遮蔽** `window.showSaveFilePicker`（defineProperty 置 undefined——Chromium 原生面在安全上下文存在，不遮蔽到不了降级路径）；改写 `HTMLAnchorElement.prototype.click` 记录兜底点击 | ① 首开渲染；② 右键 →「另存为」 | ① 兜底面落地：被点击的 `<a>` 的 href 以 `blob:` 开头、download=`mid.png`；② 兜底 blob 体**字节数与校验和均与源等值** → 取数在兜底落地**之前**已完成（降级面「先取数后选目标」；此判据不依赖跨进程时刻比对）；③ 远端取数请求确实发出（计数增长）；④ 页内 `showSaveFilePicker` 为 `undefined`（装置自证：确在无 FS Access 形态） | —（无 FS Access 降级零锚：`saveAs.ts:107-112` blob URL + `<a download>`；残余 A2 翻转只覆盖有 FS Access 的 picker-first 路） |
| SAV-PICKER-FIRST-01 | 2MiB PNG 远端来源 + picker 桩（**带服务器侧取数计数面**：桩在返回句柄前先读一次 `/api/count`）+ 默认阈值 | ① 首开渲染；② 记取数计数 → 右键「另存为」；③ 比对「选定目标时的取数计数」与「另存为前计数」 | ① **判别证据：选定目标时服务器侧取数计数 == 另存为前计数** → 传输在目标选定之后才启动（残余 A2 picker-first 形态；旧形态「先取数后选目标」该计数会 > 基准而红；判据用计数单源表达，**不用跨进程时刻比对**，系统时钟被 NTP 调整亦不破）；② suggestedName=源文件名；③ `close`=1、写入字节数 = 源字节数（字节等值面见既有 SA-01，本域不重复其分块校验和——2MiB < 泵窗 4MiB，两种算法同值） | —（远端 + 有 FS Access 的 picker-first 顺序零锚） |
| SAV-LOCAL-NOFSA-01 | 本地文件（`helpers.ts` 的 `openDirBytes` 注入 2MiB PNG → `localfiles:` 来源，`size` 已知）+ 无 FS Access 遮蔽 + `<a download>` 点击记录 | ① 打开本地文件；② 右键 →「另存为」 | ① 在手/归档分支（`saveAs.ts:308-312`：store.read 单次全量 → saveAsBlob）→ 无 picker → blob URL + `<a download>` 兜底（href 以 `blob:` 开头、download=`local.png`）；② blob 体字节数与校验和均与源等值；③ 本地来源不触发进度卡/确认卡（`.vv-dl-confirm`/`.vv-dl-progress` 均计数 0） | —（在手/归档分支的 blob 兜底面零锚——此前只覆盖远端分支 `saveAs.ts:286-306`，两条分支不同源） |
| SAV-NORANGE-01 | 直连 S3 挂载（mounts 记录 + `workspaces` 快照恢复，storeId=`s3direct:hash8(['s3',endpoint,bucket,prefix,'path'])`）；端点 mock 对 Range 请求一律回 **200 + 全量 body**（S3 Range 防线降级 → `store.rangeCapable=false`）；1MiB PNG（≤ dispatcher `FULL_LIMIT`）；picker 桩 | ① 恢复后首开渲染（首读带 Range 头 → 端点回 200 → 降级）；② 记对象读计数 → 右键「另存为」 | ① 首读带 Range 头（`range` 非 null）；② 另存为的对象读**恰 1 次且不带 Range 头**（非 range 来源回落单次全量读——泵的 N 窗循环会把传输放大 N 倍）；③ 落盘字节数与校验和等值、`abort`=0 | —（远端 `!rangeCapable` 分支零锚：`saveAs.ts:253/296`，**directS3 侧**；directDav 侧的同款 Range 防线锚在挂载域 `b-mounts-deep` MM-17，跨域承接不重复） |

### 2.3 确认门：非触发侧、作用域键、降级面、原生确认（SAV-CONF-* / SAV-MENU-*）

| 编号 | 前置条件 | 步骤 | 期望 | 关联缺陷 |
| --- | --- | --- | --- | --- |
| SAV-CONF-EQ-01 | 阈值预置 1MB；远端文件**体量恰等阈值**（精确 1048576 字节 PNG，声明 size 同值） | ① 打开文件 → 等待渲染完成 | ① `.vv-dl-confirm` 计数 0（**等界不确认，严比较**：`shouldConfirm` 为严格 `>`）；② `/api/file` 请求数 > 0（门未拦截，下载照常发生）；③ **size 已知有据**：完成态卡回显「共 1.0 MB」——缺席断言本身不可分辨「恰等阈值」与「size 未知」，此行把 size 钉在已知面上；④ 缺席断言前先等渲染完成这一稳定在场信号 | —（确认门等界不触发无对照锚；既有 DL-CONF-01a/02 只覆盖触发侧） |
| SAV-CONF-EQ-CTRL-01 | 阈值预置 2MB；远端文件恰 2MiB（2097152 字节 = 阈值）；目录 tab + 文件 tab | ① 打开文件 → 无确认卡、渲染完成、完成态卡回显「共 2.0 MB」；② 页内把阈值下调为 1MB → 切到目录 tab → 切回文件 tab | ① 阈值 2MB == size 2MiB → `.vv-dl-confirm` 计数 0（等界不拦）；② 完成态卡回显「共 2.0 MB」（size 已知有据）；③ **差分对照**：同一已知 size 载体，阈值降为 1MB 后重跑渲染 effect → **确认卡如期出现**（证明 ① 的缺席源于「恰等阈值」而非「size 未知/门失效」） | —（等界不触发的差分对照——单靠缺席断言无法排除「size 未随快照传播」的同真同假） |
| SAV-CONF-UNKNOWN-01 | 阈值预置 1MB；远端文件 **size 未知**（树条目省略 size + 快照不带 size → `FileSource.size=null`） | ① 打开文件 → 等待渲染完成 | ① `.vv-dl-confirm` 计数 0（size 未知不适用确认门：无前置数字）；② `/api/file` 请求数 > 0（不定态下载照常发生） | —（确认门 size 未知不触发无显式缺席断言） |
| SAV-CONF-LOCAL-01 | 阈值预置 1MB；本地 2MiB PNG（`helpers.ts` `openDirBytes` 注入，本地 File 体量已知且 > 阈值） | ① 打开本地文件 → 等待渲染完成 | ① `.vv-viewer-host img` 可见（本地来源直接渲染）；② `.vv-dl-confirm` 计数 0（**本地来源 L1–L3 永不拦**：体量已知且超阈值仍无确认卡——若 `isRemoteDownload` 门条件被放宽即红） | —（确认门「本地来源永不拦」边界在 e2e 无对照锚——既有与本域锚均只覆盖远端来源） |
| SAV-NOFSA-CONF-01 | 阈值预置 1MB；远端 2MiB 文件；**无 FS Access 遮蔽**（`removeFsAccess`） | ① 打开文件 → 确认卡出现 | ① 确认卡在场，「开始下载」「取消」可见；② **`.vv-dl-confirm-saveas` 计数 0**（双形态二按钮不渲染——`canFsSave` 探测装配门，`ViewerPane.svelte:247-249` + `DownloadConfirmCard.svelte:45-49`）；③ 降级后的普通下载路径照常可用（开始下载 → 内容渲染） | —（无 FS Access 环境确认卡的降级契约零锚——plan 明列「无 FS Access 环境降级为普通下载路径」） |
| SAV-CONF-KEY-01 | 阈值 1MB；远端 2MiB 文件 tab + 目录 tab；不装 picker 桩 | ① 打开文件 → 确认卡出现 →「开始下载」→ 渲染完成；② 记请求数 → 切到目录 tab → 切回文件 tab | ① 切回后 `/api/file` 请求数**增长**（渲染 effect 重跑、门已放行）；② `.vv-dl-confirm` 计数 0（**同键不再问**：键 = `storeId::path::size`，确认后登记 `dlApprovedKey`） | —（确认作用域键「同键不再问」零锚） |
| SAV-CONF-KEY-02 | 阈值 1MB；远端 2MiB 文件 tab + 目录 tab | ① 打开文件 → 确认卡出现 →「取消」；② 切到目录 tab → 切回文件 tab | ① 取消后 `.vv-dl-confirm` 计数 0，且**沉降窗 500ms 后** `/api/file` 请求数恒 0（取消静默中止，泵未启动；显式窗口避免隐式时序依赖）；② 切回后**确认卡重现**（**取消后重问**：取消不登记确认键），且沉降窗后请求数仍为 0（重问期间泵仍未启动） | —（确认作用域键「取消后重问」零锚） |
| SAV-MENU-CONF-01 | 阈值 1MB；远端 2MiB 文件（先经确认卡「开始下载」完成首下载）+ picker 桩；`page.on('dialog')` 桩**拒绝** | ① 右键「另存为」→ 原生确认弹出 → 拒绝 | ① 原生确认文案含文件名与「超过远端下载确认阈值」；② picker 桩被调 1 次（picker-first：目标先选）但 `createWritable` 调用数 0、写入块 0、`close`=0、`abort`=0（**目标文件零触碰**）；③ **沉降窗 500ms 后** `/api/file` 请求数零增长（**零读**：确认门拒绝 = cancelled，read 未启动） | —（菜单路远端超阈值 `window.confirm` 拒绝面零锚） |
| SAV-MENU-CONF-02 | 阈值 1MB；远端 2MiB 文件（先经确认卡「开始下载」完成首下载）+ picker 桩；`page.on('dialog')` 桩**接受** | ① 右键「另存为」→ 原生确认弹出 → 接受 | ① picker 桩 suggestedName=文件名；② 落盘字节数与校验和等值；③ `close`=1、`abort`=0 | —（菜单路远端超阈值 `window.confirm` 接受面零锚） |
| SAV-MENU-STATUS-01 | 12MiB PNG（单块延时 500ms → 另存为耗时约 1.5s，保证「开始拉取」提示可被观测）+ picker 桩 | ① 首开渲染；② 右键「另存为」 | ① 状态条先落「正在拉取全量以另存为…」（`TabBar.svelte:191`——菜单路的轻量进度面，与进度卡是两条不同反馈面）；② 另存为完成后状态条落「已另存为 big.png」（`TabBar.svelte:199`） | —（菜单路状态条反馈面此前仅有源码级单元断言 `saveAs.test.ts:635-636`，运行时零锚） |

### 2.4 置灰判定与 tee 降级面（SAV-DISABLED-* / SAV-DEGRADE-*）

| 编号 | 前置条件 | 步骤 | 期望 | 关联缺陷 |
| --- | --- | --- | --- | --- |
| SAV-DISABLED-DIR-01 | 远端来源 + 目录 tab（`path` 为空）+ 文件 tab；picker 桩 | ① 右键目录 tab → 菜单；② 「另存为」项 `aria-disabled` 断言；③ force 点击该项 | ① 「另存为」项 `aria-disabled="true"`（`saveAsDisabledOf` 的 `path===''` 判定）；② force 点击后**菜单留守**、picker 桩调用数 0（点击零动作） | —（`saveAsDisabledOf` 三条判定中目录分支零锚；占位分支见既有 SA-03） |
| SAV-DISABLED-ERR-01 | 远端来源 + 单文件 tab；`/api/file` 强制 500（读失败 → 错误卡片 → `lastRendererId='error'`）；picker 桩 | ① 等 `.vv-error-card` 出现；② 右键该 tab → 菜单；③ force 点击「另存为」 | ① 「另存为」项 `aria-disabled="true"`（`saveAsDisabledOf` 的 `lastRendererId==='error'` 判定）；② force 点击后菜单留守、picker 桩调用数 0 | —（`saveAsDisabledOf` 三条判定中错误分支零锚） |
| SAV-DEGRADE-WRITABLE-01 | 阈值 1MB；远端 2MiB 文件；picker 桩档位「`createWritable` 抛错」 | ① 打开文件 → 确认卡 →「下载并另存为」 | ① 状态条出现「已降级为普通下载」（`直写落盘通道开启失败，已降级为普通下载`——静默降级不留提示是缺陷，此处钉提示面）；② 内容照常渲染（`.vv-viewer-host img` 可见，普通下载路径未受影响）；③ picker 桩 `createWritable` 调用数 1（失败确实发生在开启面）、`close`=0、`abort`=0（无 writable → 无半成品面） | —（tee `createWritable` 失败降级零锚） |
| SAV-DEGRADE-WRITE-01 | 阈值 1MB；远端 2MiB 文件；picker 桩档位「`write` 抛错」 | ① 打开文件 → 确认卡 →「下载并另存为」 | ① 写尝试次数 > 0（失败确实发生在写面）；② `abort`=1、`close`=0（**半成品丢弃，不落盘**）；③ 内容照常渲染（写失败不回灌取数主路，字节流照常交付） | —（tee 写失败 abort 半成品零锚） |

## 3. 验收行为

- **完成态卡两动作是独立入口**（SAV-PROBE-02 / SAV-DONE-CLOSE-01）：同一张卡上「另存为」触发远端重下 + 落盘，「关闭」只卸卡（零取数、零 picker、已渲染内容不被销毁重建）。两者分岔即为「完成态卡是消费面而非仅提示面」的判据。
- **两种取消语义必须分开**（SAV-CANCEL-PUMP-01 / SAV-CANCEL-RENDER-01）：完成态重下路的取消句柄是自持 `pumpAbort`（只断本次重下泵 → 半成品 abort、不落盘、取数停增）；渲染 effect 路的取消句柄是 `effectAbort`（取消整个 dispatch → 产出丢弃、无错误卡）。**判别证据是 abort/close 计数与取数停增**，「已渲染内容存活」在两种句柄下均成立（取消前渲染早已收束），只作护栏不作判据。
- **取消与拒绝的静默语义**（SAV-PICKER-CANCEL-01 / SAV-MENU-CONF-01 / SAV-CANCEL-*）：picker 取消（NotAllowedError）与确认门拒绝都是 `cancelled` 而非失败——零写入、零取数、状态条不落「另存为失败」。分类被破坏（`isPickerCancel` 失效、`.catch` 兜到）即由状态条断言红。
- **取数与选目标的顺序是产品契约**（SAV-PICKER-FIRST-01 / SAV-NOFSA-01）：有 FS Access 时目标必须先于传输选定（否则重下超过瞬态激活窗时 picker 被拒、整次另存为静默丢失）；无 FS Access 时降级面是「先取数后 blob 落地」。两条顺序结论一律以**服务器侧取数计数**（picker 桩在返回句柄前读一次 `/api/count`）与**blob 体字节等值**表达——不使用浏览器 `Date.now()` 与 node 请求到达时刻的跨进程比对（无毫秒容差，系统时钟被 NTP 调整即破）。
- **确认门的非触发侧与触发侧同等重要**（SAV-CONF-EQ-01 / SAV-CONF-EQ-CTRL-01 / SAV-CONF-UNKNOWN-01 / SAV-CONF-LOCAL-01）：门是严格 `>` 比较，等界不确认；size 未知不适用确认门；本地来源永不拦。等界场景另配**差分对照**（同一已知 size 载体、阈值下调即出卡）与**size 已知有据**（完成态卡回显总大小）——单靠缺席断言无法排除「size 未随快照传播」的同真同假。
- **确认作用域键的生命周期**（SAV-CONF-KEY-01 / SAV-CONF-KEY-02）：键 = `storeId::path::size`；确认后登记 → 同键不再问；取消不登记 → 同文件下次渲染重问。键是组件级 state，刷新页面即复位（本域不设刷新复位断言）。
- **原生确认面只在菜单路**（SAV-MENU-CONF-01 / SAV-MENU-CONF-02）：Tab 右键菜单路用 `window.confirm` 钩子；完成态卡与确认卡路径用确认卡/恒真钩子，不弹原生对话框（SAV-PROBE-02 以对话框计数 0 钉这条分工）。菜单路的用户可见反馈是**状态条**而非进度卡（SAV-MENU-STATUS-01：开始提示 → 完成提示）。
- **降级面必须留痕**（SAV-DEGRADE-WRITABLE-01 / SAV-DEGRADE-WRITE-01 / SAV-NOFSA-CONF-01）：直写开启失败给状态条降级提示（内容不丢）；直写写失败 abort 半成品、不落盘，但字节流仍交付给渲染（内容不丢）；无 FS Access 环境确认卡只给普通下载路径（双形态二按钮不渲染）。
- **置灰判定的三条支线**（SAV-DISABLED-DIR-01 / SAV-DISABLED-ERR-01 + 既有 SA-03）：占位（unrestorable）/错误（`lastRendererId==='error'`）/目录（`path===''`）三类 tab 的「另存为」均 `aria-disabled` 且点击零动作、菜单留守。

## 4. 环境与数据

### 4.1 套件与装置

- 桌面专属：`test.beforeEach` + `testInfo.skip(testInfo.project.name !== 'chromium', '桌面视口专属（仅 chromium project）')`（b-save-as / b-diagram-file 同款写法）。
- **假 vviewer 服务器**（node:http 随机端口，本文件内）：`/api/health`（`{capabilities:['file-server']}`）、`/api/tree`（可声明/省略 size）、`/api/file`（Range 206 切片 + 单块延时 + 强制 500 形态 + 请求计数）、`/api/count`（**取数计数面**：顺序判据用）、`/api/ticket`、`/api/events`（SSE 持挂）；全响应 `Access-Control-Allow-Origin: *`。
- **会话预置**：旧键 `tabs` 快照（remote 来源 `remote:hash8(base:label)` + 目录 tab + 文件 tab + 可选 size）；恢复链以快照 `storeLabel` 原值重建 store（label 参与 storeId hash，见 `serverConnect.svelte.ts` label 回环注记）。
- **阈值装置**：`addInitScript` 预置 localStorage `vviewer:settings` 的 `storage.remoteDownloadConfirmMb`（设置面持久化单源；`loadSettings` 每轮现算 → 门评估即时生效；局部覆盖由 `normalizeSettings` 补默认节）；运行期下调用页内直写 localStorage + 切 tab 触发 effect 重跑。
- **picker 桩**（`addInitScript`）：`showSaveFilePicker` 记录 suggestedName；writable 记录写入块数/字节数/逐块校验和（块内下标参与，与 node 端 `byteHashChunked` 同算法）、`close`/`abort` 计数；桩在返回句柄前可选读一次服务器侧取数计数（顺序判据）；四档形态（正常 / `createWritable` 抛错 / `write` 抛错 / picker 抛 `NotAllowedError`）。
- **无 FS Access 形态**：`addInitScript` 以 `Object.defineProperty(window,'showSaveFilePicker',{value:undefined})` 遮蔽原生面（headless Chromium 在安全上下文下原生面存在，不遮蔽到不了降级路径）；同时改写 `HTMLAnchorElement.prototype.click` 记录 `<a download>` 兜底点击（href/download）。
- **直连 S3 装置**：`mounts` store 记录 + `workspaces` 快照直写（IndexedDB，免版本 open + 五 store 幂等补建，抄 `b-mounts-deep.spec.ts` MM-13 同款）；端点以 `page.route` mock（OPTIONS 预检放行、ListObjectsV2 回 XML、对象读回 200 + 全量 body 以触发 Range 防线降级）。
- **本地文件注入**：复用既有共享 helper `e2e/helpers.ts` 的 `waitAppMounted` / `openDirBytes` / `openFile`（**只读引用，未改动共享文件**）。

### 4.2 装置收敛与重复面处置（2026-11-08 复核处置）

1. **PNG 构造收敛到 node:zlib 的 crc32**：`pngChunk` 改用 `node:zlib` 的 `crc32`（`png-fixture.ts:1/20` 同款），**删除**本域原手写的 256 项 CRC 表与 `crc32` 实现（原与 `b-save-as.spec.ts:43-67` 重复）。本机 node v24.13.0 实测 `typeof require('node:zlib').crc32 === 'function'`（返回值即无符号 32 位）。精确体量构造（`makePngOfExactSize`）保留——`png-fixture.ts` 的 `goodPng()` 固定 32×8 体量，无法满足「体量恰等阈值」的字节级比较。
2. **假服务器保留在本域的原因**（与既有共享件 `fake-file-server.ts` 的能力差）：共享件只回整段文本响应，**无 Range 206 切片**——泵的请求窗会取到同一段前缀（字节面错误）；且无请求计数面、无 500 形态、无逐块延时。本域所需的四能力（206 切片 / 计数面 / 500 / 延时）均在其缺失项内，无法直接复用。
3. **与既有 `b-save-as.spec.ts` 的装置无法互相 import**：spec 文件顶层即注册用例，跨 spec import 会重复注册并污染报告；故本域不抽公共 helper 文件（域间文件互斥约束），收敛止于「共享 fixture 层（node:zlib crc32、helpers.ts）+ 本域内去手写实现」。直连 S3 装置（`seedMountRecord` / `seedWorkspaceSnapshot` / CORS 头常量）与 `b-mounts-deep.spec.ts` MM-13 的内联副本重复同理——该域装置未抽共享件，本域不可 import 其 spec 文件，故保留域内副本并在两侧注释标明同源。
4. **断言层去重**：SAV-PICKER-FIRST-01 原含与既有 SA-01 重复的分块校验和（且 2MiB < 泵窗 4MiB，分块与扁平算法同值、无增量），已删除，只留净增量的顺序判据与「写入字节数 = 源字节数」；SA-01 继续承担「菜单路落盘字节等值」的唯一锚。

### 4.3 数据构造与边界注意事项

1. **精确体量 PNG**：`makePngOfExactSize(total)` 用 vvEX 私有 ancillary 块把 1×1 PNG 填到指定字节数（解码器跳过未知块）。精确体量的意义：确认门是字节级严格比较，「等界不触发」场景要求声明 size 与阈值逐字节相等。
2. **落盘字节等值的两层断言**：字节总数 + 逐块校验和。块边界必须与泵的请求窗一致（`pumpFull` 的 `FULL_CHUNK` = 4MiB），页内累计按「块内下标」重置（与 node 端 `byteHashChunked` 同算法）——单块文件（≤4MiB）时两种算法同值，多块文件必须按块切分对齐。
3. **顺序断言的时钟无关性**：本域**不使用**跨进程时刻比对（浏览器 `Date.now()` vs node 请求到达时刻，无毫秒容差且 NTP 调整即破）。改用服务器侧取数计数（picker 桩在返回句柄前读一次 `/api/count` → 「选定目标时计数 == 另存为前计数」= 目标先选、传输后启）与 blob 体字节等值（取数先于落盘）。这两条判据都直接对应产品语义，不依赖计时。
4. **「零取数」类缺席结论一律带显式沉降窗**：`SETTLE_MS = 500ms`（口径对齐既有 DL-CONF-01b 的 `b-save-as.spec.ts:480`）——点击往返实测约 37ms、请求下发约 3ms，500ms 留两个数量级余量；SAV-CANCEL-RENDER-01 的取数停增窗取 2.5s（> 单块延时 700ms）。
5. **完成态卡 TTL**：完成态卡 4s 自动卸载（`DL_DONE_TTL_MS`，`ViewerPane.svelte:181`）——卡出现到点击之间只留一次往返（文案以 `innerText` 一次性取回、Node 侧断言，随即点击），避免多次 expect 往返在 CI 高负载下被 TTL 抢先。
6. **进度卡与完成态卡互斥挂载**：两者同挂 `.vv-dl-progress` 基类但不同节点，断言「完成态出现」时不得同时断言「进度卡仍在」；本域用 `.vv-dl-progress:not(.vv-dl-progress-done)` 精确取下载中形态。
7. **确认卡/完成态卡的缺席断言**：均先等「渲染完成/错误卡出现/进度卡卸载」等稳定在场信号，再判缺席（避免把「慢」误判成「无」）；等界场景另配差分对照与 size 已知有据（完成态卡总大小回显）。
8. **原生对话框**：`page.on('dialog')` 桩在菜单路场景分别 dismiss/accept；未注册 handler 时 Chromium 自动 dismiss，会把「拒绝」场景假绿——故每处都显式注册。
9. **直连 S3 恢复链**：快照须含 `sources[]`（`kind:'direct'` + `storeId` 与 mounts 记录 id 一致）与文件 tab（`path`/`name`/`size`），restore 链按记录 id 重建 store（`AppShell.svelte` 直连挂载恢复分支）；记录删除或 id 不一致 → tab 落占位，场景会以「内容不出现」红（非假绿）。
10. **本域未覆盖的面**（登记待补，非本域受阻）：`saveAsStreamToDisk` 契约面当前无应用内消费者（`saveAs.ts` 头注备案），无 e2e 落点；zip 条目（L3）在无 FS Access 环境的 blob 兜底未单列（SAV-LOCAL-NOFSA-01 覆盖 L1/L2 本地分支，L3 同走 `saveAsBlob`，zipStore 读通道的字节等值由既有 SA-02 承担）；MetaPanel 无另存为动作入口，无面可断；确认作用域键的「刷新页面即复位」未设断言。
11. **索引登记**：`docs/e2e/README.md` §2.1 的特性域枚举清单尚未收录本文件（pdf-range-transport / diagram-file-renderers / file-viewer-foreign-bridge / sw-runtime-cache 等同期在飞域同样未收录，属仓库现状惯例）——待统一刷新索引时补；本轮受「只改本域两文件」约束未动 README。
