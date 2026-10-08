# Markdown 与 HTML 文档渲染（M3） — e2e 场景

> 来源：`docs/e2e-test-report-2026-10-08.md`（被测版本 `main` @ `a47148114dd4962b1b32bcf3fe190702356fb3c8`）。本档为该报告 M3 域内容的忠实转写，不引入报告之外的行为声明。
> 证据目录：`.temp/e2e-artifacts/markdown-html-docs/`（16 张截图）、复核截图 `.temp/e2e-artifacts/verify/`（复核会话 `vv-verify-markdown-html-docs-MD-11`）。

## 1. 域描述与覆盖范围

本域验证 markdown 渲染管线（五步管线：GFM 表格/任务列表/callout/KaTeX/mermaid/front matter/围栏高亮）、TOC、代码块复制、图片灯箱、HTML 沙箱与净化、HTML 渲染/源码双视图、媒体链接增强。

报告第 4 节矩阵行原文摘录：

> markdown-html-docs｜13 测试点｜通过 12｜缺陷 1（0 fail / 1 partial）｜受阻 0｜**基本完整**｜五步管线（GFM 表格/任务列表/callout/KaTeX/mermaid/front matter/围栏高亮）、TOC 三断言、HTML 沙箱、源码/渲染双视图全部通过；唯一缺陷 MD-11 外部图片外泄网络请求（BUG-17，隐私类）。围栏高亮走 hljs 兜底现象归属 BUG-06

通过/缺陷情况：

- **12 pass / 1 partial**：MD-01~MD-10、MD-12、MD-13 均 pass；仅 MD-11（危险 HTML 净化）为 partial，对应唯一缺陷 **BUG-17**（medium · verified，外部 http 图片仍被浏览器实际发起 GET 请求，跟踪像素可回传访客 IP）。
- **跨域现象归属**：MD-05 实测 rust 围栏由 hljs 兜底着色（`language-rust hljs` + 8 span），该现象归属 **BUG-06**（本地 tree-sitter wasm 主路径整链失效，主体在 code-highlight-degrade / pwa-mobile-performance 域）；MD-05 测试点本身判 pass（降级链下游着色正确）。
- **已裁决偏差（不计缺陷）**：偏差 #1——HTML 沙箱实现为 `sandbox="allow-same-origin"`（无 allow-scripts）而非 opaque origin；脚本执行维度安全等价、父页面可读 contentDocument。涉及 MD-10。
- 报告 6 节：仓库自带 Playwright 套件的 m3 项（markdown 渲染与搜索）通过，与本域黑盒结论互相印证。

## 2. 场景清单

统一前置：vviewer 主实例已启动（`vviewer serve --root .temp/e2e-data --web-dist apps/web/build --port 8391 --compute`，报告 2.2 节），浏览器已连接服务器并加载文件树。编号沿用报告测试点编号（MD-01~MD-13，报告无缺号，无需续编）。

