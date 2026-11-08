# 图表文件渲染器（29 型）e2e — 场景（DIA 域扩面）

> 来源：spec `docs/superpowers/specs/2026-11-04-file-viewer-integration-design.md` §5.1/§5.2（29 型注册面 + 渲染路径）。实现锚：`packages/vviewer-render-text/src/diagramFile.ts`（注册面 `:59-125`、大小门 `:49/:203-243`、模式裁决 `:132-149`、DOM 骨架/工具条 `:268-288`、三分发降级链 `:321-468`、sanitize `:327/:347`、在飞守卫 `:481`）；注册表 `packages/vviewer-render-diagram/src/markdown/diagrams.ts:39-74`；CDN 引擎 `packages/vviewer-render-diagram/src/markdown/cdnEngines.ts`；kroki/plantuml 编码 `diagrams.ts:88/:106-128`；设置注入 `apps/web/src/lib/viewer.ts:278-297`（`modeOf` 读 `settings.diagrams.modes`）、白名单 `apps/web/src/lib/stores/settings.ts:163-186`。
>
> 脚本：`apps/web/e2e/b-diagram-file-2.spec.ts`（本域独占，新建；DIA 域 **10 个场景编号，展开为 35 个 test**，chromium project）。**状态：场景锚已定，行列与断言经一次性勘察跑验证（2026-11-08，记录见 §6）；spec 脚本已落库（2026-11-08）；复核轮实跑（mustFix 前的 32 test 形态）32 passed，`--retries=0` 复跑亦 32 passed（稳定性口径见 §6 复核轮）；本轮（mustFix 落实后，35 test 形态）类型检查通过（`npx tsc --noEmit -p apps/web/tsconfig.e2e.json` 退出码 0）、`npx playwright test --list` 解析出 35 个用例（未实跑——工作流统一调度）。**
>
> 旧锚承接（不重复）：`apps/web/e2e/b-diagram-file.spec.ts` DIA-FILE-01~05（graphviz 抢注、图/源码切换、mermaid 本地、plantuml kroki/官方双跳、>2MB 降级）。`b-cdn-diagram-engines.spec.ts` CDN-01~04 与 `b-diagram-server-kroki.spec.ts` DSV-03~10 覆盖的是 **markdown 围栏管线**（`.md-diagram-view`），与本域的 **图表文件渲染器**（`.vv-html` 面，`diagramFile.ts` 自有降级链）不同面，不互认覆盖。

## 1. 目的与来源

图表文件渲染器（29 型 / 33 扩展名，`diagramFile.ts:59-89`）在浏览器端只有 3 型有锚（graphviz / mermaid / plantuml，共 6 锚），其余 26 型零锚；另有三处通用门未锚：大小门等界（只锚 >2MB）、kroki-only 型的单跳失败文案（只锚 plantuml 双跳）、source 生效模式不建工具条。本轮把「型覆盖」按渲染档位铺开，并把三处通用门补齐：

1. **渲染档位全覆盖（26/26 型零锚补齐）**——本地 npm 引擎（nomnoml）、本地 wasm（svgbob）、CDN 本地引擎 8 型（d2/dbml/vega/vegalite/excalidraw/bpmn/bytefield/wavedrom）、kroki-only 15 型（pikchr/ditaa/blockdiag/nwdiag/actdiag/seqdiag/erd/structurizr/tikz/umlet/goat/wireviz/packetdiag/rackdiag/symbolator）、官方服务器族 c4plantuml（officialServer 型：kroki 段 + 官方重试一跳）——29 型减去既有锚的 3 型（graphviz/mermaid/plantuml）全部落锚；
2. **通用门补齐**——大小门 =2MiB 等界与 +1 字节界、source 档无工具条、kroki-only 单跳失败文案（覆盖 2/15 型：pikchr、ditaa；同形未逐型锚，见 §3.4）；
3. **降级链与消毒链锚**——CDN 档引擎失败回退 kroki 第一跳、official 档 official→kroki 回落、server 档未连接服务端时回落 local、渲染产物过 `sanitizeDiagramFragment`（script / 事件属性剥离）。

## 2. 场景清单

公共环境：default 套件（`playwright.config.ts`，chromium project；本域全部用例 beforeEach 跳过 mobile——图表引擎渲染面与视口无关，mobile 变体只翻倍时长，同 `b-diagram-file.spec.ts` 口径）。注入通道 `injectDir + openTreeFile`（`b-markdown-html-docs-helpers.ts`，type 显式 `text/plain`）。**第三方请求一律用 `context.route`（page.context().route）拦截**，不用 `page.route`：本仓 SW 有 `urlPattern: /^https:\/\/cdn\.jsdelivr\.net\/npm\/.*/` 的 CacheFirst 运行时规则（`apps/web/vite.config.ts:789`），SW 控制页面后 jsdelivr 模块请求经 SW 发出——实测 `page.route` 命中 0 次（请求真出网）、`context.route` 命中 1 次（详见 §6）。**全部锚离线可跑**：kroki.io / cdn.jsdelivr.net / www.plantuml.com 一律先挂 context.route mock。

**落库实现与本表的差异（以源码实况为准）**：脚本内用**一条**正则拦截面 `/(kroki\.io|cdn\.jsdelivr\.net|plantuml\.com)/` 统一接管三 hosts（按 URL 分派 abort / fulfill 最小 svg / fulfill 假 ESM），台账在 route 命中处记账——多挂同 host 的 glob 路由会因「后注册者优先」互相遮蔽，单条正则规避该歧义，且请求计数不依赖 SW 是否把请求转发到页面网络栈（route 命中即请求确曾发出）。表驱动场景按型拆成独立 test（编号后缀带型名），一个 test 一个文件一次打开——避免同 test 内切 tab 时旧实例 DOM 尚在导致的断言串型竞态。

