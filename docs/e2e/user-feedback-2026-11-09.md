# 用户反馈八项验收（UFB 域）

## 1. 来源与现状脚本

- 来源：2026-11-09 用户反馈八项（代码换行开关、手机 PDF 超宽、PPT 默认模式、PDF「Iterator is not defined」、Word 双渲染器、默认渲染器设置、缩窗右栏折叠钮消失、图片拖动）。
- 脚本：`apps/web/e2e/b-user-feedback.spec.ts`（UFB-01~08，默认套件双 project；按 project 分流的用例以 `test.skip` 声明适用面）。
- 夹具：`apps/web/e2e/pptx-fixture.ts`（运行时生成含 theme/slideMaster/slideLayout 的合法 pptx，不入库二进制；上游语料「presentation 组无小体量夹具」）；`png-fixture.ts` 的 `goodPng(w, h)` 参数化出大图；PDF 用 spec 内 `buildPdf(pages, w, h)` 现地构造（横向 842×595 发票页）。
- 触屏手势：CDP `Input.dispatchTouchEvent` 合成（mobile project hasTouch），单指=拖动、双指=捏合。

## 2. 根因与修复对照

| # | 现象 | 根因 | 修复提交 |
| --- | --- | --- | --- |
| 1 | 代码没有自动换行开关 | 代码视图为固定行高虚拟滚动，`.vv-code-line { white-space: pre }`，无换行设置 | core `variableScroller`/`RowHeights`（ee308fa、d30d2e0）、render-text `wordWrap`/`setWordWrap`（baa0db4）、设置「代码视图」/状态栏「换行」/Alt+Z（9ad8bd2） |
| 2 | 手机上 PDF 100% 超宽，横向发票看不到左半边、拖不动 | 100% = 1pt:1px（842pt 横向页 > 375px）；`.vv-pdf-pages` 以 `align-items:center` 居中，页宽超容器时左侧溢出落在负滚动区永远不可达 | a769db5（auto 默认适宽且封顶 100%、「适应宽度」按钮、左右 auto margin 居中、缩放保持阅读位置） |
| 3 | PPT 默认是大纲模式 | `.pptx` 绑定自研文本提纲渲染器；可逐页还原的 foreign 演示文稿渲染器刻意不绑 pptx | ccdea50（演示文稿拥有 pptx，提纲降为候选）；3b37296（引擎解析失败时错误卡给「以 PowerPoint（文本提纲） 打开」兜底与可读文案） |
| 4 | 电脑上 PDF 报「无法预览此文件 Iterator is not defined」 | 浏览器版本低（Chrome/Edge<122、Firefox<131、Safari<18.4 无全局 Iterator）：pdfjs-dist 6.4.299 现代构建模块顶层 `typeof Iterator.prototype.join` 求值即抛 ReferenceError | 03fe011（主模块/worker 改 legacy 构建，core-js 先注册全局 Iterator；加载失败不入单例） |
| 5 | Word 分成「Word 文档」与「（兼容格式）」两个 | 两个渲染器：mammoth 语义 HTML（丢版式，.docx 默认）与 docx-preview 系版式还原（原只绑 doc/rtf/odt 等） | ccdea50（版式还原拥有 docx、label 澄清为「版式还原」/「简化视图」） |
| 6 | 多渲染器格式无法设置默认渲染器 | 注册表每扩展名单一所有者，无偏好机制 | 3326018（`altExtensions` 候选 + `registry.setPreferenceResolver` + 设置「打开方式」节 + `rendererDefaults`） |
| 7 | 缩窄窗口后左栏自动折叠，右栏折叠钮不见了 | 601–900px 段左栏转抽屉，右栏仍在主区，但折叠钮/竖条/`.vv-right-off` 只在 >900px 生效，ℹ 右抽屉只在 ≤600px 出现——该段右栏无任何收起入口 | 10ceaf8 |
| 8 | 打开图片后能滚轮缩放，但鼠标/触屏拖动都移不动 | 图片查看器只写 `transform: scale`（不改布局尺寸、滚动区不增长）且无拖动平移；灯箱平移只挂 mouse 事件 | 981a788（布局缩放 + 容器滚动、Pointer Events 拖动/捏合）、acec3c6（灯箱 Pointer Events + 捏合 + touch-action） |