| 编号 | 前置条件 | 步骤 | 期望 | 关联缺陷 |
| --- | --- | --- | --- | --- |
| MD-01 | 数据集含 `samples/m3/demo.md`（含 GFM 表格、任务列表、删除线） | 1) 文件树点击 demo.md 打开渲染视图；2) 检查表格是否渲染为 HTML 表格；3) 检查任务列表 checkbox 数量与可交互性；4) 检查删除线文本元素 | 表格渲染为 HTML 表格（报告实测 ×1）；任务列表渲染 2 个 checkbox 且均为 disabled（不可勾选）；删除线文本渲染为 `del` 元素（视觉删除线）；无错误卡片 | — |
| MD-02 | 打开含多种类型 callout（≥6 种，含 caution 与未知类型）的 markdown 文件 | 1) 打开渲染视图；2) 逐个检查 callout 卡片的类型标识与边框颜色；3) 检查未知类型 callout 的兜底表现 | 各已知类型 callout 渲染为带类型色边框的卡片（报告实测 5 类型 + caution 各异色边，共 6 种）；未知类型以灰色兜底样式渲染，应用不崩 | — |
| MD-03 | 打开含行内与块级数学公式的 markdown；另备含非法公式的样例 | 1) 打开渲染视图，检查 `.katex` 元素数量；2) 打开含非法公式的样例，检查非法公式处理与页面状态 | 行内 + 块级公式均渲染（报告实测 `.katex`×2）；非法公式以原文保留显示，应用不崩溃 | — |
| MD-04 | 打开含合法 mermaid 块的 markdown；另备含非法 mermaid 块的样例 | 1) 打开渲染视图，检查 mermaid 块渲染产物；2) 打开含非法 mermaid 块的样例，检查其呈现与后续管线（代码块复制按钮）是否可用 | 合法块渲染为 `svg.flowchart`；非法块以错误样式呈现、不崩溃，且不阻塞后续管线（复制按钮不受阻） | — |
| MD-05 | 已执行 `pnpm gen:grammars`（偏差 #10 强制前置）；打开含 rust 围栏代码块的 markdown | 1) 打开渲染视图；2) 检查围栏代码块 `pre code` 的 className 与内部语法着色 span | 围栏代码块获得语法着色：报告实测 `language-rust hljs` + 8 个 hljs span；渲染管线不出错。tree-sitter 未生效的现象归属 BUG-06 | BUG-06（现象归属；本测试点判 pass） |
| MD-06 | 打开带 YAML front matter 的 markdown；另备 front matter 非法（不合语法）的样例 | 1) 打开渲染视图，检查正文是否出现 front matter 元数据；2) 打开非法样例，检查渲染结果与页面状态 | front matter 元数据不出现在渲染正文；front matter 非法时按原文渲染，应用不崩溃 | — |
| MD-07 | 打开含 h1–h4 多级标题的 markdown（报告实测 TOC 9 项；报告未点名载体文件，可复用 demo.md 或按第 4 节说明构造） | 1) 数右侧 TOC 项数，与正文各标题逐项对照；2) 点击任一 TOC 项，读取滚动位置变化；3) 滚动正文，观察 TOC active 高亮是否跟随 | TOC 项数与正文 h1–h4 标题一致（实测 9 项）；点击 TOC 项滚动至对应标题（实测 scrollTop 0→1623）；滚动时 active 高亮随视口所在章节跟随 | — |
| MD-08 | 打开含代码块的 markdown（报告实测代码块 98 字符） | 1) hook `navigator.clipboard.writeText`；2) 点击代码块的复制按钮；3) 读取捕获的写入内容，与对应代码块 `textContent`（去尾部换行）比对 | writeText 被调用，写入内容与对应代码块 textContent 去尾换行后逐字符一致（报告实测 98 字符吻合） | — |
| MD-09 | 打开含图片的 markdown 渲染视图 | 1) 点击图片，检查灯箱 overlay 打开；2) 按 Esc 关闭；3) 再次点开，点击遮罩关闭 | 灯箱打开；Esc 与点击遮罩两条关闭路径均生效（报告实测开/关三路径全部通过） | — |
| MD-10 | 数据集含 `samples/m3/page.html` | 1) 文件树点击 page.html 打开渲染视图；2) eval 读 iframe 的 sandbox 属性；3) 经 contentDocument 统计 script 元素与 on* 属性；4) 检查行内样式是否保留 | iframe 带 sandbox 属性且不含 allow-scripts（报告实测 `sandbox="allow-same-origin"`，形态为偏差 #1 已裁决项：脚本执行维度安全等价、父页面可读 contentDocument）；内联脚本不执行（实测 script 统计 0）；行内样式保留 | —（沙箱形态见偏差 #1） |
| MD-11 | 打开含内联 script、on* 事件属性、`javascript:` 链接、外部 http 图片（带 onerror）与外链 https 的危险 HTML（报告复现步骤中的 danger.html，构造方式见第 4 节） | 1) 打开渲染视图；2) eval 读 iframe.contentDocument，统计 script 元素数、on* 属性数、hrefs、imgSrc；3) 检查正文是否出现 alert 文本；4) 检查 network requests 中是否有对外请求（检索 external.example）；5) 清空网络日志后重开文件二次验证 | 脚本/事件属性/`javascript:` 净化（script=0、on* 属性=0、`javascript:` href 被移除、正文无 alert 文本）；外部资源不发起任何网络加载。当前实测：script/on*/javascript: 净化达标，但 `img src=http://external.example.com/track.png` 保留在 DOM 且浏览器实际发起 GET，本点判 partial | BUG-17 |
| MD-12 | 数据集含 `samples/m3/page.html` | 1) 打开 page.html；2) 切「源码」视图，按 / 搜索标签名，观察命中计数与行高亮；3) 切回渲染视图重复搜索，观察结果 | 渲染/源码双视图可切换且内容完整；源码视图中 / 搜索命中计数正确（报告实测 1/7→2/7）且当前命中行高亮。报告记录的 low 瑕疵：渲染视图中搜索恒无结果（未单列缺陷编号） | —（渲染视图搜索无结果为报告已记录的 low 瑕疵） |
| MD-13 | 打开含指向 `.mp4`/`.mp3` 链接的 markdown 渲染视图 | 1) 定位正文中的媒体链接；2) 检查其渲染形态；3) 检查原链接是否仍以 `a` 元素存在 | `.mp4`/`.mp3` 链接渲染为内联 video/audio controls 占位；原链接不再以 `a` 元素存在 | — |

