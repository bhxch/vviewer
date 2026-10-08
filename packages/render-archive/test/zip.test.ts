// zip.test.ts — zipStore/archiveRenderer 单测：jszip 造内存 zip，断言目录聚合/自然排序/read/
// 真实递归深度接线（经 source.storeId 推导，非手工传参）/深度限制放宽语义/错误转换。
// jszip 不支持生成加密 zip：加密错误路径以导出的 normalizeZipError 纯函数直接断言；
// BUG-12 混合加密包以「jszip 生成 + 翻转通用标志 bit0」模拟（加密条目数据不变——
// store 层逐条拦截不解密；明文条目经 libarchive worker 真实读取验证兜底管线）。
import { describe, expect, it, vi } from 'vitest';
import type { Detection, FileSource, TreeNode } from '@vviewer/core';
import { archiveRenderer } from '../src/archive';
import { ARCHIVE_OPEN_EVENT, type ArchiveOpenDetail } from '../src/archive';
import { createZipStore, normalizeZipError, archiveChainOf, parseZipCentralDirectory } from '../src/zipStore';

async function makeZip(): Promise<Uint8Array> {
  const JSZip = (await import('jszip')).default;
  const zip = new JSZip();
  zip.file('hello.txt', 'hello vviewer');
  zip.file('z10.txt', 'natural sort');
  zip.file('z9.txt', 'natural sort');
  zip.file('nested/inner.txt', 'inner content');
  zip.file('nested/deep/leaf.md', '# leaf');
  zip.folder('empty-dir');
  const bytes = await zip.generateAsync({ type: 'uint8array' });
  return bytes;
}

describe('createZipStore', () => {
  it('listChildren 根层：目录优先 + 自然排序 + 虚拟目录聚合', async () => {
    const store = await createZipStore(await makeZip());
    const kids = await store.listChildren('');
    expect(kids.map((n: TreeNode) => `${n.kind}:${n.name}`)).toEqual([
      'dir:empty-dir',
      'dir:nested',
      'file:hello.txt',
      'file:z9.txt',
      'file:z10.txt' // 自然排序：z9 < z10
    ]);
  });

  it('listChildren 子目录层级', async () => {
    const store = await createZipStore(await makeZip());
    const nested = await store.listChildren('nested');
    expect(nested.map((n) => `${n.kind}:${n.name}`)).toEqual(['dir:deep', 'file:inner.txt']);
    const deep = await store.listChildren('nested/deep');
    expect(deep.map((n) => n.name)).toEqual(['leaf.md']);
    // 文件节点带 size
    expect(nested.find((n) => n.name === 'inner.txt')?.size).toBe('inner content'.length);
  });

  it('read 返回条目原始字节', async () => {
    const store = await createZipStore(await makeZip());
    const bytes = await store.read('hello.txt');
    expect(new TextDecoder().decode(bytes)).toBe('hello vviewer');
  });

  it('read 目录条目/未知路径抛错', async () => {
    const store = await createZipStore(await makeZip());
    await expect(store.read('nested')).rejects.toThrow('目录');
    await expect(store.read('no/such.txt')).rejects.toThrow('未知路径');
  });

  it('displayName 与 id：顶层为 zip:<名字>', async () => {
    const store = await createZipStore(await makeZip(), undefined, 'bundle.zip');
    expect(store.displayName()).toBe('bundle.zip');
    expect(store.id).toMatch(/^zip:bundle\.zip$/);
  });

  it('parentChain 体现嵌套层级 id', async () => {
    const inner = await createZipStore(await makeZip(), 'zip');
    expect(inner.id).toMatch(/^zip:zip:/);
    const deepest = await createZipStore(await makeZip(), 'zip:zip');
    expect(deepest.id).toMatch(/^zip:zip:zip:/);
  });

  it('archiveChainOf：由 store id 前导归档段推导内层父链', () => {
    expect(archiveChainOf('zip:outer.zip')).toBe('zip');
    expect(archiveChainOf('zip:zip:inner.zip')).toBe('zip:zip');
    expect(archiveChainOf('zip:zip:zip:deep.zip')).toBe('zip:zip:zip');
    expect(archiveChainOf('localfiles:samples')).toBe('');
    expect(archiveChainOf('single:foo.zip')).toBe('');
  });

  it('depth ≥3 的 store：内嵌 zip 条目 read 抛"嵌套层数超限"，普通条目放行', async () => {
    const JSZip = (await import('jszip')).default;
    const inner = new JSZip();
    inner.file('plain.txt', 'still readable');
    const nested = new JSZip();
    nested.file('x.txt', 'x');
    inner.file('nested.zip', await nested.generateAsync({ type: 'uint8array' }));
    const store = await createZipStore(await inner.generateAsync({ type: 'uint8array' }), 'zip:zip:zip');
    await expect(store.read('plain.txt')).resolves.toBeInstanceOf(Uint8Array);
    await expect(store.read('nested.zip')).rejects.toThrow('嵌套层数超限');
  });

  it('超 200MB 输入直接拒绝', async () => {
    const fake = { length: 201 * 1024 * 1024 } as Uint8Array;
    await expect(createZipStore(fake)).rejects.toThrow('200MB');
  });
});

