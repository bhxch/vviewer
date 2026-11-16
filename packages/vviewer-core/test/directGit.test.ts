// directGit.test.ts — GitHub/GitLab 直连 TreeStore 双工厂（spec I，plan Task 1）。
// fetch mock 形态照 directS3.test.ts 先例（vi.stubGlobal + json/bytes 响应桩）。
// 断言锚=plan Task 1 验收锚 ①-⑧：storeId 凭据隔离（快照恢复红线）/ref 解析缓存/
// 清单切片/truncated BFS 分层/prefix 下钻/read 五态/GitLab 全链/probe 采样语义。
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createGithubDirectStore,
  createGitlabDirectStore,
  githubAuthHintText,
  githubCorsFailureText,
  githubDirectStoreId,
  githubHttpFailedText,
  githubRateLimitText,
  gitlabAuthHintText,
  gitlabCorsFailureText,
  gitlabDirectStoreId,
  gitlabHttpFailedText,
  gitlabRateLimitText,
  gitNotFoundHintText,
  probeGithubDirect,
  probeGitlabDirect,
  setGithubAuthHintText,
  setGithubCorsFailureText,
  setGithubHttpFailedText,
  setGithubRateLimitText,
  setGitlabAuthHintText,
  setGitlabCorsFailureText,
  setGitlabHttpFailedText,
  setGitlabRateLimitText,
  setGitNotFoundHintText,
  type GitlabDirectConfig,
  type GithubDirectConfig
} from '../src/tree/directGit';

// ---------- 响应桩（directS3.test.ts 先例形态） ----------

function mkHeaders(h: Record<string, string> = {}): { get(name: string): string | null } {
  const map = new Map(Object.entries(h).map(([k, v]) => [k.toLowerCase(), v] as const));
  return { get: (name: string) => map.get(name.toLowerCase()) ?? null };
}

/** JSON 响应桩：json + text + headers（Link/x-ratelimit-remaining 判定用）。 */
function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): unknown {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
    arrayBuffer: async () =>
      new TextEncoder().encode(JSON.stringify(body)).buffer as ArrayBuffer,
    headers: mkHeaders(headers)
  };
}

/** 字节响应桩：arrayBuffer（raw/内容通道用）。 */
function bytesResponse(bytes: Uint8Array, status = 200, headers: Record<string, string> = {}): unknown {
  return {
    ok: status >= 200 && status < 300,
    status,
    arrayBuffer: async () =>
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    text: async () => '',
    headers: mkHeaders(headers)
  };
}

/** 安装 fetch stub：handler 分发 URL→响应；返回 vi.fn（调用序列断言用）。 */
function installFetch(handler: (url: string, init: RequestInit) => unknown): ReturnType<typeof vi.fn> {
  const fn = vi.fn(async (input: string | URL, init?: RequestInit) =>
    handler(String(input), (init ?? {}) as RequestInit)
  );
  vi.stubGlobal('fetch', fn);
  return fn;
}

function calledUrls(fn: ReturnType<typeof vi.fn>): string[] {
  return fn.mock.calls.map((c) => String(c[0]));
}

// ---------- 缝恢复 + fetch 解 stub（用例间隔离） ----------

const ALL_SETTERS = [
  setGithubHttpFailedText,
  setGitlabHttpFailedText,
  setGithubAuthHintText,
  setGitlabAuthHintText,
  setGitNotFoundHintText,
  setGithubRateLimitText,
  setGitlabRateLimitText,
  setGithubCorsFailureText,
  setGitlabCorsFailureText
];

afterEach(() => {
  for (const s of ALL_SETTERS) s(null);
  vi.unstubAllGlobals();
});

// ---------- 共享 fixture ----------

const GH_SHA = 'a'.repeat(40);
const GH_B_README = 'b'.repeat(39) + '1';
const GH_B_GUIDE = 'b'.repeat(39) + '2';
const GH_B_X = 'b'.repeat(39) + '3';
const GH_T_DOCS = 'c'.repeat(39) + '1';
const GH_T_API = 'c'.repeat(39) + '2';
const GH_COMMIT = 'd'.repeat(40);
const GL_COMMIT = 'e'.repeat(40);
const GL_PID = 42;

