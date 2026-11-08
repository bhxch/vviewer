# 路径规范化与越权防护（PAT 域）e2e 场景文档

> 来源：残余 A4（2026-11-07）`posixJoin` 规范化收紧——`../` 与前导 `/` 拒绝（commit `9471efd`，`git log -1 --format="%h %ad %s" 9471efd` → `9471efd 2026-11-07 fix(web): 残余清理批一——确认卡中性文案/error-meta 样式/posixJoin 规范化`）+ 本轮测绘的 PAT 域缺口清单（bridge 越权防御、嵌套附件名合成、归档条目穿越面）。
> 脚本：`apps/web/e2e/b-path-normalize.spec.ts`（PAT-01~09；chromium project）。
> 域定位：**路径规范化与越权防护**——构造恶意路径输入，断言「不越权、不抛未捕获异常、内容不串到别的文件」。本域不追求渲染成功面（渲染面由 FO/FO2/FOM 域覆盖）。

## 1. 目的与来源

### 1.1 被测面与代码锚

| 面 | 代码锚 | 既有锚 | 本域增量 |
| --- | --- | --- | --- |
| 桥接 sibling 解析（路径工具 + 越权防御） | `packages/vviewer-render-foreign/src/bridge.ts:198-206`（`posixDirname`/`posixJoin`）、`:213-218`（`posixNormalize`）、`:225-227`（`isUnsafeSiblingName`）、`:236-250`（`createSiblingResolver`） | 单测 `packages/vviewer-render-foreign/test/bridge.test.ts:410-480`（覆盖五形态拒读、`:473-480` 的读路径精确与退化形归一） | PAT-01~05：浏览器内执行 + **单测未覆盖的形态**（'..foo'/'a..b.json' 对向放行、根级来源 dirname 空串分支、'a/../b.json' 保守拒、多形态前导 '/'）+ 「零 read 调用」的调用序列断言 |
| markdown 相对图片路径解析（越界拒绝） | `apps/web/src/lib/markdownImages.ts:22-35`（`resolveInStorePath`）、`:43-63`（`resolveImageBlobUrl`）、接线 `apps/web/src/lib/viewer.ts:263`、调用面 `packages/vviewer-markdown/src/markdownRenderer.ts:209-230`（`:150-152` `isAbsoluteSrc`、`:582` 解析早于 `:591` 挂载） | 单测 `apps/web/src/lib/markdownImages.test.ts:36-41`、`:82`；e2e 正例 `b-md-export.spec.ts:39`（`src^="blob:"`） | PAT-06：**越界拒绝**（`'../../secret.png'` 不被解析成 store 内文件、文档内 blob: 图恰 1 张、不落错误卡） |
| 归档条目名（穿越段） | jszip 路径 `packages/vviewer-render-archive/src/zipStore.ts:193-250`（`createZipStore`）、`:71-96`（`listTreeChildren`）；libarchive 路径 `packages/vviewer-render-archive/src/libarchiveStore.ts`（walk 聚合期规范化）、`zipStore.ts` 的 `normalizeArchiveEntryPath`（三路径共用的归档内规范化）；libarchive.js dist 的 `getFilesObject`→`getObjectPropReference`（按 '/' 拆嵌套，不消毒） | 条目打开机制由 SA-02 / FOM-ZIP-01 覆盖；**穿越命名零锚** | PAT-07（jszip 路径）/ PAT-09（tar·libarchive 路径）：条目树不得暴露穿越段名 + 内容取归档自身字节（不串宿主同名/同路径文件） |
| 嵌套附件兜底名（路径成分） | `apps/web/src/lib/foreignRenderers.ts:68-73`（`nestedName` 合成 `attachment.<ext>`）、`:147-153`（`renderNestedBuffer` 适配）、分派 `apps/web/src/lib/viewer.ts:93-118`、兜底下载 `packages/vviewer-render-foreign/src/bridge.ts:110-117`、上游 `getAttachmentExtension`（`@file-viewer/renderer-email` dist `email.js:211-214`） | FOM-NEST-02 只断言兜底名的**扩展名**口径（`b-foreign-office-3.spec.ts:382-412`） | PAT-08：**产品侧合成名**（`<a download>` 属性）不得含路径成分 + 多附件落盘字节不串 |

### 1.2 缺口成因（为什么 sibling 防御要用「模块注入」装置）

`resolveSibling` 在应用侧是**死缝**：`apps/web/src/lib/foreignRenderers.ts:143-154` 构造上游 `FileRenderContext` 时只传 `filename`/`sourceFile`/`signal`/`renderNestedBuffer` 四字段，`args.resolveSibling` 从未被读取（上游 `@file-viewer/core` 的 `FileRenderContext` 契约亦无 sibling 字段）。故 `createSiblingResolver` 的越权防御**在浏览器里没有任何可达入口**——无法经 UI 黑盒触达。

