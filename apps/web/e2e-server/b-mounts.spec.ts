import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import { join, resolve } from 'node:path';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect } from '@playwright/test';
import { assertPortFree, stopServer, waitHealthy } from '../e2e/serverHarness';

/**
 * 运行时挂载三 API e2e（目录挂载阶段二 spec §3，plan Task 3；编号 MTS-*）。
 * 与 Cargo 集成测试（server/tests/mounts_api.rs，MockTransport）分工：
 * - 读路径（挂载根 tree/file 走 mock 上游）已由 MockTransport 集成测试全量覆盖；
 *   真实 reqwest 打不可达上游的链路在 MTS-03 以「上游拒绝 → 500 而非 400 越界」
 *   锚定接线即可路由（127.0.0.1:9 discard 端口即时 ECONNREFUSED，无外网依赖）。
 * - 本文件锚 API 面（真实 release 二进制 + 真实 HTTP 栈）：Bearer 门、TOML 静态
 *   挂载装配与清单分段、userinfo 展示面剥除、凭据不回显、注册幂等、64KB body
 *   限值（DefaultBodyLimit 穿真实 hyper 栈）、DELETE 矩阵、IDB v3→v4 真迁移。
 * - 前端对账（syncMountsOnConnect）语义由前端单测（mountsSync.test.ts，fake-indexeddb
 *   + fetch 桩）覆盖，不在此重复（plan Step 1 口径裁决，记录任务报告）。
 *
 * 实例拓扑（b-wsx-root-channel 同款 beforeAll 辅助实例模式；套件单 worker 串行）：
 * - 主实例 :4174（playwright.server.config.ts webServer，无 token）：仅承载
 *   MTS-IDB 的浏览器页面（IDB 迁移是纯浏览器面，与 server 无关）；
 * - 辅助实例 :4401：--config TOML（fs 根 + token + 静态 S3 挂载指向不可达
 *   endpoint 且带 userinfo 误配置形态），承载全部 API 面断言。端口与既有
 *   4173/4174/4178-4180/4375-4377/4383/4384/4395/4396-4399/4857/8030/8399/8449 错开。
 */

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const BIN = join(repoRoot, 'server/target/release/vviewer');
const BASE = 'http://127.0.0.1:4174';

const PORT_AUX = 4401;
const AUX = `http://127.0.0.1:${PORT_AUX}`;
/** TOML token（有 token 部署形态——Bearer 门的真实二进制验证面）。 */
const TOKEN = 'vv-mounts-e2e-token';
/** 静态挂载凭据特征值（泄漏断言用）。 */
const STATIC_SECRET = 'static-sk-e2e-value';
const STATIC_AK = 'static-ak-e2e-value';

let auxServer: ChildProcess | null = null;
let auxDir = '';

test.beforeAll(async () => {
  await assertPortFree(`${AUX}/api/health`);
  auxDir = mkdtempSync(join(os.tmpdir(), 'vv-mounts-'));
  // TOML 全参面（config.rs FileConfig）：token 部署 + 静态挂载。endpoint 携带
  // userinfo（误配置形态）——展示面剥除与凭据不回显的真实装配验证；127.0.0.1:9
  // （discard）不可达且拒绝即时，无启动探针（静态装配不做 IO）
  writeFileSync(
    join(auxDir, 'vviewer.toml'),
    `root = ["${auxDir}"]
port = ${PORT_AUX}
token = "${TOKEN}"

[[mount]]
kind = "s3"
label = "static-docs"
endpoint = "http://user:${STATIC_SECRET}@127.0.0.1:9"
bucket = "static-bucket"
prefix = "static"
access_key_id = "${STATIC_AK}"
secret_access_key = "${STATIC_SECRET}"
path_style = true
`
  );
  auxServer = spawn(BIN, ['serve', '--config', join(auxDir, 'vviewer.toml')], {
    stdio: ['ignore', 'inherit', 'inherit']
  });
  await waitHealthy(AUX);
});

test.afterAll(async () => {
  await stopServer(auxServer, 'vv-mounts-aux');
  if (auxDir !== '') rmSync(auxDir, { recursive: true, force: true });
});

// ---------- 请求助手 ----------

interface Outcome {
  status: number;
  text: string;
  json: unknown;
  headers: Headers;
}

