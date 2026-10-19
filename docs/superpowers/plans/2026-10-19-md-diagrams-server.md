# Markdown 服务端图表渲染 Implementation Plan（spec §2.5）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `--compute` 服务端在 markdown compute 输出后处理中把 graphviz/dot 与 svgbob 围栏渲染为内联 SVG（markpad Rust 栈同款），health 细分宣告 `diagrams` 子集；前端 auto 路由细化（仅图表/math 围栏的文档可远程）并把服务端产物接回标准 wrapper（图/源码切换一致体验）。

**Architecture:** Rust 侧 `server/src/compute/diagrams.rs` 纯函数（fence 扫描→实体反解码→layout-rs/svgbob 渲染→div 替换，失败保留原 fence），挂在 `compute::markdown::render` 出口；health 仿 computeLanguages 增 `diagrams` 字段。前端 `runDiagrams` 前置 `wrapServerDiagrams` 预步（`[data-vv-diagram="server"]` 接回标准 wrapper，经提取的 buildDiagramWrapper 共享构造），viewer.ts 的 BUG-22 localOnly 启发式细化为「存在非图表语言围栏才留本地」。

**Tech Stack:** layout-rs 0.1（`layout` lib）、svgbob 0.7、comrak 0.56 输出扫描、axum 集成测试（tower oneshot 既有模式）、vitest/playwright。

**Spec:** `docs/superpowers/specs/2026-10-19-markdown-markpad-alignment-design.md` §2.5

## Global Constraints

- 服务端原生集仅 `graphviz`（别名 `dot`）与 `svgbob`；plantuml 系/mermaid/其他不实现（失败/非原生围栏保留原 fence 由客户端接手）。
- 服务端 SVG 直出必须过前端 sanitize：**不得含 `<style>` 子元素、不得用外链 `<img>`**（BUG-17 外域剥除）；`data-*` 标记可存活（ALLOW_DATA_ATTR）。
- 不新增 CLI 旗标：随 `--compute` 门控（路由层既有），health 在 compute 分支内细分宣告 `diagrams: ["graphviz","svgbob"]`，非 compute 整体省略。
- 客户端按语言模式（local/kroki/source）与服务端路径正交（spec §2.5 边界），前端不因模式设置拦截服务端产物。
- auto 路由细化口径：围栏语言 ∈ 图表注册表（含 math）不触发 localOnly；无语言围栏与非图表语言围栏仍触发（BUG-22 高亮语义不变）。
- Rust 测试：纯函数单测在 `src/compute/markdown.rs`/`diagrams.rs` 的 `mod tests`；集成在 `server/tests/compute_markdown.rs`（fixture/oneshot 既有模式）；health 断言仿 `compute_advertises_sorted_full_registry`。
- 每任务原子提交；cargo 测试勿与 vitest 并发跑（watch 时序互扰教训）。

---

### Task 1: Rust 图表渲染模块

**Files:**
- Modify: `server/Cargo.toml`（dependencies 加 layout-rs、svgbob）
- Create: `server/src/compute/diagrams.rs`
- Modify: `server/src/compute/mod.rs`（mod 声明）
- Create: `server/src/compute/diagrams.rs` 内 `#[cfg(test)] mod tests`

**Interfaces:**
- Produces: `pub fn replace_diagram_fences(html: &str) -> String`（Task 2 消费）；内部 `render_diagram_svg(lang, source) -> Option<String>`、`unescape_code(s) -> String`（单测锚）。
- 产物 DOM 契约（Task 3 消费）：`<div data-vv-diagram="server" data-diagram-lang="<lang>" data-diagram-src="<HTML 属性转义源码>">SVG</div>`；渲染失败/非原生语言**原样保留** `<pre><code …>`。

- [ ] **Step 1: 写失败测试**