## 3. 场景清单

| 编号 | 场景 | 适用 project |
| --- | --- | --- |
| UFB-01a | 状态栏「换行」开关：关→开（无横向溢出、长行多视觉行、相邻行不重叠）→关 | 双 |
| UFB-01b | 设置中心「代码视图」勾选应用后已打开视图即时换行；刷新后新打开视图仍换行 | 双 |
| UFB-01c | Alt+Z 切换换行；Ctrl+Alt+Z 进专注模式不误触换行 | chromium |
| UFB-01d | 换行模式滚到底末行可达；搜索跳转命中行落在视口内 | 双 |
| UFB-02a | 842×595 横向页默认适宽（<100%）、整页在视口内；放大溢出后 scrollLeft=0 左缘可达；「适应宽度」页宽≈容器内容宽 | mobile |
| UFB-02b | 放大溢出、停在最右后手指往右拖：scrollLeft 随手势减小，拖到 0 时页面左缘进入视口 | mobile |
| UFB-02c | 桌面竖页（600pt）仍 100% | chromium |
| UFB-03a | 真结构 pptx 落演示文稿逐页渲染（`.pptx-viewer-shell` + `.slide`），打开方式可切回文本提纲 | chromium |
| UFB-03b | 极简 pptx（无 theme，引擎解析失败）错误卡文案可读（非「[object Object]」）+「以 PowerPoint（文本提纲） 打开」兜底可用 | chromium |
| UFB-04 | 删除全局 Iterator 后 PDF 照常渲染、无错误卡；加载后全局 Iterator 由 legacy 构建补回 | 双 |
| UFB-05 | docx 落版式还原（`.docx-wrapper`）；打开方式列出两个可区分的 Word 渲染器并可切简化视图 | chromium |
| UFB-06 | 设置「打开方式」列出 csv/docx/pptx/xls/xlsm/xlsx；改 .docx 默认即生效、单标签手选优先、改回内置默认恢复 | chromium |
| UFB-07a | 800px：左栏抽屉化、右栏折叠钮可见可用（折叠→右竖条展开） | chromium（自设视口） |
| UFB-07b | 桌面折叠右栏后缩窄到 800px：右栏保持折叠 | chromium（自设视口） |
| UFB-07c | ≤600px 右抽屉形态（无折叠钮、ℹ 在）；桌面双折叠钮在 | chromium（自设视口） |
| UFB-08a | 大图鼠标拖动：scrollLeft/Top 随拖动增长 | chromium |
| UFB-08b | 小图滚轮放大后可拖动平移 | chromium |
| UFB-08c | 触屏单指拖动平移、双指捏合放大 | mobile |
| UFB-08d | markdown 灯箱触屏拖动：stage translate 随单指位移且不误关 | mobile |

## 4. 判别力核验（修复前基线 RED）

以修复前提交 76e6ef8 在隔离副本构建并伺服 4173，用本 spec 直跑：20 failed / 3 passed（UFB-02c、UFB-07c 为回归护栏本应通过；初版 UFB-02b 只测可达方向横扫亦通过，已改为「往右拖看左半边」后基线红：页面左缘停在 −233.5px）。失败原因逐条对应原始缺陷，其中 UFB-04 基线错误卡原文即用户所报「无法预览此文件 Iterator is not defined report.pdf」。修复后构建：23 passed / 15 skipped（按 project 分流）。

## 5. 相关既有锚的随迁

- MEDIA-01（t-media / b-media-office-viewer）：倍率读数面由 `transform: scale()` 改为 `img[data-vv-zoom]`，并加布局宽度断言。
- MEDIA-07：首屏断言 auto 适宽值（桌面 100% / mobile <100%）后 ＋ 回 100% 走原锚链。
- FSEARCH-06：顶对齐判据纳入「已滚到底」（mobile 适宽后末页无足够后续内容贴顶）。
- m4 office、MEDIA-08/10、FOM-NEST-05：锚 vviewer 自有 mammoth/提纲渲染器，经 `rendererDefaults` 偏好选用。
- b-settings-center：分组清单新增「代码视图」「打开方式」。
