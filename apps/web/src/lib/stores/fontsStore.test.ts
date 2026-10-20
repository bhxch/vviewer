// fontsStore.test.ts — fonts store v3 CRUD/迁移与 FontFace 生命周期
// （字体系统 spec 2026-10-19 §5，Task 4）。jsdom 缺 FontFace/document.fonts 可控桩
// （既有教训先例）：FontFace 以类桩全局替换，document.fonts 以记录 add/delete 的
// 桩对象替换；IndexedDB 用 fake-indexeddb，每个用例换全新库实例（互不串扰）。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import {
  MAX_FONT_BYTES,
  addFontFromFile,
  addFontFromUrl,
  deleteFont,
  listFontRecords,
  loadEnabledFontFaces,
  setEnabledFont,
  withQuotaGuidance,
  type FontRecord
} from './fontsStore';

// ---- jsdom 缺口桩 ----
let faces: FakeFontFace[] = [];
let failLoads = false; // 置 true 时 FontFace.load reject（模拟非字体内容）

class FakeFontFace {
  loaded = false;
  constructor(
    public family: string,
    public source: ArrayBuffer
  ) {
    faces.push(this);
  }
  load(): Promise<FakeFontFace> {
    if (failLoads) return Promise.reject(new Error('OpenType parsing failed'));
    this.loaded = true;
    return Promise.resolve(this);
  }
}

let fontSet: { added: FakeFontFace[]; removed: FakeFontFace[] };

function stubFontWorld(): void {
  fontSet = { added: [], removed: [] };
  vi.stubGlobal('FontFace', FakeFontFace);
  Object.defineProperty(document, 'fonts', {
    value: {
      add: (f: FakeFontFace) => fontSet.added.push(f),
      delete: (f: FakeFontFace) => fontSet.removed.push(f)
    },
    configurable: true
  });
}

function stubFetch(buf: ArrayBuffer, ok = true, status = 200): void {
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok, status, arrayBuffer: async () => buf })));
}

const fileOf = (bytes: number[], name: string): File => new File([new Uint8Array(bytes)], name);

/** 绕过 add 管线直写 store（构造「库里已有但 FaceFace 损坏」的恢复期场景） */
async function rawPut(rec: FontRecord): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const req = indexedDB.open('vviewer');
    req.onsuccess = () => {
      const d = req.result;
      const tx = d.transaction('fonts', 'readwrite');
      tx.objectStore('fonts').put(rec, rec.id);
      tx.oncomplete = () => {
        d.close();
        resolve();
      };
      tx.onerror = () => reject(tx.error);
    };
    req.onerror = () => reject(req.error);
  });
}

