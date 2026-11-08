# 扩展名绑定与抢占秩序（BND 域）e2e — 场景

> 来源：2026-11-04/07 计划 1 批次一「卫生批」——把「扩展名 → 渲染器」绑定补齐并钉死唯一归属。
>
> 实现锚（源码实况，2026-11-08 核对）：
> - 注册面装配序：`apps/web/src/lib/viewer.ts:81`（diagram 29 型）→ `:126`（foreign 20 组）→ `:127-140`（自有 12 类）→ `:143`（`installFallbackExtensions('code', GENERATED_EXTENSIONS)` 补空位）。
> - 注册表语义（冲突抛错 / 补空位只填空位 / 单 owner）：`packages/vviewer-core/src/registry/registry.ts:21`（`install`，扩展名归一化 + `RegistryError`）、`:33`（`installFallbackExtensions`，已占即 skipped）。
> - 绑定清单：hex `packages/vviewer-render-binary/src/hex.ts:788`（含 `hex`）；av `packages/vviewer-render-media/src/av.ts:360`（含 `mpeg`/`weba`）、`:34`（MIME 表 `weba:'audio/webm'`）、`:44`（`VIDEO_EXTS` 含 `mpeg`）；archive `packages/vviewer-render-archive/src/zipStore.ts:24`（`ARCHIVE_BINDINGS` 单一事实源，冻结）、`:31`（`ARCHIVE_EXTS` 同源派生）、`:17`（`MAX_ARCHIVE_DEPTH=3`）、`:51`（`isArchiveEntry`）；foreign 20 组 `apps/web/src/lib/foreignRenderers.ts`（spreadsheet 组含 `tsv`、data 组含 `sqlite`/`wasm`）。
> - 派发链：`packages/vviewer-core/src/dispatch/dispatcher.ts:301`（`resolveInitialRenderer`：扩展名主路由 → 签名改派 → 文本性探测 → hex 兜底）、`:162`（`SIGNATURE_ROUTES` 签名改派表）、`packages/vviewer-detect/src/detect/magic.ts`（签名嗅探表无 zstd 项；`looksTextual` 以「无 NUL 且控制字符占比 ≤5%」判文本——见 §3.3 的实测边界）。
> - 资产三层链：`apps/web/src/lib/foreignAssets.ts:17`（缺省 CDN 层）、`:21`（同源预留槽，当前为空串 = 未启用）、`:72-79`（链对象）、`:86`（链首非空层解析）、`:103`（per-package 基座派生）；构建期 env 层注入 `apps/web/vite.config.ts:819`。
> - 候选面构造：`apps/web/src/lib/openWith.ts:13-33`（`['', dispatch 渲染器, 扩展名注册渲染器…, code, markdown, hex]`，`Set` 去重 + `registry.byId` 存在性守卫）；`apps/web/src/lib/MetaPanel.svelte:238-246`（下拉渲染）、`:76-79`（折叠面追加 UI 哨兵项「更多渲染器…」）；哨兵 id 定义 `apps/web/src/lib/RendererPickerMenu.ts:15-17`。
>
> 脚本：`apps/web/e2e/b-ext-bindings.spec.ts`（本域独占，新建；10 个场景 BND-01~10，chromium project 桌面专属）。
> **状态：2026-11-08 复核轮实跑通过——`apps/web/node_modules/.bin/playwright test --config apps/web/playwright.config.ts b-ext-bindings --project=chromium --reporter=list` → 10 passed (13.3s)，EXIT=0；`npx tsc -p apps/web/tsconfig.e2e.json --noEmit` → 本文件 0 错误（该工程另有他域文件 `b-sw-runtime-cache.spec.ts:342` 的 TS2532 报错，不属本域）。**（复核前一轮同命令 8 passed (15.4s)，当时缺 BND-09/BND-10 两场景。）

## 1. 目的与来源

本域只钉**「扩展名 → 渲染器」的归属**与**「绑定 vs 探测链改派」的语义**，不重复各渲染器的渲染内容锚。勘察结论（2026-11-08）：

