# file-viewer 引入 · 计划 4（第二波：data/design/image/geo/typst/dicom/signature/eda/drawio/midi）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 引入第二波 12 个 npm 包（data/design/image/geo/typst/dicom/signature/eda/drawing + renderer-media 宿主 + capability-drawio-official/-midi），桥接装配约 66 个新扩展名（含 wasm 自 hex 转移、字体查看面、geo/typst/signature 自兜底转移），扩展资产映射与 SW 面、e2e 域编写、矩阵回写。

**Architecture:** 完全复用计划 3 钉死的形态：精确锁版 + wrapFileViewerRenderer 桥接 + 装配序铁律 + 全局 mount 队列串行化（计划 3 终审 I1 修复已全局生效，第二波自动受益）+ per-package 资产映射 + foreign-* chunk 分组 + 双门禁（check-foreign-deps 含 CDN 交叉断言 / foreign-budget 含 worker denylist 与存在性断言）。

**Tech Stack:** 同计划 3。

**Spec:** §6.3 序 12-21（引入清单）、§7（合规——introspect-wasm MPL-2.0 取面注记）。

## Global Constraints

- 沿计划 3 全部约束：精确版本无范围、零产物入 dist/precache、装配先于 codeRenderer、e2e 只写不跑（移交统一验证）、每任务原子 commit。
- **许可特别注记**：`@paged-media/introspect-wasm`（renderer-design 传递依赖）双许可 MPL-2.0 OR LicenseRef-PMEL——NOTICES 行显式注记「双许可取 MPL-2.0 面」；bpmn-js 不装（drawing 包的 BPMN 部分不启用——装配面不注册 bpmn 相关能力，`.bpmn` 维持计划 1 的 diagram-bpmn 渲染器）。
- **hex wasm 转移**：`wasm` 自 hex.ts:785 清单移除与 renderer-data 桥接注册同 commit（wasm 模块结构/导出解析归 data；hex 保留 open-as 兜底——用户拍板）。
- 字体扩展名（ttf/otf/woff/woff2）注册 renderer-data 桥接查看视图；fonts store 加载职责不动（spec §6.3 序 12）。
- image 桥接仅接管新 5 扩展名（tiff/tif/heic/heif/jxl）；原 9 格式维持 vviewer（jxl 上游实现形态实施时核实，若实际不支持则该扩展名不绑定并在 commit 注记）。
- midi 经 capability-midi（宿主 renderer-media）；**renderer-media 的媒体扩展名不注册**（vviewer av 占优）。

## Review Focus

1. **experimental 包错误面**：dicom/signature/eda/design 的解析失败须落标准错误卡（不白屏/不悬挂 mount）——T2 锚。
2. **wasm 双归属**：转移后 hex 不再认 wasm、data 桥接认——byExtension 单 owner 双向锚。
3. **字体查看 vs fonts store**：桥接打开字体文件不影响 fonts store 状态（互不写）——T2 锚。
4. **大 wasm 资产**：assets-typst（编译器 wasm）/assets-drawing（diagrams.net bundle）若超 jsdelivr 单文件 20MB 上限 → 按 spec §6.2 预案触发记录（实施时 HEAD 实测 content-length，超限项记台账不做二次封装——由用户后续决策）。
5. **signature 22 扩展名绑定面**：与 generated 兜底（sig 在册）转移原子。

---

### Task 1: 第二波依赖精确锁版 + NOTICES（12 包）

**Files:**
- Modify: `apps/web/package.json`（12 项精确版本：renderer-data/-design/-image/-geo/-typst/-dicom/-signature/-eda/-drawing/-media + capability-drawio-official/-midi，npm 实查 3.3.3 系）
- Modify: `THIRD_PARTY_NOTICES.md`（10 行新直接依赖 + introspect-wasm 双许可注记入 renderer-design 行）
- Test: 无新脚本（check-foreign-deps 既有门禁自动覆盖；跑一次验证 12 项全过）