| 编号 | 前置条件 | 步骤 | 期望 | 依赖网络 | 关联缺陷 |
| --- | --- | --- | --- | --- | --- |
| DIA-LOCAL-01 | 无 mock（本地引擎，环境无关）；第三方请求台账挂在注入前 | 打开 `n.nomnoml`（npm 引擎零锚型，test 后缀 `/nomnoml`）、打开 `s.svgbob`（wasm 引擎零锚型，test 后缀 `/svgbob`） | ① 各型 `.vv-html-content svg` 可见（30s 上界）；② **产物内容**：nomnoml 的 `.vv-html-content text` 文本集恰为 `['A','B']`、svgbob 恰为 `['a']`（引擎出空图/错图即红——只断言 svg 存在则空 svg 也能过）；③ 各型 `.vv-code` 计数 0、`img` 计数 0（未落源码面、未走 kroki img）；④ 各型无 `.vv-error-card`；⑤ 第三方请求计数（kroki.io / cdn.jsdelivr.net / plantuml.com）**合计 0**；⑥ `.vv-html-toolbar` 计数 1 且 `.vv-html-btn-rendered` 带 `active` 类 | 否 | —（新增锚，本域无既有缺陷登记；打红面见 §3.1） |
| DIA-KROKI-01 | `context.route` 正则拦截面：kroki.io → fulfill 最小 svg，其余第三方 → abort；请求台账同面记账 | 表驱动打开 15 个 kroki-only 型（pikchr/ditaa/blockdiag/nwdiag/actdiag/seqdiag/erd/tikz/goat/wireviz/packetdiag/rackdiag/symbolator + umlet(.uxf)/structurizr(.dsl)），每型一个 test（编号后缀带型名） | ① 每型该次在案请求 URL 匹配 `^https://kroki\.io/<krokiType>/svg/[A-Za-z0-9_-]+$`（base64url 无填充载荷）；② 每型 `.vv-html-content img` 可见（20s 上界）；③ 台账中 kroki 请求 ≥ 1 次且**每次**的型段都是本型（不串型）；④ 每型 `.vv-error-card` 计数 0、`.vv-code` 计数 0 | 否 | —（新增锚，本域无既有缺陷登记；打红面见 §3.1） |
| DIA-KROKI-02 | 同一拦截面：kroki.io 与 plantuml.com 均 abort（plantuml 仅作零请求台账） | 打开 `f.pikchr`（test 后缀 `/pikchr`）、打开 `f.ditaa`（test 后缀 `/ditaa`） | ① `.vv-error-card` 可见（30s 上界），`.vv-error-title` = `图表渲染失败，已回退源码视图`；② `.vv-error-detail` 含 `kroki 渲染失败（图片加载错误）：pikchr`（ditaa 各自匹配）；③ `.vv-error-detail` **不含** `官方服务器`（缺席断言——单跳 ≠ plantuml 两跳）；④ plantuml.com 请求计数 **0**（非 officialServer 型不得触发官方重试一跳）；⑤ `.vv-html-content .vv-code` 可见、`svg` 计数 0、`img` 计数 0；⑥ `.vv-html-btn-source` 带 `active` 类 | 否 | —（新增锚，本域无既有缺陷登记；打红面见 §3.1） |
| DIA-C4-01/kroki | 同一拦截面：kroki.io → fulfill 最小 svg，其余第三方 → abort | 打开 `c.c4plantuml`（c4plantuml 注册表 defaultMode=kroki、krokiType=c4plantuml） | ① `.vv-html-content img` 可见（20s 上界）且 `src` 匹配 `^https://kroki\.io/c4plantuml/svg/[A-Za-z0-9_-]+$`（型段随型而变，不串到 plantuml）；② 台账中 kroki 请求 ≥ 1 次且每次型段均为 c4plantuml；③ 无 `.vv-error-card`、无 `.vv-code` | 否 | —（新增锚，本域无既有缺陷登记；打红面见 §3.1） |
| DIA-C4-01/official-retry | 同一拦截面：kroki.io 与 plantuml.com 均 abort | 打开 `c.c4plantuml` | ① `.vv-error-card` 可见，`.vv-error-title` = `图表渲染失败，已回退源码视图`，`.vv-error-detail` 含 `kroki 与官方服务器渲染失败（图片加载错误）：c4plantuml`（两跳形态——c4plantuml 是 officialServer 型，kroki 失败会重试官方一跳）；② **官方重试确曾发生**：plantuml.com 请求恰 1 次且 URL 匹配 `^https://www\.plantuml\.com/plantuml/svg/[0-9A-Za-z_-]+$`（既有 DIA-FILE-04b 只断言两跳文案，未证官方那一跳真的发出）；③ kroki 请求 ≥ 1 次且型段为 c4plantuml；④ 源码视图承接、`svg`/`img` 计数 0 | 否 | —（新增锚，本域无既有缺陷登记；打红面见 §3.1） |
| DIA-CDN-01 | 同一拦截面：cdn.jsdelivr.net → abort、kroki.io → fulfill 最小 svg；settings 预设 `diagrams.modes.d2='local'`（d2 注册表 defaultMode=kroki，须显式 local 才走 CDN 档） | 表驱动打开 8 个 CDN 本地引擎型（excalidraw/bpmn/vega/vegalite(.vl)/wavedrom/bytefield/dbml/d2），每型一个 test（编号后缀带型名） | ① 每型 `.vv-html-content img` 可见（20s 上界）且 `src` 匹配 `^https://kroki\.io/<krokiType>/svg/[A-Za-z0-9_-]+$`——回退第一跳接管；② 每型 `.vv-error-card` 计数 0（第一跳即终态成功）、`svg` 计数 0；③ **终态之后**取计数：在案 jsdelivr 请求含该型自己的包名 token（`@excalidraw/utils` / `bpmn-js` / `vega-embed` / `wavedrom` / `bytefield-svg` / `dbml-renderer` / `@d2lang/d2`）且**恰 1 次**、无别型包名——因果锚：证曾走本型引擎（计数在终态断言之后取，避免只增计数器上 poll 提前放行） | 否 | —（新增锚，本域无既有缺陷登记；打红面见 §3.1） |
| DIA-SIZE-01/exact | settings 预设 `diagrams.modes.pikchr='source'`（大小门位于模式裁决之前，判据与模式无关；固定 source 档只为让「正常路径」的落点唯一——源码视图，无网络面）；字节数在代码内以 `new TextEncoder().encode(x).byteLength` 自证 | 打开 `exact.pikchr`（字节数 = 2×1024×1024） | ① `.vv-html-content .vv-code` 可见（降级路径无 `.vv-html-content` 骨架，故此断言本身即「未走大小门」的判据）；② `.vv-error-card` 计数 0；③ `.vv-html` **不带** `vv-degraded` 类；④ 第三方请求计数 0（**注**：source 档本就不发请求，此条只作「无外呼」陈述，**不构成次序证据**——次序证据在 /over 分支） | 否 | —（新增锚，本域无既有缺陷登记；打红面见 §3.1） |
| DIA-SIZE-01/over | **不注入 source 档**——pikchr 留注册表默认 kroki 档（`diagrams.ts:50` defaultMode kroki）：如此「零三方外呼」才真正证明大小门早于引擎链（若门被挪到模式裁决之后，pikchr 会发 kroki.io 请求、计数非零） | 打开 `over.pikchr`（字节数 = 2×1024×1024 + 1） | ① `.vv-error-card` 可见，`.vv-error-title` = `图表文件过大，已降级显示`、`.vv-error-detail` 含 `2MB`、`.vv-error-meta` = `over.pikchr`；② `.vv-html` **带** `vv-degraded` 类；③ 第三方请求计数 **0**（**次序证据**：pikchr 默认 kroki 档下仍零外呼）；④ `.vv-html-content` 计数 0（降级路径不建渲染骨架，正常路径才有）；⑤ `.vv-degraded-content.vv-code` 可见（源码视图承接）。**旧版「无工具条」断言已删**——降级路径 `diagramFile.ts:219` 必清空骨架，该断言无论次序都成立（恒真），不作证据 | 否 | —（新增锚，本域无既有缺陷登记；打红面见 §3.1） |
| DIA-SRC-01 | settings 预设 `diagrams.modes.pikchr='source'` | 打开 `src.pikchr` | ① `.vv-html-toolbar` 计数 0、`.vv-html-btn-rendered` 计数 0、`.vv-html-btn-source` 计数 0（缺席三连——source 档无渲染视图可切）；② `.vv-html-content .vv-code` 可见、`.vv-code-line` 首行含 `hello source`；③ `svg` 计数 0、`img` 计数 0；④ 第三方请求计数 **0**；⑤ `.vv-error-card` 计数 0 | 否 | —（新增锚，本域无既有缺陷登记；打红面见 §3.1） |
| DIA-SAN-01 | `context.route` 正则拦截面：cdn.jsdelivr.net → fulfill 假 dbml 模块（ESM 源，导出 `run(src,fmt)` 返回含 `<script>` 与 `onclick` 的 SVG 串；`content-type: text/javascript`，并附 `access-control-allow-origin: *` 兜底跨浏览器 CORS 面）；dbml 默认即 local 档 | 打开 `z.dbml` | ① `.vv-html-content svg` 可见（30s 上界）+ jsdelivr 请求 ≥ 1——证 mock 模块确实被加载并渲染（假引擎形态与真 dbml 同调用面）；② `.vv-html-content script` 计数 0；③ 脏 `rect` 不带 `onclick` 属性，且产出物全域扫描**零** `on*` 内联事件属性；④ `.vv-html-content text` 文本 = `hello`（产物真被渲染，非空壳）；⑤ 点击脏 `rect` 后 `page.evaluate(() => window.__vvDiaPwned)` 仍为 `undefined`（副作用未发生）；⑥ `.vv-error-card` 计数 0（净化 ≠ 渲染失败） | 否 | —（新增锚，本域无既有缺陷登记；打红面见 §3.1） |
| DIA-SERVER-01 | settings 预设 `diagrams.modes.graphviz='server'`；default 套件无服务端连接 → `serverDiagramOf` 恒 false（`viewer.ts:288` loadDiagramCapabilities 为空）；另挂 `/api/(compute|kroki)` 拦截台账（命中即记账并 abort） | 打开 `g.dot`（最小 digraph） | ① `.vv-html-content svg` 可见（30s 上界）——回落 local 的 viz-js 本地引擎出图（server→local→kroki→source 链第一跳）；② **零服务端代理请求**：`/api/compute/diagram` 与 `/api/kroki` 请求计数 0（未走 server 链）；③ 零三方外呼；④ 无 `.vv-error-card`、无 `img`、无 `.vv-code`，渲染钮带 `active` | 否 | —（新增锚，本域无既有缺陷登记；打红面见 §3.1） |
| DIA-OFFICIAL-01 | 复用 `apps/web/e2e/fixtures/diagram-file/proc.puml`；settings 预设 `diagrams.modes.plantuml='official'`；同一拦截面：plantuml.com → abort、kroki.io → fulfill 最小 svg；两 host 请求台账 | 打开 `proc.puml` | ① `.vv-html-content img[src^="https://kroki.io/plantuml/svg/"]` 可见（30s 上界）——official→kroki 回落接管（**须等该 src 前缀的 img**：加载失败的官方 img 仍有布局盒，`toBeVisible` 会假通过）；② `.vv-error-card` 计数 0；③ kroki.io 请求 ≥ 1（回落确曾发生）；④ **终态之后**取计数：plantuml.com 请求恰 1 次且 URL 匹配 `^https://www\.plantuml\.com/plantuml/svg/[0-9A-Za-z_-]+$`（官方编码字母表、无填充） | 否 | —（新增锚，本域无既有缺陷登记；打红面见 §3.1） |