beforeEach(() => {
  faces = [];
  failLoads = false;
  vi.stubGlobal('indexedDB', new IDBFactory()); // 每用例全新库（迁移用例不受他例升版污染）
  stubFontWorld();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('v2 存量升版迁移（session.ts DB_VERSION 现为 4）', () => {
  it('v2 库（kv/themes 存量）升 v3：fonts store 补建，存量数据原样保留', async () => {
    // 造 v2 库：kv + themes 各存一条（session.ts v2 形态）
    await new Promise<void>((resolve, reject) => {
      const req = indexedDB.open('vviewer', 2);
      req.onupgradeneeded = () => {
        req.result.createObjectStore('kv');
        req.result.createObjectStore('themes');
      };
      req.onsuccess = () => {
        const d = req.result;
        const tx = d.transaction(['kv', 'themes'], 'readwrite');
        tx.objectStore('kv').put('keep-kv', 'tabs');
        tx.objectStore('themes').put({ id: 'imported:x' }, 'imported:x');
        tx.oncomplete = () => {
          d.close();
          resolve();
        };
        tx.onerror = () => reject(tx.error);
      };
      req.onerror = () => reject(req.error);
    });
    // fontsStore 以 DB_VERSION 打开触发升级（Task 2 起 DB_VERSION=4：v2 存量
    // 一路升到 v4，fonts/mounts 两 store 同轮补建）
    expect(await listFontRecords()).toEqual([]);
    await new Promise<void>((resolve, reject) => {
      const req = indexedDB.open('vviewer');
      req.onsuccess = () => {
        const d = req.result;
        expect(d.version).toBe(4);
        expect(d.objectStoreNames.contains('fonts')).toBe(true);
        const tx = d.transaction(['kv', 'themes'], 'readonly');
        const kv = tx.objectStore('kv').get('tabs');
        const th = tx.objectStore('themes').get('imported:x');
        tx.oncomplete = () => {
          expect(kv.result).toBe('keep-kv');
          expect(th.result).toEqual({ id: 'imported:x' });
          d.close();
          resolve();
        };
        tx.onerror = () => reject(tx.error);
      };
      req.onerror = () => reject(req.error);
    });
  });
});

describe('CRUD 与门禁', () => {
  it('URL 添加：fetch→入库（kind/url/名取末段去扩展解码）→FontFace 引号包裹→document.fonts.add', async () => {
    stubFetch(new Uint8Array([1, 2, 3]).buffer);
    const rec = await addFontFromUrl('https://cdn.example/fx/My%20Font.woff2');
    expect(rec.kind).toBe('url');
    expect(rec.url).toBe('https://cdn.example/fx/My%20Font.woff2');
    expect(rec.name).toBe('My Font');
    expect(rec.family).toBe('My Font');
    expect(rec.enabled).toBe(true);
    expect(rec.size).toBe(3);
    expect(rec.id).not.toBe('');
    expect(faces).toHaveLength(1);
    expect(faces[0]!.family).toBe('"My Font"'); // family 参数引号包裹原文
    expect(faces[0]!.loaded).toBe(true);
    expect(fontSet.added).toEqual(faces);
    expect((await listFontRecords()).map((r) => r.id)).toEqual([rec.id]);
  });

  it('URL 添加显式 name 优先于末段推导', async () => {
    stubFetch(new Uint8Array([1]).buffer);
    const rec = await addFontFromUrl('https://f.example/x.woff2', '自 定 义');
    expect(rec.name).toBe('自 定 义');
    expect(faces[0]!.family).toBe('"自 定 义"');
  });

  it('本地上传：文件名去扩展名为 name，同走装载/入库/注册', async () => {
    const rec = await addFontFromFile(fileOf([9, 9], 'Sarasa Mono SC.ttf'));
    expect(rec.kind).toBe('file');
    expect(rec.name).toBe('Sarasa Mono SC');
    expect(rec.url).toBeUndefined();
    expect(rec.size).toBe(2);
    expect(faces[0]!.family).toBe('"Sarasa Mono SC"');
    expect(fontSet.added).toHaveLength(1);
  });

  it('非 https 拒收且不发起 fetch（mixed content 防线）', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(addFontFromUrl('http://f.example/x.woff2')).rejects.toThrow(/https/);
    await expect(addFontFromUrl('ftp://f.example/x.woff2')).rejects.toThrow(/https/);
    await expect(addFontFromUrl('not a url')).rejects.toThrow(/非法/);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await listFontRecords()).toEqual([]);
  });

  it('台账 Low：名称含逗号拒收（显式名/URL 末段推导同门禁），不入库不装载', async () => {
    stubFetch(new Uint8Array([1]).buffer);
    await expect(addFontFromUrl('https://f.example/x.woff2', 'A,B')).rejects.toThrow(/逗号/);
    // URL 末段含逗号（%2C 解码后）同拒
    await expect(addFontFromUrl('https://f.example/a%2Cb.woff2')).rejects.toThrow(/逗号/);
    await expect(addFontFromFile(fileOf([1], 'c,d.ttf'))).rejects.toThrow(/逗号/);
    expect(faces).toHaveLength(0); // 名称门禁在装载之前（fail fast）
    expect(await listFontRecords()).toEqual([]);
  });

  it('台账 Low：与库内同名拒收（下拉/槽位回落均按 name 键比对），首条不受影响', async () => {
    stubFetch(new Uint8Array([1]).buffer);
    const first = await addFontFromFile(fileOf([1], 'Dup.ttf'));
    stubFetch(new Uint8Array([2, 2]).buffer);
    await expect(addFontFromUrl('https://f.example/other.woff2', 'Dup')).rejects.toThrow(/同名/);
    const all = await listFontRecords();
    expect(all.map((r) => r.id)).toEqual([first.id]); // 仅首条，无重复记录
    expect(faces).toHaveLength(1); // 第二次未走到装载
  });

  it('单文件超 30MB 拒收（URL 下载后 / 上传同门禁），不入库', async () => {
    const big = new Uint8Array(MAX_FONT_BYTES + 1);
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, arrayBuffer: async () => big.buffer }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(addFontFromUrl('https://f.example/big.woff2')).rejects.toThrow(/30MB/);
    expect(fetchMock).toHaveBeenCalledOnce(); // 门禁在 fetch 之后、入库之前
    await expect(addFontFromFile(new File([big], 'big.ttf'))).rejects.toThrow(/30MB/);
    expect(await listFontRecords()).toEqual([]);
  });

  it('下载失败（网络/非 2xx）：抛错误态（提示 CORS）且不入库', async () => {
    stubFetch(new ArrayBuffer(0), false, 404);
    await expect(addFontFromUrl('https://f.example/x.woff2')).rejects.toThrow(/CORS/);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch');
      })
    );
    await expect(addFontFromUrl('https://f.example/x.woff2')).rejects.toThrow(/CORS/);
    expect(await listFontRecords()).toEqual([]);
  });

  it('非字体内容（load reject）：不入库；负缓存不固化——重试成功', async () => {
    stubFetch(new Uint8Array([1]).buffer);
    failLoads = true;
    await expect(addFontFromUrl('https://f.example/bad.woff2', 'Bad')).rejects.toThrow(/字体解析失败/);
    expect(await listFontRecords()).toEqual([]);
    failLoads = false;
    const rec = await addFontFromUrl('https://f.example/bad.woff2', 'Bad');
    expect(rec.name).toBe('Bad');
    expect(faces).toHaveLength(2); // 失败的那次没被缓存复用
  });

  it('列表按入库序（addedAt 升序）返回', async () => {
    // addedAt 同毫秒并列时序不定（store 主键为随机 id，getAll 按键序）——受控时钟分离
    let nowSeq = 0;
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => ++nowSeq * 1000);
    const a = await addFontFromFile(fileOf([1], 'A.ttf'));
    const b = await addFontFromFile(fileOf([2], 'B.ttf'));
    nowSpy.mockRestore();
    expect((await listFontRecords()).map((r) => r.id)).toEqual([a.id, b.id]);
  });
});

