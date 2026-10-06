# @vviewer/grammar-builder

grammar wasm 资产管线：为 M2 语法高亮产出 `apps/web/static/grammars/{manifest.json, *.wasm}`。

## 两条路径

| 模式 | 命令 | 说明 |
| --- | --- | --- |
| `--from-wasms`（M2 主路径） | `node build.mjs --from-wasms` | 从 `node_modules/tree-sitter-wasms/out` 按 `aliases.json` 映射拷贝，计算 sha256，写 manifest |
| `--self-build`（备用） | `node build.mjs --self-build` | 对 `build-list.json` 逐个 `tree-sitter build --wasm`；`emcc` 缺失时整批不执行，写 `out/failure-list.json` 并 exit 0 |
| 自建清单 | `node build-list.mjs` | 汇总 markpad `grammar_info.json`（subpath 表）+ 278 个语法源，判据 `src/parser.c` 存在 → `build-list.json` |

## tree-sitter-wasms 实测（0.1.13）

- `out/` 共 **36 个** wasm，命名 `tree-sitter-<grammar 仓库名>.wasm`（如 `tree-sitter-c_sharp.wasm`、`tree-sitter-tlaplus.wasm`）。
- typescript 与 tsx 是**两个独立 wasm**（`tree-sitter-typescript.wasm` / `tree-sitter-tsx.wasm`）；`tree-sitter-ocaml.wasm` 导出符号仅 `tree_sitter_ocaml`（不含 ocaml-interface）。
- 每个文件导出唯一 `tree_sitter_<ident>` 符号，语言标识无歧义（可用 `WebAssembly.Module.exports` 验证）。
- 与 helix `languages.json`（325 键）交集 **32 个语言**，即 `aliases.json` 全量映射；任务书期望的 ≥60 语言交集不存在（上游只发 36 个）。

## aliases.json

`{ helixLangName: { wasm: "tree-sitter-wasms 文件名（不含扩展名）", aliases: [...] } }`。
**键序 = 高频优先**（javascript → typescript → tsx → python → …），是总量截断的依据。别名覆盖 js/ts/py/rs/sh/c++/golang/yml/rb 等 34 条。

## 资产约束（M2 决定）

- 单文件 ≤ **3MB**：超限跳过（实测跳过 ocaml / c-sharp / kotlin / swift / tlaplus / cpp 共 6 个），记录到 `out/from-wasms-skipped.json`。
- 入库总量 ≤ **80MB**：按 `aliases.json` 键序截断。实测 26 个语言共 **16.9MB**，远低于上限。
- `manifest.json`：`{ generatedAt, source: 'tree-sitter-wasms', grammars: Record<lang, { file, abi, sha256, aliases }> }`。`abi` 为 `null`——tree-sitter-wasms 未声明 ABI 版本，运行时由 web-tree-sitter 加载校验兜底。
- wasm 虽为构建产物，M2 决定入库（`.gitignore` 白名单 `!apps/web/static/grammars/*.wasm`）保证纯前端版开箱可用。

## 环境变量覆盖

`VV_LANGUAGES_JSON` / `VV_GRAMMAR_INFO` / `VV_GRAMMARS_DIR` / `VV_BUILD_LIST` / `VV_WASMS_DIR` / `VV_GRAMMARS_OUT` / `VV_MANIFEST_OUT` / `VV_FAILURE_OUT` / `VV_SKIPPED_OUT`。

## 测试

`pnpm vitest run tools/grammar-builder`（16 项：映射覆盖、判据幂等、manifest 结构/sha256 一致性、跳过与截断逻辑、emcc 缺失路径）。