```rust
// server/src/compute/diagrams.rs mod tests（随实现一起建，先写测试再实现）
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unescape_code_roundtrip() {
        assert_eq!(unescape_code("a -&gt; b &amp; &lt;x&gt; &quot;q&quot; &#39;f&#39;"), "a -> b & <x> \"q\" 'f'");
        assert_eq!(unescape_code("&#x27;"), "'");
        assert_eq!(unescape_code("plain"), "plain");
    }

    #[test]
    fn replaces_graphviz_fence_with_server_div() {
        let html = "<p>前</p><pre><code class=\"language-dot\">digraph { a -&gt; b }</code></pre><p>后</p>";
        let out = replace_diagram_fences(html);
        assert!(out.contains("data-vv-diagram=\"server\""), "{out}");
        assert!(out.contains("data-diagram-lang=\"dot\""));
        assert!(out.contains("<svg"), "layout-rs 应产出 svg：{out}");
        assert!(!out.contains("<pre><code class=\"language-dot\""), "原 fence 应被替换：{out}");
        assert!(out.contains("<p>前</p>") && out.contains("<p>后</p>"), "前后文保留：{out}");
    }

    #[test]
    fn svgbob_fence_replaced() {
        let html = "<pre><code class=\"language-svgbob\">+---+   |a|</code></pre>";
        let out = replace_diagram_fences(html);
        assert!(out.contains("data-diagram-lang=\"svgbob\""), "{out}");
        assert!(out.contains("<svg"), "{out}");
    }

    #[test]
    fn parse_failure_leaves_fence_untouched() {
        let html = "<pre><code class=\"language-graphviz\">digraph { a -&gt;</code></pre>";
        let out = replace_diagram_fences(html);
        assert_eq!(out, html, "layout-rs 解析失败应原样保留（客户端接手）");
    }

    #[test]
    fn non_native_languages_untouched() {
        let html = "<pre><code class=\"language-mermaid\">graph TD;</code></pre><pre><code class=\"language-rust\">fn main() {}</code></pre>";
        assert_eq!(replace_diagram_fences(html), html);
    }

    #[test]
    fn multiple_fences_independent() {
        let html = "<pre><code class=\"language-dot\">digraph{a}</code></pre><pre><code class=\"language-graphviz\">broken -&gt;</code></pre>";
        let out = replace_diagram_fences(html);
        assert!(out.contains("data-vv-diagram=\"server\""), "首个成功：{out}");
        assert!(out.contains("<pre><code class=\"language-graphviz\""), "第二个失败保留：{out}");
    }
}
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cargo test --manifest-path server/Cargo.toml diagrams`（先加依赖与空实现骨架使其可编译：diagrams.rs 仅含函数签名 `todo!()` 或直接返回入参）
Expected: FAIL（断言未过/模块缺失）

- [ ] **Step 3: 实现 diagrams.rs**

