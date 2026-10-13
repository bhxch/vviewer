# grammar SPA-fallback 嗅探回归 — e2e 场景（本轮补充）

> 来源：e2e 补充测试盘点（2026-10-13）medium 缺口。050ae69（fetchGrammarManifest 嗅探 200 text/html，SPA fallback 视为层缺失）与 7fab3a5（SPA-fallback 不再误载 grammar 查询资产，C1 双层修：server 层 .scm/.wasm 回 404 不入 index fallback + 前端层 remoteQueryLoader 对 200 text/html 视同缺失）是两个真实 bug 修复，均只有单测/服务端集成用例，无浏览器端 e2e 回归锚。spec 依据：`docs/superpowers/specs/2026-10-09-full-grammar-alignment-design.md`（三层资产解析链）与 `apps/web/src/lib/grammarLayers.ts`（同源→服务端→CDN 逐层 fetch）。
>
> 本域缺陷编号 BUG-106 为回归防护缺口编号（修复已落地）。既有锚点（不重复布点）：b-grammar-layers.spec.ts 用例 1/2（CDN 兜底正锚、CDN 不可达降级）、b-grammar-layers-server.spec.ts（服务端层 first-wins/wasm 零跨源）、CMP-02/04 与 t-cmp（路由三道门）。

## 1. 目的与来源

静态托管把缺失路径 SPA-fallback 成 200 index.html 是真实部署形态（release 二进制 serve_index 曾如此）。三层资产链的三个资产面（manifest / wasm / 查询 .scm）各有被 HTML 误载的修复：

- manifest：grammarLayers.ts:52-54——200 且 content-type 含 text/html → null + 「非 JSON 资产应答（SPA fallback？）」warn 跳层（050ae69；修复前 res.json() 抛 SyntaxError 误报网络错）；
- 查询 .scm：core-parse.ts:330-334——200 text/html → undefined 视同缺失（7fab3a5 前端层；修复前 HTML 误载为查询文本，Query 编译抛错整语言降级 hljs）；
- wasm：HTML 误入 WebAssembly 实例化必抛——断言降级不崩、不误报成功。

## 2. 场景清单

公共环境：default 套件；`test.use({ serviceWorkers: 'block' })`（b-grammar-layers 先例：SW CacheFirst 使 page.route 随机失效，屏蔽 SW 求确定性）；本地目录经 `__vvOpenDirImpl` 注入；构建期前提 `VV_GRAMMAR_CDN=https://cdn.grammars.test/grammars/`（CDN 层用例 1/2 必需，构建注入缺失时 CDN 命中计数恒 0——用例内断言即守卫）。mock 均经 page.route（fulfill 跨源需显式 ACAO）。

| 编号 | 前置条件 | 步骤 | 期望 | 关联缺陷 |
| --- | --- | --- | --- | --- |
| GRF-01 | mock CDN manifest（`**/cdn.grammars.test/grammars/manifest.json`）→ 200 text/html doctype 页 | ① 打开 java 文件（同源 manifest 剥离 java 条目）；② 挂 console.warn 监听；③ 读状态栏高亮段与 warn 计数 | CDN manifest 200 text/html → 层缺失跳过：不把 HTML 当 JSON 解析；warn 恰一条且文案含「非 JSON 资产应答」（050ae69 修复文案）；页面不崩，java 降级 hljs 兜底 | BUG-106 |
| GRF-02 | 同源 manifest 200 text/html（route 拦截同源 /grammars/manifest.json，负向前瞻排除 CDN host——b-grammar-layers 同款 glob 分流）；CDN manifest 正常（含 java） | ① 打开 java 文件；② 读状态栏与 cdnWasmHits 计数 | 同源层判缺失不误载 HTML；CDN 层兜底生效（first-wins 跨层）：cdnWasmHits ≥1、tree-sitter 生效（`ts-*` span>0、状态栏非「hljs 兜底」） | BUG-106 |
| GRF-03 | mock 同源 `/grammars/java.wasm` → 200 text/html（同源 manifest 含 java） | ① 打开 java 文件；② 读状态栏与 console | wasm 资产被 HTML 兜底 → 不实例化 HTML（WebAssembly 编译失败被捕获）：整语言降级 hljs 兜底不崩、无未捕获异常；hljs- span 正常 | BUG-106 |
| GRF-04 | mock 同源 `/queries/java/injections.scm` → 200 text/html（highlights.scm 照常 200） | ① 打开 java 文件；② 读状态栏与 `ts-*` span 计数 | 查询资产 HTML 兜底视同缺失（7fab3a5 前端层）：injections.scm 缺席不炸 Query 编译，highlights.scm 照常加载——java 仍 tree-sitter（`ts-*` span>0），**不整语言降级 hljs** | BUG-106 |
| GRF-05 | 不 mock（真实同源 manifest，content-type application/json） | ① 打开 rust 文件；② 读状态栏 | 正锚（嗅探不误伤）：manifest 正常载入、tree-sitter 生效、零 warn | —（回归护栏） |
| GRF-06 | mock 同源 manifest → 200、**无 content-type 头**、body 为 HTML 文本 | ① 打开任意语法文件；② 读 warn 与状态栏 | 无 content-type 的 HTML body 走 JSON.parse 失败 catch：等价层缺失（warn 跳层、不崩、hljs 兜底）；不得把 HTML 误当 manifest 条目 | BUG-106 |
| GRF-07 | GRF-01 场景延续 | ① 同会话内连续打开第二个 java 文件（换文件中转重载）；② 汇总 warn 计数 | 层缺失 warn 每层每会话恰一条不重复刷屏（既有用例 2「warn 恰一条」口径在 SPA-fallback 形态的对位）；第二文件渲染正常 | —（可观测性锚） |
| GRF-08 | mock `/queries/java/injections.scm` → 200 text/html（GRF-04 同款），同目录另开 rust 文件 | ① 打开 java；② 打开 rust；③ 分别读两文件状态栏 | 隔离性：查询缺失只降级涉事语言——java 仍 tree-sitter（GRF-04 判据）、rust 完全不受影响（ts-* 正常）；两文件无交叉污染 | —（隔离性锚） |

