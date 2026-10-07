# M4 二进制与媒体 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** PDF（pdfjs+搜索）、hex/结构树（零依赖自研 Worker）、压缩包（zip/tar/7z + 包内递归预览）、Office 三件套（成熟库集成）、ArtPlayer 媒体播放升级。

**Architecture:** 三个新包 `@vviewer/render-doc`（pdf+office）、`@vviewer/render-binary`（hex）、`@vviewer/render-archive`（压缩包+ArchiveStore）；av.ts 升级 ArtPlayer。全部重依赖动态 import；压缩包通过 ArchiveStore 接入 TreeStore 后由派发器递归复用。

**Tech Stack:** pdfjs-dist 5.x、jszip、libarchive.js（tar/7z/rar）、mammoth.js（docx→HTML）、SheetJS community（xlsx→表格）、pptx 预览（实测选库：pptx-preview 或类似 MIT/Apache 库；找不到维护良好的就用"幻灯片占位+错误卡"降级并记录）、artplayer 5.x + hls.js/mpegts.js 按需。

**Spec:** `docs/superpowers/specs/2026-10-06-vviewer-design.md`（5.5 媒体 / 5.6 PDF/hex/压缩包/Office / Q16 ArtPlayer / M4 里程碑行）

## Global Constraints

- 沿用全局约束（TS strict、Angular 中文 commit）。
- **License 门槛**：新引入的每个 npm 包必须 license 兼容（MIT/Apache/BSD/ISC）；AGPL/GPL 禁入。Office 库选定后把 license 记入 `THIRD_PARTY_NOTICES.md`（新建）。
- hex 默认只渲染前 1MB（可"加载更多"翻页，每页 1MB）；结构树解析带时间预算（>2s 停止，已解析部分展示）。
- 压缩包递归深度 ≤3；加密条目给出明确提示（不解密）。
- M4 验收：samples/m4 全格式 E2E（pdf 页面渲染/搜索、hex dump 与结构树、zip 包内树+点击 txt 递归预览、docx/xlsx 渲染、ArtPlayer 视频播放）、连续 3 次全绿。

---

### Task 1: render-doc——PDF 渲染器

**Files:** Create `packages/render-doc/{package.json,tsconfig.json}`、`src/pdf.ts`；Test `test/pdf.test.ts`；Create `THIRD_PARTY_NOTICES.md`
**Interfaces:** `pdfRenderer: Renderer`（id 'pdf'，exts ['pdf']）——pdfjs-dist（`GlobalWorkerOptions.workerSrc` 指向 vite 打包的 worker：`new URL('pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url)` 模式或 copy 到 static，实测选稳的）；页面渲染 canvas（可视页懒渲染，简单版：前 3 页立即 + IntersectionObserver 其余）；缩放按钮；**搜索**：pdfjs `getDocument().getPage()` 的 textContent 聚合 + RenderedInstance.search/gotoMatch（复用 M3 SearchPanel 契约——命中页跳转 + 高亮矩形叠加可选，简单版跳页即可）。pdfjs 的 worker 与 cmaps 资产处理是主要实测点。验收样例：samples/m4/sample.pdf（用 node 脚本生成最小 PDF 或入库一个 <50KB 的手工 PDF）。
**Steps:** 测试（jsdom 下 pdfjs 不可用→E2E 断言为主；单测只测 textContent 聚合纯函数）→ 实现 → build 绿 → Commit `feat(render-doc): PDF 渲染器（懒分页/缩放/文本搜索）`

### Task 2: render-binary——hex 渲染器与结构树

**Files:** Create `packages/render-binary/{package.json,tsconfig.json}`、`src/{hex.ts,struct.ts,binary.worker.ts}`；Test `test/{hex.test.ts,struct.test.ts}`
**Interfaces:** `hexRenderer: Renderer`（id 'hex'，exts ['bin','exe','dll','so','dylib','elf','o','a','class','wasm','dat'] 及未知二进制兜底——**与 core 派发器协作：未知扩展名仍走 error 页，hex 只接显式扩展名**）；`renderHex(buffer, target, opts)`——经典三列（偏移/十六进制/ASCII），前 1MB + "加载更多"按钮；`parseStruct(head: Uint8Array): StructNode | null`——magic 识别（PNG/JPEG/GIF/PDF/ZIP/ELF/PE/Mach-O/GZ 七种）输出结构树（字段名/偏移/值），时间预算 2s；Worker 化（big buffer 解析不卡主线程——模式参考 packages/highlight 的 core-parse+薄壳）。UTF-16/be 列可后续。结构树 JSON 渲染为可折叠 `<details>` 树。
**Steps:** 失败测试（parseStruct：PNG 真实头解析出宽高字段；ELF 头 magic/class/endian；超预算返回已解析部分）→ 实现（含 worker）→ 绿 → Commit `feat(render-binary): hex 渲染器与 magic 结构树（Worker 化）`

### Task 3: render-archive——zip + ArchiveStore + 递归预览

