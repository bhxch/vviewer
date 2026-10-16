# 错误卡片打开方式入口（open-as 全链） — e2e 场景

> 来源：e2e 补充测试盘点（2026-10-13）medium 缺口（brief 建议补测顺序③）。格式覆盖与打开方式手选（spec `docs/superpowers/specs/2026-10-11-format-coverage-open-with-design.md` §5 验收「错误卡片与 MetaPanel 两入口可用，override 经刷新恢复」）的 e2e 只测了 MetaPanel 入口（OPEN-03）与错误卡片按钮**存在性**（MEDIA-11/BUG-14：断言 `.vv-error-action` 文案，从未点击）；「渲染失败→错误卡片→以 hex/纯文本打开」点击全链零锚。核心实现：`packages/core/src/dispatch/dispatcher.ts:110-126` openAsAction（rendererOverride 重入 dispatch、级联托管、.catch 保留卡片=e183735）、dispatcher.ts:138-187 两类卡片动作构造、`apps/web/src/lib/ViewerPane.svelte:245-255`（临时查看不落 override）。本域缺陷编号 BUG-108 为回归防护缺口编号。
>
> **两条实现链（本轮脚本化前的源码盘点实锤，样本选择与断言口径据此设计）**：
>
> 1. **渲染器内构卡片（软失败）**：`packages/render-media/src/av.ts` showMediaError → 动作=「重试 + 以 hex 打开」两枚，hex 动作**直调** `hex.render(buffer, …)`（无 StreamCtx 全量形态）、经 takeOver 级联托管，**不经 dispatch 重入、无 rendererOverride、无「以纯文本打开」**（pdf 渲染器同构，MEDIA-11 断言的两按钮即此链）。截断 mp4/pdf 的卡片属这条链。
> 2. **dispatcher 级卡片（抛错型）**：渲染器 render 抛错 → dispatcher.ts:373-403 catch → buildRenderErrorActions → 「重试 + 以纯文本打开/以 hex 打开」三枚（按 `looksTextual(head)` 动态排序，dispatcher.ts:167：文本→纯文本排前、NUL→hex 排前），openAsAction 以 `rendererOverride` **重入 dispatch**。损坏图片不产卡（img error 无监听仅裂图，t-media.spec.ts BUG-53 fixme 在案），抛错型样本用 **broken.svg**（sanitizeSvg 解析失败抛错，`packages/render-media/src/image.ts:8`）。
>
> 既有锚点：OPEN-01/02（探测改派）、OPEN-03/BUG-69（MetaPanel 手选+快照落盘+remote restore 透传 override）、MEDIA-11/BUG-14（卡片按钮存在性）、BUG-52/53 fixme（t-media 探索）。

## 1. 目的与来源

错误卡片快捷动作（入口 A，spec §3「『无法预览此文件』卡片在既有『重试 / 降级查看』旁增加『以纯文本打开』『以 hex 打开』两按钮（按探测结果动态排序）」）的行为面：

- 点击链：卡片动作 → 上位新视图（两条链各自锚定：内构链 takeOver 级联替换；dispatcher 链 rendererOverride 重入 dispatch）；
- 语义面：临时查看不落 override（OPEN-03 的 MetaPanel 手选才落快照）——openAsAction 不经 setRendererOverride，open-as 成功后下拉维持「自动」不跟随（ViewerPane.svelte:245-255 注释承诺）；
- 失败面：open-as 重入失败 .catch 保留错误卡片（e183735），卡片动作可再次使用；
- 可达面：移动断点下右栏为抽屉，入口 A 是主要触达路径（spec §3），按钮必须不依赖抽屉即可达可点。

## 2. 场景清单

公共环境：default 套件（chromium + mobile 375×667 双 project，全部场景双份执行，无 desktop-only 跳过项）；本地目录经 `__vvOpenDirImpl` 注入（b-media-office-viewer.spec.ts openDir 同款）；远端通道用 spec 内 mini 假服务器（health/ticket/events/tree/file，全响应 `ACAO:*`，t-open-with.spec.ts BUG-69 同款端点集）+ 旧键 'tabs' 快照预置恢复（须含 path==='' 目录条目派生来源）。

