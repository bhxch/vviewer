# 阶段 2：资产链（npm 单包 + CDN + 三层解析链）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** grammar wasm 资产三层交付——同源 dist（lite）→ 已连接服务端 origin → CDN（npm 精确版本钉死）——客户端按语言粒度谁有谁兜底；release 增加 npm 单包 publish 管线；pages 无服务端也能全量高亮。

**Architecture:** 只有 grammar wasm 需要分层（queries 资产同源 dist 已全量拷贝 307 目录，不分层）。契约变更：`GrammarTable` 条目新增 `base?: string`（该条目 wasm 的绝对 URL 前缀），`core-parse` 按 entry.base 加载；应用侧新纯模块做三层 manifest 合并（first-wins + 逐条 base 注记），create() 一次性装配（连接服务器在会话中发生后需刷新页面才纳入第 2 层——记录为已知语义）。CDN 前缀经构建期 env 烙进 bundle（与 BUILD_REVISION 同通道）。

**Tech Stack:** SvelteKit/Vite（define 注入）、workbox generateSW、GitHub Actions（artifact 聚合 + npm publish）。

**Spec:** `docs/superpowers/specs/2026-10-09-full-grammar-alignment-design.md`（§3 阶段 2）

## Global Constraints

- 资产源解析顺序固定：同源 dist → 服务端 origin → CDN；同键 first-wins；任何一层失败只 console.warn 跳层，不阻塞启动。
- npm 单包：包名 `${vars.NPM_SCOPE}/vviewer-grammars-full`（scope 为 GitHub repo variable，未配置则 job 跳过并 notice）；内容 = wasm 全集 + manifest.json + queries/；版本 = release tag 去 v 前缀；publish 幂等（版本已存在则跳过）。
- CDN URL 形态：`https://cdn.jsdelivr.net/npm/<pkg>@<精确版本>/`，web 构建期经 `VV_GRAMMAR_CDN` 注入；未配置时第 3 层不存在（行为与现状一致）。
- 产物不入库；e2e 不依赖外网（CDN 层用 playwright page.route mock）。
- 既有行为回归：无服务端连接且无 CDN env 时，加载路径与现状逐字节等价（单层）。
- commit Angular 规范、原子化。

---

### Task 1: GrammarTable base 契约（packages/highlight）

**Files:**
- Modify: `packages/highlight/src/core-parse.ts`（GrammarTable 类型 :15、resolveGrammar/doPrepare :255-268）
- Test: `packages/highlight/test/`（现有 core-parse 相关测试文件内追加）

**Interfaces:**
- Produces: `type GrammarTable = Record<string, { file: string; aliases?: string[]; base?: string }>`（base=该条目 wasm 的目录 URL/路径前缀，缺省回落 grammarsBase）——Task 2/3 的消费契约。

- [ ] **Step 1: 写失败测试**（在 packages/highlight 现有 Node 侧 core-parse 测试文件追加；若文件名不确定先 `rg -l "grammarsDir" packages/highlight/test`）

```ts
it('entry.base 优先于 grammarsBase 定位 wasm', async () => {
  // 目录 A 放真 wasm，grammarsDir 指向空目录 B；manifest 条目带 base=A
  // 断言：highlight 成功（说明从 base=A 加载），无 base 的对照条目报加载失败
});
```

测试的完整实现要求：用 fixture 拷贝一个真实 lite wasm（如 `apps/web/static/grammars/json.wasm`，测试前置检查存在、否则 skip）到临时目录 A；引擎 A 用 `grammars: { json: { file: 'json.wasm', base: dirA } }` + `grammarsBase: dirB(空)` + queriesDir 指向真实 queries；`highlight('{}', 'json')` 应 ok。

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run packages/highlight`
Expected: 新用例 FAIL（base 未生效，从空 grammarsDir 加载失败）

- [ ] **Step 3: 实现**

```ts
// GrammarTable 条目类型（:15）
export type GrammarTable = Record<string, { file: string; aliases?: string[]; base?: string }>;

