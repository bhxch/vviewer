# 新远端类型：GitHub / GitLab API 直连 store — 设计

日期：2026-11-12　状态：待用户审阅

## 1. 背景与动机（用户诉求，已拍板）

把 GitHub/GitLab 等代码托管平台作为远端挂载：输入 token（支持 fine-grained PAT）、**可分 user/org 设置不同 token**、支持指定分支/tag/commit，通过 API 获取文件列表与内容。关于「有无不受 CORS 影响的方案」——**已实测有**：

- GitHub API（api.github.com，含 git/trees）、raw.githubusercontent.com：`Access-Control-Allow-Origin: *`（2026-11-12 实测）。
- GitLab API（gitlab.com，含 `repository/files/:path/raw` 端点）：`ACAO: *` + methods GET/HEAD/POST/…（实测）；GitLab **网页版 raw 端点**（/-/raw/）无 CORS 头——必须走 API 端点。
- 结论：**v1 浏览器直连，无需任何代理**。自建 GitLab 实例的 CORS 由管理员配置（直接 fetch 失败走既有 CORS TypeError 特征化文案）；服务端 proxy 通道列为非目标。

## 2. 现状锚点（direct store 家族四点插拔）

- 接口：`TreeStore`（packages/vviewer-core/src/types.ts:39-65：id/displayName/listChildren/read(path,{range?,signal?})/rangeCapable?/close?）；`DirectStore` watch 契约=**立即 onError、listener 恒不触发**（directS3.ts:512-518）。
- storeId 编码：`s3direct:<hash8>`（identity 不含凭据与 label，轮换不换 id，directS3.ts:506-509）、`davdirect:<hash8>`（directDav.ts:124-127）；新增前缀改动面仅两处一行级：`sourceKindOf`（apps/web workspaceStore.ts:72）+ `isMountRootStoreId`（serverHealthCache.ts:75-81，direct 前缀恒挂载源）。
- 创建分派单点：openFlow `createDirectMountStore`（openFlow.svelte.ts:256-269，`'bucket' in cfg` 判别扩支）；direct watch 有意分叉不经 wireStoreWatch（:244-255，只 console.warn 不写全局 watchHealth）。
- 持久化：IndexedDB `mounts` store（DB_VERSION=5）；`DirectMountRecord`（mountsSync.ts:95-111，kind 'direct'，id=core storeId，**凭据明文=既有 spec 拍板**，credentialWarning 警示面现成）；direct 指纹与 server mount_fingerprint 无关（direct 无服务端注册面）。
- 恢复链：AppShell restore `directById`（:944-968）——storeId 即记录 id，`createDirectMountStore(rec)` 重建 → registerStore → 快照有目录条目则 addDirTabForRestore；记录已删→tab 占位不阻断。
- 参考实现：GitHub trees API 列清单+raw 下载+sha 校验+truncated 分层——`tools/fetch-e2e-corpus.mjs:1-35` 是现成 TS 算法参考。
- CORS 特征化先例：`rawFetch` TypeError 特征化（directS3.ts:546-568）+ 错误文案注入缝（mountsSync :44-50，8 个 setter）。
- 搜索：direct 前缀进 isMountRootStoreId → 自动「该根不可服务端搜索」提示 + 浏览器内补扫（globalSearch.ts:63-66；上限 2000 文件/200MB/1000 命中，core/compute/search.ts:56-57）。

## 3. 设计

### 3.1 core：`directGit.ts`（两个实现或 provider 抽象，builder 裁量）

**GitHub**：
- 清单：`GET /repos/{owner}/{repo}/git/trees/{ref}?recursive=1`；`truncated:true` → 按子树逐目录降级拉取（corpus 脚本算法）；清单缓存于 store 实例内（ref+sha 键）。
- 内容：优先 `raw.githubusercontent.com/{owner}/{repo}/{ref}/{path}`（ACAO*、不计 API 限速）；PAT 以 `Authorization: Bearer <token>` 传递（raw 域同样接受）；fallback/强一致场景用 API `repository/files` 面不必要（raw 足够，裁量简化）。
- ref 解析：branch/tag/commit → `GET /repos/{owner}/{repo}/commits/{ref}` 取 sha 缓存（branch 指针过期由刷新动作重解析）。
- 匿名（无 token）可用但 60/h 限速——token 缺失时给出限速提示面（429/403 rate limit 响应特征化）。

