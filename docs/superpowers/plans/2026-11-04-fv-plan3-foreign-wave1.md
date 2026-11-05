# file-viewer 引入 · 计划 3（第一波：core + 10 组 Office/阅读/区域渲染器）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** npm 精确锁版引入 `@file-viewer/core` + 10 组渲染器（email/epub/ofd/chm/word+rtf/presentation/spreadsheet/iwork/hangul/wordperfect），经计划 2 的桥接契约装配为 vviewer 渲染器（扩展名转移原子完成），打通资产 CDN 直链与 SW 缓存、foreign 预算门禁、e2e 语料与渲染锚，补齐 NOTICES。

**Architecture:** 桥接层（计划 2 的 `@bhxch/vviewer-render-foreign`）以注入式 mount 承接 file-viewer 渲染器——装配点从各 `@file-viewer/renderer-*` 包按其 CLI catalog 的 `renderer-export` 形态取渲染器对象、动态 import（chunk 分离）；renderNested 回调经 vviewer dispatcher byExtension 承接附件；resolveSibling 走 store.read；资产经 VV_FOREIGN_ASSETS 三层链（同源→服务端→CDN 默认 jsdelivr `@file-viewer/assets-standard@3.3.3/viewer/`）+ SW CacheFirst。扩展名转移随包原子提交（registry 专有先注册铁律）。

**Tech Stack:** TypeScript / pnpm workspace / Svelte 5 装配层 / vitest / Playwright / CI --check 惯例。

**Spec:** `docs/superpowers/specs/2026-11-04-file-viewer-integration-design.md` §6.1-§6.5、§7（合规）。

## Global Constraints

- **版本精确锁定（用户拍板）**：全部 `@file-viewer/*` 依赖 package.json 写无 `^`/`~` 前缀的精确版本（3.3.3 系；capability 子包按其 npm 实际版本精确写）；lockfile 入库；后续升级=显式独立 commit。
- **版本白名单 CI 校验**：新增 `tools/check-foreign-deps.mjs --check`（校验 apps/web package.json 中 @file-viewer/* 声明无范围前缀且与 lockfile 一致），入 ci.yml 前端 job；仿 gen-code-extensions --check 惯例。
- 桥接渲染器一律 `streaming: false`（计划 2 契约）；512MB 级联既有防线与确认门不变。
- 零产物入库：file-viewer 的 Worker/WASM 资产不入 git、不进 dist、不进 precache（CDN 直链 + 运行时缓存）。
- NOTICES 逐包一行（许可/用途/里程碑=file-viewer 批 T<n>）；`renderer-word` 的 odt/odp 归属与 `capability-rtf` 的 rtf 归属按其 README 注记。
- 扩展名转移原子：新桥接渲染器 install 先于 codeRenderer（generated 补空位铁律）；`tsv` 自 code 内置清单移除与 spreadsheet 桥接注册同一 commit；`dot` 维持 graphviz（计划 1 裁决）、`pot` 归 presentation。
- e2e 语料：真实二进制不入库——tools/fetch-e2e-corpus.mjs 增源（file-viewer GitHub 仓库测试夹具，钉 commit），CI 前拉取；仓库内只有 manifest。
- 每任务原子 commit；中文 Conventional Commits。
- **e2e 延后统一验证（用户指令 2026-11-05）**：开发期各任务**编写** e2e spec 但**不运行**（不跑 build:e2e/playwright）；e2e 统一在计划 5 收口后的最终验证阶段一次跑齐（含全部回归）。单测/typecheck 门禁照旧每任务全跑。

## Review Focus

1. **版本漂移**：任何 `^`/`~` 前缀或 lockfile 与声明不一致 → CI 校验必须红——T1 测试锚。
2. **装配序回退**：桥接渲染器若晚于 codeRenderer 安装，docm/potx 等被 generated 占走 → RegistryError 白屏——沿用计划 1 源序锚形态扩展。
3. **扩展名转移原子性**：`tsv` 双注册/漏转移（code 清单未删）任一即 registry 冲突或语义错位——T2 锚。
4. **chunk 分离**：file-viewer 包静态 import 进主 chunk = 体积回归——T4 门禁锚。
5. **嵌套附件回调死循环**：eml 附件内嵌 eml 递归渲染无深度限——T2 锚（depth 上限 3，超限落下载）。

---

### Task 1: 依赖精确锁版引入 + 版本白名单 CI 校验 + NOTICES 11 行

**Files:**
- Modify: `apps/web/package.json`（dependencies 增 11 项精确版本：`@file-viewer/core@3.3.3`、`@file-viewer/renderer-email@3.3.3`、`renderer-epub`、`renderer-ofd`、`renderer-chm`、`renderer-word`、`renderer-presentation`、`renderer-spreadsheet`、`renderer-iwork`、`renderer-hangul`、`renderer-wordperfect` 各 3.3.3 + `@file-viewer/capability-rtf`（npm 实查精确版本））
- Create: `tools/check-foreign-deps.mjs`（--check 校验：@file-viewer/* 无范围前缀 + lockfile 版本一致；违规列明细 exit 1）
- Modify: `.github/workflows/ci.yml`（前端 job 增 `node tools/check-foreign-deps.mjs --check`）
- Modify: `THIRD_PARTY_NOTICES.md`（11 行：core/email/epub/ofd/chm/word/presentation/spreadsheet/iwork/hangul/wordperfect/capability-rtf——许可 Apache-2.0、doc 包相关 MIT 注记、用途与里程碑）
- Test: `tools/test/check-foreign-deps.test.mjs`（node --test 或 vitest，按 tools 既有惯例——rg tools/*/test）

