// enrich.ts — 净化后 DOM 的展示性增强：callout 卡片与音视频媒体占位。
import { hostOf, isExternalMediaSrc } from './sanitize';
// 移植自 markpad src/lib/utils/markdown.ts 的 processMarkdownHtml（callout 块引用
// pass 与 img/a 媒体替换 pass），剥离 Tauri invoke/convertFileSrc、fold 状态、
// sourcepos 携带与 YouTube 替换（不在 vviewer M3 契约内）。

// 已知 callout 类型（≥6）：命中者带图标；未命中者仍转卡片（默认样式类 + 大写类型名标题）。
const CALLOUT_ICONS: Readonly<Record<string, string>> = {
  note: '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"/><path d="m15 5 4 4"/></svg>',
  info: '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/></svg>',
  todo: '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21.801 10A10 10 0 1 1 17 3.335"/><path d="m9 11 3 3L22 4"/></svg>',
  tip: '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 2.5z"/></svg>',
  important: '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" x2="12" y1="8" y2="12"/><line x1="12" x2="12.01" y1="16" y2="16"/></svg>',
  warning: '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/></svg>',
  caution: '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="7.86 2 16.14 2 22 7.86 22 16.14 16.14 22 7.86 22 2 16.14 2 7.86 7.86 2"/><line x1="12" x2="12" y1="8" y2="12"/><line x1="12" x2="12.01" y1="16" y2="16"/></svg>',
  faq: '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><path d="M12 17h.01"/></svg>',
  question: '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><path d="M12 17h.01"/></svg>',
  example: '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="8" x2="21" y1="6" y2="6"/><line x1="8" x2="21" y1="12" y2="12"/><line x1="8" x2="21" y1="18" y2="18"/><line x1="3" x2="3.01" y1="6" y2="6"/><line x1="3" x2="3.01" y1="12" y2="12"/><line x1="3" x2="3.01" y1="18" y2="18"/></svg>',
};

// BUG-17/MD-13：enrich 在 sanitize 之后执行——img/a 转出的媒体元素不在净化
// 覆盖内。外域 http(s) 媒体与 sanitize 层同口径：强制 preload="none" 并去
// autoplay（不点不发请求；点播放=主动行为，与 <a href> 外链不拦一致），
// title 留域名悬停提示。
function applyExternalMediaGuard(media: Element, url: string): void {
  if (!isExternalMediaSrc(url)) return;
  media.setAttribute('preload', 'none');
  media.removeAttribute('autoplay');
  media.setAttribute('title', `外域媒体：${hostOf(url)}（点击播放才发起请求）`);
}

// ASCII 空白才算空（与 markpad 一致：U+00A0 是作者有意输入，不当作空）。
function isBlank(text: string | null | undefined): boolean {
  return /^[ \t\n\f\r]*$/.test(text ?? '');
}

