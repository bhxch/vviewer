import { describe, it, expect } from 'vitest';
import { detect } from '../src/detect';

describe('detect chain', () => {
  it('extension + text', () => {
    const d = detect({ name: 'a.js', head: new TextEncoder().encode('const x=1') });
    expect(d.ext).toBe('js');
    expect(d.encoding).toBe('utf-8');
    expect(d.binary).toBe(false);
  });
  it('png binary via magic', () => {
    const png = new Uint8Array([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a,0,0,0,0]);
    const d = detect({ name: 'img.png', head: png });
    expect(d.signature).toBe('png');
    expect(d.binary).toBe(true);
  });
  it('zip disguised as txt keeps signature for redirect', () => {
    const zip = new Uint8Array([0x50,0x4b,0x03,0x04,0,0]);
    const d = detect({ name: 'notes.txt', head: zip });
    expect(d.signature).toBe('zip');
    expect(d.binary).toBe(false); // 文本类扩展名：签名只留作派发器纠偏，不判二进制
  });
  it('gb18030 text detected non-utf8 but not binary', () => {
    const d = detect({ name: 'old.txt', head: new Uint8Array([0xd6,0xd0,0xce,0xc4]) });
    expect(d.encoding).toBe('gb18030');
    expect(d.binary).toBe(false);
  });
});
