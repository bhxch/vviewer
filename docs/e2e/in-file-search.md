# 文件内搜索（M3/M4） — e2e 场景

> 来源：`docs/e2e-test-report-2026-10-08.md`（被测版本 `main` @ `a47148114dd4962b1b32bcf3fe190702356fb3c8`）。本档为该报告 in-file-search 域内容的忠实转写，不引入报告之外的行为声明。
> 证据目录：`.temp/e2e-artifacts/in-file-search/`（14 张截图，报告 §3.1）；复核截图在 `.temp/e2e-artifacts/verify/`（复核会话 `vv-verify-in-file-search-FSEARCH-03`）。

## 1. 域描述与覆盖范围

本域验证文件内搜索面板：`/` 唤起、命中计数、`Enter`/`Shift+Enter`/`n`/`N` 键盘导航循环、`Esc` 关闭，覆盖五类视图——代码、3MB 虚拟滚动（分块路径）、markdown 渲染、HTML 源码、PDF，另含大小写敏感开关与无命中/清空边界。

报告 §4 功能完成度矩阵行原文摘录：

> in-file-search｜7 测试点｜通过 5｜缺陷 2（1 fail / 1 partial）｜受阻 0｜**基本完整**｜核心交互（/ 唤起、n/N 计数、Enter/Shift+Enter 循环、Esc）在代码/3MB 虚拟滚动/markdown 渲染/HTML 源码/PDF 五类视图全部精确工作（与 grep/pdftotext 吻合）；缺全部命中高亮（partial，BUG-18）与大小写开关（failed，BUG-23）。failed=FSEARCH-03、partial=FSEARCH-01（依域 summary 口径）

**逐点结果**（报告 §8.5 附录，7 点：5 pass / 1 partial / 1 fail）：

| 编号 | 测试点 | 结果 | 简要证据（摘自报告） |
| --- | --- | --- | --- |
| FSEARCH-01 | sample.ts 搜索：唤起/计数/导航/Esc/全部命中高亮 | partial | 计数 1/4 与 grep 吻合、Enter/Shift+Enter/Esc ✓；仅当前行行级高亮（BUG-18）→ 01-search-point-1of4.png、01b-only-current-line-highlight.png、01-after-esc.png |
| FSEARCH-02 | 3MB 文本稀疏 10 命中：分块搜索兼容虚拟滚动 | pass | 计数 1/10；Enter 步进 ≈70700px 与样例间距逐一吻合 → 02-3mb-open.png、02-hit-10of10.png |
| FSEARCH-03 | 大小写敏感开/关切换 | fail | 无开关控件、固定不敏感（BUG-23）→ 03-case-insensitive.png |
| FSEARCH-04 | markdown 渲染视图搜索：mark 高亮/滚动/退出还原 | pass | 6 个 mark、active 转移、Esc 后还原无损 → 04-md-mark-active.png |
| FSEARCH-05 | HTML 源码视图搜索标签名 | pass | 计数 1/3 与 grep -c 吻合、跳转正常 → 05-html-source-search.png |
| FSEARCH-06 | PDF 内搜索命中计数与页跳转 | pass | 计数与 pdftotext 吻合；3 页 PDF 跨页跳转到位 → 06-pdf-1of1.png、06b-multipage-gamma.png |
| FSEARCH-07 | 无命中不报错与清空恢复 | pass | 「无结果」+Enter 无异常；清空恢复、Esc 关闭 → 07-no-hit.png、07-after-clear.png |

通过/缺陷情况：

- **5 pass / 1 partial / 1 fail**：partial=FSEARCH-01（对应 **BUG-18**，medium · verified——无全部命中高亮与词级高亮，仅当前命中行有行级淡黄背景）；fail=FSEARCH-03（对应 **BUG-23**，low · verified——面板无大小写敏感开关，搜索固定大小写不敏感）。
- **高亮形态的域内差异**（均为报告实测，如实并陈）：代码视图仅当前命中行有 `vv-search-hit-line`（rgba(255,213,0,0.18)）行级背景（BUG-18）；markdown 渲染视图则有全部命中的词级 `<mark>`（FSEARCH-04 实测 6 个 mark，pass）。
- **跨域对照**（报告 §5 BUG-09 仲裁备注）：全局搜索点击命中行不滚动定位、无命中行高亮（BUG-09，涉及域 compute-global-search）；对照组文件内搜索 `/` 定位到位且命中行带 `vv-search-hit-line`，证明滚动定位+高亮能力存在——本域不因此新增缺陷点，该对照事实作为 BUG-18 验收的边界参考（见第 3 节）。
- **交叉验证**（报告 §6）：仓库自带 Playwright 套件 72 项中 1 项 flaky 为 `[mobile] › e2e/m3-search.spec.ts:107`「关闭后重开：搜索面板 closed 标志复位，重新搜索计数恢复」，失败于 `m3-search.spec.ts:124:50` 的 `.vv-search-input` toBeFocused 断言；套件注记明确该计时型 flaky 预先存在、勿归为新缺陷，与黑盒结论（FSEARCH 系列 5 pass，面板可唤起、计数与键盘导航全部精确工作）不矛盾。
- 本域 7 点编号齐全（FSEARCH-01~07），无续编点。