```rust
// server/src/compute/diagrams.rs — 服务端图表围栏渲染（spec 2026-10-19 §2.5）。
// markpad Rust 栈同款：graphviz=layout-rs、svgbob=svgbob crate（纯 Rust，无 Java/进程）。
// comrak 输出后处理：原生集围栏替换为内联 SVG div；解析失败/非原生语言原样保留
//（客户端管线接手）。SVG 不得含 <style>/外链 img（前端 sanitize 约束，layout-rs/
// svgbob 直出均为无 style 的自包含 svg，实施时以单测锚定）。
use layout::backends::svg::SVGWriter;
use layout::gv::{DotParser, GraphBuilder};

/// 服务端原生图表语言（含别名）。与前端注册表的本子集对齐（graphviz+dot/svgbob）。
const NATIVE: &[(&str, &str)] = &[("graphviz", "graphviz"), ("dot", "graphviz"), ("svgbob", "svgbob")];

fn render_diagram_svg(canon: &str, source: &str) -> Option<String> {
    match canon {
        "graphviz" => {
            let mut parser = DotParser::new(source);
            let graph = parser.process().ok()?;
            let mut builder = GraphBuilder::new();
            builder.visit_graph(&graph);
            let mut visual_graph = builder.get();
            let mut svg_writer = SVGWriter::new();
            visual_graph.do_it(false, false, false, &mut svg_writer);
            Some(svg_writer.finalize())
        }
        "svgbob" => Some(svgbob::to_svg(source)),
        _ => None,
    }
}

/// comrak 围栏实体反解码（comrak 只转义这五个）。
fn unescape_code(s: &str) -> String {
    s.replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&amp;", "&")
}

/// HTML 属性值转义（data-diagram-src 承载原文供前端源码面板）。
fn escape_attr(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;")
}

/// comrak 输出后处理：graphviz/dot/svgbob 围栏 → 服务端渲染 div。
/// 扫描 `<pre><code class="language-X">…</code></pre>`（comrak 输出形态恒定，
/// code 内无嵌套 pre）；渲染失败保留原块。返回新 HTML（无改动时原串语义不变）。
pub fn replace_diagram_fences(html: &str) -> String {
    const OPEN: &str = "<pre><code class=\"language-";
    const CLOSE: &str = "</code></pre>";
    let mut out = String::with_capacity(html.len());
    let mut rest = html;
    loop {
        let Some(start) = rest.find(OPEN) else {
            out.push_str(rest);
            break;
        };
        let after_open = &rest[start + OPEN.len()..];
        let Some(lang_end_rel) = after_open.find("\">") else {
            out.push_str(rest);
            break;
        };
        let lang = &after_open[..lang_end_rel];
        let Some(canon) = NATIVE.iter().find(|(n, _)| *n == lang).map(|(_, c)| *c) else {
            // 非原生语言：原样拷到该 fence 之后继续扫
            let consume = OPEN.len() + lang_end_rel + 2;
            out.push_str(&rest[..start + consume]);
            rest = &rest[start + consume..];
            continue;
        };
        let body_start = start + OPEN.len() + lang_end_rel + 2;
        let Some(body_len) = rest[body_start..].find(CLOSE) else {
            out.push_str(rest);
            break;
        };
        let escaped = &rest[body_start..body_start + body_len];
        let source = unescape_code(escaped);
        let consumed_end = body_start + body_len + CLOSE.len();
        match render_diagram_svg(canon, &source) {
            Some(svg) => {
                out.push_str(&rest[..start]);
                out.push_str(&format!(
                    "<div data-vv-diagram=\"server\" data-diagram-lang=\"{}\" data-diagram-src=\"{}\">{}</div>",
                    lang,
                    escape_attr(&source),
                    svg
                ));
                rest = &rest[consumed_end..];
            }
            None => {
                // 失败保留原 fence：原样拷到块尾继续扫
                out.push_str(&rest[..consumed_end]);
                rest = &rest[consumed_end..];
            }
        }
    }
    out
}
```

Cargo.toml `[dependencies]` 加（comrak 行之后）：

```toml
# 服务端图表渲染（spec 2026-10-19 §2.5，markpad Rust 栈同款）
layout-rs = "0.1"
svgbob = "0.7"
```

`server/src/compute/mod.rs` 加 `mod diagrams;`（若 mod.rs 用 pub(crate) 风格则跟随；diagrams 对外仅被 markdown.rs 同 crate 使用，无需 pub）。

- [ ] **Step 4: 跑测试确认通过**

Run: `cargo test --manifest-path server/Cargo.toml diagrams`
Expected: 6 passed。若 layout-rs 对某合法 dot 串渲染失败（子集限制），换更简单的测试 dot（如 `digraph{a->b}`）并把「子集外特性失败保留」语义用该例锚定。

- [ ] **Step 5: Commit**

```bash
git add server/Cargo.toml server/Cargo.lock server/src/compute/diagrams.rs server/src/compute/mod.rs
git commit -m "feat(server): 服务端图表渲染模块——layout-rs/svgbob 围栏后处理，失败保留原 fence"
```

---

### Task 2: compute/markdown 接线 + health 宣告 + 集成测试

