import { deflateSync, crc32 } from 'node:zlib';

/**
 * 真 PNG 夹具（32×8 RGBA：签名+IHDR+IDAT+IEND，CRC 经 node:zlib crc32），供各
 * e2e 套件作「正常图片」载体。来源：samples/m4/sample.bin 系「PNG 签名+IHDR+4KB
 * 伪随机体」（无 IDAT/IEND，本就不可完整解码），BUG-53 解码校验（image.ts render
 * 后 observeImageDecode，2026-10-16 合入）按设计以「图片解码失败」卡拒绝之——
 * t-media MEDIA-01 连带红为载体修复波实证；b-media zoom.png 连带红为同批全量门禁发现
 * （2026-10-16 T4a 实证，fix(test) 07f9bf9 后抽出本夹具统一修面）。
 */
export const goodPng = (): Uint8Array => {
  const w = 32;
  const h = 8;
  const chunk = (type: string, data: Uint8Array): Uint8Array => {
    const out = new Uint8Array(12 + data.length);
    const dv = new DataView(out.buffer);
    dv.setUint32(0, data.length);
    out.set(new TextEncoder().encode(type), 4);
    out.set(data, 8);
    dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
    return out;
  };
  const ihdr = new Uint8Array(13);
  const ihdrDv = new DataView(ihdr.buffer);
  ihdrDv.setUint32(0, w);
  ihdrDv.setUint32(4, h);
  ihdr[8] = 8; // 位深 8
  ihdr[9] = 6; // 色型 RGBA
  const raw = new Uint8Array(h * (1 + w * 4)); // 每行 filter 0 + RGBA 像素（全 0 透明）
  const idat = new Uint8Array(deflateSync(raw));
  const sig = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const parts = [sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', new Uint8Array(0))];
  const png = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let off = 0;
  for (const p of parts) {
    png.set(p, off);
    off += p.length;
  }
  return png;
};
