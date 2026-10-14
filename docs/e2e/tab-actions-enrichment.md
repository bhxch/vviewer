# tab 动作富化（撤销栈与拖拽受理边界） — e2e 场景（本轮补充）

> 来源：e2e 补充测试盘点（2026-10-13）第二轮富化。tab 管理动作首面上轮已锚 TA-01~08（apps/web/e2e/t-tab-actions.spec.ts：六动作/pinned 豁免/中键+撤销 LIFO/复制/刷新恢复/组内隔离/remote 占位撤销/撤销落点，全绿）；本轮把该域推到恰界/超界/组合边界：撤销栈容量 10 挤出与 LIFO 严格序、拖拽受理边界（自身/邻位/容器外/pinned 区双侧）、全 pinned 批量关闭、duplicate(pinned) 与撤销恢复归位、中键双事件防御、输入焦点内快捷键不误触、快照恢复后撤销幂等、重连清扫豁免撤销栈、拖拽重排不入撤销栈。
>
> 事实来源：设计 spec `docs/superpowers/specs/2026-10-11-browser-tab-actions-design.md`（§1 决策表/§2 设计）；实现 `apps/web/src/lib/tabOrder.ts`（CLOSED_STACK_MAX=10、reorderIds 拒绝数学、regroupPinned）、`apps/web/src/lib/openFlow.svelte.ts`（TabCollection 动作方法、pushClosed/reopenClosed、undoable:false 豁免）、`apps/web/src/lib/TabBar.svelte`（菜单组装/中键 mousedown+auxclick/拖拽 dragover 受理）、`apps/web/src/lib/AppShell.svelte:402-434`（全局键位 inField 拦截 + Alt+Shift+T）。编号 TAX-01~10，与既有锚 TA-01~08 无重叠。

## 1. 目的与来源

本轮覆盖的富化面（每面对应实现事实）：

- **撤销栈容量与顺序（tabOrder.ts:73 CLOSED_STACK_MAX=10；tabOrder.ts:94-96 push 淘汰栈底）**：连续关闭 11 个 tab，第 1 个被挤出永不可恢复，其余按严格 LIFO 逐个恢复；栈空重复撤销幂等且只提示一次通道（openFlow.svelte.ts:432 showStatusNotice）。
- **系统替换动作豁免（openFlow.svelte.ts:168 `undoable !== false` 判定；872-874 同 base 重连清扫传 `undoable:false`）**：重连清扫关掉的 remote tab 不得污染容量 10 的栈——该豁免此前零 e2e 锚（实测另见 §3.1 SUS-TAX-1：清扫本身不彻底，文件 tab 残留，属独立疑似缺陷，本域按现状锚定豁免语义）。
- **拖拽受理边界（tabOrder.ts:34-52 reorderIds；TabBar.svelte:92-142 dropRejected/ondragover/ondrop/ondragend）**：自身原位拒（fromId===toId→null）、普通 tab 插入点落 pinned 区内拒、pinned tab 插入点越区尾拒（「回弹」= 拒绝后原序不变，对齐 Chrome 拖过固定区弹回的观测形态）、恰区尾边界与区内任意位受理；drop 落容器外走 dragend 清理不重排。
- **pinned 组合边界（openFlow.svelte.ts:249-269 closeOthers/closeRight 的 pinned 豁免；328-341 duplicate 的 pinned 继承与 splice 落位；367-401 reopenClosed 的 snap.pinned 归位区尾）**：全部 pinned 时批量关闭应无动作、closeRight 按「右侧无普通 tab」置灰；unpin 后放行；duplicate(pinned) 副本插原 tab 右侧（pinned 区内）继承 pinned；关闭 pinned tab 撤销恢复归位 pinned 区尾（非原位）。
- **中键双事件防御（TabBar.svelte:66-71 onaux 仅 button 1 关闭并 preventDefault；166-170 onmousedown 仅拦中键默认行为不关闭）**：mousedown 单独不关、auxclick 恰关一次——一次中键恰产生一条撤销栈条目。
- **快捷键输入焦点防御（AppShell.svelte:402-407 inField 判定，输入框焦点内 Alt+Shift+T 不接管）**：焦点在文件内搜索输入框（.vv-search-input）时按 Alt+Shift+T 不触发撤销、不弹栈空提示；出框后同键恢复。
- **撤销栈会话级（spec §1「不持久化，刷新即清」；openFlow.svelte.ts:494-499）**：快照恢复后栈空，立即撤销无幽灵恢复、重复按幂等。

