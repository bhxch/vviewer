# 手动高亮语言（overrideLang 全链） — e2e 场景

> 来源：渲染器/语言手动指定+markpad 对齐收口（spec `.superpowers/sdd/2026-10-23-renderer-lang-override-p1-interaction/` §4，brief Task 8）。语言手动指定的实现链：`Tab.overrideLang`（`apps/web/src/lib/openFlow.svelte.ts:520` setHighlightLang，rev++ 复用 SSE 刷新的重渲染通道 + persist 落快照）→ ViewerPane 渲染 effect `langOverride` 透传（`apps/web/src/lib/ViewerPane.svelte:336`）→ `packages/render-text/src/code.ts:2571` render 第 6 参 `opts.langOverride`（优先于服务端检测头与扩展名检测，仅 code 渲染器消费，其余渲染器零感知）。UI 入口：MetaPanel 语言行 datalist input（`MetaPanel.svelte` `input[list="vv-lang-datalist"]`，Task 5）与状态栏浮层/Tab 右键「语言：…」只读轻入口（Task 6，`metaLangFocus.ts` 单通道 → AppShell 展开/开抽屉+聚焦，`AppShell.svelte:176-184`）。快照恢复：`AppShell.svelte:707` restore 读回；duplicate 继承：`openFlow.svelte.ts` duplicate 读回拷贝。
>
> **断言锚口径（为什么盯 ts-* span 与状态栏「语言:」段）**：
>
> 1. **本地注入路径（LANG-01/02/04）**：`.txt` 在 `packages/highlight/assets/languages.json` 无条目 → `detectLanguage('txt')` 恒 null → lang null 走 hljs 自动兜底（hljs-* span），**tree-sitter 的 ts-* span 恒 0**；overrideLang='rust' 后本地 lite 内嵌 rust.wasm 命中 → ts-* span 出现。引擎级翻转只来自手动指定，不靠 hljs 自动检测的巧合命中——这是「指定生效」的最硬前端锚。
> 2. **远程快照恢复路径（LANG-03）**：remote 文件带 computeSrc 且假服务器只报 `file-server` 能力（无 compute）→ 按简报裁决不回退本地 wasm，overrideLang rust 落 hljs 整文件层（hljs-* span）。生效主锚改用状态栏「语言: rust」：`getMeta().lang` 单源 = `opts.langOverride ?? 服务端 X-VV-Lang ?? det.lang`（code.ts:2587），本夹具后两者恒空，「rust」只能来自 overrideLang——快照恢复 → dispatch 透传全链证毕。
> 3. **语言行提交通道**：playwright `fill` 对文本框走逐键输入路径**只派发 input 不派发 change**（playwright-core fillLocalInput 的 change 派发仅限 color/date 等类型，2026-10-23 实测钉死）——以 `fill + blur()` 触发原生 change（MetaPanel `onchange` → onLangCommit 提交，空值 = 清除回自动）。

## 1. 目的与来源

语言手动指定（spec §4.1/§4.2）的行为面：

- 设置面：MetaPanel 语言行（datalist 候选 `detectableLanguageNames()`，宽松透传不校验）提交 → setHighlightLang 写 Tab.overrideLang + rev++ 即时重渲染 + persist；
- 渲染面：code 渲染按指定语言高亮（opts.langOverride 优先级最高），状态栏语言段/属性面板随 getMeta.lang 单源回显，「（手动）」徽标（`.meta-openwith-manual`）标生效态；
- 清除面：置空提交 → overrideLang 删除回自动检测，徽标消失、引擎回落；
- 持久面：快照 restore 读回（reload 后语言行回显且渲染仍按 rust）、duplicate 继承（副本语言行回显且渲染生效）；
- 轻入口面：状态栏浮层尾部「语言：…」项 / Tab 右键「语言：…（在属性面板中修改）」只读项 → vv:focus-meta-lang → AppShell 展开右栏/移动抽屉 + 聚焦语言行 input。

## 2. 场景清单

公共环境：chromium project（desktop 1280×720；右栏常驻，`openRightIfNarrow` 兜 ≤600px 抽屉断点）；本地目录经 `__vvOpenDirImpl` 注入（t-tab-actions openDir 同款）；rust 样例为 `fn main() { let msg = …; println!(…); }` 四行片段（fn/let 关键字必产 tree-sitter 捕获）。**开序先开后设**（TAX-13 教训）：overrideLang 经 setHighlightLang 写激活 tab，先开文件再填语言行，杜绝作用错 tab 的假阴性。

