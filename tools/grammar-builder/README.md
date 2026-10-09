# @vviewer/grammar-builder

grammar wasm 资产管线：为语法高亮生成 `apps/web/static/grammars/{manifest.json, *.wasm}`
与 runtime `apps/web/static/tree-sitter.wasm`。**产物一律不入库**（构建期生成，
`.gitignore`），由 `pnpm gen:grammars`（= `--fetch --lite` + `--self-build`）一键生成。

## 两种模式

| 模式 | 命令 | 说明 |
| --- | --- | --- |
| `--fetch`（源获取） | `node build.mjs --fetch [--lite\|--languages x,y]` | 目标语言 join vendored `languages.toml`（`[[grammar]]` git+rev+subpath）逐个浅取源仓（`git fetch --depth 1 <rev>`，并发 8，单仓失败记 `out/fetch-failures.json` 继续），**整仓**拷贝到 `out/grammars/<name>/`（保留仓库布局——typescript/tsx/ocaml 的 scanner include 仓库根 `common/`），判据 `<subpath>/src/parser.c`。默认全量 build-list；`--lite`/`--languages` 收窄 |
| `--self-build`（构建） | `node build.mjs --self-build [--all\|--languages x,y] [--force]` | 目标语言逐个 `tree-sitter build --wasm`（cli ≥0.26 免 emcc，首次自动下载 wasi-sdk/binaryen 到 `~/.cache/tree-sitter`），wasm 直写 `apps/web/static/grammars/` 并整表重写 `manifest.json`（目录即事实源），runtime wasm 从 node_modules 拷到 `apps/web/static/`。已存在 wasm 跳过（`--force` 重建）；选择面：默认 lite（aliases.json 键）/`--all`/`--languages`。CLI 钉定仓库内 `node_modules/.bin/tree-sitter`（裸 PATH 会命中系统全局旧版，实测 0.26.11 与 0.27 的 wasi-sdk 缓存不兼容） |

CI 流（`.github/workflows/grammar.yml`，经 composite action `.github/actions/setup-grammars`）：
`pnpm install` → 缓存（工具链/源树/产物三层）→ `--fetch`（全量）→ `--self-build --all`
→ ≥264 断言 → artifact `grammar-wasm`（release 打包为 `grammar-wasm.tar.zst`）。

## 选择面与语言解析

- **lite**（默认，本地开发/测试/release web 包）：`aliases.json` 键（原 tree-sitter-wasms
  36 键），其中 objc/systemrdl 无查询资产且 helix 未收录（无源可取）、yaml/vue 受下述
  vendored 约束，实际产出 **34**（32 自建 + 2 vendored）。
- 语言解析顺序：build-list 的 `helixLang`/`name`（含 `_`/`-` 变体）→ `languages.toml`
  同名条目（swift 等不在 build-list 快照内者）→ `aliases.json` wasm 字段去
  `tree-sitter-` 前缀推导。解析失败仅告警不致命。
- **all**：build-list 全部可建项（≥264 断言口径）+ aliases 可解析补充。

## vendored 例外（fixtures/）

cli ≥0.26 的 wasi-sdk wasm 工具链不支持 **C++ 外置 scanner**（`get_scanner_path` 只认
`scanner.c`，0.27.0 实测），yaml/vue（`scanner.cc`）无法再生。二者以 tree-sitter-wasms
0.1.13 时代的预编译产物作为**不可再生的遗留输入** vendor 在 `fixtures/`（gitignore 白名
单 `!tools/grammar-builder/fixtures/*.wasm`）：命中选择面时短路拷贝，manifest 条目标
`source: 'vendored'`。上游工具链支持 `.cc` 后删除对应 fixture 即恢复自建。

## wasm 集与服务端集的口径差

阶段 1 起两侧语言集合不同源，口径如下（2026-10-09 实测）：

