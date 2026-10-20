# 目录挂载阶段三+四：前端直连 store 与目录管理页 Implementation Plan（spec §4+阶段四）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 前端直连 S3/WebDAV 两类 TreeStore（浏览器内 SigV4 签名 fetch/PROPFIND 解析，凭据 IndexedDB 明文+警示）；目录管理页三组聚合展示（服务端根与挂载/前端配置挂载/本机授权来源）+ 增删测试打开。

**Architecture:** 直连 store 实现与 RemoteStore 同 TreeStore 接口（packages/core/src/tree/）；TS SigV4 用 WebCrypto SubtleCrypto（HMAC-SHA256 异步，不引依赖）；S3 直连 ListObjectsV2/GET 同服务端语义；WebDAV 直连复用服务端 multistatus 解析语义（TS 侧 DOMParser 版）；目录管理页全屏 overlay（设置中心同形态先例），三组数据源=health/mounts API + mounts store + localfs 状态。

**Tech Stack:** WebCrypto SubtleCrypto、DOMParser、fake-indexeddb/vitest、playwright（mock S3/Dav 伺服）。

**Spec:** `docs/superpowers/specs/2026-10-19-directory-mounting-design.md` §4+§5（阶段四）

## Global Constraints

- 直连只读：listChildren/read/watch（watch 恒不支持）；凭据 IndexedDB 明文+管理页警示（spec 拍板）。
- S3 直连签名：SigV4（与阶段一 Rust 实现同规范——向量复用）；CORS 失败特征化错误文案（「bucket CORS 未配置或网络不可达」——TypeError+0 字节特征）。
- WebDAV 直连：UI 预检明确提示服务器需配 CORS（大概率被拦，知情使用）。
- rangeCapable=false（Range 不回 Content-Range/长度超窗）→ 走既有全量切片通道（!rangeCapable 语义）。
- storeId：`s3direct:<hash8(config)>` / `davdirect:<hash8(config)>`——hash8 与既有 storeId hash 形态一致。
- 挂载配置 mounts store（v4 已建）扩 kind: 'direct'（Plan B 已有 'proxy'）。
- 目录管理页：Ctrl+Alt+M 或 TopBar 入口（spec §5 阶段四），与 zen/设置中心 overlay 同形态；三组展示+确认弹窗纪律。
- 每任务原子提交；测试在仓库根跑。

---

### Task 1: 直连 TreeStore 实现（s3direct + davdirect）

**Files:**
- Create: `packages/core/src/tree/directS3.ts`（SigV4 签名 fetch + ListObjectsV2 解析 + GET Range）
- Create: `packages/core/src/tree/directDav.ts`（PROPFIND/GET + Basic）
- Modify: `packages/core/src/tree/`（TreeStore 注册/工厂——rg createRemoteStore 的消费点定直连 store 的创建入口 openFlow 侧）
- Modify: `packages/core/src/tree/mountsStore`（Plan B 的 mounts store——kind 扩 'direct' 与直连配置字段）
- Test: `packages/core/test/directS3.test.ts`、`directDav.test.ts`（WebCrypto 在 vitest node 可用【node 18+ globalThis.crypto】；fetch mock 形态照 RemoteStore 既有测试先例）

**Interfaces:**
- Produces: `createS3DirectStore(cfg, opts): TreeStore`、`createDavDirectStore(cfg, opts): TreeStore`（与 RemoteStore 同接口：listChildren/read[Range]/watch[恒不支持]/capabilities）；`signS3Get(url, creds): Promise<Headers形态>` 纯函数（向量锚）；`parseMultistatus(xml): Entry[]`（DOMParser）。

