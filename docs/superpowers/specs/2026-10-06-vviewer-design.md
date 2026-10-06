# vviewer 设计文档：网页版只读文件查看器

日期：2026-10-06
状态：待评审

## 1. 背景与目标

vviewer 是一个**网页版只读文件查看器**，支持代码、Markdown、HTML、图片、音视频、PDF、压缩包、Office 文档与二进制（hex/结构）的浏览，不做任何编辑功能。

首期交付两个版本：

1. **纯前端版**：部署到任意静态托管站点。通过拖拽/对话框打开本地**文件或文件夹**，全部解析渲染在浏览器内完成。
2. **带后端版**：Rust + axum 单二进制，两个递进档位：
   - **档 1 文件服务**：浏览与打开服务器本地文件（目录树 + 文件流），渲染仍在前端。
   - **档 2 计算卸载**：把高亮、Markdown 渲染、压缩包解包、格式检测、二进制结构解析等重任务放到后端执行，避免浏览器过大的性能消耗。

### 成功标准

- 纯前端版可静态托管后离线使用本地文件夹浏览全部支持格式。
- 带后端版档 1 可浏览服务器目录树并流畅查看大文件（Range 流式）。
- 档 2 下浏览器不做 wasm 重解析（可选服务端 tree-sitter 全量高亮）。
- 代码高亮覆盖 helix 语言清单全量（目标 264+，编译失败者清单化并 hljs 兜底）。
- Markdown 与代码高亮均支持多主题切换。

### 明确不做（YAGNI）

- 不做任何编辑能力；不做服务端媒体转码（浏览器解码优先）；不做弹幕、网盘对接（DPlayer 只取播放器本体）；首期不做登录/多用户/权限（后端默认 bind 127.0.0.1）；Kroki 等远程图表服务默认关闭；不做 LSP/语义诊断。

## 2. 参考项目与复用策略

| 项目 | 定位 | 复用内容 | License 约束 |
|---|---|---|---|
| helix-editor/helix | 终端编辑器 | `languages.toml`（语言检测规则 + grammar 清单）、`runtime/queries/`（highlights/injections）、`runtime/themes/`（220 主题）、shebang 检测正则、主题最长前缀回退逻辑 | MPL-2.0，保留来源声明 |
| markpad-aio/Markpad | Tauri 桌面 Markdown 应用 | 前端五步渲染管线（sanitize→highlight→diagrams→katex→copy/lightbox）、`queries/`（286 目录已含继承父目录，vendored）、languages.toml + grammar_info.json（验证过的 264 语法清单与 subpath 表）、tree-sitter build.rs 骨架、comrak 渲染（档 2）、styles.css 主题体系、VSCode 主题导入映射 | 项目自有（BSD-3），可直接复用 |
| flyfish-dev/file-viewer | 纯前端查看器组件库 | core 架构骨架（注册表/派发器/签名重定向/预检/编码检测）、`renderer-text`（大文本虚拟滚动、HTML 沙箱双层防御）、`renderer-binary`（hex/结构树）、format-catalog 数据驱动注册模式 | Apache-2.0 |
| DIYgod/DPlayer | HTML5 播放器 | 集成为视频/音频播放 UI（含 hls.js 等按需 loader） | MIT |
| maple3142/GDIndex | 网盘索引前端 | 参考：文件列表 + 流式媒体播放交互 | MIT |
| OpenListTeam/OpenList | 网关文件列表 | **仅参考设计**：按扩展名路由预览器、Range 流播放交互 | AGPL-3.0，禁止引入代码 |

### tree-sitter 避坑结论（来自 markpad 实证）

markpad 已以 helix `languages.toml`（git+rev+subpath）为唯一清单源验证了 264 个语法静态编译，其经验直接吸收：

**采纳的做法**

