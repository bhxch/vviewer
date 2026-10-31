# @bhxch/vviewer-grammars-full

vviewer 语法高亮的完整 grammar wasm 资产包：≥264 语言的 tree-sitter wasm
（tree-sitter-cli 0.27 自建，免 emcc，[wasi-sdk/binaryen 工具链]）+ helix 上游
查询继承 + manifest 清单。与 [web-tree-sitter](https://www.npmjs.com/package/web-tree-sitter)
运行时配套，按 manifest 懒加载；无需安装本包也可经 jsdelivr CDN 直接按版本引用。

## 布局契约

- `grammars/manifest.json` 与 `grammars/*.wasm` **同目录**（CDN base 必须以
  `/grammars/` 结尾）
- `queries/<lang>/{highlights,injections}.scm` 与 `grammars/` 为包根下兄弟目录
  （由 grammar base 推导：`/grammars/` → `/queries/`）
- vendored 语言（上游 C scanner，如 yaml）在 manifest 中以 `vendored` 标注
- 门禁口径：manifest 键数 ≥264

## CDN 引用

```text
https://cdn.jsdelivr.net/npm/@bhxch/vviewer-grammars-full@<版本>/grammars/
https://cdn.jsdelivr.net/npm/@bhxch/vviewer-grammars-full@<版本>/queries/
```

版本号内嵌于 URL（jsdelivr 精确版本钉死）；manifest 各条目自带 `base` 字段，
客户端按条目 base 解析 wasm 路径。

## 配套运行时

- [`@bhxch/vviewer-highlight`](https://www.npmjs.com/package/@bhxch/vviewer-highlight)：
  web-tree-sitter 高亮引擎 + capture→CSS 绑定核，`TreeSitterEngine.create({
  grammarsBase, queriesBase, runtimeDir })` 直接消费本包资产
- [`@bhxch/vviewer-markdown`](https://www.npmjs.com/package/@bhxch/vviewer-markdown)：
  markdown 完整渲染组合包，默认 grammar 来源即本包的 CDN 地址

## 仓库与许可

- 仓库：[bhxch/vviewer](https://github.com/bhxch/vviewer)，构建管线位于
  `tools/grammar-builder/`
- 许可：见包内 `GRAMMAR_LICENSES.md`（各上游语法仓库许可聚合）