1. **新绑定三扩展名零锚**：`.hex`（hex 渲染器）、`.mpeg`/`.weba`（av 渲染器）三个扩展名此前无任何 e2e 锚——它们既不在生成物清单内（不在 `GENERATED_EXTENSIONS`），也不被其它渲染器认领，绑定一旦被撤会静默改派（`.hex` 文本载荷 → code 面；`.mpeg`/`.weba` 二进制载荷 → hex 兜底），无人察觉。
2. **archive 绑定清单整体零锚**：既有 BIN 域锚只覆盖 zip/tar 等少数（`b-binary-hex-archive.spec.ts`）；`ARCHIVE_BINDINGS`（`zipStore.ts:24`）与其余 20 项扩展名之间、以及派生的 `ARCHIVE_EXTS`（`:31`，嵌套展开门 `isArchiveEntry`）的集合语义均无一致性锚。
3. **「唯一 owner / 补空位不抢注」只有单点锚**：`.dot`（DIA-FILE-01）、`.tsv`（FO-07）、`geojson/kml/gpx`（FO2-06）、`wasm`（FO2-02）各是一个单点；装配序一旦颠倒（补空位先于专有注册），这些扩展名会整体被 code 认领，现无跨组一致性锚。
4. **剔除项「不绑定」语义零锚**：`zst`/`tzst`/`zipx` 被显式剔除出 archive 绑定清单（`zipStore.ts:22-23` 注记：libarchive wasm 未编 libzstd；zipx 的 LZMA/PPMd jszip 读不出），但「不被绑定」这一语义没有任何断言。
5. **foreign 资产三层链的同源层未接线**：`FOREIGN_ASSETS_SAME_ORIGIN_PREFIX`（`foreignAssets.ts:21`）当前为空串，链解析实际落到缺省 CDN 层；该层选行为无锚。
6. **「生成物补空位」的补空位半边零锚**（复核补充）：既有锚只证明「专有渲染器不被抢注」，没有一条证明「未被专有认领的生成物扩展名确实由 code 认领」——删掉 `viewer.ts:143` 的 `installFallbackExtensions` 整行，既有全量用例仍全绿。

## 2. 场景清单

| 编号 | 前置条件 | 步骤 | 期望 | 关联缺陷 |
| --- | --- | --- | --- | --- |
| BND-01 | 无（本地注入通道） | 注入 `probe.hex`（**文本**载荷）→ 树行点击打开 | ① hex 面在场（`.vv-hex-row`）；② code 源码面缺席（`.vv-code-pre` 计数 0）；③ 状态栏「打开方式」= 二进制（hex） | —（新增锚，本域无既有缺陷登记；打红面见 §3.1） |
| BND-02 | 无 | 注入 `clip.mpeg`（非文本垃圾字节）→ 打开 | ① 状态栏 = 音视频（mpeg）；② 候选面含 `av` 项（`av` 非恒在兜底 id）；③ hex 面与 code 面均缺席 | —（新增锚，同上） |
| BND-03 | 无 | 注入 `tone.weba`（非文本垃圾字节）→ 打开 | ① 状态栏 = 音视频（weba）；② 候选面含 `av` 项；③ hex 面与 code 面均缺席 | —（新增锚，同上） |
| BND-04 | 无 | 注入 26 个 archive 绑定扩展名语料（统一用最小合法 zip 作载荷）→ 逐个打开 | ① **语料清单 ⊇ 绑定清单**（比对 `zipStore.ts:24` 单一事实源，新增绑定项未纳入语料即红）；② 逐项：状态栏 = 压缩包（`<该扩展名>`），即扩展名主路由命中、未被 PK 签名改派；③ 逐项归档面在场 | —（新增锚，同上） |
| BND-05 | 无 | 注入 `p01.zst` / `p02.tzst`（zstd 魔数载荷）→ 逐个打开 | ① hex 面在场（探测链尾兜底）；② 状态栏 = 二进制（`<扩展名>`），检出扩展名未被改派；③ 候选面首个非自动候选 = hex（本 tab 候选面已算好的位置信号）；④ 候选面**无专有 owner**（恒在兜底项与 UI 哨兵之外为空集） | —（新增锚，同上） |
| BND-06 | 无 | 注入 `p01.zipx`（**最小合法 zip** 载荷）→ 打开 | ① 归档面在场（PK 签名路由进 archive）；② 状态栏 = 压缩包（**zip**，非 zipx）；③ 检出扩展名取值精确等于 `zip` | —（新增锚，同上） |
| BND-07 | SW block（`serviceWorkers: 'block'`）+ `context.route` 全量外域拦截 + abort | 注入 `probe.sqlite`（非文本垃圾字节）→ 打开 | ① 候选面含 `foreign-data` 项（sqlite 归 foreign-data 组）；② foreign-data 组的 sql-wasm 资产请求**命中 mock**且落**链首非空层**基座（env → 同源 → 缺省 CDN，当前为缺省 CDN 的 assets-data 包基座） | —（新增锚，同上） |
| BND-08 | 外域 CDN 引擎 abort 拦截面 | 注入 9 个「生成物清单内被专有渲染器认领」的扩展名 → 逐个打开 | 逐项（单次原子读出）：① 「自动」入口恰一项；② 恒在兜底项与 UI 哨兵之外的专有候选**恰一项且等于期望 owner** | —（新增锚，同上） |
| BND-09 | 无 | 注入 4 个「仅在生成物清单内、未进任何渲染器显式清单」的扩展名（ipynb/dockerfile/caddyfile/jenkinsfile）+ 1 个未注册扩展名（zzz），载荷同为二进制 → 逐个打开 | ① 4 个补空位扩展名：状态栏 = 代码/文本（`<ext>`）且 `.vv-code-pre` 在场、`.vv-hex-row` 缺席；② 对照项 zzz：状态栏 = 二进制（zzz）且 hex 面在场、code 面缺席 | —（新增锚，同上） |
| BND-10 | 无 | 注入 4 层嵌套 zip（outer ⊃ l1 ⊃ l2 ⊃ l3 ⊃ {deep.txt, inner.7z, inner.zst}）→ 逐层下钻到 l3 → 点三个条目 | ① `inner.7z`（∈ ARCHIVE_EXTS）→ depth=3 命中拒展门（错误卡「嵌套层数超限」）；② `deep.txt`（∉）→ 同深度照常可读（code 面出内容）；③ `inner.zst`（剔除项 ∉）→ 不被拒展，落 hex 兜底 | —（新增锚，同上） |