编号沿用 docs/e2e/README §3.2 约定：一个 test 对应一个场景编号；表驱动场景按型拆 test 时以编号后缀带型名（`DIA-KROKI-01/pikchr`、`DIA-CDN-01/d2`、`DIA-LOCAL-01/svgbob` …），DIA-SIZE-01 的两个独立分支按后缀 `DIA-SIZE-01/exact`、`DIA-SIZE-01/over` 落两个 test，仍属同一场景编号。**10 个场景编号 → 35 个 test**（LOCAL 2 + KROKI-01 15 + KROKI-02 2 + C4-01 2 + CDN-01 8 + SERVER-01 1 + SIZE-01 2 + SRC-01 1 + SAN-01 1 + OFFICIAL-01 1）。

### 排除项与理由

| 编号 | 排除场景 | 理由 |
| --- | --- | --- |
| DIA-X-01 | server 档真链路（`POST /api/compute/diagram` 服务端渲染 svg） | 需 `server/target/release/vviewer` 二进制 + `playwright.server.config.ts` 通道；本机无二进制，release 构建需重编 301 个 tree-sitter grammar，代价与本次范围不成比例 |
| DIA-X-02 | `krokiVia='server'` 服务端代发（`POST /api/kroki` 内联 svg） | 需已连接服务端且宣告 `kroki-proxy` 能力；default 套件无服务端（DSV-01/02 已在 e2e-server 通道承担） |
| DIA-X-03 | CDN 引擎真网实渲染（jsdelivr 真下载出 svg） | 依赖真网外域可达；本域锚一律离线可跑，真网面由 md 围栏域 CDN-01/DSV-04/DSV-06 承担（那里有 `skipIf offline` 策略位） |
| DIA-X-05 | CDN 档双失败终态（jsdelivr + kroki 双 abort → 源码回退） | 与 DIA-KROKI-02 的终态断言同形（单跳文案 + 源码承接），增量有限，名额让给 DIA-OFFICIAL-01 |
| DIA-X-06 | 在飞守卫 chainToken 连切（render→source→render 后旧链迟到落定作废） | 时序竞态面，e2e 不可稳定锚；jsdom 单测已锚（`packages/vviewer-render-text/test/diagramFile.test.ts` 在飞守卫组）。**已声明但仍未覆盖**：official→kroki 回落链的代币守卫（`diagramFile.ts:420-435`，token 快照不递增）与 `attemptRendered` 的代币语义不同，文件渲染器 e2e 侧无锚 |
| DIA-X-07 | mobile 视口变体 | 图表引擎渲染面与视口无关，mobile 复跑只翻倍套件时长无增量覆盖 |
| DIA-X-08 | mermaid / graphviz / plantuml 三型既有行为 | 已被 DIA-FILE-01~05 覆盖，不重复造锚 |
| DIA-X-09 | 注册面数量 / 扩展名全覆盖清单断言（29 型、33 扩展名计数） | 硬约束禁项；注册面由单测锚定（`diagramFile.test.ts` 注册面组），e2e 侧只对具体型的行为断言 |
| DIA-X-10 | mermaid 主题即时重画（`applyTheme`）在文件域的落点 | 需外观事件桥接（`vv:appearance-applied`）与主题设置面板联动，且 md 域已有 T7 主题重画锚、单元层已有锚；本轮名额让出，可作下一批 |
| DIA-X-11 | 图表文件在「打开方式 / 另存为」等壳层的行为 | 属 OPEN-AS / SAVE-AS 域，不属 DIA |

