# git 信息面板（纯前端 isomorphic-git）设计

- 日期：2026-10-31
- 状态：已批准（brainstorming 六需求批量立项之一）
- 上游：无（全仓零 git 代码，全新能力面）

## 1. 背景与动机

vviewer 定位只读查看器，但常见打开对象是代码仓库工作副本；查看时缺「这文件最后谁改的/现在有没有未提交改动/这段代码什么时候写的」一类信息。用户拍板全量四信息面：**文件末次提交+状态（基础）、行级 blame、diff 视图、文件历史 log**；UI 升级为右面板与「目录/属性」并列的第三段。

**机制裁决（brainstorm 关键转折）**：最初定服务端 git2（libgit2 vendored），用户提出纯前端方案——评估后采纳，理由有三：

1. **`.git` 读取畅通（实测核实）**：服务端 hidden 过滤语义是「只滤列表、不滤寻址/读取」（`server/storage/src/lib.rs:417-418`：「`--hidden`：列出时过滤 dot 开头条目（**寻址/读取不过滤**）」），`.git/HEAD`、`.git/objects/**`、`.git/index` 经既有文件 API 全部可读；`.git` 出现在文件树/搜索的排除（SearchSection PRESETS）是展示层过滤，不影响寻址。
2. **覆盖面反而扩大**：git2 方案仅服务端本地 fs 根可用；纯前端对 **FS Access 本地根（浏览器直读）、服务端本地根、S3/DAV 直连挂载、代理 remote** 全部生效——凡 store 能读出 `.git` 字节的来源都可用；Pages/worker/桌面全形态一致，服务端零改动。
3. **不引入 Rust 重依赖**（libgit2 编译链与跨平台负担）。

## 2. 机制

### 2.1 isomorphic-git + fs 适配层

- 选型 **isomorphic-git**（MIT，纯 JS，浏览器一等公民）：commit/tree/blob 读取、`log`（支持 `filepath` 过滤）、`readBlob`、packfile 解析齐备。随带依赖（pako 等）全部进动态 chunk。
- 新增 **git worker**（`apps/web/src/lib/git-worker.ts`，仿 `ts-worker.ts` 三行 side-effect 模式，实现在 highlight 包或 web 内 builder 定）：全部 git 计算在 worker 内，主线程零阻塞；消息协议 `{ kind, requestId, … }`，请求层可取消（AbortController + 仓库 abort 身份惯例 `isAbortError` 单源）。**降级注记（builder check 收敛）**：`TreeStore.listChildren` 无 signal 参数（`packages/vviewer-core/src/types.ts:42-51`），目录列举不可中断——取消止于 git worker 请求层，不给公共契约补 signal（知情接受，列举量级有界）。
- **fs 适配层 `GitFsAdapter`**：把 isogit 的 fs 接口适配到 vviewer 各 store 的文件 API（listChildren/readFile）。要点：
  - 寻址基准 = 仓库根在 store 内的相对路径前缀（`.git` 探测向上逐级定位，见 §2.2），isogit 的 `dir` 参数经适配层映射到「store 根 + repoDir 前缀」。
  - 只读承诺：适配层写方法一律 throw（`NOENT`/自定义只读错误），isogit 不获任何写通道。
  - Range 语义：isogit 读 pack 是整读（其 fs 接口无 range）——packfile 在 worker 内存缓存（worker 生命周期 = 会话，会话结束即释放）；大 packfile 首拉成本是已知边界（§6）。
  - zip 来源（render-archive）不接（zip 内 .git 理论可读，v1 不承诺）。

### 2.2 能力探测（前端化）

- **打开文件后台探测（builder check 收敛，替代「Git 段激活时探测」的矛盾口径）**：文件打开后异步探测——从文件所在目录向上逐级读 `.git/HEAD`（≤5 级），**缓存键 = 目录路径**（同目录后续文件零成本复用；探测失败的目录记负缓存，同会话不重试）；`.git/HEAD` 可读且 ref 语法合法 → git 可用（记录 repoDir 相对前缀）。探测轻量（每目录一次性 ≤5 次读）且后台化，**Git 段显隐因此准确**：不可用来源不渲染 Git 段（e2e「无 .git 无段」断言成立），无「点了才发现不可用」的体验。
- `.git` 为**文件**（worktree/submodule 形态，内容 `gitdir: <path>`）：v1 支持指向 store 内可达路径的情况，外链不可达则判定不可用（builder 细节，记实现注记）。
- 不依赖 health capabilities（服务端零改动）；`url`/`single` 类单文件来源天然不可用。

### 2.3 会话缓存

per `(storeId, repoDir, HEAD 短 hash)` 键缓存：文件 log、blame 结果、blob 读取。HEAD 变化（重新打开/外部改仓库）在缓存命中前比对 `.git/HEAD` 内容失效（读一次 HEAD 极廉价）。

