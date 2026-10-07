# vviewer 设计文档：网页版只读文件查看器

日期：2026-10-06（初稿）｜修订：2026-10-07（grilling 共识合入）
状态：待评审

## 1. 背景与目标

vviewer 是一个**网页版只读文件查看器**，支持代码、Markdown、HTML、图片、音视频、PDF、压缩包、Office 文档与二进制（hex/结构）的浏览，不做任何编辑功能。项目按**开源工程标准**建设（CI、release、license 合规、双语文档可后置），优先服务**自用 + 内网小团队**场景。

首期交付两个版本：

1. **纯前端版**：部署到任意静态托管站点（PWA）。通过拖拽/对话框打开本地**文件或文件夹**，全部解析渲染在浏览器内完成。
2. **带后端版**：Rust + axum 单二进制，两个递进档位：
   - **档 1 文件服务**：浏览与打开服务器本地文件（目录树 + 文件流 + 变更推送），渲染仍在前端。
   - **档 2 计算卸载**：高亮、Markdown 渲染、压缩包解包、格式检测、二进制结构解析、**跨文件搜索（ripgrep）**等重任务放到后端执行，避免浏览器过大的性能消耗。

**移动端是一等公民**：布局、交互（触屏手势）、性能预算均按桌面 + 移动双档设计。

### 成功标准

- 纯前端版可静态托管后离线使用（PWA 应用壳 + 已缓存资产），本地文件夹浏览全部支持格式。
- 带后端版档 1 可浏览服务器目录树、流畅查看大文件（Range 流式）、文件变更自动刷新。
- 档 2 下浏览器不做 wasm 重解析；跨文件搜索由服务端 ripgrep 完成。
- 代码高亮覆盖 helix 语言清单（目标 ≥264，编译失败者清单化并 hljs 兜底）。
- Markdown 与代码高亮均支持多主题切换，markdown 内代码块与代码主题联动。
- 当前文件内搜索：代码/文本/markdown/HTML 源码/PDF 全部支持。
- 会话（标签页、滚动位置、句柄）跨刷新完整恢复（桌面 Chromium）。
- 性能预算达成（见 5.11 节量化表）。

### 明确不做（YAGNI）

编辑能力；服务端媒体转码；弹幕、网盘协议对接；登录/多用户体系（token 不是用户体系）；Kroki 等远程图表服务（默认关闭，架构保留）；LSP/语义诊断；密码保护压缩包；多根工作区（同时挂多个文件夹根）；会话跨设备同步；完整 WCAG 审计（只做基础 a11y）；应用自动更新。

## 2. 参考项目与技术事实基线

### 2.1 复用策略

| 项目 | 定位 | 复用内容 | License 约束 |
|---|---|---|---|
| helix-editor/helix | 终端编辑器 | `languages.toml`（语言检测规则 + grammar 清单 286 条）、`runtime/queries/`、`runtime/themes/`（220 主题）、shebang 检测正则、主题最长前缀回退逻辑 | MPL-2.0（文件级），保留来源声明 |
| markpad-aio/Markpad | Tauri 桌面 Markdown 应用 | 前端五步渲染管线、`queries/`（286 目录已含继承父目录，vendored）、languages.toml + grammar_info.json（验证过的 264 语法清单与 subpath 表）、tree-sitter build.rs 骨架、comrak 渲染（档 2）、styles.css 主题体系、VSCode 主题导入映射（P2） | 项目自有（BSD-3） |
| flyfish-dev/file-viewer | 纯前端查看器组件库 | core 架构骨架（注册表/派发器/签名重定向/预检/编码检测）、`renderer-text`（大文本虚拟滚动、HTML 沙箱双层防御）、`renderer-binary`、format-catalog 数据驱动注册模式 | Apache-2.0 |
| zhw2590582/ArtPlayer | HTML5 播放器 | **集成为视频/音频播放 UI**（缩略图/画中画/字幕/倍速/移动端触控） | MIT |
| DIYgod/DPlayer | HTML5 播放器 | 仅交互参考（已停滞：2023-01 后无版本发布） | — |
| maple3142/GDIndex | 网盘索引前端 | 参考：文件列表 + 流式媒体播放交互 | MIT |
| OpenListTeam/OpenList | 网关文件列表 | **仅参考设计**：按扩展名路由预览器、Range 流播放 | AGPL-3.0，禁止引入代码 |

### 2.2 技术事实基线（查证日期 2026-10）