1. 单一事实来源：grammar 清单用 `languages.toml`（含 git+rev+subpath），wasm 与 Rust 原生两条路线都由它生成。
2. 查询集 vendored 入库：直接搬 markpad `src-tauri/queries/`（286 目录，已包含 `ecma`、`_typescript`、`_jsx` 等继承父目录）；`; inherits:` 运行时递归合并（父查询在前），算法移植 markpad `highlight/mod.rs:134-219`。
3. 原生侧 build.rs 骨架照抄：cc 编译 + **强制 `-std=gnu11`（C）/`-std=gnu++17`（C++）**（gcc16 C23 下 glibc `bsearch` 宏化与 perl 语法冲突、mingw libstdc++ 缺 move 符号）、C++ scanner（astro/cmake/haskell-persistent/lean/org/ruby/vue/yaml 等 8 个）外部 g++ 编译后 `ar rs` 合并进主 `.a` 并加 `-fPIC`、导出符号名 override 表（如 sshclientconfig → `tree_sitter_ssh_client_config`）、代码生成 FFI 分发表。
4. config **懒加载 + 缓存**（markpad 曾因启动预建 264 个 config 卡死而返工）。
5. hljs 兜底以"高亮调用返回 Err"为信号，前端**不做语言名单预检**（markpad 曾因别名不一致删除预检）。
6. CI 必须强制下载/校验 grammar（markpad CI 缺此步骤，发布包静默退化为 0 语法）。
7. subpath 多语法仓库（typescript/tsx、markdown/markdown_inline、ocaml/interface）以 **parser.c 实际存在为判据**生成构建清单，不信脚本输出（markpad 因此丢了 14 个语法）。
8. fence 语言别名表 + 伪语言映射（math→latex、vegalite→json、bpmn→xml、graphviz→dot）。

**markpad 未解决、vviewer 必须做对的**

1. **injection 二级高亮**：markpad 的 injection 回调是 `|_| None`，html 内嵌 js/css 无二级着色。vviewer 前后端两条高亮路线都必须实现 injection callback（按 `@injection.language` / `#set! injection.language` / shebang 解析语言名，递归调用对应 grammar）。
2. **超时/取消/大小上限**：解析放 Worker（前端）/ async 任务（后端），大文件按阈值降级，绝不阻塞主线程（markpad 同步 Tauri 命令冻结全部窗口）。
3. ABI 兼容回归：tree-sitter runtime 升级时对全量 grammar 做一次性构建回归（不是 `>200 就过` 的粗筛）。
4. 补齐 markpad 放弃的 14 个语法（markdown、markdown_inline、ocaml、ocaml-interface、php-only、prolog、v、vue、wast、wat、fortran、glimmer×3）——subpath 问题已定位，非根本障碍；vue/glimmer 符号冲突单独排查。
5. 别名表剔除死条目（markpad `registry.rs` 存在指向未编译语言的死别名）。

## 3. 总体形态

**一个前端，四种文件来源，后端两档能力。**

```
                     ┌─ 纯前端版（静态托管）：
                     │   来源 = 本地文件 / 本地文件夹 / URL；计算全在浏览器
同一个 SvelteKit 前端 ─┤
                     └─ 带后端版（axum 单二进制）：
                         档 1 文件服务：来源 += 服务器目录（/api/tree、/api/file）
                         档 2 计算卸载：高亮/markdown/解包/检测/结构解析可选在后端跑
```

- 前端运行时探测 `GET /api/health` 获取能力集（`file-server` / `compute`），UI 与任务路由按能力启用；探测不到即纯前端形态。
- 后端可关档：`vviewer serve --root DIR [--compute] [--no-assets]`；`--no-assets` 纯 API 模式供纯前端版跨域连接（CORS 显式配置）。
- 纯前端版亦可作为"瘦客户端"直连任意 vviewer 后端。

**决策记录**：否决了"两个独立 app"与"构建期切换两种产物"方案（维护成本/部署矩阵翻倍），采用单前端双形态。

## 4. 仓库布局（pnpm monorepo + Cargo workspace）

