// engine.ts — markdown-it 引擎：GFM 全家（table/strikethrough 内建，tasklist 插件，
// footnote 插件，linkify）+ html:true。输出必经 sanitizeHtml（sanitize.ts）后才能入 DOM。
// footnote（终审批次 C）：补齐与 comrak（服务端）的 GFM 脚注能力对齐——此前本地引擎
// 把 `[^1]` 渲染成字面文本而服务端出 footnote-ref，同文档双引擎渲染不一致。
// 删除线（BUG-67/CAND-cmp-F1，同缺陷类 BUG-66/CAND-md-F1）：markdown-it v13 起
// strikethrough 默认标签由 del 改为 <s>，而远程 comrak ext.strikethrough 出 <del>
// （server/src/compute/markdown.rs）——同文档 remote/local 双引擎 DOM 指纹必然差一个
// 标签。renderer rule 改写回 <del>（GFM 规范推荐标签），与 comrak 对齐。
// mark/ins/deflist（Task 2，md-katex 语法对齐计划）：扩展语法 `==x==`→<mark>、
// `++x++`→<ins>、term/`: def`→<dl><dt><dd>——与 comrak 侧扩展语法金标的本地半边
// 对齐，此前三语法本地引擎均输出字面文本。
// 行内脚注 `^[note]`（Task 4，同计划）：无需自写规则——markdown-it-footnote 4.0.0
// 自带 footnote_inline（其 index.mjs「Process inline footnotes」节，注册于
// inline.ruler.after('image')），与 `[^1]` 共用 env.footnotes.list 并轨编号；
// md-katex 计划设想的「自写 inline rule 并入同一 env」经实读源码与实测确认没有
// 实现面，行为由 test/markdownEngine.test.ts「行内脚注（Task 4）」describe 固化。
// 双端等价面口径：comrak 行内脚注深层形态（#fn-__inline_N、尾注 ol 无类、
// data-footnote-backref）与本插件（#fnN、ol.footnotes-list、footnote-backref 类）
// 不等深同构，等价面=class + DOM 结构层，勿跨端互锚 id 形态。
import MarkdownIt from 'markdown-it';
import type { MarkdownIt as MarkdownItInstance } from 'markdown-it';
// markdown-it-task-lists / markdown-it-footnote / markdown-it-mark / markdown-it-ins /
// markdown-it-deflist 均无类型声明，见 src/types/*.d.ts
import taskLists from 'markdown-it-task-lists';
import footnote from 'markdown-it-footnote';
import mark from 'markdown-it-mark';
import ins from 'markdown-it-ins';
import deflist from 'markdown-it-deflist';
import { parseFrontMatter } from './frontMatter';

export interface MarkdownRenderResult {
  html: string;
  frontMatter: Record<string, unknown> | null;
}

export type MarkdownEngine = MarkdownItInstance;

/** 创建共享配置的 markdown-it 实例（html:true 输出必经净化；tasklist 复选框 disabled）。 */
export function createMarkdownEngine(): MarkdownEngine {
  const md = new MarkdownIt({ html: true, linkify: true, breaks: false });
  md.use(taskLists, { enabled: false });
  md.use(footnote);
  // 扩展语法三插件（Task 2）：mark/ins/dl/dt/dd 均在 DOMPurify 默认允许表，
  // sanitize 侧无需显式放行（markdownSanitize.test.ts 装配用例固化）
  md.use(mark);
  md.use(ins);
  md.use(deflist);
  // 删除线输出 <del>（对齐 comrak/GFM，见文件头注释）。markdown-it v15 的
  // token 类型为 s_open/s_close（内建默认渲染 <s>），按名覆写
  md.renderer.rules.s_open = () => '<del>';
  md.renderer.rules.s_close = () => '</del>';
  installHeadingAnchors(md);
  return md;
}

