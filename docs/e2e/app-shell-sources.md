# 应用外壳与文件来源（M1） — e2e 场景

> 转写自：`docs/report/e2e/e2e-test-report-2026-10-08.md`（被测版本 `main` @ `a4714811`，2026-10-08）。
> 本文将该报告「应用外壳与文件来源（app-shell-sources，M1）」域的黑盒测试内容转写为可独立执行的场景文档；只收录报告中有依据的内容，不补充报告之外的 spec 行为。各场景括注报告原始结果（pass / partial / fail / blocked）。

## 1. 域描述与覆盖范围

以下均摘自报告 §1.1、§3.3、§4 矩阵与 §8.1 附录。

- **覆盖与评级**：13 个测试点全部实跑——5 pass / 5 partial（内含 2 fail）/ 1 blocked，域评级 **部分实现**。failed=SHELL-11/12，partial=SHELL-01/03/08/09/13，blocked=SHELL-07。
- **通过面**（报告 §4 备注）：核心打开通道（服务器树 / URL / 打开文件 / 拖单文件）、tab 生命周期（新建/追加/切换/关闭/空态）、未知类型兜底错误卡片、响应式双断点抽屉、本地文件刷新占位均通过。
- **系统性缺失**（报告 §4 备注，拉低评级的三块）：键盘滚动/快速打开零实现（BUG-03）、状态栏元数据未实现（BUG-04）、设置面板整体缺失（BUG-05）。
- **受阻项**（报告 §3.3、§7.1 未覆盖项 1/2/3）：SHELL-07 FS Access 真实 picker 链路——headless Chromium 无法显示/驱动原生目录选择器与刷新后 `requestPermission` 权限弹窗，整条「打开本地文件夹→刷新恢复文件树/双 tab/滚动位置」未覆盖；已验证的仅是 IndexedDB tab 快照恢复。真实 OS 文件夹拖拽（webkitGetAsEntry 通道）同样因合成事件限制未覆盖。
- **关联缺陷**（报告 §5，共 7 条）：
  - BUG-03（medium · verified）——键盘快捷键零响应，对应 SHELL-11；
  - BUG-04（medium · verified，跨域合并 SHELL-12 + HL-06 + HL-07 + SRV-05）——状态栏元数据整体未实现，本域对应 SHELL-12；
  - BUG-05（medium · verified，跨域合并 SHELL-09 + SHELL-13 + SRV-07）——设置面板整体缺失，本域对应 SHELL-09/SHELL-13；
  - BUG-07（medium · verified，主体 HL-05 在 code-highlight-degrade 域）——无扩展名文件被拒，本域仅 SHELL-03 的无扩展名表现观察并入；
  - BUG-08（medium · **unconfirmed**）——服务器来源 tab 刷新后被误标为本地文件占位，源自 SHELL-07 附带发现（本文续编为场景 SHELL-14）；
  - BUG-19（low · verified）——「打开文件夹」点击后无用户可见反馈，两次复核证据相互矛盾，对应 SHELL-01；
  - BUG-25（low · **unconfirmed** · 复核判误报）——报告称 webkitdirectory 回退通道不存在，对应 SHELL-08 原始报告。

## 2. 场景清单表

编号沿用报告测试点编号（SHELL-01~13）；SHELL-14 为续编号（报告未单列测试点，取自 BUG-08 的复现步骤，属 SHELL-07 附带发现）。