describe('storeId（hash 输入不含凭据——快照恢复红线，Review Focus 1）', () => {
  const GH = { owner: 'octo', repo: 'repo', ref: 'main', prefix: 'docs' };
  const GL = { host: 'gitlab.example.com', project: 'grp/repo', ref: 'main', prefix: 'docs' };

  it('平台前缀字面 + hash8 形态（验收锚 ①）', () => {
    expect(githubDirectStoreId(GH)).toMatch(/^githubdirect:[0-9a-f]{8}$/);
    expect(gitlabDirectStoreId(GL)).toMatch(/^gitlabdirect:[0-9a-f]{8}$/);
  });

  it('token 不同 → 同 id（Pick 类型外的运行时红线断言）', () => {
    expect(githubDirectStoreId({ ...GH, token: 'ghp_secret' } as typeof GH)).toBe(
      githubDirectStoreId(GH)
    );
    expect(gitlabDirectStoreId({ ...GL, token: 'glpat_secret' } as typeof GL)).toBe(
      gitlabDirectStoreId(GL)
    );
  });

  it('credentialKey 变化 → 同 id（凭据库引用轮换不换 id）', () => {
    expect(githubDirectStoreId({ ...GH, credentialKey: 'github.com:octo' } as typeof GH)).toBe(
      githubDirectStoreId(GH)
    );
    expect(gitlabDirectStoreId({ ...GL, credentialKey: 'gitlab.example.com:grp' } as typeof GL)).toBe(
      gitlabDirectStoreId(GL)
    );
  });

  it('prefix 归一幂等：docs / docs/ / /docs/ 同 id；空串与 undefined 同 id', () => {
    const a = githubDirectStoreId({ ...GH, prefix: 'docs' });
    expect(githubDirectStoreId({ ...GH, prefix: 'docs/' })).toBe(a);
    expect(githubDirectStoreId({ ...GH, prefix: '/docs/' })).toBe(a);
    const b = githubDirectStoreId({ ...GH, prefix: '' });
    expect(githubDirectStoreId({ ...GH, prefix: undefined })).toBe(b);
  });

  it('gitlab host 归一幂等三形态同 id（Errata ⑨——恢复链一致性锚）', () => {
    const bare = gitlabDirectStoreId({ ...GL, host: 'gitlab.example.com' });
    expect(gitlabDirectStoreId({ ...GL, host: 'https://gitlab.example.com' })).toBe(bare);
    expect(gitlabDirectStoreId({ ...GL, host: 'https://gitlab.example.com/' })).toBe(bare);
  });

  it('owner/repo/ref trim 归一（identity 构成字面）', () => {
    expect(
      githubDirectStoreId({ owner: ' octo ', repo: ' repo ', ref: ' main ', prefix: 'docs' })
    ).toBe(githubDirectStoreId(GH));
    expect(
      gitlabDirectStoreId({ ...GL, host: ' gitlab.example.com ', project: ' grp/repo ' })
    ).toBe(gitlabDirectStoreId(GL));
  });

  it('身份任一分量不同 → 不同 id', () => {
    expect(githubDirectStoreId(GH)).not.toBe(githubDirectStoreId({ ...GH, ref: 'dev' }));
    expect(gitlabDirectStoreId(GL)).not.toBe(gitlabDirectStoreId({ ...GL, project: 'grp/other' }));
    expect(gitlabDirectStoreId(GL)).not.toBe(gitlabDirectStoreId({ ...GL, host: 'other.example.com' }));
  });
});

describe('错误特征化注入缝（9 setter——directS3.ts:74-166 模式镜像）', () => {
  it('githubHttpFailedText / gitlabHttpFailedText：缺省英文 + 注入 + 恢复缺省', () => {
    expect(githubHttpFailedText(404, ' x')).toBe('GitHub request failed: HTTP 404 x');
    expect(gitlabHttpFailedText(500, '')).toBe('GitLab request failed: HTTP 500');
    setGithubHttpFailedText((status, detail) => `GH[${status}]${detail}`);
    setGitlabHttpFailedText((status, detail) => `GL[${status}]${detail}`);
    expect(githubHttpFailedText(500, '!')).toBe('GH[500]!');
    expect(gitlabHttpFailedText(401, '!')).toBe('GL[401]!');
    setGithubHttpFailedText(null);
    setGitlabHttpFailedText(null);
    expect(githubHttpFailedText(500, '!')).toBe('GitHub request failed: HTTP 500!');
    expect(gitlabHttpFailedText(401, '')).toBe('GitLab request failed: HTTP 401');
  });

  it('githubAuthHintText / gitlabAuthHintText / gitNotFoundHintText：三缝独立注入恢复', () => {
    expect(githubAuthHintText()).not.toBe('H1');
    setGithubAuthHintText(() => 'H1');
    setGitlabAuthHintText(() => 'H2');
    setGitNotFoundHintText(() => 'H3');
    expect(githubAuthHintText()).toBe('H1');
    expect(gitlabAuthHintText()).toBe('H2');
    expect(gitNotFoundHintText()).toBe('H3');
    setGithubAuthHintText(null);
    expect(githubAuthHintText()).not.toBe('H1');
  });

  it('限速双缝 + CORS 双缝：注入消费 + 恢复缺省', () => {
    setGithubRateLimitText(() => 'GHRL');
    setGitlabRateLimitText(() => 'GLRL');
    setGithubCorsFailureText(() => 'GHCORS');
    setGitlabCorsFailureText(() => 'GLCORS');
    expect(githubRateLimitText()).toBe('GHRL');
    expect(gitlabRateLimitText()).toBe('GLRL');
    expect(githubCorsFailureText()).toBe('GHCORS');
    expect(gitlabCorsFailureText()).toBe('GLCORS');
    setGithubRateLimitText(null);
    setGitlabCorsFailureText(null);
    expect(githubRateLimitText()).not.toBe('GHRL');
    expect(gitlabCorsFailureText()).not.toBe('GLCORS');
    expect(gitlabRateLimitText()).toBe('GLRL'); // 未恢复的缝保持注入
  });
});