/** 去掉查询串/锚点后取小写扩展名。 */
function mediaExtension(url: string): string | null {
  const path = url.replace(/[?#][\s\S]*$/, '');
  const m = path.match(/\.([a-z0-9]+)$/i);
  return m ? (m[1]?.toLowerCase() ?? null) : null;
}

const VIDEO_EXTS = new Set(['mp4', 'webm', 'ogg']);
const AUDIO_EXTS = new Set(['mp3', 'wav', 'flac', 'm4a']);

/** 媒体替换：img/a 指向音视频扩展名时替换为 video/audio 占位（controls，保留语义属性）。 */
function convertMediaElements(root: Document): void {
  for (const img of Array.from(root.querySelectorAll('img'))) {
    const src = img.getAttribute('src');
    if (!src) continue;
    const ext = mediaExtension(src);
    if (!ext) continue;
    const isVideo = VIDEO_EXTS.has(ext);
    const isAudio = AUDIO_EXTS.has(ext);
    if (!isVideo && !isAudio) continue;

    const media = root.createElement(isVideo ? 'video' : 'audio');
    media.setAttribute('controls', '');
    media.setAttribute('src', src);
    media.style.maxWidth = '100%';
    applyExternalMediaGuard(media, src);
    if (img.hasAttribute('width')) media.setAttribute('width', img.getAttribute('width')!);
    if (img.hasAttribute('height')) media.setAttribute('height', img.getAttribute('height')!);
    if (img.hasAttribute('alt')) media.setAttribute('aria-label', img.getAttribute('alt')!);
    if (img.hasAttribute('title')) media.setAttribute('title', img.getAttribute('title')!);
    img.replaceWith(media);
  }

  for (const a of Array.from(root.querySelectorAll('a'))) {
    const href = a.getAttribute('href');
    if (!href) continue;
    const ext = mediaExtension(href);
    if (!ext || (!VIDEO_EXTS.has(ext) && !AUDIO_EXTS.has(ext))) continue;

    const media = root.createElement(VIDEO_EXTS.has(ext) ? 'video' : 'audio');
    media.setAttribute('controls', '');
    media.setAttribute('src', href);
    media.style.maxWidth = '100%';
    applyExternalMediaGuard(media, href);
    const label = a.textContent?.trim();
    if (label) media.setAttribute('aria-label', label);
    a.replaceWith(media);
  }
}

/**
 * callout 转换：块引用首段以 `[!type]` 开头（Obsidian/GitHub 语法）时替换为
 * div.markdown-alert.markdown-alert-{type} 卡片（标题 + 内容）。代码 fence 中的
 * `[!type]` 字样是正文，不触发；嵌套引用（`> > [!type]`）只转换内层——外层
 * 的首子元素是 blockquote 而非段落，不匹配标记，保持块引用（转换出的卡片
 * 留在外层引用内）。
 */
function convertCallouts(root: Document): void {
  for (const bq of Array.from(root.querySelectorAll('blockquote'))) {
    // 只有引用首段落打开的文本才是标记
    let first = bq.firstChild;
    while (first && first.nodeType === 3 && isBlank(first.textContent)) first = first.nextSibling;
    const lead =
      first?.nodeType === 1 && (first as Element).tagName === 'P' ? first.firstChild : null;
    // 标记后空白只吞空格/制表（不含换行）：换行是标题行终止符，吞掉会把
    // 次行内容并进标题（markdown-it 软换行输出 '\n' 而非 <br>）
    const matchResult =
      lead?.nodeType === 3
        ? lead.nodeValue?.match(/^\s*\[!([a-zA-Z0-9_\-]+)\][^\S\n]*/i)
        : null;
    if (!matchResult || !lead) continue;
    const textNode = lead as Text;

    // 折叠后缀（Task 5，GitHub 语义）：] 后可隔空白紧跟 + 或 -、且其后随空白/
    // 行尾才算折叠标记——`[!note]+x` 未知语法从保守（不折叠，原文留在标题），
    // `[!note] -5 度` 等正文负号由 (?=\s|$) 前瞻保护不误判。
    let fold: '+' | '-' | null = null;
    let consumed = matchResult[0].length;
    const rest = textNode.nodeValue!.slice(consumed);
    const foldMatch = rest.match(/^[ \t]*([+-])(?=\s|$)/);
    if (foldMatch) {
      fold = foldMatch[1] as '+' | '-';
      consumed += foldMatch[0].length;
      // 后缀与标题间的空白吞掉（与无后缀路径 ] 后 [^\S\n]* 的既有处理对齐）
      consumed += rest.slice(foldMatch[0].length).match(/^[^\S\n]*/)![0].length;
    }
    textNode.nodeValue = textNode.nodeValue!.slice(consumed);

    const type = (matchResult[1] ?? '').toLowerCase();

    // 标题 = 首行剩余节点。行终止：markpad 的 <br>（comrak hardbreaks）在这里对应
    // markdown-it 软换行输出的 '\n'——含换行的文本节点按首个 '\n' 分割，
    // 前半归标题、后半留在段落内进内容区。
    const titleNodes: Node[] = [];
    let current: Node | null = textNode;
    while (current) {
      if (current.nodeType === 3) {
        const value = current.nodeValue ?? '';
        const nl = value.indexOf('\n');
        if (nl !== -1) {
          const after = root.createTextNode(value.slice(nl + 1));
          current.nodeValue = value.slice(0, nl);
          if (current.nextSibling) {
            current.parentNode!.insertBefore(after, current.nextSibling);
          } else if (current.parentNode) {
            current.parentNode.appendChild(after);
          }
          titleNodes.push(current);
          break;
        }
      }
      if (current.nodeType === 1 && (current as Element).tagName === 'BR') {
        const br = current;
        current = br.nextSibling;
        br.parentElement?.removeChild(br);
        break;
      }
      const next: Node | null = current.nextSibling;
      titleNodes.push(current);
      current = next;
    }

    const container = root.createElement('div');
    container.className = `markdown-alert markdown-alert-${type}`;

    const titleEl = root.createElement('p');
    titleEl.className = 'markdown-alert-title';
    // 折叠后缀：foldable 卡片 + 按符号预置收起（+ 展开 / − 收起）；标题点击切换
    // collapsed——节点挂载进主文档后监听随节点保留（copyBtn 先例）
    if (fold) {
      container.classList.add('markdown-alert-foldable');
      if (fold === '-') container.classList.add('markdown-alert-collapsed');
      titleEl.classList.add('markdown-alert-fold-toggle');
      // 标题内锚链接（如 [[#…]] 转出的 a）点击按链接语义导航：冒泡到标题的
      // click 不得切换折叠（closest 由 target 自身起算，覆盖 a 内子节点）
      titleEl.addEventListener('click', (ev) => {
        if ((ev.target as Element)?.closest('a')) return;
        container.classList.toggle('markdown-alert-collapsed');
      });
    }
    const titleInner = root.createElement('span');
    titleInner.className = 'callout-title-inner';
    for (const tn of titleNodes) titleInner.appendChild(tn);
    // 空标题回退为类型大写名
    if (titleInner.textContent?.trim() === '') {
      titleInner.textContent = type.charAt(0).toUpperCase() + type.slice(1);
    }
    for (const br of Array.from(titleInner.querySelectorAll('br'))) {
      br.parentElement?.removeChild(br);
    }

    const iconHtml = CALLOUT_ICONS[type] ?? '';
    if (iconHtml) {
      const temp = root.createElement('div');
      temp.innerHTML = iconHtml;
      if (temp.firstChild) titleEl.appendChild(temp.firstChild);
    }
    titleEl.appendChild(titleInner);
    container.appendChild(titleEl);

    const contentWrapper = root.createElement('div');
    contentWrapper.className = 'markdown-alert-content';
    const contentInner = root.createElement('div');
    contentInner.className = 'content-inner';
    contentWrapper.appendChild(contentInner);
    while (bq.firstChild) contentInner.appendChild(bq.firstChild);
    container.appendChild(contentWrapper);

    bq.replaceWith(container);
  }
}

/**
 * wikilink 四形态（Task 6，Obsidian 语法子集）：文本节点扫描——跳过 PRE/CODE/
 * SCRIPT/STYLE 祖先（代码字面不触发，katex 步 MATH_SKIP_TAGS 同思路）与 A（链接
 * 内不嵌套造链接）；已处理的降级 span 同样跳过（enrichMarkdownDom 幂等契约）。
 * - `[[#slug]]` → a[href="#slug"][data-wikilink=anchor]：href 原样保留，由
 *   markdownRenderer 的 remapHeadingHashLinks 在 id 定型后统一改写（enrich 在
 *   assignHeadingIds 之前运行，拿不到最终 id，不做自己的改写）；
 * - `![[path]]` / `![[path|W]]` / `![[path|WxH]]` → img[src=path]（width/height
 *   按 `^\d+(?:x\d+)?$` 校验的尺寸段；src 原文相对路径，markdownRenderer 的
 *   resolveRelativeImages 按 doc 级 img 查询解析 blob URL，enrich 造的 img 自然
 *   被覆盖）。外域 http(s)/协议相对地址不造 img——enrich 在 sanitize 之后执行，
 *   放行即绕过净化层的外域跟踪像素拦截（BUG-17），降级为不可点原文；
 * - `[[file…]]` → span.md-wikilink-dead（跨文件 wikilink 不支持，原文保留不可点）。
 * 尺寸段非法（含多段）时只取首段路径、尺寸丢弃——未知写法从保守。
 */
const WIKILINK_RE = /(!?)\[\[([^\[\]]+)\]\]/g;
const WIKILINK_SKIP_TAGS = new Set(['PRE', 'CODE', 'SCRIPT', 'STYLE', 'A']);

function buildWikilink(root: Document, embed: boolean, content: string, raw: string): Node {
  if (embed) {
    const path = (content.split('|')[0] ?? '').trim();
    if (path !== '' && !isExternalMediaSrc(path)) {
      const img = root.createElement('img');
      img.setAttribute('src', path);
      const size = content.split('|')[1]?.match(/^(\d+)(?:x(\d+))?$/);
      if (size) {
        img.setAttribute('width', size[1]!);
        if (size[2] !== undefined) img.setAttribute('height', size[2]!);
      }
      return img;
    }
  } else {
    const slug = content.trim();
    if (slug.startsWith('#')) {
      const a = root.createElement('a');
      a.setAttribute('href', `#${slug.slice(1)}`);
      a.setAttribute('data-wikilink', 'anchor');
      a.textContent = raw;
      return a;
    }
  }
  // 跨文件 wikilink / 外域嵌入降级：不可点原文
  const span = root.createElement('span');
  span.className = 'md-wikilink-dead';
  span.setAttribute('title', '跨文件 wikilink 不支持');
  span.textContent = raw;
  return span;
}

function convertWikilinks(root: Document): void {
  const walker = root.createTreeWalker(root.body, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement;
      if (parent?.classList.contains('md-wikilink-dead')) return NodeFilter.FILTER_REJECT;
      let cur: Node | null = node.parentNode;
      while (cur && cur !== root.body) {
        if (cur.nodeType === 1 && WIKILINK_SKIP_TAGS.has((cur as Element).tagName)) {
          return NodeFilter.FILTER_REJECT;
        }
        cur = cur.parentNode;
      }
      return NodeFilter.FILTER_ACCEPT;
    },
  });

  // 先收集后替换：替换产生的片段含原文形态的 [[..]] 文本（在 a/span 内），
  // 快照避免 walker 复访二次改写
  const targets: Text[] = [];
  let node: Node | null;
  while ((node = walker.nextNode())) {
    if ((node.nodeValue ?? '').includes('[[')) targets.push(node as Text);
  }

  for (const target of targets) {
    const value = target.nodeValue ?? '';
    WIKILINK_RE.lastIndex = 0;
    if (!WIKILINK_RE.test(value)) continue;
    WIKILINK_RE.lastIndex = 0;
    const frag = root.createDocumentFragment();
    let last = 0;
    let m: RegExpExecArray | null;
    while ((m = WIKILINK_RE.exec(value)) !== null) {
      if (m.index > last) frag.appendChild(root.createTextNode(value.slice(last, m.index)));
      frag.appendChild(buildWikilink(root, m[1] === '!', m[2] ?? '', m[0]));
      last = m.index + m[0].length;
    }
    if (last < value.length) frag.appendChild(root.createTextNode(value.slice(last)));
    target.replaceWith(frag);
  }
}

