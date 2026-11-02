# 代码大纲与右面板切换 e2e — 场景（OUT 域）

> 来源：spec `docs/superpowers/specs/2026-10-31-code-outline-panel-switch-design.md`（§2 数据面 tags.scm 提取 / §3 交互面「目录|属性|Git」切换器，含 §3 行为备案 fixwave 回写）+ plan `docs/superpowers/plans/2026-10-31-code-outline.md`（Task 3 OUT-01..06）。本文档为该域收册文档：既有 OUT-01..06 转录现状脚本，OUT-07..10 为测绘差距新增锚（≈2MB 全量+大纲性能面 / rightViewTouched 跨文件保持 / depth 钳制 / 在飞结果 tab 失效）。

## 1. 目的与来源

- **现状 e2e 文件**：`apps/web/e2e/b-code-outline.spec.ts`（OUT-01..06，头注载明链路事实与语言资产实况：python/ts tags 捕获形态、ocaml 无 tags、perl 无 wasm、>2MB 窗口路径）。
- **实现锚**：提取链 `packages/vviewer-highlight/src/client.ts:37-38/213-231`（outline 独立 pending 面 + 三层失效 + 同 lang 去重）；上行 `apps/web/src/lib/ViewerPane.svelte:261-280`（渲染 effect 一次性读 + 250ms 轮询，空 [] 不上行）与 `:568-581`（跨 tab 清空 lastSeenTab 门）；切换器与落位 `apps/web/src/lib/AppShell.svelte:133-135/210-228`（rightView/rightViewTouched、默认落位 effect：touched 后不写）+ `:1332-1356`（三元切换器，切段置 touched）；视图 `apps/web/src/lib/OutlineView.svelte:67-70`（depth 钳制 `Math.min(depth, 8)`，12px/层）。
- **测绘差距**（本文档新增面）：OUT-04 只锚 >2MB 窗口路径**无大纲**，2MB 内全量+大纲同窗的卡顿面零锚（OUT-07，交接锚 A3）；rightViewTouched 跨文件保持零锚（OUT-08，OUT-03 只锚默认落位矩阵）；深嵌套 depth 钳制零锚（OUT-09）；大纲在飞结果跨 tab 串台面零锚（OUT-10，id 失效三层防护惯例的 e2e 面）。

## 2. 场景清单

### 2.1 既有面（现状脚本已锚）

| 编号 | 落点 | 锚要 |
| --- | --- | --- |
| OUT-01 | `b-code-outline.spec.ts:97` | python 大纲渲染：引用条目过滤（7→5）、kind 中文徽标、depth 缩进（类 0px/方法 12px） |
| OUT-02 | `b-code-outline.spec.ts:121` | 点击跳转 pendingLine 通道：目标行视口就位 + 行级高亮；rev 重渲窗口大纲面板不自清空（fixwave 豁免锚：DOM 打标 poll） |
| OUT-03 | `b-code-outline.spec.ts:168` | 切换器显隐矩阵：py 有 / ts 有（接口签名面）/ md TOC 有 / 无大纲纯属性；默认落位目录 |
| OUT-04 | `b-code-outline.spec.ts:210` | >2MB 窗口路径（3MB py）与 hljs 兜底路径（.pl）均不出大纲：无切换器不抛错 |
| OUT-05 | `b-code-outline.spec.ts:246` | 无 tags 语言（ocaml：wasm 可用 queries 无 tags）真实 parse 路径零大纲——先锚「高亮: tree-sitter」防降级凑出 [] |
| OUT-06 | `b-code-outline.spec.ts:259` | 滚动跟随：scrollTop 800 → 二分迁移激活高亮项 fn00→fn13（firstVisibleLine 仅全量句柄链） |

### 2.2 新增面（测绘差距锚）