| 编号 | 前置条件 | 步骤 | 期望 | 关联缺陷 |
| --- | --- | --- | --- | --- |
| SHELL-01（partial） | vviewer 服务已启动（8391 主实例，`--compute`），浏览器已经 TopBar「连接服务器」接入；数据根含 sort-demo（子目录 sub 与文件 a2、a10、b） | ① 展开文件树定位 sort-demo，记录条目顺序；② 点击 TopBar「打开文件夹」按钮，点击前后以页内 eval 探针对比 file input 数量 / DOM 变化 / 网络请求，观察是否出现选择器、toast 或错误提示（可另以 eval 直调 `window.showDirectoryPicker({mode:'read'})` 验证函数存在性） | ① sort-demo 树序为 sub→a2→a10→b（目录优先、a2 排 a10 前的自然排序；报告经服务器树验证 ✓）；② 点击后应弹出 FS Access 目录选择器或回退/报错提示——实测本轮点击后无任何用户可见反馈（BUG-19，两次复核对回退通道结论相反） | BUG-19、BUG-25 |
| SHELL-02（pass） | 已连接服务器，文件树可见；samples/m1 下有 hello.js、notes.md | ① 点击树中 samples/m1/hello.js；② 再点击 samples/m1/notes.md；③ 观察两个 tab 的激活态与内容 | ① 新建 tab 并激活，代码内容正确渲染（证据 SHELL-02-hello-tab.png）；② 第二个文件追加为新 tab 并接管激活态，原 tab 保留、内容不串扰 | — |
| SHELL-03（partial） | 页面已打开；备好可拖入的单个代码文件与无扩展名 File（构造见第 4 节）；注：headless 下文件夹拖拽通道无法真实构造 | ① 向页面派发合成 drop（DataTransfer 携带单个 File）拖入代码文件；② 同法拖入无扩展名 File（如 `Makefile`）；③ 文件夹拖入（webkitGetAsEntry 建树）通道标注环境受限，仅记录不判定 | ① drop 后新建 tab 并正确渲染文件内容（报告 ✓，证据 SHELL-03-folder-drop.png）；② 无扩展名文件应可识别预览——实测与「不支持的扩展名 "."」错误卡片表现一致（BUG-07 通用表征）；③ 文件夹建树本轮未覆盖（报告 §7.1 未覆盖项 3） | BUG-07 |
| SHELL-04（pass） | 服务运行中；备好三个 URL：有效文件路径、必然 404 的路径、CORS 拒绝的外域 URL | 经 TopBar「文件 URL」入口依次输入三个 URL 并确认打开 | 有效 URL 正确渲染文件内容；404 与 CORS 失败均给出含失败原因的明确提示（报告三场景均有提示，✓；证据 SHELL-04-url-error.png） | — |
| SHELL-05（pass） | 数据树中存在 unknown.xyz | 树中点击 unknown.xyz 打开 | 显示错误卡片，文案含文件名与扩展名：「不支持的扩展名 ".xyz" / unknown.xyz」，不渲染内容（证据 SHELL-05-unknown-xyz.png） | — |
| SHELL-06（pass） | 已连接服务器，文件树可见 | ① 依次打开 3 个不同文件形成 3 个 tab；② 在 3 个 tab 间点击切换；③ 逐个关闭 tab 直至 0 | ② 每次切换内容跟随所点文件；③ 每关闭一个剩余 tab 数递减，全部关闭后显示空态文案（证据 SHELL-06-empty-state.png） | — |
| SHELL-07（blocked） | **真实桌面 Chromium**（FS Access 可用）——本轮 headless 无法驱动原生目录选择器与刷新后 `requestPermission` 弹窗，测试点整体受阻 | ① 点击「打开文件夹」经 FS Access 选择本地目录建立文件树；② 打开两个文件并滚动到非顶部位置；③ F5 刷新并在 `requestPermission` 弹窗中授权；④ 检查文件树、双 tab、滚动位置是否恢复 | ③④ 刷新后文件树 / 双 tab / 滚动位置恢复（spec 期望；本轮 blocked 未验证。已证实子项：IndexedDB tab 快照恢复 ✓，证据 SHELL-08-placeholder-after-reload.png）；② 过程中附带发现 BUG-08（服务器来源 tab 场景，见 SHELL-14） | BUG-08 |
| SHELL-08（partial） | 非 FS Access 环境（或模拟缺失 `showDirectoryPicker`）；本地文件夹内含至少一个文本文件 | ① 点击「打开文件夹」触发 webkitdirectory 回退；② 选择本地文件夹并打开其中一个文件；③ F5 刷新后观察该 tab | ① 回退通道应创建 `input[type=file][webkitdirectory=true]` 并调用 `click()` 弹出目录选择（两次复核结论相反、复核判报告误报，见 BUG-25）；③ 本地文件刷新后 tab 显示占位卡片「无法预览此文件 / 会话中的本地文件需要重新打开（浏览器不保留文件内容）」，无崩溃（复核确认 pass，证据 SHELL-08-placeholder-after-reload-verify.png） | BUG-19、BUG-25 |
| SHELL-09（partial） | 树中目录 excl-demo 含 `.git/`、`node_modules/`、`src/keep.txt`；已连接服务器 | ① 展开树确认 `.git`/`node_modules` 默认显示；② 在 console 写入排除规则：`localStorage['vviewer:settings'] = JSON.stringify({excludedPatterns:[".git","node_modules"]})`（须写单键对象，见第 4 节边界 3）；③ 刷新页面重新展开树；④ 再次刷新验证持久 | ① 默认显示 ✓；②③ 排除后树中 `.git`/`node_modules` 消失、仅剩 src/keep.txt ✓；④ 跨刷新持久 ✓（排除引擎与持久化经 localStorage 探针证实正常；证据 SHELL-09-default-tree.png、SHELL-09-excluded.png）。注：经设置 UI 完成同样操作的入口不存在（BUG-05） | BUG-05 |
| SHELL-10（pass） | 已连接服务器；视口宽度可调 | ① 视口调至 800px（601–900 区间）加载并观察布局；② 视口调至 550px（≤600）观察；③ 分别开合两个抽屉 | ① 文件树收为抽屉 ✓；② 右栏也收为独立抽屉 ✓；③ 两抽屉可独立开合（证据 SHELL-10-800px-firstload.png、SHELL-10-550px-drawers.png） | — |
| SHELL-11（fail） | 已打开 301 行 long-code.js（虚拟滚动容器 scrollHeight≈6040 / clientHeight≈473） | ① 在 CDP 点击代码区、focus 容器、blur 到 body 三种焦点状态下，依次按 j×43、k、g、g、G、Ctrl+P；② 挂 window keydown 探针确认 trusted 事件到达；③ 按 `/` 对照验证监听链路；④ eval 直接赋值 `scrollTop=1000` 验证容器可滚 | 期望（spec 5.11，即修复后验收判据）：j/k 逐行滚动、gg 跳顶、G 跳底（301 行样例 G 后 scrollTop≈5567）、Ctrl+P 弹出快速打开面板可按文件名跳转。实测现状：trusted keydown 全部到达（探针记录 `{key:'j',trusted:true}`、`{key:'p',ctrl:true,trusted:true}`）但 `.vv-code-pre.scrollTop` 恒 0、无快速打开面板（枚举所有 vv-* 面板为空）；`/` 正常唤起搜索面板、eval 赋值 scrollTop 生效，证明监听链路与容器滚动均有效而应用未实现键盘滚动（复核截图 verify/SHELL-11-01~09.png） | BUG-03 |
| SHELL-12（fail） | 服务运行中（服务端 X-VV 检测头正确下发）；备好代码文件 long-code.js、utf16le.txt（UTF-16LE 带 BOM）、GB18030 件、UTF-8（带 BOM）中文件、图片 pixel.png、视频 sample.mp4 | ① 依次打开上述五类文件，读取 `.vv-statusbar` 的 innerText 与 outerHTML；② `curl -I /api/file` 对照 x-vv-lang / x-vv-encoding 头；③ 全页扫描编码/语言指示控件 | 期望（spec L290，即修复后验收判据）：状态栏显示编码、语言、大小、行列；代码文件额外显示高亮引擎与执行位置。实测现状：代码文件状态栏仅「高亮: … · 执行: … · 自动刷新不可用」，outerHTML 中编码/语言/大小/行列四字段均为 Svelte 条件占位 `<!---->` 未渲染；图片/视频仅「自动刷新不可用」；GB18030/UTF-8/UTF-16LE 均无编码显示，而服务端 x-vv-encoding 正确下发 gb18030/utf-8/utf-16le（Range 206 响应同样携带）、x-vv-lang 正确下发 javascript/python；全页无任何编码/语言控件，属性面板仅占位「文件元数据（M4 接入）」；「引擎与执行位置」半项已实现（证据 SHELL-12-1~5.png） | BUG-04 |
| SHELL-13（partial） | 已打开文件；UI 可交互 | ① 经 UI 修改计算策略与代码主题；② eval 读取 localStorage 键 `vviewer:settings` 对照写入值；③ F5 刷新验证恢复；④ 遍历全部按钮/文本/dialog/右键/快捷键寻找排除规则与自动刷新开关入口 | ①③ 计算策略与代码主题修改后写入 localStorage、刷新后恢复逐字吻合 ✓（复核证实）；④ 排除规则与自动刷新应有 UI 入口且修改后持久恢复——实测无任何相关控件（全量 button 穷举无一相关、checkbox/switch 为 0、Ctrl+comma 无弹层，BUG-05；复核截图 SHELL-13 系列） | BUG-05 |
| SHELL-14（续编；unconfirmed） | 已连接服务器；树中有 long-code.js。说明：报告未单列测试点编号，场景取自 BUG-08 复现步骤（SHELL-07 blocked 条目的附带发现），结果 unconfirmed | ① 连接服务器打开 long-code.js；② 设 `scrollTop=2500` 后 F5 刷新；③ 观察 tab 占位文案；④ 重连服务器后点击该 tab | 期望（spec L262，即修复后验收判据）：服务器文件刷新后可重新拉取、自动重读并保留滚动位置。实测现状（unconfirmed，未经独立复核）：刷新后该 tab 变为占位卡片「无法预览此文件 / 会话中的本地文件需要重新打开（浏览器不保留文件内容）」——服务器来源文件被误标为本地文件；④ 重连后点击该 tab 仍是占位（`.vv-code-pre` 不存在），服务器文件未被重读，滚动位置无从还原 | BUG-08 |

