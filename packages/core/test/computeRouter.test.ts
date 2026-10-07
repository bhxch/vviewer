import { describe, expect, it, vi } from 'vitest';
import {
  createComputeRouter,
  highlightRemoteEligible,
  INJECTION_LANGS
} from '../src/compute/router';
import type { ComputePolicy, ComputeSource, HighlightInterval } from '../src/compute/types';

function iv(start: number, end: number, capture = 'keyword'): HighlightInterval {
  return { start, end, capture };
}

interface RouterOpts {
  policy: ComputePolicy;
  compute?: boolean;
  base?: string | null;
}

function makeRouter(o: RouterOpts) {
  return createComputeRouter({
    hasCompute: () => o.compute ?? false,
    policy: () => o.policy,
    remote: { base: () => o.base ?? null, token: () => (o.base ? 'tok-1' : null) }
  });
}

const remotePath = (p: string): ComputeSource => ({ path: p, storeId: 'remote:abcd1234' });

describe('routeHighlight 路由矩阵', () => {
  it('policy local：有能力且 src.path 存在也恒走本地（不调 remoteFn）', async () => {
    const remoteFn = vi.fn(async () => [iv(0, 4)]);
    const res = await makeRouter({ policy: 'local', compute: true, base: 'http://s' }).routeHighlight(
      remotePath('a.rs'),
      'rust',
      async () => [iv(0, 2)],
      remoteFn
    );
    expect(res).toEqual({ where: 'local', ok: true, data: [iv(0, 2)] });
    expect(remoteFn).not.toHaveBeenCalled();
  });

  it('policy local：本地失败如实报错（ok:false + error）', async () => {
    const res = await makeRouter({ policy: 'local' }).routeHighlight(
      { text: 'x' },
      'rust',
      async () => {
        throw new Error('worker 解析失败');
      }
    );
    expect(res).toEqual({ where: 'local', ok: false, error: 'worker 解析失败' });
    expect(res.data).toBeUndefined();
  });

  it('policy remote：无 compute 能力走本地', async () => {
    const localFn = vi.fn(async () => [iv(0, 2)]);
    const res = await makeRouter({ policy: 'remote', compute: false, base: 'http://s' }).routeHighlight(
      remotePath('a.rs'),
      'rust',
      localFn,
      async () => [iv(0, 4)]
    );
    expect(res.where).toBe('local');
    expect(localFn).toHaveBeenCalledOnce();
  });

  it('policy remote：有能力但调用侧未提供 remoteFn → 本地', async () => {
    const res = await makeRouter({ policy: 'remote', compute: true, base: 'http://s' }).routeHighlight(
      remotePath('a.rs'),
      'rust',
      async () => [iv(0, 2)]
    );
    expect(res).toEqual({ where: 'local', ok: true, data: [iv(0, 2)] });
  });

  it('policy remote：有能力走远程（本地函数不被调用）', async () => {
    const localFn = vi.fn(async () => [iv(0, 2)]);
    const res = await makeRouter({ policy: 'remote', compute: true, base: 'http://s' }).routeHighlight(
      remotePath('a.rs'),
      'rust',
      localFn,
      async () => [iv(0, 4)]
    );
    expect(res).toEqual({ where: 'remote', ok: true, data: [iv(0, 4)] });
    expect(localFn).not.toHaveBeenCalled();
  });

  it('policy remote：远程失败如实报错、不回退本地（用户显式选择）', async () => {
    const localFn = vi.fn(async () => [iv(0, 2)]);
    const res = await makeRouter({ policy: 'remote', compute: true, base: 'http://s' }).routeHighlight(
      remotePath('a.rs'),
      'rust',
      localFn,
      async () => {
        throw new Error('HTTP 404');
      }
    );
    expect(res).toEqual({ where: 'remote', ok: false, error: 'HTTP 404' });
    expect(localFn).not.toHaveBeenCalled();
  });

  it('policy auto：无能力走本地', async () => {
    const res = await makeRouter({ policy: 'auto', compute: false, base: 'http://s' }).routeHighlight(
      remotePath('a.rs'),
      'rust',
      async () => [iv(0, 2)],
      async () => [iv(0, 4)]
    );
    expect(res.where).toBe('local');
  });

  it('policy auto：有能力但 src 无 path（本地文件/纯文本）走本地', async () => {
    const remoteFn = vi.fn(async () => [iv(0, 4)]);
    for (const src of [{ text: 'x' }, { storeId: 'localfs:1', pathInStore: 'a.rs' }, {}]) {
      const res = await makeRouter({ policy: 'auto', compute: true, base: 'http://s' }).routeHighlight(
        src,
        'rust',
        async () => [iv(0, 2)],
        remoteFn
      );
      expect(res.where).toBe('local');
    }
    expect(remoteFn).not.toHaveBeenCalled();
  });

  it('policy auto：有能力且 src.path 存在走远程', async () => {
    const res = await makeRouter({ policy: 'auto', compute: true, base: 'http://s' }).routeHighlight(
      remotePath('a.rs'),
      'rust',
      async () => [iv(0, 2)],
      async (src, lang) => {
        expect(src).toEqual(remotePath('a.rs'));
        expect(lang).toBe('rust');
        return [iv(0, 4)];
      }
    );
    expect(res).toEqual({ where: 'remote', ok: true, data: [iv(0, 4)] });
  });

  it('policy auto：远程失败回退本地（结果标 where: local）', async () => {
    const localFn = vi.fn(async () => [iv(0, 2)]);
    const res = await makeRouter({ policy: 'auto', compute: true, base: 'http://s' }).routeHighlight(
      remotePath('a.rs'),
      'rust',
      localFn,
      async () => {
        throw new Error('HTTP 500');
      }
    );
    expect(res).toEqual({ where: 'local', ok: true, data: [iv(0, 2)] });
    expect(localFn).toHaveBeenCalledOnce();
  });
});

