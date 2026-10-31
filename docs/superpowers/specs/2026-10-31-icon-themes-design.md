# VSCode 图标主题支持（icon theme 格式 + Seti 预置）设计

- 日期：2026-10-31
- 状态：已批准（brainstorming 六需求批量立项之一）
- 上游：`2026-10-11-vscode-themes-design.md`（颜色主题导入/存储/解析基建）、`2026-10-19-settings-center-design.md`（设置中心外观分组）

## 1. 背景与动机

vviewer 目前**没有任何文件图标**：`TreeNodeRow.svelte:48-51` 仅渲染 caret（文本 ▾/▸）+ 纯文本名；tab（`TabBar.svelte:275`）、快速打开（`QuickOpenPanel.svelte:173-174`）、全局搜索结果（`GlobalSearchPanel.svelte:276-278`）同为纯文本。全仓无扩展名→icon 映射。

VSCode 颜色主题基建已就位（VSIX 解包、JSON 导入、IndexedDB themes store、设置中心外观分组），icon theme 是同族能力：同一导入通道、同一存储模式、同一设置分组。用户拍板：**支持 VSCode icon theme 插件格式，预置 VSCode 默认图标主题（Seti）**；出现范围做成设置项，默认仅文件树。

## 2. 数据面

### 2.1 支持的格式范围

VSCode file icon theme JSON（`contributes.iconThemes` 指向的主题清单文件），消费字段面：

| 字段 | 语义 | vviewer 处理 |
|---|---|---|
| `iconDefinitions` | 图标定义表：`fontCharacter`（字形码点）/`fontColor`/`fontSize`/`fontId` | 全支持；`fontCharacter` 是单字符（如 `\uea01`） |
| `fonts` | 字体表：`id`/`src`（相对主题文件的 woff/ttf 路径）/`format` | woff/woff2/ttf，FontFace API 注册 |
| `fileNames` | 精确文件名→图标 id | 支持 |
| `fileExtensions` | 扩展名→图标 id | 支持 |
| `languageIds` | VSCode 语言 id→图标 id | 支持，经 §2.4 映射表 |
| `folderNames` / `folderNamesExpanded` | 目录名（开/合）→图标 id | 支持 |
| `_file` / `_folder` / `_folder_open` | 保留键：默认文件/目录图标 | 支持（回退链终点） |
| `hidesExplorerArrows` | 主题自带目录开合形态时隐藏箭头 | 见 §3.3 |

**非目标**：SVG 路径形态的图标定义（VSCode file icons 本身仅字体字形形态，无 SVG 通道；不存在此格式即无兼容损失）；产品图标（codicon UI 图标，另一 contributes 类别）。

预置 Seti = VSCode 默认图标主题（MIT），vendor vscode 仓库 1.141.0 的 `seti-icons.json` + 字体文件到 `packages/vviewer-highlight/assets/icon-themes/seti/`（与既有 dark/light_modern.json vendor 同包同惯例；入库前核字体体积，woff 优先）。

### 2.2 解析与校验

- 新模块 `packages/vviewer-highlight/src/vscodeIcon.ts`：`validateVscodeIconTheme(json)` 仿同包 `validateVscodeTheme`（`vscode.ts:77-96`）模式——name 必填、iconDefinitions/fonts 结构校验、字体 src 路径域校验（拒绝对路径/协议前缀）；产出归一化后的主题实体。
- JSONC 容忍：现有颜色主题导入用纯 `JSON.parse`（`vsixImport.ts:43-49`），Seti vendor 件入库前做同款「JSONC 规范化」（剥注释/尾逗号，`2026-10-11-vscode-themes-design.md` 先例）；用户导入的文件按纯 JSON 处理，解析失败报错（与颜色主题导入现状一致）。

### 2.3 存储与导入

- `apps/web/src/lib/stores/session.ts`：`DB_VERSION` 4→5，`onupgradeneeded` 补建 `iconThemes` store（仿 MOUNTS v4 先例 `:46-52`）。记录结构 `ImportedIconTheme { id: 'imported:<随机8>', name, manifest（归一化实体）, fonts: [{ path, format, data: ArrayBuffer }], source: 'json'|'vsix', addedAt }`。
- 导入管线复用 `vsixImport.ts` 骨架：VSIX 解包（`createZipStore`，`@bhxch/vviewer-render-archive/zipStore`）+ 清单读取（`readVsixManifest`，定位 `contributes.iconThemes[].path`）+ 字体文件收集。**JSON 直导要求字体同批选中**（builder check 收敛：单 JSON 内只有 `fonts[].src` 相对路径无二进制，无字体的主题一个字形都渲染不出）——多选 json+字体文件同批导入，`fonts[].src` 按文件名关联，缺失任一字体 → 拒绝入库并报错，不产生残主题。函数 `importIconThemeFiles(files)` 与既有 `importThemeFiles` 并列。
- 预置 Seti 不走导入：构建期静态 import，以内置实体形态参与选择器（仿 `BUILTIN_APPEARANCES` 动态 import 先例 `theme.ts:137-140`）。

## 3. 消费面

### 3.1 设置项（用户拍板的范围开关）

settings 新增节（settingsDraft 白名单同步）：

