# 图表 server 模式与 kroki 代发 e2e — 场景（P3 服务端图表收口）

> 来源：plan `.superpowers/sdd/2026-10-23-renderer-lang-override-p3-server-types/`（Task 9）。spec 依据：`docs/superpowers/specs/2026-10-23-renderer-lang-override-markpad-alignment-design.md` §8（图表 server 模式、/api/compute/diagram、/api/kroki 服务端代发、krokiVia 设置与能力协商）+ §9.2（mermaid 主题即时重画，Task 7 承接）+ §10（kroki 类型扩容 30 类与新 CDN 引擎，DSV-04/06 为 Task 8 申报的真网承接）。服务端契约单测面（diagrams.rs/kroki.rs/core）不在本档——此处只收浏览器端到端面。
>
> 脚本：`apps/web/e2e/b-diagram-server-kroki.spec.ts`（DSV-03/04/06 + T7，默认通道双 project）与 `apps/web/e2e-server/b-diagram-server-kroki.spec.ts`（DSV-01/02/05，server 通道 chromium）。旧锚承接：`b-settings-center-deep.spec.ts` SC-10（30 类扩容后网格行数锚 18→30 + diagrams 节落盘 toEqual 补全五键，见 §5）。

## 1. 目的与来源

Task 4（b-compute-diagrams.spec.ts）已锚「服务端 markdown 后处理」面（整篇远程、契约 div 接回 wrapper）；本轮补齐 spec §8 的另外两个消费面与两个能力协商 UI 面：

1. **按语言 server 模式**（DSV-01）——客户端管线 `effectiveModeOf` 经 health `diagrams` 子集能力协商后单围栏 POST `/api/compute/diagram`，与 Task 4 的整篇 `/api/compute/markdown` 路径互斥可辨（`data-md-diagram-wrapped` 指纹只在后处理路径出现）；
2. **krokiVia=server 代发**（DSV-02）——kroki 型围栏从 img 直发改走 `/api/kroki` 内联 svg，kroki-proxy 能力缺失自动回落 img（DSV-03b）；
3. **能力协商 UI 面**（DSV-03a/DSV-05）——未连接「服务端代发」option disabled ↔ 已连接 enabled，graphviz 行「服务端」档的有无（注册表 `server` 旗标投影）；
4. **§10 新引擎真网面**（DSV-04/06）——wavedrom 默认 local 与 d2 显式 local 档的 CDN 引擎真渲染（T8 台账申报的承接项）；
5. **T7 承接**（§9.2）——mermaid 主题设置切换即时重画已打开文档。

## 2. 场景清单

### server 通道（`playwright.server.config.ts`，release 二进制；拓扑 b-compute-diagrams 同款：webServer :4174 不参与，spec 内 beforeAll spawn 同源实例 :4186 `--compute --kroki-host http://127.0.0.1:4187`，afterAll stop）

| 编号 | 前置条件 | 步骤 | 期望 | mock 策略 |
| --- | --- | --- | --- | --- |
| DSV-01 | 同源连接（computePolicy=local + diagrams.modes.graphviz='server' 经 localStorage 预注入） | 打开含 ```dot 围栏的 md | ① 真实 `POST /api/compute/diagram` 发生且 200（response 观测 + poll）；② `.md-diagram-view svg` 可见；③ `[data-md-diagram-wrapped]` 计数 0（证非 Task 4 的 markdown 后处理面）；④ 状态栏「渲染: 本地」（正文留本地，仅单围栏走服务端） | 无需 mock（layout-rs 真实引擎；服务端原生集 graphviz/svgbob） |
| DSV-02 | 同源连接（computePolicy=local + diagrams.krokiVia='server'） | 打开含 ```plantuml 围栏的 md | ① `POST /api/kroki` 200；② **mock 上游命中台账**：路径 `/plantuml/svg` + body 含源码原文（core kroki.rs raw 透传语义）；③ 视图 `[data-vv-diagram="kroki-proxy"] svg` 内联可见、`img` 计数 0 | **`--kroki-host` 指 spec 内自起 node http mock 上游**（见 §3） |
| DSV-05 | 同源连接（默认设置） | 打开设置中心 → 图表组 | 「Kroki 通道」select：client 值、「服务端代发」option `toBeEnabled`（DSV-03a 的对照面）；`graphviz 渲染模式` 行含 `server` option、`plantuml 渲染模式` 行无（`t.server` 旗标 UI 投影） | 无需 mock |