// resolveGrammar 改返回条目（别名解析后同样返回条目）：
private resolveGrammarEntry(lang: string): { file: string; base?: string } | null {
  const direct = this.grammarTable[lang];
  if (direct) return direct;
  const alias = this.aliasToLang.get(lang);
  return alias ? (this.grammarTable[alias] ?? null) : null;
}

// doPrepare 内（原 :264）：
const entry = this.resolveGrammarEntry(lang);
if (!entry) return null;
const language = await Language.load(joinPath(entry.base ?? this.grammarsBase, entry.file));
```

- [ ] **Step 4: 跑测试通过 + 全包回归**

Run: `pnpm vitest run packages/highlight`
Expected: 全绿（含既有 63 用例——无 base 条目行为不变）

- [ ] **Step 5: Commit**

```bash
git add packages/highlight/src/core-parse.ts packages/highlight/test
git commit -m "feat(highlight): GrammarTable 条目支持 base 覆写 wasm 加载前缀

why: 资产三层解析链（同源/服务端/CDN）需要逐条目标明 wasm 来源（spec §3）。
what: 条目新增 base?: string，doPrepare 按 entry.base ?? grammarsBase 加载；
无 base 条目行为不变。"
```

---

### Task 2: 三层 manifest 合并链（apps/web）

**Files:**
- Create: `apps/web/src/lib/grammarLayers.ts`
- Create: `apps/web/src/lib/grammarLayers.test.ts`
- Modify: `apps/web/src/lib/highlightClient.ts`（create() :208-238 与 warm 调用 :159-160）

**Interfaces:**
- Consumes: Task 1 的 base 契约。
- Produces:
  - `interface GrammarLayer { base: string; table: GrammarTable }`
  - `mergeGrammarLayers(layers: GrammarLayer[]): GrammarTable`（first-wins；每条目写全 `base`）
  - `fetchGrammarManifest(url: string): Promise<GrammarTable | null>`（非 2xx/网络错 → null + console.warn）
  - `assembleGrammarLayers(opts: { sameOriginBase: string; serverBase?: string | null; cdnBase?: string | null }): Promise<{ grammars: GrammarTable; layers: string[] }>`

- [ ] **Step 1: 写失败测试（纯函数 + stub fetch）**

```ts
// grammarLayers.test.ts —— 要点（完整用例自拟，覆盖以下命题）：
// 1) first-wins：两层同键，取第 1 层条目（base=第 1 层）
// 2) base 注记：第 2 层独有键的 base=第 2 层 base；无 base 概念泄漏（每条都有 base）
// 3) fetchGrammarManifest：404 → null + warn；网络 reject → null + warn；200 → 表
// 4) assembleGrammarLayers：serverBase=null/cdnBase=null 时只取同源层；
//    server 层 fetch 失败 → 跳层继续 cdn 层；layers 返回实际命中的层名
// fetch 用 vi.stubGlobal('fetch', vi.fn()) 逐 URL 编排响应。
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run apps/web/src/lib/grammarLayers.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 grammarLayers.ts**

```ts
import type { GrammarTable } from '@vviewer/highlight';

export interface GrammarLayer { base: string; table: GrammarTable }

export function mergeGrammarLayers(layers: GrammarLayer[]): GrammarTable {
  const out: GrammarTable = {};
  for (const layer of layers) {
    for (const [lang, entry] of Object.entries(layer.table)) {
      if (out[lang]) continue; // first-wins
      out[lang] = { ...entry, base: layer.base };
    }
  }
  return out;
}

export async function fetchGrammarManifest(url: string): Promise<GrammarTable | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) {
      console.warn(`[vviewer] grammar manifest ${url}: HTTP ${res.status}，跳过该资产层`);
      return null;
    }
    const json = (await res.json()) as { grammars?: GrammarTable };
    return json.grammars ?? null;
  } catch (e) {
    console.warn(`[vviewer] grammar manifest ${url} 加载失败，跳过该资产层:`, e);
    return null;
  }
}

export async function assembleGrammarLayers(opts: {
  sameOriginBase: string;
  serverBase?: string | null;
  cdnBase?: string | null;
}): Promise<{ grammars: GrammarTable; layers: string[] }> {
  const candidates: Array<{ name: string; base: string }> = [
    { name: 'same-origin', base: opts.sameOriginBase }
  ];
  if (opts.serverBase) candidates.push({ name: 'server', base: `${opts.serverBase.replace(/\/+$/, '')}/grammars/` });
  if (opts.cdnBase) candidates.push({ name: 'cdn', base: opts.cdnBase });
  const layers: GrammarLayer[] = [];
  const hit: string[] = [];
  for (const c of candidates) {
    const table = await fetchGrammarManifest(`${c.base}manifest.json`);
    if (table) {
      layers.push({ base: c.base, table });
      hit.push(c.name);
    }
  }
  return { grammars: mergeGrammarLayers(layers), layers: hit };
}
```