> 场景编号 BND-01~10 全局唯一（跨域不撞号）；本域与既有锚的承接关系见 §4.3。

## 3. 验收行为

### 3.1 各场景的打红面

| 场景 | 判据（产品行为） | 会打红的产品变更 |
| --- | --- | --- |
| BND-01 | `.hex` 由 hex 渲染器认领（扩展名主路由），文本载荷也落 hex 面 | ① `hexRenderer.extensions` 去掉 `hex`（`hex.ts:788`）→ 文本探测链把 `.hex` 送 code → `.vv-code-pre` 出现、状态栏变「代码/文本」；② hex 渲染器改走 code 复用路径；③ hex 面类名漂移 |
| BND-02 | `.mpeg` 由 av 渲染器认领并落视频形态 | ① `avRenderer.extensions` 去掉 `mpeg`（`av.ts:360`）→ 二进制载荷落 hex 兜底 → hex 面出现、候选面无 `av`、状态栏变「二进制」；② `mpeg` 被移出 `VIDEO_EXTS`（`av.ts:44`）→ 拼成音频播放器；③ 候选面 `av` 项消失（owner 变更） |
| BND-03 | `.weba` 由 av 渲染器认领并落音频形态 | ① `avRenderer.extensions` 去掉 `weba` → 同 BND-02 的 hex 兜底面；② `weba` 从 MIME 表移除（`av.ts:34`）→ blob 无类型、音频面退化；③ 候选面 `av` 项消失 |
| BND-04 | archive 绑定清单与语料清单两向一致，且每项扩展名**由扩展名主路由**命中 archive（检出扩展名不被签名改派） | ① 任一绑定项被移出 `ARCHIVE_BINDINGS`（`zipStore.ts:24`）→ 该项落探测链（PK 签名改派）→ 状态栏显示（zip）而非（<该扩展名>）；② 绑定清单新增项而语料未覆盖 → 语料覆盖断言红；③ archive 渲染器 label 漂移；④ 归档面类名漂移 |
| BND-05 | `zst`/`tzst` 不属任何渲染器 → 探测链尾 hex 兜底，候选面无专有 owner | ① 二者被加回 archive 绑定清单 → 状态栏变「压缩包」、候选面出现专有 owner、hex 面缺席；② hex 兜底链断裂 → 落「不支持的扩展名」错误卡；③ 签名嗅探表新增 zstd 项且改派到 archive → 同 ①；④ 探测链链尾改动（hex 兜底取消）→ 落错误卡 |
| BND-06 | `zipx` 不属任何渲染器 → 走 PK 签名改派（检出扩展名纠偏为 zip） | ① `zipx` 被加回 archive 绑定清单 → 扩展名主路由命中 → 检出扩展名 = `zipx` → 红；② 签名改派表删掉 `zip` 路由 → 落 hex 兜底 → 归档面缺席；③ 改派后扩展名不再纠偏（`dispatcher.ts:317` 失效） |
| BND-07 | foreign 资产请求落三层链**链首非空层**，且是 foreign-data 组的包基座 | ① 链解析次序错（env/同源层被跳过恒走 CDN）→ 请求落错基座；② per-package 基座派生失效（`foreignAssets.ts:103` 的 `assets-standard@` 替换段写错）→ 请求落 assets-standard 而非 assets-data；③ 资产请求不发（渲染器改走无资产路径）→ 命中 mock 计数为 0 → 红；④ `sqlite` 绑定被撤（落到 hex/code）→ 候选面无 `foreign-data` |
| BND-08 | 生成物清单内的专有扩展名逐个归属唯一 owner（补空位只填空位，不抢专有） | ① **装配序颠倒**（`viewer.ts:143` 的补空位先于专有注册）→ `registry.install` 对重复扩展名抛 `RegistryError`（`registry.ts:26-27`）→ **应用启动即崩**（页面不挂载，全域用例红；真实打红形态是启动失败，不是候选值逐项翻转）；② 任一专有渲染器撤销该扩展名认领 → 该项 owner 落到 code → 该项红；③ registry 冲突检查被放宽（同一扩展名被两渲染器认领）→ 候选面出现两项专有候选 → 该项红 |
| BND-09 | 仅在生成物清单内的扩展名由 code 经**补空位**认领；未注册扩展名同载荷落 hex 兜底 | ① `installFallbackExtensions('code', GENERATED_EXTENSIONS)` 整行删除（`viewer.ts:143`）→ 补空位扩展名无 owner → 二进制载荷落 hex 兜底 → 状态栏变「二进制」、code 面缺席 → 红；② 补空位越过专有注册（认领了 diagram/foreign 的扩展名）→ 装配期 `RegistryError` → 启动崩；③ 补空位 owner 改为其它渲染器 → 状态栏 label 漂移 → 红 |
| BND-10 | 嵌套展开门按**扩展名集合**判定：`ARCHIVE_EXTS` 成员在 depth=3 被拒展、非成员照常可读 | ① `isArchiveEntry`（`zipStore.ts:51`）判定放宽/收紧 → 归档类条目不再被拒（错误卡缺席）或非归档类条目被误拒（deep.txt 报错）；② `MAX_ARCHIVE_DEPTH`（`zipStore.ts:17`）改值 → 拒展深度漂移（l3 层不再被拒或更早被拒）；③ `ARCHIVE_EXTS` 与 `ARCHIVE_BINDINGS` 脱钩（派生漂移）→ inner.7z 的判定翻转 → 红；④ 剔除项 zst 被误加进清单 → inner.zst 也被拒展 → 红 |