describe('routeMarkdown 路由矩阵（与 highlight 同构）', () => {
  const opts = { wikilinks: true };

  it('policy auto + src.path：走远程并转发 options', async () => {
    const res = await makeRouter({ policy: 'auto', compute: true, base: 'http://s' }).routeMarkdown(
      remotePath('doc.md'),
      '# hi',
      opts,
      async () => '<h1>local</h1>',
      async (text, o) => {
        expect(text).toBe('# hi');
        expect(o).toEqual(opts);
        return '<h1>remote</h1>';
      }
    );
    expect(res).toEqual({ where: 'remote', ok: true, data: '<h1>remote</h1>' });
  });

  it('policy auto：src 缺省或无 path 走本地', async () => {
    const r = makeRouter({ policy: 'auto', compute: true, base: 'http://s' });
    const remoteFn = vi.fn(async () => '<h1>remote</h1>');
    const a = await r.routeMarkdown(undefined, '# hi', undefined, async () => '<h1>l</h1>', remoteFn);
    const b = await r.routeMarkdown({ text: '# hi' }, '# hi', undefined, async () => '<h1>l</h1>', remoteFn);
    expect(a.where).toBe('local');
    expect(b.where).toBe('local');
    expect(remoteFn).not.toHaveBeenCalled();
  });

  it('policy remote：远程失败不回退', async () => {
    const localFn = vi.fn(async () => '<h1>l</h1>');
    const res = await makeRouter({ policy: 'remote', compute: true, base: 'http://s' }).routeMarkdown(
      remotePath('doc.md'),
      '# hi',
      undefined,
      localFn,
      async () => {
        throw new Error('HTTP 413');
      }
    );
    expect(res).toEqual({ where: 'remote', ok: false, error: 'HTTP 413' });
    expect(localFn).not.toHaveBeenCalled();
  });

  it('policy local：恒本地（远程不可达也不影响）', async () => {
    const res = await makeRouter({ policy: 'local' }).routeMarkdown(
      remotePath('doc.md'),
      '# hi',
      undefined,
      async () => '<h1>l</h1>',
      async () => {
        throw new Error('should not be called');
      }
    );
    expect(res).toEqual({ where: 'local', ok: true, data: '<h1>l</h1>' });
  });
});