describe('GitHub 清单链（ref 解析/recursive 清单/切片）', () => {
  /** 标准 recursive 清单响应（README + docs/{guide.md, api/{x.md}} + submodule 跳过）。 */
  const RECURSIVE_TREE = {
    sha: GH_SHA,
    truncated: false,
    tree: [
      { path: 'README.md', type: 'blob', size: 12, sha: GH_B_README },
      { path: 'docs', type: 'tree', sha: GH_T_DOCS },
      { path: 'docs/guide.md', type: 'blob', size: 100, sha: GH_B_GUIDE },
      { path: 'docs/api', type: 'tree', sha: GH_T_API },
      { path: 'docs/api/x.md', type: 'blob', size: 5, sha: GH_B_X },
      { path: 'sub/link', type: 'commit', sha: GH_COMMIT }
    ]
  };

  function githubStore(cfg: Partial<GithubDirectConfig> = {}) {
    return createGithubDirectStore({
      owner: 'octo',
      repo: 'repo',
      ref: 'main',
      label: '样例仓',
      ...cfg
    });
  }

  it('branch ref 解析 + recursive 清单 + 根切片（目录优先自然序，验收锚 ②③）', async () => {
    const fn = installFetch((url) => {
      if (url === 'https://api.github.com/repos/octo/repo/commits/main') {
        return jsonResponse({ sha: GH_SHA });
      }
      if (url === `https://api.github.com/repos/octo/repo/git/trees/${GH_SHA}?recursive=1`) {
        return jsonResponse(RECURSIVE_TREE);
      }
      return jsonResponse({ message: 'miss' }, 404);
    });
    const store = githubStore();
    const root = await store.listChildren('');
    expect(root.map((n) => `${n.kind}:${n.name}`)).toEqual(['dir:docs', 'file:README.md']);
    expect(root.find((n) => n.name === 'README.md')?.size).toBe(12);
    // 第二次根 listChildren：重解析语义（commits 恰 2 次）+ 清单缓存键命中（recursive 恰 1 次）
    await store.listChildren('');
    const urls = calledUrls(fn);
    expect(urls.filter((u) => u.includes('/commits/main')).length).toBe(2);
    expect(urls.filter((u) => u.includes('/git/trees/')).length).toBe(1);
  });

  it('40 位 sha ref 零解析请求（验收锚 ②）', async () => {
    const fn = installFetch((url) => {
      if (url === `https://api.github.com/repos/octo/repo/git/trees/${GH_SHA}?recursive=1`) {
        return jsonResponse(RECURSIVE_TREE);
      }
      return jsonResponse({ message: 'miss' }, 404);
    });
    const store = githubStore({ ref: GH_SHA });
    await store.listChildren('');
    await store.listChildren('');
    expect(calledUrls(fn).filter((u) => u.includes('/commits/')).length).toBe(0);
  });

  it('子目录切片纯内存零请求 + sub 目录切片（验收锚 ③）', async () => {
    let commits = 0;
    let trees = 0;
    installFetch((url) => {
      if (url.includes('/commits/main')) {
        commits++;
        return jsonResponse({ sha: GH_SHA });
      }
      if (url.includes('/git/trees/')) {
        trees++;
        return jsonResponse(RECURSIVE_TREE);
      }
      return jsonResponse({ message: 'miss' }, 404);
    });
    const store = githubStore();
    await store.listChildren('');
    const docs = await store.listChildren('docs');
    expect(docs.map((n) => `${n.kind}:${n.name}`)).toEqual(['dir:api', 'file:guide.md']);
    const api = await store.listChildren('docs/api');
    expect(api.map((n) => n.name)).toEqual(['x.md']);
    expect(api[0]?.path).toBe('docs/api/x.md');
    expect(commits).toBe(1);
    expect(trees).toBe(1);
  });

  it('submodule（type:commit）条目跳过（反目标：无递归面）', async () => {
    installFetch((url) => {
      if (url.includes('/commits/main')) return jsonResponse({ sha: GH_SHA });
      if (url.includes('/git/trees/')) return jsonResponse(RECURSIVE_TREE);
      return jsonResponse({ message: 'miss' }, 404);
    });
    const store = githubStore();
    const root = await store.listChildren('');
    expect(root.some((n) => n.name === 'sub' || n.name === 'link')).toBe(false);
  });

  it('匿名请求不带 authorization 头；token 在场带 Bearer 头', async () => {
    const seen: string[] = [];
    installFetch((url, init) => {
      seen.push(`${url}|${JSON.stringify(init.headers ?? {})}`);
      if (url.includes('/commits/main')) return jsonResponse({ sha: GH_SHA });
      if (url.includes('/git/trees/')) return jsonResponse(RECURSIVE_TREE);
      return jsonResponse({ message: 'miss' }, 404);
    });
    await githubStore().listChildren('');
    expect(seen.every((s) => !s.includes('authorization'))).toBe(true);
    await githubStore({ token: 'T0K' }).listChildren('');
    expect(seen.some((s) => s.includes('"authorization":"Bearer T0K"'))).toBe(true);
  });

  it('truncated recursive → BFS 逐目录完整清单（验收锚 ④——store 打开路径全量分层）', async () => {
    const fn = installFetch((url) => {
      if (url.includes('/commits/main')) return jsonResponse({ sha: GH_SHA });
      if (url === `https://api.github.com/repos/octo/repo/git/trees/${GH_SHA}?recursive=1`) {
        return jsonResponse({ sha: GH_SHA, truncated: true, tree: [] });
      }
      if (url === `https://api.github.com/repos/octo/repo/git/trees/${GH_SHA}`) {
        return jsonResponse({
          sha: GH_SHA,
          truncated: false,
          tree: [
            { path: 'a', type: 'tree', sha: GH_T_DOCS },
            { path: 'f.md', type: 'blob', size: 1, sha: GH_B_README }
          ]
        });
      }
      if (url === `https://api.github.com/repos/octo/repo/git/trees/${GH_T_DOCS}`) {
        return jsonResponse({
          sha: GH_T_DOCS,
          truncated: false,
          tree: [{ path: 'inner.md', type: 'blob', size: 2, sha: GH_B_GUIDE }]
        });
      }
      return jsonResponse({ message: 'miss' }, 404);
    });
    const store = githubStore();
    const root = await store.listChildren('');
    expect(root.map((n) => `${n.kind}:${n.name}`)).toEqual(['dir:a', 'file:f.md']);
    expect((await store.listChildren('a')).map((n) => n.name)).toEqual(['inner.md']);
    const urls = calledUrls(fn);
    expect(urls.filter((u) => u.includes(`trees/${GH_SHA}?recursive=1`)).length).toBe(1);
    expect(urls.filter((u) => u === `https://api.github.com/repos/octo/repo/git/trees/${GH_SHA}`).length).toBe(1);
    expect(urls.filter((u) => u === `https://api.github.com/repos/octo/repo/git/trees/${GH_T_DOCS}`).length).toBe(1);
  });

  it('目录级 truncated → throw 特征化文案（绝不静默截断）', async () => {
    setGithubRateLimitText(() => 'GHRL');
    installFetch((url) => {
      if (url.includes('/commits/main')) return jsonResponse({ sha: GH_SHA });
      if (url.includes('?recursive=1')) {
        return jsonResponse({ sha: GH_SHA, truncated: true, tree: [] });
      }
      return jsonResponse({ sha: 'x', truncated: true, tree: [] });
    });
    const store = githubStore();
    await expect(store.listChildren('')).rejects.toThrow(/truncated/);
  });

  it('BFS 请求超 1000 上限 → throw 超限文案（Review Focus 6）', async () => {
    let depth = 0;
    installFetch((url) => {
      if (url.includes('/commits/main')) return jsonResponse({ sha: GH_SHA });
      if (url.includes('?recursive=1')) {
        return jsonResponse({ sha: GH_SHA, truncated: true, tree: [] });
      }
      depth++;
      return jsonResponse({
        sha: `t${depth}`,
        truncated: false,
        tree: [{ path: `d${depth}`, type: 'tree', sha: `t${depth + 1}` }]
      });
    });
    const store = githubStore();
    await expect(store.listChildren('')).rejects.toThrow(/1000/);
  });
});

