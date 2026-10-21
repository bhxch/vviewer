# Markdown KaTeX 对齐与扩展语法 Implementation Plan（spec 阶段二+三）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** KaTeX 对齐 markpad（mhchem、`\(...\)`/`\[...\]` 分隔符）；扩展语法全量双引擎落地（`==mark==`/`++ins++`/描述列表/行内脚注 + comrak 三 extension）；callout 折叠后缀、wikilink 四形态、代码块语言徽标。

**Architecture:** KaTeX 增强在管线 katex 步（扫描器扩展+mhchem 动态子路径导入）；扩展语法双端同步——markdown-it 插件（engine.ts 注册）+ comrak extension 开启（server markdown.rs，字段已实证存在）+ 双侧金标 fixture 交叉注记作一致性锚；引擎无关项（callout 折叠/wikilink/徽标）落 enrich/copyCode 前端单实现层。

**Tech Stack:** markdown-it 15（+markdown-it-mark/ins/deflist）、comrak 0.56（`extension.highlight/insert/inline_footnotes`——均 ExtensionOptions 字段。**勘误 2026-10-21**：原文「`parser.inline_footnotes`——registry 源码 parser/options.rs:170/569/586 实证」失实：inline_footnotes 属 Extension 非 Parse 选项，行号引用亦已漂移；实证=server/core/src/compute/markdown.rs extension 配置段 `ext.inline_footnotes`）、katex contrib/mhchem、vitest/playwright。

**Spec:** `docs/superpowers/specs/2026-10-19-markdown-markpad-alignment-design.md` §3、§4

## Global Constraints

- hardbreaks 保持 GFM（`breaks:false`/comrak `hardbreaks=false` 不动，spec 拍板）。
- 双引擎一致性机制=双侧金标 fixture：本地引擎单测断言渲染产物 == 金标（注释注明 comrak 侧对应形态，Rust 侧 markdown.rs 单测反向锚定）；不引入跨进程实时比对。
- katex 子路径必须 `.mjs` 裸子路径（`katex/contrib/mhchem`），禁止 `dist/contrib/*.js`（CJS 副本产生第二解析器、宏表分裂——markpad #745 教训）。
- 行内脚注 ^[note] 为风险项：无现成 markdown-it 插件，自写 inline rule 并入 markdown-it-footnote env；**降级路径**=实现失败（与 footnote env 结构冲突不可调和）则该语法保持字面渲染、双侧 spec 注记偏差，不阻塞其余交付。
  - **勘误（2026-10-21）**：上句「无现成插件、自写 inline rule」过时——markdown-it-footnote 4.0.0 自带 footnote_inline（注册于 `md.inline.ruler.after('image')`，与 `[^1]` 共用 env.footnotes.list 并轨编号），无需自写规则，风险项未发生、降级路径未触发。实证：engine.ts 文件头注释；markdownEngine.test.ts「行内脚注（Task 4）」describe 固化。
- wikilink 口径（spec §4.2）：`[[#heading]]` 锚跳转（href 交由既有 remapHeadingHashLinks 收口）；`[[file]]`/`[[file#heading]]` 降级不可点字面链接；`![[img]]`/`![[img|100]]`/`![[img|100x50]]` 嵌入 `<img>`（src=原文相对路径，交由既有 resolveRelativeImages 解析；尺寸段转 width/height，属性转义）。
- 测试在仓库根跑 vitest；cargo 勿与 vitest 并发；每任务原子提交。

---

### Task 1: KaTeX 对齐（mhchem + 新分隔符）

**Files:**
- Modify: `packages/render-text/src/markdown/pipeline.ts`（scanMathSegments 扩展 + runKatex mhchem）
- Modify: `packages/render-text/src/markdown/pipeline.test.ts`（或既有 katex 测试落位文件）

**Interfaces:**
- Produces: scanMathSegments 识别四形态：`$..$` 行内、`$$..$$` 块级、`\(..\)` 行内、`\[..\]` 块级；`\ce{}` mhchem 宏可用。

- [ ] **Step 1: 写失败测试**