### 默认通道（`playwright.config.ts`，chromium + mobile 双 project；vite preview :4173）

| 编号 | 前置条件 | 步骤 | 期望 | 依赖网络 |
| --- | --- | --- | --- | --- |
| DSV-03a | 不连接（默认通道无服务端） | 打开设置中心 → 图表组 | 「Kroki 通道」select 值恒 client；「服务端代发」option `disabled`（HTMLOptionElement.disabled JS 属性 + disabled 属性双锚——`toBeDisabled` 对 `<option>` 的可禁用面实测不稳定，勿改回） | 否 |
| DSV-03b | localStorage 预设 krokiVia='server'（无连接 = krokiProxy=false）+ `page.route('**/plantuml/svg/*')` fulfill svg | 打开 ```plantuml 围栏 md | 回落面：`img[src^="https://kroki.io/plantuml/svg/"]` 可见（client 直发）；`[data-vv-diagram="kroki-proxy"]` 计数 0（能力缺失不得走代发——pipeline.ts appendKrokiImg 分叉头部 catch 语义） | 否（全 mock） |
| DSV-04 | 真网可达（探测 `page.request.get('https://cdn.jsdelivr.net/', {timeout: 3000})` 失败即 skip——CDN-01 同策略） | 打开 ```wavedrom wavejson 围栏 md | `.md-diagram-view svg` 可见（120s 上界）；无 `md-diagram-error`；kroki.io 请求为零（CDN 成功即不降级） | 是（skipIf offline） |
| DSV-06 | 真网可达（同上）+ localStorage 预设 `modes.d2='local'` | 打开 ```d2 围栏 md | `.md-diagram-view svg` **first()** 可见（180s 上界——@d2lang/d2 wasm 11.5MB）；无错误态；kroki.io 请求为零 | 是（skipIf offline） |
| T7 | localStorage 预设 themeMode=light；`page.route('**kroki.io/**')` abort（mermaid 本地引擎，环境无关） | 打开 ```mermaid 围栏 md → 出图后走设置中心 UI 管线（图表组 → Mermaid 主题 forest → 应用） | 重画锚：svg 根 `id="md-mermaid-N"`（diagramEngines `mermaidSeq` 每渲染递增）poll 必异于初始 id；重画后 svg 可见、`[data-mermaid]` 锚保留、无错误类 | 否 |

### skipIf 策略

DSV-04/06 是本 spec 仅有的真网依赖用例（执行环境无外网时 skip，不假红）；DSV-01/02/05/T7 与 DSV-03a/b 离线稳定（server 通道服务端真引擎/mock 上游皆 127.0.0.1，默认通道全 route mock 或本地引擎）。

## 3. mock 策略记档（kroki 上游）

**page.route 拦不到 kroki.io 上游请求**：DSV-02 的出站段是 vviewer 服务端进程的 reqwest 请求，不经过浏览器网络栈——`page.route('**/kroki.io/**')` 只能拦浏览器侧（img 直发）请求。上游离线模拟的唯一通道是**部署侧配置**：`--kroki-host http://127.0.0.1:4187` 指向 spec 内自起的 node http mock（POST `{lang}/svg` 恒 200 `image/svg+xml`，每轮必重建、不幂等复用——无探测端点）。该形态顺带真实穿过 SSRF 防线（host 只来自部署侧、lang 白名单、raw 源码透传——core kroki.rs 语义），mock 侧命中台账（路径+body）是转发链发生的直接观测面。

前端消费面单独离线验证不依赖上游：DSV-03b 直接拦 `/plantuml/svg/*`（浏览器 img 面）；DSV-02 的前端消费断言（kroki-proxy 容器内联 svg 非 img）在 mock 上游应答上成立，与真实 kroki 应答同构（均为 svg 文本）。

## 4. 夹具与断言锚

| 夹具 | 规格 | 用于场景 |
| --- | --- | --- |
| `dsv-01-server-mode.md` | 标题+段落+```dot `digraph { dsv -> ok }`（server 单测同款最小 digraph） | DSV-01 |
| `dsv-02-kroki-proxy.md` | 标题+```plantuml `Alice -> Bob: dsv` | DSV-02 |
| `dsv-03-fallback.md` / `dsv-04-wavedrom.md` / `dsv-06-d2.md` / `t7-mermaid-theme.md` | 默认通道 spec 内联构造（injectDir，不落 samples） | DSV-03b/04/06/T7 |
| wavedrom wavejson | `{"signal":[{"name":"clk","wave":"p..."},{"name":"dat","wave":"x3.4x","data":["A","B"]}]}`（经典入门样例裁剪） | DSV-04 |
| d2 源 | `x -> y`（最小有向边） | DSV-06 |
| mock 上游应答 | 最小 `<svg><rect/></svg>`（data-* 是否穿过客户端 sanitize 不进断言面） | DSV-02 |

