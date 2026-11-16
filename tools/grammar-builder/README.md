# @bhxch/vviewer-grammar-builder

grammar 资产管线（spec F 构建源头化）：**唯一上游事实源 = helix pin**
（`helix-pin.json`，master commit 锚）。`gen-sources.mjs` 从 pin 自拉再生全部源清单与
查询/主题资产（生成物不入库），`build.mjs` 按清单浅取源树并自建 wasm（产物不入库）。

```bash
pnpm gen:sources        # = node tools/grammar-builder/gen-sources.mjs（按 pin 全量生成）
node tools/grammar-builder/build.mjs --fetch        # 源树浅取（--lite / --languages 收窄）
node tools/grammar-builder/build.mjs --self-build   # wasm 自建（默认 lite）
pnpm gen:grammars       # = pnpm gen:sources && --fetch --lite && --self-build
```

**生成物一律不入库**（`.gitignore`，spec F 出库清单）：`tools/grammar-builder/languages.toml`、
`build-list.json`、`packages/vviewer-highlight/assets/{languages.json, themes.json, queries/}`、
`server/grammars-manifest.json`、`server/GRAMMAR_LICENSES.md`、
`packages/vviewer-core/src/registry/generated-extensions.ts`。入库保留：脚本、测试、
`aliases.json`（vviewer 自有资产）、`helix-pin.json`、本 README。任何消费端在产物缺失时
报错统一指向 `pnpm gen:sources`。

## gen-sources.mjs（单源生成器）

| 命令 | 行为 |
| --- | --- |
| `node gen-sources.mjs` | 按 pin 全量生成 + 变更摘要（对盘上旧产物 diff：语言集 ±、rev 变更数、queries 差异文件数） |
| `node gen-sources.mjs --refresh` | resolve helix master HEAD → 更新 pin（refreshedAt）→ 全量重生成 + 差异报告（pin 缺失时自动初始化——首跑入口） |

- **pin 文件**：`{ ref: 'master', commit: '<40hex>', release: '', refreshedAt: '<ISO8601>' }`；
  缺失/缺字段/commit 非 40hex 显式报错指向 `--refresh`。语言与 tags 同一 commit 锚
  （单一锚点消除节点名漂移，用户 2026-11-14 拍板；release 信息不作为锚）。
- **languages.toml@pin** 拉取解析后派生四产物：`build-list.json`（[[grammar]] 全集 −
  `use-grammars.except`（wren/gemini 语义照抄）；`parserCExists` 恒 true——信任 helix
  清单不预探测，实探由 `--fetch`/`--self-build` 失败清单承接；`helixLang=name`）、
  `server/grammars-manifest.json`（cSymbol 按 `tree_sitter_<name，-→_>` 规约派生，fetch 后
  由 build.mjs 从 parser.c 交叉验证，不符进 fetch-failures）、`languages.json`（[[language]]
  派生零增补）、`generated-extensions.ts`（fileTypes 全集）。
- **queries@pin 整树拉取**：`runtime/queries/**/*.scm` 全量（**不过滤语言清单**——
  `_typescript`/`_javascript`/`ecma`/`php-only` 等继承父目录与变体目录必须入盘，逐语言
  过滤断 inherits 链）；tags.scm 随整树同 pin 收编（TAGS_SOURCES 独立 pin 机制退役）。
  trees API truncated 即抛错、raw 单文件失败重试 1 次仍败抛错带失败清单（显式不静默）。
- **themes@pin**：`runtime/themes/*.toml` → `collectThemes`（跳 `theme.toml`/`base16_*`）→
  `themes.json`。
- **QUERY_PATCHES**（机制自 `tools/helix-assets/generate.mjs` 迁入，helix-assets 已退役）：
  helix queries@pin 原样落盘后的针对性修正——当前仅 `solidity/highlights.scm` 1 条（删去
  单子元素组内尾随锚点，tree-sitter 0.27 硬语法错误）；find 须唯一命中，命中≠1 抛错提醒
  人工复核。历史条目（ecma/injections.scm O(n²) 锚点）随上游内置等价锚移除，若回退在
  gen-sources.mjs 重新添加。
- **aliases 一致性门禁**：aliases.json 每键须命中 manifest 名集（含 `-`/`_` 变体），未命中
  即报错；`ALIASES_KNOWN_MISSING = ['objc', 'systemrdl']` 白名单告警放行（现状合法差异）。
