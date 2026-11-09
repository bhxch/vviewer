# e2e 场景文档索引

## 1. 目的与来源

本目录（`docs/e2e/`）把 vviewer 首轮黑盒 e2e 评测的结果转写为可独立复现的场景文档，作为后续修复验收与回归执行的统一依据。唯一事实来源：

- 源报告：`docs/report/e2e/e2e-test-report-2026-10-08.md`（被测版本 `main` @ `a4714811`，2026-10-08）。
- 报告口径：**106 个测试点、10 个功能域**，全部实跑（无 skipped，1 点受阻 SHELL-07）；结果分布 72 pass / 24 partial / 9 fail / 1 blocked；最终缺陷 **26 条**（23 verified + 3 unconfirmed，唯一 high 为 BUG-01）；另载 10 条已裁决偏差（不计缺陷，报告 §2.4）。
- 各域文档只收录报告中有依据的内容（复现步骤、期望/实测、证据截图名），不补充报告之外的 spec 行为；verified / unconfirmed 的区分原样保留。
- 报告的证据目录（`.temp/e2e-data/` 测试数据、`.temp/e2e-artifacts/<域名>/` 截图）为评测当时存证；复测环境按各域文档第 4 节转录的数据清单与构造规格重建。

## 2. 域索引

| 域 | 文档 | 场景数 | 关联缺陷 |
| --- | --- | --- | --- |
| 应用外壳与文件来源（M1） | [app-shell-sources.md](app-shell-sources.md) | 14（SHELL-01~14，含续编 SHELL-14） | BUG-03、BUG-04、BUG-05、BUG-07、BUG-08、BUG-19、BUG-25 |
| 代码查看与高亮降级链（M2） | [code-highlight-degrade.md](code-highlight-degrade.md) | 11（HL-01~11） | BUG-04、BUG-06、BUG-07、BUG-20 |
| 主题三层与外观（M2/M7） | [theme-system.md](theme-system.md) | 7（THEME-01~07） | BUG-06（佐证观察，非本域缺陷） |
| Markdown 与 HTML 文档渲染（M3） | [markdown-html-docs.md](markdown-html-docs.md) | 13（MD-01~13） | BUG-06（现象归属）、BUG-17 |
| 文件内搜索（M3/M4） | [in-file-search.md](in-file-search.md) | 7（FSEARCH-01~07） | BUG-18、BUG-23 |
| 图片、音视频、PDF 与 Office（M4） | [media-office-viewer.md](media-office-viewer.md) | 11（MEDIA-01~11） | BUG-01、BUG-14 |
| hex/结构树与压缩包（M4） | [binary-hex-archive.md](binary-hex-archive.md) | 10（BIN-01~10） | BUG-12、BUG-13、BUG-16（跨域） |
| 后端档 1 文件服务（M5） | [server-file-service.md](server-file-service.md) | 13（SRV-01~13） | BUG-02、BUG-04、BUG-05 |
| 后端档 2 计算卸载与全局搜索（M6） | [compute-global-search.md](compute-global-search.md) | 12（CMP-01~12） | BUG-09、BUG-10、BUG-11、BUG-21、BUG-22 |
| PWA、移动端与性能预算（M7） | [pwa-mobile-performance.md](pwa-mobile-performance.md) | 9（PWA-01~09） | BUG-06、BUG-15、BUG-16、BUG-24、BUG-26 |
| **合计** | 10 份 | **107**（报告 106 测试点 + 续编 SHELL-14） | BUG-01~BUG-26 全部 26 条 |

域排序沿用源报告 §8 附录顺序；场景编号一律沿用报告测试点编号。首轮 10 域之外，后续特性 spec 驱动的域文档同落本目录（场景编号自成体系、与首轮测试点编号不连续，各域文档第 1 节载明 spec/plan 出处与现状脚本，体例同为「目的与来源 / 场景清单 / 验收行为 / 环境与数据」），不并入上表口径。

### 2.1 特性域文档（spec 驱动续编）

本轮测绘差距落库（2026-11-03）新增/补节的六域，以及 2026-11-04/07 五计划流水线与 2026-11-07 残余批的新特性补强新增的八域：

