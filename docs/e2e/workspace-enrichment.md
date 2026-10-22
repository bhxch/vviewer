# workspace 富化：多根语义、恢复链与搜索引擎宣告 — e2e 场景（第二轮富化）

> 来源：2026-10-13 补充轮之后的第二轮域富化（WSX 前缀，编号接续既有 WS-01~07 / MRF-01~08 锚点、互不重叠）。本域把四份设计文档的承诺面里**尚无 e2e 锚**的部分补齐：
>
> - `docs/superpowers/specs/2026-10-11-workspace-tabs-design.md` §2.1/§2.3/§5——`/api/search` 的 root 限定/跨根语义（SRV-MULTIROOT 只锚了缺省跨根一面）、`/api/compute/*` 携 root（MRF 只锚 file/tree 双端点）、管理面板与切换器的边界操作（WS-01 只锚新建/重命名/删除活动组的 happy-path）；
> - `docs/superpowers/specs/2026-10-11-search-grep-fallback-design.md`——health `searchEngine` 宣告与 rg 缺失→grep 回退全链（既有 CMP-09 的「无 rg 501」锚先于该设计，其拓扑恰好 rg+grep 双缺；**rg 缺失但 grep 在**的回退正例零锚）；
> - `docs/superpowers/specs/2026-10-11-watch-log-flood-design.md`（BUG-68）——SSE 帧层面的风暴防护承诺（watch.rs 500ms debounce 聚合、逐根聚合发帧）无 e2e；既有 t-srv BUG-68 锚只覆盖「越界 symlink 不降级」一面；
> - 上轮盘点缺口 c/d（`docs/e2e/multiroot-file-channel.md` 头注）：多根 remote 源（storeId 带 `:r1` 段，非 basePath）的**刷新恢复链**（WS-05 只锚 basePath 源、WS-06 只锚根 0 源的 pinned）、RemoteSourceModal 的**断线/越界/token 错误语义**（MRF-07 只走通创建 happy-path）。
>
> 服务器事实（源码核实 + 实跑校准，2026-10-14）：`server/src/routes/search.rs:221-244`（多根 root 缺省+path → 400 `path requires an explicit root`；`root=Some(i)` → guard 清洗/canonicalize/越界 403，帧无 root 字段；root 越界的**可达**文案是 guard::resolve_at 前置拒绝的 `root index out of range: N`——search.rs:293-299 的 parser_roots 越界分支为防御式兜底，正常请求在目录解析阶段已被拒）；`server/src/compute/highlight.rs:95,449`（HighlightRequest.root 仅 path 模式，`resolve_at` 越界 400 同 guard 文案）；`server/src/routes/search.rs:123-133`（resolve_engine：rg 覆盖 → PATH rg → grep 覆盖 → PATH grep → 双缺 501）；`server/src/watch.rs:96,581-582`（DEBOUNCE_WINDOW 500ms 固定窗口聚合并入同一条 changed，逐根发帧）。

## 1. 目的与来源

四条线：

- **多根 search/compute 通道语义（server 套件，release 二进制真实引擎）**：`POST /api/search` 指定 `root` 限定单根（帧形状退化为单根形态）vs 缺省跨根（帧带 `root`）的对比、多根歧义/越界 4xx 矩阵、单根历史形状回归护栏；`POST /api/compute/highlight` 的 `root` 在 path 模式按根解析（越界 400、缺省不串根）而 text 模式不涉 root。
- **搜索引擎宣告与回退链（server 套件）**：health `searchEngine` 按探测链如实宣告；rg 缺失（PATH 注入）→ grep 回退 200 NDJSON（col 恒 1）；rg+grep 双缺 → 501 + 字段整体省略；前端连接时缓存（sessionStorage `vv:search-engine`）→ 搜索面板引擎徽标（grep 带「降级引擎」tooltip）、双缺时徽标缺失。
- **多根 remote 源恢复链与错误语义（default 套件，假双根服务器）**：根 1 整根源（storeId `remote:<hash>:r1`）刷新×2 回环恢复（快照 storeLabel 原值 + rootIndex 透传，`/api/file` 恒带 `root=1`）；面板「＋ 添加来源 → 后端路径…」把根 1 源并入既有组形成双根双源并存 + 根 1 目录 tab pinned（M-5）跨根恢复；RemoteSourceModal 断线（网络层）/tree 越界 400（服务端层）/token 会话轮换 401 三种错误面的文案、重试通道与切根自愈。
- **切换器/管理面板边界与快照保序（default 套件）**：删最后一组的新默认兜底、重命名重名允许（id 为身份不合并）与空名忽略、三组切换后刷新的组序保序 + 活动组还原 + 组内 tab 归属还原。

