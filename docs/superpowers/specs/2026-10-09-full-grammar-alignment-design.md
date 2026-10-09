# 设计：tree-sitter 语法生态全量对齐 Markpad（301 语言）

- 日期：2026-10-09
- 状态：已评审（brainstorming 四节逐节确认）
- 关联：`2026-10-06-vviewer-design.md`（M2/M6 grammar 资产策略与 compute 服务）、`2026-10-08-e2e-fixes.md`（BUG-06c 路由契约）

## 1. 背景与目标

vviewer 现状：客户端 wasm 内嵌 lite 集 34 语言，服务端 compute 仅 14 语言（无 injection）；全量集（build-list 292 条）只在 CI 构建、不随任何发行物交付。参考系 Markpad（Tauri 桌面应用）2026-10-07 完成 helix master 大同步后为 **301 语言、injections/locals 已接线、逐文件查询降级**，并有编译 301 grammar 进 Rust 二进制的成熟工程路径（build.rs + cc + FFI 生成 + sanitize）。

本设计将 vviewer 语法生态全量对齐 Markpad 的 301 种，并配套调整资产分发、路由语义与大文件渲染模型。

### 已拍板的决策（brainstorm 记录）

| 决策点 | 结论 |
| --- | --- |
| 前端全量口径 | npm 单包发布全量资产，pages 经 CDN（jsdelivr，精确版本钉死）按需拉取；自托管 dist 保持 lite |
| 服务端产物形态 | 301 grammar 编译进二进制（Markpad 同款），接受二进制 21MB → ~200-300MB |
| auto 大文件语义 | 服务端 serve 的文件在 auto 下不限大小走服务端解析；前端添加的文件/文件夹维持 >2MB 永不远程 |
| 大文件切块范围 | 本地 + 服务端统一可视区懒高亮 |
| 推进结构 | 单 spec 四阶段（1 语法生态 → 2 资产链 → 3 路由语义 → 4 统一懒高亮），逐阶段独立提交与验证 |
| npm 打包粒度 | 单包全量（版本对齐零风险、发布原子）；"发一包 ≠ 下一包"，按需粒度由文件级 fetch + SW 缓存天然提供 |
| 服务端能力探知 | 保留既有 `/api/health` 宣告机制（`capabilities:["compute"]` + `computeLanguages`）；仅文件服务的服务器在 auto 下全走前端解析，行为不变 |

### 非目标

- 不动 markdown compute 的围栏留本地语义（BUG-22）。
- 不做服务端流式/WebSocket 推送；保持请求-响应模型。
- 不引入 `includedRanges` 上下文解析（chunk 为独立子文本 parse；接口留升级位，见 §5.1）。
- 不新增计算策略枚举值（仍 `auto | local | remote`）。
- 不发 lite npm 包、不做每语言包（演进备注：若出现"第三方只想依赖单语言"的真实需求再拆）。
- 保留 hljs 回退链（整文件 / 行级 / 纯文本）作为 tree-sitter 失败时的最终兜底，tree-sitter 永远不是单点；回退触发阈值的调整本身在范围内（见 §5.2）。

## 2. 阶段 1：语法生态对齐（共享地基）

### 2.1 语法源同步

- `tools/grammar-builder/languages.toml` 刷新到 Markpad 2026-10-07 同步点的 helix `languages.toml`（303 个 `[[grammar]]` 带 pin rev）；`build-list.json` 从 292 条补齐对齐。**验收集合 = Markpad `src-tauri/src/highlight/registry.rs` 的 301 名单**。
- 下载管线吸收 Markpad `3b5173f` 的教训：rev 可达性校验（浅克隆 `cat-file -e rev^{commit}`，不可达回退 `--filter=blob:none` 全量克隆）；整仓拷贝保留共享资源（如 `../../common/scanner.h`）。
- queries 资产同步刷新：`packages/highlight/assets/queries` 286 目录 / 752 scm → ~301 语言目录 + 继承父目录（`_javascript` 等）/ ~950 scm。vviewer 的 queries vendored 入库，**同步即 pin**——比 Markpad（helix master 未 pin）更强的版本纪律，保持。
- 已知约束（写入 manifest 与文档）：wasm 侧受 cli wasm 工具链限制（`get_scanner_path` 只认 `scanner.c`），带 C++ 外置 scanner 的语言（已知 yaml/vue，plan 阶段全量排查）在 wasm 集继续 vendored（`tools/grammar-builder/fixtures/`）或剔除；**Rust 服务端无此限制（cc 可编 scanner.cc），恰为 301**。两侧集合差如实记录。

