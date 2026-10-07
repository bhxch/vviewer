# M7 PWA 与打磨 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** PWA（可安装 + 应用壳预缓存 + grammar wasm 运行时缓存）；UI markdown 接入远程 comrak 引擎（M6 遗留第一批）；hljs 主题近似映射器（Q11 M7 项，简化版）；移动视口 E2E 冒烟；主 README 与全量 E2E 收官。

**Architecture:** PWA 用 vite-plugin-pwa（workbox，MIT）：globPatterns 覆盖应用壳 + manifest；grammar wasm 与 queries 走 runtimeCaching（CacheFirst，M2 资产已内容哈希化/静态路径稳定）。markdown 引擎选择经 ComputeRouter（remote comrak / local markdown-it）。

**Tech Stack:** vite-plugin-pwa、workbox；无其他新依赖。

**Spec:** `docs/superpowers/specs/2026-10-06-vviewer-design.md`（5.11 性能预算 / 决策 Q14 PWA / Q11 映射器 / M7 里程碑行）

## Global Constraints

- 沿用全局约束；SW 注册仅 production build（dev 不注册）。
- PWA 不缓存 /api/*（网络优先不缓存）；grammar/queries 资产 CacheFirst（内容稳定）；应用壳 precache + 自动更新（registerType autoUpdate）。
- M7 验收：build 产出 SW + manifest；Lighthouse 式断言不做，E2E 断言 SW 注册成功 + 二次加载离线壳可用（可选简化为 SW active 断言）；移动视口（375×667，Pixel 7 描述档）E2E 冒烟通过；全量 E2E（m1-m7）连续 2 次全绿；主 README 完成。

---

### Task 1: PWA 接入

**Files:** Modify `apps/web/{package.json,vite.config.ts}`、`src/routes/+layout.svelte`（SW 注册由插件注入，补 manifest 图标引用）；Create `apps/web/static/icons/`（192/512 png，脚本生成纯色+字 logo）；Create `apps/web/e2e/m7.spec.ts`（SW 断言部分）
**Interfaces:** vite-plugin-pwa 配置：registerType autoUpdate、manifest（name vviewer、theme_color var 不支持→写死亮色值+暗色 meta、icons 192/512）、workbox globPatterns（js/css/html/woff2）、runtimeCaching：`urlPattern /grammars/.*\.wasm`、`/queries/.*` CacheFirst（maxEntries 300）；devOptions 关闭。**裁决：离线打开本地文件场景不做**（纯壳缓存即可，spec 的"应用壳离线"满足），报告说明。
**Steps:** 配置 → build 产物断言（dist/sw.js、manifest.webmanifest、precache 数量>10）→ E2E：注册成功 + caches 包含 precache → Commit `feat(web): PWA（manifest/SW/资产缓存策略）`

### Task 2: UI markdown 接远程引擎（M6 遗留第一批）

**Files:** Modify `packages/render-text/src/markdown/markdownRenderer.ts`（引擎入口参数化：`setMarkdownEngine(fn)` 或 context 扩展——**裁决：沿用 highlightFence 模式，markdownRenderer 增加 `setMarkdownBackend(fn: ((src: string) => Promise<string>) | null)` 模块级注入，apps/web viewer.ts 接 ComputeRouter.routeMarkdown**——remote 返回 comrak HTML 仍走 sanitize+enrich+pipeline 全管线）；E2E 断言扩展 m6（remote 策略下 markdown tab 的执行位置指示显示远程——markdownRenderer 需暴露当前引擎，类比 getEngine）
**Interfaces:** remote 引擎失败（网络/comrak 413）→ 回退 local markdown-it（auto 语义，与 highlight 一致）；remote 显式 → 错误卡片。执行位置指示接入状态栏（复用 M6 模式）。
**Steps:** 失败测试（引擎注入 mock：remote 返回不同标记 HTML 时管线仍净化处理；失败回退 local）→ 实现 → E2E 扩展 → Commit `feat(web): markdown 远程引擎接入（comrak 卸载）`

### Task 3: hljs 主题近似映射器（简化版）

**Files:** Modify `apps/web/src/lib/theme.ts`（applyCodeTheme 时同步生成 hljs 类覆盖：当前 helix 主题的 keyword/string/comment/number/function 色 → `--hljs-keyword` 等 9 个变量，继承既有 CSS 变量名——M1 的 hljs 双主题变量与 helix 变量并存，映射器输出覆盖 `--hljs-*`）；Test `theme.test.ts` 扩展
**Interfaces:** 映射规则（注释声明近似）：`keyword→--hljs-keyword`、`string→--hljs-string`、`comment→--hljs-comment`、`constant.numeric→--hljs-number`、`function→--hljs-title`、`type→--hljs-type`、`variable→--hljs-variable`、`tag→--hljs-tag`、`attribute→--hljs-attr`——各取 resolveCapture 结果的 fg；未命中保持现值。**行为**：hljs 兜底路径的着色跟随当前代码主题（近似），Q11 的"独立双主题"升级为"近似跟随"。
**Steps:** 失败测试（applyCodeTheme 后 --hljs-keyword 等被更新为主题色）→ 实现 → Commit `feat(web): hljs 兜底主题近似跟随代码主题`

### Task 4: 移动视口 E2E + 全量收官

**Files:** Create `apps/web/e2e/mobile.spec.ts`; Modify `playwright.config.ts`（projects 加 mobile：375×667 + hasTouch + Pixel 7 UA）
**Interfaces:** 冒烟断言：抽屉开合（drawer-toggle 按钮）、文件夹打开→树→打开 md→渲染、触摸滚动（touchscreen 简单滑动断言 scrollTop 变化）、视频播放页不崩、主题切换。全量 m1-m7 连续 2 次全绿（chromium + mobile 两 project）。
**Steps:** 配置 → 冒烟 → 全绿 → Commit `test(web): 移动视口 E2E 冒烟`

### Task 5: 主 README 与收官

**Files:** Create `README.md`（项目定位/两版本形态/功能矩阵/快速开始：纯前端 pnpm build 静态托管 + 后端 vviewer serve/架构图引 spec/ license 汇总）；Modify `docs/deploy.md`（RustEmbed 评估结论：**裁决不做**，--web-dist 模式已满足单二进制分发（附带 dist 目录），内嵌收益（真单文件）vs 复杂度（构建顺序耦合）记录 ADR 段落）
**Steps:** README → 全量验证（vitest+cargo+E2E 双 project 连续 2 次）→ Commit `docs: 主 README 与部署收官`

## Self-Review 记录

- Spec 覆盖：Q14 PWA（T1）、M6 遗留 markdown 引擎接线（T2）、Q11 映射器简化版（T3）、M7 验收含移动视口（T4）、文档（T5）；RustEmbed 裁决不做（T5 记录 ADR）。
- 已声明裁剪：hljs 映射器为简化版 9 类近似（spec Q11 的 M7 项本就是"打磨项"）；离线打开本地文件不做。
- 大文件调参与编码矩阵：M2/M4 已实测校准（阈值 2MB、编码表 Rust/TS 对齐），不再单列任务。
