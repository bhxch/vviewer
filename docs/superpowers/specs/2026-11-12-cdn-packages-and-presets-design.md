# CDN 体系：grammar 拆包修复 + CDN 档位设置 + 预设网络字体 — 设计

日期：2026-11-12　状态：待用户审阅

## 1. 背景与动机

### 1.1 现网 bug（实测，2026-11-12）

jsdelivr 对 `@bhxch/vviewer-grammars-full@0.1.0` 返回 403，错误体 `Package size exceeded the configured limit of 150 MB`——全量包解包 228MB 超过 jsdelivr **按包**准入上限，该包下**任何单文件**（4.5MB 的 python.wasm、58KB 的 manifest.json）都整包 403；fastly/gcore/testingcf 镜像同源同 403。客户端「按语言只拉对应 wasm」的按需设计与服务端按包准入门正交，无法绕过。

后果：grammar 三层解析链（同源 lite → 服务端 → CDN 全量）的 CDN 层对**所有用户**失效，非 lite 34 语言全部静默走 hljs 兜底——直接构成用户报的「代码渲染器用 hljs 不用 tree-sitter」的主因。unpkg 实测可完整伺服该包（200 + `Access-Control-Allow-Origin: *`）；npmmirror files 通道有白名单门禁（本包 403，需向 cnpm/unpkg-white-list 申请）。

### 1.2 用户诉求

- 包依赖 CDN 可切换国内源；默认全球 CDN，另加中国优化档，可考虑多组 CDN。
- 字体：预设开源网络字体，国内外 CDN 兼顾，一键添加，不用自己找资源。

**拍板（2026-11-12）**：拆包+档位设置（全球默认 jsdelivr 拆包子包 / unpkg / 中国档 npmmirror（白名单落地后生效）/ 自定义 URL）+ 字体预设。

## 2. 现状锚点

- **grammar CDN 链**：构建期 `VV_GRAMMAR_CDN` env → vite define（apps/web/vite.config.ts:819-821）→ `grammarLayers.ts` 三层（同源 `static/grammars/` → 服务端 `<origin>/grammars/` → CDN）manifest 逐层 fetch、first-wins 合并、**每条目带层 base**（grammarLayers.ts:29-38/:71-91）；消费点 highlightClient.ts:256-299（create），worker 按 entry.base 加载 wasm。standalone 包缺省值 `packages/vviewer-markdown/src/highlightDefault.ts:20`（jsdelivr 全量包 URL）。
- **发布链**：release.yml publish-npm（:258-330）pack-npm.mjs 打包（grammars/manifest.json 与 wasm 同目录布局契约；contentHash=sha256 前 16 hex 剔 generatedAt）；发布后拼 `VV_GRAMMAR_CDN=https://cdn.jsdelivr.net/npm/@scope/vviewer-grammars-full@<ver>/grammars/` 注入 web job（release.yml:72-78）与 pages-deploy.yml:93-98。pages 无 npm 关联时 warn 缺席。
- **SW 缓存**：grammars wasm `/\/grammars\/.*\.wasm$/` CacheFirst（vite.config.ts:662-670）、查询 `/\/queries\//`（:702-708）、foreign 资产 `^https://cdn\.jsdelivr\.net/npm/@file-viewer/assets-`（:750-765）+ env 镜像域构造 RegExp（:51-66/:773）、vv-cdn-engines 通配 `^https://cdn\.jsdelivr\.net/npm/.*`（:795-801）。跨版本清理 genSwCleanup 族清单（:121-171）。
- **其他 CDN 依赖**（小包，jsdelivr 正常但国内可达性差）：图表引擎 8 包 cdnEngines.ts（`CDN='https://cdn.jsdelivr.net/npm'` :5，运行时 import 拼接 :8）；foreign 资产 foreignAssets.ts:17（FOREIGN_ASSETS_CDN_DEFAULT，10 包清单 :32-43，三层链 :72-89）；open-vsx.org（用户显式触发，不缓存）。
- **字体系统**：fontsStore.ts（IndexedDB v3 fonts store；URL 添加仅 https、30MB 上限、FETCH_TIMEOUT_MS 硬超时；先装载验证后入库；启停=FontFace add/delete；负缓存不固化）；UI 仅手动 URL/上传（FontsSection.svelte:350-396）；`UI_FONT_PRESETS/CODE_FONT_PRESETS`（fonts.ts:34-57）只是**本机 family 名**清单，非网络源。**无网络字体预设/一键添加机制**。预设字体的「css 切片型」中文字体（@fontsource 中文、lxgw-wenkai-webfont 等）是多文件切片 + css 引用，与现单文件 FontFace 模型不兼容——需新装载通道。

## 3. 设计

### 3.1 grammar 拆包（恢复默认全球档）

