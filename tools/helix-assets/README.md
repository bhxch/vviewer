# helix-assets 生成器

从本机 helix-editor/helix 与 markpad-aio 的源资产生成 `packages/highlight/assets/` 下的三件资产：

| 产物 | 来源 | 说明 |
| --- | --- | --- |
| `languages.json` | markpad `src-tauri/languages.toml`（与 helix 同源，grammar 清单带验证过的 rev/subpath） | `Record<langName, { scope, injections?, fileTypes, globFileTypes?, shebangs, grammar, aliases? }>`；file-types 字符串为后缀、`{glob}` 归入 globFileTypes；grammar 缺省等于 name |
| `themes.json` | helix `runtime/themes/*.toml`（跳过 `theme.toml` 与 `base16_*.toml`） | `Record<themeName, Record<capture, { fg?, bg?, modifiers? }>>`；`[palette]` 命名色引用已内联；`inherits` 主题继承已展开（父在前，子按捕获覆盖） |
| `queries/` | markpad `src-tauri/queries/` | 原样拷贝（286 目录，含继承父目录如 `_typescript`），不改内容 |

## 用法

```bash
node tools/helix-assets/generate.mjs   # 或 pnpm --dir tools/helix-assets generate
```

可重复执行，产物幂等。两个 JSON 首行为生成头注释（`// Generated from ...`），解析时需剥离首行。

源路径可用环境变量覆盖：`VV_LANGUAGES_TOML`、`VV_QUERIES_DIR`、`VV_THEMES_DIR`、`VV_ASSETS_OUT`。

## 测试

```bash
pnpm vitest run tools/helix-assets/test/generate.test.ts
```
