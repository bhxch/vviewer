# CDN 直链图表引擎 e2e — 场景（P2 图表引擎收口 + P3 后续批次 hpcc 承接）

> 来源：plan `docs/superpowers/plans/2026-10-23-renderer-lang-override-p2-diagram-engines.md` Task 5。spec 依据：`docs/superpowers/specs/2026-10-23-renderer-lang-override-markpad-alignment-design.md` §6（四类图表 CDN 直链本地引擎 + 回退链 CDN→kroki→source）与 §7（svgbob 前端 wasm 引擎，唯一本地打包例外）。运行时回退链由 f807636 落地（local 引擎失败且有 krokiType 先降 kroki img，kroki img error 再落错误卡+源码）。CDN-04（graphviz hpcc 渲染器真渲染，spec §9.1 双渲染器）为 P3 后续批次承接 `docs/e2e/diagram-server-kroki.md` §6 留档候选落地。
>
> 脚本：`apps/web/e2e/b-cdn-diagram-engines.spec.ts`（CDN-01~04，chromium project）。旧锚承接（同 Task 5 收口，spec §6 翻转注记）：`b-md-diagrams-deep.spec.ts` DM-04/DM-06（vegalite kroki 断言面改经 settings 强制 kroki 保留）、`b-md-corpus-markpad.spec.ts` MC-29（demo_features 口径改「仍 kroki 型出 img + local 型出引擎产物」）/MC-35（console error 白名单补 cdn.jsdelivr.net 条目）。2026-10-24 CI 收口补注：语料组 mockExternalNoise 追加 jsdelivr abort（含 MC 循环全组接入）——CDN 直链引擎 +esm 模块图真网加载 27-30s 级顶穿 `.vv-markdown` 30s 时限（MC-15/29/35 CI 稳定挂），语料锚确定性走降级链，真网成功语义仍由 CDN-01 专锚；dbml 入册（P3）后 MC-28 计数 279→278、`.md-diagram` 3→4。

## 1. 目的与来源

四类图表（excalidraw/bpmn/vega/vegalite）defaultMode 由 kroki 翻转 CDN 直链本地引擎（jsdelivr `+esm` 精确版本，dist 零增量），svgbob 翻本地 wasm（构建期 `gen:svgbob-wasm` 产物入 dist）。翻转引入三个此前无浏览器端回归锚的资产面：

1. **CDN 引擎真网实渲染**（CDN-01）——T4 spike 用 jsdom 冒烟，真浏览器（真实 Worker URL 构造惰性路径、真实 DOM 度量）无锚；
2. **回退链两态**（CDN-02）——local 引擎加载/渲染失败的运行时降级（CDN→kroki→错误卡+源码）只有单测断 src 形态，img error 事件链是 jsdom 不派发的 e2e 专属面；
3. **svgbob 本地 wasm 出图**（CDN-03）——本地打包引擎的首个浏览器端锚，兼锚「local 默认成功路径零 kroki 请求」；
4. **graphviz hpcc 渲染器真渲染**（CDN-04，P3 承接）——spec §9.1 双渲染器的 hpcc 档（`renderers.graphviz='hpcc'` → @hpcc-js/wasm-graphviz CDN 加载→Graphviz.load→layout）此前无浏览器端锚，按 DSV-06 模式（settings 预设 + skipIf offline）落地。

## 2. 场景清单

公共环境：default 套件（chromium project）；注入通道 `injectDir + openTreeFile`（与 b-md-diagrams 同款，夹具内联构造，不另落 samples）。CDN-02/03/04 挂 `test.use({ serviceWorkers: 'block' })`——page.route 拦不到经 SW 的请求（DM-03 备案同源：SW runtimeCaching 的 jsdelivr CacheFirst 会吞掉拦截面），阻断 SW 保证请求必经页面网络栈，abort 才能确定性触发回退链；CDN-04 另需 SW block 使 @hpcc-js/wasm-graphviz 请求可被 `page.on('request')` 观测（经 SW fetch 的请求不进页面网络栈）。CDN-01 真网语义不 block。