## 3. 关联缺陷的验收行为

每条：缺陷现状（引用报告证据）→ 修复后应有行为（作为回归验收依据）。

### BUG-03【medium · verified】键盘快捷键 j/k/gg/G/Ctrl+P 全部零响应

- **涉及测试点**：SHELL-11（fail）。复核会话 vv-verify-app-shell-sources-SHELL-11，截图 `.temp/e2e-artifacts/verify/SHELL-11-01~09.png`。
- **缺陷现状**（报告 §5 BUG-03）：spec 5.11 键盘快捷键零实现。打开 301 行 long-code.js 后，在 CDP 点击代码区、focus 容器、blur 到 body 三种焦点状态下按 j×43、k、g、g、G、Ctrl+P：trusted keydown 全部到达 window（探针逐条记录），但 `.vv-code-pre.scrollTop` 恒 0（G 后应为 5567）、无快速打开面板；eval 直接赋值 scrollTop=1000 可生效（容器可滚）；`/` 键正常唤起搜索面板（键盘监听链路有效）；`docs/spec-deviations.md` 无此项豁免。复核同时纠正原报告误报：Ctrl+Shift+F 两次独立验证均正常打开全局搜索面板；「状态栏行列不变」一项不成立（状态栏本就无行列显示）。
- **修复后应有行为**（回归验收）：
  1. 代码区点击、容器 focus、body focus 三种焦点状态下，j/k 使代码视图逐行滚动（scrollTop 或视口行随按键递增/递减）；
  2. gg 跳至文件顶、G 跳至文件底（301 行样例 G 后 scrollTop≈5567，以报告基准核对）；
  3. Ctrl+P 弹出快速打开面板（vv-* 面板枚举非空），可输入文件名过滤并跳转打开；
  4. 回归不破坏：`/` 文件内搜索与 Ctrl+Shift+F 全局搜索仍正常（报告已证实二者工作）。