describe('GitHub 内容通道（read 五态——验收锚 ⑥）', () => {
  const RAW_BASE = `https://raw.githubusercontent.com/octo/repo/${GH_SHA}`;

  /** recursive 清单响应（同 GitHub 清单链 describe 的 RECURSIVE_TREE）。 */
  const RECURSIVE_TREE = {
    sha: GH_SHA,
    truncated: false,
    tree: [
      { path: 'README.md', type: 'blob', size: 12, sha: GH_B_README },
      { path: 'docs', type: 'tree', sha: GH_T_DOCS },
      { path: 'docs/guide.md', type: 'blob', size: 100, sha: GH_B_GUIDE },
      { path: 'docs/api', type: 'tree', sha: GH_T_API },
      { path: 'docs/api/x.md', type: 'blob', size: 5, sha: GH_B_X }
    ]
  };

  /** 装置：清单拉取 + read 通道 mock。 */
  async function readWith(
    mock: (url: string, init: RequestInit) => unknown,
    path: string,
    cfg: Partial<GithubDirectConfig> = {}
  ): Promise<{
    store: ReturnType<typeof createGithubDirectStore>;
    fn: ReturnType<typeof vi.fn>;
    bytes: Uint8Array;
    url: string;
    init: RequestInit;
  }> {
    const fn = installFetch((url, init) => {
      if (url === 'https://api.github.com/repos/octo/repo/commits/main') {
        return jsonResponse({ sha: GH_SHA });
      }
      if (url === `https://api.github.com/repos/octo/repo/git/trees/${GH_SHA}?recursive=1`) {
        return jsonResponse(RECURSIVE_TREE);
      }
      return mock(url, init);
    });
    const store = createGithubDirectStore({ owner: 'octo', repo: 'repo', ref: 'main', label: '样例仓', ...cfg });
    await store.listChildren('');
    const bytes = await store.read(path);
    return { store, fn, bytes, url: String(fn.mock.calls.at(-1)?.[0]), init: fn.mock.calls.at(-1)?.[1] as RequestInit };
  }

  it('raw 200：ref 槽取解析后 sha + path 逐段 encodeURIComponent（Review Focus 4）', async () => {
    const GUIDE_BYTES = new TextEncoder().encode('# guide');
    const r = await readWith(
      (url) => (url === `${RAW_BASE}/docs/guide.md` ? bytesResponse(GUIDE_BYTES) : jsonResponse({ message: 'miss' }, 404)),
      'docs/guide.md'
    );
    expect(r.url).toBe(`${RAW_BASE}/docs/guide.md`);
    expect(new TextDecoder().decode(r.bytes)).toBe('# guide');
  });

  it('raw 401 → blobs 兜底：Bearer 头 + manifest blob sha 消费 + base64 解码（Errata ①）', async () => {
    const content = btoa('fallback via git/blobs');
    const r = await readWith(
      (url, init) => {
        if (url.startsWith(RAW_BASE)) return jsonResponse({ message: 'Unauthorized' }, 401);
        if (url === `https://api.github.com/repos/octo/repo/git/blobs/${GH_B_GUIDE}`) {
          expect((init.headers as Record<string, string>).authorization).toBe('Bearer T0K');
          return jsonResponse({ content, encoding: 'base64' });
        }
        return jsonResponse({ message: 'miss' }, 404);
      },
      'docs/guide.md',
      { token: 'T0K' }
    );
    expect(r.url).toBe(`https://api.github.com/repos/octo/repo/git/blobs/${GH_B_GUIDE}`);
    expect(new TextDecoder().decode(r.bytes)).toBe('fallback via git/blobs');
  });

  it('raw 404 → notFound 文案（共用 404 缝）', async () => {
    setGitNotFoundHintText(() => '（NF）');
    await expect(
      readWith(
        (url) => (url.startsWith(RAW_BASE) ? jsonResponse({ message: 'Not Found' }, 404) : jsonResponse({ message: 'miss' }, 404)),
        'docs/guide.md'
      )
    ).rejects.toThrow(/HTTP 404（NF）/);
  });

  it('raw 429 / raw 403+x-ratelimit-remaining:0 → 限速文案（限速优先于兜底）', async () => {
    setGithubRateLimitText(() => 'GHRL');
    await expect(
      readWith(
        (url) => (url.startsWith(RAW_BASE) ? jsonResponse({ message: 'rate limited' }, 429) : jsonResponse({ message: 'miss' }, 404)),
        'docs/guide.md'
      )
    ).rejects.toThrow('GHRL');
    const r = await readWith(
      (url) => (url.startsWith(RAW_BASE) ? jsonResponse({ message: 'forbidden' }, 403, { 'x-ratelimit-remaining': '0' }) : jsonResponse({ message: 'miss' }, 404)),
      'docs/guide.md'
    ).catch((e: Error) => e.message);
    expect(r).toBe('GHRL');
  });

  it('raw 403 非限速形态 → 仍走 blobs 兜底（401/403 同兜底面）', async () => {
    const content = btoa('via blobs after 403');
    const r = await readWith(
      (url) => {
        if (url.startsWith(RAW_BASE)) return jsonResponse({ message: 'forbidden' }, 403);
        if (url === `https://api.github.com/repos/octo/repo/git/blobs/${GH_B_GUIDE}`) {
          return jsonResponse({ content, encoding: 'base64' });
        }
        return jsonResponse({ message: 'miss' }, 404);
      },
      'docs/guide.md'
    );
    expect(new TextDecoder().decode(r.bytes)).toBe('via blobs after 403');
  });

  it('fetch TypeError → CORS 特征化文案（rawFetch 注入缝消费）', async () => {
    setGithubCorsFailureText(() => 'GHCORS');
    installFetch(() => {
      throw new TypeError('Failed to fetch');
    });
    const store = createGithubDirectStore({ owner: 'octo', repo: 'repo', ref: 'main', label: '样例仓' });
    await expect(store.listChildren('')).rejects.toThrow('GHCORS');
  });

  it('清单无该 path → notFound 文案且零 raw 请求（快照一致性：内容只服务清单代际）', async () => {
    setGitNotFoundHintText(() => '（NF）');
    let rawCalls = 0;
    const fn = installFetch((url) => {
      if (url === 'https://api.github.com/repos/octo/repo/commits/main') {
        return jsonResponse({ sha: GH_SHA });
      }
      if (url.includes('/git/trees/')) return jsonResponse(RECURSIVE_TREE);
      if (url.startsWith('https://raw.githubusercontent.com/')) rawCalls++;
      return jsonResponse({ message: 'miss' }, 404);
    });
    const store = createGithubDirectStore({ owner: 'octo', repo: 'repo', ref: 'main', label: '样例仓' });
    await store.listChildren('');
    await expect(store.read('missing.md')).rejects.toThrow(/（NF）/);
    expect(rawCalls).toBe(0);
    expect(calledUrls(fn).some((u) => u.startsWith('https://raw.githubusercontent.com/'))).toBe(false);
  });
});

