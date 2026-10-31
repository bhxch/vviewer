// sanitize.ts — 不可信渲染 HTML 的唯一净化策略（@bhxch/vviewer-sanitize 包本体）。
// 自 render-text/src/markdown/sanitize.ts 原样迁入（过渡期原位置保留，应用代码
// 改指本包后移除）：移植自 markpad src/lib/utils/sanitize.ts（单一策略模块原则），
// 按 vviewer 契约调整 URI 白名单：http/https/mailto/相对路径/data:image（data: 仅限
// src/srcset，见下方钩子）；FORBID_TAGS meta（style 的禁用由 uponSanitizeElement
// 钩子按服务端图表容器上下文二分承载，见 registerSanitizeHooks）；ALLOW_DATA_ATTR
// 保留 mermaid/katex 管线钩子。
// BUG-40：外域拦截自 img src/srcset（BUG-17）扩展到五类等价加载向量——
// video/audio poster、SVG image/use href、行内 style url()、background 属性、
// input type=image src（见钩子内 BUG-40 各分支）。
import DOMPurify from 'dompurify';
import type { Config } from 'dompurify';

// 仅在 DOMPurify 默认形状上收窄与放行两种方向：
//   - `data:image/`：内嵌图片（其余 data: MIME 一律拒绝，如 data:text/html）
//   - 删除 markpad 的盘符/asset:/tauri: 分支（无 Tauri 环境）
// 其余与 DOMPurify 默认一致：相对路径、片段、字母开头的非 scheme 串。
// `javascript:`、`vbscript:`、`data:text/html` 匹配不到任何分支，连属性一起剥除。
// 注意该正则只做值前缀匹配、不区分属性：data:image/ 也会命中 <a href>，
// data: 的属性级放行由下方 afterSanitizeAttributes 钩子收窄为 src/srcset。
export const ALLOWED_URI_REGEXP =
  /^(?:(?:(?:f|ht)tps?|mailto):|data:image\/|[^a-z]|[a-z+.\-]+(?:[^a-z+.\-:]|$))/i;

// data: 协议仅放行 src/srcset（内嵌图片/媒体）。ALLOWED_URI_REGEXP 按属性无关的
// 值前缀匹配，单正则难以按属性区分；DOMPurify 默认的 DATA_URI_TAGS 分支又只覆盖
// data: 前缀本身而非 data:image/。故用钩子在属性判定之后统一复核：src/srcset 之外
// 的属性一律不允许 data:*——否则 <a href="data:image/svg+xml,..."> 可通过，用户点击
// 后浏览器顶层导航至 SVG data URL，其中的脚本可执行（跳转型 XSS）。
// 惰性注册（首次 sanitizeHtml 时、幂等）：模块顶层不可触 DOMPurify——SSR/Node 下
// 默认导出是未绑定 window 的工厂（无 addHook/sanitize），顶层调用会让 SvelteKit
// SSR 求值直接 500。
const DATA_URI_ATTRS = new Set(['src', 'srcset']);

/**
 * 外域图片判定（BUG-17 跟踪像素防线）：绝对 http(s) 与协议相对（//host/…）都会向
 * 第三方发起 GET（可回传 IP/会话）；相对路径、data:image、blob: 不在此列。
 */
export function isExternalMediaSrc(src: string): boolean {
  return /^https?:/i.test(src) || src.startsWith('//');
}

/** URL 的 host（解析失败回落原串做提示） */
export function hostOf(url: string): string {
  try {
    return new URL(url, 'https://vviewer.invalid').host;
  } catch {
    return url;
  }
}

function markBlockedExternal(el: Element, host: string): void {
  el.setAttribute('data-vv-blocked-external', '1');
  el.setAttribute('title', `已拦截外部图片：${host}`);
}

