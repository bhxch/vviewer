# e2e 富化第三轮 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 补齐两轮 e2e 报告缺口余量——文件树源级移除全链（FTSRC）、QuickOpen 多源扫描（QO）+ BUG-31 Ctrl+P 切换修复转正、TAX duplicate 两交叉锚（TAX-12/13），并落「源级折叠不存在」勘误注记。

**Architecture:** 唯一产品改动是 BUG-31：AppShell 全局键位 handler 的 inField 提前 return 吞掉 Ctrl+P toggle（面板输入框自动聚焦导致 toggle 不可达）——Ctrl+P 组合键在 inField 分支内例外放行。其余为纯 e2e 增量：FTSRC 用 `.vv-tree-src-remove` 按钮 + dialog 事件处理 confirm；QO 多源沿 WSX-08 的 startWsxFakeServer 双根装置 + 本地注入源并存；TAX 沿 b-tab-actions-enrichment 既有装置。

**Tech Stack:** Playwright e2e（chromium+mobile 双 project）+ Svelte 5（AppShell 一处产品改动）。

**Spec:** docs/superpowers/specs/2026-10-16-e2e-enrichment-round3-design.md

## Global Constraints

- 文中行号为实施起点 HEAD（0a24f56 一带）参考，以符号定位为准；装置/helper 以现文逐字对齐。
- e2e 伺服 apps/web/build：产品改动（BUG-31）合入后必须重建（`VV_GRAMMAR_CDN=https://cdn.grammars.test/grammars/ pnpm --filter web build`）再跑。
- 每任务原子提交，Angular 规范、先 why 后 what。
- BUG-31 铁律：inField 提前 return 的既有语义对非 Ctrl+P 按键原样保留（j/k/gg/G、单键面在输入框内不接管）；仅 Ctrl/Cmd+P 组合键例外放行。
- TAX-12 铁律：按实现现状锚定（duplicate 对目录 tab 的现行语义——支持复制锚复制结果；不提供/禁用锚「动作不可达或 null」），不预设产品改动。
- 既有用例零翻转：SHELL-11（单源 Ctrl+P）、WSX-07/08（源标签计数）、TAX-01..11。

---

### Task 1: QO-05 BUG-31 修复 + fixme 转正

**Files:**
- Modify: `apps/web/src/lib/AppShell.svelte`（$effect 内 onKey 的 inField 分支，约 :408-416）
- Modify: `apps/web/e2e/t-shell.spec.ts`（BUG-31 fixme 转正，约 :577）

**Interfaces:** 无新增导出；快捷键行为变更一处。

- [ ] **Step 1: 写失败测试（fixme 转正为正式断言——现状红）**

t-shell BUG-31 `test.fixme(` → `test(`，长注释压缩为 3-4 行背景（缺陷号/inField 吞 toggle 根因/修复机制），断言体：

```ts
  test.setTimeout(60_000);
  await page.goto('/');
  await openDir(page, [{ name: 'bug31.ts', type: 'text/plain', content: 'export const a = 1;\n' }]);
  // 第一按：打开面板（输入框自动聚焦）
  await page.keyboard.press('Control+p');
  const panel = page.locator('.vv-quickopen');
  await expect(panel).toBeVisible();
  // 第二按：面板已开（输入焦点）→ toggle 关闭且 preventDefault（现状：inField 吞掉，面板不关）
  await page.keyboard.press('Control+p');
  await expect(panel, 'BUG-31：面板已开再按 Ctrl+P 应关闭').toBeHidden();
```

（`openDir` 为 t-shell 既有装置——实施时以该文件现文对齐；若 t-shell 无页内注入装置则沿 b-worker-init-probe 的 `__vvOpenDirImpl` 手法内联。断言可加第三按重开（toggle 双向），沿 fixme 证据口径 s5_panelReopened。）

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter web exec playwright test t-shell -g "BUG-31"`
Expected: FAIL（面板不关闭）。

- [ ] **Step 3: 实现**

AppShell.svelte 的 inField 分支（`if (inField) return;`）改为：

```ts
      if (inField) {
        // BUG-31：快速打开面板输入框自动聚焦，本分支提前 return 会吞掉 Ctrl+P
        // toggle（面板已开时再按不关闭、不 preventDefault → 真实浏览器触发打印）。
        // 组合键例外放行：Ctrl/Cmd+P 恒走 toggle（VSCode 同惯例）；其余按键维持
        // inField 不接管语义（j/k/gg/G、单键面）。
        if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'p') {
          e.preventDefault();
          quickOpenOpen = !quickOpenOpen;
        }
        return;
      }
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter web exec playwright test t-shell -g "BUG-31"`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add apps/web/src/lib/AppShell.svelte apps/web/e2e/t-shell.spec.ts
git commit -m "fix(web): Ctrl+P 在输入焦点下例外放行 toggle——BUG-31

why：快速打开面板输入框自动聚焦，AppShell inField 提前 return 吞掉
Ctrl+P toggle（面板已开再按不关闭不 preventDefault，真实浏览器触发
打印对话框；BUG-31，low）。
what：inField 分支内 Ctrl/Cmd+P 组合键例外放行（恒走 toggle +
preventDefault，VSCode 同惯例）；其余按键 inField 语义原样。fixme 转正。"
```