既有锚点（不重复布点）：WS-01~07（`t-workspace.spec.ts`：新建/重命名/删除活动组、多源徽标、面板、remote/localfiles 恢复、basePath 源回环、根 0 pinned、单文件源）、MRF-01~08（`b-multiroot-file.spec.ts`：file/tree 的 root 路由与越界、symlink 403、root×Range、单根兼容、root1 来源 UI 全链 happy-path、watch 帧按根过滤 UI）、SRV-MULTIROOT（`t-srv.spec.ts:609`：health roots、tree?root、search 缺省跨根帧、SSE root 帧）、DEG-07/08（SSE changed 增量重渲染）、TA-06（组内语义）、CMP-09（无 rg 实例 501 + 前端降级——拓扑上 rg+grep 双缺）。

## 2. 场景清单

公共环境分两套：

- **server 套件**（`apps/web/playwright.server.config.ts`：release 二进制 :4174 同源伺服，chromium 单 project，workers 1）。API 级场景直接 node fetch；UI 级场景（WSX-03/04 徽标）在 :4174 页面经连接表单跨源连辅助实例（辅助实例带 `--cors-origin http://127.0.0.1:4174`，精确回显）。spec 内 `beforeAll` 另起四个辅助实例（重试安全复用，`ensureServe` 同 b-compute 先例）：**:4396** 双根（互不相交 mkdtemp，MRF 同款约束）；**:4397** 单根 + `PATH=<仅含 grep 符号链接的临时目录>`（rg 缺失注入）；**:4398** 单根 + `PATH=<空临时目录>`（双缺注入）；**:4399** 双根 + `--compute`。
- **default 套件**（`apps/web/playwright.config.ts`：vite preview :4173，chromium + mobile 375×667 双 project）。spec 内 node:http 假双根 vviewer 服务器（t-workspace startFakeServer 扩展：health 宣告 roots/rootPaths、tree/file 携 `root` 参数路由、可配置 token 门与运行期轮换、SSE 持挂；全响应带 ACAO:*）。树行点击经 `openDrawerIfNarrow` 适配窄视口；切换器断言经下拉活动行（≤600px 触发钮恒显「工作区 ▾」）。