describe('GitLab 全链（清单分页/内容/错误族——验收锚 ⑦）', () => {
  const GL_PROJECT_URL = `https://gitlab.test/api/v4/projects/group%2Frepo`;
  const GL_TREE_BASE = `https://gitlab.test/api/v4/projects/${GL_PID}/repository/tree`;
  const GL_NEXT_LINK = `<${GL_TREE_BASE}?ref=main&recursive=true&per_page=100&page=2>; rel="next"`;

  /** GitLab tree 条目形态（id/name/type/path）。 */
  function glBlobs(prefixPath: string | null, count: number, tag: string): Array<{ id: string; name: string; type: string; path: string }> {
    return Array.from({ length: count }, (_, i) => {
      const p = `${tag}${i}.txt`;
      return { id: `id_${tag}${i}`, name: p, type: 'blob', path: prefixPath === null ? p : `${prefixPath}/${p}` };
    });
  }

  /** 混合条目（tree/commit/blob——切片语义锚）。 */
  const GL_MIXED = [
    { id: 'g1', name: 'README.md', type: 'blob', path: 'README.md' },
    { id: 'g2', name: 'docs', type: 'tree', path: 'docs' },
    { id: 'g3', name: 'guide.md', type: 'blob', path: 'docs/guide.md' },
    { id: 'g4', name: 'api', type: 'tree', path: 'docs/api' },
    { id: 'g5', name: 'x.md', type: 'blob', path: 'docs/api/x.md' },
    { id: 'g6', name: 'sub', type: 'commit', path: 'sub' }
  ];

  function gitlabStore(cfg: Partial<GitlabDirectConfig> = {}) {
    return createGitlabDirectStore({
      host: 'https://gitlab.test',
      project: 'group/repo',
      ref: 'main',
      label: '样例项目',
      ...cfg
    });
  }

  /** 装置：项目定位 mock。 */
  function installProjectMock(extra: (url: string, init: RequestInit) => unknown): ReturnType<typeof vi.fn> {
    return installFetch((url, init) => {
      if (url === GL_PROJECT_URL) return jsonResponse({ id: GL_PID });
      return extra(url, init);
    });
  }

  it('项目解析一次缓存：两次根 listChildren 恰 1 次 /projects 请求 + tree 重拉 2 次（验收锚 ⑦）', async () => {
    const fn = installProjectMock((url) => {
      if (url.startsWith(GL_TREE_BASE)) return jsonResponse(glBlobs(null, 3, 'r'));
      return jsonResponse({ message: 'miss' }, 404);
    });
    const store = gitlabStore();
    await store.listChildren('');
    await store.listChildren('');
    const urls = calledUrls(fn);
    expect(urls.filter((u) => u === GL_PROJECT_URL).length).toBe(1);
    expect(urls.filter((u) => u.includes('/repository/tree')).length).toBe(2);
  });

  it('root 切片 + 子目录切片：tree/commit 条目不入清单（blob path 推导目录）', async () => {
    installProjectMock((url) => {
      if (url.startsWith(GL_TREE_BASE)) return jsonResponse(GL_MIXED);
      return jsonResponse({ message: 'miss' }, 404);
    });
    const store = gitlabStore();
    const root = await store.listChildren('');
    expect(root.map((n) => `${n.kind}:${n.name}`)).toEqual(['dir:docs', 'file:README.md']);
    expect((await store.listChildren('docs')).map((n) => `${n.kind}:${n.name}`)).toEqual(['dir:api', 'file:guide.md']);
    expect((await store.listChildren('docs/api')).map((n) => n.name)).toEqual(['x.md']);
  });

  it('Link rel=next 顺序 follow 两页（禁并发深分页——顺序 URL 断言）', async () => {
    const fn = installProjectMock((url) => {
      if (url === `${GL_TREE_BASE}?ref=main&recursive=true&per_page=100`) {
        return jsonResponse(glBlobs(null, 100, 'p1_'), 200, { link: GL_NEXT_LINK });
      }
      if (url === `${GL_TREE_BASE}?ref=main&recursive=true&per_page=100&page=2`) {
        return jsonResponse(glBlobs(null, 50, 'p2_'));
      }
      return jsonResponse({ message: 'miss' }, 404);
    });
    const root = await gitlabStore().listChildren('');
    expect(root.length).toBe(150);
    const treeUrls = calledUrls(fn).filter((u) => u.includes('/repository/tree'));
    expect(treeUrls.length).toBe(2);
    expect(treeUrls[1]).toContain('page=2');
  });

  it('Link 头不可读 → page 参数顺序走页直到短页（§7-4 退化路径）', async () => {
    const fn = installProjectMock((url) => {
      if (url === `${GL_TREE_BASE}?ref=main&recursive=true&per_page=100`) {
        return jsonResponse(glBlobs(null, 100, 'p1_'));
      }
      if (url === `${GL_TREE_BASE}?ref=main&recursive=true&per_page=100&page=2`) {
        return jsonResponse(glBlobs(null, 100, 'p2_'));
      }
      if (url === `${GL_TREE_BASE}?ref=main&recursive=true&per_page=100&page=3`) {
        return jsonResponse(glBlobs(null, 30, 'p3_'));
      }
      return jsonResponse({ message: 'miss' }, 404);
    });
    const root = await gitlabStore().listChildren('');
    expect(root.length).toBe(230);
    const treeUrls = calledUrls(fn).filter((u) => u.includes('/repository/tree'));
    expect(treeUrls.length).toBe(3);
    expect(treeUrls[1]).toContain('page=2');
    expect(treeUrls[2]).toContain('page=3');
  });

  it('per_page=100 + recursive=true + prefix → path 参数（清单层下钻——§6-4）', async () => {
    const fn = installProjectMock((url) => {
      if (url.startsWith(GL_TREE_BASE)) return jsonResponse(glBlobs('docs', 2, 'g'));
      return jsonResponse({ message: 'miss' }, 404);
    });
    const store = gitlabStore({ prefix: 'docs' });
    await store.listChildren('');
    const treeUrl = calledUrls(fn).find((u) => u.includes('/repository/tree')) ?? '';
    expect(treeUrl).toContain('per_page=100');
    expect(treeUrl).toContain('recursive=true');
    expect(treeUrl).toContain('ref=main');
    expect(treeUrl).toContain('path=docs');
  });

  it('prefix 挂载：GitLab 相对形态条目归一回补 mountPrefix（全路径形态兼容同剥）', async () => {
    // GitLab tree API 带 path 参数的条目 path 形态两实现并存：相对 prefix（此处锚）
    // 或仓库相对全路径（下例锚）——归一宽容两形态（startsWith 剥前缀/原样回补）。
    installProjectMock((url) => {
      if (url.startsWith(GL_TREE_BASE)) return jsonResponse(glBlobs(null, 2, 'g'));
      return jsonResponse({ message: 'miss' }, 404);
    });
    const store = gitlabStore({ prefix: 'docs' });
    const root = await store.listChildren('');
    expect(root.map((n) => n.name)).toEqual(['g0.txt', 'g1.txt']);
    expect(root[0]?.path).toBe('g0.txt');
  });

  it('prefix 挂载：GitLab 仓库相对全路径形态条目 → 剥 mountPrefix 归一', async () => {
    installProjectMock((url) => {
      if (url.startsWith(GL_TREE_BASE)) return jsonResponse(glBlobs('docs', 2, 'g'));
      return jsonResponse({ message: 'miss' }, 404);
    });
    const store = gitlabStore({ prefix: 'docs' });
    const root = await store.listChildren('');
    expect(root.map((n) => n.name)).toEqual(['g0.txt', 'g1.txt']);
    expect(root[0]?.path).toBe('g0.txt');
  });

  it('2 万条目上限 → throw 截断文案（不静默截断）', async () => {
    let pageN = 0;
    installProjectMock((url) => {
      if (url.startsWith(GL_TREE_BASE)) {
        pageN++;
        return jsonResponse(glBlobs(null, 100, `w${pageN}_`));
      }
      return jsonResponse({ message: 'miss' }, 404);
    });
    const store = gitlabStore();
    await expect(store.listChildren('')).rejects.toThrow(/20000/);
  });

  it('host 归一运行时面：无 scheme + 尾斜杠原文 → 请求基址归一（Errata ⑨ 与 storeId 同源）', async () => {
    const fn = installFetch((url) => {
      if (url === 'https://gitlab.test/api/v4/projects/group%2Frepo') return jsonResponse({ id: GL_PID });
      if (url.startsWith(GL_TREE_BASE)) return jsonResponse(glBlobs(null, 1, 'r'));
      return jsonResponse({ message: 'miss' }, 404);
    });
    const store = gitlabStore({ host: 'gitlab.test/' });
    await store.listChildren('');
    expect(calledUrls(fn)[0]).toBe(GL_PROJECT_URL);
  });

  it('PRIVATE-TOKEN 头：token 在场 → 清单与 raw 请求均带；匿名 → 不带', async () => {
    const seen: string[] = [];
    installFetch((url, init) => {
      seen.push(`${url}|${JSON.stringify(init.headers ?? {})}`);
      if (url === GL_PROJECT_URL) return jsonResponse({ id: GL_PID });
      if (url.startsWith(GL_TREE_BASE)) return jsonResponse(glBlobs(null, 1, 'r'));
      if (url === `https://gitlab.test/api/v4/projects/${GL_PID}/repository/files/README.md/raw?ref=main`) {
        return bytesResponse(new TextEncoder().encode('# readme'));
      }
      return jsonResponse({ message: 'miss' }, 404);
    });
    await gitlabStore().listChildren('');
    await gitlabStore().read('README.md');
    expect(seen.every((s) => !s.includes('PRIVATE-TOKEN'))).toBe(true);
    await gitlabStore({ token: 'GL-T' }).listChildren('');
    await gitlabStore({ token: 'GL-T' }).read('README.md');
    expect(seen.filter((s) => s.includes('"PRIVATE-TOKEN":"GL-T"')).length).toBeGreaterThanOrEqual(2);
  });

  it('read：files/{path 全路径 %2F}/raw?ref= API 端点（spec §5 路径编码锚）', async () => {
    const RAW_BYTES = new TextEncoder().encode('gl file body');
    const fn = installProjectMock((url) => {
      if (url.startsWith(GL_TREE_BASE)) return jsonResponse(glBlobs(null, 1, 'r'));
      if (url === `https://gitlab.test/api/v4/projects/${GL_PID}/repository/files/docs%2Fapi%2Fx.md/raw?ref=main`) {
        return bytesResponse(RAW_BYTES);
      }
      return jsonResponse({ message: 'miss' }, 404);
    });
    const store = gitlabStore();
    await store.listChildren('');
    const bytes = await store.read('docs/api/x.md');
    expect(new TextDecoder().decode(bytes)).toBe('gl file body');
    const rawUrl = calledUrls(fn).find((u) => u.includes('/files/')) ?? '';
    expect(rawUrl).toContain('docs%2Fapi%2Fx.md');
    expect(rawUrl).not.toContain('docs/api/x.md');
  });

  it('错误族：401 → authHint / 404 → notFound / 429 → 限速（ensureGitOk 特征化）', async () => {
    setGitlabAuthHintText(() => '（GLAUTH）');
    setGitNotFoundHintText(() => '（NF）');
    setGitlabRateLimitText(() => 'GLRL');
    const statusMap: { mode?: number; headers?: Record<string, string> } = {};
    installProjectMock((url) => {
      if (url.startsWith(GL_TREE_BASE)) {
        return jsonResponse({ message: 'err' }, statusMap.mode ?? 200, statusMap.headers ?? {});
      }
      return jsonResponse({ message: 'miss' }, 404);
    });
    const store = gitlabStore();
    statusMap.mode = 401;
    await expect(store.listChildren('')).rejects.toThrow(/HTTP 401（GLAUTH）/);
    statusMap.mode = 404;
    await expect(store.listChildren('')).rejects.toThrow(/HTTP 404（NF）/);
    statusMap.mode = 429;
    await expect(store.listChildren('')).rejects.toThrow('GLRL');
    statusMap.mode = 403;
    statusMap.headers = { 'x-ratelimit-remaining': '0' };
    await expect(store.listChildren('')).rejects.toThrow('GLRL');
    statusMap.mode = 403;
    statusMap.headers = {};
    await expect(store.listChildren('')).rejects.toThrow(/HTTP 403/);
  });

  it('fetch TypeError → GitLab CORS 特征化文案（自建实例放行提示）', async () => {
    setGitlabCorsFailureText(() => 'GLCORS');
    installFetch(() => {
      throw new TypeError('Failed to fetch');
    });
    const store = gitlabStore();
    await expect(store.listChildren('')).rejects.toThrow('GLCORS');
  });
});

