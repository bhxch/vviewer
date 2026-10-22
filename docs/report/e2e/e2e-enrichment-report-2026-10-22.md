# e2e 补强批次独立复核报告(2026-10-22 批次,复核日期 2026-10-23)

复核人:独立复核员(未参与本轮任何编写与修复)。复核纪律:全部结论以本会话实读文件/实跑命令为证;除本报告外未修改任何文件;未执行 git add/commit/push(复核前后 `git status --porcelain` 两次比对一致:6 个跟踪文件修改 + 9 个未跟踪新文件)。

---

## 1. 概览

| 项 | 值 |
| --- | --- |
| 范围 | 8 域 / 107 用例 / 9 个新文件(8 spec + 1 语料下载脚本)+ 语料基建(fetch 脚本接入 ci.yml、.gitignore、门禁 env)+ 双侧产品修复与保护单测 |
| 用例数对账 | 8 个新 spec 静态 `test(` 计 79 个,其中 b-md-corpus-markpad 两组为 for..of 程序化生成(批量模板 1 → 27 例、汇总锚模板 1 → 3 例),运行时合计 10+9+36+10+12+9+10+11 = **107,与声称精确吻合**(rg 实测) |
| 门禁复核 | 四项门禁全部本会话独立复跑通过(见第 3 节);无断言放宽、无覆盖造假 |
| 裁决 | **PASS**(0 blocking;4 条 notes 见第 5 节) |

本轮实质产出三层:

1. **产品修复(双侧同源)**:`protectLatexDelimiters`(前端)与 `apply_latex_delimiters`(Rust)数学定界符态由「字符缓冲至闭合/EOF 回填」改为「内容流式直出、闭定界符在闭合处补写」,消除未闭合 `\[` 吞掉数百行正文结构的缺陷。
2. **真实语料测试维度**:27 个 bhxch/Markpad 真实 md 文件经 `tools/fetch-e2e-corpus.mjs` 拉取(不入库,sha256+git blob sha 双校验清单),驱动批量稳定性 + 深断言 + 汇总锚三类用例。
3. **六个既有域的补强 spec**:语法负路径/灯箱导出边界/字体/布局 zen/设置中心/目录挂载。

## 2. 分域用例清单与意图

### 2.1 b-syntax-deep.spec.ts(SY-01~SY-11,359 行,11 用例)

扩展语法(KaTeX/扩展语法域)负路径与组合交互:callout 折叠后缀保守解析(+x/负号正文)、未知类型兜底、折叠方向与多卡独立、折叠标题内 wikilink 锚跳组合、wikilink 上下文混排、空脚注边界、金额 `$` 与转义 `\$`、mhchem 块级 + 非法段容错、代码豁免面组合、无语言代码块徽标复制、CRLF 回归锚。抽读 SY-01~05 实现段(b-syntax-deep.spec.ts:38-169):断言为结构 + 交互语义双面(点击收起/展开、hash 收口 `#user-content-`、`toBeInViewport`),夹具全内联,断言强度足额。

### 2.2 b-md-lightbox-export-deep.spec.ts(LE-01~LE-12,490 行,12 用例)

灯箱与导出域边界:同 src 元素身份定位(5-5 修复面)、图表 svg 直开、输入守卫、a11y 基线(focus spy 观察装置)、缩放限幅边界(0.2–8 按 1.25/0.8 幂精确推得按键数)、kroki img 画廊、点击关闭语义负路径(T1 裁决)、移动端全按钮链、媒体占位组合、暗色导出 WYSIWYG 双标(LE-10)、非 markdown 视图族句柄清空、大文档导出 60s 时长锚(chromium-only)。

### 2.3 b-md-corpus-markpad.spec.ts(MC-01~MC-36,396 行,36 用例 = 27 批量 + 9 手写)

全新真实语料维度。批量组 MC-01~27 逐文件稳定性锚(`.vv-markdown` 可见 + 零 pageerror + 零错误卡);深断言组 MC-28~33 以语料实有结构计数锚高亮/图表矩阵/callout/脚注/wikilink 分流/编码稳定性;汇总锚 MC-34~36 分 3 批聚合 console error 白名单外为零(白名单仅 kroki 装置边缘、语料相对图片 404 契约降级、favicon 三项,逐项注明理由)。逐用例 `fs.existsSync` 对语料缺失容错 skip。