### 2.2 服务端全量编译（Markpad 模式移植）

- `server/build.rs`：静态表 `(name, dir, subpath, c_symbol)` 由脚本从 §2.1 同步源生成；cc 编译 `parser.c` + `scanner.c`；关键工程点：
  - C 侧固定 `-std=gnu11`（gcc16 默认 C23 会把 `bsearch` 宏化，与部分 grammar 自带同名 C 函数冲突）；
  - C++ scanner 手动 `g++ -std=gnu++17 -include cstdint -Os -fPIC -ffunction-sections` 编译，`ar rs` 合并回 cc 产物，链接 `stdc++`；
  - vue 内嵌 html scanner 未重命名符号 → 编译后 `objcopy --localize-symbol tree_sitter_html_external_scanner_*`；
  - FFI `extern "C"` 声明 + `get_language(name)` match 生成到 `OUT_DIR`，registry `include!` 引入。
- grammar 源树与 `tools/grammar-builder/out` 共享 fetch 缓存；CI `.github/actions/setup-grammars` 三层缓存扩展覆盖 server 构建。
- `server/src/compute/queries.rs`：`ENTRIES` 从硬编码 14 改为生成式 301；接线 injections/locals（`HighlightConfiguration::new(language, name, highlights, injections, locals)`）；移植 helix `; inherits:` 父查询合并与 Markpad `sanitize_query` 逐文件降级（highlights 编译失败才判语言失败，injections/locals 失败仅置空该文件并告警）。
- **退役现役 13 个 crates.io grammar crate**（tree-sitter-rust 等），统一源码编译，消除 crates.io 版本与 helix 源漂移；`tree-sitter 0.27` / `tree-sitter-highlight 0.27` 运行时不变。
- 编译为默认路径（无 feature 分叉），依赖源树缓存保持增量构建可用。
- `GET /api/health` 的 `computeLanguages` 自动变为 301（canonical 排序，~4KB，可接受）。
- 体积锚点：Markpad 裸二进制 279 MiB（含 Tauri）；vviewer server 预计 21.4MB → 200-300MB（已拍板接受）。
- 验收：301/301 查询兼容冒烟测试（对齐 Markpad `test_all_languages_query_compatibility`）全绿；现役 14 语言的区间输出抽样回归（golden 快照）；health 宣告 301。

## 3. 阶段 2：资产链（npm 单包 + CDN）

- **npm 包**：`@<scope>/vviewer-grammars-full`，内容 = wasm 全集（≤301，含 vendored）+ `manifest.json` + `queries/` 全目录；版本号与 vviewer release 一致；tarball 估 100-150MB（wasm gzip 压缩率 60-70%）。运营依赖：npm token 入 CI secret、scope 定名。
- **发布管线**：release.yml 新增 publish job，消费现有 grammar job 产物重排为 npm layout 后 `npm publish`；精确版本 URL 经 jsdelivr 永久不可变。
- **客户端资产源解析链**（`highlightClient.create()` 重构）：按序 fetch 三层 manifest——同源 `${base}grammars/manifest.json` → 已连接服务端 origin（跨源；与 compute 能力解耦，逐层探测 manifest 存在性）→ CDN 前缀（构建期 env 烙入，pages 部署默认启用）——合并为一张 GrammarTable，**每个 entry 自带 wasm/queries 实际基址**；worker 端 `Language.load` 与 `remoteQueryLoader` 按 entry 基址取件。语言粒度谁有谁兜底。
- **SW 缓存**：现有 runtimeCaching 正则按 pathname 匹配，CDN 路径（`/npm/<pkg>@<ver>/grammars/*.wasm`）天然命中；`maxEntries` 300 → 500；跨源 fetch 用默认 cors 模式（jsdelivr 返回 `Access-Control-Allow-Origin: *` 与 `application/wasm`，非 opaque 响应可正常 CacheFirst）；主线程 warm 预灌机制扩展到 CDN/服务端基址。约束核对：最大单 wasm 5.8MB < jsdelivr 20MB/文件上限。
- **验收**：pages 部署打开 lite 集外文件（如 `.kt`）→ CDN 拉取 wasm 高亮成功；二次访问走 SW 缓存；CDN 不可达 → 该语言 hljs 兜底 + console.warn，页面零阻塞；仅文件服务的服务器 + CDN → 前端全量本地解析。