/**
 * 标题尾置锚链接（BUG-67 指纹对齐第二处分歧）：远程 comrak 开 header_id_prefix
 * （server/src/compute/markdown.rs）为每级标题输出 id，并在标题末尾渲染空锚
 * `<a href="#{id}" aria-label="Link to heading '{text}'"
 * data-heading-content="{text}" class="anchor"></a>`（comrak 0.56 html.rs
 * render_heading）。本地 markdown-it 此前不产锚，同文档双引擎 DOM 指纹差 a.anchor。
 * BUG-39 裁决落地（2026-10-17，Wave 4）：双引擎 heading id 方案统一为 user-content-
 * 前缀命名空间（GitHub 同款）——本规则 href 与 comrak（header_id_prefix_in_href=true）
 * 同款输出带前缀完整锚；本地 heading 的实际 id 由 enrich 侧 assignHeadingIds 用同一
 * GfmAnchorizer 分配（markdownRenderer.ts），引擎 href 形态与其一致，前端锚 href
 * 改写步再按最终 id 收口（自一致由构造保证）。
 */
export class GfmAnchorizer {
  private ids = new Set<string>();
  private nextSuffix = new Map<string, number>();

  /** GFM 基名变换（comrak Anchorizer 同款）：小写 → 保留 空格/-/字母/附标/数字/
   * 连接标点 → 空格转 '-'。不去重。 */
  baseSlug(text: string): string {
    return text
      .toLowerCase()
      .replace(/[^ \-\p{L}\p{M}\p{N}\p{Pc}]/gu, '')
      .replace(/ /g, '-');
  }

  /** comrak Anchorizer 同款去重：首现无后缀，重名 -1 起顺延。 */
  anchorize(text: string): string {
    const base = this.baseSlug(text);
    let uniq = this.nextSuffix.get(base) ?? 0;
    let anchor: string;
    for (;;) {
      anchor = uniq === 0 ? base : `${base}-${uniq}`;
      if (!this.ids.has(anchor)) break;
      uniq += 1;
    }
    this.ids.add(anchor);
    this.nextSuffix.set(base, uniq + 1);
    return anchor;
  }

  /** 预占既有 id（作者 HTML / 远程预填标题）：后续 anchorize 自动避让。 */
  reserve(id: string): void {
    this.ids.add(id);
  }
}

function installHeadingAnchors(md: MarkdownEngine): void {
  const headingText = (inline: { content: string; children: { content: string }[] | null } | undefined): string => {
    if (!inline) return '';
    if (inline.children === null) return inline.content;
    return inline.children.map((c) => c.content).join('');
  };
  const escapeAttr = (s: string): string =>
    s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  md.renderer.rules.heading_close = (tokens, idx, _options, env) => {
    // tokens[idx-1] = inline（标题文本）；id 取 comrak 同款 GFM anchorize + user-content-
    // 前缀（BUG-39 双引擎统一命名空间；本地 heading 的实际 id 归 enrich assignHeadingIds，
    // 同一 GfmAnchorizer 算法，最终一致）
    const text = headingText(tokens[idx - 1]);
    const scope = (env ??= {}) as { __anchorizer?: GfmAnchorizer };
    const state = scope.__anchorizer ?? (scope.__anchorizer = new GfmAnchorizer());
    const id = state.anchorize(text);
    const escaped = escapeAttr(text);
    return `<a href="#user-content-${id}" aria-label="Link to heading '${escaped}'" data-heading-content="${escaped}" class="anchor"></a></${tokens[idx]!.tag}>\n`;
  };
}

const sharedEngine = createMarkdownEngine();

