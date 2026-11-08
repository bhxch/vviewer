# SW 运行时缓存路由 e2e — 场景（SWR 域）

> 来源：`apps/web/vite.config.ts` 的 workbox `runtimeCaching` 路由表（:655-797）与 `genSwCleanup`
> 跨版本清理脚本（:123-169，构建期生成 `apps/web/static/vv-sw-cleanup.js` → 烘焙进产物
> `apps/web/build/vv-sw-cleanup.js`）。残余 A7（worker 图同源 wasm 路由）与残余 A8
> （env `VV_FOREIGN_ASSETS` 跨域镜像域路由）的 e2e 补强。
>
> 脚本：`apps/web/e2e/b-sw-runtime-cache.spec.ts`（SWR-ROUTE-01~07 / SWR-TABLE-01~02 /
> SWR-MIRROR-01 / SWR-EXP-01 / SWR-CLEAN-01~03）。既有锚（相邻域，未改动）：
> `m7.spec.ts:30`、`fix-pwa.spec.ts:59,87,107`、`t-pwa.spec.ts:206,230,251,263,303,352,550,649,736`。
>
> **落库形态**：SWR-CLEAN-01/02 两条缺陷锚**已修产品侧并转正式断言**（清理正则补入
> `vv-worker-wasm` 族，见 §3.1）；SWR-ROUTE-07 亦**已转正式断言**（服务端 fallback 收窄后
> 未知资产 404 不入缓存；cargo 集成锚守服务端契约，见 §3.2）；其余 10 条为常规断言。

## 1. 目的与来源

### 1.1 被测对象

`vite.config.ts` 的 `runtimeCaching` 数组按「先匹配先赢」（workbox 按注册顺序遍历路由，
首个命中者接管）排布运行时路由，全部 `CacheFirst`，`cacheName` 拼 `BUILD_REVISION`，
`cacheableResponse` 只收 200：

| 序 | urlPattern | cacheName 族 | maxEntries | 产品锚 |
| --- | --- | --- | --- | --- |
| 1 | `/\/grammars\/.*\.wasm$/` | `vv-grammars-` | 500 | :659-667（tree-sitter 语法 wasm） |
| 2 | `/\/tree-sitter\.wasm$/` | `vv-runtime-` | 4 | :674-680（web-tree-sitter runtime） |
| 3 | `/\/libarchive\/libarchive\.wasm$/` | `vv-runtime-` | 4 | :689-695（libarchive.wasm，与序 2 同族共用配额） |
| 4 | `/\/queries\//` | `vv-queries-` | 300 | :699-705（tree-sitter 查询 .scm） |
| 5 | `/svgbob_wasm_bg[\w.-]*\.wasm$/` | `vv-diagram-svgbob-` | 2 | :711-717（svgbob 前端 wasm） |
| 6 | `/\/_app\/immutable\/workers\/assets\/.+\.wasm$/` | `vv-worker-wasm-` | 8 | :729-735（**残余 A7**：worker 图同源 wasm） |
| 7 | `/^https:\/\/cdn\.jsdelivr\.net\/npm\/@file-viewer\/assets-/` | `vv-foreign-assets-` | 64 | :747-762（foreign 资产 CDN 直链） |
| 8 | `^<env 镜像 base>`（env 非空且为 http(s) 才生成） | `vv-foreign-assets-` | 64 | :64-72 + :770 展开 `FOREIGN_MIRROR_RUNTIME_CACHING`（**残余 A8**） |
| 9 | `/\/file-viewer-assets\//` | `vv-foreign-assets-` | 64 | :774-785（foreign 资产同源预留槽） |
| 10 | `/^https:\/\/cdn\.jsdelivr\.net\/npm\/.*/` | `vv-cdn-engines-` | 48 | :789-799（CDN 图表引擎通配，**必须排在 7/8 之后**） |

外加 workbox `NavigationRoute`（导航兜底，`navigateFallback: index.html`）与
`precacheAndRoute`（workbox precache 族 `workbox-precache-*`，非 vv-* 运行时族）。