| 事实 | 依据 |
|---|---|
| web-tree-sitter **锁 ~0.25.10**（0.27 要求 wasm 含 dylink.0 节，与 tree-sitter-wasms 0.1.13 预编译产物不兼容，实测；0.25 起 ABI 13–15 可用）；CLI 生成默认 ABI 14、`--abi 15` 可对齐；`tree-sitter-wasms` 0.1.13 实测仅 36 个 wasm（M2 实况） | npm registry + 实测（M2） |
| highlight.js 11.12.0（2026-08）活跃维护；核心 199 语言定义；258 个 CSS 主题 | npm + 仓库实测 |
| FS Access API（`showDirectoryPicker`）**仅桌面 Chromium**（全球支持率约 30%）；Firefox/Safari 无本地目录 API（OPFS 仅沙箱内存储，不解决打开本地目录） | caniuse + MDN BCD |
| `webkitdirectory` 于 2025-08 达成 Baseline：桌面全支持；**iOS Safari 18.4+（2025-03）、Android Chrome 132+**——移动端文件夹打开的唯一跨浏览器路径 | MDN BCD |
| ArtPlayer 5.4.0 活跃（2026-09 仍在迭代）；hls.js 1.7.3、mpegts.js 1.8.2 维护正常 | GitHub API + npm |
| 浏览器基线：evergreen 最新两个大版本（Chrome/Edge/Firefox/Safari）；FS Access 降级路径见 5.7 | 决策 Q2 |

### 2.3 tree-sitter 避坑结论（来自 markpad 实证）

**采纳的做法**

1. 单一事实来源：grammar 清单用 `languages.toml`（git+rev+subpath），wasm 与 Rust 原生两条路线都由它生成。
2. 查询集 vendored 入库：搬 markpad `src-tauri/queries/`（286 目录，含 `ecma`、`_typescript`、`_jsx` 等继承父目录）；`; inherits:` 运行时递归合并（父查询在前），算法移植 markpad `highlight/mod.rs:134-219`。
3. 原生侧 build.rs 骨架照抄：cc 编译 + **强制 `-std=gnu11`（C）/`-std=gnu++17`（C++）**、C++ scanner（astro/cmake/haskell-persistent/lean/org/ruby/vue/yaml 等 8 个）外部 g++ 编译后 `ar rs` 合并并加 `-fPIC`、导出符号名 override 表（如 sshclientconfig → `tree_sitter_ssh_client_config`）、代码生成 FFI 分发表。
4. config **懒加载 + 缓存**（markpad 曾因启动预建 264 个 config 卡死而返工）。
5. hljs 兜底以"高亮调用返回 Err"为信号，前端**不做语言名单预检**（markpad 曾因别名不一致删除预检）。
6. CI 必须强制下载/校验 grammar（markpad CI 缺此步骤，发布包静默退化为 0 语法）。
7. subpath 多语法仓库以 **parser.c 实际存在为判据**生成构建清单（markpad 因此丢了 14 个语法）。
8. fence 语言别名表 + 伪语言映射（math→latex、vegalite→json、bpmn→xml、graphviz→dot）。

**markpad 未解决、vviewer 必须做对的**

1. **injection 二级高亮**：markpad 的 injection 回调是 `|_| None`。vviewer 前后端两条高亮路线都必须实现 injection callback（按 `@injection.language` / `#set! injection.language` / shebang 解析语言名，递归调用对应 grammar，深度限 3）。
2. **超时/取消/大小上限**：解析放 Worker（前端）/ async 任务（后端），大文件按阈值降级。
3. ABI 全量回归：runtime 升级时对全量 grammar 重新构建验证（不是粗筛）。
4. 补齐 markpad 放弃的 14 个语法（markdown、markdown_inline、ocaml、ocaml-interface、php-only、prolog、v、vue、wast、wat、fortran、glimmer×3）；vue/glimmer 符号冲突单独排查。
5. 别名表剔除死条目（markpad `registry.rs` 存在指向未编译语言的死别名）。

## 3. 总体形态

**一个前端，四种文件来源，后端两档能力。**

```
                     ┌─ 纯前端版（静态托管 + PWA）：
                     │   来源 = 本地文件 / 本地文件夹 / URL；计算全在浏览器
同一个 SvelteKit 前端 ─┤
                     └─ 带后端版（axum 单二进制）：
                         档 1 文件服务：来源 += 服务器目录（/api/tree、/api/file、/api/events）
                         档 2 计算卸载：高亮/markdown/解包/检测/结构解析/ripgrep 搜索可选在后端跑
```

- 前端运行时探测 `GET /api/health`（免认证，仅含版本与能力集）获取 `file-server` / `compute` 能力，UI 与任务路由按能力启用；探测不到即纯前端形态。
- 后端可关档：`vviewer serve --root DIR [--compute] [--no-assets]`；`--no-assets` 纯 API 模式供纯前端版跨域连接（CORS 显式配置）。
- 纯前端版亦可作为"瘦客户端"直连任意 vviewer 后端（服务器地址在 UI 填写）。

