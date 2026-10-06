# helix-assets 生成器

从本机 helix-editor/helix 与 markpad-aio 的源资产生成 `packages/highlight/assets/` 下的三件资产：

| 产物 | 来源 | 说明 |
| --- | --- | --- |
| `languages.json` | markpad `src-tauri/languages.toml`（与 helix 同源，grammar 清单带验证过的 rev/subpath） | `Record<langName, { scope, injections?, fileTypes, globFileTypes?, shebangs, grammar, aliases? }>`；file-types 字符串为后缀、`{glob}` 归入 globFileTypes；grammar 缺省等于 name |
| `themes.json` | helix `runtime/themes/*.toml`（跳过 `theme.toml` 与 `base16_*.toml`） | `Record<themeName, Record<capture, { fg?, bg?, modifiers? }>>`；色名引用按 helix 语义解析（内置 ANSI 表 → `inherits` 父主题 palette 递归 → 本主题 palette，未命中的字段丢弃），所有 fg/bg 统一为 6 位 `#rrggbb`；主题 `inherits` 样式继承已展开（父在前，子按捕获覆盖） |
| `queries/` | markpad `src-tauri/queries/` | 原样拷贝（286 目录，含继承父目录如 `_typescript`），不改内容 |

## 用法

```bash
node tools/helix-assets/generate.mjs   # 或 pnpm --dir tools/helix-assets generate
```

可重复执行，产物幂等。两个 JSON 均为纯 JSON，可直接 `import x from '*.json'`。

源路径可用环境变量覆盖：`VV_LANGUAGES_TOML`、`VV_QUERIES_DIR`、`VV_THEMES_DIR`、`VV_ASSETS_OUT`。

## 测试

```bash
pnpm vitest run tools/helix-assets/test/generate.test.ts
```