// ---------- BUG-40：五类等价加载向量的外域拦截 ----------
//
// 既有防线只覆盖 IMG 的 src/srcset 与 VIDEO/AUDIO/SOURCE 的 src；以下属性同样是
// 「元素渲染即自动加载」的外域向量（md 渲染视图把净化后 DOM 挂主文档、无 CSP 兜
// 底，属性在即真实外联，跟踪像素可回传 IP/会话）：
//   ① video/audio poster——poster 图随元素渲染即拉取（与 preload 无关）；
//   ② SVG <image>/<use> 的 href/xlink:href——SVG 引用外域文档即加载；
//   ③ 行内 style 的 url()/image-set() 字符串 URL——样式应用即拉取；
//   ④ background 属性（table/td/body 等遗留表现属性）——同背景图自动加载；
//   ⑤ input type=image src——与 img 同等的自动加载图片。
// 策略与 IMG（BUG-17）同口径：移除加载源 + data-vv-blocked-external 标记 +
// title 域名提示；行内 style 只剥含外域引用的声明、其余声明保留。

/** SVG 命名空间（xlink:href 剥除用 removeAttributeNS，qualified name 双保险） */
const XLINK_NS = 'http://www.w3.org/1999/xlink';

/** 引号/括号感知的 style 声明切分：url("a;b")、image-set("a;b" 1x) 不误切。 */
function splitStyleDeclarations(value: string): string[] {
  const out: string[] = [];
  let cur = '';
  let depth = 0;
  let quote: string | null = null;
  for (const ch of value) {
    if (quote !== null) {
      cur += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      cur += ch;
      continue;
    }
    if (ch === '(') depth += 1;
    else if (ch === ')') depth = Math.max(0, depth - 1);
    if (ch === ';' && depth === 0) {
      out.push(cur);
      cur = '';
      continue;
    }
    cur += ch;
  }
  if (cur.trim() !== '') out.push(cur);
  return out;
}

/**
 * 单条声明中的外域引用判定：命中返回引用 URL（供 title 域名提示），无外域返回
 * null。先摘 data: URL（base64 字符可能含 '//'，避免误报）后查两种形态：
 * url(...) 括号内（引号三态）与引号字符串字面量/无引号 //host（image-set 的
 * URL 可不写 url()）。content:"…" 等纯展示文本命中属可接受的误伤（剥声明不剥内容）。
 */