## 3. 关联缺陷的验收行为

### BUG-17【medium · verified】markdown/HTML 渲染视图中外部 http 图片仍被浏览器实际发起 GET 请求

**缺陷现状**（报告第 5 节证据）：

- 涉及域 markdown-html-docs，对应测试点 MD-11（单点）。高危向量全部达标：script=0、on* 属性=0、`javascript:` href 被移除、正文无 alert 文本。
- 但 `img src=http://external.example.com/track.png` 保留在 DOM，且浏览器实际发起 GET (Image)，紧跟该页 `/api/file` 请求之后；清空网络日志后重开文件二次复现。
- 对照组：with-script.html 的外链脚本无任何 cdn 请求（外链脚本维度当前已达标）。
- 复核会话 `vv-verify-markdown-html-docs-MD-11` 独立复现，统计结果与报告完全一致（`md11-danger-dom.png`）；external.example.com 为不可解析保留域名、DNS 失败无状态码，不影响「请求被浏览器实际发起」的结论。
- 仲裁备注：medium——脚本执行/事件导航等高危向量已正确阻断，残余为图片类隐私外泄（跟踪像素可回传访客 IP），非崩溃/核心不可用/错误结果。

**修复后应有行为**（回归验收判据）：

1. 重复 MD-11 场景：净化后 DOM 中不存在可发起外部加载的图片资源——外部 http(s) 图片的原始 src 不保留（或被替换为不可加载占位）；network requests 检索 `external.example` 零命中。
2. 清空网络日志后重新打开同一文件，二次复验仍零命中（覆盖报告所测的重开路径）。
3. 高危向量不回退：script 元素数=0、on* 属性数=0、`javascript:` href 仍被移除、正文无 alert 文本。
4. 外部脚本仍不发起网络加载（with-script.html 对照：无 cdn 请求），与报告现行达标项一致。

### BUG-06【medium · verified】本地 tree-sitter wasm 主路径完全失效（本域关联现象：MD-05 围栏走 hljs 兜底）

**缺陷现状**（报告第 4 节矩阵行、第 5 节 BUG-06、附录 8.4 MD-05）：

- BUG-06 主体归属 code-highlight-degrade 与 pwa-mobile-performance（HL-01 + HL-10 + PWA-03 合并）；报告矩阵明确本域「围栏高亮走 hljs 兜底现象归属 BUG-06」，MD-05 实测 rust 围栏仅获得 `language-rust hljs` + 8 span。
- 根因摘录：自动与本地策略下前端运行时从不请求/消费 grammar wasm（全会话零 `.wasm` 网络请求、仅 manifest fetch、manifest 34 项 abi 全 null、`vv-grammars-*` 运行时缓存从未创建），仅「远程」策略经 `POST /api/compute/highlight` 获得 tree-sitter（rs=98 个 ts-* span）。HL-05/HL-01 复核数值：自动/本地/远程三策略 ts-* span 为 0/0/98。