## 3. 信息面（用户拍板全量四项）

### 3.1 基础：末次提交 + 状态 + 分支

- 分支名：`.git/HEAD` 解析（`ref: refs/heads/x` → `x`；detached → 短 hash 标注）。
- 末次提交：`isogit log({ filepath, depth: 1 })` → 短 hash/作者/相对日期/subject。
- 状态（单文件，不跑全仓 statusMatrix）：**经 store 原始字节通道重新读取当前文件**与 HEAD blob 比对（builder check 收敛：渲染链路持有的是归一文本——BOM 剥除、CRLF→LF——拿它比对会把 CRLF 工作区成片误报 modified，必须绕开）→ `clean` / `modified`；HEAD 无此文件 → `untracked`。二进制文件（detect binary 先例）比对哈希不比对解码。blame 行号与 diff 渲染使用渲染归一行号口径（与大纲/跳转通道同基）。e2e 夹具补 CRLF 行尾仓库形态。
- UI：Git 段顶部信息卡（分支/状态徽标/末次提交）。

### 3.2 行级 blame（自研，worker 内）

- 算法：`isogit log({ filepath, depth: 上限 200 })` 逆序逐提交取该文件 blob → Myers diff（自研或轻量库，builder 定）向新版本推进 → 行→提交归属。历史上限 200 截断并在 UI 标注「仅最近 200 个提交参与」。
- 交互：代码区行 hover（~300ms 延迟）浮层显示该行提交者短名 + 相对日期 + subject。浮层实现取 `.vv-status-picker` 的 absolute+相对容器模式（`ViewerPane.svelte:560-581` 先例）；虚拟滚动兼容：hover 挂行元素、行回收即收浮层（virtualScroller 行生命周期）。
- 懒查：blame 全文件在 worker 算一次后缓存；触发时机 = 首次 hover 而非常驻开关（避免为看一眼付出全历史 diff 成本）。
- 仅全量 parse 路径（≤2MB）提供；窗口/流式路径 hover 无浮层（与大纲同边界）。

### 3.3 diff 视图

- 规则（已定）：有未提交改动 → 工作区 vs HEAD；clean → HEAD vs HEAD^（末次提交的改动）。untracked 文件无 diff（提示态）。
- 取两侧内容（worktree 字节 + isogit readBlob）→ Myers unified diff → **Git 段内嵌渲染**：`<pre>` 行级 +/− 着色（自绘，不引 dispatcher 全链不派发临时 tab）；diff 语法高亮不做（+/- 着色已满足可读性）。
- 上限：diff 输出 >2000 行或 >200KB 截断 + 尾注（常量进实现，UI 可见）。

### 3.4 文件历史 log

- `isogit log({ filepath, depth: 50 })` 列表：短 hash/作者/相对时间/subject。
- 点击条目展开提交详情：full hash、author+committer+时区时间戳、完整 message、**该提交对该文件的 diff**（复用 §3.3 通道）。

## 4. UI 面：右面板第三段（与 spec 大纲切换器整合）

- 切换器形态：`[目录 | 属性 | Git]`——spec 大纲（`2026-10-31-code-outline-panel-switch-design.md` §3）的二元分段控件扩为三元；两 spec 的显隐规则合并：**目录段** = 有大纲时显示；**Git 段** = git 探测可用时显示；均无 → 纯属性现状。
- 默认视图：有大纲 → 目录（已定）；否则恒属性（Git 段不抢默认）。isogit 动态 chunk 懒加载时机 = **首次激活 Git 段**（可用性探测已后台完成，chunk 只在用户真看 git 时才拉）。会话内切换不持久化（与目录段一致）。
- Git 段内容布局（自上而下）：信息卡（§3.1）→ blame 说明行（hover 即查的提示）→ diff 折叠区 → 历史 log 列表。全部遵循 ui-design-system 令牌。
- 探测不可用（无 .git/非本地可达）时：无 Git 段，右面板不出现空段。

## 5. 安全与承诺

- 只读：fs 适配层零写通道（§2.1）；无任何会触碰工作区/索引/远端的操作。
- 凭据零涉：不读 `.git/config` 的 remote/凭据内容（v1 甚至不解析 config）；不发起网络请求。
- 信息暴露面 = 既有文件内容的同一信任域（能读仓库文件的服务对象本就能读提交历史），无新增授权面。
- 大仓边界（记档，非 v1 阻塞）：超大 packfile（>50MB）在非 Range 源上整包拉取慢；blame 历史截断 200；大文件（接近 2MB）blame 计算秒级属预期，worker 内不冻 UI。

## 6. 触达面