describe('normalizeZipError', () => {
  it('加密条目错误转换为中文提示', () => {
    const converted = normalizeZipError(new Error('Encrypted ZIP: file is encrypted with unsupported algorithm'));
    expect(converted).toBeInstanceOf(Error);
    expect((converted as Error).message).toBe('该条目已加密，无法解密预览');
  });

  it('其他错误原样透传', () => {
    const err = new Error('corrupt zip');
    expect(normalizeZipError(err)).toBe(err);
    expect(normalizeZipError('boom')).toBe('boom');
  });
});

// ---------- BUG-12：混合加密包（中心目录自解析 + 逐条加密标记 + 明文兜底读取） ----------

const u16 = (b: Uint8Array, o: number): number => b[o]! | (b[o + 1]! << 8);
const u32 = (b: Uint8Array, o: number): number =>
  (b[o]! | (b[o + 1]! << 8) | (b[o + 2]! << 16) | (b[o + 3]! << 24)) >>> 0;
const setU16 = (b: Uint8Array, o: number, v: number): void => {
  b[o] = v & 0xff;
  b[o + 1] = (v >> 8) & 0xff;
};

/** jszip 生成 zip 后按名翻转通用标志 bit0（local header + central directory 同步），
 * 模拟 ZipCrypto 混合包（加密条目数据保持原样——store 层拦截不解密，仅供树/标记断言） */
async function makeMixedZip(
  files: Record<string, string | Uint8Array>,
  encryptedNames: string[]
): Promise<Uint8Array> {
  const JSZip = (await import('jszip')).default;
  const zip = new JSZip();
  for (const [n, c] of Object.entries(files)) zip.file(n, c);
  const bytes = await zip.generateAsync({ type: 'uint8array' });
  const enc = new Set(encryptedNames);
  const decode = (o: number, len: number): string => new TextDecoder().decode(bytes.subarray(o, o + len));
  // local headers：PK\x03\x04（flag@6，nameLen@26，extraLen@28，name@30，后随 data；
  // data 长度 = compressedSize，uncompressedSize 不占空间）
  let off = 0;
  while (off + 4 <= bytes.length && bytes[off] === 0x50 && bytes[off + 1] === 0x4b && bytes[off + 2] === 0x03) {
    const nameLen = u16(bytes, off + 26);
    const extraLen = u16(bytes, off + 28);
    if (enc.has(decode(off + 30, nameLen))) setU16(bytes, off + 6, u16(bytes, off + 6) | 1);
    off += 30 + nameLen + extraLen + u32(bytes, off + 18);
  }
  // central directories：PK\x01\x02（flag@8，nameLen@28，extraLen@30，commentLen@32，name@46）
  while (off + 4 <= bytes.length && bytes[off] === 0x50 && bytes[off + 1] === 0x4b && bytes[off + 2] === 0x01) {
    const nameLen = u16(bytes, off + 28);
    const extraLen = u16(bytes, off + 30);
    const commentLen = u16(bytes, off + 32);
    if (enc.has(decode(off + 46, nameLen))) setU16(bytes, off + 8, u16(bytes, off + 8) | 1);
    off += 46 + nameLen + extraLen + commentLen;
  }
  return bytes;
}

