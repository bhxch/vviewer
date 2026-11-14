// relativeLinks.test.ts — spec D §3.2 相对链接站内导航接管：isRelativeLinkHref 分类
// 纯函数 + wireRelativeLinks 接管绑定（fake resolver/opener jsdom 直测）+ markdownRenderer
// 双缝装配面（Renderer 路径模块缝 / createMarkdownView options 双通道；缺省 null 不接管
// = standalone 安全缺省）+ wikilink 死链升级同通道。
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  isRelativeLinkHref,
  wireRelativeLinks,
  markdownRenderer,
  setRelativeLinkResolver,
  setRelativeLinkOpener,
  getRelativeLinkResolver,
  getRelativeLinkOpener,
  type RelativeLinkOpener,
  type RelativeLinkResolver
} from '../src/markdownRenderer';

function docOf(html: string): Document {
  const doc = document.implementation.createHTMLDocument('');
  doc.body.innerHTML = html;
  return doc;
}

const SOURCE = { storeId: 's1', storeLabel: '本地', path: 'sub/a.md', name: 'a.md' };
const FILE_TARGET = { kind: 'file', storeId: 's1', path: 'sub/b.md' } as const;

describe('isRelativeLinkHref——接管候选分类（spec §3.2）', () => {
  it('接管：./x、../x、x.md、/x（store 根相对属接管面——与图片面 isAbsoluteSrc 刻意不同权）、裸名、带 hash、带 query', () => {
    for (const h of ['./b.md', '../up/x.md', 'c.md#frag', '/root-x.md', 'bare-name', 'a/b.md?x=1']) {
      expect(isRelativeLinkHref(h), h).toBe(true);
    }
  });

  it('不接管：空串/页内锚(#)/协议相对(//host)/任意 scheme（http/https/mailto/data/blob/tel…）', () => {
    for (const h of ['', '   ', '#a', '//host/x', 'https://e.example/x', 'http://e.example/x', 'mailto:a@b.example', 'data:image/png;base64,x', 'blob:https://x/uuid', 'tel:+123']) {
      expect(isRelativeLinkHref(h), `"${h}"`).toBe(false);
    }
  });

  it('trim 后判定（首尾空白相对路径仍接管；纯空白串不接管）', () => {
    expect(isRelativeLinkHref(' ./x.md ')).toBe(true);
    expect(isRelativeLinkHref('   ')).toBe(false);
  });
});

