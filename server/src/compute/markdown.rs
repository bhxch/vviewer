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
    // ==mark== / ++ins++（spec §4.1，markpad 同款）；行内脚注 ^[note]。三者均为
    // comrak 0.56 Extension 选项（inline_footnotes 并非 Parse 选项，上游文档示例
    // 即 options.extension.inline_footnotes）。与前端 markdown-it mark/ins/deflist
    // 插件对齐（金标互引见 tests highlight_and_insert_extensions /
    // inline_footnote_renders 及 packages/render-text/test/markdownEngine.test.ts
    // Task 2 用例）。
    ext.highlight = true;
    ext.insert = true;
    ext.inline_footnotes = true;
    // heading id 用 GitHub 同款前缀命名空间，避免嵌入页面时撞 DOM id。
    // header_id_prefix_in_href（BUG-39 清偿，2026-10-17）：comrak 0.56 默认自产锚
    // href 不带前缀（仿 GitHub 依赖其前端 JS 做 hash→前缀映射），本仓库前端无该
    // 逻辑，纯远程档自产锚 href 与 heading id 自不一致（页内锚死链）——开启后
    // href 与 id 同带前缀，自一致；前端 remapHeadingHashLinks 再把作者无前缀
    // 页内链接映射到命名空间 id（渲染期 DOM 改写，GitHub 映射的确定性等价形态）。
    ext.header_id_prefix = Some("user-content-".to_string());
    ext.header_id_prefix_in_href = true;
    options.render.r#unsafe = true; // raw HTML 透传——净化职责在前端管线
    options.render.hardbreaks = false;

    let prepared = apply_latex_delimiters(text);
    let prepared = if wikilinks { apply_wikilinks(&prepared) } else { prepared };
    // 服务端图表围栏后处理（spec §2.5）：原生集（graphviz/dot/svgbob）替换为内联
    // SVG div；解析失败/非原生语言原样保留（客户端管线接手）。
    crate::compute::diagrams::replace_diagram_fences(&markdown_to_html(&prepared, &options))
}

/// 行首围栏判定：Some((围栏字符, 数量))。开围栏 = 行首 ≤3 空格缩进 + 3+ 个反引号
/// （info 串不得含反引号——否则按 CommonMark 是行内码起点，不算围栏）或 3+ 个波浪线
/// （info 串任意）；闭围栏（open=false）= 同形态且行内仅剩空白。
fn fence_of(body: &str, open: bool) -> Option<(char, usize)> {
    let stripped = body.trim_start_matches(' ');
    if body.len() - stripped.len() > 3 {
        return None;
    }
    let mut chars = stripped.chars();
    let ch = chars.next()?;
    if ch != '`' && ch != '~' {
        return None;
    }
    // 数量按字符数=字节数（`/~ 均单字节），下述切片索引安全
    let count = 1 + chars.take_while(|&c| c == ch).count();
    if count < 3 {
        return None;
    }
    let rest = &stripped[count..];
    if open {
        if ch == '`' && rest.contains('`') {
            return None;
        }
        Some((ch, count))
    } else {
        (rest.chars().all(|c| c == ' ' || c == '\t')).then_some((ch, count))
    }
}