- [ ] **Step 4: highlightClient 接线**

`create()` 中 manifest 加载段替换为：

```ts
  const cdnBase = (import.meta.env.VV_GRAMMAR_CDN as string | undefined) || null;
  const serverBase = loadLastServer()?.baseUrl ?? null;
  const { grammars } = await assembleGrammarLayers({
    sameOriginBase: `${baseUrl}grammars/`,
    serverBase,
    cdnBase
  });
  grammarManifest = grammars;
```

`new HighlightClient(worker, {...})` 的 `grammars:` 传合并后的表；`grammarsBase` 保持 `${baseUrl}grammars/`（第 1 层缺省 base；合并表每条已带 base，实际不再回落）。warm 调用（:159-160）改为 `${g.base}grammars/${g.file}`（g.base 恒存在）。模块头注释补两层语义说明（第 2 层为连接时快照，会话中新连接需刷新页面）。

- [ ] **Step 5: 跑测试 + 单包回归**

Run: `pnpm vitest run apps/web/src/lib/grammarLayers.test.ts && pnpm vitest run packages/highlight && pnpm typecheck`
Expected: 全绿

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/lib/grammarLayers.ts apps/web/src/lib/grammarLayers.test.ts apps/web/src/lib/highlightClient.ts
git commit -m "feat(web): grammar wasm 三层资产解析链（同源→服务端→CDN）

why: pages 部署无法内嵌全量 wasm，需按语言从服务端/CDN 兜底（spec §3）。
what: grammarLayers 纯模块做三层 manifest 合并（first-wins + 逐条 base 注记，
失败跳层不阻塞）；create() 装配（服务端层为连接时快照）；warm 按 entry.base。"
```

---

### Task 3: SW 容量与 CDN env 注入 + e2e 分层链用例

**Files:**
- Modify: `apps/web/vite.config.ts`（runtimeCaching grammars maxEntries、define 注入）
- Modify: `apps/web/e2e/`（新增 `b-grammar-layers.spec.ts`）
- Modify: `apps/web/e2e/` 的 setup 约定（若 e2e 语言清单需要加 java——查 `apps/web/playwright.config.ts` 与 CI e2e job 的 setup-grammars languages；CI 的 ci.yml e2e job languages 加 `java`）

**Interfaces:**
- Consumes: Task 2 的解析链（`import.meta.env.VV_GRAMMAR_CDN`）。
- Produces: e2e 可复现的分层链验证环境（VV_GRAMMAR_CDN 构建注入）。

- [ ] **Step 1: vite.config.ts 两处**

```ts
// runtimeCaching grammars 块：maxEntries 300 → 500（全量集 ~299 个 wasm）
expiration: { maxEntries: 500, purgeOnQuotaError: true },
```

```ts
// define 块（BUILD_REVISION 旁）：
'import.meta.env.VV_GRAMMAR_CDN': JSON.stringify(process.env.VV_GRAMMAR_CDN ?? ''),
```

- [ ] **Step 2: e2e 用例（mock CDN，不依赖外网）**

前置确认：e2e 语言集需含 java（wasm 在 static、查询在同源 queries——若 ci.yml e2e job 的 setup-grammars languages 无 java 则加上；本地 playwright 跑前同样 fetch java）。

```ts
// apps/web/e2e/b-grammar-layers.spec.ts 要点：
// 1. test.beforeAll 说明：本 spec 需要构建期 VV_GRAMMAR_CDN=https://cdn.grammars.test/
//    （playwright.config webServer 的 build 步骤已透传 env；CI e2e job 设置同名 env）
// 2. 用例 1「同源 wasm 404 → CDN 层兜底」：
//    - page.route('**/grammars/java.wasm', 404)  —— 模拟同源缺失（lite 不含 java 的场景）
//    - page.route('**/cdn.grammars.test/manifest.json', fulfill {grammars: {java: {file: 'java.wasm', aliases: []}}})
//    - page.route('**/cdn.grammars.test/grammars/java.wasm', fulfill 静态文件字节——从 e2e 服务器读
//      同源 /grammars/java.wasm 的响应体（request.get 后 fulfill {body}），不读盘）
//    - 打开 samples 的 .java 文件，断言 tree-sitter 高亮生效（状态栏 where=local 且 __vvLastHighlightOk=true）
// 3. 用例 2「CDN manifest 失败 → 优雅降级」：
//    - page.route('**/cdn.grammars.test/**', abort)
//    - 打开同一文件，断言页面无崩溃、java 走 hljs 或报 console.warn 一条跳层（不阻塞渲染）
```

- [ ] **Step 3: 本地验证**

```bash
cd apps/web
VV_GRAMMAR_CDN=https://cdn.grammars.test/ pnpm build
pnpm exec playwright test b-grammar-layers
```
Expected: 2 用例绿。CI 侧 ci.yml e2e job 与本地同参（env 加到 e2e job 的 build 步骤）。

- [ ] **Step 4: Commit**

```bash
git add apps/web/vite.config.ts apps/web/e2e/b-grammar-layers.spec.ts .github/workflows/ci.yml
git commit -m "feat(web): CDN 资产层构建注入与分层链 e2e