- [ ] **Step 1: 失败测试**（校验脚本三锚：范围前缀检出、lockfile 不一致检出、合规通过）。
- [ ] **Step 2: 红** → **Step 3: package.json 11 项精确版本 + pnpm install --prefer-offline（registry 下载，如实发生）+ 校验脚本 + CI 接线 + NOTICES** → **Step 4: 绿**（脚本对现状 pass；手工临时加 ^ 验证 fail 后还原）+ `pnpm --filter web typecheck` 0E（e2e 本任务不涉） → **Step 5: Commit** `feat(web): file-viewer 第一波依赖精确锁版引入（11 包 3.3.3 系）+版本白名单 CI 校验+NOTICES`

### Task 2: file-viewer 渲染器 API 探针 + 桥接装配（10 组 28 扩展名）

**Files:**
- Modify: `packages/vviewer-render-foreign/src/bridge.ts`（render 桩实装：Uint8Array→File 物化、mount 调用、RenderedInstance destroy 对接、renderNested→装配注入回调、depth 限 3）
- Modify: `apps/web/src/lib/viewer.ts`（diagram 块后、codeRenderer 前插 10 组桥接渲染器 install；动态 import `() => import('@file-viewer/renderer-x')`）
- Modify: `packages/vviewer-render-text/src/code/index.ts`（移除 `'tsv'` 及行内转移注释）
- Test: `packages/vviewer-render-foreign/test/bridge.test.ts` 追加 + `apps/web/src/lib/*` 装配锚（沿计划 1 源序锚形态）

**Interfaces:**
- Consumes: 计划 2 `wrapFileViewerRenderer/DiagramFileRenderOpts`；计划 2 T1 carry-forward（render 桩校验替换、ForeignMountResult 填充）。
- Produces: 10 组桥接渲染器，扩展名绑定（依 spec §6.3 表）：email(eml,msg,mbox)、epub(epub,fb2,umd)、ofd(ofd)、chm(chm)、word(doc,docm,dotx,dotm,odt,odp,rtf)、presentation(ppt,pptm,potx,potm,ppsx,ppsm)、spreadsheet(xltx,xlsb,xlt,xla,xlam,xltm,ods,fods,dbf,tsv)、iwork(pages,numbers,key)、hangul(hwp,hwpx)、wordperfect(wpd,wp,wp5,wp6)。

- [ ] **Step 0（探针，产出进报告）**: 读 `node_modules/@file-viewer/core` 的 dist .d.ts 与 README——钉死三事：① 各 renderer-export 对象的挂载 API 实名与签名（mount/render 函数、参数、返回与销毁）；② 资产 base URL 的传递形态（options 字段名）；③ `renderNestedBuffer` 宿主回调的实参形状（contracts types.ts:971 附近）。探针结论落 `task-2-report.md`「API 探针」节，后续任务按此接线；探针发现与 brief 假设冲突处停下报告 NEEDS_CONTEXT。
- [ ] **Step 1: 失败测试**：wrapFileViewerRenderer render 实装锚（mock mount：File 物化字节等值、signal 贯穿、destroy 对接、renderNested depth 3 上限）；装配锚（fresh registry 按 viewer.ts 序 install 零冲突 + byExtension 28 项逐字 + tsv→桥接 spreadsheet 桥 + 源序：桥接块先于 codeRenderer）。
- [ ] **Step 2: 红** → **Step 3: 实装**（bridge render 实装 + viewer.ts 装配 + tsv 移除同 commit）→ **Step 4: 绿**（foreign 包 + render-text 包 + web lib 全量；根 typecheck 0E）→ **Step 5: Commit** `feat(web): file-viewer 第一波桥接装配——10 组 28 扩展名+tsv 转移+嵌套附件回调（spec §6.3）`

### Task 3: 资产解析链（VV_FOREIGN_ASSETS 三层链 + SW CacheFirst）

