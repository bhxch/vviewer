# 代码渲染器引擎修复批：open-as 语言回填 + 切语言引擎路由 + worker 毒化重建 — 设计

日期：2026-11-12　状态：待用户审阅

## 1. 背景与动机（用户报的 bug）

「从其他渲染器切到代码渲染器后默认是 hljs，切换语言后还是 hljs，不用 tree-sitter」。侦察定案三层根因（彼此独立、叠加表现）：

1. **CDN 层全坏是最大主因**（spec③ 处理）：全量 grammar 包被 jsdelivr 150MB 上限 403 → 非 lite 34 语言（如 markdown）在三层合并清单中缺失 → worker `ok:false "语言 X 无可用 grammar 或查询"` → 静默 hljs 兜底。spec③ 拆包修复后此面自动收窄，本 spec 处理其余缺口。
2. **open-as 覆盖路径跳过 det.lang 回填**：dispatcher 唯一写 `det.lang`（shebang/extless 文本探测链）在 `resolveInitialRenderer`（packages/vviewer-core/src/dispatch/dispatcher.ts:345-355）；override 分支（:496-501）只跑 `override.sniff`（code 渲染器无 sniff 字段）→ 无扩展名文件 open-as code 时 `lang=null` → `hljsWholeFile`（highlightAuto）。正常直开同文件走文本探测拿 shebang 语言 → tree-sitter。
3. **langOverride 只改语言字符串、不参与引擎选择，且失败静默**：链路 MetaPanel `onLangCommit`（宽松透传不校验，MetaPanel.svelte:93-102）→ `setHighlightLang` → `DispatchOptions.langOverride` → `code/index.ts:78-89` `opts.lang` 跳过 detectLanguage；引擎仍由 strategy×client 可用性×worker 成败决定。清单外语言（datalist 候选是 languages.json 全量 301 名，本地 lite 仅 34 wasm；CDN 层坏时更窄）→ worker ok:false → catch → `hljsWholeFile`（renderCode.ts:536）**无任何用户可见原因**。
4. **HighlightClient 单例一次性毒化、无重建通道**：`failWorker`（packages/vviewer-highlight/src/client.ts:147-163）onerror/15s 看门狗触发后 `initFailed=true` 永久短路后续请求（:171-174 直接 reject）；创建失败 `attachHighlightClient(null)` → attachPhase 'failed' → `waitForAttachedClient` 即刻 null；单例失败保持 rejected 不重试（highlightClient.ts:32-33/:47-49），无任何重建面。启动 restore 多 tab 并发压垮 worker 一次 → 之后全会话所有 open-as/切语言/重渲染恒 hljs。

## 2. 设计

### 2.1 修 1：override 路径的语言回填

- dispatcher override 分支（:496-501）对 code 渲染器补 `det` 回填：复用文本探测链的 shebang 探测（`:345-355` 同源逻辑抽公共函数；**注意**该段是唯一写 det.lang 的地方——抽出时保持 auto 路径行为逐字节不变，回归锚=既有直开用例）。
- 范围：只补 shebang/文本探测链产出的 lang（extless 文件主诉求）；不做签名/扩展名重判（BUG-13 预检跳过语义维持——override 用户显式选择优先）。
- `Tab.overrideLang` 优先级不变（langOverride > det.lang）。

### 2.2 修 2：切语言的引擎路由与失败可见化

- **清单感知**：langOverride 生效时（renderOpts.lang 设定后），code 渲染器在 tree-sitter 尝试前查合并 grammar 清单（highlightClient 已持三层合并表——暴露 `hasGrammar(lang)` 查询口）；清单内 → 现行 worker 链；**清单外 → 直接 hljs 但附带结构化原因**，不再无声。
- **失败可见化**：状态栏 engine 指示已有（'hljs'），新增原因注记（hover title / 可选 toast，裁量）：「语言 X 无 tree-sitter grammar（当前资源清单），已用 hljs 兜底」。理由不进错误卡片（非失败，是降级）。
- **候选标注**（可选增强，裁量）：MetaPanel 语言 datalist 301 候选中标记「有 grammar」子集（`hasGrammar` 查询口 + datalist 无富文本能力 → 用分隔/排序把有 grammar 语言置前，或提示文案在语言行旁注记）。低成本优先。
- **远程面不动**：server-served lazy chunk「router null 不回本地 wasm」是既有简报裁决（renderCode.ts:400-403、docs/e2e/override-lang.md:42），维持；注意该裁决与整文件路径 auto 失败折回本地 wasm（router.ts:113-121）的差异已在侦察中确认为既有语义，本 spec 不改。

### 2.3 修 3：client 毒化后的重建通道

- 原则：**不自动无限重试**（防循环），在用户显式动作面提供重建：
  - 显式面=切换渲染器（setRendererOverride）、切语言（setHighlightLang）、设置中心 CDN 档位变更（spec③ 接缝）触发时，若 client 处于 initFailed/attach-failed → destroy 旧单例 + 重新 create（限流：单飞闸防并发重建，同代际防旧实例回魂——复用 STORE_UID/代际判据先例心智）；
  - 重建后首次 highlight 失败 → 回落 hljs（现行语义），不二次自动重建（该会话该代际内）。
- `failWorker` 的 `initFailed` 语义保留为「当前实例不可用」，可被 destroy 清除；15s 看门狗阈值不动。
- 兼容红线：BUG-35（init-ok ack 置活）与 BUG-34/37 相关既有锚不翻转；worker init-ok ack 路径零改动。

## 3. 目标 / 非目标 / 反目标

- 目标：open-as 后 extless 文件能吃 tree-sitter；切语言清单内语言走到 tree-sitter；清单外降级有可见原因；worker 毒化后用户动作可恢复。
- 非目标：CDN 层修复（spec③）；lazy chunk 远程裁决变更；worker 看门狗阈值调优；自动健康探测重试。
- 反目标：把 hljs 兜底改成错误卡片（降级不是失败）；在 worker 内做清单外语言的动态拉取（清单面已含 CDN 层，够了）。

## 4. 验收锚点

- 单测：dispatcher override det 回填（shebang 文件 open-as code → lang 命中）；hasGrammar 查询口；client destroy/recreate 代际（failWorker 后显式动作重建成功，单飞/代际用例）；降级原因结构化字段。
- e2e：①无扩展名 shebang 文件 open-as code → ts-* span（RED 现状=hljs）；②overrideLang 清单内语言 → tree-sitter（LANG-01 既有锚保持）；③清单外语言 → hljs + 原因提示可见；④构造 worker 失败（mock 15s/错误帧）→ 显式切语言后恢复 tree-sitter；⑤重渲染横切：毒化后正常直开文件不再永久 hljs（重建后）。
- 回归：直开 .py（lite 内语言）路径逐字节不变（侦察确认 override 与正常路径在渲染层同构，修 1 后需复测两路径一致）。

## 5. 留给 builder 的裁量

- det 探测链抽取的函数边界；原因提示的具体通道（状态栏 title vs toast vs 两者）；hasGrammar 查询口的暴露层（client vs grammarLayers）；重建触发面是否含「手动重试」按钮（错误卡片无——降级面不用错误卡）；MetaPanel 候选排序的最终形态。
