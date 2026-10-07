//! comrak markdown 渲染（Task 2）：GFM 全扩展 + wikilink 预处理。
//!
//! 裁剪（M6 计划级裁决）：comrak 数学扩展（math_dollars/math_code）不启用、
//! 无数学掩码；输出必经前端既有净化管线（DOMPurify 同类），服务端 unsafe
//! 只是保证 raw HTML/生成的 wikilink 锚元素不被 comrak 转义。

use comrak::{markdown_to_html, Options};

/// markdown 渲染输入上限（UTF-8 字节）：超限请求 413。
pub const MARKDOWN_MAX_BYTES: usize = 5 * 1024 * 1024;

/// GFM 全扩展渲染：table/strikethrough/tasklist/autolink/footnotes/
/// description_lists/shortcodes + heading id（comrak 的 header_id_prefix）。
/// hardbreaks 保持 false（单换行是软换行，GitHub 语义）。
pub fn render(text: &str, wikilinks: bool) -> String {
    let mut options = Options::default();
    let ext = &mut options.extension;
    ext.table = true;
    ext.strikethrough = true;
    ext.tasklist = true;
    ext.autolink = true;
    ext.footnotes = true;
    ext.description_lists = true;
    ext.shortcodes = true;
    // heading id 用 GitHub 同款前缀命名空间，避免嵌入页面时撞 DOM id
    ext.header_id_prefix = Some("user-content-".to_string());
    options.render.r#unsafe = true; // raw HTML 透传——净化职责在前端管线
    options.render.hardbreaks = false;

    let prepared = if wikilinks { apply_wikilinks(text) } else { text.to_string() };
    markdown_to_html(&prepared, &options)
}

/// `[[target|text]]` / `[[target]]` → `<a class="vv-wikilink" data-target="…">text</a>`。
///
/// comrak 之前的文本预处理（不引 regex 依赖，单遍扫描）：无闭合 `]]` 的 `[[`
/// 与空 target 原样保留；target/label 仅做 HTML 转义保证属性与标签边界完整
/// （markdown 内联格式仍可能在 label 中被 comrak 解析，与 GitHub wikilink 行
/// 为一致）；data-target 非 URL 语义，链接净化由前端管线负责。
fn apply_wikilinks(text: &str) -> String {
    let mut out = String::with_capacity(text.len() + 32);
    let mut rest = text;
    while let Some(open) = rest.find("[[") {
        out.push_str(&rest[..open]);
        let after = &rest[open + 2..];
        match after.find("]]") {
            Some(close) => {
                let inner = &after[..close];
                let (target, label) = match inner.find('|') {
                    Some(pipe) => (&inner[..pipe], &inner[pipe + 1..]),
                    None => (inner, inner),
                };
                if target.is_empty() {
                    // `[[]]`：无链接语义，原样保留整段
                    out.push_str(&rest[..open + 2 + close + 2]);
                } else {
                    out.push_str("<a class=\"vv-wikilink\" data-target=\"");
                    out.push_str(&escape_html(target));
                    out.push_str("\">");
                    out.push_str(&escape_html(label));
                    out.push_str("</a>");
                }
                rest = &after[close + 2..];
            }
            None => {
                // 无闭合 `]]`：`[[` 原样保留，从其后继续找下一个候选
                out.push_str("[[");
                rest = after;
            }
        }
    }
    out.push_str(rest);
    out
}

/// HTML 文本/属性值转义：& < > "（属性用双引号包裹，转义后不会提前终止）。
fn escape_html(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            _ => out.push(c),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wikilink_text_form_and_bare_form() {
        let html = render("see [[docs/index|首页]] and [[notes]]\n", true);
        assert!(html.contains(r#"<a class="vv-wikilink" data-target="docs/index">首页</a>"#), "{html}");
        assert!(html.contains(r#"<a class="vv-wikilink" data-target="notes">notes</a>"#), "{html}");
    }

    #[test]
    fn wikilink_disabled_by_default_and_escapes_attrs() {
        assert!(!render("[[x]]\n", false).contains("vv-wikilink"));
        assert!(render("[[x]]\n", true).contains("vv-wikilink"));
        // 引号不提前终止属性；尖括号转义不产生伪标签
        let html = render("[[a\"<b>|t]]\n", true);
        assert!(html.contains(r#"data-target="a&quot;&lt;b&gt;""#), "{html}");
        assert!(!html.contains(r#"data-target="a""#), "{html}");
    }

    #[test]
    fn wikilink_unclosed_and_empty_target_preserved() {
        assert!(render("a [[open b\n", true).contains("a [[open b"));
        assert!(render("[[]] x\n", true).contains("[[]]"));
    }

    #[test]
    fn gfm_extensions_render() {
        let html = render("| a | b |\n|---|---|\n| 1 | 2 |\n", true);
        assert!(html.contains("<table") && html.contains("<th>a</th>"), "{html}");
        let html = render("- [x] done\n- [ ] todo\n", true);
        assert!(html.contains("checkbox") && html.contains("checked"), "{html}");
        let html = render("x[^1]\n\n[^1]: note\n", true);
        assert!(html.contains("footnote-ref") && html.contains("footnotes"), "{html}");
        let html = render("~~gone~~\n", true);
        assert!(html.contains("<del>gone</del>"), "{html}");
    }

    #[test]
    fn soft_breaks_stay_soft_and_raw_html_passes_through() {
        assert_eq!(render("a\nb\n", true), "<p>a\nb</p>\n");
        assert!(render("<div class=\"x\">raw</div>\n", true).contains(r#"<div class="x">raw</div>"#));
    }
}
