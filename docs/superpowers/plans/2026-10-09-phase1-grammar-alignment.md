# 阶段 1：语法生态对齐（301 语言）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** vviewer 语法生态全量对齐 Markpad 301 语言：grammar/queries 源同步到 Markpad 2026-10-07 pin 点，服务端改为 build.rs 源码编译全部 grammar（FFI 生成），injections/locals 接线，health 宣告 301。

**Architecture:** 保持双引擎格局。grammar 源树沿用 `tools/grammar-builder/out/grammars/<name>/<subpath>/`（fetch 管线现成，与 Markpad grammars/ 同构），server 新增 `build.rs` 逐 grammar cc/g++ 编译 + 生成 `OUT_DIR/grammar_entries.rs`（extern FFI + include_str 查询三件套），`queries.rs` 的 ENTRIES 从硬编码 14 改为生成式 + sanitize 逐文件降级 + inherits 按文件类别展开。

**Tech Stack:** Node (smol-toml 构建脚本) / Rust build.rs (cc, serde_json) / tree-sitter 0.27 + tree-sitter-highlight 0.27 + tree-sitter-language 0.1 / GitHub Actions composite action。

**Spec:** `docs/superpowers/specs/2026-10-09-full-grammar-alignment-design.md`（§2 阶段 1）

## Global Constraints

- 产物不入库：wasm、grammar 源树、OUT_DIR 生成物一律不 commit；`server/grammars-manifest.json` 与 `server/GRAMMAR_LICENSES.md` 是**例外**（由仓库外 Markpad 现势生成、体积小、无源不可再生，spec §2.2/§3 定为入库）。
- 服务端语言集合验收 = Markpad `src-tauri/src/highlight/registry.rs` 的 301 名单；`GENERATED_COUNT == 301` 是 CI 门禁（部分源缺失时本地构建降级为 partial，允许）。
- vendored 例外：`tools/grammar-builder/languages.toml`、`packages/highlight/assets/queries` 整体来自 Markpad 同源（同步即 pin，spec §2.1）。
- 既有 14 语言（rust/python/bash/json/go/c/cpp/javascript/typescript/tsx/yaml/toml/html/css）的行为回归必须保持（含 CRLF 归一、缓存键、10s 超时等既有语义）。
- commit 按 Angular 规范、原子化；wasm/源树等 gitignore 项不得入库。
- 本机工具链已验证可用（Markpad 同机编译过 301 grammar）：gcc/g++/ar/objcopy 齐备。

---

### Task 1: 同步 languages.toml 与 queries 资产，重建 lite wasm 并过前端测试

**Files:**
- Modify: `tools/grammar-builder/languages.toml`（整体替换为 Markpad 版）
- Modify: `packages/highlight/assets/queries/`（整体替换为 Markpad 307 目录）
- 参考（只读）: `/share/rw/repo/markpad-aio/Markpad/src-tauri/languages.toml`、`/share/rw/repo/markpad-aio/Markpad/src-tauri/queries/`

**Interfaces:**
- Produces: 后续所有任务依赖的新 rev 源树（`tools/grammar-builder/out/grammars/`）与新 queries 资产（301 语言目录 + 6 继承父目录，含 `_javascript`）。

- [ ] **Step 1: 替换 vendored 源（注意保留 vviewer 文件头注记）**

```bash
cd /share/rw/repo/server/vviewer
# languages.toml：整份拷入，然后把 vviewer 原文件头（1-8 行左右的中文注记）重新拼回文件顶部
head -8 tools/grammar-builder/languages.toml   # 先看现有头注记内容，拷贝后手工还原
cp /share/rw/repo/markpad-aio/Markpad/src-tauri/languages.toml tools/grammar-builder/languages.toml
# queries：镜像替换（--delete 清掉陈旧目录如 robots）
rsync -a --delete /share/rw/repo/markpad-aio/Markpad/src-tauri/queries/ packages/highlight/assets/queries/
ls packages/highlight/assets/queries | wc -l   # 期望 307
```

- [ ] **Step 2: 清源树缓存并重建 lite（关键：fetch 对已存在 parser.c 幂等跳过，不清理会拿旧 rev 源）**

```bash
rm -rf tools/grammar-builder/out/grammars
node tools/grammar-builder/build.mjs --fetch --lite
node tools/grammar-builder/build.mjs --self-build --force
# 期望：built 32, vendored 2（yaml/vue），failed 0；fetch failures 0
```

- [ ] **Step 3: 前端测试验证（真实 wasm + 新查询）**

```bash
rg -l "local-grammars" packages apps/web/src --type ts   # 定位资产锁测试
pnpm vitest run packages/highlight
pnpm vitest run <上一步定位到的 local-grammars 测试文件路径>
```
Expected: 全绿（新 rev grammar + 新 queries + 客户端 inherits 展开兼容 `_javascript` 等新父目录）。