## 4. 阶段 3：路由语义

- **`decideComputeRoute` 修订**（`packages/core/src/compute/router.ts`）：auto 判定 = `hasCompute && remoteFn && hasServerPath` 即远程，**不再看文件大小**；失败回退本地语义不变。`INJECTION_LANGS` 豁免整体删除（前提：阶段 1 服务端已接线 injections，rust/c/cpp/go/html/javascript 不再被迫留本地）。`remoteLanguageAdvertised` 门保留（集合随宣告放宽到 301；空集 = 未知保持先试远程）；显式 `remote` / `local` 语义不变。
- **大文件硬护栏改造**（`apps/web/src/lib/highlightRouter.ts:22`）：`policy !== 'remote' → null` 改为 `policy === 'remote' || (policy === 'auto' && computeSrc?.path 存在)` 才走远程。判据说明：`computeSrc` 仅对 remote store 文件产生（`getRemoteBase(storeId) !== undefined`，`code.ts:813-814`），天然区分两类来源。本阶段远程仍为整文件解析：>20MB 服务端 413（`HIGHLIGHT_MAX_BYTES`）→ auto 回退本地降级链；阶段 4 解除。
- **markdown compute 不动**；策略枚举、settings 存储、TopBar UI 均无新值。
- **e2e 断言改写**：CMP-02「auto 3MB 零 POST」拆双护栏——server-served 3MB auto 必须 POST、本地添加 3MB auto 仍零 POST；CMP-04 的 400 场景语言从 php（301 集内）换为集外语言名；受影响面：`computeRouter.test.ts`、`highlightRouter.test.ts`、`m6.spec.ts`、`b-compute-global-search-server.spec.ts`、`b-code-highlight-degrade.spec.ts`。
- **验收**：路由矩阵单测全绿；e2e 双护栏通过；仅文件服务服务器下 auto 全本地行为与改造前一致（回归）。

## 5. 阶段 4：统一懒高亮（本地 + 服务端）

### 5.1 协议

- `POST /api/compute/highlight` 请求体扩展 `range?: {startLine: number, lineCount: number}`；响应追加 `baseLine`，`intervals` 为相对 chunk 首行的 UTF-16 区间（复用 `Utf16Index` 基建与 CRLF 归一）；**不传 range 时行为与现状完全一致**（`baseLine: 0`，intervals 相对全文）。本地 worker 同构参数：`highlight(text, lang, {startLine, lineCount})`。
- **实现裁决：本地与服务端都按"子文本直接 parse + baseLine 偏移"，不引入 `includedRanges`**。理由：`includedRanges` 适用于"在完整文档里只解析片段"（需全局结构上下文）；渲染驱动的 chunk 是独立窗口，直接 parse 子文本实现更简单、与 hljs 分块行为同构、边界误差同源。若未来出现跨 chunk 语法上下文需求（如超长多行字符串），升级到 includedRanges 方案，接口不变。
- chunk 取可视区 ± overscan，**重叠 2 行**；渲染按行去重取首次结果。多行注释/字符串被 chunk 边界截断的降级为已知限制（与 hljs-block 现状同级，HL-03 断言口径沿用）。

### 5.2 渲染层与服务端配套

