// inspector.ts — 数据检查器解码纯函数（Task 3，spec H §2.3）。cursor 处按当前
// 字节序解码 int/uint/float 全宽 + bool（非零即真）+ UTF-8 片段（16 字节截断）+
// 原始 hex 回显；剩余字节不足的类型 available=false（value='—'，MetaPanel 灰显）。
// 纯函数、无 DOM 依赖（jsdom 单测直测；cursor 交互与 getInspector/setLittle 鸭子
// 接口见 hex.ts）。解码在主线程做：buffer 全量已在参数内，8 字节窗口无 IO。

/** 解码表单行：available=false 时 value 恒为 '—' */
export interface InspectorRow {
  label: string;
  value: string;
  available: boolean;
}

/** getInspector 鸭子接口快照（hex 实例光标定位时返回；未定位返回 null） */
export interface InspectorSnapshot {
  offset: number;
  little: boolean;
  rows: InspectorRow[];
}

/** UTF-8 片段与 hex 回显的窗口字节数（spec §2.3：16 字节截断） */
export const INSPECTOR_WINDOW_BYTES = 16;

const UNAVAILABLE = '—';

interface NumericType {
  label: string;
  size: number;
  read(dv: DataView, offset: number, little: boolean): string;
}

// 类型集（spec §Global Constraints）：int8..64 / uint8..64 / float32/64。
// int64/uint64 以 BigInt 承载（String 化输出，无 Number 精度损失）；
// float 遵循 IEEE 754，NaN/Inf 经 String 原样输出。
const NUMERIC_TYPES: NumericType[] = [
  { label: 'int8', size: 1, read: (dv, off) => String(dv.getInt8(off)) },
  { label: 'int16', size: 2, read: (dv, off, little) => String(dv.getInt16(off, little)) },
  { label: 'int32', size: 4, read: (dv, off, little) => String(dv.getInt32(off, little)) },
  { label: 'int64', size: 8, read: (dv, off, little) => String(dv.getBigInt64(off, little)) },
  { label: 'uint8', size: 1, read: (dv, off) => String(dv.getUint8(off)) },
  { label: 'uint16', size: 2, read: (dv, off, little) => String(dv.getUint16(off, little)) },
  { label: 'uint32', size: 4, read: (dv, off, little) => String(dv.getUint32(off, little)) },
  { label: 'uint64', size: 8, read: (dv, off, little) => String(dv.getBigUint64(off, little)) },
  { label: 'float32', size: 4, read: (dv, off, little) => String(dv.getFloat32(off, little)) },
  { label: 'float64', size: 8, read: (dv, off, little) => String(dv.getFloat64(off, little)) }
];

// 非致命解码：截断的多字节序列 → U+FFFD（decode 无 stream 语义，可复用实例）
const utf8Decoder = new TextDecoder('utf-8');

function toHexBytes(data: Uint8Array, from: number, to: number): string {
  let s = '';
  for (let i = from; i < to; i++) {
    if (s !== '') s += ' ';
    s += data[i]!.toString(16).padStart(2, '0');
  }
  return s;
}

/**
 * data 的 offset 处按字节序解码整表（13 行，顺序锁定：int8..64 / uint8..64 /
 * float32/64 / bool / UTF-8 / hex）。offset 出界或剩余字节不足的类型
 * available=false（value='—'）；bool 取首字节非零即真；UTF-8 片段与 hex 回显
 * 为 offset 起 ≤16 字节窗口。
 */
export function decodeAt(data: Uint8Array, offset: number, little: boolean): InspectorRow[] {
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const rows: InspectorRow[] = [];
  for (const t of NUMERIC_TYPES) {
    const ok = offset >= 0 && offset + t.size <= data.length;
    rows.push({ label: t.label, value: ok ? t.read(dv, offset, little) : UNAVAILABLE, available: ok });
  }
  const anyByte = offset >= 0 && offset < data.length;
  rows.push({
    label: 'bool',
    value: anyByte ? (data[offset]! !== 0 ? 'true' : 'false') : UNAVAILABLE,
    available: anyByte
  });
  const winEnd = Math.min(offset + INSPECTOR_WINDOW_BYTES, data.length);
  rows.push({
    label: 'UTF-8',
    value: anyByte ? utf8Decoder.decode(data.subarray(offset, winEnd)) : UNAVAILABLE,
    available: anyByte
  });
  rows.push({
    label: 'hex',
    value: anyByte ? toHexBytes(data, offset, winEnd) : UNAVAILABLE,
    available: anyByte
  });
  return rows;
}