## 2. 场景清单

统一前置：vviewer 主实例已启动（`vviewer serve --root .temp/e2e-data --web-dist apps/web/build --port 8391 --compute`，报告 §2.2），浏览器（agent-browser 独立会话）已连接服务器并加载文件树。编号沿用报告测试点编号 FSEARCH-01~07。

| 编号 | 前置条件 | 步骤 | 期望 | 关联缺陷 |
| --- | --- | --- | --- | --- |
| FSEARCH-01 | 连接服务器；打开 `samples/m2/sample.ts`（内容含 4 处 `Point`，基准 `grep -o Point \| wc -l` = 4，报告 BUG-18 复现步骤） | 1) 焦点在预览区按 `/` 唤起搜索面板，输入 `Point`；2) 读面板计数；3) 以 TreeWalker 遍历 4 个命中文本节点，检查其父元素的 className 与背景色，并在全 DOM 检索 `mark` 及搜索类元素；4) 读当前命中行的 className 与背景色；5) 连按 Enter×4、再 Shift+Enter，观察计数游标与滚动定位的循环；6) 按 Esc 关闭面板；7) 各状态截图存证 | `/` 唤起面板；计数 1/4（与 grep 基准精确吻合）；Enter 跳下一个、Shift+Enter 跳上一个、循环正确；Esc 关闭；**全部 4 处命中均有可见高亮**。现状实测：计数/导航/Esc 全部正确，但 4 个命中文本节点父元素均为纯语法高亮 span（背景透明、无搜索类），全 DOM 无 mark/词级高亮元素，仅当前命中行有 `vv-search-hit-line`（rgba(255,213,0,0.18)）行级背景，其余 3 行完全无高亮 → partial | BUG-18（现状 partial：全部命中高亮与词级高亮缺失） |
| FSEARCH-02 | 连接服务器；数据集含 3MB 长文本样例（域内另造，报告 §2.3「3MB 长文本×2」；查询词全文恰 10 处，构造与校验见第 4 节） | 1) 打开 3MB 长文本（确认为分块+虚拟滚动渲染路径）；2) 按 `/` 输入查询词，读计数；3) 连续按 Enter 从第 1 处步进到第 10 处，逐次记录滚动位置（scrollTop/视口行）变化；4) 将各次步进的滚动距离与样例中相邻命中的物理间距逐一比对 | 计数 1/10；每次 Enter 精确步进到下一命中（报告实测步进 ≈70700px、与样例间距逐一吻合）；搜索兼容分块+虚拟滚动路径，无丢命中、无错位、滚动定位到位 | — |
| FSEARCH-03 | 连接服务器；数据集含 `case-test.txt`（AlphaCase×2 + alphacase×2 + ALPHACASE×1 + AlPhAcAsE×1，共 6 处基准）与 FSEARCH-02 的 3MB 样例 | 1) 按 `/` 唤起面板，以 snapshot 枚举面板内全部控件；2) 打开 case-test.txt，分别以 `AlphaCase`、`alphacase`、`ALPHACASE`、`AlPhAcAsE` 四种形式查询，逐一记录计数；3) 在 3MB 样例上分别查 `zzneedleqz`、`ZZNEEDLEQZ`、`ZzNeedleQz`，记录计数；4) 阴性对照：查不存在的 `nonexistentzz`；5) 以 `rg`/`curl` 独立校验文件内实际命中基准 | 面板存在大小写敏感开关，且开/关切换时命中数随之变化（区分口径下 case-test.txt 四种查询应为 2/2/1/1）。现状实测：面板仅 input+计数+3 按钮、无任何开关控件；四种查询均返回 1/6、3MB 样例三种写法均 1/10（固定不敏感）；阴性对照无结果，证明搜索本身工作 → fail | BUG-23（现状 fail：无大小写开关，固定不敏感） |
| FSEARCH-04 | 连接服务器；打开某 markdown 文件的渲染视图（报告未指名载体文件，门槛：所选查询词在渲染正文中命中 6 处，载体选择见第 4 节） | 1) 打开 markdown 渲染视图；2) 按 `/` 搜索该词；3) 统计渲染 DOM 中 `mark` 元素数量；4) 连按 Enter，观察 active 高亮（当前命中标记）是否逐个转移；5) 按 Esc 退出搜索；6) 检查退出后渲染内容还原无损（mark 清除、正文与搜索前一致） | 渲染视图中全部命中以词级 `mark` 高亮（报告实测 6 个 mark）；active 随 Enter 逐个转移；Esc 退出后还原无损 | — |
| FSEARCH-05 | 连接服务器；打开 HTML 文件并切「源码」视图（报告未指名载体文件，门槛：所搜标签名 `grep -c` = 3，载体选择见第 4 节） | 1) 打开 HTML 文件，切到源码视图；2) 按 `/` 搜索该标签名；3) 读面板计数；4) 按 Enter 观察跳转定位 | 计数 1/3，与 `grep -c` 吻合；Enter 跳转到下一命中、定位正常 | — |
| FSEARCH-06 | 连接服务器；数据集含 PDF（域内另造 3/6 页 PDF，报告 §2.3；本场景用 3 页样例） | 1) 以 `pdftotext` 提取 PDF 全文，确认查询词命中数作为基准；2) 在 vviewer 中打开该 PDF；3) 按 `/` 搜索该词，读计数并与基准比对；4) 按 Enter 逐个步进，观察跨页跳转是否到达命中所在页与位置 | 命中计数与 pdftotext 基准吻合（报告实测单命中样例 1/1）；3 页 PDF 上 Enter 跨页跳转到位 | — |
| FSEARCH-07 | 连接服务器；任一已打开的预览文件 | 1) 按 `/` 唤起面板，输入一个文件中不存在的词；2) 检查面板提示与页面状态（有无报错/异常卡片）；3) 在无结果状态下按 Enter；4) 清空输入框；5) 按 Esc 关闭 | 无命中时显示「无结果」类提示、无任何异常；无结果时按 Enter 无异常；清空输入后恢复（可重新搜索）；Esc 正常关闭 | — |

