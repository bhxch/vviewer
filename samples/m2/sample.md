# M2 样例：Markdown 与代码围栏

markdown 不在 36 个 grammar wasm 清单内，本文件本身走 hljs 兜底；
围栏内代码的 tree-sitter 注入断言为可选项（T7 报告说明）。

## Rust 围栏

```rust
fn main() {
    let answer = 42;
    println!("answer = {answer}");
}
```

- 列表项一
- 列表项二