describe('probe 双函数（采样语义——验收锚 ⑧，Errata ⑩）', () => {
  const GL_TREE_BASE = `https://gitlab.test/api/v4/projects/${GL_PID}/repository/tree`;

  it('probeGithubDirect：truncated 响应不 BFS——请求恰止于 recursive 单响应 + 部分计数', async () => {
    const fn = installFetch((url) => {
      if (url === 'https://api.github.com/repos/octo/repo/commits/main') {
        return jsonResponse({ sha: GH_SHA });
      }
      if (url === `https://api.github.com/repos/octo/repo/git/trees/${GH_SHA}?recursive=1`) {
        return jsonResponse({
          sha: GH_SHA,
          truncated: true,
          tree: [
            { path: 'a.md', type: 'blob', size: 1, sha: GH_B_README },
            { path: 'b.md', type: 'blob', size: 2, sha: GH_B_GUIDE },
            { path: 'c', type: 'tree', sha: GH_T_DOCS },
            { path: 'c/d.md', type: 'blob', size: 3, sha: GH_B_X }
          ]
        });
      }
      // BFS 非递归请求若发生 → 测试失败（请求恰止于 recursive 单响应）
      return jsonResponse({ message: 'BFS must not happen in probe' }, 500);
    });
    const r = await probeGithubDirect({ owner: 'octo', repo: 'repo', ref: 'main', label: 'p' });
    expect(r).toEqual({ files: 3, sha: GH_SHA, truncated: true });
    const urls = calledUrls(fn);
    expect(urls.filter((u) => u.includes('/commits/')).length).toBe(1);
    expect(urls.filter((u) => u.includes('/git/trees/')).length).toBe(1);
  });

  it('probeGithubDirect：recursive 正常 → {files, sha}；40 位 sha ref 零解析请求', async () => {
    const fn = installFetch((url) => {
      if (url === `https://api.github.com/repos/octo/repo/git/trees/${GH_SHA}?recursive=1`) {
        return jsonResponse({
          sha: GH_SHA,
          truncated: false,
          tree: [
            { path: 'a.md', type: 'blob', size: 1, sha: GH_B_README },
            { path: 'c', type: 'tree', sha: GH_T_DOCS }
          ]
        });
      }
      return jsonResponse({ message: 'miss' }, 404);
    });
    const r = await probeGithubDirect({ owner: 'octo', repo: 'repo', ref: GH_SHA, label: 'p' });
    expect(r).toEqual({ files: 1, sha: GH_SHA });
    expect(calledUrls(fn).some((u) => u.includes('/commits/'))).toBe(false);
  });

  it('probeGitlabDirect：恰 1 页（Link 在场不翻页）+ commits 取 sha', async () => {
    const fn = installFetch((url) => {
      if (url === `https://gitlab.test/api/v4/projects/group%2Frepo`) return jsonResponse({ id: GL_PID });
      if (url === `https://gitlab.test/api/v4/projects/${GL_PID}/repository/commits/main`) {
        return jsonResponse({ id: GL_COMMIT });
      }
      if (url === `${GL_TREE_BASE}?ref=main&recursive=true&per_page=100`) {
        return jsonResponse(glProbeBlobs(), 200, { link: '<...page=2>; rel="next"' });
      }
      return jsonResponse({ message: 'miss' }, 404);
    });
    const r = await probeGitlabDirect({ host: 'https://gitlab.test', project: 'group/repo', ref: 'main', label: 'p' });
    expect(r).toEqual({ files: 100, sha: GL_COMMIT });
    expect(calledUrls(fn).filter((u) => u.includes('/repository/tree')).length).toBe(1);
  });

  it('probeGitlabDirect：prefix → path 参数；首页 <100 短页照常单页', async () => {
    installFetch((url) => {
      if (url === `https://gitlab.test/api/v4/projects/group%2Frepo`) return jsonResponse({ id: GL_PID });
      if (url === `https://gitlab.test/api/v4/projects/${GL_PID}/repository/commits/main`) {
        return jsonResponse({ id: GL_COMMIT });
      }
      if (url === `${GL_TREE_BASE}?ref=main&recursive=true&per_page=100&path=docs`) {
        return jsonResponse([{ id: 'g1', name: 'x.md', type: 'blob', path: 'x.md' }]);
      }
      return jsonResponse({ message: 'miss' }, 404);
    });
    const r = await probeGitlabDirect({ host: 'https://gitlab.test', project: 'group/repo', ref: 'main', prefix: 'docs', label: 'p' });
    expect(r).toEqual({ files: 1, sha: GL_COMMIT });
  });

  function glProbeBlobs(): unknown[] {
    return Array.from({ length: 100 }, (_, i) => ({ id: `p${i}`, name: `f${i}.txt`, type: 'blob', path: `f${i}.txt` }));
  }
});