| 编号 | 前置条件 | 步骤 | 期望 | 关联缺陷 |
| --- | --- | --- | --- | --- |
| WSX-01 | :4396 双根实例（root0/`wsx-r0.txt`、root1/`wsx-r1.txt` 同 pattern 各 1 命中 + root1/`sub/needle-deep.txt`）；health 先探 `searchEngine` | ① `POST /api/search {pattern}` 缺省；② 同 pattern `root:1`；③ `root:1, path:'sub'`；④ `root:0` | ① 200 且命中帧恰含两根各一文件、每帧带 `root` 字段（值域 {0,1}）、路径相对各自根；② 200 且帧集合恰为 {`wsx-r1.txt`}、**帧无 `root` 字段**（限定单根 = 单根形状，search.rs:289-291）；③ 命中 `sub/needle-deep.txt`（path 相对所选根）；④ 恰为 {`wsx-r0.txt`} 无 `root` 字段；rg 引擎下 col 精确（grep 引擎 col=1 跳过精确断言） | BUG-107 |
| WSX-02 | 同 WSX-01 实例；主实例 :4174（单根） | ① `{pattern, path:'wsx-r0.txt'}`（多根无 root）；② `{pattern, root:2}`；③ `{pattern, root:1, path:'../outside'}`；④ `{pattern, root:1, path:'no-such-dir'}`；⑤ `{pattern:''}`；⑥ :4174 `{pattern:'greet', path:'hello.js'}`；⑦ 护栏 `root:1` 正常 | ① 400 `path requires an explicit root`（多根歧义防护）；② 400 `root index out of range: 2`（guard::resolve_at 前置拒绝的可达文案，guard.rs:38-40；search.rs:293-299 的 parser_roots 越界分支为防御式兜底不可达）；③ 400 `path must not contain '..'`（清洗层先于越界校验）；④ 404 `path not found`；⑤ 400 `pattern must not be empty`；⑥ 200 命中全部落在 `hello.js`（greet 两处）且**无 root 字段**（单根历史语义：path 合法、多根 400 不外溢单根）；⑦ 200（防护不误伤合法索引） | BUG-107 |
| WSX-03 | :4397 实例（PATH 仅含 grep 符号链接 → probe(rg) 失败、probe(grep) 命中）；页面 :4174 | API：① health；② `POST /api/search`。UI：③ 连接表单连 :4397；④ 读 sessionStorage `vv:search-engine`；⑤ Ctrl+Shift+F 看徽标与 tooltip；⑥ 搜索并读结果与降级提示 | ① `searchEngine === 'grep'`；② 200 NDJSON：命中帧 `col===1`（grep 无列号）、`file`/`line`/`text` 正确、终帧 `{done:true}`；③ 连接成功树可见；④ 值为 `'grep'`；⑤ 徽标「服务端搜索：grep」且 title 含「降级引擎」（无列定位/顺序不保证/ERE 方言）；⑥ 结果可用（行可见、状态含「个命中」）且**无**「已改用浏览器内搜索」提示（服务端引擎真实执行） | 搜索回退设计 A 项（BUG-10/11 邻接面） |
| WSX-04 | :4398 实例（PATH 空目录 → rg/grep 双缺）；主实例 :4174 | ① health(:4398)；② `POST /api/search`；③ 对照 health(:4174)；④ UI：连接 :4398 → 读 sessionStorage → Ctrl+Shift+F 看徽标 | ① 响应体**无 `searchEngine` 键**（双缺整体省略，health.rs:105-110 语义）；② 501 且错误体含 `neither ripgrep (rg) nor grep found on server`；③ :4174 `searchEngine === 'rg'`（主路径宣告）；④ `vv:search-engine` 为 null（saveSearchEngine 对未知值清缓存）且面板无「服务端搜索：」徽标 | 搜索回退设计 §2.1④ |
| WSX-05 | :4399 双根 + `--compute` 实例；root0/`wsx-hl-r0.js` 1 行、root1/`wsx-hl-r1.js` 3 行 | ① `{path:'wsx-hl-r1.js', lang:'javascript', root:1}`；② 同 ① 缺省 root；③ `{path:'wsx-hl-r0.js', lang:'javascript', root:0}`；④ ① 加 `range:{startLine:2,lineCount:1}`；⑤ `{path:'wsx-hl-r0.js', root:9}`；⑥ `{text:'const z = 1;', lang:'javascript', root:9}` | ① 200 `{intervals≥1, captures≥1, baseLine:0}`；② 404 `path not found`（缺省 = 0 号根，不串根解析——highlight.rs:449 `req.root.unwrap_or(0)`）；③ 200；④ 200 且 `baseLine===2`（root1 文件 3 行才可能有第 2 行；若误读 root0 的 1 行文件必 400 startLine beyond EOF——root 路由的锐证）；⑤ 400 `root index out of range: 9`（guard 文案形态）；⑥ 200（text 模式不涉 root——root 越界不波及） | BUG-107（compute 通道扩展面） |
| WSX-06 | :4396 双根实例；SSE 建连（ticket → events） | ① 订阅 `/api/events`；② 向 root1 **单次同步循环连写 24 个文件**（一个 500ms debounce 窗口内）；③ 收集 3s 内全部 changed 帧 | 全部 changed 帧 `root===1` 且 paths 均为 burst 文件名（无 root0 帧与跨根混入）；帧数 **< 24**（watch.rs:96 500ms debounce 聚合——帧风暴防护承诺，连续写入并入同一条 changed）；帧数 ≥ 1 且 24 个路径的并集完整覆盖（聚合不丢事件）；至少一帧含 ≥2 条路径（聚合确证发生） | BUG-68 承诺面（watch-log-flood 设计 §3 刷屏抑制的 SSE 层） |
| WSX-07 | default 套件；假双根服务器（rootPaths=['/wsx-fake-root-0','/wsx-fake-root-1']；root0 有 `decoy-r0.txt`、root1 有 `hello-r1.txt`）；`/api/file` 请求记录器 | ① 连接（根 0 源入默认组）；② 新建工作区 → 后端路径浏览 → 根选择按钮×2 → 选根 1 → 整根作来源 → 创建并激活；③ 树中打开 `hello-r1.txt`；④ 快照落盘后 `reload()` ×2 | ② 根选择两按钮文案 = rootPaths、根 1 浏览只见 `hello-r1.txt` 不见 `decoy-r0.txt`、目录 tab 与树源标签含「根1」；③ 内容渲染且 `hello-r1.txt` 的全部 `/api/file` 请求带 `root=1`（`remote.ts:181-183` rootIndex 透传）、零 `decoy-r0.txt` 请求；④ 两次刷新均：组结构恢复（活动组=新建组）、`:r1` storeId 回环重建来源（树源标签「根1」在）、文件 tab 内容恢复非占位、请求仍恒带 `root=1`、无错误卡片 | 上轮 MRF 缺口 c；BUG-08（恢复通道） |
| WSX-08 | 同 WSX-07 假服务器；默认组已连根 0 源 | ① Alt+W 面板 → 默认组「＋ 添加来源」→「后端路径…」→ 选根 1 → 整根作来源（入既有组）；② 树中打开 `hello-r1.txt`；③ 右键根 1 目录 tab → 固定（host 根 0 tab 不固定）；④ 快照落盘后 `reload()` | ① 同组双源并存：目录 tab×2（host 与「host · 根1/」）、树源标签×2、tab 来源徽标×2（多源才显示）；② 内容渲染、请求带 `root=1`；③ 根 1 tab `data-pinned="true"`、host tab 无 pinned；④ 恢复后：双目录 tab 齐全、根 1 tab `data-pinned="true"`（M-5 pinned 跨根读回——WS-06 只锚根 0）、host tab 未 pinned、树两源分组、文件 tab 内容恢复、请求恒 `root=1` | 上轮 MRF 缺口 c（pinned 跨根面）；BUG-08 |
| WSX-09 | default 套件；假服务器 A（单根）与 B（health 宣告双根但 `tree?root=1` 恒 400 `root index out of range: 1`，模拟服务端状态漂移） | A（断线）：① 连接 A 成功；② 关停 A；③ 新建工作区 → 后端路径…；B（越界 400）：④ 连接 B → 后端路径… → 选根 1；⑤ 点「重试」；⑥ 点「← 重选根」选根 0 | ③ `.vv-remotesrc-error`（role=alert）含「无法连接 …：网络错误或地址不可达」+「重试」按钮在（init 网络层错误面，RemoteSourceModal.svelte:76-79）；④ 错误含「服务器请求失败: HTTP 400: root index out of range: 1」（错误体 detail 透传）；⑤ 重试后错误持续（服务端仍坏，不崩溃不假成功）；⑥ 切根后条目正常列出、错误清除（切根自愈通道） | 上轮 MRF 缺口 d（断线/越界错误语义） |
| WSX-10 | default 套件；假服务器 C（tree/ticket 需 Bearer，token 运行期可轮换） | ① 以 `wsx-tok-1` 连接（访问令牌表单）→ 树可见；② 服务端 token 轮换为 `wsx-tok-2`；③ 新建工作区 → 后端路径…（health 免鉴权过 → 单根直进浏览） | ③ `.vv-remotesrc-error` 含「服务器请求失败: HTTP 401: invalid token」（状态码 + 服务端错误体 detail 透传，RemoteSourceModal.svelte:133-141）；「重试」在且重试后仍 401（凭据失效持续性）；Esc 退出后应用不受伤（TopBar 可见）——token 错误卡片语义不阻断会话 | 上轮 MRF 缺口 d（token 错误语义） |
| WSX-11 | default 套件；纯前端（drop 注入单文件 tab） | ① drop `wsx-a.txt` 入默认组 → 删除最后一组「默认」（confirm 接受）；② 新建「组乙」+ drop `wsx-b.txt` → 切回默认 + drop `wsx-a2.txt`；③ 重命名默认 → 「组乙」（与既有组重名）；④ 切到另一「组乙」行；⑤ 对活动组重命名为空串并确认 | ① 新「默认」重建为唯一活动组（至少一个不变式，`workspaceStore.remove` 删最后一个分支）且 TabBar 清空（连带关 tab）；③ 切换器出现两行「组乙」（重名允许、id 为身份）、活动组 tab（`wsx-a2.txt`）仍在（改名不并组）；④ 切到的行 TabBar 为 `wsx-b.txt`（重名行身份独立、tab 各归各组）；⑤ 表单关闭、名称保持「组乙」不变（TopBar commitRename 空名忽略） | WS/TA 邻接边界（WS-01 只锚删除活动组与合法重命名） |
| WSX-12 | default 套件；纯前端；三组各 drop 一枚文件 tab（默认/`wsx-d0`、甲组/`wsx-d1`、乙组/`wsx-d2`）；切换顺序 甲→默认→乙（活动=乙组） | ① 直读 IndexedDB `workspaces` 快照（组序/活动 id/tabs 归属）；② `reload()`；③ 读恢复后切换器组序与活动组；④ 逐组切换读组内活动 tab | ① 快照组序 = 登记序 [默认, 甲组, 乙组]、activeId=乙组、三枚 tab 各归各组（多组切换后快照保序——replaceAll 按 `list` 序写、activeId 独立）；③ 恢复后活动组=乙组（快照 activeId 还原）、下拉组序与快照一致（插入序不因切换重排）；④ 乙组活动 tab=`wsx-d2`（占位错误卡「需要重新打开」——single 源不跨刷新）、切甲组=`wsx-d1`、切默认=`wsx-d0`（tab→组归属逐组还原） | WS-04 扩展面（三组 + 保序 + 逐组归属） |
| WSX-13 | default 套件；假单根服务器（rootPaths=`['/r0']`、`hello.txt`）；快照注入缺陷形态（IndexedDB 直写：文件 tab storeId 加 `placeholder:` 前缀 + 占位目录条目 `path===''`/前缀 storeId——`snapshot()` 无过滤的真实产物） | ① 连接 → 树中打开 `hello.txt` → 快照落盘；② 注入前缀化 storeId 与占位目录条目；③ `reload()`（服务器存活） | ③ 文件 tab 复活：内容渲染、`.vv-error-card` 恒 0；目录条目复活：快照 `path===''` 条目 storeId 无前缀（恰一条 `^remote:`——dirSnap/查表剥前缀命中，真实目录 tab 重建） | 终审新增候选 C1（restore 查表剥占位前缀） |
| WSX-14 | 同 WSX-13 前置；`page.route('**/api/health*')` 掐断 health（来源不可达，BUG-08 通道） | ① 同 WSX-13 注入前缀化 storeId（不注入目录条目）；② `reload()` | ② 落占位（`.vv-error-card` 在场）且快照 storeId 保持单层前缀（`^placeholder:(?!placeholder:)`——addPlaceholderTab 剥前缀防线，不叠双前缀的幂等锚） | 同 C1（幂等护栏面） |