```ts
// 追加到既有 katex 相关测试文件（rg 'scanMathSegments|runKatex|katex' packages/render-text/src/markdown/*.test.ts 定位）
it('KaTeX 分隔符扩展：\\(..\\) 行内与 \\[..\\] 块级', async () => {
  const doc = renderDoc('行内 \\(a^2\\) 与块级：\n\n\\[b_2\\]');
  expect(doc.body.innerHTML).toContain('katex');
  // $ 字面量不误伤（金额语义回归）
});
it('mhchem 宏：$\\ce{CO2 + C -> 2 Fe}$ 渲染含 mhchem 产物', async () => {
  const doc = renderDoc('$\\ce{CO2}$');
  const html = doc.body.innerHTML;
  expect(html).toContain('katex');
  // mhchem 输出特征：mchem 类或化学式排版 span（以实测 mhchem 产物特征断言，先手跑一次记录）
});
it('\\( 与 \\[ 在代码块/既有 .katex 祖先内不触发（跳过规则复用）', async () => {
  const doc = renderDoc('`\\(a^2\\)`');
  expect(doc.querySelector('code')!.textContent).toBe('\\(a^2\\)');
});
```

（renderDoc 为该测试文件既有 helper：sanitize→pipeline 最小装配；若无则以 markdownRenderer 的 doc 装配顺序同构。）

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run packages/render-text/src/markdown`
Expected: 新用例 FAIL

- [ ] **Step 3: 实现**

3a. scanMathSegments 的 while 循环加两个分支（`$` 分支之前）：

```ts
    if (ch === '\\' && text[i + 1] === '(') {
      const end = text.indexOf('\\)', i + 2);
      const inner = end === -1 ? '' : text.slice(i + 2, end).trim();
      if (end !== -1 && inner) {
        if (buf) segments.push({ kind: 'text', value: buf });
        segments.push({ kind: 'math', value: inner, display: false });
        buf = '';
        i = end + 2;
        continue;
      }
    }
    if (ch === '\\' && text[i + 1] === '[') {
      const end = text.indexOf('\\]', i + 2);
      const inner = end === -1 ? '' : text.slice(i + 2, end).trim();
      if (end !== -1 && inner) {
        if (buf) segments.push({ kind: 'text', value: buf });
        segments.push({ kind: 'math', value: inner, display: true });
        buf = '';
        i = end + 2;
        continue;
      }
    }
```

runKatex 的候选收集扩为：`value.includes('$') || value.includes('\\(') || value.includes('\\[')`。

3b. runKatex 的 katex 加载后加 mhchem（同实例扩展）：

```ts
  const katex = (await import('katex').catch(() => null))?.default;
  if (!katex) return;
  await import('katex/contrib/mhchem').catch(() => null); // .mjs 裸子路径：CJS 副本会产生第二解析器（#745）
```

（mhchem import 失败静默=无 \ce 宏，普通公式不受影响。）

- [ ] **Step 4: 跑测试确认通过 + render-text 回归**

Run: `pnpm vitest run packages/render-text`
Expected: 全绿（既有 $ 扫描用例零翻转）

- [ ] **Step 5: Commit**

```bash
git add packages/render-text/src/markdown/pipeline.ts packages/render-text/src/markdown/pipeline.test.ts
git commit -m "feat(md): katex 对齐——mhchem 宏与 \\(..\\)/\\[..\\] 分隔符"
```

---

### Task 2: 扩展语法 markdown-it 侧（mark/ins/deflist 注册）

**Files:**
- Modify: `packages/render-text/package.json`（+markdown-it-mark、markdown-it-ins、markdown-it-deflist；mark/ins 无类型声明时补 src/types/*.d.ts，先例 footnote/taskLists）
- Modify: `packages/render-text/src/markdown/engine.ts`（三插件注册）
- Modify: 既有 engine 测试文件

**Interfaces:**
- Produces: 本地引擎输出 `==x==`→`<mark>x</mark>`、`++x++`→`<ins>x</ins>`、`; term`/`: def`→`<dl><dt><dd>`（Task 3 comrak 侧金标交叉注记的本地半边）。

- [ ] **Step 1: 写失败测试**

```ts
// engine 既有测试文件追加
it('==mark== 渲染 <mark>', () => {
  expect(localRender('==高亮==')).toContain('<mark>高亮</mark>');
});
it('++ins++ 渲染 <ins>', () => {
  expect(localRender('++插入++')).toContain('<ins>插入</ins>');
});
it('描述列表 ; / : 渲染 dl/dt/dd', () => {
  const html = localRender('术语\n: 定义一行');
  expect(html).toContain('<dl>');
  expect(html).toContain('<dt>术语</dt>');
  expect(html).toContain('<dd>');
});
```

（localRender=该文件既有最小渲染 helper。）

- [ ] **Step 2: 跑测试确认失败**（安装依赖：`pnpm add --filter @vviewer/render-text markdown-it-mark markdown-it-ins markdown-it-deflist`）

- [ ] **Step 3: 实现 engine.ts**

```ts
import mark from 'markdown-it-mark';
import ins from 'markdown-it-ins';
import deflist from 'markdown-it-deflist';
// createMarkdownEngine 内 footnote 之后：
  md.use(mark);
  md.use(ins);
  md.use(deflist);
