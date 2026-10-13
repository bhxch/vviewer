# 错误卡片打开方式入口 — e2e 场景（本轮补充）

> 来源：e2e 补充测试盘点（2026-10-13）medium 缺口（brief 建议补测顺序③）。格式覆盖与打开方式手选（spec `docs/superpowers/specs/2026-10-11-format-coverage-open-with-design.md` §5 验收「错误卡片与 MetaPanel 两入口可用，override 经刷新恢复」）的 e2e 只测了 MetaPanel 入口（OPEN-03）与错误卡片按钮**存在性**（MEDIA-11/BUG-14 断言 `.vv-error-action` 文案，从未点击）；「渲染失败→错误卡片→以 hex/纯文本打开」全链零锚。核心实现：dispatcher.ts:106-185 openAsAction（以 rendererOverride 重入 dispatch、级联托管、open-as 成功后 MetaPanel 维持「自动」不跟随）、e183735（open-as 重入链补 .catch 保留原错误卡片）。
>
> 本域缺陷编号 BUG-108 为回归防护缺口编号。既有锚点：OPEN-01/02（探测改派）、OPEN-03/BUG-69（MetaPanel 入口+快照）、MEDIA-11/BUG-14（卡片按钮存在性）、BUG-52/53 fixme 探索用例（t-media.spec.ts 仅提及卡片）。

## 1. 目的与来源

错误卡片快捷动作（入口 A，spec §3「『无法预览此文件』卡片在既有『重试 / 降级查看』旁增加『以纯文本打开』『以 hex 打开』两按钮（按探测结果动态排序）」）的行为面：

- 点击链：卡片动作 → rendererOverride 重入 dispatch → 新渲染器实例上位（级联托管替换原卡片）；
- 语义面：临时查看不落 override（OPEN-03 的 MetaPanel 手选才落快照）——dispatcher.ts 注释「open-as 成功后本下拉维持『自动』不跟随（临时查看不落 override）」；
- 失败面：open-as 重入失败 .catch 保留错误卡片（e183735）。

## 2. 场景清单

公共环境：default 套件；本地目录经 `__vvOpenDirImpl` 注入（b-media-office-viewer.spec.ts openDir 同款）；损坏样本用真样本截断构造（head -c 口径，MEDIA-11 同款）。

| 编号 | 前置条件 | 步骤 | 期望 | 关联缺陷 |
| --- | --- | --- | --- | --- |
| OWX-01 | 注入 broken.mp4（sample.mp4 截 300B，moov 损坏） | ① 打开 → 等错误卡片（「无法播放此媒体」）；② 点 `.vv-error-action`「以 hex 打开」；③ 读 hex 视图与状态行 | hex 视图上位（`.vv-hex` 可见、行渲染），状态行显示文件名与「未知二进制」类结构解析文案；原错误卡片被替换（级联托管，不残留双实例） | BUG-108 |
| OWX-02 | 注入 broken.png（真 PNG 头 + 截断正文，image 解码失败） | ① 打开 → 等错误卡片；② 检查动作按钮集合与顺序；③ 点「以纯文本打开」 | 卡片按探测结果提供「以纯文本打开/以 hex 打开」（探测结论对应按钮排前，spec §3）；点击后 code 视图上位，原始字节以文本形态可见（乱码可接受——语义是「以纯文本查看字节」） | BUG-108 |
| OWX-03 | 同 OWX-01 现场（open-as hex 已成功） | ① 打开右栏 MetaPanel（移动断点经抽屉）；② 读「打开方式」下拉值；③ 对照 OPEN-03 手选链的落值行为 | open-as 成功后 MetaPanel openWith 维持「自动」（不跟随临时查看，dispatcher.ts 注释承诺；与 OPEN-03 手选后值='hex' 形成对照）；IDB 快照中该 tab 无 overrideRenderer | BUG-108 |
| OWX-04 | 注入 NUL 二进制 noext（无扩展名 + NUL 占比高，探测链落 hex） | ① 打开 → 错误卡片；② 点「以纯文本打开」（重入 code 渲染二进制被拒）；③ 等新卡片；④ 点「以 hex 打开」 | ② 重入失败不白屏：.catch 保留错误卡片形态（e183735，新卡片带完整动作组）；④ 二次 open-as 成功上位 hex（重入链可多次使用，无 once 污染） | BUG-108 |
| OWX-05 | 假服务器（t-open-with 内嵌 mini fake 同款：health/ticket/events/tree/file）伺服 broken.mp4；连接远端来源打开 | ① 远端打开 → 错误卡片；② 点「以 hex 打开」；③ 读 hex 与计量（page.on('response') 过滤 /api/file） | 远端通道 open-as 全链可用（BUG-69 相邻面）：hex 窗口流式渲染（逐 Range 请求、无全量 200），状态行正确 | —（远端 open-as 锚） |
| OWX-06 | 同 OWX-01 现场已完成 open-as hex | ① reload 页面；② 等恢复渲染 | 刷新恢复回原路由形态：broken.mp4 仍按扩展名路由 av → 错误卡片复现（临时查看不落快照，快照无 overrideRenderer——与 OPEN-03 手选后刷新恢复 hex 形成对照） | BUG-108 |
| OWX-07 | 同 OWX-01 | ① 错误卡片先点「重试」；② 等待结果；③ 换新 tab 重开再点「以 hex 打开」 | 「重试」与 open-as 并存且互斥替换（takeOver 语义）：重试失败回错误卡片、重试成功卡片消失；open-as 后原卡片实例被替换且无泄漏面（连续操作无重复卡片/无控制台未捕获错误） | —（卡片动作托管锚） |
| OWX-08 | 同 OWX-01；mobile project（375×667）天然执行 | ① 移动断点下打开 → 错误卡片；② 直接点击「以 hex 打开」（右栏抽屉闭合状态）；③ 开抽屉读 MetaPanel | 移动断点错误卡片按钮可达可点（spec §3「移动端右栏为抽屉，入口 A 为主要触达路径」）：点击后 hex 上位不被抽屉遮挡；无需先开抽屉 | —（移动可达性锚） |