/**
 * 任务列表类名归一化：直接产 HTML 的引擎（远程 comrak tasklist）不给 li 加类，
 * 而 markdown-it-task-lists 输出 li.task-list-item——补齐保证两引擎样式一致。
 * 幂等：已有类的 li（本地路径）不重复添加。
 * ul/input 同点归一（BUG-67 指纹对齐，2026-10-17）：本地插件输出
 * ul.contains-task-list + input.task-list-item-checkbox，远程 comrak tasklist
 * 裸 ul/input——与 li.task-list-item 同一裁决方向（归一到插件命名），否则
 * 同文档双引擎 DOM 指纹差三类名（CMP-05 实测）。
 */
function normalizeTaskLists(root: Document): void {
  for (const li of Array.from(root.querySelectorAll('li'))) {
    const direct = Array.from(li.children).find((c) => c.tagName === 'INPUT');
    if (direct?.getAttribute('type') !== 'checkbox') continue;
    if (!li.classList.contains('task-list-item')) {
      li.classList.add('task-list-item');
    }
    const ul = li.parentElement;
    if (ul?.tagName === 'UL' && !ul.classList.contains('contains-task-list')) {
      ul.classList.add('contains-task-list');
    }
    if (!direct.classList.contains('task-list-item-checkbox')) {
      direct.classList.add('task-list-item-checkbox');
    }
  }
}

/** 净化后 DOM 的展示性增强入口（幂等：callout/媒体替换后原元素已不复存在；
 * wikilink 扫描跳过 A/降级 span 祖先，已处理文本不二次改写）。 */
export function enrichMarkdownDom(root: Document): void {
  convertMediaElements(root);
  convertCallouts(root);
  convertWikilinks(root); // Task 6：注册在 callout 之后（折叠卡片标题内的 wikilink 同获改写）
  normalizeTaskLists(root);
}