本域因此为 PAT-01~05 自建**模块注入装置**：读仓内产品源码 `packages/vviewer-render-foreign/src/bridge.ts` → `ts.transpileModule`（只做类型擦除；该文件唯一 import 是 `import type`，编译后零运行时依赖）→ `page.addScriptTag({type:'module'})` 注入页内 → `window.__patBridge.createSiblingResolver` 即产品实现本体。不用构建产物的原因：vite build 的 chunk 经 tree-shake 不再导出 `createSiblingResolver`（应用只 import `wrapFileViewerRenderer`/`disposeForeignRendered`），且构建产物可能滞后于源码。注入前先加载**真实产品页**（`waitAppMounted` → vite preview + SW 开启），使 PAT-04 的「失败不外泄为页面未处理拒绝」断言在产品页语境下成立。

### 1.3 与既有锚的边界（不重复计覆盖）

| 既有锚 | 覆盖内容 | 本域不重复之处 |
| --- | --- | --- |
| `bridge.test.ts:410-480`（vitest 单测，Node 内） | sibling 解析的单测语义：五形态拒读（`:459-471`）、读路径精确与退化形归一（`:473-480`）、根级来源（`:428-429`）、'..foo' 放行（`:469-470`） | PAT-01~05 是**浏览器内 + 产品源码注入**执行；净增形态：'a/../b.json'（含 '..' 段但不出根的保守拒）、多形态前导 '/'（'/abs.json'、'/a/b/ok.json'）、**'..foo'/'a..b.json' 对向放行**（单测只有 '..foo'）、**调用序列断言**（`store.read` 零调用/恰好一次——单测只断言 `toHaveBeenCalledExactlyOnceWith`，读路径为空/畸形时的行为不可分）、**取消形态 + 未处理拒绝通道**（`DOMException('AbortError')`、页内 `unhandledrejection`） |
| FOM-NEST-01/02/03（`b-foreign-office-3.spec.ts`） | 嵌套附件回流、深度限 3、兜底下载的**扩展名**口径 | PAT-08 落在**产品侧合成名的路径成分**（`<a download>` 属性层，非浏览器消毒后的 `suggestedFilename`）与**多附件内容不串**（两个同扩展名附件，点谁下谁） |
| SA-02 / FOM-ZIP-01（`b-foreign-office-3.spec.ts:773-802`） | 归档条目点击开 tab 机制 | PAT-07/PAT-09 落在**条目名穿越段**（树内无 '..' 段名）+ 内容取归档自身字节而非宿主同名/同路径文件；且覆盖 FOM 未触及的 **libarchive（tar）路径** |
| SRV-09（`apps/web/e2e-server/b-server-file-service.spec.ts:185`） | 服务端 `../` 与 `%2e%2e%2f` 穿越 400 | 服务端面归 SRV 域，**本域不重复**（服务端套件是独立 playwright 工程） |
| BUG-17/BUG-40（`packages/vviewer-sanitize/src/sanitize.ts:308-325`） | markdown 外域 `img src` 拦截（`b-md-export.spec.ts:40`） | 本域只管**同 store 内**的相对路径解析与越界拒绝 |

> **交叉去重说明**：本轮另有 7 份新域文档与 spec 由并行实现者产出（ext-bindings、diagram-file、pdf-range、save-as、sw-runtime-cache、foreign-office-3 等），本域与其的锚号段不重叠（PAT-* vs 各自域前缀），且本域仅引用 `./b-markdown-html-docs-helpers`、`./drawer`、`./helpers` 三个只读 helper，不改动他域文件。`docs/e2e/README.md` 的域索引收录属控制器统一收口范围（按本域「只改两个文件」的约束未改）。

## 2. 场景清单

公共环境：chromium project（桌面 1280×720；`test.beforeEach` + `testInfo.skip` 跳过 mobile——PAT-06~09 的树/邮件/归档交互为桌面面，PAT-01~05 为视口无关的模块级锚，随文件级跳过统一收敛运行面）。
注入通道：`injectDir` + `openTreeFile`（`./b-markdown-html-docs-helpers`，只读引用）；嵌套目录经「展开目录行 → 点子文件行」打开（`./drawer` 只读引用）；模块级锚注入前经 `waitAppMounted`（`./helpers`，只读引用）加载真实产品页。