/// LaTeX 定界符前置改写（Task 1b，markpad local_commands.rs markdown_ext
/// process_latex_delimiters 同款语义；前端对偶实现见
/// packages/render-text/src/markdown/engine.ts protectLatexDelimiters）：
/// `\(..\)`→`$..$`、`\[..\]`→`$$..$$`——comrak 按 CommonMark 消费 `\(`/`\[` 的
/// 反斜杠转义，数学定界符到不了解析器，先于解析统一成上游 math 词汇 $/$$
/// （数学渲染归前端管线 katex 步，本crate 数学扩展不启用）。
///
/// 跳过规则：围栏码块（fence_of 行语义，```/~~~）整段透传；单反引号行内码 span
/// （状态跨行持续）内透传。继承性边界（markpad Task 14 审查补记同款，只记录不改
/// 行为）：双反引号行内码翻转两次后失同步、4 空格缩进码块不跟踪，其中的
/// `\[…\]`/`\(…\)` 仍会被转换。未闭合数学：缓冲内容原样回填、开定界符不还原
/// （markpad 同款）。先于 apply_wikilinks（原始用户文本最先改写，wikilink 锚
/// HTML 产物不被本状态机触碰）。
fn apply_latex_delimiters(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut fence: Option<(char, usize)> = None;
    let mut in_inline_code = false;
    let mut in_display = false;
    let mut in_inline = false;
    let mut math = String::new();

    // CRLF/CR 入口归一化（修复轮 1/m1，与前端 protectLatexDelimiters 同款）：按
    // \n 切行残留的 \r 会卡死闭围栏判定（fence_of 仅容空白）；CommonMark 本就视
    // \r\n 为换行，归一化不改渲染语义
    let normalized = text.replace("\r\n", "\n").replace('\r', "\n");
    let lines: Vec<&str> = normalized.split('\n').collect();
    for (li, line) in lines.iter().enumerate() {
        if li > 0 {
            if in_display || in_inline {
                math.push('\n');
            } else {
                out.push('\n');
            }
        }
        match fence {
            Some((ch, len)) => {
                out.push_str(line);
                if let Some((c2, n2)) = fence_of(line, false) {
                    if c2 == ch && n2 >= len {
                        fence = None;
                    }
                }
            }
            None => {
                if let Some((ch, len)) = fence_of(line, true) {
                    fence = Some((ch, len));
                    out.push_str(line);
                    continue;
                }
                // 非围栏行：` 行内码翻转 → 码内透传 → 数学进出（markpad 状态机同款）
                let mut chars = line.chars().peekable();
                while let Some(c) = chars.next() {
                    if c == '`' && !in_display && !in_inline {
                        in_inline_code = !in_inline_code;
                        out.push('`');
                        continue;
                    }
                    if in_inline_code {
                        out.push(c);
                        continue;
                    }
                    let next = chars.peek().copied();
                    if !in_display && !in_inline {
                        match (c, next) {
                            ('\\', Some('[')) => {
                                in_display = true;
                                math.clear();
                                out.push_str("$$");
                                chars.next();
                            }
                            ('\\', Some('(')) => {
                                in_inline = true;
                                math.clear();
                                out.push('$');
                                chars.next();
                            }
                            _ => out.push(c),
                        }
                    } else if in_display {
                        if c == '\\' && next == Some(']') {
                            in_display = false;
                            out.push_str(&math);
                            out.push_str("$$");
                            math.clear();
                            chars.next();
                        } else {
                            math.push(c);
                        }
                    } else if c == '\\' && next == Some(')') {
                        in_inline = false;
                        out.push_str(&math);
                        out.push('$');
                        math.clear();
                        chars.next();
                    } else {
                        math.push(c);
                    }
                }
            }
        }
    }
    if in_display || in_inline {
        out.push_str(&math);
    }
    out
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

    #[test]
    fn heading_anchor_href_matches_id_including_prefix_and_duplicates() {
        // BUG-39：自产锚 href 与 heading id 必须自一致（header_id_prefix_in_href），
        // 且重名标题按 GFM -1 起去重时 id 与 href 同步——无前缀时代 href 缺前缀、
        // 作者页内链接指向裸 slug 均死链。
        let html = render("# 中文标题\n\n## 中文标题\n\n[跳转](#中文标题)\n", true);
        assert!(html.contains(r##"<h1 id="user-content-中文标题">"##), "{html}");
        assert!(html.contains(r##"<h2 id="user-content-中文标题-1">"##), "{html}");
        assert!(
            html.contains(r##"href="#user-content-中文标题" aria-label"##),
            "{html}"
        );
        assert!(
            html.contains(r##"href="#user-content-中文标题-1" aria-label"##),
            "{html}"
        );
        // 作者页内链接保持作者视角的裸 slug hash（comrak 按惯例百分号编码非 ASCII，
        // 解码映射归前端 remapHeadingHashLinks 的 decode 路径）
        assert!(
            html.contains(r##"href="#%E4%B8%AD%E6%96%87%E6%A0%87%E9%A2%98""##),
            "{html}"
        );
    }

    #[test]
    fn render_replaces_native_diagram_fence() {
        let html = render("```dot\ndigraph { a -> b }\n```", false);
        assert!(html.contains("data-vv-diagram=\"server\""), "{html}");
    }

    #[test]
    fn latex_delimiters_rewritten() {
        // Task 1b：\(..\)→$..$、\[..\]→$$..$$（comrak 数学扩展未启用，改写产物为
        // 字面文本；管线 katex 步在前端接力渲染）
        let html = render("\\(a^2\\)\n", true);
        assert!(html.contains("$a^2$"), "{html}");
        assert!(!html.contains("\\("), "{html}");
        let html = render("\\[b_2\\]\n", true);
        assert!(html.contains("$$b_2$$"), "{html}");
        assert!(!html.contains("\\["), "{html}");
    }

    #[test]
    fn latex_delimiters_skip_fences_and_inline_code() {
        let html = render("```\n\\(x\\)\n```\n", true);
        assert!(html.contains("\\(x\\)"), "{html}");
        assert!(!html.contains("$x$"), "{html}");
        let html = render("~~~\n\\(x\\)\n~~~\n", true);
        assert!(html.contains("\\(x\\)"), "{html}");
        let html = render("前 `\\(x\\)` 后\n", true);
        assert!(html.contains("\\(x\\)"), "{html}");
    }

    #[test]
    fn latex_delimiters_noop_without_delimiters() {
        let src = "价格 $100 与 $200，普通 (括号)\n";
        assert_eq!(apply_latex_delimiters(src), src);
        assert_eq!(apply_latex_delimiters("no math"), "no math");
    }

    #[test]
    fn latex_delimiters_unclosed_keeps_content_without_closer() {
        // markpad 同款：未闭合时内容回填、开定界符已消耗（不还原）
        assert_eq!(apply_latex_delimiters("未闭 \\(abc"), "未闭 $abc");
        assert_eq!(apply_latex_delimiters("跨行 \\[a\nb"), "跨行 $$a\nb");
    }

    #[test]
    fn latex_delimiters_crlf_fences_close_and_rewrite_outside() {
        // CRLF 残留 \r 不得卡死闭围栏判定；归一化后围栏内保留、围栏外转换
        assert_eq!(
            apply_latex_delimiters("```\r\n\\(x\\)\r\n```\r\n\\(a\\)"),
            "```\n\\(x\\)\n```\n$a$"
        );
    }

    #[test]
    fn highlight_and_insert_extensions() {
        // ==mark== / ++ins++（spec §4.1，markpad 同款）；本地对偶金标：
        // packages/render-text/test/markdownEngine.test.ts「扩展语法（Task 2）」
        // mark/ins 用例——形态一致以两侧断言互为锚。
        let html = render("==mark== 与 ++ins++", false);
        assert!(html.contains("<mark>mark</mark>"), "{html}");
        assert!(html.contains("<ins>ins</ins>"), "{html}");
    }

    #[test]
    fn inline_footnote_renders() {
        // 行内脚注 ^[note]（parser.inline_footnotes）；本地对偶金标：
        // packages/render-text/test/markdownEngine.test.ts 脚注用例（[^1] 定义式，
        // markdown-it 脚注插件）——footnote-ref 形态一致以两侧断言互为锚。
        let html = render("正文^[注内容]续", false);
        assert!(html.contains("footnote-ref"), "{html}");
        assert!(html.contains("注内容"), "{html}");
    }
}