why: 分层链需要可复现的端到端验证（mock CDN，不依赖外网，spec §3）。
what: VV_GRAMMAR_CDN 经 define 注入 bundle；grammars SW maxEntries 300→500；
新增 b-grammar-layers 两用例（同源缺失→CDN 兜底 / CDN 不可达→优雅降级），
e2e 语言集补 java。"
```

---

### Task 4: npm 单包打包脚本

**Files:**
- Create: `tools/grammar-builder/pack-npm.mjs`
- Create: `tools/grammar-builder/test/pack-npm.test.ts`

**Interfaces:**
- Produces: `packNpm({ grammarsDir, queriesDir, outDir, name, version })` → 组装 `outDir`（manifest.json + grammars/*.wasm + queries/ + package.json），返回 `{ files: number, bytes: number }`——Task 5 publish job 消费（CLI 入口 `node tools/grammar-builder/pack-npm.mjs`，env：`VV_NPM_PACKAGE_NAME`、`VV_NPM_PACKAGE_VERSION`、`VV_NPM_OUT`）。

- [ ] **Step 1: 写失败测试**

```ts
// pack-npm.test.ts 覆盖：
// 1) 布局：outDir/manifest.json + outDir/grammars/*.wasm + outDir/queries/<dir>/*.scm
// 2) package.json：name/version/files(["manifest.json","grammars","queries"])/license 字段
// 3) manifest 中每条 entry 补 base 字段 = './grammars/'（CDN 层消费端按 base 拼 wasm URL）
// 4) 空 grammarsDir 抛错
// fixture：临时目录造 2 个假 wasm（任意字节）+ 假 manifest + 2 个假 queries 目录。
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run tools/grammar-builder/test/pack-npm.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现 pack-npm.mjs**

核心逻辑（完整脚本照此写，含 main() 与 env 处理，风格对齐 build.mjs）：

```js
// 复制 grammarsDir 全部 *.wasm → outDir/grammars/；manifest.json 读入后
// 每条 entry 注 base: './grammars/'，写 outDir/manifest.json；
// queriesDir 整目录 cp → outDir/queries/；写 package.json：
// { name, version, private: false, files: [...], license: 'SEE LICENSE IN GRAMMAR_LICENSES.md',
//   description: 'vviewer grammar wasm 全量资产（自建，manifest+queries）', repository: <从 package.json 读> }
```