**默认构建实有 9 条运行时路由**（序 8 的 env 镜像路由在 `VV_FOREIGN_ASSETS` 为空时不生成，
`vite.config.ts:37,54-56`）；env 非空且为 http(s) 前缀时为 10 条。

### 1.2 本域要补的缺口

1. **vv-worker-wasm 路由零锚**（残余 A7）：该族此前无任何 e2e 锚——路由删了、族名改了、
   被前面的规则截胡，都无人发现。
2. **foreign 资产 CDN 路由零锚**：序 7 与序 10 的**先后归属**（foreign 直链必须落
   `vv-foreign-assets-`、不得被 jsdelivr 通配规则吞进 `vv-cdn-engines-`）此前只有
   `apps/web/src/lib/foreignAssets.test.ts:126-139` 的**源码文本序**断言，无运行期锚。
3. **env 镜像域路由零锚**（残余 A8）：env 为空时不生成镜像路由，非空时生成一条与 foreign
   同族的镜像路由（base 经 `escapeRegExp` 转义为正则前缀）。
4. **已知产品缺陷（缓存卫生不变量在 A7 上失效）**：`genSwCleanup` 的 current 清单含
   `vv-worker-wasm`（:130），但 activate 里的删除正则漏了该族（:148
   `/^(vv-grammars|vv-runtime|vv-queries|vv-diagram-svgbob|vv-cdn-engines|vv-foreign-assets)-/`）
   → 旧 REV 的 `vv-worker-wasm-*` 缓存永久残留（BUG-60 的不变量在新增族上复发）。
   `apps/web/scripts/check-pwa-build.mjs:67-77` 只断言 cacheName **存在**、拦不住；
   `apps/web/src/lib/foreignAssets.test.ts:142-146` 只断言 current 清单含
   `vv-foreign-assets`、同样拦不住。
5. **缺陷 SWR-DEF-01（已修）**：真实后端曾对未知且非 `.scm`/`.wasm` 的路径返回 200 + index.html
   （`server/src/lib.rs` SPA fallback），而 `/file-viewer-assets/` 路由的
   `cacheableResponse` 只收 200（`vite.config.ts:777-784`）→ fallback HTML 被收进
   `vv-foreign-assets` 缓存，与 `vite.config.ts:776` 的注释承诺相悖。**已修**：服务端 SPA
   fallback 收窄为只对导航请求生效（Accept 含 `text/html`，`server/src/lib.rs`
   `serve_index`），非导航 fetch 的未知资产 URL 一律 404。实测口径与修复锚见 §3.2。

## 2. 场景清单

公共环境：chromium + mobile 两 project（场景不依赖视口，不做 project 跳过）。
装置全部自建在本 spec 内（node:http 假静态服务器 + 合成探针 + 产物内 REV 改写 + 产物层解析器），
不复用其它域 helper，也不抽公共文件——理由见 §2.3。

