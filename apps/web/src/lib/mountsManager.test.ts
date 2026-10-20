// mountsManager.test.ts — 目录管理页纯逻辑（目录挂载 spec §5 阶段四，plan Task 2）。
// MountsManager.svelte 的可测面收编本文件：表单校验（必填镜像 server build_mount
// per-kind 必填 + endpoint userinfo 拒绝——评审 L1）、草稿↔记录构造（id 闭环）、
// 三组数据装配（服务端根与挂载/前端配置挂载/本机授权来源）、测试连接探测（S3
// ListObjectsV2 / WebDAV PROPFIND 条目数+延迟回显；CORS 特征化与 WebCrypto 缺失
// 错误回显——Task 1 疑虑①）。组件骨架/接线为源码契约断言（mountsManagerUi.test.ts）。
import { afterEach, describe, expect, it, vi } from 'vitest';
import { webcrypto } from 'node:crypto';
import {
  assembleLocalRows,
  assembleMountRows,
  assembleServerMountRows,
  CREDENTIAL_WARNING,
  draftFromRecord,
  draftToDirectRecord,
  draftToProxyRecord,
  emptyDraft,
  endpointIssue,
  formatProbeResult,
  mountFormIssues,
  mountUsageOf,
  probeDraft,
  probeRecord,
  proxyOffsiteOf,
  WEBDAV_CORS_HINT,
  type MountFormDraft
} from './mountsManager';
import type { DirectMountRecord, MountsManifest, ProxyMountRecord } from './mountsSync';
import type { WorkspaceSource } from './workspaceStore';

// ---------- 桩 ----------

/** fetch 桩：handler 返回 Response 形态对象；undefined = 未模拟抛错。 */
function stubFetch(handler: (method: string, url: string) => unknown): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const method = (init?.method ?? 'GET').toUpperCase();
      const res = handler(method, String(input));
      if (res === undefined) throw new Error(`unmocked ${method} ${input}`);
      return res;
    })
  );
}

const S3_LIST_XML = `<ListBucketResult>
  <IsTruncated>false</IsTruncated>
  <Contents><Key>docs/a.txt</Key><Size>3</Size></Contents>
  <Contents><Key>docs/b.txt</Key><Size>1</Size></Contents>
  <CommonPrefixes><Prefix>docs/sub/</Prefix></CommonPrefixes>
</ListBucketResult>`;

const PROPFIND_XML = `<?xml version="1.0" encoding="utf-8"?>
<D:multistatus xmlns:D="DAV:">
  <D:response><D:href>/dav/</D:href><D:propstat><D:prop><D:resourcetype><D:collection/></D:resourcetype></D:prop></D:propstat></D:response>
  <D:response><D:href>/dav/dir/</D:href><D:propstat><D:prop><D:resourcetype><D:collection/></D:resourcetype></D:prop></D:propstat></D:response>
  <D:response><D:href>/dav/a.txt</D:href><D:propstat><D:prop><D:resourcetype/><D:getcontentlength>3</D:getcontentlength></D:prop></D:propstat></D:response>
</D:multistatus>`;

