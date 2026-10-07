# M6 后端档 2：计算卸载与搜索 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 档 2 计算卸载：`--compute` 开启后高亮/Markdown/解包/搜索可选在后端执行（ComputeBackend 路由 + 偏好）；ripgrep 跨文件搜索（服务端流式）与纯前端内存 grep 双实现；全局搜索面板。

**Architecture:** server 侧新增 `compute` 模块（`POST /api/compute/{highlight,markdown}`、`GET→POST /api/search`、`POST /api/compute/archive/*`），能力经 health `capabilities` 追加 `"compute"`；前端 `packages/core` 新增 `compute/`（Backend 接口 + Local/Remote 实现 + 路由器 computePolicy）；ripgrep 以子进程 `rg --json` 流式（PATH 探测，缺失降级明确错误）。

**Tech Stack:** comrak（GFM 全扩展）、tree-sitter-highlight 0.25 + 核心 grammar crates（rust/typescript 含 tsx?——tree-sitter-typescript crate 提供 tsx；python/bash/json/go/c/cpp/json/yaml/html/css——**以 crates.io 实际可得为准选 8-12 个**）、ripgrep 15.2（本机 /usr/sbin/rg）、zip/tar crate（服务端解包）、flate2。

**Spec:** `docs/superpowers/specs/2026-10-06-vviewer-design.md`（5.8 计算卸载 / 5.9 跨文件搜索 / 5.10 档 2 API / 2.3 避坑——服务端高亮必须实现 injection 回调、async+取消+超时+大小上限）

## Global Constraints

- 沿用全局约束。服务端高亮中间表示与前端完全一致：`{intervals: [{start,end,capture}], captures}`（区间 UTF-16 偏移——**Rust 字节偏移到 UTF-16 偏移的转换必须做**（comrak/tree-sitter 输出字节偏移），转换函数 + 单测（CJK 文本）。
- 服务端高亮缓存 `(path, mtime, size)` → intervals；单请求超时 10s；输入大小上限 20MB；全部 async（tokio::spawn_blocking 包 tree-sitter 同步解析）。
- ripgrep 不在 PATH：`/api/search` 返回 501 + `{error:"ripgrep not available"}`；前端降级纯前端 grep。
- computePolicy 设置：`auto | local | remote`（默认 auto），存 settings；UI 状态栏已有引擎指示器——追加执行位置指示（local/remote）。
- M6 验收：cargo test（highlight 区间与前端快照一致性抽样/markdown/search 参数）+ E2E（--compute 模式：大文件高亮走 remote（状态栏显示 remote）、全局搜索 Ctrl+Shift+F 命中跨文件、comrak 渲染 wikilink 样例）连续 2 次全绿。

---

### Task 1: 前端 ComputeBackend 抽象与路由

**Files:** Create `packages/core/src/compute/{types.ts,router.ts}`; Modify `packages/core/src/index.ts`、`apps/web/src/lib/viewer.ts`（highlight 路由接入）、`stores/settings.ts`（computePolicy）、状态栏指示; Test `packages/core/test/computeRouter.test.ts`
**Interfaces:**
- `types.ts`: `interface HighlightBackend { highlight(src: {path?: string; text?: string}, lang: string): Promise<{ok: true; intervals: HighlightInterval[]} | {ok: false; error: string}> }`（HighlightInterval 从 highlight 包类型重导出或 core 定义同构类型）；`MarkdownBackend { render(text): Promise<string> }`；`ArchiveBackend { list/read }`（M6 简化为高亮+markdown+search 三类，解包卸载列 P2——**裁决：服务端解包移 P2**（前端 jszip/libarchive 已可用，服务端解包收益低），spec 5.8 的 ArchiveBackend/DetectBackend/InspectBackend 接口定义保留但不实现 remote，报告中声明裁剪）。
- `router.ts`: `createComputeRouter(opts: { capabilities: Set<string>; policy: () => ComputePolicy; remoteBase?: () => string | null; token?: () => string | null })` → `{ highlight, markdown, search }`——每个方法按 policy+capabilities 返回 Local/Remote 执行结果并打标 `{where: 'local'|'remote', ...}`。
- viewer/highlightClient 接入：highlight 调用前问 router（policy remote 且能力有时走 `POST /api/compute/highlight`）。
**Steps:** 失败测试（policy 三态路由矩阵、无能力回退 local、remote 失败回退 local——auto 语义）→ 实现 → 绿 → Commit `feat(core): ComputeBackend 抽象与路由（policy/能力/回退）`

### Task 2: server --compute + /api/compute/markdown（comrak）

**Files:** Modify `server/src/{main.rs,state.rs,routes/mod.rs}`、Create `server/src/routes/compute.rs`、`server/src/compute/markdown.rs`; Test `server/tests/compute_markdown.rs`
**Interfaces:** `--compute` flag → capabilities 追加 "compute"；`POST /api/compute/markdown` body `{text: string, options?: {wikilinks?: boolean}}`（≤5MB 上限）→ `{html}`——comrak（GFM 全扩展：table/strikethrough/tasklist/autolink/footnotes/description_list/heading_ids；`render.unsafe_=true`——**输出必经前端 sanitize（既有管线）**；数学掩码不实现（P2，报告记录）；wikilinks 选项渲染 `<a class="vv-wikilink" data-target="...">`）；Bearer 保护同组。
**Steps:** cargo 测试（GFM 表格/任务列表/footnote/上限 413/无 --compute 时 404）→ 实现 → 绿 → Commit `feat(server): compute 开关与 comrak markdown 渲染`

### Task 3: /api/compute/highlight（tree-sitter 核心 grammar 子集）

