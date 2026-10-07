//! 语言注册表（Task 3）：tree-sitter grammar 子集 + helix 风格 highlights.scm。
//!
//! 查询资产经 `include_str!` 编译期嵌入（`../../..` 自 `server/src/compute/`
//! 回到仓库根，指向 packages/highlight/assets/queries/——与前端 worker 共用
//! 同一份 vendored helix 查询，无需构建脚本拷贝）。`; inherits: a,b` 头在
//! 构建 HighlightConfiguration 时递归展开（父在前、子在后，visited 防环）。
//!
//! M6 裁剪（计划级裁决）：服务端 v1 无 injection——只加载 highlights.scm，
//! injections/locals 查询传空串，请求时 injection_callback 恒 None。
//! markdown 围栏等注入场景由前端本地高亮兜底（policy=local）。

use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use once_cell::sync::Lazy;
use tree_sitter::Language;
use tree_sitter_highlight::HighlightConfiguration;
use tree_sitter_language::LanguageFn;

/// 语法 + 查询三件套之一：语言名、grammar 的 LanguageFn、highlights.scm 全文。
struct LanguageEntry {
    name: &'static str,
    language: LanguageFn,
    highlights: &'static str,
}

macro_rules! query {
    ($lang:literal) => {
        include_str!(concat!(
            "../../../packages/highlight/assets/queries/",
            $lang,
            "/highlights.scm"
        ))
    };
}

/// 实装 grammar 子集（13 个，crates.io 官方/可用 crate 实测全装上；
/// typescript crate 同时携带 tsx grammar，按 helix 查询目录名暴露 typescript）。
static ENTRIES: Lazy<Vec<LanguageEntry>> = Lazy::new(|| {
    vec![
        LanguageEntry { name: "rust", language: tree_sitter_rust::LANGUAGE, highlights: query!("rust") },
        LanguageEntry { name: "python", language: tree_sitter_python::LANGUAGE, highlights: query!("python") },
        LanguageEntry { name: "bash", language: tree_sitter_bash::LANGUAGE, highlights: query!("bash") },
        LanguageEntry { name: "json", language: tree_sitter_json::LANGUAGE, highlights: query!("json") },
        LanguageEntry { name: "go", language: tree_sitter_go::LANGUAGE, highlights: query!("go") },
        LanguageEntry { name: "c", language: tree_sitter_c::LANGUAGE, highlights: query!("c") },
        LanguageEntry { name: "cpp", language: tree_sitter_cpp::LANGUAGE, highlights: query!("cpp") },
        LanguageEntry { name: "javascript", language: tree_sitter_javascript::LANGUAGE, highlights: query!("javascript") },
        LanguageEntry { name: "typescript", language: tree_sitter_typescript::LANGUAGE_TYPESCRIPT, highlights: query!("typescript") },
        LanguageEntry { name: "tsx", language: tree_sitter_typescript::LANGUAGE_TSX, highlights: query!("typescript") },
        LanguageEntry { name: "yaml", language: tree_sitter_yaml::LANGUAGE, highlights: query!("yaml") },
        LanguageEntry { name: "toml", language: tree_sitter_toml_ng::LANGUAGE, highlights: query!("toml") },
        LanguageEntry { name: "html", language: tree_sitter_html::LANGUAGE, highlights: query!("html") },
        LanguageEntry { name: "css", language: tree_sitter_css::LANGUAGE, highlights: query!("css") },
    ]
});

/// 仅作 inherits 父目录的查询资产（本身不是可请求的语言名）：
/// `; inherits: ecma,_typescript` 的展开目标，均已在 assets 顶层 vendored。
static PARENT_ASSETS: Lazy<HashMap<&'static str, &'static str>> = Lazy::new(|| {
    HashMap::from([
        ("ecma", query!("ecma")),
        ("_typescript", query!("_typescript")),
        ("_jsx", query!("_jsx")),
    ])
});

/// 从查询头部解析 `; inherits: a,b`（仅扫描首个非注释/非空行之前）。
fn parse_inherits(content: &str) -> Vec<&str> {
    for line in content.lines() {
        let line = line.trim();
        if let Some(rest) = line.strip_prefix("; inherits:") {
            return rest.split(',').map(str::trim).filter(|s| !s.is_empty()).collect();
        }
        // 头部注释区结束即停（inherits 必须在首个指令/模式之前）
        if !line.starts_with(';') && !line.is_empty() {
            return Vec::new();
        }
    }
    Vec::new()
}

/// 去掉 `; inherits:` 行（展开后不再保留指令）。
fn strip_inherits_line(content: &str) -> String {
    let mut out = String::with_capacity(content.len());
    let mut removed = false;
    for line in content.lines() {
        if !removed && line.trim().starts_with("; inherits:") {
            removed = true;
            continue;
        }
        out.push_str(line);
        out.push('\n');
    }
    out
}

/// 递归展开某语言/父目录的 highlights.scm：父查询在前、自身在后。
/// `visited` 防环（静态资产本无环，防御性保留）；找不到返回 None。
fn expand_asset(name: &str, visited: &mut HashSet<String>) -> Option<String> {
    if !visited.insert(name.to_string()) {
        return Some(String::new()); // 环：不再重复展开
    }
    let own = ENTRIES
        .iter()
        .find(|e| e.name == name)
        .map(|e| e.highlights)
        .or_else(|| PARENT_ASSETS.get(name).copied())?;
    let mut merged = String::new();
    for parent in parse_inherits(own) {
        if let Some(expanded) = expand_asset(parent, visited) {
            merged.push_str(&expanded);
        }
    }
    merged.push_str(&strip_inherits_line(own));
    Some(merged)
}

