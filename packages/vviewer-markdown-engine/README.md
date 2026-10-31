# @bhxch/vviewer-markdown-engine

markdown → HTML 引擎预设包：markdown-it GFM 全家装配（table/strikethrough 内建 +
tasklists/footnote/mark/ins/deflist 插件 + linkify、`html:true`）、GFM slug 标题锚
（`GfmAnchorizer` + heading_close 锚规则）、LaTeX 定界符前置保护
（`protectLatexDelimiters`）、front matter 定位解析（`parseFrontMatter`）。
面向任何 markdown-it 项目的即插预设。

## 安装

```bash
npm install @bhxch/vviewer-markdown-engine
```

## 公共导出面（`src/index.ts`）

| 符号 | 说明 |
| --- | --- |
| `createMarkdownEngine()` | 共享配置 markdown-it 实例（tasklist 复选框 disabled、删除线 `<del>` 覆写、标题尾置锚） |
| `renderMarkdownToHtml(src)` | markdown 源 → `{ html, frontMatter }`（模块级 `sharedEngine` 单例，语义随包保留） |
| `protectLatexDelimiters(text)` | `\(..\)`/`\[..\]` → `$..$`/`$$..$$`（围栏/行内码透传状态机） |
| `GfmAnchorizer` | GFM slug 基名 + comrak Anchorizer 同款去重（`reserve` 预占既有 id） |
| `parseFrontMatter(src)` | `---` YAML 块定位解析（失败/非映射返回 null 且原文整体渲染） |
| `MarkdownEngine` / `MarkdownRenderResult` / `FrontMatterResult` | 类型 |

## 双引擎指纹对齐协议（横切语义契约，禁止单边演进）

本包本地引擎与 Rust 服务端 comrak 渲染（`server/core/src/compute/markdown.rs`）构成
双引擎指纹对齐契约：同文档 remote/local 双引擎 DOM 指纹必须一致。已固化的对齐点：

- 删除线输出 `<del>`（markdown-it v13+ 默认 `<s>`，renderer rule 覆写回 comrak/GFM 形态）；
- 标题尾置空锚 `<a href="#user-content-{slug}" … class="anchor">`，slug 由
  `GfmAnchorizer` 按 comrak Anchorizer 同款算法生成（user-content- 前缀命名空间）；
- footnote / mark / ins / deflist / tasklist 扩展语法与 comrak 侧扩展对齐
  （等价面 = class + DOM 结构层，勿跨端互锚 id 形态）。

**协议面承诺：禁止单边演进**——任何一侧输出形态变更必须同步另一侧，并同批更新两侧
测试（本包 `test/markdownEngine.test.ts` ⇄ `server/core/src/compute/markdown.rs` tests）。

## 无类型插件的 ambient 垫片

markdown-it-task-lists / -footnote / -mark / -ins / -deflist 均无自带类型，垫片在
`src/types/*.d.ts`（`declare module`）。ambient 声明不随 import 图/exports 传播：
`src/engine.ts` 顶部以 `/// <reference path="./types/markdown-it-*.d.ts" />` 指令显式
收进消费方 program——跨包消费本包时五插件模块的声明即随该指令带入，消费方无需自备
垫片，垫片不可删、指令不可省。

## 发布注意（未来转公开发布时）

- monorepo 态 exports 指 `src/*.ts`（与仓库各包一致，当前 private 无构建）。
  转发布时 `tsc` emit 到 dist 不会拷贝 ambient d.ts：build script 需显式
  `cp src/types/*.d.ts dist/types/` 并把 dist/types 纳入 files 白名单——
  `/// reference` 的相对路径 `./types/…` 在 dist 层级（engine.d.ts 与 types/ 同级）
  自洽，无需改写。
- `engine.d.ts` 签名引用的 `MarkdownIt` 类型由 markdown-it 主包自带类型提供
  （其为本包 dependencies），消费方无需垫片。
- 依赖清单中 markdown-it + 五插件 + yaml 全量为运行时依赖（frontend 无 node 端独占
  依赖），license 均为 MIT/ISC，见仓库 `THIRD_PARTY_NOTICES.md`。

## 仓库与许可

- 仓库：[bhxch/vviewer](https://github.com/bhxch/vviewer)，源码位于 `packages/vviewer-markdown-engine/`
- 许可：Apache-2.0；第三方依赖许可见仓库 `THIRD_PARTY_NOTICES.md`