**不布点记录（跨组移动 tab）**：spec §1 非目标明确「不做跨 workspace 拖拽」（非目标清单第 1 条）；实现同口径——dragReorder 以 `groupOrderOf(from.workspaceId)` 组内作用域（openFlow.svelte.ts:348-357），跨组无受理路径。故不为本轮布点；若未来承诺跨组移动（如「移动到其他工作区」菜单项），应另立域补锚。

## 2. 场景清单

公共环境：default 套件（apps/web/playwright.config.ts：vite preview :4173，chromium + mobile 375×667 双 project）。夹具一律 `__vvOpenDirImpl` 目录注入（localfiles 通道，dir tab 名 'ttab'）；拖拽类场景（TAX-02/03/10）仅 chromium project——375px 下多 tab 触发横向滚动拖拽坐标不可靠（TA-02/THEME-03 桌面基准惯例）。除 TAX-09 外全部 localfiles 夹具，无网络面。

| 编号 | 前置条件 | 步骤 | 期望 | 关联缺陷 |
| --- | --- | --- | --- | --- |
| TAX-01 | 注入 11 文件 f01~f11（内容 `body-NN`）全部打开，组序 [ttab,f01..f11] | ① 按序中键关闭 f01→f11；② Alt+Shift+T ×10 逐次断言组序；③ 第 11 次 Alt+Shift+T | ① 文件 tab 归零仅剩 ttab；② 严格 LIFO：恢复序恰为 f11,f10,…,f02，逐次落组尾（第 i 次后组序 = [ttab,f11,…,f(12-i)]），f01 从不出现；首次恢复即渲染 `body-11` 非占位；③ 栈空：状态栏「没有可重新打开的标签页」、组序不变、f01 不可再恢复（容量 10 挤出） | —（撤销栈容量/顺序锚） |
| TAX-02 | aa/bb/cc 三文件打开，组序 [ttab,aa,bb,cc]（chromium） | ① aa 拖到 aa 自身左沿；② aa 拖到 bb 右沿；③ aa 拖到 .vv-statusbar（tabbar 容器外）释放 | ① 无变更：组序不变（fromId===toId 拒）、无 .vv-tab-dragover 残留；② 邻位交换受理：[ttab,bb,aa,cc]；③ drop 落容器外不受理：组序不变、无 dragover 残留（dragend 清理；窗口级 drop 对无文件拖拽为 no-op，+page.svelte:6-17） | —（dragReorder 受理边界·普通区锚） |
| TAX-03 | aa/bb/cc 打开；pin bb、pin cc → 组序 [bb,cc,ttab,aa]（chromium） | ① aa 拖到 ttab 左沿（恰区尾第一个普通位）；② aa 拖到 cc 左沿（pinned 区内）；③ cc 拖到 aa 右沿（pinned 越区尾）；④ bb 拖到 aa 左沿（pinned 恰区尾/区内）。②④ 以 dragover 事件内快照（落点 tab × 指示状态）读拖拽进行中的受理指示 | ① 受理：[bb,cc,aa,ttab]；② 拒：落在 cc 上的 dragover 事件全部无 .vv-tab-dragover 指示（dropRejected→dragOver=null），序不变；③ 拒（回弹）：组序不变（insertAt 2 > 剩余 pinned 数 1）、无指示残留；④ 受理：[cc,bb,aa,ttab]，落在 aa 上的 dragover 出现指示 .vv-tab-dragover + data-drop-before="true"；终态 bb/cc 仍 data-pinned | —（dragReorder·pinned 区双侧边界锚；TA-02 锚的是普通 tab 拖到 pinned 区首，本场景补区尾/区内/恰界） |
| TAX-04 | aa/bb/cc 打开；pin aa→bb→cc→ttab，全员 data-pinned，组序 [aa,bb,cc,ttab] | ① cc 右键菜单点「关闭右侧」（force，aria-disabled 置灰态）；② 菜单点「关闭其他」（正常态）；③ unpin bb；④ 以 aa 为锚再点「关闭其他」；⑤ Alt+Shift+T 一次 | ① 关闭右侧置灰（右侧无普通 tab）可点击但无动作：菜单不关、4 tab 不变；② 无动作：全员 pinned 豁免，组序仍 [aa,bb,cc,ttab]；③ bb 落普通区首位 → [aa,cc,ttab,bb] 且去 data-pinned；④ 放行：非 pinned 的 bb 被关（豁免解除），ttab 仍 pinned 豁免幸存 → [aa,cc,ttab]；⑤ 批量关闭逐个入栈：恢复 bb 落组尾 [aa,cc,ttab,bb] | —（全 pinned 批量关闭无动作 + unpin 放行锚） |
| TAX-05 | aa/bb/cc 打开；pin aa → [aa,ttab,bb,cc] | ① 菜单「复制标签页」；② pin bb；③ 中键关闭 aa 副本；④ Alt+Shift+T | ① 副本插原 tab 右侧（pinned 区内）：[aa,aa,ttab,bb,cc]，两 aa 均 data-pinned，副本激活且渲染内容、原件退居非激活；② [aa,aa,bb,ttab,cc]；③ 副本关闭入栈（快照带 pinned）；④ 恢复归位 pinned 区尾而非原位：[aa,bb,aa,ttab,cc]（恢复件=DOM 第 2 个 aa），data-pinned、激活、内容渲染无错误卡（存活实例捕获） | —（duplicate(pinned) 落位/继承 + 撤销恢复 pinned 归位区尾锚） |
| TAX-06 | aa/bb 两文件打开 | ① 对 bb 合成派发 mousedown(button=1,cancelable)；② 对 bb 合成派发 auxclick(button=1)；③ 真实中键点 aa；④ Alt+Shift+T ×3 | ① defaultPrevented=true 且 bb 不关闭（mousedown 只拦默认行为不接线关闭——双事件防御半）；② auxclick 同样 preventDefault（防中键滚动双保险）且 bb 恰关一次（auxclick 才是关闭接线）；③ aa 关闭；④ 恢复序 aa→bb（栈恰 2 条：每次点击恰 1 条目，mousedown+auxclick 不双开），第 3 次状态栏提示且 tab 数不变 | —（中键 mousedown/auxclick 职责切分 + 恰一次入栈锚） |
| TAX-07 | aa/bb 打开；中键关 aa（栈 1 条） | ① 按 `/` 打开文件内搜索；② 焦点在 .vv-search-input 内按 Alt+Shift+T，等 500ms 读状态；③ Esc 关面板后再按 Alt+Shift+T | ① 输入框聚焦；② inField 拦截（AppShell.svelte:402-407）：不恢复 aa、tab 数不变、状态栏无「没有可重新打开的标签页」、输入框保持聚焦（现状锚定：输入焦点内快捷键不误触）；③ 出框后同键生效：aa 恢复、内容渲染、无栈空提示 | —（快捷键 inField 防御锚） |
| TAX-08 | aa/bb 打开、pin bb；中键关 aa；等快照落盘后刷新 | ① 读恢复现场；② Alt+Shift+T；③ 紧接再按 Alt+Shift+T | ① [bb] 占位恢复（错误卡信号；localfiles 目录条目跳过同 TA-05 口径）；② 栈空（会话级不持久化）：状态栏「没有可重新打开的标签页」、tab 数不变、无幽灵 aa 恢复；③ 幂等：提示仍在、tab 数仍 1、无新增 tab/错误卡 | —（快照恢复后立即撤销幂等/无幽灵锚） |
| TAX-09 | 注入 lfile.txt 打开后中键关闭（栈恰 1 条本地条目）；node:http 假服务器（health/ticket/events/tree/file + OPTIONS 预检）；连接（token 空）→ 打开 hello.js | ① 带 token 'tok-b' 重连同 base；② Alt+Shift+T；③ 再按 Alt+Shift+T | ① 清扫路径（token 不一致不走实例复用）：**目录 + 文件 tab 一并清扫**（SUS-TAX-1 修复后，2026-10-14：匹配在任一关闭前一次性计算，不依赖逐一关闭后的 remoteBaseById 存活）——[ttab,host]、hello.js 归零、新目录 tab 落组尾；② 撤销恢复的是 lfile.txt 而非被清扫的 remote tab（清扫贡献 0 条目，undoable:false 豁免成立），内容渲染非占位；③ 栈空提示、tab 数 3 不变（栈深恰 1 旁证）。原「文件 tab 幸存仍可读」现状锚已随修复退役（存档于 §3.1） | —（重连清扫豁免撤销栈锚 + SUS-TAX-1 修复验收锚，openFlow.svelte.ts 清扫段） |
| TAX-10 | aa/bb/cc 打开（chromium）；中键关 aa | ① cc 拖到 bb 左沿；② Alt+Shift+T；③ 再按 Alt+Shift+T | ① 邻位重排受理：[ttab,cc,bb]；② 撤销恢复的是最近**关闭**的 aa（重排不在栈上），落组尾：[ttab,cc,bb,aa]，重排序保持、内容渲染；③ 栈空提示（重排未产生条目） | —（拖拽重排非 undoable 语义锚） |

