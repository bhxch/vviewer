# 扩展语法采样

KaTeX 对齐与扩展语法计划（2026-10-19）的语法样例库：mark/ins/描述列表/行内脚注、
callout 折叠、wikilink 锚跳与嵌入、代码语言徽标、四形态数学定界符。
被 apps/web/e2e/b-md-syntax.spec.ts 以 readFileSync 注入（b-md-diagrams 同款通道）。

==高亮标记== 与 ++插入文本++ 同段混排。

行内脚注^[行内注内容]续写正文。

术语
: 描述列表定义行

> [!note]- 折叠提示
> 收起后展开才可见的正文内容。

页内锚跳：[[#目标]]。

嵌入图片（相对路径，样例库不含该二进制，img 元素存在但 src 不解析）：

![[syntax-sampler-embed.png|120]]

跨文件 wikilink 降级为不可点原文：[[Other.md]]

```rust
fn main() {
    println!("syntax sampler");
}
```

质能方程 $E=mc^2$。

水的化学式 $\ce{CO2 + C -> 2 Fe}$。

行内括号式 \(\alpha + \beta = \gamma\) 与块级括号式：

\[ E = h\nu \]

## 目标

锚跳落点，位于文档末尾以实证滚动定位。