---

### Task 2: QO-01..04 QuickOpen 多源 e2e

**Files:**
- Create: `apps/web/e2e/b-quickopen-multisource.spec.ts`

**Interfaces:** 沿 WSX-08 装置（`startWsxFakeServer`/`waitAppMounted`/`connectForm`，自 b-wsx-recovery.spec.ts 或其共享 helper 导入——以现文为准）；本地源沿 `__vvOpenDirImpl` 注入。

- [ ] **Step 1: 写用例**

场景（编号 QO-01..04，域文档注记在用例头）：

```ts
// QO-01 双源扫描拼接：本地注入源（2 文件）+ remote fake server 根（1 文件）并存后
//   Ctrl+P → 不输入过滤词 → 结果行同时含两源文件，行文本含「源名 / path」前缀形态
//   （对照 QuickOpenPanel.svelte:166 的 {labelOf(f.storeId)} / {f.path} 渲染）；
//   按源序断言（workspace.sources 顺序 = 本地在先或 remote 在先，以 AppShell sources
//   合成序为准——实施时以实际序锚定，注释写明）。
// QO-02 按 storeId 打开：过滤词命中 remote 源文件 → Enter → 打开的 tab 数据落 remote
//   store（断言：文件内容为 fake server 的 body；或 tab label 正确 + 内容可见）。
// QO-03 跨源排除规则：连接前 settings 写入 excludedPatterns（localStorage
//   'vviewer:settings'，沿 t-shell BUG-27 注释的手法）命中两源同名文件 → Ctrl+P
//   结果两源均无该文件、其余文件在。
// QO-04 空来源态：仅本地源注入 0 文件目录（或 remote 根空）→ Ctrl+P 面板空态提示
//   不报错（断言面板可见 + 无结果行 + 无错误态）。
```

（四个 test 的实体代码实施时以 WSX-08 装置逐字组装；每用例 30s 超时；双 project 天然覆盖。maxFiles=5000 上限由单测承载，e2e 不重复布点——spec §2 既有裁决。）

- [ ] **Step 2: 验证**

Run: `pnpm --filter web exec playwright test b-quickopen-multisource`
Expected: 4 用例 ×2 project 全绿。

- [ ] **Step 3: 提交**

```bash
git add apps/web/e2e/b-quickopen-multisource.spec.ts
git commit -m "test(e2e): QuickOpen 多源扫描补齐——QO-01..04

why：多源=workspace 多根来源扫描，单测已全钉（quickOpen.test.ts 双源拼接/
跨源排除/maxFiles/空来源）而 e2e 仅单源一条（SHELL-11）；2026-10-13 报告
WSX 缺口「多源扩域无 e2e」。
what：本地注入源 + remote fake server 根并存的双源 e2e——拼接与源名前缀/
按 storeId 打开落对来源/跨源排除规则/空来源态四场景。"
```

---

### Task 3: FTSRC-01..04 文件树源级移除全链 e2e

**Files:**
- Create: `apps/web/e2e/b-filetree-src-remove.spec.ts`

**Interfaces:** 源标签行 `.vv-tree-src` + `.vv-tree-src-remove`（FileTree.svelte:61-69）；confirm 为原生 `window.confirm`（Playwright `page.on('dialog')` 处理）；`onremove` → AppShell removeSource（关该组内该源全部 tab + workspaceStore.removeSource）。

- [ ] **Step 1: 写用例**

```ts
// FTSRC-01 confirm 接受：双源（本地注入 + remote fake 根）各开 1 个 tab → 点 remote
//   源标签行 ✕ → page.on('dialog') accept（文案含「将关闭该来源下全部 tab」）→
//   断言：remote 源 tab 关闭（.vv-tab 计数减一且无该文件 tab）、.vv-tree-src 该源标签
//   消失、本地源 tab 与标签保留。
// FTSRC-02 confirm 取消：同上点 ✕ → dialog dismiss → 断言 tab 与源标签均不动。
// FTSRC-03 同组他源保留：FTSRC-01 的断言细化（本地源 .vv-tree-src-label 文本不变 +
//   其 tab active 态不受影响）。
// FTSRC-04 跨组共享 storeId：harness 可达性裁决点——若 UI 可达（同 store 挂两组），
//   锚「移除 A 组内该源，B 组不动」；不可达则降级为单组断言 + 用例内注释引用
//   AppShell「移除是组内操作」语义注释（spec §2 预授权的降级路径）。
```

