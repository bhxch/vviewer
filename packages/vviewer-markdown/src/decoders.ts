// decoders.ts — Encoding → TextDecoder 标签表（decodeText 消费；UTF-32 不在表内
// ——WHATWG TextDecoder 不支持，decodeText 自带定长解码器分流）。自 render-text
// src/code/strategy.ts 逐字迁入，Encoding 改包内 types 引用；扩列由 Record 键
// 编译期强制同步。
import type { Encoding } from './types';

export const DECODERS: Record<Exclude<Encoding, 'utf-32le' | 'utf-32be'>, string> = {
  'utf-8': 'utf-8',
  'utf-16le': 'utf-16le',
  'utf-16be': 'utf-16be',
  'gb18030': 'gb18030',
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
  'x-mac-cyrillic': 'x-mac-cyrillic'
};
