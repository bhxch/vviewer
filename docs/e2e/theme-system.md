# 主题三层与外观（M2/M7） — e2e 场景

> 转写来源：`docs/report/e2e/e2e-test-report-2026-10-08.md`「theme-system」域——第 1.3 节执行摘要、第 2 节环境与数据、第 3.3 节环境限制、第 4 节矩阵该域行、第 5 节 BUG-06、第 6 节交叉验证、第 8.3 节逐点明细。被测版本 `main @ a471481`，与报告一致。证据截图 `.temp/e2e-artifacts/theme-system/`（8 张，THEME01~07 系列文件已确认在盘）。

## 1. 域描述与覆盖范围

**域定位**：覆盖主题系统的三层——①壳层亮暗三态（`跟随系统 / 亮 / 暗`，落 `html` 的 `data-theme-mode` 属性）；②代码主题层（helix `themes.json` 全量 214 主题，切换时只整体替换 `style#vv-code-theme` 内 CSS 变量，零重解析契约）；③hljs 兜底近似映射层（9 个 `--hljs-*` 变量，使降级着色跟随当前代码主题，对应 M7）。

**报告结论**（第 4 节矩阵）：7 个测试点 **7 通过、0 缺陷、0 受阻**，域评级「**完整**」——10 个域中唯一获此评级者。执行摘要（第 1.3 节）：「文件服务契约、主题系统、Markdown/Office/压缩包查看与全局搜索主链路扎实可用（主题域 7/7 全过）」。

**覆盖内容**（矩阵原文摘录）：亮暗循环与记忆、跟随系统（prefers-color-scheme 双向仿真）、214 个 helix 主题零重解析（纯 CSS 变量替换，MutationObserver 实测 0.5~0.8ms 落 DOM、36 万 span 类名哈希不变）、codeTheme 双主题记忆与联动、markdown 同步、>2MB 分块路径主题跟随。

**缺陷关联说明**：域内观察到的 hljs 兜底/零 wasm 现象**归属 BUG-06**（code-highlight-degrade、pwa-mobile-performance 域），本域不重复计，故本域缺陷数为 0；BUG-06 的验收行为见第 3 节。

**交叉验证**（报告第 6 节）：仓库自带 Playwright 套件整体退出码 0（72 项：64 passed / 1 flaky / 7 skipped），其中 m7 项「hljs 近似映射真实级联」、mobile 项「主题三态循环写 data-theme-mode」与黑盒结论互证。仓库源文件 `apps/web/e2e/m2.spec.ts:53`（切换代码主题零重解析）、`apps/web/e2e/mobile.spec.ts:118`（三态循环写 `data-theme-mode`）即对应本域断言（本次转写时已读源核实存在）。

**测试工具限制**（报告第 3.3 节）：对 36 万 span 超大 DOM 执行 agent-browser 无障碍 snapshot 曾两次致渲染进程无响应/CDP 超时（HL-03、THEME-06），判定为**测试工具 AX 遍历副作用、不计应用缺陷**，改用页内 eval 完成验证——本域所有场景断言一律以页内 eval 为准，见第 4 节边界。

## 2. 场景清单表