| 编号 | 前置条件 | 步骤 | 期望 | 关联缺陷 |
| --- | --- | --- | --- | --- |
| PAT-01 | 桥接模块注入完成（真实产品页内 `window.__patBridge.createSiblingResolver` 就绪）；stub store 带 `read`（记录调用路径） | ①以 `../escape.json`、`sub/../../escape.json`、`..`、`a/../b.json` 调 resolver；②以 `..foo`、`a..b.json` 调 resolver（对向） | ①每次返回 `null`（不抛）且 `store.read` 调用序列恒为**空**（穿越读一次都不该发生）；②合法名（含 '..' 子串但非独立段）**必须放行**：返回字节非 `null`、读路径恰为 `a/b/..foo` / `a/b/a..b.json`（段判定退化为子串判定即红） | 残余 A4（commit `9471efd`）的回归护栏 |
| PAT-02 | 同 PAT-01 | 以 `/etc/passwd`、`/abs.json`、`/a/b/ok.json` 调 resolver | 每次返回 `null`（不抛）；`store.read` 调用序列恒为**空**（根逃逸读一次都不该发生） | 同上 |
| PAT-03 | 同 PAT-01 | 三种契约外输入各调一次：空名；`source.path === ''`；`source.path` 以 `/` 结尾（目录型来源） | 每次返回 `null`（不抛）；`store.read` 调用序列恒为**空** | — |
| PAT-04 | 同 PAT-01 | ①`store.read` 抛 `Error('pat-read-boom')` 与 `DOMException('pat-read-abort','AbortError')`，直调 resolver；②同 ① 但**不 await 不 catch** 地调 resolver（页内 `unhandledrejection` 监听） | ①两次 resolver 的 promise 均兑现为 `null`（自身不抛），且 `store.read` **被尝试过一次**、路径恰为 `a/b/ok.json`（区分「取消被兜 null」与「根本没读」）；②页内 `unhandledrejection` 通道**零记录**（read 失败不外泄为页面未处理拒绝） | — |
| PAT-05 | 同 PAT-01；store 文件表 `a/b/ok.json`→`[1,2,3]`、`a/b/other.json`→`[9,9,9]`、`a/sib.json`→`[7,7]`、`sib.json`→`[8,8]` | ①`source.path='a/b/data.csv'` 求 `ok.json`；②同源求 `other.json`；③`source.path='top.csv'` 求 `sib.json`；④`source.path='a//b.csv'` 求 `sib.json`；⑤`source.path='./a/b.csv'` 求 `./sib.json` | ①读路径恰为 `a/b/ok.json`、字节恰为 `[1,2,3]`；②读路径 `a/b/other.json`、字节 `[9,9,9]`（内容不串别的文件）；③读路径恰为 `sib.json`（根级来源 dirname 为空 → 直接取名）、字节 `[8,8]`；④⑤读路径均归一为 `a/sib.json`、字节 `[7,7]`（`posixNormalize` 生效） | — |
| PAT-06 | 注入 `pat-doc/readme.md`（含 `![pat-ok](./img.png)` 与 `![pat-escape](../../secret.png)`）、`pat-doc/img.png`（1×1 PNG）、`secret.png`（1×1 PNG，位于 store 根） | 展开 `pat-doc` → 打开 `readme.md` → 等 markdown 渲染落定 | markdown 根可见（选择器 `.vv-markdown`——渲染根即宿主元素本身，见 §4.3 注 5）；对照图 `img[alt="pat-ok"]` 的 `src` 匹配 `^blob:` 且 `naturalWidth > 0`（本环境图片链路可用）；越界图 `img[alt="pat-escape"]` 的 `src` 仍为字面量 `../../secret.png`（未被改写成内联 URL → 未读 store）；文档内 `img[src^="blob:"]` 计数恰为 **1**（越界图未被物化 → 无内容串到别的文件）；`.vv-error-card` 计数 0（未落错误卡） | — |
| PAT-07 | 注入 `bundle.zip`（jszip 写入面直给穿越条目名 `../secret.txt`，负载 `ZIP-ESCAPE-BYTES`；另含条目 `ok.txt`）+ 宿主 `secret.txt`（`HOST-SECRET-BYTES`）与宿主 `../secret.txt`（`HOST-RAW-SECRET-BYTES`） | 打开 `bundle.zip` → 读归档树条目名 → 点 `secret.txt` 条目行 → 读新 tab 代码面 | 归档树可见条目名**无任一含 `..` 路径段**；`.vv-error-card` 计数 0；点击后新 tab 激活、代码面含 `ZIP-ESCAPE-BYTES` 且**不含** `HOST-SECRET-BYTES`/`HOST-RAW-SECRET-BYTES`（内容取归档自身字节，不串宿主同名/同路径文件） | — |
| PAT-08 | 注入 `probe.eml`（multipart/mixed，附件 `x.z/evil` 负载 `EVIL-ATTACHMENT-BYTES` 与 `other.zzz` 负载 `OTHER-ATTACHMENT-BYTES`，均无 byExtension 命中） | 打开 `probe.eml` → 等邮件解析遮罩撤除 → 装 `<a download>` 属性钩子 → 点附件项 `x.z/evil` → 捕获下载 | 触发 1 次下载且钩子记录到 `<a download>` 的 **download 属性**；该属性（**产品侧合成名**）非空、**不含 `/`、`\`、`..` 路径段**（硬断言——`fileNameOnly` 文件名化后为 'evil'，见 §3.2 PAT-EX-01）；落盘字节与 `EVIL-ATTACHMENT-BYTES` 逐字节等值且**不等于** `OTHER-ATTACHMENT-BYTES`；`.vv-error-card` 计数 0 | PAT-EX-01（已修） |
| PAT-09 | 注入 `bundle.tar`（手写 ustar 包，条目 `ok.txt` 与穿越名 `../secret.txt`（负载 `TAR-ESCAPE-BYTES`））+ 宿主 `secret.txt`（`HOST-SECRET-BYTES`）与宿主 `../secret.txt`（`HOST-RAW-SECRET-BYTES`） | 打开 `bundle.tar` → 读归档树条目名 → 点穿越条目（扁平化名 `secret.txt`）→ 读新 tab | 归档树可见条目名**无任一含 `..` 路径段**（硬断言）；穿越条目以扁平化名 `secret.txt` 呈现（与 jszip 读侧消解后的形态一致）；`.vv-error-card` 计数 0；点击后代码面含 `TAR-ESCAPE-BYTES` 且**不含** `HOST-SECRET-BYTES`/`HOST-RAW-SECRET-BYTES`（内容取归档自身字节，不串宿主同名/同路径文件） | PAT-EX-02（已修） |

### 2.1 装置说明（全部自建于本 spec 文件，不抽公共 helper）

| 装置 | 规格 | 用于场景 |
| --- | --- | --- |
| 桥接模块注入 | 先 `waitAppMounted`（真实产品页）→ 读 `packages/vviewer-render-foreign/src/bridge.ts` → `ts.transpileModule`（`target: ES2020`/`module: ESNext`）→ `page.addScriptTag({type:'module'})` → 追加 `window.__patBridge = { createSiblingResolver }`；`waitForFunction` 等导出就绪 | PAT-01~05 |
| stub store | 页内对象：`read(path)` 记录调用路径，按文件表返回字节；退化形态可切换（抛 `Error`、抛 `DOMException('AbortError')`、无 `read`、无 `store`）；另有 `fireAndForget` 形态（不 await 不 catch → 拒绝落到页面 `unhandledrejection` 通道） | PAT-01~05 |
| 穿越命名 zip | jszip `file('../secret.txt', …)`（**写面不消解**——jszip 3.10 的 `lib/object.js` 无 `utils.resolve`，消解只在读侧 `lib/load.js:66`；实测 `z.file('../secret.txt')` 的 forEach 名字为 `['../','../secret.txt']`）→ `generateAsync({type:'nodebuffer',compression:'STORE'})` → 断言包体含 `../secret.txt` 字面 | PAT-07 |
| 穿越命名 tar | 手写 ustar：512B 头（name/mode/uid/gid/size/mtime/chksum/typeflag/magic/version，chksum 为头字节和的八进制）+ 512B 对齐数据 + 两块零尾。**已用系统 `tar -tvf` 实测**：条目名原样列出（`../secret.txt`，16B）+ `ok.txt`（12B）；解包时 GNU tar 报 "Member name contains '..'"（即其安全解包对 '..' 成员拒绝） | PAT-09 |
| MIME 合成器 | RFC822 头（From/To/Subject/Date/MIME-Version）+ `multipart/mixed` + `text/plain` 正文段 + `application/octet-stream` 附件段（base64 76 列折行，`Content-Disposition: attachment; filename="…"`）。**已用 postal-mime 4.1.4 实测**：附件名原样保留（`x.z/evil`），字节逐字节等值 | PAT-08 |
| 下载名观测钩子 | 覆写 `HTMLAnchorElement.prototype.click`，记录被点锚的 `download` **属性**（产品侧合成名真值）。落盘文件名（`suggestedFilename`）被浏览器兜底消毒（`'../../x'`→`'_x'`、`'a/b/x'`→`'a_b_x'`），在该层观测路径成分恒被消毒 → 断言恒真 | PAT-08 |
| 下载捕获器 | `page.on('download')`（blob 兜底通道 `<a download>` 点击）+ `download.path()` 回读落盘字节 | PAT-08 |

## 3. 验收行为

### 3.1 残余 A4 的回归护栏（PAT-01~05）

- **缺陷现状（已修，防回退）**：`posixJoin` 规范化收紧前，穿越段与前导 `/` 会退化为父目录读 / 根逃逸读（commit `9471efd`，2026-11-07）。
- **修复后应有行为（回归验收判据）**：契约外 sibling 名（空名 / 前导 `/` / 任一 `..` 段）一律拒读——resolver 返回 `null`、**且 `store.read` 零调用**；目录型来源（`path` 以 `/` 结尾）/ `read` 抛错（含取消）一律兜 `null` 且不抛。
- **回归不破坏**：合法 sibling 仍命中且读路径为 `dirname(source.path) + name`（根级来源直接取名）；退化形（`a//b.csv`、`./a/b.csv`）读路径仍归一为 `a/sib.json`；**含 `..` 子串但非独立段的合法文件名（`..foo`、`a..b.json`）仍放行**。
- **断言口径说明**：
  1. 本域断言「读路径字符串精确相等」而非「调用过一次」——只断言调用次数会被「读了但路径错了」的实现蒙混过关。
  2. **调用序列断言是承重项**：PAT-03 的若干形态（空名、目录型来源）在守卫被摘掉后，读会因路径未命中而抛错、被产品兜成 `null`——此时「返回 null」仍成立，只有「`store.read` 零调用」会红。故 PAT-01~03 必须保留 `calls === []` 断言。
  3. **「store 缺失 / store 无 read」两形态已剔除（恒真）**：`bridge.ts:239` 的守卫被摘掉后，`store.read` 调用（store 缺失 → `undefined.read`；store 无 read → 非函数）都落在 `try` 内被 `catch {}` 吞成 `null`——外部可观测面与守卫存在时**完全一致**，任何断言都无法判别（变异实测：删守卫后两形态仍全绿）。故 PAT-03 不含这两形态（若产品后续把守卫移到 `try` 之外并显式区分，可再补断言）。
  4. **保守拒是当前契约**：任一 `..` 段即拒（含 `a/../b.json` 这类「解引用后并不出根」的形态，bridge.ts:225-227）。若产品后续放宽为「解引用后不出根才拒」，PAT-01 的第一个子用例需同步调整。
  5. **段判定 vs 子串判定**：守卫是「段」判定（`name.split('/').includes('..')`）。若退化为「任意 `..` 子串」，`..foo`/`a..b.json` 这类**合法文件名会被误拒**——过度拦截是越权防护的反面故障，PAT-01 的对向子用例即其鉴别锚。