## 3. 关联缺陷的验收行为

### BUG-107 多根通道 root 语义（search/compute 通道扩展——本域视角）

**缺陷现状**：MRF 域已收口 file/tree 通道（见 `docs/e2e/multiroot-file-channel.md` §3）。本域补同族两通道的 e2e 空白：`/api/search` 的「指定 root 限定单根」（帧退化为无 `root` 字段的单根形状）与多根歧义防护（root 缺省 + path → 400）、`/api/compute/highlight` 的 path 模式按根解析（缺省不串根、越界 400、range 与 root 共存可作路由锐证）此前均无锚；回归形态为「限定单根仍带 root 字段」「多根 path 缺省 root 不 400」「compute 高亮 root1 文件回落 0 号根 404」「text 模式误受 root 越界影响」。

**修复后应有行为（回归验收）**：
1. `root=Some(i)` 限定单根：帧集合限于该根、帧无 `root` 字段、path 相对该根解析（WSX-01③④）。
2. 多根 4xx 矩阵：歧义 400 / 越界 400（search.rs 文案）/ `..` 清洗 400 / 不存在 404 / 空 pattern 400，且单根实例历史形状逐字节不变（WSX-02）。
3. compute highlight：path 模式按根路由（baseLine 锐证 WSX-05④）、越界 400、text 模式不受 root 影响（WSX-05⑥）。
4. 回归不破坏：SRV-MULTIROOT 既有跨根帧护栏、MRF-01~08 全部持续通过。

