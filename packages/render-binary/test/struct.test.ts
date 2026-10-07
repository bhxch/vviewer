// struct.test.ts — parseStruct magic 结构树单测。
// 全部用真实 magic 字节手工构造头（不依赖任何样例文件），断言字段名/偏移/值与预算截断。
import { describe, expect, it } from 'vitest';
import { parseStruct, type StructNode } from '../src/struct';

/** 查找指定名字的节点（深度优先） */
function find(node: StructNode | null, name: string): StructNode | undefined {
  if (!node) return undefined;
  if (node.name === name) return node;
  for (const c of node.children ?? []) {
    const hit = find(c, name);
    if (hit) return hit;
  }
  return undefined;
}

describe('parseStruct: PNG', () => {
  // 89 50 4E 47 0D 0A 1A 0A + IHDR chunk：len(4)+type(4)+width(4 BE)+height(4 BE)+bd+ct+c+f+il+CRC(4)
  const png = new Uint8Array([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, // signature
    0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, // IHDR length + type
    0, 0, 0x7a, 0x69, // width = 31337 (BE)
    0, 0, 0x04, 0x00, // height = 1024 (BE)
    8, 6, 0, 0, 0, // bitDepth=8 colorType=6 compression filter interlace
    0, 0, 0, 0 // CRC
  ]);

  it('识别 PNG 并解析出 IHDR 宽高/位深/颜色类型', () => {
    const { root, truncated } = parseStruct(png);
    expect(truncated).toBe(false);
    expect(root?.name).toBe('PNG');
    expect(find(root, 'width')?.value).toBe('31337');
    expect(find(root, 'height')?.value).toBe('1024');
    expect(find(root, 'bitDepth')?.value).toBe('8');
    expect(find(root, 'colorType')?.value).toBe('6');
  });

  it('signature 节点带偏移与十六进制值', () => {
    const { root } = parseStruct(png);
    const sig = find(root, 'signature');
    expect(sig?.offset).toBe(0);
    expect(sig?.size).toBe(8);
    expect(sig?.value).toContain('89 50 4e');
  });
});

describe('parseStruct: ELF', () => {
  // 7F ELF + class=2(64bit) data=1(LE) version=1 osabi=0 + pad(7) + type=2(exec) + machine=62(x86-64)
  const elf = new Uint8Array(64);
  elf.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0], 0);
  const dv = new DataView(elf.buffer);
  dv.setUint16(16, 2, true); // type = EXEC
  dv.setUint16(18, 62, true); // machine = x86-64
  dv.setUint32(24, 0x401000, true); // entry

  it('识别 ELF 并解析 class/endian/machine/entry', () => {
    const { root } = parseStruct(elf);
    expect(root?.name).toBe('ELF');
    expect(find(root, 'class')?.value).toBe('64-bit');
    expect(find(root, 'endian')?.value).toBe('little');
    expect(find(root, 'machine')?.value).toBe('x86-64');
    expect(find(root, 'entry')?.value).toBe('4198400');
  });
});

describe('parseStruct: PE', () => {
  // 'MZ' DOS 头 + e_lfanew(0x3C, LE) 指向 'PE\0\0' + machine(0x8664) + sections + timestamp
  const pe = new Uint8Array(0x40 + 24);
  pe.set([0x4d, 0x5a], 0); // 'MZ'
  const dv = new DataView(pe.buffer);
  dv.setUint32(0x3c, 0x40, true); // e_lfanew = 0x40
  pe.set([0x50, 0x45, 0, 0], 0x40); // 'PE\0\0'
  dv.setUint16(0x44, 0x8664, true); // machine = x64
  dv.setUint16(0x46, 6, true); // numberOfSections
  dv.setUint32(0x48, 0x5f5e1000, true); // timeDateStamp

  it('识别 PE 并沿 e_lfanew 解析 machine/sections/timestamp', () => {
    const { root } = parseStruct(pe);
    expect(root?.name).toBe('PE');
    expect(find(root, 'dosMagic')?.value).toBe('MZ');
    expect(find(root, 'machine')?.value).toBe('x64');
    expect(find(root, 'numberOfSections')?.value).toBe('6');
    expect(find(root, 'timestamp')?.value).toBe('1600000000');
  });

  it('e_lfanew 指向非 PE 签名时仍输出 DOS 头（不伪造 PE 子节点）', () => {
    const dos = new Uint8Array(0x40);
    dos.set([0x4d, 0x5a], 0);
    const { root } = parseStruct(dos);
    expect(root?.name).toBe('PE');
    expect(find(root, 'machine')).toBeUndefined();
  });
});