- [ ] **Step 1: 写失败测试**（SigV4 向量与阶段一 Rust 同例交叉锚【同输入同签名——WebCrypto HMAC 与 Rust hmac 输出一致】；ListObjectsV2 解析对齐服务端语义；CORS TypeError 特征化错误；Range 非 206 判定 rangeCapable=false 全量切片；PROPFIND 双前缀解析；dav GET Basic 头）。
- [ ] **Step 2: 确认失败**
- [ ] **Step 3: 实现**
- [ ] **Step 4: 跑测试确认通过 + packages/core 回归**
- [ ] **Step 5: Commit** `feat(mounts): 前端直连 TreeStore——s3direct/davdirect`

---

### Task 2: 目录管理页（阶段四）

**Files:**
- Create: `apps/web/src/lib/MountsManager.svelte`（全屏 overlay 三组）
- Modify: `apps/web/src/lib/settings/` 或独立入口接线（TopBar 入口 + Ctrl+Alt+M；** OVERLAY_SELECTOR 入册**——zen Esc 优先级）
- Modify: `apps/web/src/lib/mountsSync.ts`（管理页消费：direct 记录 CRUD/测试连接/对账状态展示；警示文案固定出现在新增表单与列表详情）
- Test: 纯逻辑直测 + e2e（Task 3）

**Interfaces:**
- 三组：①服务端根与挂载（health/mounts API 数据——fs 根/静态/运行时徽标+「在树中打开」）②前端配置挂载（mounts store direct+proxy——新增表单[kind→字段集切换→测试连接→保存]/编辑/删除/测试/打开[proxy 已注册 rootIndex 状态徽标]）③本机授权来源（localfs 句柄名称+授权状态+打开/清除/localfiles 会话来源）。
- 测试连接：S3=list_dir 探测回显条目数与延迟；WebDAV=PROPFIND 探测+CORS 预检提示。
- 警示文案（spec §6）：直连凭据 IndexedDB 明文可被同源脚本与本机用户提取——新增表单与列表详情双处固定。

- [ ] **Step 1: 写失败测试**（三组数据装配纯函数/表单必填校验/测试连接状态机/删除引用回落联动复用——按纯逻辑可测面切分）。
- [ ] **Step 2: 确认失败**
- [ ] **Step 3: 实现**
- [ ] **Step 4: 跑测试 + typecheck + build:e2e**
- [ ] **Step 5: Commit** `feat(mounts): 目录管理页——三组聚合/表单/测试连接`

---

### Task 3: e2e + 门禁 + 文档

**Files:**
- Create: `apps/web/e2e/b-mounts-manager.spec.ts`（mock S3/Dav 伺服 route 拦截）；Modify: `README.md`（目录管理页行+直连 CORS 前置说明）

- [ ] **Step 1: e2e**：①管理页打开三组渲染（mock health/mounts API + 预置 store 记录）②新增 direct 挂载表单→测试连接（mock 拦截）→保存→列表③「在树中打开」挂载根→树渲染④CORS 失败特征文案⑤直连凭据警示文案可见⑥删除联动。
- [ ] **Step 2: 门禁**：typecheck + 全仓 vitest + build:e2e + 定向 e2e + b-mounts 回归。
- [ ] **Step 3: README + Commit** `test(e2e): 目录管理页冒烟+README 同步`

---

### 实施风险与裁决预留

- SigV4 的 WebCrypto 异步性使签名无法同步——TreeStore.read 返回 Promise 内 await 签名即可（接口本异步）。
- ListObjectsV2 分页聚合在前端的内存面（大目录全聚合——与 RemoteStore 既有分页语义对齐，RemoteStore 若有分页则直连同款；实读后取一致形态）。
- 直连 store 的 storeId 与快照恢复（含凭据引用——重启后凭据从 mounts store 恢复，store 失效（记录删除）→占位 tab 降级，复用既有降级链）。
- 目录管理页数据源三组的服务端 API 形态（mounts API 已有 GET；localfs 句柄状态读取面 rg dirHandle）。
- e2e mock S3 的 route 拦截形态（**/bucket/** pattern + SigV4 头不校验——mock 不验签）。