| 编号 | 前置条件 | 步骤 | 期望 | 关联缺陷 |
| --- | --- | --- | --- | --- |
| OWX-01 | 注入 broken.mp4（sample.mp4 截 300B，moov 损坏） | ① 打开 → 等错误卡片；② 核对按钮集合（MEDIA-11 存在性口径）；③ 点「以 hex 打开」；④ 读 hex 视图与状态行 | av 内构卡片两按钮 `[重试, 以 hex 打开]`；点击后 hex 上位（`.vv-hex` 可见、行渲染、状态行「300 B · 未知二进制」）；原错误卡片被替换无残留（takeOver 级联托管，`.vv-error-card`=0 且 `.vv-hex` 唯一） | BUG-108 |
| OWX-02 | 注入 broken.svg（截断 XML，sanitizeSvg 抛「SVG 解析失败」→ dispatcher 级卡片） | ① 打开 → 等错误卡片；② 核对动作按钮集合与顺序；③ 点「以纯文本打开」 | dispatcher 级卡片三按钮且动态排序 `[重试, 以纯文本打开, 以 hex 打开]`（looksTextual 判文本→纯文本排前）；点击后 code 视图上位（`.vv-code-pre` 含原始字节可读投影），卡片清零 | BUG-108 |
| OWX-03 | 同 OWX-01 现场（内构链 open-as hex 已成功） | ① 打开右栏（窄视口经 `.vv-right-toggle` 抽屉）；② 读「打开方式」下拉值与标记；③ 静置后读 IDB workspaces 快照 | open-as 后 `.meta-openwith` 值维持 ''（自动）、无「（手动）」标记（与 OPEN-03 手选后 value='hex'+标记对照）；快照该 tab 无 overrideRenderer 字段 | BUG-108 |
| OWX-04 | 假服务器伺服 broken.svg（128B）恢复出 dispatcher 级卡片 | ① /api/file 注入 500 → 点「以 hex 打开」；② 读卡片/控制台/pageerror；③ 解除故障 → 同一按钮再点 | ① 重入读失败不白屏：原卡片原样保留（detail 不变、三按钮完整、无 `.vv-hex`），console.error `'[vviewer] open-as 重入失败'` 落日志（e183735 .catch）且无 pageerror；③ 二次点击成功上位 hex（重入链可重复使用，无 once 污染） | BUG-108 |
| OWX-05 | 假服务器伺服 broken.svg 1.5MB（size>1MB → headOnly 探测 + hex 窗口模式）恢复出 dispatcher 级卡片 | ① 恢复 → 卡片；② 点「以 hex 打开」；③ 滚 `.vv-hex-dump` 到底；④ 计量 /api/file（page.on('response')） | hex 窗口流式渲染：状态行含「1.5 MB」；点击后的 /api/file 请求全部带 Range 头且 206，含 start>8192 的窗口块读（结构尾窗/滚动窗块），无 Range-less 全量 200（hex 阶段零全量预取；恢复期 av/image 语义内全量读不计） | BUG-108 |
| OWX-06 | 假服务器伺服 broken.mp4（300B）恢复出 av 内构卡片 | ① 点「以 hex 打开」→ hex 上位；② 静置后读快照；③ reload 再等渲染 | 临时查看不落快照：快照无 overrideRenderer；刷新回原路由形态——broken.mp4 仍按扩展名路由 av → 「无法播放此媒体」错误卡片复现且无 `.vv-hex`（与 OPEN-03 手选后刷新恢复 hex、BUG-69 快照透传 override 形成对照） | BUG-108 |
| OWX-07 | 注入 broken.svg + broken.mp4 | ① svg 卡片点「重试」（render 再抛错）；② 再点「以纯文本打开」；③ 切 mp4 卡片点「重试」（软失败重渲染） | 重试与 open-as 互斥替换（takeOver 托管）：任一时刻 `.vv-error-card` ≤1；svg 重试后卡片原位重建且动作组完整（3 枚）、open-as 后卡片清零且 `.vv-code-pre` 唯一；mp4 重试后新卡片替换旧卡片（2 枚按钮、`.vv-artplayer`=0 黑屏不回流）；全程无 pageerror（无泄漏面） | BUG-108 |
| OWX-08 | 同 OWX-01；mobile project（375×667）天然执行 | ① 移动断点下打开 → 错误卡片（左抽屉经 drawer.ts 开合点树行）；② 右栏抽屉保持闭合直接点「以 hex 打开」；③ 开右栏抽屉读 MetaPanel | 入口 A 窄视口可达可点：不依赖抽屉点击即 hex 上位、不被遮挡；右栏抽屉里 `.meta-openwith` 值 ''（自动，OWX-03 的移动断点复核）。桌面 project 同用例为空操作抽屉路径（无 skip） | BUG-108 |

## 3. 关联缺陷的验收行为

### BUG-108 错误卡片「以 hex/纯文本打开」点击链断裂（回归防护缺口）

**缺陷现状**：spec §5 验收明确「错误卡片与 MetaPanel 两入口可用」；现状 e2e 只覆盖 MetaPanel 入口（OPEN-03）与卡片按钮存在性（MEDIA-11/BUG-14：断言按钮文案，从未点击）。两条 open-as 链（渲染器内构直调 hex、dispatcher openAsAction rendererOverride 重入）均无端到端锚——按钮无效、重入白屏、双实例残留、override 误落快照、重入失败不保留卡片，任何一种回归都不会被现有套件发现。