**GitLab**：
- 清单：`GET /api/v4/projects/{id}/repository/tree?ref={ref}&recursive=true&per_page=100` 分页（Link header）；
- 内容：`GET /api/v4/projects/{id}/repository/files/{path url-encoded}/raw?ref={ref}`（**API 端点，非网页 raw**），PAT 以 `PRIVATE-TOKEN` 头；
- 项目定位：表单接受 `owner/repo` 或数字 id → `/projects/{url-encoded path}` 解析一次缓存。

**共同**：
- `rangeCapable: false`（v1 全量切片通道；raw 域 Range 支持不被上游契约保证——裁量：GitHub raw 实测支持 Range 后可开启并加 206 校验，仿 s3direct 可读窗段三态校验先例）；
- watch：DirectStore 契约（立即 onError，无 watch 能力）；
- 凭据不入 storeId：`githubdirect:<hash8(owner/repo/ref/prefix)>`、`gitlabdirect:<hash8(host/project/ref/prefix)>`；
- 错误：401/403/404/429 各自特征化文案（中文/英文，经注入缝 setter 模式）；CORS TypeError 复用特征化。

### 3.2 token 管理（分 user/org）

- 目录管理页新增「凭据」区块（或并入 mount 表单旁，裁量）：按 **host+owner/org** 条目化存 token（GitHub：`github.com:<owner>` 或 `github.com:*` 通配；GitLab：`<host>:<namespace>` 或通配）。fine-grained PAT 与 classic 同形存储（都是 header token，无区别处理）。
- mount 创建时 token 输入框可留空 → 按记录的 owner 匹配凭据库（精确 owner → 通配 → 匿名）；显式填入则随该 mount 记录存（覆盖库匹配）。凭据明文 IndexedDB + credentialWarning 双处警示先例沿用。
- 反目标：不做 OAuth 流程、不做加密存储（明文=既有拍板）、不做多 token 轮询（429 时提示换 token）。

### 3.3 前端接线（四点插拔逐点落地）

1. storeId 前缀两处判定各加一行（§2 锚点）；
2. `DirectMountRecord.backend` 扩 `'github'|'gitlab'` + 表单字段（owner/repo、ref（下拉/输入任意 ref 文本）、子目录 prefix、host（GitLab 可自定义自建域））；`directConfigOf` 映射分支；
3. openFlow `createDirectMountStore` 第三/四判别支；
4. 恢复链零改动（storeId 即记录 id 机制直接生效）。
- 目录管理页组②新增两类表单 + **测试连接**按钮（refs 解析 API 探测 + 树清单首页采样，成功显示文件数/ref sha）。
- 快照恢复：DirectMountRecord 含 ref/prefix/owner 全量信息 → 重建后指向最新 ref 解析（branch 已移动指向新 commit——预期行为，记录在快照注记）。

## 4. 目标 / 非目标 / 反目标

- 目标：GitHub/GitLab（含自建 GitLab 域）目录只读挂载；token 分 owner 条目化；ref 任意（branch/tag/commit）；搜索走本地补扫语义自动生效。
- 非目标：服务端 proxy 通道；写操作；GraphQL；submodule 递归；Range 流式（v1 全量）；watch（无上游能力）。
- 反目标：把 token 编进 storeId/hash（轮换会换 id 破坏快照恢复）；为 anonymous 提供无限速保护（提示即可）；网页版 raw 端点（无 CORS）。

## 5. 验收锚点

- 单测：trees recursive+truncated 分层算法（mock 分页/截断响应）；ref 解析缓存；路径编码（GitLab url-encoded file path）；storeId hash 输入不含 token（快照恢复断言）。
- e2e：fake 伺服 mock API 面（tree/raw/raw-file 端点，fake-file-server.ts 惯例）——挂载→浏览→打开文件→快照恢复→删除；token 缺失 429/401 特征化文案；白名单/自建域 CORS 失败 TypeError 文案。
- 真网冒烟（手动清单）：挂 bhxch/vviewer 仓库 lite 路径实测（匿名限速内完成）。

## 6. 留给 builder 的裁量

- github/gitlab 双实现 vs 单 provider 抽象；清单缓存刷新策略（手动刷新按钮 vs 打开时自动）；raw vs API 内容通道的最终选择（限速 vs 一致性权衡）；凭据区块在目录管理页的落位；prefix 过滤在前端树层还是清单层；Range 实测后是否开启。