describe('routeSearch 路由占位（T4 实现远程）', () => {
  it('policy auto + src.path 走远程；失败回退本地', async () => {
    const r = makeRouter({ policy: 'auto', compute: true, base: 'http://s' });
    const ok = await r.routeSearch(remotePath('a.txt'), 'foo', async () => [], async () => [
      { line: 1, start: 0, end: 3 }
    ]);
    expect(ok).toEqual({ where: 'remote', ok: true, data: [{ line: 1, start: 0, end: 3 }] });

    const localFn = vi.fn(async () => [{ line: 0, start: 0, end: 3 }]);
    const fallback = await r.routeSearch(remotePath('a.txt'), 'foo', localFn, async () => {
      throw new Error('HTTP 404');
    });
    expect(fallback).toEqual({ where: 'local', ok: true, data: [{ line: 0, start: 0, end: 3 }] });
  });
});

describe('INJECTION_LANGS 注入语言路由（服务端 v1 无 injection）', () => {
  it('auto + 注入语言：highlightClient 不装配 remoteFn → 走本地', async () => {
    // highlightClient 按 highlightRemoteEligible 决定 remoteFn 有无：
    // auto 下注入语言（如 html，含内嵌脚本/样式注入）留在本地保注入完整
    expect(highlightRemoteEligible('auto', 'html')).toBe(false);
    const remoteFn = vi.fn(async () => [iv(0, 4)]);
    const res = await makeRouter({ policy: 'auto', compute: true, base: 'http://s' }).routeHighlight(
      remotePath('page.html'),
      'html',
      async () => [iv(0, 2)],
      highlightRemoteEligible('auto', 'html') ? remoteFn : undefined
    );
    expect(res).toEqual({ where: 'local', ok: true, data: [iv(0, 2)] });
    expect(remoteFn).not.toHaveBeenCalled();
  });

  it('remote + 注入语言：显式策略仍装配 remoteFn → 走远程', async () => {
    // 远程是用户的显式选择：注入语言也不拦截（丢注入由该选择自担）
    expect(highlightRemoteEligible('remote', 'rust')).toBe(true);
    const localFn = vi.fn(async () => [iv(0, 2)]);
    const res = await makeRouter({ policy: 'remote', compute: true, base: 'http://s' }).routeHighlight(
      remotePath('a.rs'),
      'rust',
      localFn,
      highlightRemoteEligible('remote', 'rust') ? async () => [iv(0, 4)] : undefined
    );
    expect(res).toEqual({ where: 'remote', ok: true, data: [iv(0, 4)] });
    expect(localFn).not.toHaveBeenCalled();
  });

  it('INJECTION_LANGS 清单与 assets 实测一致（带 injections.scm 的服务端语言）', () => {
    for (const lang of ['rust', 'c', 'cpp', 'go', 'html', 'javascript']) {
      expect(INJECTION_LANGS.has(lang), lang).toBe(true);
    }
    // 服务端 14 语言中无 injections.scm 者
    for (const lang of ['python', 'bash', 'json', 'yaml', 'toml', 'css', 'typescript', 'tsx']) {
      expect(INJECTION_LANGS.has(lang), lang).toBe(false);
    }
  });
});

describe('remoteCall（apps/web 构造远程请求用）', () => {
  it('无连接返回 null', () => {
    expect(makeRouter({ policy: 'auto', compute: true }).remoteCall('/api/compute/markdown')).toBeNull();
  });

  it('有连接拼 base 与 Bearer 头；无 token 时头为空对象', () => {
    const r = makeRouter({ policy: 'auto', compute: true, base: 'http://127.0.0.1:8321' });
    expect(r.remoteCall('/api/compute/markdown')).toEqual({
      url: 'http://127.0.0.1:8321/api/compute/markdown',
      headers: { authorization: 'Bearer tok-1' }
    });
    const noToken = createComputeRouter({
      hasCompute: () => true,
      policy: () => 'auto',
      remote: { base: () => 'http://s', token: () => null }
    });
    expect(noToken.remoteCall('/api/compute/highlight')).toEqual({
      url: 'http://s/api/compute/highlight',
      headers: {}
    });
  });
});
