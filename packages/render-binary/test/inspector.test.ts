// inspector.test.ts — Task 3（hex 增强 spec H §2.3）：数据检查器。
// 三段：decodeAt 解码纯函数（已知字节序列逐类型断言、字节序两向、字节不足降级、
// bool/UTF-8 截断/NaN-Inf）；renderHexBytes cursor/flash 档（span 切分优先级扩展）；
// renderHex cursor 点击/键盘定位与 getInspector/setLittle 鸭子接口（jsdom DOM）。
import { describe, expect, it, vi, beforeEach, afterEach, type MockInstance } from 'vitest';
import { decodeAt, type InspectorRow } from '../src/inspector';
import { renderHexBytes, byteIndexAtColumn } from '../src/hexBytes';
import type { HexHighlight, HexRow } from '../src/hexBytes';
import { renderHex } from '../src/hex';

// ---- decodeAt：解码表纯函数 ----

/** spec §2.3 已知字节序列（brief Step 1 原文：00 01 02 03 04 05 06 07 08） */
const KNOWN = new Uint8Array([0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08]);

function rowOf(rows: InspectorRow[], label: string): InspectorRow {
  return rows.find((r) => r.label === label)!;
}

describe('decodeAt：已知字节序列', () => {
  it('行集与顺序锁定（int8..64 / uint8..64 / float32/64 / bool / UTF-8 / hex），offset 0 全可用', () => {
    const rows = decodeAt(KNOWN, 0, true);
    expect(rows.map((r) => r.label)).toEqual([
      'int8', 'int16', 'int32', 'int64',
      'uint8', 'uint16', 'uint32', 'uint64',
      'float32', 'float64', 'bool', 'UTF-8', 'hex'
    ]);
    expect(rows.every((r) => r.available)).toBe(true);
  });

  it('字节序两向：int16/uint32/float32/int64/uint64 little/big 值断言（ DataView 实测值）', () => {
    const little = decodeAt(KNOWN, 0, true);
    const big = decodeAt(KNOWN, 0, false);
    expect(rowOf(little, 'int16').value).toBe('256');
    expect(rowOf(big, 'int16').value).toBe('1');
    expect(rowOf(little, 'uint32').value).toBe('50462976');
    expect(rowOf(big, 'uint32').value).toBe('66051');
    expect(rowOf(little, 'float32').value).toBe('3.820471434542632e-37');
    expect(rowOf(big, 'float32').value).toBe('9.25571648671185e-41');
    expect(rowOf(little, 'int64').value).toBe('506097522914230528');
    expect(rowOf(big, 'int64').value).toBe('283686952306183');
    expect(rowOf(little, 'uint64').value).toBe('506097522914230528');
    expect(rowOf(big, 'uint64').value).toBe('283686952306183');
  });

  it('符号与 uint8：ff fe → int8 -1 / uint8 255 / int16 little -257 / big -2', () => {
    const rows = decodeAt(new Uint8Array([0xff, 0xfe]), 0, true);
    expect(rowOf(rows, 'int8').value).toBe('-1');
    expect(rowOf(rows, 'uint8').value).toBe('255');
    expect(rowOf(rows, 'int16').value).toBe('-257');
    expect(rowOf(rows, 'bool').value).toBe('true');
    expect(rowOf(decodeAt(new Uint8Array([0xff, 0xfe]), 0, false), 'int16').value).toBe('-2');
  });

  it('bool 非零即真：仅看首字节，0 → false', () => {
    expect(rowOf(decodeAt(new Uint8Array([0]), 0, true), 'bool').value).toBe('false');
    expect(rowOf(decodeAt(new Uint8Array([0, 1]), 0, true), 'bool').value).toBe('false');
    expect(rowOf(decodeAt(new Uint8Array([5]), 0, true), 'bool').value).toBe('true');
  });

  it('float NaN/Inf 原样（IEEE 754 位型 → String）', () => {
    const f = new Uint8Array([0, 0, 0xc0, 0x7f, 0, 0, 0x80, 0x7f, 0, 0, 0x80, 0xff]);
    expect(rowOf(decodeAt(f, 0, true), 'float32').value).toBe('NaN');
    expect(rowOf(decodeAt(f, 4, true), 'float32').value).toBe('Infinity');
    expect(rowOf(decodeAt(f, 8, true), 'float32').value).toBe('-Infinity');
  });

  it('字节不足：剩余字节不足的类型 available=false 且 value=—；小宽度仍可用', () => {
    const rows3 = decodeAt(new Uint8Array([0xde, 0xad, 0xbe]), 0, true);
    for (const label of ['float32', 'int32', 'uint32', 'int64', 'uint64', 'float64']) {
      expect(rowOf(rows3, label)).toEqual({ label, value: '—', available: false });
    }
    expect(rowOf(rows3, 'int16').available).toBe(true);
    expect(rowOf(rows3, 'uint8').available).toBe(true);
    expect(rowOf(decodeAt(new Uint8Array([0xde, 0xad, 0xbe]), 2, true), 'int16').available).toBe(false);
    expect(rowOf(decodeAt(new Uint8Array([0xde, 0xad, 0xbe]), 2, true), 'uint8').available).toBe(true);
    // offset 出界（防御路径）：整表不可用
    const out = decodeAt(new Uint8Array([1]), 1, true);
    expect(out.every((r) => !r.available && r.value === '—')).toBe(true);
  });

  it('UTF-8 片段：16 字节截断，中文跨字符截断补 U+FFFD', () => {
    const rows = decodeAt(new TextEncoder().encode('你好'.repeat(4)), 0, true); // 24 字节
    expect(rowOf(rows, 'UTF-8').value).toBe('你好你好你\uFFFD'); // 前 16 字节 = 5 字 + 半个
    expect(rowOf(decodeAt(new TextEncoder().encode('hi 你'), 0, true), 'UTF-8').value).toBe('hi 你');
  });

  it('hex 回显：offset 起小写两位空格分隔，16 字节截断', () => {
    const b = new Uint8Array(20);
    for (let i = 0; i < b.length; i++) b[i] = 0x10 + i;
    expect(rowOf(decodeAt(b, 3, true), 'hex').value).toBe('13 14 15 16 17 18 19 1a 1b 1c 1d 1e 1f 20 21 22');
    expect(rowOf(decodeAt(b, 18, true), 'hex').value).toBe('22 23'); // 尾部不足 16 字节
  });
});

