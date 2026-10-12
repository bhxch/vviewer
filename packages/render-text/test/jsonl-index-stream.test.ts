// jsonl-index-stream.test.ts — Task 2（io-streaming 计划 2）：jsonlIndex 行索引流式
// 推进器单测。语义覆盖：LF/CRLF/孤立 CR 终结符、空行与纯 ASCII 空白行丢弃（对齐
// splitJsonlLines 的 trim()==='' 语义）、跨块 \r\n（任意切面鲁棒）、巨行 >= 阈值
// （对齐 parseJsonlLine 的 >= 锚定）、atEnd 尾行、空文件，以及与全量模式
// （decode→replace(/\r\n?/g,'\n')→splitJsonlLines）的逐字节等价性（字符空间映射
// 回原始字节空间的独立参照实现，与被测字节扫描器不同构）。
import { describe, expect, it } from 'vitest';
import { JSONL_OVERSIZE_LINE_BYTES, splitJsonlLines } from '../src/jsonl/parse';
import { advanceJsonlIndex, createJsonlIndex, finishJsonlIndex } from '../src/jsonl/indexStream';

const enc = new TextEncoder();
const dec = new TextDecoder('utf-8');

/** 按切面大小 k 把字节切块并按序喂入（k=Infinity 即单块整喂）；默认阈值 1MB */
function feed(bytes: Uint8Array, k: number, maxLineBytes = JSONL_OVERSIZE_LINE_BYTES): ReturnType<typeof createJsonlIndex> {
  const step = k === Number.POSITIVE_INFINITY ? bytes.length : k;
  const state = createJsonlIndex(maxLineBytes);
  for (let i = 0; i < bytes.length; i += step) {
    advanceJsonlIndex(state, bytes.subarray(i, i + step));
  }
  return state;
}