**Files:**
- Modify: `server/src/compute/markdown.rs`（render() 出口接线 + 单测）
- Modify: `server/src/routes/health.rs`（diagrams 字段 + 单测）
- Modify: `server/tests/compute_markdown.rs`（集成用例）

**Interfaces:**
- Consumes: Task 1 `replace_diagram_fences`。
- Produces: `/api/compute/markdown` 响应含服务端图表 div；`GET /api/health` 在 compute 时多 `diagrams:["graphviz","svgbob"]`。

- [ ] **Step 1: 写失败测试**

markdown.rs `mod tests` 追加：

```rust
    #[test]
    fn render_replaces_native_diagram_fence() {
        let html = render("```dot\ndigraph { a -> b }\n```", false);
        assert!(html.contains("data-vv-diagram=\"server\""), "{html}");
    }
```

health.rs `mod tests` 追加（仿既有 compute 断言用例的 base_state 模式）：

```rust
    #[tokio::test]
    async fn compute_advertises_diagram_subset() {
        let app = build_router(base_state(true));
        let res = app.oneshot(Request::get("/api/health").body(Body::empty()).unwrap()).await.unwrap();
        let body: serde_json::Value = serde_json::from_slice(&into_bytes(res).await).unwrap();
        assert_eq!(body["diagrams"], serde_json::json!(["graphviz", "svgbob"]));
    }
```

（helper 名以文件内既有为准：`into_bytes`/`base_state` 不存在时照抄同文件相邻用例的取 body 方式与 state 构造。）

server/tests/compute_markdown.rs 追加：