| 编号 | 前置条件 | 步骤 | 期望 | 关联缺陷 |
| --- | --- | --- | --- | --- |
| SWR-ROUTE-01 | 假静态服务器伺服 `apps/web/build`；SW 由产品自身注册（`+layout.svelte:13` registerSW） | 等 SW activated + controller 在位；fetch `/_app/immutable/workers/assets/swr-probe.wasm` 两次；再断网 fetch 一次 | 该 URL 恰好被 1 个 `vv-*` 缓存持有且族为 `vv-worker-wasm-*`；第二次 fetch 服务端命中计数**不增**（CacheFirst 命中，不再回源）；断网后仍 200（离线二次可用性） | 残余 A7 零锚 |
| SWR-ROUTE-02 | 同上 | fetch `/file-viewer-assets/swr-probe.wasm` | 恰好被 1 个 `vv-*` 缓存持有且族为 `vv-foreign-assets-*`（同源预留槽与 CDN 路由同族计账） | 缺口 2（同源侧） |
| SWR-ROUTE-03 | 同上 | fetch `/file-viewer-assets/swr-missing.wasm`（服务端 404）；再 fetch 同族 200 探针并等其入缓存 | 404 原样透传（status=404，不被 SW 拦成网络错误）；200 探针入缓存（证明 put 通道已跑通）；404 URL **不**被任何 `vv-*` 缓存持有（`cacheableResponse` 只收 200） | 路由族通用不变量 |
| SWR-ROUTE-04 | 同上 | 依次 fetch `/grammars/swr-probe.wasm`、`/tree-sitter.wasm`、`/libarchive/libarchive.wasm`、`/queries/swr-probe/highlight.scm`、`/_app/immutable/assets/svgbob_wasm_bg.swrprobe.wasm` | 每个 URL 恰好被 1 个 `vv-*` 缓存持有，族依次为 `vv-grammars-` / `vv-runtime-` / `vv-runtime-` / `vv-queries-` / `vv-diagram-svgbob-`（URL→族的唯一归属映射口径） | 既有路由映射回归 |
| SWR-ROUTE-05 | 真网可达（**用页面 fetch 探可达性**，非 200/失败即 `test.skip`——CDN-01/CDN-04 同策略） | ① no-cors fetch（opaque 应答）；② cors fetch（200 应答） | ① opaque（status 0）**不入**任何 `vv-*` 缓存（`statuses:[200]` 拒收 status 0）；② 恰好被 1 个 `vv-*` 缓存持有且族为 `vv-foreign-assets-*`（**不被 jsdelivr 通配路由截胡**） | 缺口 2（跨域侧）+ 跨域应答形态 |
| SWR-ROUTE-06 | 真网可达（同上，页面 fetch 口径） | fetch `https://cdn.jsdelivr.net/npm/lodash@4.17.21/package.json` | 恰好被 1 个 `vv-*` 缓存持有且族为 `vv-cdn-engines-*`（不被 foreign 路由截胡） | 缺口 2（跨域侧） |
| SWR-ROUTE-07 | 同上（**已转正式断言**） | fetch `/file-viewer-assets/swr-spa.js`（服务端 404——修复后契约：非导航 fetch 的未知资产由 Accept 收窄回 404）；再 fetch 同族 200 wasm 探针并等其入缓存 | 未知资产 fetch 应答 404；同族 wasm 探针入缓存（put 通道已跑通）；**404 不入 `vv-foreign-assets` 缓存**（`cacheableResponse` 只收 200，拒收 404） | **SWR-DEF-01（已修）** |
| SWR-TABLE-01 | `apps/web/build/sw.js` 存在（CI 在 e2e 前 `pnpm --filter web build`，`.github/workflows/ci.yml:163`） | 解析产物 `registerRoute` 调用表（含 plugins 段与 method 参数），按 workbox 匹配语义（正则对完整 URL 匹配；跨域须从头匹配）解析 9 条代表 URL | 每条 URL 首个命中路由：族归属符合预期（先匹配先赢）、处理器为 `CacheFirst`、方法为 `GET`、`statuses` 恰为 `[200]`、配 `maxEntries>0` 与 `purgeOnQuotaError`；`vv-runtime` 族两条路由共用同一 cacheName 且同一 maxEntries | 缺口 2/3（离线可验面）+ 路由表全参契约 |
| SWR-TABLE-02 | 同上 | 解析产物 `importScripts` 路径与 `manifest.webmanifest` 的 scope；解析客户端产物的 SW 注册 URL/scope | 清理脚本 importScripts 目录与 manifest scope 目录一致（base 接线正确）；importScripts 目标为 `vv-sw-cleanup.js`；SW 注册 URL 为相对路径或带 base 前缀、scope 为 `./` 或与 manifest scope 一致 | VV_BASE_PATH 子路径部署面 |
| SWR-MIRROR-01 | 同上；从构建产物注入字面量读出构建期 `VV_FOREIGN_ASSETS` 值 | 解析产物路由表，按 env 值推导期望的绝对 URL 路由条数（env 空⇒2、env 非空且 http(s)⇒3） | 绝对 URL 路由条数 == env 推导值；每条绝对 URL 路由：字面前缀可命中 + 元字符已转义（按字面匹配）+ 归属 foreign 族或 cdn-engines 族；env 非空时镜像路由字面前缀恰为 env base 且归 foreign 族；env 空时跨域主机集合恰为 `{cdn.jsdelivr.net}` | 残余 A8 零锚（双态） |
| SWR-EXP-01 | 同上；应用启动会预热 `/tree-sitter.wasm` 并入 `vv-runtime` 族（`highlightClient.ts:297`），故族内基线非零 | 经 **tree-sitter 与 libarchive 两条不同路由**写入 6 条不同 URL 到 `vv-runtime` 族 | 族内条目数 ≤ maxEntries(4)；本用例写入的 6 条中至少 2 条被逐出（无过期插件则全留→红）；逐出非全清（族内仍有条目） | expiration 配额（maxEntries）+ 共用族挤占 |
| SWR-CLEAN-01 | 假静态服务器 + 产物内 REV 全量替换（部署换版模拟） | 预热旧 REV 的 `vv-grammars-*` 与 `vv-worker-wasm-*` 缓存 → 改写 REV 并 reload → 等新 REV 缓存出现、旧 REV 的 grammars 缓存被清理 | **旧 REV 的 `vv-worker-wasm-*` 缓存被清理**（产品侧已修：删除正则补族）；当前 REV 的同族缓存须保留（不过度清理）；控制组：旧 REV 的 `vv-grammars-*` 确实被清理（证清理动作执行过） | **已修**（`vite.config.ts:148` 删除正则补 `vv-worker-wasm`，与 `:130` current 清单对齐） |
| SWR-CLEAN-02 | `apps/web/build/vv-sw-cleanup.js` 存在 | 解析产物的 current 清单与删除过滤正则 | **正向**：current 清单里的每个缓存名都被删除正则覆盖（漏族 → 旧 REV 缓存永久残留）——产品侧已修（漏 `vv-worker-wasm` 已补） | **已修**（同上，产物层正向不变量转为回归护栏） |
| SWR-CLEAN-03 | 同上；`apps/web/build/sw.js` 存在 | 解析产物路由表的每条 cacheName，与 current 清单双向比对 | **反向**：每条运行时路由的 cacheName 都在 current 清单里（新增族忘进清单 → 静默泄漏）；清单亦无多余条目 | 同上（产物层反向不变量） |

