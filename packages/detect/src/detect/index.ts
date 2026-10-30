import type { BaseDetection } from '../types';
import { extractExtension } from './extension';
import { sniffSignature } from './magic';
import { detectEncoding } from './encoding';

export { extractExtension } from './extension';
export { sniffSignature } from './magic';
export { detectEncoding, isStrictUtf8 } from './encoding';
// 统一根入口（包化导出面）：dispatcher 原三处 import（'../detect'、
// '../detect/encodingRefine'、'../detect/magic'）统一为 from '@vviewer/detect' 后
// 符号不变，故在此补齐精判与文本性/shebang 符号的 re-export。
export { refineEncoding } from './encodingRefine';
export { looksTextual, shebangLangOf } from './magic';

/** 文本类扩展名窄表（detect 链 binary 判定用）：手工维护、与 @vviewer/highlight
 * languages.json 无构建期同步（同 SHEBANG_LANGS，见 magic.ts 注释）——包化后成为
 * 本包对外承诺，扩列时人工同步 languages.json 及派发侧约定。 */
const TEXT_EXTENSIONS = new Set(['txt','md','markdown','html','htm','css','scss','js','mjs','cjs','ts','tsx','jsx','json','jsonc','jsonl','ndjson','yaml','yml','toml','xml','svg','csv','log','py','rb','go','rs','java','kt','c','h','cpp','hpp','cc','sh','bash','zsh','fish','sql','lua','php','pl','swift','dart','vue','svelte','ini','conf','cfg','env','properties','gradle','cmake','dockerfile','gitignore','license','makefile']);

/** 检测链：扩展名主路由 + magic 签名 + 编码。head 建议 ≥8KB；full 用于编码精确判定。
 * BUG-32：binary 判定成立时不透出文本编码——编码检测对二进制字节无意义
 * （png/jpg 严格 UTF-8 校验失败恒回退 gb18030 的误导值）；消费方约定：getMeta 的
 * encoding 为 undefined 时状态栏/属性面板隐藏「编码」段（ViewerPane/MetaPanel 的
 * 真值判断），文本渲染器本就以 `det.encoding ?? 'utf-8'` 兜底不受影响。
 * 返回 BaseDetection（本包基础形状）；core 的 Detection extends BaseDetection
 * 追加派发链标记，赋值/传参零摩擦。 */
export function detect(input: { name: string; head: Uint8Array; full?: Uint8Array }): BaseDetection {
  const ext = extractExtension(input.name);
  const signature = sniffSignature(input.head);
  const encoding = detectEncoding(input.full ?? input.head);
  // binary 判定：签名命中且扩展名不属于文本类（文本类扩展名但签名是 zip/ole 时 signature 仍记录，由派发器纠偏），
  // 或编码检测为 gb18030（非 UTF 文本）且扩展名不属于文本类（保守）
  const binary =
    signature !== null
      ? !TEXT_EXTENSIONS.has(ext)
      : encoding === 'gb18030' && !TEXT_EXTENSIONS.has(ext);
  return { ext, encoding: binary ? undefined : encoding, binary, signature };
}