### BUG-08 远端来源恢复链（`:r1` 根索引源与跨根 pinned——本域视角）

**缺陷现状**：WS-04/05/06/07 已锚根 0 整根源、basePath 源、根 0 pinned、单文件源的恢复；根 1 整根源（storeId 带 `:r1` 段、无 basePath）的「刷新×2 回环」与「跨根 pinned 目录 tab 读回」无锚（上轮 MRF 缺口 c）。回归形态：恢复重建 storeId 与快照分叉（storeLabel 换算 host 或 rootIndex 丢失）→ 树行消失/tab 落占位/二次刷新落占位；pinned 读回仅覆盖根 0。

**修复后应有行为（回归验收）**：
1. 根 1 整根源刷新×2：树源标签、文件 tab 内容、`/api/file?...&root=1` 透传三面全部逐次恢复，无占位错误卡（WSX-07）。
2. 面板「＋ 添加来源 → 后端路径…」并入既有组形成双根双源：双 tab/双树分组/多源徽标，刷新后双源与根 1 pinned 各自忠实恢复、根 0 不被误标 pinned（WSX-08）。

### 搜索引擎宣告与回退（search-grep-fallback 设计，无缺陷号）

**现状**：resolve_engine 四级链（`server/src/routes/search.rs:123-133`）有 Rust 单测与 health 单测；e2e 仅 CMP-09（其 PATH 剔除拓扑在本机恰好 rg+grep 双缺 → 501 面）。「rg 缺失但 grep 在 → 200 + `searchEngine:'grep'` + col=1 + 前端徽标/tooltip」与「双缺 → health 字段整体省略 + 徽标缺失」无 e2e。