### 3.2 断言纪律自查（恒真断言排查）

复核提出的两条恒真断言已按「改成更强而非更弱」处理，逐条交代：

| 复核指出的恒真项 | 处置 | 现在的判别力 |
| --- | --- | --- |
| 「owner 在候选面恰一次」（`filter(v => v === owner).length === 1`） | **删除**，改写为「恒在兜底项与 UI 哨兵之外的专有候选集合 == `[owner]`」 | 原断言被 `openWith.ts` 的 `Set` 去重保证 ≤1、且被上一行的 owner 相等蕴含 → 恒真；新断言要求集合**恰一项且等于期望 owner**：owner 变更 / owner 被撤（落 code）/ 冲突检查被放宽（两项）三种变更均打红 |
| 「`values[0] === ''`（「自动」恒为首项）」 | **删除**，改写为「`values.filter(v => v === '').length === 1`」 | 原断言恒真（`openWith.ts:22` 无条件置首）；新断言对「自动」入口被改名（如改 id）、被重复渲染两处打红 |
| 「同源层零请求」断言 + 硬编码 `**/file-viewer-assets/**` pattern | **删除**；拦截 pattern 改为「非同源外域请求」全量宽面（不写死产品里不存在的路径），同源层只在源常量接线时才入判据 | 原断言在当前源码下恒真（源常量为空串 → 产品不可能发该路径）；现在同源层未接线时明确标注「不在本次判据内」（控制台说明 + §3.3），接线后断言「请求落同源前缀」 |
| BND-05 的「候选面就位」前置（`length > 0`） | 换成**位置信号**：首个非自动候选 = hex（本 tab 的 dispatch 渲染器） | `length > 0` 被恒在的「自动」空选项满足 → 前置无效；`code/markdown/hex` 亦是恒在兜底项，其「出现」不构成就位证据；位置信号只在候选面按当前 tab 算好后才成立 |
| BND-06 的 `not.toContain('zipx')`（被上一行正则蕴含） | **删除**，改写为「检出扩展名取值精确等于 `zip`」 | 原断言冗余（正则已要求右括号紧跟 zip）；新断言是取值比对，`zipx` 入绑定清单时直接红 |