### BUG-04【medium · verified】状态栏通用元数据（编码/语言/大小/行列）整体未实现

- **涉及测试点**：本域 SHELL-12（fail）；跨域合并 HL-06、HL-07（code-highlight-degrade）与 SRV-05（server-file-service），同根因合并。证据截图 SHELL-12-1~5.png、HL06/07-verify、srv05 系列。
- **缺陷现状**（报告 §5 BUG-04）：spec L290 状态栏元数据未实现，而服务端检测正确。依次打开代码（long-code.js / utf16le.txt / GB18030 / UTF-8 中文）、图片（pixel.png）、视频（sample.mp4）后，`.vv-statusbar` 仅「高亮: … · 执行: … · 自动刷新不可用」（代码文件）或仅「自动刷新不可用」（图片/视频）；outerHTML 中编码/语言/大小/行列四字段均为 Svelte 条件占位 `<!---->`；GB18030/UTF-8/UTF-16LE 文件无编码显示，而 `curl` 证实服务端 x-vv-encoding 正确下发 gb18030/utf-8/utf-16le（Range 206 响应同样携带）、x-vv-lang 正确下发 javascript/python；全页检索无任何编码/语言字样与控件，属性面板仅占位「文件元数据（M4 接入）」。半项「高亮引擎与执行位置」已实现（SHELL-12 复核补测 edge/langs/app.js 排除个例）。
- **修复后应有行为**（回归验收）：
  1. 打开上述代码文件后 `.vv-statusbar` 渲染出编码、语言、大小、行列四字段的实际值（outerHTML 不再出现 `<!---->` 占位），且与服务端 `curl -I /api/file` 返回的 x-vv-encoding（utf-16le/gb18030/utf-8）、x-vv-lang（javascript 等）一致；
  2. 代码文件继续显示高亮引擎与执行位置（现有正确行为不得退化）；
  3. 图片/视频打开后状态栏不再仅有「自动刷新不可用」，按 spec L290 通用字段口径呈现（报告未细化媒体文件口径，以 spec L290 为准）；
  4. 跨域回归观察点：HL-06/HL-07（编码显示）、SRV-05（X-VV 头到状态栏的映射）在各自域场景中复验。