/** 三 API 统一通道：Bearer 按需注入；JSON body 按需序列化。 */
async function call(
  method: 'GET' | 'POST' | 'DELETE',
  path: string,
  opts: { bearer?: string | null; body?: unknown; contentType?: boolean } = {}
): Promise<Outcome> {
  const headers: Record<string, string> = {};
  if (opts.bearer) headers.authorization = `Bearer ${opts.bearer}`;
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(`${AUX}${path}`, {
    method,
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body)
  });
  const text = await res.text();
  let json: unknown = null;
  try {
    json = JSON.parse(text);
  } catch {
    // 非 JSON（tower 层 413 纯文本等）：原样
  }
  return { status: res.status, text, json, headers: res.headers };
}

function errorOf(o: Outcome): string {
  const v = o.json as { error?: unknown } | null;
  return typeof v?.error === 'string' ? v.error : '';
}

interface MountEntry {
  rootIndex: number;
  kind: string;
  label?: string;
  endpoint: string;
  bucket?: string;
  prefix: string;
  capabilities: { watch: boolean; search: boolean };
}

interface Manifest {
  fsRoots: number;
  staticMounts: MountEntry[];
  runtimeMounts: MountEntry[];
  mounts: MountEntry[];
}

function manifestOf(o: Outcome): Manifest {
  return o.json as Manifest;
}

/** 运行时 WebDAV 注册体（userinfo 误配置形态；127.0.0.1:9 即时拒绝）。 */
const RUNTIME_SECRET = 'runtime-pass-e2e-value';

function webdavBody(label = 'e2e-dav'): Record<string, unknown> {
  return {
    kind: 'webdav',
    label,
    endpoint: `http://e2e-user:${RUNTIME_SECRET}@127.0.0.1:9/dav`,
    username: 'e2e-user',
    password: RUNTIME_SECRET
  };
}

// ---------------------------------------------------------------- MTS-01

test('MTS-01: 有 token 部署的 Bearer 门——三 API 无/错 token 全 401，不产生副作用', async () => {
  test.setTimeout(60_000);
  for (const [method, path] of [
    ['POST', '/api/mounts'],
    ['GET', '/api/mounts'],
    ['DELETE', '/api/mounts/1']
  ] as const) {
    const noAuth = await call(method, path, { body: method === 'POST' ? webdavBody() : undefined });
    expect(noAuth.status, `${method} ${path} 无 Bearer`).toBe(401);
    const badAuth = await call(method, path, {
      bearer: 'wrong-token',
      body: method === 'POST' ? webdavBody() : undefined
    });
    expect(badAuth.status, `${method} ${path} 错 token`).toBe(401);
  }
  // 401 的 POST 无副作用：清单需鉴权看不到，但鉴权后清单应为纯静态形态
  const m = manifestOf(await call('GET', '/api/mounts', { bearer: TOKEN }));
  expect(m.runtimeMounts).toHaveLength(0);
});

// ---------------------------------------------------------------- MTS-02

test('MTS-02: GET 清单分段与脱敏——TOML 静态挂载入 staticMounts、userinfo 剥除、凭据不回显', async () => {
  test.setTimeout(60_000);
  const res = await call('GET', '/api/mounts', { bearer: TOKEN });
  expect(res.status).toBe(200);
  const m = manifestOf(res);

  expect(m.fsRoots).toBe(1);
  expect(m.staticMounts).toHaveLength(1);
  const s = m.staticMounts[0]!;
  expect(s.rootIndex).toBe(1) // 静态段自 fsRoots 起算;
  expect(s.kind).toBe('s3');
  expect(s.label).toBe('static-docs');
  expect(s.bucket).toBe('static-bucket');
  expect(s.prefix).toBe('static');
  expect(s.endpoint).toBe('http://127.0.0.1:9') // userinfo 展示面剥除;
  expect(s.capabilities).toEqual({ watch: false, search: false }) // 挂载根能力位;
  expect(m.runtimeMounts).toHaveLength(0);
  expect(m.mounts).toHaveLength(1) // 汇总段 = 静态 + 运行时;
  expect(m.mounts[0]!.rootIndex).toBe(1);

  // 凭据三不纪律之 GET 面：静态段 AK/SK 与 userinfo 密码、字段名均不出现
  expect(res.text).not.toContain(STATIC_SECRET);
  expect(res.text).not.toContain(STATIC_AK);
  expect(res.text).not.toContain('secret_access_key');
  expect(res.text).not.toContain('access_key_id');
  expect(res.text).not.toContain('password');
});

// ---------------------------------------------------------------- MTS-03