### 3.2 本域登记的产品缺陷（已修，转回归护栏）

| 编号 | 现象 | 修复（产品侧） | 现状 | 锚 |
| --- | --- | --- | --- | --- |
| PAT-EX-01 | 嵌套附件兜底下载的**产品侧合成名**携带路径分隔符：恶意附件名 `x.z/evil` → 上游 `getAttachmentExtension`（`@file-viewer/renderer-email` dist `email.js:211-214`，取 `lastIndexOf('.')` 之后的后缀）产出扩展名 `z/evil` → `nestedName('z/evil')`（`apps/web/src/lib/foreignRenderers.ts:68-73`，含点分支原样返回）产出 `attachment.z/evil` | **已修**（FOM 轮）：`apps/web/src/lib/foreignRenderers.ts:81-109` 新增 `fileNameOnly`（取 basename、拒空/'.'/'..'）与 `nestedDispatchName`（优先用上游 context.filename 的附件原名并文件名化，回落 `nestedName(type)` 且同样文件名化），装配面 `:194` 消费 → 恶意附件名不再派成扩展名、不再落成含路径的下载名 | **绿**：`<a download>` 属性为文件名化的裸名（附件 'x.z/evil' → 'evil'） | PAT-08（硬断言） |
| PAT-EX-02 | 非 jszip 归档路径（tar/7z/rar → libarchive）的条目名**不做路径消毒**即进产品条目树：libarchive 的列举 API 原样返回 pathname（`archive_read_next_header` 不消毒），libarchive.js 的 `getFilesObject` 按 `/` 拆嵌套对象（`utils.ts` `getObjectPropReference` 无消毒），产品侧 walk（`packages/vviewer-render-archive/src/libarchiveStore.ts`）按原名聚合 → 条目树出现名为 `..` 的目录 | **已修**（本轮）：`packages/vviewer-render-archive/src/zipStore.ts` 新增导出 `normalizeArchiveEntryPath`（丢弃空段/'.' 段、'..' 段扁平化到上级且不越出归档根、剥掉前导 '/'，与 jszip 读侧 `utils.resolve` 同口径）；`libarchiveStore.ts` 的 walk 以规范化后的路径作 `sizes`/`handles` 键（句柄原样保留 → `extract()` 仍按原始 pathname 定位条目，解出的是该条目自身字节）；同族面一并收口：`zipStore.ts` 的 `parseZipCentralDirectory`（加密 zip 自解析中心目录）同样按规范化路径建键（否则与 libarchive 侧键不一致 → read 落「未知路径」）；纵深防御：`zipStore.ts` 的 `listTreeChildren` 对穿越段名（'..'/'.' 独立段）不产子项 | **绿**：tar 夹具（条目 `../secret.txt`）的条目树无穿越段名，条目以扁平化名 `secret.txt` 呈现且可读（内容为归档自身字节） | PAT-09（硬断言）+ 包内单测 `packages/vviewer-render-archive/test/tar.test.ts`、`zip.test.ts` |