### BUG-05【medium · verified】设置面板整体缺失：排除规则、刷新开关、手动刷新按钮均无 UI 入口

- **涉及测试点**：本域 SHELL-09、SHELL-13（partial）；跨域合并 SRV-07（server-file-service，fail），同根因合并。证据截图 SHELL-09/SHELL-13/SRV-07 系列。
- **缺陷现状**（报告 §5 BUG-05）：设置面板不存在。连接服务器后遍历全部按钮/文本/dialog/右键/快捷键/路由/localStorage：22 个 button 穷举无一相关、checkbox/switch 为 0、无 dialog/menu、tab 右键无菜单、`#settings` 与 `GET /settings` 均为 SPA fallback、Ctrl+comma 无弹层。引擎层正常：向 localStorage 键 `vviewer:settings` 写入 `{"excludedPatterns":[".git","node_modules"]}` 后树中 `.git`/`node_modules` 消失（excl-demo 仅剩 src/keep.txt）且跨刷新持久；计算策略与代码主题两项可改可恢复。但向已打开文件追加内容后，用户无任何 UI 手段刷新内容（2.5s 后页面不含新行）。对应 spec L262/L229、决策 Q8b/Q9。
- **修复后应有行为**（回归验收）：
  1. 存在用户可到达的设置入口（按钮/dialog；Ctrl+comma 可打开面板）；
  2. 设置中可启用排除预设（.git/node_modules），启用后树中相应目录消失且跨刷新持久（引擎已验证工作，仅需入口可达）；
  3. 设置中可切换自动/手动刷新（spec L262/L229、决策 Q8b/Q9）；
  4. 存在始终可用的手动刷新按钮：自动刷新不可用时向已打开文件追加内容，点击手动刷新后页面出现新行（现状为无新行）；
  5. 回归不破坏：计算策略与代码主题的 UI 修改与 localStorage 恢复仍正常（SHELL-13 已验证部分）。

