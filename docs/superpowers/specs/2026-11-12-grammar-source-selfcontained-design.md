# tree-sitter 构建源头化：helix pin + 自解析源清单 + 生成物出库 — 设计

日期：2026-11-12　状态：待用户审阅

## 1. 背景与动机（用户诉求，已拍板）

当前 grammar 生态的**源清单再生链**依赖本机固定检出目录（/share/rw/repo/markpad-aio/Markpad、/share/rw/repo/github/helix-editor/helix），且大量「可由脚本初始化的文件」被提交入库。用户拍板：

1. 构建不依赖本地固定文件夹——有自己的解析器，从源头（helix 官方）自行拉取解析；
2. 包括拉取 helix **最新正式版本号**及其注册的语言、tree-sitter 仓库能力；
3. 入库的应是脚本和构建工具，**不应提交可通过脚本初始化的文件**；
4. helix 版本策略：**pin 文件 + 一键刷新命令**（可复现可审计）。

## 2. 现状锚点（侦察实测）

### 2.1 本地路径依赖全清单（要消灭的面）

- `tools/grammar-builder/build-list.mjs:18-21`：`VV_GRAMMAR_INFO` 缺省 Markpad `src-tauri/grammar_info.json`、`VV_GRAMMARS_DIR` 缺省 Markpad `src-tauri/grammars`（探测 parser.c）。
- `tools/grammar-builder/gen-server-manifest.mjs:14`：`VV_MARKPAD_BUILD_RS` 缺省 Markpad `src-tauri/build.rs`。
- `tools/helix-assets/generate.mjs:12-21`：`VV_LANGUAGES_TOML/VV_QUERIES_DIR/VV_THEMES_DIR` 缺省 Markpad src-tauri 与本机 helix 检出 runtime/themes；`:218-222` tags.scm 补源 `TAGS_SOURCES.queriesDir` 缺省本机 helix runtime/queries，并记录 helix commit ba40e547。

### 2.2 入库的「可生成物」（要出库的面）

- `tools/grammar-builder/languages.toml`（303 [[grammar]]，vendored 自 Markpad→helix 同源）、`build-list.json`（301 条）、`aliases.json`（**保留入库**——36 键 lite 选择面+44 别名是 vviewer 自有资产非上游派生）。
- `packages/vviewer-highlight/assets/`：`languages.json`、`themes.json`、`queries/`（960 个 .scm）。
- `server/grammars-manifest.json`（服务端 301 验收集合）、`server/GRAMMAR_LICENSES.md`（从 out/grammars 源树收集，out 本身仓内）。
- `packages/vviewer-core/src/registry/generated-extensions.ts`（gen-code-extensions.mjs 产物，现入库 + CI `--check`）。

### 2.3 无需改动的现状

- CI 构建 wasm 链**本就不依赖本地检出**：build.mjs `--fetch` 按入库 languages.toml 的 git+rev 浅取 grammar 源（build.mjs:395-418，并发 8、工具链预热单飞、失败即删坏产物）；setup-grammars composite action（.github/actions/setup-grammars）缓存 key=grammars-<os>-<langs>-<fetch-only>-hash(lockfile, languages.toml, build-list.json)。
- QUERY_PATCHES 机制（generate.mjs:253-263，现仅 solidity 尾锚 1 条，命中≠1 抛错）：保留并迁入新脚本。
- helix 最新 release 现值：**25.07.1**（2026-11-12 实测 GitHub API）。
- Markpad 转载与 helix master 的 languages.toml 曾实测逐字节一致（2026-10-19 盘点，唯一分歧是 vviewer 有意保留的 yaml QUERY_PATCHES，属补丁层不属源清单）。

## 3. 设计

### 3.1 helix pin 文件

`tools/grammar-builder/helix-pin.json`（入库，唯一新源清单）：

```json
{ "tag": "25.07.1", "commit": "<该 tag 的 commit sha>", "refreshedAt": "2026-11-12T…" }
```

- 初始生成：GitHub API `releases/latest` 解析 tag → `git/refs/tags/<tag>` 解析 commit（或 raw 重定向/commits API，builder 选可靠路径），写 pin。
- 所有下游生成都以 pin 为准（可复现）；网络失败显式报错不静默。

### 3.2 新生成器脚本 `tools/grammar-builder/gen-sources.mjs`

单一脚本合并现 build-list/gen-server-manifest/helix-assets 三者职责（旧脚本退役），从 **helix tag 源头**拉取：

1. **languages.toml@tag**：`raw.githubusercontent.com/helix-editor/helix/<tag>/languages.toml` 下载解析（smol-toml 已是 devDep），产出：
   - `build-list.json` 等价物（name/source/rev/subpath + parser.c 探测改为**拉取后探测**或信任上游——裁量：保持探测（浅取 grammar 源后验）会把 build-list 生成推迟到 fetch 之后；替代=信任 helix 清单不探测，`--fetch` 失败即暴露。倾向后者+fetch 层失败清单既有机制）；
   - `server/grammars-manifest.json`（301 门禁集合派生，<301 报错语义保留）；
   - languages.json 派生（**builder 必查**：现 languages.json 的字段消费面——detect/highlight/registry 三处消费的具体字段与 helix languages.toml 字段的映射关系；若现文件含 Markpad 增补字段需在派生时保留注入）；
   - `generated-extensions.ts`（gen-code-extensions 逻辑并入，源=languages.json）。