| 域 | 文档 | 场景编号 | 来源 spec |
| --- | --- | --- | --- |
| 渲染器自选与内容探测（更多渲染器/签名改派/编码精判） | [renderer-picker-signature-encoding.md](renderer-picker-signature-encoding.md) | OWM-01~07、SIG-01~04、ENC-01~02 | 2026-10-28-renderer-picker-signature-encoding-design.md |
| 侧栏多根与壳层动作（源头行/空态引导/徽标消歧） | [sidebar-shell-actions.md](sidebar-shell-actions.md) | SRC-01~08（FTSRC-01~04 既有域另收） | 2026-10-31-sidebar-roots-design.md |
| 图标主题与 Open VSX 通道 | [icon-themes-openvsx.md](icon-themes-openvsx.md) | ICON-01~09、OVX-01~05 | 2026-10-31-icon-themes-design.md |
| 代码大纲与右面板切换 | [code-outline-panel-switch.md](code-outline-panel-switch.md) | OUT-01~10 | 2026-10-31-code-outline-panel-switch-design.md |
| Git 信息面板 | [git-panel.md](git-panel.md) | GIT-01~12 | 2026-10-31-git-panel-design.md |
| 图表官方服务器档与 kroki 回落（diagram 域续编） | [diagram-server-kroki.md](diagram-server-kroki.md)（既有文档补节，不新建） | DSV-07a/07b、08~10（07 = DM-11/12 落库承接拆行） | 2026-10-23-renderer-lang-override-markpad-alignment-design.md §8 |
| file-viewer 桥接渲染器跨边界（嵌套附件回流/远端 R1/确认门/归档条目/CDN 资产失败收口） | [file-viewer-foreign-bridge.md](file-viewer-foreign-bridge.md) | FOM-NEST-01~05、FOM-REMOTE-01、FOM-CONFIRM-01、FOM-ZIP-01、FOM-CDN-01（9） | 2026-11-04-file-viewer-integration-design.md §6.1/§6.3/§6.4 + 计划 3/4（fv-plan3-foreign-wave1、fv-plan4-foreign-wave2） |
| 另存为管线与下载确认门（picker-first 顺序/无 FS Access 降级/取消语义/tee 降级面） | [save-as-pipeline.md](save-as-pipeline.md) | SAV-PROBE-02、SAV-DONE-CLOSE-01、SAV-CANCEL-PUMP-01、SAV-CANCEL-RENDER-01、SAV-PICKER-CANCEL-01、SAV-PICKER-FIRST-01、SAV-NOFSA-01、SAV-NOFSA-CONF-01、SAV-LOCAL-NOFSA-01、SAV-NORANGE-01、SAV-CONF-EQ-01、SAV-CONF-EQ-CTRL-01、SAV-CONF-UNKNOWN-01、SAV-CONF-LOCAL-01、SAV-CONF-KEY-01、SAV-CONF-KEY-02、SAV-MENU-CONF-01、SAV-MENU-CONF-02、SAV-MENU-STATUS-01、SAV-DISABLED-DIR-01、SAV-DISABLED-ERR-01、SAV-DEGRADE-WRITABLE-01、SAV-DEGRADE-WRITE-01（23） | 2026-11-04-file-viewer-integration-design.md §6.4 + 计划 2（fv-plan2-bridge-datasource） |
| pdf Range transport 补强（本地 1MB 阈值两侧读形态/memo 记忆/进度卡缺席断言/M1 失败收口） | [pdf-range-transport.md](pdf-range-transport.md) | PDFX-LOCAL-01~02、PDFX-MEMO-01~05、PDFX-CARD-01~02、PDFX-M1-01~02、PDFX-FIX-01（12） | 2026-11-04-file-viewer-integration-design.md §6.6（决策⑫）+ 计划 5（fv-plan5-pdf-range） |
| SW 运行时缓存路由与换版清理（URL→缓存族归属/产物层路由表/配额逐出/旧 REV 清理） | [sw-runtime-cache.md](sw-runtime-cache.md) | SWR-ROUTE-01~07、SWR-TABLE-01~02、SWR-MIRROR-01、SWR-EXP-01、SWR-CLEAN-01~03（14） | 残余 A7/A8（2026-11-07，commit 5694d93）+ `apps/web/vite.config.ts` runtimeCaching/genSwCleanup |
| SSE 变更后 size 回填（≤1MB 失效域/回填失败回落/多 tab 分组/缩小面/手动刷新通道） | [sse-size-backfill.md](sse-size-backfill.md) | STR-NEST-01、STR-BACKFILL-01~03、STR-SHRINK-01、STR-CHANNEL-01（6） | 残余 A1（2026-11-07，commit e8bbdd6）+ plan-e2e-strengthen 工作流 STR 域 focus 段 |
| 图表文件渲染器 29 型铺开（本地/npm/wasm/CDN/kroki/官方各档 + 大小门/单跳失败文案/sanitize） | [diagram-file-renderers.md](diagram-file-renderers.md) | DIA-LOCAL-01、DIA-KROKI-01~02、DIA-C4-01、DIA-CDN-01、DIA-SIZE-01、DIA-SRC-01、DIA-SAN-01、DIA-SERVER-01、DIA-OFFICIAL-01（10 场景编号 → 35 个 test） | 2026-11-04-file-viewer-integration-design.md §5.1/§5.2 + 计划 1（fv-plan1-hygiene-diagram-file） |
| 扩展名绑定与抢占秩序（绑定清单一致性/签名改派绕行/探测链尾兜底/补空位扩展名/嵌套归档深度门） | [extension-bindings.md](extension-bindings.md) | BND-01~10（10） | 2026-11-04-file-viewer-integration-design.md §4（批次一卫生批）+ 计划 1（fv-plan1-hygiene-diagram-file） |
| 路径规范化与穿越防御（bridge sibling 解析/markdown 相对图越界拒绝/嵌套附件名合成/归档条目穿越面） | [path-normalization.md](path-normalization.md) | PAT-01~09（9） | 残余 A4（2026-11-07 残余清理批一，commit 9471efd）+ 本轮测绘 PAT 域缺口清单 |
| 用户反馈八项验收（代码自动换行/手机 PDF 适宽/pptx·docx 默认渲染器/旧浏览器 PDF/默认渲染器设置/平板段右栏折叠/图片拖动平移） | [user-feedback-2026-11-09.md](user-feedback-2026-11-09.md) | UFB-01a~e、UFB-02a~c、UFB-03a~b、UFB-04、UFB-04b、UFB-05、UFB-05b、UFB-06、UFB-07a~c、UFB-08a~d（22） | 2026-11-09 用户反馈（无 spec，根因与修复对照见文档 §2） |

