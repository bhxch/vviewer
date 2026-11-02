# 渲染器自选与内容探测 e2e — 场景（OWM / SIG / ENC 三子域）

> 来源：spec `docs/superpowers/specs/2026-10-28-renderer-picker-signature-encoding-design.md`（议题一「更多渲染器」就地展开 §2 / 议题二 magic 签名表扩容 §3 / 议题三编码探测升级 §4）+ plan `docs/superpowers/plans/2026-10-28-renderer-picker-signature-encoding.md`（Task 4 OWM-01..03、Task 6 SIG-01..04、Task 9 ENC-01..02）。上游 spec：`2026-10-23-renderer-lang-override-markpad-alignment-design.md` §2（渲染器三入口单机制不变量）。本文档为该域的收册文档：既有场景行转录现状脚本，OWM-04..07 为测绘差距新增锚（收起动作 / 展开态非持久 / reload 快照恢复 / 三入口双向回显）。

## 1. 目的与来源

- **现状 e2e 文件**：`apps/web/e2e/b-open-with-more.spec.ts`（OWM-01..03，三入口展开与全量选择）、`apps/web/e2e/b-file-detect-signature.spec.ts`（SIG-01..04，无扩展名 mp4/webp/gz/7z 改派）、`apps/web/e2e/b-encoding-detect.spec.ts`（ENC-01..02，Shift-JIS 精判与 UTF-32LE BOM）、`apps/web/e2e/t-open-with.spec.ts`（OWX 系候选集/override 快照落盘与 restore，BUG-69）。
- **实现锚**：哨兵常量 `apps/web/src/lib/RendererPickerMenu.ts:13-14`（`__more__`/`__less__`，UI 语义项不进数据面）；MetaPanel 壳 `apps/web/src/lib/MetaPanel.svelte:70-87`（`openWithOptions` 展开分支 + `onOpenWithChange` 哨兵拦截）；状态栏浮层壳 `apps/web/src/lib/ViewerPane.svelte:153-178`（`pickerItems` + `pickRenderer`）；TabCtx 壳 `apps/web/src/lib/TabBar.svelte:115-150`（「打开方式」children + 「更多渲染器」二级 = 「自动」头项 + registry 全量，434e6a4）；签名改派 `packages/core/src/detect/magic.ts` + `packages/core/src/dispatch/dispatcher.ts`（SIGNATURE_ROUTES）；编码精判 `packages/core/src/detect/encodingRefine.ts`（chardet 分层，gb18030 门控 + 置信 ≥0.90 白名单）。
- **测绘差距**（本文档新增面）：现 OWM-01/02 只锚「展开与选择」，**收起动作零锚**（OWM-04）；展开态非持久与 TabCtx 子菜单复位语义零锚（OWM-05，434e6a4 修复面）；三场景无 reload 会话恢复面（OWM-06）；MetaPanel 主入口 → 状态栏指示器的回显方向零锚（OWM-07，OWM-02 只锚反向）。

## 2. 场景清单

### 2.1 既有面（现状脚本已锚，编号沿用 plan）

| 编号 | 落点 | 锚要 |
| --- | --- | --- |
| OWM-01 | `b-open-with-more.spec.ts:75` | MetaPanel 受限候选尾「更多渲染器…」哨兵 → 展开全量 14 项（自动 + registry 12 + 收起）→ 选 archive 落 override：错误卡上位 + select 回退自动（受限外回退自动语义）+（手动）徽标 |
| OWM-02 | `b-open-with-more.spec.ts:125` | 状态栏浮层展开选 JSON Lines → `.vv-jsonl` 视图 + `.vv-status-openwith` label 跟随 +（手动）徽标 |
| OWM-03 | `b-open-with-more.spec.ts:159` | Tab 右键「打开方式 ▸ 更多渲染器」二级子菜单选 PDF → run 必关 + 错误卡 + ✓ 回显 + Esc 三层收 |
| SIG-01..04 | `b-file-detect-signature.spec.ts:60-81` | 无扩展名 mp4（ftyp isom）/webp（RIFF…WEBP）/gz（1f 8b 08）/7z → 候选面出现 av/image/archive option + select value 恒 ''（自动路由语义，SUSP-09 同锚） |
| ENC-01 | `b-encoding-detect.spec.ts:61` | Shift-JIS（cp932 87B 样本）→ 精判翻转 shift_jis：`.meta-panel` 含 shift_jis + `.vv-code-pre` 无乱码 |
| ENC-02 | `b-encoding-detect.spec.ts:68` | UTF-32LE BOM（FF FE 00 00）→ 编码行 utf-32le + 定长解码 'AB' |

### 2.2 新增面（测绘差距锚，编号接续 OWM）