**验收判据**：WSX-03（grep 回退正例全链：API NDJSON 形状 + sessionStorage 缓存 + 面板徽标「服务端搜索：grep」+ 降级 tooltip + 无本地回退提示）；WSX-04（双缺 501 + 字段省略 + 徽标缺失 + 主实例 `rg` 宣告护栏）。回归不破坏：CMP-09 既有 501/降级提示锚。

### BUG-68 watcher 风暴防护承诺面（watch-log-flood 设计——SSE 层视角）

**现状**：t-srv BUG-68 锚「越界 symlink 不降级」；设计 §3「刷屏抑制」的 SSE 可观测承诺——500ms debounce 固定窗口把窗口内连续事件并入同一条 changed（`watch.rs:96,581-582`）、多根逐根聚合并显式携带 root——无 e2e。ErrorLogGate 限频与 `--log-file` 轮转为日志层承诺，分别由 Rust 单测与运维面承担（10MB 阈值不宜 e2e，见 §4.3）。

**验收判据**：WSX-06——单窗口 24 连写 → 帧数 < 24、并集完整（聚合不丢）、至少一帧多路径（聚合确证）、全部帧 `root:1` 且无跨根混入。回归不破坏：SRV-MULTIROOT 的单变更单帧、DEG-07/08 假服务器 SSE 链不受影响。

### MRF 缺口 d：RemoteSourceModal 错误语义（无缺陷号，上轮盘点缺口）

**现状**：MRF-07 只走通多根来源创建 happy-path；浏览层三种错误面（init 网络失败、tree 非 2xx 带 detail、凭据会话失效）无 e2e。错误面契约：`.vv-remotesrc-error`（role=alert）文案 = 「无法连接 …：网络错误或地址不可达」/「服务器请求失败: HTTP <status>: <detail>」，常驻「重试」，多根时另有「← 重选根」逃生通道。

