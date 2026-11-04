# TabBar 融合菜单与优雅滚动 — e2e 场景（MEN/SCRL/MOB 域）

> 来源：spec `docs/superpowers/specs/2026-11-03-tabbar-consolidation-design.md`（§3 融合菜单 / §4 tab 条滚动 / §5 管理 ▾ 化 / §6.2 新增覆盖）+ plan `docs/superpowers/plans/2026-11-03-tabbar-consolidation.md`（Task 1 融合菜单迁移 / Task 2 滚动三件 / Task 3 管理 ▾ 化 / Task 4 本域落册）。现状脚本：`apps/web/e2e/b-tabbar-menu.spec.ts`（MEN-01..05 + MOB-01，Task 4 新域）与 `apps/web/e2e/b-tabbar-scroll.spec.ts`（SCRL-01..08，Task 2 + 终审修复波 SCRL-08 触屏滑动补口）。spec §6.2 的「新域 `b-tabbar-menu`」落为**结构性拆分的两文件**——箭头/滚动用例随 Task 2 commit 独立成文件、融合菜单用例随 Task 4 commit 成文件，本域文档统一收册两者，编号体系不变（b-tabbar-scroll.spec.ts 文件头注同口径备案）。公共装置：`apps/web/e2e/tabbar-menu.ts`（Task 1 交付：`TABBAR_MENU`/`TRIGGER`/`MENU_POP`/`openMenu`/`openSubmenu('工作区'|'打开'|'主题')`/`menuOpenFile`/`menuOpenFolder`/`menuOpenUrl`/`menuConnectServer`）。

## 1. 目的与来源

- **域定位**：TabBar 左端融合全局菜单（触发钮「工作区名 ▾」+ 单浮层承载 8 首层行 + 就地手风琴子菜单，spec §3）与 tab 条优雅滚动（滚动条隐藏/悬浮箭头/滚轮横移/按住连滚/激活滚入，spec §4）、右端管理钮 ▾ 图标化（spec §5）三条交付线的验收锚。退役面：`.vv-tabbar-actions` 四件簇与 `.vv-ws-pop` 独立下拉随 Task 1 消失，互斥/触达语义随迁类名 `.vv-tbmenu-pop`（spec §3.3/§3.4）。
- **编号分段**：MEN-xx 融合菜单行为 / SCRL-xx tab 条滚动 / MOB-xx 移动端浮层几何。MEN-04 与 `docs/e2e/tab-actions-enrichment.md` TAX-14 同口径（互斥随迁双绿：TAX-14 为随迁锚、MEN-04 为域内主锚加压子菜单展开态）。
- **红线消费面**（只消费既有 UI，不布产品改动）：aria-label/title 逐字锚（切换工作区/刷新当前文件/目录管理/设置/进入·退出专注模式/文件 URL/管理标签）、字形白名单（▾ ▸ ↻ ＋ ✓，无新增图标字体）。

## 2. 场景清单

公共环境：default 套件（apps/web/playwright.config.ts：vite preview :4173，chromium 1280×720 + mobile 375×667 双 project，retries=1）。除 MOB-01 的 mobile 分叉、SCRL-07（chromium 限定）与 SCRL-08（mobile 限定）外全场景双 project 同径；窄视口树行点击经 `e2e/drawer.ts` 适配。

### 2.1 融合菜单（b-tabbar-menu.spec.ts，MEN/MOB）