> 两条缺陷均已按「产品缺陷由分诊阶段单独修复」处置：PAT-EX-01 由 FOM 轮的产品改动修复（`apps/web/src/lib/foreignRenderers.ts`），PAT-EX-02 由本轮的产品改动修复（`packages/vviewer-render-archive/src/{zipStore,libarchiveStore}.ts`）。两处红锚均**未弱化换绿**——修复后 `expect.soft` 升为硬断言（回归护栏）。

### 3.3 已知缺口（登记备查，本轮未落锚）

1. **兄弟边车（sibling）端到端未接通**：`resolveSibling` 从未被应用消费（见 §1.2），`.shp` 的 `.shx`/`.dbf`/`.prj` 边车链路在产品面不可达；桥接层的防御目前只有「模块级锚」与单测锚。
2. **加密 zip 的条目名消解已随 PAT-EX-02 一并收口**（产品侧 `zipStore.ts` 的 `parseZipCentralDirectory` 改为按 `normalizeArchiveEntryPath` 建键），但**e2e 仍无锚**：加密混合包夹具（ZipCrypto + libarchive 兜底读取面）构造成本高于本轮预算 → 该面目前只有包内单测（`zip.test.ts` 的中心目录规范化用例）覆盖。
3. **「取消不被误当读失败上屏」在 resolver 层无观测面**：`bridge.ts:246-248` 的 `catch {}` 对普通 `Error` 与 `AbortError` 同等吞掉，resolver 对两者都返回 `null`——「取消语义」与「读失败语义」在返回值上不可分（PAT-04 因此只钉「两者都兑现为 null + 读被尝试过一次 + 不外泄」）。若产品后续要在上层区分取消与失败（如错误卡片文案），需在 resolver 返回面上扩展契约再补锚。
4. **`nestedName` 的含点分支未做路径成分过滤**：见 PAT-EX-01（已红锚）。另一侧问题是「type 含 `.` 时原样返回」本身允许完整文件名穿透（`nestedName('a.b') === 'a.b'`）——该分支当前只有上游裸扩展名调用方可达（`getAttachmentExtension` 只传扩展名），未来若有调用方传完整文件名，合成名会带路径。