其余纪律：

- **无「只断言元素存在」的条款**：每个场景至少含一条取值类断言——状态栏文本（渲染器 label + 检出扩展名，原文比对）、候选面 option value（专有候选集合逐项比对）、资产请求 URL（基座前缀 + 相对路径）。
- **无注册面硬编码计数**：全文件不断言「注册面共 N 个扩展名」。BND-04 的比对是**两向集合语义**（语料 ⊇ 绑定清单 + 逐项归属），不写死条目总数；BND-08/BND-09 同理（表驱动逐项断言，不数项）。
- **候选面里的非渲染器项不作判据**：`openWith.ts:30-32` 无条件 push `code`/`markdown`/`hex`（+ 首项 `''`），`MetaPanel.svelte:76-79` 另追加 UI 哨兵 `__more__`（展开态为 `__less__`，`RendererPickerMenu.ts:15-17`）——这些 id 的「出现」不携带归属信息，全部排除在「专有 owner 集合」之外。
- **缺席断言均有在场信号在前**：BND-01/02/03 先等 hex 面/状态栏归属锚在场再判 code 面缺席；BND-05 先等 hex 面在场、状态栏锚成立、候选面位置信号成立，再判「无专有 owner」；BND-06 先等归档面在场再判扩展名纠偏；BND-09 先等状态栏归属锚与 code 面在场，再判 hex 面缺席；BND-10 先等归档面/树在场再判拒展与可读。
- **轮询断言一律 `expect.poll`**：状态栏文本、候选面读数、资产请求计数全部走 `expect.poll`；BND-08/BND-09 的候选面读数用**单次原子求值**（一次 evaluate 内同时取「自动」计数与专有候选集合），避免「轮询长度 → 一次性读取」两步读到半更新值。
- **绑定 vs 改派的判别力**：状态栏括号内的**检出扩展名**是关键——扩展名主路由命中即原值，签名改派即纠偏值（`dispatcher.ts:317`）。BND-04 用「统一 zip 载荷 + 逐项比对原扩展名」把 26 项的绑定/改派语义一次钉死；BND-06 反向用同一载荷证明改派纠偏。
- **计数/时序余量**：渲染面可见 15~40s、状态栏/候选面轮询 30s（BND-07 放宽到 60~90s：foreign chunk 懒加载 + wasm 引导）；BND-04 单项两段断言预算（状态栏 15s + 归档面 5s）→ 单项最坏 ~21s → 26 项最坏 ~546s < 总预算 600s（任一项卡住在该步定点失败并带扩展名上下文，而非整例静默超时；本机实测 26 项合计 3.6s）。CI 2 核 + 375×500 视口为已知脆弱面，故本域只在 chromium 跑（桌面专属）。
- **网络面零裸依赖**：BND-07 用 `serviceWorkers: 'block'` + `context.route`（宽面拦非同源外域请求）abort 兜底并断言「命中 mock」态（命中计数 > 0 + URL 落期望基座 + 相对资产路径匹配）；BND-08 的外域 CDN 引擎（bpmn/typst/fods 组）一律 abort 收口，判据不依赖渲染成败。
- **SW 与拦截面的关系**：`page.route` 拦不到经 SW 的请求（仓内 DM-03 备案），故拦截面用 `context.route`（`b-diagram-file-2` 实测 SW 在位/不在位均命中）并另配 `serviceWorkers: 'block'` 双保险；请求计数记在 route 命中处，不依赖页面网络栈观测。

### 3.3 已知边界与现状保护项（非缺陷，备查）