### BUG-07【medium · verified】无扩展名文件被「不支持的扩展名 "."」直接拒绝预览（本域相关部分）

- **涉及测试点**：主体 HL-05（code-highlight-degrade 域，fail）；本域并入 SHELL-03 的无扩展名表现观察。复核会话 vv-verify-code-highlight-degrade-HL-05。
- **缺陷现状**（报告 §5 BUG-07）：无扩展名文件在语言识别发生前即被扩展名派发拦截。复核两次复现：树点击 shebang-py（首行 `#!/usr/bin/env python3`，190B，file(1) 识别为 Python script）直接渲染错误页「无法预览此文件 / 不支持的扩展名 "." / shebang-py」，无任何代码渲染；同内容 shebang-py-verify.py 正常渲染（服务端对其返回 x-vv-lang: python，对无扩展名文件不返回该头；curl 证实 /api/file 对无扩展名文件返回 200 完整正文但无 x-vv-lang）。本域 SHELL-03 复核：合成 drop 无扩展名 `File('drag-folder')` 与 `File('Makefile')` 表现完全一致（同一「不支持的扩展名 "."」提示），属无扩展名文件的通用表现。仲裁将 HL-05 由 high 调整为 medium。
- **修复后应有行为**（回归验收，本域视角）：
  1. 拖入/打开无扩展名文件（Makefile、shebang-py）不再出现「不支持的扩展名 "."」错误卡片；
  2. shebang-py 按首行 shebang 识别为 python 并按 python 语法高亮预览（对齐 helix Loader）；
  3. 对照组同内容 .py 副本行为一致；识别在前端完成（服务端对无扩展名文件不下发 x-vv-lang，属已知现状）；
  4. 回归不破坏：SHELL-05 的真未知类型兜底（.xyz 错误卡片，已 pass）保持不变。
  - 注：HL-05 主体场景的完整验收在 code-highlight-degrade 域文档。

### BUG-08【medium · unconfirmed】服务器来源 tab 刷新后被误标为本地文件占位，重连后也不重载

- **涉及测试点**：SHELL-07 blocked 条目的附带发现（本文续编为场景 SHELL-14）。**状态：unconfirmed，未独立复核**；修复前应先按报告复现步骤复核证实现状。
- **缺陷现状**（报告 §5 BUG-08）：连接服务器打开 long-code.js，scrollTop=2500 后 F5 刷新，该 tab 变为占位卡片「无法预览此文件 / 会话中的本地文件需要重新打开（浏览器不保留文件内容）」——服务器来源文件被误标为本地文件；重连服务器后点击该 tab 仍是占位（`.vv-code-pre` 不存在），服务器文件未被重读，滚动位置无从还原。spec L262 要求打开的 tab 自动重读并保留滚动位置。有明确 evidence 但无独立复核会话验证。本地文件刷新占位行为本身符合期望（SHELL-08 复核确认 pass）。
- **修复后应有行为**（回归验收）：
  1. 服务器来源 tab 刷新后不出现「会话中的本地文件需要重新打开」占位（该文案仅适用于本地来源文件）；
  2. 重连服务器后点击该 tab 应重新拉取 `/api/file` 并渲染（`.vv-code-pre` 存在）；
  3. 按 spec L262：打开的 tab 自动重读并保留滚动位置（刷新前 scrollTop=2500 可还原，或至少内容可重读）；
  4. 回归不破坏：本地文件刷新后的重开占位（SHELL-08，已验证 pass）保持不变。

### BUG-19【low · verified】「打开文件夹」点击后无任何用户可见反馈（两次复核证据矛盾）

