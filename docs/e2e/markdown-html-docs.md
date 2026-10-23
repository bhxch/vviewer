# Markdown 与 HTML 文档渲染（M3） — e2e 场景

> 来源：`docs/report/e2e/e2e-test-report-2026-10-08.md`（被测版本 `main` @ `a47148114dd4962b1b32bcf3fe190702356fb3c8`）。本档为该报告 M3 域内容的忠实转写，不引入报告之外的行为声明。
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

## 5. syntax-deep 补强场景（SY-01~SY-11，2026-10-22 第二轮 default 套件）

扩展语法（KaTeX 与扩展语法域）的负路径、边界与组合交互补强，载体 `apps/web/e2e/b-syntax-deep.spec.ts`。与第 2 节分工：MD-02/MD-03/MD-08 及 b-md-syntax 已锚 happy path，本表只补缺口；夹具全部 spec 内联构造（不落 samples/，避免扰动 b-md-syntax 依赖 `samples/md/syntax-sampler.md` 的计数断言环境）。通道与 b-md-syntax 组一致（injectDir + openTreeFile，chromium/mobile 双 project）。时序契约：renderMarkdown 全管线 await 完成才挂载，`.vv-markdown` 可见即 enrich + 五步管线就绪，计数 0 断言无假绿窗口。