/// 从展开后的查询文本收集命名捕获（供 configure 的高亮名表）。
/// `@_xxx`（下划线开头）是查询内部捕获，不进表。
fn collect_capture_names(query_text: &str, out: &mut Vec<String>) {
    let bytes = query_text.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'@' {
            let start = i + 1;
            let mut end = start;
            while end < bytes.len() && (bytes[end].is_ascii_alphanumeric() || bytes[end] == b'_' || bytes[end] == b'.' || bytes[end] == b'-') {
                end += 1;
            }
            let name = &query_text[start..end];
            if !name.starts_with('_') && !out.iter().any(|n| n == name) {
                out.push(name.to_string());
            }
            i = end;
        } else {
            i += 1;
        }
    }
}

/// 全局高亮名表：所有语言查询的命名捕获去重排序（configure 的属性索引
/// 按此表下标发出，Highlight(h) → HIGHLIGHT_NAMES[h]）。
pub static HIGHLIGHT_NAMES: Lazy<Vec<String>> = Lazy::new(|| {
    let mut names = Vec::new();
    for entry in ENTRIES.iter() {
        let expanded = expand_asset(entry.name, &mut HashSet::new()).unwrap_or_default();
        collect_capture_names(&expanded, &mut names);
    }
    names.sort();
    names
});

/// 语言名 → 编译好的高亮配置；查询与 grammar 节点类型不匹配的语言在构建期
/// 剔除（请求侧表现为 400 unsupported language），并输出 warn 日志。
static CONFIGS: Lazy<HashMap<&'static str, Arc<HighlightConfiguration>>> = Lazy::new(|| {
    let names = Lazy::force(&HIGHLIGHT_NAMES);
    let mut map = HashMap::new();
    for entry in ENTRIES.iter() {
        let Some(expanded) = expand_asset(entry.name, &mut HashSet::new()) else {
            continue;
        };
        match HighlightConfiguration::new(
            Language::from(entry.language),
            entry.name,
            &expanded,
            "", // injections：v1 无注入（见模块注释）
            "", // locals：tree-sitter-highlight 不消费 helix locals 语义
        ) {
            Ok(mut config) => {
                config.configure(names);
                map.insert(entry.name, Arc::new(config));
            }
            Err(e) => {
                tracing::warn!("language {} highlights query 编译失败，已剔除: {e}", entry.name);
            }
        }
    }
    map
});

/// 语言是否可用（已注册且查询编译通过）。
pub fn is_supported(lang: &str) -> bool {
    CONFIGS.contains_key(lang)
}

/// 取语言配置（handler 在 spawn_blocking 内调用）。
pub fn config(lang: &str) -> Option<Arc<HighlightConfiguration>> {
    CONFIGS.get(lang).cloned()
}

/// 支持的语言名列表（错误信息与调试用）。
pub fn supported_languages() -> Vec<&'static str> {
    let mut names: Vec<&'static str> = CONFIGS.keys().copied().collect();
    names.sort_unstable();
    names
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_inherits_header_variants() {
        assert_eq!(parse_inherits("; inherits: ecma,_typescript\n(x) @k\n"), vec!["ecma", "_typescript"]);
        assert_eq!(parse_inherits("; comment\n\n; inherits: c\n(x)\n"), vec!["c"]);
        // inherits 之后的指令行不再扫描
        assert!(parse_inherits("(x) @k\n; inherits: c\n").is_empty());
        assert!(parse_inherits("(x) @k\n").is_empty());
    }

    #[test]
    fn strip_inherits_keeps_rest() {
        let out = strip_inherits_line("; inherits: c\n\n; 常量\n(x) @constant\n");
        assert_eq!(out, "\n; 常量\n(x) @constant\n");
    }

    #[test]
    fn cpp_inherits_c_and_typescript_inherits_ecma_and_typescript_base() {
        let cpp = expand_asset("cpp", &mut HashSet::new()).unwrap();
        assert!(cpp.contains("(identifier) @variable"), "c 父查询在前: {cpp}");
        assert!(!cpp.contains("; inherits:"), "指令行已剥离");

        let ts = expand_asset("typescript", &mut HashSet::new()).unwrap();
        assert!(ts.contains("(identifier) @variable"), "ecma 在前");
        assert!(ts.contains("ambient_declaration"), "_typescript 自身在后期拼接: {ts}");
        assert!(!ts.contains("; inherits:"));

        // 父目录资产不可直接作为语言请求
        assert!(ENTRIES.iter().all(|e| e.name != "ecma"));
        assert!(expand_asset("no-such-lang", &mut HashSet::new()).is_none());
    }

    #[test]
    fn all_entries_compile_and_register() {
        let langs = supported_languages();
        assert_eq!(langs.len(), ENTRIES.len(), "全部语言查询应编译通过: {langs:?}");
        for expected in ["rust", "python", "bash", "json", "go", "c", "cpp", "javascript", "typescript", "tsx", "yaml", "toml", "html", "css"] {
            assert!(langs.contains(&expected), "缺少 {expected}: {langs:?}");
        }
    }

    #[test]
    fn highlight_names_cover_common_captures() {
        let names = Lazy::force(&HIGHLIGHT_NAMES);
        for expect in ["keyword", "string", "comment", "function", "variable", "type"] {
            assert!(names.iter().any(|n| n == expect || n.starts_with(&format!("{expect}."))), "{expect}: {names:?}");
        }
    }
}