**决策记录**：否决"两个独立 app"与"构建期切换两种产物"（维护成本/部署矩阵翻倍），采用单前端双形态。

## 4. 仓库布局（pnpm monorepo + Cargo workspace）

```
vviewer/
├── apps/web/                # SvelteKit 5 + Svelte 5 前端（唯一前端，双形态，PWA）
├── server/                  # Rust workspace：axum 后端（档 1 + 档 2）
├── packages/
│   ├── core/                # 框架无关：source 归一化、格式检测链、注册表、派发器、
│   │                        #   TreeStore 抽象、ComputeBackend 抽象与路由、搜索服务
│   ├── highlight/           # 高亮运行时：tree-sitter wasm（Worker）、查询继承展开、
│   │                        #   injection 递归、主题映射、hljs 兜底
│   ├── render-text/         # code / markdown / html 渲染器
│   ├── render-media/        # image / video(ArtPlayer) / audio
│   ├── render-doc/          # pdf / docx / xlsx / pptx
│   ├── render-archive/      # zip / tar / 7z 浏览 + 包内递归预览
│   └── render-binary/       # hex dump / 结构树
├── tools/
│   ├── helix-assets/        # 生成 languages.json（检测规则）、themes.json（转换后主题）
│   └── grammar-builder/     # grammar wasm 构建管线（输入 languages.toml + subpath 表）
├── docs/                    # 本文档、ADR
└── samples/                 # 全格式样例文件矩阵（测试用）
```

前端包用 pnpm workspace；`server/` 独立 Cargo workspace（产出单个 `vviewer` 二进制）。

## 5. 子系统设计

### 5.1 格式检测与派发（packages/core）

参考 file-viewer core，检测链：

1. **扩展名主路由**：注册表维护"扩展名 → renderer"唯一所有权映射（冲突在安装期报错）；未知扩展名渲染错误页兜底。
2. **magic 预检**：ZIP/OLE 签名识别 + OOXML/ODF 部件校验；签名与扩展名不符时抛 `RedirectError(actualRendererId)` 二次派发（只重定向一次）。
3. **编码检测**：BOM → UTF-8 字节校验 → GB18030 兜底。
4. **代码语言检测**：接入生成的 `languages.json`（来源 helix `languages.toml` 的 file-types/glob/shebang），shebang 正则与 helix `Loader` 行为一致。
5. 服务端检测（档 1 起）通过 `/api/file` 响应头 `X-VV-Type/X-VV-Lang` 下发，前端信任但不盲从（本地来源走本地链）。

渲染器统一接口：`(buffer, target, type, context) → Promise<RenderedInstance>`；`RenderedInstance` 可声明 `zoom/search/print/exportHtml` 能力，由 core 统一提供工具栏动作。重依赖一律动态 `import()` 懒加载。

### 5.2 代码高亮（packages/highlight + tools/grammar-builder + server 档 2）

**三条路线共享同一份资产**（helix/markpad 的 queries 与主题）与同一个**中间表示**：高亮区间数组 `[{start, end, capture}]`。

| 路线 | 引擎 | 覆盖 | 使用场景 |
|---|---|---|---|
| 前端 wasm | web-tree-sitter ~0.25.10（grammar 按需 fetch `/grammars/{lang}.wasm`，ABI 13–15） | **M2 实况：预编译集 36 语言（22 个查询可用，14 个查询/ABI 失配自动降 hljs）；self-build buildable 278（=263 helix 对齐 + 15 非对齐），全量 ≥264 目标由 CI self-build（需 emcc）承接** | 纯前端版默认 |
| 前端 hljs | highlight.js 11.12 | 199 核心语言 | wasm 失败/无查询/超阈值的兜底 |
| 服务端原生 | tree-sitter 0.25+ + tree-sitter-highlight + 静态链接全部 grammar（markpad build.rs 骨架） | 同一清单 286 | 档 2 高亮卸载 |

**构建期（tools/grammar-builder）**

- 输入：`languages.toml`（git+rev+subpath）+ subpath 表；以下载后 `parser.c` 实际存在为判据生成构建清单。
- C 标准固定 `-std=gnu11`；C++ scanner `-std=gnu++17 -fPIC`（wasm 侧对应 clang `-std` 固定）；C++ scanner 单独编译合并；符号名 override 表；生成期用 `nm` 校验实际导出符号。
- ABI 策略：wasm 以 web-tree-sitter 的兼容窗口（13–15）为闸，超窗语法换用上游 release rev 重新生成并记录。
- 产物：`/grammars/{lang}.wasm` + **可枚举资产清单** manifest（语言名、别名、sha256——service worker 预缓存与 lite 集的输入）；构建失败进失败清单（CI 门禁：失败数只许减少）；增量构建。**M2 实况：tree-sitter-wasms 预编译 36 语言入库（22 个查询可用，14 个查询/ABI 失配自动降 hljs）；`nm` 符号校验属 self-build/CI 路径门禁，wasm 主路径未做。**
- 体积实测 49.4MB（预编译子集，gzip 前原值入库）；lite 精简集（top 30）未做，归属 M7/CI；全量资产随 GitHub Releases 分发，纯前端版支持自定义资产 URL（自托管）。