**修复后应有行为**（对本域场景的回归验收判据，取自 BUG-06「期望」字段）：

1. 自动/本地策略下打开含 rust 围栏的 markdown，围栏代码块获得 tree-sitter 高亮（`pre code` 内出现 ts-* span，数量 > 0），而非仅 hljs 兜底。
2. 打开过程网络层出现 grammar wasm 按需 fetch，并按 CacheFirst 写入 `vv-grammars-*` 运行时缓存。
3. 断网后重新渲染含围栏 markdown，仍可 tree-sitter 高亮（缓存命中）。

> 注：本节仅覆盖该缺陷在本域场景的验收面；完整验收（sample.rs 独立文件、9 语言缓存矩阵、离线打开代码文件等）见 code-highlight-degrade 域场景文档。

## 4. 测试数据与边界

**运行前置**（报告 2.1/2.2 节）：

- grammar wasm 资产不入库，测试/复测前必须先执行 `pnpm gen:grammars`（偏差 #10；本域仅 MD-05/BUG-06 验收直接依赖）。
- 主实例：`vviewer serve --root .temp/e2e-data --web-dist apps/web/build --port 8391 --compute`。

**本域直接载体文件**：

| 文件 | 用途 | 说明 |
| --- | --- | --- |
| `samples/m3/demo.md` | MD-01 明确使用；MD-02~MD-08 报告未逐一指认载体文件名 | 报告数据集表列 m3 含 demo.md。MD-02~08 的证据摘要给出了门槛数值（callout 6 类、`.katex`×2、TOC 9 项、98 字符代码块）；若复用 demo.md 而其不含相应元素，按下方构造方式补造对应元素后复测 |
| `samples/m3/page.html` | MD-10（沙箱）、MD-12（源码/渲染双视图） | 报告数据集表列 m3 含 page.html |
| `danger.html` | MD-11 / BUG-17 | 报告复现步骤给出内容构成：内联 script、外部 http 图片（带 onerror，`src=http://external.example.com/track.png`）、`javascript:` 链接、外链 https。报告未单独给出该文件路径；按报告 2.3 惯例属各域另造样例（存于 `.temp/e2e-data/domain-<域名>/`），复测时按上述构成自造即可 |
| `with-script.html` | BUG-17 中的对照件 | 数据集文件（内联 + 外链 script），用于验证外链脚本不发起网络加载 |

**数据集中的相关文件**（报告 2.3 节，本域场景未直接使用，列出避免误读）：`with-event-attrs.html`（on* 属性 + `javascript:` 链接，可作 MD-11 危险向量的素材基础）、`deep-quotes.md`（12 层嵌套 blockquote，用于 PWA-05 移动端流程）。

**非法输入构造**：MD-03/MD-04/MD-06 的非法样例（非法公式、非法 mermaid 块、非法 YAML front matter）为本轮各域另造样例，报告未给出文件名（证据 `md03-math-invalid.png`、`md04-mermaid-bad.png`、`md06-front-matter-invalid.png`）；复测时在 md 文件内嵌入对应类型的非法内容即可，判据以场景期望为准（原文保留 / 错误样式 / 原文渲染，均不崩溃且不阻塞管线）。

**边界与注意事项**：

- `external.example.com` 为不可解析保留域名，请求 DNS 失败、无状态码；验收判据是「请求被浏览器实际发起」（网络层出现该 GET，且时序上紧跟该页 `/api/file` 请求之后），不是响应状态码。
- 沙箱形态（偏差 #1，已裁决不计缺陷）：实现为 `sandbox="allow-same-origin"`（无 allow-scripts）而非 opaque origin，父页面可读 iframe.contentDocument——MD-10/MD-11 的 eval 统计手法依赖该形态。
- MD-05 的判 pass 口径：hljs 兜底属预期降级链下游；本地 tree-sitter 未生效不在此重复计缺陷，验收归属 BUG-06（见第 3 节）。