function externalRefInDeclaration(decl: string): string | null {
  const withoutData = decl.replace(/data:[a-z0-9.+-]+\/[a-z0-9.+-]+(?:;[^;)'"\s]*)?/gi, '');
  const urlFn = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*?))\s*\)/gi;
  for (let m = urlFn.exec(withoutData); m !== null; m = urlFn.exec(withoutData)) {
    const inner = (m[1] ?? m[2] ?? m[3] ?? '').trim();
    if (isExternalMediaSrc(inner)) return inner;
  }
  const quoted = /(["'])((?:(?!\1).)*)\1/g;
  for (let m = quoted.exec(withoutData); m !== null; m = quoted.exec(withoutData)) {
    const inner = (m[2] ?? '').trim();
    if (isExternalMediaSrc(inner)) return inner;
  }
  const bare = withoutData.match(/(?:^|[\s(,])(?:https?:)?\/\/[a-z0-9][^\s)'",;]*/i);
  if (bare !== null) return bare[0].trim();
  return null;
}

/** 行内 style：剥含外域引用的声明；全部被剥时整属性移除；有剥必打拦截标记。 */
function sanitizeStyleAttribute(el: Element): void {
  const style = el.getAttribute('style');
  if (style === null) return;
  const decls = splitStyleDeclarations(style);
  const kept: string[] = [];
  let blockedHost = '';
  let blocked = false;
  for (const decl of decls) {
    const hit = externalRefInDeclaration(decl);
    if (hit === null) {
      kept.push(decl);
      continue;
    }
    blocked = true;
    if (blockedHost === '' && hit !== '') blockedHost = hostOf(hit);
  }
  if (!blocked) return;
  if (kept.length === 0) el.removeAttribute('style');
  else el.setAttribute('style', kept.join(';'));
  markBlockedExternal(el, blockedHost);
}

let dataUriHookRegistered = false;

// ---------- 豁免 style 的安全判定（修复轮 1 H1/M1/L1） ----------
//
// 匹配在归一化副本上进行：浏览器 CSS tokenizer 对 ident/值内反斜杠转义先解码再
// 语义化——`\75 rl(`、`u\72 l(` 在浏览器里都按 url( 生效，字面串匹配会漏（hex
// 转义绕过可实现无交互外域 GET，击穿「零外域自动 GET」不变量）。归一化两步：
// hex 转义（CSS 规范语义：至多 6 位 + 恰好消费一个尾随空白）→ 码点，越界回落
// U+FFFD；字面转义（`\;` 等）→ 去反斜杠。先 hex 后字面（否则 `\75` 会被字面
// 规则截断）。归一化仅用于匹配，不改写保留节点的文本（合法 CSS 的有意转义不动）。
function cssEscapeNormalized(text: string): string {
  return text
    .replace(/\\([0-9a-fA-F]{1,6})\s?/g, (_m, hex: string) => {
      const cp = parseInt(hex, 16);
      // CSS 规范：越界码点（>10FFFF）按 U+FFFD 处理——不可能是任何危险 token 的组成
      return cp > 0x10ffff ? String.fromCodePoint(0xfffd) : String.fromCodePoint(cp);
    })
    .replace(/\\(.)/g, '$1');
}

// 危险 token 清单（不区分大小写；无 g 旗标——RegExp.test 无 lastIndex 状态）：
//   </style       逃逸/守卫触发向量；
//   url(          外联加载主向量（转义变体由归一化拆除）——仅拒绝非片段形态
//                 （终审 C1）：`url(` 后（可选空白+可选引号）首字符为 # 属同文档
//                 片段引用，零网络放行——svgbob 引擎 style 恒含
//                 `marker-start: url(#arrow)` 等形态（0.7.6 实测），一刀切会把
//                 全部 svgbob 服务端图的线条样式杀没；引号/绝对 URL 形态仍整杀；
//   image-set(    字符串 URL 形态无 url(（M1：与属性层 externalRefInDeclaration
//                 的 image-set 同口径——那里逐声明剥除，这里整节点丢弃），无
//                 片段语义，维持整杀；
//   @import       样式表级外联；
//   behavior:     遗留 IE 行为绑定（L1）；
//   -moz-binding: 遗留 XBL 绑定（L1）；
//   expression(   遗留 IE CSS 表达式；
//   http(s)://    绝对 URL 兜底：引擎 CSS 无外链，任何转义伪装归一化后同此命中。
const STYLE_DEADLY: readonly RegExp[] = [
  /<\/\s*style/i,
  /url\((?!\s*['"]?#)/i,
  /image-set\(/i,
  /@import/i,
  /behavior\s*:/i,
  /-moz-binding\s*:/i,
  /expression\(/i,
  /https?:\/\//i,
];

function styleTextIsDeadly(text: string): boolean {
  const normalized = cssEscapeNormalized(text);
  return STYLE_DEADLY.some((re) => re.test(normalized));
}

// ---------- 服务端图表容器契约（拆包提取：原硬编码于 style 豁免钩子内） ----------
//
// compute markdown 的服务端图表（server/src/compute/diagrams.rs）与 render-text
// wrapServerDiagrams 产出 [data-vv-diagram="server"] 容器，style 豁免钩子按该契约
// 识别容器上下文。拆包后契约字面量提取为模块默认值 + 按调用可配选项
// （SanitizeOptions.serverDiagram），默认值与原硬编码字面量逐字一致——既有产出
// 对端零改动即可继续命中豁免。

/** 服务端图表容器契约默认属性名 */
const SERVER_DIAGRAM_ATTR = 'data-vv-diagram';
/** 服务端图表容器契约默认取值 */
const SERVER_DIAGRAM_VALUE = 'server';

/** 归一化契约：未配置字段回落服务端契约默认字面量 */
function normalizeServerDiagramContract(contract?: ServerDiagramContract): {
  attr: string;
  value: string;
} {
  return {
    attr: contract?.attr ?? SERVER_DIAGRAM_ATTR,
    value: contract?.value ?? SERVER_DIAGRAM_VALUE,
  };
}

// DOMPurify Config 无官方自定义字段通道；契约随当次 sanitize 的 config 注入，由
// uponSanitizeElement 钩子第 3 参读回（3.4.16 实测：_parseConfig 对传入 config
// 全量 clone 保留自有键、_executeHooks 把当次 CONFIG 原样传给钩子）——逐调用
// 透传，钩子侧不持模块级可变状态。键名加 __ 前缀避免与上游未来新增键冲突。
const SERVER_DIAGRAM_CONFIG_KEY = '__vvServerDiagramContract';
type SanitizeConfig = Config &
  Record<typeof SERVER_DIAGRAM_CONFIG_KEY, { attr: string; value: string }>;

/** 钩子侧读回当次契约：config 未携带（防御性兜底）时回落默认字面量 */
function hookServerDiagramContract(config: Config | undefined): {
  attr: string;
  value: string;
} {
  return (
    (config as SanitizeConfig | undefined)?.[SERVER_DIAGRAM_CONFIG_KEY] ??
    normalizeServerDiagramContract()
  );
}

/** 服务端图表容器契约（style 豁免钩子按「净化串内祖先节点带 attr 属性且取值为 value」识别豁免容器） */
export interface ServerDiagramContract {
  /** 容器属性名，默认 'data-vv-diagram'（服务端契约字面量，产出对端 server/src/compute/diagrams.rs 与 render-text wrapServerDiagrams） */
  attr?: string;
  /** 容器属性取值，默认 'server' */
  value?: string;
}

function registerSanitizeHooks(): void {
  if (dataUriHookRegistered) return;
  dataUriHookRegistered = true;
  DOMPurify.addHook('uponSanitizeElement', (node, data, config) => {
    // ---------- 服务端图表 style 上下文豁免（spec §2.5，2026-10-19 控制器裁决） ----------
    //
    // compute markdown 的服务端图表（server/src/compute/diagrams.rs）产出带引擎生成
    // <style> 的 SVG（layout-rs 仅字体规则；svgbob 固定描边规则 + 用户 CSS——
    // `# Legend:` 语法 `name = {css}` 原样并入 style 块，0.7.6 实测）；FORBID_TAGS
    // 一刀切会把线条样式剥没（svgbob 线全消失）。裁决：服务端图表容器内的 style
    // 经安全检查后保留；容器外维持原剥除语义（BUG-40 防线不松动）。Legend 用户
    // CSS 的外泄面由下方全量归一化危险 token 判定兜住（凡含 url( 非片段形态/
    // @import/绝对 URL 等即整节点丢弃），页面级样式注入与作者伪造容器同为 M2
    // 口径知情接受。
    //
    // 拆包提取（2026-10-31）：容器识别字面量不再硬编码于此——经当次 sanitize 的
    // config 注入（SanitizeOptions.serverDiagram，默认即 data-vv-diagram="server"
    // 服务端契约字面量），见上方契约节。
    //
    // 威胁模型（修复轮 1 M2 落实）：该容器属性可被 markdown 作者伪造——comrak
    // render.unsafe 透传作者原始 HTML 且 ALLOW_DATA_ATTR 保留 data-*，豁免并非
    // 只服务端图表可达：作者可自造带属性 div 获得页面级样式注入（选择器级
    // chrome 篡改，中危，知情接受）；「零外域自动 GET」不变量由下方危险 token
    // 判定阻断（归一化匹配 + 命中即整节点丢弃，见 styleTextIsDeadly）。
    //
    // 机制注（DOMPurify 3.4.16 实测语义，非旧版惯用法）：FORBID_TAGS 命中在钩子
    // 载荷之外短路移除（_sanitizeDisallowedNode），uponSanitizeElement 的
    // data.allowed/allowedTags 均无法覆写。故 style 移出 FORBID_TAGS（回落默认
    // 允许表），钩子内按节点上下文二分——容器外由钩子自行摘除节点（元素连 CSS
    // 文本一并移除；DOMPurify 对钩内摘除有 _handleHookDetachedNode 正式支撑，
    // 可观察输出与原 FORBID_TAGS+FORBID_CONTENTS 一致）；容器内按判定放行或丢弃。
    if (data.tagName !== 'style' || node.nodeType !== 1) return;
    const { attr, value } = hookServerDiagramContract(config);
    const el = node as Element;
    let inServer = false;
    for (let cur: Node | null = el.parentNode; cur !== null; cur = cur.parentNode) {
      if (cur.nodeType === 1 && (cur as Element).getAttribute(attr) === value) {
        inServer = true;
        break;
      }
    }
    if (!inServer) {
      el.remove(); // 容器外：维持 FORBID_TAGS 原语义（元素连内容一并移除）
      return;
    }
    // 容器内豁免：命中任一危险 token（归一化匹配，H1/M1/L1）→ 整节点丢弃——
    // 引擎生成 CSS 永不含这些 token，凡命中即敌意输入，宁降级不冒险（不做
    // 删除式保留：删除防不住转义重组后的二次拼接，徒留探测面）。未命中的
    // 合法引擎 CSS 原样保留、零改动。
    if (styleTextIsDeadly(el.textContent ?? '')) {
      el.remove();
    }
  });
  DOMPurify.addHook('afterSanitizeAttributes', (node) => {
    for (const attr of Array.from(node.attributes)) {
      if (DATA_URI_ATTRS.has(attr.name.toLowerCase())) continue;
      if (/^\s*data:/i.test(attr.value)) node.removeAttribute(attr.name);
    }
    // BUG-17：img 的 http(s)/协议相对 src 一律移除并打拦截标记——渲染视图中不再
    // 向外域发起网络请求（跟踪像素拿不到 IP）；title 保留域名供占位悬停提示。
    // 相对路径与 data:/blob: 不受影响（markdown 相对图片解析为 blob 的链路发生在
    // 净化之后，同样不受影响）；链接 <a href> 外链不拦（用户主动导航型外泄）。
    if (node.nodeType === 1) {
      const el = node as Element;
      const tag = el.tagName;
      if (tag === 'IMG') {
        const src = el.getAttribute('src');
      const srcExternal = src !== null && isExternalMediaSrc(src.trim());
      if (srcExternal) {
        el.removeAttribute('src');
        markBlockedExternal(el, hostOf(src!.trim()));
      }
      // srcset 是同等的图片加载源（无 src 时浏览器按 srcset 加载；markdown 渲染
      // 视图把净化后 DOM 挂主文档、无 CSP 兜底）：逐候选过滤——srcset 语法上逗号
      // 不出现在 URL 内，候选首段（首个空白前）即其 URL。外域候选移除、其余保留；
      // 过滤后无任何可用加载源（src 缺失或同为外域已拦）时补拦截标记。
      const srcset = el.getAttribute('srcset');
      if (srcset !== null) {
        const candidates = srcset.split(',').map((c) => c.trim()).filter((c) => c !== '');
        const kept: string[] = [];
        let firstBlockedHost = srcExternal ? hostOf(src!.trim()) : '';
        for (const c of candidates) {
          const url = (c.split(/\s+/)[0] ?? '').trim();
          if (isExternalMediaSrc(url)) {
            if (firstBlockedHost === '') firstBlockedHost = hostOf(url);
            continue;
          }
          kept.push(c);
        }
        if (kept.length !== candidates.length) {
          if (kept.length === 0) el.removeAttribute('srcset');
          else el.setAttribute('srcset', kept.join(', '));
          if (kept.length === 0 && (src === null || srcExternal)) {
            markBlockedExternal(el, firstBlockedHost);
          }
        }
      }
    }
    // BUG-17/MD-13 延伸：video/audio/source 的外域 src 同样会自动加载（Chrome
    // 默认 preload=metadata 即对外域 GET 首块数据，可回传 IP）。与 img 不同：
    // 不剥 src——用户点播放属主动行为（与 <a href> 外链不拦同口径），改强制
    // preload="none" 并去 autoplay，保证不点不发请求；<source> 是候选列表语义
    // 无法延迟加载，外域候选直接剥除 src。
    else if (tag === 'VIDEO' || tag === 'AUDIO' || tag === 'SOURCE') {
      const src = el.getAttribute('src');
      if (src !== null && isExternalMediaSrc(src.trim())) {
        if (tag === 'SOURCE') {
          el.removeAttribute('src');
        } else {
          el.setAttribute('preload', 'none');
          el.removeAttribute('autoplay');
        }
      }
      // BUG-40①：poster 图随元素渲染即拉取（与 preload 无关，preload=none 拦不住），
      // 与 src 的「点播放才请求」语义不同权——直接移除（同 img 剥 src 口径）。
      const poster = el.getAttribute('poster');
      if (poster !== null && isExternalMediaSrc(poster.trim())) {
        el.removeAttribute('poster');
        markBlockedExternal(el, hostOf(poster.trim()));
      }
    }
    // BUG-40②③④⑤：SVG 引用元素 / 遗留 background 属性 / input type=image / 行内
    // style url()——五类等价加载向量，全部与 img src 同权（移除加载源 + 拦截标记）。
    // 注：text/html 解析下 SVG 元素 tagName 为小写（image/use）；<svg> 外的 <image>
    // 会被 HTML 解析器改写为 img（上方 IMG 分支已覆盖）。
    const svgTag = tag.toLowerCase();
    if (svgTag === 'image' || svgTag === 'use') {
      // SVG image/use 的 href 与 xlink:href（解析器二选一出现，双剥保险）
      for (const attr of ['href', 'xlink:href']) {
        const v = el.getAttribute(attr);
        if (v === null) continue;
        if (isExternalMediaSrc(v.trim())) {
          el.removeAttribute(attr);
          el.removeAttributeNS(XLINK_NS, 'href');
          markBlockedExternal(el, hostOf(v.trim()));
        }
      }
    }
    const background = el.getAttribute('background');
    if (background !== null && isExternalMediaSrc(background.trim())) {
      el.removeAttribute('background');
      markBlockedExternal(el, hostOf(background.trim()));
    }
    if (tag === 'INPUT' && (el.getAttribute('type') ?? '').toLowerCase() === 'image') {
      const src = el.getAttribute('src');
      if (src !== null && isExternalMediaSrc(src.trim())) {
        el.removeAttribute('src');
        markBlockedExternal(el, hostOf(src.trim()));
      }
    }
    sanitizeStyleAttribute(el);
  }
  });
}

// <style> 默认在 DOMPurify 允许表内且其 CSS 不经过滤：作者样式表注入预览文档后
// 可全局生效（隐藏 UI / background:url 外传），本应禁——现由 uponSanitizeElement
// 钩子按上下文二分承载（见 registerSanitizeHooks 内注释）：服务端图表容器内豁免
// （容器契约默认 data-vv-diagram="server"，经 SanitizeOptions.serverDiagram 可配），
// 容器外钩子摘除（语义同禁）。行内 style 属性仍允许。
// <meta> 当前虽不在 DOMPurify 默认允许表内，仍显式声明防上游默认变化
// （http-equiv=refresh/UVG 元信息不应出现在预览片段；沙箱文档的 CSP meta 由
// html 渲染器在净化之后自行注入，不受此禁影响）。
// 注意 style 不得留在 FORBID_TAGS：3.4.16 中 FORBID_TAGS 命中先于钩子载荷短路
// 移除，钩子将无从豁免（见钩子内机制注）。
export const MARKDOWN_SANITIZE_CONFIG: Config = {
  ALLOWED_URI_REGEXP,
  FORBID_TAGS: ['meta'],
  ALLOW_DATA_ATTR: true,
};

/** sanitizeHtml 可选项 */
export interface SanitizeOptions {
  /** true 时净化整份 HTML 文档（含 html/head/body 与其中的 meta/title），html 渲染器 srcdoc 用 */
  wholeDocument?: boolean;
  /** 服务端图表容器契约：style 豁免钩子的容器识别字面量，默认 data-vv-diagram="server"（见 ServerDiagramContract） */
  serverDiagram?: ServerDiagramContract;
}

/**
 * 服务端获取的图表 SVG 片段净化（spec 2026-10-23 §8.3）：server 模式
 * （/api/compute/diagram）与 krokiVia=server（/api/kroki 代发）两分支共用的
 * 承接面——片段包进契约壳后整串走 sanitizeHtml，uponSanitizeElement 钩子按壳
 * 上下文放行引擎 <style>（危险 token 全量归一化判定兜底，url(# 同文档片段引用
 * 既有放行），与 compute markdown 后处理产物的 wrapServerDiagrams 承接面同一
 * 豁免语义。壳须留在净化输入串内（钩子按串内祖先上下文二分），净化后剥壳取回
 * 内层——敌意内容若截断壳，截出部分落容器外 → style 豁免不适用（fail-closed，
 * 且整串仍经 DOMPurify 全量净化）。壳属性与钩子识别同源取自 opts.serverDiagram
 * （默认 data-vv-diagram="server"），契约字面量不会在壳/钩两处漂移；attr/value
 * 为调用方自有契约常量（非不可信输入），直接拼入净化输入串。
 */
export function sanitizeDiagramFragment(root: Document, html: string, opts: SanitizeOptions = {}): string {
  const { attr, value } = normalizeServerDiagramContract(opts.serverDiagram);
  const probe = root.createElement('div');
  probe.setAttribute(attr, value);
  // 先在管线期 detached doc 内解析归一（innerHTML 不执行脚本），再嵌壳净化——
  // 与 sanitizeHtml 的 Document 输入两步语义一致
  probe.innerHTML = html;
  const holder = root.createElement('div');
  holder.innerHTML = sanitizeHtml(`<div ${attr}="${value}">${probe.innerHTML}</div>`, opts);
  return holder.firstElementChild?.innerHTML ?? '';
}

/**
 * 不可信渲染 HTML 过唯一共享策略。string 与 Document 输入统一返回字符串
 * （SDD Ruling：T3 管线以字符串为统一出口，自行 innerHTML 成 DOM）。
 * Document 输入取 body 内容净化（DOMPurify 无法导入文档节点本身；本管线
 * 的 Document 均为 body 级片段容器）。wholeDocument 时输入必须是完整文档
 * 字符串（Document 输入会丢 head，此时应直接传原始字符串）。
 */
export function sanitizeHtml(dirty: string | Document, opts: SanitizeOptions = {}): string {
  registerSanitizeHooks();
  const html = typeof dirty === 'string' ? dirty : dirty.body.innerHTML;
  // 每次新建 config（不回写共享的 MARKDOWN_SANITIZE_CONFIG）：契约与
  // wholeDocument 均为逐调用形态，经钩子第 3 参 CONFIG 透传
  const config: SanitizeConfig = {
    ...MARKDOWN_SANITIZE_CONFIG,
    ...(opts.wholeDocument ? { WHOLE_DOCUMENT: true } : {}),
    [SERVER_DIAGRAM_CONFIG_KEY]: normalizeServerDiagramContract(opts.serverDiagram),
  };
  // 无 RETURN_DOM/RETURN_DOM_FRAGMENT 的重载返回 string
  return DOMPurify.sanitize(html, config) as string;
}