**验收判据**：WSX-09（断线错误面 + 重试持续 + 切根自愈）、WSX-10（401 detail 透传 + 重试持续 + 应用不受伤）。

### WS/TA 邻接：切换器边界与快照保序（无缺陷号）

**现状**：WS-01 锚新建/合法重命名/删除活动组（两组成员）、TA-06 锚组内批量关闭/撤销；「删除最后一组 → 兜底新建默认」「重命名与既有组重名（允许，id 身份不合并）」「重命名空串忽略」「多组切换后快照组序保序 + 逐组 tab 归属还原」无锚。

**验收判据**：WSX-11、WSX-12（判据见清单表期望列）。回归不破坏：WS-01/WS-04 既有断言。

### 终审新增 C1：restore 查表剥占位前缀（终审新增候选清偿批，无缺陷号）

**缺陷现状**：占位 tab 的 `placeholder:` 前缀 storeId 随 `snapshot()` 原样入快照（写侧忠实记录，不改）；restore 读侧 rebuilt 查表/dirSnap 匹配/exists 查重按原始 id 逐字比较，前缀 id 必 miss → 断连刷新过的会话恢复后文件 tab 恒再落占位、占位目录条目（undo 栈窄径产出：close 目录 tab → store 失活 → reopenClosed 落 addPlaceholder 得 `path===''`）整条丢弃。回归形态：前缀快照在服务器存活时内容/目录不复活；来源不可达时落占位叠加双前缀（`placeholder:placeholder:`，逐次刷新持续劣化）。

**修复后应有行为（回归验收）**：
1. 来源重建成功：前缀快照的文件 tab 与占位目录条目双双复活——内容渲染、目录 tab 以无前缀 `remote:` storeId 落快照（WSX-13）。
2. 来源不可达：落占位且快照 storeId 保持单层前缀不叠加（restore 侧 addPlaceholderTab 与 openFlow.addPlaceholder 同款 `originStoreIdOf` 防线，幂等）（WSX-14）。

## 4. 环境与数据

### 4.1 套件与实例矩阵

- server 套件 spec：`apps/web/e2e-server/b-wsx-root-channel.spec.ts`。主实例 :4174（webServer 自起）；辅助实例全部 spec 内 spawn（重试安全 `ensureServe`，`assertPortFree` fail-fast）：**:4396** `--root root0 --root root1`（WSX-01/02/06）；**:4397** 单根 + `PATH=<仅含 grep 的临时目录>` + `--cors-origin http://127.0.0.1:4174`（WSX-03）；**:4398** 单根 + `PATH=<空临时目录>` + 同 cors（WSX-04）；**:4399** `--root … --root … --compute`（WSX-05）。端口 4396-4399 与既有 4173/4174/4178-4180/4375-4377/4383/4384/4395/8399/8449 错开。
- default 套件 spec：`apps/web/e2e/b-wsx-recovery.spec.ts`（chromium + mobile 双 project，树行/切换器经窄视口适配；桌面-only 交互无——本域场景全部键位/点击可达）。
- rg/grep 探测注入手法：`PATH` 指向临时目录——grep 回退实例内放一枚指向真实 grep（`which grep` 探测）的符号链接 `grep`（`resolve_one` 的 `is_executable` 跟随符号链接，`search.rs:135-139`）；双缺实例为空目录（probe 双失败 → 501 + health 省略）。rg 主路径实例（:4396/:4399）继承进程 PATH 不注入。

### 4.2 夹具构造