```

sanitize 核查：mark/ins/dl/dt/dd 均在 DOMPurify 默认允许表（engine 输出必经 sanitize——若有丢失，单测的 renderDoc 装配会暴露，需在 sanitize.ts 显式补 ALLOWED_TAGS 并注记）。

- [ ] **Step 4: 跑测试确认通过 + 回归**

- [ ] **Step 5: Commit**

```bash
git add packages/render-text/package.json pnpm-lock.yaml packages/render-text/src/markdown/engine.ts packages/render-text/src/types packages/render-text/src/markdown/engine.test.ts
git commit -m "feat(md): 扩展语法本地引擎注册——mark/ins/deflist 三插件"
```

---

### Task 3: comrak 侧 extension 开启 + 双侧金标锚

**Files:**
- Modify: `server/core/src/compute/markdown.rs`（extension.highlight/insert + extension.inline_footnotes + 单测）
- Modify: `packages/render-text/src/markdown/engine.test.ts`（金标注记：comrak 侧产物形态注释交叉引用）

**Interfaces:**
- Produces: 远程 comrak 输出 `<mark>`/`<ins>`/`<dl>`/行内脚注（形态=markdown-it 侧金标的对偶注记）。

- [ ] **Step 1: 写失败测试**（markdown.rs `mod tests`）：

```rust
    #[test]
    fn highlight_and_insert_extensions() {
        let html = render("==mark== 与 ++ins++", false);
        assert!(html.contains("<mark>mark</mark>"), "{html}");
        assert!(html.contains("<ins>ins</ins>"), "{html}");
    }

    #[test]
    fn inline_footnote_renders() {
        let html = render("正文^[注内容]续", false);
        assert!(html.contains("footnote-ref"), "{html}");
        assert!(html.contains("注内容"), "{html}");
    }
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cargo test --manifest-path server/Cargo.toml markdown::`
Expected: FAIL

- [ ] **Step 3: 实现**（markdown.rs options 段，extension 清单处追加）：

```rust
        // ==mark== / ++ins++（spec §4.1，markpad 同款）；行内脚注 ^[note]
        options.extension.highlight = true;
        options.extension.insert = true;
        options.extension.inline_footnotes = true; // 勘误 2026-10-21：Extension 非 Parse 选项
