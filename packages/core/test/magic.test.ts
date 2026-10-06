import { describe, it, expect } from 'vitest';
import { sniffSignature } from '../src/detect/magic';

describe('sniffSignature', () => {
  it('zip / ole / png / jpeg / gif / pdf', () => {
    expect(sniffSignature(new Uint8Array([0x50,0x4b,0x03,0x04,1]))).toBe('zip');
    expect(sniffSignature(new Uint8Array([0x50,0x4b,0x05,0x06]))).toBe('zip');
    expect(sniffSignature(new Uint8Array([0xd0,0xcf,0x11,0xe0,0xa1,0xb1,0x1a,0xe1]))).toBe('ole');
    expect(sniffSignature(new Uint8Array([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]))).toBe('png');
    expect(sniffSignature(new Uint8Array([0xff,0xd8,0xff,0xe0]))).toBe('jpeg');
    expect(sniffSignature(new TextEncoder().encode('GIF89a'))).toBe('gif');
    expect(sniffSignature(new TextEncoder().encode('%PDF-1.7'))).toBe('pdf');
  });
  it('text returns null', () => {
    expect(sniffSignature(new TextEncoder().encode('hello world'))).toBeNull();
  });
});