```
vviewer/
├── apps/web/                # SvelteKit 5 + Svelte 5 前端（唯一前端，双形态）
├── server/                  # Rust workspace：axum 后端（档 1 + 档 2）
├── packages/
│   ├── core/                # 框架无关：source 归一化、格式检测链、注册表、派发器、
│   │                        #   TreeStore 抽象、ComputeBackend 抽象与路由
│   ├── highlight/           # 高亮运行时：tree-sitter wasm（Worker）、查询继承展开、
│   │                        #   injection 递归、主题映射、hljs 兜底
│   ├── render-text/         # code / markdown / html 渲染器
│   ├── render-media/        # image / video(DPlayer) / audio
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
2. **magic 预检**：ZIP/OLE 签名识别 + OOXML/ODF 部件校验；签名与扩展名不符时抛 `RedirectError(actualRendererId)` 二次派发（解决"后缀骗人"，只重定向一次）。
3. **编码检测**：BOM → UTF-8 字节校验 → GB18030 兜底（对齐 file-viewer `textEncoding.ts`）。
4. **代码语言检测**：接入生成的 `languages.json`（来源 helix `languages.toml` 的 file-types/glob/shebang），shebang 正则 `^#!\s*(?:\S*[/\\](?:env\s+(?:-\S+\s+)*)?)?([^\s.\d]+)` 与 helix `Loader` 行为一致。
5. 服务端检测（档 1 起可用）通过 `/api/file` 响应头 `X-VV-Type/X-VV-Lang` 下发，前端信任但不盲从（本地来源走本地链）。

渲染器统一接口：`(buffer, target, type, context) → Promise<RenderedInstance>`；`RenderedInstance` 可声明 `zoom/search/print/exportHtml` 能力，由 core 统一提供工具栏动作。重依赖一律动态 `import()` 懒加载。

### 5.2 代码高亮（packages/highlight + tools/grammar-builder + server 档 2）

**三条路线共享同一份资产**（helix/markpad 的 queries 与主题）与同一个**中间表示**：高亮区间数组 `[{start, end, capture}]`。

| 路线 | 引擎 | 覆盖 | 使用场景 |
|---|---|---|---|
| 前端 wasm | web-tree-sitter（grammar 按需 fetch `/grammars/{lang}.wasm`） | 清单 286（helix 上游），目标编译 ≥264（markpad 已验证数）+ 补齐 markpad 丢弃的 14 个 | 纯前端版默认 |
| 前端 hljs | highlight.js 11 | 190+ 语言 | wasm 失败/无查询/超阈值的兜底 |
| 服务端原生 | tree-sitter 0.25 + tree-sitter-highlight + 静态链接全部 grammar（markpad build.rs 骨架） | 同一清单 286 | 档 2 高亮卸载 |

**构建期（tools/grammar-builder）**

- 输入：`languages.toml`（git+rev+subpath）+ subpath 表；以下载后 `parser.c` 实际存在为判据生成构建清单（教训：markpad 丢了 14 个）。
- C 标准固定 `-std=gnu11`；C++ scanner `-std=gnu++17 -fPIC`（wasm 侧对应 clang `-std` 固定）；C++ scanner 单独编译合并；符号名 override 表；生成期用 `nm` 校验实际导出符号。
- wasm 产物 + 元数据清单（语言名、别名、ABI 版本、查询文件 sha）入静态资产目录；构建失败进失败清单（CI 门禁：失败数只许减少）；产物可增量构建。
- 体积预估 60–120MB（gzip 后），按语言按需 fetch；另出 `lite` 精简集（top 30 语言）供受限托管。

**运行期（前端）**

- Worker 内 parser 池，wasm 模块按语言缓存；主线程只收区间数组渲染 span；支持取消（切换文件即取消）。
- 查询加载：vendored `queries/`（搬 markpad 286 目录）+ `; inherits:` 递归展开（父在前）。
- **injection 二级高亮**：解析 `@injection.language` capture 与 `#set! injection.language` 属性，递归派发对应 grammar（html 内 js/css、markdown 围栏代码块）；helix 扩展 predicate（`injection.include-unnamed-children`、`@injection.shebang`）做 shim；递归深度限 3。
- 主题：构建期把 helix 220 个主题 TOML 转 JSON；运行时"最长前缀回退"解析 capture → CSS 变量（`--ts-*`，与 markpad `CAPTURE_TO_CSS` 类名体系一致）；**主题切换零重解析**（区间+capture 已缓存，换 CSS 变量即可）。