- **真资产契约锚**：扩展名 ≥100、含 jsonl（C/D 项契约）。

## build.mjs 两种模式

| 模式 | 命令 | 说明 |
| --- | --- | --- |
| `--fetch`（源获取） | `node build.mjs --fetch [--lite\|--languages x,y]` | 目标语言 join gen-sources 产物 `languages.toml@helix-pin`（`[[grammar]]` git+rev+subpath）逐个浅取源仓（`git fetch --depth 1 <rev>`，并发 8，单仓失败记 `out/fetch-failures.json` 继续），**整仓**拷贝到 `out/grammars/<name>/`（保留仓库布局——typescript/tsx/ocaml 的 scanner include 仓库根 `common/`），判据 `<subpath>/src/parser.c`。fetched 条目逐一 cSymbol 交叉验证（期望 `tree_sitter_<name，-→_>` 未见于 parser.c 即记入失败清单，spec F §8）。默认全量 build-list；`--lite`/`--languages` 收窄。注意：幂等短路按目录存在性判断不校验 rev——pin refresh 后 rev 变更的语言需删除 `out/grammars/<name>/` 重取（CI 由缓存 key 含 pin hash 自然失效） |
| `--self-build`（构建） | `node build.mjs --self-build [--all\|--languages x,y] [--force]` | 目标语言逐个 `tree-sitter build --wasm`（cli ≥0.26 免 emcc，首次自动下载 wasi-sdk/binaryen 到 `~/.cache/tree-sitter`），wasm 直写 `apps/web/static/grammars/` 并整表重写 `manifest.json`（目录即事实源），runtime wasm 从 node_modules 拷到 `apps/web/static/`。已存在 wasm 跳过（`--force` 重建）；选择面：默认 lite（aliases.json 键）/`--all`/`--languages`。CLI 钉定仓库内 `node_modules/.bin/tree-sitter`（裸 PATH 会命中系统全局旧版，实测 0.26.11 与 0.27 的 wasi-sdk 缓存不兼容）。gen 产物（build-list.json/languages.toml）缺失时两分支入口均显式报错指向 `pnpm gen:sources` |

## CI 流

`.github/workflows/grammar.yml` 经 composite action `.github/actions/setup-grammars`：
`pnpm install` → 缓存（工具链/源树/gen 产物/生成物，key 含 `helix-pin.json` hash——pin
不变即命中；`helix-pin.json`/`aliases.json` 入库文件不进缓存 paths）→ 缓存未命中时
`gen-sources` → `--fetch`（全量）→ `--self-build --all` → `gen-licenses`（全量源树在手
再生 license）→ **动态等式门禁**（wasm manifest 键数 + self-build 失败清单数 ==
`server/grammars-manifest.json` 条目数——gen-sources 产出即真相，随 pin refresh 自然
增长；fetch 失败被 parser.c-missing 失败条目吸收，fetch-failures 仅打印）→ artifact
`grammar-wasm`（grammars + queries + GRAMMAR_LICENSES.md 同根布局，spec F §8——
publish-npm 不跑 gen，经 `VV_QUERIES_DIR`/`VV_LICENSE_FILE` 消费解包路径）。
server 全量门禁：`full_registry_count_matches_manifest`（registry 数 == manifest 条目数）。

## 选择面与语言解析

- **lite**（默认，本地开发/测试/release web 包）：`aliases.json` 键（原 tree-sitter-wasms
  36 键），其中 objc/systemrdl 无查询资产且 helix 未收录（无源可取）、vue 受下述
  vendored 约束，实际产出 **34**（33 自建 + 1 vendored；yaml 曾 vendored，BUG-37 清偿
  起自建）。
- 语言解析顺序：build-list 的 `helixLang`/`name`（含 `_`/`-` 变体）→ `languages.toml`
  同名条目（swift 等不在 build-list 快照内者）→ `aliases.json` wasm 字段去
  `tree-sitter-` 前缀推导。解析失败仅告警不致命。
- **all**：build-list 全部可建项 + aliases 可解析补充。

## vendored 例外（fixtures/）