| 编号 | 前置条件 | 步骤 | 期望 |
| --- | --- | --- | --- |
| OWM-04 | 目录注入 `aa.txt` 并打开（OWM-01 同装置）；MetaPanel、状态栏浮层、TabCtx 三入口可达 | ① MetaPanel `.meta-openwith` selectOption('__more__') 展开后 selectOption('__less__')；② 重开浮层（`.vv-status-openwith` 点击）→ 点「更多渲染器…」→ 点 menuitem「收起附加候选」；③ 右键 tab → 点「打开方式」→ 点「更多渲染器」展开二级 → 读二级项集 | ① option 回受限 5 项（label 序：自动（按扩展名）/代码/文本/Markdown/二进制 + `__more__`）且 `option[value="__more__"]` 文案复位「更多渲染器…」（`MetaPanel.svelte:86` LESS 分支翻 `openWithExpanded=false`）；② 浮层**不关**（LESS 分支只复位展开态，`ViewerPane.svelte:176`），menuitem 面回受限 5 项（✓ 自动（按扩展名）/代码/文本/Markdown/二进制 + 「更多渲染器…」——自动头项计入 menuitem 计数，override 为空时 ✓ 落自动项）；③ TabCtx 二级子菜单**无**「收起附加候选」项（形态差异：二级 = 「自动（按扩展名）」头项 + 全量 12 = 13 项，`TabBar.svelte:135-150`——回受限由菜单重开承担，见 OWM-05①） |
| OWM-05 | 同上；TabCtx 与状态栏浮层均可操作 | ① Tab 右键 → 「打开方式」→「更多渲染器」展开二级 → Esc 关菜单 → 再次右键同一 tab → 直接读「打开方式」子菜单面（不点二级）；② 二级展开后点空白处（activateTab 切 tab）→ 再右键新激活 tab → 点「打开方式」→ 点「更多渲染器」展开二级，断言 `.vv-tabctx-sub` menuitem 项数与头项；③ 状态栏浮层展开态下切另一 tab → 重开浮层 | ① 重开即新实例：`TabContextMenu` 仅 `ctx !== null` 时挂载（`TabBar.svelte:337`）、关闭路径收敛 `onclose`（Esc/外点/滚动/resize，`TabContextMenu.svelte:23-25`）→ `openPath` 空起步：一级子菜单 menuitem 计 5 项（✓ 自动（按扩展名）/代码/文本/Markdown/二进制 + 「更多渲染器」父项——`rendererCandidatesOfTab` 委托 `openWithOf` 受限面 4 项含头项，`RendererPickerMenu.ts:53-68`（经 `rendererCandidates` :38 委托链），头项计入计数），二级须再点才展开；② 切 tab 的 pointerdown 先关旧菜单（外点路径 `TabContextMenu.svelte:143-149`）→ 重开二级 = 「✓ 自动（按扩展名）」头项 + 全量 12 = 13 项（434e6a4 修复面：展开态随 tab 切换复位不残留）；③ 状态栏浮层展开态复位触发器 = **激活 tab id 变化**（`ViewerPane.svelte:115-121` 复位 effect，MetaPanel 同款 `MetaPanel.svelte:64-69`）：切 tab 后重开浮层回受限面（受限 5 项同 OWM-04② 口径）。备案：同 tab 内关浮层再开**不**复位（`pickerExpanded` 写点仅 MORE/LESS 拦截与 tab 复位 effect 两类）——spec §2.2「不持久化」指不进快照/设置，非浮层开关复位，此为现状语义非缺陷 |
| OWM-06 | 测试内假 vviewer 服务器（BUG-69 通道，`t-open-with.spec.ts:258` 起）预置 remote 会话：sessionStorage `vviewer-last-server` + IDB 旧键 `'tabs'` 快照（目录条目派生来源 + `notes.txt` 文件 tab，无 override）→ reload 走 migrateLegacyTabs 恢复；状态栏浮层可达 | ① 运行期浮层展开选 JSON Lines（`.vv-jsonl` 视图 + 徽标确认）；② 等快照落盘（IndexedDB kv `'workspaces'` 键出现该 tab `overrideRenderer='jsonl'`，`expect.poll` 轮询写法沿 `t-open-with.spec.ts:202-244`）；③ `page.reload()` → 会话恢复 | override 保留（remote 来源重连重建 + restore 读回 `AppShell.svelte:953-955`，快照类型 `session.ts`）：`.vv-jsonl` 视图回归（非 code 视图，含内容卡）、`.meta-openwith-manual`（手动）徽标在场、`.vv-status-openwith` toContainText 'JSON Lines'（指示器 label 随恢复的 override 重建，`ViewerPane.svelte:669`）。**勘误备案（2026-11-03 实读修订，原前置「目录注入 aa.txt」作废）**：本地注入目录（`openDirectoryViaInput` 内存 File store）不在 restore 重建范围——`AppShell.svelte` 仅重建 localfs 句柄/remote/direct 三类来源，未重建来源的 tab 落 `addPlaceholderTab`（`AppShell.svelte:995-1023`）：占位 store read 即抛错且只回填 pinned 不读回 `overrideRenderer`，三锚均不可能出现（`t-open-with` OPEN-03「本地内容不跨刷新」同源语义）；改走 remote 通道后验收语义不变（运行期浮层选择 → 落盘 → reload 恢复三锚同帧），语料全本地（127.0.0.1 随机端口测试内 http + `/api/file` 内联合法 jsonl 两行）零外网面 |
| OWM-07 | 目录注入 `aa.txt` 打开（OWM-01 同装置，无需会话恢复面）；MetaPanel 可达（窄视口先 `openRightIfNarrow`） | ① MetaPanel `.meta-openwith` selectOption('markdown')（受限内选择）；② 读状态栏指示器；③ 对照反向面（浮层选 → MetaPanel 徽标，OWM-02 已锚）不重跑 | `.vv-status-openwith` toContainText 'Markdown'（MetaPanel 主入口 → `onOpenWith` → `setRendererOverride` → rev++ 重派 → `rendererLabel` 重建，`ViewerPane.svelte:669`/`:857`）；`.meta-openwith-manual` 徽标在场；三入口同帧一致（TabCtx ✓ 面由 OWM-03 既有锚承接，不重复布点） |