- [ ] **Step 1: npm 实查 12 包精确版本 + peerDeps** → Step 2: package.json + install + NOTICES → Step 3: `node tools/check-foreign-deps.mjs --check` 绿 + 双 typecheck 0E + 根 vitest 全绿 → Step 4: Commit `feat(web): file-viewer 第二波依赖精确锁版引入（12 包）+NOTICES（introspect-wasm 取 MPL-2.0 面注记）`

### Task 2: 桥接装配第二波（约 66 扩展名 + wasm 转移 + 字体面）

**Files:**
- Modify: `apps/web/src/foreignRenderers.ts`（10 组 FOREIGN_GROUPS 增补：data(sqlite,parquet,avro,webarchive,ttf,otf,woff,woff2,wasm)/design(25)/image5/geo4/typst2/dicom2/signature22/eda5/drawing2(drawio,dio)/midi2——逐字依 spec §6.3 序 12-21；jxl 核实后定夺）
- Modify: `packages/vviewer-render-binary/src/hex.ts`（移除 `'wasm'`）
- Modify: `apps/web/src/lib/viewer.ts`（foreign 块增 10 组 install——仍在 codeRenderer 前）
- Test: bridge/装配锚扩展（全部新扩展名 byExtension + wasm 双向转移 + 源序 + rendering: false + jxl 核实结论落报告）

- [ ] **Step 1: 探针复核**（第二波包的 handler 签名/资产需求/assets-* 依赖——沿计划 3 T2 探针形态，落报告）→ Step 2: 失败测试 → Step 3: 实装（hex wasm 移除同 commit）→ Step 4: 绿（根 vitest/双 typecheck）→ Step 5: Commit `feat(web): file-viewer 第二波桥接装配——10 组约 66 扩展名+wasm 转移+字体查看面（spec §6.3）`

### Task 3: 资产映射扩展 + 门禁面复核

**Files:**
- Modify: `apps/web/src/lib/foreignAssets.ts`（FOREIGN_GROUP_ASSET_PACKAGE 增第二波映射：assets-data/design/drawing/typst——按 T2 探针实测；**超 20MB 文件 HEAD 实测**（assets-typst 编译器 wasm、assets-drawing bundle），超限项记台账）
- Modify: `apps/web/vite.config.ts`（若第二波 chunk 超 2MiB precache 上限 → foreign-* 分组增补；SW 规则前缀已通用则不动）
- Test: foreignAssets 锚扩展 + foreign-budget/check-pwa-build 复跑绿

- [ ] **Step 1: 映射+HEAD 实测** → Step 2: 实装 → Step 3: build + 双 --check 绿（foreign-budget 对新 chunk 面复跑）→ Step 4: Commit `feat(web): 第二波资产映射与 chunk 分组扩展（spec §6.2）`

### Task 4: e2e 域编写（SAVE-FOREIGN-2）+ 语料源扩展

**Files:**
- Modify: `tools/fetch-e2e-corpus.mjs`（第二波夹具精选：上游有小夹具的格式〔dicom/signature/geo/psd/sqlite 系——探针时查上游 test fixtures 清单〕；无小夹具格式降级记录）
- Create: `apps/web/e2e/b-foreign-office-2.spec.ts`（编写 only：每可得格式组渲染锚 + wasm 转移锚 + 字体查看锚 + signature/eda 错误卡锚 + FO-00 式 manifest 断言）
- Test: 无（编写 only）

- [ ] **Step 1: 语料源扩展+本地拉取验证** → Step 2: spec 编写（静态一致性走读）→ Step 3: 门禁（根 vitest/双 typecheck/porcelain）→ Step 4: Commit `test(e2e): SAVE-FOREIGN-2 域锚编写+语料源扩展（e2e 实跑移交统一验证）`

### Task 5: 矩阵回写第二波 + 收口

**Files:**
- Modify: `docs/file-viewer/format-package-survey-2026-11-04.md`（§3 第二波管线行转 ✅、§3.1 重算、§4.2 勾销第二波项、§4.4 三缺口注记全部清偿确认）
- Modify: `README.md`（第二波格式行）

- [ ] **Step 1: 实测注册面回写** → Step 2: 门禁（根 vitest/双 typecheck/双 --check/porcelain）→ Step 3: Commit `docs(survey): 覆盖矩阵第二波回写（实测注册面）`
