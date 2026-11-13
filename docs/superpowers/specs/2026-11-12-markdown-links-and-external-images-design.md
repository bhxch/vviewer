# markdown 外链媒体三档放行 + 相对链接站内导航 — 设计

日期：2026-11-12　状态：待用户审阅

## 1. 背景与动机（用户报的两个 bug + 拍板）

1. **外链图片不渲染**：`![img](https://…)` 被 sanitize 主动剥除 src（BUG-17 跟踪像素防线，2026-09 引入），渲染为虚线占位框（title 提示域名）。用户确认为安全限制并要求解除，拍板形态：**三档设置（禁止/手动/自动）+ 域名白名单（白名单中的域名不受限制）**。
2. **markdown 内链同目录文件 404**：`[text](./other.md)` 点击走浏览器原生导航到不存在 URL（SPA 404 页或静态托管 404）。根因：双引擎不改写相对 href（markdown-engine/engine.ts:48-63 原样输出、server/core/src/compute/markdown.rs:54-87 comrak 透传）、sanitize 放行（ALLOWED_URI_REGEXP `[^a-z]` 分支）、无任何点击拦截。

## 2. 现状锚点

**外链媒体面**：
- 外域判定 `isExternalMediaSrc`（packages/vviewer-sanitize/src/sanitize.ts:38-40，`^https?:` 或 `//` 开头）。
- img 拦截：afterSanitizeAttributes 钩子 IMG 分支（sanitize.ts:331-337）——外域 src `removeAttribute` + `markBlockedExternal`（:51-54，写 `data-vv-blocked-external="1"` + title 保留域名）；srcset 逐候选过滤（:342-362）。
- 占位呈现：`BLOCKED_EXTERNAL_CSS`（packages/vviewer-markdown/src/css.ts:188-189，min 96×40 虚线框）。
- BUG-40 五类等价向量维持面：video/audio poster、SVG image/use href、行内 style url()、background 属性、input type=image（sanitize.ts:56-67 注释/:369-417）。
- MD-13 音视频防线：外域 video/audio 不剥 src 但强制 `preload="none"` 去 autoplay（sanitize.ts:369-378）；enrich 后第二道 `applyExternalMediaGuard`（vviewer-markdown/src/enrich.ts:25-30）。
- 导出：`resolveExportImage` 外域不强拉（apps/web/src/lib/markdownExport.ts:31-33）。
- 既有 e2e 锚：t-md.spec.ts:457/:491、b-markdown-html-docs-bug-regressions.spec.ts:138/:190-191（断言外域 img src 已移除+占位标记）。
- sanitize 是共享单出口（vviewer-sanitize 包），双引擎 + mermaid 哨兵隔离共用；包零 settings 依赖（注入缝先例：setResolveRemoteBase/setMarkdownImageResolver 五组 setter/getter，vviewer-markdown/src/index.ts:31-41）。

**相对链接面**：
- 引擎不改写（上）；锚改写只管 `a[href^="#"]`（remapHeadingHashLinks，markdownRenderer.ts:311-332）；wikilink `[[file]]` 降级不可点 `span.md-wikilink-dead`（enrich.ts:248-253，css.ts:180）；`[[#slug]]` 已可点页内锚（:241-245）。
- 全仓无 markdown 视图内 anchor click 拦截（仅 callout 折叠对 `closest('a')` 豁免 enrich.ts:170-171、img 灯箱 pipeline.ts:755）。
- 图片相对路径解析先例：`resolveRelativeImages`（markdownRenderer.ts:209-230，sanitize 后运行）→ app 侧 resolver 注入（viewer.ts:278-282 → markdownImages.ts:43-63，20MB 上限）；`isAbsoluteSrc` 判定 :150-152。
- 路径工具：posixJoin 已有（2026-11-07 A4 加固：`../` 与前导 `/` 拒绝语义——注意本次需要的是「允许合法 ../ 上级」的解析，与 A4 的安全拒绝边界区分，builder 核对 posixJoin 现行为后定解析式）。
- store 侧：TreeStore.exists/listChildren 可用；openFlow 打开通道全集（openFiles/openUrl 等，openFlow.svelte.ts:55/:169/:333）；目录 tab 打开通道（addDirStoreTab）。

