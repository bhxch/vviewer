# VSCode 图标主题 vendor（assets/vscode-icons/）

本目录 Seti 图标主题资产来自 [microsoft/vscode](https://github.com/microsoft/vscode) 仓库
`extensions/theme-seti/icons/`（theme-seti 扩展，MIT 许可，Copyright (c) Microsoft
Corporation；字形数据上游为 [jesseweed/seti-ui](https://github.com/jesseweed/seti-ui)，同 MIT），
vendor 基准 tag：**1.141.0**（2026-11-01 经 raw.githubusercontent.com 抓取；清单上游
文件名为 `vs-seti-icon-theme.json`，入库改名 `seti-icon-theme.json`）。

| 文件 | 上游来源 | 修改 |
| --- | --- | --- |
| `seti-icon-theme.json` | tag `1.141.0` 的 `extensions/theme-seti/icons/vs-seti-icon-theme.json`（实测已为严格 JSON，无注释/尾逗号，JSONC 规范化即重排缩进） | ① `fonts[].src` 对象形式 `[{path,format}]` → 字符串数组（`validateVscodeIconTheme` 只收字符串 src，`format` 上提到字体级）；② 字体级 `size: '150%'` 剥除（消费面无此字段）；③ 顶层 `file: "_default"` 关联改写为 `iconDefinitions._file` 别名定义（vviewer 回退键口径，VSCode 官方关联键 `file`/`folder` 本方解析器不消费）；④ 剥 `information_for_contributors`/`version` 元数据键与 `light` 亮色变体节 + 全部 `*_light` 定义（图标渲染单变体不消费，体积 54KB→27KB）；字形码点/色值未改动。 |
| `seti.woff` | tag `1.141.0` 的 `extensions/theme-seti/icons/seti.woff` | 原样拷贝（37284 字节，远低于 200KB 子集化关注线）。 |

## 上游现状备注（2026-10 的 1.141.0）

- 上游清单**无 folder 图标**（无 `folder`/`folderNames` 关联键、无 `hidesExplorerArrows`
  键）——VSCode 的 Seti 主题本来就只给文件配图标、目录仅显示折叠箭头。经本方
  `normalizeIconTheme` 归一后 `_folder`/`_folder_open` 落空、`hidesExplorerArrows=false`，
  目录行维持纯 caret 现状；「caret 由 folder 图标替代」的行为只能由导入的
  自带 folder 图标且声明 `hidesExplorerArrows: true` 的主题触发。
- 归一后定义 193 条（上游 383 条剥 190 条 `*_light`）；文件映射面：fileNames 101、
  fileExtensions 238、languageIds 83 条原样保留（键与值引用均未改动）。
- `weight`/`style`（'normal'）保留；字形字号未定义（`fontSize` 仅定义级字段，上游
  定义无此键），渲染跟随各消费点行内字号。

## 许可

theme-seti 扩展为 MIT（其 package.json `license: "MIT"`）；MIT 全文见上游仓库
根 LICENSE，本仓库级汇总登记见根目录 `THIRD_PARTY_NOTICES.md`（由计划 Task 4 增补条目——vendor 属 Task 4）。
本文件即二进制资产（woff）无法内嵌声明的统一声明载体（惯例同上级 `../vscode/README.md`）。

vendor 转换脚本（src 对象形式改写/`_file` 别名/亮色变体剪除）为一次性操作，未随
仓库分发；复现步骤即上表「修改」列所述。
