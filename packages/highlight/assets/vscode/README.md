# VSCode 主题 vendor（assets/vscode/）

本目录两份 JSON 来自 [microsoft/vscode](https://github.com/microsoft/vscode) 仓库
`extensions/theme-defaults/themes/`（MIT 许可，Copyright (c) Microsoft Corporation），
vendor 基准 tag：**1.141.0**（2026-10-11 抓取；`main` 分支同路径文件不稳定，故用 release tag）。

| 文件 | 上游来源 | 修改 |
| --- | --- | --- |
| `dark_modern.json` | tag `1.141.0` 的 `themes/dark_modern.json`（经 `include` 引 `dark_plus.json` → `dark_vs.json`） | 格式规范化修改：原文件为 JSONC（`//` 注释 + 尾逗号，VSCode 用宽松解析器），且 tokenColors 经 include 链外置；vendor 时以字符串感知扫描剥注释/尾逗号，按 include 链合并（colors 覆盖序 vs→plus→modern；tokenColors 拼接序 vs→plus，匹配语义与 VSCode「后规则胜平级」一致）后序列化为严格 JSON；新增 `type: "dark"`（取自扩展 package.json `contributes.themes` 的 `uiTheme: "vs-dark"`，原版存于 package.json 而非主题 JSON）；删除 `$schema`/`include` 键。色值未改动。 |
| `light_modern.json` | tag `1.141.0` 的 `themes/light_modern.json`（经 `include` 引 `light_plus.json` → `light_vs.json`） | 同上（`type: "light"` 取自 `uiTheme: "vs"`）。 |

## 上游现状备注（2026-10 的 1.141.0）

- `dark_plus.json` / `light_plus.json` 已无 `colors` 块多年；`editor.selectionBackground`、
  `list.hoverBackground`（仅暗侧缺）、`editorError.foreground`、`editorWarning.foreground`
  等键在近期上游 JSON 中均不存在（移入 VSCode 主题服务默认值）。因此
  `src/vscode.ts` 的 `colorsToUiVars` 12 键映射对这两份资产：dark 命中 8 键、light 命中
  9 键，其余键走消费方 app.css 的 default 值回退（设计内：缺键跳过，不推断）。
- tokenColors 的 scope 含空格选择器（如 `source.powershell variable.other.member`）：
  被映射管线按「无前缀命中」自然跳过（不解析 selector 语法），原样保留在文件中；
  `semanticTokenColors` 段被丢弃（vendor 合并未收入两份 JSON，映射管线亦只消费
  `colors`/`tokenColors`）。
- 上游色值大小写混杂（如 `#569cd6` 小写、`#6A9955` 大写），快照断言以本目录文件实际值为准。

## 许可

theme-defaults 扩展为 MIT（其 package.json `license: "MIT"`）；MIT 全文见上游仓库
根 LICENSE，本仓库级汇总登记见根目录 `THIRD_PARTY_NOTICES.md`（由计划 Task 5 增补条目）。
本文件即 JSON 纯格式无法内嵌声明的统一声明载体（惯例同上级 `LICENSE-README.md`）。

vendor 生成脚本（JSONC 解析 + include 合并）为一次性操作，未随仓库分发；复现步骤即
上表「修改」列所述。