// ---- renderHexBytes：cursor/flash 档（Task 2 span 切分的档位扩展）----

describe('renderHexBytes：cursor/flash 档', () => {
  const data = new Uint8Array(16);
  for (let i = 0; i < 16; i++) data[i] = i;

  it('cursor 单字节区间：hex 列与 ASCII 列对应字节 cursor 档', () => {
    const rows = renderHexBytes(data, 0, [{ start: 5, end: 6, active: false, cursor: true }]) as HexRow[];
    expect(rows[0]!.spans.filter((s) => s.cursor).map((s) => s.text)).toEqual(['05', '.']);
    expect(rows[0]!.text).toBe(renderHexBytes(data, 0)[0]); // 整行文本不变
  });

  it('cursor 与当前命中间字节重叠：cursor 档胜出（active 档被吞并）', () => {
    const rows = renderHexBytes(data, 0, [
      { start: 5, end: 6, active: true },
      { start: 5, end: 6, active: false, cursor: true }
    ]) as HexRow[];
    expect(rows[0]!.spans.filter((s) => s.cursor).map((s) => s.text)).toEqual(['05', '.']);
    expect(rows[0]!.spans.some((s) => s.active === true)).toBe(false);
  });

  it('flash 档：优先级 cursor > flash > active（命中）', () => {
    const rows = renderHexBytes(data, 0, [
      { start: 5, end: 6, active: true },
      { start: 5, end: 6, active: false, flash: true }
    ]) as HexRow[];
    expect(rows[0]!.spans.filter((s) => s.flash).map((s) => s.text)).toEqual(['05', '.']);
    const mixed = renderHexBytes(data, 0, [
      { start: 5, end: 6, active: false, flash: true },
      { start: 5, end: 6, active: false, cursor: true }
    ]) as HexRow[];
    expect(mixed[0]!.spans.filter((s) => s.cursor).map((s) => s.text)).toEqual(['05', '.']);
    expect(mixed[0]!.spans.some((s) => s.flash)).toBe(false);
  });

  it('byteIndexAtColumn：偏移列归首字节、hex 列每字节 3 列（分隔空格归左邻）、ASCII 列逐字节、越界 clamp', () => {
    expect(byteIndexAtColumn(0, 16)).toBe(0); // 偏移列 → 首字节（最近字节语义）
    expect(byteIndexAtColumn(9, 16)).toBe(0);
    expect(byteIndexAtColumn(10, 16)).toBe(0); // hex 列首字符
    expect(byteIndexAtColumn(12, 16)).toBe(0); // 分隔空格归左邻字节
    expect(byteIndexAtColumn(13, 16)).toBe(1); // 下一字节首字符
    expect(byteIndexAtColumn(56, 16)).toBe(15);
    expect(byteIndexAtColumn(59, 16)).toBe(15); // hex/ASCII 列间隙归末字节
    expect(byteIndexAtColumn(60, 16)).toBe(0); // ASCII 列首字符
    expect(byteIndexAtColumn(75, 16)).toBe(15);
    expect(byteIndexAtColumn(76, 16)).toBe(15); // 闭合竖线归末字节
    expect(byteIndexAtColumn(75, 3)).toBe(2); // 尾行 clamp 到实际字节数
  });
});