- **BND-07 的同源层断言是「现状保护锚」且当前不入判据**：`FOREIGN_ASSETS_SAME_ORIGIN_PREFIX` 当前为空串（`foreignAssets.ts:21`，plan 4 待接线），产品不可能发出该前缀的请求 → 写「零请求」是恒真断言，故本域改为：同源层未接线时明确标注「该层不在本次判据内」（控制台说明），接线后（源常量非空）断言「请求落同源前缀」。拦截面不再硬编码 `**/file-viewer-assets/**`（产品源码里根本不存在的路径约定）。
- **BND-07 的 env 层（构建期 define）已可判**：env 层由 `vite.config.ts:819` 以字符串字面量注入，e2e 跑的是构建产物 → spec 从构建产物反查该字面量（foreignAssets 模块 chunk 内除 CDN 默认基座外的唯一 URL 字面量），据此把链首层期望切到镜像域；构建目录缺失或候选不唯一时按「未注入」处理（CI 的 e2e 构建只注入 `VV_GRAMMAR_CDN`，`ci.yml:163-165`）。
- **BND-07 的资产请求与产品行为耦合**：sql-wasm 的拉取发生在 `initSqlJs({locateFile})` 之前、DB 解析之后（上游 dist 实码），故任意 `.sqlite` 载荷都会触发该请求；若上游改为「先校验 sqlite 头再加载 wasm」，本锚的「命中 mock」计数会归零而红（属产品行为变更信号，非测试缺陷）。
- **av 的视频/音频形态断言口径**：媒体运行期解码失败时，av 渲染器自办错误卡（`av.ts` `showMediaError`，文案「无法播放此媒体：…」）并摘除媒体元素——媒体元素是**短命面**，故 BND-02/03 以「渲染器归属（状态栏 + 候选面）+ hex/code 面缺席」为判据，不断言媒体元素的存活时长。
- **4 字节 zstd 魔数会被判为文本**（实测）：`looksTextual`（`magic.ts`）以「无 NUL 且控制字符占比 ≤5%」判文本，4 字节 `28 B5 2F FD` 无 NUL → 判文本 → 未绑定扩展名落 **code** 面而非 hex 面。BND-10 的 `inner.zst` 载荷因此补了 NUL 尾字节（8 字节），使其与顶层 `.zst`（BND-05，32 字节带 NUL）同机制落 hex 兜底。此为探测链现状（不是缺陷登记项），但会影响任何以 zstd 魔数构造的小载荷用例。
- **签名嗅探表无 zstd 项**（`magic.ts`）：`.zst`/`.tzst` 载荷不触发签名改派，这是 BND-05「走探测链尾 hex 兜底」判据成立的前提；若将来嗅探表新增 zstd 且路由到 archive，本锚按 §3.1 ① 转红（属期望行为）。
- **archive 绑定清单条目数**：源实况为 **26 项**（`zipStore.ts:24-30`），与缺口清单里写的「27 项」不符（按源码实况校正）；spec 不断言条目数，只做两向集合比对。

## 4. 环境与数据（夹具与断言锚）

### 4.1 夹具与语料（全部在本文件内合成，零外部语料依赖）

| 夹具 | 规格 | 用于场景 |
| --- | --- | --- |
| 文本载荷 | `hello hex binding\nsecond line\n`（纯可打印 ASCII → 文本探测链会命中 code，用于区分「绑定命中」与「探测链兜底」） | BND-01 |
| 非文本垃圾字节 | 64 字节，**前 4 字节置 NUL**（→ 非文本）+ 后续 `(i*7+13)&0xff`（→ 不匹配任何 magic 签名：zip/ole/png/jpeg/gif/pdf/ico/gz/7z/rar/flac/ogg/bmp/webm/wav/ftyp 全部落空） | BND-02 / BND-03 / BND-07 / BND-09 |
| zstd 魔数载荷 | 32 字节，头 4 字节 `28 B5 2F FD` + NUL 尾（zstd 帧魔数；嗅探表无 zstd 项 → 不触发签名改派；带 NUL → 非文本 → 落 hex 兜底而非 code 面，见 §3.3） | BND-05 |
| 最小合法 zip | JSZip 生成：`hello.txt` = `hello vviewer`（PK 头 + 单条目）→ 走 archive 渲染器的 jszip 分支（`archive.ts` `isZipMagic`），渲染快、无 libarchive worker | BND-04 / BND-06 |
| 4 层嵌套 zip | JSZip 生成：outer ⊃ `l1.zip` ⊃ `l2.zip` ⊃ `l3.zip` ⊃ {`deep.txt`=deep payload、`inner.7z`=7z 魔数 5 字节、`inner.zst`=zstd 魔数 + NUL 8 字节}；链段数 = 嵌套层数（`zipStore.ts` `createZipStore` 的 parentChain 段数），`l3.zip` 的 store depth=3 = `MAX_ARCHIVE_DEPTH` → 命中拒展门 | BND-10 |
| archive 语料清单 | 26 项扩展名（`zipStore.ts:24` 全集）；文件名 `pNN.<ext>` 两位定宽 → 树行定位无子串歧义（`probe.tbz` vs `probe.tbz2` 同类歧义已规避） | BND-04 |
| 专有 owner 表 | 9 组「扩展名 → owner id」：`mmd→diagram-mermaid`、`bpmn→diagram-bpmn`、`dbml→diagram-dbml`、`pot→foreign-presentation`、`fods→foreign-spreadsheet`、`typ→foreign-typst`、`sig→foreign-signature`、`svg→image`、`jsonl→jsonl`（均为「在 `GENERATED_EXTENSIONS` 内且被专有渲染器认领」的扩展名；已锚载体 `.dot`/`.eml`/`.geojson`/`.kml`/`.gpx`/`.tsv`/`.wasm` 不重复） | BND-08 |
| 补空位语料 | 4 个「仅在 `GENERATED_EXTENSIONS` 内、未进任何渲染器显式清单」的扩展名：`ipynb`/`dockerfile`/`caddyfile`/`jenkinsfile`（其 owner 只能来自 `installFallbackExtensions`）；对照项 `zzz`（不在生成物清单、无人认领） | BND-09 |