## 3. 关联缺陷的验收行为

### BUG-106 SPA-fallback 200 text/html 误载 grammar 资产（回归防护缺口）

**缺陷现状**：
- manifest 面（050ae69，终审 M5）：release 二进制 SPA fallback 把缺失 manifest 兜底成 200 index.html，`res.json()` 抛 SyntaxError 走 catch，warn 误导为网络错；
- 查询面（7fab3a5，终审 C1）：113/307 查询目录缺 injections.scm 时前端 fetch 得 200 HTML 误载为查询文本，Query 编译抛错致整语言降级 hljs（lite 盘面五语言处降级态）；修复=server 层 .scm/.wasm 回 404 + 前端 remoteQueryLoader 对 200 text/html 视同缺失。
- 两修复各只有单测（050ae69「补单测钉该分支」）与 cargo 集成用例，无浏览器端回归锚。

**修复后应有行为（回归验收）**：
1. manifest 200 text/html → 层缺失 + 「非 JSON 资产应答（SPA fallback？）」warn 恰一条，不误报网络错（GRF-01/06/07）。
2. 同源层缺失时 CDN 层兜底照常（first-wins 跨层不受嗅探影响，GRF-02）。
3. 查询 .scm 200 text/html → 视同缺失：highlights.scm 照常、语言不整降级（GRF-04/08）。
4. wasm 被HTML 兜底 → 捕获失败降级 hljs，不崩不误报（GRF-03）。
5. 回归不破坏：正常 JSON manifest（application/json）零误伤（GRF-05）。

## 4. 环境与数据

### 4.1 套件与 helper

- default 套件；spec：`apps/web/e2e/b-grammar-spa-fallback.spec.ts`（自包含；`openDir/openFile` 装置与 drawer 适配复制 b-grammar-layers.spec.ts 同款手法，公共 drawer.ts 复用既有 helper 不另建）。
- 构建期前提：`VV_GRAMMAR_CDN=https://cdn.grammars.test/grammars/ pnpm build`（vite define 静态替换进 highlightClient.ts；b-grammar-layers.spec.ts 头注同款口径——CI e2e job 已设该 env）。

### 4.2 夹具构造

| 夹具 | 规格 | 用于场景 |
| --- | --- | --- |
| Hello.java | 短小 java 源（tree-sitter 与 hljs 均可识别，b-grammar-layers 同款） | GRF-01/02/03/04/07/08 |
| sample.rs | 基础样例 | GRF-05/08 |
| SPA 页面应答 | `<!DOCTYPE html><html>…</html>` 最小 doctype 页，content-type `text/html; charset=utf-8`（GRF-06 变体去 content-type 头） | 全部 mock |

### 4.3 边界与注意事项

1. `serviceWorkers: 'block'` 强制（b-grammar-layers.spec.ts:33 已知边界：SW CacheFirst 拦不住 page.route）。
2. 跨源 mock（CDN 域）fulfill 必须显式 `access-control-allow-origin: *`；同源 mock 的 glob 用负向前瞻排除 cdn host（双星吞 scheme/host 的已知坑，b-grammar-layers.spec.ts:64 注释）。
3. warn 计数用 console 事件监听在 goto 前挂载，避免漏计。
4. java 的角色与既有用例一致：同源 manifest 剥离 java 条目模拟 lite 集（`request.get('/grammars/manifest.json')` 取真清单后 delete，防硬编码漂移）。
