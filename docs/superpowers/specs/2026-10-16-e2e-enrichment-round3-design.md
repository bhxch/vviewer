# e2e 富化第三轮设计（文件树源级移除 / QuickOpen 多源 / TAX 组合）

- 日期：2026-10-16
- 状态：待用户审阅
- 来源：2026-10-13 两份 e2e 报告缺口清单余量（§6.2）+ 本轮 brainstorm 探索复核
- 文中行号为 2026-10-16 HEAD（49cbc26）参考，实施时以符号定位为准。

## 1. 背景与动机

两轮 e2e 富化（2026-10-13/14）后缺口清单余量，经探索复核收敛为三域：

1. **文件树源级操作零覆盖**：源级操作现仅一处——「移除来源」（`FileTree.svelte:53-56`
   requestRemove confirm → AppShell `removeSource` 关该源全部 tab + workspaceStore 移除；
   注释 :361-365 明言「移除是组内操作——其他 workspace 若共享同一 storeId 不受影响」），
   `.vv-tree-src-remove` 在 e2e/e2e-server **零命中**。
2. **QuickOpen 多源无 e2e**：多源 = workspace 多根来源扫描（`quickOpen.ts:33-63` 按源序
   串行 DFS、跨源 maxFiles=5000、排除规则跨源；结果行带「源名 / path」前缀，按 storeId
   定位来源打开）。单测已全钉（quickOpen.test.ts 双源拼接/跨源排除/maxFiles/空来源），
   e2e 仅单源一条（SHELL-11）。顺带：**BUG-31**（t-shell fixme）——AppShell:63 设计注释
   本写「Ctrl+P 切换」，实现却在面板已开时不关闭不 preventDefault，属实现偏离设计的
   小缺陷，纯前端可达。
3. **TAX 组合面余量**：pinned×拖拽、pinned×撤销、拖拽×撤销均已布点（TAX-03/05/10），
   真正待补仅两个：duplicate×目录 tab、duplicate×手选打开方式（overrideRenderer）。

## 2. 范围与场景

### E1 文件树源级移除全链（FTSRC-01..04）

- FTSRC-01 confirm 分支：双源工作区点 `✕` → confirm 接受 → 该源全部 tab 关闭、来源标签
  与树区消失、其余 tab 保留。
- FTSRC-02 cancel 分支：confirm 取消 → tab 与来源均不动。
- FTSRC-03 同组他源保留：同 workspace 双源移除其一，另一源标签/树/tab 完整。
- FTSRC-04 跨组共享 storeId 不受影响：同一 store 挂两个 workspace（组），移除 A 组内
  该源，B 组同 store 的 tab 与来源不动（锁「组内移除」语义；跨组共享 storeId 的 harness
  可达性 plan 阶段核实，若 UI 不可达则降级为单组断言 + 域文档注记）。
- 注：SUSP-07 修复后探针翻转已在 TDD 修复轮（38fdfef）完成，本轮不重复布点（plan 阶段
  复核一眼即可）。

### E2 QuickOpen 多源 + BUG-31（QO-01..05）

- QO-01 双源扫描：两来源文件拼接、结果行带「源名 / path」前缀、按源序排列。
- QO-02 按 storeId 打开：选中 B 源结果 → 打开的 tab 数据落 B 来源（对 store 断言）。
- QO-03 跨源排除规则：排除规则命中跨源生效（结果不含任一源的命中项）。maxFiles=5000
  跨源上限由既有单测承载（quickOpen.test.ts），e2e 不重复布点。
- QO-04 空来源态：来源存在但无可列文件 → 空态提示不报错。
- QO-05（含产品小修）BUG-31 转正：面板已开再按 Ctrl+P → 面板关闭 + preventDefault
  （不触发浏览器打印/快速搜索默认行为）。产品修复面：AppShell 全局键位 handler
  （:379 一带）Ctrl+P 分支改切换语义，与 :63 设计注释对齐。

### E3 TAX 组合（TAX-12..13）

- TAX-12 duplicate×目录 tab：对目录 tab 触发 duplicate 的行为锚。**plan 阶段先核实现**：
  TabCollection.duplicate 对目录 tab 的现行语义（支持复制 → 锚复制结果；不提供/禁用 →
  锚「无 duplicate 入口或动作无效」），按实现现状裁决，不预设产品改动。
- TAX-13 duplicate×overrideRenderer：带手选打开方式（overrideRenderer）的 tab 被
  duplicate → 断言副本继承 override（快照与 Tab.overrideRenderer 语义一致）。

### E4 文档注记收尾

- workspace-enrichment.md（或就近域文档）补一句勘误：2026-10-13 报告所称「源级折叠」
  在 UI 中不存在（仅目录级展开/折叠），非待补面。
- error-card-open-as 域文档的排序注记在媒体 spec（2026-10-16-media-error-fallback）T5
  落地，本 spec 不重复。

## 3. 非目标

- BUG-27（QuickOpen 403 一票否决）：缺陷修复归 e2e-server 通道，另行立项（fixme 转正
  提示已写明需服务端数据集）。
- 触屏拖拽、跨组移动 tab（spec 明示不做）；源级折叠（UI 不存在）。
- QuickOpen 面板 UI/交互增强（仅补既有设计的覆盖）。

## 4. 测试与验收

- 新场景门禁 3 轮全绿（沿前两轮口径：新场景集多轮 + chromium/mobile 双 project，
  mobile skip 项与 TAX 既有惯例一致）；全量回归跑一轮，既有锚零翻转。
- QO-05 的产品修复（Ctrl+P 切换）补 unit（AppShell 键位 handler 若有可单测面）+ e2e
  双锚；SHELL-11 既有用例保持绿。
- 双源 harness 复用既有材料：b-wsx-recovery.spec.ts:434（WSX-08 双根双源）、
  t-workspace.spec.ts:268（WS-02 localfiles 第二来源）。

## 5. 裁决记录

- 2026-10-16 用户拍板：三域补点全做；TAX-12 按实现现状锚定不预设产品改动；
  BUG-31 作为 QO-05 的产品小修纳入（实现偏离设计注释，方向明确）；
  SUSP-07 探针翻转与「源级折叠」不进本轮范围。
