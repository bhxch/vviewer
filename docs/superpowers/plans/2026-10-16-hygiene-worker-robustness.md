# 卫生与 worker 健壮性批 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 清偿 SDD ledger 余量 11 条 minor/nit（H1-H12）+ 修复 BUG-35 看门狗误杀健康 worker（W1）+ 建立 worker init 挂起的 CI 取证通道（W2）。

**Architecture:** W1 在 worker init 成功完成处回一帧 `{kind:'init-ok'}`（无论 debug 开关），HighlightClient 的 onmessage 现行「非 progress 帧先 markWorkerAlive」路径天然消化（ack 无 id，pending 落空 return）——看门狗语义变为「init 完成 ack 前静默 15s 才杀」，静置页面不再误杀，真挂起（无 ack）照样 15s 触发。W2 新增一条带 `?vvWorkerDebug=1` 的专用 e2e，用例内挂 console 收集器，失败时 `testInfo.attach` 阶段帧（不依赖 trace 收录 debug 级 console）。H 系列各自一至数行的精准修改。

**Tech Stack:** TypeScript（highlight/render-text/web/e2e）+ Rust（server/src/compute/queries.rs）+ GitHub Actions YAML + vitest/cargo/Playwright。

**Spec:** docs/superpowers/specs/2026-10-16-hygiene-worker-robustness-design.md

## Global Constraints

- 文中行号为实施起点 HEAD 参考（bf87291 一带），以符号定位为准；改动前先读目标代码确认现文。
- vitest 仓库根跑；cargo 用 `cargo test`（server 目录，全量——lib 单测编译错只有全量才抓得到，既有教训）。
- 每任务原子提交，Angular 规范、先 why 后 what。
- BUG-35 铁律：init-ok ack 无论 debug 开关恒发（这是修复本体非探针）；init-progress 进度帧**不计存活**的既有语义与测试锚（client.test.ts）不动；init 失败路径（console.error + postError）不动。
- PERF-LAZY 铁律：只加裕量，断言口径（预算比较式）不变；CI×4 的既有倍率机制不动。
- H10 铁律：ENTRIES 层既有逐文件预校验（highlights 失败剔语言、injections/locals 置空保底）不动；只改 CONFIGS 构建段的合并失败处置。
- 涉及生成物/产物的文件（apps/web/build、static/grammars 等）不入库。

---

### Task 1: W1 BUG-35 修复——init-ok ack 置活

**Files:**
- Modify: `packages/highlight/src/types.ts`（HighlightResponse 附近新增 InitOkFrame 接口；serveWorker 的 postMessage 形参联合类型同步）
- Modify: `packages/highlight/src/worker.ts`（initWorker resolve 后回 ack，先于排空队列）
- Modify: `packages/highlight/test/client.test.ts`（新增 ack 置活用例）
- Modify: `apps/web/e2e/t-hl.spec.ts`（BUG-35 fixme 转正，约 :515）

**Interfaces:**
- Consumes: client.ts 现行 onmessage（:50-71）——`kind === 'init-progress'` 早退分流后 `this.markWorkerAlive()`，`pending.get(res.id)` 落空 return；**client.ts 零改动即修复**（本任务验证此点，若实现中发现必须改 client，停下来报 NEEDS_CONTEXT）。
- Produces: 协议新帧 `{ kind: 'init-ok' }`（无 id 字段）；看门狗仅杀「15s 无任何回包（含 ack）」的 worker。

- [ ] **Step 1: 写失败测试（client.test.ts）**

先读 client.test.ts 的既有看门狗用例（rg "INIT_TIMEOUT|看门狗|watchdog" 定位）与 fake worker 桩形态。新增用例（沿既有桩形态）：

```ts
it('init-ok ack 置活：init 完成回 ack 后看门狗解除，静置超窗不再误杀（BUG-35）', async () => {
  // 沿既有看门狗用例的 fake Worker 桩与 fake timers 形态：
  // 1) 构造 client（不发任何 highlight 请求）；
  // 2) worker 侧按真实时序回 ack：postMessage({ kind: 'init-ok' })（经 client.onmessage）；
  // 3) 推进时钟越过 INIT_TIMEOUT_MS；
  // 4) 断言：onWorkerError 未被调、initFailed 未置位——此后 highlight() 正常发起
  //    （fake worker 回合法响应即 resolve）。
});
```