### 3.4 本域未覆盖的相邻面（不属本域或已被他域覆盖）

- 服务端文件服务路径穿越：SRV-09（`apps/web/e2e-server/b-server-file-service.spec.ts:185`）已覆盖（`../` 与 `%2e%2e%2f` → 400、root 外 symlink → 403）。
- markdown 外域 `img src` 拦截：BUG-17/BUG-40（`packages/vviewer-sanitize/src/sanitize.ts:308-325`）已有锚（`b-md-export.spec.ts:40`）。
- git 面板 `gitdir:` 越界与 `resolveRelPath` 越界（`apps/web/src/lib/git/gitFs.ts`）：单测有锚，e2e 未落；触发面需构造恶意 git 仓库，不在本域分配的缺口清单内。

## 4. 环境与数据

### 4.1 环境

| 项 | 值 |
| --- | --- |
| 套件 | `apps/web/e2e/b-path-normalize.spec.ts`（playwright `testDir: apps/web/e2e`） |
| project | `chromium`（桌面 1280×720 默认视口）；mobile project 由 `test.beforeEach` + `testInfo.skip` 跳过 |
| 预览面 | `pnpm vite preview --host 127.0.0.1 --port 4173 --strictPort`（playwright.config `webServer` 自动拉起，`baseURL=http://127.0.0.1:4173`） |
| 外网依赖 | **零**。PAT-01~05 走模块注入（产品页本地加载）；PAT-06~09 全部本地合成（markdown + PNG / zip / tar / eml），无任何外域请求 |
| SW | 无需 `serviceWorkers:'block'`——本域无外域请求面（PAT-08 的邮件渲染器属零资产组，不拉 CDN；PAT-01~05 在产品页内注入模块，不发外域请求） |
| 桌面跳过 | `test.beforeEach` + `testInfo.skip(testInfo.project.name !== 'chromium', …)` |
| 用例时限 | PAT-01~05 `test.setTimeout(60_000)`（含产品页加载 + 模块注入）；PAT-06~09 `test.setTimeout(180_000)`（首屏懒加载 chunk + 引擎初始化 + 邮件解析遮罩撤除）——**默认 30s 上限会让含 60s/90s/120s 断言的用例必然超时**，故逐用例显式放宽（对齐 `b-foreign-office-3.spec.ts` 的 180_000/240_000 先例） |