**服务端高亮（档 2）**

- `POST /api/compute/highlight`：输入 `path`（引用服务器文件）或文本；服务端解析全文件并按 `(path, mtime, size)` 缓存区间，前端按可视范围请求区间切片；树/大文件不受浏览器内存限制。
- 协议输出与前端 wasm 路线完全相同的区间+capture 结构，前端渲染层无感知。

**降级链（阈值实测后调整；渲染始终虚拟滚动）**

| 文件大小 | 策略 |
|---|---|
| ≤ 5MB | tree-sitter（wasm 或服务端）全量高亮，Worker 解析 |
| 5MB–20MB | 服务端高亮（若可用），否则 hljs 按可视窗口分块 |
| > 20MB | 纯文本虚拟滚动 + 提示 |

**渲染**：虚拟滚动采用 file-viewer `largeText.ts` 思路（字节级行索引 + 每 256 行 checkpoint + 分块搜索）。

### 5.3 Markdown（packages/render-text）

- 首期单引擎：markdown-it（GFM 插件组：table/strikethrough/tasklist/footnote）→ HTML。
- 后处理管线移植 markpad 五步：**DOMPurify 净化 → 高亮（接 5.2，围栏代码块走 injection 递归）→ 图表 → KaTeX → copyCode/lightbox**；另移植 callouts（`[!note]` 12 种图标）、视频/音频链接增强、YAML front matter、TOC 组件（从预览 DOM headings 构建 + 滚动跟随）。
- 图表：mermaid 必做；graphviz/vega/nomnoml 等懒加载；Kroki 远程默认关闭。
- 档 2 可选 comrak 引擎（移植 markpad `markdown.rs`：数学掩码、GFM 全扩展、sourcepos），管线入口与引擎解耦（引擎只产 HTML，管线对引擎无感知）。
- Obsidian wikilink 首期不做。

### 5.4 HTML（packages/render-text）

双层防御照搬 file-viewer：DOMPurify `WHOLE_DOCUMENT` + 属性白名单二次清洗（去 `on*`、外链 src 仅留 data:）→ 注入严格 CSP meta → opaque-origin sandbox iframe（禁 script/form）。提供"源码 / 渲染"双视图切换（源码视图走 5.2 代码高亮）。

### 5.5 图片与媒体（packages/render-media）

**原则：浏览器自己解码优先，转码库仅兜底。**

- 图片：原生 `<img>`/createImageBitmap（EXIF 方向 `imageOrientation: 'from-image'`）；jpg/png/gif/webp/avif/bmp/ico/svg；SVG 经消毒（禁外部资源）后 blob 渲染；缩放/旋转/平移；HEIC/TIFF 检测到浏览器不支持时提示并按需加载 heic2any/utif 兜底。
- 视频：**集成 DPlayer**（MIT）；容器/编码浏览器支持即直接播（mp4/webm 等）；`.m3u8` 按需加载 hls.js、`.flv/.ts` 按需加载 mpegts.js；后端版直接消费 `/api/file` 的 Range 流，本地文件用 blob URL。
- 音频：原生 `<audio>` 控件（mp3/wav/ogg/flac/m4a），倍速/进度用浏览器原生能力；播放列表、列表连播列为 P2。
- 交互参考 GDIndex/OpenList：文件列表点击即播、键盘操作、列表/网格视图；不做弹幕、网盘协议对接。

### 5.6 PDF / hex / 压缩包 / Office

- **PDF**：pdfjs-dist（Worker），文本选择与搜索。
- **hex/结构**：零依赖自研（参考 file-viewer `renderer-binary`）：magic 识别（PNG/ELF/PE/Mach-O…）+ hex dump + 结构树，Worker 化，时间/深度预算；默认只取前 1MB，档 1/2 走 Range/服务端解析按需分页。
- **压缩包**：jszip（zip）+ libarchive.js（tar/7z/rar），本地解包；包内条目树接入 TreeStore（ArchiveStore），**点击包内文件复用整个查看器递归预览**（深度限 3）。档 2 可切换服务端解包（zip/tar/7z crate）。
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
| LocalFsStore | File System Access API（`showDirectoryPicker`） | Chromium；句柄存 IndexedDB，刷新后恢复；`<input webkitdirectory>` 降级（一次性读入，大目录提示） |
| RemoteStore | `/api/tree` + `/api/file` | 懒加载 + Range |
| ArchiveStore | 压缩包内存解包 | 嵌套在任意 Store 的文件之上 |
| SingleFileStore | 本地单文件 / URL | 拖拽、对话框、粘贴 URL；直连第三方 URL 受 CORS 限制（无法访问时提示失败原因） |