### 2.1 skipIf 策略

- **SWR-ROUTE-05/06 是本 spec 仅有的真网依赖用例**：跨域 CDN 请求经 SW 的 fetch 事件发起，
  不进页面网络栈，`page.route` 拦不到。可达性探针与断言**同口径（页面 fetch，受 CORS 约束）**——
  CDN 撤掉 ACAO 或不可达时页面 fetch 失败/非 200 → `test.skip`，不把「CORS 缺失」误判成产品缺陷。
  （`page.request` 探针不受 CORS 约束，与页面 fetch 不同口径，本 spec 不用。）
  离线环境的等价覆盖由 SWR-TABLE-01（产物层路由归属）承担。
- 其余场景全部离线稳定：探针 URL 由本域自建服务器合成应答，不依赖外网与真实资产内容。

### 2.2 恒真性自查（每条断言对应的「产品改动会打红」）

| 断言 | 什么产品改动会让它变红 |
| --- | --- |
| SWR-ROUTE-01 族归属 + 二次不回源 + 断网可取回 | 删/改 worker-wasm 路由或族名；把该路由改成 NetworkFirst（回源计数增、断网取不回）；族名写错 |
| SWR-ROUTE-02 族归属 | 删同源预留槽路由；该路由被前面的规则截胡；族名写错 |
| SWR-ROUTE-03 404 不入缓存 | `cacheableResponse` 放宽到含 404（探测面在 SWR-TABLE-01 的 statuses 断言 + 本条的运行期入缓存判据） |
| SWR-ROUTE-04 URL→族映射 | 任一既有路由删除/改族/被前序规则截胡；svgbob 路由族改名 |
| SWR-ROUTE-05 opaque 不入缓存 + foreign 族归属 | `statuses` 放宽到含 0（opaque 被缓存）；foreign 规则被通配规则吞掉；族名写错 |
| SWR-ROUTE-06 cdn-engines 族归属 | 两条 jsdelivr 规则顺序对调（foreign 被吞）；族名写错 |
| SWR-ROUTE-07 未知资产 404 不入缓存 | 服务端 fallback 收窄回退（非导航请求重新拿到 200 index.html——则 fetch 得 200，第一条断言红）；`cacheableResponse` 放宽到含 404（则 404 入缓存，零持有者断言红） |
| SWR-TABLE-01 族归属/handler/method/statuses/过期配额 | 任一 urlPattern 改动；handler 由 CacheFirst 改为其它策略；method 改为 POST；statuses 放宽到 [0,200] 或 [200,404]；删 ExpirationPlugin 或去掉 purgeOnQuotaError；两条 vv-runtime 路由族分裂 |
| SWR-TABLE-02 base 接线 | importScripts 路径与 scope 脱钩（base 接错 → 清理脚本 404）；SW 注册 URL 改为不带 base 的绝对路径；注册 scope 与 manifest scope 不一致 |
| SWR-MIRROR-01 条数 + 字面匹配 + 族归属 | env 为空时仍生成镜像路由（条数多一条）；env 非空时不生成镜像路由（条数少一条）；镜像路由 base 未转义（`re.test(mutated)` 转真）；镜像路由归错族；jsdelivr 规则族归属错位 |
| SWR-EXP-01 配额与逐出 | 删 ExpirationPlugin / maxEntries 放宽 → 族内条数超配额；逐出逻辑改为清空族 → 本用例写入条目全灭 |
| SWR-CLEAN-01/02/03 清理不变量 | 删除正则漏族（正向红）；新增族忘进 current 清单（反向红）；current 清单含多余条目（反向红）；当前 REV 缓存被误删（护栏红） |

