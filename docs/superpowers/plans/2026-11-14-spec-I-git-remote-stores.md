# GitHub/GitLab API 直连 store（新远端类型挂载 + 分 owner 凭据库）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 GitHub/GitLab（含自建 GitLab 域）作为浏览器直连只读挂载（spec I）：①core 新 `directGit.ts` 双工厂——GitHub trees recursive+truncated 分层清单 / GitLab 树分页顺序拉（per_page=100、2 万条目上限）+ raw 内容通道（GitHub raw 优先、401/403 降级 API blobs 兜底；GitLab 恒 API files/raw 端点）+ 401/403/404/429/CORS TypeError 特征化文案（注入缝 setter 模式）；②分 host+owner 条目化的 Git 凭据库（IndexedDB mounts store 第三 kind `gitcred`，`DirectMountRecord` 存 credentialKey 引用——轮换=改库条目即生效）+ 显式 token 直存记录；③目录管理页 git 两类表单（owner/repo、ref 纯文本、GitLab host/项目、子目录 prefix）+ 组④「Git 凭据」区块 + git 测试连接（文件数/ref sha 回显）；④四点插拔（storeId 前缀两判定、DirectMountRecord/directConfigOf、createDirectMountStore 分派+查库、恢复链机制零改动）。

**Architecture:** core 层单文件双实现（`createGithubDirectStore`/`createGitlabDirectStore` + 共享 rawFetch/ensureOk/切片 helper，directS3/directDav 两文件同族先例——§6 裁量落定）：清单整树缓存在 store 闭包（GitHub 键=ref+解析 sha，GitLab 键=ref 文本），根 listChildren 恒重解析（GitHub commits API / GitLab 直接重拉），sha/ref 命中零请求复用、子目录 listChildren 纯内存切片；挂载 prefix 清单层下钻（GitHub corpus `listSource` 逐段取子树 sha 算法、GitLab tree API `path` 参数）。apps/web 层凭据经 mountsSync `recordCache` 同步镜像在 `directConfigOf` 内现查（`createDirectMountStore` 同步签名维持——恢复链/打开链零 async 改动）；UI 落 MountsManager 组②表单扩支 + 组④凭据区块（全屏 overlay 既有入册面内新增区块，无新浮层）。

**Tech Stack:** Svelte 5 runes（全局强制）、vitest（仓库根 jsdom）、Playwright 双 project、Conventional Commits。

**Spec:** `docs/superpowers/specs/2026-11-12-git-remote-stores-design.md`（本计划从 spec 论证；实现者两份都读——spec §3 设计、§4 目标/非目标/反目标、§5 验收锚点、§6 裁量与 §7 builder check 订正落定节同样有效）

## 基线与实施顺序

- **基线**：当前 HEAD `475364f`（main；工作树 clean——spec A/B/C/D/E 已全部落地含评审修订，最近 commit 为 D 批 M6 评审订正）。spec I 此前零落地（`rg "githubdirect|gitlabdirect|directGit" packages apps/web/src` 零命中实查）；本计划全部工作基于该 HEAD 展开。
- **实施顺序**：Task 1 → Task 2 → Task 3 → Task 4 → Task 5，**严格串行**。理由：T1 core 工厂/storeId/错误缝是 T2 分派与配置映射的消费前提（core 导出先定后消费）；T2 逻辑面（前缀判定/git 记录/凭据解析/createDirectMountStore 分派）是 T3 表单与凭据区块的接口前提（表单经 draftToDirectRecord/凭据 helpers 落记录）；T3 装配是 T4 e2e 锚批的运行时前提；T5 收尾。
- **grammar 构建链（spec F）条件核查**：本计划触及面为 vviewer-core tree 直连家族、apps/web 挂载/凭据/管理页与 e2e——**不触及** `tools/grammar-builder`、`build.mjs`、gen-sources 与任何 cargo 生成物，**无需 gen-sources 与 build.mjs --fetch 先行步骤**（无 cargo 依赖；本计划零 grammar 消费面）。
- **不触及 server/（Rust）**：v1 浏览器直连、服务端 proxy 通道列为非目标（spec §1/§4 拍板）——挂载不经服务器、无注册面（直连记录不入对账，mountsSync.ts:8 既有分层），本计划零 server/ 文件改动（`rg -i "github|gitlab" server/` 仅 markdown.rs:53-222 注释中的 GitHub 渲染语义比对，零相关实现面实查）。

## Global Constraints

- **拍板项不得偏离**（spec §1/§3/§4/§7 落定）：
  - **v1 浏览器直连、零代理**：GitHub（api.github.com + raw.githubusercontent.com，ACAO\*）与 GitLab（API 端点，ACAO\*）直 fetch；GitLab **网页版 raw 端点（/-/raw/）反目标**——内容恒走 `repository/files/:path/raw` API 端点；自建实例 CORS 失败走既有 TypeError 特征化文案（不提示代理通道）。
  - **只读挂载**：非目标=写操作/GraphQL/submodule 递归（trees 清单 `type:'commit'` 条目跳过）/Range 流式/watch（DirectStore 契约：立即 onError、listener 恒不触发，directS3.ts:512-518 同款）。
  - **凭据不入 storeId**：`githubdirect:<hash8(owner/repo/ref/prefix)>`、`gitlabdirect:<hash8(host/project/ref/prefix)>`——token/credentialKey 不得进 hash 输入（反目标红线：轮换换 id 会破坏快照恢复；单测硬断言）。
  - **凭据库引用模型**（§7 落定 2）：凭据库按 host+owner 独立条目（GitHub `github.com:<owner>`、GitLab `<host>:<namespace>`；owner 通配条目 `*`）；token 留空的记录存 `credentialKey`（匹配顺序精确 owner → 通配 → 匿名），`createDirectMountStore` 重建经 directConfigOf 按 credentialKey 查库——**轮换凭据=改库条目即生效**；显式填 token 的记录直存 token（不建库条目、不写 credentialKey）。凭据明文 IndexedDB + credentialWarning 双处警示沿用（spec §4 拍板既有）。
  - **反目标**：OAuth 流程、加密存储、多 token 轮询（429 时特征化文案提示换 token）、anonymous 无限速保护（提示即可）。
  - **ref 输入形态**（§7 落定 3）：纯文本输入 + 测试连接探测；**不做 branches/tags 下拉列表**；表单 hint 标注「匿名模式探测消耗 GitHub 匿名限速额度（60 次/小时）」与「branch 型 ref 每次打开/恢复重解析指向最新 commit（§3.3 快照注记语义）」。
  - **GitLab 分页**（§7 落定 4）：per_page=100 **顺序**拉 + 条目上限默认 2 万（数值裁量落定）后 throw 特征化截断文案（FileTree SUSP-07 状态栏提示通道呈现，直连 store 无 UI 进度通道——记档 ⑤）；**禁的是 offset 深分页并发**，Link header 不可读时退化 page 参数顺序走页（同一顺序语义，见 T1 Interfaces）。
  - **内容通道**（§7 落定 1）：GitHub raw 优先（`raw.githubusercontent.com/{owner}/{repo}/{sha}/{path}`，ref 槽取解析后 sha——清单快照一致性，记档 ④）+ API 兜底（401/403 自动降级，api.github.com Bearer 标准契约；兜底具体端点落定 `git/blobs/{manifestSha}`——Errata ①）；API 命中比例注记限速预算（5000/h）于模块注释。
  - **rangeCapable: false**（§3.1 共同 + §6 裁量落定=不开启）：v1 全量切片通道；raw 域 Range 不被上游契约保证，实测开启与 206 校验列为后续增强（不实施）。
  - **搜索/watch 语义自动生效**：前缀进 isMountRootStoreId → per-source「此源不支持变更推送」+「该根不可服务端搜索」+ 浏览器内补扫（globalSearch.ts:63-66 + GREP_MAX_FILES 2000/GREP_MAX_BYTES 200MB/GREP_MAX_MATCHES 1000 上限，core/compute/search.ts:56-60）零新代码——仅靠前缀判定扩列即达。