**运行期（前端）**

- Worker 内 parser 池，wasm 模块按语言缓存；主线程只收区间数组渲染 span；支持取消（切换文件即取消）。
- 查询加载：vendored `queries/` + `; inherits:` 递归展开（父在前）。
- **injection 二级高亮**：解析 `@injection.language` capture 与 `#set! injection.language` 属性，递归派发对应 grammar（html 内 js/css、markdown 围栏代码块）；helix 扩展 predicate（`injection.include-unnamed-children`、`@injection.shebang`）做 shim；递归深度限 3。
- **已知限制（M2 实况）**：`injection.combined` 未实现（assets 中 31 处，单 fence 场景近似正确）；注入超时丢弃子结果（主高亮不受影响）；查询超时显式转失败以接通 hljs 兜底。
- 主题：构建期把 helix 214 个主题 TOML 转 JSON（M2 实测 218 个 toml − 4 个 base16；palette 按 helix 语义含内置 ANSI 表与父主题递归合并）；运行时"最长前缀回退"解析 capture → CSS 变量（`--ts-*`，与 markpad `CAPTURE_TO_CSS` 类名体系一致）；**主题切换零重解析**。

**服务端高亮（档 2）**

- `POST /api/compute/highlight`：输入 `path`（引用服务器文件）或文本；服务端解析全文件并按 `(path, mtime, size)` 缓存区间，前端按可视范围请求区间切片。
- 协议输出与前端 wasm 路线完全相同，前端渲染层无感知。

**降级链（阈值实测后调整；渲染始终虚拟滚动）**

| 文件大小 | 策略 |
|---|---|
| ≤ 5MB | tree-sitter（wasm 或服务端）全量高亮，Worker 解析 |
| 5MB–20MB | 服务端高亮（若可用），否则 hljs 按可视窗口分块 |
| > 20MB | 纯文本虚拟滚动 + 提示 |

**hljs 兜底主题（决策 Q11）**：hljs 使用独立亮/暗双主题（挑自其 258 个 CSS 主题，映射到 `--hljs-*` 变量，markpad 方案），不追求与当前 helix 主题一致；helix 主题 → hljs 类名的自动近似映射器列为 M7 打磨项。

**渲染**：虚拟滚动采用 file-viewer `largeText.ts` 思路（字节级行索引 + 每 256 行 checkpoint + 分块搜索）。

### 5.3 Markdown（packages/render-text）

- 首期单引擎：markdown-it（GFM 插件组：table/strikethrough/tasklist/footnote）→ HTML。
- 后处理管线移植 markpad 五步：**DOMPurify 净化 → 高亮（接 5.2，围栏代码块走 injection 递归）→ 图表 → KaTeX → copyCode/lightbox**；另移植 callouts（`[!note]` 12 种图标）、视频/音频链接增强、YAML front matter、TOC 组件（从预览 DOM headings 构建 + 滚动跟随）。
- 图表：mermaid 必做；graphviz/vega/nomnoml 等懒加载；Kroki 远程默认关闭。
- 档 2 可选 comrak 引擎（移植 markpad `markdown.rs`：数学掩码、GFM 全扩展、sourcepos），管线入口与引擎解耦。
- Obsidian wikilink 首期不做。

### 5.4 HTML（packages/render-text）

双层防御照搬 file-viewer：DOMPurify `WHOLE_DOCUMENT` + 属性白名单二次清洗（去 `on*`、外链 src 仅留 data:）→ 注入严格 CSP meta → opaque-origin sandbox iframe（禁 script/form）。提供"源码 / 渲染"双视图切换（源码视图走 5.2 代码高亮，可搜索；渲染视图不提供搜索——opaque origin 下无法跨文档检索）。

### 5.5 图片与媒体（packages/render-media）

**原则：浏览器自己解码优先，转码库仅兜底。**