- pack-npm.mjs 增拆分模式：按语言体积均衡装箱切 N 个子包，**每包解包体积门禁 50MB**（用户 2026-11-14 拍板——jsdelivr 150MB 之外，镜像站可能限制更低，50MB 留 3 倍余量；N=装箱结果，全量 228MB 下预计 5-6 包），包名 `@scope/vviewer-grammars-full-p1..pN`；每包自带 `grammars/manifest.json`（仅本包语言条目）+ 本包 wasm + 本包 queries（queries 按 `<lang>/` 目录跟随语言所在子包）。
- **worker 端 queries 路径核实点**（builder 必查）：现 worker 按 entry.base 拼 wasm 与 queries 路径的具体拼法（highlight worker doPrepare / queries fetch 面），确认每包 base 下 queries/<lang>/ 可达即兼容；若 queries 有全局共享路径假设，改为按语言条目 base 解析。
- release.yml publish-npm：发 N 包（逐包 contentHash 门 + OIDC provenance 同款）；outputs 下发**已解析版本**（N 包同 tag 同版本号，版本对齐简单化——单包 SKIP 语义改为「全包集 hash 比对」，裁量：取全部子包 hash 聚合单门）。
- 注入默认档变多基：`VV_GRAMMAR_CDN` 值改为**多基分号/管道分隔**（`https://cdn.jsdelivr.net/npm/@scope/vviewer-grammars-full-p1@v/grammars/|…p2@v/…|…pN@v/grammars/`），grammarLayers 直接消费多基（多层合并现成，逐层独立 manifest fetch 失败跳层 warn 语义不变）。
- 旧单包 `vviewer-grammars-full` 保留发布（存量 0.1.0 用户/standalone 包兼容），highlightDefault.ts 缺省 URL 改为子包多基。
- 兼容性红线：`manifest.json 与 *.wasm 同目录`布局契约、`/grammars/` 结尾 env 约定、contentHash 归一化规则不破坏；b-grammar-layers 分层用例与 CDN-01 真网锚随新包更新。

### 3.2 CDN 档位设置（运行时切换）

- 作用面与档位值集（**落定，builder check：engines 的 jsdelivr `+esm` 转换端点与 unpkg/npmmirror 不兼容**——bpmn/wavedrom 等是 CJS 包依赖 jsdelivr 转换，且 foreign 10 包是第三方 @file-viewer 包白名单不可控）：
  - `grammars`：四档 `default|unpkg|cn|custom` + 自定义输入（cn=npmmirror files 通道，**本仓子包白名单申请中**）；
  - `engines`（图表 CDN 引擎）：两档 `default|custom`（不提供 unpkg/cn 预设——`+esm` 转换端点无兼容替代，除非 builder 实测 esm.sh 可行后另行增强）；
  - `foreign`（资产 10 包）：两档 `default|custom`。
- 新设置节（裁量归组：**新组「网络资源」或并入既有存储与数据组**）：`settings.cdn: { grammars, grammarsCustom, engines, enginesCustom, foreign, foreignCustom }`。
- **运行时消费改造**：现三处均为构建期 define/env——改为运行时：
  - grammar：highlightClient create() 的 cdnBase 从 settings 读（构建 env 仅作 `default` 档的缺省注入），变更后**无条件重建** HighlightClient（档位变更语义：manifest 是 create() 快照，不重建不生效；与 spec⑤ 的 failed-态门控重建是两个独立入口，共享 destroy/create 单例原语，无先后依赖——builder check 顺序耦合问题以此消解）；
  - 图表引擎：cdnEngines.ts 的 host 常量改参数化（diagramOptions 注入缝现成 setDiagramOptions）；
  - foreign：foreignAssets 三层链 CDN 层 base 参数化。
- **SW 缓存一致性**（关键接缝）：runtimeCaching 是构建期静态规则，运行时换 host 后新域请求不命中既有 CacheFirst 规则。方案（裁量）：复用 env 镜像域机制（:51-66）在构建期注入各档位已知 host 正则（jsdelivr/unpkg/npmmirror 三族全量注册，量小），自定义域走 **SW message 通道动态注册**（或最简：档位变更提示刷新页面使 SW 重注册——推荐起步，message 通道列为增强项）。
- 档位预设值（**落定：三档统一指向新子包多基**，形态同构）：
  - `default`：构建期注入（release/pages 拼 jsdelivr 子包 URL，已知精确版本）；
  - `unpkg`：`https://unpkg.com/@scope/vviewer-grammars-full-p1/grammars/|…p2/…|…pN/grammars/`（不带版本=unpkg 缺省 latest 重定向）——**版本解析固化策略**：启用档位时经 unpkg meta API 解析一次精确版本并显示/固化（可手动重解析），避免重定向不确定性与缓存键漂移；builder 实测重定向链 CORS 后可改直用缺省重定向；
  - `cn`：`https://registry.npmmirror.com/@scope/.../files/grammars/`（同固化策略；**标注：包白名单申请中，落地前不可用**；npmmirror 布局契约核实点：files 通道路径即包内路径，manifest 同目录契约成立——builder 用任一白名单包实测确认）；
  - `custom`：用户填完整多基（以 `/grammars/` 结尾校验）。