### 2.3 与既有锚的边界（复核要求写清）

| 既有锚 | 拥有的断言面 | 本域的增量面 |
| --- | --- | --- |
| `t-pwa.spec.ts:736-881`（BUG-60「已修复」锚） | 「改写 sw.js + vv-sw-cleanup.js 的 REV → reload → 旧 REV 的 grammars/runtime/queries 缓存被 activate 清理」**三族**的换版清理机制与断言写法 | 仅 **新增族 vv-worker-wasm** 的同机制表现（残余 A7 增量）；控制组压到最小一条（仅证「清理动作确实执行过」） |
| `t-pwa.spec.ts:263`（PWA-03）、`fix-pwa.spec.ts:107`（BUG-06） | 「打开语言文件后某族缓存被创建」的存在性判据 | **URL → 缓存族的唯一归属映射**（每个 URL 恰好被一个族持有、且是该族）；含既有锚零覆盖的 svgbob 族 |
| `apps/web/scripts/check-pwa-build.mjs:67-77` | 构建期「cacheName 族存在」 | 产物层**按 workbox 匹配语义解析首个命中路由**的运行语义面（含 method/statuses/过期配额/共用族一致性） |
| `apps/web/src/lib/foreignAssets.test.ts:126-139` | vite.config 源码**文本序**（foreign 规则先于 jsdelivr 通配） | 产物层**解析序**（产物里两条规则的先后 + 族归属），非源码文本比对 |
| `apps/web/src/lib/foreignAssets.test.ts`（A8 源码锚） | env → base 解析链的源码级断言 | SW 产物侧：env 推导的镜像路由条数/前缀/族归属 |

**装置自建的理由**（与 `docs/e2e/README.md` §3.2 第 1 条「公共装置复用既有 helper」的边界说明）：
本域需要的装置是「伺服 `apps/web/build` **构建产物** + 对指定路径给精确 200/404 合成应答 +
在产物内改写 BUILD_REVISION」。既有 `apps/web/e2e/serverHarness.ts` 是 **m5/m6 的 Rust 进程
harness**（cargo build + spawn vviewer 二进制 + `/api/health` 轮询），它伺服的是**文件服务根目录**
而非构建产物目录，且其未知路径走 `server/src/lib.rs` `serve_index` 的 SPA fallback（SWR-DEF-01
收窄后 fetch 形态恒 404，无法对指定路径给精确 200 合成应答），不满足本域的合成探针需求；
本域 e2e 铁律亦要求装置自建在本文件内（避免域间文件冲突），故不复用。§2.1 的 `page.route`
拦截面与本域无关（SW 缓存面一律走 caches API）。