- [ ] **Step 4: 跑测试通过**

Run: `pnpm vitest run tools/grammar-builder`
Expected: 全绿（含既有 build/gen-server-manifest/pack 测试）

- [ ] **Step 5: Commit**

```bash
git add tools/grammar-builder/pack-npm.mjs tools/grammar-builder/test/pack-npm.test.ts
git commit -m "feat(grammars): npm 单包打包脚本（wasm 全集 + manifest + queries）

why: CDN 分发的资产单位是一个 npm 精确版本包（spec §3，tree-sitter-wasms 先例）。
what: pack-npm.mjs 组装 npm 布局并给 manifest 条目注 base='./grammars/'，
含布局/字段/异常单测。"
```

---

### Task 5: release publish job 与 CDN env 贯通

**Files:**
- Modify: `.github/workflows/release.yml`（新增 publish job；web job 与 release 聚合依赖调整）
- Modify: `.github/workflows/pages-deploy.yml`（web 构建步骤补 VV_GRAMMAR_CDN env）

**Interfaces:**
- Consumes: Task 4 pack 脚本；既有 grammar-wasm artifact（全量 wasm+manifest）。
- Produces: npm 包 `<scope>/vviewer-grammars-full@<tag>`；web 构建烙入 `VV_GRAMMAR_CDN=https://cdn.jsdelivr.net/npm/<scope>/vviewer-grammars-full@<version>/`。

- [ ] **Step 1: release.yml web job 注入 env**

web job 的 `pnpm --filter web build` 步骤加：

```yaml
        env:
          VV_GRAMMAR_CDN: https://cdn.jsdelivr.net/npm/${{ vars.NPM_SCOPE && format('{0}/', vars.NPM_SCOPE) || '' }}vviewer-grammars-full@${{ github.ref_name }}/
```

（`github.ref_name` 形如 `v1.2.3`——CDN URL 的版本段保留 `v` 前缀会与 npm 版本不符；改为在 publish 与 web 两个 job 各自用 shell 归一：`VERSION="${GITHUB_REF_NAME#v}"` 后写 `$GITHUB_ENV`，两个 job 同法，保证一致。按此实现，不用上面的内联表达式。）

- [ ] **Step 2: 新增 publish job**

```yaml
  publish-npm:
    name: npm 资产包发布（grammars-full）
    runs-on: ubuntu-latest
    # scope 未配置（repo variable）则整个包分发未启用，跳过并 notice
    if: vars.NPM_SCOPE != ''
    needs: [grammar]
    steps:
      - uses: actions/checkout@v7
      - uses: pnpm/action-setup@v6
      - uses: actions/setup-node@v7
        with:
          node-version: 22
          registry-url: https://registry.npmjs.org
      - uses: actions/download-artifact@v8
        with:
          name: grammar-wasm
          path: artifacts/grammar-wasm
      - name: 归一版本号并打包
        run: |
          echo "VV_NPM_PACKAGE_VERSION=${GITHUB_REF_NAME#v}" >> "$GITHUB_ENV"
          echo "VV_NPM_PACKAGE_NAME=${{ vars.NPM_SCOPE }}/vviewer-grammars-full" >> "$GITHUB_ENV"
          echo "VV_NPM_OUT=$GITHUB_WORKSPACE/dist-npm" >> "$GITHUB_ENV"
          node tools/grammar-builder/pack-npm.mjs
      - name: 版本已发布则跳过（幂等）
        run: |
          if npm view "$VV_NPM_PACKAGE_NAME@$VV_NPM_PACKAGE_VERSION" version >/dev/null 2>&1; then
            echo "SKIP_PUBLISH=1" >> "$GITHUB_ENV"
          fi
      - name: npm publish
        if: env.SKIP_PUBLISH != '1'
        run: npm publish ./dist-npm --access public
        env:
          NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}
```

（artifact 名 `grammar-wasm` 以 workflow 实际 upload 名为准——先 `rg -n "name: grammar" .github/workflows/grammar.yml` 核对再写。）

- [ ] **Step 3: pages-deploy.yml 同参注入**