| 编号 | 前置条件 | 步骤 | 期望 | 关联缺陷 |
| --- | --- | --- | --- | --- |
| MEN-01 | node:http 假服务器（health/ticket/events/tree/file，t-workspace 先例；`rev.txt`=rev-one body）；每用例新 context 默认组 | 8 首层行逐一点开断言：① 「打开▸→打开文件」（filechooser 喂 menu-open.txt）；② 「打开▸→打开文件夹」（hook `showDirectoryPicker` 计数）；③ 「打开▸→粘贴 URL」行内表单回车提交（route 拦截 200）；④ 「连接服务器」行内表单再点收起/复点展开→填地址连接；⑤ 打开远端 rev.txt→改服务端内容→「↻ 刷新当前文件」；⑥ 「主题▸」三显式项 亮→暗→跟随系统；⑦ 「目录管理」；⑧ 「设置」；⑨ 「专注模式」进 zen→热区唤临时条→「退出专注模式」 | ① 文件 tab 激活且内容渲染、菜单先收再弹选择器（pop 归零）；② picker 恰调 1 次 + 状态栏「已取消选择文件夹」（headless AbortError，BUG-19 通道）；③ 提交后 URL 行 `aria-expanded=false`、**菜单保持开**、url tab 内容渲染；④ 表单 hidden 控制开合、连接成功收整个菜单 + host 目录 tab 落组；⑤ rev++ 重读重渲染——`.vv-code-pre` 变 rev-two body、动作类条目点击即收菜单；⑥ `data-theme-mode` 随项翻转 light/dark/system、当前项 ✓ 前缀回显、选择即收菜单；⑦ `.vv-mounts-manager` 可见、Esc 收；⑧ `.vv-settings-center` 可见、Esc 收；⑨ `.vv-shell.zen` 类翻转 1→0 | —（全条目触达矩阵现状锚；rev 重读走远端 store——url store 有 bytes 内存缓存刷新不重读，不可作观测载体） |
| MEN-02 | 默认组空态 | ① 三父项（工作区/打开/主题）逐个：点击展开→再点收起；② 展开 A（工作区）后点 B（打开）→再点 C（主题） | ① 每父项展开 `aria-expanded=true` + chevron ▸→▾ + `.vv-tbmenu-sub` 恰 1 且内容成形（工作区=`.vv-ws-item` 1 行 + `.vv-ws-new`；打开=打开文件/打开文件夹/粘贴 URL 三钮；主题=跟随系统/亮/暗三钮），再点全部翻转回 false/▸ 且子区卸载；② 仅 A 收（`aria-expanded=false`、其子区内容消失）、B/C 依次展开，同刻 `.vv-tbmenu-sub` 恒恰 1（sub 单槽互斥，spec §3.2） | —（就地手风琴现状锚） |
| MEN-03 | 默认组空态 | 三通道各自：开菜单→触发关闭→断残留。① 物理 Esc（先点「主题」父项把焦点置浮层内再按）；② 合成 Esc（对 pop 本体 `dispatchEvent(keydown Escape, bubbles)`——closeTopOverlayForZen 同款派发）；③ 外点 pointerdown（裸坐标 `page.mouse.click(200,560)` 落空 viewer 主体/侧栏空白——locator actionability 对空态元素不可靠：statusbar 空态不渲染、`.vv-tabbar-tabs` 空态零高空包围盒不可点） | 三通道均 `.vv-tbmenu-pop` 归零且触发钮 `aria-expanded` 回 false（零残留双锚）。通道① keydown target 落浮层内→容器 onkeydown 通道（window 兜底 contains 守卫放走，同事件不双触发）；通道② 冒泡到 window 的兜底被 contains 守卫挡下，**只有容器通道能关**（移动端返回键路径承接，spec §3.3 关闭通道第三条） | —（三关闭通道现状锚；单测面 appShellZenEsc I-2 源码正则锚互证） |
| MEN-04 | 合成 drop 单文件 mutex.txt 开档（注入空目录被「所选文件夹为空」拒收，载荷不可省） | ① 融合菜单开（含「打开」子菜单展开态）→ 右键文件 tab；② 右键菜单开 → 点触发钮；③ Esc | ① 右键接管：pointerdown(button 2) 落浮层外先收融合菜单（含子菜单区——子菜单随宿主浮层同生命周期无独立关闭态），contextmenu 再挂右键菜单，`.vv-tbmenu-pop` 归零；② 反向接管：外点 pointerdown 关右键菜单、click toggle 开融合菜单（触发钮 `aria-expanded=true`）；③ Esc 全收，`.vv-tbmenu-pop`+`.vv-tabctx` 合计 0。全程两浮层合计 ≤1 | —（TAX-14 随迁口径的域内主锚；随迁行见 docs/e2e/tab-actions-enrichment.md TAX-14） |
| MEN-05 | 默认组空态 | ① 核对 `[aria-label="管理标签"]` 钩子与文本；② 点击；③ Esc | ① `data-vv-wspanel-trigger` 在场 + 文本「▾」（Task 3 图标化形态：`getByText('管理')` 精确文本钮已退役）；② `.vv-wspanel` 可见（触发机制/Alt+W 不变，spec §5）；③ Esc 收面板 | —（管理 ▾ 形态变更回归锚） |
| MOB-01 | 默认组 + WorkspaceCreateModal 循环新建 5 工作区（共 6 组，简报原样）；mobile 分支开菜单前 `setViewportSize(375×500)` 压短视口 | ① 开菜单+展开工作区子菜单（`.vv-ws-item` 恰 6）+展开连接服务器表单（两展开面同刻齐开）；② 读 pop 几何（scrollHeight/clientHeight/inline max-height/top/bottom）；③ mobile project 加压内部滚动 | top ≥ 0（top 未越视口，评审焦点 1）。mobile（500px 高触顶）：`scrollHeight > clientHeight` + `overflow-y:auto` + inline `max-height` 非 $effect 写入恒空的空串 + 设 `scrollTop=40` 读回 >0（内部确可滚，spec §3.3 超高策略）+ **`bottom ≤ 视口高 − 8`**（修复 edad740 后收紧的精确锚）；chromium（720px 不触顶走收合路径）：max-height 空串 + `scrollHeight ≤ clientHeight` + `bottom ≤ 视口高` | 视口压短根因（CI run 41757373361 双 attempt 红、本地绿）：667 视口下内滚裕量仅 ~8px（626>618），CI 行高度量略矮即无溢出——压短到 500px 裕量放大到 ~190px 量级，断言与内容行高的环境差解耦；chromium 收合路径保持 720 不动（其裕量方向安全）。浮层超高策略锚缺陷史见 §4.2-6 |

