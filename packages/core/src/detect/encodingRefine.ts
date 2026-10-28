// encodingRefine.ts — chardet 精判分层（议题三 §4.3）：快路径（BOM/严格 UTF-8）零成本，
// 仅「严格 UTF-8 失败的文本」触发重探测。懒加载单例 + 置信度白名单双闸，任何失败
// 路径回落 gb18030 现状——永不比今天更差。chardet 2.2.0 置信度实测为 0–100 量纲
// （2026-10-28 probe：识别器源码 sbcs 0–98、mbcs/utf8/unicode 0–100，真实语料 SJIS
// 得 100、西里尔弱匹配仅 19），spec 阈值 0.90 折算 90——阈值取低会把弱置信错配
// （如俄文样本 ISO-8859-1:19）放行，反而比 gb18030 现状更差。
import type { Detection, Encoding } from '../types';
import { looksTextual } from './magic';

const CONFIDENCE_MIN = 90;
const SAMPLE_LIMIT = 64 * 1024;

type ChardetModule = typeof import('chardet');
let chardetPromise: Promise<ChardetModule> | null = null;
function loadChardet(): Promise<ChardetModule> {
  chardetPromise ??= import('chardet');
  return chardetPromise;
}

/** detector 编码名 → TextDecoder 标签白名单（键小写查表）；映射外维持 gb18030。
 * MacCyrillic → WHATWG x-mac-cyrillic；ASCII/UTF 族/GB18030 不可达（UTF-8 被严格
 * 校验先行，UTF-16/32 被 BOM 先行，GB18030 为现状值）。ibm866/iso-8859-15/maccyrillic
 * 为前瞻性键（chardet 2.2.0 识别器暂不产出，未来版本可能启用），查表 miss 即维持
 * gb18030 无害。 */
const LABELS: Readonly<Record<string, Encoding>> = {
  'shift_jis': 'shift_jis',
  'euc-jp': 'euc-jp',
  'iso-2022-jp': 'iso-2022-jp',
  'euc-kr': 'euc-kr',
  'big5': 'big5',
  'windows-1250': 'windows-1250',
  'windows-1251': 'windows-1251',
  'windows-1252': 'windows-1252',
  'windows-1253': 'windows-1253',
  'windows-1254': 'windows-1254',
  'windows-1255': 'windows-1255',
  'windows-1256': 'windows-1256',
  'windows-1257': 'windows-1257',
  'windows-1258': 'windows-1258',
  'koi8-r': 'koi8-r',
  'ibm866': 'ibm866',
  'iso-8859-2': 'iso-8859-2',
  'iso-8859-5': 'iso-8859-5',
  'iso-8859-7': 'iso-8859-7',
  'iso-8859-15': 'iso-8859-15',
  'maccyrillic': 'x-mac-cyrillic'
};

/** 精判：门控（gb18030 且文本性）→ chardet analyse → 置信度+白名单双闸 → 就地改写
 * det.encoding。只动 encoding 一字段（binary 判定属 detect 同步面，不回流）。 */
export async function refineEncoding(bytes: Uint8Array, det: Detection): Promise<void> {
  if (det.encoding !== 'gb18030') return;
  const sample = bytes.length > SAMPLE_LIMIT ? bytes.subarray(0, SAMPLE_LIMIT) : bytes;
  if (!looksTextual(sample)) return;
  try {
    const chardet = await loadChardet();
    const matches = chardet.analyse(sample);
    const best = matches[0];
    if (!best || best.confidence < CONFIDENCE_MIN) return;
    // GB18030 自匹配守卫（fix round 1）：chardet 已高置信确认真 GB18030 时维持现状
    // 解码（ analyse 匹配列非只看榜首——sbcs 98 分错配居首、GB18030 次席的反例见
    // 评审），防「今天正确 → 明天 mojibake」
    if (matches.some((m) => m.name.toLowerCase() === 'gb18030' && m.confidence >= CONFIDENCE_MIN)) return;
    const label = LABELS[best.name.toLowerCase()];
    // label !== 'gb18030' 为防御性条件：LABELS 现无该键（GB18030 走自匹配守卫前置
    // return），未来误加键时此条件兜底
    if (label !== undefined && label !== 'gb18030') det.encoding = label;
  } catch {
    // 探测器加载/分析失败：维持 gb18030（永不比今天更差）
  }
}