| 编号 | 前置条件 | 步骤 | 期望 | 关联缺陷 |
| --- | --- | --- | --- | --- |
| THEME-01 | 按报告 2.2 运行形态启动服务（`vviewer serve --root .temp/e2e-data --web-dist apps/web/build --port 8391 --compute`）并打开首页；TopBar 主题按钮初始态「跟随系统」（settings 默认 `themeMode: system`，`apps/web/src/lib/stores/settings.ts:16`） | ① 读主题按钮文案与 `html` 的 `data-theme-mode` 属性；② 连续点击主题按钮 3 次，每次记录按钮文案、`data-theme-mode`、整壳配色；③ 读 localStorage 单键对象 `vviewer:settings` 的 `themeMode`；④ F5 刷新，重读按钮文案与 `data-theme-mode` | 三态按「跟随系统→亮→暗」循环推进，`data-theme-mode` 同步写 `system/light/dark`；亮/暗两态整壳 UI 配色可见变化；刷新后主题态与刷新前一致（themeMode 持久于 localStorage 并恢复） | 无 |
| THEME-02 | 同 THEME-01 环境；点击主题按钮至「跟随系统」态 | ① 浏览器仿真 `prefers-color-scheme: dark`（DevTools Rendering 面板或 CDP `Emulation.setEmulatedMedia`）；② 观察整壳配色与 `data-theme-mode`；③ 仿真切回 `light` 再观察；④ 双向各至少完整一轮 | 系统切暗→整壳变暗；系统切亮→整壳变亮；双向切换均实时跟随、无需手动干预；主题态保持「跟随系统」不变 | 无 |
| THEME-03 | 服务器已连接；打开长 Rust 源码文件（测试点名义 `sample.rs`，`samples/m2/sample.rs`；报告证据截图为长 .rs 且滚动至 100000、矩阵口径 36 万 span，长 .rs 构造方式见第 4 节）；代码主题下拉含精选+全部共 214 项 | ① 打开 .rs 文件，将代码区滚动至 `scrollTop=100000`；② 页内 eval 抓取代码区全部 span 的 className 序列哈希作基线；③ 挂 MutationObserver 观察 `style#vv-code-theme`；④ 在「代码主题」下拉连续切换多个主题（214 项均可选，证据含 catppuccin_mocha）；⑤ 每次切换记录：样式落 DOM 耗时、span 类名哈希、scrollTop | 214 个主题全部可切换且代码着色即时变化；切换为纯 CSS 变量替换——span 类名哈希与基线一致（零重解析）；`scrollTop=100000` 不丢失；样式落 DOM 亚毫秒级（报告 MutationObserver 实测 0.5~0.8ms） | BUG-06（佐证观察：该文件状态栏为「hljs 兜底 · 本地」、全会话零 .wasm 请求——现象归属该缺陷、本域不计；本测试点验证的零重解析判据不受其影响，报告判定 pass） |
| THEME-04 | 应用已打开；准备两个不同代码主题（报告证据暗槽位为 gruvbox，亮槽位任选亮色主题） | ① 主题态切「亮」，代码主题下拉选主题 A；② 切「暗」，选主题 B（如 gruvbox）；③ 读 localStorage `vviewer:settings` 的 `codeThemeLight`/`codeThemeDark`；④ 亮↔暗来回切换数次，每次读下拉当前值与 `style#vv-code-theme` 内容（其注释含当前主题名，`apps/web/src/lib/theme.ts:191`）；⑤ 刷新页面重复 ④ | 亮暗两槽位各自记忆（`codeThemeLight=A`、`codeThemeDark=B`，双键独立存储）；来回切换互不串扰（亮态恒回 A、暗态恒回 B）；刷新后双槽位记忆保持并正确应用 | 无 |
| THEME-05 | 服务器已连接；一个含 rust 围栏代码块的 markdown 文件 + 一个独立 .rs 文件（报告未记录 THEME-05 确切文件路径，构造建议见第 4 节） | ① 打开 markdown，定位 rust 围栏渲染块；② 抽检围栏内 token 着色（关键字/字符串的 computed color）；③ 同一亮暗态与同一代码主题下打开独立 .rs 文件，抽检同类 token 着色并比对；④ 切换代码主题后重复 ②③ | 任意代码主题下，markdown rust 围栏与独立 .rs 文件的同类 token 同主题同色；切换代码主题后两者同步更新（围栏着色与代码主题联动） | 无 |
| THEME-06 | 打开 >2MB 文本文件进入 hljs 分块+虚拟滚动路径（报告证据为 3MB、36 万 span 规模，构造见第 4 节）；⚠ 断言只用页内 eval，禁止对 36 万 span DOM 执行 agent-browser 无障碍 snapshot（报告 3.3 工具限制） | ① 打开 >2MB 文本，确认处于分块路径（状态栏「hljs 分块」类指示）；② 切暗色，代码主题选 tokyonight；③ 页内 eval 读 `style#vv-code-theme` 中 9 个 `--hljs-*` 变量（`--hljs-keyword/string/comment/number/title/type/variable/tag/attr`，`apps/web/src/lib/theme.ts:115-125`）；④ 抽检视口内 hljs span 的 computed color 与变量值一致；⑤ 换另一代码主题重复 ③④ | tokyonight 色板下 9 个 `--hljs-*` 变量全量更新（每个变量均写入 tokyonight 取色，无默认残留）；36 万 span 规模下视口 span 计算色同步为新色板（hljs 兜底着色跟随当前代码主题） | BUG-06（该「hljs 分块路径」本身即本地 tree-sitter 主路径失效后的降级路径；本测试点验证的是降级路径的主题跟随能力，报告判定 pass） |
| THEME-07 | 同 THEME-06（3MB 文件；报告证据代码主题为 github_dark） | ① 打开 3MB 文件；② 页内 eval 采集切换前基线：head 子节点结构签名（标签+id 序列）与代码区 span 类名哈希；③ 切换代码主题至 github_dark；④ 再次采集两项签名并比对；⑤ 以 MutationObserver（或 `performance.now()` 包裹）测 `style#vv-code-theme` textContent 替换落 DOM 耗时 | 切换前后 DOM 结构签名与 span 类名哈希完全不变；变化的仅为 `style#vv-code-theme` 的 textContent（单节点幂等整体替换，`apps/web/src/lib/theme.ts:183-191`）；落 DOM 亚毫秒级（报告口径 0.8ms，矩阵 0.5~0.8ms） | 无 |