function xmlRes(xml: string, status: number): unknown {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => xml,
    arrayBuffer: async () => new TextEncoder().encode(xml).buffer as ArrayBuffer,
    headers: { get: () => null }
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

// ---------- L1：endpoint userinfo 校验 ----------

describe('endpointIssue（评审 L1：authority 段 userinfo 拒绝）', () => {
  it('含 userinfo 的 endpoint 拒绝并给固定提示文案', () => {
    expect(endpointIssue('https://user:pass@s3.example.com')).toBe(
      '请使用不含凭据的 endpoint，凭据在下方字段填写'
    );
    expect(endpointIssue('http://ak@127.0.0.1:9000')).not.toBeNull();
    expect(endpointIssue('webdav 主机@dav.example.com/dav')).not.toBeNull(); // 无 scheme 形态同判
  });

  it('path 段 @ 不误伤；干净 endpoint 通过（null）', () => {
    expect(endpointIssue('https://s3.example.com/bucket@suffix')).toBeNull();
    expect(endpointIssue('https://s3.example.com')).toBeNull();
    expect(endpointIssue('http://127.0.0.1:9000')).toBeNull();
    expect(endpointIssue('https://@host')).not.toBeNull(); // 空 userinfo 形态同拒（防御）
  });
});

// ---------- 表单必填校验（镜像 server build_mount per-kind 必填） ----------

describe('mountFormIssues', () => {
  it('合法直连 S3 草稿零错误', () => {
    const d: MountFormDraft = {
      ...emptyDraft(),
      label: '样例',
      endpoint: 'https://s3.example.com',
      bucket: 'bkt',
      username: 'AK',
      secret: 'SK'
    };
    expect(mountFormIssues(d)).toEqual({});
  });

  it('S3 必填：label/endpoint/bucket/凭据缺失逐项标错（错误消息含字段定位）', () => {
    const issues = mountFormIssues(emptyDraft());
    expect(issues.label).toBeTruthy();
    expect(issues.endpoint).toBe('必填');
    expect(issues.bucket).toBe('必填');
    expect(issues.username).toBe('必填');
    expect(issues.secret).toBe('必填');
  });

  it('WebDAV 必填：bucket 非必填；username/password 必填', () => {
    const d: MountFormDraft = {
      ...emptyDraft(),
      backend: 'webdav',
      label: '文献',
      endpoint: 'https://dav.example.com',
      username: 'u',
      secret: 'p'
    };
    expect(mountFormIssues(d)).toEqual({});
    const missing = mountFormIssues({ ...d, secret: '' });
    expect(missing.secret).toBeTruthy();
    expect(missing.bucket).toBeUndefined();
  });

  it('endpoint userinfo：占位文案即 L1 提示（非「必填」）', () => {
    const d: MountFormDraft = {
      ...emptyDraft(),
      label: 'x',
      endpoint: 'https://u:p@h',
      bucket: 'b',
      username: 'a',
      secret: 'b'
    };
    expect(mountFormIssues(d).endpoint).toBe('请使用不含凭据的 endpoint，凭据在下方字段填写');
  });

  it('proxy 模式需已连接服务器（serverBase 注入），直连模式不要求', () => {
    const d: MountFormDraft = {
      ...emptyDraft(),
      mode: 'proxy',
      label: 'x',
      endpoint: 'https://s3.example.com',
      bucket: 'b',
      username: 'a',
      secret: 'b'
    };
    expect(mountFormIssues(d).serverBase).toBeTruthy();
    expect(mountFormIssues({ ...d, serverBase: 'http://127.0.0.1:8321' }).serverBase).toBeUndefined();
  });
});

// ---------- 草稿 ↔ 记录 ----------

describe('draftToDirectRecord/draftToProxyRecord/draftFromRecord', () => {
  const d: MountFormDraft = {
    mode: 'direct',
    backend: 's3',
    label: ' 样例桶 ',
    endpoint: 'http://127.0.0.1:9000/',
    bucket: ' bkt ',
    prefix: ' sub ',
    username: ' AK ',
    secret: 'SK',
    pathStyle: false,
    serverBase: ''
  };

  it('直连记录：id = s3DirectStoreId（同配置去重、凭据轮换不换 id）；trim 落盘；createdAt 沿用既有', () => {
    const first = draftToDirectRecord(d);
    expect(first.kind).toBe('direct');
    expect(first.id).toMatch(/^s3direct:[0-9a-f]{8}$/);
    expect(first.endpoint).toBe('http://127.0.0.1:9000');
    expect(first.bucket).toBe('bkt');
    expect(first.label).toBe('样例桶');
    expect(first.pathStyle).toBe(false);
    const again = draftToDirectRecord({ ...d, username: 'ROTATED', secret: 'ROTATED' });
    expect(again.id).toBe(first.id); // 凭据轮换不换 id
    expect(draftToDirectRecord(d, first).createdAt).toBe(first.createdAt);
  });

  it('WebDAV 直连记录：id = davDirectStoreId；bucket/pathStyle 不入记录面', () => {
    const rec = draftToDirectRecord({ ...d, backend: 'webdav', endpoint: 'https://dav.example.com/dav' });
    expect(rec.id).toMatch(/^davdirect:[0-9a-f]{8}$/);
    expect(rec.bucket).toBeUndefined();
    expect(rec.pathStyle).toBeUndefined();
    expect(rec.secret).toBe('SK');
  });

  it('代理记录：fingerprint 不含凭据（同目标重存幂等同 id）；serverBase 作用域', () => {
    const base = { ...d, mode: 'proxy' as const, serverBase: 'http://127.0.0.1:8321' };
    const rec = draftToProxyRecord(base);
    expect(rec.kind).toBe('proxy');
    expect(rec.serverBase).toBe('http://127.0.0.1:8321');
    expect(rec.fingerprint).toContain('s3');
    const rotated = draftToProxyRecord({ ...base, username: 'ak2', secret: 'sk2' });
    expect(rotated.id).toBe(rec.id); // 指纹不含凭据：凭据轮换同 id（幂等重存）
    expect(rotated.fingerprint).toBe(rec.fingerprint);
  });

  it('draftFromRecord 回环：direct/proxy 记录 → 草稿字段齐全（编辑预填）', () => {
    const direct: DirectMountRecord = {
      id: 's3direct:abcd1234',
      kind: 'direct',
      backend: 's3',
      label: '样例',
      endpoint: 'http://h',
      bucket: 'b',
      prefix: 'p',
      username: 'ak',
      secret: 'sk',
      pathStyle: false,
      createdAt: 1
    };
    expect(draftFromRecord(direct)).toMatchObject({
      mode: 'direct',
      backend: 's3',
      label: '样例',
      endpoint: 'http://h',
      bucket: 'b',
      prefix: 'p',
      username: 'ak',
      secret: 'sk',
      pathStyle: false
    });
    const proxy: ProxyMountRecord = {
      id: 'mount:x',
      kind: 'proxy',
      backend: 'webdav',
      label: '文献',
      endpoint: 'https://dav',
      prefix: '',
      username: 'u',
      secret: 'p',
      fingerprint: 'f',
      serverBase: 'http://srv:8321',
      createdAt: 1,
      pendingRetry: true,
      lastError: 'HTTP 500'
    };
    const pd = draftFromRecord(proxy);
    expect(pd.mode).toBe('proxy');
    expect(pd.backend).toBe('webdav');
    expect(pd.serverBase).toBe('http://srv:8321');
    expect(pd.pathStyle).toBe(true); // dav 无 pathStyle 概念：草稿缺省
  });
});

// ---------- 组①②③装配 ----------

describe('assembleServerMountRows（组①：服务端根与挂载）', () => {
  it('fs 根段 + 静态段 + 运行时段按序装配；fs 根名取 rootPaths 宣告（回落「根 N」）', () => {
    const manifest: MountsManifest = {
      fsRoots: 2,
      staticMounts: [
        {
          rootIndex: 2,
          kind: 's3',
          label: '文档桶',
          endpoint: 's3.eu.example.com',
          bucket: 'docs',
          prefix: '',
          capabilities: { watch: false, search: false }
        }
      ],
      runtimeMounts: [
        {
          rootIndex: 3,
          kind: 'webdav',
          endpoint: 'dav.example.com/dav',
          prefix: 'lib',
          capabilities: { watch: false, search: false }
        }
      ],
      mounts: []
    };
    const rows = assembleServerMountRows(manifest, ['/data/docs', '/data/books']);
    expect(rows.map((r) => [r.rootIndex, r.segment, r.title])).toEqual([
      [0, 'fs', '/data/docs'],
      [1, 'fs', '/data/books'],
      [2, 'static', '文档桶'],
      [3, 'runtime', 'webdav 挂载']
    ]);
    expect(rows[0]).toMatchObject({ segmentLabel: 'fs 根', watch: true, search: true });
    expect(rows[2]).toMatchObject({ endpoint: 's3.eu.example.com', bucket: 'docs', watch: false, search: false });
    // 运行时条目无 label：title 回落 `${kind} 挂载`（上方 toEqual 已锚 'webdav 挂载'）
  });

  it('manifest 缺失（未连接/旧服务端）返回空数组；rootPaths 长度不足回落「根 N」', () => {
    expect(assembleServerMountRows(null, [])).toEqual([]);
    const rows = assembleServerMountRows({ fsRoots: 2, staticMounts: [], runtimeMounts: [], mounts: [] }, ['/only']);
    expect(rows.map((r) => r.title)).toEqual(['/only', '根 1']);
  });
});

describe('assembleMountRows（组②：前端配置挂载状态机）', () => {
  const direct: DirectMountRecord = {
    id: 's3direct:abcd1234',
    kind: 'direct',
    backend: 's3',
    label: '直连桶',
    endpoint: 'http://127.0.0.1:9000',
    bucket: 'b',
    prefix: '',
    username: 'ak',
    secret: 'sk',
    createdAt: 1
  };
  const proxy = (over: Partial<ProxyMountRecord>): ProxyMountRecord => ({
    id: 'mount:x',
    kind: 'proxy',
    backend: 'webdav',
    label: '代理',
    endpoint: 'https://dav',
    prefix: '',
    username: 'u',
    secret: 'p',
    fingerprint: 'f',
    serverBase: 'http://srv',
    createdAt: 2,
    ...over
  });

  it('direct 行：直连徽标 + 凭据已存指示 + 展示面 endpoint', () => {
    const [row] = assembleMountRows([direct], 'http://srv');
    expect(row!.modeLabel).toBe('直连');
    expect(row!.backendLabel).toBe('S3');
    expect(row!.hasCredential).toBe(true);
    expect(row!.state).toEqual({ code: 'direct' });
  });

  it('proxy 行状态机：已注册（rootIndex）/ 待注册（pendingRetry+lastError）/ 未注册（同服务器）', () => {
    const rows = assembleMountRows(
      [
        proxy({ registeredRootIndex: 5 }),
        proxy({ id: 'mount:y', pendingRetry: true, lastError: 'HTTP 500' }),
        proxy({ id: 'mount:z' })
      ],
      'http://srv'
    );
    expect(rows[0]!.state).toEqual({ code: 'registered', rootIndex: 5 });
    expect(rows[0]!.modeLabel).toBe('代理');
    expect(rows[1]!.state).toEqual({ code: 'pending', error: 'HTTP 500' });
    expect(rows[2]!.state).toEqual({ code: 'unregistered' });
  });

  it('无凭据记录 hasCredential=false（凭据已存指示的暗态）', () => {
    const [row] = assembleMountRows([{ ...direct, secret: undefined }], 'http://srv');
    expect(row!.hasCredential).toBe(false);
  });
});

describe('assembleMountRows/proxyOffsiteOf 跨连接作用域（评审 M1：proxy serverBase 比对当前连接）', () => {
  const registered: ProxyMountRecord = {
    id: 'mount:a',
    kind: 'proxy',
    backend: 's3',
    label: 'A 机挂载',
    endpoint: 'http://s3.example.com',
    bucket: 'b',
    prefix: '',
    username: 'ak',
    secret: 'sk',
    fingerprint: 'fa',
    serverBase: 'http://a:8321',
    createdAt: 1,
    registeredRootIndex: 5
  };

  it('同服务器（matched）：registered 徽标保持、offsite 判定 false——行为不变', () => {
    expect(assembleMountRows([registered], 'http://a:8321')[0]!.state).toEqual({
      code: 'registered',
      rootIndex: 5
    });
    expect(proxyOffsiteOf(registered, 'http://a:8321')).toBe(false);
  });

  it('他机注册（offsite）：registered 徽标改「注册于他机」、offsite 判定 true（打开/删除/重注册的拦截依据）', () => {
    const rows = assembleMountRows([registered], 'http://b:8321');
    expect(rows[0]!.state).toEqual({ code: 'offsite', rootIndex: 5 });
    expect(proxyOffsiteOf(registered, 'http://b:8321')).toBe(true);
  });

  it('未连接（currentBase null）：已注册项一律视为 offsite（无安全服务端操作面）', () => {
    expect(assembleMountRows([registered], null)[0]!.state).toEqual({ code: 'offsite', rootIndex: 5 });
    expect(proxyOffsiteOf(registered, null)).toBe(true);
  });

  it('pending/unregistered 状态不受作用域影响（记录自身事实，非跨连接误导面）；direct 不受 currentBase 影响', () => {
    const pending = { ...registered, registeredRootIndex: undefined, pendingRetry: true, lastError: 'HTTP 500' };
    expect(assembleMountRows([pending], 'http://b:8321')[0]!.state).toEqual({
      code: 'pending',
      error: 'HTTP 500'
    });
    expect(assembleMountRows([pending], null)[0]!.state).toEqual({ code: 'pending', error: 'HTTP 500' });
    expect(assembleMountRows([{ ...pending, pendingRetry: undefined, lastError: undefined }], 'http://b:8321')[0]!.state).toEqual({
      code: 'unregistered'
    });
  });
});

describe('assembleLocalRows（组③：本机授权来源）', () => {
  const sources: WorkspaceSource[] = [
    { kind: 'localfiles', storeId: 'localfiles:photos', storeLabel: 'photos' },
    { kind: 'remote', storeId: 'remote:abc', storeLabel: 'srv' }
  ];

  it('localfs 句柄行：名称+授权态；授权态文案分已授权/需重授权', () => {
    const rows = assembleLocalRows({ name: 'docs' }, 'granted', sources);
    expect(rows[0]).toMatchObject({ kind: 'localfs', title: 'docs', permission: 'granted' });
    expect(rows[0]!.detail).toContain('已授权');
    const stale = assembleLocalRows({ name: 'docs' }, 'prompt', sources);
    expect(stale[0]!.permission).toBe('prompt');
    expect(stale[0]!.detail).toContain('重新授权');
  });

  it('localfiles 会话来源行（remote 等他类不入组③）；句柄缺省仅列会话来源', () => {
    const rows = assembleLocalRows(null, null, sources);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: 'localfiles', title: 'photos', permission: null });
    expect(rows[0]!.detail).toContain('会话');
  });
});