- 设置中心 UI：三作用面各一行档位选择 + 自定义输入框；i18n 双目录。
- 反目标：不做 CDN 健康探测自动选路；不为 kroki/plantuml/open-vsx 提供档位。

### 3.3 预设网络字体（一键添加）

- FontsSection 新增「预设字体」区块：清单条目 `{ family, displayName, kind: 'single'|'css', sources: [{label, url}] }`；一键添加复用 fontsStore 添加尾段（重名/30MB/https 门禁）。
- **两种装载通道**：
  - `single`：现 FontFace 单文件模型直用（英文等宽/ UI 字体：JetBrains Mono、Fira Code、Inter 等 @fontsource-* 的 woff2 直链，jsdelivr/unpkg 可拉）；
  - `css`（中文切片字体必需）：注入 `<link>`/`@import` css（css 内部按相对路径拉切片），记录为 css 型条目，启停=style 节点插拔，删除=移除节点；fontsStore 记录模型扩 kind 字段（IndexedDB v3 内记录字段扩展，无 schema 升版，裁量确认无需升版）。
- 建议预置清单（裁量增删；每条多源，源标签 jsdelivr / unpkg / 中文源）：
  - 中文：霞鹜文楷 LXGW WenKai（lxgw-wenkai-webfont npm 包切片 css）、Noto Sans SC、Noto Serif SC（@fontsource 或 cn-fontsource-* 包 css）；
  - 西文等宽：JetBrains Mono、Fira Code、Iosevka；西文 UI：Inter。
- 中文源候选（国内可达性优先）：npmmirror（白名单后）、中文网字计划 chinese-fonts-cdn、ZeoSeven fontsapi——具体 URL 由 builder 实测可达后定，spec 只约束「每条多源 + 来源标签可见 + 添加失败按现负缓存/重试交互走」。
- 反目标：不做 queryLocalFonts 系统字体枚举（2026-10-19 拍板维持）；不做字体子集化。

## 4. 目标 / 非目标

- 目标：默认全球档恢复可用；国内可达档位与自定义兜底；三作用面可切；中文网络字体一键可达。
- 非目标：CDN 自动探测选路、grammars 按版本范围浮动（版本钉死纪律维持——升级=代码与 CDN 同步显式 commit，foreignAssets.ts:15-16 先例）。
- 附带跟进项（独立小任务，不入本 spec 实施面）：向 cnpm/unpkg-white-list 提 PR 申请本仓包白名单。

## 5. 验收锚点

- e2e：①b-grammar-layers 多基合并（两子包 manifest 合并、某层失败跳层）；②档位切换 → grammar CDN 层 URL 断言（custom 档输入校验）；③CDN-01 真网锚更新至子包 URL；④SW 缓存锚（SWR-ROUTE 系）随多域规则更新；⑤字体预设一键添加（single+css 两型）、启停/删除回落。
- 门禁：pack-npm 单测拆分模式（**包体积断言 <50MB**、manifest 键集与 wasm 文件一致）；release.yml dry 逻辑单测（若有）。
- 本机实测门（前置）：unpkg/npmmirror 各拉一个子包 manifest+wasm 成功（CORS 头核对）。

## 6. 留给 builder 的裁量

- 子包切分算法（按语言字母段 vs 体积均衡装箱）；outputs 版本聚合口径；SW 自定义域通道（message 动态注册 vs 提示刷新）；档位节归属组；css 型字体的记录结构与撤销路径；预置清单最终条目与来源 URL 实测选定。

## 7. builder check 订正与落定（2026-11-13）

- **包名定稿**（消除与 Trusted Publisher 前置的顺序矛盾）：`@bhxch/vviewer-grammars-full-p1..pN`（**50MB 门禁装箱，预计 5-6 包**，N 与语言分组随 pack-npm 实现落定，Trusted Publisher 配置随首发包数对齐）。**仓外前置（用户操作，首发硬门）**：npm 包页逐包配置 Trusted Publisher（owner=bhxch/repo=vviewer/workflow=release.yml，勾选 npm publish）——OIDC 首发 absence 即 E403/E404，v0.1.0 首发 same pattern。
- **css 型字体不做离线**（落定）：切片走普通网络请求不入库不进 SW 缓存，断网时该字体回退缺省；single 型维持现有入库离线语义。UI 上 css 型条目标注「在线字体」。
- **engines/foreign 档位收窄、cn 档仅 grammars**：见 §3.2 落定注记（白名单申请范围仅本仓子包）。
