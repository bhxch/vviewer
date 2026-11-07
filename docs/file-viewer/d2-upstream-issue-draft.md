# d2 上游报障 issue 草稿（B1，2026-11-07 编制——只起草不外发，外发由用户决策）

对象：`@d2lang/d2`（npm，wasm 引擎分发包）/ terrastruct d2 上游。起草依据：本仓 CI 稳定化实测证据（`.superpowers/sdd/ci-stabilize-report.md` §一「DSV-06」），下文「Evidence」均可在该报告与本仓 trace artifact 复核。外发前需用户确认：①是否点名具体 chromium 版本策略；②是否附本仓业务上下文（建议剥离，只保留最小复现）；③英文文本可再润色。

---

## Issue draft（英文，可直接粘贴）

**Title:** `@d2lang/d2@0.1.34` ESM wasm engine: intermittent silent hang or uninformative worker error on Chromium 156 (+esm fetch 200s, then no error events, no further requests)

**Environment**

- Package: `@d2lang/d2@0.1.34` loaded via jsDelivr `+esm` bundle (~11.5 MB, inline compressed wasm: ~11.3 MB base64 → in-memory decompress; wasm itself costs zero extra network requests)
- Runtime: module worker created from a blob URL (`wasm_exec` inlined) → `WebAssembly.instantiate` + go runtime (`go.run`)
- Browser: Chromium 156 (Playwright-managed, headless and headed both observed)
- Host app: client-side file viewer, dynamic `import('https://cdn.jsdelivr.net/npm/@d2lang/d2@0.1.34/+esm')` on first d2 diagram render

**Symptom**

After the `+esm` module fetch completes (HTTP 200, consistently 2.6–3.2 s in our traces), the engine chain intermittently enters one of two failure modes:

1. **Silent hang**: `instantiate`/`go.run` never settles; no error events, no further network requests, no page lifecycle signals (page stays active). Awaiting the import/ready chain for 80–100 s does not resolve.
2. **Fast error with no detail**: worker reports a generic `"D2 worker encountered an error"` with no underlying error payload; no subsequent network activity.

Both modes are intermittent and phase-like: identical probe code ran 6/6 green in one phase and hung in another on the same machine; a local green phase showed the full compile chain completing in ~4 s.

**What we ruled out**

- Service Worker / CacheFirst caching: a no-SW control run hung identically.
- Bandwidth/CDN latency: `curl` fetches of the same `+esm` URL complete in 2.1–4.8 s at ~5.3 MB/s; the hang occurs *after* the 200.
- Timeouts being too short: budget sweeps at 80 s×2, 100 s (and 90 s×2 in the no-SW control) all hung.
- Page throttling/backgrounding: reproduced with the page focused and active.

**Minimal repro sketch**

```js
// in a Chromium 156 page (module context):
const t0 = performance.now();
const mod = await import('https://cdn.jsdelivr.net/npm/@d2lang/d2@0.1.34/+esm'); // 200s in ~3s
// then drive the engine the way the bundle does internally:
//   blob module worker (wasm_exec inline) → instantiate → go.run
// observed: occasionally never settles; occasionally generic worker error, no detail
```

（若上游需要，可补一个不依赖宿主应用的独立 repro 页；本仓可提供 trace 与 HAR。）

**Expected**

- `instantiate`/`go.run` either completes deterministically or surfaces a structured error (with the underlying exception/wasm trap) via `worker.onerror`/`messageerror` or a rejected promise.
- A hang with zero observability (no error events, no network) looks like a lost exception inside the worker or an unresolved Go runtime start — even a `console.error` with the original stack would make this diagnosable downstream.

**Questions**

1. Is the inline base64 → in-memory decompress path of the wasm known to be sensitive to memory pressure under specific V8/Chromium versions?
2. Does the bundled `wasm_exec` glue register a top-level error handler that could swallow the original error before re-emitting the generic message?
3. Any known incompatibility with Chromium 156 specifics (module worker + WASM SIMD/threads flags)?

---

## 内部备注（外发前删除本节）

- 证据锚：ci-stabilize-report.md §一「DSV-06」——`+esm` fetch 2.6-3.2s 200（trace 实证）、80s×2/100s/noSW 90s×2 预算扫描全挂、6/6 绿相位对照、noSW 对照排除 SW/带宽。
- 本仓侧缓解（已落码，与本 issue 独立成立）：b-diagram-server-kroki DSV-06 预热门（引擎不可用即 skip 本轮，e967204/663fc3a）；门维持至上游修复或自托管分发面落地。
- chromium 156 为本仓 e2e Playwright 锁定形态；若上游要求具体小版本，从 `npx playwright --version` 对应浏览器构建取 revision 再补。
- 候选后续：d2 引擎自托管 wasm/换分发面（ci-stabilize concerns 1 原文）——上游有结论前不动。