断言锚对照（源码契约）：模式解析与降级链 `packages/render-text/src/markdown/pipeline.ts`（`effectiveModeOf` 能力协商 / `renderServerDiagram` / `renderKrokiViaServer` / `appendKrokiImg` 分叉头部）；能力注入 `apps/web/src/lib/viewer.ts`（setDiagramOptions 闭包现读 `loadCapabilities`/`loadDiagramCapabilities`）；UI 面 `apps/web/src/lib/settings/DiagramsSection.svelte`（krokiProxy 挂载时读会话缓存）；服务端端点 `server/src/routes/compute.rs`（diagram 双 400）/`server/src/routes/kroki.rs`（proxy）；转发纯逻辑 `server/core/src/kroki.rs`（`{host}/{lang}/svg` 拼接、lang 白名单、raw 透传）；mermaid 重画 `packages/render-text/src/markdown/markdownRenderer.ts`（per-instance `vv:diagram-settings-applied` 监听）+ `packages/render-text/src/markdown/diagramEngines.ts`（mermaidSeq id 计数器）。

## 5. 旧锚承接明细

| 锚 | 扩容/新增前 | 承接后 |
| --- | --- | --- |
| SC-10（b-settings-center-deep，默认通道） | 模式网格 `toHaveCount(18)`；落盘 `toEqual({ krokiHost, modes })` 两键 | spec §10 扩容后注册表 30 类——`toHaveCount(30)`；diagrams 节落盘含全形五键（§8.3/§9.2 起 krokiVia/mermaidTheme 恒默认归一值、renderers 空 = 注册表默认），toEqual 补全 `{ krokiHost, krokiVia: 'client', mermaidTheme: 'auto', modes, renderers: {} }`。全量门禁实跑暴露（实锤 30≠18 一处红），断言口径同步，产品代码零改动 |
| SRV-01（t-srv）/SRV-02（b-server-file-service）/CMP-01/2（t-cmp，server 通道） | health `capabilities` 断言 `['file-server']` / `['file-server', 'compute']` | §8.2 起 `kroki-proxy` 恒宣告（core/health.rs：`[file-server, kroki-proxy]`，compute 尾部追加为三元素）——五处 toEqual 同步。实跑暴露，断言口径同步，产品代码零改动 |
| SRV-08（b-server-file-service，server 通道） | 非法 Range 两 case（越界/非数字）同断 `Content-Range: bytes */size` | 8c5fe16（台账 1-2）起双重故障分诊：语法非法在 stat 前即 416（size 未知 → RFC 9110 §14.4 `bytes */*`）、起点越界语法合法 → `bytes */size`——按形态分拆断言。实跑暴露，断言口径同步，产品代码零改动 |
| 服务端图表③（b-compute-diagrams，server 通道） | viz 失败降级 kroki img 依赖真网 kroki.io 快速报错落错误卡 | 本环境浏览器网络栈对 kroki.io 黑洞（连接挂起，img 无 onload/onerror，实测 3 分钟无终态）——abort kroki（`**/kroki.io/**`）确定性令 img error 落错误卡（MD-04 同款注记），锚定「local 接手失败→错误卡+原文」本意。环境依赖定态化，产品代码零改动 |

## 6. 未覆盖面记档

- **graphviz hpcc 渲染器真网 e2e（T6 申报候选）**：viz-js 默认档已有本地出图面（b-md-diagrams/b-cdn-diagram-engines CDN-03），hpcc 档真渲染（@hpcc-js/wasm-graphviz CDN 加载→Graphviz.load→layout）未落 e2e——T8 台账「真渲染待 e2e 真实网承接（同 hpcc 先例）」中 d2 已由 DSV-06 收口，hpcc 同形态可按 DSV-06 模式（settings 预设 `renderers.graphviz='hpcc'` + skipIf offline）后续补，本轮未加（承接清单未列，量力留档）。
- **d2 默认 kroki 档**：defaultMode=kroki 的 img 直发面与 plantuml 同构（DSV-03b 已锚 kroki img 通道），不重复加。
