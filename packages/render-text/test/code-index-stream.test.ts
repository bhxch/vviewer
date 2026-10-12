// code-index-stream.test.ts — Task 3（io-streaming 计划 3）：codeIndex 行索引流式
// 推进器单测。语义对齐 code.ts 全量路径（decode→replace(/\r\n?/g,'\n')→
// buildLineIndex(=split('\n'))），与 jsonlIndex 的关键差异：
// - 空行/纯空白行也产出条目（code 行号 = 文本行号，split('\n') 逐元素对齐）；
// - 文本以终结符收尾时 finish 产出末尾空串条目（'a\n' → ['a',''] 两条目），
//   空文件 '' → ['']（1 条目）——与虚拟滚动 itemCount=lines.length 严格一致；
// - code 无逐行巨行防护概念（code.ts 超限防线是整 buffer 级 STREAM_MAX_BYTES），
//   maxLineBytes 支持 Infinity：永不记 oversized；有限阈值仍按 >= 判定（与
//   jsonlIndex 同口径）。
// 覆盖：LF/CRLF/孤立 CR 终结符、空行条目、跨块 \r\n（任意切面鲁棒）、Infinity
// 与有限阈值双语义、atEnd 尾行/幂等 finish、空文件，以及与全量模式的逐字节
// 等价性（字符空间参照实现，与被测字节扫描器不同构）。
import { describe, expect, it } from 'vitest';
import { advanceCodeIndex, createCodeIndex, finishCodeIndex } from '../src/codeIndexStream';

const enc = new TextEncoder();
const dec = new TextDecoder('utf-8');

/** 按切面大小 k 把字节切块并按序喂入（k=Infinity 即单块整喂）；默认阈值 Infinity */
function feed(
  bytes: Uint8Array,
  k: number,
  maxLineBytes = Number.POSITIVE_INFINITY
): ReturnType<typeof createCodeIndex> {
  const step = k === Number.POSITIVE_INFINITY ? bytes.length : k;
  const state = createCodeIndex(maxLineBytes);
  for (let i = 0; i < bytes.length; i += step) {
    advanceCodeIndex(state, bytes.subarray(i, i + step));
  }
  return state;
}