## 3. 验收行为

### 3.1 关联缺陷的验收行为（SWR-CLEAN-01/02 已修转绿；SWR-ROUTE-07 见 §3.2 亦已修转绿）

**缺陷（缓存卫生不变量在 A7 上失效）**：`genSwCleanup`（`vite.config.ts:123-169`）在构建期生成
`static/vv-sw-cleanup.js`，其中：

- `current` 清单（:125-133）列出 7 个当前 REV 的缓存名，**含 `vv-worker-wasm-${BUILD_REVISION}`**（:130）；
- activate 的删除过滤（:148）用正则 `/^(vv-grammars|vv-runtime|vv-queries|vv-diagram-svgbob|vv-cdn-engines|vv-foreign-assets)-/`
  圈定「可删除的族」，**漏掉 `vv-worker-wasm`**。

后果：部署换版后，旧 REV 的 `vv-worker-wasm-*` 缓存既不被任何路由命中（cacheName 拼了新 REV），
也不在删除正则的删除范围内 → 永久残留，随部署次数线性累积（BUG-60 在 grammars/runtime/queries
三族上修掉的问题，在残余 A7 新增族上复发）。

**修复后应有行为**（回归验收判据）：

1. 旧 REV 的 `vv-worker-wasm-*` 缓存在换版后被 activate 清理（SWR-CLEAN-01）；
2. 当前 REV 的 `vv-worker-wasm-*` 缓存**不得**被误删（SWR-CLEAN-01 护栏项）；
3. `current` 清单与删除过滤正则**同族对齐**（SWR-CLEAN-02 正向不变量）；
4. 反向不变量：每条运行时路由的 cacheName 都在 `current` 清单里、清单无多余条目
   （SWR-CLEAN-03）——防「新增族忘进清单」这一同族漏配的另一半形态；
5. 回归不破坏：既有六族的清理行为不变（SWR-CLEAN-01 控制组：`vv-grammars-*` 旧 REV 仍被清理）；
   既有族的路由归属不变（SWR-ROUTE-04）。

> 修复面提示（不在本域实施）：删除正则补 `vv-worker-wasm` 即可（:148）；产品侧修复后本域两条
> fixme 锚转正式断言即转绿。`check-pwa-build.mjs` 可另加「current 清单 ⊆ 删除正则覆盖」
> 构建期门禁。

### 3.2 缺陷 SWR-DEF-01（已修）：SPA fallback 的 200 HTML 曾被收进 foreign 资产缓存

**缺陷态**（实测口径，见 §4.3 的装置说明）：真实后端 `server/src/lib.rs` 的 SPA fallback
曾对未知且非 `.scm`/`.wasm` 的路径返回 **200 + index.html**（`text/html`）。foreign 资产的真实形态
是 `.js`（`/file-viewer-assets/vendor/docx/docx.js`），前缀未部署时即命中该分支。该 200 HTML 被
`/file-viewer-assets/` 路由的 CacheFirst + `cacheableResponse{statuses:[200]}`（:777-784）收进
`vv-foreign-assets` 缓存并长期复用——与 `vite.config.ts:776` 的注释承诺（「404/SPA fallback
应答不入缓存」）相悖（实测只对 404 成立）。

**修复锚**：`server/src/lib.rs` `serve_index` 加 Accept 导航判定——fallback 只对导航请求
（Accept 含 `text/html`，大小写不敏感）回 index.html，其余（fetch/XHR 的 `*/*`、资源加载、
缺 Accept 头）一律 404。浏览器导航 Accept 恒含 text/html 不受影响；脚本/wasm/fetch 形态
拿到 404，`cacheableResponse` 只收 200 自然拒收，污染面归零。SW 层无法按 content-type
过滤（generateSW 不支持自定义 cacheWillUpdate plugin），故治理面在服务端。

**双端锚**：服务端契约由 cargo 集成锚 `server/tests/health.rs`
`spa_fallback_gated_on_navigation_accept` 守住（fetch 形态 404 / 缺头 404 / 未知 .js 404 /
导航形态 200 / `.scm`/`.wasm` 特判维持 404）；e2e 侧 SWR-ROUTE-07 已随修复转正式断言
（断言面改为修复后契约：未知资产 fetch 得 404、零 `vv-foreign-assets` 缓存条目），
转正后实跑待 CI/实机复核（§4.3）。

