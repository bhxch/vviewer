//! 语言注册表（生成式）：全部语言来自 grammars-manifest.json，grammar 由
//! server/build.rs 源码编译，查询三件套（highlights/injections/locals）由其
//! 生成物 grammar_entries.rs 经 include! 并入本模块（OUT_DIR），与前端 worker
//! 共用同一份 vendored helix 查询。`; inherits: a,b` 头在构建
//! HighlightConfiguration 前按文件类别递归展开（父在前、子在后，visited 防环）。
//!
//! sanitize 逐文件降级（spec §2.2）：highlights.scm 编译失败剔除整个语言
//! （请求侧表现为 400 unsupported language）；injections/locals 编译失败置空
//! 保底。注入已接线（阶段 1，spec §2.2）：Highlighter 的 injection_callback
//! 经 [`config_ref`] 从全局注册表解析注入语言配置。

use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use once_cell::sync::Lazy;
use tree_sitter::Language;
use tree_sitter_highlight::HighlightConfiguration;
use tree_sitter_language::LanguageFn;

/// 语法 + 查询三件套（injections/locals 已接线）。
struct LanguageEntry {
    name: &'static str,
    language: LanguageFn,
    highlights: &'static str,
    injections: &'static str,
    locals: &'static str,
}

include!(concat!(env!("OUT_DIR"), "/grammar_entries.rs"));

/// sanitize 逐文件降级（spec §2.2）：highlights 失败才剔除语言，
/// injections/locals 失败置空保底（用 tree_sitter::Query 预编译校验）。
static ENTRIES: Lazy<Vec<LanguageEntry>> = Lazy::new(|| {
    let mut entries = Vec::new();
    for (name, language, highlights, injections, locals) in generated_entries() {
        let lang = Language::from(language);
        let compile = |text: &'static str| matches!(tree_sitter::Query::new(&lang, text), Ok(_));
        if !compile(highlights) {
            tracing::warn!("language {name} highlights.scm 编译失败，剔除");
            continue;
        }
        let injections = if compile(injections) { injections } else {
            tracing::warn!("language {name} injections.scm 编译失败，置空保底");
            ""
        };
        let locals = if compile(locals) { locals } else {
            tracing::warn!("language {name} locals.scm 编译失败，置空保底");
            ""
        };
        entries.push(LanguageEntry { name, language, highlights, injections, locals });
    }
    entries
});

