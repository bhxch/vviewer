# 多根 file 通道与越界防护 — e2e 场景（本轮补充）

> 来源：e2e 补充测试盘点（2026-10-13）medium 缺口。workspace 多根（spec `docs/superpowers/specs/2026-10-11-workspace-tabs-design.md` §2.1/§5「`--root a --root b` 下 tree/file 的 `root` 参数路由与越界 403/400」）的 e2e 只有 SRV-MULTIROOT（apps/web/e2e-server/t-srv.spec.ts:609 起），覆盖 health roots/rootPaths、tree?root、search 跨根帧、SSE root 帧——**file 通道 `?root=` 路由与越界防护零锚**；UI 面（多根来源创建→rootIndex 透传→watch 帧按来源过滤）同样无锚。
>
> 服务器事实（源码核实）：`server/src/routes/file.rs:189` `resolve_at(&state, q.path, q.root.unwrap_or(0))`；`server/src/guard.rs:31-52`——root_idx 越界 → 400 `root index out of range`，canonicalize 后越出所选根 → 403 `path escapes root`，路径不存在 → 404。
>
> 口径修正：盘点曾列「快照 v2 迁移无 e2e」——实际 t-open-with.spec.ts:254 起（BUG-69 用例）已种旧 `tabs` 键走 migrateLegacyTabs + remote 重连断言，本域不重复布点。本域缺陷编号 BUG-107 为回归防护缺口编号。

## 1. 目的与来源

多根服务端的面：

- **API 面（server 套件，release 二进制真实行为）**：`/api/file?root=N` 按根路由、越界 400、越界 symlink 403、root 与 Range 共存、单根兼容；
- **UI 面（server 套件，同源页面）**：双根实例伺服 web-dist → 页面连本机 → 添加 1 号根来源 → 打开文件渲染（RemoteStore `rootIndex` 透传 `&root=`，remote.ts:112-148）；watch 帧带 root 时按 rootIndex 过滤（remote.ts:126「单根服务器省略 root = 全部接受」），root0 变更不得触发 root1 来源 tab 重渲染。

既有锚点：SRV-MULTIROOT（health/tree/search/SSE 的 root 帧）、WS-01~07（workspace UI）、BUG-68 探索用例（越界 symlink watcher 不降级，含 0o000/建链手法）。

## 2. 场景清单

公共环境：server 套件（`apps/web/playwright.server.config.ts`：release 二进制 :4174 同源伺服，chromium 单 project，workers 1）。API 级场景直接 fetch；UI 级场景另起双根实例（:4395，`--root r0 --root r1 --web-dist apps/web/build`，两根为互不相交的独立临时目录——嵌套根会被 strip_root 前缀匹配误归 0 号根，SRV-MULTIROOT 注释同款约束）。

| 编号 | 前置条件 | 步骤 | 期望 | 关联缺陷 |
| --- | --- | --- | --- | --- |
| MRF-01 | 双根实例 :4395（root0/`a.txt`='r0'，root1/`b.txt`='r1'） | ① `GET /api/file?path=a.txt&root=0`；② `GET /api/file?path=a.txt`（缺省）；③ `GET /api/file?path=b.txt&root=1` | ①=②（root=0 显式与缺省等价，返回 'r0'）；③ 返回 'r1'（按根路由） | BUG-107 |
| MRF-02 | 同 MRF-01 | ① `GET /api/file?path=a.txt&root=2`；② `GET /api/tree?path=&root=9`；③ 对照 `root=1` 正常 | ① 400 且错误体含 `root index out of range`（guard.rs:36-38）；② 同 400；③ 200 护栏 | BUG-107 |
| MRF-03 | 双根实例；root1 内放 `sub/only-r1.txt`；root0 内放 `other.txt` | ① `GET /api/file?path=../a.txt&root=1`；② `GET /api/file?path=other.txt&root=1`；③ `GET /api/file?path=sub/only-r1.txt&root=1` | ① 400（`../` 清洗层拒绝）；② 404（root0-only 路径在 root=1 下不存在——按根解析不串根）；③ 200 'r1' | —（guard 清洗/按根解析锚） |
| MRF-04 | root1 内建 symlink `esc → ../outside-secret`（指向 root 外真实文件） | ① `GET /api/file?path=esc&root=1`；② 对照 root1 内正常文件 | ① 403 且错误体含 `path escapes root`（guard.rs:46-50 canonicalize 越界校验）；② 200 护栏（BUG-68 建链手法，TOCTOU 窗口为已知接受风险不影响断言） | —（越界 symlink 防护锚） |
| MRF-05 | 双根实例；root1/`range.bin` = 1MB 二进制含布点 | ① `GET /api/file?path=range.bin&root=1` 带 `Range: bytes=0-1023`；② `Range: bytes=1048570-`（尾越界钳制） | ① 206 + Content-Range `bytes 0-1023/1048576` + body 恰 1024 字节（root 参数与 Range 语义共存）；② 206 钳制到末字节（前端窗口流式对 root1 文件的 Range 契约） | —（root×Range 共存锚） |
| MRF-06 | 主实例 :4174（单根，webServer 自起） | ① `GET /api/file?path=<既有夹具>&root=0`；② `GET /api/file?path=<同夹具>&root=3` | ① 200（单根显式 root=0 正常，单根请求形状不变）；② 400 越界（单根下越界同样防护）；①② 均不因多根参数引入回归 | —（单根兼容锚） |
| MRF-07 | :4395 页面 + 双根实例；root1/`hello-r1.txt` 内容带可断言文本 | ① 打开 `http://127.0.0.1:4395`；② 「连接服务器」填本机 base 连接；③ 经来源创建流添加 1 号根目录来源（health roots=2 → 选根 1）；④ 树中打开 `hello-r1.txt`；⑤ 读渲染与网络请求 | 多根来源 UI 全链：root1 来源树只见 root1 条目；文件以 code 渲染且内容正确；page 侧 /api/file 请求带 `root=1`（rootIndex 透传，remote.ts:124-127）；无错误卡片 | BUG-107 |
| MRF-08 | 同 MRF-07 现场已打开 root1 来源的 `hello-r1.txt` | ① 向 root0 目录写入新文件（触发 root0 watcher）；② 等待 2s 读页面（无重渲染证据：计量/内容不变）；③ 改写 root1/`hello-r1.txt` 内容；④ 等 SSE changed 后读页面 | watch 帧按来源 rootIndex 过滤（remote.ts:126）：root0 变更不触发 root1 来源 tab 的重渲染；root1 变更触发重渲染且更新后内容可见 | —（watch 归属过滤 UI 锚） |