test('MTS-03: POST 注册 201/幂等 200 + 挂载根接线即可路由（上游拒绝 500 非 400）+ 凭据不回显', async () => {
  test.setTimeout(60_000);
  // ① 注册：201 + rootIndex=2（fsRoots=1 + 静态段 1 项之后）
  const reg = await call('POST', '/api/mounts', { bearer: TOKEN, body: webdavBody() });
  expect(reg.status).toBe(201);
  expect((reg.json as { rootIndex?: number }).rootIndex).toBe(2);

  // ② 接线即可路由：注册后 root=2 已入路由面——上游 127.0.0.1:9 即时拒绝 →
  //    500（StorageError Other → internal），而非「越界 400」（未接线形态）。
  //    读路径的完整语义由 MockTransport 集成测试覆盖，此处只锚接线的存在性。
  const tree = await call('GET', '/api/tree?root=2', { bearer: TOKEN });
  expect(tree.status).toBe(500);
  expect(errorOf(tree)).not.toBe('');
  expect(tree.text).not.toContain(RUNTIME_SECRET); // 上游错误消息不携凭据
  expect(tree.text).not.toContain('e2e-user');

  // ③ 清单入运行时段：endpoint 剥 userinfo、无凭据回显
  const fresh = await call('GET', '/api/mounts', { bearer: TOKEN });
  expect(fresh.status).toBe(200);
  const m = manifestOf(fresh);
  expect(m.runtimeMounts).toHaveLength(1);
  const r = m.runtimeMounts[0]!;
  expect(r.rootIndex).toBe(2);
  expect(r.kind).toBe('webdav');
  expect(r.label).toBe('e2e-dav');
  expect(r.endpoint).toBe('http://127.0.0.1:9/dav') // userinfo 剥除;
  expect(r.bucket).toBeUndefined() // webdav 无 bucket 字段;
  expect(m.mounts.map((e) => e.rootIndex)).toEqual([1, 2]);
  expect(fresh.text).not.toContain(RUNTIME_SECRET);
  expect(fresh.text).not.toContain('e2e-user');

  // ④ 幂等重注册：同指纹（endpoint 含 userinfo 同形态）→ 200 + 既有 rootIndex
  const again = await call('POST', '/api/mounts', { bearer: TOKEN, body: webdavBody() });
  expect(again.status).toBe(200);
  expect((again.json as { rootIndex?: number }).rootIndex).toBe(2);
  const after = manifestOf(await call('GET', '/api/mounts', { bearer: TOKEN }));
  expect(after.runtimeMounts).toHaveLength(1) // 幂等命中不重复分配;
});

// ---------------------------------------------------------------- MTS-04

test('MTS-04: POST 大 body 413——64KB DefaultBodyLimit 穿真实 HTTP 栈生效且无副作用', async () => {
  test.setTimeout(60_000);
  const before = manifestOf(await call('GET', '/api/mounts', { bearer: TOKEN }));

  // 65KB+1 的合法 JSON（prefix 撑大，label 保留语义供登记断言；字段级合法——
  // 拒收只能来自限值层）
  const big = { ...webdavBody('big'), prefix: 'x'.repeat(64 * 1024 + 1) };
  const res = await call('POST', '/api/mounts', { bearer: TOKEN, body: big });
  expect(res.status).toBe(413);

  // 限值内（60KB）不受影响——限值不误伤正常形态
  const ok = await call('POST', '/api/mounts', {
    bearer: TOKEN,
    body: { ...webdavBody('normal'), prefix: 'x'.repeat(60 * 1024) }
  });
  expect(ok.status).toBe(201);

  const after = manifestOf(await call('GET', '/api/mounts', { bearer: TOKEN }));
  expect(after.runtimeMounts).toHaveLength(before.runtimeMounts.length + 1); // 仅限值内注册生效
  expect(after.runtimeMounts.some((e) => e.label === 'normal')).toBe(true);

  // 清理本用例注册项（worker 串行下也为重试留出确定性）
  const idx = after.runtimeMounts.find((e) => e.label === 'normal')!.rootIndex;
  const del = await call('DELETE', `/api/mounts/${idx}`, { bearer: TOKEN });
  expect(del.status).toBe(204);
});

// ---------------------------------------------------------------- MTS-05