| 编号 | 前置条件 | 步骤 | 期望 |
| --- | --- | --- | --- |
| OUT-07 | 页内构造 ≈2MB python（HL-03 先例：`__vvOpenDirImpl` 免大参数跨 evaluate 拷贝——约 2.9 万行 `def fnNNNNN():\n    pass`，每符号可在 tags 捕获面内） | ① 打开文件起表：`.vv-code-pre` 首行可见时刻；② 等切换器/大纲首项到货；③ 打开窗口内驱动滚动（`scrollTop` 写入 + 首行内容断言） | ① 首屏时限锚：`.vv-code-pre` 可见 ≤20s（套装负载口径，OUT-04 30s 上界参照；大纲 worker 独立 parse 不阻塞首屏——全量渲染完成先行、outline fire-and-forget 后置）；② 大纲到货 ≤30s 且首项可见（切换器出现 = 上行链路全通）；③ 打开窗口内代码可滚动（`scrollTop` 生效、行号/内容自洽）= 主线程无长任务佐证（HL-11 交互响应性先例的轻量替代锚） |
| OUT-08 | 双有大纲文件（calc.py + shape.ts）+ plain.txt 注入；新 context（rightViewTouched 初值 false） | ① 打开 calc.py → 默认落「目录」（aria-pressed）；② 手动点「属性」钮（置 touched，`AppShell.svelte:1340-1346`）；③ 切 shape.ts（有大纲）读落位；④ 对照：另一新 context 直接打开 calc.py | ②③ **touched 台账跨文件保持**：shape.ts 大纲在（切换器在场）但落位仍「属性」——默认落位 effect 因 touched 不写（`AppShell.svelte:216-217`）；④ 新 context 未 touched → 直接落「目录」（默认落位语义）；plain.txt 无大纲文件在 touched 后维持属性现状（OUT-03 既有面不重复） |
| OUT-09 | 页内构造 10+ 层嵌套 python（`class A0:` 起逐层缩进嵌套 `class A1:`…`class A10:` + 末层 `def deep()`——tags class 捕获 byte range 包含栈式推导 depth） | 打开 → 等大纲到货 → 读各条目 `paddingLeft` 与容器溢出 | 缩进钳制有界：条目 paddingLeft ≤ 96px（`Math.min(depth, 8)` × 12px/层，`OutlineView.svelte:67-70`）——深层条目（depth ≥8）缩进钉死同值不随层数增长；`.vv-outline` 容器 `scrollWidth ≤ clientWidth`（无横向溢出爆版面） |
| OUT-10 | calc.py（大纲体积大到到货需数百 ms——加大行数或函数量）+ plain.txt 注入 | ① 点开 calc.py 后**立即**（不等切换器）切 plain.txt；② 读右栏；③ 切回 calc.py | ② plain.txt 激活时：`.vv-right-switch` 与 `.vv-outline` 计数 0——calc.py 的 outline 响应不串台（响应回来时读的是 plain.txt 实例：鸭子缺席 → 上行空 []；跨 tab 清空由 `ViewerPane.svelte:580` lastSeenTab 门承担；在飞请求按 id 失效丢弃，`client.ts:37-38/213-231`）；③ 切回 calc.py 大纲重建（切换器重现 + 条目数回归——同 tab rev 未变实例缓存命中，轮询上行 length 跳变） |

## 3. 验收行为

- **OUT-07 性能面**：时限锚为套装负载下的上界口径（非严格 perf budget），首跑校准后钉值；「首屏不等大纲」是 spec §2.2 的架构承诺（全量 parse 后 fire-and-forget、worker 独立 parse），首屏锚与大纲到货锚分离计时即为其行为级表达。回归护栏：OUT-04（>2MB 无大纲）与 HL-03（3MB 错位面）零翻转。
- **OUT-08 交互语义**：按 spec §3 修正语义（「不跨文件记忆」修正为「未动过时跟随默认落位、动过保持」）断言两向——touched 保持 + 新 context 默认落位。回归护栏：OUT-03 默认落位矩阵、GIT-02 的 touched 面（Git 段激活同置 touched，`git-panel` 域互证）。
- **OUT-09 边界**：钳制防深嵌套爆版面（spec §3 builder 定钳制值 8 层）；kind 徽标与条目排序不在本锚（OUT-01 已锚）。
- **OUT-10 竞态负路径**：不串台的判定锚是「切走后的右栏终态」+「切回重建」两点，不锚中间帧；与 OUT-02 的 rev 重渲豁免锚互斥（OUT-10 是跨 tab 清空路径，OUT-02 是同 tab 保持路径）。回归护栏：OUT-02、OUT-06 零翻转。
- **md TOC 回归护栏**：m3 / `b-markdown-html-docs-md07-09` 既有 TOC 锚为切换器共享面的回归网（OUT-03 既有口径），切换器任何改动定向同跑。

## 4. 环境与数据

- **通道与装置**：default 套件双 project；注入经 `b-markdown-html-docs-helpers.ts injectDir`（`__vvOpenDirImpl` + webkitRelativePath 纯前端本地管线）+ `openTreeFile`；右栏断言前 `ensureRightDrawer(page, true)`（mobile ≤600px 右栏在抽屉内，375px 双抽屉热区重叠——断言完即收，OUT-03 编排先例）。
- **语法层前提**：e2e 语法层 `VV_GRAMMAR_CDN=cdn.grammars.test` 被 mock 空清单（build:e2e 注入）→ grammar 走同源 static/grammars 层（34 语 wasm）；python/typescript tags.scm 在 assets（`packages/vviewer-highlight/assets/queries/`）——OUT 载体的捕获面以 `b-code-outline.spec.ts:14-21` 语言资产实况为准。
- **OUT-07 体量构造**：≈2MB 判定按构造后字节数（页内 `new File([...]).size` 可断言）；每行 `def fnNNNNN():\n    pass\n` 模式使全部符号进 python tags 捕获面（class/function/constant + reference.call），大纲条目量万级——首项可见锚用 `.vv-outline li` first 而非全量计数（万级 li 计数断言本身即重 DOM 操作，禁用）。
- **OUT-10 时序控制**：载体行数以保证 outline 到货窗口 ≥ 数百 ms 为准（复用 OUT-04 的 `waitForTimeout(1_200)` 轮询窗口口径反向使用）；「立即切 tab」后 plain.txt 的渲染就绪锚 `.vv-code-pre` 先行，再断右栏空态。
- **构建前置**：`pnpm --filter web build:e2e`（grammar 注入）；移动端形态随双 project 同参覆盖（OUT-03 编排责任备案同款）。