## 3. 关联缺陷的验收行为

### BUG-107 多根 file 通道 root 参数路由失效/越界不防护（回归防护缺口）

**缺陷现状**：workspace-tabs spec §2.1 明确「`/api/tree`、`/api/file`、`/api/compute/*` 增加可选 `root`（0-based 索引，缺省 0）……`root_idx` 越界 → 400」，§5 服务端集成验收列「tree/file 的 `root` 参数路由与越界 403/400」。SRV-MULTIROOT 只断言了 tree/search/SSE/health 四面，file 通道的 `?root=` 路由（file.rs:189）与 guard.rs 越界 400/403 无任何 e2e；前端 rootIndex 透传（remote.ts storeId `:r<N>` 段）与 watch 过滤亦无 UI 级锚。多根来源打开文件回落 0 号根（同名路径）或越界参数 500 化均属本缺口回归形态。

**修复后应有行为（回归验收）**：
1. `?root=N` 按根路由正确：root1 只能取 root1 子树文件；显式 root=0 与缺省等价（MRF-01/03）。
2. root 越界 → 400 `root index out of range`（file/tree 双端点，MRF-02/06）；`../` 清洗 → 400；symlink 越出所选根 → 403 `path escapes root`（MRF-03/04）。
3. root 与 Range 共存语义正确（206/Content-Range/尾钳制，MRF-05）。
4. UI 全链：多根来源创建→root1 文件渲染→请求带 `root=1`（MRF-07）；watch 变更按来源根过滤（MRF-08）。
5. 回归不破坏：单根部署请求形状不变（MRF-06）、SRV-MULTIROOT 既有四面护栏持续通过。

## 4. 环境与数据

### 4.1 套件与实例矩阵

- server 套件（`apps/web/playwright.server.config.ts`，testDir `apps/web/e2e-server`，release 二进制 :4174，chromium 单 project，workers 1）。
- spec：`apps/web/e2e-server/b-multiroot-file.spec.ts`（自包含：双根实例 spawn/健康等待/端口预检/assertPortFree 复制 t-srv.spec.ts SRV-MULTIROOT 同款手法；固定端口 **4395**，与既有 4173/4174/4384 及 4375-4383 段错开）。

### 4.2 夹具构造

| 夹具 | 规格 | 用于场景 |
| --- | --- | --- |
| root0/a.txt、root1/b.txt | 单行文本，内容互异可断言 | MRF-01/02/03 |
| root1/sub/only-r1.txt、root0/other.txt | 根归属判别件 | MRF-03 |
| root1/esc → ../outside-secret | symlink（outside-secret 在双根之外的临时目录，内容可断言） | MRF-04 |
| root1/range.bin | 1MB 二进制（0xde 布点于 0x100/0xff00） | MRF-05 |
| root1/hello-r1.txt | 文本件（SSE 阶段被改写） | MRF-07/08 |
| 主实例夹具 | 复用 :4174 webServer 既有 fixtures.mjs 清单中的任一文本件 | MRF-06 |

### 4.3 边界与注意事项

1. 双根必须互不相交的独立临时目录（mkdtemp），不得嵌套、不得写入共享 FIXTURE（root0 顶层清单被既有用例断言；嵌套根被 strip_root 逐根前缀匹配误归——SRV-MULTIROOT 注释同款约束）。
2. symlink 场景注意测试环境保留 symlink（无 Windows;tokio::fs::canonicalize 语义按 Linux）；用后清理。
3. UI 场景连接 base 用 `http://127.0.0.1:4395`（同源，无 CORS 面）；「连接服务器/服务器地址/连接」选择器沿用 b-io-streaming.spec.ts:286-290 connectForm。
4. MRF-08 的 watcher 等待用轮询（waitHealthy 同款健康轮询思路），root0 写入后 2s 内页面无变化判定要留足 watcher 聚合延迟裕量再判负向。
5. API 断言错误体形态以 guard.rs 文案为准（`root index out of range` / `path escapes root`），错误码断言 400/403 精确值。
