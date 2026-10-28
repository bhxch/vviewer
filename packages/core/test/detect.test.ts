import { describe, it, expect } from 'vitest';
import { detect, sniffSignature, detectEncoding } from '../src/detect';
import { signatureRouteOf } from '../src/dispatch/dispatcher';

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
    // BUG-32：二进制不透出文本编码（png 字节恒非严格 UTF-8，此前误报 gb18030）
    expect(d.encoding).toBeUndefined();
  });
  it('zip disguised as txt keeps signature for redirect', () => {
    const zip = new Uint8Array([0x50,0x4b,0x03,0x04,0,0]);
    const d = detect({ name: 'notes.txt', head: zip });
    expect(d.signature).toBe('zip');
    expect(d.binary).toBe(false); // 文本类扩展名：签名只留作派发器纠偏，不判二进制
    expect(d.encoding).toBe('utf-8'); // 未判二进制：编码照常透出
  });
  it('gb18030 text detected non-utf8 but not binary', () => {
    const d = detect({ name: 'old.txt', head: new Uint8Array([0xd6,0xd0,0xce,0xc4]) });
    expect(d.encoding).toBe('gb18030');
    expect(d.binary).toBe(false);
  });
  it('binary without signature (non-text ext, non-utf8): encoding dropped (BUG-32)', () => {
    // 无签名 + 非文本扩展名 + 非 UTF-8 字节 → 保守判二进制：encoding 一并置 undefined
    const d = detect({ name: 'blob.dat', head: new Uint8Array([0xd6,0xd0,0xce,0xc4]) });
    expect(d.binary).toBe(true);
    expect(d.encoding).toBeUndefined();
  });
});

describe('议题二：签名表扩容', () => {
  const head = (bytes: number[]): Uint8Array => new Uint8Array(bytes);

  it('ftyp 品牌分派：isom→mp4、M4A →m4a、avif→avif、未知品牌不命中', () => {
    const mk = (brand: string): Uint8Array => {
      const b = new Uint8Array(12);
      b.set([0x00, 0x00, 0x00, 0x18], 0);
      b.set(new TextEncoder().encode('ftyp'), 4);
      b.set(new TextEncoder().encode(brand), 8);
      return b;
    };
    expect(sniffSignature(mk('isom'))).toBe('mp4');
    expect(sniffSignature(mk('mp42'))).toBe('mp4');
    expect(sniffSignature(mk('M4A '))).toBe('m4a');
    expect(sniffSignature(mk('avif'))).toBe('avif');
    expect(sniffSignature(mk('avis'))).toBe('avif');
    expect(sniffSignature(mk('xxxx'))).toBeNull();
  });

  it('强签名族逐值命中', () => {
    expect(sniffSignature(head([0x1a, 0x45, 0xdf, 0xa3]))).toBe('webm');
    expect(sniffSignature(new TextEncoder().encode('RIFF0000WEBP') as unknown as Uint8Array)).toBe('webp');
    expect(sniffSignature(new TextEncoder().encode('RIFF0000WAVE') as unknown as Uint8Array)).toBe('wav');
    expect(sniffSignature(head([0, 0, 1, 0, 0, 0]))).toBe('ico');
    expect(sniffSignature(head([0x1f, 0x8b, 0x08, 0x00]))).toBe('gz');
    expect(sniffSignature(head([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]))).toBe('7z');
    expect(sniffSignature(head([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x00]))).toBe('rar');
    expect(sniffSignature(new TextEncoder().encode('fLaC') as unknown as Uint8Array)).toBe('flac');
    expect(sniffSignature(new TextEncoder().encode('OggS') as unknown as Uint8Array)).toBe('ogg');
  });

  it('bmp 保留字段强校验：BM+保留四字节非零不命中（文本 "BM…" 防误伤）', () => {
    const bmp = head([0x42, 0x4d, 0x46, 0x00, 0x00, 0x00, 0, 0, 0, 0, 0, 0]);
    expect(sniffSignature(bmp)).toBe('bmp');
    const fake = new TextEncoder().encode('BMW M4 文档') as unknown as Uint8Array;
    expect(sniffSignature(fake)).toBeNull();
  });

  it('SIGNATURE_ROUTES 全新值有路由且 ext 纠偏正确（ole 维持无路由）', () => {
    expect(signatureRouteOf('mp4')).toEqual({ rendererId: 'av', ext: 'mp4' });
    expect(signatureRouteOf('m4a')).toEqual({ rendererId: 'av', ext: 'm4a' });
    expect(signatureRouteOf('avif')).toEqual({ rendererId: 'image', ext: 'avif' });
    expect(signatureRouteOf('webm')).toEqual({ rendererId: 'av', ext: 'webm' });
    expect(signatureRouteOf('webp')).toEqual({ rendererId: 'image', ext: 'webp' });
    expect(signatureRouteOf('wav')).toEqual({ rendererId: 'av', ext: 'wav' });
    expect(signatureRouteOf('ico')).toEqual({ rendererId: 'image', ext: 'ico' });
    expect(signatureRouteOf('gz')).toEqual({ rendererId: 'archive', ext: 'gz' });
    expect(signatureRouteOf('7z')).toEqual({ rendererId: 'archive', ext: '7z' });
    expect(signatureRouteOf('rar')).toEqual({ rendererId: 'archive', ext: 'rar' });
    expect(signatureRouteOf('flac')).toEqual({ rendererId: 'av', ext: 'flac' });
    expect(signatureRouteOf('ogg')).toEqual({ rendererId: 'av', ext: 'ogg' });
    expect(signatureRouteOf('bmp')).toEqual({ rendererId: 'image', ext: 'bmp' });
    expect(signatureRouteOf('ole')).toBeNull();
  });
});

describe('议题三：BOM 扩充', () => {
  it('UTF-32LE BOM 优先于 UTF-16LE（前缀包含）', () => {
    expect(detectEncoding(new Uint8Array([0xff, 0xfe, 0x00, 0x00, 0x41, 0, 0, 0]))).toBe('utf-32le');
  });
  it('UTF-32BE BOM 识别', () => {
    expect(detectEncoding(new Uint8Array([0x00, 0x00, 0xfe, 0xff, 0, 0, 0x41]))).toBe('utf-32be');
  });
  it('既有 BOM 判定不回归', () => {
    expect(detectEncoding(new Uint8Array([0xef, 0xbb, 0xbf, 0x41]))).toBe('utf-8');
    expect(detectEncoding(new Uint8Array([0xff, 0xfe, 0x41, 0]))).toBe('utf-16le');
    expect(detectEncoding(new Uint8Array([0xfe, 0xff, 0, 0x41]))).toBe('utf-16be');
  });
});