### 3.3 回归护栏（现状正确行为的保护）

- SWR-ROUTE-04：grammars / runtime / queries / svgbob 四族的「URL → 族」映射不变。
- SWR-TABLE-01：全部运行时路由的 handler 仍为 `CacheFirst`、method 仍为 `GET`、`statuses` 仍恰为
  `[200]`、均配 `maxEntries` + `purgeOnQuotaError`；两条 vv-runtime 路由仍共用同一 cacheName 与配额。
- SWR-TABLE-02：SW 注册与清理脚本的 base 接线仍与 manifest scope 一致。
- SWR-MIRROR-01 默认态：env 为空时跨域路由仍只有 jsdelivr 两族。

## 4. 环境与数据

### 4.1 装置（全部在本 spec 内自建）

| 装置 | 规格 | 用于场景 |
| --- | --- | --- |
| 假静态服务器 | `node:http`，`listen(0)` 取临时端口（不与 playwright webServer 的 4173 冲突）；伺服 `apps/web/build` 产物 + 合成探针（含修复后服务端契约的 404 形态）；每路径命中计数；可把 `sw.js`/`vv-sw-cleanup.js` 内的 BUILD_REVISION 全量替换（部署换版模拟） | 全部运行时场景 |
| 合成探针（同源，200） | `/grammars/swr-probe.wasm`、`/queries/swr-probe/highlight.scm`、`/_app/immutable/assets/svgbob_wasm_bg.swrprobe.wasm`、`/_app/immutable/workers/assets/swr-probe.wasm`、`/file-viewer-assets/swr-probe.wasm`（均为最小 wasm 头 8 字节 / 文本） | SWR-ROUTE-01~04 / SWR-CLEAN-01 |
| 合成探针（同源，404） | `/file-viewer-assets/swr-missing.wasm`；`/file-viewer-assets/swr-spa.js`（模拟**修复后**服务端契约：非导航 fetch 的未知资产路径 404——server/src/lib.rs `serve_index` Accept 收窄） | SWR-ROUTE-03 / SWR-ROUTE-07 |
| vv-runtime 族探针 | `/y1..y3/libarchive/libarchive.wasm`（走 libarchive 路由）、`/z1..z3/tree-sitter.wasm`（走 tree-sitter 路由）——两条**不同路由**写入同一族，用于验证共用配额互相挤占 | SWR-EXP-01 |
| 产物层解析器 | 解析 `build/sw.js` 的 `registerRoute` 调用表（含 `CacheableResponsePlugin.statuses`、`ExpirationPlugin.maxEntries/purgeOnQuotaError` 与 method 参数；压缩产物的命名空间字母随打包变化，按 `new <ns>.<Ctor>(` 形态匹配不写死字母）；按 workbox `RegExpRoute` 语义解析首个命中路由（正则对完整 URL 匹配；跨域且 match.index≠0 不接管）；另解析 `importScripts` 路径与客户端产物的 SW 注册 URL/scope | SWR-TABLE-01~02 / SWR-MIRROR-01 / SWR-CLEAN-02~03 |

### 4.2 数据与环境依赖

- **构建产物依赖**：`apps/web/build/` 必须存在且为当次构建（CI 在 e2e 前跑
  `pnpm --filter web build`，`.github/workflows/ci.yml:163`）。产物陈旧时
  SWR-TABLE-01/02、SWR-MIRROR-01、SWR-CLEAN-02/03 会因产物与源码不同步而红——先重跑 build。
- **网络依赖**：仅 SWR-ROUTE-05/06 需要真网 jsdelivr（不可达即 skip，见 §2.1）。
- **SW 默认开启**：本域不设 `serviceWorkers: 'block'`（阻断 SW 会使运行时缓存路由整体失效，
  与本域被测对象相悖）；跨域请求不可用 `page.route` 计数，故 SW 缓存断言一律走
  `caches` API（`page.evaluate` 内 `caches.keys()` / `caches.open().match()`）。
