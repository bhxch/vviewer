# 图标主题与 Open VSX 通道 e2e — 场景（ICON / OVX 两子域）

> 来源：spec `docs/superpowers/specs/2026-10-31-icon-themes-design.md`（§2 数据面 / §3 消费面 / §6 Open VSX 安装与更新通道）+ plan `docs/superpowers/plans/2026-10-31-icon-themes.md`（Task 4 ICON-01..05、Task 5 OVX-01..05）。本文档为该域收册文档：既有 ICON-01..05 与 OVX-01..05 转录现状脚本，ICON-06..09 为测绘差距新增锚（匹配链三面 / 手动 VSIX 导入通道）。

## 1. 目的与来源

- **现状 e2e 文件**：`apps/web/e2e/b-icon-themes.spec.ts`（ICON-01..05 + ICON-04 附损坏字体回退）、`apps/web/e2e/b-openvsx.spec.ts`（OVX-01..05，SW block 全 mock + 真网冒烟）。
- **实现锚**：匹配链 `packages/vviewer-highlight/src/vscodeIcon.ts:345-383`（`matchIconTheme`：fileNames 精确名命中即返回 `:369-370` > fileExtensions 多级后缀枚举 `:370-374`（`fileSuffixes` 最长优先 `:184-190`）> languageIds 反向表 `:375-380`（`EXT_TO_LANGS`，VSCODE_LANG_EXT vendored 表 `:96-105`：typescript → ['.ts','.mts','.cts']）> `_file` 回退 `:383`；查表键 lowercase）；导入管线 `apps/web/src/lib/vsixImport.ts:356-392`（`.json`/`.vsix`/字体分派，`importIconVsixFile` 读 `contributes.iconThemes[].path`）；存储 `apps/web/src/lib/stores/session.ts:50/201`（`source: 'json' | 'vsix'`）；导入 UI `apps/web/src/lib/settings/AppearanceSection.svelte:550-552`（图标主题 file input `accept=".json,.woff,.woff2,.ttf,.otf,.vsix"`）。
- **测绘差距**（本文档新增面）：现 ICON-01..05 只覆盖 seti 预置/scopes/导入 json 通道/零位移，**匹配链内部优先级零 e2e 锚**（fileNames 压扩展名、languageIds 反向表、多级后缀——均为单测面）；**手动 file input 直导 .vsix 通道零锚**（ICON-04 只锚 json+字体同批，OVX-01 只锚网络 mock 路 vsix）。

## 2. 场景清单

### 2.1 既有面（现状脚本已锚）

| 编号 | 落点 | 锚要 |
| --- | --- | --- |
| ICON-01 | `b-icon-themes.spec.ts:224` | seti 预置默认仅文件树：文件行 `.vv-file-icon` 非空字形、源头行/tab 零图标（上游 Seti 无 folder 关联）；tabs 开关双向补断言 |
| ICON-02 | `b-icon-themes.spec.ts:257` | scopes 门控：关 tree 开 tabs → 树零图标 / tab 图标在场 |
| ICON-03 | `b-icon-themes.spec.ts:270` | quickOpen/search 作用域：Ctrl+P 行首、Ctrl+Shift+F 仅文件头行首图标（命中行不加） |
| ICON-04 | `b-icon-themes.spec.ts:296` | 导入 json+字体同批（Mini 夹具）→ folder 图标 + caret 替代（hidesExplorerArrows）+ 删除回退 none；附损坏字体 fontsOk=false 回退纯 caret（`:375`） |
| ICON-05 | `b-icon-themes.spec.ts:345` | 无匹配文件零位移：未命中行无图标元素且行高亚像素一致 |
| OVX-01..05 | `b-openvsx.spec.ts:147-332` | 安装生效 / manifest 预检快错零整包下载 / 更新闭环（v1→v2 引用 id 不变+运行时刷新）/ 30MB 超限拒 / 真网冒烟 skipIf offline |

### 2.2 新增面（测绘差距锚）