apps/web（git-worker、GitFsAdapter、gitClient 封装、MetaPanel 侧 `.vv-right` 第三段视图组件、切换器扩三元、app.css）、packages 无改（isogit 为 apps/web 依赖进动态 chunk，rollldown codeSplitting 组登记——遵守 4MB 预算门禁：动态 chunk 不进 precache，预算脚本口径确认）。e2e：**新夹具先例**——playwright 装置内 `mkdtemp` + `execFile('git', [...])` 构造真实仓库（init/config user/多次 commit + 一次未提交改动；CI runner 自带 git）。用例 GIT-01..：信息卡（分支/状态三态/末次提交）、blame hover 浮层、diff 两模式（clean/modified）、log 展开详情、无 .git 来源无 Git 段、FS Access 通道跳过（headless 限制记档）。服务端 cargo 零改动零测试。

## 7. 实施顺序

五 spec 中最后（体量最大、独立域不与他人冲突；依赖 spec 大纲的切换器形态先行落地为二元版，本 spec 扩三元是纯增量）。

## 8. 实现裁决记档（2026-11-01 fixwave 终审汇档）

终审（HEAD 22b4a1f，0C/0I/7M）时点与实施各轮已定案的裁决、既有备案汇总——均为知情取舍非缺陷，实现以本节与源码注释为准（出处随注）。

### 8.1 I1 域收紧：worktree 形态须落 .git 所在目录子树内

`.git` 为文件（worktree/submodule）时，`gitdir: <path>` 指向的实体**必须落在 `.git` 所在目录的前缀模型内**（相对目标以 `.git` 所在目录为基、绝对目标以 store 根为基，逐段消解；逃逸或指向 store 他处——`../main/.git` 之类——即便可达也判不可用，本级不命中继续向上）。原因：GitFsAdapter 以 repoDir 为单根前缀供数，isogit `dir:'/'` 的全部 fs 路径映射进该前缀，模型外路径 worker 链表达不了（越界 throw）。模型内形态（指向自身子树内实体）isogit 的 discoverGitdir 原生跟随，worker 侧无需特判。实现与测试：gitProbe.ts 头注释「保守对齐」节 + gitProbe.test.ts 的 worktree `gitdir:` 形态用例组（相对/绝对/不可达/逃逸四态）。

### 8.2 §3.4 逐提交 diff 基线 = log 前条目（与 git log -p 的 merge 语义 differ）

log 条目展开的逐提交 diff：基线侧 = 文件历史上**相邻前一条目**（isogit log filepath 过滤保证相邻条目即此文件的前一变更点）；首条目无前条才回落 `oid^`（git 首父；无父/该时点无文件 → 空基线全 +）。与 `git log -p` 在 **merge 提交处语义可 differ**：`log -p` 取首父对 diff（merge 提交显示的是对首父的整体变化，filepath 过滤后可能为空），本实现取 filepath 过滤的相邻变更条目——对单文件视图后者更准（跳过不触该文件的 merge 轮次），线性历史二者等价。v1 口径备案（Task 3 ruling）。

### 8.3 既有备案四项汇总（task 1–3 报告与源码注释原样归档）

1. **探测负缓存无恢复口**：probe 把一切读取失败（404/解析失败/store 瞬态失联）并入「此处无 .git」，目录负缓存同会话不重试；store 恢复后重开同目录文件也不重探，需刷新会话（gitProbe.ts 失败口径注释；`clearGitProbeCache` 已导出未接 UI，重试 UI 诉求出现时再消费）。
2. **离线首用降级重试**：isomorphic-git 动态 chunk 不进 precache（4MB 预算门禁），首次激活 Git 段才拉取；离线首用拉取失败 → 段内报错 + 重试钮重建 worker（创建失败不缓存 rejected promise、failWorker 后单例剔除，均可重试语义；gitClient.ts ensureGitClient 注释）。
3. **非 UTF-8 blame 行域**：blame 归一固定 UTF-8 TextDecoder（gitDiff.ts normalizeBlobText），渲染链路按检测编码解码——非 UTF-8 文件（GBK 等）多字节行数理论可漂移（hover 行号对位随行数漂移）。仓库文本默认 UTF-8，v1 接受（gitDiff.ts normalize 注释备案；e2e 夹具未含非 UTF-8 仓库形态）。
4. **objectBytes 无 LRU**：worker 侧会话级对象字节缓存（`.git/objects` 下松散对象/idx，不可变）无 LRU 上限，有界性 = worker 生命周期即会话；`.pack` 与解析态 idx 由 isogit 共享 cache 持有避免双份（gitWorker.ts 缓存注释 + §2.1/§5 大仓边界）。崩溃路径兜底：failWorker 现在 terminate 回收（2026-11-01 终审 Minor 修复，与 dispose 对齐）。
