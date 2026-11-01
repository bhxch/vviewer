// apps/web/src/lib/openVsx.test.ts — Open VSX 安装与更新通道单测（T5 Step 1）。
// IndexedDB 用 fake-indexeddb/auto（session.test.ts / vsixImport.test.ts 同款先例，
// 库在本文件内持久 → 记录数断言一律用相对计数）；fetch 用 __setFetchImplForTest
// 注入缝（cdnEngines __setCdnLoaderForTest 同形态）；vsix 字节用真实 jszip 构造。
import 'fake-indexeddb/auto';
import { afterAll, describe, expect, it } from 'vitest';
import JSZip from 'jszip';
import {
  MAX_VSIX_BYTES,
  __setFetchImplForTest,
  checkUpdate,
  installFromOpenVsx,
  parseOpenVsxInput,
  updateTheme
} from './openVsx';
import {
  listIconThemes,
  listThemes,
  type ImportedIconTheme,
  type ImportedTheme
} from './stores/session';

const OVX = 'https://open-vsx.org';
const PUB = 'pub';
const EXT = 'mini-icons';

/** 元数据响应体（spec §6.1 形状：version + files.manifest/download 直链）。 */
function metaJson(version: string): string {
  return JSON.stringify({
    version,
    files: {
      manifest: `${OVX}/api/${PUB}/${EXT}/${version}/file/${PUB}.${EXT}-${version}.manifest`,
      download: `${OVX}/api/${PUB}/${EXT}/${version}/file/${PUB}.${EXT}-${version}.vsix`
    }
  });
}

/** 图标主题 vsix：contributes.iconThemes 单条，字形码点随版本变化（更新闭环断言用）。 */
async function iconVsix(v: string, char: string): Promise<Uint8Array> {
  const zip = new JSZip();
  zip.file(
    'extension/package.json',
    JSON.stringify({ name: EXT, contributes: { iconThemes: [{ label: 'OVX Mini', path: './icons/mini.json' }] } })
  );
  zip.file(
    'extension/icons/mini.json',
    JSON.stringify({
      name: 'OVX Mini',
      iconDefinitions: { file: { fontCharacter: char } },
      fonts: [{ id: 'm', src: ['./m.woff'] }],
      fileExtensions: { ts: 'file' }
    })
  );
  zip.file('extension/icons/m.woff', 'FAKE-FONT-BYTES');
  return zip.generateAsync({ type: 'uint8array' });
}

/** 颜色主题 vsix：contributes.themes 单条，背景色随版本变化。 */
async function colorVsix(v: string, bg: string): Promise<Uint8Array> {
  const zip = new JSZip();
  zip.file(
    'extension/package.json',
    JSON.stringify({ name: 'night', contributes: { themes: [{ label: 'OVX Night', path: './themes/night.json' }] } })
  );
  zip.file(
    'extension/themes/night.json',
    JSON.stringify({ name: 'OVX Night', type: 'dark', colors: { 'editor.background': bg } })
  );
  return zip.generateAsync({ type: 'uint8array' });
}

interface MockRoute {
  status?: number;
  body: string | Uint8Array;
  contentType?: string;
}

/** 注入 mock fetch：URL → 响应路由，返回请求 URL 收集器（预检快错断言用）。 */
function mockFetch(routes: Record<string, MockRoute>): string[] {
  const hits: string[] = [];
  __setFetchImplForTest((async (input: RequestInfo | URL) => {
    const url = String(input);
    hits.push(url);
    const route = routes[url];
    if (route === undefined) return new Response(`not mocked: ${url}`, { status: 404 });
    return new Response(route.body as BodyInit, {
      status: route.status ?? 200,
      headers: { 'content-type': route.contentType ?? 'application/json' }
    });
  }) as typeof fetch);
  return hits;
}

afterAll(() => {
  __setFetchImplForTest(null); // 还原生产 fetch（注入缝契约）
});