/// 非语言的查询目录（`; inherits` 展开目标；build.rs 扫描 assets 顶层生成）：
/// 三件套按 [Highlights, Injections, Locals]（`Kind::slot`）下标存放，三类别
/// 各自回退；partial 构建下会含缺源语言目录（固有语义，全量时收敛为真父目录）。
static PARENT_ASSETS: Lazy<HashMap<&'static str, [&'static str; 3]>> = Lazy::new(|| {
    generated_parents()
        .into_iter()
        .map(|(name, highlights, injections, locals)| (name, [highlights, injections, locals]))
        .collect()
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

/// 查询文件类别：`; inherits` 链按类别独立展开（highlights/injections/locals
/// 的父目录引用互不混淆）。
#[derive(Clone, Copy)]
enum Kind {
    Highlights,
    Injections,
    Locals,
}

impl Kind {
    /// ENTRIES 字段选择与 PARENT_ASSETS 数组下标的统一映射。
    fn slot(self) -> usize {
        match self {
            Kind::Highlights => 0,
            Kind::Injections => 1,
            Kind::Locals => 2,
        }
    }
}

/// 递归展开某语言/父目录的指定类别查询：父查询在前、自身在后。
/// `visited` 防环（静态资产本无环，防御性保留）；找不到返回 None。
fn expand_asset(name: &str, kind: Kind, visited: &mut HashSet<String>) -> Option<String> {
    if !visited.insert(name.to_string()) {
        return Some(String::new()); // 环：不再重复展开
    }
    let own = ENTRIES
        .iter()
        .find(|e| e.name == name)
        .map(|e| match kind {
            Kind::Highlights => e.highlights,
            Kind::Injections => e.injections,
            Kind::Locals => e.locals,
        })
        .or_else(|| PARENT_ASSETS.get(name).map(|a| a[kind.slot()]))?;
    let mut merged = String::new();
    for parent in parse_inherits(own) {
        if let Some(expanded) = expand_asset(parent, kind, visited) {
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
        let expanded = expand_asset(entry.name, Kind::Highlights, &mut HashSet::new()).unwrap_or_default();
        collect_capture_names(&expanded, &mut names);
    }
    names.sort();
    names
});

/// 语言名 → 编译好的高亮配置（三件套传入，injections/locals 生效）；展开合并
/// 后查询仍与 grammar 节点类型不匹配的语言在构建期剔除（请求侧表现为 400
/// unsupported language），并输出 warn 日志。
static CONFIGS: Lazy<HashMap<&'static str, Arc<HighlightConfiguration>>> = Lazy::new(|| {
    let names = Lazy::force(&HIGHLIGHT_NAMES);
    let mut map = HashMap::new();
    for entry in ENTRIES.iter() {
        let Some(expanded) = expand_asset(entry.name, Kind::Highlights, &mut HashSet::new()) else {
            continue;
        };
        // injections/locals 同样经各自的 inherits 链展开（父目录按 Kind 回退）
        let injections = expand_asset(entry.name, Kind::Injections, &mut HashSet::new()).unwrap_or_default();
        let locals = expand_asset(entry.name, Kind::Locals, &mut HashSet::new()).unwrap_or_default();
        match HighlightConfiguration::new(
            Language::from(entry.language),
            entry.name,
            &expanded,
            &injections,
            &locals,
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

/// 注入回调与 handler 共用的 'static 配置引用（Arc 存于全局 static，引用恒活）。
pub fn config_ref(lang: &str) -> Option<&'static HighlightConfiguration> {
    CONFIGS.get(lang).map(|c| &**c)
}

/// build.rs 生成 grammar 计数（partial 诊断与全量门禁测试用）。
pub fn generated_count() -> usize {
    GENERATED_COUNT
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
        let cpp = expand_asset("cpp", Kind::Highlights, &mut HashSet::new()).unwrap();
        assert!(cpp.contains("(identifier) @variable"), "c 父查询在前: {cpp}");
        assert!(!cpp.contains("; inherits:"), "指令行已剥离");

        let ts = expand_asset("typescript", Kind::Highlights, &mut HashSet::new()).unwrap();
        assert!(ts.contains("(identifier) @variable"), "ecma 在前");
        assert!(ts.contains("ambient_declaration"), "_typescript 自身在后期拼接: {ts}");
        assert!(!ts.contains("; inherits:"));

        // tsx 专属查询（review fix 2）：inherits 三父展开，含 jsx 节点模式
        let tsx = expand_asset("tsx", Kind::Highlights, &mut HashSet::new()).unwrap();
        assert!(tsx.contains("ambient_declaration"), "_typescript 父");
        assert!(tsx.contains("jsx_self_closing_element"), "_jsx 父: {tsx}");
        assert!(!tsx.contains("; inherits:"));
        // tsx 与 typescript 展开结果不同（tsx 额外带 jsx 模式）
        assert!(tsx.len() > ts.len(), "tsx 应为 typescript 展开的超集");

        // 父目录资产不可直接作为语言请求
        assert!(ENTRIES.iter().all(|e| e.name != "ecma"));
        assert!(expand_asset("no-such-lang", Kind::Highlights, &mut HashSet::new()).is_none());
    }

    #[test]
    fn all_entries_compile_and_register() {
        let langs = supported_languages();
        assert_eq!(langs.len(), ENTRIES.len(), "全部语言查询应编译通过: {langs:?}");
        for expected in ["rust", "python", "bash", "json", "go", "c", "cpp", "javascript", "typescript", "tsx", "yaml", "toml", "html", "css", "java"] {
            assert!(langs.contains(&expected), "缺少 {expected}: {langs:?}");
        }
    }

    /// CI 全量门禁（grammar.yml 全源环境断言；partial 本地构建跳过）。
    #[test]
    fn full_registry_count_is_301() {
        if generated_count() < 301 {
            eprintln!("partial 构建（{}/301），跳过全量门禁", generated_count());
            return;
        }
        assert_eq!(supported_languages().len(), 301);
        assert_eq!(generated_count(), 301);
    }

    #[test]
    fn html_injections_wired_for_script() {
        let html = ENTRIES.iter().find(|e| e.name == "html").expect("html entry");
        assert!(html.injections.contains("script"), "html injections 应含 script 注入规则");
        assert!(config_ref("javascript").is_some(), "注入子语言配置应可解析");
    }

    #[test]
    fn parents_include_all_inherit_targets() {
        let parents = Lazy::force(&PARENT_ASSETS);
        for p in ["ecma", "_typescript", "_jsx", "_javascript"] {
            assert!(parents.contains_key(p), "缺父目录 {p}: {:?}", parents.keys());
        }
        // 修复轮 1：父目录嵌入三件套——ecma injections 资产非空且可取用
        let ecma = parents.get("ecma").unwrap();
        let lens: Vec<usize> = ecma.iter().map(|s| s.len()).collect();
        assert!(!ecma[Kind::Injections.slot()].is_empty(), "ecma injections 应已嵌入: {lens:?}");
    }

    /// js 族 injections/locals 的父链展开（修复轮 1）：ecma/_typescript/_javascript
    /// 的 injections/locals 嵌入后，`; inherits` 指向父目录的规则不再丢失。
    #[test]
    fn js_family_injections_locals_expand_parent_chain() {
        // ecma/injections.scm 的稳定特征行（tagged template 注入规则谓词）
        const ECMA_INJ: &str = r#"(#any-of? @injection.language "html" "css" "json" "sql" "js" "ts" "bash")"#;
        let js = expand_asset("javascript", Kind::Injections, &mut HashSet::new()).unwrap();
        assert!(js.contains(ECMA_INJ), "javascript injections 应含 ecma 父模式: {js}");
        assert!(!js.contains("; inherits:"), "指令行已剥离");

        // tsx injections 头 `; inherits: _jsx,_typescript,ecma`——_jsx/_typescript 无
        // injections 资产（物化空串），可观察内容来自 ecma 父
        let tsx_inj = expand_asset("tsx", Kind::Injections, &mut HashSet::new()).unwrap();
        assert!(tsx_inj.contains(ECMA_INJ), "tsx injections 应含 ecma 父模式: {tsx_inj}");
        assert!(!tsx_inj.contains("; inherits:"));

        // tsx locals 同头三父：_typescript 与 ecma 均有实体 locals，应一并展开
        let tsx_loc = expand_asset("tsx", Kind::Locals, &mut HashSet::new()).unwrap();
        assert!(tsx_loc.contains("(type_alias_declaration)"), "_typescript locals 父: {tsx_loc}");
        assert!(tsx_loc.contains("(for_in_statement)"), "ecma locals 父: {tsx_loc}");
        assert!(!tsx_loc.contains("; inherits:"));

        // javascript locals 头 `; inherits: _javascript,ecma`——_javascript locals 实体展开
        let js_loc = expand_asset("javascript", Kind::Locals, &mut HashSet::new()).unwrap();
        assert!(js_loc.contains("@local.definition.variable.parameter"), "_javascript locals 父: {js_loc}");
        assert!(js_loc.contains("(for_in_statement)"), "ecma locals 父: {js_loc}");
    }

    #[test]
    fn highlight_names_cover_common_captures() {
        let names = Lazy::force(&HIGHLIGHT_NAMES);
        for expect in ["keyword", "string", "comment", "function", "variable", "type"] {
            assert!(names.iter().any(|n| n == expect || n.starts_with(&format!("{expect}."))), "{expect}: {names:?}");
        }
    }
}