### 4.2 断言锚（源码契约）

- 状态栏「打开方式」按钮：`.vv-status-openwith`，文案 `打开方式: {rendererLabel}（{detLabel}）`（`ViewerPane.svelte:1227`；`rendererLabel = registry.byId(res.rendererId)?.label`（`:985`，错误卡时为空 → 按钮不渲染）、`detLabel = res.det.ext`（`:986`，派发后纠偏值））。
- 属性面板「打开方式」下拉：`.meta-openwith`（`MetaPanel.svelte:238-246`），候选由 `rendererCandidatesOfTab` → `openWithOf`（`apps/web/src/lib/openWith.ts:13-33`）构造：`['', dispatch 渲染器, 扩展名注册渲染器…, code, markdown, hex]`，`Set` 去重；`MetaPanel.svelte:47-57` 用激活 tab 的 `lastRendererId`/`lastDetExt` 计算（未渲染成功时 `lastDetExt` 缺省 → 由文件名派生扩展名，`RendererPickerMenu.ts:42-46`（扩展名派生）、`:53-70`（候选组装））；折叠面另追加 UI 哨兵 `__more__`（`MetaPanel.svelte:76-79`，id 定义 `RendererPickerMenu.ts:15-17`）。
- 派发链与改派：`dispatcher.ts:301-360`（`resolveInitialRenderer`）、`:162-185`（`SIGNATURE_ROUTES`：`zip→archive/zip` 等）；`magic.ts`（嗅探表 + `looksTextual`）。
- 绑定清单：hex `hex.ts:788`；av `av.ts:34/44/360`；archive `zipStore.ts:24/31/17/51`；foreign 组 `foreignRenderers.ts`（spreadsheet 组 `tsv`、data 组 `sqlite`/`wasm`）。
- 补空位语义：`registry.ts:33-52`（`installFallbackExtensions`：已占即 skipped，只填空位）；冲突面 `registry.ts:26-27`（重复扩展名抛 `RegistryError`）；生成物清单 `packages/vviewer-core/src/registry/generated-extensions.ts`（670 项，由 `tools/grammar-builder/gen-code-extensions.mjs` 生成，CI `--check` 校验）。
- 资产三层链：`foreignAssets.ts:17/21/72-79/86/103`（缺省 CDN / 同源槽 / 链对象 / 链首非空层解析 / per-package 派生）；构建期 env 注入 `vite.config.ts:819`；组→包映射 `foreignRenderers.ts:206-227`（`foreign-data → assets-data`）；SQL wasm 资产路径 `viewer/wasm/data/sql-wasm.wasm`（包内基座相对派生）。

### 4.3 既有锚承接（不重复造锚）

