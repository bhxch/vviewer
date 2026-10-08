# Spec 偏差记档（final review A6）

对照 spec（`docs/superpowers/specs/2026-10-06-vviewer-design.md`）逐条记录实现偏差：偏差内容、
理由、回补条件。此处只收"与 spec 文本不一致但经过裁决"的项；纯实现细节不记。

## 1. HTML 沙箱用 `allow-same-origin` 而非 opaque origin

- **偏差**：spec 要求不可信 HTML 以 opaque origin 沙箱呈现；实现为
  `sandbox="allow-same-origin"`（无 `allow-scripts`）（`packages/render-text/src/html.ts:128-130`）。
- **理由**：脚本面由 sandbox 封死（不给 `allow-scripts`，文档内脚本一律不执行），与
  opaque origin 在脚本执行维度安全等价；`allow-same-origin` 使父页面可读
  `contentDocument`，支撑 E2E 对沙箱内容的可观测断言（opaque origin 下跨文档访问恒为空，
  只能靠截图）。
- **回补条件**：一旦引入"允许文档内脚本"的需求（沙箱策略放宽），必须切回 opaque origin，
  改用 postMessage 桥通信，并重做 E2E 探针（届时 allow-same-origin 不再安全）。

## 2. `?token=` URL 引导交换未实现

- **偏差**：spec 5.13"前端首次以 `?token=` 交换（随后从 URL 剥离、存 sessionStorage）"；
  实现为连接表单手动粘贴 token（`apps/web/src/lib/TopBar.svelte` → `connectServer`），
  会话内凭据存 sessionStorage（`openFlow.svelte.ts` LastServer），重连需手动。
- **理由**：URL 引导涉及地址栏泄漏面（历史记录/Referer/剪贴板分享）与深链生命周期管理；
  手动粘贴已覆盖核心鉴权路径（Bearer + `/api/ticket` 预检 + SSE `?ticket=` 均已实现），
  M7 以最小可用形态交付。
- **回补条件**：需要"带 token 的分享链接直达受保护服务器"或部署引导向导时实现
  （读 `?token=` → 连接交换 → `history.replaceState` 剥离参数 → 存 sessionStorage）。

## 3. `X-VV-Type` 响应头未实现

- **偏差**：spec 5.6/5.10 列明 `/api/file` 响应头带 `X-VV-Type/X-VV-Lang/X-VV-Encoding`；
  服务端只下发 `X-VV-Lang` 与 `X-VV-Encoding`（`server/src/routes/file.rs:19-20`）。
- **理由**：类型判定的权威通道已由 `Content-Type`（扩展名 → MIME）覆盖，前端 registry
  选路走扩展名 + Content-Type；`X-VV-Type` 是冗余重复通道，少一个头少一份漂移面。
- **回补条件**：出现 MIME 无法区分、需要服务端权威类型语义的场景（无扩展名文件、
  自定义文件处理器）时补齐，前端 `getRemoteMeta` 增加对应字段。

## 4. 移动端双指捏合缩放未实现

- **偏差**：spec 移动端要求图片查看器支持双指捏合缩放；实现只有滚轮缩放 + 双击复位，
  代码内注释"双指捏合缩放留待 M7 触屏专项"（`packages/render-media/src/image.ts:43`）。
- **理由**：捏合需要 pointer 事件状态机（双指距离跟踪、多点捕获）且要处理与页面滚动、
  浏览器原生手势的冲突（touch-action 策略）；触屏专项成本高，移动端冒烟 E2E 已覆盖
  布局与抽屉导航。
- **回补条件**：M7 触屏专项（pointermove 双指跟踪 + `touch-action: none` 收敛）落地时。
- **核实（终审批次 C，2026-10-06）**：后置裁决维持——`image.ts` 的专项注释仍在原位，
  捏合未实现，与 A6 记录一致，无漂移。

## 5. 服务端高亮无 injection

- **偏差**：spec 的 tree-sitter 高亮语义含 injection；服务端 v1 只加载 `highlights.scm`，
  injections/locals 查询传空串、injection_callback 恒 None（M6 计划级裁决，
  `server/src/compute/queries.rs:8-9`、`server/src/compute/highlight.rs:3`）。
- **理由**：injection 使服务端查询装载复杂度与内存翻倍，而前端本地 worker 已具备完整
  injection 能力；配套前端对策已落地——`INJECTION_LANGS`（`packages/core/src/compute/router.ts`）
  在 auto 策略下把 6 种带 injection 的语言留在本地，显式 remote 的丢注入由用户选择自担。
- **回补条件**：服务端装载 injections.scm 并在响应中标注 injection 覆盖范围后，前端按
  语言从 `INJECTION_LANGS` 撤出。

## 6. comrak 数学扩展/数学掩码不做