- 图片：原生 `<img>`/createImageBitmap（EXIF 方向 `imageOrientation: 'from-image'`）；jpg/png/gif/webp/avif/bmp/ico/svg；SVG 经消毒（禁外部资源）后 blob 渲染；缩放/旋转/平移（**桌面滚轮+拖拽，移动端双指捏合**）；HEIC/TIFF 检测到浏览器不支持时提示并按需加载 heic2any/utif 兜底。
- 视频：**集成 ArtPlayer**（MIT，活跃维护；DPlayer 仅交互参考）；容器/编码浏览器支持即直接播（mp4/webm 等）；`.m3u8` 按需加载 hls.js、`.flv/.ts` 按需加载 mpegts.js；后端版直接消费 `/api/file` 的 Range 流，本地文件用 blob URL；移动端原生全屏 API。
- 音频：原生 `<audio>` 控件（mp3/wav/ogg/flac/m4a）；播放列表、列表连播列 P2。
- 交互参考 GDIndex/OpenList：文件列表点击即播、键盘操作、列表/网格视图；不做弹幕、网盘协议对接。

### 5.6 PDF / hex / 压缩包 / Office

- **PDF**：pdfjs-dist（Worker），文本选择与搜索（pdfjs 自带 findController）。
- **hex/结构**：零依赖自研（参考 file-viewer `renderer-binary`）：magic 识别（PNG/ELF/PE/Mach-O…）+ hex dump + 结构树，Worker 化，时间/深度预算；默认只取前 1MB，档 1/2 走 Range/服务端解析按需分页。
- **压缩包**：jszip（zip）+ libarchive.js（tar/7z/rar），本地解包；包内条目树接入 TreeStore（ArchiveStore），**点击包内文件复用整个查看器递归预览**（深度限 3）。档 2 可切换服务端解包。密码保护压缩包不做（检测到加密条目给出明确提示）。
- **Office**：docx/xlsx/pptx，借鉴 file-viewer 自研引擎（Apache-2.0），懒加载。

### 5.7 文件来源与 TreeStore（packages/core）

统一接口（示意）：

```ts
interface TreeStore {
  listChildren(path: string): Promise<TreeNode[]>;   // {name, kind, size?, mtime?}
  read(path: string, opts?: { range?: [number, number] }): Promise<Uint8Array | ReadableStream>;
  displayName(): string;
}
```

| 实现 | 来源 | 说明 |
|---|---|---|
| LocalFsStore | File System Access API（`showDirectoryPicker`） | 桌面 Chromium 专属；句柄存 IndexedDB，刷新后经 `queryPermission/requestPermission` 恢复 |
| LocalFilesStore | `<input webkitdirectory>` | **移动端统一路径**（iOS Safari 18.4+ / Android Chrome 132+，低版本提示升级或改用服务器模式）；一次性枚举，文件内容按需读取（File 对象惰性，防移动端内存爆）；无持久句柄，会话仅记文件名清单 |
| RemoteStore | `/api/tree` + `/api/file` | 懒加载 + Range |
| ArchiveStore | 压缩包内存解包 | 嵌套在任意 Store 的文件之上 |
| SingleFileStore | 本地单文件 / URL | 拖拽、对话框、粘贴 URL；直连第三方 URL 受 CORS 限制（失败时提示原因） |

左栏文件树组件只有一份实现，消费 TreeStore 抽象。**隐藏文件策略（决策 Q9）**：默认全部显示，设置提供排除模式预设（`.git`、`node_modules`、`dist`…），服务器端同步提供 `--hidden` 开关作用于 `/api/tree`。树排序：目录优先、名称自然排序（可切大小/时间，前端排序）。

### 5.8 计算卸载（ComputeBackend，档 2）

每类重任务定义 Backend 接口，Local/Remote 双实现：

```ts
interface HighlightBackend { highlight(src: TextRef, lang: string): Promise<HighlightIntervals> }
interface MarkdownBackend  { render(src: string): Promise<{ html: string }> }
interface ArchiveBackend   { list(ref: FileRef): Promise<Entries>; extract(ref: FileRef, entry: string): Promise<Uint8Array> }
interface DetectBackend    { detect(head: Uint8Array, name: string): Promise<Detection> }
interface InspectBackend   { inspect(ref: FileRef, kind: string): Promise<StructTree> }
```

- 路由策略：`computePolicy: 'auto' | 'local' | 'remote'`（auto = 按 health 能力与文件大小选择），UI 显示当前任务执行位置。
- 服务端实现要点（吸取 markpad 教训）：全部 async、带取消标志、单任务超时与输入大小上限；高亮结果按 `(path, mtime, size)` 缓存。

### 5.9 搜索与变更监听

**当前文件内搜索（首期必备，决策 Q5）**

- 代码/文本/HTML 源码：基于字节级行索引的分块搜索（虚拟滚动兼容），全部命中标记 + Enter/Shift+Enter 跳转、计数。
- Markdown：渲染视图对渲染后 DOM 文本搜索并滚动到命中；源码视图复用代码搜索。
- PDF：pdfjs findController。

