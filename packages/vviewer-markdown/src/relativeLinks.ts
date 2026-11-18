// relativeLinks.ts — spec D §3.2 相对链接站内导航接管：渲染出口 wire pass（双注入缝
// 同时在场才绑定，standalone 安全缺省=原生导航语义维持）+ wikilink 死链升级同通道。
// 监听生命周期与灯箱/复制徽标同款：逐元素绑定随节点收养进主文档后保留、随
// renderMarkdownInto 的 destroy()（target.replaceChildren）与节点同灭，无解绑簿记。
import type { FileSourceLike } from './types';

/**
 * 相对链接解析目标（spec §3.2）：file→新 tab 打开、directory→目录 tab、missing→
 * 状态栏提示——打开与提示的 app 侧通道由装配方一体承接（包不感知 store/
 * showStatusNotice）；missing.path 为解析后完整路径（提示文案消费，spec
 * `{ kind: 'missing' }` 的兼容扩展）。
 */
export type RelativeLinkTarget =
  | { kind: 'file'; storeId: string; path: string }
  | { kind: 'directory'; storeId: string; path: string }
  | { kind: 'missing'; path?: string };

/**
 * 相对链接解析器：相对 href + 当前文件来源 → RelativeLinkTarget；null=resolver
 * 显式弃权（当次点击无动作——app 装配恒返回 target：失败=missing 不产 null，null
 * 仅 standalone 契约形态）。reject（store 读抛错）由 wireRelativeLinks 的**显式
 * `.catch`** 吞掉=当次点击无动作（resolveRelativeImages 抛错视同找不到同口径；
 * 评审 C1 已把「.then 无第二参」改为显式 catch——三处注释据此订正）。
 */
export type RelativeLinkResolver = (
  href: string,
  source: FileSourceLike
) => Promise<RelativeLinkTarget | null>;

/**
 * 相对链接打开与提示通道（file→新 tab、directory→目录 tab、missing→状态提示由
 * 装配方一体承接——包不感知 store/showStatusNotice）；source 供装配方取 store 引用。
 */
export type RelativeLinkOpener = (
  target: RelativeLinkTarget,
  href: string,
  source: FileSourceLike
) => void;

/**
 * 接管候选分类：空串/页内锚(#)/协议相对(//host)/任意 scheme（http/https/mailto/
 * data/blob/tel…）不接管；其余（./x、../x、x.md、/x、裸名）为站内相对候选。
 * `/` 开头=store 根相对属接管面——与 markdownRenderer.isAbsoluteSrc 的图片面
 * 「根相对不进 resolver」刻意不同权（spec §3.2 明示）。
 */
export function isRelativeLinkHref(href: string): boolean {
  const h = href.trim();
  if (h === '' || h.startsWith('#') || h.startsWith('//')) return false;
  return !/^[a-z][a-z0-9+.-]*:/i.test(h);
}

/**
 * 渲染出口接管绑定：逐 a[href] 分类命中即挂 data-vv-rel-link 代币并绑定 click
 * （preventDefault 后异步 resolver→opener；reject/弃权当次点击无动作）；死链
 * wikilink span 恒写 data-wikilink-path（enrich 侧元数据）在场且路径为站内相对时
 * 换 a.md-wikilink 同通道接管——resolver 未注入维持死链形态（本函数仅在双缝在场
 * 时由渲染出口调用，缺省不接管由调用点保证）。
 */
export function wireRelativeLinks(
  root: Document,
  opts: { resolver: RelativeLinkResolver; opener: RelativeLinkOpener; source: FileSourceLike }
): void {
  for (const a of Array.from(root.querySelectorAll('a[href]'))) {
    const href = a.getAttribute('href') ?? '';
    if (!isRelativeLinkHref(href)) continue; // 锚/绝对 URL/data:/blob: 不接管（spec §3.2）
    if (a.hasAttribute('data-vv-rel-link')) continue; // 幂等代币：二次 wire 不重复绑定
    a.setAttribute('data-vv-rel-link', '');
    a.addEventListener('click', (ev) => {
      ev.preventDefault(); // 接管：原生导航让位站内解析
      void opts
        .resolver(href, opts.source)
        .then((t) => {
          // preventDefault 已同步生效（接管即拦原生导航）；t=null=resolver 显式弃权
          // →本次点击无动作（app 装配恒返回 target：失败=missing 不产 null，null 仅
          // standalone 契约形态）
          if (t !== null) opts.opener(t, href, opts.source);
        })
        .catch(() => {
          // resolver reject（store 读抛错）= 当次点击无动作——resolveRelativeImages
          // 的 try/catch await 同语义（抛错视同找不到），显式 catch 防未处理 rejection
        });
    });
  }
  // wikilink 升级（Review Focus 4）：enrich 死链 span 恒写 data-wikilink-path，
  // 路径为站内相对时换 a.md-wikilink 同通道接管；外域嵌入 ![[https://…]] 的 path
  // 按 isRelativeLinkHref 不升级（维持死链原样——enrich 对外域嵌入刻意不造 img）。
  for (const span of Array.from(root.querySelectorAll('span.md-wikilink-dead[data-wikilink-path]'))) {
    const path = span.getAttribute('data-wikilink-path') ?? '';
    if (path === '' || !isRelativeLinkHref(path)) continue;
    const a = span.ownerDocument!.createElement('a');
    a.className = 'md-wikilink';
    a.setAttribute('href', path);
    a.setAttribute('data-wikilink-path', path);
    // 幂等代币与 a[href] 分支对称：升级产物 a.md-wikilink[href] 也会命中上方第一
    // 循环 a[href] 选择器，同 doc 二次 wire 时代币在场跳过（防双重绑定）
    a.setAttribute('data-vv-rel-link', '');
    a.textContent = span.textContent ?? ''; // raw 维持（enrich 升级保原文）
    span.replaceWith(a);
    a.addEventListener('click', (ev) => {
      ev.preventDefault();
      void opts
        .resolver(path, opts.source)
        .then((t) => {
          if (t !== null) opts.opener(t, path, opts.source);
        })
        .catch(() => {
          // resolver reject 同 a[href] 分支：当次点击无动作（防未处理 rejection）
        });
    });
  }
}