上表末八行来自两个来源批次：2026-11-04/07 的 file-viewer 五计划流水线（计划 1~5，spec `2026-11-04-file-viewer-integration-design.md`），以及 2026-11-07 残余批的新特性补强（残余 A1/A2/A4/A7/A8 等已落库修复的回归锚）；两批文档编号自成体系、与首轮测试点编号不连续，各文档第 1 节载明 spec/plan 出处与现状脚本。

首轮之后落库的其余特性域文档（cdn-diagram-engines、code-scan-resilience、error-card-open-as、filetree-src-remove、grammar-spa-fallback、io-degrade-matrix、jsonl-degrade-chain、multiroot-file-channel、override-lang、quickopen-multisource、susp-verification、tab-actions-enrichment、workspace-enrichment）：出处与编号段见各文档头注与 §2 场景清单，不在此重复转录。

跨域归属说明（按各域文档第 1 节口径）：

- **BUG-04 / BUG-05 / BUG-06 / BUG-07** 为跨域合并条目，在多个域文档各有一节「本域视角」的验收小节；根因全貌以报告 §5 对应条目为准。
- **BUG-16** 主体在 pwa-mobile-performance（PWA-08）；binary-hex-archive 第 3 节单列其 hex 视图跨域回归验收，本域矩阵行不计。
- **BUG-08 / BUG-25 / BUG-26** 为 unconfirmed（BUG-25、BUG-26 复核判误报/不可复现，报告 §1.2），对应场景文档已标注；处理方式见第 4 节。

## 3. 使用方式

### 3.1 手工黑盒执行

1. **环境准备**（报告 §2.1/§2.2，各域文档第 4 节均有转录）：
   - 前置执行 `pnpm gen:grammars`（偏差 #10 强制前置：grammar wasm 资产不入库、构建期生成）；
   - 构建前端 production build 与 release 二进制；**GRF 域（grammar SPA-fallback/layers）用例需 CDN 注入产物：本地构建用 `pnpm --filter web build:e2e`（与 CI 同参 `VV_GRAMMAR_CDN`，2026-10-16 裁决档②）**——忘走它时 GRF-01/02 假红即构建注入守卫报警；
   - 主实例：`vviewer serve --root .temp/e2e-data --web-dist apps/web/build --port 8391 --compute`，`/api/health` 应返回 `capabilities=["file-server","compute"]`；
   - 测试数据按各域文档第 4 节的清单与构造规格重建于 `.temp/e2e-data/`；server-file-service 域需按其 §4.1 实例矩阵另起辅助实例。
2. **逐场景执行**：每份域文档第 2 节为场景清单表（编号 | 前置条件 | 步骤 | 期望 | 关联缺陷），按行执行；「期望」列中「修复后验收判据」与「实测现状」并存时，以实测现状核对环境是否与报告一致，以验收判据作为回归期望。
3. **断言与证据**：DOM 断言优先页内 eval；对 36 万 span 级超大 DOM 禁用 agent-browser 无障碍 snapshot（报告 §3.3：曾两次致渲染进程无响应，属工具副作用）；截图建议存 `.temp/e2e-artifacts/<域名>/`，复核截图存 `.temp/e2e-artifacts/verify/`，与报告口径一致。
4. **环境受限项**（执行前先读报告 §3.3 与 §7.1 的 10 项未覆盖范围）：headless 无法驱动 FS Access 原生对话框（SHELL-07 blocked）；合成拖拽的 `webkitGetAsEntry()` 恒为 null（真实文件夹拖拽未覆盖）；设备仿真不启用触摸（`maxTouchPoints=0`），触摸须 CDP `Input.dispatchTouchEvent` 且先经 `Emulation.setTouchEmulationEnabled` 开启；移动端/真机相关结论（BUG-19/25/26、hex 性能数字）以真机补测为最终定论。