## 3. 关联缺陷的验收行为

### BUG-18【medium · verified】文件内搜索无全部命中高亮与词级高亮，仅当前命中行有行级淡黄背景

**缺陷现状**（报告 §5 BUG-18 条目、§8.5 FSEARCH-01）：

- 涉及域 in-file-search，对应测试点 FSEARCH-01（单点）。载体 `samples/m2/sample.ts`（`grep -o Point | wc -l` = 4）。
- 达标面：计数 1/4 与 grep 精确吻合；Enter 下一个/Shift+Enter 上一个/Esc 关闭的导航循环全部正确。
- 缺陷面：4 个 `Point` 命中文本节点父元素均为纯语法高亮 span（背景透明、无搜索类），全 DOM 无 `mark`/词级高亮元素；仅当前命中行有 `vv-search-hit-line`（rgba(255,213,0,0.18)）行级背景，其余 3 个命中行完全无高亮。
- 复核会话独立复现，行级类名与色值与报告分毫不差（`01-search-point-1of4.png`、`04-nav-3of4.png`）；一次中间查询 hit-line=0 的瞬态疑为防抖/虚拟滚动重渲染时序，重做干净流程后稳定复现，不影响结论。
- 仲裁备注：medium——搜索唤起/计数/导航/当前行定位全部可用，可经 n/N 逐个跳转绕过，非错误结果。与 BUG-09 不同根因：BUG-09 是全局搜索跳转未接入已有能力，本条是文件内搜索自身无全部命中高亮。

**修复后应有行为**（回归验收判据，取自报告 BUG-18「期望」字段：全部 4 处命中可见高亮，n/N 计数正确，Enter 下一个/Shift+Enter 上一个/Esc 关闭）：