**跨文件搜索（决策 Q6/Q15）**

- 档 2：`POST /api/search` → **ripgrep 子进程**（`--json` 流式输出），支持 pattern/glob/大小写/正则开关，结果流式返回、按文件分组、可取消。
- 纯前端版：内存遍历已打开文件夹（LocalFilesStore/LocalFsStore 已授权范围），仅文本类文件（检测为文本且单文件 <2MB），**上限累计 2000 文件 / 200MB**，超限提示改用服务器模式。
- UI：全局搜索面板（`Ctrl+Shift+F`），结果按文件分组、点击跳转到文件内高亮行。

**变更监听（决策 Q6，直接补项）**

- 档 1/2：notify crate 监听 root，debounce 500ms，经 SSE `/api/events` 推送变更事件；打开的对应 tab 自动重读重渲染（保留滚动位置），设置可切"自动/手动"，手动刷新按钮始终可用。
- 纯前端版：手动刷新；FileSystemObserver 可用时渐进增强为自动。
- SSE 鉴权见 5.10 的 ticket 机制。

### 5.10 后端 API（server/，Rust + axum）

全部只读。**认证（决策 Q4）**：`--token <value|--token-gen>` 启用 Bearer token；`--allow-lan` 未配置 token 时**拒绝启动**；`127.0.0.1` 绑定可免 token。前端首次以 `?token=` 交换（随后从 URL 剥离、存 sessionStorage），后续请求带 `Authorization: Bearer`；SSE/EventSource 无法自定义头，通过 `POST /api/ticket`（Bearer 换 30 秒一次性 ticket）后 `?ticket=` 连接。`/api/health` 免认证（仅版本与能力）。

| 接口 | 说明 |
|---|---|
| `GET /api/health` | `{name, version, capabilities: ["file-server"?, "compute"?]}`（免认证） |
| `GET /api/tree?path=` | 单层目录列表（懒加载；受 `--hidden` 与排除规则约束） |
| `GET /api/file?path=` | 文件流 + Range；响应头带 `X-VV-Type/X-VV-Lang/X-VV-Encoding` 服务端检测结果 |
| `POST /api/detect` | `{name, head_base64}` → 检测结果 |
| `GET /api/events?ticket=` | SSE 变更事件流（debounce 500ms） |
| `POST /api/ticket` | Bearer 换一次性短时 ticket |
| `POST /api/search` | ripgrep 流式搜索（档 2） |
| `POST /api/compute/highlight` | `{path \| text, lang, range?}` → 区间 + capture；结果按 `(path, mtime, size)` 缓存（档 2） |
| `POST /api/compute/markdown` | comrak 渲染（档 2） |
| `GET /api/compute/archive/*` | 服务端解包列表/提取（档 2） |
| `POST /api/compute/inspect` | 二进制结构树（档 2） |

安全：路径 canonicalize + root 前缀校验（防穿越）；symlink resolve 后不得越出 root；默认 bind `127.0.0.1`；无任何写接口；CORS 默认关闭，`--cors-origin` 显式配置。

部署：单二进制 RustEmbed 内嵌前端 dist + grammar/主题资产；`--root` 指定浏览根；`--compute` 开档 2；`--no-assets` 纯 API 模式。

### 5.11 UI 外壳、主题与性能预算（apps/web）

- 布局：左栏文件树（TreeStore）+ 中央标签页查看区 + 右栏 TOC/元数据面板（按格式显隐）；状态栏（编码/语言/大小/行列）。
- **响应式与移动端（决策 Q3c）**：窄屏单视图（查看区全屏）+ 抽屉式文件树/面板；触屏手势：双指缩放图片、滑动切换 tab、视频原生全屏；虚拟滚动适配触控滚动与惯性。
- 顶栏：打开文件/文件夹/URL、连接服务器、暗亮切换（跟随系统可选）。
- **主题三层**：UI 外壳主题 × 文档主题（基于 markpad `styles.css` CSS 变量体系，首期 GitHub Light/Dark + markpad 默认等 3–5 套）× 代码主题（helix 214 主题全量 + 精选置顶，M2 已上线；53 常用捕获子集着色，其余走最长前缀回退）。两个下拉独立选择；markdown 内代码块颜色跟随代码主题，切换零重解析。
- VSCode 主题导入（markpad `themes/vscode.rs` 的 `TEXTMATE_TO_CAPTURE` 映射 + 最长前缀匹配）列为 P2。
- 键盘：j/k 滚动、gg/G、`/` 文件内搜索、`Ctrl+Shift+F` 全局搜索、`Ctrl+P` 快速打开、tab 管理。
- i18n：首期中文（zh-CN），预留 locales 目录。