**原 DIA-X-04 已升格为正式锚**：server 档未连接服务端时回落 local（`modes.graphviz='server'` → `serverDiagramOf` 恒 false → 回落 local 出本地 svg、零 `/api/compute` 请求）原以「名额已满」排除——本轮复核指出该面离线可跑且属 workflow 的 DIA focus 链（server→local→kroki→source），故落为 **DIA-SERVER-01**（见 §2）。

## 3. 验收行为

本域锚的判据是「产品哪一处改动会让它变红」——逐场景列出可打红的产品变更面。凡是只能被「元素存在」打红、或恒真的断言一律不落（自查结论见 §3.2）。

### 3.1 各场景的打红面

| 场景 | 判据（产品行为） | 会打红的产品变更 |
| --- | --- | --- |
| DIA-LOCAL-01 | 本地 npm / wasm 引擎档在无网络条件下直出 svg，**svg 内含夹具对应的节点文本**，且**不发**任何三方请求 | ① 装配序颠倒使 `.nomnoml`/`.svgbob` 被 code 渲染器抢注（无 svg）；② 引擎出空图/错图（文本集非 `['A','B']` / `['a']`）；③ 本地引擎降级链误走 kroki（出现 img / 三方请求计数非零）；④ 引擎失败未回落而是直接落源码面（`.vv-code` 非零） |
| DIA-KROKI-01 | 15 个 kroki-only 型各自直发 `kroki.io/<本型>/svg/<base64url>` | ① 型段写死/串型（URL 段与本型不符）；② 编码形态变（base64 带 `+/=` 或改用 query 形态）；③ 未走 kroki（如误落本地引擎或源码面） |
| DIA-KROKI-02 | kroki-only 型失败终态是**单跳**文案，且不触发官方服务器重试 | ① 失败文案统一成两跳形态（含「官方服务器」）；② 文案漏型 id；③ 非 officialServer 型误触发官方重试（plantuml 请求计数非零）；④ 失败后未落源码视图（图形面残留 / 源码钮未激活） |
| DIA-C4-01/kroki | c4plantuml 默认 kroki 档直发 `kroki.io/c4plantuml/svg/…`（型段随型而变） | ① 型段串到 plantuml（`/plantuml/svg/`）或其它型；② c4plantuml 未落 kroki 档（出现源码面 / 失败卡） |
| DIA-C4-01/official-retry | c4plantuml（officialServer 型）kroki 失败触发**官方重试一跳**，终态为两跳文案 | ① officialServer 旗标失效（官方重试请求缺席 → 终态退化为单跳文案）；② 官方重试 URL 形态漂移；③ kroki 段型段串型；④ 官方重试后未落源码视图 |
| DIA-CDN-01 | CDN 档引擎加载失败后回退 kroki 第一跳，且**曾试的是本型引擎包** | ① 包名 token 写错（加载了别型的包）；② 引擎请求次数异常（0 次 = 没走本型引擎；>1 次 = 重复加载——计数在终态断言之后取，迟到的第二次请求可见）；③ 回退链断裂（kroki img 不出现 / 落到失败卡）；④ 本地引擎意外成功（出现 svg，说明 CDN 拦截未生效） |
| DIA-SERVER-01 | server 档在未连接服务端时回落 local：出本地 svg、零 `/api/compute` 请求 | ① 未连接服务端时仍发 `/api/compute/diagram`（服务端代理计数非零）；② 未回落 local 而直接落源码面/失败卡；③ 回落后误走 kroki（出现 img / 三方计数非零） |
| DIA-SIZE-01/exact | 恰 2MiB 不触发大小门（判据是严格大于） | 大小门判据改成 `>=`（等界即降级 → 出现超限卡与 `vv-degraded` 类）；或降级路径误挂 `.vv-html-content` 骨架 |
| DIA-SIZE-01/over | 2MiB+1 触发大小门：直落源码视图 + 超限降级卡，**且在 pikchr 默认 kroki 档下仍零引擎外呼**（次序证据） | ① 阈值上移/判据改 `>`（不降级 → 无卡）；② **大小门被挪到模式裁决/引擎链之后**（pikchr 默认 kroki 档会发出 kroki.io 请求 → 三方计数非零）；③ 降级标记 `vv-degraded` 缺失；④ 降级卡文案/阈值明细/文件名 meta 漂移；⑤ 降级路径误建渲染骨架（`.vv-html-content` 出现） |
| DIA-SRC-01 | source 档只有源码视图：无工具条、无渲染请求 | ① source 档误建 toolbar（三个缺席断言同时红）；② source 档仍调引擎/发请求（三方计数非零）；③ 源码视图未挂载或内容为空 |
| DIA-SAN-01 | 本地引擎产出物过 `sanitizeDiagramFragment`：script 与 `on*` 事件属性被剥离，副作用不发生 | ① 产出物不再过消毒（script 元素在 DOM / `onclick` 属性在 / 点击后 `__vvDiaPwned` 被置位）；② 消毒过严（`<text>` 被剥 → 文本断言红）；③ mock 模块未被加载（无 svg / 无 CDN 请求） |
| DIA-OFFICIAL-01 | official 档直连官方服务器（官方编码 URL 形态），官方图失败回落 kroki | ① 官方 URL 形态漂移（字母表/填充/路径段）；② 回落链断裂（kroki img 不出现 → 落失败卡）；③ official 档误回落源码视图而无 kroki 一跳；④ 官方请求数异常（0 次 = 未直连官方；>1 次 = 重复请求——计数在终态断言之后取，kroki 再失败触发的官方第二跳可见） |

