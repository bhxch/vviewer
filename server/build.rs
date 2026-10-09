//! server/build.rs：源码编译全部 grammar + 生成 grammar_entries.rs。
//! 语言清单来自入库的 grammars-manifest.json（Markpad 301 验收集合）；
//! grammar 源树由 tools/grammar-builder fetch 管线产出（VV_GRAMMAR_SOURCES，
//! 缺省 ../tools/grammar-builder/out/grammars）。源缺失的语言跳过编译
//! （partial 构建，本地开发友好）；CI 全量门禁以 GENERATED_COUNT==301 收口。
//! 工程手法移植自 Markpad build.rs（C++ scanner 手动 g++/ar/objcopy、
//! -std=gnu11、vue 符号 localize），见 spec §2.2。

use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

#[derive(serde::Deserialize)]
struct GrammarEntry {
    name: String,
    dir: String,
    subpath: String,
    #[serde(rename = "cSymbol")]
    c_symbol: String,
}

#[derive(serde::Deserialize)]
struct ManifestFile {
    grammars: Vec<GrammarEntry>,
}

fn main() {
    println!("cargo:rerun-if-changed=grammars-manifest.json");
    println!("cargo:rerun-if-env-changed=VV_GRAMMAR_SOURCES");

    let manifest: Vec<GrammarEntry> =
        serde_json::from_str::<ManifestFile>(include_str!("grammars-manifest.json")).expect("grammars-manifest.json").grammars;
    let sources_root = PathBuf::from(
        env::var("VV_GRAMMAR_SOURCES").unwrap_or_else(|_| "../tools/grammar-builder/out/grammars".into()),
    );
    let out_dir = PathBuf::from(env::var("OUT_DIR").unwrap());

    copy_queries(&out_dir);

    let mut built: Vec<&GrammarEntry> = Vec::new();
    let mut missing: Vec<&str> = Vec::new();
    for e in &manifest {
        let rel = if e.subpath.is_empty() { e.dir.clone() } else { format!("{}/{}", e.dir, e.subpath) };
        let src = sources_root.join(&rel).join("src");
        if !src.join("parser.c").exists() {
            missing.push(&e.name);
            continue;
        }
        // grammar_dir = 源仓库根（不含 subpath），subpath 由 compile_grammar 内部拼接
        // （Markpad 原版契约；否则 ocaml 等带 subpath 语言路径双拼）
        compile_grammar(e, &sources_root.join(&e.dir), &out_dir);
        built.push(e);
    }
    if !missing.is_empty() {
        println!(
            "cargo:warning=grammar 源缺失 {}/{}（partial 构建）：缺 [{}, ...]；全量获取：pnpm gen:grammars --fetch 或 node tools/grammar-builder/build.mjs --fetch",
            built.len(),
            manifest.len(),
            missing.iter().take(8).cloned().collect::<Vec<_>>().join(","),
        );
    }

    generate_entries(&out_dir, &built);
    // 含 C++ scanner 的 grammar（yaml/vue/ruby 等）需要 libstdc++
    println!("cargo:rustc-link-lib=dylib=stdc++");
}

/// 查询三件套拷入 OUT_DIR/queries/<dir>/（缺失文件物化为空串，使生成代码的
/// include_str! 恒可解析）。逐文件发 rerun-if-changed（目录级指令不感知深层修改）。
fn copy_queries(out_dir: &Path) {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../packages/highlight/assets/queries");
    for dir in fs::read_dir(&root).expect("queries 资产目录") {
        let dir = dir.unwrap().path();
        if !dir.is_dir() {
            continue;
        }
        let name = dir.file_name().unwrap().to_str().unwrap();
        let dest = out_dir.join("queries").join(name);
        fs::create_dir_all(&dest).unwrap();
        for kind in ["highlights.scm", "injections.scm", "locals.scm"] {
            let src = dir.join(kind);
            println!("cargo:rerun-if-changed={}", src.display());
            let text = fs::read_to_string(&src).unwrap_or_default();
            fs::write(dest.join(kind), text).unwrap();
        }
    }
}