### 2.2 tab 条滚动（b-tabbar-scroll.spec.ts，SCRL）

| 编号 | 前置条件 | 步骤 | 期望 | 关联缺陷 |
| --- | --- | --- | --- | --- |
| SCRL-01 | 目录注入连开 25 文件 tab（+目录 tab）保溢出；回卷最左 | ① 读初态箭头；② 滚到底；③ 关 tab 至不溢出；④ 逐枚新开 tab（每枚后回卷最左） | ① 右钮可见左钮不渲染（`{#if}` count 0）；② 左显右隐；③ 双钮皆隐；④ 右钮复现（`$effect` 依赖 tabs 重算） | —（悬浮箭头可见性翻转锚） |
| SCRL-02 | 同 SCRL-01；scrollLeft=0 | 单击右箭头 | smooth 位移 ≥ 0.5×clientWidth（单击 = scrollBy 0.8×视宽，断言留动画观察余量） | — |
| SCRL-03 | 同上 | 按住右箭头至位移超 0.9×clientWidth（poll 驱动按住时长）→ 释放 → 静置两时间点 | 连滚位移显著大于单击档（350ms 延迟后 80ms×64px 步进）；释放即停（held 旗标抑制 click 补滚） | — |
| SCRL-04 | 同上 | tabbar 上 `mouse.wheel(0,240)` | scrollLeft ≈ +240/devicePixelRatio（CDP delta 按 DSF 换算，mobile DSF=2 → 120±10）且 `window.scrollY` 不变（preventDefault 非被动监听） | — |
| SCRL-05 | 同上；scrollLeft=0 | Ctrl+P 快开激活最右 tab scrl-25 | 激活 tab 包围盒完整进入滚动区可视范围（nearest instant 滚入） | — |
| SCRL-06 | 同上 | 读 `.vv-tabbar-tabs` computed scrollbar-width | `none`（滚动条隐藏；触屏原生滑动/动量不受影响） | — |
| SCRL-07 | 同上（**仅 chromium project**——375px 拖拽坐标不可靠，TA-02/THEME-03 桌面基准惯例） | 合成 dnd 事件序列：dragstart 置源→dragover 右缘 36px 带内 ×12 次/100ms→dragend | 悬置期 scrollLeft 持续自增（手工 rAF 步进）；dragend 后滚停（两时间点相等）。native-first 探针结论：CDP 真实输入不进 drag session、无原生 autoscroll（TabBar.svelte 注释记档） | — |
| SCRL-08 | 同 SCRL-01（**仅 mobile project**——触屏滑动需 hasTouch 视口，SCRL-07 桌面基准的镜像；spec §6.2「触屏滑动（mobile project 抽查）」计划 Task 2 静默收窄，终审裁决补口） | CDP 触摸事件序列（touchSwipe，mobile.spec.ts 同款）：滚动区包围盒内手指右→左滑 5 步 | `scrollLeft` 前移（>0，poll 观察合成器 panning 到位）。先行探针实证 headless 一次性触摸滑动真产生位移（单滑满程），不落 PWA-06/2「触摸动量恒 0」受限域——本行断跟手 panning，不断 touchend 惯性（真机惯性仍待复核） | — |

## 3. 验收行为

- **触达矩阵即能力面零回退基准**（spec §2 目标第 4 条）：MEN-01 九段把 8 首层行全部走通到可观测效果层（内容渲染/属性翻转/页面开合），任何条目回流（如 aria 漂移、通道改名、菜单不收）即红。
- **互斥不变式**：MEN-04 + TAX-14（随迁行）双锚锁定「融合菜单浮层 × tab 右键菜单同刻至多一个」，由双方外点 pointerdown 关闭器自然合成，无新增 JS 互斥状态；子菜单不构成独立浮层（随宿主同生命周期）。
- **关闭通道三分**：容器 onkeydown Esc（物理浮层内焦点 + 合成派发双入口）/ window 兜底（target 在浮层外）/ 外点 pointerdown；MEN-03 三通道各自零残留防「通道互替掩盖单通道断裂」。
- **几何护栏**：MOB-01 锁 spec §3.3 超高策略两端——触顶转内部滚动（面板滚动条不隐藏）与不触顶收合（max-height 清空）；SCRL-01..08 锁 tab 条滚动行为（含触屏滑动横移）。
- **回归护栏**：融合菜单触达流是全库高频前置（t-workspace/t-theme/b-mounts-manager/settings-center.ts 等消费 `openMenu/openSubmenu` 装置），本域红先查组件锚红线（aria-label/title/类名）。