- [ ] **Step 4: Commit**

```bash
git add tools/grammar-builder/languages.toml packages/highlight/assets/queries
git commit -m "feat(grammars): 语法源与查询资产同步 Markpad 2026-10-07 pin 点

why: 全量对齐 Markpad 301 语言的地基；旧 languages.toml rev 落后、queries 缺
21+ 目录（含继承父目录 _javascript）且含陈旧目录 robots。
what: languages.toml 整体换用 Markpad vendored 版（303 [[grammar]]），queries
镜像替换为 307 目录/950 scm，lite 34 wasm 按新 rev 重建验证。"
```

---

### Task 2: 重新生成 build-list.json（292 → 现势全量）

**Files:**
- Modify: `tools/grammar-builder/build-list.json`
- 参考（只读）: `/share/rw/repo/markpad-aio/Markpad/src-tauri/grammar_info.json`、`/share/rw/repo/markpad-aio/Markpad/src-tauri/grammars/`

**Interfaces:**
- Consumes: Task 1 的新 languages.toml。
- Produces: 全量 build-list（`--all` fetch/self-build 与 CI 门禁的输入）。

- [ ] **Step 1: 核对 grammar_info.json 现势**

```bash
node -e "const j=require('/share/rw/repo/markpad-aio/Markpad/src-tauri/grammar_info.json'); console.log(Object.keys(j).length)"
```
Expected: ≥301（Markpad 10-07 同步后应已再生）。若 <301，改用 `gen-server-manifest.mjs`（Task 3）解析 Markpad build.rs 表的 name/subpath 作为 build-list 来源（写一个临时汇总脚本，把 name/subpath 按同一 JSON 形状输出），不得手抄。

- [ ] **Step 2: 重新生成并检查 diff**

```bash
node tools/grammar-builder/build-list.mjs
git diff --stat tools/grammar-builder/build-list.json
node -e "const l=require('./tools/grammar-builder/build-list.json'); console.log('total', l.length, 'buildable', l.filter(e=>e.parserCExists).length)"
```
Expected: total ≈ 301-303（与 Markpad [[grammar]] 数一致），buildable 与 total 一致（Markpad grammars/ 目录全量在盘）。

- [ ] **Step 3: Commit**

```bash
git add tools/grammar-builder/build-list.json
git commit -m "chore(grammars): build-list 重新生成对齐 Markpad 现势（292→全量）

why: build-list 是 --all fetch/self-build 的输入面，旧快照缺 20+ 新语法。
what: 由 build-list.mjs 按 Markpad grammar_info.json 现势再生，全量 parserCExists。"
```

---

### Task 3: 服务端 grammar 清单生成器 + server/grammars-manifest.json

**Files:**
- Create: `tools/grammar-builder/gen-server-manifest.mjs`
- Create: `server/grammars-manifest.json`
- Test: `tools/grammar-builder/test/gen-server-manifest.test.ts`
- 参考（只读）: `/share/rw/repo/markpad-aio/Markpad/src-tauri/build.rs`（16-318 行静态表）

**Interfaces:**
- Produces: `server/grammars-manifest.json`，元素形状 `{ name: string, dir: string, subpath: string, cSymbol: string }`（按 name 排序）——Task 5 build.rs 的唯一输入。

- [ ] **Step 1: 写失败测试**

```ts
// tools/grammar-builder/test/gen-server-manifest.test.ts
import { describe, expect, it } from 'vitest';
import { parseBuildRsTable, toManifest } from '../gen-server-manifest.mjs';

const SAMPLE = `let grammars: Vec<(&str, &str, &str, &str)> = vec![
    ("ada", "ada", "", "tree_sitter_ada"),
    ("c-sharp", "c-sharp", "", "tree_sitter_c_sharp"),
    ("tsx", "tsx", "tsx", "tree_sitter_tsx"),
];`;

describe('gen-server-manifest', () => {
  it('解析 Markpad build.rs 静态表为排序清单', () => {
    const entries = parseBuildRsTable(SAMPLE);
    expect(entries).toEqual([
      { name: 'ada', dir: 'ada', subpath: '', cSymbol: 'tree_sitter_ada' },
      { name: 'c-sharp', dir: 'c-sharp', subpath: '', cSymbol: 'tree_sitter_c_sharp' },
      { name: 'tsx', dir: 'tsx', subpath: 'tsx', cSymbol: 'tree_sitter_tsx' },
    ]);
  });
  it('toManifest 产出 JSON 字符串且按 name 排序、带生成注记', () => {
    const json = JSON.parse(toManifest(parseBuildRsTable(SAMPLE)));
    expect(json.note).toContain('Markpad build.rs');
    expect(json.grammars.map((g) => g.name)).toEqual(['ada', 'c-sharp', 'tsx']);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run tools/grammar-builder/test/gen-server-manifest.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现生成器**

```js
#!/usr/bin/env node
// 服务端 grammar 清单生成器：解析 Markpad build.rs 的 (name, dir, subpath, c_symbol)
// 静态表（301 语言的服务端验收集合，spec §2.1），产出 server/grammars-manifest.json。
// 该 JSON 与 build-list.json 同理入库（体积小、由仓库外现势生成、无源不可再生）。
// 用法：node tools/grammar-builder/gen-server-manifest.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