## 3. 关联缺陷的验收行为

本域无关联缺陷（TA-01~08 与 TAX-01~10 均为现状锚）。第 3 节按四节结构给出「现状即承诺」的回归护栏判据——下列行为任何一条回归（含 refactor 触碰 tabOrder.ts / openFlow.svelte.ts 动作层 / TabBar.svelte 事件接线时）都应被视为缺陷：

1. **撤销栈有界且严格 LIFO**：容量恰 10（第 11 条挤出栈底最旧且不可再恢复，TAX-01）；批量关闭逐个入栈、每次撤销恰弹 1 条（TAX-01/04/06）；栈空重复撤销幂等，唯一反馈是状态栏一次性提示（TAX-01/08/09/10）。
2. **系统替换动作不入栈**：同 base 重连清扫（undoable:false）关掉的 remote tab 不占栈容量、不被撤销复活（TAX-09）；用户关闭条目不被清扫条目淹没。
3. **拖拽受理边界与回弹**：自身/越界落点无动作且序不变（TAX-02/03）；受理落点给 .vv-tab-dragover + data-drop-before 指示、拒绝落点不给（TAX-03）；容器外释放经 dragend 清理（TAX-02）；重排不产生撤销条目、不丢已有关闭条目（TAX-10）。
4. **pinned 区不变式**：pinned 区恒靠左连续——批量关闭豁免（全 pinned 时无动作）、unpin 后放行（TAX-04）；duplicate(pinned) 副本落 pinned 区内且继承（TAX-05）；撤销恢复 pinned tab 归位区尾而非原位（TAX-05）。
5. **中键单次语义**：mousedown 仅阻止默认（自动滚动），关闭只接线在 auxclick button 1 上——一次中键恰关一 tab 恰入栈一条（TAX-06）。
6. **快捷键输入焦点防御**：INPUT/TEXTAREA/SELECT/contentEditable 焦点内 Alt+Shift+T 不接管（不恢复、不提示），出框后恢复生效（TAX-07）。
7. **撤销栈不跨刷新**：快照恢复后立即撤销无幽灵恢复、重复按幂等（TAX-08）。