| 编号 | 前置条件 | 步骤 | 期望 | 关联 spec 段 |
| --- | --- | --- | --- | --- |
| LANG-01 | 注入 rusty.txt（rust 代码内容）并打开 | ① 断言前置对照（ts-* = 0，hljs 兜底）；② 语言行填 rust + blur 提交；③ 读高亮产物/状态栏/徽标 | ts-* span 出现（expect.poll，tree-sitter rust 命中）；状态栏「语言: rust」（getMeta.lang 单源）；语言行「（手动）」徽标可见 | §4.1 设置链 |
| LANG-02 | 同 LANG-01（先设 rust 成功） | ① 置空提交（fill('')+blur）；② 读徽标/输入值/引擎 | 徽标消失、input 值回 ''；ts-* 消退（回 lang null 的 hljs 自动兜底）、状态栏不再含「语言: rust」 | §4.2 置空回自动 |
| LANG-03 | 测试内假 vviewer 文件服务器（health/file/ticket/events，ACAO:*，t-open-with BUG-69 同款端点集）+ 旧键 'tabs' 快照预置（含 path==='' 目录条目派生来源 + t1 `overrideLang: 'rust'`） | ① reload 触发 restore 走迁移 + remote 重连；② 读语言行/徽标；③ 读状态栏与高亮产物 | 语言行回显 rust + 「（手动）」徽标（migrateLegacyTabs 透传 TabSnapshot 全字段 → AppShell:707 读回）；状态栏「语言: rust」；hljs-* span 出现（引擎无关口径，见上锚口径 2） | §4.1 快照恢复 |
| LANG-04 | 注入 dup-lang.txt 并打开、设 rust 成功 | ① 右键「复制标签页」（TA-04 装置）；② 读新 tab 语言行/渲染 | 副本激活于原 tab 右侧（tabNames 三元）；副本语言行回显 rust + 徽标；副本渲染按 rust（ts-* span 再现）——duplicate 读回拷贝非仅 UI 回显 | §4.1 duplicate 继承 |
| LANG-05 | 注入 status-lang.txt（纯文本）并打开 | ① 点状态栏 `.vv-status-openwith` 开浮层；② 读浮层尾部「语言」项文案；③ 点击 | 浮层项显示「语言：自动」（overrideLang 优先、否则 fileMeta.lang 回显、缺省「自动」）；点击后 `input[list="vv-lang-datalist"]` 获焦点（toBeFocused，AppShell rAF 聚焦链） | §4.2 轻入口 |

## 3. 域内既有锚随动（同批改锚，2026-10-23）

- **OWX 候选集 +markdown（spec §3.1）**：openWithOf markdown 恒兜底后，候选枚举断言补 Markdown 项——`t-open-with.spec.ts` OPEN-08（状态栏浮层）、`t-tab-actions.spec.ts` TA-09（右键子菜单）、`b-layout-zen-deep.spec.ts` LZ-14（jsonl 现场复核），均带行注 `spec 2026-10-23 §3.1 markdown 恒兜底`；TA-01 右键菜单顶层计数 7 → 8（§4.2 增「语言：…」只读项）。`.md` 类候选序不变（[自动, Markdown, 代码/文本, 二进制]）；`b-error-card-open-as.spec.ts` OWX-09 错误卡动作排序（重试恒首、open-as 组内 looksTextual 排序）不经 openWithOf，语义不受影响、零改锚。
- **MetaPanel 语言行改 datalist input（spec §4.2 Task 5）漏网残留**：`b-app-shell-sources.spec.ts` SHELL-12 旧断言「语言 row contains javascript」（dd 文本时代）随 a36d674 失效（检测语言回显挪进 placeholder）——改 `placeholder=自动（javascript）` + 自动态无「（手动）」徽标双锚。
- **MD 徽标即复制（spec §5）**：`button.md-copy-btn` 退役为 `.md-code-lang` 徽标本体（codeBar 内唯一 button）——`b-md-syntax.spec.ts`（bar 内 button 计数 1）、`b-syntax-deep.spec.ts` SY-10（无语言徽标「代码」→「复制」、定位改 `bar.locator('button')`）、`b-md-lightbox-export-deep.spec.ts`（管线落定锚 count 20 改 `.md-code-lang`）、`b-md-export.spec.ts`（openSampler 落定锚 + 导出 probe：`button.md-code-lang` 归零 + `.md-code-lang` span 保留=flattenCodeLangBadge）、`b-markdown-html-docs-md07-09.spec.ts` MD-08（改选徽标按钮 + 补「js」词断言）、`b-markdown-html-docs-pipeline.spec.ts`（js 围栏徽标锚）。

## 4. 已知边界与瞬态处理

- **fill 不派 change**：语言行提交必须 fill+blur（或手动 dispatchEvent change）。直接 `fill` 后断言徽标/重渲染会假阴性（2026-10-23 调试探钉，见锚口径 3）。
- **远程高亮不落本地 wasm**：假服务器无 compute 能力时 remote 文件的 rust 高亮走 hljs 整文件层（`高亮: hljs 兜底 · 执行: 本地`），ts-* 恒 0——这是设计内裁决（server-served 文件不回退本地 wasm，简报口径），LANG-03 断言据此引擎无关。
- **dropFile tab 激活瞬态**：`t-open-with.spec.ts` / `b-layout-zen-deep.spec.ts` 的 dropFile 激活断言放宽至 20s（3 worker 并发负载下 drop → 建链渲染可超默认 5s，OPEN-05/08/LZ-14 实测瞬态，非本域逻辑缺陷）。
- **CDN 层噪音**：`VV_GRAMMAR_CDN=https://cdn.grammars.test/` 构建注入的假 CDN 在 e2e 恒加载失败（「grammar manifest … 加载失败，跳过该资产层」console warning），资产链按设计回落 lite 内嵌层——属既有噪音，勿据此加 console-error 断言。