（测试体必须落成可运行代码——以既有看门狗用例为模板逐字改写其arrange/act，上述 4 步是其骨架；若既有用例用 `vi.useFakeTimers()`，本用例同款。）

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run packages/highlight/test/client.test.ts`
Expected: 新用例 FAIL（现状 init 成功零回包，越过 15s 后 onWorkerError 被调）；既有用例零翻转。

- [ ] **Step 3: 实现**

types.ts（HighlightResponse 之后）：

```ts
/** init 完成回执（BUG-35）：无 id 帧——client onmessage 现行路径 markWorkerAlive 后
 * pending 落空 return。无论 debug 开关恒发（修复本体非探针）。 */
export interface InitOkFrame {
  kind: 'init-ok';
}
```

worker.ts 的 `serveWorker` postMessage 形参类型（:65 一带 `HighlightResponse | InitProgressFrame`）追加 `| InitOkFrame`（import 同步）；init 分支的 `initWorker(...)` 成功回调改为：

```ts
        .then((h) => {
          // BUG-35：init 成功回 ack（无论 debug 开关）——client onmessage 现行路径
          // markWorkerAlive 解除看门狗；「静置 >15s 再开文件」不再被误杀降级 hljs。
          // 真挂起（init 永不 resolve → 无 ack）仍由看门狗 15s 收口，语义不变。
          ctx.postMessage({ kind: 'init-ok' } satisfies InitOkFrame);
          for (const req of queued.splice(0)) void dispatch(req, h);
          return h;
        })
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run packages/highlight/test/`
Expected: 全 PASS（client.test.ts 新用例转绿；「进度帧不计存活」等既有锚零翻转）

- [ ] **Step 5: t-hl fixme 转正**

`t-hl.spec.ts` BUG-35 `test.fixme(` → `test(`，标题保留 BUG-35 编号；长复现注释压缩为 4-6 行背景（缺陷号/根因/init-ok ack 修复机制/影响面一句——原注释的勘误史与证据路径段删除，缺陷库指针保留）；断言体（`test.setTimeout(120_000)` 起）原样保留。同文件其余 fixme 不动。

- [ ] **Step 6: 提交**

```bash
git add packages/highlight/src/types.ts packages/highlight/src/worker.ts packages/highlight/test/client.test.ts apps/web/e2e/t-hl.spec.ts
git commit -m "fix(highlight): worker init 成功回 init-ok ack 置活看门狗——BUG-35

why：init 成功路径零回包，页面静置 >15s 再开文件被 15s 看门狗误杀健康
worker → 全会话静默降级 hljs + 误导性 console.error（BUG-35，medium）。
what：initWorker resolve 后恒发 {kind:'init-ok'}（无论 debug），client onmessage
现行 markWorkerAlive 路径天然消化（无 id 帧 pending 落空）——client 零改动；
进度帧不计存活语义不变，真挂起仍 15s 收口；t-hl fixme 转正。"
```

---

### Task 2: W2 CI 探针蹲守 e2e

**Files:**
- Create: `apps/web/e2e/b-worker-init-probe.spec.ts`

**Interfaces:**
- Consumes: `?vvWorkerDebug=1` 探针（highlightClient.ts init 配置）；状态栏引擎指示（`.vv-statusbar`「高亮: tree-sitter」）；Task 1 的 init-ok 帧（探针帧之外的首个回包）。
- Produces: 挂起取证通道——挂起 → 用例超时红 → artifact 含阶段帧 attach。

- [ ] **Step 1: 写用例**

```ts
import { expect, test, type Page } from '@playwright/test';

/**
 * worker init 挂起取证蹲守（spec 2026-10-16 卫生与 worker 健壮性 W2）：
 * 环境级 Parser.init 挂起（2026-10-09 立项）至今无 CI 证据通道——探针帧仅
 * console.debug 且无任何 e2e 带参，trace 又仅失败上传。本用例带 ?vvWorkerDebug=1
 * 导航，console 收集器全程记录 [vviewer-worker] 阶段帧，失败时 testInfo.attach
 * 全量（不依赖 trace 对 debug 级 console 的收录）；挂起 → init ready 断言超时红
 * → artifact 留帧（停在 wasm-fetch 还是 parser-init 一目了然）。
 */

test('worker init 探针蹲守：debug 带参导航下 tree-sitter 初始化完成', async ({ page }, testInfo) => {
  test.setTimeout(60_000);
  const frames: string[] = [];
  page.on('console', (msg) => {
    const text = msg.text();
    if (text.includes('[vviewer-worker]')) frames.push(`[${new Date().toISOString()}] ${text}`);
  });
  await page.goto('/?vvWorkerDebug=1');
  // 打开一个会触发 tree-sitter 高亮的本地文件（沿同目录既有 spec 的注入装置形态；
  // 实施时对照 t-media 的 openDir/openFile 或本目录共享 helper 逐字对齐——构造 .ts
  // 文件并打开）
  // 断言 init ready：状态栏出现「高亮: tree-sitter」；失败路径先 attach 阶段帧再上抛
  try {
    await expect(page.locator('.vv-statusbar')).toContainText('高亮: tree-sitter', { timeout: 45_000 });
  } catch (err) {
    await testInfo.attach('worker-init-frames.txt', { body: frames.join('\n') || '(无探针帧)' });
    throw err;
  }
});
```

（注释中「实施时对照」段落指向注入装置的具体形态选择；attach 已以 try/catch 形态保证失败路径真实发生。）

- [ ] **Step 2: 验证**

Run: `pnpm --filter web exec playwright test b-worker-init-probe`
Expected: PASS（本机未复现挂起；用例绿即通道就绪）

- [ ] **Step 3: 提交**

```bash
git add apps/web/e2e/b-worker-init-probe.spec.ts
git commit -m "test(e2e): worker init 探针蹲守用例——?vvWorkerDebug=1 取证通道

why：环境级 Parser.init 挂起（2026-10-09 立项）的「待 CI 取证」原机制不成立
（探针仅 console.debug、无 e2e 带参、trace 仅失败上传且无帧）。
what：带参导航 + console 收集器 + 失败 testInfo.attach 阶段帧；挂起→超时红
→artifact 留帧定位停驻阶段；CI 绿满 10 轮后提请未复现关闭裁决。"
```

---

### Task 3: 前端/测试卫生批（H2/H3/H4/H5/H9）

**Files:**
- Modify: `apps/web/tsconfig.e2e.json`（include 追加 e2e-server）
- Modify: `apps/web/src/app.d.ts`（ImportMetaEnv）
- Modify: `apps/web/src/lib/highlightClient.ts`（cast 收敛，约 :246）
- Modify: `packages/highlight/test/local-grammars.test.ts`（:53-56 断言钉死）
- Modify: `apps/web/e2e/b-code-highlight-degrade.spec.ts`（PERF-LAZY 裕量，rg "PERF-LAZY" 定位预算行）
- Modify: `packages/render-text/src/code.ts`（pumpChunk catch，rg "pumpChunk" 定位）
- Modify: e2e-server 内暴露的类型错（H2 连带）

**Interfaces:** 无跨任务接口；各自独立小改。

- [ ] **Step 1: H2 tsconfig include**

`tsconfig.e2e.json` :18 `"include": ["e2e/**/*.ts", "playwright.config.ts"]` → `"include": ["e2e/**/*.ts", "e2e-server/**/*.ts", "playwright.config.ts"]`。随后 `pnpm typecheck`——e2e-server 从未被 typecheck，会暴露存量类型错：逐个修复（只修类型面——类型注记/导入/明显笔误，不改测试逻辑；若某错需要改测试语义，停下来记录并跳过该文件，在报告中说明）。预期新增类型错面：playwright test 前置导入、fixture 类型、node 全局（tsconfig 已有 @types/node）。

- [ ] **Step 2: H3 ImportMetaEnv**

`app.d.ts` 改：

```ts
/// <reference types="vite-plugin-pwa/client" />

interface ImportMetaEnv {
  /** 构建期注入的 grammar CDN 层 base（须以 /grammars/ 结尾；缺省=无 CDN 层） */
  readonly VV_GRAMMAR_CDN?: string;
}

declare global { namespace App {} }
export {};
```

`highlightClient.ts` 约 :246 的 `import.meta.env.VV_GRAMMAR_CDN as string | undefined` cast 收敛为直接使用（读该行现文后最小改动；若类型已自然收窄则删 cast）。

- [ ] **Step 3: H4 local-grammars 断言钉死**

:53-56 的 `startsWith('keyword')` 前缀断言钉死为具体 capture 名：跑一次现状测试拿实际值（`pnpm vitest run packages/highlight/test/local-grammars.test.ts` 后在失败输出或加临时 console 确认 python 的 keyword.function 与 java 的 keyword 精确名），改为：

```ts
      // 层级捕获词法（上游查询同步伴生变化）：python def→keyword.function、java class→keyword。
      // 钉死具体 capture 名（ledger H4：前缀匹配弱于精确名；与 theme.ts 最长前缀回退同构
      // 的设计意图注释保留）
      const kw = lang === 'python'
        ? r.intervals.find((i) => i.capture === 'keyword.function')
        : r.intervals.find((i) => i.capture === 'keyword');
```

（以实测精确值为准——若实际 capture 名不同，以实测值钉死并同步注释。）

- [ ] **Step 4: H5 PERF-LAZY 裕量**

`b-code-highlight-degrade.spec.ts` 内 rg "PERF-LAZY" 定位预算断言行（形如 `expect(ms).toBeLessThan(BUDGET)`）：本地预算乘 1.5（读现值后取整，如 300→450）；**CI×4 倍率机制（env 或条件）保持不动**；注释补一句「本地裕量（ledger H5）：CI 波动固有属性，锚点口径不变」。

- [ ] **Step 5: H9 pumpChunk catch**

`code.ts` rg "pumpChunk" 定位函数体：外层包裹 try/catch（或在其 async 调用点捕获——读现文后选最小侵入面）：

```ts
      } catch (err) {
        // hljs 动态 import 失败兜底（ledger H9，low）：unhandled rejection 噪音消除，
        // 该块停留 plain（与 hljs 缺席同形态）；取消语义不变（HighlightCanceledError
        // 亦在此静默，不与失败混淆——留 debug 级统一留痕）
        console.debug('[code] pumpChunk 高亮失败（该块停留 plain）', err);
      }
```

（若 pumpChunk 内部已有 per-chunk 错误边界，则只在缺失的 `hljs ??= await import('highlight.js')` 处补 try——以现文实际结构为准，目标是消除 unhandled rejection 且该块停留 plain。）

- [ ] **Step 6: 验证**

Run: `pnpm typecheck && pnpm vitest run packages/highlight/test/local-grammars.test.ts packages/render-text/test/code.test.ts`
Expected: typecheck 0E（含 e2e-server 新纳入）；两测试文件全绿。

- [ ] **Step 7: 提交**

```bash
git add apps/web/tsconfig.e2e.json apps/web/src/app.d.ts apps/web/src/lib/highlightClient.ts packages/highlight/test/local-grammars.test.ts apps/web/e2e/b-code-highlight-degrade.spec.ts packages/render-text/src/code.ts apps/web/e2e-server/
git commit -m "chore(web,highlight,render-text): 前端卫生批——e2e-server 纳入 typecheck 等五项

why：SDD ledger 余量清偿（H2/H3/H4/H5/H9）——e2e-server 从不被 typecheck、
ImportMetaEnv 缺声明、弱断言、PERF-LAZY 零裕量、pumpChunk unhandled rejection。
what：tsconfig include 补 e2e-server 并清存量类型错；app.d.ts 补 env 接口；
local-grammars 钉死具体 capture；PERF-LAZY 加本地裕量；pumpChunk 补 catch
（该块停留 plain，取消语义不变）。"
```

---

### Task 4: 工具批（H8 pack-npm 收紧 / H11 build:e2e）

**Files:**
- Modify: `tools/grammar-builder/pack-npm.mjs`（queries 过滤 + outDir fail-fast）
- Modify: `tools/grammar-builder/test/pack-npm.test.ts`（新用例）
- Modify: `apps/web/package.json`（build:e2e 脚本）
- Modify: `docs/e2e/README.md`（本地构建口径一句；若无该文件则放 docs/e2e/ 目录 README 或 media-office-viewer 同级新建注记——以现状为准选最近入口）

**Interfaces:** pack-npm.mjs 的 main(env) 可注入测试（既有模式）；resolvePathsFrom 已导出。

- [ ] **Step 1: H8 实现**

读 pack-npm.mjs 的 queries 拷贝段（rg "queries" 定位整目录 cp 处）：拷贝时过滤仅 `.scm` 后缀：

```js
  // queries 拷贝：仅 .scm（ledger H8——queries/ 混入的非 scm 资产不进包）
  for (const entry of fs.readdirSync(queriesDir, { withFileTypes: true })) {
    ...
  }
```

（以现文件实际结构为准：若为 `fs.cpSync` 整目录拷贝，改为递归手工拷贝仅 .scm 文件，保持目录层级；头注「整目录拷贝」句同步改为「仅 .scm 拷贝」。）outDir fail-fast：main 入口在写盘前检查 `fs.existsSync(path.join(outDir, 'package.json'))` 或 manifest——存在即 `throw new Error('outDir 非空（已有打包产物）：请清空或换目录（脚本不清理既有内容）')`；头注「outDir 应指向空目录（脚本不清理既有内容）」句尾追加「；已含产物时 fail-fast 拒跑（ledger H8）」。

- [ ] **Step 2: H8 测试**

pack-npm.test.ts 沿既有 main(env) 注入模式新增两用例：①queries 目录含非 scm 文件 → 包内 queries 无该文件；②outDir 预置假产物 → main 抛错。

- [ ] **Step 3: H11 build:e2e**

`apps/web/package.json` scripts 增：

```json
    "build:e2e": "node ../../tools/gen-icons.mjs && cross-env VV_GRAMMAR_CDN=https://cdn.grammars.test/grammars/ vite build && node scripts/check-pwa-build.mjs",
```

（若仓库无 cross-env 依赖，改用 `env VV_GRAMMAR_CDN=... vite build` 的 POSIX 形态——CI runner 与本机均 POSIX，直接用 `env` 前缀避免新增依赖；与 build 的差异仅 env 前缀。）docs/e2e/README.md 的构建/本地运行节补一句：「GRF 域用例需 CDN 注入产物：本地构建用 `pnpm --filter web build:e2e`（与 CI 同参）；忘走时 GRF-01/02 假红即守卫报警（2026-10-16 裁决档②）」。

- [ ] **Step 4: 验证**

Run: `pnpm vitest run tools/grammar-builder/test/pack-npm.test.ts && node -e "const p=require('./apps/web/package.json'); console.log(p.scripts['build:e2e'])"`
Expected: 测试全绿；build:e2e 脚本在位。

- [ ] **Step 5: 提交**

```bash
git add tools/grammar-builder/pack-npm.mjs tools/grammar-builder/test/pack-npm.test.ts apps/web/package.json docs/e2e/README.md
git commit -m "chore(tools,web): 工具卫生批——pack-npm 收紧 + build:e2e 固化

why：ledger H8（queries 混非 scm/outDir 不清理）+ GRF env 固化三档裁决取②
（本地无 env 重建令 GRF-01/02 假红，两次先例）。
what：queries 拷贝过滤仅 .scm + outDir 已含产物 fail-fast（附测试）；
package.json 增 build:e2e（与 ci.yml 同参）+ e2e README 构建口径注记。"
```

---

### Task 5: Rust/CI 批（H7 timeout / H10 queries.rs 严格化）

**Files:**
- Modify: `.github/workflows/grammar.yml`（server-full job 补 timeout-minutes）
- Modify: `server/src/compute/queries.rs`（CONFIGS 构建段合并失败降级重试）

**Interfaces:** `HighlightConfiguration::new(lang, name, highlights, injections, locals)`（tree_sitter API）；ENTRIES 的 LanguageEntry 字段（name/language/highlights/injections/locals，:30-56 现文）。

- [ ] **Step 1: H7**

`grammar.yml` server-full job（:58-61）`runs-on: ubuntu-latest` 之后补：

```yaml
    timeout-minutes: 240  # 全量 301 编译+测试上限（ledger H7：默认 360 兜底不显式；self-build 为 120）
```

- [ ] **Step 2: H10 实现**

queries.rs 的 CONFIGS 构建段（rg "HighlightConfiguration::new" 定位，现 :198-211 一带）Err 分支改降级重试：

```rust
            Err(e) => {
                // 合并后编译失败（ledger H10 严格化）：降级重试——仅主 queries 重建
                // 配置（injections/locals 剔除），不再剔整语言；再失败才剔除。
                tracing::warn!("language {} 合并查询编译失败，降级为主 queries 重试: {e}", entry.name);
                match HighlightConfiguration::new(
                    Language::from(entry.language),
                    entry.name,
                    &expanded,
                    "",
                    "",
                ) {
                    Ok(mut config) => {
                        config.configure(names);
                        tracing::warn!("language {} 以主 queries 降级可用（injections/locals 剔除）", entry.name);
                        map.insert(entry.name, Arc::new(config));
                    }
                    Err(e2) => {
                        tracing::warn!("language {} highlights query 编译失败，已剔除: {e2}", entry.name);
                    }
                }
            }
```

（注意 `expanded` 为展开后的主 queries 字符串——降级重试直接复用；injections/locals 传空串与 ENTRIES 置空保底同形态。若现文 Err 分支的 warn 文案被测试锚定，rg 确认后同步。）

- [ ] **Step 3: 验证**

Run: `cd server && cargo test 2>&1 | tail -15`
Expected: 全套件 PASS（`full_registry_count_is_301` 等门禁用例零翻转——降级路径对全量 301 全部健康源不触发）

- [ ] **Step 4: 提交**

```bash
git add .github/workflows/grammar.yml server/src/compute/queries.rs
git commit -m "fix(server): 合并查询编译失败降级主 queries 重试——不再剔整语言

why：ledger H10 严格化——展开合并后的 injections/locals 编译失败走
HighlightConfiguration::new Err 即剔整语言，降级强度弱于 ENTRIES 层
sanitize 契约（逐文件置空保底）；另 grammar.yml server-full 补显式
timeout（H7，默认 360 兜底不显式）。
what：CONFIGS 构建 Err 分支降级重试（主 queries 重建、injections/locals
剔除）+ warn 双段留痕，再失败才剔除；ENTRIES 预校验层不动。"
```

---

### Task 6: 文档批（H1 spec §7.2 勘误 / H6 spec-deviations 勘误）

**Files:**
- Modify: `docs/superpowers/specs/2026-10-09-full-grammar-alignment-design.md`（§7.2 两段式勘误，约 :150-152）
- Modify: `docs/spec-deviations.md`（「6 纯父目录」勘误一行）

**Interfaces:** H1 沿该 spec §7.3 的两段式先例（保留原文 + 追加勘误段）；§7.3 勘误段格式（rg "勘误（2026-10-10" 定位参照）。

- [ ] **Step 1: H1**

读 §7.2 现文（约 :145-160，rg "7.2" 定位）：保留原文，其后追加勘误段：

```markdown
> **勘误（2026-10-16，ledger H1）：** 上文「两 job 均以 vars.NPM_SCOPE != '' 门控」
> 的表述已过时，且与实现不符：release.yml 的 web job 无 job 级 NPM_SCOPE 门
> （CDN 注入为 step 级），publish-npm 门在 npm 方案 B（contentHash 对比线上 latest）
> 落地时整体重写——门控粒度为 step 级而非本节所述 job 级。本节保留原文仅作
> 历史记录，现行为准以 release.yml 现文为准。
```

（以 §7.3 勘误段的实际格式模板微调——blockquote/加粗形态逐字对齐先例。）

- [ ] **Step 2: H6**

`docs/spec-deviations.md` 追加一行（沿该文件既有条目格式）：

```markdown
- 2026-10-16：阶段 1 简报「6 纯父目录」散文估算失实——实测 307 目录全含 highlights.scm（SDD ledger 阶段 1 progress :35 记档；验收当时已以 307 逐字镜像硬判据兜住，结论不变、论据修正）。
```

- [ ] **Step 3: 提交**

```bash
git add docs/superpowers/specs/2026-10-09-full-grammar-alignment-design.md docs/spec-deviations.md
git commit -m "docs(spec): 全量对齐 spec §7.2 门控粒度勘误 + spec-deviations 目录数勘误

why：ledger H1/H6——§7.2「两 job 均以 NPM_SCOPE 门控」与方案 B 重写后实现
不符；阶段 1 简报「6 纯父目录」散文估算与实测 307 不符。
what：§7.2 两段式勘误（保留原文+勘误段，沿 §7.3 先例）；spec-deviations
补一行论据修正记录（结论不变）。"
```

---

### Task 7: 收口门禁

**Files:** 无新改动（发现回归时修复并单独提交）

- [ ] **Step 1: 全量单测 + typecheck**

Run: `pnpm vitest run && pnpm typecheck`
Expected: 全 PASS / 0E

- [ ] **Step 2: cargo 全套件**

Run: `cd server && cargo test 2>&1 | tail -6`
Expected: 全 PASS

- [ ] **Step 3: build + playwright 默认通道**

Run: `VV_GRAMMAR_CDN=https://cdn.grammars.test/grammars/ pnpm --filter web build`（独立命令）→ `pnpm --filter web exec playwright test`（独立命令）
Expected: 全 PASS（含 BUG-35 转正用例与 W2 探针蹲守用例；既有锚零翻转）

- [ ] **Step 4: 收口**

门禁数字记入台账；如有修复按 Angular 规范单独提交。