describe('createJsonlIndex / advanceJsonlIndex', () => {
  it('LF 基本切行：offsets/lengths 不含终结符，loadedBytes 随块推进', () => {
    const text = '{"a":1}\n{"b":2}\n';
    const bytes = enc.encode(text);
    const st = feed(bytes, Number.POSITIVE_INFINITY);
    expect(st.offsets).toEqual([0, 8]);
    expect(st.lengths).toEqual([7, 7]);
    expect([...st.oversized]).toEqual([]);
    expect(st.atEnd).toBe(false);
    expect(st.loadedBytes).toBe(bytes.length);
  });

  it('CRLF 记为一个终结符：不产生空行，lengths 不含 \\r\\n 两字节', () => {
    const st = feed(enc.encode('a\r\nb\r\n'), Number.POSITIVE_INFINITY);
    expect(st.offsets).toEqual([0, 3]);
    expect(st.lengths).toEqual([1, 1]);
  });

  it('孤立 CR（旧 Mac）计终结符：a\\rb 切两行', () => {
    const st = feed(enc.encode('a\rb'), Number.POSITIVE_INFINITY);
    finishJsonlIndex(st); // 'b' 为悬挂尾行，atEnd 提交
    expect(st.offsets).toEqual([0, 2]);
    expect(st.lengths).toEqual([1, 1]);
  });

  it('空行与纯 ASCII 空白行（空格/\\t/\\v/\\f）丢弃，不产出条目', () => {
    const st = feed(enc.encode('a\n\n \n\t\n\x0b\n\x0c\nb\n'), Number.POSITIVE_INFINITY);
    expect(st.offsets).toEqual([0, 11]);
    expect(st.lengths).toEqual([1, 1]);
  });

  it('块边界切开 \\r\\n（\\r 块尾、\\n 下块头）不产生空行；任意切面结果全等', () => {
    const text = 'a\r\nb\r\nc';
    const bytes = enc.encode(text);
    const whole = feed(bytes, Number.POSITIVE_INFINITY);
    finishJsonlIndex(whole); // 悬挂尾行 'c' 一并提交，与切面口径一致
    for (let k = 1; k <= bytes.length; k++) {
      const st = feed(bytes, k);
      finishJsonlIndex(st);
      expect(st.offsets, `切面 ${k}`).toEqual(whole.offsets);
      expect(st.lengths, `切面 ${k}`).toEqual(whole.lengths);
    }
    // 2 字节切面恰把 \r\n 切开（'a\r' | '\nb' | '\r\n' | 'c'），'c' 起点为字节 6
    const st = feed(bytes, 2);
    finishJsonlIndex(st);
    expect(st.offsets).toEqual([0, 3, 6]);
    expect(st.lengths).toEqual([1, 1, 1]);
  });

  it('巨行防护：行字节长 >= maxLineBytes 记 oversized（等号即超限，对齐 parseJsonlLine）', () => {
    const state = createJsonlIndex(8);
    advanceJsonlIndex(state, enc.encode('12345678\n1234567\n12345678'));
    finishJsonlIndex(state);
    expect(state.offsets.length).toBe(3);
    expect([...state.oversized]).toEqual([0, 2]); // 8 字节行（含末尾无终结符行）超限，7 字节不超
  });

  it('巨行防护：真实常量 1MB 整为超限、1MB-1 不超（parse.ts 锚定同源）', () => {
    const text = 'x'.repeat(1_048_576) + '\n' + 'y'.repeat(1_048_575);
    const st = feed(enc.encode(text), Number.POSITIVE_INFINITY);
    finishJsonlIndex(st); // 1MB-1 的 'y' 行无终结符，悬挂尾行提交
    expect([...st.oversized]).toEqual([0]);
    expect(st.lengths).toEqual([1_048_576, 1_048_575]);
  });

  it('atEnd 尾行：无终结符的末行由 finishJsonlIndex 提交；已终结则不追加', () => {
    const st1 = feed(enc.encode('a\nb'), Number.POSITIVE_INFINITY);
    expect(st1.offsets).toEqual([0]); // finish 前 'b' 悬挂
    finishJsonlIndex(st1);
    expect(st1.atEnd).toBe(true);
    expect(st1.offsets).toEqual([0, 2]);
    expect(st1.lengths).toEqual([1, 1]);

    const st2 = feed(enc.encode('a\n'), Number.POSITIVE_INFINITY);
    finishJsonlIndex(st2);
    expect(st2.offsets).toEqual([0]); // 以终结符收尾：无悬挂行
    expect(st2.atEnd).toBe(true);
  });

  it('空文件：零行；finish 后 atEnd 仍零行', () => {
    const st = feed(enc.encode(''), Number.POSITIVE_INFINITY);
    expect(st.offsets).toEqual([]);
    expect(st.lengths).toEqual([]);
    expect(st.loadedBytes).toBe(0);
    finishJsonlIndex(st);
    expect(st.atEnd).toBe(true);
    expect(st.offsets).toEqual([]);
  });

  it('非法 maxLineBytes 抛错（与 blockStream 的 blockSize 校验同口径）', () => {
    expect(() => createJsonlIndex(0)).toThrow();
    expect(() => createJsonlIndex(1.5)).toThrow();
    expect(() => createJsonlIndex(Number.NaN)).toThrow();
  });
});

