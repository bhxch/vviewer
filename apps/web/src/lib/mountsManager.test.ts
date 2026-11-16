// mountsManager.test.ts — 目录管理页纯逻辑（目录挂载 spec §5 阶段四，plan Task 2）。
// MountsManager.svelte 的可测面收编本文件：表单校验（必填镜像 server build_mount
// per-kind 必填 + endpoint userinfo 拒绝——评审 L1）、草稿↔记录构造（id 闭环）、
// 三组数据装配（服务端根与挂载/前端配置挂载/本机授权来源）、测试连接探测（S3
// ListObjectsV2 / WebDAV PROPFIND 条目数+延迟回显；CORS 特征化与 WebCrypto 缺失
// 错误回显——Task 1 疑虑①）。组件骨架/接线为源码契约断言（mountsManagerUi.test.ts）。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { webcrypto } from 'node:crypto';
import {
  assembleGitCredentialRows,
  assembleLocalRows,
  assembleMountRows,
  assembleServerMountRows,
  credentialWarning,
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
  webdavCorsHint,
  type MountFormDraft
} from './mountsManager';
// i18n 目录（Task 8 域 E）：zh 值逐字节双锁（S5——运行时值断言保留 + 目录锁）
import { messages as zhMounts } from './i18n/catalogs/zh-CN/mounts';
// 注入缝访问函数（评审 I-1 测试锁）：本文件 import 链经 mountsSync 顶层注入目录
// getter，core 访问函数在测试进程内恒返回 zh 目录值——锁直连错误文案的 zh 渲染形态
import {
  githubDirectStoreId,
  gitlabDirectStoreId,
  httpFailedText,
  davHttpFailedText
} from '@bhxch/vviewer-core';
import {
  resetMountRecordCacheForTests,
  saveMount,
  type DirectMountRecord,
  type GitCredentialRecord,
  type MountsManifest,
  type ProxyMountRecord
} from './mountsSync';
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
    serverBase: '',
    owner: '',
    repo: '',
    ref: ''
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
  it('凭据警示与 WebDAV CORS 提示为目录值函数（单一出处；Task 8 常量改函数——装载时刻取值钉死 locale）', () => {
    expect(credentialWarning()).toContain('明文');
    expect(credentialWarning()).toContain('同源脚本');
    expect(credentialWarning()).toContain('本机用户');
    expect(webdavCorsHint()).toContain('CORS');
  });
});