- **runes 纪律**：`.svelte`/`.svelte.ts` 一律 runes 写法（`$state`/`$derived`/`$props`），legacy 语法编译报错；MountsManager.svelte 为既有 runes 组件扩展，新逻辑全部落纯 `.ts`（mountsManager.ts/mountsSync.ts/core directGit.ts）供 vitest 直测。
- **i18n 纪律**：新文案键落 `catalogs/{zh-CN,en}/mounts.ts`（域=mounts，core 直连错误注入缝消费面同源），key 三段 `{域}.{模块}.{语义}`；en 键集==zh 键集由聚合机检硬断言（catalogs.aggregate.test.ts）；占位符 zh/en 一致。core 包保持零 i18n 依赖（注入缝 apps/web → core 方向不反转，directS3.ts:67-72 模块注先例）。
- **门禁口径**：vitest 一律在**仓库根**跑（包目录直跑缺 jsdom）；typecheck 仓库根 `pnpm run typecheck`；重建 web 一律 `pnpm --filter web build:e2e`（裸 build 冲掉 CDN 注入）；playwright 一律 `pnpm --filter web exec playwright test …`（根 package.json 无 playwright devDep）。
- **commit 纪律**：Conventional Commits（feat/fix/test/docs… 中文主题）、原子化；`git status --porcelain` 自查净空再 add（不按记忆清单）；**一律不得 git push**。
- **UI 文案/交互组件/a11y 任务前置阅读**（Task 3 开工前全文加载，不凭记忆转述）：`docs/design/frontend-conventions.md`（§3 i18n 纪律 + §4 a11y 基线 + §6 评审必查清单）、`docs/design/semantic-components.md`（MountsManager 全屏 overlay 已入册 OVERLAY_SELECTOR——mountsManagerUi.test.ts:26 契约；组④区块为该面板内部新增 section，**非新浮层/菜单/确认通道**，表单控件非浮层不入册；若该文档清单要求登记则先登记后使用）、`docs/design/ui-design-system.md`（组④/表单扩支沿用既有 `vv-mm-*` 类与面板 z-index=30 层，零新 token）。Task 2 的 mounts.err.* 注入缝文案属 i18n 面：开工前读 `docs/design/frontend-conventions.md` §3。
- **e2e 装置既有先例**（Task 4 直接复用，不新造）：`b-mounts-manager.spec.ts` 的 mockS3/mockDav（:171-202/:203-227）——`page.route` 拦截 + CORS_HEADERS（ACAO\* + allow-headers/methods）+ OPTIONS 预检应答 + authLog 采集 authorization 头存在性断言 + 未命中兜底 404；IndexedDB 直写装置 seedMountRecord/seedSnapshot（:98-119/:122-135，免版本 open + 五 store 幂等补建）；hash8 镜像函数（:54-61，快照 storeId 预置闭环）；面板通道 openMountsPanel（:154，⋯ 菜单 aria-label=目录管理）与表单 fill 装置 fillS3Form（:228-240，#vv-mm-* id）；树行断言 seeTreeRow 抽屉适配（:146-152）。**git mock 落定为 page.route 拦截 GitHub/GitLab 真实域名形态**（Errata ⑥：GitHub 域名固定无法指 fake host，node:http fixture 不可达；route 先于网络，零真实出网、不烧限速）。
- **规划期实查订正**（2026-11-14，规划师 I，基于 HEAD 475364f；锚点勘误与机制落定全文见文末 Errata）：
  1. spec §2 行号锚漂移：AppShell 恢复链实为 **:1071-1095**（restore() 函数体 :979 起；directById 构建 :986-988 `listDirectMounts().catch(() => [])` 先于逐来源重建——凭据库查库时序成立），非 :944-968；注入缝 `mountsSync.ts:44-50` 为 **7 个 setter**（spec 写 8）；DirectStore 接口实为 directS3.ts:512-518。
  2. **核心 storeId/凭据隔离机制**：`directConfigOf`（mountsSync.ts:323-346）是创建分派与管理页探测的单一映射面——git 凭据现查落本函数内（recordCache 同步镜像，mountsSync.ts:203 记录缓存经 list/save/delete 三漏斗维护），`createDirectMountStore`（openFlow.svelte.ts:256-269）签名维持同步；AppShell 恢复 :986 listDirectMounts → recordCache 已建 → :1081 查库恒命中；冷启动极快点击窗口退化为匿名（401/限速文案可见、重开自愈）——记档 ③。
  3. **DB 零升版**：凭据条目入既有 IndexedDB `mounts` store（session.ts:71 DB_VERSION=5 零改动）为第三 kind `gitcred`——kind 判别联合扩列；既有消费面（recordCache 镜像/displayLabelForStore/displayEndpointForStore 精确 id 命中/listProxyMounts/listDirectMounts kind 过滤）对 `gitcred:` 前缀 id 天然隔离，唯一需主动过滤点是组②装配 assembleMountRows（Task 3 内收）。
  4. **直连前缀判定全仓恰好两处**（spec §2「两处一行级」实查确认）：workspaceStore.ts:72（sourceKindOf）+ serverHealthCache.ts:76（isMountRootStoreId）；downloadProgress.ts:84 经 sourceKindOf 单源派生自动扩列（R2 直连下载进度卡对 git 挂载自动生效，零改动）。
  5. **凭据轮换释放链免费复用**：MountsManager submitForm → saveDirectMount → releaseDirectMountStore（MountsManager.svelte:285/:289 既有流程）对 git direct 记录同型生效——保存后旧实例释放、下次打开持新凭据（openFlow.svelte.ts:290-297）。

## Review Focus

1. **storeId hash 输入不含凭据（反目标红线）**：`githubDirectStoreId`/`gitlabDirectStoreId` 入参类型用 `Pick<…>` 约束到 owner/repo/ref/prefix（+host/project）——token/credentialKey **类型上就进不去**（s3DirectStoreId Pick 先例 directS3.ts:506）；单测断言「token 不同 → 同 id」「credentialKey 变化 → 同 id」（快照恢复断言，spec §5 单测锚第四条）。
2. **gitcred 记录的既有消费面零破坏**：recordCache 镜像全 kind 混存——`displayLabelForStore`/`displayEndpointForStore` 按 `recordCache.get(storeId)` 精确 id 命中（mountsSync.ts:285/:307），`gitcred:` id 与 storeId 恒不相交；`listProxyMounts`/`listDirectMounts` kind 过滤隔离；**assembleMountRows 必须过滤 gitcred**（否则组②把凭据条目当挂载行渲染、backendLabel 判空）——单测锁定。DB_VERSION 与 onupgradeneeded 零改动（无新 object store）。
3. **createDirectMountStore 同步签名维持**：凭据解析不得引入 async IndexedDB 读——一律经 recordCache 同步镜像；若发现必须 async 化（镜像未建窗口不可接受），升级为 Errata 记档并同步改 AppShell 恢复 :1081/openDirectMount :278/probeWith 三调用面为 await 形态——不得静默把 openDirectMount 改 async 而漏 AppShell 恢复链。
4. **GitHub 内容通道的快照一致性**：raw URL ref 槽用解析后 sha（非 ref 文本）——branch 移动后清单与文件内容同代际；GitLab raw 恒 ref 文本（上游语义，无树 sha 可锚）——两平台一致性差异记档 ④，单测各锚一例（GitHub：ref 解析后的 raw URL 断言含 sha；GitLab：raw URL 断言含 ref 文本）。
5. **GitLab 分页顺序性与上限**：Link rel=next 顺序 follow（禁并发）；Link 头不可读（CORS 未 Expose）退化 page 参数顺序走页直到短页；两路共用 2 万条目上限 throw 截断文案（不静默截断——corpus 脚本「绝不静默截断」纪律 fetch-e2e-corpus.mjs:9 同款）；单测双路径（Link 在场/缺省）+ 上限各锚。
6. **GitHub truncated 分层绝不静默**：recursive 响应 `truncated:true` → 按子树逐目录 BFS（corpus listTree :216-239 算法同构）；目录级 truncated → throw 特征化文案（corpus failures 语义）；BFS 目录请求上限 1000（数值裁量落定）throw 超限文案——prefix 下钻路径同样适用（子树 sha 上 BFS）。
7. **既有 MM 域 e2e/单测锚零翻转**：Task 1/2/3 各步落地后 b-mounts-manager 全量绿（git 后端为纯扩支：s3/webdav 分支逐字节不变——mountFormIssues/draftToDirectRecord/directConfigOf 既有用例零改动通过=兼容锚）；MM-01 测试名「三组」订正随 Task 4 落（断言面本就不计数，不翻红）。

---

### Task 1: core `directGit.ts`——GitHub/GitLab 直连 TreeStore 双工厂（清单/内容/错误特征化/storeId）

**Files:**
- Create: `packages/vviewer-core/src/tree/directGit.ts`
- Test: `packages/vviewer-core/test/directGit.test.ts`
- Modify: `packages/vviewer-core/src/index.ts`（:17-18 directS3/directDav 导出旁加 `export * from './tree/directGit';`）