- **服务端集 = 301**：`server/build.rs` 源码编译（cc 编 C，C++ 外置 scanner 手动
  g++/ar/objcopy），无 wasm 工具链限制，全量无缺口。清单 = 入库的
  `server/grammars-manifest.json`（由 build-list 静态表生成），与 `build-list.json`
  的 301 条一一对应。
- **wasm 集 ≤301**：受 cli wasm 工具链限制（`get_scanner_path` 只认 `scanner.c`，
  见上文 vendored 例外），带 C++ 外置 scanner 的语言无法自建。对 fetch 源树全量排查：
  `find out/grammars -name scanner.cc | sort` 命中 6 个——yaml/vue 命中 vendored
  短路计入，**astro / haskell-persistent / lean / org** 为 wasm 集自建缺口（解析法
  理论口径 301 − 4 = 297，含 vendored；全量自建未在本地实跑，实测数待 CI
  `grammar.yml` 首跑回填）。
- **集合对比查询**（manifest ↔ build-list 差集核查）：

  ```bash
  # 源树中带 C++ 外置 scanner 的语言（wasm 自建缺口 + vendored）
  find tools/grammar-builder/out/grammars -name scanner.cc | sort
  # 集合规模与双向差集
  node -e "const bl=require('./tools/grammar-builder/build-list.json'),m=require('./server/grammars-manifest.json');const b=new Set(bl.map(e=>e.name)),s=new Set(m.grammars.map(e=>e.name));console.log('build-list',b.size,'server',s.size);console.log('仅 build-list:',[...b].filter(n=>!s.has(n)));console.log('仅 server:',[...s].filter(n=>!b.has(n)))"
  ```

## npm 资产包（pack-npm）

把 grammar wasm 集打成可发布的 npm 单包（spec §3 阶段 2：manifest + wasm + queries +
许可证聚合一个包）。发布由 CI 承接（`.github/workflows/release.yml` 的 `publish-npm`
job，`vars.NPM_SCOPE`/`secrets.NPM_TOKEN` 门控，首发走 tag）；本地打包：

```bash
VV_NPM_PACKAGE_NAME='@your-scope/vviewer-grammars-full' \
VV_NPM_PACKAGE_VERSION='0.0.0-local' \
VV_NPM_OUT=/tmp/dist-npm \
node tools/grammar-builder/pack-npm.mjs
```

- **输入**：`VV_GRAMMARS_OUT`（默认 `apps/web/static/grammars`——本地即 lite 集 34
  wasm；CI publish 下载 `grammar.yml` 的 `grammar-wasm` artifact，为全量集）+
  `VV_QUERIES_DIR`（默认 `packages/highlight/assets/queries`）+ 仓库根
  `server/GRAMMAR_LICENSES.md`（缺失即抛错，许可证聚合必须随包）。
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
  `pnpm vitest run tools/grammar-builder`（pack-npm 8 项在列）。

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

- `languages.toml`：vendored 自 helix（`[[grammar]]` 段 = 浅取源）。
- `build-list.json`：markpad grammar 源快照（292 条，判据 `src/parser.c`），由
  `build-list.mjs` 再生成（数据源在仓库外 markpad）。
- `aliases.json`：36 键映射 + 别名表（js/ts/py/rs/sh/c++/golang/yml/rb 等 44 条），
  键序 = 高频优先（历史截断依据，现仅作文档语义）。
- `manifest.json`（生成）：`{ generatedAt, source: 'self-built', grammars: Record<lang,
  { file, abi: null, sha256, aliases, source?: 'vendored' }> }`。

## 环境变量覆盖

`VV_LANGUAGES_TOML` / `VV_GRAMMARS_DIR` / `VV_GRAMMARS_OUT` / `VV_MANIFEST_OUT` /
`VV_FAILURE_OUT` / `VV_FETCH_FAILURES_OUT` / `VV_VENDORED_DIR`。

## 测试

`pnpm vitest run tools/grammar-builder`（24 项：选择面解析、stub CLI 全链路、vendored
短路、fetch 本地 fixture、manifest 结构；manifest 磁盘校验在产物存在时才跑，fresh clone
自动跳过）。