```
iconThemes: {
  theme: 'none' | 'seti' | 'imported:<id>',   // 默认 'none'
  scopes: {
    tree: true,        // 文件树——默认唯一开启项
    tabs: false,       // tab 栏
    quickOpen: false,  // 快速打开
    search: false,     // 全局搜索结果
  }
}
```

- UI 落设置中心**外观组**（`AppearanceSection.svelte` 增分区：主题选择器 + 四个范围复选；已导入列表与删除复用颜色主题列表的交互形态）。
- 图标主题**单选、不随亮暗切换**（VSCode 同款；`fontColor` 为主题静态值，不做暗色变体推导）。

### 3.2 字形渲染机制

- 字体注册：`document.fonts.add(new FontFace('vv-iconfont-<themeId>', buffer))`；主题切换/删除时注销（fonts store 有 `document.fonts` 注销先例，设置中心存储管理同款）。
- 单一 helper `iconGlyphFor(theme, target): { char, color?, fontSize? } | null`（highlight 包导出，消费侧共享单源）：目标为 `{ kind: 'file'|'folder'|'folderExpanded', name, ext?, langId? }`。匹配优先级 = VSCode 语义：`fileNames`（全名精确）> `fileExtensions`（尾扩展名，含多级如 `.d.ts` 取全后缀尝试）> `languageIds`；目录：`folderNames`/`folderNamesExpanded` → `_folder`/`_folder_open`；文件最终回退 `_file`。
- 渲染：各消费点在名称前置 `<span class="vv-file-icon" style="font-family:…;color:…">{char}</span>`；helper 返回 null（无匹配且主题无 `_file`）则不渲染、布局零位移。
- CSS 类样式进 app.css（`.vv-file-icon` 基线：inline-flex、禁选中、宽度不固定），具体尺寸对齐各消费点行高。

### 3.3 各作用域落点

| 作用域 | 落点 | 说明 |
|---|---|---|
| tree | `TreeNodeRow.svelte`（文件行）+ `FileTree.svelte` 源头行（目录图标） | 见下方 caret 规则 |
| tabs | `TabBar.svelte:275` tab 名前 | 文件 tab；目录 tab 用 folder 图标 |
| quickOpen | `QuickOpenPanel.svelte:173-174` | 文件行 |
| search | `GlobalSearchPanel.svelte:276-278` 文件头行 | 仅文件头行加图标，命中行不加 |

caret 规则（`hidesExplorerArrows` 语义对齐 VSCode）：主题定义了 folder 图标且 `hidesExplorerArrows=true` → 目录行 caret（▾/▸）由 folder/folderExpanded 图标替代；定义了 folder 图标但 false → 图标与 caret 并存；未定义 folder 图标 → 维持纯 caret 现状。

### 3.4 languageIds 映射（builder check 收敛为反向表）

VSCode 语言 id 与 helix 语言名不同源，且文件 detect 结果只存在于活动 tab 的 compute 链——文件树、非活动 tab、快速打开、搜索结果均拿不到 per 文件 detect，`languageIds` 若按 detect 结果匹配，在默认作用域（树）永不命中。故映射表**反向使用**：`vscode id → 扩展名集合`，匹配输入 = 文件名扩展名本身（零 detect 依赖，四个作用域一致）。vendored 首版覆盖 ~40 主流 id（typescript/javascript/python/rust/go/java/c/cpp/csharp/shell/html/css/json/yaml/markdown 等）；表外 id 无匹配（静默，不报错）。无扩展名文件不经 languageIds 命中——该场景由 fileNames 覆盖，与 VSCode 主题的实际用法一致。

### 3.5 生效通道

settings.iconThemes 变更 → 注册字体 + 计算 `iconSig`（theme id + scopes 序列化）→ 进既有 `touchActiveTab` 重渲染联动（fontsSig 先例，`fontsReaction` 模式）；树/搜索面板等非 tab 组件按各自响应式依赖自然重渲。`imported:<id>` 被删除时回退 `none`（引用回落语义，颜色主题同款）。

## 4. 触达面

- **packages/vviewer-highlight**：`vscodeIcon.ts`（校验+归一化+glyph 匹配）、Seti vendor 资产、单测（Seti 向量：常见扩展名/目录/回退链逐点断言）。
- **apps/web**：`vsixImport.ts`（icon 导入函数）、`stores/session.ts`（v5 + CRUD）、`settings/AppearanceSection.svelte`（UI）、`settingsDraft.ts`（白名单/规范化/导入导出）、`iconReaction.ts`（sig 联动，仿 fontsReaction）、四个消费组件、`stores/settings.ts`（默认值）、app.css。
- **e2e**：ICON-01..——Seti 预置默认树图标渲染；scopes 四开关逐点显隐；VSIX 导入第三方主题生效；删除主题回退；tab/quickOpen/search 作用域开启后锚点。

## 5. 非目标与边界

- 不支持 SVG/产品图标（§2.1）；不做图标主题的亮暗双槽。
- 彩色 emoji 字体类主题（字体本身多色）按 FontFace 原样渲染，`fontColor` 不覆盖彩色字形——行为等价 VSCode，不做特殊处理。
- 会话快照不新增字段（theme/scopes 全在 settings，跨会话天然恢复）。
- 字体文件体积核验在实施期入库时做（预期 woff 数十 KB 级；若 vendor 件超预算，回退 ttf→woff 转换或裁字形子集，builder 裁决并记档）。