describe('parseOpenVsxInput（三形态 + 非法输入）', () => {
  it('页面 URL：/extension/{p}/{e}[/v]（容忍尾斜杠与查询串）', () => {
    expect(parseOpenVsxInput('https://open-vsx.org/extension/rust-lang/rls')).toEqual({
      publisher: 'rust-lang',
      extension: 'rls'
    });
    expect(parseOpenVsxInput('https://open-vsx.org/extension/zhuangtongfa/material-theme/2.0.1')).toEqual({
      publisher: 'zhuangtongfa',
      extension: 'material-theme',
      version: '2.0.1'
    });
    expect(parseOpenVsxInput('https://open-vsx.org/extension/a/b/?utm=x#frag')).toEqual({
      publisher: 'a',
      extension: 'b'
    });
  });

  it('标识：{p}.{e} 与 {p}.{e}@{v}', () => {
    expect(parseOpenVsxInput('pkief.material-icon-theme')).toEqual({
      publisher: 'pkief',
      extension: 'material-icon-theme'
    });
    expect(parseOpenVsxInput(' pub.mini-icons@1.2.3-beta.1 ')).toEqual({
      publisher: 'pub',
      extension: 'mini-icons',
      version: '1.2.3-beta.1'
    });
  });

  it('vsix 直链：/api/{p}/{e}/{v}/file/*.vsix', () => {
    expect(
      parseOpenVsxInput(`${OVX}/api/pub/mini-icons/1.0.0/file/pub.mini-icons-1.0.0.vsix`)
    ).toEqual({ publisher: 'pub', extension: 'mini-icons', version: '1.0.0' });
  });

  it('非法输入：空串/无点/多点/http 明文/外域/非 extension 路径 → error 文案', () => {
    expect('error' in parseOpenVsxInput('')).toBe(true);
    expect('error' in parseOpenVsxInput('plainname')).toBe(true);
    expect('error' in parseOpenVsxInput('a.b.c')).toBe(true);
    expect('error' in parseOpenVsxInput('a.')).toBe(true);
    expect('error' in parseOpenVsxInput('http://open-vsx.org/extension/a/b')).toBe(true);
    expect('error' in parseOpenVsxInput('https://evil.com/extension/a/b')).toBe(true);
    expect('error' in parseOpenVsxInput(`${OVX}/api/a/b`)).toBe(true);
    expect('error' in parseOpenVsxInput(`${OVX}/extension/a`)).toBe(true);
  });
});

