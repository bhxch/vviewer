// server/src/compute/diagrams.rs — 服务端图表围栏渲染（spec 2026-10-19 §2.5）。
// markpad Rust 栈同款：graphviz=layout-rs、svgbob=svgbob crate（纯 Rust，无 Java/进程）。
// comrak 输出后处理：原生集围栏替换为内联 SVG div；解析失败/非原生语言原样保留
//（客户端管线接手）。SVG 含引擎生成的 <style>（layout-rs 仅字体类；svgbob 固定描边
// 规则 + 用户提供 CSS——`# Legend:` 语法 `name = {css}` 原样并入 style 块），由前端
// sanitize 上下文豁免承载——uponSanitizeElement 钩子对 [data-vv-diagram=server] 内
// style 按归一化危险 token 判定放行或整节点丢弃（Task 3 落地，2026-10-19 控制器裁决；
// Legend CSS 外泄面由该全量判定兜住）；不得用外链 img 的约束不变（实测两引擎直出均无 img）。

use layout::backends::svg::SVGWriter;
use layout::gv::{DotParser, GraphBuilder};

/// 服务端原生图表语言（含别名）。与前端注册表的本子集对齐（graphviz+dot/svgbob）。
const NATIVE: &[(&str, &str)] = &[("graphviz", "graphviz"), ("dot", "graphviz"), ("svgbob", "svgbob")];

/// 语言别名 → 服务端原生规范名（走 NATIVE 表，大小写不敏感——M1 同款语义）。
/// 围栏后处理与单图渲染端点（spec 2026-10-23 §8.1）共用此唯一匹配点；未知
/// 语言 None（围栏走非原生分支原样保留 / 端点 400）。
pub fn canonical_of(lang: &str) -> Option<&'static str> {
    NATIVE.iter().find(|(n, _)| n.eq_ignore_ascii_case(lang)).map(|(_, c)| *c)
}

/// 单图渲染（规范语言名 → SVG）：graphviz=layout-rs、svgbob=svgbob crate。
/// Task 4（spec §8.1）起 `pub` 供 /api/compute/diagram 端点直调——调用方先
/// 经 [`canonical_of`] 归一；围栏后处理（[`replace_diagram_fences`]）为既有
/// 消费方。失败 None（端点 400 / 围栏保留原样交客户端）。
pub fn render_diagram_svg(canon: &str, source: &str) -> Option<String> {
    match canon {
        "graphviz" => {
            let mut parser = DotParser::new(source);
            let graph = parser.process().ok()?;
            let mut builder = GraphBuilder::new();
            builder.visit_graph(&graph);
            let mut visual_graph = builder.get();
            // 零节点图（`digraph{}`）解析成功但 do_it 内 assert!(!is_empty) 必 panic——
            // 无 CatchPanicLayer 下整请求连接重置（终审 C2）。可判空先早退（保原 fence
            // 语义），catch_unwind 兜底双保险：do_it 路径上的其他 panic 形态（上游库
            // 版本演进）同样降级为失败保留，不出 500/连接重置。
            if visual_graph.num_nodes() == 0 {
                return None;
            }
            // do_it/finalize 为外部 crate 代码，闭包内借用了本地状态——AssertUnwindSafe
            // 足够：panic 后这些状态即弃用（整个调用返回 None），无跨 panic 观察面。
            let rendered = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                let mut svg_writer = SVGWriter::new();
                visual_graph.do_it(false, false, false, &mut svg_writer);
                svg_writer.finalize()
            }));
            rendered.ok()
        }
        "svgbob" => Some(svgbob::to_svg(source)),
        _ => None,
    }
}

/// comrak 围栏实体反解码（comrak 只转义这五个；`'` 视版本/形式有 &#39; 与 &#x27; 两种）。
fn unescape_code(s: &str) -> String {
    s.replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&#x27;", "'")
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
        // 大小写不敏感（M1）：```DOT/```Graphviz 等围栏与 ```dot 同为原生集，
        // 不静默漏到「非原生」分支走客户端——匹配点与端点共用 canonical_of
        let Some(canon) = canonical_of(lang) else {
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
    fn canonical_of_maps_alias_and_is_case_insensitive() {
        // 规范名与别名（NATIVE 表）均归一到 graphviz；大小写不敏感与围栏 M1 同语义
        assert_eq!(canonical_of("graphviz"), Some("graphviz"));
        assert_eq!(canonical_of("dot"), Some("graphviz"));
        assert_eq!(canonical_of("DOT"), Some("graphviz"));
        assert_eq!(canonical_of("GraphViz"), Some("graphviz"));
        assert_eq!(canonical_of("svgbob"), Some("svgbob"));
        assert_eq!(canonical_of("SVGBOB"), Some("svgbob"));
        // 未知语言（端点 400 面）/空串 → None
        assert_eq!(canonical_of("mermaid"), None);
        assert_eq!(canonical_of("plantuml"), None);
        assert_eq!(canonical_of(""), None);
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
    fn empty_digraph_leaves_fence_untouched() {
        // 终审 C2：零节点图解析成功但 do_it 内 assert panic——修复后判空早退 +
        // catch_unwind 兜底，均降级为失败保留（原 fence 交客户端），不 panic 串请求
        let for_dot = "<pre><code class=\"language-dot\">digraph{}</code></pre>";
        assert_eq!(replace_diagram_fences(for_dot), for_dot);
        let for_graphviz =
            "<pre><code class=\"language-graphviz\">digraph { } node_in_name_only</code></pre>";
        assert_eq!(replace_diagram_fences(for_graphviz), for_graphviz);
    }

    #[test]
    fn uppercase_fence_language_renders_server_side() {
        // 终审 M1：NATIVE 匹配大小写不敏感——```DOT 不再静默走非原生分支
        let html = "<pre><code class=\"language-DOT\">digraph { a -&gt; b }</code></pre>";
        let out = replace_diagram_fences(html);
        assert!(out.contains("data-vv-diagram=\"server\""), "{out}");
        assert!(out.contains("data-diagram-lang=\"DOT\""), "原文语言保留供前端注册表归一: {out}");
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

    #[test]
    fn graphviz_svg_keeps_engine_style() {
        // spec §2.5 知情裁决（2026-10-19）：layout-rs 引擎生成的 <style> 由前端
        // sanitize 上下文豁免承载（uponSanitizeElement 钩子对 [data-vv-diagram=server]
        // 内 style 强制保留 + 危险 token 中和，Task 3 落地）。Rust 侧不得剥除。
        let html = "<pre><code class=\"language-dot\">digraph{a}</code></pre>";
        let out = replace_diagram_fences(html);
        assert!(out.contains("<style>"), "引擎生成的 <style> 应原样保留，勿在 Rust 侧剥除：{out}");
    }
}