describe('wireRelativeLinks——接管绑定（fake resolver/opener）', () => {
  afterEach(() => {
    setRelativeLinkResolver(null);
    setRelativeLinkOpener(null);
  });

  function makeWire(): { resolver: ReturnType<typeof vi.fn>; opener: ReturnType<typeof vi.fn>; call: (doc: Document) => void } {
    const resolver = vi.fn(async () => FILE_TARGET);
    const opener = vi.fn();
    return {
      resolver,
      opener,
      call: (doc: Document) => wireRelativeLinks(doc, { resolver: resolver as unknown as RelativeLinkResolver, opener: opener as unknown as RelativeLinkOpener, source: SOURCE })
    };
  }

  function click(a: Element): void {
    a.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  }

  it('分类面：相对 a[href] 接管挂 data-vv-rel-link；外域/页内锚/协议相对不接管（属性零变化）', () => {
    const w = makeWire();
    const doc = docOf(
      '<a href="./b.md">1</a><a href="https://e.example/x">2</a><a href="#top">3</a><a href="//host/x">4</a>',
    );
    w.call(doc);
    const links = Array.from(doc.querySelectorAll('a'));
    expect(links[0]!.hasAttribute('data-vv-rel-link')).toBe(true);
    for (const l of links.slice(1)) {
      expect(l.hasAttribute('data-vv-rel-link'), l.getAttribute('href')!).toBe(false);
    }
    expect(w.resolver).not.toHaveBeenCalled();
  });

  it('click preventDefault + resolver 以 (href, source) 调用 + opener 以 (target, href, source) 调用', async () => {
    const w = makeWire();
    const doc = docOf('<a href="./b.md">b</a>');
    w.call(doc);
    const a = doc.querySelector('a')!;
    const ev = new MouseEvent('click', { bubbles: true, cancelable: true });
    a.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true); // 接管即拦原生导航
    expect(w.resolver).toHaveBeenCalledWith('./b.md', SOURCE);
    await vi.waitFor(() => {
      expect(w.opener).toHaveBeenCalledWith(FILE_TARGET, './b.md', SOURCE);
    });
  });

  it('resolver missing/directory/null 四态 opener 调用面（null=显式弃权不调 opener）', async () => {
    const missing = vi.fn(async () => ({ kind: 'missing', path: 'sub/missing.md' }));
    const openerMissing = vi.fn();
    const docMissing = docOf('<a href="./missing.md">x</a>');
    wireRelativeLinks(docMissing, { resolver: missing as unknown as RelativeLinkResolver, opener: openerMissing as unknown as RelativeLinkOpener, source: SOURCE });
    click(docMissing.querySelector('a')!);
    await vi.waitFor(() => {
      expect(openerMissing).toHaveBeenCalledTimes(1);
      expect(openerMissing.mock.calls[0]![0]).toEqual({ kind: 'missing', path: 'sub/missing.md' });
    });

    const dir = vi.fn(async () => ({ kind: 'directory', storeId: 's1', path: 'sub' }));
    const openerDir = vi.fn();
    const docDir = docOf('<a href="./sub">x</a>');
    wireRelativeLinks(docDir, { resolver: dir as unknown as RelativeLinkResolver, opener: openerDir as unknown as RelativeLinkOpener, source: SOURCE });
    click(docDir.querySelector('a')!);
    await vi.waitFor(() => {
      expect(openerDir).toHaveBeenCalledWith({ kind: 'directory', storeId: 's1', path: 'sub' }, './sub', SOURCE);
    });

    const abstain = vi.fn(async () => null);
    const openerAbstain = vi.fn();
    const docAbstain = docOf('<a href="./b.md">x</a>');
    wireRelativeLinks(docAbstain, { resolver: abstain as unknown as RelativeLinkResolver, opener: openerAbstain as unknown as RelativeLinkOpener, source: SOURCE });
    click(docAbstain.querySelector('a')!);
    await new Promise((r) => setTimeout(r, 0));
    expect(openerAbstain).not.toHaveBeenCalled(); // t=null=弃权：本次点击无动作
  });

  it('resolver reject 无动作且无未处理 rejection（显式 catch——resolveRelativeImages try/catch await 同语义）', async () => {
    const onRejection = vi.fn();
    process.on('unhandledRejection', onRejection);
    const reject = vi.fn(async () => {
      throw new Error('store read failed');
    });
    const opener = vi.fn();
    const doc = docOf('<a href="./b.md">x</a>');
    wireRelativeLinks(doc, { resolver: reject as unknown as RelativeLinkResolver, opener: opener as unknown as RelativeLinkOpener, source: SOURCE });
    expect(() => click(doc.querySelector('a')!)).not.toThrow();
    await new Promise((r) => setTimeout(r, 0));
    expect(opener).not.toHaveBeenCalled();
    expect(reject).toHaveBeenCalledTimes(1);
    // 显式 catch 兜底：不产生 unhandled rejection（vitest 全量 Errors 段/退出码 0 的保证面）
    expect(onRejection).not.toHaveBeenCalled();
    process.off('unhandledRejection', onRejection);
  });

  it('幂等代币：二次 wire 不重复绑定（data-vv-rel-link 已在场跳过）', () => {
    const w = makeWire();
    const doc = docOf('<a href="./b.md">x</a>');
    w.call(doc);
    w.call(doc);
    // 单监听：一次点击一次 resolver 调用（重复绑定会调两次）
    click(doc.querySelector('a')!);
    expect(w.resolver).toHaveBeenCalledTimes(1);
  });

  it('wikilink 升级：span.md-wikilink-dead[data-wikilink-path] 站内相对 → a.md-wikilink（textContent=raw 维持 + data-wikilink-path 恒写 + href=path）', async () => {
    const w = makeWire();
    const doc = docOf('<span class="md-wikilink-dead" data-wikilink-path="Other.md" title="跨文件 wikilink 不支持">[[Other.md]]</span>');
    w.call(doc);
    expect(doc.querySelector('span.md-wikilink-dead')).toBeNull();
    const a = doc.querySelector('a.md-wikilink')!;
    expect(a).not.toBeNull();
    expect(a.getAttribute('href')).toBe('Other.md');
    expect(a.getAttribute('data-wikilink-path')).toBe('Other.md');
    expect(a.textContent).toBe('[[Other.md]]');
    click(a);
    expect(w.resolver).toHaveBeenCalledWith('Other.md', SOURCE);
    await vi.waitFor(() => {
      expect(w.opener).toHaveBeenCalledWith(FILE_TARGET, 'Other.md', SOURCE);
    });
  });

  it('wikilink 外域 path 不升级（![[https://…]] 降级 span 原样）；空 path 不升级', () => {
    const w = makeWire();
    const doc = docOf(
      '<span class="md-wikilink-dead" data-wikilink-path="https://e.example/p.png">![[https://e.example/p.png]]</span>' +
        '<span class="md-wikilink-dead" data-wikilink-path="">x</span>',
    );
    w.call(doc);
    const spans = Array.from(doc.querySelectorAll('span.md-wikilink-dead'));
    expect(spans).toHaveLength(2); // 两者均维持死链形态
    expect(doc.querySelector('a.md-wikilink')).toBeNull();
    expect(w.resolver).not.toHaveBeenCalled();
  });

  it('升级产物幂等代币：a.md-wikilink 挂 data-vv-rel-link，二次 wire 不重复绑定', () => {
    const w = makeWire();
    const doc = docOf('<span class="md-wikilink-dead" data-wikilink-path="Other.md">[[Other.md]]</span>');
    w.call(doc);
    const a = doc.querySelector('a.md-wikilink')!;
    expect(a.hasAttribute('data-vv-rel-link')).toBe(true); // 与普通 a 分支代币对称
    w.call(doc); // 二次 wire：升级产物命中第一循环 a[href] 但代币在场跳过
    click(a);
    expect(w.resolver).toHaveBeenCalledTimes(1); // 单监听（双重绑定会调两次）
  });
});