- **断言对象**：`vv-*` 运行时缓存族（`workbox-precache-*` 为 precache 族，单独口径，不混入）。
- **族内基线非零**：`vv-runtime` 族在应用启动即被预热 `/tree-sitter.wasm`
  （`apps/web/src/lib/highlightClient.ts:297`），故 SWR-EXP-01 的断言不假设族初始为空。

### 4.3 实测记录（2026-11-08，chromium + mobile 两 project）

本域 spec 自带静态伺服面（随机端口），不依赖 playwright webServer 的 4173，可独立运行：

| 场景 | 实测 | 说明 |
| --- | --- | --- |
| SWR-ROUTE-01~06、SWR-TABLE-01~02、SWR-MIRROR-01、SWR-EXP-01、SWR-CLEAN-03 | **passed**（11 条，两 project 各一遍） | SWR-ROUTE-05/06 在有外网时走真网断言（jsdelivr 直链），无外网时按 §2.1 skip |
| SWR-ROUTE-07 | **已转正式断言**（服务端 fallback 收窄后伺服面改为修复后契约：swr-spa.js → 404）。缺陷态实测（2026-11-08，以普通 test 跑旧 200-HTML 伺服面）确实为红：收到 `vv-foreign-assets-0.1.0-hsw4k` 持有者——证明锚非恒真；修复后契约形态的实跑待 CI/实机复核 | 缺陷锚历史证据保留；断言面已改为修复后契约（404 透传 + 零缓存条目，§3.2） |
| SWR-CLEAN-01、SWR-CLEAN-02 | **已转正式断言（产品侧已修）**：修复前以普通 test 执行时确实为红（SWR-CLEAN-01 收到 `vv-worker-wasm-0.1.0-hsw4k` 残留、SWR-CLEAN-02 报 `清理正则未覆盖的 current 缓存族：vv-worker-wasm-0.1.0-hsw4k`）——变异核验与修复后复跑证明二者非恒真 | 删除正则补族后转绿（§3.1） |

### 4.4 已知状态与未覆盖项

- **SWR-CLEAN-01/02 已修**（真实产品缺陷已定位并修复，见 §3.1）：`genSwCleanup` 的 activate
  删除正则补入 `vv-worker-wasm` 族（`apps/web/vite.config.ts:148`），与 `current` 清单
  （`:125-133`）逐族对齐；两条锚已由 `test.fixme` 转正式断言（断言原文未弱化）。
- **SWR-ROUTE-07 已转正式断言**（SWR-DEF-01 已修，修复锚见 §3.2）：断言面为修复后契约
  （未知资产 fetch 得 404、零 `vv-foreign-assets` 缓存条目）；服务端契约另有 cargo 集成锚
  （`server/tests/health.rs` `spa_fallback_gated_on_navigation_accept`）双端把守；
  本机未复跑 playwright，转正后实跑待 CI/实机复核。
- **SWR-CLEAN-03 当前绿**（反向不变量成立）：产物路由的每条 cacheName 都在 current 清单内、
  清单无多余条目。该条为常规断言——它守住「新增族忘进 current 清单」这另一半同族漏配形态，
  使 SWR-CLEAN-02 的正向红锚有对应的绿侧对照。
- **残余 A8 的 env 非空态需双态构建**：SWR-MIRROR-01 的期望条数由产物注入的 env 值推导
  （空⇒2 条、非空 http(s)⇒3 条），两种构建形态下都是可执行断言；但 **CI 当前只构建默认形态
  （env 空）**，非空形态的镜像路由（条数/前缀/族归属）需 `VV_FOREIGN_ASSETS=https://<mirror>/`
  的双态构建才能实跑——残余 A7/A8 的 CI 双态构建尚未建立（构建期定型约束，
  `vite.config.ts:37-64`）。该缺口在本域不可自解（需改 CI 与构建流程），故按「默认态已覆盖、
  非空态待双态构建」记录。
- **跨域路由的运行期覆盖依赖外网**：SWR-ROUTE-05/06 在离线 CI 上 skip，离线等价面由
  SWR-TABLE-01（产物层路由归属 + statuses + 过期配额）承担。