| 编号 | 前置条件 | 步骤 | 期望 |
| --- | --- | --- | --- |
| ICON-06 | Mini 夹具变体：`iconDefinitions { x: charX, y: charY }` + `fileNames { 'app.ts': 'x' }` + `fileExtensions { ts: 'y' }`（两字形不同码点）；注入含 `app.ts` 目录 | 选主题应用 → 读 `app.ts` 树行 `.vv-file-icon` 字形 | 命中 **x**（精确名压过扩展名）：fileNames 全名精确命中即短路返回（`vscodeIcon.ts:369-370` 在后缀枚举之前）——`.vv-file-icon` toHaveText charX，非 fileExtensions 的 charY |
| ICON-07/lang | Mini 夹具变体：`iconDefinitions { t: charT }` + `languageIds { typescript: 't' }`（无 fileExtensions）；注入 `app.ts` | 选主题应用 → 读树行字形 | 树行命中 t（`.vv-file-icon` toHaveText charT）：反向表匹配输入 = 文件名扩展名本身（`.ts` → `EXT_TO_LANGS` → 'typescript'，`vscodeIcon.ts:375-380`），零 detect 依赖。机制注：树是默认唯一开启作用域、文件未打开时 detect 链不参与——「四作用域一致生效」由该零 detect 依赖直接推得，作用域开关显隐面归 ICON-02/03 既有锚，本行不逐作用域重复布点 |
| ICON-07/表外 | 同夹具追加 `languageIds { zig: 'z' }`；注入 `code.zig` | 读 `code.zig` 树行 | 表外 id 静默零渲染：`.vv-file-icon` 计数 0 且无 `_file` 回退时不渲染元素（反向表层 `vscodeIcon.ts:375-381` 落空后 `:383` 尾回退 null）、零位移（ICON-05 同锚）、无报错无 console error |
| ICON-08 | Mini 夹具变体：`iconDefinitions { dt: charDT, ts: charTS }` + `fileExtensions { 'd.ts': 'dt', ts: 'ts' }`；注入 `a.d.ts` 与 `b.ts` | 选主题应用 → 分别读两行字形 | `a.d.ts` 命中 **charDT**：多级扩展名全后缀尝试最长优先（`fileSuffixes('a.d.ts')` = ['d.ts','ts']，`:184-190`；先试 `.d.ts` 再 `.ts`）——专属字形非单级 `.ts` 字形；`b.ts` 对照命中 charTS（单级路径不回归） |
| ICON-09 | jszip Node 侧构造含 `contributes.iconThemes[].path` + 字体的小 vsix 夹具（`b-openvsx.spec.ts:35-52` iconVsix 同构） | 图标主题导入区 file input `setInputFiles([xxx.vsix])`（`AppearanceSection.svelte:550-552` accept 含 .vsix）→ 选新主题应用 → 读树字形与已导入列表 | 导入生效：`.vv-settings-note`「已导入 1 个图标主题」、select label 带「（vsix）」后缀（source 投影，OVX-01 `:171` 同锚）、树行字形在场；记录 `source='vsix'`（`session.ts:50`）——与 OVX-01 网络路产物同型（同一 `importIconVsixFile` 内核），区别仅在 vsix 由本机 file input 直供 |

## 3. 验收行为

- **ICON-06..08 匹配链**：三锚共同锁「VSCode 语义优先级」（spec §3.2 匹配链首位）在真实 DOM 渲染层生效，字形断言用 `toHaveText(码点字符)` 精确比对（Mini 夹具各定义码点互异，禁用「有无图标」的弱断言——弱断言区分不了命中层级）。**编号落法备案**：ICON-07 无本体行——正反两面（命中/表外静默）无共同断言面，按 README §3.2 条 3 后缀约定拆 `ICON-07/lang`、`ICON-07/表外` 双行落（与 SRC-05 本体+双变体的落法不同源，特此注记）；编号段口径 ICON-01~09 不变。回归护栏：ICON-05 零位移锚（夹具均无 `_file` 时未命中行零元素）与 ICON-01 seti 面零翻转。
- **ICON-07/表外静默**：断言面为「零渲染 + 零报错」（无 console error、无错误卡），对齐 spec §3.4「表外 id 无匹配（静默，不报错）」。
- **ICON-09**：与 OVX-01 的分界 = vsix 来源通道（file input vs Open VSX 下载），导入内核/校验链/入库记录同一（spec §6.2「复用既有导入管线内核」）——本锚只断通道入口与产物等价性，不重复 OVX-01 的预检/下载断言。
- **回归护栏**：ICON-04 附损坏字体回退（`b-icon-themes.spec.ts:375`）与 OVX-02 预检快错为负路径既有基准，匹配链改动后定向复跑。

## 4. 环境与数据

- **通道与装置**：default 套件双 project；settings-center 装置（`openSettings`/`gotoGroup('外观')`/`applySettings`，`e2e/settings-center.ts` 草稿统一落盘）；目录注入 openDir + 树行精确名定位（`b-icon-themes.spec.ts:67-97` 同构）；Mini 夹具基座见 `b-icon-themes.spec.ts:36-58`（`fontCharacter` 用 CSS 转义形 `\xe6··`，JSON.parse 后落单字符；无 `_file` 键使未命中回退链落空）。
- **字体字节**：夹具 woff 复用 vendor `packages/vviewer-highlight/assets/vscode-icons/seti/seti.woff`（ICON-04/ OVX-01 同源先例）；ICON-09 vsix 夹具的字体项同源打包。
- **前置**：`node tools/fetch-e2e-corpus.mjs`（幂等）+ `pnpm --filter web build:e2e`（H11 铁律：产品代码改动后必须重建）。
- **移动端形态**：树行断言前 `openDrawerIfNarrow` 适配（ICON-04 展开流程先例）；设置面板断言与视口无关（居中面板双 project 同参）。
- **真网项**：本域新增锚全离线（mock/file input，零网络依赖）；OVX-05 真网冒烟既有 skipIf offline 口径不变（`b-openvsx.spec.ts:319-322`，`ovxReachable` 5s 探测）。