**性能预算（决策 Q10；M2/M5/M7 实测校准，作为回归门禁）**

| 指标 | 桌面 | 移动（中端手机） |
|---|---|---|
| lite 版首屏可交互 | < 2s | < 4s |
| 切换文件到首帧（本地 ≤10MB） | < 300ms | < 800ms |
| 2MB 代码 tree-sitter 高亮完成（M2 实测 ~1.7-2.4s/MB，阈值已按此校准） | < 5s | < 5s |
| hex 首屏 1MB 解析 | < 200ms | < 500ms |
| `--compute` 5MB 高亮 P95（本地回环） | < 800ms | — |
| 媒体起播（本地 blob / 服务器 Range） | < 1s | < 1.5s |

**状态持久化（决策 Q8b）**：localStorage 存设置（主题/计算策略/编码偏好/排除规则）；IndexedDB 存 FS Access 句柄 + **标签页会话快照**（每 tab 的来源引用、滚动位置、视图模式、主题覆盖）+ 最近打开。移动端 webkitdirectory 会话仅记文件名清单（重开需重选）。标签页内存策略：活动 tab 全量驻留，非活动 tab 超过 6 个或内存压力时挂起 buffer（保留区间缓存与滚动位置）。

**直接补项（决策 Q12）**：统一错误卡片（渲染失败 → 错误详情 + 重试 + 降级路径提示）；代码字体用系统等宽字体栈（不内嵌 web font）；基础 a11y（语义化 HTML、焦点管理、键盘可达）；诊断信息进 console + 全局错误面板（不上报）。

## 6. 数据流

```
来源（File API/FS Access/webkitdirectory/URL/远程服务器）
  → core：source 归一化（TreeStore.read）→ 检测链（扩展名→magic→编码→语言）
  → 派发器选 renderer（未知格式→错误页；签名不符→重定向一次）
  → renderer(buffer, target, type, context)
      ├─ code:    ComputeBackend(highlight) → 区间+capture → 主题映射 → 虚拟滚动渲染
      ├─ markdown: MarkdownBackend → 净化 → 五步管线 → TOC
      ├─ html:    净化 + CSP → sandbox iframe（源码视图走 code）
      ├─ media:   blob/Range URL → ArtPlayer / img
      ├─ archive: 解包 → ArchiveStore → 递归派发
      └─ binary/pdf/doc: 各自懒加载引擎
  → RenderedInstance（zoom/search/print 能力声明）→ 工具栏/右栏面板
  （档 1/2）SSE 变更事件 → 打开 tab 自动刷新
```

## 7. 测试策略

- **core**：vitest 单测——检测链（扩展名 × magic 纠偏 × 编码矩阵）、注册表冲突、TreeStore 三实现（内存/临时目录桩）、跨文件搜索上限。
- **highlight**：固定样例的区间快照测试；`; inherits:` 展开单测（重点 ecma/_typescript/_jsx 链）；injection 二级高亮测试（html 内 js/css、markdown 围栏）；ABI 失败降级测试；伪语言映射测试。
- **搜索**：文件内分块搜索（大文件、命中跳转）；ripgrep 集成（流式、取消、二进制跳过）。
- **grammar-builder**：增量构建幂等性；失败清单门禁；`nm` 符号校验。
- **server**：cargo test——路径穿越（`../`、编码变体、symlink）、Range 语义、检测结果、能力开关、token/ticket 鉴权、SSE debounce、并发高亮缓存。
- **E2E**：Playwright 冒烟跑 `samples/` 全格式矩阵（打开 → 断言渲染特征 → 主题切换 → 搜索 → 刷新后会话恢复）；移动视口（375px/触屏 UA）专项。
- **性能基线**：5.11 预算表在样例上实测校准（M2/M5/M7）。

## 8. 分期计划