### 3.2 后续 Playwright 脚本与场景编号的对应约定

仓库现自带套件位于 `apps/web/e2e/`（m1~m7、m3-search、mobile 共 9 个 spec + `drawer.ts`/`serverHarness.ts` 两个 helper；报告 §6 交叉验证轮：chromium + mobile 两项目，72 项 64 passed / 1 flaky / 7 skipped，与黑盒互补而非冗余——该套件未覆盖黑盒发现的主要缺陷面）。后续把本目录场景落成 Playwright 脚本时，约定：

1. **一域一文件，文件名带域前缀**：新脚本按场景编号前缀组织（`shell` / `hl` / `theme` / `md` / `fsearch` / `media` / `bin` / `srv` / `cmp` / `pwa`，如 `shell.spec.ts`），不得写入既有 m1~m7/mobile 文件，避免与现存用例口径混淆；公共装置复用 `serverHarness.ts` 等既有 helper。
2. **测试标题以场景编号开头**：`test('SHELL-11: j/k 逐行滚动、gg/G 跳顶底、Ctrl+P 快速打开', …)`，保证从测试名可直接反查场景文档第 2 节的对应行与报告原始结果。
3. **编号一一对应**：一个 test 对应一个场景编号；场景内含多个独立子断言时（如 SHELL-04 的成功/404/CORS 三场景），拆为多个用例并在标题中携带编号后缀（如 `SHELL-04/404`），不合并为无编号用例。
4. **缺陷场景的落法**：现状为 fail/partial 的场景，修复合入前以 `test.fixme` / `skip` 落占位并在标题或注释标注缺陷号（如 `test.fixme('BUG-03 …')`）；缺陷修复 PR 中转为正式断言，即第 4 节的回归验收。
5. **unconfirmed 场景**（SHELL-14、PWA-06 惯性项等）：先落探针用例按报告复现步骤复核证实现状，再决定转正式断言或关闭，不直接按报告原结论写断言（BUG-25/26 已被复核判误报/不可复现）。
6. **已知 flaky 区分**：`m3-search.spec.ts:107`（mobile 项目「关闭后重开」的 `.vv-search-input` 焦点断言）为预先存在的计时型 flaky（报告 §6），套件失败时先区分，勿归为新缺陷。

## 4. 修复验收约定

- **唯一验收基准**：每条缺陷的修复验收以对应域场景文档**第 3 节「关联缺陷的验收行为」**为准。该节逐条给出「缺陷现状」（含报告证据与复核结论）与「修复后应有行为」（回归验收判据，含「回归不破坏」护栏项）；报告 §5 是现状事实的出处，场景文档第 3 节是可执行判据的出处。
- **跨域缺陷**：合并条目（BUG-04/05/06/07）与跨域回归条目（BUG-16）在多个域文档各有一节验收——根因修复验证以归属域为主（BUG-06 → code-highlight-degrade；BUG-16 → pwa-mobile-performance；BUG-04/05 → 各并入域按各自验收点核对），其余域的「本域视角」小节作为回归观察点，各域均须通过各自的验收项。
- **PR 标注**：修复 PR 应注明缺陷号与对应场景编号（如 `BUG-03 / SHELL-11`）；验收按第 3 节「修复后应有行为」逐项核对，并覆盖条目内全部「回归不破坏」护栏项。
- **unconfirmed 缺陷**（BUG-08/25/26）：修复前先按报告复现步骤复核证实现状；BUG-25/26 复核已判误报/不可复现，其第 3 节为「现状正确行为的回归保护」口径，无修复对象。
- **已裁决偏差不算缺陷**：报告 §2.4 的十条偏差（如 #1 HTML 沙箱形态、#2 token 手动粘贴、#7 压缩包前端解包、#10 grammar 资产构建期生成）在各域文档第 1/4 节已标注涉及场景，回归执行时不得作为缺陷报。

---

*本索引只做汇总与导航，不新增事实；首轮 10 域的场景数、缺陷归属、结果分布均转录自 `docs/report/e2e/e2e-test-report-2026-10-08.md` 与本目录 10 份域文档；§2.1 特性域文档的场景编号与来源转录自各域文档本体。*