**Interfaces:**
- 配置与 storeId（Pick 类型约束=凭据类型上进不了 hash，Review Focus 1）：
  ```ts
  export interface GithubDirectConfig {
    owner: string;
    repo: string;
    /** 任意 ref 文本（branch/tag/40 位 commit sha）。 */
    ref: string;
    /** 挂载子目录：空 = 仓根；非空归一 `xxx/`（normalizeMountPrefix 同款）。 */
    prefix?: string;
    /** PAT（Bearer）；缺省匿名（GitHub 匿名 60 req/h 限速）。 */
    token?: string;
    label: string;
  }
  export interface GitlabDirectConfig {
    /** 实例基址（缺省 `https://gitlab.com`；自建域如 `https://gitlab.example.com`；尾 '/' 容忍，无 scheme 补 https）。 */
    host: string;
    /** 数字 id 或 `group/sub/repo` 全路径（构建期 URI 编码进 /projects/{id} 定位）。 */
    project: string;
    ref: string;
    prefix?: string;
    /** PAT（PRIVATE-TOKEN 头）；缺省匿名。 */
    token?: string;
    label: string;
  }
  /** 直连 storeId（spec §3.1）：`githubdirect:<hash8>` / `gitlabdirect:<hash8>`——
   *  hash 输入=挂载目标身份，不含 token/credentialKey/label（轮换不换 id，
   *  s3DirectStoreId 同口径 directS3.ts:506-509；平台标签居首为 s3/dav 家族同款）。
   *  **gitlab host 归一在 hash 输入内完成**（评审 ② 钉死）：identity 用归一后 host
   *  （`gitlabHostNormalize`：trim → 无 scheme 补 `https://` → 剥尾 '/'）——gitlab
   *  host 是「无 scheme 补 https、尾 / 容忍」的宽容输入（与 s3 endpoint 必填 scheme
   *  不同权），归一必须单源落在 storeId 与工厂共用的模块内私有函数上，使
   *  「draftToDirectRecord 存原文 host」与「store.id 按归一后 host」恒同 id
   *  （storeId 即记录 id 机制 → AppShell 恢复链 directById 查表不 miss）。 */
  export function githubDirectStoreId(cfg: Pick<GithubDirectConfig, 'owner' | 'repo' | 'ref' | 'prefix'>): string
  // identity = ['github', owner.trim(), repo.trim(), ref.trim(), normalizeMountPrefix(prefix)].join('\u{1f}')
  export function gitlabDirectStoreId(cfg: Pick<GitlabDirectConfig, 'host' | 'project' | 'ref' | 'prefix'>): string
  // identity = ['gitlab', gitlabHostNormalize(host), project.trim(), ref.trim(), normalizeMountPrefix(prefix)].join('\u{1f}')
  ```
- 工厂（清单/切片/内容语义见下方实现要点；均返回 `DirectStore`（directS3.ts:512-518 既有接口，`watch` 立即 onError、`rangeCapable` 恒 false）；createGitlabDirectStore 的请求基址同样经 `gitlabHostNormalize(cfg.host)` 单源归一——与 storeId 同一归一，Errata ⑨）：
  ```ts
  export function createGithubDirectStore(cfg: GithubDirectConfig): DirectStore
  export function createGitlabDirectStore(cfg: GitlabDirectConfig): DirectStore
  ```
- 测试连接探测（mountsManager probeWith 消费——Task 2 前移收编；独立函数不建 store 实例——免缓存副作用；两平台均只取**首页采样**=spec §3.3 拍板：GitHub recursive=1 本就是单请求全响应、GitLab 首页 per_page=100 不翻页）：
  ```ts
  export interface GitProbeResult { files: number; sha: string; truncated?: boolean; }
  export async function probeGithubDirect(cfg: GithubDirectConfig): Promise<GitProbeResult>
  // 解析 ref→sha + recursive=1 单响应 blob 计数；**truncated:true 不做 BFS 分层**——
  // 返回 truncated:true + 首响应部分计数（Errata ⑩：大仓 BFS 上限 1000 请求对匿名
  // 60/h 是单次探测即爆的面，且 spec §3.3 拍板「首页采样」；截断注记由 UI 文案承接。
  // store 打开路径（listChildren）不受此约束——仍走全量分层，两路径行为分离）
  export async function probeGitlabDirect(cfg: GitlabDirectConfig): Promise<GitProbeResult>
  // 解析项目 id + commits/{ref} 取 commit id + tree 首页（per_page=100 不翻页）→ 首页 blob 计数
  ```
- 错误特征化注入缝（directS3.ts:74-166 模式逐条镜像；9 个 setter——setXxx(getter|null) + 缺省英文 + 访问函数；apps/web 注入 Task 2）：
  `setGithubHttpFailedText`（zh `GitHub 请求失败: HTTP {status}{detail}`）/`setGitlabHttpFailedText`（zh `GitLab 请求失败: HTTP {status}{detail}`）/`setGithubAuthHintText`（zh `（认证失败：令牌无效或无权访问该资源）`）/`setGitlabAuthHintText`（同语义）/`setGitNotFoundHintText`（共用 404 hint，zh `（仓库、ref 或路径不存在：检查 owner/repo/ref/prefix）`）/`setGithubRateLimitText`（zh `GitHub API 限速：额度已用尽（匿名 60 次/小时，配置访问令牌 PAT 后 5000 次/小时），请配置令牌后重试`）/`setGitlabRateLimitText`（zh `GitLab 请求限速：请稍后重试或配置访问令牌`）/`setGithubCorsFailureText`（zh `GitHub 直连失败：网络不可达（api.github.com 恒支持 CORS）`）/`setGitlabCorsFailureText`（zh `GitLab 直连失败：实例 CORS 未配置或网络不可达（自建实例需管理员放行本站来源与 GET 方法）`）。
- 请求通道与状态判定（复用 directS3 导出面）：`rawFetch`（directS3.ts:546-568，30s 超时 + TypeError→corsMessage 特征化）直 import；`ensureGitOk(res, platform)`：非 2xx → **限速优先**（`status===429` 或 `status===403 && res.headers.get('x-ratelimit-remaining')==='0'`）→ throw rateLimitText；401 → httpFailed(status, authHint)；404 → httpFailed(status, notFoundHint)；其余 → httpFailed(status, 采样体≤512 字符)。
- 实现要点（模块注释同步落）：
  - **GitHub 清单**：ref 解析——40 位 hex sha 直接用（零请求）；否则 `GET /repos/{o}/{r}/commits/{ref}` 取 `.sha`；实例 Map 缓存 ref→sha。根 listChildren（path===''）恒重解析（branch 跟踪）；清单缓存键 `${ref}\u001f${sha}` 命中零请求复用。manifest 获取 = prefix 下钻（§6-4 清单层落定）：prefix 非空逐段取子树 sha（`GET /git/trees/{sha}` 非递归找 entry，段缺失/非 tree → throw notFound 文案——corpus listSource :246-273 算法同构）→ `GET /git/trees/{subtreeSha}?recursive=1`；`truncated:true` → BFS 逐目录（corpus listTree :216-239：queue[{sha,dir}] 非递归展开、目录级 truncated throw、blob 收集）；BFS 请求上限 1000 throw（Review Focus 6）。清单条目归一为 repo 相对 blob 路径数组 `{path, size?}`（`type:'commit'` 跳过=submodule 非目标；size 来自 tree 条目）。
  - **GitLab 清单**：项目定位一次缓存——`GET {归一后 host}/api/v4/projects/{encodeURIComponent(project)}` 取数字 `id`（路径形态 %2F 编码、数字 id 原样）；清单 `GET /api/v4/projects/{id}/repository/tree?ref={ref}&recursive=true&per_page=100`（prefix 非空加 `&path={encodeURIComponent(prefix 去尾/）}`——§6-4 清单层落定）；翻页 Link rel=next 顺序 follow，Link 头不可读退化 `&page={n}` 顺序走页直到短页（§7-4：禁并发深分页）；条目 `type:'blob'` 收集（`type:'tree'` 供切片推导、`'commit'` 跳过）；上限 2 万条目 throw 截断文案。GitLab 清单缓存键=ref 文本（上游无树 sha；branch 移动探测不做——记档 ⑤）。
  - **切片层**（双平台共用）：挂载相对路径 = blob path 剥 prefix；`listChildren(path)` = 缓存清单按 path 切片（直接子目录=去重下一段、文件=直接命中），目录优先 + naturalCompare 排序（directS3.ts:690-692 同款）；根 listChildren 触发上述重解析，子目录恒纯内存零请求。
  - **GitHub 内容**：read = 解析 sha（缓存命中）→ raw `https://raw.githubusercontent.com/{o}/{r}/{sha}/{path 逐段 encodeURIComponent}`（Review Focus 4）→ 200 返回 bytes；401/403 → 兜底 `GET api.github.com/repos/{o}/{r}/git/blobs/{manifest blob sha}`（Bearer；blob sha 取自清单，清单未拉则现拉；Errata ①）→ base64 解码（`Uint8Array.from(atob(content), c => c.charCodeAt(0))`）；404 → notFound 文案；清单无该 path → notFound 文案（快照一致性：内容通道只服务清单代际）。
    - **GitLab 内容**：read = `GET {归一后 host}/api/v4/projects/{id}/repository/files/{encodeURIComponent(path 全路径)}/raw?ref={ref}`（**API 端点**；encodeURIComponent 含 '/'→%2F——spec §5 路径编码锚）+ PRIVATE-TOKEN 头 → 200 bytes；非 2xx ensureGitOk 特征化。
  - **GitHub 匿名限速预算注记**（模块注释）：token 缺省 60 req/h——测试连接/清单/内容全计；token 在场 5000 req/h，兜底 blobs 命中比例不放大预算（注记于 read 注释）。
  - watch=directS3.ts:732-736 同款；`get rangeCapable() { return false; }`；displayName=cfg.label。
- **验收锚**：directGit.test.ts 全绿——①storeId：token/credentialKey 不同同 id、prefix 归一幂等、平台前缀字面、**gitlab host 归一幂等**（`gitlab.example.com` / `https://gitlab.example.com` / `https://gitlab.example.com/` 三形态同 id——Errata ⑨ 恢复链一致性锚）；②ref 解析缓存：同实例两次根 listChildren 中 commits 调用恰 2 次（重解析语义）而同一次清单周期内不重复解析、40 位 sha ref 零解析请求；③清单切片：flat 清单→目录/文件切片正确、排序目录优先自然序、sub 目录切片；④GitHub truncated：recursive truncated → BFS 完整清单、目录级 truncated throw、超 1000 请求 throw（**store 打开路径**）；⑤prefix 下钻：逐段请求序列断言、段缺失 throw、下钻后路径回补；⑥GitHub read：raw 200/401→blobs 兜底（Bearer 头断言 + manifest sha 消费断言）/404 文案/429 与 403+x-ratelimit-remaining:0 限速文案/TypeError CORS 文案；⑦GitLab：项目解析一次缓存（两次 listChildren 恰 1 次 /projects 请求）/Link 两页顺序拉/page 参数退化路径/per_page=100 与 path 参数断言/2 万上限 throw/raw URL 全路径 %2F 编码断言/PRIVATE-TOKEN 头断言/401 404 限速文案；⑧**probe 采样语义**：probeGithubDirect 对 truncated 响应不 BFS（请求恰止于 recursive 单响应 + 返回 truncated:true 与部分计数——Errata ⑩）、probeGitlabDirect 恰 1 页（per_page=100 不翻页）。+ 既有 core 全量零回归；`pnpm run typecheck` 绿。所触 e2e 锚文件=`apps/web/e2e/b-git-remote-mounts.spec.ts`（Task 4 落——本 task 自身不跑 e2e）。

- [ ] **Step 1: TDD storeId + 错误缝（RED→GREEN）**

directGit.test.ts 新 describe：storeId 幂等/平台前缀/prefix 归一/**token 不同同 id**（快照恢复断言）；9 缝 setter 注入/恢复缺省。Run: `pnpm vitest run packages/vviewer-core/test/directGit`（仓库根）→ RED（模块不存在）→ 落配置/storeId/缝骨架 → GREEN。

- [ ] **Step 2: TDD GitHub 清单链（RED）**

fetch mock 沿 directS3.test.ts 先例（`vi.fn` + `vi.stubGlobal('fetch', …)` + json/xml/bytes 响应桩形态，:20-60）：ref 解析（branch→commits sha/40 位直用）、recursive 清单切片、truncated BFS、目录级 truncated throw、超限 throw、prefix 下钻段序列、根重解析（两次根 listChildren→commits 恰 2 次）。Run 同上 → Expected: RED。

- [ ] **Step 3: 实装 GitHub 清单/切片 + GREEN**

按 Interfaces 落地（下钻/BFS/缓存/切片）。Run: Step 2 命令 → GREEN。

- [ ] **Step 4: TDD GitHub 内容 + GitLab 全链（RED→GREEN）**

read 通道五态（raw/blobs 兜底/404/限速/CORS）+ GitLab（项目解析缓存/分页两路/上限/编码/PRIVATE-TOKEN/错误族）+ probe 双函数（含采样语义：github truncated 不 BFS、gitlab 单页——验收锚 ⑧）+ host 归一幂等三形态。Run: `pnpm vitest run packages/vviewer-core` → RED → 实装 → GREEN（既有全量零回归）。

- [ ] **Step 5: 导出 + 门禁 + 提交**

index.ts 导出；`pnpm vitest run packages/vviewer-core && pnpm run typecheck && pnpm lint` 全绿。

```bash
git add packages/vviewer-core && git commit -m "feat(core): directGit GitHub/GitLab 直连 TreeStore——trees recursive+truncated 分层清单（prefix 清单层下钻）/raw 内容通道（401/403 降级 API blobs 兜底）/GitLab 分页顺序拉（2 万上限）/401/403/404/429+CORS 特征化注入缝/storeId 不含凭据"
```

---

### Task 2: apps/web 直连逻辑面——前缀两判定 + git 记录/凭据库 + directConfigOf/openFlow 分派 + probeWith 类型连带（前移收编）

**前置阅读（触发词条款，开工前全文加载）：** `docs/design/frontend-conventions.md`（§3 i18n 纪律——mounts.err.* 注入缝文案键 + probe 回显键）。

**Files:**
- Modify: `apps/web/src/lib/workspaceStore.ts`（sourceKindOf :72 前缀扩列 → 'direct'）
- Modify: `apps/web/src/lib/serverHealthCache.ts`（isMountRootStoreId :76 前缀扩列 → true）
- Modify: `apps/web/src/lib/mountsSync.ts`：
  - `DirectMountRecord`（:95-111）backend 扩 `'github' | 'gitlab'` + 新字段 `owner?/repo?/ref?/host?/credentialKey?`（token 复用既有 `secret?` 字段——凭据字段名纪律：secret=「该记录的敏感凭据」既有语义，git 直译为 PAT；注释更新说明两平台映射）；
  - `GitCredentialRecord` 新接口 + `MountRecord` 联合扩列：`{ id: 'gitcred:<host>:<owner>'; kind: 'gitcred'; host: string; owner: string; token: string; note?: string; createdAt: number }`（owner `'*'`=通配条目）；
  - `resolveGitCredential(host: string, owner: string): string | undefined`（精确 owner → 通配 `*` → undefined，recordCache 镜像查询）+ `gitCredentialTokenByKey(key: string): string | undefined`（重建查库通道）；
  - `directConfigOf`（:323-346）git 两分支：github → `GithubDirectConfig`（token = `rec.secret ?? gitCredentialTokenByKey(rec.credentialKey ?? '') ?? ''`）；gitlab → `GitlabDirectConfig`（token 同上）——backend 不识别抛错既有语义保持；**返回类型注解扩为四联合** `S3DirectConfig | DavDirectConfig | GithubDirectConfig | GitlabDirectConfig`（四支判别的类型前提）；
  - 注入缝（:44-50 尾部追加 9 行 git setter 调用——`t('mounts.err.githubHttpFailed', …)` 等目录键）；
  - i18n `catalogs/{zh-CN,en}/mounts.ts`（`mounts.err.*` 9 新键 + `mounts.probe.okGit`/`mounts.probe.truncated` 2 新键——见下方 Interfaces，zh 先定稿 → en 对译占位符一致）。
- Modify: `apps/web/src/lib/mountsManager.ts`（**directConfigOf 签名扩宽的类型连带——评审 ① 落定整体前移，不留给 Task 3**：`ProbeResult`（:393）ok 支扩 `sha?: string; truncated?: boolean`；`probeWith`（:403）签名收宽为四联合 + git 支路转 core probe 函数（`'owner' in cfg` 收窄出 GithubDirectConfig、`'project' in cfg` 收窄出 GitlabDirectConfig——四联合 `in` 收窄下 `probeGithubDirect(cfg)`/`probeGitlabDirect(cfg)` 字面传参类型成立，无需 as 断言）；`probeDraft`（:415-417）/`probeRecord`（:420-422）直传面零改动（directConfigOf 四联合喂收宽后 probeWith 即类型闭合）；`formatProbeResult`（:425-429）git 分支：`r.sha !== undefined` → `t('mounts.probe.okGit', { entries, sha: r.sha.slice(0,8), ms })` + `r.truncated === true` 拼接 `t('mounts.probe.truncated')`，否则既有 ok 文案逐字节不变（s3/dav 兼容锚））
- Test: `apps/web/src/lib/mountsManager.test.ts`（probe git 分派 describe 前移：probeDraft github 草稿 → probeGithubDirect mock 断言 sha/truncated 回显；gitlab 草稿同型；s3 草稿既有探测文案零回归）
- Test: `apps/web/src/lib/mountsSync.test.ts`（凭据库用例：resolveGitCredential 精确/通配/匿名三态、gitCredentialTokenByKey 轮换即生效（改条目 → directConfigOf 产出 token 变化）、gitcred 记录混存后 displayLabelForStore/listDirectMounts 隔离、git 记录 directConfigOf 映射两例）
- Modify: `apps/web/src/lib/openFlow.svelte.ts`（createDirectMountStore :258 判别链扩四支：`'bucket' in cfg ? S3 : 'username' in cfg ? Dav : 'owner' in cfg ? Github : Gitlab`——判别键取各配置接口的独有字段名，类型收窄自然成立）
- Modify: `apps/web/src/lib/directMountFlow.test.ts`（源码契约扩展：四支分派 + directConfigOf git 分支 + credentialKey 查库调用面）

**Interfaces:**
- sourceKindOf（workspaceStore.ts:72）与 isMountRootStoreId（serverHealthCache.ts:76）各一行扩列：
  ```ts
  if (storeId.startsWith('s3direct:') || storeId.startsWith('davdirect:') ||
      storeId.startsWith('githubdirect:') || storeId.startsWith('gitlabdirect:')) return 'direct'; // / return true;
  ```
  两处注释同步补 git 前缀（spec I §3.3 插拔点①）；downloadProgress.isRemoteDownload 经单源派生自动扩列（实查 4，零改动）。
- DirectMountRecord git 形态（字段注释同步 spec §3.2/§7-2）：
  ```ts
  export interface DirectMountRecord {
    id: string;
    kind: 'direct';
    backend: 's3' | 'webdav' | 'github' | 'gitlab';
    label: string;
    endpoint: string;        // git 记录为展示面：github = `https://github.com/{owner}/{repo}`、gitlab = host 原文（dlAddressText 下载地址展示；Errata ⑦）
    bucket?: string;
    prefix: string;
    username?: string;
    secret?: string;         // git = 显式 PAT（覆盖库匹配；明文警示沿用）；留空=凭据库引用
    pathStyle?: boolean;
    owner?: string;          // github = 仓库 owner；gitlab = 凭据匹配用 namespace（项目路径剥末段；数字 id 项目为 ''）
    repo?: string;           // github = 仓库名；gitlab = 项目（路径或数字 id 文本）
    ref?: string;            // git = 任意 ref 文本（branch/tag/commit）
    host?: string;           // gitlab = 实例基址原文（github 恒空——平台域名固定；**host 归一由 core gitlabDirectStoreId/工厂统一承担，本映射面不预归一**——Errata ⑨ 恢复链 id 一致性）
    credentialKey?: string;  // token 留空场景：库条目键（'github.com:<owner>' / '<host>:<namespace>'）；显式 token 记录不写
    createdAt: number;
  }
  ```
  MountRecord = `ProxyMountRecord | DirectMountRecord | GitCredentialRecord`。
- directConfigOf git 分支（token 优先级=Review Focus 3 同步镜像纪律）：
  ```ts
  if (rec.backend === 'github') {
    return {
      owner: rec.owner ?? '', repo: rec.repo ?? '', ref: rec.ref ?? '',
      ...(rec.prefix ? { prefix: rec.prefix } : {}),
      ...(rec.secret ? { token: rec.secret } : {}),
      label: rec.label
    };
  }
  // gitlab：host 原文透传（归一由 core gitlabDirectStoreId/工厂单源承担——Errata ⑨，
  // 本面归一会使 rec.id=hash(原文) ≠ store.id=hash(归一) 断恢复链）；token 同上优先级
  //（secret ?? 按键查库 ?? 缺省匿名）
  ```
  查库失败（credentialKey 指向条目已删）→ token 缺省=匿名（不抛错——重建降级安全，401/限速文案在使用面可见）。
- **probeWith 类型连带（评审 ① 落定——directConfigOf 注解扩四联合后 mountsManager.ts:416/:421 直传面即 TS2345，本 task 内闭合不留 Task 3）**：
  ```ts
  export type ProbeResult =
    | { ok: true; entries: number; ms: number; sha?: string; truncated?: boolean }
    | { ok: false; error: string };
  async function probeWith(cfg: S3DirectConfig | DavDirectConfig | GithubDirectConfig | GitlabDirectConfig): Promise<ProbeResult> {
    const started = Date.now();
    try {
      if ('owner' in cfg) {
        const r = await probeGithubDirect(cfg);            // GitHub：file 数 + sha + truncated 注记（Errata ⑩ 采样语义）
        return { ok: true, entries: r.files, sha: r.sha, ...(r.truncated ? { truncated: true } : {}), ms: Date.now() - started };
      }
      if ('project' in cfg) {
        const r = await probeGitlabDirect(cfg);            // GitLab：首页采样计数（spec §3.3）
        return { ok: true, entries: r.files, sha: r.sha, ms: Date.now() - started };
      }
      const store = 'bucket' in cfg ? createS3DirectStore(cfg) : createDavDirectStore(cfg);
      const entries = await store.listChildren('');
      return { ok: true, entries: entries.length, ms: Date.now() - started };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
  ```
  i18n（zh 定稿 → en 对译；`{entries}/{sha}/{ms}` 占位符两侧一致）：
  - `mounts.probe.okGit`：zh `连接成功：{entries} 个文件，ref {sha}，延迟 {ms} ms`；en `Connected: {entries} files, ref {sha}, {ms} ms`
  - `mounts.probe.truncated`：zh `（清单已截断，以上为部分计数）`；en `(listing truncated; partial count above)`
- openFlow 分派（:258）：
  ```ts
  const cfg = directConfigOf(rec);
  const store = 'bucket' in cfg
    ? createS3DirectStore(cfg)
    : 'username' in cfg
      ? createDavDirectStore(cfg)
      : 'owner' in cfg
        ? createGithubDirectStore(cfg)
        : createGitlabDirectStore(cfg);
  ```
  import 增 createGithubDirectStore/createGitlabDirectStore（:16-27 既有 core import 块——实查订正）。
- **验收锚**：mountsSync.test.ts 新用例全绿 + 既有全绿（s3/webdav 分支逐字节兼容锚）+ mountsManager.test.ts probe git describe 绿 + 既有探测用例零回归（ok 文案逐字节——formatProbeResult 非 git 分支兼容锚）+ directMountFlow.test.ts 契约扩展绿 + workspaceStore/serverHealthCache 既有测试零回归（`pnpm vitest run apps/web/src/lib packages/vviewer-core`）+ **typecheck 绿（评审 ① 的闭合判据：probeWith 收宽与 directConfigOf 四联合同 commit 闭合，无 improvisation 空窗）** + lint 绿。所触 e2e 锚文件=`apps/web/e2e/b-mounts-manager.spec.ts`（MM-03/06/07 既有探测与 direct 全链回归——Task 4 定向实跑）、`apps/web/e2e/b-git-remote-mounts.spec.ts`（本 task 落地后运行时分派面与探测面就位，Task 4 落锚）。

- [ ] **Step 1: TDD mountsSync 凭据库与 git 记录映射（RED）**

mountsSync.test.ts 新 describe（fake-indexeddb 先例 :8-45）：凭据三态匹配/按键查库/轮换即生效（saveMount 覆写 gitcred 条目 → directConfigOf 产出变化）/git 记录映射两例（github token 显式/gitlab credentialKey 命中——host 原文透传断言：含尾斜杠/无 scheme 原文进 config 原样，Errata ⑨）/gitcred 混存隔离（displayLabelForStore 未命中回落、listDirectMounts 不含凭据条目）。Run: `pnpm vitest run apps/web/src/lib/mountsSync` → Expected: RED。

- [ ] **Step 2: 实装 mountsSync（记录/凭据/directConfigOf 四联合/注入缝/i18n 11 键）**

按 Interfaces 落地（directConfigOf 返回注解四联合同步扩——github/gitlab 分支返回值与注解同 commit 闭合）；i18n `mounts.err.*` 9 键 + `mounts.probe.okGit`/`truncated` 2 键，zh 先定稿（Task 1 Interfaces / 本 task Interfaces 文案）→ en 对译。

- [ ] **Step 3: probeWith 类型连带前移实装（评审 ①——RED→GREEN）**

mountsManager.test.ts 先落 probe git describe（github 草稿 stub probeGithubDirect 域内 fetch → sha/truncated 回显；s3 既有文案零回归锚）→ RED → 按 Interfaces 落 probeWith 收宽/git 分派/formatProbeResult git 分支/ProbeResult 扩展。Run: `pnpm vitest run apps/web/src/lib/mountsManager apps/web/src/lib/mountsSync` → GREEN（**此刻起 Task 2 全部类型改动自洽，typecheck 无中途红窗**）。

- [ ] **Step 4: 前缀两判定 + openFlow 分派 + 契约测试扩展**

workspaceStore/serverHealthCache 各一行扩列（注释同步）；openFlow 四支判别；directMountFlow.test.ts 契约（四支字符串断言 + `gitCredentialTokenByKey` 在 directConfigOf 内的调用面断言 + 恢复链 :1081 createDirectMountStore 未改断言——机制零改动锚）。Run: `pnpm vitest run apps/web/src/lib packages/vviewer-core && pnpm run typecheck && pnpm lint` → 全绿。

- [ ] **Step 5: 提交**

```bash
git add apps/web/src/lib/workspaceStore.ts apps/web/src/lib/serverHealthCache.ts apps/web/src/lib/mountsSync.ts apps/web/src/lib/mountsSync.test.ts apps/web/src/lib/mountsManager.ts apps/web/src/lib/mountsManager.test.ts apps/web/src/lib/openFlow.svelte.ts apps/web/src/lib/directMountFlow.test.ts apps/web/src/lib/i18n && git commit -m "feat(web): git 直连挂载逻辑面——githubdirect/gitlabdirect 前缀两判定+DirectMountRecord 扩支与 GitCredentialRecord 凭据库（credentialKey 引用轮换即生效）+directConfigOf 四联合映射+createDirectMountStore 四支分派+probeWith git 采样分派（探测 sha/truncated 回显）+错误文案注入缝"
```

---

### Task 3: 目录管理页——git 两类表单 + 组④「Git 凭据」区块（重提覆盖=编辑）+ 装配过滤 + i18n

**前置阅读（触发词条款，开工前全文加载）：** `docs/design/frontend-conventions.md`（§3 i18n 纪律 + §4 a11y 基线 + §6 评审必查清单）、`docs/design/semantic-components.md`（组④为 MountsManager 既有全屏 overlay 内新增 section——非新浮层/菜单/确认通道核对）、`docs/design/ui-design-system.md`（组④/表单扩支沿用既有 `vv-mm-*` 类与面板 z-index=30 层，零新 token）。

**Files:**
- Modify: `apps/web/src/lib/mountsManager.ts`：
  - `MountFormDraft`（:53-68）backend 扩四类 + 新字段 `owner/repo/ref`（gitlab host 复用 endpoint 字段、git token 复用 secret 字段——注释说明）；
  - `mountFormIssues`（:108-123）per-backend 分派：github 必填 label/owner/repo/ref；gitlab 必填 label/endpoint(host)/repo(项目)/ref + endpoint userinfo 拒绝照走；s3/webdav 分支逐字节不变（兼容锚）；proxy 模式 + git backend → mode issue（git 无代理面）；
  - `draftToDirectRecord`（:133-158）git 两分支：id = core storeId（**host 原文参与 storeId——归一在 core gitlabDirectStoreId hash 输入内单源完成，Errata ⑨**；同 s3/dav 先例 draftToDirectRecord :136 仅 endpoint 展示值归一，git host/repo 字段不预归一）、endpoint 展示面（github `https://github.com/{owner}/{repo}`）、token 填写 → 存 secret 不建库条目；token 留空 → `resolveGitCredential(host, owner)` 命中存 credentialKey（github host='github.com'；gitlab namespace=项目路径剥末段、数字 id 项目 owner=''→仅通配可命中）、未命中 = 匿名（两字段都缺省）；createdAt 沿用既有；
  - `draftFromRecord`（:188-214）git 回环预填；
  - `probeWith`（:403）git 分支/`ProbeResult` 扩展/`formatProbeResult`（:425-429）git 分支——**Task 2 已前移收编（评审 ①），本 task 零改动**（git 表单探测经 probeDraft 直传面自然生效）；
  - `assembleMountRows`（:318-343）：**gitcred 过滤**（`records.filter(r => r.kind !== 'gitcred')`——Review Focus 2）+ `backendLabel` 扩 `'GitHub' | 'GitLab'`（类型 `'S3' | 'WebDAV' | 'GitHub' | 'GitLab'`）+ `hasCredential` git 形态（secret 或 credentialKey 在场）；
  - `assembleGitCredentialRows(records)` 新装配：`{ key; host; owner; wildcard: boolean; note?: string }[]`（createdAt 升序）。
- Modify: `apps/web/src/lib/MountsManager.svelte`：
  - backend select（:546-549）加 `github`/`gitlab` option；git backend 时 mode select（:536）disabled + 强制 'direct'；
  - 条件字段组：github → `#vv-mm-owner`/`#vv-mm-repo` 输入；gitlab → endpoint 字段复用（placeholder 改 `https://gitlab.example.com`）+ `#vv-mm-repo`（label「项目（group/repo 或数字 ID）」）；公共 `#vv-mm-ref`（label「ref（分支/tag/commit）」）+ hint（匿名限速 + branch 重解析语义，§7-3）；token 复用 `#vv-mm-secret`（git 时 label「访问令牌（PAT，可空）」）；s3 专属 bucket/pathStyle 块（:561-572）条件不变；
  - 组④「Git 凭据」section（:649 组③ section 之后、:650 body 闭合前）：heading + credentialWarning() 渲染 + 凭据行列表（`host:owner` 主文本 + 通配徽标 + note + 删除钮）+ 新增表单（host 文本输入预置 github.com/owner/token/note）——**编辑面=重提同键覆盖**（评审 ③：`GitCredentialRecord.id='gitcred:<host>:<owner>'` + saveMount `put(rec, rec.id)` 键覆盖语义 mountsSync.ts:226-227 即「同 host+owner 再保存一次」= 更新 token/note，**不设独立编辑钮**；轮换流程=表单改 token 重提同 host/owner）；装配/保存/删除走 assembleGitCredentialRows + saveMount/deleteMount（recordCache 镜像即时生效——mountsManagerUi 契约同步锁「重提覆盖」语义）；
  - 组②行 `data-kind` 徽标（:488）随 backendLabel 自动扩显。
- Modify: `apps/web/src/lib/i18n/catalogs/{zh-CN,en}/mounts.ts`（新键清单，zh 定稿 → en 对译，占位符一致）：
  - 表单族：`mounts.form.owner`（zh `仓库所有者（owner）`）/`mounts.form.repo`（zh `仓库（repo）`）/`mounts.form.repoProject`（zh `项目（group/repo 或数字 ID）`）/`mounts.form.ref`（zh `ref（分支/tag/commit）`）/`mounts.form.gitToken`（zh `访问令牌（PAT，可空）`）/`mounts.form.gitTokenHint`（zh `留空按 owner 匹配凭据库（精确 → 通配 → 匿名）；显式填入则随本挂载存储。匿名使用 GitHub 时限速 60 次/小时，测试连接也消耗额度。`）/`mounts.form.refHint`（zh `branch 型 ref 在每次打开/恢复会话时重新解析指向最新 commit，属预期行为。`）/`mounts.form.gitProxyBlock`（zh `GitHub/GitLab 挂载仅支持浏览器直连`）；
  - 凭据区块族：`mounts.cred.group`（zh `Git 凭据`）/`mounts.cred.add`（zh `＋ 添加凭据`）/`mounts.cred.empty`（zh `暂无 Git 凭据。`）/`mounts.cred.host`（zh `主机（如 github.com）`）/`mounts.cred.owner`（zh `owner/namespace（* 通配全部）`）/`mounts.cred.token`（zh `访问令牌（PAT）`）/`mounts.cred.note`（zh `备注（可空）`）/`mounts.cred.wildcard`（zh `通配`）/`mounts.cred.save`（zh `保存凭据`）——必填提示复用既有 `mounts.form.required`，不另立键；同键重提=更新（hint 并入 owner 键文案不另立）；
  - 探测族 2 键（`mounts.probe.okGit`/`mounts.probe.truncated`）与错误族 9 键均 **Task 2 已落，此处无新增**。
  键序：域目录尾部按模块分段追加（zh/en 同序——聚合机检 + mountsManagerUi.test.ts zh 值双锁）。
- Test: `apps/web/src/lib/mountsManager.test.ts`（git 表单校验/draftToDirectRecord git id+credentialKey 解析+token 优先级/draftFromRecord 回环/assembleMountRows gitcred 过滤与徽标/assembleGitCredentialRows 含通配/重提覆盖）+ `apps/web/src/lib/mountsManagerUi.test.ts`（骨架契约：组④ section 在册 + backend select 四 option + git 条件字段 id 契约 + 重提覆盖语义 + zh 目录值双锁）

**Interfaces:** 见上方 Files 内联（mountsManager.ts 纯逻辑全部 vitest 直测；组件改动镜像既有 runes 形态——draft `$state`、rows `$derived`）。

- **验收锚**：mountsManager.test.ts 新用例全绿 + 既有全绿（s3/webdav 表单/记录/装配用例零改动通过=兼容锚；Task 2 前移的 probe describe 回归绿）+ mountsManagerUi.test.ts 契约扩展绿 + mountsSync.test.ts/mountsSync 回归绿 + 聚合机检绿（en==zh 键集）+ typecheck+lint 绿。所触 e2e 锚文件=`apps/web/e2e/b-mounts-manager.spec.ts`（MM-01~07 既有面零翻转——MM-01 三组标题断言仍成立，四组为纯增量；名称订正归 Task 4）、`apps/web/e2e/b-git-remote-mounts.spec.ts`（表单/凭据区块运行时面就位，Task 4 落锚）。

- [ ] **Step 1: TDD mountsManager 纯逻辑（RED）**

mountsManager.test.ts 新 describe：git 必填矩阵（github 三必填+ref/gitlab 四必填/proxy+git 阻断）、draftToDirectRecord git（id=githubDirectStoreId 字面闭环/credentialKey 精确命中存储/通配命中/匿名双缺省/显式 token 不写 key/host 原文不预归一——Errata ⑨ 断言）、draftFromRecord 回环、assembleMountRows（gitcred 过滤/GitHub·GitLab 徽标/hasCredential 两形态）、assembleGitCredentialRows（通配徽标/升序/同键覆盖=更新）。Run: `pnpm vitest run apps/web/src/lib/mountsManager` → RED（装置分两类：纯函数/装配面沿本文件既有 stubFetch 形态 mountsManager.test.ts:34-44；credentialKey 解析面需 recordCache 建库——fake-indexeddb `IDBFactory` 交换 + `saveMount(gitcred)` 漏斗沿 mountsSync.test.ts:8 先例，用例尾部 `resetMountRecordCacheForTests()` 隔离）。

- [ ] **Step 2: 实装 mountsManager.ts + GREEN**

按 Files 落地（gitcred 过滤=Review Focus 2 硬断言面）。Run: Step 1 命令 → GREEN。

- [ ] **Step 3: MountsManager.svelte 表单扩支 + 组④区块（重提覆盖=编辑）+ i18n 双目录**

组件按 Files 落地（runes 写法；表单字段 aria-label 走 t() 键——frontend-conventions §3）；i18n 新键 zh 先定稿 → en 对译（仅表单/凭据两族 17 键——probe/err 族 Task 2 已落）。mountsManagerUi.test.ts 契约扩展。Run: `pnpm vitest run apps/web/src/lib && pnpm run typecheck && pnpm lint` → 全绿（聚合机检含新键）。

- [ ] **Step 4: 提交**

```bash
git add apps/web/src/lib/mountsManager.ts apps/web/src/lib/mountsManager.test.ts apps/web/src/lib/MountsManager.svelte apps/web/src/lib/mountsManagerUi.test.ts apps/web/src/lib/i18n && git commit -m "feat(web): 目录管理页 git 直连面——github/gitlab 两类表单（ref 纯文本+token 可空凭据库匹配）+组④ Git 凭据区块（host+owner 条目化/通配/重提同键覆盖=编辑）+gitcred 装配过滤"
```

---

### Task 4: e2e 锚批 b-git-remote-mounts（git 全链/凭据库/错误特征化/恢复链 + MM-01 四组订正）

**Files:**
- Create: `apps/web/e2e/b-git-remote-mounts.spec.ts`（GIT- 域）
- Modify: `apps/web/e2e/b-mounts-manager.spec.ts`（MM-01 测试名/注释「三组」→「四组」+ 组④标题可见断言追加——head 注释块同步补 GIT 域指针）

**验收锚 / e2e**：本任务即 e2e 锚批——`pnpm --filter web build:e2e` 后本域全绿 + 定向回归（b-mounts-manager / b-mounts-deep）零翻转。装置复用见 Global Constraints「e2e 装置既有先例」；git mock = page.route 拦截（Errata ⑥）。

- [ ] **Step 1: mock 装置——mockGithub/mockGitlab（route 拦截 + authLog）**

`mockGithub(page, opts)`：`**api.github.com/**`（OPTIONS 预检 CORS_HEADERS；`/repos/{o}/{r}/commits/{ref}` → `{sha}`；`/repos/{o}/{r}/git/trees/{sha}?recursive=1` → `{tree, truncated}`（含 truncated 分层变体）；`/repos/{o}/{r}/git/blobs/{sha}` → `{content: base64}`；authorization 头采集 authLog）+ `**raw.githubusercontent.com/**`（path 分发 bytes）。`mockGitlab(page, host, opts)`：`/api/v4/projects/{enc}` → `{id}`；`/repository/commits/{ref}` → `{id}`；`/repository/tree` → 首页数组 + Link 头 rel=next（翻页/退化两变体）；`/repository/files/{enc}/raw` → bytes（PRIVATE-TOKEN 采集）。全部未命中兜底 404（mockS3 台账 3-3 纪律）。表单 fill 装置 `fillGithubForm/fillGitlabForm`（#vv-mm-owner/repo/ref/secret 镜像 fillS3Form :228-240 形态——行号实查订正，评审 ⑤）。

- [ ] **Step 2: GIT-01——GitHub 全链（挂载→测试连接→保存→打开→浏览→读文件）**

mockGithub 两文件一目录 → 面板新增挂载（backend=github，owner/repo/ref/prefix 空，token 空）→ 测试连接 → 回显「N 个文件，ref {sha8}」+ **无 authorization 头**（匿名）→ 保存（行徽标 GitHub）→ 打开 → seeTreeRow 目录/文件行 → 点开文件 → 内容渲染断言（文本入 tab）→ raw 域请求 URL 断言含解析 sha（route 内采集 URL——Review Focus 4）。

- [ ] **Step 3: GIT-02——凭据库命中与轮换即生效（spec §7-2 运行时面）**

先在组④添加凭据（github.com/alice token=T1）→ mount 表单 token 留空 + owner=alice → 测试连接 → api 请求带 `authorization: Bearer T1` → 保存；**轮换=重提同键覆盖**（评审 ③：组④新增表单以同 host=github.com/owner=alice 重提 token=T2——`put(rec, rec.id)` 键覆盖即更新，无独立编辑钮，Task 3 组④语义）→ 行内「打开」重开挂载 → 请求带 T2（credentialKey 查库+releaseDirectMountStore 重建链——实查 5）。

- [ ] **Step 4: GIT-03——429/401 特征化文案（spec §5）**

mockGithub commits 端点返回 `403 + x-ratelimit-remaining: 0`（匿名限速）→ 测试连接回显限速文案（`mounts.probe.fail` 包裹 mounts.err.githubRateLimit 串）；变体 commits 401 → 认证文案。断言走表单回显区 `.vv-mm-probe`（role=status）toContainText。

- [ ] **Step 5: GIT-04——GitLab 全链 + 自建域 CORS 失败（spec §5）**

mockGitlab（分页两页 Link）→ gitlab 表单（host=https://gitlab.test、项目=group/repo、ref、token=T）→ 测试连接回显 → 保存打开读文件 → PRIVATE-TOKEN 头断言 + tree 请求顺序两页断言（authLog 时序）。CORS 面：`**gitlab-cors-fail.test/**` route.abort() → 测试连接回显 TypeError 特征化文案（mounts.err.gitlabCors）。

- [ ] **Step 6: GIT-05——快照恢复链（storeId 即记录 id 机制 + 凭据查库）**

seedMountRecord（githubdirect 记录 id=hash8 镜像计算 + gitcred 条目）+ seedSnapshot（workspace direct 来源 + 目录/文件 tab）→ reload → 目录/文件 tab 重建（MM-08 :564 形态）→ 文件内容可读且请求带凭据库 token（恢复链查库——Review Focus 3 时序锚）。变体：记录删除态 → 落占位（既有降级链断言沿用 MM-08 形态，git 记录一例）。

- [ ] **Step 7: MM-01 四组订正 + 定向回归 + 提交**

b-mounts-manager.spec.ts MM-01：测试名「三组渲染」→「四组渲染」、组④标题断言追加、head 注释补一行 GIT 域指针。Run: `pnpm --filter web build:e2e && pnpm --filter web exec playwright test b-git-remote-mounts b-mounts-manager b-mounts-deep` → 全绿（MM-02~10 既有断言零翻转——git 后端纯增量）。

```bash
git add apps/web/e2e && git commit -m "test(e2e): git 直连挂载 GIT 域锚——GitHub/GitLab 全链/凭据库轮换即生效/限速与认证特征化/自建域 CORS/快照恢复查库（MM-01 三组→四组订正）"
```

---

### Task 5: 全量门禁与收尾（控制器执行）

- [ ] `pnpm lint && pnpm run typecheck && pnpm vitest run`（仓库根全量）→ `pnpm --filter web build:e2e` → playwright 全量双 project（`pnpm --filter web exec playwright test`；对比基线：新增 b-git-remote-mounts GIT 域外零回归——重点观察挂载/来源/树面与设置面既有锚）→ `pnpm --filter web exec playwright test --config playwright.server.config.ts`（server 档零翻转——本计划零 server/ 改动的一致性兑现）→ `git status --porcelain` 净空。
- [ ] **真网冒烟（手动清单，spec §5；不阻塞自动门禁，执行结果记档）**：真挂 `bhxch/vviewer` 仓 lite 子路径实测——匿名（60/h 内完成：测试连接 1 + 清单 1 + 文件读 2）验证 trees/raw 直连 CORS、清单切片、文件打开、搜索浏览器内补扫提示、下载进度卡地址展示（github endpoint 展示面）。限速/网络不可达即如实记档为环境受限，不降级为假通过。
- [ ] 全量 review（superpowers:requesting-code-review，范围=本计划全部 commit），修复全部 C/I/M 后复审；**不 push**。
- [ ] 台账汇总（实施期记档项随任务报告归集；本计划规划期记档六条见 Errata——①blobs 兜底 ②锚点勘误 ③recordCache 同步镜像冷启动降级 ④两平台快照一致性差异 ⑤GitLab 分页无 UI 进度通道+会话内 branch 移动不可廉价探测 ⑥e2e mock=route 拦截实化形态）。

## Errata（执行期勘误）

- 2026-11-14 计划评审修订（6 条意见：1 阻断 + 1 高 + 3 低 + 1 信息项；规划师 I 逐条实查复现后同文件落定，代码基线 475364f 不变；评审员核查范围=计划评审，门禁本体未运行——vitest/typecheck/playwright/build:e2e 均未跑，其核查锚清单与本计划规划期实查互证一致）：①【阻断】directConfigOf 返回类型扩四联合与 mountsManager probeWith 消费面的类型连带被排进两个 task——实查 mountsManager.ts:403 `probeWith(cfg: S3DirectConfig | DavDirectConfig)` + :416/:421 probeDraft/probeRecord 直传 `directConfigOf(...)`（签名扩宽即 TS2345；只加分支不改 :323 注解则 mountsSync.ts 内部先 TS2322），原切分下 Task 2 Step 3 typecheck 必红——落定 **probeWith 面整体从 Task 3 前移收编进 Task 2**（probeWith 签名收宽四联合 + git 支路转 core probe 函数 + ProbeResult 扩 sha/truncated + formatProbeResult git 分支 + i18n probe 两键 + mountsManager.test.ts probe describe；Task 3 该面零改动），Task 2 Steps 重排为 5 步（probeWith 前移=Step 3 独立 RED→GREEN，typecheck 无中途红窗）。②【高】gitlab host 归一位置歧义可断恢复链——若归一仅落 directConfigOf/工厂而 draftToDirectRecord 用原文 host 算 id，则 rec.id=hash(原文) ≠ store.id=hash(归一) → AppShell 恢复链 directById（:1077-1081 实查）查表必 miss、gitlab 记录恢复全落占位——落定 **归一单源钉死在 core gitlabDirectStoreId 的 hash 输入内**（gitlabHostNormalize：trim→无 scheme 补 https→剥尾 /，storeId 与工厂同函数消费；gitlab host 属「无 scheme 补 https、尾 / 容忍」宽容输入，与 s3 endpoint 必填 scheme 不同权，directS3.ts:506-509 仅 trim 的先例不可直接套），Task 1 验收锚 ① 补三形态同 id 断言、Task 2 directConfigOf/host 字段注释改「原文透传、归一由 core 统一承担」、mountsSync.test.ts 补 host 原文透传断言（Errata ⑨ 新立）。③【低】GIT-02「组④编辑凭据条目」与 Task 3 组④无编辑钮矛盾——落定 **编辑面=重提同键覆盖**（GitCredentialRecord.id=`gitcred:<host>:<owner>` + saveMount `put(rec, rec.id)` 键覆盖语义 mountsSync.ts:226-227 实查）：Task 3 组④区块与 mountsManagerUi 契约显式锁「重提覆盖=更新，不设独立编辑钮」，Task 4 GIT-02 措辞同步改「重提同键覆盖」。④【低】probeGithubDirect 原落定 truncated 走 BFS 分层与 spec §3.3「树清单首页采样」的偏离未记档、匿名限速后果未声明——落定 **probe 对 truncated:true 不 BFS**（返回首响应部分计数 + truncated:true 标记，UI 经 mounts.probe.truncated 注记；store 打开路径 listChildren 仍全量分层——两路径行为分离），GitProbeResult 扩 truncated?: boolean、Task 1 验收锚 ⑧ 补采样语义用例（Errata ⑩ 新立）。⑤【低·行号锚】计划内部两处漂移订正：Task 4 Step 1 fillS3Form :259-268→:228-240（与 Global Constraints/Errata 同文件口径一致）；openFlow core import 块 :11-21→:16-27（实查 `sed -n '10,30p' apps/web/src/lib/openFlow.svelte.ts`：type import :16 + value import :17-27）。⑥【信息项·核实为真无需改】Errata ①（contents→git/blobs 兜底）机制论证经评审员独立实查成立（contents API >1MB 返回 content:''+encoding:'none' 属官方契约；blob sha 在 tree 清单在手——fetch-e2e-corpus.mjs:229 toBlob 含 e.sha 实查），行为面逐条保持，维持原文。评审后仍零 deferred：新增落定 ⑨⑩ 已全部内联。
- ⑨**gitlab host 归一单源=core storeId/工厂 hash 输入内**（评审 ② 落定）：`gitlabHostNormalize`（trim → 无 scheme 补 `https://` → 剥尾 `/`）为 directGit.ts 模块内私有单源，gitlabDirectStoreId 与 createGitlabDirectStore 同函数消费——draftToDirectRecord 存原文 host、directConfigOf 原文透传、store.id 按归一后 host 计算，三形态输入恒同 id（`gitlab.example.com` === `https://gitlab.example.com` === `https://gitlab.example.com/`）——「storeId 即记录 id」恢复链查表不 miss（AppShell.svelte:1077-1081）；Task 1 单测三形态同 id + Task 2 host 原文透传断言双锚。
- ⑩**probe 采样语义与 store 清单行为分离**（评审 ④ 落定，spec §3.3「树清单首页采样」的 GitHub 落地面）：probeGithubDirect 对 recursive 响应 `truncated:true` **不做 BFS 分层**——返回首响应 blob 计数 + truncated:true（大仓 BFS 上限 1000 请求对匿名 60 req/h 是单次探测即爆的面，且 recursive 单响应本就是 GitHub 侧唯一的「首页」形态）；截断事实经 `mounts.probe.truncated` 文案注记（Task 2 formatProbeResult git 分支）。**store 打开路径不受此约束**——listChildren 仍走 truncated 全量分层（Review Focus 6 语义不变）：探测面轻（保限速预算）、挂载面全（保清单完整性），两路径分离为有意设计而非不一致。
- 2026-11-14 初版（规划师 I 基于 HEAD 475364f 编写；规划期关键实查已内联：TreeStore 接口 types.ts:39-65 / DirectStore+watch 契约 directS3.ts:511-518、s3DirectStoreId :506-509、rawFetch :546-568、注入缝模式 ：74-166、createDavDirectStore 判别源 directDav.ts:141 / 前缀判定全仓两处 workspaceStore.ts:72+serverHealthCache.ts:76（downloadProgress.ts:84 单源派生）/ DirectMountRecord mountsSync.ts:95-111、directConfigOf :323-346、注入缝挂载点 ：44-50（7 setter）、recordCache 镜像 ：203、displayLabelForStore :284-296 / createDirectMountStore openFlow.svelte.ts:256-269、openDirectMount :277-280、releaseDirectMountStore :290-297、core import 块 ：16-27（评审 ⑤ 实查订正） / 恢复链 AppShell.svelte:1071-1095（restore :979、directById :986-988）/ 凭据轮换释放流 MountsManager.svelte:285/:289 / 表单骨架 MountsManager.svelte:530-621（backend select :546-549、条件字段 ：561-589）、组②加载 listMounts :195、assembleMountRows 消费 ：191 / mountsManager.ts MountFormDraft :53-68、mountFormIssues :108-123、draftToDirectRecord :133-158、draftFromRecord :188-214、assembleMountRows :318-343、probeWith :403-412、credentialWarning :39-41 / i18n mounts 域结构与 satisfies 契约 catalogs/zh-CN/mounts.ts:9/:189 / 聚合机检 catalogs.aggregate.test.ts / sourceKindOf 判别先例 workspaceStore.ts:68-75 / GREP 上限 core/compute/search.ts:56-60 / globalSearch isMountRootSource :63-66 / DB_VERSION=5 session.ts:71 / hash8 导出 singleFile.ts:57 / corpus 算法 fetch-e2e-corpus.mjs listTree :216-239、listSource :246-273、fetchRaw :174-197（HTML 错误页嗅探为脚本面特例，store 不复用）/ e2e 装置 b-mounts-manager.spec.ts mockS3 :171-202、mockDav :203-227、fillS3Form :228-240、seedMountRecord :98-119、seedSnapshot :122-135、hash8 镜像 :54-61、openMountsPanel :154、seeTreeRow :146、MM-08 恢复 :564 / directMountFlow.test.ts 源码契约形态 :1-45 / core tree 导出 index.ts:13-18）。
- ①**GitHub API 兜底端点落定 `git/blobs` 而非 spec 字面的 `repository/contents`**（§7-1 机制必要订正）：contents API 对 1-100MB 文件默认 media type 下返回 `content:''` + `encoding:'none'`（官方契约），兜底通道在 >1MB 文件上不成立；git/blobs API 无该编码缺陷且 blob sha 在清单在手（零额外寻址）。同为 api.github.com + Bearer 标准契约——§7-1 的行为面（raw 401/403 自动降级 API 面、限速预算注记）逐条保持，仅兜底端点机制替换；单测/e2e 锚按 blobs 断言。
- ②**spec §2 行号/计数勘误**：AppShell 恢复链 :944-968 → 实查 :1071-1095（:944-950 现为 zen 恢复段）；注入缝「8 个 setter」实为 7（mountsSync.ts:44-50 七行）；directS3.ts/directDav.ts 位于 `packages/vviewer-core/src/tree/`（spec 引用省略目录段）。
- ③**凭据解析冷启动窗口（recordCache 同步镜像纪律）**：`createDirectMountStore` 同步签名维持，凭据查库走 mountsSync recordCache 镜像（list/save/delete 漏斗维护）——AppShell 恢复 :986 listDirectMounts 先于 :1081 重建（恒命中）、MountsManager 装载 :195 先于一切表单动作（恒命中）；唯一暴露面=启动后 restore 未完成的极快点击窗口，退化为匿名（401/限速文案在使用面可见、重开自愈）——与 displayLabelForStore 未命中回落同款降级纪律，知情接受。
- ④**两平台内容快照一致性差异**：GitHub raw 用解析后 sha（清单代际一致；branch 移动后刷新动作重解析）；GitLab raw 恒 ref 文本（上游按 ref 实时解析，无树 sha 可锚）——同 ref 语义下 GitLab 会话内 branch 移动不可廉价探测（无独立树 sha 端点），重开挂载/刷新页面可见——GitHub 根 listChildren 重解析自然可见。快照注记语义（spec §3.3）落表单 refHint 文案 + 模块注释，不新增 UI 面。
- ⑤**GitLab 分页无 UI 进度通道**：store 层无进度回调面——顺序拉在 listChildren await 内（树加载态已有）；上限 2 万 throw 截断文案经 FileTree SUSP-07 状态栏提示通道呈现（根级加载失败非静默，FileTree.svelte:42-49）；spec §7-4「进度提示」以该通道兑现。
- ⑥**e2e mock 实化形态=page.route 拦截**：spec §5「fake 伺服 mock API 面（fake-file-server.ts 惯例）」落定为 b-mounts-manager mockS3/mockDav 的 route 拦截惯例扩支——GitHub api.github.com/raw.githubusercontent.com 域名固定无法指 fake host（node:http fixture 不可达），GitLab 自建域统一同机制；route 先于网络零出网、不烧限速；未命中兜底 404（台账 3-3 防静默假绿）。
- ⑦**github 记录 endpoint 为展示面**：`https://github.com/{owner}/{repo}`（dlAddressText 下载进度卡地址段语义合理化——真实内容面为 raw.githubusercontent/{sha}/；不参与 storeId hash）；gitlab 记录 endpoint=host 原值。
- ⑧**规划期无 deferred 项**：spec §6 五项裁量（双实现 vs 抽象/清单缓存刷新/凭据区块落位/prefix 过滤层/Range 开启）与 §7 四条落定（含 GitLab 2 万、GitHub BFS 1000 两个数值裁量）全部内联落定于上文 Interfaces/Global Constraints/Errata，无遗留待决事项。