describe('启停与 document.fonts 交互', () => {
  it('停用：enabled 落库 + document.fonts.delete；再启用：缓存复用不重建', async () => {
    const rec = await addFontFromFile(fileOf([1], 'A.ttf'));
    await setEnabledFont(rec.id, false);
    expect(fontSet.removed).toEqual([faces[0]]);
    expect((await listFontRecords())[0]!.enabled).toBe(false);
    await setEnabledFont(rec.id, true);
    expect(faces).toHaveLength(1); // 缓存命中，未重建
    expect(fontSet.added).toEqual([faces[0], faces[0]]);
    expect((await listFontRecords())[0]!.enabled).toBe(true);
  });

  it('启用损坏字体：记录已置 enabled，抛错可重试（负缓存不固化）', async () => {
    await listFontRecords(); // 先把库开到 v3（直写前 fonts store 须已存在）
    // 直写一条 enabled=false 的损坏记录（绕过 add 管线的先装载后入库门），再启用触发重建
    const corrupt: FontRecord = {
      id: 'font:corrupt0',
      name: 'Corrupt',
      family: 'Corrupt',
      kind: 'file',
      data: new Uint8Array([3]).buffer,
      size: 1,
      enabled: false,
      addedAt: 1
    };
    await rawPut(corrupt);
    failLoads = true;
    await expect(setEnabledFont(corrupt.id, true)).rejects.toThrow(/字体解析失败/);
    expect((await listFontRecords()).find((r) => r.id === corrupt.id)?.enabled).toBe(true);
  });
});

describe('删除与引用回落信号', () => {
  it('删除：记录移除 + document.fonts 注销；返回被删记录（消费方比对 name 回落槽位），未命中 null', async () => {
    const rec = await addFontFromFile(fileOf([1], 'B.ttf'));
    const gone = await deleteFont(rec.id);
    expect(gone?.name).toBe('B');
    expect(gone?.family).toBe('B');
    expect(fontSet.removed).toEqual([faces[0]]);
    expect(await listFontRecords()).toEqual([]);
    expect(await deleteFont(rec.id)).toBeNull();
  });
});

describe('loadEnabledFontFaces（启动恢复）', () => {
  it('仅 enabled 项注册；损坏项 warn 不阻断其余；停用项不注册', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const a = await addFontFromFile(fileOf([1], 'A.ttf'));
    const b = await addFontFromFile(fileOf([2], 'B.ttf'));
    await setEnabledFont(a.id, false);
    const corrupt: FontRecord = {
      id: 'font:corrupt1',
      name: 'Corrupt',
      family: 'Corrupt',
      kind: 'file',
      data: new Uint8Array([3]).buffer,
      size: 1,
      enabled: true,
      addedAt: 3
    };
    failLoads = true;
    await rawPut(corrupt);
    fontSet.added = [];
    await loadEnabledFontFaces(); // 不 reject
    // A 停用不注册；B 缓存命中注册；Corrupt 损坏 warn
    expect(fontSet.added).toEqual([faces.find((f) => f.family === '"B"')]);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(String(warnSpy.mock.calls[0])).toContain('Corrupt');
  });
});

describe('配额错误引导（settings center spec §2.2，评审 M-1）', () => {
  it('QuotaExceededError（含 _quota 变体）message 附「设置→存储与数据」清理引导，name 保留', () => {
    const q = new DOMException('The quota has been exceeded', 'QuotaExceededError');
    const wrapped = withQuotaGuidance(q) as Error;
    expect(wrapped.message).toContain('设置→存储与数据');
    expect(wrapped.message).toContain('清理空间');
    expect(wrapped.name).toBe('QuotaExceededError');
    const legacy = withQuotaGuidance(Object.assign(new Error('写入失败'), { name: '_quota' })) as Error;
    expect(legacy.message).toContain('设置→存储与数据');
    expect(legacy.name).toBe('_quota');
  });

  it('普通错误原样透传（同一对象返回，不含引导文案）', () => {
    const boom = new Error('boom');
    expect(withQuotaGuidance(boom)).toBe(boom);
    expect((withQuotaGuidance(new DOMException('未授权', 'InvalidStateError')) as Error).message).not.toContain('设置');
  });
});