### 3.2 断言纪律自查（恒真断言排查）

- **无「只断言元素存在」的条款**：每个场景都至少含一条取值/状态类断言（URL 形态、文案原文、类名、计数、字节数、产物文本集），并配一条缺席断言（`not.toContainText` / `not.toHaveAttribute` / 计数 0）。**复核补强**：DIA-LOCAL-01 原先只断言「svg 可见」，引擎返回空 svg 也能过——现补产物文本锚（nomnoml `['A','B']`、svgbob `['a']`，node 侧渲染实测取到的文本节点集）。
- **无注册面硬编码计数**：本域不断言「29 型 / 33 扩展名」之类注册面数量（注册面由单测 `packages/vviewer-render-text/test/diagramFile.test.ts` 锚定）；表驱动只对**具体型**的行为断言（URL 型段、包名 token、krokiType 段）。
- **缺席断言均有在场信号在前**（**例外：DIA-SIZE-01/over 的「零三方外呼」**——见下条；其余成立）：失败卡可见 → 才判「detail 不含官方服务器」；源码视图可见 → 才判「无工具条」；kroki img 可见 → 才判「plantuml 零请求」；渲染完成 → 才判「三方零请求」。
  - **例外说明（over 分支）**：该分支的缺席断言是**计数器型**（三方请求计数 0），不是 DOM 缺席；它的判别力不来自「在场信号」，而来自**夹具模式的选择**——pikchr 留注册表默认 kroki 档，故「零外呼」只可能由大小门短路造成。旧版注入 `modes.pikchr='source'` 时零外呼由模式决定（source 档根本不发请求），与大小门次序无关——**恒真，已改**（复核变异 B 实测：把大小门整块移到模式裁决与 DOM 骨架之后，旧版 exact/over/src 三例仍全绿）。
  - 同批删掉的还有 over 分支的「无工具条」断言：降级路径 `diagramFile.ts:219` 的 `target.replaceChildren(card, degraded)` 必清空骨架，该断言无论大小门与骨架的次序如何都成立（恒真），不作证据。改用的证据是「零三方外呼（默认 kroki 档）」+「`.vv-html-content` 计数 0（降级路径不建渲染骨架）」。
- **计数类断言给足余量**：svg 可见 30s、img 可见 20s、失败卡 30s（CI 2 核 + 375×500 视口为已知脆弱面，本域只在 chromium 跑，见 §2 公共环境）。
- **计数取于终态之后，不用只增计数器上的 `expect.poll`**（复核纠正）：`expect.poll` 对只增计数器会在「计数首次等于期望值」的瞬间放行，迟到到达的第二次请求不可见——DIA-CDN-01 的「CDN 请求恰 1 次」与 DIA-OFFICIAL-01 的「官方请求恰 1 次」改为**终态断言之后一次性取计数**（终态 = kroki img 可见 / 失败卡与源码视图落定），此时「>1 次 = 重复加载 / 重复请求」才真能打红。终态前的等待一律用 locator 自动等待。
- **网络面**：全部用例先挂 `context.route` 拦截面（abort 或 fulfill mock），无裸依赖真网的路径；「零请求」断言的台账在 route 命中处记账（route 命中即请求确曾发出），不依赖页面网络栈观测（SW 在位时 `page.on('request')` 观测面不可靠）。服务端代理面（`/api/compute/diagram`、`/api/kroki`）另挂一条同源拦截台账（命中即记账并 abort），用于 DIA-SERVER-01。

### 3.3 已知的实现脆弱性（非缺陷，备查）

`diagramFile.ts:356-365` 的 `mountImg` 先置 `src` 后挂 `error` 监听（浏览器 error 事件异步派发，实测回落链正常）；`diagramFile.ts:380-413` 中 official 档回落 kroki 后若 kroki 再失败会再试官方一跳（有界重试，终态文案仍为两跳形态）。两处均为实测行为正确、非缺陷，本域锚不因此放宽。

### 3.4 覆盖度与已知未覆盖面