describe('与全量模式等价性（decode→replace→splitJsonlLines vs 索引产物）', () => {
  /**
   * 独立参照：在字符空间重放归一化文本（replace 只收缩终结符，段内容逐字符不变），
   * 把每个归一化位置映射回原始字节偏移，从而从 splitJsonlLines 语义推出 (offset,len)。
   * 算法与被测字节扫描器不同构（字符空间自顶向下 vs 字节空间增量状态机），代理对
   * 按码点合并计数以保证 UTF-8 字节累计正确。
   */
  function referenceIndex(text: string): {
    lines: string[];
    offsets: number[];
    lengths: number[];
    oversized: Set<number>;
  } {
    const normalized = text.replace(/\r\n?/g, '\n');
    // normByte[k] = 归一化第 k 个码元之前的原始字节偏移；normByte[len] = 总字节。
    // \r\n/\r 归一化为 1 个 '\n' 码元（replace 语义），故只占一个映射项
    const normByte: number[] = [0];
    let byte = 0;
    for (let i = 0; i < text.length; ) {
      if (text[i] === '\r') {
        const len = text[i + 1] === '\n' ? 2 : 1;
        byte += len;
        normByte.push(byte);
        i += len;
        continue;
      }
      const code = text.codePointAt(i)!;
      const units = code > 0xffff ? 2 : 1;
      byte += enc.encode(text[i]! + (units === 2 ? text[i + 1]! : '')).length;
      for (let u = 0; u < units; u++) normByte.push(byte);
      i += units;
    }
    const lines: string[] = [];
    const offsets: number[] = [];
    const lengths: number[] = [];
    const oversized = new Set<number>();
    let start = 0; // 当前段在归一化文本中的码元起点
    for (const seg of normalized.split('\n')) {
      const end = start + seg.length; // 终结符（或 EOF）之前的归一化位置
      if (seg.trim() !== '') {
        const lineNo = offsets.length;
        const len = normByte[end]! - normByte[start]!;
        lines.push(seg);
        offsets.push(normByte[start]!);
        lengths.push(len);
        if (len >= JSONL_OVERSIZE_LINE_BYTES) oversized.add(lineNo);
      }
      start = end + 1; // 跳过 '\n'
    }
    return { lines, offsets, lengths, oversized };
  }

  /** 复合文本：CRLF/孤立 CR/空行/纯空白行/多字节中文+emoji/1MB 整巨行/尾行无终结符 */
  const EQUIV_TEXT = [
    '{"a":1}',
    '',
    '   ',
    '{"b":"中文与 emoji 🎉 mixing"}',
    'x'.repeat(1_048_576),
    '{"c":true}\r\n{"d":null}',
    'plain\rline',
    '\t',
    '{"e":[1,2,3]}'
  ].join('\n');

  function assertEquivalent(text: string, split: number): void {
    const bytes = enc.encode(text);
    const ref = referenceIndex(text);
    const st = feed(bytes, split);
    finishJsonlIndex(st);
    expect(st.offsets, `切面 ${split} offsets`).toEqual(ref.offsets);
    expect(st.lengths, `切面 ${split} lengths`).toEqual(ref.lengths);
    expect([...st.oversized], `切面 ${split} oversized`).toEqual([...ref.oversized]);
    expect(st.loadedBytes, `切面 ${split} loadedBytes`).toBe(bytes.length);
    // 最强校验：索引字节逐行 decode 回来 == 全量 splitJsonlLines 行序列
    expect(ref.lines.length).toBe(st.offsets.length);
    for (let i = 0; i < st.offsets.length; i++) {
      const lineBytes = bytes.subarray(st.offsets[i]!, st.offsets[i]! + st.lengths[i]!);
      expect(dec.decode(lineBytes), `行 ${i}`).toBe(ref.lines[i]);
    }
  }

  it('复合文本（含巨行/多字节/尾行）：单块整喂与大切面均与全量模式等价', () => {
    const bytes = enc.encode(EQUIV_TEXT);
    // 小切面（1/2/3/7 字节）的跨块鲁棒性由小型对抗文本穷举钉住；此处取大切面，
    // 另含末块 1 字节（bytes.length-1）与质数切面（巨行中部任意对齐）覆盖 EOF 边界
    const cuts = [Number.POSITIVE_INFINITY, bytes.length - 1, 4096, 65536, 999983];
    for (const k of cuts) assertEquivalent(EQUIV_TEXT, k);
  }, 20_000);

  it('小型对抗文本穷举：全 1/2/3 字节切面等价', () => {
    const samples = [
      'a\r\n\r\nb',
      '\r\na\rb\n',
      'a\n\rb',
      '  \n a \n\t\nb',
      '中文\r\n行\r尾',
      '🎉\r\n🎉\r🎉'
    ];
    for (const text of samples) {
      for (const k of [1, 2, 3]) assertEquivalent(text, k);
    }
  });
});