- **涉及测试点**：SHELL-01（partial）。两条相互矛盾的复核证据并存。
- **缺陷现状**（报告 §5 BUG-19）：SHELL-01 复核：点击 TopBar「打开文件夹」后 3s 内 file input 数 / webkitdirectory / dialog / DOM 字节数 / network requests 等六项指标全部零变化、无新网络请求、无 toast/error（截图 vv-01~vv-04）。SHELL-08 复核以 createElement hook 得出相反结论：点击后捕获 `input[type=file][webkitdirectory=true]` 创建（500ms 后属性就位、未连接 DOM）、`input.click()` 被调用、cancel 事件 +1ms 触发——webkitdirectory 回退通道存在且可达，headless 下选择器立即取消属自动化环境特性，弱探针（只查 DOM 连接或创建瞬间属性）会误判为无反应（截图 SHELL-08-folder-fallback-verified.png）。eval 直调 `window.showDirectoryPicker({mode:'read'})` 返回 SecurityError（需用户手势）佐证函数存在。仲裁按低估原则由复核的 medium 降为 low，缺陷焦点收窄为「点击后 cancel 无任何用户反馈」；真实桌面 Chromium 的 FS Access 行为本次无法验证。
- **修复后应有行为**（回归验收）：
  1. 点击「打开文件夹」后用户始终有可见反馈：FS Access 可用时弹原生目录选择器；用户取消（cancel 事件）或环境不支持时给出提示（toast/文案），不再静默；
  2. 真实桌面 Chromium 端到端补测通过：弹出选择器 → 选目录 → 建树全链路（对应报告 §7.1 未覆盖项 2，BUG-19/25 之争需真机定论）。

### BUG-25【low · unconfirmed · 复核判误报】报告称 webkitdirectory 回退通道不存在

- **涉及测试点**：SHELL-08 原始报告。**状态：unconfirmed，复核未能复现报告缺陷并判定为误报**（按规则保留标注不丢弃）。
- **缺陷现状**（报告 §5 BUG-25）：报告称非 FS Access 下「打开文件夹」无任何 input 创建、按钮无反应、无错误提示。复核（confirmed=false）推翻：hook createElement 后 3 次点击（桌面 2 + Pixel 9 仿真 1）均捕获完整事件链——`input[type=file][webkitdirectory=true]` 创建（500ms 后属性就位、connected:false 未连 DOM）、`input.click()` 被调用、cancel 事件 +1ms 触发，且无 JS 错误。结论：回退通道存在且可达，真实非 FS Access 浏览器中用户会看到目录选择对话框，headless 立即 cancel 属自动化特性；报告探针疑因只查 DOM 连接状态或只读创建瞬间属性（属性系后置设置）而误判。占位部分复核确认 pass（文案与 spec 一致、无崩溃）。与 BUG-19 同一按钮且两次复核矛盾，真实非 FS Access 浏览器（iOS Safari/Firefox 等）端到端仍未验证。
- **修复后应有行为**（现状正确行为的回归保护）：
  1. 非 FS Access 环境（模拟缺失 `showDirectoryPicker`）点击「打开文件夹」：创建 `input[type=file][webkitdirectory=true]` 并调用 `click()`，弹出目录选择对话框；
  2. 用户取消时不报 JS 错误、应用状态不破坏；
  3. 验收方法约束：探针须 hook `document.createElement` 并延迟 ≥500ms 读属性（属性后置设置、input 未连接 DOM）；
  4. 真实非 FS Access 浏览器端到端验证列为补测项（报告 §7.1 未覆盖项 2）。

## 4. 测试数据与边界

### 4.1 运行形态（报告 §2.1、§2.2）

- 主服务：`vviewer serve --root .temp/e2e-data --web-dist apps/web/build --port 8391 --compute`；`/api/health` 返回 `capabilities=["file-server","compute"]`。
- 前置：测试前执行 `pnpm gen:grammars`（偏差 #10 强制前置，grammar wasm 资产构建期生成）。
- 数据根 `.temp/e2e-data/` 总量约 24MB、53 个常规文件 + 1 个 symlink；各域另造样例存于 `.temp/e2e-data/domain-<域名>/`。