**报告结果与证据**（第 8.3 节，7/7 全 pass）：THEME-01 → `THEME01-dark-shell.png`；THEME-02 → `THEME02-system-dark.png`、`THEME02-system-light.png`；THEME-03 → `THEME03-longrs-mocha-scrolled.png`；THEME-04 → `THEME04-dark-gruvbox.png`；THEME-05 → `THEME05-md-fence-github-light.png`；THEME-06 → `THEME06-3mb-tokyonight.png`；THEME-07 → `THEME07-3mb-github-dark.png`。规模口径备注：THEME-03 矩阵记「36 万 span 类名哈希不变」，附录证据摘要记「36 span」，两处规模有出入；场景断言以「类名哈希不变」本体判据为准，规模依实际打开的文件。

## 3. 关联缺陷的验收行为

### BUG-06【medium · verified】本地 tree-sitter wasm 主路径完全失效（主题域佐证观察来源）

**与本域的关系**：BUG-06 的归属域为 code-highlight-degrade、pwa-mobile-performance（合并 HL-01 + HL-10 + PWA-03），**不是本域缺陷**。报告矩阵明示：「域内观察到的 hljs 兜底/零 wasm 现象归属 BUG-06，不重复计」；BUG-06 仲裁备注亦记录「theme-system 域 summary 亦独立观察到同一现象（sample.rs/hello.js 走 hljs 兜底、零 .wasm 请求），列为佐证」。列于此处作为本域两条相关场景（THEME-03、THEME-06）的回归验收锚点。

**缺陷现状**（报告第 5 节 BUG-06 证据）：

- 自动与本地策略下 sample.rs 均降级「hljs 兜底 · 执行: 本地」（`ts-*` span=0、`hljs-*`=36，等待 6.5s 与硬刷新均复现）；
- 全会话零 `.wasm` 网络请求、仅 manifest fetch；manifest 34 项 abi 字段全为 null（疑为本地引擎门控依据）；
- 仅「远程」策略经 POST `/api/compute/highlight` 获得 tree-sitter（rs=98 个 `ts-*` span）；
- sw.js 声明的 `vv-grammars-*` 运行时缓存从未创建（打开 9 语言后 caches 仅 precache）；
- 断网后 8 个 grammar wasm fetch 全部 Failed to fetch，离线打开代码文件降级 hljs 兜底。

复核会话 HL-01 独立复现且数值逐字一致（自动/本地/远程三策略 `ts-*` span 0/0/98，network `--filter wasm` 为空）。

**修复后应有行为**（回归验收依据，依报告 BUG-06「期望」字段）：

