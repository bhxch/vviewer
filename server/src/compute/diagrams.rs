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