| 既有锚 | 位置 | 与本域的关系 |
| --- | --- | --- |
| DIA-FILE-01（`.dot` 抢注） | `b-diagram-file.spec.ts:73` | 同语义（补空位不抢注）单点载体；BND-08 是跨组表驱动版本，不含 `.dot` |
| FO-07（`.tsv` 转移） | `b-foreign-office.spec.ts:294` | foreign 组转移语义单点载体；BND-08 不含 `.tsv` |
| FO2-06（`geojson/kml/gpx` 转移） | `b-foreign-office-2.spec.ts:299` | 同上；BND-08 不含三者 |
| FO2-02（`wasm` 转移） | `b-foreign-office-2.spec.ts:202` | 同上；BND-08 不含 `wasm` |
| FO2-01（`sqlite`/`wasm` 渲染面） | `b-foreign-office-2.spec.ts:180` | 渲染面锚；BND-07 的增量在**资产基座层选**，不在渲染面 |
| FOM-CDN-01（CDN 资产不可达收口） | `b-foreign-office-3.spec.ts:810`（describe 在 `:807`） | CDN 不可达收口锚（载体 `.wpd`）；BND-07 的增量在**层选判据**（落哪一层基座），载体换 `.sqlite`（assets-data 包基座路径，与 `.wpd` 的 assets-wordperfect 独立） |
| SIG-01~04（签名改派） | `b-file-detect-signature.spec.ts` | 无扩展名文件的签名改派；BND-05/06 是**有扩展名但未绑定**时的改派/兜底语义 |
| BIN-04/08/10（hex/归档） | `b-binary-hex-archive.spec.ts` | 渲染内容锚；BND-04 的增量在**绑定清单整体一致性** |
| m4 的 zip 4 层深度拒绝锚 | `m4.spec.ts:111` | 深度门「.zip 被拒」已锚；BND-10 的增量在**拒展按扩展名集合判定**（`.7z` 拒 / `.txt` 不拒 / 剔除项 `.zst` 不拒） |

## 5. mock 与离线纪律

- **注入通道**：目录注入经 `__vvOpenDirImpl`（`injectDir`/`openTreeFile`，`b-markdown-html-docs-helpers` 只读引用）；单批单目录注入（`injectDir` 内含 `page.goto('/')`，逐文件多次注入会反复重载应用）。
- **拦截面**：`context.route`（仓内 `b-diagram-file-2` 实测：SW 在位与不在位均命中）+ BND-07 另配 `serviceWorkers: 'block'`；BND-07 的拦截面取「非同源外域请求」宽面（同源判定用 playwright 配置的 baseURL origin，不用 `page.url()`——注入前页面仍是 `about:blank`）；BND-08 的外域引擎一律 abort 收口。台账记在 route 命中处，不依赖页面网络栈观测。
- **零真网依赖**：全部场景的判据均可在无外网可达的环境下成立（CDN 请求走 mock/abort；无 CDN 引擎的本地引擎组不受影响）。
- **禁项自查**：未在仓内测试目录留任何临时探针文件（本域只新增 `b-ext-bindings.spec.ts` 一个 spec 文件，无公共 helper 文件；复核期的探针脚本落 `/tmp`）。

## 6. 未落项与原因

| 编号 | 原因 |
| --- | --- |
| 未落项 A | 「注册面扩展名总数」断言——硬约束禁项（注册面随产品演进变化），已由 BND-04/BND-08/BND-09 的集合语义断言替代 |
| 未落项 B | 扩展名大小写归一（`registry.ts:25` 注册侧归一、`:52` 查询侧归一）——需 `.HEX`/`.ZIP` 语料，判定面与 BND-01/04 同形，增量有限，且大写扩展名在部分文件系统/拖放通道不可稳定构造；留作下一批 |
| 未落项 C | foreign 组间扩展名互抢（20 组之间的 owner 唯一性全量表）——需 20 组语料与各自资产面，成本高于本轮名额；BND-08 已覆盖「生成物 vs 专有」这一侧 |
| 未落项 D | **各归档格式「真能打开」**——BND-04 用统一 zip 载荷逐项锚「扩展名路由」，但非 zip 载荷（真 tar/7z/rar）会走 libarchive wasm 分支（`archive.ts` `isZipMagic` 之外），本域未覆盖；同理「zipx 若被绑定后打开即错误卡静默降级」的风险形态需真 zipx 载荷才能测。两者留作下一批（需每格式各自的真实归档载荷） |
| 未落项 E | 「装配期冲突面」的 e2e 锚——两个渲染器认领同一扩展名时 `registry.install` 抛 `RegistryError` → 应用启动崩（装配期语义，无运行期可观测面）；BND-08 只覆盖「冲突检查被放宽后候选面出现两项专有候选」的运行期形态 |