1. 本地主路径按需 fetch grammar wasm，代码文件显示 tree-sitter 高亮——状态栏引擎显示 tree-sitter，代码区出现 `ts-*` span 而非 `hljs-*` 兜底；
2. grammar wasm 按 CacheFirst 写入 `vv-grammars-*` 运行时缓存（`caches.keys()` 中可见该缓存）；
3. 断网后打开代码文件仍可 tree-sitter 高亮（不再降级 hljs 兜底）；
4. 本域回归锚点：修复后复测 THEME-03~07，全部判据不回退——尤其 THEME-03 零重解析与 THEME-07「仅 `style#vv-code-theme` 变化」：高亮引擎由 hljs 兜底切为 tree-sitter 后，span 类名前缀虽由 `hljs-*` 变为 `ts-*`，但「切主题只换 CSS 变量、不触碰已渲染 span」的契约不变。

## 4. 测试数据与边界

### 4.1 运行环境（报告 2.2）

- 主服务：`vviewer serve --root .temp/e2e-data --web-dist apps/web/build --port 8391 --compute`（报告主实例形态）。
- 浏览器：agent-browser 独立会话（headless Chromium）；系统亮暗用 `prefers-color-scheme` 仿真（THEME-02）。
- **强制前置**（偏差 #10，报告 2.1）：测试前执行 `pnpm gen:grammars`（grammar wasm 资产不入库、构建期生成）。THEME-03 打开 .rs 涉及高亮链路，必须先备好资产。

### 4.2 输入文件清单

| 场景 | 输入 | 来源与构造方式 |
| --- | --- | --- |
| THEME-01/02 | 无需测试文件 | 仅壳层交互；需浏览器提供 `prefers-color-scheme` 仿真能力 |
| THEME-03 | 长 .rs 文件（36 万 span 规模）；名义样例 `samples/m2/sample.rs` | 报告证据截图为 long .rs、滚动至 100000，**未记录长 .rs 的确切路径**；自造方式：将 Rust 代码片段（含关键字/字符串/注释/函数等多样 token）程序化重复拼接至 36 万 span 规模，存 `.temp/e2e-data/domain-theme-system/`（各域自造样例目录惯例，报告 2.3） |
| THEME-04 | 无特定文件 | 任一可打开文件即可；被测对象为代码主题下拉（214 项）与 localStorage 双槽位 |
| THEME-05 | 含 rust 围栏的 markdown + 独立 .rs 文件 | 报告**未记录 THEME-05 使用的确切文件名**；可基于 `samples/m2/sample.md` 插入 ` ```rust ` 围栏代码块，独立文件用 `samples/m2/sample.rs` |
| THEME-06/07 | >2MB 文本文件（3MB、36 万 span 规模） | 报告证据名为 3mb，**未记录本域确切路径**；其他域同规模样例为 `long-3mb.txt` 类长文本（报告 2.3 记「3MB 长文本×2」），可按同规格自造并存 `domain-theme-system/` |

### 4.3 规模与边界值

- 214 个 helix 主题全量可切（含 8 个精选置顶，`apps/web/src/lib/theme.ts:25-34`）；
- 36 万 span / 约 3MB 文本：零重解析与变量跟随断言的规模边界；
- `scrollTop=100000`：主题切换不得破坏滚动位置（THEME-03）；
- >2MB：hljs 分块路径触发阈值（THEME-06/07 的被测路径）；
- 样式落 DOM 耗时：报告实测 0.5~0.8ms，验收按亚毫秒级、无感知卡顿判。

### 4.4 工具与断言边界（报告 3.3，如实转写）

- **禁止**对 36 万 span 超大 DOM 执行 agent-browser 无障碍 snapshot：HL-03、THEME-06 各发生一次渲染进程无响应/CDP 超时，判定为测试工具 AX 遍历副作用、不计应用缺陷；改用页内 eval（`evaluate`）完成全部 DOM 断言。
- 报告为黑盒测试结论，本文档所有「期望」均转写自报告测试点与证据摘要；未在报告或仓库源码中出现的行为（如具体动画、过渡效果）不作为验收判据。