**Files:** Create `server/src/compute/highlight.rs`、`server/src/compute/queries.rs`; Modify `Cargo.toml`；Test `server/tests/compute_highlight.rs`
**Interfaces:**
- 依赖：tree-sitter-highlight 0.25 + `tree-sitter-{rust,python,bash,json,go,c,cpp,html,css,javascript,typescript,yaml,toml}` 中 crates.io 实际可装的（typescript crate 含 tsx；html/css 可能无官方 crate——实测装 8-12 个，报告清单）。
- 查询：include_str! packages/highlight/assets/queries/{lang}/highlights.scm + **inherits 展开的 Rust 版**（参考 markpad `highlight/mod.rs:134-219` 算法：头部 `; inherits:` 递归拼接父在前；assets 里父目录已 vendored）；Lazy 静态表 lang→(language_fn, query)。
- `POST /api/compute/highlight` body `{path?: string, text?: string, lang: string}`：path 模式读 root 下文件（走 guard）+ 缓存 `(path,mtime,size)` HashMap<Mutex>；text 模式直解析（≤20MB 否则 413）。响应 `{intervals: [[start,end,captureIdx]...], captures: [name...]}`（紧凑编码——区间数组 JSON 体积优化：capture 去重为索引表）。
- **字节→UTF-16 偏移转换**：tree-sitter 节点偏移是字节；转换函数（按行预计算字节→UTF-16 增量表，二分查找）+ CJK/emoji 单测。
- injection：**M6 服务端 v1 不做 injection**（helix Rust 栈的 injection callback 工程量大；裁决：`--compute` 高亮声明为"无注入的主语法高亮"，markdown 围栏等注入场景前端本地兜底——ComputeBackend 路由规则：需要 injection 的语言（有 injections.scm）在 auto 策略下走 local。报告明确声明该裁剪与 spec 5.2 的差距（前端 wasm 路线有 injection）。
**Steps:** cargo 测试（rust 源码样例：区间非空+capture 含 keyword 类；缓存命中（mtime 不变第二次走缓存——观察计数）；UTF-16 转换 CJK 用例；无查询语言 400）→ 实现 → 绿 → Commit `feat(server): tree-sitter 服务端高亮（核心 grammar 子集+缓存+UTF-16 偏移）`

### Task 4: /api/search（ripgrep 流式）+ 前端全局搜索

**Files:** Create `server/src/routes/search.rs`; Create `packages/core/src/compute/search.ts`（remote+local grep 实现）；Create `apps/web/src/lib/GlobalSearchPanel.svelte`; Modify AppShell（Ctrl+Shift+F + 面板挂载 + 结果跳转）；Test `server/tests/search.rs`、`packages/core/test/grep.test.ts`
**Interfaces:**
- server：`POST /api/search` body `{pattern, glob?, caseSensitive?, regex?, path?}` → NDJSON 流式（每行一个结果 `{"file","line","col","text"}` 结束帧 `{"done":true,"truncated":bool}`）；实现：spawn `rg --json`（PATH 探测，缺失 501）→ 解析 match 事件转 NDJSON；取消：fetch abort → kill 子进程；参数映射（--glob/--ignore-case/--regexp vs 固定串 -F）；上限：结果 1000 条截断。
- 前端 local grep（纯前端内存 grep，spec Q15）：`grepStore(store: TreeStore, query, opts, onProgress): Promise<{matches, truncated}>`——listChildren 递归（限深 5）文本类文件（ext 白名单或 <2MB）逐个 read 扫描；上限 2000 文件/200MB 累计（超出 truncated+提示）。
- GlobalSearchPanel：Ctrl+Shift+F 打开；输入 → policy 路由（remote 有能力→server；否则 local grep）→ 结果按文件分组列表 → 点击跳转（addTab + gotoMatch 式滚动）。
**Steps:** 测试（server：临时目录 + 真 rg 子进程断言 NDJSON 流/取消/501；local grep：内存 TreeStore 桩断言上限/递归/文本过滤）→ 实现 → 绿 → Commit `feat(server/web): ripgrep 跨文件搜索与纯前端内存 grep`

### Task 5: E2E compute 模式

**Files:** Create `apps/web/e2e/m6.spec.ts`; Modify `server`（如需）
**Interfaces:** E2E：`--compute` 起服 → 前端连接 → 设置 computePolicy=remote（settings UI 或 localStorage 注入）→ 打开 samples/m5/sample.js → 状态栏高亮引擎指示 remote（或 engine 文案变化——**裁决：状态栏追加执行位置文本"远程"**）→ Ctrl+Shift+F 全局搜 "inner" → m5 的 sub/inner.txt 出现结果 → 点击跳转打开该文件 → markdown comrak：samples/m6/sample-wikilink.md（若 comrak wikilinks 选项实现）或 GFM 表格断言与前端引擎输出一致的表格渲染。连续 2 次。
**Steps:** 样例 → E2E → 绿 → Commit `test(web/server): M6 compute 模式 E2E`

## Self-Review 记录

- Spec 覆盖：5.8（Highlight/Markdown Backend 双实现 + policy 路由；Archive/Detect/Inspect 裁剪 P2 已声明）、5.9 跨文件搜索双实现（ripgrep + 内存 grep 上限）、5.10 档 2 API、M6 验收。
- 已声明裁剪（报告必须重申）：服务端高亮无 injection（8-12 核心语言）、comrak 数学掩码不做、服务端解包移 P2——三者均为 spec 5.8/5.2 的范围收缩，理由：工程量/收益比，前端路线已覆盖。
- UTF-16 偏移转换是前后端区间一致性的命门，单测必须含 CJK+emoji。