// ---------- 测试连接（S3 ListObjectsV2 / WebDAV PROPFIND 探测） ----------

describe('probeDraft/probeRecord/formatProbeResult（测试连接状态回显）', () => {
  const s3Draft: MountFormDraft = {
    ...emptyDraft(),
    label: '桶',
    endpoint: 'http://127.0.0.1:9000',
    bucket: 'bkt',
    prefix: 'docs',
    username: 'AK',
    secret: 'SK'
  };

  it('S3 探测：ListObjectsV2 回显条目数与延迟（≥0）', async () => {
    if (!globalThis.crypto?.subtle) vi.stubGlobal('crypto', webcrypto);
    stubFetch((_m, url) => (url.includes('list-type=2') ? xmlRes(S3_LIST_XML, 200) : undefined));
    const r = await probeDraft(s3Draft);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.entries).toBe(3); // 2 文件 + 1 目录
      expect(r.ms).toBeGreaterThanOrEqual(0);
    }
    expect(formatProbeResult(r)).toMatch(/连接成功：根目录 3 个条目，延迟 \d+ ms/);
  });

  it('WebDAV 探测：PROPFIND 回显条目数（方法断言在桩内）', async () => {
    let sawPropfind = false;
    stubFetch((m, url) => {
      if (m === 'PROPFIND' && url === 'https://dav.example.com/dav/') {
        sawPropfind = true;
        return xmlRes(PROPFIND_XML, 207);
      }
      return undefined;
    });
    const r = await probeDraft({ ...s3Draft, backend: 'webdav', endpoint: 'https://dav.example.com/dav', bucket: '', prefix: '' });
    expect(sawPropfind).toBe(true);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.entries).toBe(2); // 1 目录 + 1 文件（自身条目跳过）
  });

  it('S3 网络层失败：CORS 特征化文案回显（测试连接错误态）', async () => {
    if (!globalThis.crypto?.subtle) vi.stubGlobal('crypto', webcrypto);
    stubFetch(() => {
      throw new TypeError('Failed to fetch');
    });
    const r = await probeDraft(s3Draft);
    expect(r).toEqual({ ok: false, error: 'S3 直连失败：bucket CORS 未配置或网络不可达' });
    expect(formatProbeResult(r)).toBe('连接失败：S3 直连失败：bucket CORS 未配置或网络不可达');
  });

  it('WebDAV 网络层失败：CORS 提示文案回显', async () => {
    stubFetch(() => {
      throw new TypeError('Failed to fetch');
    });
    const r = await probeDraft({ ...s3Draft, backend: 'webdav', endpoint: 'https://dav.example.com' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('服务器 CORS 未配置或网络不可达');
  });

  it('http 部署 crypto.subtle 缺失：WebCrypto 错误回显（Task 1 疑虑①——错误态覆盖）', async () => {
    vi.stubGlobal('crypto', {} as typeof crypto); // 非 https 且非 localhost 的浏览器形态
    const r = await probeDraft(s3Draft);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('WebCrypto 不可用');
  });

  it('probeRecord：已存记录走同一探测面（directConfigOf 映射）', async () => {
    if (!globalThis.crypto?.subtle) vi.stubGlobal('crypto', webcrypto);
    stubFetch((_m, url) => (url.includes('list-type=2') ? xmlRes(S3_LIST_XML, 200) : undefined));
    const rec = draftToDirectRecord(s3Draft);
    const r = await probeRecord(rec);
    expect(r.ok).toBe(true);
  });
});