### 4.2 数据清单

| 数据 | 规格 | 用于场景 |
| --- | --- | --- |
| 桥接源码 | 仓内 `packages/vviewer-render-foreign/src/bridge.ts`（测试时读盘转译注入，非构建产物） | PAT-01~05 |
| stub store 文件表 | `a/b/ok.json`→`[1,2,3]`；`a/b/other.json`→`[9,9,9]`；`a/b/..foo`→`[4,4]`；`a/b/a..b.json`→`[5,5]`；`a/sib.json`→`[7,7]`；`sib.json`→`[8,8]`；读未命中路径抛 `未知路径: …` | PAT-01~05 |
| `pat-doc/readme.md` | 文本：`# PAT 相对图片探针` + `![pat-ok](./img.png)` + `![pat-escape](../../secret.png)` | PAT-06 |
| `pat-doc/img.png` | 1×1 PNG（`b-markdown-html-docs-helpers` 的 `PIXEL_PNG_B64`）——对照图须真像素才能解码出 `naturalWidth>0` | PAT-06 |
| `secret.png` | 1×1 PNG（与上同字节；越界目标的**存在**才是关键——守卫放宽时会解析成 store 内文件而暴露） | PAT-06 |
| `bundle.zip` | jszip 生成（写面直给穿越名）：条目 `ok.txt`（`ZIP-OK-BYTES`，12B）与 `../secret.txt`（`ZIP-ESCAPE-BYTES`，16B；应用侧读入时 jszip 消解为 `secret.txt`）；`STORE` 压缩 | PAT-07 |
| 宿主 `secret.txt` / `../secret.txt` | `HOST-SECRET-BYTES`（17B）/ `HOST-RAW-SECRET-BYTES`（21B）——与归档条目同名 / 同原始路径，内容各异；两条都进 local store（`../secret.txt` 经 `webkitRelativePath` 落到 store 的 `..` 目录键下），越界读的「串内容」两面可判别 | PAT-07、PAT-09 |
| `bundle.tar` | 手写 ustar：条目 `ok.txt`（`TAR-OK-BYTES`，12B）与 `../secret.txt`（`TAR-ESCAPE-BYTES`，16B）；系统 `tar -tvf` 实测可列（条目名原样） | PAT-09 |
| `probe.eml` | RFC822/multipart-mixed；附件 `x.z/evil`（`EVIL-ATTACHMENT-BYTES`，21B）与 `other.zzz`（`OTHER-ATTACHMENT-BYTES`，22B），MIME `application/octet-stream`（无 byExtension 命中 → 落 blob 下载兜底） | PAT-08 |

### 4.3 断言纪律与已知易踩面（写/改本 spec 前必读）

