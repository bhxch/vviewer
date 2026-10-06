import type { Detection } from '../types';
import { extractExtension } from './extension';
import { sniffSignature } from './magic';
import { detectEncoding } from './encoding';

export { extractExtension } from './extension';
export { sniffSignature } from './magic';
export { detectEncoding, isStrictUtf8 } from './encoding';

const TEXT_EXTENSIONS = new Set(['txt','md','markdown','html','htm','css','scss','js','mjs','cjs','ts','tsx','jsx','json','jsonc','yaml','yml','toml','xml','svg','csv','log','py','rb','go','rs','java','kt','c','h','cpp','hpp','cc','sh','bash','zsh','fish','sql','lua','php','pl','swift','dart','vue','svelte','ini','conf','cfg','env','properties','gradle','cmake','dockerfile','gitignore','license','makefile']);

/** 检测链：扩展名主路由 + magic 签名 + 编码。head 建议 ≥8KB；full 用于编码精确判定。 */
export function detect(input: { name: string; head: Uint8Array; full?: Uint8Array }): Detection {
  const ext = extractExtension(input.name);
  const signature = sniffSignature(input.head);
  const encoding = detectEncoding(input.full ?? input.head);
  // binary 判定：签名命中且扩展名不属于文本类（文本类扩展名但签名是 zip/ole 时 signature 仍记录，由派发器纠偏），
  // 或编码检测为 gb18030（非 UTF 文本）且扩展名不属于文本类（保守）
  const binary =
    signature !== null
      ? !TEXT_EXTENSIONS.has(ext)
      : encoding === 'gb18030' && !TEXT_EXTENSIONS.has(ext);
  return { ext, encoding, binary, signature };
}