test('MTS-05: 注册校验面——缺必填 400 含字段名、未知字段 4xx、坏 JSON 4xx、错误不携凭据', async () => {
  test.setTimeout(60_000);
  // 缺 password → 400，错误含字段名、不含凭据值
  const missing = await call('POST', '/api/mounts', {
    bearer: TOKEN,
    body: { kind: 'webdav', label: 'no-pass', endpoint: 'http://127.0.0.1:9', username: 'u' }
  });
  expect(missing.status).toBe(400);
  expect(errorOf(missing)).toContain('password');
  expect(missing.text).not.toContain('no-pass-value');

  // S3 缺 bucket → 400 含字段名
  const noBucket = await call('POST', '/api/mounts', {
    bearer: TOKEN,
    body: {
      kind: 's3',
      label: 'no-bucket',
      endpoint: 'http://127.0.0.1:9',
      access_key_id: 'ak',
      secret_access_key: 'sk'
    }
  });
  expect(noBucket.status).toBe(400);
  expect(errorOf(noBucket)).toContain('bucket');

  // 未知字段（deny_unknown_fields 防拼错键静默忽略）→ 4xx
  const unknown = await call('POST', '/api/mounts', {
    bearer: TOKEN,
    body: { ...webdavBody('typo'), pasword: 'typo-value' }
  });
  expect(unknown.status).toBeGreaterThanOrEqual(400);
  expect(unknown.status).toBeLessThan(500);

  // 非 JSON body → 4xx
  const raw = await fetch(`${AUX}/api/mounts`, {
    method: 'POST',
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: 'not json'
  });
  expect(raw.status).toBeGreaterThanOrEqual(400);
  expect(raw.status).toBeLessThan(500);

  // 校验失败全无副作用
  const after = manifestOf(await call('GET', '/api/mounts', { bearer: TOKEN }));
  expect(after.runtimeMounts.map((e) => e.label)).not.toContain('no-pass');
  expect(after.runtimeMounts.map((e) => e.label)).not.toContain('no-bucket');
  expect(after.runtimeMounts.map((e) => e.label)).not.toContain('typo');
});

// ---------------------------------------------------------------- MTS-06

test('MTS-06: DELETE 矩阵——运行时 204/再删 404/静态与 fs 根 405/删后越界 400', async () => {
  test.setTimeout(60_000);
  // 自注册运行时项（自包含，不依赖他用例的注册状态——retries 重跑确定性）
  const reg = await call('POST', '/api/mounts', { bearer: TOKEN, body: webdavBody('del-target') });
  expect(reg.status).toBe(201);
  const idx = (reg.json as { rootIndex: number }).rootIndex;

  // 运行时项 204 + 空体
  const del = await call('DELETE', `/api/mounts/${idx}`, { bearer: TOKEN });
  expect(del.status).toBe(204);
  expect(del.text).toBe('');

  // 删后清单收缩（tombstone 空洞不进清单）+ 该根寻址 400 越界——tombstone
  // 语义：其余项 rootIndex 不移位、被删索引进程内恒不解析（重复 DELETE 404，
  // 见下），无移位串扰（活跃 tab 失效帧降级为「删除即成功」，见任务报告）
  const after = manifestOf(await call('GET', '/api/mounts', { bearer: TOKEN }));
  expect(after.runtimeMounts.map((e) => e.rootIndex)).not.toContain(idx);
  expect(after.mounts.map((e) => e.rootIndex)).toEqual([1, ...after.runtimeMounts.map((e) => e.rootIndex)]);
  const tree = await call('GET', `/api/tree?root=${idx}`, { bearer: TOKEN });
  expect(tree.status).toBe(400);
  expect(errorOf(tree)).toContain('root index out of range');

  // 再删 → 404（已删 tombstone 空洞同越界归 404）
  const again = await call('DELETE', `/api/mounts/${idx}`, { bearer: TOKEN });
  expect(again.status).toBe(404);

  // 静态 TOML 挂载（1）与 fs 根（0）拒删 → 405（静态资源类不支持 DELETE；
  // RFC 9110 MUST：405 响应携 Allow 头）
  for (const staticIdx of [0, 1]) {
    const res = await call('DELETE', `/api/mounts/${staticIdx}`, { bearer: TOKEN });
    expect(res.status, `DELETE /api/mounts/${staticIdx}`).toBe(405);
    expect(errorOf(res)).toContain('static root');
    expect(res.headers.get('allow')).toBe('GET, POST');
  }
});

// ---------------------------------------------------------------- MTS-IDB