```rust
#[tokio::test]
async fn markdown_renders_graphviz_fence_server_side() {
    let (app, _dir) = fixture(true, None);
    let body = serde_json::json!({ "text": "```dot\ndigraph { a -> b }\n```" });
    let res = post_json(&app, "/api/compute/markdown", &body).await;
    assert_eq!(res.status(), 200);
    let json: serde_json::Value = serde_json::from_slice(&into_bytes(res).await).unwrap();
    assert!(json["html"].as_str().unwrap().contains("data-vv-diagram=\"server\""));
    assert!(json["html"].as_str().unwrap().contains("<svg"));
}

#[tokio::test]
async fn markdown_keeps_broken_diagram_fence_for_client() {
    let (app, _dir) = fixture(true, None);
    let body = serde_json::json!({ "text": "```graphviz\ndigraph { a ->\n```" });
    let res = post_json(&app, "/api/compute/markdown", &body).await;
    let json: serde_json::Value = serde_json::from_slice(&into_bytes(res).await).unwrap();
    let html = json["html"].as_str().unwrap();
    assert!(html.contains("<pre><code class=\"language-graphviz\""), "失败保留原 fence：{html}");
    assert!(!html.contains("data-vv-diagram"));
}
```

（`into_bytes`/`post_json` 以该文件既有 helper 为准；无则照相邻用例读 body 的写法。）

- [ ] **Step 2: 跑测试确认失败**

Run: `cargo test --manifest-path server/Cargo.toml --test compute_markdown markdown_renders_graphviz && cargo test --manifest-path server/Cargo.toml compute_advertises_diagram`
Expected: FAIL

- [ ] **Step 3: 接线实现**

markdown.rs `render()` 尾行改：

```rust
    crate::compute::diagrams::replace_diagram_fences(&comrak::markdown_to_html(&prepared, &options))
```

（`mod diagrams;` 可见性按 Task 1 声明调整；render 无改动语义——非原生/失败围栏原样。）

health.rs：Health 结构加字段（compute_languages 之后）：

```rust
    /// 服务端图表渲染子集（spec §2.5；随 compute 门控，非 compute 省略）
    #[serde(rename = "diagrams", skip_serializing_if = "Option::is_none")]
    pub diagrams: Option<Vec<&'static str>>,
```

组装分支（`state.compute` 内）加 `diagrams: Some(vec!["graphviz", "svgbob"]),`；非 compute 分支（结构体字面量另一构造处）`diagrams: None`。同文件既有 Health 构造点（tests 的 base_state 等）同步补字段。

- [ ] **Step 4: 跑全部 Rust 测试确认通过**

Run: `cargo test --manifest-path server/Cargo.toml`
Expected: 全绿（含既有 11 套件）

- [ ] **Step 5: Commit**

```bash
git add server/src/compute/markdown.rs server/src/routes/health.rs server/tests/compute_markdown.rs
git commit -m "feat(server): compute markdown 接线服务端图表+health diagrams 子集宣告"
```

---

### Task 3: 前端路由细化 + 服务端图 wrapper 集成

**Files:**
- Modify: `apps/web/src/lib/viewer.ts`（BUG-22 启发式细化；提取纯函数导出）
- Modify: `packages/render-text/src/markdown/pipeline.ts`（提取 buildDiagramWrapper + runDiagrams 前置 wrapServerDiagrams）
- Modify: `packages/render-text/src/markdown/markdownRenderer.ts`（若 wrapper 构造提取涉及导出——预计不需要）
- Test: `packages/render-text/src/markdown/pipeline.diagrams.test.ts`（追加 server 预步用例）、`apps/web/src/lib/viewer.fence.test.ts`（新建）

**Interfaces:**
- Consumes: Task 2 服务端 DOM 契约（`[data-vv-diagram="server"]`+`data-diagram-lang`+`data-diagram-src`）、Plan 1 注册表 `resolveDiagramType`、Plan 1 wrapper 构造。
- Produces: `hasNonDiagramFence(text: string): boolean`（viewer.ts 导出，单测锚）；pipeline 内 `buildDiagramWrapper(doc, opts: { langLabel: string; highlightLang: string; ctx: PipelineCtx }): { wrap; toggle?; view; sourcePane; sourceCode }`（toggle 在 source-only 场景不生成——沿用终审后 source 分支语义）。

- [ ] **Step 1: 写失败测试**

```ts
// apps/web/src/lib/viewer.fence.test.ts
import { describe, expect, it } from 'vitest';
import { hasNonDiagramFence } from './viewer';

describe('hasNonDiagramFence（BUG-22 启发式细化）', () => {
  it('纯图表/math 围栏 → false（可路由服务端）', () => {
    expect(hasNonDiagramFence('```graphviz\\ndigraph{a}\\n```')).toBe(false);
    expect(hasNonDiagramFence('```dot\\ndigraph{a}\\n```\\n```math\\nE=mc^2\\n```')).toBe(false);
  });
  it('无语言围栏/普通语言围栏 → true（留本地，高亮语义不变）', () => {
    expect(hasNonDiagramFence('```\nfn main() {}\n```')).toBe(true);
    expect(hasNonDiagramFence('```rust\nfn main() {}\n```')).toBe(true);
  });
  it('混合（图表+普通）→ true；无围栏 → false', () => {
    expect(hasNonDiagramFence('```mermaid\\ngraph TD;\\n```\\n```rust\\nx\\n```')).toBe(true);
    expect(hasNonDiagramFence('纯文本')).toBe(false);
  });
  it('行首 ≤3 空格容忍与 ~~~ 围栏（既有启发式语义）', () => {
    expect(hasNonDiagramFence('   ```rust\\nx\\n```')).toBe(true);
    expect(hasNonDiagramFence('~~~graphviz\\ndigraph{a}\\n~~~')).toBe(false);
  });
});
```

pipeline.diagrams.test.ts 追加：

```ts
it('服务端图表 div 接回标准 wrapper（图/源码切换一致）', async () => {
  const doc = document.implementation.createHTMLDocument('');
  doc.body.innerHTML = '<div data-vv-diagram="server" data-diagram-lang="dot" data-diagram-src="digraph{a}"><svg viewBox="0 0 1 1"></svg></div>';
  await runPipeline(doc, baseCtx);
  const wrap = doc.querySelector('.md-diagram')!;
  expect(wrap).not.toBeNull();
  expect(wrap.querySelector('.md-diagram-view svg')).not.toBeNull();
  expect(wrap.querySelector('.md-diagram-view[data-mermaid]')).toBeNull(); // 非 mermaid 无锚
  const src = wrap.querySelector('.md-diagram-source code')!;
  expect(src.textContent).toBe('digraph{a}');
  expect((wrap.querySelector('.md-diagram-toggle') as HTMLElement)).not.toBeNull();
});

it('服务端 div 的 data-diagram-src 经属性反解码为原文', async () => {
  const doc = document.implementation.createHTMLDocument('');
  doc.body.innerHTML = '<div data-vv-diagram="server" data-diagram-lang="svgbob" data-diagram-src="a -&gt; b"><svg/></div>';
  await runPipeline(doc, baseCtx);
  expect(doc.querySelector('.md-diagram-source code')!.textContent).toBe('a -> b');
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run apps/web/src/lib/viewer.fence.test.ts packages/render-text/src/markdown/pipeline.diagrams.test.ts`
Expected: FAIL（hasNonDiagramFence 不存在；server div 无 wrapper）

- [ ] **Step 3: 实现**

3a. pipeline.ts 重构提取（保既有测试全绿为锁）：把 renderDiagramBlock 内 wrapper 构造段抽成

```ts
function buildDiagramWrapper(
  doc: Document,
  ctx: PipelineCtx,
  opts: { langLabel: string; highlightLang: string; source: string; withToggle: boolean }
): { wrap: HTMLElement; toggle: HTMLButtonElement | null; view: HTMLElement; sourcePane: HTMLElement; sourceCode: HTMLElement } {
  // 原 L143-166 构造段移入；withToggle=false 时跳过 toggle 创建与监听（source-only 形态）
}
```

renderDiagramBlock 三分支改用返回值（行为零变化，既有单测/断言为行为锁）；runDiagrams 开头插入：

```ts
    wrapServerDiagrams(root, ctx);

function wrapServerDiagrams(root: Document, ctx: PipelineCtx): void {
  for (const el of Array.from(root.querySelectorAll('[data-vv-diagram="server"]'))) {
    if (el.hasAttribute('data-md-diagram-wrapped')) continue;
    el.setAttribute('data-md-diagram-wrapped', '');
    const lang = el.getAttribute('data-diagram-lang') ?? '';
    const source = el.getAttribute('data-diagram-src') ?? '';
    const type = resolveDiagramType(lang);
    const w = buildDiagramWrapper(el.ownerDocument, ctx, {
      langLabel: lang,
      highlightLang: type?.highlightLang ?? '',
      source,
      withToggle: true
    });
    w.view.appendChild(el); // svg 原样搬入视图面板（sanitize 已过）
    el.removeAttribute('data-vv-diagram'); // 防二次命中
    el.replaceWith(w.wrap);
    w.sourcePane.setAttribute('hidden', '');
    if (w.toggle) {
      w.toggle.addEventListener('click', () => {
        const showSource = w.sourcePane.hasAttribute('hidden');
        w.sourcePane.toggleAttribute('hidden', !showSource);
        w.view.toggleAttribute('hidden', showSource);
        w.toggle!.textContent = showSource ? '图' : '源码';
      });
    }
  }
}
```

（与 renderDiagramBlock 的切换监听同构——如 review 认为重复，允许把切换监听一并提为 `wireDiagramToggle(toggle, view, sourcePane)` 共享，二选一以 reviewer 意见为准。）

3b. viewer.ts：BUG-22 段改用新纯函数（viewer.ts 顶部或 BUG-22 段上方定义并 export）：

```ts
/** BUG-22 启发式细化（spec §2.5）：图表/math 围栏由服务端渲染无需本地高亮，
 * 仅「存在非图表语言或无语言围栏」才强制留本地。行首 ≤3 空格容忍不变。 */
export function hasNonDiagramFence(text: string): boolean {
  let m: RegExpExecArray | null;
  const fence = /^[ \t]{0,3}(?:```|~~~)([^\n`]*)/gm;
  while ((m = fence.exec(text)) !== null) {
    const lang = (m[1] ?? '').trim().split(/\\s/)[0] ?? '';
    if (!resolveDiagramType(lang)) return true;
  }
  return false;
}
```

L127 改：`const localOnly = policy === 'auto' && hasNonDiagramFence(text);`

（import 处加 resolveDiagramType——viewer.ts 已有 diagrams import 则合并。注意原正则对 ``` 后任意字符的匹配改为捕获语言词；反引号类排除照原样保留语义。）

- [ ] **Step 4: 跑测试确认通过 + 双端回归**

Run: `pnpm vitest run packages/render-text apps/web/src/lib/viewer.fence.test.ts apps/web/src/lib` && `pnpm typecheck`
Expected: 全绿（既有 pipeline 契约用例零翻转——重构为行为锁）

- [ ] **Step 5: Commit**

```bash
git add packages/render-text/src/markdown/pipeline.ts packages/render-text/src/markdown/pipeline.diagrams.test.ts apps/web/src/lib/viewer.ts apps/web/src/lib/viewer.fence.test.ts
git commit -m "feat(md): 服务端图表接回标准 wrapper+auto 路由细化——图表围栏不再强制留本地"
```

---

### Task 4: 服务端 e2e

**Files:**
- Create: `apps/web/e2e-server/b-compute-diagrams.spec.ts`

**Interfaces:**
- Consumes: e2e-server 既有 fixture（release 二进制 + `--compute` 起服，t-cmp 系同款）。

- [ ] **Step 1: 写用例**（对照 apps/web/e2e-server/ 既有 spec 的起服/打开文件 helper 模式）：

```ts
import { expect, test } from '@playwright/test';

test.describe('b-compute-diagrams 服务端图表', () => {
  test('auto 策略下图表围栏文档路由服务端（启发式细化生效）', async ({ page }) => {
    // 打开含 graphviz fence 的 md（连接 --compute 服务端，策略默认 auto）
    // 断言：.md-diagram-view 内有服务端产物（svg 且容器 data-md-diagram-wrapped）
    // 状态栏「渲染: 远程」可见（routeMarkdown where=remote 的既有指示器）
  });
  test('graphviz fence 服务端 svg + 图/源码切换', async ({ page }) => {
    // svg visible；toggle 点击后源码面板展示原文
  });
  test('解析失败围栏客户端接手', async ({ page }) => {
    // 非法 dot：服务端保留 fence → 客户端管线接手（local 引擎渲染失败 → md-diagram-error + 原文）
  });
});
```

（骨架注释处按 t-cmp 系既有 helper 落实现；服务端健康等待/基址复用既有 playwright.server.config 与全局 setup。）

- [ ] **Step 2: 跑通**

Run: `pnpm --filter web build:e2e && pnpm --filter web exec playwright test --config playwright.server.config b-compute-diagrams`
Expected: 3 passed（命令行以仓库既有 server 套件跑法为准）

- [ ] **Step 3: Commit**

```bash
git add apps/web/e2e-server/b-compute-diagrams.spec.ts
git commit -m "test(e2e-server): 服务端图表三用例——auto 路由/切换/失败接手"
```

---

### Task 5: 门禁与文档

**Files:**
- Modify: `README.md`（服务端图表一行）、`docs/superpowers/specs/2026-10-19-markdown-markpad-alignment-design.md`（§7 测试节补服务端路径已落地注记可选）

- [ ] **Step 1: README 行**（图表矩阵行追加「；--compute 服务端原生渲染 graphviz/svgbob（health `diagrams` 宣告）」）
- [ ] **Step 2: 全量门禁**：`pnpm typecheck && pnpm vitest run && cargo test --manifest-path server/Cargo.toml && pnpm --filter web build:e2e && node tools/diagram-budget.mjs`（vitest 既有 1 败=grammar-builder 环境项，stash 复核非本计划引入即可）
- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs(md): 服务端图表渲染能力同步 README"
```