- **偏差**：spec 的 markdown 管线提到数学公式处理；服务端 comrak 明确不启用
  `math_dollars`/`math_code`、无数学掩码（`server/src/compute/markdown.rs:3-4`）。
- **理由**：本地 markdown 引擎已有 KaTeX 全链路（M3）；服务端启用数学需要 KaTeX 服务端
  输出或"掩码保护美元段不被 comrak 误解析"的预处理，两者都与"服务端只做语法高亮、
  结构化输出"的 M6 边界冲突。
- **回补条件**：远程 markdown 与本地渲染在数学内容上出现实际不一致反馈时，评估掩码
  预处理（保持输出仍走前端净化管线）。

## 7. 服务端解包移 P2

- **偏差**：spec 计算后端含 ArchiveBackend（服务端解包）；实现裁剪为仅 Highlight /
  Markdown / Search 三类（`packages/core/src/compute/types.ts:8-10` 类型注释占位）。
- **理由**：本地 JSZip/libarchive.js 已覆盖 zip/tar/7z/rar 等格式（M4）；服务端解包需要
  先设计服务端文件系统安全边界（路径逃逸、软链、解压炸弹限额），P2 再做不阻塞主线。
- **回补条件**：P2 启动条件——出现前端无法承载 wasm 解压的弱设备，或超大压缩包
  （本地解压内存峰值不可接受）的真实场景。

## 8. RustEmbed 不内嵌前端产物

- **偏差**：spec 发布物形态未锁定单文件；实现明确不做 rust-embed/include_dir 内嵌，
  `--web-dist` 保持唯一前端挂载通道（ADR 见 `docs/deploy.md`"不做 RustEmbed 内嵌前端
  产物"节）。
- **理由**：ADR 三条——`--web-dist` 已满足"二进制 + 静态目录"分发语义；内嵌引入
  `pnpm build → cargo build` 的构建顺序硬耦合；grammar/libarchive wasm 等运行时资产本就
  无法全量内嵌，收益面窄。
- **回补条件**：出现明确的单文件分发需求（如单文件 Demo 发布）时，评估 include_dir 仅
  内嵌 index.html 占位页的折中方案（ADR 已预记）。

## 9. 搜索列号（col）口径统一为 UTF-16 码元

- **性质**：spec 未定义 col 口径——此条是实现约定记录（终审批次 C 补记），非与 spec
  文本的偏差。
- **裁决与完成情况**：M6 起本地 grep 与服务端 rg 的 col 口径漂移（标量 vs 字节）被
  终审挂账"行定位（P2）前统一"；批次 B（`3b02a3a`）完成统一——服务端在 `match_frame`
  把 rg 的字节偏移换算为 UTF-16 码元计数（`prefix.encode_utf16().count() + 1`，
  `server/src/routes/search.rs`），与 JS 侧 `String` 索引天然一致，增补平面字符
  （emoji）有区分性用例锁定。
- **回补条件**：引入真实行内列定位 UI（P2 行号定位）时若需改用字形簇（grapheme）
  口径，两端同步换算并更新本条。

## 10. grammar wasm 从"入库资产"改为"构建期生成"

- **偏差**：M2 裁定 `apps/web/static/grammars/*.wasm` 入库保证纯前端开箱可用（spec L153-154
  的 lite 集入库口径）；实现改为产物一律不入库（`.gitignore`），由 `pnpm gen:grammars`
  与 CI composite action 构建期生成，release web 包继续内置 lite 集、全量集随
  `grammar-wasm.tar.zst` 分发（开箱可用语义不变）。
- **理由**：tree-sitter-wasms 0.1.13 上游停滞一年，预编译产物是唯一不受控环节；cli 0.27
  免 emcc 自建使产物可从锁定的源清单（vendored `languages.toml` pinned rev）再生，入库
  只剩 50MB 历史 object 成本与升级时的全量 diff。lite 集 36 → 34：objc/systemrdl 无查询
  资产（原预编译集死产物）剔除；yaml/vue 因 cli wasm 工具链不支持 C++ 外置 scanner 以
  vendored 遗留产物保留（`tools/grammar-builder/fixtures/`，manifest 标 `vendored`）。
- **连带变化**：web-tree-sitter 运行时锁 ~0.25.10 的理由消失（cli 0.27 产物含 dylink.0，
  实测 0.25 可加载），维持 0.25 为 API 稳定性选择；历史 commit 中的 wasm blob 经
  filter-repo 移除（体积回收）。
- **回补条件**：tree-sitter-wasms 或其他预编译分发源恢复活跃且覆盖 ≥264 语言时，可重评
  "预编译产物直接分发"方案；cli 支持 C++ scanner 后删除 fixtures 恢复全自建。