### 3.1 现状观察（疑似缺陷，非验收判据）

**SUS-TAX-1 同 base 重连清扫不彻底：文件 tab 残留失联（TAX-09 观察记录）**
- 现象（2026-10-14 实测，构建 08114d2，MutationObserver + IndexedDB 快照取证）：目录 tab + 文件 tab 并存时换 token 重连，清扫循环（openFlow.svelte.ts:872-874，匹配条件 `getRemoteBase(t.source.storeId) === base`）只关掉目录 tab；同 storeId 的文件 tab 幸存。机制：关目录 tab 使该 store 实例失去最后持有者 → releaseStoreIfLast 终结实例（remote.ts close 删除 remoteBaseById 登记 + 停 SSE，服务端侧观测到 SSE 连接关闭）→ 清扫循环走到文件 tab 时 `getRemoteBase` 已返回 undefined，匹配落空。
- 用户可见后果：幸存文件 tab 不在新连接的 watch 内（丢 SSE 自动刷新）、快照 storeBase 登记被清（此后关闭该 tab 再撤销会退化为本地占位文案而非「服务器…重连后可恢复」）；内容 read 仍可用（remote.ts:23-27）。代码注释（openFlow.svelte.ts:868-870「先关闭同 base 的旧 remote tab（目录 + 文件）」）宣称目录+文件都被清扫，与实测不符。
- ~~TAX-09 按现状锚定（幸存 + 仍可读），修复时（如清扫改为先按 storeId 聚合、或匹配脱离 remoteBaseById 依赖）应同步把该场景的期望改为「文件 tab 一并清扫或迁移至新连接」，撤销栈豁免判据（清扫贡献 0 条目）保持不变。~~ **已修复（2026-10-14）**：清扫改为关闭前一次性收集同 base tab id（先收集后关，匹配脱离逐一关闭后的 remoteBaseById 存活依赖），TAX-09 期望已同步改为「文件 tab 一并清扫」，撤销栈豁免判据不变；幸存可读的现状记录保留于上文本作修复对照存档。

## 4. 环境与数据

### 4.1 套件与 helper