pages 构建步骤（`pnpm --filter web build`）加与 Step 1 相同的 `VV_GRAMMAR_CDN` env（版本用 `github.ref_name` 归一同法）。

- [ ] **Step 4: 校验 + commit**

```bash
python3 -c "import yaml; [yaml.safe_load(open(f'.github/workflows/{w}.yml')) for w in ['release','pages-deploy']]; print('yaml ok')"
git add .github/workflows/release.yml .github/workflows/pages-deploy.yml
git commit -m "ci(release): npm 资产包发布管线与 CDN env 贯通

why: 三层解析链的第 3 层需要发布管线与构建期 URL 对齐（spec §3）。
what: release 新增 publish-npm job（scope variable 门控、版本幂等、
NPM_TOKEN secret）；web/pages 构建注入 VV_GRAMMAR_CDN 精确版本 URL。"
```

---

### Task 6: 服务端层冒烟 + 文档 + spec 回写

**Files:**
- Modify: `apps/web/e2e-server/`（新增或扩展一个 spec：服务端层冒烟）
- Modify: `README.md` 或 `server/README.md`（资产分发一节）、`tools/grammar-builder/README.md`
- Modify: `docs/superpowers/specs/2026-10-09-full-grammar-alignment-design.md`（§7 阶段 2 行回写）

**Interfaces:**
- Consumes: Task 2 解析链、既有 e2e-server 基建（playwright.server.config.ts + release 二进制伺服 :4174）。

- [ ] **Step 1: 服务端层冒烟用例**

在 e2e-server 目录新增 spec（对齐既有 b-compute-*.spec.ts 的 fixture 惯例）：应用从 vite preview（无服务端）打开，`page.addInitScript` 预写 localStorage `LastServer`（指向 :4174 的 release 二进制）→ 断言：页面启动时向 `http://127.0.0.1:4174/grammars/manifest.json` 发出请求（page.on('request') 记录），且该层命中（layers 含 server——经 `window.__vv` 调试约定或 manifest 请求成功即可）后，同源语言高亮行为不变。若 release 二进制的 dist 未配全量，断言「合并表 = lite ∪ server 层（server 层同为 lite 集，结果不变）」。

- [ ] **Step 2: 文档**

`tools/grammar-builder/README.md` 补「npm 资产包」小节（pack-npm 用法、包布局、base 字段语义）；`server/README.md` 或根 README 补「资产分发」一节（三层顺序、`--cors-origin` 在 pages+远程服务器组合下的要求、NPM_SCOPE/NPM_TOKEN 运营准备清单）。

- [ ] **Step 3: spec §7.2 回写**（阶段 2 实测：e2e 用例数、publish job 门控语义、已知语义——服务端层为连接时快照）

- [ ] **Step 4: 全量门禁 + commit**

```bash
pnpm vitest run && pnpm typecheck
git add -A apps/web/e2e-server tools/grammar-builder/README.md README.md server/README.md docs/superpowers/specs/2026-10-09-full-grammar-alignment-design.md
git commit -m "docs(grammars): 阶段 2 收口——服务端层冒烟、分发文档与 spec 回写"
```

---

## Self-Review 记录

1. **Spec 覆盖**：§3 npm 单包→Task 4/5；发布管线→Task 5；三层解析链→Task 1/2；SW 适配→Task 3；跨源 CORS→Task 6 文档（运行期属服务器参数，无代码改动）；验收锚点（pages+CDN、SW 二次命中、CDN 不可达降级）→Task 3 e2e 两用例 + Task 6 冒烟。无缺口。
2. **占位符扫描**：Task 1 Step 1 的测试实现要点与 Task 2 Step 1 的用例命题为「意图+硬判据」式给定（执行者据现有测试风格落地），无 TBD；Task 5 artifact 名核对为显式指令。其余步骤含完整代码。
3. **类型一致性**：`GrammarTable.base`（Task 1）↔ mergeGrammarLayers 注记（Task 2）↔ pack-npm base './grammars/'（Task 4）↔ CDN wasm URL `${base}grammars/<file>`（Task 3 mock）同构；`assembleGrammarLayers` 返回 `layers` ↔ Task 6 冒烟断言一致。