describe('parseZipCentralDirectory（BUG-12 中心目录自解析）', () => {
  it('产出条目大小表与加密路径集；目录条目不参与加密标记', async () => {
    const buffer = await makeMixedZip(
      { 'plain/open.txt': 'open content', 'secret/locked.txt': 'locked', 'empty-dir/': '' },
      ['secret/locked.txt']
    );
    const dir = parseZipCentralDirectory(buffer);
    expect(dir.sizes.get('plain/open.txt')).toBe('open content'.length);
    expect(dir.sizes.get('secret/locked.txt')).toBe('locked'.length);
    expect(dir.sizes.get('empty-dir')).toBe(-1);
    expect(dir.encryptedPaths).toEqual(new Set(['secret/locked.txt']));
  });

  it('带注释的 zip：EOCD 从尾部向前扫描命中（注释可含任意字节）', async () => {
    const JSZip = (await import('jszip')).default;
    const zip = new JSZip();
    zip.file('a.txt', 'aaa');
    const buffer = await zip.generateAsync({ type: 'uint8array', comment: 'PK\x03\x04 fake sig inside comment' });
    const dir = parseZipCentralDirectory(buffer);
    expect(dir.sizes.get('a.txt')).toBe(3);
    expect(dir.encryptedPaths.size).toBe(0);
  });

  it('EOCD 缺失抛「无法定位 zip 中心目录」；ZIP64 哨兵抛「ZIP64 暂不支持」', () => {
    expect(() => parseZipCentralDirectory(new TextEncoder().encode('not a zip at all...........'))).toThrow(
      '无法定位 zip 中心目录'
    );
    // 手工构造 EOCD（cdOffset=0xFFFFFFFF 哨兵）
    const eocd = new Uint8Array(22);
    eocd.set([0x50, 0x4b, 0x05, 0x06], 0);
    eocd.set([0xff, 0xff], 16); // cdOffset 低 16 位
    eocd.set([0xff, 0xff], 18);
    expect(() => parseZipCentralDirectory(eocd)).toThrow('ZIP64');
  });
});

