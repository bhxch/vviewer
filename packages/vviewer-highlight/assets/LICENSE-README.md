# 资产来源与修改声明（MPL-2.0 合规）

本目录下的资产派生自或拷贝自 [helix-editor/helix](https://github.com/helix-editor/helix)（MPL-2.0），生成与溯源流程见仓库 `tools/helix-assets/README.md` 及 `tools/helix-assets/generate.mjs`。

| 文件/目录 | 来源 | 修改 |
| --- | --- | --- |
| `themes.json` | helix `runtime/themes/*.toml`（214 主题；跳过 `theme.toml` 与 `base16_*.toml`） | 格式转换修改：TOML → 扁平 JSON（`Record<themeName, Record<capture, { fg?, bg?, modifiers? }>>`）；色名引用按 helix 语义解析为 6 位 `#rrggbb`；`inherits` 继承已展开 |
| `languages.json` | helix `languages.toml`（经 markpad 同源副本，grammar 清单带验证过的 rev/subpath） | 格式转换修改：TOML → JSON（`Record<langName, { scope, injections?, fileTypes, globFileTypes?, shebangs, grammar, aliases? }>`）；file-types 字符串为后缀、`{glob}` 归入 `globFileTypes` |
| `queries/` | helix `runtime/queries/` | vendored 原样拷贝（目录数随上游 pin 点变化，含继承父目录如 `_typescript`、`ecma`、`_javascript`），未修改内容 |

## MPL-2.0 声明保留说明

原文件为 TOML/tree-sitter 查询且无内嵌许可声明文本，MPL-2.0 要求的"保留法律声明"与"显著标注修改"以本文件履行：本目录资产整体作为 MPL-2.0 授权代码分发，各自的修改如上表所列。原始许可文本见 helix 仓库根目录的 LICENSE 文件（MPL-2.0 全文），本仓库不随资产内嵌副本。

两个 JSON 为纯 JSON 格式，无法在文件首行外加说明注释，故以本文件（`LICENSE-README.md`）作为统一声明载体。

本仓库其余代码以 Apache-2.0 授权；MPL-2.0 的文件级 Copyleft 边界仅覆盖本目录派生/拷贝的资产，不延伸至仓库其余部分。

引入里程碑：M2（语法/主题高亮资产）。生成时间与源 rev 以生成器运行时输出为准（幂等可复现）。