左栏文件树组件只有一份实现，消费 TreeStore 抽象。

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

### 5.9 后端 API（server/，Rust + axum）

全部只读：

| 接口 | 说明 |
|---|---|
| `GET /api/health` | `{name, version, capabilities: ["file-server"?, "compute"?]}` |
| `GET /api/tree?path=` | 单层目录列表（懒加载） |
| `GET /api/file?path=` | 文件流 + Range；响应头带 `X-VV-Type/X-VV-Lang/X-VV-Encoding` 服务端检测结果 |
| `POST /api/detect` | `{name, head_base64}` → 检测结果 |
| `POST /api/compute/highlight` | `{path \| text, lang, range?}` → 区间 + capture；`range` 按可视范围切片取缓存区间；结果按 `(path, mtime, size)` 缓存 |
| `POST /api/compute/markdown` | comrak 渲染 |
| `GET /api/compute/archive/*` | 服务端解包列表/提取 |
| `POST /api/compute/inspect` | 二进制结构树 |

安全：路径 canonicalize + root 前缀校验（防穿越）；symlink resolve 后不得越出 root；默认 bind `127.0.0.1`，`--allow-lan` 显式开启；无任何写接口；CORS 默认关闭，`--cors-origin` 显式配置。

部署：单二进制 RustEmbed 内嵌前端 dist + grammar/主题资产；`--root` 指定浏览根；`--compute` 开档 2；`--no-assets` 纯 API 模式。

### 5.10 UI 外壳与主题系统（apps/web）

- 布局：左栏文件树（TreeStore）+ 中央标签页查看区 + 右栏 TOC/元数据面板（按格式显隐）；状态栏（编码/语言/大小/行列）。
- 顶栏：打开文件/文件夹/URL、连接服务器、暗亮切换（跟随系统可选）。
- **主题系统三层**：UI 外壳主题 × 文档主题（Markdown 排版风格，基于 markpad `styles.css` 的 CSS 变量体系，首期 GitHub Light/Dark + markpad 默认等 3–5 套）× 代码主题（helix 220 主题全量 + 精选置顶）。两个下拉独立选择；markdown 内代码块颜色跟随代码主题（得益于区间+capture 中间表示，切换零重解析）。
- VSCode 主题导入（markpad `themes/vscode.rs` 的 `TEXTMATE_TO_CAPTURE` 映射 + 最长前缀匹配）列为 P2。
- 键盘：j/k 滚动、gg/G、`/` 搜索、`Ctrl+P` 快速打开（文件夹模式）、tab 管理（参考 markpad viewerKeymap）。
- i18n：首期中文（zh-CN），预留 locales 目录。

## 6. 数据流

```
来源（File API/FS Access/URL/远程服务器）
  → core：source 归一化（TreeStore.read）→ 检测链（扩展名→magic→编码→语言）
  → 派发器选 renderer（未知格式→错误页；签名不符→重定向一次）
  → renderer(buffer, target, type, context)
      ├─ code:    ComputeBackend(highlight) → 区间+capture → 主题映射 → 虚拟滚动渲染
      ├─ markdown: MarkdownBackend → 净化 → 五步管线 → TOC
      ├─ html:    净化 + CSP → sandbox iframe（源码视图走 code）
      ├─ media:   blob/Range URL → DPlayer / img
      ├─ archive: 解包 → ArchiveStore → 递归派发
      └─ binary/pdf/doc: 各自懒加载引擎
  → RenderedInstance（zoom/search/print 能力声明）→ 工具栏/右栏面板
```

## 7. 测试策略

