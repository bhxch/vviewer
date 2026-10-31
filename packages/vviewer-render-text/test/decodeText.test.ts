import { describe, expect, it } from 'vitest';
import { decodeText } from '../src/decodeText';

describe('decodeText 单源（议题三 §4.2）', () => {
  it('utf-32le：BOM 剥离 + LE 码元解码', () => {
    // BOM(FF FE 00 00) + 'A'(41 00 00 00) + '中'(2D 4E 00 00)
    const b = new Uint8Array([0xff, 0xfe, 0x00, 0x00, 0x41, 0, 0, 0, 0x2d, 0x4e, 0x00, 0x00]);
    expect(decodeText(b, 'utf-32le')).toBe('A中');
  });
  it('utf-32be：BOM 剥离 + BE 码元解码', () => {
    // BOM(00 00 FE FF) + 'A'(00 00 00 41) + '中'(00 00 4E 2D)
    const b = new Uint8Array([0x00, 0x00, 0xfe, 0xff, 0, 0, 0, 0x41, 0, 0, 0x4e, 0x2d]);
    expect(decodeText(b, 'utf-32be')).toBe('A中');
  });
  it('非法码点/代理区 → U+FFFD 替换符（fatal:false 同语义）', () => {
    const b = new Uint8Array([0xff, 0xfe, 0x00, 0x00, 0x00, 0x00, 0x11, 0x00, 0x00, 0xd8, 0x00, 0x00]);
    expect(decodeText(b, 'utf-32le')).toBe('\u{FFFD}\u{FFFD}');
  });
  it('utf-8 缺省与 gb18030 透传 TextDecoder 不回归', () => {
    expect(decodeText(new TextEncoder().encode('abc'), undefined)).toBe('abc');
    expect(decodeText(new TextEncoder().encode('abc'), 'gb18030')).toBe('abc');
  });
});
