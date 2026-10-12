// textWindow.test.ts — Task 2（io-streaming 计划 3）：公共文本窗口单测。用例从
// jsonl 等价性覆盖平移：块解码缓存 LRU（触新/逐出/重建）、前缀解码游标（升序
// 推进/降序回退/游标落点）、跨块字节域拼装（块切口打碎多字节字符不得产出
// U+FFFD）、块 0 BOM 剥离口径、末块短读 gather。纯逻辑模块，blockAt 闭包模拟
// BlockStream 块表取数。
import { describe, expect, it } from 'vitest';
import { createTextWindow } from '../src/textWindow';

/** 测试块大小：4 字节（切口刻意打碎多字节字符，便于断言字节域拼装） */
const B = 4;

/** 10 字节样例：'ab中d中f'——「中」（E4 B8 AD）在块 0/1 与块 1/2 两处切口被腰斩：
 * 块 0=[61 62 e4 b8]、块 1=[ad 64 e4 b8]、块 2=[ad 66]（末块短读 2 字节） */
const CONTENT = new TextEncoder().encode('ab中d中f');

/** fake 块表：按块号切片（末块自然短读），记录每次取数（LRU 重建断言用） */
function fakeBlocks(opts: { content?: Uint8Array<ArrayBuffer>; calls?: number[] }) {
  const content = opts.content ?? CONTENT;
  return {
    calls: opts.calls,
    blockAt: (b: number): Uint8Array<ArrayBuffer> => {
      opts.calls?.push(b);
      return content.subarray(b * B, (b + 1) * B);
    }
  };
}

describe('createTextWindow', () => {
  it('① entryOf 整块解码 + 前缀解码游标：升序推进命中游标、降序回退整前缀、游标随查询落点', () => {
    const win = createTextWindow({ blockSize: B, maxBlocks: 8, blockAt: fakeBlocks({}).blockAt });
    const e = win.entryOf(0);
    expect(e.text).toBe('ab\uFFFD'); // 块内被腰斩的「中」首两字节 → 单个替换符（fatal:false 口径）
    expect(e.walkByte).toBe(0); // 初始游标在块首
    expect(e.walkChar).toBe(0);
    expect(win.charOffsetOf(e, 0, 2)).toBe(2); // 'ab' 两字节两字符
    expect(win.charOffsetOf(e, 0, 4)).toBe(3); // 自游标 [62..) 前缀 [e4 b8] → 1 替换符
    expect(e.walkByte).toBe(4); // 游标推进到查询点
    expect(e.walkChar).toBe(3);
    expect(win.charOffsetOf(e, 0, 1)).toBe(1); // 降序查询：回退整前缀 decode([61])
    expect(e.walkByte).toBe(1); // 游标回退重落
    expect(e.walkChar).toBe(1);
  });

  it('② 跨块字节域拼装：块切口打碎的多字节字符缝合后单次解码，无重复 U+FFFD', () => {
    const win = createTextWindow({ blockSize: B, maxBlocks: 8, blockAt: fakeBlocks({}).blockAt });
    expect(win.decode(win.gather(0, 5))).toBe('ab中'); // 「中」跨块 0/1（e4 b8 | ad）
    expect(win.decode(win.gather(2, 9))).toBe('中d中'); // 两处切口（0/1 与 1/2）同程缝合
    expect(win.decode(win.gather(0, 10))).toBe('ab中d中f'); // 全域拼装（含末块短读）
  });

  it('③ 缓存 LRU：上限逐出最旧、命中触新（非 FIFO）、已逐出块经 blockAt 重建', () => {
    const calls: number[] = [];
    const { blockAt } = fakeBlocks({ calls });
    const win = createTextWindow({ blockSize: B, maxBlocks: 2, blockAt });
    win.entryOf(0);
    win.entryOf(1);
    expect(win.entries.size).toBe(2);
    win.entryOf(0); // 触新：命中不重建
    expect(calls).toStrictEqual([0, 1]);
    win.entryOf(2); // 超限：逐出最旧（块 1——块 0 因触新存活）
    expect(win.entries.has(0)).toBe(true);
    expect(win.entries.has(1)).toBe(false);
    expect(win.entries.size).toBe(2);
    win.entryOf(1); // 已逐出块重建：经 blockAt 重取字节
    expect(calls).toStrictEqual([0, 1, 2, 1]);
  });

  it('④ 块 0 BOM 剥离口径：条目解码与 gather/decode 同一 decoder 单例（与整块解码一致）', () => {
    const bom = new Uint8Array([0xef, 0xbb, 0xbf, 0x7b]); // BOM + '{'
    const win = createTextWindow({
      blockSize: B,
      maxBlocks: 4,
      blockAt: (b) => bom.subarray(b * B, (b + 1) * B)
    });
    expect(win.entryOf(0).text).toBe('{'); // decode 剥 BOM（jsonl 块 0 口径）
    expect(win.decode(win.gather(0, 4))).toBe('{'); // 同口径
  });

  it('⑤ 末块短读：gather 跨入末块按实际块长拼装（不越界）', () => {
    const win = createTextWindow({ blockSize: B, maxBlocks: 8, blockAt: fakeBlocks({}).blockAt });
    expect(win.decode(win.gather(5, 10))).toBe('d中f'); // 块 1 全部 + 块 2 短读 2 字节
  });

  it('⑥ 参数校验：blockSize/maxBlocks 须为正整数', () => {
    const { blockAt } = fakeBlocks({});
    expect(() => createTextWindow({ blockSize: 0, maxBlocks: 4, blockAt })).toThrow(/blockSize/);
    expect(() => createTextWindow({ blockSize: B, maxBlocks: 0, blockAt })).toThrow(/maxBlocks/);
    expect(() => createTextWindow({ blockSize: B, maxBlocks: 1.5, blockAt })).toThrow(/maxBlocks/);
  });
});