- `code.ts`：三条路径统一进 `chunkCache`（首行号 → 行 HTML + 文件 stamp），`BLOCK_CACHE_MAX_ROWS = 5000` 逐出沿用，`virtualScroller.onRange` 驱动（顺带修复 hljs-block 现存"窗口重叠反复重算" quirk：已缓存行命中即跳过、连续未缓存区段合并计算）；hljs 分块退役为 tree-sitter chunk 失败时的行级回退。
- 阈值语义：≤2MB 整文件一次算（保首屏）；>2MB 一律懒高亮通道；**>20MB 不再落入纯文本**（虚拟滚动 + 懒高亮兜底，hex 50 万行虚拟化已验证此路），纯文本上限参数化、默认放宽到 200MB（与 grep 预算对齐，实测回调）。
- 服务端：path 模式按 range 读行区间（首版顺序扫行定位，seek 优化后置）；LRU 缓存键扩展为 `(canonical_path, mtime_ms, size, lang, startLine, lineCount)`；10s 超时与预算机制沿用（chunk 级绰绰有余）；`text` 模式无 range 语义不变。

### 5.3 错误处理汇总

- chunk 级失败（超时 / 413 / 504 / 网络）→ 该 chunk 行级 hljs 兜底，不炸整文件；显式 remote 失败仍如实错误卡片（语义不变）。
- 切 tab / 滚离取消：沿用 `remoteAbort` 与 HL-09 语义，chunk 请求粒度更细、取消更及时。
- CDN 不可达 → 该语言 hljs 兜底 + console.warn；SW 缓存写入失败 → 直连重试；服务端无 compute 宣告 → auto 全本地（既有探测）。

### 5.4 测试与性能锚点

- 单测：路由矩阵加"来源 × 大小 × 策略"维度；manifest 三层合并链；chunk 协议编解码（`computeRemote.test.ts`）；chunkCache 逐出与 quirk 修复。
- 集成（`server/tests/compute_highlight.rs`）：range 边界——首行 / 尾行 / 越界 / lineCount=0 / CRLF / 多字节字符跨界 / 同文件并发不同 range 的 LRU 命中。
- e2e：§4 断言改写 + 新增 pages+CDN 用例（playwright `page.route` mock CDN 源，不依赖外网）；HL-09 取消、HL-11 响应性、BUG-20 改写（>20MB 文件现为懒高亮而非纯文本提示条）。
- 性能锚点：>20MB 文件首屏百毫秒级、滚动零长任务（对标 hex 虚拟化：桌面中位 38ms 量级）。

## 6. 风险与已知限制

1. **wasm 集可能 <301**：C++ 外置 scanner 语言受 cli 工具链限制（§2.1）；plan 阶段全量排查产出确切名单。
2. **服务端二进制 200-300MB**：单文件分发变重（已拍板）；release 上传体积与用户下载耗时上升。
3. **CI 时长**：grammar.yml 全量 292 仓 fetch 的首跑时长本就是遗留观察项；server 侧再编 301 个 .c 会加重——靠 setup-grammars 三层缓存与共享源树缓解，PR 实测。
4. **npm 运营依赖**：token / scope / 包体积限额；发布失败不阻塞 release 其余产物（publish job 允许重跑）。
5. **chunk 边界高亮降级**：多行结构跨 chunk 截断（§5.1），与 hljs-block 现状同级，记录为已知限制。
6. **版本对齐生命线**：app ↔ wasm ↔ queries 必须同版；机制 = npm 精确版本钉死 + 构建期烙 CDN 前缀 + SW `BUILD_REVISION` 缓存隔离。

## 7. 交付顺序与验收总表

| 阶段 | 交付物 | 独立验收 |
| --- | --- | --- |
| 1 | 语法源同步 + 服务端 301 编译 + injections/locals 接线 | 301 兼容测试全绿；health 宣告 301；14 语言回归 |
| 2 | npm 单包 + 发布管线 + 三层资产解析链 + SW 适配 | pages + CDN 全量高亮可用；离线/降级路径符合 §3 验收 |
| 3 | auto 路由语义修订 + 硬护栏按来源区分 + e2e 改写 | 路由矩阵与双护栏 e2e 全绿；无 compute 服务器回归不变 |
| 4 | range 协议（本地+服务端）+ chunkCache 重构 + 阈值放宽 | §5.4 测试全绿；>20MB 性能锚点达标 |