- **core**：vitest 单测——检测链（扩展名 × magic 纠偏 × 编码矩阵）、注册表冲突、TreeStore 三实现（用内存/临时目录桩）。
- **highlight**：固定样例的区间快照测试；`; inherits:` 展开单测（重点 ecma/_typescript/_jsx 链）；injection 二级高亮测试（html 内 js/css、markdown 围栏）；ABI 失败降级测试；伪语言映射测试。
- **grammar-builder**：增量构建幂等性；失败清单门禁；`nm` 符号校验。
- **server**：cargo test——路径穿越（`../`、编码变体、symlink）、Range 语义、检测结果、能力开关、并发高亮缓存。
- **E2E**：Playwright 冒烟跑 `samples/` 全格式矩阵（打开 → 断言渲染特征 → 主题切换）。
- **性能基线**：5MB/20MB 阈值实测校准降级链。

## 8. 分期计划

| 里程碑 | 内容 | 验收 |
|---|---|---|
| M1 骨架 | monorepo 脚手架；core 检测派发；前端外壳（三来源、TreeStore、FS Access API）；code(hljs 先行)/图片/音视频（原生）；CSS 变量主题框架 | 拖拽打开文件夹可浏览 hljs 高亮代码与图片 |
| M2 高亮 | grammar-builder 全量管线；highlight 包（Worker/继承展开/injection/主题）；虚拟滚动与降级链；languages.json 检测 | 264+ 语言 tree-sitter 高亮，主题切换零重解析 |
| M3 文档 | markdown-it + markpad 管线移植；TOC；front matter；HTML 沙箱 | samples 全部 md/html 渲染通过，净化测试全绿 |
| M4 二进制与媒体 | PDF；hex/结构树；压缩包（含包内递归预览）；Office；DPlayer 集成与流媒体 loader | 全格式 E2E 矩阵通过 |
| M5 后端档 1 | axum health/tree/file+detect/Range；目录树接 TreeStore；路径安全；单二进制打包 | 静态托管前端连后端浏览服务器目录 |
| M6 后端档 2 | ComputeBackend 路由与偏好；服务端高亮（静态 grammar + injection）；comrak；服务端解包/结构解析 | 大文件高亮走后端，浏览器零 wasm 解析 |
| M7 打磨 | 大文件调参；编码矩阵；E2E 全绿；文档与部署说明 | 全部验收标准达成 |

## 9. 风险与对策

| 风险 | 对策 |
|---|---|
| 300+ 条 grammar 构建成功率与 ABI 匹配（清单 286；helix pin 的 rev 可能超出 web runtime ABI 范围） | 增量构建 + 失败清单门禁；ABI 超限语法换用上游 release rev 重试；hljs 兜底保证可用；runtime 升级做全量回归 |
| wasm 资产体积（60–120MB） | 按语言按需 fetch；lite 精简集；后端版资产可选内嵌 |
| 查询兼容（inherits 展开、helix 扩展 predicate） | 搬 markpad 已验证的查询集与合并算法；专项单测 |
| injection 递归解析的性能与环 | 深度限 3；子解析独立取消；按需懒加载子 grammar |
| 双高亮路线（wasm/原生）结果不一致 | 同一份 queries + 同一 capture 中间表示；快照测试双跑比对 |
| Office/压缩包 wasm 体积 | 全部懒加载；档 2 服务端解包 |
| 双 markdown 引擎行为漂移 | 首期单引擎；comrak 为档 2 可选项且管线入口与引擎解耦 |
| 静默降级不可见（markpad CI 0 语法事故） | 失败清单门禁 + health 暴露高亮能力计数 + UI 显示当前高亮引擎 |

## 10. License 合规

- helix 资产（languages.toml、queries、themes）：MPL-2.0，在 `tools/helix-assets/` 与 `packages/highlight/queries/` 保留来源与 license 声明。
- markpad：项目自有（BSD-3），可自由复用。
- file-viewer：Apache-2.0，保留 NOTICE。
- DPlayer：MIT，可直接集成。
- GDIndex：MIT，仅参考交互。
- OpenList：AGPL-3.0，**仅参考设计，禁止引入任何代码**。
