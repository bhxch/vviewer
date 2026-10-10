# 设计：JSON Lines（.jsonl/.ndjson）行卡片流式渲染器

- 日期：2026-10-11
- 状态：已评审（brainstorm 确认，待实施）
- 关联：`2026-10-11-format-coverage-open-with-design.md`（装配顺序契约：专有渲染器先注册，生成物跳过被占扩展名）、`2026-10-06-vviewer-design.md`（registry/dispatch）、`2026-10-09-full-grammar-alignment-design.md`（tree-sitter json 高亮管线）

## 1. 背景与目标

现状：`.jsonl` 完全打不开（`code` 渲染器扩展名清单无此项、有扩展名不走 extless 回退链 → 错误卡片；`ndjson` 同缺）；JSON 仅是语法高亮的纯文本视图，无任何结构化渲染。C 项落地后 `.jsonl` 会以纯文本形式可打开，但仍无行级结构化体验。

目标：新增 JSON Lines 渲染器——每行一个卡片、流式（按需）加载与解析、tree-sitter json 高亮；解析失败行显式标注不中断整体。

### 已拍板的决策（brainstorm 记录）

| 决策点 | 结论 |
| --- | --- |
| 注册 | renderer id `jsonl`，label「JSON Lines」，extensions `['jsonl','ndjson']`；在 viewer.ts 装配序列中先于 C 生成物注册（占用即免疫生成物覆盖） |
| 卡片内容 | 行号徽标 + 该行 JSON 的 pretty-print（`JSON.stringify(v, null, 2)`，保持键原序不排序）；解析失败行显示原始文本 + 红色错误徽标（tooltip 提示原因），不影响其他行 |
| 长内容 | pretty 后超 40 行的卡片默认折叠（显示首 40 行 + 「展开全部」）；展开仍封顶 400 行，超出部分卡片内滚动（高度有界是窗口化前提） |
| 滚动 | 可变高度窗口化渲染（测量缓存型，render-jsonl 内自建），不扩展 core `virtualScroller` 的固定行高 API |
| 高亮 | pretty 文本走 tree-sitter json（复用 highlight worker chunk 泵）；降级链与 code.ts 同构（≤2MB 整文件 ts、>2MB 可视区 lazy、>200MB 无高亮） |
| 流式 | 本地 File 按 `File.slice` 块读、远端按 Range 块拉，只解析已加载块；滚动按需续读 |
| 实施顺序 | 不强依赖 C：本渲染器专有注册后 `.jsonl` 即可打开；C 落地仅影响生成物归属 |

### 非目标

- 不做行过滤/搜索框、不做 JSON 树形折叠导航（未来项）。
- 不做行级 diff、schema 推断、表格视图。
- 不改 `application/x-ndjson` 搜索流协议（与本渲染器无关）。

## 2. 设计

### 2.1 模块与管线

- 位置：`packages/render-text/src/jsonl.ts`（与 code.ts 同包，直接复用其块读取、chunk 泵与 worker 高亮基建；不新建包）。
- 行切分与 code.ts 一致（`\n`；剥离 UTF-8 BOM）；空行跳过不占卡片（JSONL 惯例容忍尾空行）。
- 行状态机：`unloaded → loaded(raw) → parsed(ok | failed(reason)) → highlighted`，全部惰性；解析在主线程（可视区 `JSON.parse` 成本可忽略），高亮走既有 worker。
- 惰性解析按 chunk 组织（对齐 `CHUNK_LINES=200` 思路），解析结果与 pretty 文本进 LRU（对齐 `CHUNK_CACHE_MAX_LINES` 思路），滚动往返零重复解析。

### 2.2 流式加载

- 首屏只加载/解析可视区 ± overscan 的行块；向上/向下滚动触发相邻块读取（本地 `Blob.slice` 字节块对齐到换行边界；远端 Range 请求对齐同参数，复用 code.ts 的远端块读取协议）。
- 顶部 meta 显示「已加载 N 行」（总行数未知，滚动到底才确定）；达到文件尾显示「共 N 行」。
- 巨大单行防护：单行原始字节 > 1MB 时不解析，直接以原始文本前 64KB 展示 + 「行过大（>1MB）」徽标。

### 2.3 卡片与窗口化渲染

- 卡片 DOM：`.vv-jsonl-card`（行号 gutter + pretty 文本容器 + 状态徽标）；失败行卡片加错误态样式与原因 tooltip。
- 高亮注入与 code.ts 同机制：tree-sitter span 类名 + `--vv-ts-*` CSS 变量，主题切换零重解析。
- 可变高度窗口：渲染后实测卡片高度进缓存（以卡片为粒度），总高 = 实测 + 未测区按估算值（默认折叠高度）外推，滚动时修正；回收视口外卡片 DOM。
- plain 降级（>200MB）：退回 code 渲染器纯文本虚拟滚动模式（状态栏注明），不做行卡片（200MB 卡片化内存不可控）。

### 2.4 与 dispatcher/打开方式的关系

- 扩展名 `jsonl`/`ndjson` 命中本渲染器；用户可经 C 项「打开方式」手选切到 code（纯文本）或 hex（本渲染器 render 抛错时的降级动作同样适用）。
- 服务端 `X-VV-Lang: json` 头与既有 detect 链不受影响。

## 3. 测试

- 单测：行切分/BOM/空行；解析状态机（成功/失败/过大行）；pretty 与折叠阈值；chunk 缓存往返；窗口化测量外推修正。
- 集成：本地 File 与远端 Range 两通道的首屏块边界（跨块行不重复不丢失）。
- e2e：打开 `.jsonl` 显示行卡片；含坏行的样例文件失败徽标与续读；大文件（数十 MB 合成样例，远低于 200MB 降级线）滚动流畅且内存有界；「打开方式」切 code/hex 往返。
- 性能锚点：1MB/约 5000 行样例首屏可交互 < 200ms（桌面 headless 中位），对齐 BUG-16 hex 首屏口径。

## 4. 风险与已知限制

- 可变高度窗口的估算误差在大幅跳跃滚动（拖滚动条到底）时会出现一次高度修正跳动：接受（行业通行做法）。
- 极深嵌套 JSON 的 pretty 行数上限由折叠封顶兜底；`JSON.parse` 对超大行已被 2.2 防护拦截。
- `ndjson` 若未来进入 languages.json fileTypes 被 C 生成物收录，装配顺序保证仍归属本渲染器。

## 5. 验收

| 项 | 标准 |
| --- | --- |
| 打开 | `.jsonl`/`.ndjson` 默认以 JSON Lines 渲染器打开，行卡片正确 |
| 容错 | 坏行/过大行标注显示，不中断其余行 |
| 流式 | 大文件首屏只加载首块，滚动续读无重复解析（缓存命中可观测） |
| 高亮 | tree-sitter json 生效；>200MB 降级纯文本有提示 |
| 回归 | vitest / typecheck / playwright 全绿 |

交付顺序：管线与解析（TDD）→ 窗口化 UI 与 e2e；两个 commit。