/**
 * LaTeX 定界符前置改写（Task 1b，markpad src-tauri local_commands.rs markdown_ext
 * process_latex_delimiters 同款语义；服务端对偶实现见 server/src/compute/markdown.rs
 * apply_latex_delimiters）：`\(..\)`→`$..$`、`\[..\]`→`$$..$$`——markdown-it/comrak
 * 按 CommonMark 消费 `\(`/`\[` 的反斜杠转义，数学定界符到不了解析器，先于引擎把
 * 定界符统一成上游 math 词汇 $/$$。
 *
 * 跳过规则：围栏码块（行首 ≤3 空格缩进的 ```/``` 与 ~~~，闭围栏同字符且不少于开
 * 长度、仅剩空白）整段透传；单反引号行内码 span（`` `..` ``，可跨行）内透传——状态
 * 机与 markpad 同款翻转语义。继承性边界（markpad Task 14 审查补记同款，只记录不改
 * 行为）：双反引号 ``...`` 行内码翻转两次后失同步、4 空格缩进码块不跟踪，其中的
 * `\[…\]`/`\(…\)` 仍会被转换。数学态内容流式直出、闭定界符在闭合处补写：未闭合时
 * 开定界符已消耗、内容原样保留（markpad 同款；结构保序修复 2026-10-23——此前字符
 * 缓冲至闭合/EOF 回填，未闭合 \[ 令数百行正文搬进缓冲拼成一行，围栏/表格结构失效，
 * stress-test.md:679 语料实证）。CRLF/CR 在入口归一化为 \n
 * （修复轮 1/m1：split('\n') 残留 \r 会卡死闭围栏判定；CommonMark 本就视 \r\n 为
 * 换行，归一化不改渲染语义）。
 */
export function protectLatexDelimiters(text: string): string {
  let out = '';
  // 围栏按行判定（CommonMark 行语义），围栏外逐字符状态机、行内码/数学状态跨行持续
  let fence: { ch: string; len: number } | null = null;
  let inInlineCode = false;
  let inDisplayMath = false;
  let inInlineMath = false;

  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  for (let li = 0; li < lines.length; li++) {
    const line = lines[li]!;
    if (li > 0) out += '\n';
    if (fence) {
      out += line;
      // 闭围栏：同字符、不少于开长度、行内仅剩空白（≤3 空格缩进）
      const close = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(line);
      if (close && close[1]![0] === fence.ch && close[1]!.length >= fence.len) fence = null;
      continue;
    }
    // 开围栏：```（info 串不得含反引号——否则按 CommonMark 是行内码起点，不当围栏）
    // 或 ~~~（info 串任意）
    const open = /^ {0,3}((`{3,})[^`]*$|(~{3,}))/.exec(line);
    if (open) {
      const mark = open[2] ?? open[3]!;
      fence = { ch: mark[0]!, len: mark.length };
      out += line;
      continue;
    }
    // 非围栏行：` 行内码翻转 → 码内透传 → 数学进出（markpad 状态机同款）
    let i = 0;
    while (i < line.length) {
      const ch = line[i]!;
      if (ch === '`' && !inDisplayMath && !inInlineMath) {
        inInlineCode = !inInlineCode;
        out += ch;
        i += 1;
        continue;
      }
      if (inInlineCode) {
        out += ch;
        i += 1;
        continue;
      }
      const nxt = line[i + 1];
      if (!inDisplayMath && !inInlineMath) {
        if (ch === '\\' && nxt === '[') {
          inDisplayMath = true;
          out += '$$';
          i += 2;
          continue;
        }
        if (ch === '\\' && nxt === '(') {
          inInlineMath = true;
          out += '$';
          i += 2;
          continue;
        }
        out += ch;
        i += 1;
      } else if (inDisplayMath) {
        if (ch === '\\' && nxt === ']') {
          inDisplayMath = false;
          out += '$$';
          i += 2;
          continue;
        }
        // 数学内容流式直出（不改写即缓冲目的的全部语义）：闭定界符在闭合处补写。
        // 此前字符缓冲至闭合/EOF 回填——未闭合/远闭合的 \[（stress-test.md:679
        // 「\[ not a link」字面示例实证）会把数百行正文搬进缓冲在 EOF 拼成一行，
        // markdown 结构整段失效（围栏标记行拼接、表格并入一行）。
        out += ch;
        i += 1;
      } else {
        if (ch === '\\' && nxt === ')') {
          inInlineMath = false;
          out += '$';
          i += 2;
          continue;
        }
        out += ch;
        i += 1;
      }
    }
  }
  return out;
}

/** markdown 源 → { html, frontMatter }。front matter 解析失败/非映射时为 null 且原文整体渲染。 */
export function renderMarkdownToHtml(src: string): MarkdownRenderResult {
  const { frontMatter, body } = parseFrontMatter(src);
  return { html: sharedEngine.render(protectLatexDelimiters(body)), frontMatter };
}