```

（**勘误 2026-10-21**：原文 `options.parser.inline_footnotes` 失实——`inline_footnotes` 属 ExtensionOptions（`options.extension` 字段访问），非 ParseOptions；实证=server/core/src/compute/markdown.rs extension 配置段。）

- [ ] **Step 4: 跑测试确认通过 + 全量 cargo 回归**；engine.test.ts 金标注记：在 Task 2 三用例注释补「comrak 对偶：server/core/src/compute/markdown.rs tests highlight_and_insert_extensions / inline_footnote_renders——形态一致以两侧断言互为锚」。

- [ ] **Step 5: Commit**

```bash
git add server/core/src/compute/markdown.rs packages/render-text/src/markdown/engine.test.ts
git commit -m "feat(server): comrak highlight/insert/inline_footnotes 开启+双侧金标锚"
```

---

### Task 4: 行内脚注 markdown-it 自写规则（风险项）

> **勘误（2026-10-21）**：本任务未按「自写规则」实施——markdown-it-footnote 4.0.0 自带 footnote_inline 直接覆盖（见 Global Constraints 勘误），无自写实现面；终态见 engine.ts 文件头注释与 markdownEngine.test.ts「行内脚注（Task 4）」describe。以下步骤为历史设想存档。

**Files:**
- Create: `packages/render-text/src/markdown/inlineFootnote.ts`（自写 md.use 插件）
- Modify: `packages/render-text/src/markdown/engine.ts`（注册）
- Modify: engine 测试

**Interfaces:**
- Produces: `^[文本]` → 与 markdown-it-footnote 同构的脚注引用+尾注（渲染产物含 footnote-ref/footnote-def 类，编号与 `[^1]` 体系并轨）。

- [ ] **Step 1: 写失败测试**

```ts
it('行内脚注 ^[注] 产出 footnote-ref 并入尾注', () => {
  const html = localRender('有注^[行内注]与常规[^1]\n\n[^1]: 常规注');
  expect(html).toContain('footnote-ref');
  expect(html).toContain('行内注');
  expect(html).toContain('常规注');
});
```

- [ ] **Step 2: 跑测试确认失败**

- [ ] **Step 3: 实现**：读 node_modules/markdown-it-footnote/index.js 摸 env 结构（`state.env.footnotes` 数组项 {id,label,count,token}——以实读为准），inline rule：匹配 `^\[`  + 直到 `]`（内容非空、不含 `]`），push env 条目并 emit 与 footnote_ref 相同 token 序列（复用其 renderer 规则）。**降级出口**：若 env 结构不可稳集成（版本耦合过深），放弃插件内注入，改为 enrich 层后处理（渲染字面 `^[..]` → 前端转脚注引用 DOM 并手补尾注节）——二选一以可实现性为准，报告记录选择与理由；彻底不可行则按 Global Constraints 降级字面+双侧 spec 注记。

- [ ] **Step 4: 跑测试确认通过**（或按降级出口记录）

- [ ] **Step 5: Commit**

```bash
git add packages/render-text/src/markdown/inlineFootnote.ts packages/render-text/src/markdown/engine.ts packages/render-text/src/markdown/engine.test.ts
git commit -m "feat(md): 行内脚注 ^[note]——并入 markdown-it-footnote 体系的自写规则"
```

---

### Task 5: callout 折叠后缀与折叠交互

**Files:**
- Modify: `packages/render-text/src/markdown/enrich.ts`（convertCallouts 解析 `+`/`-` 后缀 → 可折叠卡片）
- Modify: `apps/web/src/app.css`（折叠态样式 + 标题钮）
- Modify: enrich 相关测试

**Interfaces:**
- Produces: `> [!note]+` 默认展开、`> [!note]-` 默认收起；卡片结构在既有 markdown-alert 基础上加 `markdown-alert-foldable` 类与标题点击折叠（`markdown-alert-collapsed` 类切换）；无后缀行为零变化。

- [ ] **Step 1: 写失败测试**（enrich 测试文件，rg convertCallouts 定位）：

```ts
it('callout 折叠后缀：+ 默认展开、- 默认收起、无后缀不变', () => {
  const plus = enrichDoc('> [!note]+ 标题\n> 内容');
  expect(plus.querySelector('.markdown-alert-foldable')).not.toBeNull();
  expect(plus.querySelector('.markdown-alert-collapsed')).toBeNull();
  const minus = enrichDoc('> [!warning]- 标题\n> 内容');
  expect(minus.querySelector('.markdown-alert-collapsed')).not.toBeNull();
  const plain = enrichDoc('> [!note] 标题\n> 内容');
  expect(plain.querySelector('.markdown-alert-foldable')).toBeNull();
});
it('折叠交互：标题点击切换 collapsed', () => {
  const doc = enrichDoc('> [!note]- 标题\n> 内容');
  (doc.querySelector('.markdown-alert-title') as HTMLElement).click();
  expect(doc.querySelector('.markdown-alert-collapsed')).toBeNull();
});
```

- [ ] **Step 2: 跑测试确认失败**

- [ ] **Step 3: 实现 enrich.ts**：callout 正则 `[!type]` 后捕获可选 `[+-]`（`\][ \t]*([+-])?(?=\s|$)` 语义——后缀必须紧随 `]` 且后随空白/行尾，`[!note]+x` 不触发折叠（未知语法从保守））；有后缀时 container 加 `markdown-alert-foldable` + 按符号预置 `markdown-alert-collapsed`，titleEl 加折叠钮类与 click 监听（toggle collapsed 类——节点挂载进主文档后监听保留，copyBtn 先例）。CSS：`.markdown-alert-collapsed` 隐藏标题外内容（`> :not(.markdown-alert-title) { display: none }`）+ 标题钮指示符（::after '▾/▸'）。

- [ ] **Step 4: 跑测试确认通过 + render-text 回归**

- [ ] **Step 5: Commit**

```bash
git add packages/render-text/src/markdown/enrich.ts packages/render-text/src/markdown/enrich.test.ts apps/web/src/app.css
git commit -m "feat(md): callout 折叠后缀 +/−——GitHub 语义默认开合与标题点击切换"
```

---

### Task 6: wikilink 四形态（enrich 文本扫描）

**Files:**
- Modify: `packages/render-text/src/markdown/enrich.ts`（新 convertWikilinks，callout 之后调用）
- Modify: enrich 测试

**Interfaces:**
- Produces: `[[#slug]]`→`<a href="#slug" data-wikilink="anchor">`（后续 remapHeadingHashLinks 统一改写 user-content- id）；`![[path]]`/`![[path|W]]`/`![[path|WxH]]`→`<img src="path" width? height?>`（src 交既有 resolveRelativeImages）；`[[file…]]`→`<span class="md-wikilink-dead" title="跨文件 wikilink 不支持">`；**围栏/代码内字面不触发**（扫描走文本节点且跳过 code/pre 祖先——复用 katex 步 MATH_SKIP_TAGS 同思路）。

- [ ] **Step 1: 写失败测试**

```ts
it('[[#heading]] 产锚链接并经 remap 收口', () => {
  const doc = enrichDoc('跳[[#目标]]转\n\n## 目标');
  const a = doc.querySelector('a[data-wikilink="anchor"]')!;
  expect(a.getAttribute('href')).toBe('#目标'); // 原样 slug，remapHeadingHashLinks(markdownRenderer) 统一改写
});
it('![[img.png]] 与尺寸段', () => {
  const doc = enrichDoc('![[pic.png]] 与 ![[p2.png|100]] 与 ![[p3.png|100x50]]');
  const imgs = doc.querySelectorAll('img');
  expect(imgs.length).toBe(3);
  expect(imgs[0]!.getAttribute('src')).toBe('pic.png');
  expect(imgs[1]!.getAttribute('width')).toBe('100');
  expect(imgs[2]!.getAttribute('width')).toBe('100');
  expect(imgs[2]!.getAttribute('height')).toBe('50');
});
it('[[file]] 跨文件形态降级不可点', () => {
  const doc = enrichDoc('见 [[Other.md]]');
  const dead = doc.querySelector('.md-wikilink-dead')!;
  expect(dead.textContent).toBe('[[Other.md]]');
  expect(doc.querySelector('a[href="Other.md"]')).toBeNull();
});
it('代码内 [[x]] 字面保留', () => {
  const doc = enrichDoc('`[[x]]`');
  expect(doc.querySelector('code')!.textContent).toBe('[[x]]');
  expect(doc.querySelector('a[data-wikilink]')).toBeNull();
});
```

- [ ] **Step 2: 跑测试确认失败**

- [ ] **Step 3: 实现 enrich.ts**：文本节点 TreeWalker（跳 PRE/CODE/SCRIPT/STYLE/A——A 内不嵌套改写）；正则 `/(!?)\[\[([^\[\]]+)\]\]/g`：
  - `!` + 内容按 `|` 分段：首段=路径，次段尺寸（`W` 或 `WxH`，正则 `^\d+(?:x\d+)?$` 校验，非法则忽略尺寸段并入路径段？不——非法尺寸段按多段处理只取首段路径、其余丢弃并注记）；造 `<img>`（src 原文、width/height setAttribute 数字字面量）。
  - 无 `!`：内容以 `#` 开头 → `<a href="#slug">`；否则 → `<span class="md-wikilink-dead" title="跨文件 wikilink 不支持">原文</span>`。
  - 文本节点 replaceWith 片段（混合段落多节点拆分）。
  - 调用点：convertCallouts 之后（enrich 主函数内注册顺序注记）。
  - `#slug` 的 slug 原样保留（GfmAnchorizer 基名由用户写时对齐；remapHeadingHashLinks 对不存在锚的处理已有降级）。

- [ ] **Step 4: 跑测试确认通过 + 回归**（含 markdownRenderer 级：[[#x]] 经完整装配后 href 被 remap 为 user-content- 前缀——若该链路已由 remapHeadingHashLinks 自动覆盖则补一条集成断言）

- [ ] **Step 5: Commit**

```bash
git add packages/render-text/src/markdown/enrich.ts packages/render-text/src/markdown/enrich.test.ts
git commit -m "feat(md): wikilink 四形态——锚跳转/嵌入 img/跨文件降级/代码豁免"
```

---

### Task 7: 代码块语言徽标

**Files:**
- Modify: `packages/render-text/src/markdown/pipeline.ts`（copyCode 步重构：pre 顶栏 lang 徽标+复制语义并入）
- Modify: `apps/web/src/app.css`（徽标样式）
- Modify: 既有 copyCode 测试

**Interfaces:**
- Produces: `<pre>` 首子元素 `div.md-code-bar`（`span.md-code-lang`（语言词，无语言时「代码」）+ 既有复制钮迁入 bar 保留「复制」文案——语义并入=徽标+按钮同 bar，点击行为不并入（保持单复制钮，避免双触发面））。**计划裁决**：spec 原文「点击徽标=复制、现有按钮语义并入徽标」与「无语言显示复制图标」三态交互过密，取简：bar 内 [lang 徽标 | 复制钮] 并排，行为各一——对 markpad 的「徽标即复制」交互为知情简化，报告/spec 注记。

- [ ] **Step 1: 写失败测试**

```ts
it('copyCode 语言徽标：有语言显示词、无语言显示「代码」', async () => {
  const doc = docWithFence('rust', 'fn main() {}');
  const doc2 = docWithFence('', 'plain');
  await runPipeline(doc, baseCtx);
  await runPipeline(doc2, baseCtx);
  expect(doc.querySelector('.md-code-lang')!.textContent).toBe('rust');
  expect(doc2.querySelector('.md-code-lang')!.textContent).toBe('代码');
  expect(doc.querySelector('.md-code-bar .md-copy-btn')).not.toBeNull(); // 复制钮迁入 bar
});
```

- [ ] **Step 2: 跑测试确认失败**

- [ ] **Step 3: 实现**：runCopyCode 内 pre 前插 bar（pre.firstChild 前 insertBefore），复制钮 append 进 bar（原逻辑不动）；lang 取 code 的 language- 类首词小写化。CSS：`.md-code-bar`（flex、`position: sticky`? 取简单 absolute 右上并入现状——copyBtn 现为 absolute 右上（app.css:114），bar 改为 pre 顶部一行 flex，copyBtn 的 absolute 定位退役改 static）。

- [ ] **Step 4: 跑测试确认通过**（既有 copyBtn 断言若定位断言变化同步修）+ e2e 涉及 copy 的用例回归（b-markdown 系 copy 断言 rg 定位核对）

- [ ] **Step 5: Commit**

```bash
git add packages/render-text/src/markdown/pipeline.ts packages/render-text/src/markdown/pipeline.test.ts apps/web/src/app.css
git commit -m "feat(md): 代码块语言徽标——bar 内徽标+复制钮迁移"
```

---

### Task 8: e2e + 文档 + 门禁

**Files:**
- Create: `apps/web/e2e/b-md-syntax.spec.ts`；Modify: `README.md`

- [ ] **Step 1: e2e 用例**（照 b-md-diagrams 的上传/连接 helper）：
  1. mark/ins/deflist 渲染断言（mark/ins/dl 选择器）
  2. callout 折叠（`[!note]-` 默认收起→标题点击展开）
  3. wikilink 锚跳（文档含 `## 目标` 与 `[[#目标]]`，点击后 location.hash 变化或目标 heading 进入视口）
  4. 代码徽标可见
  夹具 samples/md/syntax-sampler.md（含全部语法样本；math/mhchem 断言含 katex 类）。
- [ ] **Step 2: README 图表矩阵行旁补扩展语法短句（mark/ins/deflist/行内脚注/callout 折叠/wikilink 锚与嵌入/语言徽标）**
- [ ] **Step 3: 门禁**：`pnpm typecheck && pnpm vitest run && pnpm --filter web build:e2e && pnpm --filter web exec playwright test b-md-syntax && cargo test --manifest-path server/Cargo.toml`
- [ ] **Step 4: Commit**

```bash
git add apps/web/e2e/b-md-syntax.spec.ts samples/md/syntax-sampler.md README.md
git commit -m "test(e2e): 扩展语法冒烟四用例+README 同步"
```