// ---- renderHex：cursor 定位 / getInspector / setLittle（jsdom DOM 行为）----
// jsdom 无 ResizeObserver（虚拟滚动依赖），全文件 stub（照 hex.test.ts 惯例）
beforeEach(() => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    }
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const BUF = (() => {
  const b = new Uint8Array(256);
  b.set([0x01, 0x00], 6); // setLittle 值翻转用（uint16：little 1 / big 256）
  b.set([0xde, 0xad], 20); // 与搜索命中共存用
  return b;
})();

function setup(buffer: Uint8Array = BUF): {
  inst: ReturnType<typeof renderHex>;
  target: HTMLElement;
  dump: HTMLElement;
} {
  const target = document.createElement('div');
  document.body.append(target);
  const inst = renderHex(buffer, target, { createWorker: () => null });
  return { inst, target, dump: target.querySelector('.vv-hex-dump') as HTMLElement };
}

/** 等宽布局 mock：行宽 mock 为**内容宽** 77 字符 × 10px/字符（renderHexBytes 行总宽
 * 恒 77）。真实布局由 app.css `.vv-hex-row { width: max-content; min-width: 100% }`
 * 保证（fix round 1 Critical 1：无此规则时行被 .vv-virtual-viewport 拉伸为容器宽，
 * 「行宽/字符数=单字符宽」高估）；jsdom 无布局只能以 mock 固化该假设，真实布局
 * 断言在 e2e t-hex-enhance.spec.ts（Range 实测字符宽 × 77 ≈ 行宽）。 */
function mockRowRect(): MockInstance {
  return vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({
    left: 0, top: 0, right: 770, bottom: 18, width: 770, height: 18, x: 0, y: 0,
    toJSON(): DOMRect {
      return {} as DOMRect;
    }
  } as DOMRect);
}

function clickRow(dump: HTMLElement, clientX: number): void {
  const row = dump.querySelector('.vv-hex-row') as HTMLElement;
  row.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX, clientY: 9 }));
}

function pressEnter(el: HTMLInputElement): void {
  el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
}

function key(dump: HTMLElement, k: string): boolean {
  return dump.dispatchEvent(new KeyboardEvent('keydown', { key: k, cancelable: true, bubbles: true }));
}

async function flush(): Promise<void> {
  for (let i = 0; i < 4; i++) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
}