## 3. 设计

### 3.1 外链媒体三档 + 白名单

**设置**：新 `settings.markdown` 节（与 diagrams 节同型）：`externalImages: 'blocked'|'manual'|'auto'`（默认 `manual`——默认档从「禁止」升到「手动」是放行诉求的合理解读，但**知情取舍**：跟踪像素防线从默认拦截变为默认逐张放行；如需保守可默认 `blocked`，见 §5 裁量）+ `externalImagesAllowlist: string[]`（域名条目，`example.com` 精确 + `.example.com`/`*.example.com` 子域通配，归一时小写化）。

**sanitize 选项注入**：`sanitizeHtml(html, opts?)` 扩第二参（包内纯函数，向后兼容缺省=现行行为）；opts `{ externalImagePolicy, externalImageAllowlist }` 由管线端注入——vviewer-markdown 管线读 options（新 PipelineCtx 字段，apps/web 装配从 settings 读入，五组 setter 先例同款；standalone 包消费者自行传）。**markpad/mermaid 哨兵隔离不受影响**（钩子逻辑只 IMG 分支消费新 opts）。

**行为矩阵**（作用面=img 与 srcset；**音视频维持 MD-13 preload=none 防线不随档位放行**，poster 属 BUG-40 向量维持剥除——作用面收窄为知情裁量，见 §5）：
- `blocked`：现行行为（剥 src+srcset、占位框、title 域名）。
- `manual`：不剥 src，改为保留 `data-vv-blocked-external="1"` 标记 + 占位框内**「加载图片」按钮**；点击 = 占位框替换为真 img（src 回填）+ 标记转已加载；单次会话内同 src 免重复确认（内存 Set，不持久化，裁量）。实现落点：enrich/管线层按标记注册点击代理（sanitize 包保持纯函数无交互）。
- `auto`：钩子 IMG 分支直接放行（src/srcset 保留），无占位交互。
- **白名单优先于档位**：allowlist 命中的域名在任意档位下都按 `auto` 处理（含 `blocked` 档）。
- BUG-40 五类等价向量维持剥除（白名单也不放行它们——那是加载面不是 img 面）；SVG image/use href 的外域放行**不做**（SVG 内嵌外域图是主动加载向量，维持）。
- e2e 锚更新：t-md 两处既有锚按默认档改写（manual 档下占位框仍存在、src 保留但未加载——断言形态变化，builder 核对 playwright 下 img 加载时序，可能需断言占位可见而非 src 缺失）。

### 3.2 相对链接站内导航

**注入缝**：vviewer-markdown 新 option `resolveRelativeLink?: (href: string) => Promise<RelativeLinkTarget | null>`（包零 store 依赖；apps/web 装配实现，走激活 store 遍历）；`RelativeLinkTarget = { kind: 'file'|'directory', storeId, path } | { kind: 'missing' }`。

**管线侧**：渲染出口（enrich 后、灯箱接线同代）对内容区 `a[href]` 逐个分类：
- `#` 锚、绝对 URL（http/https/mailto/协议）、`data:`/`blob:` → 不接管（浏览器原生/既有语义）；
- 相对路径（`./x`、`../x`、`x.md`、`/` 开头视为站点根相对——**按当前文件所在 store 的根解析**而非站点 URL）→ 接管点击：调 `resolveRelativeLink` → 命中 file：新 tab 打开（openFiles 通道，渲染器自选）；directory：打开目录 tab；missing：状态提示「目标不存在：<路径>」（BUG-24 showStatusNotice 通道）；解析器未注入/返回 null → 不接管（standalone 包安全缺省）。
- 解析式：基于**当前 md 文件的 store 路径**做 posix 语义 join（`a/b/c.md` + `../d/e.md` → `a/d/e.md`；URL 解码 `%xx` 后处理；query/hash 剥离后解析、hash 保留为页内锚判定先行）。
- **wikilink 升级**（顺带）：`[[file]]` 死链 `span.md-wikilink-dead` 改走同一 resolveRelativeLink 通道，可点打开（enrich.ts:248-253 改造）；解析器未注入时维持降级死链形态。
- 视图切换/销毁清理：点击代理随渲染实例生命周期（复用现有管线事件绑定/解绑模式，BUG-52 装置收口先例）。

