# 设计：扩展名覆盖自动化、未知格式内容探测与打开方式手选

- 日期：2026-10-11
- 状态：已评审（brainstorm 确认，待实施）
- 关联：`2026-10-06-vviewer-design.md`（M2 dispatch/registry）、`2026-10-11-jsonl-viewer-design.md`（消费本设计的装配顺序）、`2026-10-09-full-grammar-alignment-design.md`（languages.json 来源）

## 1. 背景与目标

现状三个缺口：

1. **扩展名覆盖靠手工清单**：`code` 渲染器的 extensions 数组（`apps/web/src/lib/viewer.ts`）仅约 50 项，而 tree-sitter `languages.json` 有 342 语言条目（309 grammar）各自带 `fileTypes`。缺口实锤：`.jsonl` 打不开（不在清单、有扩展名不走无扩展名回退链，直接报「不支持的扩展名」）。
2. **不支持格式无内容探测**：`sniffSignature`（7 种 magic）与 `looksTextual`（NUL/控制字符占比）只服务于无扩展名回退链；带未知扩展名的文件（如 `.foo` 的 PNG）直接错误卡片。
3. **用户无打开方式选择权**：全仓无「打开方式」入口；唯一近似物是渲染失败错误卡片上的「降级查看（→hex）」动作（BUG-14）。

目标：扩展名注册构建期自动生成（消灭手工清单缺口）；未知扩展名走内容探测自动选择纯文本或 hex；任何已打开文件可手动切换渲染器（VSCode "Open With..." 模式）。

### 已拍板的决策（brainstorm 记录）

| 决策点 | 结论 |
| --- | --- |
| 扩展名来源 | 构建期脚本从 `languages.json` 的 fileTypes 生成，入库为生成物（小 JSON，避免运行链依赖 grammar 构建），CI 校验新鲜度 |
| 收录规则 | 仅收**含点**的 fileTypes token（`rs` 来自 `.rs` 形态，统一归一为 `rs`）；无点文件名（Makefile/README）不收——文本类由既有 extless 回退链覆盖，二进制类由探测链落 hex |
| 装配顺序 | 专有渲染器先注册（现序），生成物只补未被占用的扩展名（`registry` 重复注册抛错语义天然防呆）；`jsonl`/`ndjson` 由 jsonl 渲染器（D 项）专有优先 |
| 自动探测顺序 | 未知扩展名 → `sniffSignature` 改派（复用 SIGNATURE_ROUTES）→ `looksTextual` 判文本走 code → 否则 hex |
| 打开方式入口 | 两层：错误卡片快捷按钮（纯文本/hex）+ MetaPanel 常驻「打开方式」下拉（列适用渲染器，当前项标 active） |
| override 载体 | `Tab.overrideRenderer?: RendererId`，dispatch 时最优先；会话快照新增可选字段 |

### 非目标

- 不做「始终以此方式打开」的持久关联偏好（未来项）。
- 不改 `detectEncoding`（BOM/UTF-8/gb18030 链）与扩展名→高亮语言映射（`detectLanguage`）——二者与渲染器路由正交。
- 不做 magic 签名表扩充（仍 7 种；扩充另行立项）。

## 2. 设计

### 2.1 构建期扩展名生成

- 新脚本 `tools/grammar-builder/gen-code-extensions.mjs`：读 `packages/highlight/assets/languages.json`，收集全部 `fileTypes` token，过滤出含点项并剥前导点、小写归一、去重、排序，写出 `packages/core/src/registry/generated-extensions.json`（字符串数组）。
- 生成物**入库提交**（与 wasm 产物「一律不入库」原则不冲突：该文件 KB 级且是运行时装配依赖，不构建 grammar 也要可用——lite 离线、e2e 直跑依赖此）；脚本提供 `--check` 模式，CI 比对无 diff。
- 装配（`apps/web/src/lib/viewer.ts`）：现有 11 个渲染器按现序 install 后，读生成 JSON 逐项 `tryRegisterExtension('code', ext)`——已被占用静默跳过，新增项记 debug 日志。`code` 渲染器原手工清单缩减为「非语法类」（txt/log/conf 等），语法类全部移交生成物。
- 预期效果：`.jsonl`、`.adoc`、`.astro` 等数百扩展名自动获得 code 路由；语言不认识时由 `detectLanguage` → shebang → hljs `highlightAuto` 既有降级链兜底。

