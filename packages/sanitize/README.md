# @vviewer/sanitize

不可信渲染 HTML 的唯一净化出口：DOMPurify（^3.4.16）强化净化预设——URI 白名单、
`data:` 按属性收窄、外域加载向量拦截、服务端图表 SVG 片段净化。所有不可信渲染
HTML 必须经本包出口进入 DOM，调用方不得各自直连 DOMPurify 或另设净化规则。

## 导出面

| 导出 | 用途 | 既有消费点 |
| --- | --- | --- |
| `sanitizeHtml(dirty, opts?)` | 片段/整文档净化，string 与 Document 输入统一返回字符串 | render-doc `docx.ts`、render-text `markdownRenderer.ts` / `html.ts` |
| `sanitizeDiagramFragment(root, html, opts?)` | 服务端图表 SVG 片段承接：契约壳包裹 → 净化 → 剥壳 | render-text `pipeline.ts`（server 模式与 krokiVia=server 两分支） |
| `isExternalMediaSrc(src)` | 外域加载源判定（http(s) 与协议相对） | render-text `enrich.ts` 媒体替换守卫 |
| `hostOf(url)` | URL host 提示文本（解析失败回落原串） | render-text `enrich.ts` |
| `ALLOWED_URI_REGEXP` | URI 白名单正则（html 渲染器二层复核共用同一正则） | render-text `html.ts` |
| `MARKDOWN_SANITIZE_CONFIG` | DOMPurify 基础 config（FORBID_TAGS meta、ALLOW_DATA_ATTR、ALLOWED_URI_REGEXP） | — |
| `SanitizeOptions` / `ServerDiagramContract` | 选项与契约类型 | — |

## 选项（SanitizeOptions）

- `wholeDocument`：净化整份 HTML 文档（html/head/body 进允许表），html 渲染器
  srcdoc 用。此时输入必须是完整文档字符串（Document 输入会丢 head）。
- `serverDiagram`：服务端图表容器契约，style 豁免钩子按「净化串内祖先节点带
  `attr` 属性且取值为 `value`」识别豁免容器。默认 `data-vv-diagram="server"`——
  与 server 端 `compute/diagrams.rs` 及 render-text `wrapServerDiagrams` 的产出
  契约逐字一致，既有消费方零改动。自定义时 `sanitizeDiagramFragment` 的壳属性
  与钩子识别同源取自该契约，字面量不会在壳/钩两处漂移。

## 钩子为模块级惰性注册状态——多实例/多配置语义（必读）

- 两枚钩子（`uponSanitizeElement` 的 style 上下文二分、`afterSanitizeAttributes`
  的 data: 收窄与外域向量复核）在**首次 `sanitizeHtml` 调用时**注册到 dompurify
  默认导出的单例实例上，进程内一次性（幂等闸）。模块顶层不触 DOMPurify——
  SSR/Node 下默认导出是未绑定 window 的工厂（无 `addHook`/`sanitize`），顶层
  调用会让 SvelteKit SSR 求值直接 500。
- 因此本包**没有按调用隔离的多实例**：同一模块图内所有净化调用共享同一套钩子，
  钩子只注册一次。按调用的差异只能经 config 传递——`wholeDocument` 与
  `serverDiagram` 契约均随当次 sanitize 的 config 走（契约经 DOMPurify 钩子第 3
  参 CONFIG 读回；3.4.16 实测 `_parseConfig` 对传入 config 全量 clone 保留自有
  键、`_executeHooks` 把当次 CONFIG 原样传给钩子），钩子侧不持模块级可变状态，
  无跨调用串扰残留。
- 若同进程另行 `DOMPurify(window)` 工厂建第二实例，本包钩子不会注册其上——
  必须统一经本包出口净化，或自行对新实例 addHook（不建议，会绕开本包策略）。
- 多配置并存的正确姿势：每次调用带上各自的 `SanitizeOptions`；不要用
  `DOMPurify.setConfig`/`clearConfig` 改全局状态（会与本包的按调用 config 语义
  叠加出意外）。

## 迁移注记

自 `packages/render-text/src/markdown/sanitize.ts` 迁入（零内部依赖、仅
dompurify）。过渡期原位置保留，render-text 内部消费方与 render-doc 改指
`@vviewer/sanitize` 后移除原位置与 render-text 的 `./sanitize` 子路径导出。