**Files:** Create `packages/render-archive/{package.json,tsconfig.json}`、`src/{archive.ts,zipStore.ts}`；Modify `apps/web/src/lib/viewer.ts`、AppShell/ViewerPane（包内树）；Test `test/zip.test.ts`
**Interfaces:** `archiveRenderer: Renderer`（id 'archive'，exts ['zip']）——jszip 解析（内存，上限 200MB 输入提示）→ 条目列表（目录树 UI 复用 FileTree？不行——ArchiveStore 实现 TreeStore 接口：`createZipStore(buffer: Uint8Array): TreeStore`（listChildren/read，加密条目 kind 标记 + read 抛"加密"错误）→ ViewerPane 检测到 archive tab 时左栏树切换为 ArchiveStore（M1 的 dirStore $effect 需扩展：archive tab 激活时树显示包内）。**递归预览**：包内文件点击 → addTab(zipStore, path, name) → 派发器自然路由（txt→code、png→image…）。深度计数：store id 链 `zip:<parentStoreId>:<path 截断>`，超 3 层拒绝再嵌套。加密条目：jszip 侦测（read 抛错捕获后错误卡提示）。
**Steps:** 失败测试（zipStore：jszip 构造内存 zip → listChildren 层级/read 内容/加密 zip 抛错）→ 实现 → 绿 → Commit `feat(render-archive): zip 包内树与递归预览（ArchiveStore）`

### Task 4: libarchive 扩展（tar/7z/rar）

**Files:** Modify `packages/render-archive`（`src/libarchiveStore.ts`）
**Interfaces:** `createLibarchiveStore(buffer): Promise<TreeStore>`——libarchive.js（wasm，动态 import；其实测点：worker 与 wasm 资产的 vite 处理）；exts 扩展 tar/gz/tgz/bz2/xz/7z/rar 注册到 archiveRenderer 的 sniff 或第二 renderer（裁决：同一 renderer id 'archive'，exts 合并，render 内按 magic 分派 jszip/libarchive）。加密/不支持格式明确错误。
**Steps:** 失败测试（tar 内存构造 libarchive 解析——libarchive.js 在 vitest 可用性实测，不可用则此包测试走 E2E）→ 实现 → 绿 → Commit `feat(render-archive): tar/7z/rar 支持（libarchive.wasm）`

### Task 5: Office 三件套

**Files:** Modify `packages/render-doc`（`src/{docx.ts,xlsx.ts,pptx.ts}`）
**Interfaces:** docxRenderer（exts docx；mammoth convertToHtml → 净化（复用 render-text sanitize？跨包依赖裁决：**把 sanitizeHtml 提升到 @vviewer/core 或新建依赖方向 render-doc → render-text？裁决：render-doc 依赖 render-text（复用 sanitize），方向单一无环））；xlsxRenderer（exts xlsx/xlsm/csv——csv 已归 code！裁决：csv 保持 code；xlsx 用 SheetJS sheet_to_html → 净化 → 表格；大 sheet 前 200 行 + 提示）；pptxRenderer（exts pptx——实测选库：`pptx-preview`（维护/license 实测），找不到合格库则降级"幻灯片文本提取"（jszip 读 slide XML 文本）并在报告记录偏差）。全部动态 import；OOXML magic 预检（zip + [Content_Types].xml 部件校验）进 renderer.sniff。
**Steps:** 失败测试（xlsx：SheetJS 造小表→渲染表格断言；docx：mammoth 造最小 docx buffer？构造难——用 fixture 入库 10KB 真实 docx）→ 实现 → 绿 → Commit `feat(render-doc): Office 三件套（docx/xlsx/pptx）`

### Task 6: ArtPlayer 媒体升级

**Files:** Modify `packages/render-media/src/av.ts`、`package.json`（artplayer + hls.js/mpegts.js 可选依赖）
**Interfaces:** avRenderer 改用 ArtPlayer（视频）——`new ArtPlayer({ container, url: blobUrl, type, customType: { m3u8: hlsLoader, flv: mpegtsLoader } })`；hls.js/mpegts.js **动态 import 仅当扩展名匹配**（.m3u8/.flv/.ts）；音频保持原生 `<audio>`（spec 决策）；destroy 时 `art.destroy()`；blob URL 生命周期不变。ArtPlayer 容器样式接入主题变量。
**Steps:** 失败测试（jsdom 无法真渲染 ArtPlayer——单测断言容器构造参数与类型分派纯函数；真实播放走 E2E）→ 实现 → E2E 补视频播放断言（video 元素存在 + readyState>0 或 error 无）→ Commit `feat(render-media): ArtPlayer 播放器集成（hls/flv 按需）`

### Task 7: samples/m4 + E2E

**Files:** Create `apps/web/e2e/m4.spec.ts`、`samples/m4/`（sample.pdf、sample.zip（内含 hello.txt+nested/inner.txt+secret 加密可选）、sample.tar、sample.docx、sample.xlsx、sample.mp4（几 KB 的最小 mp4——ffmpeg 生成？环境无 ffmpeg——用公开最小 mp4 base64 入库）、sample.bin）
**Interfaces:** 断言：pdf canvas/文本层、pdf 搜索计数；hex 三列与结构树展开；zip 包内树 → 点击 hello.txt 出现 code tab（递归）→ 深度限制提示；docx 渲染 `<p>`；xlsx 渲染 `<table>`；ArtPlayer 容器 `.artplayer` 或 video 存在。连续 3 次。
**Steps:** 样例（node 脚本生成 zip/tar/xlsx；pdf/mp4 用最小 fixture）→ E2E → 绿 → Commit `test(web): M4 E2E（pdf/hex/zip/office/artplayer）`

## Self-Review 记录

- Spec 覆盖：5.5（T6 ArtPlayer+图片已在 M1）、5.6（T1 PDF/T2 hex/T3-4 压缩包/T5 Office）、M4 验收（T7）；文件变更监听属 M5。
- 依赖方向裁决：render-doc → render-text（sanitize 复用），无环；archive 递归复用派发器（apps/web 层）。
- 风险标注：pdfjs worker 资产、libarchive.js vite 集成、pptx 选库是三个实测决定点，均有降级路径。