| 里程碑 | 内容 | 验收 |
|---|---|---|
| M1 骨架 | monorepo 脚手架；core 检测派发；前端外壳（三来源、TreeStore、FS Access + webkitdirectory 双通道）；code(hljs 先行)/图片/音视频（原生）；CSS 变量主题框架；**响应式布局与移动端基础**；会话持久化 schema（IndexedDB） | 拖拽/选择打开文件夹可浏览 hljs 高亮代码与图片；桌面刷新后会话恢复 |
| M2 高亮（已完成） | grammar-builder 管线（预编译 36 + self-build 路径）；highlight 包（Worker/继承展开/injection/主题）；虚拟滚动与降级链（阈值 2MB 实测校准）；languages.json 检测；内容哈希资产清单；**文件内搜索顺延 M3** | 36 语言 wasm（22 查询可用）+ hljs 全量兜底；主题切换零重解析；引擎指示器（已上线） |
| M3 文档 | markdown-it + markpad 管线移植；TOC；front matter；HTML 沙箱；**markdown 渲染视图搜索** | samples 全部 md/html 渲染通过；净化测试全绿 |
| M4 二进制与媒体 | PDF（含搜索）；hex/结构树；压缩包（含包内递归预览）；Office；**ArtPlayer 集成**与流媒体 loader | 全格式 E2E 矩阵通过；移动端媒体起播达标 |
| M5 后端档 1 | axum health/tree/file+detect/Range；**token/ticket 鉴权**；**SSE watch 与自动刷新**；目录树接 TreeStore；路径安全；单二进制打包 | 静态托管前端连后端浏览服务器目录；文件变更自动刷新 |
| M6 后端档 2 + 搜索 | ComputeBackend 路由与偏好；服务端高亮（静态 grammar + injection）；comrak；服务端解包/结构解析；**ripgrep 跨文件搜索**；**纯前端内存 grep** | 大文件高亮走后端；`Ctrl+Shift+F` 全局搜索两端可用 |
| M7 打磨 | **PWA service worker**（应用壳 + 资产预缓存）；大文件调参；编码矩阵；**hljs 主题近似映射器**；E2E 全绿（含移动视口）；文档与部署说明 | 全部验收标准与性能预算达成 |

## 9. 风险与对策

| 风险 | 对策 |
|---|---|
| 全量 grammar 构建成功率；个别语法 ABI 超出 web-tree-sitter 兼容窗（13–15） | 增量构建 + 失败清单门禁；超窗语法换上游 release rev 重生成并记录；hljs 兜底保证可用；runtime 升级做全量回归 |
| wasm 资产体积（实测 49.4MB 预编译子集） | 按语言按需 fetch + 内容哈希永久缓存（PWA）；lite 精简集；后端版资产可选内嵌 |
| 查询兼容（inherits 展开、helix 扩展 predicate） | 搬 markpad 已验证的查询集与合并算法；专项单测 |
| injection 递归解析的性能与环 | 深度限 3；子解析独立取消；按需懒加载子 grammar |
| 双高亮路线（wasm/原生）结果不一致 | 同一份 queries + 同一 capture 中间表示；快照测试双跑比对 |
| Office/压缩包 wasm 体积 | 全部懒加载；档 2 服务端解包 |
| 双 markdown 引擎行为漂移 | 首期单引擎；comrak 为档 2 可选项且管线入口与引擎解耦 |
| 静默降级不可见（markpad CI 0 语法事故） | 失败清单门禁 + health 暴露高亮能力计数 + UI 显示当前高亮引擎 |
| 移动端内存压力（大目录枚举、多 tab、大文件） | File 对象惰性读取；tab 挂起策略；grep/跨文件搜索设上限；预算表含移动档 |
| iOS/Android 旧版无 webkitdirectory | 能力检测 + 明确提示（升级或服务器模式）；服务器模式是完整能力的兜底路径 |

## 10. 开源合规与分发（决策 Q7/Q13）

- **项目协议：Apache-2.0**（含专利授权与 NOTICE 机制），配 `THIRD_PARTY_NOTICES.md`：helix MPL-2.0 文件清单与出处（queries/themes/languages.toml 派生文件保留 MPL 声明）、markpad BSD-3、file-viewer Apache-2.0 借鉴范围、ArtPlayer/hls.js/mpegts.js/highlight.js/markdown-it 等运行时依赖的 license 清单（构建期从 node_modules/Cargo.lock 生成）。
- **分发**：GitHub Releases（后端单二进制 + 前端 dist zip + 全量 grammar 资产包）；GitHub Pages 部署 lite 演示版；纯前端版支持自定义资产 URL（自托管全量资产）。npm 前端包（嵌入用）等 core 稳定后评估。
- CI：GitHub Actions——lint/test/E2E/grammar 增量构建门禁/release 自动化。

## 11. License 合规明细

| 资产/依赖 | License | 合规动作 |
|---|---|---|
| helix queries/themes/languages.toml 派生 | MPL-2.0 | 文件头保留声明 + 标注修改；NOTICES 列清单 |
| markpad 移植代码 | BSD-3（自有） | 保留声明 |
| file-viewer 借鉴/移植 | Apache-2.0 | 保留 NOTICE 与出处标注 |
| ArtPlayer | MIT | bundle 时保留 license |
| hls.js / mpegts.js / highlight.js / markdown-it / pdfjs-dist / jszip / libarchive.js 等 | Apache-2.0/MIT/BSD 系 | 构建期生成第三方清单 |
| OpenList | AGPL-3.0 | **零代码引入**，仅设计参考 |