（confirm 文案断言可选：`dialog.message()` 含「移除来源」字样，增强锚定。）

- [ ] **Step 2: 验证**

Run: `pnpm --filter web exec playwright test b-filetree-src-remove`
Expected: 3-4 用例 ×2 project 全绿。

- [ ] **Step 3: 提交**

```bash
git add apps/web/e2e/b-filetree-src-remove.spec.ts
git commit -m "test(e2e): 文件树源级移除全链——FTSRC-01..04

why：源级移除（confirm→该源 tab 全关→组内移除语义）是文件树唯一源级
操作且 e2e 零覆盖（.vv-tree-src-remove 全仓零命中）；2026-10-13 报告
缺口清单余量。
what：confirm 接受/取消两分支 + 同组他源保留 + 跨组共享 storeId（可达性
裁决，不可达降级单组断言+注释）。"
```

---

### Task 4: TAX-12/13 duplicate 两交叉锚

**Files:**
- Modify: `apps/web/e2e/b-tab-actions-enrichment.spec.ts`（末尾追加两用例）

**Interfaces:** `openFlow.svelte.ts duplicate(tabId)`（:328——`unrestorable → null`；非活动组 → null；复制 pinned 与 overrideRenderer 并插入原 tab 右侧）；右键菜单 TabContextMenu 的「复制」动作（沿 TAX-05 的操作手法）。

- [ ] **Step 1: 写用例**

```ts
// TAX-12 duplicate×目录 tab（按实现现状锚定）：开目录 tab（pinned 形态沿既有装置）
//   → 右键「复制」→ 断言现行语义（目录 tab 的 source 形态下 duplicate 的实际行为：
//   若产生副本——锚副本存在且紧邻原 tab；若 null 拒绝——锚「无新 tab 产生 + 原表
//   不变」。实施前先读 duplicate 对目录 tab 的 unrestorable 判定定锚，注释写明依据）。
// TAX-13 duplicate×overrideRenderer：文件 tab 手选「以 hex 打开」（override 置位，
//   沿 OPEN-03/既有 override 装置手法）→ 右键复制 → 断言副本 tab 的 overrideRenderer
//   继承（副本内容渲染为 hex 形态——.vv-hex 容器在场；或经 getMeta/调试字段锚），
//   且副本落原 tab 右侧（TAX-05 既有归位断言同款）。
```

- [ ] **Step 2: 验证**

Run: `pnpm --filter web exec playwright test b-tab-actions-enrichment`
Expected: 全绿（TAX-01..13；既有 11 条零翻转）。

- [ ] **Step 3: 提交**

```bash
git add apps/web/e2e/b-tab-actions-enrichment.spec.ts
git commit -m "test(e2e): TAX-12/13 duplicate 交叉锚——目录 tab 与 overrideRenderer

why：pinned×拖拽/撤销等交叉已布点（TAX-03/05/10），2026-10-13 报告余量仅
duplicate×目录 tab 与 duplicate×overrideRenderer 两个组合面。
what：TAX-12 按实现现状锚定（unrestorable 判定定锚，不预设产品改动）；
TAX-13 锚 overrideRenderer 继承与归位（duplicate 现行实现直读）。"
```

---

### Task 5: 域文档勘误 + 收口门禁

**Files:**
- Modify: `docs/e2e/workspace-enrichment.md`（源级折叠不存在勘误注记）
- Modify: `docs/e2e/`（若 QO/FTSRC 域文档按惯例需建——两份新 spec 的域文档各一份简版，沿既有域文档结构精简：场景清单表 + 装置说明）

**Interfaces:** 无。

- [ ] **Step 1: 文档**

workspace-enrichment.md 末尾追加：

```markdown
## 勘误（2026-10-16）

2026-10-13 报告所称「源级折叠」在 UI 中不存在（文件树仅目录级展开/折叠，无源级
折叠实现）——非待补面，系报告措辞失实（e2e 富化第三轮 spec §3 既有记录）。
```

两份新域文档（quickopen-multisource.md / filetree-src-remove.md）按既有域文档精简结构落地（场景表 + 装置），各 60-100 行。

- [ ] **Step 2: 门禁**

Run（分立命令）: `pnpm vitest run` → `pnpm typecheck` → `VV_GRAMMAR_CDN=... pnpm --filter web build` → `pnpm --filter web exec playwright test`
Expected: 全绿（vitest exit 0 / typecheck 0E / playwright 0f——m3-search 计时型既有 flake 口径除外）。

- [ ] **Step 3: 收口提交**

```bash
git add docs/e2e/
git commit -m "docs(e2e): 富化第三轮域文档两份 + workspace 源级折叠勘误

why：场景文档随代码同批（域文档惯例）；「源级折叠不存在」须落纸面
（报告措辞失实的可发现性）。
what：quickopen-multisource/filetree-src-remove 两份域文档 + 勘误注记。"
```
