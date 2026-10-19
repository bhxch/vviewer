# 设计：字体系统（UI/代码字体与字号、网络字体管理）

- 日期：2026-10-19
- 状态：已评审（brainstorm 确认，待实施）
- 关联：`2026-10-12-appearance-subscription-design.md`（中心化订阅注入模式）、后续 `设置中心` spec（schema 迁移 UI）、`markdown 对齐 markpad` spec（导出 HTML 字体嵌入为后续候补，本 spec 不含）

## 1. 背景与目标

现状：UI 字体硬编码于 `app.css:36`（`body { font-family: system-ui, ... }`），代码字体仅有 `--vv-code-font` 变量（app.css:4）但字号硬编码（`.vv-code-pre` 13px / `.vv-hex-dump` 12px），用户无任何字体配置能力。

目标：UI 字体与代码字体各自可配 family + size；字体来源支持预设清单、手输 family 名、网络 URL、本地上传文件；带字体管理功能（列表/启停/删除/样张预览）。

### 已拍板的决策（brainstorm 记录）

| 决策点 | 结论 |
| --- | --- |
| 系统字体枚举 | **仅预设+手输**：不做 `queryLocalFonts`（Chromium 专属需授权）也不做宽度探测；预设清单分组展示 + 手输任意 family 名（允许多级回退） |
| 网络字体 | **URL + 本地上传**双入口；fetch 下载后 **IndexedDB 缓存**（PWA 离线可用、跨会话零重下） |
| 应用粒度 | 两槽位：`uiFont`（family+size）、`codeFont`（family+size）；代码字号变更联动虚拟滚动行高（code/hex/jsonl 三处） |
| 字号语义 | UI 字号作用于 body 继承面（正文阅读、文件树、面板基础文本）；显式 px 定值的紧凑组件（按钮/徽标）不承诺等比缩放 |

### 非目标

- 不做 `queryLocalFonts`/宽度探测（上述裁决）。
- 不做 per-app 区域独立字号（如单独调文件树字号）。
- 不做字体渲染微调（字重/字距/抗锯齿开关）。
- 不做导出 HTML 嵌入自定义字体（markpad 对齐 spec 的后续候补项）。

## 2. Settings schema 与应用机制

### 2.1 schema 扩展

```ts
fonts: {
  uiFamily: string;    // '' = 默认（现 system-ui 栈）
  uiSize: number;      // px，默认 16（body 现状），clamp 10–28
  codeFamily: string;  // '' = 默认（现 --vv-code-font 栈）
  codeSize: number;    // px，默认 13（.vv-code-pre 现状），clamp 9–28
}
```

`loadSettings` 字段白名单同步扩展；spec 6 设置中心落地后仅迁移 UI，schema 不变。

### 2.2 CSS 注入（theme.ts 同模式新增 applyFonts）

- 独立注入节点 `style#vv-font`（不与外观注入混用，避免字体改动触发外观重注入）：
  `--vv-ui-font`（family 栈 = 设置值 + 回退栈）、`--vv-ui-font-size`、`--vv-code-font`、`--vv-code-font-size`、`--vv-code-line-height = max(16, round(codeSize × 1.5))`（现 13px→20px 关系即 1.538，归一为 ×1.5）。
- app.css 消费点改造：`body` 字族/字号改变量（保留现值为 fallback）；`.vv-code-pre` 13px 与 `.vv-hex-dump` 12px 均改 `var(--vv-code-font-size)`（hex 由 12px 归一到同一字号，视觉微变知情接受）；markdown 行内 code 的 `.9em` 相对值不变。
- family 名注入前做 CSS 转义（引号/反斜杠），自定义名经 `CSS.escape` 语义校验，防注入。

### 2.3 变更订阅

- 中心化订阅点（appearance 订阅同处）监听 fonts 四元组签名，变化即重注入 `style#vv-font` 并**触发激活 tab 重渲染**（rev++），原因见 §3。

## 3. 虚拟滚动行高联动（本 spec 硬骨头）

现状：`packages/render-text/src/code.ts:75` `LINE_HEIGHT = 20` 常量喂给 core virtualScroller 固定行高 API；hex 行虚拟化（BUG-16 引入）同理。字号可变后行高必须随动，否则行点击错位/滚动计算漂移（hex 行宽 max-content 修复的前科警示）。