## 3. 关联缺陷的验收行为

### BUG-108 错误卡片「以 hex/纯文本打开」点击链断裂（回归防护缺口）

**缺陷现状**：spec §5 验收明确「错误卡片与 MetaPanel 两入口可用」；现状 e2e 只覆盖 MetaPanel 入口（OPEN-03）与卡片按钮存在性（MEDIA-11：断言 `.vv-error-action` nth(1) 文案为「以 hex 打开」，从不点击）。openAsAction 的重入链（rendererOverride 重入 dispatch、级联托管 takeOver、失败 .catch e183735、MetaPanel 不跟随）均无端到端锚——点击链断裂（按钮无效、重入白屏、双实例残留、override 误落快照）任何一种回归都不会被现有套件发现。

**修复后应有行为（回归验收）**：
1. 渲染失败错误卡片点「以 hex 打开」→ hex 视图上位渲染原字节，原卡片被替换无残留（OWX-01/05）。
2. 点「以纯文本打开」→ code 文本形态上位（OWX-02）；重入失败保留错误卡片且可再次 open-as（OWX-04）。
3. open-as 为临时查看：MetaPanel 维持「自动」、快照无 overrideRenderer、刷新回原路由形态（OWX-03/06）。
4. 回归不破坏：MetaPanel 手选入口行为（OPEN-03）、卡片「重试」动作、av/档统一卡片形态（MEDIA-11 护栏）。

## 4. 环境与数据

### 4.1 套件与 helper

- default 套件；spec：`apps/web/e2e/b-error-card-open-as.spec.ts`（自包含：openDir/openFile 装置复制 b-media-office-viewer.spec.ts 同款手法；drawer.ts 复用既有 helper）。
- OWX-05 远端面：spec 内起 mini 假服务器（t-open-with.spec.ts 内嵌 fake 同款端点集），端口 listen(0) 随机分配。

### 4.2 夹具构造

| 夹具 | 规格 | 用于场景 |
| --- | --- | --- |
| broken.mp4 | samples/m4/sample.mp4 截前 300B（moov 损坏，MEDIA-11 同口径） | OWX-01/03/06/07/08 |
| broken.png | 真 PNG 8 字节签名 + 截断正文（解码失败；IEND 缺失） | OWX-02 |
| noext | 无扩展名 NUL 二进制（`bad\0\0…` 填充 ≥1KB；探测链 NUL 判二进制） | OWX-04 |
| 远端 broken.mp4 | 同 broken.mp4 经假服务器伺服 | OWX-05 |

### 4.3 边界与注意事项

1. av 渲染器已知干扰面：ArtPlayer 销毁期伪 error 事件（MEDIA-11 注释）——正常样本先开的规避手法照抄（OWX-01 无正常件时直接断言卡片，不涉该面）。
2. open-as 点击断言必须等待重入 dispatch 完成（hex 首行渲染或状态行文本为确定性信号），不可只断言卡片消失。
3. 「以纯文本打开」二进制的渲染形态断言放宽为「code 视图存在且含原始字节的可打印投影」——替换字符/乱码是语义内结果（spec：以纯文本查看字节）。
4. IDB 快照读取在 reload 前完成（OPEN-03:167-190 同款轮询先例），避免 close 时机竞态。