### 4.2 本域输入数据清单

| 数据 | 用于场景 | 构造/来源（均出自报告） |
| --- | --- | --- |
| samples/m1/hello.js、notes.md | SHELL-02 | 基础数据集自带（m1：generate.mjs、hello.js、notes.md、pixel.png，报告 §2.3） |
| sort-demo/（sub/、a2、a10、b） | SHELL-01 | 数据根下建目录：一个子目录 + a2、a10、b 三个文件，命名覆盖「目录优先 + 自然排序 a2<a10」 |
| long-code.js（301 行） | SHELL-11、SHELL-12、SHELL-14 | JS 代码文件 301 行；报告实测其虚拟滚动容器 scrollHeight 6040 / clientHeight 473（行高 20px/行，G 键跳底基准 scrollTop≈5567） |
| unknown.xyz | SHELL-05 | 任意内容的 .xyz 文件（触发未知扩展名兜底） |
| excl-demo/（.git/、node_modules/、src/keep.txt） | SHELL-09 | 目录含 `.git/`、`node_modules/` 两个将被排除的目录与 `src/keep.txt` 保留文件（复核验证排除后仅剩 keep.txt） |
| utf16le.txt（UTF-16LE 带 BOM）、GB18030 件、UTF-8（带 BOM）中文件 | SHELL-12 | 基础数据集编码 5 件（均经 file(1) 验证；GB18030 的 file(1) 误报 ISO-8859 属常见现象，需以 python `decode('gb18030')` 回读验证内容） |
| pixel.png | SHELL-12（图片状态栏） | samples/m1 自带 |
| sample.mp4 | SHELL-12（视频状态栏） | 测试期间另造 3s mp4（ffprobe 验证合法） |
| 合成拖拽 File：普通代码文件、`Makefile`、`drag-folder` | SHELL-03 | JS 构造 File 对象经 DataTransfer + drop 事件派发；无扩展名件用于 BUG-07 表征观察 |
| 本地文件夹（含 ≥1 文本文件） | SHELL-07、SHELL-08 | FS Access / webkitdirectory 通道用（headless 受限，见 4.3 边界 1/2） |

### 4.3 边界与环境限制（报告 §3.3、§5、§7.1）

1. **SHELL-07 需真实桌面 Chromium**：headless 无法显示/驱动 FS Access 原生目录选择器与刷新后 `requestPermission` 权限弹窗，该场景在 headless 下不可执行（blocked 的直接原因）。
2. **真实 OS 文件夹拖拽未覆盖**：合成拖拽事件的 `DataTransferItem.webkitGetAsEntry()` 恒为 null（规范限制），SHELL-03 的文件夹建树通道需真实拖拽补测。
3. **设置探针键名**：必须写单键对象 `localStorage['vviewer:settings']`；写 `vviewer:settings.excludedPatterns` 无效（复核纠正，报告 §5 BUG-05）。
4. **btrfs 数据根的干扰字样**：8391 主实例（btrfs 数据根）状态栏会常驻「自动刷新不可用」（BUG-02 表征，SSE 建连时即出现）；SHELL-12 观察状态栏时该字样属 BUG-02 根因，不计入状态栏元数据缺陷本身。
5. **webkitdirectory 回退的探针方法**：headless 下选择器立即 cancel 属自动化特性；验证须 hook `document.createElement` 并延迟 ≥500ms 读属性（属性系后置设置、input 未连接 DOM），弱探针会误判为无反应（报告 §5 BUG-19/25）。
6. **快捷键口径**：快速打开为 Ctrl+P；Ctrl+Shift+F 是全局搜索且工作正常（复核纠正原报告「无响应」误报），两者勿混淆（报告 §5 BUG-03）。
7. **SHELL-14 / BUG-08 为 unconfirmed**：回归执行时应先按报告复现步骤复核证实现状，再验证修复行为。