### 2.4 b-md-diagrams-deep.spec.ts(DM-01~DM-09,380 行,10 用例)

图表域深断言:kroki URL 编码端到端可逆(DM-07)、mermaid 主题联动就地重画(DM-08)、多图性能锚 12 围栏 45s 全终态/引擎 chunk 恰一次/kroki 每围栏恰一次(DM-09)等。

### 2.5 b-fonts-deep.spec.ts(FNT-01~FNT-10,593 行,10 用例)

字体域:字号 clamp 边界与 j 步长联动(FNT-01)、脏 localStorage 字段级归位、行高公式边界、网络字体全链、IDB 持久化、名称门禁与撞车过滤(FNT-08)等。clamp 范围(10–28/9–28)与设计基线 `docs/superpowers/specs/2026-10-19-font-system-design.md:36-38` 一致。

### 2.6 b-layout-zen-deep.spec.ts(LZ-09~LZ-16 等 9 用例,480 行)

布局 zen 域:拖拽实时预览途中不落盘、松手才写(LZ-09,与设计 `2026-10-19-layout-zen-design.md:42`「拖动实时预览、松手落盘」一致)、折叠持久化、zen 进出、渲染器双入口接力(LZ-14)等。

### 2.7 b-mounts-deep.spec.ts(MM-11~MM-19,866 行,9 用例)

目录挂载域:降级重探转健康(MM-11)、Range 防线(MM-17,设计 `2026-10-19-directory-mounting-design.md:36,82`)、直连凭据轮换(MM-18)、删除使用中挂载组合(MM-19)等。组①「在树中打开」/组②「打开」两操作语义与设计 §3(:89-91)一致。

### 2.8 b-settings-center-deep.spec.ts(SC-10~SC-19,539 行,10 用例)

设置中心域:图表组表单管线整词锚定(SC-10)、导入合并字段级语义(SC-11,与设计 `2026-10-19-settings-center-design.md:90`「节内字段级 + diagrams.modes 键级合并」勘误口径一致)、三方共存、存储矩阵与引用回落(SC-16,设计 :69)、导出往返(SC-17)等。

## 3. 门禁证据(全部本会话复跑,非转述)

| 门禁 | 命令 | 结果 | 结论 |
| --- | --- | --- | --- |
| typecheck | `pnpm typecheck` | svelte-check found 0 errors and 0 warnings;`TYPECHECK_EXIT=0` | ✅ |
| vitest 全量 | `pnpm test` | **119 test files / 1768 tests 全部 passed**,Duration 31.71s;`VITEST_EXIT=0` | ✅ |
| Rust 单测 | `cargo test --manifest-path server/Cargo.toml -p vviewer-core --lib markdown` | **17 passed**(含新增 `latex_delimiters_unclosed_display_keeps_fence_lines_intact`) | ✅ |
| playwright 全量 | `VV_GRAMMAR_CDN=https://cdn.grammars.test/grammars/ pnpm --filter web build`(exit 0,precache 166 条)→ `pnpm --filter web exec playwright test` | **866 passed / 5 flaky(retries=1 兜底后绿)/ 65 skipped / 0 failed,7.7m;`PW_EXIT=0`** | ✅ |

flaky 明细(重试后全绿,不计失败):MM-08(chromium,既有 spec)、LZ-14(mobile,本轮新 spec)、OPEN-01/03/08(mobile,既有 t-open-with)。

### 3.1 语料真实渲染计数探针(复核员自建 /tmp playwright 直连探针,preview + chromium 实测 DOM)

| 语料 | spec 断言 | 探针实测 | 一致性 |
| --- | --- | --- | --- |
| all_languages_test.md(MC-28) | `pre code`=279、`.md-diagram`=3 | preCode=279、diagram=3 | ✅ |
| demo_features.md(MC-29) | `.md-diagram`=12、kroki img=6、`.md-diagram-view .katex-display`=3、全文 katex-display=7、front matter 不泄漏 | diagram=12、krokiImg=6、viewKatexDisplay=3、katexDisplayTotal=7、Markpad Team 不在正文;**svgTotal=6(3 图形引擎 + 3 math 装饰性 svg,与修复声称的探针口径吻合)** | ✅ |
| stress-test.md(MC-31) | `pre code`=72、`.md-diagram`=3、svg=3、表格 ≥5 | preCode=72、diagram=3、diagramSvg=3、tables=66 | ✅ |
| markdown-syntax.md(MC-32) | `.md-wikilink-dead`=3、`a[data-wikilink]`=2 | dead 恰 3:`[[not a wikilink]]`(P 内裸文本)+ L323 + L324 两条跨文件;anchor 恰 2(`[[#1. Text]]`/`[[#^demo-block]]`);code 内 12 处 `[[` 字样全部保持字面(豁免实证) | ✅(归因注释有误,见 5.2) |

