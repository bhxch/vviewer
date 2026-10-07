// M2 样例：简单 Rust 代码（rust 查询与预编译 wasm ABI 失配时自动降级 hljs，
// 见 task-5-report 的 14 失败清单——本文件同时覆盖降级链的真实路径）
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