test('MTS-IDB: 真实浏览器 IDB v3→v4 迁移——fonts 存量保留 + mounts store 补建 + 共存读写', async ({
  page
}) => {
  test.setTimeout(90_000);
  // ① 停在无应用脚本的 JSON 响应页（同源）预置 v3 库：kv/themes/fonts 三 store
  //    （session.ts v3 形态镜像；升级回调幂等所以只需形状对齐）+ fonts 存量记录。
  //    enabled:false——loadEnabledFontFaces 只装载启用项，禁用存量不触发 FontFace
  //    解析（迁移共存面与字体可用性正交）
  await page.goto(`${BASE}/api/health`);
  await page.evaluate(async () => {
    const fontData = new TextEncoder().encode('e2e-migration-font-bytes').buffer;
    await new Promise<void>((resolve, reject) => {
      const req = indexedDB.open('vviewer', 3);
      req.onupgradeneeded = () => {
        const d = req.result;
        if (!d.objectStoreNames.contains('kv')) d.createObjectStore('kv');
        if (!d.objectStoreNames.contains('themes')) d.createObjectStore('themes');
        if (!d.objectStoreNames.contains('fonts')) d.createObjectStore('fonts');
      };
      req.onsuccess = () => {
        const d = req.result;
        const tx = d.transaction('fonts', 'readwrite');
        tx.objectStore('fonts').put(
          {
            id: 'font:e2e-mig',
            name: 'E2E 迁移字体',
            family: 'E2E 迁移字体',
            kind: 'url',
            data: fontData,
            url: 'https://fonts.example.com/e2e.woff2',
            size: 24,
            enabled: false,
            addedAt: 1700000000000
          },
          'font:e2e-mig'
        );
        tx.oncomplete = () => {
          d.close();
          resolve();
        };
        tx.onerror = () => reject(tx.error);
      };
      req.onerror = () => reject(req.error);
    });
  });

  // ② 进应用：AppShell onMount（restore/loadEnabledFontFaces）→ db() 以 v4 open
  //    现有 v3 库 → 真实 onupgradeneeded 补建 mounts
  await page.goto('/');

  // ③ 探针：免版本 open 观察实际形态（轮询等待应用侧升级完成；免版本 open
  //    自身绝不触发升级——读到 4 只能来自应用的 v4 open）
  const probe = await page.evaluate(async () => {
    const open = (): Promise<{ version: number; stores: string[]; conn: IDBDatabase }> =>
      new Promise((resolve, reject) => {
        const req = indexedDB.open('vviewer');
        req.onsuccess = () => {
          const d = req.result;
          resolve({ version: d.version, stores: Array.from(d.objectStoreNames), conn: d });
        };
        req.onerror = () => reject(req.error);
      });
    let state = await open();
    for (let i = 0; i < 100 && state.version !== 4; i++) {
      state.conn.close();
      await new Promise((r) => setTimeout(r, 100));
      state = await open();
    }
    const { conn, version, stores } = state;
    const get = (store: string, key: IDBValidKey): Promise<unknown> =>
      new Promise((resolve, reject) => {
        const tx = conn.transaction(store, 'readonly');
        const req = tx.objectStore(store).get(key);
        req.onsuccess = () => resolve(req.result ?? null);
        req.onerror = () => reject(req.error);
      });
    // mounts 写读回环（v4 新 store 可写）+ fonts 存量读回（迁移不丢数据）
    const roundtrip = await new Promise<unknown>((resolve, reject) => {
      const tx = conn.transaction('mounts', 'readwrite');
      tx.objectStore('mounts').put(
        { id: 'probe-1', kind: 'proxy', backend: 'webdav', label: 'probe', endpoint: 'http://127.0.0.1:9', prefix: '', fingerprint: 'fp', serverBase: 'http://127.0.0.1:4174', createdAt: 1 },
        'probe-1'
      );
      tx.oncomplete = () => resolve(null);
      tx.onerror = () => reject(tx.error);
    }).then(() => get('mounts', 'probe-1'));
    const font = await get('fonts', 'font:e2e-mig');
    conn.close();
    return { version, stores, font, roundtrip };
  });

  expect(probe.version).toBe(4); // 应用侧 v4 open 已完成升级
  // objectStoreNames 按字典序返回（DOMStringList 排序语义）：恰为 v3 三 store +
  // v4 补建 mounts，无多余
  expect(probe.stores.slice().sort()).toEqual(['fonts', 'kv', 'mounts', 'themes']);
  expect(probe.font).toMatchObject({ id: 'font:e2e-mig', name: 'E2E 迁移字体', enabled: false, size: 24 }) // v3 fonts 存量迁移后原样保留;
  expect(probe.roundtrip).toMatchObject({ id: 'probe-1', kind: 'proxy', backend: 'webdav' }) // mounts store 迁移后可写可读;
});