describe('installFromOpenVsx（mock fetch 管线）', () => {
  it('图标主题：manifest 预检过 → 拉 vsix → 走 importIconThemeFiles 内核 → origin 字段落库', async () => {
    const routes: Record<string, MockRoute> = {
      [`${OVX}/api/${PUB}/${EXT}`]: { body: metaJson('1.0.0') },
      [`${OVX}/api/${PUB}/${EXT}/1.0.0/file/${PUB}.${EXT}-1.0.0.manifest`]: {
        body: JSON.stringify({ name: EXT, contributes: { iconThemes: [{ label: 'OVX Mini', path: './icons/mini.json' }] } })
      },
      [`${OVX}/api/${PUB}/${EXT}/1.0.0/file/${PUB}.${EXT}-1.0.0.vsix`]: {
        body: await iconVsix('1.0.0', '\\e001'),
        contentType: 'application/octet-stream'
      }
    };
    const hits = mockFetch(routes);
    const { imported, errors } = await installFromOpenVsx('pub.mini-icons');
    expect(errors).toEqual([]);
    expect(hits).toEqual([
      `${OVX}/api/${PUB}/${EXT}`,
      `${OVX}/api/${PUB}/${EXT}/1.0.0/file/${PUB}.${EXT}-1.0.0.manifest`,
      `${OVX}/api/${PUB}/${EXT}/1.0.0/file/${PUB}.${EXT}-1.0.0.vsix`
    ]);
    expect(imported).toHaveLength(1);
    const rec = imported[0] as ImportedIconTheme;
    expect(rec).toMatchObject({ name: 'OVX Mini', source: 'vsix' });
    expect(rec.origin).toEqual({ publisher: PUB, extension: EXT, version: '1.0.0', checkedAt: expect.any(Number) });
    // 落库可查（同 id 覆盖更新用例的前置）
    const stored = await listIconThemes();
    expect(stored.find((t) => t.id === rec.id)).toMatchObject({ name: 'OVX Mini' });
  });

  it('颜色主题：contributes.themes → importThemeFiles 通道，origin 落库', async () => {
    const routes: Record<string, MockRoute> = {
      [`${OVX}/api/${PUB}/${EXT}`]: { body: metaJson('1.0.0') },
      [`${OVX}/api/${PUB}/${EXT}/1.0.0/file/${PUB}.${EXT}-1.0.0.manifest`]: {
        body: JSON.stringify({ name: EXT, contributes: { themes: [{ label: 'OVX Night', path: './themes/night.json' }] } })
      },
      [`${OVX}/api/${PUB}/${EXT}/1.0.0/file/${PUB}.${EXT}-1.0.0.vsix`]: {
        body: await colorVsix('1.0.0', '#011627'),
        contentType: 'application/octet-stream'
      }
    };
    mockFetch(routes);
    const { imported, errors } = await installFromOpenVsx(`${OVX}/extension/pub/mini-icons`);
    expect(errors).toEqual([]);
    const rec = imported[0] as ImportedTheme;
    expect(rec).toMatchObject({ name: 'OVX Night', kind: 'dark', source: 'vsix' });
    expect(rec.origin).toEqual({ publisher: PUB, extension: EXT, version: '1.0.0', checkedAt: expect.any(Number) });
    expect((await listThemes()).find((t) => t.id === rec.id)).toMatchObject({ name: 'OVX Night' });
  });

  it('双通道包：contributes 两类并存 → 颜色+图标各一条、origin 同源', async () => {
    const zip = new JSZip();
    const pkg =
      JSON.stringify({
        name: EXT,
        contributes: {
          themes: [{ label: 'OVX Night', path: './themes/night.json' }],
          iconThemes: [{ label: 'OVX Mini', path: './icons/mini.json' }]
        }
      });
    zip.file('extension/package.json', pkg);
    zip.file(
      'extension/themes/night.json',
      JSON.stringify({ name: 'OVX Night', type: 'dark', colors: { 'editor.background': '#000000' } })
    );
    zip.file(
      'extension/icons/mini.json',
      JSON.stringify({
        iconDefinitions: { file: { fontCharacter: '\\e001' } },
        fonts: [{ id: 'm', src: ['./m.woff'] }]
      })
    );
    zip.file('extension/icons/m.woff', 'FONT');
    const routes: Record<string, MockRoute> = {
      [`${OVX}/api/${PUB}/${EXT}`]: { body: metaJson('1.0.0') },
      [`${OVX}/api/${PUB}/${EXT}/1.0.0/file/${PUB}.${EXT}-1.0.0.manifest`]: {
        body: pkg
      },
      [`${OVX}/api/${PUB}/${EXT}/1.0.0/file/${PUB}.${EXT}-1.0.0.vsix`]: {
        body: await zip.generateAsync({ type: 'uint8array' }),
        contentType: 'application/octet-stream'
      }
    };
    mockFetch(routes);
    const { imported, errors } = await installFromOpenVsx('pub.mini-icons');
    expect(errors).toEqual([]);
    expect(imported).toHaveLength(2);
    const origins = imported.map((t) => t.origin);
    for (const o of origins) expect(o).toEqual({ publisher: PUB, extension: EXT, version: '1.0.0', checkedAt: expect.any(Number) });
  });

  it('非主题扩展：manifest 预检快速报错（不触发整包下载）', async () => {
    const routes: Record<string, MockRoute> = {
      [`${OVX}/api/${PUB}/${EXT}`]: { body: metaJson('1.0.0') },
      [`${OVX}/api/${PUB}/${EXT}/1.0.0/file/${PUB}.${EXT}-1.0.0.manifest`]: {
        body: JSON.stringify({ name: EXT, contributes: { languages: [] } })
      }
    };
    const hits = mockFetch(routes);
    await expect(installFromOpenVsx('pub.mini-icons')).rejects.toThrow('该扩展不含主题');
    expect(hits).toHaveLength(2); // 元数据 + manifest 预检，无 vsix 下载
  });

  it('vsix 超过 30MB 上限：下载后拒绝（不部分入库）', async () => {
    const routes: Record<string, MockRoute> = {
      [`${OVX}/api/${PUB}/${EXT}`]: { body: metaJson('1.0.0') },
      [`${OVX}/api/${PUB}/${EXT}/1.0.0/file/${PUB}.${EXT}-1.0.0.manifest`]: {
        body: JSON.stringify({ name: EXT, contributes: { iconThemes: [{ label: 'x', path: './i.json' }] } })
      },
      [`${OVX}/api/${PUB}/${EXT}/1.0.0/file/${PUB}.${EXT}-1.0.0.vsix`]: {
        body: new Uint8Array(MAX_VSIX_BYTES + 1),
        contentType: 'application/octet-stream'
      }
    };
    mockFetch(routes);
    await expect(installFromOpenVsx('pub.mini-icons')).rejects.toThrow('30MB');
  });

  it('API 404 → HTTP 状态透出；网络失败 → 「需网络与 CORS」文案；解析失败输入 → error 文案', async () => {
    const routes: Record<string, MockRoute> = {
      [`${OVX}/api/${PUB}/${EXT}`]: { status: 404, body: '{"error":"Not Found"}' }
    };
    mockFetch(routes);
    await expect(installFromOpenVsx('pub.mini-icons')).rejects.toThrow('HTTP 404');
    __setFetchImplForTest((async () => {
      throw new TypeError('fetch failed');
    }) as typeof fetch);
    await expect(installFromOpenVsx('pub.mini-icons')).rejects.toThrow('需网络与 CORS');
    mockFetch({});
    await expect(installFromOpenVsx('not an id')).rejects.toThrow('无法识别');
  });

  it('元数据缺 version 且输入无 @version → 抛「元数据缺少版本号」（评审 Minor 4：不落 latest 死循环提示）', async () => {
    const routes: Record<string, MockRoute> = {
      [`${OVX}/api/${PUB}/${EXT}`]: {
        body: JSON.stringify({
          files: {
            manifest: `${OVX}/api/${PUB}/${EXT}/1.0.0/file/${PUB}.${EXT}-1.0.0.manifest`,
            download: `${OVX}/api/${PUB}/${EXT}/1.0.0/file/${PUB}.${EXT}-1.0.0.vsix`
          }
        })
      },
      [`${OVX}/api/${PUB}/${EXT}/1.0.0/file/${PUB}.${EXT}-1.0.0.manifest`]: {
        body: JSON.stringify({ name: EXT, contributes: { iconThemes: [{ label: 'x', path: './i.json' }] } })
      }
    };
    mockFetch(routes);
    await expect(installFromOpenVsx('pub.mini-icons')).rejects.toThrow('元数据缺少版本号');
  });
});