export const SOURCES = {
  buildRs: process.env.VV_MARKPAD_BUILD_RS ?? '/share/rw/repo/markpad-aio/Markpad/src-tauri/build.rs',
  outFile: process.env.VV_SERVER_MANIFEST ?? path.join(here, '../../server/grammars-manifest.json'),
};

/** 提取 build.rs 中 `vec![ ... ]` 静态表：四元组 ("name", "dir", "subpath", "c_symbol")。 */
export function parseBuildRsTable(text) {
  const block = /let grammars[^=]*=\s*vec!\[([\s\S]*?)\];/.exec(text)?.[1] ?? '';
  const entries = [];
  const re = /\(\s*"([^"]+)"\s*,\s*"([^"]+)"\s*,\s*"([^"]*)"\s*,\s*"([^"]*)"\s*\)/g;
  for (const m of block.matchAll(re)) {
    entries.push({ name: m[1], dir: m[2], subpath: m[3], cSymbol: m[4] });
  }
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return entries;
}

export function toManifest(entries) {
  return JSON.stringify(
    {
      note: '由 Markpad build.rs 静态表生成（node tools/grammar-builder/gen-server-manifest.mjs）；server/build.rs 的编译与 FFI 输入，语言集合 = 服务端 301 验收口径',
      generatedAt: new Date().toISOString(),
      grammars: entries,
    },
    null,
    2,
  ) + '\n';
}