describe('createCodeIndex / advanceCodeIndex / finishCodeIndex', () => {
  it('LF 基本切行（含空行条目）：offsets/lengths 不含终结符，loadedBytes 随块推进', () => {
    const text = 'a\n\nb\n';
    const bytes = enc.encode(text);
    const st = feed(bytes, Number.POSITIVE_INFINITY);
    // 'a'(0,1)、''(2,0)、'b'(3,1) 已提交；末尾空串段（5,0）悬挂待 finish
    expect(st.offsets).toEqual([0, 2, 3]);
    expect(st.lengths).toEqual([1, 0, 1]);
    expect([...st.oversized]).toEqual([]);
    expect(st.atEnd).toBe(false);
    expect(st.loadedBytes).toBe(bytes.length);
    finishCodeIndex(st);
    expect(st.atEnd).toBe(true);
    expect(st.offsets).toEqual([0, 2, 3, 5]); // 末尾空串条目：对齐 ['a','','b','']
    expect(st.lengths).toEqual([1, 0, 1, 0]);
  });

  it('CRLF 记为一个终结符：不产生额外空条目，lengths 不含 \\r\\n 两字节', () => {
    const st = feed(enc.encode('a\r\nb\r\n'), Number.POSITIVE_INFINITY);
    finishCodeIndex(st);
    expect(st.offsets).toEqual([0, 3, 6]); // ['a','b','']——末尾空串条目
    expect(st.lengths).toEqual([1, 1, 0]);
  });

  it('孤立 CR（旧 Mac）计终结符：a\\rb 切两行', () => {
    const st = feed(enc.encode('a\rb'), Number.POSITIVE_INFINITY);
    finishCodeIndex(st); // 'b' 为悬挂尾行，atEnd 提交
    expect(st.offsets).toEqual([0, 2]);
    expect(st.lengths).toEqual([1, 1]);
  });

  it('空行与纯 ASCII 空白行（空格/\\t/\\v/\\f）均产出条目（与 jsonlIndex 的关键差异）', () => {
    const st = feed(enc.encode('a\n\n \n\t\n\x0b\n\x0c\nb\n'), Number.POSITIVE_INFINITY);
    finishCodeIndex(st);
    expect(st.offsets).toEqual([0, 2, 3, 5, 7, 9, 11, 13]);
    expect(st.lengths).toEqual([1, 0, 1, 1, 1, 1, 1, 0]);
  });

  it('空文件：finish 产出 1 条空条目（对齐全量 buildLineIndex("") === [""]）', () => {
    const st = feed(enc.encode(''), Number.POSITIVE_INFINITY);
    expect(st.offsets).toEqual([]);
    expect(st.loadedBytes).toBe(0);
    finishCodeIndex(st);
    expect(st.atEnd).toBe(true);
    expect(st.offsets).toEqual([0]);
    expect(st.lengths).toEqual([0]);
  });

  it('块边界切开 \\r\\n（\\r 块尾、\\n 下块头）不产生空条目；任意切面结果全等', () => {
    const text = 'a\r\nb\r\nc';
    const bytes = enc.encode(text);
    const whole = feed(bytes, Number.POSITIVE_INFINITY);
    finishCodeIndex(whole); // 悬挂尾行 'c' 一并提交，与切面口径一致
    for (let k = 1; k <= bytes.length; k++) {
      const st = feed(bytes, k);
      finishCodeIndex(st);
      expect(st.offsets, `切面 ${k}`).toEqual(whole.offsets);
      expect(st.lengths, `切面 ${k}`).toEqual(whole.lengths);
    }
    // 2 字节切面恰把 \\r\\n 切开（'a\\r' | '\\nb' | '\\r\\n' | 'c'），'c' 起点为字节 6
    const st = feed(bytes, 2);
    finishCodeIndex(st);
    expect(st.offsets).toEqual([0, 3, 6]);
    expect(st.lengths).toEqual([1, 1, 1]);
  });

  it('Infinity 阈值：1MB 巨行不记 oversized（code 无逐行巨行防护概念）', () => {
    const text = 'x'.repeat(1_048_576) + '\n' + 'y'.repeat(1_048_575);
    const st = feed(enc.encode(text), Number.POSITIVE_INFINITY);
    finishCodeIndex(st); // 1MB-1 的 'y' 行无终结符，悬挂尾行提交
    expect([...st.oversized]).toEqual([]);
    expect(st.lengths).toEqual([1_048_576, 1_048_575]);
  });

  it('有限阈值：行字节长 >= maxLineBytes 记 oversized（等号即超限，与 jsonlIndex 同口径）', () => {
    const state = createCodeIndex(8);
    advanceCodeIndex(state, enc.encode('12345678\n1234567\n\n12345678'));
    finishCodeIndex(state);
    expect(state.offsets.length).toBe(4);
    expect([...state.oversized]).toEqual([0, 3]); // 8 字节行超限；7 字节/空行不超
  });

  it('atEnd 尾行：无终结符的末行由 finishCodeIndex 提交；重复 finish 幂等不追加', () => {
    const st1 = feed(enc.encode('a\nb'), Number.POSITIVE_INFINITY);
    expect(st1.offsets).toEqual([0]); // finish 前 'b' 悬挂
    finishCodeIndex(st1);
    expect(st1.atEnd).toBe(true);
    expect(st1.offsets).toEqual([0, 2]);
    expect(st1.lengths).toEqual([1, 1]);
    finishCodeIndex(st1); // split('\\n') 语义下重复 finish 不得追加末尾空条目
    expect(st1.offsets).toEqual([0, 2]);
    expect(st1.lengths).toEqual([1, 1]);

    const st2 = feed(enc.encode('a\n'), Number.POSITIVE_INFINITY);
    finishCodeIndex(st2);
    expect(st2.offsets).toEqual([0, 2]); // 以终结符收尾：仍有末尾空串条目（对齐 ['a','']）
    expect(st2.lengths).toEqual([1, 0]);
  });

  it('非法 maxLineBytes 抛错；Infinity 与正整数合法（与 blockStream 的 blockSize 校验同口径）', () => {
    expect(() => createCodeIndex(0)).toThrow();
    expect(() => createCodeIndex(-1)).toThrow();
    expect(() => createCodeIndex(1.5)).toThrow();
    expect(() => createCodeIndex(Number.NaN)).toThrow();
    expect(() => createCodeIndex(Number.POSITIVE_INFINITY)).not.toThrow();
    expect(() => createCodeIndex(8)).not.toThrow();
  });
});