1. 重做 FSEARCH-01 场景：sample.ts 中 4 处 `Point` 命中**同时全部**有可见高亮——或为词级高亮元素（如 `mark`/搜索类），或为覆盖每一命中行的行级高亮；不再只有当前命中行有背景。
2. 当前命中与全部命中的视觉可区分（active 形态随 Enter/Shift+Enter 转移到对应命中处）。
3. 既有正确行为不回退：计数 1/4 与 grep 吻合；Enter 下一个、Shift+Enter 上一个、首尾循环正确；Esc 关闭。
4. 复测注意报告记录的瞬态：若一次查询 hit-line 数为 0，先重做干净流程（重开文件→再搜索）再下结论（报告判定该瞬态为防抖/虚拟滚动重渲染时序，非稳定行为）。
5. 边界参考（不作为本条验收项）：markdown 渲染视图的全部命中词级 mark（FSEARCH-04，6 个 mark）为现行已达形态；BUG-09 属全局搜索跳转未接入（涉及域 compute-global-search），其修复验收不在本域。

### BUG-23【low · verified】文件内搜索面板无大小写敏感开关，搜索固定大小写不敏感

**缺陷现状**（报告 §5 BUG-23 条目、§8.5 FSEARCH-03）：

- 涉及域 in-file-search，对应测试点 FSEARCH-03（单点）。
- 面板控件现状：仅 input+计数+3 按钮，snapshot 枚举无任何开关控件。
- 数据证据：case-test.txt（AlphaCase×2/alphacase×2/ALPHACASE×1/AlPhAcAsE×1，基准 6 处经 rg 与 curl 确认）上四种大小写形式查询均返回 1/6（若区分应为 2/2/1/1）；3MB 样例上 `zzneedleqz`/`ZZNEEDLEQZ`/`ZzNeedleQz` 均 1/10；阴性对照 `nonexistentzz` 无结果，证明搜索工作但固定不敏感。
- 复核会话 `vv-verify-in-file-search-FSEARCH-03` 独立复现；文档核对：README:30 未承诺文件内搜索有大小写开关，设计规格 L256 的大小写开关针对全局搜索（全局面板实有 Aa 开关且工作正常）。截图 5 张。
- 仲裁备注：low——结果为不误导的超集、核心搜索可用，文档未对该功能承诺开关，属体验/细节级缺失。与 BUG-21 不同面板不同缺陷：全局搜索有大小写开关而缺 glob，文件内搜索反之。

**修复后应有行为**（回归验收判据，取自报告 BUG-23「期望」字段：存在大小写敏感开关，开/关时命中数变化）：

1. 重做 FSEARCH-03 步骤 1：文件内搜索面板 snapshot 枚举到大小写敏感开关控件（input、计数与既有按钮之外新增）。
2. 开关关闭（不敏感，现行默认行为）时：case-test.txt 四种查询仍均 1/6，3MB 样例三种写法仍均 1/10（现行行为不回退）。
3. 开关打开（敏感）时：case-test.txt 上 `AlphaCase`=2/6、`alphacase`=2/6、`ALPHACASE`=1/6、`AlPhAcAsE`=1/6（即报告给出的 2/2/1/1 区分口径）。
4. 开/关切换后计数即时随口径变化，且切换后导航（Enter/Shift+Enter）在新的命中集合上工作。
5. 阴性对照不回退：不存在的词仍无结果、无异常（FSEARCH-07 行为保持）。

## 4. 测试数据与边界

**运行前置**（报告 §2.1/§2.2）：

- 主实例：`vviewer serve --root .temp/e2e-data --web-dist apps/web/build --port 8391 --compute`；`/api/health` 应返回 `capabilities=["file-server","compute"]`。
- 本域无 grammar 资产依赖（不涉及语法高亮引擎选择；代码视图中命中行呈现为纯语法高亮 span 属现状观察，见 BUG-18）。

**本域载体与构造**：