describe('checkUpdate / updateTheme（mock fetch 更新闭环）', () => {
  it('checkUpdate：latest ≠ origin.version → hasUpdate；相等 → false', async () => {
    mockFetch({ [`${OVX}/api/${PUB}/${EXT}`]: { body: metaJson('2.0.0') } });
    expect(
      await checkUpdate({ publisher: PUB, extension: EXT, version: '1.0.0', checkedAt: 1 })
    ).toEqual({ latest: '2.0.0', hasUpdate: true });
    mockFetch({ [`${OVX}/api/${PUB}/${EXT}`]: { body: metaJson('1.0.0') } });
    expect(
      await checkUpdate({ publisher: PUB, extension: EXT, version: '1.0.0', checkedAt: 1 })
    ).toEqual({ latest: '1.0.0', hasUpdate: false });
  });

  it('updateTheme 图标主题：重拉 v2 → 同 id 覆盖写入（version/内容刷新、无临时残留）', async () => {
    // v1 安装入库
    mockFetch({
      [`${OVX}/api/${PUB}/${EXT}`]: { body: metaJson('1.0.0') },
      [`${OVX}/api/${PUB}/${EXT}/1.0.0/file/${PUB}.${EXT}-1.0.0.manifest`]: {
        body: JSON.stringify({ name: EXT, contributes: { iconThemes: [{ label: 'OVX Mini', path: './icons/mini.json' }] } })
      },
      [`${OVX}/api/${PUB}/${EXT}/1.0.0/file/${PUB}.${EXT}-1.0.0.vsix`]: {
        body: await iconVsix('1.0.0', '\\e001'),
        contentType: 'application/octet-stream'
      }
    });
    const { imported } = await installFromOpenVsx('pub.mini-icons');
    const v1 = imported[0] as ImportedIconTheme;
    const before = (await listIconThemes()).length;
    // 线上已是 v2（字形码点变化）
    mockFetch({
      [`${OVX}/api/${PUB}/${EXT}`]: { body: metaJson('2.0.0') },
      [`${OVX}/api/${PUB}/${EXT}/2.0.0/file/${PUB}.${EXT}-2.0.0.vsix`]: {
        body: await iconVsix('2.0.0', '\\e002'),
        contentType: 'application/octet-stream'
      }
    });
    const updated = (await updateTheme(v1)) as ImportedIconTheme;
    expect(updated.id).toBe(v1.id); // 设置引用 id 不变（零断链）
    expect(updated.origin).toMatchObject({ version: '2.0.0', publisher: PUB, extension: EXT });
    expect(updated.manifest.fileExtensions.get('ts')).toMatchObject({ char: '\ue002' }); // 内容已刷新
    const all = await listIconThemes();
    expect(all).toHaveLength(before); // 无临时记录残留
    expect(all.find((t) => t.id === v1.id)).toMatchObject({ name: 'OVX Mini' });
  });

  it('updateTheme 颜色主题：同 id 覆盖、colors 刷新、themes store 无残留', async () => {
    mockFetch({
      [`${OVX}/api/${PUB}/${EXT}`]: { body: metaJson('1.0.0') },
      [`${OVX}/api/${PUB}/${EXT}/1.0.0/file/${PUB}.${EXT}-1.0.0.manifest`]: {
        body: JSON.stringify({ name: EXT, contributes: { themes: [{ label: 'OVX Night', path: './themes/night.json' }] } })
      },
      [`${OVX}/api/${PUB}/${EXT}/1.0.0/file/${PUB}.${EXT}-1.0.0.vsix`]: {
        body: await colorVsix('1.0.0', '#011627'),
        contentType: 'application/octet-stream'
      }
    });
    const { imported } = await installFromOpenVsx('pub.mini-icons');
    const v1 = imported[0] as ImportedTheme;
    const before = (await listThemes()).length;
    mockFetch({
      [`${OVX}/api/${PUB}/${EXT}`]: { body: metaJson('2.0.0') },
      [`${OVX}/api/${PUB}/${EXT}/2.0.0/file/${PUB}.${EXT}-2.0.0.vsix`]: {
        body: await colorVsix('2.0.0', '#011628'),
        contentType: 'application/octet-stream'
      }
    });
    const updated = (await updateTheme(v1)) as ImportedTheme;
    expect(updated.id).toBe(v1.id);
    expect(updated.origin).toMatchObject({ version: '2.0.0' });
    expect(updated.colors['editor.background']).toBe('#011628');
    const all = await listThemes();
    expect(all).toHaveLength(before);
    expect(all.find((t) => t.id === v1.id)).toMatchObject({ name: 'OVX Night' });
  });

  it('updateTheme：无 origin（本地导入）→ 报错拒绝', async () => {
    const rec: ImportedTheme = {
      id: 'imported:localxx',
      name: 'Local',
      kind: 'dark',
      colors: {},
      tokenColors: [],
      source: 'json',
      addedAt: 1
    };
    await expect(updateTheme(rec)).rejects.toThrow('无 Open VSX 来源');
  });
});
