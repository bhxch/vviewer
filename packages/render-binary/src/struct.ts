// struct.ts — magic 识别与结构树解析（纯函数，无 DOM 依赖；Worker 与 jsdom 单测共用）。
// 时间预算：EOCD 反向扫描等潜在长循环每次迭代抽样检查 performance.now，
// 超预算即返回已构建的部分树并标记 truncated。
export interface StructNode {
  name: string;
  offset: number;
  size: number;
  value: string;
  children?: StructNode[];
}

export interface ParseOptions {
  /** 时间预算（ms），超时返回已构建部分 + truncated；默认 2000 */
  budgetMs?: number;
}

export interface ParseResult {
  root: StructNode | null;
  /** 因预算耗尽而中断（root 可能是部分结果） */
  truncated: boolean;
}

// ---- 定宽读取（越界返回 null，调用方跳过该字段） ----

function u16(b: Uint8Array, off: number, le: boolean): number | null {
  if (off + 2 > b.length) return null;
  return le ? b[off]! | (b[off + 1]! << 8) : (b[off]! << 8) | b[off + 1]!;
}

function u32(b: Uint8Array, off: number, le: boolean): number | null {
  if (off + 4 > b.length) return null;
  return le
    ? (b[off]! | (b[off + 1]! << 8) | (b[off + 2]! << 16) | (b[off + 3]! << 24)) >>> 0
    : ((b[off]! << 24) | (b[off + 1]! << 16) | (b[off + 2]! << 8) | b[off + 3]!) >>> 0;
}

function u64(b: Uint8Array, off: number, le: boolean): string | null {
  const hi = le ? u32(b, off + 4, true) : u32(b, off, false);
  const lo = le ? u32(b, off, true) : u32(b, off + 4, false);
  if (hi === null || lo === null) return null;
  // 值域远超 Number 安全范围的场景罕见，高低位拼接即可（精度损失可接受，仅展示用）
  return String(hi * 0x100000000 + lo);
}

function ascii(b: Uint8Array, off: number, len: number): string | null {
  if (off + len > b.length) return null;
  let out = '';
  for (let i = 0; i < len; i++) {
    const c = b[off + i]!;
    out += c >= 0x20 && c < 0x7f ? String.fromCharCode(c) : '.';
  }
  return out;
}

function hexSeq(b: Uint8Array, off: number, len: number): string | null {
  if (off + len > b.length) return null;
  const out: string[] = [];
  for (let i = 0; i < len; i++) out.push(b[off + i]!.toString(16).padStart(2, '0'));
  return out.join(' ');
}

function field(name: string, offset: number, size: number, value: string): StructNode {
  return { name, offset, size, value };
}

const ELF_MACHINES: Record<number, string> = {
  3: 'x86',
  8: 'MIPS',
  20: 'PowerPC',
  40: 'ARM',
  62: 'x86-64',
  183: 'AArch64',
  243: 'RISC-V'
};

const ELF_TYPES: Record<number, string> = {
  1: 'relocatable',
  2: 'executable',
  3: 'shared',
  4: 'core'
};

const PE_MACHINES: Record<number, string> = {
  0x014c: 'x86',
  0x01c0: 'ARM',
  0x8664: 'x64',
  0xaa64: 'ARM64'
};

const MACHO_CPUS: Record<number, string> = {
  7: 'x86',
  0x01000007: 'x86_64',
  12: 'ARM',
  0x0100000c: 'ARM64'
};

const MACHO_TYPES: Record<number, string> = {
  1: 'object',
  2: 'execute',
  5: 'core',
  6: 'dylib',
  8: 'bundle'
};

function parseEofScan(
  head: Uint8Array,
  outOfBudget: () => boolean
): { entries: number; cdSize: number; offset: number } | null {
  // EOCD 最短 22 字节 + 最长 65535 注释：从尾部窗口反向找 PK\5\6
  const sig = [0x50, 0x4b, 0x05, 0x06];
  const minStart = Math.max(0, head.length - 22 - 65535);
  for (let i = head.length - 22; i >= minStart; i--) {
    if ((i & 0x3ff) === 0 && outOfBudget()) return null;
    if (head[i] === sig[0] && head[i + 1] === sig[1] && head[i + 2] === sig[2] && head[i + 3] === sig[3]) {
      const entries = u16(head, i + 10, true);
      const cdSize = u32(head, i + 12, true);
      if (entries !== null && cdSize !== null) return { entries, cdSize, offset: i };
      return null;
    }
  }
  return null;
}

/**
 * 识别文件头 magic 并输出结构树。
 * 已识别：PNG / JPEG / GIF / PDF / ZIP / GZIP / ELF / PE / Mach-O；
 * 未识别返回 { root: null, truncated: false }。
 */