## 3. 验收行为

- **OWM-04 收起对称性**：三入口「更多/收起」是纯 UI 哨兵（`__more__`/`__less__` 不进 `FileOpenWith` 数据面），收起后必须精确还原受限面——MetaPanel 逐项 `toHaveText` 对照 OWM-01 的受限序（label 序：自动（按扩展名）/代码/文本/Markdown/二进制 + 哨兵「更多渲染器…」）；浮层收起后再次选全量候选仍须可用（收起不封死重开路径）；TabCtx 无收起项为静态形态断言（步骤③），与 OWM-05① 的重开头面互证。受限面断言口径统一以 **label 词**落 `toHaveText`（`hex` 渲染器 label=「二进制」、`code` label=「代码/文本」，id↔label 对照见 §4 注）。
- **OWM-05 展开态生命周期**：TabCtx 面按 434e6a4 修复口径断「重开即受限头面（一级 5 项含头项）+ 切 tab 后二级不残留（13 项）」；状态栏浮层/MetaPanel 按「激活 tab id 复位」口径断。回归护栏：OWM-01（展开选择链）、OWM-02/03（三入口选择生效）零翻转。
- **OWM-06 会话恢复**：reload 后 override 渲染形态（`.vv-jsonl`）、徽标、指示器 label 三者同帧在场；回归护栏：`t-open-with` BUG-69 restore 锚与 OWX 快照落盘锚零翻转（同一持久化链）。
- **OWM-07 双向回显**：指示器 label 以 registry label 全文断言（'Markdown' 非 id），受限内选择不产生 select 回退自动现象（与 OWM-01 受限外选择分叉）。
- **SIG/ENC 回归护栏**：本文档不改签名/编码链断言；SIG-01..04 候选面锚、ENC-01..02 编码行锚为议题二/三的既有验收基准（`b-file-detect-signature.spec.ts` / `b-encoding-detect.spec.ts`），任何探测链改动后定向复跑。

## 4. 环境与数据

- **通道**：default 套件（`playwright.config.ts`）chromium + mobile 双 project；vite preview :4173。目录注入经 `helpers.ts openDirText`（`__vvOpenDirImpl` + webkitRelativePath，组名 owm）——只建目录 tab，文件 tab 须 `helpers.ts openFile` 树行打开；≤900px 文件树、≤600px 右栏各收抽屉，经 `openRightIfNarrow`/`openDrawerIfNarrow` 适配（OWM-01..03 同款）。
- **registry 全量 12**（展开面项序，`apps/web/src/lib/viewer.ts` install 序）：代码/文本、Markdown、HTML 预览、图片、音视频、PDF、Word 文档、Excel 表格、PowerPoint（文本提纲）、二进制、压缩包、JSON Lines——label 实测源 `b-open-with-more.spec.ts:18-22` 校准注（jsonl='JSON Lines' `render-text/src/jsonl/index.ts:950`、pdf='PDF' `render-doc/src/pdf.ts:52`）。**受限面 id↔label 对照**（`.txt` 载体，本文档断言统一用 label 词落 `toHaveText`、value 断言用 id）：`''`↔自动（按扩展名）、`code`↔代码/文本、`markdown`↔Markdown、`hex`↔二进制；哨兵 id `__more__`↔「更多渲染器…」、`__less__`↔「收起附加候选」。
- **快照落盘等待**：override 写 IndexedDB 为异步 debounce（`t-open-with.spec.ts:202` 先例：轮询 `workspaces` 表直至出现目标 tab `overrideRenderer`，勿用固定 sleep）。
- **移动端形态**：双 project 同参跑（OWM-01..03 惯例）；窄视口断言前先开右栏抽屉，TabCtx 断言不受抽屉影响（TabBar 恒在）。真机触摸形态不在本域（`docs/e2e/README.md` §3.1 环境受限项）。
- **SIG/ENC 夹具**（既有，转录）：SIG 载荷垃圾字节仅锚选路（`b-file-detect-signature.spec.ts:36-42` mp4ish；运行期解码错误卡不断言）；ENC-01 用 cp932 87B 真样本（`b-encoding-detect.spec.ts:39-48`，chardet analyse[0]=Shift_JIS:100——简报原样本置信不足已校准弃用）；ENC-02 BOM+`'AB'` 定长解码样本。构建前置：`pnpm --filter web build:e2e`（VV_GRAMMAR_CDN 注入）。