- **型覆盖**：29 型中除既有锚的 3 型（graphviz / mermaid / plantuml）外，其余 **26 型全部落锚**——本地 npm 1（nomnoml）+ 本地 wasm 1（svgbob）+ CDN 本地引擎 8（d2/dbml/vega/vegalite/excalidraw/bpmn/bytefield/wavedrom）+ kroki-only 15（pikchr/ditaa/blockdiag/nwdiag/actdiag/seqdiag/erd/structurizr/tikz/umlet/goat/wireviz/packetdiag/rackdiag/symbolator）+ 官方服务器族 1（c4plantuml）。
- **kroki-only 单跳失败文案**：覆盖 **2/15 型**（pikchr、ditaa）——其余 13 型走同一条 `mountKroki` 错误分支（`diagramFile.ts:396-412`），文案仅取 `diagram.id` 差异；复核判为可接受，未逐型铺开。
- **未覆盖面（已声明）**：在飞守卫 chainToken 连切（官方→kroki 回落链的代币语义与 `attemptRendered` 不同，文件域 e2e 侧无锚，见排除表 DIA-X-06）；server 档真链路与 `krokiVia='server'` 代发（需服务端二进制 / 已连接服务端，见 DIA-X-01/02）；CDN 引擎真网实渲染（见 DIA-X-03）。
- **既有锚重叠面**：DIA-SIZE-01/over 与既有 `b-diagram-file.spec.ts` 的 DIA-FILE-05（big.dot >2MB）钉同一降级行为，但增量有三处——① **精确边界夹具**（2MiB+1 字节，而非 2.2MB）；② 夹具类型为 pikchr（kroki-only 型）而非 dot；③ **次序证据**：pikchr 默认 kroki 档下「零三方外呼」只可能由大小门短路造成（DIA-FILE-05 的 dot 型默认 local 档，零外呼与大小门次序无关）。

## 4. 环境与数据（夹具与断言锚）

| 夹具 | 规格 | 用于场景 |
| --- | --- | --- |
| nomnoml 最小图 | `[A]->[B]\n`（代码内合成，npm 引擎零锚型）；产物文本锚 = svg 内两个 `<text>` 节点 `A` / `B`（node 侧渲染实测文本节点集） | DIA-LOCAL-01/nomnoml |
| svgbob 最小盒图 | `+-->+` / `| a |` / `+<--+` 三行（与 CDN-03 同款盒图）；产物文本锚 = svg 内 `<text>` 节点 `a`（node 侧 wasm 渲染实测） | DIA-LOCAL-01/svgbob |
| c4plantuml 内容 | `@startuml\nC4 -> Context: c4\n@enduml\n`（代码内合成；扩展名 `.c4plantuml` 为注册表同名扩展） | DIA-C4-01/kroki、/official-retry |
| server 档内容 | `digraph { server_mode -> local_engine }\n`（代码内合成，扩展名 `.dot`） | DIA-SERVER-01 |
| kroki-only 15 型表 | (类型 id, 扩展名, krokiType, 内容 `x <type>\n`)；扩展名取 `DIAGRAM_FILE_EXTS`（`diagramFile.ts:59-89`）——umlet→`uxf`、structurizr→`dsl` 为造名扩展名 | DIA-KROKI-01 |
| kroki fulfill 应答 | 最小 `<svg>` body（与 b-cdn-diagram-engines `SVG_BODY` 同串） | DIA-KROKI-01 / DIA-CDN-01 / DIA-OFFICIAL-01 |
| CDN 档 8 型内容 | 各型最小可读源（excalidraw 空 elements JSON / bpmn 空 definitions XML / vega·vegalite 空 spec JSON / wavedrom signal / bytefield draw-box / dbml 单表 / d2 `x -> y`）——引擎模块被 abort，内容只作意图留档，不参与判据 | DIA-CDN-01 |
| plantuml 内容 | 复用 `apps/web/e2e/fixtures/diagram-file/proc.puml`（`@startuml … @enduml`） | DIA-OFFICIAL-01 |
| 大小门双夹具 | 代码内合成字节：`synthDiagramText(n)`——每行 80 字符 + 换行 = 81 字节、末行补齐到精确字节数（**多行短行**而非单行巨串：虚拟滚动只渲染可视区行，单行 2MB 会压垮布局面）；注入前用 `new TextEncoder().encode(x).byteLength` 自证字节数（2×1024×1024 与 2×1024×1024+1） | DIA-SIZE-01/exact、/over |
| source 档内容 | `hello source\n` | DIA-SRC-01 |
| 假 dbml 模块 | `context.route` fulfill 一段 ESM：`export function run(src,fmt)` 返回 `<svg width=200 height=60>` 串，内含 `<script>window.__vvDiaPwned=1;</script>`、铺满整块的 `<rect … onclick="window.__vvDiaPwned=2"/>` 与 `<text>hello</text>`；`content-type: text/javascript` + `access-control-allow-origin: *`（勘察实测 fulfill 无需 ACAO 头即可被动态 import 消费，落库用例仍附 ACAO 兜底跨浏览器 CORS 面）。rect 铺满整块是为了让点击落点必然命中 rect 自身——「副作用不发生」这条断言才不是恒真 | DIA-SAN-01 |

断言锚对照（源码契约）：注册面与扩展名映射 `diagramFile.ts:59-89`；大小门阈值 `diagramFile.ts:49`（`2 * 1024 * 1024`，判据 `>` 严格大于）与降级卡文案 `diagramFile.ts:203-243`；模式裁决 `diagramFile.ts:132-149`（requested=source → 直接 `source`，不建工具条 `:273-288`）；kroki URL 形态 `diagrams.ts:120-128`（deflate + base64url 无填充）；plantuml 官方 URL 形态 `diagrams.ts:106-114`（deflateRaw + 自定义字母表）；kroki-only 型 `krokiType=id`（`diagrams.ts:44-50`、`:66-73`）；CDN 引擎 URL 形态（`cdnEngines.ts:19/45/64/105/120/130/144`）；失败文案分档 `diagramFile.ts:396-412`（单跳 `kroki 渲染失败（图片加载错误）：<id>` / 两跳 `kroki 与官方服务器渲染失败…`）；official→kroki 回落 `diagramFile.ts:420-435`；sanitize 入口 `diagramFile.ts:327`（server 档）与 `:347`（本地引擎档），实现 `packages/vviewer-sanitize/src/sanitize.ts:441-451`（DOMPurify 默认剥离 `script` 与 `on*` 属性）。

## 5. mock 与离线纪律