### 2.2 未知格式内容探测（dispatcher）

`packages/core/src/dispatch/dispatcher.ts` 在 `byExtension` 未命中且 `ext !== ''` 分支，套用既有 extless 回退链：

1. `sniffSignature(head)` 命中 `SIGNATURE_ROUTES` → 签名改派（zip→archive、图片→image、pdf→pdf、mpegts→av；ole 无渲染器不改派，继续下一条）。
2. `looksTextual(head)` → code 渲染器（含 shebang 语言探测现状逻辑）。
3. 都不命中 → hex 渲染器（结构树/虚拟滚动既有能力直接受益）。

探测结果经错误卡片文案反馈：命中探测时 meta 行注明「已按内容识别为 …（原扩展名 .foo）」，帮助用户理解改派原因。

### 2.3 打开方式手选

- **数据**：`Tab` 新增 `overrideRenderer?: RendererId`；`dispatcher.dispatch` 增加 override 入参，优先于一切探测/路由（override 渲染器 render 抛错仍走错误卡片+降级动作）。会话快照 `TabSnapshot` 新增可选 `overrideRenderer`（旧快照缺字段兼容）。
- **入口 A（错误卡片快捷动作）**：「无法预览此文件」卡片在既有「重试 / 降级查看」旁增加「以纯文本打开」「以 hex 打开」两按钮（按探测结果动态排序，探测结论对应的按钮排前）。
- **入口 B（MetaPanel 常驻下拉）**：右栏 MetaPanel 顶部新增「打开方式」select：候选项 = 该扩展名注册的渲染器（byExtension 命中项）∪ 探测链可能落点（code/hex），当前生效项标 active；切换即写 `tab.overrideRenderer` 并重渲染（尽力保留 scrollTop）。移动端右栏为抽屉，入口 A 为主要触达路径。
- 渲染器中文名沿用 registry `label`（代码/文本、二进制、Markdown、图片……）。

## 3. 测试

- 单测：生成脚本对样例 languages.json 的过滤/归一/去重；`tryRegisterExtension` 占用跳过；dispatcher 未知扩展名三分支（签名改派/文本/hex）；override 优先级与错误降级；快照往返含 `overrideRenderer`。
- 快照锁：`generated-extensions.json` 必含 `jsonl`（D 项契约锚点）。
- e2e：`.foo` 扩展名的 PNG 打开 → 图片渲染；`.foo` 二进制 → hex + 错误卡片旁路验证；MetaPanel 切换打开方式（code↔hex）生效且刷新恢复。

## 4. 风险与已知限制

- 生成物扩展名量大（估数百项）：registry 为 Map 索引，量级无性能影响；`detectLanguage` 未命中语言时高亮走 hljs auto，首帧成本与现状相同。
- 探测对「无 NUL 且控制字符少」的假文本（如部分 UTF-16 无 BOM）会误判为文本：与 extless 链现状同风险，接受（用户可手选 hex）。
- SVG/MD/HTML 等专有扩展名不受影响（专有渲染器先注册）。

## 5. 验收

| 项 | 标准 |
| --- | --- |
| 覆盖 | `.jsonl` 等生成物内扩展名全部可打开（code 渲染）；CI `--check` 门禁就位 |
| 探测 | 未知扩展名三分支路由正确，错误卡片消失率（抽查样本集）符合预期 |
| 手选 | 错误卡片与 MetaPanel 两入口可用，override 经刷新恢复 |
| 回归 | vitest / typecheck / playwright 全绿 |

交付顺序：先 2.1+2.2（生成与探测），再 2.3（override 与 UI）；TDD，分两个 commit。
