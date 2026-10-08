// M2 样例：简单 Rust 代码。grammars 自建（gen:grammars）后与 helix 查询版本对齐，
// 走 tree-sitter 主路径；历史上的"预编译 wasm 与查询 ABI 失配 → 降级 hljs"路径
// 由 sample.pl（lite 集未内嵌 grammar）承接。
use std::collections::HashMap;

/// 词频统计示例
fn word_counts(text: &str) -> HashMap<String, usize> {
    let mut counts = HashMap::new();
    for word in text.split_whitespace() {
        *counts.entry(word.to_lowercase()).or_insert(0) += 1;
    }
    counts
}

fn main() {
    let text = "the quick brown fox jumps over the lazy dog";
    let counts = word_counts(text);
    for (word, n) in &counts {
        println!("{word}: {n}");
    }
}