describe('与全量模式等价性（decode→replace→buildLineIndex vs 索引产物）', () => {
  /**
   * 独立参照：在字符空间重放归一化文本（replace 只收缩终结符，段内容逐字符不变），
   * 把每个归一化位置映射回原始字节偏移，从 buildLineIndex（split('\\n')，空行/末尾
   * 空串元素全保留）语义推出 (offset,len)。与 jsonl 等价性用例的参照实现同源但
   * 去掉 trim 过滤（code 语义空行也产出）。算法与被测字节扫描器不同构（字符空间
   * 自顶向下 vs 字节空间增量状态机），代理对按码点合并计数以保证 UTF-8 字节累计
   * 正确。
   */
  function referenceIndex(
    text: string,
    maxLineBytes: number
  ): {
    lines: string[];
    offsets: number[];
    lengths: number[];
    oversized: Set<number>;
  } {
    const normalized = text.replace(/\r\n?/g, '\n');
    // normByte[k] = 归一化第 k 个码元之前的原始字节偏移；normByte[len] = 总字节。
    // \\r\\n/\\r 归一化为 1 个 '\\n' 码元（replace 语义），故只占一个映射项
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
    const lines = normalized.split('\n');
    const offsets: number[] = [];
    const lengths: number[] = [];
    const oversized = new Set<number>();
    let start = 0; // 当前段在归一化文本中的码元起点
    for (let i = 0; i < lines.length; i++) {
      const seg = lines[i]!;
      const end = start + seg.length; // 终结符（或 EOF）之前的归一化位置
      const len = normByte[end]! - normByte[start]!;
      offsets.push(normByte[start]!);
      lengths.push(len);
      if (len >= maxLineBytes) oversized.add(i); // Infinity 时永不触发
      start = end + 1; // 跳过 '\\n'
    }
    return { lines, offsets, lengths, oversized };
  }

  /** 复合文本：CRLF/孤立 CR/空行/纯空白行/多字节中文+emoji/1MB 整巨行/尾行无终结符 */
  const EQUIV_TEXT = [
    'const a = 1;',
    '',
    '   ',
    'const s = "中文与 emoji 🎉 mixing";',
    'x'.repeat(1_048_576),
    'let b = 2;\r\nlet c = 3;',
    'old mac\rline',
    '\t',
    'tail()'
  ].join('\n');

  /** 以终结符收尾的复合文本：末尾空串条目（无 1MB 巨行，小切面穷举可负担） */
  const TAIL_TEXT = ['const a = 1;', '', '中文行', 'let x\r\nlet y', '🎉', ''].join('\n') + '\n';

  function assertEquivalent(text: string, split: number, maxLineBytes = Number.POSITIVE_INFINITY): void {
    const bytes = enc.encode(text);
    const ref = referenceIndex(text, maxLineBytes);
    const step = split === Number.POSITIVE_INFINITY ? bytes.length : split;
    const st = createCodeIndex(maxLineBytes);
    for (let i = 0; i < bytes.length; i += step) {
      advanceCodeIndex(st, bytes.subarray(i, i + step));
    }
    finishCodeIndex(st);
    expect(st.offsets, `切面 ${split} offsets`).toEqual(ref.offsets);
    expect(st.lengths, `切面 ${split} lengths`).toEqual(ref.lengths);
    expect([...st.oversized], `切面 ${split} oversized`).toEqual([...ref.oversized]);
    expect(st.loadedBytes, `切面 ${split} loadedBytes`).toBe(bytes.length);
    // 最强校验：条目数与行号严格对齐（code 行号 = 文本行号），索引字节逐行 decode
    // 回来 == 全量 buildLineIndex 行序列
    expect(st.offsets.length).toBe(ref.lines.length);
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
  }, 30_000);

  it('终结符收尾复合文本：末尾空串条目与全量口径等价', () => {
    for (const k of [Number.POSITIVE_INFINITY, 3, 4096]) assertEquivalent(TAIL_TEXT, k);
  });

  it('有限阈值等价：oversized 按 >= 判定与参照一致（等号即超限）', () => {
    // 中文字 9 字节、8 字节 ASCII 行均超限（阈值 8）；7 字节与空行不超
    assertEquivalent('12345678\n中文字\n\n1234567\nx', 4096, 8);
  });

  it('小型对抗文本穷举：全 1/2/3 字节切面等价', () => {
    const samples = [
      'a\r\n\r\nb',
      '\r\na\rb\n',
      'a\n\rb',
      '  \n a \n\t\nb',
      '中文\r\n行\r尾',
      '🎉\r\n🎉\r🎉',
      '\n', // 单终结符：['',''] 两条目
      'a\n', // 尾随终结符：['a',''] 末尾空串条目
      '' // 空文件：[''] 1 条目
    ];
    for (const text of samples) {
      for (const k of [1, 2, 3]) assertEquivalent(text, k);
    }
  });
});