| 编号 | 场景 | 期望（用户可见结果） | 契约依据 |
| --- | --- | --- | --- |
| SY-01 | callout 折叠后缀保守解析：`[!note]+x`（后缀非空白）与 `[!note] -5 度`（正文负号） | 均仍转 note 卡片但不带 foldable/collapsed，原文留在标题；点击标题无折叠切换（内容恒可见） | enrich convertCallouts 折叠后缀须 `]` 后隔空白紧跟 `+`/`-` 且后随空白/行尾，未知写法从保守 |
| SY-02 | 未知类型 callout 兜底（MD-02 折叠组合面）：`[!custom]` 空标题 | 转 `.markdown-alert-custom` 卡片、标题回退类型大写名 `Custom`、内容区正文完好、应用不崩 | enrich 未知类型仍转卡片（默认样式类 + 大写名回退） |
| SY-03 | 折叠方向与多卡独立：`[!warning]+` 默认展开可点击收起再展开；相邻 `[!tip]-` 保持收起 | + 卡初始展开 → 点击收起 → 再点复原；- 卡全程收起不受牵连（toggle 只作用自身卡片容器） | enrich 标题 click 监听按 container 切换 collapsed |
| SY-04 | 折叠 callout 标题内 wikilink 锚跳组合：`> [!note]- 折叠标题含 [[#落点]]` | 标题内 `[[#落点]]` 同获改写为 a（href 经 remapHeadingHashLinks 收口 `#user-content-落点`）；点击按链接语义导航（hash 变化 + 落点 heading 入视口）且折叠态保持（不触发标题折叠切换） | enrich 先 callout 后 wikilink 的注册顺序 + 标题 click 对 `closest('a')` 的豁免 |
| SY-05 | wikilink 上下文混排：列表项 `[[#列表落点]]` 可点；引用块内 `[[Ref.md]]` 降级；已有链接文本内 `[[#内部]]` 字面 | 列表内 a[data-wikilink] href 收口前缀且点击入视口；引用块内 `.md-wikilink-dead`（title「跨文件 wikilink 不支持」）且块内无 a；链接内字面保留不嵌套造链接（A 祖先豁免） | enrich convertWikilinks 跳过 PRE/CODE/SCRIPT/STYLE/A 祖先 + 降级 span title 注记 |
| SY-06 | 空行内脚注边界：`前^[]后 与 前^[ ]后` | 照产 sup.footnote-ref（[1]/[2] 并轨编号）+ section.footnotes 两个空尾注条目（仅回链，`^[]` 字面不泄漏）——markdown-it-footnote 4.0 内建现状，与 comrak 字面形态的双端分歧按 vitest 等价面口径各锁现状 | markdownEngine.test「空内容 ^[]」探针的 e2e 面 |
| SY-07 | 金额 $ 与转义 \$ 不触发公式：`$100 与 $200`、`成本 \$5。` 与真公式 `$E = mc^2$` 同段 | 金额字面全部可见（开/闭定界符紧邻空白不配对）；`\$` 转义消费为字面 `$`；全文恰一处行内 .katex、无 display 形态 | pipeline scanMathSegments 行内定界符空白规则 |
| SY-08 | mhchem 块级组合 + 非法段：`$$\ce{SO4^2- + Ba^2+ -> BaSO4 v}$$`、`\[ \ce{2H2 + O2 -> 2H2O} \]`、`$\frac{1}{2$` | 双形态各产 .katex-display（`\[..\]` 经 protectLatexDelimiters 改写为 $$ 词汇）；非法公式整段原文保留、同文档合法段照常、不崩；`.katex` computed font-family 含 KaTeX（katex.min.css 动态加载排印生效，0d767ae） | pipeline katex 步 throwOnError 单节点容错 + katex.min.css 惰性加载 |
| SY-09 | 代码豁免面组合：```text 围栏内 `==高亮==`/`[[#锚]]`/`$E=mc^2$`/`> [!note]-`/`\[ 非数学 \]` + 行内码同款 | 围栏与行内码内全部字面保留；文档级 mark/[data-wikilink]/.markdown-alert/.katex 计数全零；徽标取围栏原始语言 `text` | protectLatexDelimiters fence 透传 + enrich/katex 的 PRE/CODE 祖先跳过 |
| SY-10 | 无语言代码块徽标与复制（MD-08 无语言变体，154c0c1 顶栏迁移后回归）：``` 无语言围栏 | 徽标显示「代码」（data-md-lang 空串回退，hljs 侦测类不污染取词源）；复制钮 hook clipboard.writeText，写入内容与 code textContent 去尾换行逐字符一致，反馈「已复制」 | pipeline copyCode 徽标取词源 data-md-lang + 复制语义 |
| SY-11 | CRLF 回归锚：全 `\r\n` 行距文档含 `\[ E = h\nu \]` 块级、```rust 围栏、围栏后 `\(\alpha\)` 行内 | 围栏正常闭合（rust 徽标在、代码不含围栏后行）；围栏后行内数学渲染（全文 .katex×2、display×1）；首行标题完好——修复前 `\r` 卡死闭围栏判定会吞掉后半文档 | protectLatexDelimiters 入口 `\r\n?→\n` 归一化（1b3f43d 服务端对偶同语义的前端回归锚） |

> 注：SY-08 的 katex 步容错是「文本节点」粒度——同一节点内合法与非法公式混排时合法部分一并保留原文（scanMathSegments 分段后整体 try/catch）；场景构造按独立段落规避，该粒度属设计内行为不计缺陷。

## 6. lightbox-export-deep 补强场景（LE-01~LE-12，2026-10-22 第三轮 default 套件）

灯箱与导出域的边界、负路径、组合交互与性能锚补强，载体 `apps/web/e2e/b-md-lightbox-export-deep.spec.ts`。与第 2 节及 b-md-lightbox / b-md-export 主路径分工：开-导航-关、缩放步进、平移、导出内容全断言、句柄门控（txt）、PDF iframe 模板已锚，本表只补缺口（5-2/5-4/5-5 修复面的 e2e 锚、a11y 基线、限幅边界、kroki img 画廊、T1 关闭语义负路径、移动端按钮链、媒体组合、暗色导出、非 markdown 视图族、时长锚）。夹具全部 spec 内联构造（同第 5 节惯例，不新增 samples/，既有采样经 readFileSync 复用不修改）；kroki 场景 settings 直写 krokiHost + page.route 伺服（b-md-diagrams 同款通道）。

| 编号 | 场景 | 期望（用户可见结果） | 契约依据 |
| --- | --- | --- | --- |
| LE-01 | 同 src 元素身份定位：两张同 src 图点第二张/第一张 | 点第二张开 2/2、点第一张开 1/2（修复前按 src 查找恒 0，两图都开成 1/2） | lightbox openLightbox 元素引用 findIndex（itemEls 副表，5-5） |
| LE-02 | 图表 svg 点击直开灯箱 | 点 `.md-diagram-view svg` 直开、计数 4/4 落末位、svg 宿主显示、img 克隆隐藏 | runLightbox 对 svg 同款接线（5-4，画廊共集） |
| LE-03 | 输入守卫：raw HTML `<input>` 聚焦按 Esc/←→ | overlay 不关、计数不变；焦点移出后 Esc 恢复关闭 | lightbox onKey 输入控件直通守卫（5-2） |
| LE-04 | a11y 基线：对话框语义与焦点管理 | role=dialog、aria-modal=true、开启后 activeElement=overlay、计数 aria-live=polite、Esc 关闭时对触发图调用 focus()（原型包装 spy，img 无 tabindex 不可经 activeElement 观察） | buildOverlay 5-3 基线 + removeLightboxOverlay 焦点还原 |
| LE-05 | 缩放限幅边界：+ 连按/− 连按/=/f/滚轮 | + ×10 顶格 scale(8) 后不再增长、− ×17 底格 scale(0.2) 后不再缩小、= 同 +、f 复位 1:1、滚轮上/下放大缩小 | clampZoom(0.2–8) + ZOOM_STEP 键盘/滚轮同规 |
| LE-06 | kroki img 形态画廊条目导航 | 画廊 2 条（本地图 + kroki img），next 到 kroki 条目且克隆 src 为 kroki URL | collectGallery 收所有 img（含 .md-diagram-view 内），kroki img 管线后置创建不经净化拦截 |
| LE-07 | 点击关闭语义负路径 | 点克隆图/next/放大钮均不关（控制件生效），点 stage 空白关 | overlay click 仅 target=overlay/stage 关（T1 裁决） |
| LE-08 | 灯箱全按钮链（移动端触达基准） | next 三步到图表条目、放大钮 scale(1.25)、重置钮 1:1、关闭钮摘除 overlay，全程无键盘 | bar 按钮组 aria-label（上一张/下一张/放大/缩小/重置视图/关闭） |
| LE-09 | 媒体占位组合：不入画廊 + 单张收敛 + 导出降级 | video/audio 占位不进画廊（唯一 img 单张：prev/next/count 全 hidden、计数仍 1/1）；导出产物无 video/audio、媒体降级为源地址超链接（文本取 aria-label）、图片 data URI 保留 | enrich 媒体替换 + collectGallery 仅 img/svg + demoteMediaToLinks（MD-13 导出面，spec 非目标项行为锚） |
| LE-10 | 暗色主题导出 WYSIWYG | 亮色导出根双标 light；设置中心切暗后导出根双标 dark（data-vv-mode + data-theme-mode），主题变量定义形态注入恒在，KaTeX 20 woff2 两段均嵌 | stampMode 双属性（8b7732a 暗色提权回归）+ currentStyleCss 注入链 |
| LE-11 | 非 markdown 视图族句柄清空 | 图片 tab / 二进制 hex tab 下 `.meta-export` 消失，切回 markdown 两钮恢复（既有覆盖仅 txt） | ViewerPane cleanup setExportHandle(null) 对全部非 markdown 渲染器生效 |
| LE-12 | 大文档导出时长锚（chromium-only，桌面基准） | 150 段落 + 20 围栏 + 8 公式 + 5 图，管线就绪后导出 60s 内完成、文件名 `<原名>.html` | collectExportHtml 装配链数量级退化防线（克隆/内联/KaTeX 排印）；上限为实测宽裕倍数，CI 负载波动不假红 |

> 注：LE-04 的焦点还原断言经 `HTMLElement/SVGElement.prototype.focus` 包装 spy（addInitScript 应用脚本前注册），属观察装置不改产品行为；LE-05 限幅按当前值倍乘后钳制的实现口径，按键次数（10/17）按 1.25/0.8 幂精确推得，顶格/底格后各再按一次锚「输入被钳制」而非中间值。LE-12 仅 chromium project（性能锚桌面基准，TA-02 惯例，mobile 同断言无增量信息）。

## 7. corpus-markpad 真实语料批量渲染补强场景（MC-01~MC-36，2026-10-22 第四轮 default 套件）

全新测试维度：以 bhxch/Markpad 公开仓 27 个真实 md 文件（`tools/fetch-e2e-corpus.mjs` 下载至 `apps/web/e2e/fixtures/markpad-md/`，清单与 sha256 见该目录 `manifest.json`；个别文件缺失时逐用例 `fs.existsSync` 容错 skip）驱动渲染管线的稳定性与功能覆盖。载体 `apps/web/e2e/b-md-corpus-markpad.spec.ts`。规模口径：手写场景 9 个（MC-28~MC-36）；MC-01~MC-27 为域特殊设计要求的 for..of 逐文件程序化生成，每例只打开 1 个文件。注入通道与第 5/6 节一致（injectDir + openTreeFile），语料以 `readFileSync` 原始字节 → base64 注入（`TextFileSpec.b64` 直通绕过 utf-8 编码——samples/encoding-* 为 GBK/Shift-JIS/CP1252 非 UTF-8 文件，解码属产品编码层职责）；树内按 basename 拍平（27 个已核对唯一）。时序契约：`target.classList.add('vv-markdown')` 在管线完成后、`replaceChildren` 挂载前才加（markdownRenderer.ts:520），旧实例 destroy 即清空容器（:448）——`.vv-markdown` 可见即本文件挂载完成，逐文件打开无假绿窗口。kroki 环境无关化用 fulfill 而非 abort（不产生资源级 console error 污染汇总锚断言面；abort 的降级源码面板形态已由 b-md-diagrams 覆盖）。

| 编号 | 场景 | 期望（用户可见结果） | 契约依据 |
| --- | --- | --- | --- |
| MC-01~MC-27 | 批量组：27 个真实语料逐文件打开渲染（最大 121KB stress-test） | `.vv-markdown` 可见（含 4 个非 UTF-8 编码文件——替换字符不阻断管线）；全程零 pageerror；零错误卡（语料全部 < 20MB MARKUP_MAX_BYTES，code.ts:74） | 渲染管线稳定性锚，断言只锚稳定性不锚语料内容；断言红即语料触发降级，交分诊不放宽 |
| MC-28 | all_languages_test.md 多语言围栏高亮批量面（282 个带语言围栏，ada→zig；dot/latex/mermaid 各 1 走图表通道） | `pre code` 恰 279 + `.md-diagram` 恰 3；bash 围栏徽标 `md-code-lang`=bash 且块内有着色 span（tree-sitter 命中或 hljs 兜底均算，MD-05 判据不锚引擎） | 语料 sha 锚定于 manifest 的结构计数 + highlight 步 data-md-lang 徽标契约 |
| MC-29 | demo_features.md 本地图表矩阵四引擎 + kroki 兜底 + front matter 剥离 | front matter（author 值 Markpad Team）不泄漏进正文；12 图表围栏（latex 为 math 注册表别名）→ 12 `.md-diagram`；svg 共 6 = 图形引擎 3（mermaid/graphviz-dot/nomnoml）+ math 通道装饰 svg 3；kroki 型 6 个全部出 img（fulfill svg）；全文 katex-display 恰 7（正文 4 + diagram-view 内 math 通道 3）；csharp 围栏、rust 徽标照常 | diagrams.ts 注册表（dot=graphviz 别名、latex=math 别名、本地启用集）+ MD-06 front matter 剥离判据 |
| MC-30 | testfile.md GFM 全家桶 | 五种 callout（note/tip/important/warning/caution）各 1；任务列表 3 checkbox 前 2 勾选且全 disabled；表格 1 张 3 行；删除线 del×1；rust/javascript/python 围栏各 1；行内+块级公式各 1（.katex×2、display×1） | enrich convertCallouts 类型小写归一 + MD-01 表格/任务列表/删除线判据 |
| MC-31 | stress-test.md 121KB 大文档完整性 | 脚注 sup.footnote-ref×4 编组进 section.footnotes（li×3）；`pre code` 恰 72（markdown-it fence token 权威口径：74 围栏 = 60 text + 11 语言 + 3 mermaid，后者走图表通道，另有 1 个 4 空格缩进代码块）；`.md-diagram`×3 全出本地 mermaid svg；表格 ≥5（下限锚，609 个 \| 行拆数十张，精确数无行为价值） | markdown-it-footnote 编组 + diagrams 本地渲染 + 大输入不截断 |
| MC-32 | markdown-syntax.md wikilink 分流与脚注 | 跨文件 wikilink×2（`[[stress-test#…]]` 裸语法）降级 span.md-wikilink-dead；页内锚 wikilink×2（`[[#…]]`/`[[#^…]]`）转 a[data-wikilink]；行内码/表格内同款字样豁免；脚注 [^ref]×2 + ^[inline]×1 → sup×3 编组 li×2；mermaid×4 全出 svg | enrich convertWikilinks 的 A/PRE/CODE 祖先豁免 + 锚型/跨文件分流（SY-05 同源契约） |
| MC-33 | encoding-gbk.md 非 UTF-8 语料稳定性 | GBK 原始字节注入后渲染容器就绪、正文列表结构可见、零 pageerror、零错误卡（产品无编码标注 UI 的稳定契约锚点，只锚稳定性） | 注入层字节无损（b64 直通）+ 渲染管线对非 UTF-8 输入不崩 |
| MC-34~MC-36 | 汇总锚：整批 27 文件按 basename 避让分 3 批（9+9+9，单用例 ≤10 次打开）逐文件打开渲染 | 每批聚合收集页面级 console error 断言白名单外为零；pageerror 全程为零；末尾零错误卡 | 白名单三项：① kroki——MC-29/35 装置层 fulfill 的远端图表服务域（环境无关噪音）；② Failed to load resource 且 url 为图片——语料自带相对图片（export_pipeline_test.md 的 ../../pics/codeblock.png）在注入会话无宿主文件，保留原 src 走 404 是产品既有降级契约（markdownImages.ts L3-4）；③ favicon——preview 静态壳资源面（装置已 fulfill 204，双保险） |

## 8. corpus-multisource 多源语料批量渲染与分派场景（MS/HLD/LCD/CJL，2026-10-23 第五轮 default 套件）

语料从单一 markpad（master 浮动引用）扩充为 **7 源逐源锁定 commit sha**（`tools/fetch-e2e-corpus.mjs` 重写为 SOURCES 常量表：markpad-md 27 / mermaid-docs 70 / katex-docs 13 / k8s-docs 38 / hljs-detect 120 / linguist-samples 100 / cookbook-jsonl 5，共 373 文件 ≈5.6MB）。布局 `apps/web/e2e/fixtures/corpus/<source-id>/<仓库内相对路径>`，清单权威为 `corpus/manifest.json`（schema：sources[id,repo,commit,truncatedByMaxFiles,files[path,size,sha256]] + counts + failures）。下载机制保留幂等/重试/HTML 嗅探（sha 优先仲裁——linguist Blade 样本正文本身以 DOCTYPE 开头）/git blob sha 校验/防越界；大仓树列举逐响应检查 truncated，truncated 即分层 BFS，无静默截断；maxFiles 按 tree 顺序截断并在源级记 `truncatedByMaxFiles`。载体 `apps/web/e2e/b-md-corpus-multisource.spec.ts`（MS 系）与 `apps/web/e2e/b-corpus-code-text.spec.ts`（HLD/LCD/CJL 系）。**断言口径：一律锚结构/下限并运行时扫语料实证，不硬锚精确计数**（第四轮 MC-28 教训）；korpi/图片 404/favicon console 白名单沿用第 7 节口径。

| 编号 | 场景 | 期望（用户可见结果） | 契约依据 |
| --- | --- | --- | --- |
| MS-01~07 | mermaid-docs 7 滚动批（70 文件，≤10 文件/例） | 逐文件 `.vv-markdown` 渲染完成 + svg ≥ 可渲染围栏下限 52（54 顶层 mermaid 围栏 −2 预检 parse 失败；49 个 mermaid-example 前缀围栏经状态机排除保持 pre code）+ 零 pageerror + console 白名单外为零 | 图表管线注册表接管语义（上轮 MC-28/29 实证）；manifest sha 锚定 |
| MS-08~09 | katex-docs 2 滚动批（13 文件，含 support_table/supported 千级公式） | `.katex` 达公式下限（$$ 对全额 + 行内对半，运行时语料扫描），批 2 下限另计 | scanMathSegments 四形态；throwOnError 按设计保留原文 |
| MS-10~13 | k8s-docs 4 滚动批（38 文件） | pre code ≥ yaml 围栏实算 80、表格 ≥ 分隔行实算 18、语言徽标+高亮 span 存在性（首个有围栏文件） | 代码围栏本地高亮契约 |
| MS 深断言 ×6 | mermaid intro/index（10 围栏全 svg + example 前缀同文件对照）、mermaid accessibility（11 围栏 + accTitle→svg 内 <title>）、katex support_table（.katex ≥400 + 15 对 display + \def 源码列字面保留）、katex supported（.katex ≥400 + .katex-display 恰 5 + td 归属 + \tag 产物；9 对 $$ 中 4 对内文 `\\` 被 CommonMark 转义折叠为非法控制序列——管线实证恒 5，已固化单测）、k8s pod-lifecycle（yaml 高亮 + front matter 不泄漏）、k8s deployment（95 围栏全落 pre code + 列表项内缩进围栏 li pre code） | 各文件具体能力逐锚 | 管线 vitest 离线复现（复核员独立复跑逐字吻合）；markdownPipeline.test.ts:185-207 转义×throwOnError 回归锚 |
| CORPUS-00 | manifest 不可读守卫 | 整组 skip（对基建轮次容错）；批内 basename 冲突（k8s 三个 _index.md）派生唯一注入名 + `.vv-tree-name` 精确匹配 | 注入装置健壮性 |
| HLD 批量+深断言 | hljs-detect 120 文件（实为 .txt/.js 扩展名，定档时"无扩展名"前提经实测勘误） | ≤10 文件/例批量打开：`.vv-code-pre` 容器出现 + 不落 hex/错误卡 + 零 pageerror；深断言锚状态栏「代码/文本 +（txt）」+ hljs highlightAuto 按内容探测高亮 span（txt 不在语言表→lang=null 通道） | dispatcher.ts:326 + code.ts:2513-2519/1070-1072 |
| LCD 批量+深断言 | linguist-samples 100 文件按 18 白名单扩展名分组 | 代码/配置扩展名→代码渲染器容器、md→`.vv-markdown`；每组首文件「语言: <lang>」扩展名精确表；深断言 ×4（py/rs/go span、yaml/toml 容器不锚 span、csv 语言 csv、md 管线就绪「渲染: 本地」） | detectLanguage 扩展表（languages.json 17 项映射 node 直查实证）；code.ts:2514 扩展表 + csv grammar 在打包清单 |
| CJL 批量+深断言 | cookbook-jsonl 5 文件（maxBytes=5MB 先滤后截，实测 27KB~549KB） | jsonl 渲染器接管（`.vv-jsonl`）+ 行数指示 `[1-9]\d*`（排除「已加载 0 行」初始瞬态占位卡，jsonl/index.ts:373-377 设计内）+ 首卡 body 非空 + 打开方式「JSON Lines」+ 不落 code/hex；深断言：最大 549KB 样本 `.vv-code-pre` 恒零（未委托 code）；折叠初始恰 40 行（JSONL_COLLAPSE_LINES）→展开收敛至权威解析 350 行且展开钮消失 | parse.ts:52-72 权威解析算法镜像（离线复演选定 drone_training.jsonl） |