describe('createZipStore 混合加密包（BUG-12：不整包拒绝，明文可读、加密逐条拦截）', () => {
  it('条目树完整 + encrypted 逐条标记（plain/ 与 secret/ 均在树中）', async () => {
    const store = await createZipStore(
      await makeMixedZip({ 'plain/open.txt': 'open content', 'secret/locked.txt': 'locked' }, ['secret/locked.txt'])
    );
    const kids = await store.listChildren('');
    expect(kids.map((n: TreeNode) => `${n.kind}:${n.name}`)).toEqual(['dir:plain', 'dir:secret']);
    const plain = await store.listChildren('plain');
    expect(plain[0]).toMatchObject({ name: 'open.txt', kind: 'file' });
    expect(plain[0]!.encrypted).toBeUndefined();
    const secret = await store.listChildren('secret');
    expect(secret[0]).toMatchObject({ name: 'locked.txt', kind: 'file', encrypted: true });
  });

  it('明文条目经 libarchive 兜底读取返回原始内容；加密条目 read 抛「加密不支持预览」', async () => {
    const store = await createZipStore(
      await makeMixedZip({ 'plain/open.txt': 'open content', 'secret/locked.txt': 'locked' }, ['secret/locked.txt'])
    );
    const open = await store.read('plain/open.txt');
    expect(new TextDecoder().decode(open)).toBe('open content');
    await expect(store.read('secret/locked.txt')).rejects.toThrow('该条目已加密，无法解密预览');
    await expect(store.read('nope.txt')).rejects.toThrow('未知路径');
  });

  it('全加密包：整包不拒绝、树完整、条目全部标记并拒绝读取', async () => {
    const store = await createZipStore(
      await makeMixedZip({ 'a.txt': 'aaa', 'b.txt': 'bb' }, ['a.txt', 'b.txt'])
    );
    const kids = await store.listChildren('');
    expect(kids).toHaveLength(2);
    expect(kids.every((n: TreeNode) => n.encrypted === true)).toBe(true);
    await expect(store.read('a.txt')).rejects.toThrow('该条目已加密');
  });

  it('id 与嵌套链同构（zip:zip:…），depth 届满对内嵌归档条目同样拒展', async () => {
    const JSZip = (await import('jszip')).default;
    const inner = new JSZip();
    inner.file('x.txt', 'x');
    const innerBytes = await inner.generateAsync({ type: 'uint8array' });
    const mixed = await makeMixedZip(
      { 'plain.txt': 'readable', 'too-deep.zip': innerBytes, 'secret/locked.txt': 'locked' },
      ['secret/locked.txt']
    );
    const store = await createZipStore(mixed, 'zip:zip:zip');
    expect(store.id).toMatch(/^zip:zip:zip:zip:/);
    await expect(store.read('plain.txt')).resolves.toBeInstanceOf(Uint8Array);
    await expect(store.read('too-deep.zip')).rejects.toThrow('嵌套层数超限');
    await expect(store.read('secret/locked.txt')).rejects.toThrow('该条目已加密');
    // worker 资源：混合包 store 有 close（接线语义与 libarchive store 一致）
    store.close?.();
  });

  it('树 UI 对加密条目显示 🔒 锁形标记', async () => {
    const buffer = await makeMixedZip(
      { 'plain/open.txt': 'open content', 'secret/locked.txt': 'locked' },
      ['secret/locked.txt']
    );
    const target = document.createElement('div');
    document.body.append(target);
    const source: FileSource = {
      storeId: 'localfiles:samples', storeLabel: 'samples', path: 'mixed.zip', name: 'mixed.zip',
      store: { id: 'localfiles:samples', displayName: () => 'samples', listChildren: async () => [], read: async () => buffer }
    };
    const instance = await archiveRenderer.render(buffer, target, source, { ext: 'zip' } as Detection);
    try {
      // 展开 secret/ 目录后断言 🔒（懒展开：details toggle；plain/ 无标记为对照）
      await vi.waitFor(async () => {
        const details = [...target.querySelectorAll('details')].find((d) => d.textContent?.includes('secret'));
        if (!details) throw new Error('secret 目录未渲染');
        details.open = true;
        await new Promise((r) => setTimeout(r, 0));
        const lockedRow = [...target.querySelectorAll('button.vv-tree-row')].find((b) =>
          b.textContent?.includes('locked.txt')
        );
        if (!lockedRow) throw new Error('locked.txt 未渲染');
        expect(lockedRow.textContent).toContain('🔒');
      });
    } finally {
      instance.destroy();
      target.remove();
    }
  });
});