cli ≥0.26 的 wasi-sdk wasm 工具链不支持 **C++ 外置 scanner**（`get_scanner_path` 只认
`scanner.c`，0.27.0 实测），vue（`scanner.cc`，含嵌套 html scanner 共 2 文件）无法再生，
以 tree-sitter-wasms 0.1.13 时代的预编译产物作为**不可再生的遗留输入** vendor 在
`fixtures/`（gitignore 白名单 `!tools/grammar-builder/fixtures/*.wasm`）：命中选择面时
短路拷贝，manifest 条目标 `source: 'vendored'`。上游工具链支持 `.cc` 后删除对应 fixture
即恢复自建。yaml 曾同在此列（BUG-37：该 vendored 产物在 web-tree-sitter 0.25.10 下
parse 首调外置 scanner 抛 TypeError，本地 yaml 高亮恒静默降级 hljs）——2026-10-16 起
自建（vendor 的 tree-sitter-grammars 源），fixture 已删除。spec F 起上游 master pin 的
yaml 源指回 ikatyang/tree-sitter-yaml（scanner.cc）——冷缓存自建会失败进失败清单（既有
机制如实承接，动态等式门禁为此设计；本地 wasm 缓存命中不受影响）。

## wasm 集与服务端集的口径差

两侧语言集合同源于 gen-sources 派生清单，口径如下（数字动态，以 manifest 实值为准）：

- **服务端集 = manifest 条目数**：`server/core/build.rs` 源码编译（cc 编 C，C++ 外置
  scanner 经 cc 平台 C++ 编译器），全量无缺口。清单 = gen-sources 派生的
  `server/grammars-manifest.json`，与 `build-list.json` 条目一一对应（当前各 301，随 pin
  refresh 自然增长；上游删除语言的查询目录时 build.rs 物化空串三件套保 include_str 恒可解析）。
- **wasm 集 ≤ manifest 条目数**：受 cli wasm 工具链限制（`get_scanner_path` 只认
  `scanner.c`，见上文 vendored 例外），带 C++ 外置 scanner 的语言无法自建（vendored
  短路计入；缺失者进 self-build 失败清单，动态等式门禁吸收）。查询面排查：

  ```bash
  # 源树中带 C++ 外置 scanner 的语言（wasm 自建缺口 + vendored）
  find tools/grammar-builder/out/grammars -name scanner.cc | sort
  # 集合规模（动态计数）
  node -p "require('./server/grammars-manifest.json').grammars.length"
  node -p "Object.keys(require('./apps/web/static/grammars/manifest.json').grammars).length"
  ```

## npm 资产包（pack-npm）

把 grammar wasm 集打成可发布的 npm 单包（spec §3 阶段 2：manifest + wasm + queries +
许可证聚合一个包）。发布由 CI 承接（`.github/workflows/release.yml` 的 `publish-npm`
job——**不跑 gen**：queries/GRAMMAR_LICENSES.md 随 `grammar-wasm` artifact 下发，经
`VV_QUERIES_DIR`/`VV_LICENSE_FILE` 指向解包路径，spec F §8）；本地打包：

```bash
VV_NPM_PACKAGE_NAME='@your-scope/vviewer-grammars-full' \
VV_NPM_PACKAGE_VERSION='0.0.0-local' \
VV_NPM_OUT=/tmp/dist-npm \
node tools/grammar-builder/pack-npm.mjs
```

- **输入**：`VV_GRAMMARS_OUT`（默认 `apps/web/static/grammars`——本地即 lite 集 34
  wasm；CI publish 下载 `grammar.yml` 的 `grammar-wasm` artifact，为全量集）+
  `VV_QUERIES_DIR`（默认 `packages/vviewer-highlight/assets/queries`）+ license 聚合
  `VV_LICENSE_FILE`（默认仓库根 `server/GRAMMAR_LICENSES.md`，缺失即抛错——许可证
  聚合必须随包）。
- **包布局**（与客户端三层装配 `apps/web/src/lib/grammarLayers.ts` 的 base 契约同构）：

  ```
  package.json            # private:false；files: [grammars, queries, GRAMMAR_LICENSES.md]
  grammars/manifest.json  # 条目统一注入 base:'./'，与 *.wasm 同目录
  grammars/*.wasm
  queries/                # 整目录随包；客户端不走 CDN 取 queries，仅供独立消费
  GRAMMAR_LICENSES.md
  ```