## 4. 环境与数据

### 4.1 套件与装置

- 双 project 同跑；`SCRL-07` 仅 chromium、`SCRL-08` 仅 mobile（testInfo.project skip 判定）；MOB-01 双 project 分叉断言（mobile 滚动路径 / chromium 收合路径）。
- 融合菜单流全经 `e2e/tabbar-menu.ts` helper（Task 1 全导出）；工作区创建走 WorkspaceCreateModal UI 流（`openSubmenu('工作区')` → 「＋ 新建工作区…」→ 模态命名 → 创建并激活）。
- 假服务器（MEN-01）：node:http 随机端口，health `{capabilities:['file-server']}` / ticket / events SSE 持挂 / tree·file 内存表，全响应 `ACAO:*`；token 恒空免 OPTIONS 预检。刷新观测走远端 store（read 每次真实 fetch、无内容缓存）；url store 的 `bytes` 内存缓存使 rev++ 重读不可观测（createUrlStore 实现），不选作载体。
- 合成 Esc：`document.querySelector('.vv-tbmenu-pop').dispatchEvent(new KeyboardEvent('keydown', {key:'Escape', bubbles:true}))`——形态与 AppShell `closeTopOverlayForZen` 对 OVERLAY_SELECTOR 命中项的派发逐字对应。
- zen 内菜单触达：标签栏边缘热区（`.vv-edge[data-edge="tab"]`）两段 mouse.move 唤出临时条（mLZ-05 同款）。

### 4.2 边界与注意事项

1. 「打开文件夹」在 headless 下 `showDirectoryPicker` 立即 AbortError（BUG-19 通道反馈「已取消选择文件夹」），hook 计数器证明 picker 通道真被调用（b-app-shell-sources 同款装置）；真实目录选择 headless 不可驱动（README §3.1 受限项）。
2. 「打开文件」filechooser 通道由 Playwright `page.waitForEvent('filechooser')` + `setFiles` 承接；hidden input 常驻挂载语义（菜单收合不丢）由 helper 注释与组件实现共同保障。
3. MOB-01 触顶数学：mobile 500px（运行时压短，原 667）− top − 8 的可用高被「8 首层行（≤600px 档 padding-block 8px）+ 6 行工作区列表 + ＋新建 + 连接服务器表单」叠加超出；行高随 `--vv-ui-font-size` 联动，断言取 `scrollHeight − clientHeight > 0` 相对式而非绝对像素，防字号漂移假红——压短视口正是把该相对式裕量放大到与字体度量环境差（CI run 41757373361 实证 ~8px 裕量可被 CI 行高吃穿）解耦的量级。
4. zen 进出走菜单条目（aria-label 随态「进入/退出专注模式」exact 锚）；zen 中标签栏 visibility:hidden 不可点，须经热区临时条触达（可见入口锚 title 红线在 LZ-05，本域不重复）。
5. 主题三态断言 `data-theme-mode` 属性 + ✓ 前缀文本，不复断 `--ui-bg` 配色值（THEME-01 已锚，本域只锁菜单通道触达）。
6. **超高策略缺陷史（已修复，MOB-01 断言随修复收紧）**：首版实现 app 全局无 box-sizing 重置、`.vv-tbmenu-pop` 为 content-box，TabBarMenu `$effect` 按 border-box 语义直写 `maxHeight = avail`（视口高 − top − 8），钳制面实为内容盒——双缺陷：① 超高场景实际渲染总高 = avail + padding 8 + border 2，底缘越视口 **+2px**（探针实测 2026-11-03：bottom 669 > innerH 667，8px 底边距意图不成立）；② 钳制值 ≥ 内容高时不产生溢出——「内容略超可用高 ≤10px chrome 带」成内滚死窗（简报原样 5 枚构造内容 628 落窗内：bottom 667 恰贴底零余量、内滚不触发，Task 4 曾权宜加量 8 枚绕过）。**修复 edad740（2026-11-03，Task 1 属主）**：`maxHeight = avail − chrome`（getComputedStyle 按 box-sizing 分支扣 padding+border，border-box 下 chrome=0）+ 先清再测自然占高（rect 与底缘断言同源，消除钳制在位时的自钉死误判）——MOB-01 场景实测 bottom 659 = innerH 667 − 8 精确成立、5 枚构造内滚正常触发（scrollHeight 626 > clientHeight 618），死窗消除，权宜加量已回退，bottom 断言收紧为 `bottom ≤ innerHeight − 8` 精确锚。