**Files:**
- Create: `apps/web/src/lib/foreignAssets.ts` + `foreignAssets.test.ts`（resolveForeignAssetBase()：env VV_FOREIGN_ASSETS → 缺省 jsdelivr `https://cdn.jsdelivr.net/npm/@file-viewer/assets-standard@3.3.3/viewer/`；同源/服务端位预留空位——grammars 三层链先例形态）
- Modify: `apps/web/src/lib/viewer.ts`（mount args.assetBaseUrl 接 resolveForeignAssetBase）
- Modify: `apps/web/src/sw.ts`（或 vv-sw 生成面——rg 'runtimeCaching' apps/web；增 foreign assets 前缀 CacheFirst 规则）+ `apps/web/vv-sw-cleanup.js` 同步（BUG-60 不变量）
- Test: `apps/web/src/lib/foreignAssets.test.ts` + SW 既有测试面（rg 'check-pwa-build' tools——若断言 SW 注册清单需同步）

- [ ] **Step 1: 失败测试**（base 解析三态：env 显式/缺省 jsdelivr/尾斜杠归一；SW 规则注册面源码锚）→ **Step 2: 红** → **Step 3: 实装** → **Step 4: 绿 + `pnpm --filter web build:e2e` 后 SW 构建断言绿** → **Step 5: Commit** `feat(web): foreign 资产三层解析链+SW CacheFirst（spec §6.2）`

### Task 4: foreign 预算门禁

**Files:**
- Create: `tools/foreign-budget.mjs`（扫 apps/web/build 产物：主 chunk 与 precache 清单断言不含 `@file-viewer` 代码面（动态 import chunk 名单除外——chunk 文件允许存在于 dist，仅断言「非主 chunk」与「不在 precache 清单」）；dist 无 file-viewer 资产目录）
- Modify: `.github/workflows/ci.yml`（web job 增 `node tools/foreign-budget.mjs --check`，置于 build 之后）
- Test: `tools/test/foreign-budget.test.mjs`（三锚：主 chunk 混入检出、precache 混入检出、合规通过——用临时夹具目录）

- [ ] **Step 1: 失败测试** → **Step 2: 红** → **Step 3: 实装 + CI 接线** → **Step 4: 绿**（对真实 build 产物跑 pass）→ **Step 5: Commit** `feat(ci): foreign 预算门禁——主 chunk/precache 断言（spec §6.2）`

### Task 5: e2e 语料源 + SAVE-FOREIGN 域渲染锚

**Files:**
- Modify: `tools/fetch-e2e-corpus.mjs`（SOURCES 增 `file-viewer-fixtures`：github flyfish-dev/file-viewer 钉 v3.3.3 tag，精选每格式 1-2 个小体量夹具——doc/ppt/xlsx 系用其 test fixtures 中真实文件；manifest 增源）
- Create: `apps/web/e2e/b-foreign-office.spec.ts`（desktop only：每格式组至少一渲染锚〔doc/odt/rtf/eml/epub/chm/hwp/dbf/pages…按夹具可得性〕+ open-as 双向切换锚〔file-viewer↔vviewer 渲染器〕+ 错误文件错误卡锚 + tsv 转移锚）
- Test: e2e

- [ ] **Step 1: 语料源接入**（本地跑 fetch 脚本验证夹具落地 + manifest）→ **Step 2: e2e 编写**（复用 b-save-as/b-diagram-file 的 openFlow helper 与 picker 桩先例；file-viewer 渲染可能慢——首屏锚时限按 foreign 懒加载形态放宽并注记）→ **Step 3: 编写完成即止（不 build:e2e 不跑 playwright——最终统一验证阶段执行）** → **Step 4: 门禁**（根 vitest/双 typecheck/porcelain）→ **Step 5: Commit** `test(e2e): SAVE-FOREIGN 域锚——第一波 10 组渲染/open-as 切换/错误卡/tsv 转移`

### Task 6: 覆盖矩阵增量回写 + 收口

**Files:**
- Modify: `docs/file-viewer/format-package-survey-2026-11-04.md`（§3 表对应行状态更新：email/epub/fb2/umd/ofd/chm/word 系/presentation 系/spreadsheet 系/iwork/hangul/wordperfect → ✅（file-viewer 桥接）；§3.1 统计数字更新；§4.2 清单勾销第一波项）
- Modify: `README.md` 格式能力节（如第一波格式需入 README——rg 格式清单落点，最小增量）

- [ ] **Step 1: 回写**（基于实测 byExtension 面，不凭记忆）→ **Step 2: Commit** `docs(survey): 覆盖矩阵第一波回写——10 组管线转 ✅（file-viewer 桥接）`

### 收口

- [ ] 全量门禁：根 `pnpm vitest run` exit0；`pnpm --filter web typecheck` 0E；根 `pnpm typecheck` 0E；`node tools/check-foreign-deps.mjs --check` 绿；`node tools/foreign-budget.mjs --check` 绿；porcelain 净空。（e2e 全量回归移交最终统一验证阶段）