**修复后应有行为（回归验收）**：
1. 渲染失败错误卡片点「以 hex 打开」→ hex 上位渲染原字节，原卡片替换无残留（OWX-01 本地内构链、OWX-05 远端 dispatcher 链窗口流式）。
2. 点「以纯文本打开」→ code 文本形态上位，按钮按 looksTextual 动态排序（OWX-02）；重入失败保留错误卡片且动作可再次使用（OWX-04）。
3. open-as 为临时查看：MetaPanel 维持「自动」、快照无 overrideRenderer、刷新回原路由形态（OWX-03/06）。
4. 回归不破坏：「重试」动作互斥替换无泄漏（OWX-07）、移动断点入口 A 可达（OWX-08）、MetaPanel 手选入口（OPEN-03）、av 统一卡片形态（MEDIA-11 护栏）。

## 4. 环境与数据

### 4.1 套件与 helper

- default 套件；spec：`apps/web/e2e/b-error-card-open-as.spec.ts`（自包含：openDir/openFile 复制 b-media-office-viewer.spec.ts 手法；drawer.ts 复用既有 helper；openRightIfNarrow 仿 t-open-with.spec.ts）。
- 远端面（OWX-04/05/06）：spec 内 node:http mini 假服务器（health/ticket/events/tree/file 端点集；/api/file 支持 `Range: bytes=start-end` → 206 区间 + Content-Range、无 Range → 200 全量、可注入 500 故障），listen(0) 随机端口；快照预置仿 t-open-with BUG-69（sessionStorage last-server + IDB 旧键 'tabs'；目录条目 path==='' 派生来源，storeId=`remote:${hash8(base+':label')}`；文件条目携 size 随 TabSnapshot.size 恢复）。

### 4.2 夹具构造

| 夹具 | 规格 | 用于场景 |
| --- | --- | --- |
| broken.mp4 | samples/m4/sample.mp4（921B）截前 300B（moov 损坏，MEDIA-11 同口径）→ av 内构卡片「无法播放此媒体」 | OWX-01/03/06/07/08 |
| broken.svg-128B | `<svg xmlns="…">\n` + 'x' 填充至 128B（根元素未闭合 → parsererror）→ sanitizeSvg 抛「SVG 解析失败」→ dispatcher 级卡片 | OWX-02/04/07 |
| broken.svg-1.5MB | 同构填充至 1.5MiB（>1MB：dispatch 走 head 探测、hex 进窗口模式） | OWX-05 |
| 远端同款三件 | 上列字节经假服务器 /api/file 伺服 | OWX-04/05/06 |

### 4.3 边界与注意事项

1. av 渲染器销毁期伪 error 事件（MEDIA-11 文件头注）：套件避免「av tab 快速连开」节奏；OWX-07 先 svg 后 mp4、开完不再切换，且两处 av 卡断言口径对伪错误卡片幂等（同为「无法播放此媒体」卡片）。
2. open-as 点击断言必须等确定性信号（hex 状态行文本、code-pre 文本投影），不可只断言卡片消失。
3. 「以纯文本打开」的形态断言放宽为 code 视图含原始字节可读投影（renderCode 非致命解码，`packages/render-text/src/code.ts:633`，替换字符属语义内结果）。
4. IDB 快照读取在 reload 前完成（OPEN-03:171-204 轮询先例）；「无 overrideRenderer」为否定断言，hex 上位后静置 ~1s 再读，防持久化延迟误判。
5. Range 计量只对「点击 open-as 之后」的请求断言（恢复期非 streaming 渲染器全量读是 dispatcher 读策略语义内行为）；hex 阶段出现全量 200 = 窗口流式回归。
6. 远端快照种子必须含 path==='' 目录条目（migrateLegacyTabs 只从目录条目派生 remote 来源，缺则 restore 落占位 tab 无内容）。
7. 本域原盘点假设「损坏 PNG 卡片」「NUL 二进制重入 code 被拒」经源码核实不成立（损坏图片无卡片=BUG-53；code 无二进制守卫），已按上表样本修正——见文件头「两条实现链」注记。

## 动态排序口径（2026-10-16 裁决）

open-as 动作排序 = `looksTextual(head)` 二分（判文本 → 纯文本在前，否则 hex 在前；
head 为 8KB 探测块）。`detect()` 的签名/binary 探测链结论**不参与排序**——知情现状
（SUSP-10 同类口径）：两判据罕有分歧，卡片构造于全量拉取前，以 head 近似是声明过的
可接受退化（dispatcher.ts buildRenderErrorActions 注释在案）。OWX-09（JPEG 头+NUL
二进制载体图片 → hex 排前）与 OWX-02（损坏 SVG → 纯文本排前）构成双向锚。