- **拦截面用 context.route，不用 page.route**：SW 控制页面后 jsdelivr 请求经 SW 发出，`page.route` 拦不到（实测命中 0 次、请求真出网并连带拉到该包的真实依赖分片）；`context.route` 命中 1 次（§6 P-A/P-B/P-C）。本仓既有 `b-cdn-diagram-engines.spec.ts:29-32` 的 DM-03 备案记的是同一现象的早期版本。
- **落库实现：单条正则拦截面**——`context.route(/(kroki\.io|cdn\.jsdelivr\.net|plantuml\.com)/, handler)` 一条接管三 hosts，handler 内按 URL 分派 abort / fulfill 最小 svg / fulfill 假 ESM；台账在 handler 入口记账。理由：① 避免多挂同 host 的 glob 路由时「后注册者优先」互相遮蔽；② 记账点即拦截点，请求确曾发出的凭据不依赖页面网络栈观测（SW 在位时 `page.on('request')` 观测面不可靠，见 §3.2）。
- **route glob 写法（备查，落库未用）**：主机名不含前导斜杠——kroki 用 `'**/kroki.io/**'`（有斜杠，因 URL 形如 `https://kroki.io/...`），plantuml 用 `'**plantuml.com/**'`（无斜杠，匹配 `www.plantuml.com`）。写成 `'**/plantuml.com/**'` 时 URL 中不存在 `/plantuml.com/` 子串，route 不命中、请求挂起而非报错，失败会以「回落未发生」的面目出现（勘察踩坑，见 §6）。
- **预期 abort 的 URL 必须在 route 命中计数里可观测**：route 计数为 0 即 mock 未生效，不得继续等下游终态。
- **不再需要 SW block**：本域改用 `context.route` 后，SW 在位与不在位均能拦到第三方请求（§6 P-A/P-B/P-C/P-F 均在 SW controller 就绪后实测）；若实现者仍想用 `page.route`，则必须配 `test.use({ serviceWorkers: 'block' })`，否则拦截面随 SW 控制时机漂移（首轮勘察即踩：SW 未接管时 page.route 能拦、接管后拦不到）。
- **请求计数只统计第三方主机**（kroki.io / cdn.jsdelivr.net / `*.plantuml.com`），不统计同源应用资产（`/grammars/*.wasm`、本地引擎 chunk 等），避免把正常资产加载误判为外呼。
- **失败文案锚双证**：单跳文案既断言含 `kroki 渲染失败（图片加载错误）：<id>`，又断言不含 `官方服务器`；不只断言标题（标题两跳/单跳同文）。
- **待控制器修订（方案条文与实测冲突）**：本域方案分配书写的是「外域 CDN 一律 `page.route` abort」，但 SW（`clientsClaim`）接管后 `page.route` 命中 0 次、请求真出网（探针 P-A/P-B，见 §6）；落库实现改用 `context.route` 单条正则拦截面（复核轮实跑 32 passed 验证有效）。**建议控制器修订 e2e 铁律规则 7 与 HARNESS_TRAPS 第 1 条**：凡依赖外域 CDN 的用例一律用 `context.route`（若坚持 `page.route` 则必须配 `test.use({ serviceWorkers: 'block' })`），避免其余域实现者照字面踩 SW 拦截坑。

## 6. 勘察与验证记录（2026-11-08）

以一次性勘察脚本（跑完即删，未入库）在本机 preview 面（`pnpm vite preview --host 127.0.0.1 --port 4173`，HEAD `e1d5836` 的既有 build）验证各场景的可达性，均通过：

- `npx playwright test e2e/b-diagram-file.spec.ts --project=chromium --reporter=line` → **6 passed**（既有 DIA-FILE 锚在 HEAD 仍绿，作为基线确认）。
- 勘察轮 1（8 例：kroki-only 15 型 URL 形态 / 单跳失败文案 / nomnoml / svgbob / source 档 / 大小门等界 / dbml CDN 回退 / sanitize 剥离）→ **8 passed**。
- 勘察轮 2（5 例：official 档 URL 形态与回落 / server 档未连接回落 local / 显式 kroki 档 / CDN 8 型表驱动 / `.vv-degraded` 类分支）→ 首轮 4 passed + official 例失败；定位为勘察脚本自身的 route glob 写错（`plantuml.com` 前多写斜杠导致请求挂起而非 abort），改正后 **5 passed**；加 `serviceWorkers: 'block'` 变体复跑同样全绿。
- 勘察轮 3（CDN 8 型 jsdelivr 请求 URL 打印）→ 每型恰 1 次 jsdelivr 请求且 URL 与 `cdnEngines.ts` 各实现行一一对应（`@excalidraw/utils@0.1.5`、`bpmn-js@18.31.0`、`vega-embed@7.3.0`、`wavedrom@3.7.0`、`bytefield-svg@1.11.0`、`@softwaretechnik/dbml-renderer@1.0.31`、`@d2lang/d2@0.1.34`），kroki 回退 URL 段随型而变。

### 第二轮（评审后按 SW/context.route 复核，2026-11-08）

评审批「外域 CDN 一律 page.route abort」与实测相反，本域据此复核并改装置：

- 探针 P-A（`page.route` + SW controller 就绪后打开 .dbml）→ `pageRouteHits=0`，`context.on('request')` 记录到 `ctx:sw:https://cdn.jsdelivr.net/npm/@softwaretechnik/dbml-renderer@1.0.31/+esm`（并连带真实依赖分片 zod / @aduh95/viz.js）——请求真出网，拦截面丢失。根因：`apps/web/vite.config.ts:789` 的 `urlPattern: /^https:\/\/cdn\.jsdelivr\.net\/npm\/.*/` CacheFirst 规则（:784-790 注释自陈覆盖 CDN 图表引擎）。
- 探针 P-B（同装置改 `context.route`）→ `ctxRouteHits=1`，回退 kroki img 出现（`img count=1`）。
- 探针 P-C（`context.route` fulfill 假 dbml 模块，**不带 ACAO 头**）→ 假模块被加载、svg 渲染、`script count=0`、`pwn=undefined`——DIA-SAN-01 的消毒链锚在 context.route 下成立且无需 CORS 头。
- 探针 P-D（`context.route` abort kroki + abort plantuml）→ 单跳失败卡文案命中「kroki 渲染失败（图片加载错误）：pikchr」、`official hits=[]`——DIA-KROKI-02 在新装置下成立。
- 探针 P-E（`context.route` abort plantuml + fulfill kroki）→ official→kroki 回落 img 可见，两 host 计数各 1——DIA-OFFICIAL-01 成立。
- 探针 P-F（`context.route` abort jsdelivr，8 型表驱动）→ 每型恰 1 次 jsdelivr 命中且 URL 与 `cdnEngines.ts` 各实现行一一对应，kroki 回退 URL 段随型而变，`errCards=0`——DIA-CDN-01 的 per-type 因果锚在 SW 在位下成立。
- 基线复测：`npx playwright test e2e/b-diagram-file.spec.ts --project=chromium --reporter=line` 连跑 3 轮 → **每轮 6 passed**（HEAD `e1d5836`），本域既有锚未见 flaky（与评审在 FOM 域观测到的 FO-02 树行点击 flaky 不同源）。