// —— Task 8 S5 目录双锁（域 E）：运行时 zh 值断言全部保留在上方用例（vitest 缺省
// locale=zh-CN，translate 取目录 zh 值=原字面量逐字节），此处补目录键字节锁——
// 键值漂移与运行时断言脱钩即红。 ——
describe('mounts 域目录字节锁（Task 8 S5 双锁）', () => {
  it('表单校验/警示/探测回显/装配文案与目录 zh 值逐字节等价', () => {
    expect(zhMounts['mounts.form.endpointUserinfo']).toBe('请使用不含凭据的 endpoint，凭据在下方字段填写');
    expect(zhMounts['mounts.form.required']).toBe('必填');
    expect(zhMounts['mounts.form.serverBaseRequired']).toBe('代理挂载需先连接服务器');
    expect(zhMounts['mounts.warn.credential']).toBe(credentialWarning());
    expect(zhMounts['mounts.warn.webdavCors']).toBe(webdavCorsHint());
    expect(zhMounts['mounts.probe.ok']).toBe('连接成功：根目录 {entries} 个条目，延迟 {ms} ms');
    expect(zhMounts['mounts.probe.fail']).toBe('连接失败：{error}');
    expect(zhMounts['mounts.segment.fs']).toBe('fs 根');
    expect(zhMounts['mounts.segment.static']).toBe('静态挂载');
    expect(zhMounts['mounts.segment.runtime']).toBe('运行时');
    expect(zhMounts['mounts.title.fsRoot']).toBe('根 {n}');
    expect(zhMounts['mounts.title.mount']).toBe('{kind} 挂载');
    expect(zhMounts['mounts.mode.direct']).toBe('直连');
    expect(zhMounts['mounts.mode.proxy']).toBe('代理');
    expect(zhMounts['mounts.local.granted']).toBe('已授权（会话恢复可用）');
    expect(zhMounts['mounts.local.needsReauth']).toBe('需重新授权（刷新后恢复将弹出权限提示）');
    expect(zhMounts['mounts.local.sessionDetail']).toBe('会话来源（文件内容不持久，刷新后需重新打开）');
  });

  it('直连 HTTP 非 2xx 文案注入链 zh 渲染逐字节锁（评审 I-1：S3 无空格/DAV 词间含空格——独立缝两侧逐字节）', () => {
    // S3 面：ensureOk label='S3'，zh 模板无词间空格（与基线 `S3请求失败` 逐字节）
    expect(httpFailedText('S3', 403, '')).toBe('S3请求失败: HTTP 403');
    expect(httpFailedText('S3', 404, ' <Error><Code>NoSuchKey</Code></Error>')).toBe(
      'S3请求失败: HTTP 404 <Error><Code>NoSuchKey</Code></Error>'
    );
    // DAV 面：独立键带词间空格（与基线 `WebDAV 请求失败` 逐字节——评审 I-1 修复锁，
    // 原 {label} 共用模板渲染「WebDAV请求失败」丢空格为违约束形态）
    expect(davHttpFailedText(401, '（认证失败：检查用户名/密码）')).toBe(
      'WebDAV 请求失败: HTTP 401（认证失败：检查用户名/密码）'
    );
    expect(davHttpFailedText(404, ' <error/>')).toBe('WebDAV 请求失败: HTTP 404 <error/>');
    // 目录键面双锁（占位符形态 + core 缺省英文注释见 directS3.ts 缝注）
    expect(zhMounts['mounts.err.httpFailed']).toBe('{label}请求失败: HTTP {status}{detail}');
    expect(zhMounts['mounts.err.davHttpFailed']).toBe('WebDAV 请求失败: HTTP {status}{detail}');
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

// ---------- git 探测分派（spec I Task 2 评审 ① 前移收编：probeWith 四联合 +
// git 支路转 core probe 函数——sha/truncated 回显） ----------

describe('probeWith git 分派（spec I：probeRecord github/gitlab 记录 → probeGithubDirect/probeGitlabDirect）', () => {
  const GH_SHA = 'a'.repeat(40);
  const GL_COMMIT = 'e'.repeat(40);

  /** github 直连记录（directConfigOf git 分支映射面——Task 2 mountsSync 已扩）。 */
  function ghRec(): DirectMountRecord {
    return {
      id: 'githubdirect:abcd1234',
      kind: 'direct',
      backend: 'github',
      label: '示例仓',
      endpoint: 'https://github.com/octo/repo',
      prefix: '',
      owner: 'octo',
      repo: 'repo',
      ref: 'main',
      createdAt: 1
    };
  }

  function glRec(): DirectMountRecord {
    return {
      id: 'gitlabdirect:abcd1234',
      kind: 'direct',
      backend: 'gitlab',
      label: '示例项目',
      endpoint: 'https://gitlab.example.com',
      prefix: '',
      host: 'https://gitlab.example.com',
      repo: 'grp/rp',
      ref: 'main',
      createdAt: 1
    };
  }

  function jsonRes(body: unknown, status = 200, headers: Record<string, string> = {}): unknown {
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
      text: async () => JSON.stringify(body),
      arrayBuffer: async () => new TextEncoder().encode(JSON.stringify(body)).buffer as ArrayBuffer,
      headers: { get: (name: string) => (headers[name.toLowerCase()] ?? null) }
    };
  }

  it('github 记录探测：probeGithubDirect 域内 fetch——sha/truncated 回显（Errata ⑩ 采样语义）', async () => {
    const urls: string[] = [];
    stubFetch((_m, url) => {
      urls.push(url);
      if (url === 'https://api.github.com/repos/octo/repo/commits/main') {
        return jsonRes({ sha: GH_SHA });
      }
      if (url === `https://api.github.com/repos/octo/repo/git/trees/${GH_SHA}?recursive=1`) {
        return jsonRes({
          sha: GH_SHA,
          truncated: true,
          tree: [
            { path: 'a.md', type: 'blob', size: 1, sha: 'b1' },
            { path: 'b.md', type: 'blob', size: 2, sha: 'b2' },
            { path: 'c', type: 'tree', sha: 't1' }
          ]
        });
      }
      return undefined; // BFS 若发生即未模拟异常显式暴露（Errata ⑩：probe 不 BFS）
    });
    const r = await probeRecord(ghRec());
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.entries).toBe(2); // 首响应 blob 部分计数
      expect(r.sha).toBe(GH_SHA);
      expect(r.truncated).toBe(true);
      expect(r.ms).toBeGreaterThanOrEqual(0);
    }
    expect(urls.some((u) => u.includes('/commits/main'))).toBe(true);
    expect(urls.filter((u) => u.includes('/git/trees/')).length).toBe(1); // 恰止于 recursive 单响应
    // 回显文案（formatProbeResult git 分支：okGit + truncated 注记）
    expect(formatProbeResult(r)).toBe(
      `连接成功：2 个文件，ref aaaaaaaa，延迟 ${r.ok ? r.ms : 0} ms（清单已截断，以上为部分计数）`
    );
  });

  it('gitlab 记录探测：probeGitlabDirect 域内 fetch——项目解析 + commits + tree 首页（恰 1 页）', async () => {
    const urls: string[] = [];
    stubFetch((_m, url) => {
      urls.push(url);
      if (url === 'https://gitlab.example.com/api/v4/projects/grp%2Frp') return jsonRes({ id: 42 });
      if (url === 'https://gitlab.example.com/api/v4/projects/42/repository/commits/main') {
        return jsonRes({ id: GL_COMMIT });
      }
      if (url === 'https://gitlab.example.com/api/v4/projects/42/repository/tree?ref=main&recursive=true&per_page=100') {
        return jsonRes(
          Array.from({ length: 3 }, (_, i) => ({ id: `g${i}`, name: `f${i}.txt`, type: 'blob', path: `f${i}.txt` })),
          200,
          { link: '<https://gitlab.example.com/api/v4/projects/42/repository/tree?page=2>; rel="next"' }
        );
      }
      return undefined; // Link 在场也不翻页（spec §3.3 首页采样——page=2 未模拟即暴露）
    });
    const r = await probeRecord(glRec());
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.entries).toBe(3);
      expect(r.sha).toBe(GL_COMMIT);
      expect(r.truncated).toBeUndefined(); // GitLab 无上游截断标记
    }
    expect(urls.filter((u) => u.includes('/repository/tree')).length).toBe(1);
    expect(formatProbeResult(r)).toBe(`连接成功：3 个文件，ref eeeeeeee，延迟 ${r.ok ? r.ms : 0} ms`);
  });

  it('formatProbeResult git 分支：非 git 记录（无 sha）既有 ok 文案逐字节不变（s3/dav 兼容锚）', () => {
    expect(formatProbeResult({ ok: true, entries: 3, ms: 12 })).toBe(
      '连接成功：根目录 3 个条目，延迟 12 ms'
    );
    expect(formatProbeResult({ ok: false, error: 'boom' })).toBe('连接失败：boom');
  });
});