## 4. 问题与修复(逐项核验)

### 4.1 产品修复:数学定界符态双侧同源(核验通过)

- 前端 `packages/render-text/src/markdown/engine.ts`:删除 `mathContent` 缓冲(原 :149/:192-215 区域),display/inline 数学内容 `out += ch` 流式直出,闭合处补写 `$$`/`$`;换行恒 `out += '\n'`。闭合场景输出与旧实现逐字符一致(顺序等价:开定界符 → 内容 → 闭定界符);未闭合场景开定界符已消耗、内容原样、结构保序。
- 服务端 `server/core/src/compute/markdown.rs` `apply_latex_delimiters` 同构修复(删 `math` 缓冲、`out.push(c)` 直出),注释双向互引。
- 依据实证:语料 `samples/stress-test.md:679` 确为字面 `\[ not a link`(行尾 hard-break 双空格,`sed -n '677,681p'` + `cat -A` 实读);该文件全文件 `^```` 标记行 148 个(rg 实测)。
- 保护单测双侧在位:前端 `markdownEngine.test.ts` 新增「未闭合 \[ 跨围栏」用例(diff 实读,闭合场景 `$$a\nb$$` 与未闭合场景围栏独立成行双断言;**既有断言零改动**,diff 仅 +11 行);Rust 侧新增 `latex_delimiters_unclosed_display_keeps_fence_lines_intact`(diff 实读,cargo 实跑通过)。**未发现任何既有断言被放宽或删除。**
- 修复效果闭环:修复前 MC-31 仅 11 个 `pre code`(正文被吞),修复后探针实测 72;MC-31 断言改为 72 的口径(74 fence token = text×60 + 语言×11 + mermaid×3,mermaid 走图表通道 74−3=71,+1 个 4 空格缩进代码块 = 72)与实测一致。

### 4.2 测试修复逐项核验(16 项,全部属实)

| 项 | 声称 | 复核证据 | 结论 |
| --- | --- | --- | --- |
| SC-10 | `hasText 'plantuml'` 子串误配 c4plantuml → 改 `^id$` 正则 | b-settings-center-deep.spec.ts:117-120,注释明示,`new RegExp(`^${id}$`)` | ✅ 修正选择器,断言未放宽 |
| SC-11 | diff 行期望 13 错误 → 改 `16 → 20` | :180-181 实读 `'fonts.uiSize: 16 → 20'`;产品 `apps/web/src/lib/stores/settings.ts:52` `uiSize: 16` 实证 | ✅ 修正断言错误(原错把 codeSize 默认 13 当 uiSize),非迁就回归 |
| SC-16 | 半角 `(1 条)` → 全角 `（1 条）` | :366/:375 实读全角括号,中文 UI 全角为正常排版 | ✅ |
| MC-34/35/36 | 补 `**/cdn.grammars.test/**` fulfill 空 manifest | b-md-corpus-markpad.spec.ts:114-120;门禁 env `VV_GRAMMAR_CDN` 在 ci.yml:99 实读确认(既有行);装置去噪,白名单未加 grammars 豁免 | ✅ 装置修复,不放宽白名单断言 |
| MC-28 | 282→279 + `.md-diagram` 恰 3 | :158-159;语料 `^\s*```\w` 计 282、dot/latex/mermaid 各 1(rg :285/:819/:939);探针实测 279/3 | ✅ 计数口径权威(dot/latex/mermaid 注册表接管有 diagrams.ts 实现背书) |
| MC-29 | 10→12 + svg 按 wrapper 归属逐引擎 | :190-208;语料图表围栏恰 12(rg 实测:mermaid/dot/nomnoml/math×2/latex/plantuml/vegalite/bpmn/svgbob/excalidraw/ditaa);`diagrams.ts:39` `aliases: ['latex']` 实证;探针 svgTotal=6 印证「katex 装饰性 svg 混入裸计数」 | ✅ 按引擎 wrapper 断言比裸 svg 计数更精确 |
| MC-31 | 37→72(标题同步) | :256-285 标题与断言均 72;探针实测 72;「标记行/2」旧口径(148/2=74)确不成立 | ✅ 权威口径 |
| MC-32 | wikilink-dead 2→3 | :307 断言 3;探针实测恰 3(但第三个来源与声称归因不同,见 5.2) | ✅ 断言值正确;归因注释误 |
| DM-07 | 期望剥尾改 BIG_SRC 原样 | :229-232 实读,注释更正 fence 夹具 content 尾双换行;`pipeline.ts:262` `replace(/\n$/, '')` 剥一个实证 | ✅ |
| FNT-01 | j 段前补 closeSettings、13.7 段前重开 | :120-124/:141-143 实读,注释还原 60s 超时根因(overlay 遮挡 actionability) | ✅ 装置时序修正 |
| FNT-08 | Roboto 断言移到 UI 槽 | :485-490 实读;`fonts.ts` mergedFamilyOptions `taken.has` 过滤实证(:77-85) | ✅ 槽位语义修正,撞车过滤断言保留 |
| MM-11/19 | `has .vv-mm-state` 甄别 + exact | :276-280/:834-840 实读 | ✅ |
| MM-17/18 | seed 补 onupgradeneeded 四 store 补建 | :74-123 seedMountRecord/seedSnapshot 实读(kv/themes/fonts/mounts) | ✅ flaky 装置修复,断言未动 |
| LZ-09 | 途中断言改 `toEqual({})` | :161/166/171 三处;松手落盘断言 `leftWidth:180`/`rightWidth:230/160`(:173/183/185)保留——锚「途中不落盘、松手才写」,与设计 :42 一致 | ✅ 修正错误期望而非放宽(落盘断言更严了) |
| LE-10 | 切暗前收抽屉 + openExportArea 幂等兜底 | :409-426 实读 | ✅ 装置修正,双标断言保留 |
| grammar-builder | 环境产物过期,零代码改动 | `build.mjs:302` `source: 'vendored'` 写入链在位;当前 `apps/web/static/grammars/manifest.json` vue 条目 `source: 'vendored'`(python3 实读);`pnpm vitest run tools/grammar-builder/test/build.test.ts` 复跑 **24 passed** | ✅ 定性成立且当前实证绿 |

## 5. 遗留与建议(notes,均不阻断)

1. **docs 验收表与 spec 修复后口径失同步**:`docs/e2e/markdown-html-docs.md` 第 7 节(diff 新增)MC-28 仍写「恰 282」、MC-29 仍写「10 图表围栏 → 10 `.md-diagram`」、MC-31 仍写「恰 37」,均为修复前旧值(spec 已改 279+3/12/72 且经探针实证)。该文档是后续维护的验收基线,建议随本批一并回写。
2. **MC-32 第三个 dead 的归因注释错误**:spec 注释与修复清单均称第三个 dead 为 L406 `[[sub/deep#Setup]]`;探针实证 L406 在行内码内被 CODE 祖先豁免保持字面(enrich.ts:225 `WIKILINK_SKIP_TAGS` 含 CODE),真正的第三个 dead 是 `markdown-syntax.md:83` 转义示例 `\[\[not a wikilink\]\]` 渲染剥转义后在 DOM 中新出现的 `[[not a wikilink]]`。断言值 3 本身正确且为严格计数,仅溯源注释需更正(转义剥除形态会「无中生有」出 wikilink,这一行为本身值得在后续轮次评估是否属 enrich 语义缺口)。
3. **playwright 5 例 flaky(重试兜底后全绿)**:其中 LZ-14 mobile 属本轮新 spec(mobile 视口时序),其余 4 例为既有 spec。建议后续对 LZ-14 mobile 做首跑稳定性观察;CI 单 worker 口径下此面收敛与否以 CI 实跑为准。
4. **CI 通道未实际验证**:fetch-e2e-corpus.mjs 的 GITHUB_TOKEN 注入与 CI 完整链需 merge 后 CI 实跑确认(本地已核脚本语义:幂等 skip、sha256+git blob sha 双校验、失败清单非 0 退出;本地语料 27 文件在位,manifest counts total=27/failed=0)。另注:批量组 MC-01~27 不挂 kroki mock(设计上只锚 pageerror/错误卡,无网环境不受影响),但本机有网时会向 kroki.io 发真实请求,属轻微环境不对称,可接受。