| 夹具 | 规格 | 用于场景 |
| --- | --- | --- |
| :4396 root0/`wsx-r0.txt`、root1/`wsx-r1.txt` | 各两行，首行同 pattern（`wsx needle shared`）、次行根判异词（zebra/yak） | WSX-01/02 |
| :4396 root1/`sub/needle-deep.txt` | `deep probe needle in sub`（path 相对根解析判别件；pattern 用专属词避免与顶层同 pattern 命中集互串） | WSX-01③ |
| :4396 root1/`burst-00..23.txt` | WSX-06 用例内连写（风暴聚合注入） | WSX-06 |
| :4397 root/`wsx-grep-needle.txt` | 两行，首行含 `grep engine needle`（UI 搜索词命中行） | WSX-03 |
| :4398 root/`wsx-quiet.txt` | 无命中素材（501 面不依赖内容） | WSX-04 |
| :4399 root0/`wsx-hl-r0.js`、root1/`wsx-hl-r1.js` | 1 行 vs 3 行（range.startLine=2 的 baseLine 锐证依赖行数差） | WSX-05 |
| 假双根服务器 rootPaths | `['/wsx-fake-root-0','/wsx-fake-root-1']`（根选择按钮文案断言面） | WSX-07/08/09B |
| 假服务器 root0/`decoy-r0.txt`、root1/`hello-r1.txt` | 根归属判异件（不串根负面断言 + 恢复内容载体） | WSX-07/08 |
| 假服务器 C 的 token 门 | tree/ticket 校验 `Bearer <current>`，current 运行期可写（轮换注入） | WSX-10 |
| 主实例夹具 | 复用 :4174 fixtures.mjs 既有 `hello.js`（`greet`） | WSX-02⑥ |

### 4.3 边界与注意事项

1. :4396/:4399 双根必须互不相交的独立 mkdtemp（嵌套根被 strip_root 前缀匹配误归 0 号根——SRV-MULTIROOT/MRF 同款约束）；不写共享 FIXTURE。
2. `PATH` 注入实例的临时目录在 afterAll 停服之后再清理（符号链接/目录先于进程删除会令 probe 语义漂移）；spawn env 为 `{...process.env, PATH: <注入目录>}`，二进制以绝对路径 spawn 不受 PATH 影响。
3. WSX-06 的 SSE 读取用「pending read 复用 + race 超时」手法（t-srv BUG-68 用例同款：被 race 丢弃的 read 仍会吞下一个 chunk，超时分支仅用于负向/收尾）；收集窗 3s ≫ debounce 500ms，帧数上界断言放宽到 <24 之下再取保守界，避免 CI 负载下的窗口劈裂误报。
4. WSX-01 的 col 精确断言以 health `searchEngine` 为条件（rg 才断言 col，grep 恒 1）——两台以上环境下套件须同绿。
5. WSX-09 断线块的「关停假服务器」须在断言连接成功之后执行；`fetch` 对已关端口的失败为即时 reject，错误文案走 RemoteSourceModal 的网络分支而非 30s 超时分支。
6. WSX-11/12 的删除确认走 `window.confirm`（Playwright 默认 dismiss——必须先挂 `page.on('dialog')` 接受，WS-01 同款）；重命名同名行的定位用 `.vv-ws-item.active` 作用域规避 strict violation。
7. WSX-12 的快照直读等待用 `expect.poll` + IndexedDB `kv.workspaces`（t-workspace waitSnapshotTabs 扩展为组序/activeId/tabs 归属三维断言）；reload 后监听器需重置计数再断言 `root=1` 请求。
8. headless 边界（README §3.1.4）：本域不涉及 FS Access 原生对话框与真实触摸；localfs 权限重确认恢复链因此不在本域布点（沿用既有「真机补测」口径）。
9. 右键固定目录 tab 在窄视口（mobile 375px）的一个坑：TabContextMenu 对**任意滚动**（window capture，TabContextMenu.svelte:49-51「scroll 不冒泡」）即关——双 tab + 管理钮溢出 tabbar 时，右键自带的自动滚动尾随 scroll 事件会把刚弹出的菜单立即关掉。脚本须先 `scrollIntoViewIfNeeded` + 短暂等待滚动安静再右键（WSX-08 实跑发现的确定性失败，单 tab 的 WS-06 无溢出故不触发）；手工执行同理：先把目标 tab 滚到可见再右键。
10. 多源 workspace 下文件 tab 也带来源徽标文本（`.vv-tab-src` 渲染 storeLabel，如「host · 根1/」）——按 tab 名定位目录 tab 时须排除文件 tab（如 `filter({ hasNotText: 'hello-r1.txt' })`），否则 strict violation。

## 勘误（2026-10-16）

2026-10-13 报告所称「源级折叠」在 UI 中不存在（文件树仅目录级展开/折叠，无源级
折叠实现）——非待补面，系报告措辞失实（e2e 富化第三轮 spec §3 既有记录）。
