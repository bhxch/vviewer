import type { Detection } from '../types';

const startsWith = (head: Uint8Array, sig: readonly number[]): boolean =>
  sig.every((v, i) => head[i] === v);

/** magic 签名嗅探：ZIP（PK\x03\x04 / PK\x05\x06 / PK\x07\x08）、OLE、PNG、JPEG、GIF、PDF */
export function sniffSignature(head: Uint8Array): Detection['signature'] {
  if (startsWith(head, [0x50, 0x4b, 0x03, 0x04]) || startsWith(head, [0x50, 0x4b, 0x05, 0x06]) || startsWith(head, [0x50, 0x4b, 0x07, 0x08])) return 'zip';
  if (startsWith(head, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) return 'ole';
  if (startsWith(head, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'png';
  if (startsWith(head, [0xff, 0xd8, 0xff])) return 'jpeg';
  if (startsWith(head, [0x47, 0x49, 0x46, 0x38])) return 'gif'; // GIF87a/GIF89a
  if (startsWith(head, [0x25, 0x50, 0x44, 0x46])) return 'pdf'; // %PDF
  return null;
}