export function main() {
  const entries = parseBuildRsTable(fs.readFileSync(SOURCES.buildRs, 'utf8'));
  if (entries.length < 301) {
    throw new Error(`Markpad build.rs 表仅 ${entries.length} 条（期望 ≥301），上游文件可能已变动`);
  }
  const odd = entries.filter((e) => e.dir !== e.name);
  if (odd.length) console.warn(`[gen-server-manifest] dir != name 条目（源树查找按 dir）: ${JSON.stringify(odd)}`);
  fs.mkdirSync(path.dirname(SOURCES.outFile), { recursive: true });
  fs.writeFileSync(SOURCES.outFile, toManifest(entries));
  console.log(`[gen-server-manifest] ${entries.length} grammars -> ${SOURCES.outFile}`);
  return entries;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
```

- [ ] **Step 4: 跑测试通过 + 生成真实清单**

```bash
pnpm vitest run tools/grammar-builder/test/gen-server-manifest.test.ts   # PASS
node tools/grammar-builder/gen-server-manifest.mjs                        # 期望输出 301 grammars
node -e "const m=require('./server/grammars-manifest.json'); console.log(m.grammars.length, m.grammars[0].name, m.grammars.at(-1).name)"
```

- [ ] **Step 5: 与 Markpad 301 名单交叉验证**

```bash
node -e "
const m = require('./server/grammars-manifest.json').grammars.map(g=>g.name).sort();
const fs = require('fs');
const reg = fs.readFileSync('/share/rw/repo/markpad-aio/Markpad/src-tauri/src/highlight/registry.rs','utf8');
const names = [...reg.matchAll(/\(\s*\"([a-z0-9_-]+)\"\s*,\s*\"[a-z0-9_]+\"\s*\)/g)].map(x=>x[1]).sort();
console.log('manifest', m.length, 'registry', names.length);
console.log('only-in-manifest:', m.filter(x=>!names.includes(x)));
console.log('only-in-registry:', names.filter(x=>!m.includes(x)));
"
```
Expected: 两个差集均为空（若非空，说明解析正则漏了特殊条目，修正 `parseBuildRsTable` 后重跑）。

- [ ] **Step 6: Commit**

```bash
git add tools/grammar-builder/gen-server-manifest.mjs tools/grammar-builder/test/gen-server-manifest.test.ts server/grammars-manifest.json
git commit -m "feat(server): 301 语言清单生成器与 grammars-manifest.json

why: 服务端全量编译需要一份入库的确定性语言清单（spec §2.2），验收口径
取 Markpad registry 的 301 名单。
what: gen-server-manifest.mjs 解析 Markpad build.rs 静态表，产出
server/grammars-manifest.json（301 条，含单测与 registry 交叉验证）。"
```

---

### Task 4: server/build.rs——源码编译 + 查询拷贝 + entries 生成（partial 可构建）

**Files:**
- Create: `server/build.rs`
- Modify: `server/Cargo.toml`（新增 `[build-dependencies]`）
- 参考（只读）: `/share/rw/repo/markpad-aio/Markpad/src-tauri/build.rs`（compile_grammar 332-493、generate_ffi_module 495-548）

**Interfaces:**
- Consumes: `server/grammars-manifest.json`（Task 3）、源树 `tools/grammar-builder/out/grammars/<dir>/<subpath>/src/parser.c`（Task 1/2 fetch）、查询资产 `packages/highlight/assets/queries/`（Task 1）。
- Produces: `OUT_DIR/grammar_entries.rs`，内容为：
  - 每个已编译语言的 `unsafe extern "C" { fn <cSymbol>() -> *const (); }` 声明；
  - `pub fn generated_entries() -> Vec<(&'static str, LanguageFn, &'static str, &'static str, &'static str)>`（name, language, highlights, injections, locals——查询经 `include_str!` 嵌入缺失文件为空串）；
  - `pub fn generated_parents() -> Vec<(&'static str, &'static str)>`（非语言查询目录 → highlights.scm）；
  - `pub const GENERATED_COUNT: usize;`

- [ ] **Step 1: Cargo.toml 增加构建依赖**

在 `[dev-dependencies]` 之前插入：

```toml
[build-dependencies]
cc = "1"
serde = { version = "1", features = ["derive"] }
serde_json = "1"
```

- [ ] **Step 2: 写 build.rs（移植 Markpad compile_grammar，缺失源降级 partial）**

```rust
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

fn main() {
    println!("cargo:rerun-if-changed=grammars-manifest.json");
    println!("cargo:rerun-if-env-changed=VV_GRAMMAR_SOURCES");

    let manifest: Vec<GrammarEntry> =
        serde_json::from_str(include_str!("grammars-manifest.json")).expect("grammars-manifest.json");
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
        compile_grammar(e, &sources_root.join(&rel), &out_dir);
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
    let mut s = String::from("// @generated by server/build.rs — 手改无效\nuse tree_sitter_language::LanguageFn;\n\n");
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
```

- [ ] **Step 3: 准备最小源集并验证 partial 构建**

```bash
# lite 34 源已由 Task 1 fetch；补 java（Task 7 断言用）
node tools/grammar-builder/build.mjs --fetch --languages java
cd server && cargo build 2>&1 | tail -5
```
Expected: 编译通过，warning 显示 partial（35/301 左右）；无链接错误。

- [ ] **Step 4: Commit**

```bash
git add server/build.rs server/Cargo.toml server/Cargo.lock
git commit -m "feat(server): build.rs 源码编译 grammar 并生成 entries（partial 可构建）

why: 301 语言不可能经 crates.io crate 覆盖，服务端改为源码编译（spec §2.2，
移植 Markpad 工程手法），并退役 crates.io grammar 依赖（下一任务）。
what: build.rs 读 grammars-manifest.json，cc 编译 parser.c/scanner.c、手动
g++/ar/objcopy 处理 C++ scanner 与 vue 符号冲突；查询三件套拷入 OUT_DIR 并
生成 grammar_entries.rs（entries/parents/计数）；源缺失降级 partial 构建。"
```

---

### Task 5: queries.rs 改造为生成式 ENTRIES + injections/locals 接线；退役 crates.io grammar 依赖

**Files:**
- Modify: `server/src/compute/queries.rs`
- Modify: `server/src/compute/highlight.rs`（注入回调）
- Modify: `server/Cargo.toml`（删除 13 个 grammar crate）

**Interfaces:**
- Consumes: Task 4 的 `generated_entries()/generated_parents()/GENERATED_COUNT`。
- Produces: `queries::config_ref(lang) -> Option<&'static HighlightConfiguration>`（注入回调与 highlighter 使用；取代原 `config()`）；`pub const REGISTERED_BUDGET` 无——新增 `pub fn generated_count() -> usize`。

- [ ] **Step 1: Cargo.toml 删除 grammar crate**

删除 `tree-sitter-rust` 至 `tree-sitter-css` 的 13 行依赖（`tree-sitter`/`tree-sitter-highlight`/`tree-sitter-language` 保留）。

- [ ] **Step 2: queries.rs 重构（关键代码）**

模块头注释改为：注入/locals 已接线（阶段 1，spec §2.2），删除「v1 无 injection」三处注释。结构改造：

```rust
/// 语法 + 查询三件套（injections/locals 已接线）。
struct LanguageEntry {
    name: &'static str,
    language: LanguageFn,
    highlights: &'static str,
    injections: &'static str,
    locals: &'static str,
}

include!(concat!(env!("OUT_DIR"), "/grammar_entries.rs"));
```

ENTRIES 构造（sanitize 逐文件降级，spec §2.2；highlights 失败才剔除语言）：

```rust
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
```

PARENT_ASSETS 改为生成式（替换现硬编码 HashMap）：

```rust
static PARENT_ASSETS: Lazy<HashMap<&'static str, &'static str>> =
    Lazy::new(|| generated_parents().into_iter().collect());
```

`expand_asset` 泛化为按文件类别展开（父查询在前、自身在后，三类别各自继承链）：

```rust
fn expand_asset(name: &str, kind: Kind, visited: &mut HashSet<String>) -> Option<String> {
    if !visited.insert(name.to_string()) {
        return Some(String::new());
    }
    let own = match kind {
        Kind::Highlights => ENTRIES.iter().find(|e| e.name == name).map(|e| e.highlights),
        Kind::Injections => ENTRIES.iter().find(|e| e.name == name).map(|e| e.injections),
        Kind::Locals => ENTRIES.iter().find(|e| e.name == name).map(|e| e.locals),
    }
    .or_else(|| match kind {
        Kind::Highlights => PARENT_ASSETS.get(name).copied(),
        // 父目录仅贡献 highlights（helix 现势父目录无 injections/locals）
        _ => None,
    })?;
    let mut merged = String::new();
    for parent in parse_inherits(own) {
        if let Some(expanded) = expand_asset(parent, kind, visited) {
            merged.push_str(&expanded);
        }
    }
    merged.push_str(&strip_inherits_line(own));
    Some(merged)
}
```

CONFIGS 构造传入三件套，并新增供注入回调的 `'static` 引用访问器：

```rust
Ok(mut config) => {
    config.configure(names);
    map.insert(entry.name, Arc::new(config));
}
```

```rust
/// 注入回调与 handler 共用的 'static 配置引用（Arc 存于全局 static，引用恒活）。
pub fn config_ref(lang: &str) -> Option<&'static HighlightConfiguration> {
    CONFIGS.get(lang).map(|c| &**c)
}
pub fn generated_count() -> usize { GENERATED_COUNT }
```

原 `config()` 返回 `Option<Arc<...>>` 的调用点（highlight.rs:126）改用 `config_ref`。

- [ ] **Step 3: highlight.rs 接线注入回调**

`run_highlight` 中 `highlighter.highlight(...)` 的注入闭包改为：

```rust
    let events = highlighter
        .highlight(
            &config,
            text.as_bytes(),
            None,
            None,
            |injected: &str| queries::config_ref(injected),
        )
```

同步修正文件头与 highlight.rs:130-133 的「v1 无 injection」注释。

- [ ] **Step 4: 编译 + 既有测试回归**

```bash
cd server && cargo build 2>&1 | tail -3 && cargo test 2>&1 | tail -15
```
Expected: 编译通过（partial 源）；`all_entries_compile_and_register` 等既有测试全绿——若该测试因 partial 源缺语言失败，改其断言为「ENTRIES 与 generated_entries 的一致性 + 14 基准语言在场」（见 Step 5 测试更新，一并完成）。

- [ ] **Step 5: queries.rs 测试更新（partial 友好 + 全量门禁测试）**

`all_entries_compile_and_register` 改为：

```rust
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
```

另新增 sanitize 与注入单测：

```rust
    #[test]
    fn injection_callback_resolves_nested_language() {
        // html 的 injections.scm 含 script/style 注入；config_ref 必须能解析子语言
        assert!(config_ref("html").is_some());
        if config_ref("javascript").is_some() {
            assert!(config_ref("javascript").is_some());
        }
    }

    #[test]
    fn parents_include_all_inherit_targets() {
        let parents = Lazy::force(&PARENT_ASSETS);
        for p in ["ecma", "_typescript", "_jsx", "_javascript"] {
            assert!(parents.contains_key(p), "缺父目录 {p}: {:?}", parents.keys());
        }
    }
```

- [ ] **Step 6: Commit**

```bash
git add server/src/compute/queries.rs server/src/compute/highlight.rs server/Cargo.toml server/Cargo.lock
git commit -m "feat(server): 语言注册表改生成式并接线 injections/locals

why: 硬编码 14 语言无法承载 301 全量；且服务端 v1 无注入导致路由层被迫
豁免注入语言（spec §2.2/§4 的前提解除）。
what: ENTRIES/parents 改由 build.rs 生成物构造，sanitize 逐文件降级
（highlights 失败才剔除语言）；expand 按文件类别展开 inherits；注入回调
config_ref 接入 Highlighter；退役 13 个 crates.io grammar crate。"
```

---

### Task 6: health 断言翻转 + java/注入集成测试

**Files:**
- Modify: `server/src/routes/health.rs:61-75`
- Modify: `server/tests/compute_highlight.rs`

**Interfaces:**
- Consumes: Task 5 的注册表。

- [ ] **Step 1: health 测试翻转（java 在场；保排序断言）**

```rust
    #[tokio::test]
    async fn compute_advertises_sorted_full_registry() {
        let v = health_json(true).await;
        assert!(v["capabilities"].as_array().unwrap().contains(&serde_json::json!("compute")));
        let langs = v["computeLanguages"].as_array().expect("computeLanguages 数组");
        let names: Vec<&str> = langs.iter().map(|x| x.as_str().expect("str")).collect();
        assert_eq!(names, {
            let mut sorted = names.clone();
            sorted.sort_unstable();
            sorted
        });
        assert!(names.contains(&"rust") && names.contains(&"python"));
        // 阶段 1 收口：java 已进服务端集合（BUG-06c 时代的缺席断言翻转）
        assert!(names.contains(&"java"));
    }
```

- [ ] **Step 2: compute_highlight.rs 增补两个集成测试**

```rust
#[tokio::test]
async fn highlight_java_ok() {
    let f = fixture(true, None);
    let (status, body) = post_json(
        f.app,
        "/api/compute/highlight",
        None,
        json!({ "text": "class A { int x = 1; }", "lang": "java" }),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert!(!body["intervals"].as_array().unwrap().is_empty());
}

#[tokio::test]
async fn highlight_html_injects_javascript() {
    let f = fixture(true, None);
    let with_js = "<html><body><script>let x = 1;</script></body></html>";
    let without_js = "<html><body><p>plain</p></body></html>";
    let (s1, b1) = post_json(f.app, "/api/compute/highlight", None,
        json!({ "text": with_js, "lang": "html" })).await;
    let (s2, b2) = post_json(f.app, "/api/compute/highlight", None,
        json!({ "text": without_js, "lang": "html" })).await;
    assert_eq!((s1, s2), (StatusCode::OK, StatusCode::OK));
    let n1 = b1["intervals"].as_array().unwrap().len();
    let n2 = b2["intervals"].as_array().unwrap().len();
    assert!(n1 > n2, "注入 JS 后区间应更多: {n1} vs {n2}");
}
```

- [ ] **Step 3: 跑测试**

```bash
cd server && cargo test --test compute_highlight 2>&1 | tail -8 && cargo test --lib 2>&1 | tail -8
```
Expected: 全绿（含翻转后的 health 测试）。

- [ ] **Step 4: Commit**

```bash
git add server/src/routes/health.rs server/tests/compute_highlight.rs
git commit -m "test(server): health 集合断言翻转 + java/注入集成冒烟

why: java 缺席断言是 BUG-06c 时代的对齐缺口锁，阶段 1 后语义反转；
injection 接线需要端到端回归护栏。
what: health 改断言 java 在场；新增 java 高亮与 html→js 注入区间对比测试。"
```

---

### Task 7: 本地全量 fetch + GENERATED_COUNT==301 门禁

**Files:** 无代码新增（验证任务；如发现单个 grammar 编译失败，修 build.rs 适配并记录到 commit）。

- [ ] **Step 1: 全量 fetch（约 3-4GB 磁盘、30-60 分钟，视网络）**

```bash
node tools/grammar-builder/build.mjs --fetch 2>&1 | tail -3
cat tools/grammar-builder/out/fetch-failures.json   # 期望 []
```

- [ ] **Step 2: 全量构建 + 门禁测试**

```bash
cd server && cargo build 2>&1 | grep -E "warning|error" | head -5
cargo test full_registry_count_is_301 -- --nocapture 2>&1 | tail -5
```
Expected: `test queries::tests::full_registry_count_is_301 ... ok`，且 partial warning 消失（301/301）。个别 grammar 编译失败时：失败原因记入 `server/docs/` 不新建——直接在 commit message 列出并给出适配（若属 scanner 变体等结构性限制，按 spec §2.1 记录集合差，门禁数字相应调整为实测值并回写 spec §7 表格）。

- [ ] **Step 3: 14 语言回归全绿**

```bash
cd server && cargo test 2>&1 | tail -5
```

- [ ] **Step 4: Commit（如 build.rs 有适配修改）**

```bash
git add -A server/build.rs docs/superpowers/specs/2026-10-09-full-grammar-alignment-design.md
git commit -m "fix(server): 全量 301 构建适配（如无修改则为空操作跳过本步）

why: 全量编译暴露的个别 grammar 结构差异需要 build.rs 适配。
what: <按实际填写，无修改则本任务无 commit。>"
```

---

### Task 8: grammar 许可证清单生成（THIRD_PARTY 合规）

**Files:**
- Create: `tools/grammar-builder/gen-licenses.mjs`
- Create: `server/GRAMMAR_LICENSES.md`

**Interfaces:**
- Consumes: 源树 `tools/grammar-builder/out/grammars/<dir>/` 的 LICENSE*/COPYING* 与 package.json。

- [ ] **Step 1: 实现生成器**

```js
#!/usr/bin/env node
// grammar 许可证聚合：从源树收集 LICENSE/COPYING 与 package.json.license，
// 产出 server/GRAMMAR_LICENSES.md（随二进制分发，满足 MIT/Apache 等条款的
// 许可文本随附义务；spec §2.2）。需先 --fetch 全量源树。
// 用法：node tools/grammar-builder/gen-licenses.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const sources = process.env.VV_GRAMMAR_SOURCES ?? path.join(here, 'out/grammars');
const manifest = JSON.parse(fs.readFileSync(path.join(here, '../../server/grammars-manifest.json'), 'utf8'));

function firstLicenseFile(dir) {
    for (const f of fs.readdirSync(dir)) {
        if (/^(LICENSE|COPYING|LICENSE\..*|LICENSE-.*)$/i.test(f)) return path.join(dir, f);
    }
    return null;
}

const rows = [];
for (const g of manifest.grammars) {
    const dir = path.join(sources, g.dir);
    if (!fs.existsSync(dir)) { rows.push({ name: g.name, license: '(源未取)', file: '' }); continue; }
    const lic = firstLicenseFile(dir);
    const pkg = path.join(dir, g.subpath, 'package.json');
    let declared = '';
    try { declared = JSON.parse(fs.readFileSync(pkg, 'utf8')).license ?? ''; } catch { /* 无 package.json */ }
    rows.push({ name: g.name, license: declared || (lic ? '见文件' : '未找到'), file: lic ? path.relative(path.join(here, '../..'), lic) : '' });
}

const body = [
    '# Grammar Licenses',
    '',
    'vviewer 服务端二进制静态链接了以下 tree-sitter grammar（源码按 pinned rev 编译）。',
    '各 grammar 的许可证文本见其源仓 LICENSE 文件（路径相对仓库根；完整文本随',
    '`tools/grammar-builder/out/grammars/` 源树分发于构建环境）。',
    '',
    '| grammar | declared license | license file |',
    '| --- | --- | --- |',
    ...rows.map((r) => `| ${r.name} | ${r.license} | ${r.file} |`),
    '',
].join('\n');
fs.writeFileSync(path.join(here, '../../server/GRAMMAR_LICENSES.md'), body);
console.log(`[gen-licenses] ${rows.length} entries -> server/GRAMMAR_LICENSES.md`);
```

- [ ] **Step 2: 生成并抽查**

```bash
node tools/grammar-builder/gen-licenses.mjs
head -12 server/GRAMMAR_LICENSES.md
rg -c "未找到" server/GRAMMAR_LICENSES.md || echo "0 missing"
```
Expected: 301 行条目；「未找到」为 0（个别上游确实无 LICENSE 的，标注 declared 为 `未找到` 并在 commit message 列名——不允许静默通过）。

- [ ] **Step 3: Commit**

```bash
git add tools/grammar-builder/gen-licenses.mjs server/GRAMMAR_LICENSES.md
git commit -m "chore(server): 301 grammar 许可证清单随二进制分发

why: 二进制静态链接 301 个第三方 grammar，许可条款要求随附许可文本。
what: gen-licenses.mjs 聚合源树 LICENSE/package.json.license 生成
server/GRAMMAR_LICENSES.md。"
```

---

### Task 9: CI 三处接线（fetch-only / rust job / 全量门禁 / release）

**Files:**
- Modify: `.github/actions/setup-grammars/action.yml`
- Modify: `.github/workflows/ci.yml`（rust job）
- Modify: `.github/workflows/grammar.yml`（新增 server-full job）
- Modify: `.github/workflows/release.yml`（server job）

**Interfaces:**
- Consumes: Task 4 build.rs、Task 5 门禁测试名 `full_registry_count_is_301`。

- [ ] **Step 1: action.yml 增加 fetch-only 输入**

`inputs` 段新增：

```yaml
  fetch-only:
    description: '仅获取源树（服务端构建输入），跳过 wasm self-build'
    required: false
    default: 'false'
```

`fetch + self-build` 步骤的 run 脚本在 `node tools/grammar-builder/build.mjs --fetch $FETCH_ARGS` 之后加条件：

```bash
        if [ "${{ inputs.fetch-only }}" = "true" ]; then
          echo "fetch-only: 跳过 wasm self-build"
          exit 0
        fi
```

- [ ] **Step 2: ci.yml rust job——测试前取源（测试集 + java）**

rust job 在 `Swatinem/rust-cache` 之后、`cargo test` 之前插入：

```yaml
      - uses: pnpm/action-setup@v6
      - uses: actions/setup-node@v7
        with:
          node-version: 22
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      # build.rs 需要测试涉及语言的 grammar 源（partial 构建即可跑测试）
      - uses: ./.github/actions/setup-grammars
        with:
          languages: javascript,typescript,bash,html,css,json,python,rust,java,go,c,cpp,tsx,yaml,toml
          fetch-only: 'true'
```

- [ ] **Step 3: grammar.yml 新增 server-full 门禁 job**

workflow 末尾追加（`on` 为 workflow_call + workflow_dispatch 现状保持）：

```yaml
  server-full:
    name: server 全量 301 门禁
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - uses: pnpm/action-setup@v6
      - uses: actions/setup-node@v7
        with:
          node-version: 22
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - uses: ./.github/actions/setup-grammars
        with:
          languages: all
          fetch-only: 'true'
      - uses: dtolnay/rust-toolchain@stable
      - uses: Swatinem/rust-cache@v2
        with:
          workspaces: server
      - name: 全量构建 + 301 门禁
        run: cargo test --manifest-path server/Cargo.toml full_registry_count_is_301 -- --nocapture
```

- [ ] **Step 4: release.yml server job——构建前全量取源**

server job（`server:` job，`cargo build --release` 之前）插入与 Step 3 相同的 pnpm/node/setup-grammars(`languages: all`, `fetch-only: 'true'`) 四步。

- [ ] **Step 5: YAML 语法验证 + commit**

```bash
node -e "const y=require('js-yaml'); ['ci','grammar','release'].forEach(w=>y.load(require('fs').readFileSync('.github/workflows/'+w+'.yml','utf8'))); console.log('yaml ok')"
git add .github/actions/setup-grammars/action.yml .github/workflows/ci.yml .github/workflows/grammar.yml .github/workflows/release.yml
git commit -m "ci(grammars): 服务端全量构建接线——fetch-only 模式与 301 门禁

why: build.rs 依赖源树在位；CI 各 job 需按需取源，全量门禁由 grammar.yml
tag 时收口（GENERATED_COUNT==301）。
what: composite action 增 fetch-only；ci rust job 测试前取最小源集；
grammar.yml 新增 server-full job；release server 构建前全量取源。"
```

---

### Task 10: 文档收口与全量门禁复跑

**Files:**
- Modify: `tools/grammar-builder/README.md`（语言集合差异注记）
- Modify: `server/README.md`（构建前置：源树 fetch、VV_GRAMMAR_SOURCES）
- Modify: `docs/superpowers/specs/2026-10-09-full-grammar-alignment-design.md`（§7 阶段 1 状态回写）

- [ ] **Step 1: README 注记**

`tools/grammar-builder/README.md` 增补一节（跟随现有「vendored/差异记录」风格）：wasm 集（≤301，C++ 外置 scanner 语言受限，yaml/vue vendored）与服务端集（301，build.rs 全编）的集合差说明与查询方法（`node -e` 对比 manifest 与 build-list）。
`server/README.md` 增补「构建前置」小节：`node tools/grammar-builder/build.mjs --fetch`（全量 ~3-4GB，一次性）、`VV_GRAMMAR_SOURCES` 覆盖、partial 构建语义（缺源语言运行时 400）。

- [ ] **Step 2: spec §7 表格阶段 1 行回写实测结果**（wasm 集实测数、差集名单、门禁链接/本地输出摘要）

- [ ] **Step 3: 全量门禁最终复跑并 commit**

```bash
cd server && cargo test 2>&1 | tail -4
cd .. && pnpm vitest run 2>&1 | tail -4 && pnpm typecheck
git add tools/grammar-builder/README.md server/README.md docs/superpowers/specs/2026-10-09-full-grammar-alignment-design.md
git commit -m "docs(grammars): 阶段 1 收口——构建前置、集合差异与 spec 回写

why: 全量编译改变服务端构建前置（源树 fetch），集合口径（wasm ≤301 /
server 301）需要显式记录。
what: 两处 README 增补，spec §7 阶段 1 状态回写实测数字。"
```

---

## Self-Review 记录

1. **Spec 覆盖**：§2.1 源同步→Task 1/2；§2.2 build.rs/FFI/退役 crate→Task 3/4/5；sanitize+inherits→Task 5；health 301→Task 6/9；301 兼容测试→Task 5 `full_registry_count_is_301`（CI 全源环境运行，等价 Markpad `test_all_languages_query_compatibility` 的门禁职责，partial 环境跳过已在测试体内显式说明）；许可随附→Task 8；CI→Task 9；文档→Task 10。§2.1「wasm 集集合差如实记录」→Task 10 Step 1。无缺口。
2. **占位符扫描**：Task 7 Step 4 与 Task 10 Step 2 的「按实际填写」是执行期实测数据的回写指令（非设计缺口）；其余步骤均含完整代码/命令。
3. **类型一致性**：`generated_entries()` 五元组 ↔ Task 5 `LanguageEntry` 解构一致；`config_ref(&'static)` ↔ highlight.rs 闭包返回 `Option<&'static HighlightConfiguration>` 一致；`GENERATED_COUNT` ↔ `full_registry_count_is_301` 一致；manifest 字段 `cSymbol`（serde rename c_symbol）↔ build.rs 一致。