// ---------- git 表单与凭据库装配（spec I Task 3：git 两类表单 + 组④ Git 凭据区块） ----------

describe('git 表单与凭据库（spec I Task 3）', () => {
  /** github 表单草稿（MountFormDraft git 字段 Task 3 落——RED 期 as 断言构造）。 */
  function ghDraftOf(overrides: Partial<MountFormDraft> = {}): MountFormDraft {
    return {
      ...emptyDraft(),
      backend: 'github',
      label: '示例仓',
      owner: 'octo',
      repo: 'repo',
      ref: 'main',
      prefix: '',
      secret: '',
      ...overrides
    } as MountFormDraft;
  }

  function glDraftOf(overrides: Partial<MountFormDraft> = {}): MountFormDraft {
    return {
      ...emptyDraft(),
      backend: 'gitlab',
      label: '示例项目',
      endpoint: 'https://gitlab.example.com',
      repo: 'grp/rp',
      ref: 'main',
      prefix: '',
      secret: '',
      ...overrides
    } as MountFormDraft;
  }

  function credOf(overrides: Partial<GitCredentialRecord> = {}): GitCredentialRecord {
    return {
      id: 'gitcred:github.com:octo',
      kind: 'gitcred',
      host: 'github.com',
      owner: 'octo',
      token: 'T1',
      createdAt: 1,
      ...overrides
    };
  }

  beforeEach(() => {
    // credentialKey 解析走 recordCache 镜像——saveMount(gitcred) 漏斗建库（mountsSync.test 先例）
    vi.stubGlobal('indexedDB', new IDBFactory());
    resetMountRecordCacheForTests();
  });

  afterEach(() => {
    resetMountRecordCacheForTests();
    vi.unstubAllGlobals();
  });

  // ---- 必填矩阵（per-backend 分派）----

  it('github 必填矩阵：label/owner/repo/ref 四必填；username/secret 不校验（PAT 可空——凭据库匹配）；全填零错误', () => {
    expect(mountFormIssues({ ...ghDraftOf(), owner: '', repo: '', ref: '' })).toEqual({
      owner: '必填',
      repo: '必填',
      ref: '必填'
    });
    expect(mountFormIssues({ ...ghDraftOf(), label: '' })).toMatchObject({ label: '必填' });
    const full = mountFormIssues(ghDraftOf());
    expect(full.username).toBeUndefined();
    expect(full.secret).toBeUndefined();
    expect(full).toEqual({});
  });

  it('gitlab 必填矩阵：label/endpoint(host)/repo(项目)/ref 四必填 + endpoint userinfo 拒绝照走；全填零错误', () => {
    expect(mountFormIssues({ ...glDraftOf(), endpoint: '', repo: '', ref: '' })).toEqual({
      endpoint: '必填',
      repo: '必填',
      ref: '必填'
    });
    expect(mountFormIssues({ ...glDraftOf(), endpoint: 'https://u:p@gitlab.example.com' }).endpoint).toBe(
      '请使用不含凭据的 endpoint，凭据在下方字段填写'
    );
    expect(mountFormIssues(glDraftOf())).toEqual({});
  });

  it('proxy 模式 + git backend → mode issue（git 无代理面——仅支持浏览器直连）', () => {
    expect(mountFormIssues({ ...ghDraftOf(), mode: 'proxy', serverBase: 'http://srv:8321' }).mode).toBe(
      'GitHub/GitLab 挂载仅支持浏览器直连'
    );
    expect(mountFormIssues({ ...glDraftOf(), mode: 'proxy', serverBase: 'http://srv:8321' }).mode).toBe(
      'GitHub/GitLab 挂载仅支持浏览器直连'
    );
  });

  it('s3/webdav 分支逐字节不变（兼容锚——既有用例零改动通过的镜像断言）', () => {
    const s3 = { ...emptyDraft(), label: 'x', endpoint: 'http://h', bucket: 'b', username: 'ak', secret: 'sk' };
    expect(mountFormIssues(s3)).toEqual({});
    expect(mountFormIssues({ ...s3, bucket: '' }).bucket).toBe('必填');
  });

  // ---- draftToDirectRecord git 两分支 ----

  it('github 显式 token：id=githubDirectStoreId 字面闭环 + endpoint 展示面派生（Errata ⑦）+ secret 直存不建库条目', async () => {
    const d = ghDraftOf({ prefix: 'docs', secret: 'T1' });
    const rec = draftToDirectRecord(d);
    expect(rec.id).toBe(githubDirectStoreId({ owner: 'octo', repo: 'repo', ref: 'main', prefix: 'docs' }));
    expect(rec).toMatchObject({
      kind: 'direct',
      backend: 'github',
      label: '示例仓',
      endpoint: 'https://github.com/octo/repo',
      prefix: 'docs',
      secret: 'T1'
    });
    expect(rec.credentialKey).toBeUndefined();
    expect(rec.username).toBeUndefined();
    // 编辑不改入库序（createdAt 沿用既有记录）
    expect(draftToDirectRecord(d, { ...rec, createdAt: 42 }).createdAt).toBe(42);
  });

  it('credentialKey 精确命中存储：token 留空 + 库条目精确 owner → rec.credentialKey=键、无 secret；显式 token 不写 key', async () => {
    await saveMount(credOf());
    const rec = draftToDirectRecord(ghDraftOf()); // token 留空
    expect(rec.credentialKey).toBe('github.com:octo');
    expect(rec.secret).toBeUndefined();
    // 显式 token 优先——不建库引用
    const rec2 = draftToDirectRecord(ghDraftOf({ secret: 'TX' }));
    expect(rec2.credentialKey).toBeUndefined();
    expect(rec2.secret).toBe('TX');
  });

  it('credentialKey 通配命中：库条目 owner=* → 精确未命中时回落通配键；库空 = 匿名双缺省（credentialKey/secret 都不入记录）', async () => {
    await saveMount(credOf({ id: 'gitcred:github.com:*', owner: '*', token: 'TW' }));
    const rec = draftToDirectRecord(ghDraftOf({ owner: 'other', repo: 'repo2' })); // 精确未命中
    expect(rec.credentialKey).toBe('github.com:*');
    expect(rec.secret).toBeUndefined();
    // 库空（条目已删）：匿名双缺省
    resetMountRecordCacheForTests();
    const recClean = draftToDirectRecord(ghDraftOf({ owner: 'other', repo: 'repo2' }));
    expect(recClean.credentialKey).toBeUndefined();
    expect(recClean.secret).toBeUndefined();
  });

  it('gitlab：host 原文参与 storeId 且记录不预归一（Errata ⑨——尾斜杠/无 scheme 原文进 endpoint/host 两字段，id 闭环由 core 归一单源保证）+ namespace 剥末段命中凭据库', async () => {
    const rawHost = 'gitlab.example.com/'; // 无 scheme + 尾斜杠原文
    const d = glDraftOf({ endpoint: rawHost, secret: 'TG' });
    const rec = draftToDirectRecord(d);
    expect(rec.id).toBe(gitlabDirectStoreId({ host: rawHost, project: 'grp/rp', ref: 'main', prefix: '' }));
    expect(rec.endpoint).toBe(rawHost); // 原文逐字（不剥尾斜杠、不补 scheme——Errata ⑦ host 原值）
    expect(rec.host).toBe(rawHost);
    expect(rec.repo).toBe('grp/rp');
    expect(rec.ref).toBe('main');
    expect(rec.secret).toBe('TG');
    // namespace 剥末段：grp/rp → grp（凭据库精确命中存键——host 形态一致时）
    await saveMount(
      credOf({ id: 'gitcred:https://gitlab.example.com:grp', host: 'https://gitlab.example.com', owner: 'grp' })
    );
    const recKey = draftToDirectRecord(glDraftOf({ endpoint: 'https://gitlab.example.com', secret: '' }));
    expect(recKey.credentialKey).toBe('https://gitlab.example.com:grp');
    expect(recKey.host).toBe('https://gitlab.example.com'); // 原文（本次输入无尾斜杠）
    // host 形态不一致（条目无 scheme / 表单带 scheme）→ miss → 匿名双缺省
    //（Task 2 口径：匹配面不预归一——Errata ⑨ 归一单源钉 storeId/工厂 hash 输入）
    resetMountRecordCacheForTests();
    await saveMount(
      credOf({ id: 'gitcred:gitlab.example.com:grp', host: 'gitlab.example.com', owner: 'grp' })
    );
    const recMiss = draftToDirectRecord(glDraftOf({ endpoint: 'https://gitlab.example.com', secret: '' }));
    expect(recMiss.credentialKey).toBeUndefined();
    expect(recMiss.secret).toBeUndefined();
  });

  // ---- draftFromRecord git 回环 ----

  it('draftFromRecord github/gitlab 回环预填：git 字段回填 + secret 明文回填（管理页即凭据管理面）+ s3/dav 回环零变化（兼容锚）', () => {
    const ghRec: DirectMountRecord = {
      id: 'githubdirect:abcd1234',
      kind: 'direct',
      backend: 'github',
      label: '示例仓',
      endpoint: 'https://github.com/octo/repo',
      prefix: 'docs',
      owner: 'octo',
      repo: 'repo',
      ref: 'main',
      secret: 'T1',
      createdAt: 1
    };
    expect(draftFromRecord(ghRec)).toMatchObject({
      mode: 'direct',
      backend: 'github',
      label: '示例仓',
      endpoint: 'https://github.com/octo/repo',
      prefix: 'docs',
      owner: 'octo',
      repo: 'repo',
      ref: 'main',
      secret: 'T1'
    });
    const glRec: DirectMountRecord = {
      id: 'gitlabdirect:abcd1234',
      kind: 'direct',
      backend: 'gitlab',
      label: '示例项目',
      endpoint: 'gitlab.example.com/',
      prefix: '',
      host: 'gitlab.example.com/',
      repo: 'grp/rp',
      ref: 'main',
      credentialKey: 'gitlab.example.com:grp',
      createdAt: 1
    };
    expect(draftFromRecord(glRec)).toMatchObject({
      mode: 'direct',
      backend: 'gitlab',
      endpoint: 'gitlab.example.com/', // host 原文回环（不预归一）
      repo: 'grp/rp',
      ref: 'main',
      secret: '' // credentialKey 引用形态：secret 不回填（token 留空=库匹配语义维持）
    });
    const s3Rec: DirectMountRecord = {
      id: 's3direct:abcd1234',
      kind: 'direct',
      backend: 's3',
      label: '桶',
      endpoint: 'http://127.0.0.1:9000',
      bucket: 'b1',
      prefix: '',
      username: 'ak',
      secret: 'sk',
      pathStyle: true,
      createdAt: 1
    };
    expect(draftFromRecord(s3Rec)).toMatchObject({ backend: 's3', bucket: 'b1', username: 'ak', secret: 'sk' });
  });

  // ---- assembleMountRows（gitcred 过滤/徽标/hasCredential git 形态）----

  it('assembleMountRows：gitcred 过滤（Review Focus 2）+ GitHub/GitLab 徽标 + hasCredential git 两形态（secret 或 credentialKey 在场）', () => {
    const ghRec: DirectMountRecord = {
      id: 'githubdirect:abcd1234',
      kind: 'direct',
      backend: 'github',
      label: '示例仓',
      endpoint: 'https://github.com/octo/repo',
      prefix: '',
      owner: 'octo',
      repo: 'repo',
      ref: 'main',
      createdAt: 1
    };
    const glRec: DirectMountRecord = {
      id: 'gitlabdirect:abcd1234',
      kind: 'direct',
      backend: 'gitlab',
      label: '示例项目',
      endpoint: 'gitlab.example.com',
      prefix: '',
      host: 'gitlab.example.com',
      repo: 'grp/rp',
      ref: 'main',
      credentialKey: 'gitlab.example.com:grp',
      createdAt: 2
    };
    const rows = assembleMountRows([ghRec, glRec, credOf()], null);
    expect(rows).toHaveLength(2); // gitcred 过滤
    expect(rows[0]).toMatchObject({ backendLabel: 'GitHub', hasCredential: false });
    expect(rows[0]!.record.kind).toBe('direct');
    expect(rows[1]).toMatchObject({ backendLabel: 'GitLab', hasCredential: true }); // credentialKey 在场=有凭据
    expect(assembleMountRows([{ ...ghRec, secret: 'TX' }], null)[0]).toMatchObject({ hasCredential: true }); // secret 形态
  });

  // ---- assembleGitCredentialRows（组④装配）----

  it('assembleGitCredentialRows：行形态（key=记录 id/host/owner/wildcard/note）+ createdAt 升序 + 空库空行；重提同键覆盖=更新（saveMount put 语义漏斗）', async () => {
    expect(assembleGitCredentialRows([])).toEqual([]);
    await saveMount(credOf({ note: 'first' }));
    await saveMount(
      credOf({ id: 'gitcred:github.com:*', host: 'github.com', owner: '*', createdAt: 0, note: 'wild' })
    );
    await saveMount(
      credOf({ id: 'gitcred:gitlab.example.com:grp', host: 'gitlab.example.com', owner: 'grp', createdAt: 2 })
    );
    const rows = assembleGitCredentialRows(await listMountsForRows());
    expect(rows.map((r) => r.key)).toEqual([
      'gitcred:github.com:*',
      'gitcred:github.com:octo',
      'gitcred:gitlab.example.com:grp'
    ]); // createdAt 升序（0/1/2）
    expect(rows[0]).toMatchObject({ host: 'github.com', owner: '*', wildcard: true, note: 'wild' });
    expect(rows[1]).toMatchObject({ host: 'github.com', owner: 'octo', wildcard: false, note: 'first' });
    expect(rows[2]).toMatchObject({ host: 'gitlab.example.com', owner: 'grp', wildcard: false });
    expect(rows[2]!.note).toBeUndefined();
    // 重提同键覆盖=更新（saveMount put(rec, rec.id) 键覆盖——note 刷新可见，行数不增）
    await saveMount(credOf({ note: 'rotated' }));
    const after = assembleGitCredentialRows(await listMountsForRows());
    expect(after).toHaveLength(3);
    expect(after.find((r) => r.key === 'gitcred:github.com:octo')?.note).toBe('rotated');
  });
});

/** 组④装配的输入=全量混存记录（listMounts）——测试 helper 免类型导入噪声。 */
async function listMountsForRows(): Promise<import('./mountsSync').MountRecord[]> {
  const { listMounts } = await import('./mountsSync');
  return listMounts();
}