| 文件 | 用于 | 说明与构造 |
| --- | --- | --- |
| `samples/m2/sample.ts` | FSEARCH-01 / BUG-18 | 数据集基础样例（报告 §2.3：m2 含 sample.md/.pl/.rs/.ts）。判据基准：内容含 4 处 `Point`（`grep -o Point \| wc -l` = 4，报告 BUG-18 复现步骤给定）。若所用样例不满足该基准，先调整内容至恰 4 处再测 |
| 3MB 长文本 | FSEARCH-02 / FSEARCH-03 | 域内另造样例（报告 §2.3「3MB 长文本×2」，存于 `.temp/e2e-data/domain-<域名>/` 惯例位置）。报告未给文件名；从证据可确知所用查询词全文恰 10 处（FSEARCH-02 计数 1/10；BUG-23 中 `zzneedleqz` 三种写法均 1/10，且与 FSEARCH-02 同为 3MB 样例 1/10 口径）。构造：生成约 3MB 多行文本，埋入 10 处 `zzneedleqz`，使相邻命中间距可产生报告量级的步进（实测相邻步进 ≈70700px，为稀疏分布）；以 `rg -i` 校验恰 10 处。词的大小写分布报告未指明，复测自定即可（不敏感口径计数不变） |
| `case-test.txt` | FSEARCH-03 / BUG-23 | 报告 BUG-23 复现步骤给定的构成：`AlphaCase`×2 + `alphacase`×2 + `ALPHACASE`×1 + `AlPhAcAsE`×1，共 6 处。构造后以 `rg`/`curl` 校验基准 6 处（报告复核手法） |
| markdown 渲染载体 | FSEARCH-04 | 报告未指名载体文件。门槛：所选查询词在渲染正文命中 6 处（实测 6 个 `mark`）。可复用数据集 md（如 `samples/m6/sample-gfm.md` 或 `samples/m3/demo.md`），不满足 6 处时按第 2 节门槛在文件中补足该词后复测 |
| HTML 源码载体 | FSEARCH-05 | 报告未指名载体文件。门槛：所搜标签名 `grep -c` = 3（实测计数 1/3）。可复用 `samples/m3/page.html` 并选取恰 3 处的标签名，或自造 |
| 3 页 PDF | FSEARCH-06 | 域内另造样例（报告 §2.3：3/6 页 PDF）。基准以 `pdftotext` 提取全文统计查询词命中数；报告实测含单命中样例（1/1，`06-pdf-1of1.png`）与 3 页多命中跨页样例（`06b-multipage-gamma.png`），复测按此两档构造 |
| 任意已打开文件 | FSEARCH-07 | 无特定数据要求；无命中词自选（报告阴性对照词 `nonexistentzz` 可复用） |

**边界与注意事项**（报告证据与复核要点，如实转写）：

- **计数口径**：命中计数以外部基准校验——文本/代码对 `grep`（复核用 `rg`/`curl`），PDF 对 `pdftotext`；报告矩阵行口径即「与 grep/pdftotext 吻合」。
- **行级高亮样式基线**：当前命中行类名 `vv-search-hit-line`、背景 rgba(255,213,0,0.18)（BUG-18 实测、BUG-09 对照组同样证实）。验收 BUG-18 修复时以此区分「行级」与「词级/全部命中」两种形态。
- **瞬态 hit-line=0**：BUG-18 复核中一次中间查询 hit-line=0，疑为防抖/虚拟滚动重渲染时序；重做干净流程后稳定复现。复测遇到该瞬态先重做流程，勿直接判 pass 或新增缺陷。
- **Playwright flaky 区分**（报告 §6）：`m3-search.spec.ts:107`（mobile 项目，「关闭后重开」用例）失败于 `:124:50` 的 `.vv-search-input` toBeFocused，为预先存在的计时型焦点 flaky；黑盒已证面板唤起/计数/导航功能正常，复测套件失败时先区分该已知 flaky，勿归为新缺陷。
- **面板控件基线**（BUG-23 现状）：文件内搜索面板为 input+计数+3 按钮；全局面板（Ctrl+Shift+F）才有 Aa 大小写开关——验收 BUG-23 时勿混淆两个面板。
- **域内高亮形态差异**：代码/源码视图当前仅当前命中行行级高亮（BUG-18），markdown 渲染视图为全部命中词级 mark（FSEARCH-04）——两者均为报告实测现状，各自场景按各自期望判定，勿以一方形态去判另一方。
- **报告未指名载体的处理**：FSEARCH-04/05 的载体文件与 FSEARCH-02 的 3MB 文件名报告均未给出（属域内另造样例）；复测按本节门槛与构造方式自备，判据以场景期望列为准，不依赖具体文件名。

---

*本档仅转写报告内已有内容；报告中未覆盖或未定论的项（如各另造样例的确切文件名与词表大小写分布）已如实标注，未做补充声明。*