- default 套件；spec：`apps/web/e2e/b-tab-actions-enrichment.spec.ts`（自包含：`__vvOpenDirImpl` 目录注入 + TAX-09 的 node:http 假服务器内联，先例 t-tab-actions.spec.ts / t-workspace.spec.ts；`openDrawerIfNarrow/closeDrawerIfOpened` 复用既有 e2e/drawer.ts，不修改任何既有文件）。
- 窄视口适配：树行点击经 openDrawerIfNarrow（mobile project 375px）；拖拽场景 test.skip(chromium 限定)。右键 button:'right'、中键 button:'middle'、拖拽 dragTo / 手动 mouse 序（悬停中读受理指示时）。
- 组序断言统一 `.vv-tab .vv-tab-name` DOM 序（pinned 锁形为 ::before 伪元素不入 textContent，TA 同款口径）；菜单项用 role=menuitem + exact。

### 4.2 夹具构造

| 夹具 | 规格 | 用于场景 |
| --- | --- | --- |
| f01~f11.txt | 单行文本 `body-NN\n`（NN 可断言，内容各异防恢复错位假通过） | TAX-01 |
| aa/bb/cc.txt | 单行文本（内容各异） | TAX-02/03/04/05/10 |
| aa/bb.txt | 单行文本 | TAX-06/07 |
| aa/bb.txt + pinned bb | 同上；pin bb 供恢复现场有 pinned 件 | TAX-08 |
| lfile.txt | `local undo body\n`（撤销恢复内容旁证） | TAX-09 |
| hello.js（remote） | `const resweep = 1;\n`（假服务器 /api/file 内存表） | TAX-09 |
| 假服务器 | health `{capabilities:['file-server']}` / ticket 200 / events SSE 持挂 / tree 内存表 / file 内存表，全响应 ACAO:*（t-workspace 先例同款） | TAX-09 |

### 4.3 边界与注意事项

1. 撤销栈为会话级内存态：一切「栈空」断言依赖同一页面会话内先关后撤，不得跨 reload 复用（TAX-08 反向利用该语义）。
2. localfiles 恢复的已知项（TA-05/ledger M-5 记档）：目录条目（path===''）restore 跳过、本地文件内容不跨刷新落占位——TAX-08 期望列已按此口径，不作为缺陷。
3. 中键合成事件（TAX-06）用 `MouseEvent` 构造 cancelable 派发读 `defaultPrevented`，验证的是接线判定而非浏览器默认行为本身；headless 无法真实触发中键自动滚动，不布点（已知限制）。
4. 拖拽落点断言沿用 TA-02 实测口径：dragTo 默认落点落在目标左半（before=true），「之后」语义需显式 `targetPosition:{x:width-3,y:10}`。受理/拒绝指示（TAX-03②④）在 dragover 事件内同步快照（落点 tab × `.vv-tab-dragover` 状态）后取切片断言：真 CDP 拖拽进行中测试侧无法间歇读 DOM——Playwright 手动 mouse 序在 dragstart 拦截后的 move 被原生拖拽控制器消费（实测无 dragover 派发，仅 dragstart），事件内快照是唯一可靠的进行中状态通道。
5. TAX-09 的重连必须换 token：token 一致时走存活实例复用路径（openFlow.svelte.ts:842-866）不触发清扫。复用与清扫的形态判据：复用路径 `addDirStoreTab` 命中既有目录 tab 只激活不新建（组序不变 [ttab,host,hello.js]）；清扫路径旧目录 tab 被关、新目录 tab 落组尾（[ttab,hello.js,host]）。实测现状（2026-10-14，构建 08114d2）：目录 tab + 文件 tab 并存时清扫只关目录 tab——文件 tab 因旧实例终结（base 登记删除）匹配落空而幸存，suspects 记为 SUS-TAX-1，场景按现状锚定。
6. 快捷键负向断言（TAX-07②）带 500ms 静置窗口：若拦截失效，提示/恢复会同步发生，静置后判负不引入竞态假绿。
7. 全 pinned 场景（TAX-04）对 dir tab（ttab）同样 pin：dir tab 是普通 tab 形态，不 pin 则 closeOthers 会关掉它，「无动作」判据失真；且 unpin 只解除 bb 一个——④ 的期望是 [aa,cc,ttab]（ttab 仍 pinned 豁免），不是全关。
8. TAX-09 的假服务器必须处理 OPTIONS 预检（`Access-Control-Allow-Methods/Allow-Headers: authorization`）：带 token 重连的请求携带 authorization 头，属 CORS 非简单请求——无预检应答则浏览器判预检失败、fetch 抛网络错误（t-workspace/TA-07 先例夹具只覆盖无鉴权简单请求，本轮扩展）。