describe('markdownRenderer 双缝装配（Renderer 路径渲染出口接线，spec D §3.2）', () => {
  afterEach(() => {
    setRelativeLinkResolver(null);
    setRelativeLinkOpener(null);
  });

  async function renderMd(md: string): Promise<HTMLElement> {
    const target = document.createElement('div');
    const buffer = new TextEncoder().encode(md);
    await markdownRenderer.render(buffer, target, SOURCE, { ext: 'md' });
    return target;
  }

  it('双缝缺一不绑定：仅 resolver 注入 → wire 整体跳过（a 无 data-vv-rel-link，原生导航语义维持）', async () => {
    setRelativeLinkResolver(async () => ({ kind: 'file', storeId: 's1', path: 'sub/b.md' }));
    const target = await renderMd('[b](./b.md)');
    const a = target.querySelector('a[href="./b.md"]')!;
    expect(a).not.toBeNull();
    expect(a.hasAttribute('data-vv-rel-link')).toBe(false);
  });

  it('双缝在场：模块缝装配接管（click preventDefault → resolver → opener 以 (target, href, source) 调用）', async () => {
    const opener = vi.fn();
    setRelativeLinkResolver(async () => ({ kind: 'file', storeId: 's1', path: 'sub/b.md' }));
    setRelativeLinkOpener(opener as unknown as RelativeLinkOpener);
    const target = await renderMd('[b](./b.md)');
    const a = target.querySelector('a[href="./b.md"]')!;
    expect(a.hasAttribute('data-vv-rel-link')).toBe(true);
    const ev = new MouseEvent('click', { bubbles: true, cancelable: true });
    a.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
    await vi.waitFor(() => {
      expect(opener).toHaveBeenCalledWith({ kind: 'file', storeId: 's1', path: 'sub/b.md' }, './b.md', SOURCE);
    });
  });

  it('缺省（模块缝全 null）：渲染输出原生形态零标记（getter 缺省 null=standalone 安全缺省）', async () => {
    expect(getRelativeLinkResolver()).toBeNull();
    expect(getRelativeLinkOpener()).toBeNull();
    const target = await renderMd('[b](./b.md)');
    expect(target.querySelector('a[href="./b.md"]')!.hasAttribute('data-vv-rel-link')).toBe(false);
  });
});