- `Renderer.render` 的 `opts` 协议扩展：`opts.lineMetrics?: { fontSize: number; lineHeight: number }`（`opts.signal` 第 6 参先例）。code 与 hex 渲染器以 opts 值替换常量，缺省回落现值（20/字号 13），跨包零破坏。
- 字体变更链路：settings 订阅 → CSS 变量注入（视觉即时）→ 激活 tab rev++ 重渲染（滚动器以新行高重建，scrollTop 数值保留——字号变化后行号锚点近似保持，不做像素级补偿，注记即可）。
- jsonl 可变高度窗口（HeightModel 测量缓存）：同信号清测量缓存并重测（字体变化使高度缓存全失效）。
- 后台索引泵/流式语义不受影响（行高只影响展示层）。

## 4. 预设清单与手输

- 预设分组（按可用性分化不承诺，缺字体由浏览器回退）：
  - UI（无衬线）：system-ui、微软雅黑、PingFang SC、Noto Sans CJK SC、思源黑体、Segoe UI、Roboto、Helvetica Neue；
  - 代码（等宽）：默认等宽栈、JetBrains Mono、Fira Code、Cascadia Code、Consolas、Menlo、SF Mono、Source Code Pro、更纱等宽 Sarasa Mono SC、Noto Sans Mono CJK SC。
- 手输框：任意 family 名，支持逗号分隔多级回退（如 `JetBrains Mono, Sarasa Mono SC, monospace`）；实时预览样张。
- 样张文本：`AaBbYyZz 0123 永江流千里 0OIl1|`（中英数易混形字符齐全）。

## 5. 网络字体与字体管理

### 5.1 存储

- IndexedDB `vviewer` 库 **v2→v3** 迁移：新增 `fonts` object store，记录 `{ id, name, family, kind: 'url'|'file', data: ArrayBuffer, url?, size, enabled, addedAt }`（键 `id`，`enabled` 索引可选）。升级回调按需补建（session.ts `db()` 现模式），不动 kv/themes。
- 字体二进制只存 IndexedDB；settings 不存字体内容，家族引用按 name 动态解析（已加载且 enabled 的网络字体进可选清单）。

### 5.2 加载与生命周期

- **URL 添加**：输入 http(s) URL → `fetch` → ArrayBuffer → `new FontFace(family, buffer)` → `document.fonts.add`；**必须 https**（mixed content 防线）且目标 host 需允许 CORS（fetch 失败显式报错入列表错误态，注记「字体源需开启 CORS」）。
- **本地上传**：file input 接受 `.ttf/.otf/.woff/.woff2`，同 ArrayBuffer 路径。
- family 命名：默认取文件名去扩展名（URL 取末段），可改名；`FontFace` family 参数以引号包裹原文。
- 启用/停用：停用 `document.fonts.delete` + 触发界面重渲染；启用从 IndexedDB buffer 重建 FontFace。
- 删除：store 记录删除 + fonts 表注销 + 若被 uiFamily/codeFamily 引用则槽位回落默认并提示。
- 管理区每次列表项带样张预览（该字体渲染的 §4 样张）与体积显示；体积超 30MB 单文件拒收（IndexedDB 配额保护，提示上限）。

### 5.3 管理 UI 位置

`SettingsPanel.svelte` 新增「字体」section：上半两槽 picker（预设/网络字体下拉 + 自定义手输框 + 字号 number input）；下半网络字体列表（添加 URL / 上传 / 启停开关 / 删除）。spec 6 设置中心落地后整体迁移，组件按可搬迁粒度实现（逻辑与视图分离）。

## 6. 错误处理

- URL 字体 fetch 失败/非字体内容（`ArrayBuffer` 交给 FontFace 后 load reject）→ 列表项错误态 + 重试钮，不影响其他字体。
- 手输 family 本机不存在 → 无错误（浏览器回退），预览区展示回退效果本身即验证手段，注记。
- IndexedDB 写入配额超限 → 显式错误提示并保留原记录。
- 字体加载中（大文件 fetch）→ 列表项 loading 态；面板关闭后台继续，完成入列表。

## 7. 测试

- 单测：schema 白名单与 clamp、行高公式边界（9/13/28）、CSS 转义（含引号/分号/反斜杠 family 名）、opts.lineMetrics 透传（code/hex 渲染参数断言）、jsonl 缓存失效、fonts store CRUD 与 v2→v3 迁移（fake-indexeddb 既有基建）、URL 添加失败路径、启停 document.fonts 交互（mock FontFace）。
- e2e：设置字号后 code/hex 行点击不错位（复用 hex 点击映射既有 e2e 手法换字号档）、jsonl 重测、字体列表增删启停（URL 走本地伺服 mock 字体文件）、重启后字体验证恢复。