2. **queries@tag**：helix `runtime/queries/<lang>/*.scm` 按语言清单拉取（git trees API recursive 一次列全 + raw 逐文件，tools/fetch-e2e-corpus.mjs:1-35 算法现成）→ `packages/vviewer-highlight/assets/queries/`；QUERY_PATCHES 应用（唯一命中替换，命中≠1 抛错）；tags.scm 补源逻辑并入（TAGS_SOURCES 改 pin tag）。
3. **themes@tag**：helix `runtime/themes` → `themes.json`（现 themes.json 结构/消费面 builder 核对后保持等价输出）。
4. **GRAMMAR_LICENSES.md**：在 `--fetch` 落地 out/grammars 源树后生成（现逻辑不变，仅时序后移到 fetch 后；pack-npm 前置依赖不变）。
5. 全部产物写盘前打印变更摘要（语言集 ±、rev 变更数、queries 差异文件数）。

### 3.3 刷新命令

`gen-sources.mjs --refresh`：拉 `releases/latest` → 与 pin 对比 → 更新 pin + 全量重生成 → 打印语言集差异报告（新增/移除/rev 变更/queries 变更）。匿名 GitHub API 60/h 足够（1-2 次调用）；可选 GITHUB_TOKEN。

### 3.4 出库与 CI 重排

- .gitignore 扩：`languages.toml`、`build-list.json`、`packages/vviewer-highlight/assets/{languages.json,themes.json,queries/}`、`server/grammars-manifest.json`、`server/GRAMMAR_LICENSES.md`、`generated-extensions.ts`。`aliases.json`、`helix-pin.json`、脚本、测试、README 入库。
- **CI 三 job 前置**：setup-grammars composite action 扩一步——缓存未命中时先跑 `gen-sources`（缓存 key 改 hash(`helix-pin.json`, `aliases.json`, 脚本, pnpm-lock)），再 `--fetch`/`--self-build`；web/rust/e2e/grammar/release/pages 全链同步（rust job 的 server build.rs 依赖 queries/grammars-manifest.json 在位——**gen 必须在 cargo build 前**，fetch-only 档同样先 gen）；gen-code-extensions 的 CI `--check` 改为「gen 后 diff 校验」或直接删（产物已不入库，check 无对象——裁量：改为 build 前置生成即可，门禁语义并入 gen 成功性）。
- README/tools 文档同步（README.md:118 「292 条」过时数字一并修正）。

### 3.5 Markpad 依赖退役

- build-list 的 grammar_info join、gen-server-manifest 的 build.rs 静态表解析全部退役；Markpad 转载层消失，helix languages.toml 直接为准。**验证步骤**（实施首步）：对比 pin tag 的 helix languages.toml [[grammar]] 集合与现入库 vendored 版本（预期零差异或仅上游演进），逐字段核对 source/rev/subpath 与 Markpad grammar_info 的等价性，差异写进 gen-sources 的第一版测试锚。

## 4. 目标 / 非目标 / 反目标

- 目标：干净 clone 全链可跑（gen → fetch → self-build → cargo build → web build）；唯一上游事实源=helix pin；生成物零入库；一键刷新带差异报告。
- 非目标：改 wasm 自建工艺（tree-sitter-cli 0.27/wasi-sdk/单飞预热/失败清单机制全部维持）；改 npm 打包布局（spec③ 另行处理）； aliases.json 派生化。
- 反目标：每次构建自动拉最新 release（不可复现，已拍板 pin）；在 gen 层做语言集裁剪（选择面仍由 aliases.json + --lite/--languages 表达）。

## 5. 风险与验证

- **queries 体积与拉取时长**：960 文件全量拉取入 CI 冷缓存——trees API 单次 + raw 并发，量级同 e2e 语料 fetch（实测可承受）；缓存 key 不含 queries 内容，pin 不变即命中。
- **languages.json 字段映射**是最大不确定性（Markpad 增补字段若存在需显式注入）；themes.json 同理。
- **出库导致 build 顺序硬依赖 gen**：本地首跑/CI 冷缓存都必须先 gen——错误提示要明确（gen 缺产物时各消费端报错指向 gen 命令）。
- 全量门禁不变：`full_registry_count_is_301`、manifest ≥264 断言、vitest 24 项 grammar-builder 单测迁移改写。

## 6. 验收锚点

- 单测：languages.toml 解析器（多形态 [[grammar]]/subpath 有无）；QUERY_PATCHES 命中≠1 抛错；pin 解析；派生映射（languages.json/generated-extensions/grammars-manifest 快照锚）。
- 集成：干净 clone（临时 worktree + 模拟无 /share 环境）`gen → --fetch --lite → --self-build → cargo build → pnpm build` 全链绿；`--refresh` 在 mock GitHub 响应下产出差异报告。
- CI：三 job 冷缓存首跑绿（gen 前置生效）；缓存命中跳 gen。
- grep 门：仓内 `/share/rw/repo/markpad-aio` 与 `/share/rw/repo/github/helix-editor` 字面量清零（文档历史叙述除外）。

## 7. 留给 builder 的裁量

- gen-sources 的子命令拆分（gen/refresh/fetch-probe）与产物落盘原子性（临时目录+rename）；queries 拉取并发度与失败重试；languages.json/themes.json 映射实现；CI gen 步的缓存层次（gen 产物单独缓存 vs 并入 setup-grammars 现有 paths）；旧脚本退役的过渡提交切分。