勘察结论中未确认产品缺陷；两处实现脆弱性记档备查（均实测行为正确，非缺陷）：`diagramFile.ts:356-365` 的 `mountImg` 先置 `src`（:360）后挂 `error` 监听（:362）（浏览器 error 事件异步派发，实测回落链正常），以及 `diagramFile.ts:380-413` 中 official 档回落 kroki 后若 kroki 再失败会再试官方一跳（有界重试，终态文案仍为两跳形态）。

### 落库轮（2026-11-08，脚本入库）

`apps/web/e2e/b-diagram-file-2.spec.ts` 已落库（初版 8 个场景编号 → 32 个 test；复核轮后为 10 个场景编号 → 35 个 test，chromium project，beforeEach 跳过 mobile）。相对勘察脚本的落库差异：

1. **拦截面合并为单条正则**（`/(kroki\.io|cdn\.jsdelivr\.net|plantuml\.com)/`）替代逐 host glob——规避「后注册者优先」的路由遮蔽，并让请求台账的记账点与拦截点同源（见 §5）。
2. **表驱动场景按型拆 test**（编号后缀带型名）——同一 test 内切 tab 时旧实例 DOM 尚未销毁，断言会落在上一型的产物上（切 tab 后旧实例经 `destroy()` 清空 `.vv-html` 与子树，销毁与新渲染之间存在异步窗口）。
3. **大小门夹具改为多行短行**（`synthDiagramText`：每行 81 字节，末行补齐到精确字节数）——单行 2MB 的巨行会让虚拟滚动的行布局面吃紧；字节数仍在用例内以 `TextEncoder` 自证。
4. **DIA-SAN-01 的脏 payload 改为「铺满 rect + 文本旁置」**——点击落点必然命中 rect 自身，「onclick 存活必被触发」这条因果才成立；另加一条产出物全域 `on*` 属性扫描（属性级判据，不依赖点击）。
5. **计数类断言改用 `expect.poll`**（CDN 恰 1 次 / 官方恰 1 次）——**该做法经复核判定为假绿，已在复核轮改为「终态之后一次性取计数」**（见下节）。

### 复核轮（mustFix 前的 32 test 形态，实跑证据）

复核方在本机 preview 面上实跑本域 spec（命令与输出来自复核轮实测）：

- `cd apps/web && ./node_modules/.bin/playwright test e2e/b-diagram-file-2.spec.ts --project=chromium --reporter=line` → **32 passed (19.5s)**。
- 同命令加 `--retries=0` 复跑 → **32 passed (23.1s)**。
- 类型检查 `npx tsc --noEmit -p apps/web/tsconfig.e2e.json` → **退出码 0**。

**稳定性口径**：本域以 `--retries=0` 的结果为准——`apps/web/playwright.config.ts:12` 的 `retries: 1` 会把 flaky 洗成绿，故上文「勘察轮 1/2/3」与「基线连跑 3 轮」的 passed 结论是在**重试开启**下采集的，不足以证明无 flaky；复核轮的 `--retries=0` 复跑（32 passed）才是本域的首个无重试证据。

### 复核轮改动（本轮，mustFix 落实）

1. **DIA-SIZE-01/over 去掉 source 注入**——pikchr 留注册表默认 kroki 档，「零三方外呼」才真正证明大小门早于引擎链；删掉恒真的「无工具条」断言，改以「零三方外呼（默认 kroki 档）」+「`.vv-html-content` 计数 0」作证据（复核变异 B：大小门整块后移时旧版三例仍全绿）。
2. **计数断言移到终态之后**——DIA-CDN-01「CDN 恰 1 次」、DIA-OFFICIAL-01「官方恰 1 次」由 `expect.poll`（只增计数器上首次命中即放行）改为终态断言之后一次性取计数，迟到的第二次请求可见。
3. **补 c4plantuml（DIA-C4-01）**——kroki 段（型段 `c4plantuml`）+ 官方重试一跳（两跳文案 + 官方请求在案），补齐「26 型零锚」的最后 1 型。
4. **补 DIA-SERVER-01**——server 档未连接服务端时回落 local（原排除项 DIA-X-04 升格）：出本地 svg、零 `/api/compute` 与 `/api/kroki` 请求。
5. **DIA-LOCAL-01 补产物内容锚**——nomnoml `['A','B']`、svgbob `['a']` 的文本节点集断言（引擎出空 svg 也会红）。
6. **DIA-SAN-01 注释校正**——`<script>` 经 innerHTML 注入本就不执行，脚本侧由「script 元素计数 0」负责，副作用断言只证事件属性侧。

**执行状态（本轮）**：改动后 spec 为 **35 个 test**（`npx playwright test --list --project=chromium e2e/b-diagram-file-2.spec.ts` → `Total: 35 tests in 1 file`；类型检查 `npx tsc --noEmit -p apps/web/tsconfig.e2e.json` 退出码 0）。**本轮未在实现者会话内实跑 playwright**——工作流约定「串行跑由控制器统一调度」（端口 4173 与 CPU 统一调度），故上表的 32-test 实跑证据对应的是 mustFix **前**的形态；本轮新增的 3 个 test 与 4 处断言改动待统一跑复核。