| 编号 | 前置条件 | 步骤 | 期望 | 依赖网络 |
| --- | --- | --- | --- | --- |
| CDN-01 | 真网可达（探测 `page.request.get('https://cdn.jsdelivr.net/', {timeout: 3000})` 失败即 `test.skip`——GRF 域 VV_GRAMMAR_CDN 离线前科同策略；API request 不走页面 route/SW，探测不受拦截面污染） | 打开含 ```excalidraw 围栏的 md | `.md-diagram-view svg` 可见（120s 上界——@excalidraw/utils 包 18.74MB 含 react，慢网加载）；视图无 `md-diagram-error`；`page.on('request')` 过滤 kroki.io 为空（CDN 成功即不降级） | 是（skipIf offline） |
| CDN-02 第一跳 | `page.route('**/cdn.jsdelivr.net/**')` abort + `page.route('**/kroki.io/**')` fulfill svg（全 mock，离线稳定） | 打开同款 excalidraw 围栏文档 | 引擎动态 import 失败降级：`.md-diagram-view img[src^="https://kroki.io/excalidraw/svg/"]` 可见（回退链第一跳接管）；无 `md-diagram-error` | 否 |
| CDN-02 终点 | CDN+kroki 双 abort | 同上 | kroki img error 事件（真浏览器专属面）→ 错误卡 `.md-diagram-view.md-diagram-error` 可见且文案 `kroki 渲染失败（excalidraw）`（66afead 教训：失败态文案不得 hidden）；源码面板同展原文（`toContainText` 全 fixture）；toggle 留「图」可切回文案卡（DM-01 同构） | 否 |
| CDN-03 | 无 mock（本地 wasm 引擎，spec §7 唯一本地打包例外） | 打开含 ```svgbob 围栏的 md | `.md-diagram-view svg` 可见（构建期 gen:svgbob-wasm 产物）；kroki.io 请求为零（local 默认成功路径不触发运行时回退） | 否 |
| CDN-04 | 真网可达（CDN-01 同款 3s 探测 skipIf offline）+ localStorage 预设 `renderers.graphviz='hpcc'`（injectSettings，DM-04/DSV-06 先例） | 打开含 ```graphviz 围栏的 md | `.md-diagram-view svg` 可见（60s 上界——@hpcc-js/wasm-graphviz@1.30.0 wasm 内嵌单文件 820KB，加载 3-8s 量级）；无 `md-diagram-error`；kroki.io 请求为零（local 成功路径不降级）；**因果锚**：@hpcc-js/wasm-graphviz 的 CDN 请求在案（viz-js 为打包内嵌零网络面，请求在案即排除默认档巧合出图，renderers 设置与请求指纹双保险） | 是（skipIf offline） |

### skipIf 策略

- **CDN-01/CDN-04 是本 spec 仅有的真网依赖用例**：执行环境无外网时 skip（探测 3s 超时判定），不假红。真网 CDN 实渲染无法用 mock loader 替代（产物 chunk 内生产 loader 为 `import(/* @vite-ignore */ url)`，mock 注入口 `__setCdnLoaderForTest` 仅单测可达，e2e 产物 chunk 内不可达）。
- **CDN-02/03 必须离线稳定**：回退链两态全 route mock（abort 不依赖真网——jsdelivr/kroki 请求在 SW block 下必经页面网络栈被 page.route 拦截）；svgbob wasm 本地打包无外网面。

## 3. 夹具与断言锚

| 夹具 | 规格 | 用于场景 |
| --- | --- | --- |
| excalidraw 最小 JSON | `{"type":"excalidraw","elements":[],"appState":{},"files":{}}`（spec Task 5 夹具口径；空 elements 亦须出图） | CDN-01/02 |
| svgbob 最小盒图 | `+-->+` / `| a |` / `+<--+` 三行（`fence()` 构造，markdown-it fence 内容恒带尾换行） | CDN-03 |
| graphviz 最小有向图 | `digraph { cdn04 -> hpcc }`（server 单测同款 digraph 形态） | CDN-04 |
| kroki fulfill 应答 | 最小 `<svg>` body（与 b-md-diagrams SVG_BODY 同串） | CDN-02 第一跳 |

断言锚对照（源码契约）：注册表翻转 `packages/render-text/src/markdown/diagrams.ts`（五类 `local: true, defaultMode: 'local'`）；回退链 `packages/render-text/src/markdown/pipeline.ts` `renderDiagramBlock`（`appendKrokiImg` 局部函数，local catch → krokiType 存在先降 kroki img → img error 落错误卡+源码）；CDN 引擎 `packages/render-text/src/markdown/cdnEngines.ts`（excalidraw `exportToSvg({ data })` 归一化重组）。

## 4. 旧锚承接明细（spec §6 翻转注记）

| 锚 | 翻转前 | 翻转后 |
| --- | --- | --- |
| DM-03（b-md-diagrams-deep） | graphviz 引擎 chunk 失败断言落 `md-diagram-error` 保留源码（错误卡终点） | 运行时回退（f807636）后 chunk 失败先降 kroki img——kroki 补 fulfill 确定性接管（离线稳定），断言改 kroki img 可见 + 无错误卡 + 无引擎 svg；mermaid 不受累与徽标/toggle 断言原样 |
| DM-04（b-md-diagrams-deep） | `vega-lite` 围栏断言 `img[src^="https://kroki.io/vegalite/svg/"]`（defaultMode=kroki 直走） | vegalite defaultMode 已翻 CDN local——krokiType 归一断言面（kroki 段 URL 形态）经 `injectSettings(diagrams.modes.vegalite='kroki')` 强制保留，离线稳定；dot/latex 别名断言不动 |
| DM-06（b-md-diagrams-deep） | vegalite kroki img 可见后切源码惰性高亮 | 同款 settings 强制 kroki（DM-04 未列而同病：真网下 local 出 svg 会使 img 锚翻红）；img→源码→惰性高亮断言链原样 |
| MD-04（b-markdown-html-docs-pipeline） | 非法 mermaid 块断言 `md-diagram-error` + 原文在视图内 | 非法块本地失败先降 kroki img——abort kroki（`**/kroki.io/**`）确定性令 img error 落错误态，不依赖真网往返时序；断言改错误卡文案 + data-mermaid 保留 + 原文同展于源码面板（66afead：失败态不得 hidden） |
| MC-29（b-md-corpus-markpad） | 「kroki 型 ×6（plantuml/vegalite/bpmn/svgbob/excalidraw/ditaa）经 fulfill 全部出 img」 | 口径改两组：仍 kroki 型 plantuml/ditaa ×2 出 img（fulfill）；local 型 svgbob 出本地 wasm svg（恒定）+ mermaid/graphviz/nomnoml svg + CDN 三类（vegalite/bpmn/excalidraw）「svg 或 img 终态产物」（真网 CDN svg / 离线降级 kroki img，网络无关）；`img` 总量计数不再钉 6 |
| MC-35（b-md-corpus-markpad） | console error 白名单 kroki/favicon/图片资源三条 | 补第 4 条 cdn.jsdelivr.net（离线/被墙环境动态 import 资源级失败属回退链设计内路径，非渲染缺陷；真网无命中） |

> 承接注：控制器承接清单原列 DM-04 + MC-29/35；DM-06、DM-03、MD-04 为全量门禁实跑暴露的同类旧锚（运行时回退/注册表翻转的同批后果），按同一注记口径一并收口——五处均为断言语义翻转，产品代码零改动。
