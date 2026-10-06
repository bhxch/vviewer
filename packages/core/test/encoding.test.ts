import { describe, it, expect } from 'vitest';
import { detectEncoding } from '../src/detect/encoding';

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
