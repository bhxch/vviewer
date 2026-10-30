import { describe, it, expect } from 'vitest';
import { detectEncoding, isStrictUtf8 } from '../src/detect/encoding';

describe('detectEncoding', () => {
  it('BOM wins', () => {
    expect(detectEncoding(new Uint8Array([0xef,0xbb,0xbf,0x61]))).toBe('utf-8');
    expect(detectEncoding(new Uint8Array([0xff,0xfe,0x61,0]))).toBe('utf-16le');
    expect(detectEncoding(new Uint8Array([0xfe,0xff,0,0x61]))).toBe('utf-16be');
  });
  it('valid utf-8 (no BOM)', () => {
    expect(detectEncoding(new TextEncoder().encode('hello 世界'))).toBe('utf-8');
  });
  it('invalid utf-8 falls back to gb18030', () => {
    // "中文" 的 GB18030 编码字节（非合法 UTF-8 序列）
    expect(detectEncoding(new Uint8Array([0xd6,0xd0,0xce,0xc4]))).toBe('gb18030');
  });
});

describe('isStrictUtf8（RFC 3629 边界表驱动）', () => {
  const cases: Array<[string, number[], boolean]> = [
    // [描述（标注命中分支）, 字节, 期望]
    ['overlong: C0 80（2 字节超长编码 U+0000）', [0xc0, 0x80], false],
    ['overlong: E0 80 80（3 字节超长编码 U+0000）', [0xe0, 0x80, 0x80], false],
    ['surrogate: ED A0 80（UTF-16 代理区 U+D800）', [0xed, 0xa0, 0x80], false],
    ['truncated: E4 B8（3 字节序列截断）', [0xe4, 0xb8], false],
    ['lead: 0x80（延续字节单独出现，无合法 lead）', [0x80], false],
    ['lead: 0xF8（RFC 3629 禁止的 5 字节前缀）', [0xf8], false],
    ['bound: F7 BF BF BF（解码超出 U+10FFFF）', [0xf7, 0xbf, 0xbf, 0xbf], false],
    ['valid: F0 9F 98 80（合法 4 字节 😀 U+1F600）', [0xf0, 0x9f, 0x98, 0x80], true],
  ];
  it.each(cases)('%s', (_name, bytes, expected) => {
    expect(isStrictUtf8(new Uint8Array(bytes))).toBe(expected);
  });
});