1. **无恒真断言**：每条断言都能被一处具体产品改动打红（例：PAT-01 在 `isUnsafeSiblingName` 的段判定退化为子串判定时变红——`..foo`/`a..b.json` 被误拒；PAT-05 在 `posixNormalize` 被摘掉时变红；PAT-06 在 `resolveInStorePath` 的「`..` 弹空返 null」被去掉时变红——越界图会解析成 store 根的 `secret.png`；PAT-07/PAT-09 在归档读回落到宿主 store 时变红——视图出现宿主字节）。
2. **模块注入装置的局限**（写/改前必读）：PAT-01~05 验的是**源码**语义（测试时读盘转译），PAT-06~09 验的是**构建产物**语义（vite preview）。同一提交内二者一致；跨提交时若源码已改而未重建，模块级锚会先红——这是「锚的是当前工作区实现」的有意取舍。
3. **jszip 写面不消解、读面才消解**：`utils.resolve` 只出现在 `lib/load.js:66`；`lib/object.js` 无此调用 → `z.file('../secret.txt')` 的条目名原样保留（实测 forEach 名字 `['../','../secret.txt']`）。故 PAT-07 直接用写面给穿越名，无需字节补丁；应用侧读入时该名被 jszip 消解为 `secret.txt` → 条目树里不出现穿越段名。libarchive 路径与加密 zip 自解析路径无此消解 → 产品侧在**聚合期**统一按 `normalizeArchiveEntryPath` 规范化（PAT-EX-02 的修复面，详见 §3.2）。
4. **下载名要在产品侧观测**：`suggestedFilename` 被浏览器兜底消毒（`'../../x'`→`'_x'`、`'a/b/x'`→`'a_b_x'`、`'..'`→`'download'`），在该层断言「无路径成分」恒真。PAT-08 因此观测 `<a download>` 的 **download 属性**（产品侧合成名真值）。
5. **markdown 渲染根即宿主元素本身**：`apps/web/src/lib/ViewerPane.svelte:1152` 的宿主 div（`class="vv-viewer-host"`）就是 dispatch target（`:888` `dispatcher.dispatch(current.source, pumpBuffer, host, …)`），markdown 渲染在同一元素上加 `'vv-markdown'`（`packages/vviewer-markdown/src/markdownRenderer.ts:587` `target.classList.add('vv-markdown')`）→ 后代选择器 `.vv-viewer-host .vv-markdown` **恒不匹配**（`.vv-markdown` 元素自身即宿主，宿主的后代里没有 `.vv-markdown`）。PAT-06 用 `.vv-markdown` 定位。
6. **「不抛未捕获异常」的落点**：PAT-01~05 走页内 `unhandledrejection` 通道（直调形态自带 try/catch 会把产品拒绝吃掉 → 该形态下页面错误通道恒空，那样的断言是恒真，必须删，故另设 fire-and-forget 形态）；PAT-06~09 改为「不落错误卡 + 期望内容在场」的应用面判据（marker 过滤的 pageerror 断言近恒真，已删）。
7. **目录默认折叠**：注入带子目录时须先点目录行展开再点子文件行；`openNestedTreeFile` 先探 `fileRow.count()` 再决定是否点目录（避免点反折叠）。
8. **计数/时序余量**：markdown 与归档渲染给 20~60s（首屏懒加载 chunk + 引擎初始化 + libarchive worker 启动）；归档条目树是异步展开的（`expandInto` → `store.listChildren`），须先 poll 到条目行出现再断言条目名；邮件解析遮罩撤除给 120s（上游零资产组，但首开需懒加载 `@file-viewer/renderer-email` chunk）；下载事件捕获给 30s。
9. **图片解码对照锚不可省**：PAT-06 先断言对照图 `naturalWidth > 0`（证明本环境图片能加载），再断言越界图未被物化（`src` 字面量 + blob 计数为 1）——顺序颠倒会把「图片还没加载」误判成「越界被拒」。相对图片的解析发生在**挂载前**（`markdownRenderer.ts:582` 早于 `:591`），故 markdown 一可见即已完成解析，越界图的 `src` 断言非真空。
10. **libarchive 解包按原始 pathname 定位条目**：产品侧规范化只改「树内路径」，`CompressedFile.extract()` 仍用原始 pathname（上游 `compressed-file.ts` `extractSingleFile(this._path)`）→ 穿越命名条目解出的仍是**归档自身字节**（包内单测 `tar.test.ts` 已实跑验证：read('escape.txt') → 'escape bytes'）。注意 GNU tar 命令行在**落盘**时对 `..` 成员报 "Member name contains '..'"（本轮 `tar -xf` 实测），那是 tar CLI 的安全解包策略，与 libarchive.js 的内存提取不同。
11. **不写死注册面数量**：本域零注册面断言（扩展名/渲染器数量会变）；内容与路径断言均为语义口径。
12. **Playwright 每用例独立 BrowserContext**：本域无跨用例缓存/存储断言。

## 5. 场景编号登记

本域独占编号段（全局唯一，跨域不撞号）：

| 编号 | 一句话意图 |
| --- | --- |
| PAT-01 | 桥接 sibling 名的穿越判定按独立段：`..` 段拒读、含 `..` 子串的合法文件名放行 |
| PAT-02 | 桥接 sibling 名以 `/` 开头（根逃逸）一律拒读，返回 null 且 `store.read` 零调用 |
| PAT-03 | 桥接契约外输入（空名 / 根级来源 / 目录型来源）返回 null 且零读 |
| PAT-04 | 桥接 `store.read` 抛错（含 AbortError 取消形态）兜 null、读被尝试过一次且失败不外泄为页面未处理拒绝 |
| PAT-05 | 桥接合法 sibling 命中：读路径为 dirname 拼接（根级来源直接取名）、字节精确不串别的文件、退化形读路径归一 |
| PAT-06 | markdown 相对图片越界引用不解析成 store 内文件，同目录相对图仍解析且不落错误卡 |
| PAT-07 | 归档条目名含 `..` 段（jszip 路径）不越出归档命名空间，树内无穿越段名且内容取归档自身字节 |
| PAT-08 | 嵌套附件兜底下载名（产品侧合成名）不含路径成分，落盘字节为被点附件自身负载、不串别的附件 |
| PAT-09 | 归档条目名含 `..` 段（tar / libarchive 路径）不越出归档命名空间，树内无穿越段名且不取宿主同名文件内容 |