/// 编译单个 grammar：parser.c + scanner.c 走 cc；C++ scanner 手动 g++（gnu++17 +
/// -include cstdint，见 Markpad 注释），vue 内嵌 html scanner 符号 objcopy localize。
fn compile_grammar(e: &GrammarEntry, grammar_dir: &Path, out_dir: &Path) {
    let src_dir = if e.subpath.is_empty() { grammar_dir.join("src") } else { grammar_dir.join(&e.subpath).join("src") };
    let lib_name = format!("tree_sitter_{}", e.name.replace('-', "_"));
    println!("cargo:rerun-if-changed={}", src_dir.join("parser.c").display());

    let mut build = cc::Build::new();
    build.file(src_dir.join("parser.c"));
    for scanner in ["scanner.c"] {
        let p = src_dir.join(scanner);
        if p.exists() {
            build.file(p);
        }
    }
    build
        .flag_if_supported("-std=gnu11")
        .flag("-w")
        .include(&src_dir)
        .include(grammar_dir)
        .include(src_dir.parent().unwrap())
        .warnings(false)
        .compile(&lib_name);

    let scanner_cc = src_dir.join("scanner.cc");
    if scanner_cc.exists() {
        println!("cargo:rerun-if-changed={}", scanner_cc.display());
        let obj = out_dir.join(format!("{lib_name}_scanner.o"));
        let status = Command::new("g++")
            .args([
                "-std=gnu++17",
                "-include",
                "cstdint",
                "-Os",
                "-fPIC",
                "-ffunction-sections",
                "-fdata-sections",
                "-c",
                "-w",
                &format!("-I{}", src_dir.display()),
                &format!("-I{}", grammar_dir.display()),
                &format!("-I{}", src_dir.parent().unwrap().display()),
                "-o",
            ])
            .arg(&obj)
            .arg(&scanner_cc)
            .status()
            .expect("g++ 运行失败（C++ scanner 编译）");
        assert!(status.success(), "C++ scanner 编译失败: {}", e.name);

        // vue scanner.cc 内嵌 html scanner 未重命名符号 → 降级本地符号避免静态链接重定义
        if e.name == "vue" {
            for sym in [
                "tree_sitter_html_external_scanner_create",
                "tree_sitter_html_external_scanner_destroy",
                "tree_sitter_html_external_scanner_scan",
                "tree_sitter_html_external_scanner_serialize",
                "tree_sitter_html_external_scanner_deserialize",
            ] {
                let st = Command::new("objcopy")
                    .arg(format!("--localize-symbol={sym}"))
                    .arg(&obj)
                    .status()
                    .expect("objcopy 运行失败");
                assert!(st.success(), "objcopy localize 失败: {}", e.name);
            }
        }

        let main_lib = out_dir.join(format!("lib{lib_name}.a"));
        let st = Command::new("ar")
            .arg("rs")
            .arg(&main_lib)
            .arg(&obj)
            .current_dir(out_dir)
            .status()
            .expect("ar 运行失败");
        assert!(st.success(), "ar 合并失败: {}", e.name);
        let _ = fs::remove_file(&obj);
    }

    println!("cargo:rustc-link-lib=static={lib_name}");
}

/// 生成 OUT_DIR/grammar_entries.rs：extern 声明 + entries/parents + 计数。
fn generate_entries(out_dir: &Path, built: &[&GrammarEntry]) {
    let q = out_dir.join("queries");
    let mut s = String::from("// @generated by server/build.rs — 手改无效\n// （不写 use：本文件由 queries.rs 以 include! 并入模块，LanguageFn 由宿主模块导入）\n\n");
    for e in built {
        s.push_str(&format!("unsafe extern \"C\" {{ fn {}() -> *const (); }}\n", e.c_symbol));
    }
    s.push_str("\n/// 语言条目：(name, LanguageFn, highlights, injections, locals)。\n");
    s.push_str("pub fn generated_entries() -> Vec<(&'static str, LanguageFn, &'static str, &'static str, &'static str)> {\n    vec![\n");
    for e in built {
        let dir = q.join(&e.name);
        s.push_str(&format!(
            "        (\"{name}\", unsafe {{ LanguageFn::from_raw({sym}) }}, include_str!(r#\"{d}/highlights.scm\"#), include_str!(r#\"{d}/injections.scm\"#), include_str!(r#\"{d}/locals.scm\"#)),\n",
            name = e.name,
            sym = e.c_symbol,
            d = dir.display(),
        ));
    }
    s.push_str("    ]\n}\n\n/// 非语言的查询目录（; inherits 展开目标）。\n");
    s.push_str("pub fn generated_parents() -> Vec<(&'static str, &'static str)> {\n    vec![\n");
    for dir in fs::read_dir(&q).unwrap() {
        let dir = dir.unwrap().path();
        let name = dir.file_name().unwrap().to_str().unwrap().to_string();
        if built.iter().any(|e| e.name == name) {
            continue;
        }
        s.push_str(&format!(
            "        (\"{name}\", include_str!(r#\"{d}/highlights.scm\"#)),\n",
            name = name,
            d = dir.display(),
        ));
    }
    s.push_str("    ]\n}\n\n");
    s.push_str(&format!("pub const GENERATED_COUNT: usize = {};\n", built.len()));
    fs::write(out_dir.join("grammar_entries.rs"), s).unwrap();
}