- **`base` 字段语义**：包内条目 `base:'./'` 为同目录相对前缀（node_modules 直读场景的
  wasm 位置）；客户端运行时三层装配会以层 base（CDN 形态 `<pkg>@<ver>/grammars/`，
  以 `/` 结尾）覆写条目 base，wasm URL = `${base}${file}`——manifest 与 wasm 恒同目录，
  客户端不再插入中间段。
- **残包拦截**（publish 前即失败，不出残包）：grammarsDir 缺失/无 wasm、manifest 引用
  悬空 wasm、queriesDir 或 license 缺失、name/version/outDir 缺失，任一命中即抛错。
- **规模实测**（lite 集）：992 files / 47.5MB（34 wasm 共 46.4MB + manifest 7.6KB +
  queries ~1.1MB + license 20.9KB）；npm 发布为 gzip tarball。测试：
  `pnpm vitest run tools/grammar-builder`（pack-npm 在列）。

## 构建要点（实测结论）

- **tree-sitter.json shim**：cli 0.27 只在有 `tree-sitter.json` 时编译链接外置 scanner，
  老 grammar 缺配置时由 `ensureTreeSitterConfig` 写最小 shim（符号名按 name `-`→`_`
  推导并在 parser.c 中校验）。
- **产物与运行时兼容**：cli 0.27 产物含 `dylink.0` 节，web-tree-sitter 0.25.10 运行时
  实测可加载解析（0.27 运行时才强制要求 dylink.0 并更名 `web-tree-sitter.wasm`）。
- **失败即删**：cli 的 scanner 符号检查发生在产物落盘之后，失败会留下坏产物——构建失败
  时删除输出，避免污染 skip-if-exists 缓存。
- 8MB 单文件上限已废除（产物不入库，体积不构成仓库约束），超限仅告警。

## 清单与数据源

- `helix-pin.json`（入库）：唯一新源锚——master commit + refreshedAt，`--refresh` 更新。
- `languages.toml`（gen 产物）：gen-sources 自 pin 直拉落盘，`build.mjs --fetch` 的
  `[[grammar]]` 源清单输入。
- `build-list.json`（gen 产物）：[[grammar]] 全集 − use-grammars.except 派生（动态条目数
  = manifest 条目数），`--self-build` 目标清单。
- `aliases.json`（入库，自有资产）：36 键映射 + 别名表（js/ts/py/rs/sh/c++/golang/yml/rb
  等 44 条），键序 = 高频优先（历史截断依据，现仅作文档语义）。
- `manifest.json`（生成）：`{ generatedAt, source: 'self-built', grammars: Record<lang,
  { file, abi: null, sha256, aliases, source?: 'vendored' }> }`。

## 退役脚本说明

`build-list.mjs`（markpad grammar_info join + parser.c 探测）、`gen-server-manifest.mjs`
（Markpad build.rs 静态表解析）、`gen-code-extensions.mjs`（extensions 模块生成——逻辑
并入 gen-sources 派生面）与 `tools/helix-assets/`（languages/themes/queries 资产生成器，
纯函数与 QUERY_PATCHES 原样迁入 gen-sources.mjs，盘态守门测试迁入 gen-sources.test.ts）
已于 spec F（2026-11-17）退役删除。它们依赖的仓库外固定检出（markpad-aio/本机 helix
checkout）同步消灭——grep 门（两条本机绝对路径字面量仓内清零，docs/superpowers 历史叙述
除外）见计划 Global Constraints 与 T6 终验。

## 环境变量覆盖

`VV_LANGUAGES_TOML` / `VV_GRAMMARS_DIR` / `VV_GRAMMARS_OUT` / `VV_MANIFEST_OUT` /
`VV_FAILURE_OUT` / `VV_FETCH_FAILURES_OUT` / `VV_VENDORED_DIR` / `VV_QUERIES_DIR` /
`VV_LICENSE_FILE`（pack-npm；publish-npm artifact 解包路径）/ `VV_NPM_OUT` /
`VV_NPM_PACKAGE_NAME` / `VV_NPM_PACKAGE_VERSION`。

## 测试

`pnpm vitest run tools/grammar-builder`（build.mjs 选择面解析、stub CLI 全链路、vendored
短路、fetch 本地 fixture + cSymbol 交叉验证、ensureGenProducts、gen-sources 纯函数/派生/
盘态守门/网络面 mock、pack-npm 含 VV_LICENSE_FILE 注入；manifest 磁盘校验在产物存在时
才跑，fresh clone 自动跳过）。