describe('archiveRenderer：真实递归路径（depth 由 source.storeId 接线）', () => {
  interface Zipped { bytes: Uint8Array }
  async function zipOf(files: Record<string, string | Zipped>): Promise<Uint8Array> {
    const JSZip = (await import('jszip')).default;
    const zip = new JSZip();
    for (const [name, content] of Object.entries(files)) {
      zip.file(name, typeof content === 'string' ? content : content.bytes);
    }
    return zip.generateAsync({ type: 'uint8array' });
  }

  /** 模拟 ViewerPane：render 后点击指定条目行，捕获派发的 vv-open-entry detail。
   * name 模拟真实链路中 addTab 写入的条目名（archiveRenderer 用它做 store id 尾段）。 */
  async function renderAndClick(
    buffer: Uint8Array,
    storeId: string,
    clickName: string
  ): Promise<ArchiveOpenDetail> {
    const target = document.createElement('div');
    document.body.append(target);
    const source: FileSource = {
      storeId,
      storeLabel: 'zip-test',
      path: clickName,
      name: clickName,
      store: { id: storeId, displayName: () => 'zip-test', listChildren: async () => [], read: async () => buffer }
    };
    const det = { ext: 'zip' } as Detection;
    const details: ArchiveOpenDetail[] = [];
    const onOpen = (ev: Event): void => {
      details.push((ev as CustomEvent<ArchiveOpenDetail>).detail);
    };
    window.addEventListener(ARCHIVE_OPEN_EVENT, onOpen);
    const instance = await archiveRenderer.render(buffer, target, source, det);
    try {
      await vi.waitFor(() => {
        const row = [...target.querySelectorAll('button.vv-tree-row')].find((b) =>
          b.textContent?.includes(clickName)
        );
        if (!row) throw new Error(`条目未渲染: ${clickName}`);
        (row as HTMLButtonElement).click();
      });
      expect(details.length).toBeGreaterThan(0);
      return details[0]!;
    } finally {
      window.removeEventListener(ARCHIVE_OPEN_EVENT, onOpen);
      instance.destroy();
      target.remove();
    }
  }

  it('四层嵌套：depth 逐层接线，第 3 层 store 拒展内嵌 zip、普通文件可读', async () => {
    // L3（depth3）：普通文件 + 再嵌 zip（应被拒展）
    const l3 = await zipOf({ 'plain.txt': 'readable', 'too-deep.zip': { bytes: await zipOf({ x: 'x' }) } });
    // L2：deep.txt + L3
    const l2 = await zipOf({ 'deep.txt': 'deep', 'inner3.zip': { bytes: l3 } });
    // L1：inner2.zip 指向 L2
    const l1 = await zipOf({ 'inner2.zip': { bytes: l2 } });
    // L0：top.txt + L1
    const l0 = await zipOf({ 'top.txt': 'top', 'inner1.zip': { bytes: l1 } });

    // 顶层打开（非 zip 来源 store）：树含 inner1.zip，点击得 depth0 store；其 read 取出 L1 字节
    const d0 = await renderAndClick(l0, 'localfiles:samples', 'inner1.zip');
    expect(d0.store.id).toBe('zip:inner1.zip'); // 顶层 zip 以自身文件名入 id
    const l1Bytes = await d0.store.read('inner1.zip');

    // 打开 inner1.zip（source.storeId 已是 zip 来源）：点击 inner2.zip → depth1 store
    const d1 = await renderAndClick(l1Bytes, d0.store.id, 'inner2.zip');
    expect(d1.store.id).toBe('zip:zip:inner2.zip');
    const l2Bytes = await d1.store.read('inner2.zip'); // depth1 可读内嵌 zip

    // 打开 inner2.zip：点击 inner3.zip → depth2 store
    const d2 = await renderAndClick(l2Bytes, d1.store.id, 'inner3.zip');
    expect(d2.store.id).toBe('zip:zip:zip:inner3.zip');
    const l3Bytes = await d2.store.read('inner3.zip'); // depth2 仍可读内嵌 zip

    // 打开 inner3.zip（depth3 store）：普通条目放行、内嵌 zip 条目受限
    const d3 = await renderAndClick(l3Bytes, d2.store.id, 'too-deep.zip');
    expect(d3.store.id).toMatch(/^zip:zip:zip:zip:/);
    await expect(d3.store.read('plain.txt')).resolves.toBeInstanceOf(Uint8Array);
    await expect(d3.store.read('too-deep.zip')).rejects.toThrow('嵌套层数超限');
  });
});