**server 通道一致性**：远程 comrak 输出同样汇入 sanitize→enrich→管线（markdownRenderer.ts:557-568 单出口），行为一致，无 server 侧改动。

### 4. 目标 / 非目标 / 反目标

- 目标：三档+白名单可控放行外链图片；相对链接/wikilink 在 store 内导航闭环；双引擎一致。
- 非目标：外域音视频自动播放、导出侧外域图片强拉（维持不强拉）、`/` 开头链接的站点根语义变更（只改解析基准为 store 根）、跨 store 链接。
- 反目标：在 sanitize 包内引入交互/DOM 事件（保持纯函数单出口）；对白名单域名放宽 BUG-40 等价向量；默认档直接 `auto`。

## 5. 留给 builder 的裁量

- 默认档取 `manual`（推荐，体验优先）还是 `blocked`（保守，BUG-17 防线零回退）——**倾向 manual，需在设置文案与 release notes 标注防线语义变化**；白名单归一细节（端口/大小写）；manual 档同 src 免确认的会话范围；接管点击的事件委托落点（容器级委托 vs 逐链接绑定）；posixJoin 复用 vs 新解析函数；目录 tab 打开的 store 通道选型。

## 6. builder check 订正与落定（2026-11-13）

- **manual 档实现机制落定**（builder check 指出「src 保留+不加载」在 DOM 层面矛盾）：外域 img 的 src **迁入 `data-vv-external-src`**（DOM 无 src 即不发请求，BUG-17 防线真实维持），占位呈现=该 img 包占位容器（img 隐藏）；「加载图片」点击=src 回填+标记转已加载。e2e 断言基准=src 缺失 + data 属性存在（断言形态由此确定）。
- **媒体扩展名交点落定**：enrich 的 img→video/audio 转换发生在 sanitize 后渲染时，manual 档下 src 已迁 data 属性 → 转换不发生 → 「加载图片」按钮文案按目标扩展名区分（.mp4/.webm 等→「加载视频」），点击放行时按扩展名创建 video/audio 元素（preload=none，MD-13 语义）替换占位，而非回填进 img。
- **html/docx 直调点同步注入**（落定）：`packages/vviewer-render-text/src/html.ts:41` 与 `packages/vviewer-render-doc/src/docx.ts:47` 直调 `sanitizeHtml` 不在 markdown 管线内——同样注入档位 opts（体验一致），两处装配从 app 侧 settings 取值。
- **跨文件 fragment**（落定）：`./other.md#section` 打开目标文件后 MVP **不自动定位**（hash 丢弃，注记）；打开通道加锚点定位列为后续增强。
- **音视频/poster 维持剥除是定案**（修 §3.1 引用指向错误）：AV/poster 任何档位（含白名单）都不放行，白名单作用面=img 与 srcset。
- **锚点勘误**：TreeStore 接口无 `exists`（types.ts:39-65）——存在性探测仿 `markdownImages.ts` 的 `resolveImageBlobUrl` 用 `listChildren(dir).find(...)`，平铺 store 退化按 read 失败兜底。

## 6. 验收锚点

- 单测：sanitize 选项矩阵（三档 × 白名单命中/未命中 × srcset）；解析式用例（同目录/上级/URL 编码/query-hash）。
- e2e：①blocked/manual/auto 三档 + 白名单命中在 blocked 下直接显示；②manual 点「加载图片」→ 图片可见；③同目录 md 互链新 tab 打开、缺失目标提示、外域链接不接管、锚不接管；④wikilink 可点打开（resolver 注入）与 standalone 降级形态；⑤既有 BUG-17/BUG-40 锚按新默认档重定基（五类向量断言不变）。