describe('parseStruct: ZIP', () => {
  // local file header PK\3\4 + 版本/标志/方法 + EOCD PK\5\6（本例 head=完整文件）
  const zip = new Uint8Array(64);
  zip.set([0x50, 0x4b, 0x03, 0x04, 20, 0, 0, 0, 8, 0], 0); // PK0304 ver=20 flags=0 method=deflate
  const dv = new DataView(zip.buffer);
  const eocd = 40;
  dv.setUint32(eocd, 0x06054b50, true); // PK0506
  dv.setUint16(eocd + 10, 3, true); // entries = 3
  dv.setUint32(eocd + 12, 0x1234, true); // cd size
  dv.setUint32(eocd + 16, eocd, true); // cd offset

  it('识别 ZIP 并解析 local header 与 EOCD 条目数/大小', () => {
    const { root } = parseStruct(zip);
    expect(root?.name).toBe('ZIP');
    expect(find(root, 'method')?.value).toBe('deflate');
    expect(find(root, 'entries')?.value).toBe('3');
    expect(find(root, 'centralDirectorySize')?.value).toBe('4660');
  });
});

describe('parseStruct: 其余 magic', () => {
  it('GZ：方法 deflate、mtime', () => {
    const gz = new Uint8Array([0x1f, 0x8b, 8, 0, 0x68, 0x19, 0, 0, 0, 3]);
    const { root } = parseStruct(gz);
    expect(root?.name).toBe('GZIP');
    expect(find(root, 'method')?.value).toBe('deflate');
    expect(find(root, 'mtime')?.value).not.toBe('');
  });

  it('JPEG：SOI + APP0 JFIF', () => {
    const jpg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 2, 0]);
    const { root } = parseStruct(jpg);
    expect(root?.name).toBe('JPEG');
    expect(find(root, 'marker')?.value).toContain('JFIF');
  });

  it('GIF：版本与逻辑屏幕尺寸（LE）', () => {
    const gif = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x0a, 0, 0x14, 0, 0xf7, 0]);
    const { root } = parseStruct(gif);
    expect(root?.name).toBe('GIF');
    expect(find(root, 'version')?.value).toBe('GIF89a');
    expect(find(root, 'width')?.value).toBe('10');
    expect(find(root, 'height')?.value).toBe('20');
  });

  it('PDF：版本字符串', () => {
    const pdf = new TextEncoder().encode('%PDF-1.7\n%\xe2\xe3\xcf\xd3');
    const { root } = parseStruct(pdf);
    expect(root?.name).toBe('PDF');
    expect(find(root, 'version')?.value).toBe('1.7');
  });

  it('Mach-O：64-bit LE（cf fa ed fe）与 cputype', () => {
    const mo = new Uint8Array(32);
    mo.set([0xcf, 0xfa, 0xed, 0xfe], 0);
    const dv = new DataView(mo.buffer);
    dv.setUint32(4, 0x01000007, true); // cputype = x86_64
    dv.setUint32(16, 5, true); // ncmds
    const { root } = parseStruct(mo);
    expect(root?.name).toBe('Mach-O');
    expect(find(root, 'bits')?.value).toBe('64-bit');
    expect(find(root, 'cpuType')?.value).toBe('x86_64');
    expect(find(root, 'loadCommands')?.value).toBe('5');
  });

  it('未知 magic 返回 root null', () => {
    const { root } = parseStruct(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]));
    expect(root).toBeNull();
  });

  it('头过短（magic 不完整）返回 root null 不抛错', () => {
    expect(parseStruct(new Uint8Array([0x89, 0x50])).root).toBeNull();
  });
});

describe('parseStruct: 时间预算', () => {
  it('budgetMs 到期返回已构建部分并标记 truncated', () => {
    // ZIP + 一段长 padding + 末尾 EOCD：EOCD 反向扫描耗预算
    const zip = new Uint8Array(128 * 1024);
    zip.set([0x50, 0x4b, 0x03, 0x04, 20, 0, 0, 0, 8, 0], 0);
    const dv = new DataView(zip.buffer);
    const eocd = zip.length - 22;
    dv.setUint32(eocd, 0x06054b50, true);
    dv.setUint16(eocd + 10, 1, true);
    const { root, truncated } = parseStruct(zip, { budgetMs: 0 });
    // budgetMs=0：首轮检查即到期 → local header 也未必输出，但必须标 truncated
    expect(truncated).toBe(true);
    expect(root === null || root.name === 'ZIP').toBe(true);
  });

  it('默认预算内正常解析不被截断', () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
    const { truncated } = parseStruct(png);
    expect(truncated).toBe(false);
  });
});