export function parseStruct(head: Uint8Array, opts: ParseOptions = {}): ParseResult {
  const budgetMs = opts.budgetMs ?? 2000;
  const start = now();
  let truncated = false;
  const outOfBudget = (): boolean => {
    if (performance.now() - start >= budgetMs) {
      truncated = true;
      return true;
    }
    return false;
  };

  // PNG：89 50 4E 47 0D 0A 1A 0A
  if (hexSeq(head, 0, 8) === '89 50 4e 47 0d 0a 1a 0a') {
    const children: StructNode[] = [field('signature', 0, 8, hexSeq(head, 0, 8) ?? '')];
    if (ascii(head, 12, 4) === 'IHDR') {
      const ihdr: StructNode = { name: 'IHDR', offset: 8, size: 21, value: 'image header', children: [
        field('width', 16, 4, String(u32(head, 16, false) ?? '')),
        field('height', 20, 4, String(u32(head, 20, false) ?? '')),
        field('bitDepth', 24, 1, String(head[24] ?? '')),
        field('colorType', 25, 1, String(head[25] ?? ''))
      ] };
      children.push(ihdr);
    }
    return { root: { name: 'PNG', offset: 0, size: 8, value: 'PNG image', children }, truncated };
  }

  // ELF：7F 'ELF'
  if (ascii(head, 1, 3) === 'ELF' && head[0] === 0x7f) {
    const bits = head[4] === 2 ? '64-bit' : head[4] === 1 ? '32-bit' : '';
    const endian = head[5] === 1 ? 'little' : head[5] === 2 ? 'big' : '';
    const entrySize = head[4] === 2 ? 8 : 4;
    const entry = entrySize === 8 ? (u64(head, 24, head[5] === 1) ?? '') : String(u32(head, 24, head[5] === 1) ?? '');
    const machine = u16(head, 18, head[5] === 1);
    const children = [
      field('magic', 0, 4, hexSeq(head, 0, 4) ?? ''),
      field('class', 4, 1, bits),
      field('endian', 5, 1, endian),
      field('type', 16, 2, ELF_TYPES[u16(head, 16, head[5] === 1) ?? -1] ?? String(u16(head, 16, head[5] === 1) ?? '')),
      field('machine', 18, 2, (machine !== null && ELF_MACHINES[machine]) || (machine === null ? '' : String(machine))),
      field('entry', 24, entrySize, entry)
    ];
    return { root: { name: 'ELF', offset: 0, size: 16 + entrySize, value: 'ELF', children }, truncated };
  }

  // PE/MZ：'MZ' + 可选 e_lfanew → 'PE\0\0'
  if (ascii(head, 0, 2) === 'MZ') {
    const children: StructNode[] = [field('dosMagic', 0, 2, 'MZ')];
    const lfanew = u32(head, 0x3c, true);
    const peSig = lfanew !== null && lfanew + 4 <= head.length
      && head[lfanew] === 0x50 && head[lfanew + 1] === 0x45 && head[lfanew + 2] === 0 && head[lfanew + 3] === 0;
    if (peSig) {
      const machine = u16(head, lfanew + 4, true);
      const pe: StructNode = { name: 'PEHeader', offset: lfanew, size: 20, value: 'PE signature + header', children: [
        field('machine', lfanew + 4, 2, (machine !== null && PE_MACHINES[machine]) || String(machine ?? '')),
        field('numberOfSections', lfanew + 6, 2, String(u16(head, lfanew + 6, true) ?? '')),
        field('timestamp', lfanew + 8, 4, String(u32(head, lfanew + 8, true) ?? ''))
      ] };
      children.push(pe);
    }
    return { root: { name: 'PE', offset: 0, size: 2, value: 'DOS/PE executable', children }, truncated };
  }

  // ZIP：PK\3\4（EOCD 扫描受预算约束）
  if (u32(head, 0, true) === 0x04034b50) {
    const method = u16(head, 8, true);
    const children: StructNode[] = [
      field('localMagic', 0, 4, hexSeq(head, 0, 4) ?? ''),
      field('version', 4, 2, String(u16(head, 4, true) ?? '')),
      field('flags', 6, 2, `0x${(u16(head, 6, true) ?? 0).toString(16).padStart(4, '0')}`),
      field('method', 8, 2, method === 0 ? 'stored' : method === 8 ? 'deflate' : String(method ?? ''))
    ];
    if (!outOfBudget()) {
      const eocd = parseEofScan(head, outOfBudget);
      if (eocd) {
        children.push({
          name: 'EOCD',
          offset: eocd.offset,
          size: 22,
          value: 'end of central directory',
          children: [
            field('entries', eocd.offset + 10, 2, String(eocd.entries)),
            field('centralDirectorySize', eocd.offset + 12, 4, String(eocd.cdSize))
          ]
        });
      }
    }
    if (outOfBudget()) return { root: { name: 'ZIP', offset: 0, size: 30, value: 'zip archive', children }, truncated };
    return { root: { name: 'ZIP', offset: 0, size: 30, value: 'zip archive', children }, truncated };
  }

  // GZIP：1F 8B
  if (head[0] === 0x1f && head[1] === 0x8b) {
    const mtime = u32(head, 4, true);
    const children = [
      field('magic', 0, 2, hexSeq(head, 0, 2) ?? ''),
      field('method', 2, 1, head[2] === 8 ? 'deflate' : String(head[2] ?? '')),
      field('flags', 3, 1, `0x${(head[3] ?? 0).toString(16).padStart(2, '0')}`),
      field('mtime', 4, 4, mtime ? new Date(mtime * 1000).toISOString() : '0'),
      field('os', 9, 1, String(head[9] ?? ''))
    ];
    return { root: { name: 'GZIP', offset: 0, size: 10, value: 'gzip', children }, truncated };
  }

  // JPEG：FF D8 FF (+ APPn)
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) {
    const children: StructNode[] = [field('soi', 0, 2, 'ff d8')];
    const marker = head[3];
    if (marker !== undefined && marker >= 0xe0 && marker <= 0xef) {
      const name = `APP${marker - 0xe0}`;
      const ident = ascii(head, 6, 4); // length(2) 后的标识前 4 字符（JFIF/Exif...）
      children.push(field('marker', 2, 2 + (u16(head, 4, false) ?? 0), `${name} ${ident === null ? '' : ident.replace(/\.$/, '')}`));
    }
    return { root: { name: 'JPEG', offset: 0, size: 2, value: 'JPEG image', children }, truncated };
  }

  // GIF：GIF87a / GIF89a
  if (ascii(head, 0, 6) === 'GIF87a' || ascii(head, 0, 6) === 'GIF89a') {
    const flags = head[10] ?? 0;
    const children = [
      field('version', 0, 6, ascii(head, 0, 6) ?? ''),
      field('width', 6, 2, String(u16(head, 6, true) ?? '')),
      field('height', 8, 2, String(u16(head, 8, true) ?? '')),
      field('flags', 10, 1, `${flags & 0x80 ? 'GCT' : 'no-GCT'} colorBits=${(flags & 0x70) >> 4}`)
    ];
    return { root: { name: 'GIF', offset: 0, size: 13, value: 'GIF image', children }, truncated };
  }

  // PDF：'%PDF-x.y'
  if (ascii(head, 0, 5) === '%PDF-') {
    const children = [
      field('header', 0, 8, ascii(head, 0, 8) ?? ''),
      field('version', 5, 3, ascii(head, 5, 3) ?? '')
    ];
    return { root: { name: 'PDF', offset: 0, size: 8, value: 'PDF document', children }, truncated };
  }

  // Mach-O / fat binary
  const magic = u32(head, 0, false);
  const macho: Record<number, { le: boolean; bits: string }> = {
    0xfeedface: { le: false, bits: '32-bit' },
    0xfeedfacf: { le: false, bits: '64-bit' },
    0xcefaedfe: { le: true, bits: '32-bit' },
    0xcffaedfe: { le: true, bits: '64-bit' }
  };
  const m = magic !== null ? macho[magic] : undefined;
  if (m) {
    const cpu = u32(head, 4, m.le);
    const ncmds = u32(head, 16, m.le);
    const ftype = u32(head, 12, m.le);
    const children = [
      field('magic', 0, 4, hexSeq(head, 0, 4) ?? ''),
      field('bits', 4, 0, m.bits),
      field('cpuType', 4, 4, (cpu !== null && MACHO_CPUS[cpu]) || String(cpu ?? '')),
      field('filetype', 12, 4, MACHO_TYPES[ftype ?? -1] ?? String(ftype ?? '')),
      field('loadCommands', 16, 4, String(ncmds ?? ''))
    ];
    return { root: { name: 'Mach-O', offset: 0, size: 32, value: 'Mach-O binary', children }, truncated };
  }
  if (magic === 0xcafebabe) {
    return {
      root: { name: 'Mach-O', offset: 0, size: 4, value: 'fat binary / Java class', children: [field('magic', 0, 4, hexSeq(head, 0, 4) ?? '')] },
      truncated
    };
  }

  return { root: null, truncated };
}

/** 测试可注入的时钟（performance 全局在 Node/jsdom/Worker 均存在） */
const now = (): number => performance.now();