describe('renderHex：cursor 与检查器鸭子接口', () => {
  it('初始无光标：getInspector() 为 null，无 cursor 高亮', () => {
    const { inst, dump, target } = setup();
    expect(inst.getInspector()).toBeNull();
    expect(dump.querySelectorAll('.vv-hex-cursor')).toHaveLength(0);
    inst.destroy();
    target.remove();
  });

  it('点击 hex 列：按 x 坐标换算字节，getInspector 返回解码快照 + 光标字节双 span 高亮', () => {
    const { inst, dump, target } = setup();
    const restore = mockRowRect();
    clickRow(dump, 195); // col 19 → 字节 3
    restore.mockRestore();
    expect(inst.getInspector()).toEqual({ offset: 3, little: true, rows: decodeAt(BUF, 3, true) });
    const cursors = [...dump.querySelectorAll('.vv-hex-cursor')];
    expect(cursors.map((s) => s.textContent)).toEqual(['00', '.']); // hex 列 + ASCII 列同字节
    for (const s of cursors) {
      expect(s.closest('.vv-hex-row')!.textContent!.startsWith('00000000')).toBe(true);
    }
    inst.destroy();
    target.remove();
  });

  it('点击 ASCII 列：col 62 → 字节 2；偏移列/列间隙归最近字节（首/末）', () => {
    const { inst, dump, target } = setup();
    const restore = mockRowRect();
    clickRow(dump, 625); // col 62 → ASCII 第 3 字符 → 字节 2
    expect(inst.getInspector()!.offset).toBe(2);
    clickRow(dump, 50); // col 5 → 偏移列 → 首字节
    expect(inst.getInspector()!.offset).toBe(0);
    clickRow(dump, 595); // col 59 → 列间隙 → 末字节
    expect(inst.getInspector()!.offset).toBe(15);
    restore.mockRestore();
    inst.destroy();
    target.remove();
  });

  it('无布局环境（行宽 0，jsdom 默认）：点击忽略、不抛错、光标保持未定位', () => {
    const { inst, dump, target } = setup();
    clickRow(dump, 195);
    expect(inst.getInspector()).toBeNull();
    expect(dump.querySelectorAll('.vv-hex-cursor')).toHaveLength(0);
    inst.destroy();
    target.remove();
  });

  it('键盘 ±1：ArrowRight/ArrowLeft 微调并 clamp 首字节；拦截容器默认滚动', () => {
    const { inst, dump, target } = setup();
    const restore = mockRowRect();
    clickRow(dump, 105); // col 10 → 字节 0
    expect(inst.getInspector()!.offset).toBe(0);
    expect(key(dump, 'ArrowRight')).toBe(false); // preventDefault 已调用
    expect(inst.getInspector()!.offset).toBe(1);
    key(dump, 'ArrowLeft');
    key(dump, 'ArrowLeft');
    expect(inst.getInspector()!.offset).toBe(0); // 首字节 clamp
    restore.mockRestore();
    inst.destroy();
    target.remove();
  });

  it('无光标时方向键不动作、不拦截（交还容器滚动）', () => {
    const { inst, dump, target } = setup();
    expect(key(dump, 'ArrowRight')).toBe(true);
    expect(inst.getInspector()).toBeNull();
    inst.destroy();
    target.remove();
  });

  it('setLittle：字节序翻转 → getInspector little 与行值随之翻转（offset 不变）', () => {
    const { inst, dump, target } = setup();
    const restore = mockRowRect();
    clickRow(dump, 285); // col 28 → 字节 6（字节 01 00）
    restore.mockRestore();
    const snap1 = inst.getInspector()!;
    expect(snap1.little).toBe(true);
    expect(snap1.rows.find((r) => r.label === 'uint16')!.value).toBe('1');
    inst.setLittle(false);
    const snap2 = inst.getInspector()!;
    expect(snap2.little).toBe(false);
    expect(snap2.offset).toBe(6);
    expect(snap2.rows.find((r) => r.label === 'uint16')!.value).toBe('256');
    inst.destroy();
    target.remove();
  });

  it('cursor 与搜索命中共存：cursor 档优先于当前命中档，命中其余字节保持 active 档', async () => {
    const { inst, dump, target } = setup();
    const search = target.querySelector('.vv-hex-search') as HTMLInputElement;
    search.value = 'dead';
    pressEnter(search);
    await flush(); // 无 worker → 主线程 scanAll 兜底
    expect(inst.getInspector()).toBeNull(); // 搜索导航不定位光标
    const restore = mockRowRect();
    const row10 = [...dump.querySelectorAll('.vv-hex-row')].find((r) =>
      r.textContent!.startsWith('00000010')
    ) as HTMLElement;
    row10.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 225, clientY: 9 })); // 行内字节 4 → 偏移 20
    restore.mockRestore();
    expect(inst.getInspector()!.offset).toBe(20);
    const row = [...dump.querySelectorAll('.vv-hex-row')].find((r) =>
      r.textContent!.startsWith('00000010')
    )!;
    expect([...row.querySelectorAll('.vv-hex-cursor')].map((s) => s.textContent)).toEqual(['de', '.']);
    expect([...row.querySelectorAll('.vv-hex-hit-active')].map((s) => s.textContent)).toEqual(['ad', '.']);
    inst.destroy();
    target.remove();
  });

  it('跳转目标字节 flash（Task 1 行级收编为字节级）：1s 后重绘摘除', () => {
    vi.useFakeTimers();
    try {
      const { inst, target, dump } = setup();
      const input = target.querySelector('.vv-hex-goto') as HTMLInputElement;
      input.value = '0xf7'; // 256 字节 buffer 内（末字节 0xff 之前），行内第 8 字节
      pressEnter(input);
      const flashed = [...dump.querySelectorAll('.vv-hex-goto-flash')] as HTMLElement[];
      expect(flashed.map((s) => s.textContent)).toEqual(['00', '.']); // 单字节（hex+ASCII）
      for (const s of flashed) {
        expect(s.closest('.vv-hex-row')!.textContent!.startsWith('000000f0')).toBe(true);
      }
      vi.advanceTimersByTime(1000);
      expect(dump.querySelectorAll('.vv-hex-goto-flash')).toHaveLength(0);
      inst.destroy();
      target.remove();
    } finally {
      vi.useRealTimers();
    }
  });
});