// ---------- 警示文案与删除联动 ----------

describe('固定警示文案（spec §6：新增表单与列表详情双处出现——组件源码契约在 Ui 测试锁双处）', () => {
  it('凭据警示与 WebDAV CORS 提示为模块常量（单一出处）', () => {
    expect(CREDENTIAL_WARNING).toContain('明文');
    expect(CREDENTIAL_WARNING).toContain('同源脚本');
    expect(CREDENTIAL_WARNING).toContain('本机用户');
    expect(WEBDAV_CORS_HINT).toContain('CORS');
  });
});

describe('mountUsageOf（删除确认的引用面提示）', () => {
  it('统计引用该 storeId 的工作区数', () => {
    const ws = [
      { sources: [{ kind: 'direct', storeId: 's3direct:a', storeLabel: 'x' } as WorkspaceSource] },
      { sources: [] },
      { sources: [{ kind: 'direct', storeId: 's3direct:a', storeLabel: 'x' } as WorkspaceSource] },
      { sources: [{ kind: 'remote', storeId: 'remote:z', storeLabel: 'y' } as WorkspaceSource] }
    ];
    expect(mountUsageOf('s3direct:a', ws).sources).toBe(2);
    expect(mountUsageOf('remote:z', ws).sources).toBe(1);
    expect(mountUsageOf('s3direct:none', ws).sources).toBe(0);
  });
});
