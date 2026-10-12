// hexSearch.test.ts — Task 2（hex 增强 spec H §2.2）：搜索输入解析纯函数
// （parseSearchInput：hex/文本消歧义、奇数位非法）+ 工具条搜索 DOM 行为
// （Enter 发起、进度/命中状态位、取消、两档高亮渲染、导航、IME 过滤、兜底扫描）。
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { renderHex, parseSearchInput } from '../src/hex';
import type { BinaryRequest, BinaryWorkerMessage, SearchChunkRequest, SearchRequest, SearchWindowRequest } from '../src/binary.worker';

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
});

function enc(s: string): Uint8Array {
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
}

describe('parseSearchInput', () => {
  it('偶数位合法 hex → hex 字节（空格可作分隔、大小写均可）', () => {
    expect(parseSearchInput('dead')).toEqual({ kind: 'hex', bytes: new Uint8Array([0xde, 0xad]) });
    expect(parseSearchInput('de ad')).toEqual({ kind: 'hex', bytes: new Uint8Array([0xde, 0xad]) });
    expect(parseSearchInput('DEAD')).toEqual({ kind: 'hex', bytes: new Uint8Array([0xde, 0xad]) });
  });

  it('奇数位 hex → invalid（aria-invalid 内联提示语义）', () => {
    expect(parseSearchInput('abc')).toEqual({ kind: 'invalid' });
    expect(parseSearchInput('d ad')).toEqual({ kind: 'invalid' });
  });

  it('其余 → 文本（UTF-8 编码）；空输入 → null 不动作', () => {
    // TextEncoder 产物与字面 Uint8Array 可能跨 realm，按字节序列比较
    const r = parseSearchInput('hi!');
    expect(r?.kind).toBe('text');
    expect(Array.from((r as { bytes: Uint8Array }).bytes)).toEqual([...enc('hi!')]);
    const r2 = parseSearchInput('0x10'); // 无 0x 语法，按文本
    expect(r2?.kind).toBe('text');
    expect(Array.from((r2 as { bytes: Uint8Array }).bytes)).toEqual([...enc('0x10')]);
    expect(parseSearchInput('')).toBeNull();
    expect(parseSearchInput('   ')).toBeNull();
  });
});

// ---- 工具条搜索 DOM 行为（fake worker：第 1 次调用给结构树，第 2 次给搜索）----

const BUF = (() => {
  const b = new Uint8Array(256);
  b.set([0xde, 0xad], 20); // 命中 @20（行 1）与 @200（行 12）
  b.set([0xde, 0xad], 200);
  return b;
})();

type FakeMsg = BinaryRequest | SearchChunkRequest | BinaryWorkerMessage;

function makeFake() {
  const requests: FakeMsg[] = [];
  const worker = {
    onmessage: null as ((ev: MessageEvent) => void) | null,
    postMessage: vi.fn((req: FakeMsg) => requests.push(req)),
    terminate: vi.fn(),
    respond(msg: BinaryWorkerMessage): void {
      worker.onmessage?.({ data: msg } as MessageEvent);
    }
  };
  return { worker, requests };
}

function setup(
  buffer: Uint8Array = BUF,
  createWorker?: () => Worker | null
): {
  inst: ReturnType<typeof renderHex>;
  target: HTMLElement;
  dump: HTMLElement;
  search: HTMLInputElement;
  caseToggle: HTMLInputElement;
  status: HTMLElement;
  cancel: HTMLButtonElement;
  fakes: ReturnType<typeof makeFake>[];
} {
  const target = document.createElement('div');
  document.body.append(target);
  const fakes: ReturnType<typeof makeFake>[] = [];
  const inst = renderHex(buffer, target, {
    createWorker:
      createWorker ??
      (() => {
        const f = makeFake();
        fakes.push(f);
        return f.worker as unknown as Worker; // 第 1 次=结构树（不响应），第 2 次=搜索
      })
  });
  return {
    inst,
    target,
    dump: target.querySelector('.vv-hex-dump') as HTMLElement,
    search: target.querySelector('.vv-hex-search') as HTMLInputElement,
    caseToggle: target.querySelector('.vv-hex-search-case') as HTMLInputElement,
    status: target.querySelector('.vv-hex-search-status') as HTMLElement,
    cancel: target.querySelector('.vv-hex-search-cancel') as HTMLButtonElement,
    fakes
  };
}

function pressEnter(el: HTMLInputElement, opts: { shift?: boolean; composing?: boolean } = {}): void {
  el.dispatchEvent(
    new KeyboardEvent('keydown', {
      key: 'Enter',
      shiftKey: opts.shift === true,
      isComposing: opts.composing === true,
      bubbles: true
    })
  );
}

async function flush(): Promise<void> {
  // 仅用于「已就绪链路」排空（client 就绪后的微任务回灌、无 Worker 兜底 scanAll
  // 的块间让出）。依赖 import('./client') 首载的场景不可用固定轮次等待——该导入
  // 经 vite-node 多跳异步传播，全仓并行加载下耗时不可控（固定预算会被击穿），
  // 须用 waitForSearchRequest 条件等待（同 hex.test 的 vi.waitFor 先例）。
  for (let i = 0; i < 4; i++) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
}

/** 条件等待搜索请求出现在 fake worker：import('./client') 就绪前 client 不存在、
 * postMessage 不会发生（ensureSearchClient 的 createWorker 调用在 pressEnter 同步
 * 栈内，故 fake 引用本身无需等待）。count 断言累计请求数下界（新搜索取代场景用 2）。 */
async function waitForSearchRequest(fake: ReturnType<typeof makeFake>, count = 1): Promise<void> {
  await vi.waitFor(() => {
    expect(fake.requests.length).toBeGreaterThanOrEqual(count);
  }, { timeout: 10_000 });
}

/** 搜索 fake（fakes[1]）回灌一次完整搜索（progress + done） */
function respondSearch(
  fake: ReturnType<typeof makeFake>,
  id: number,
  offsets: number[],
  opts: { truncated?: boolean; scanned?: number } = {}
): void {
  fake.worker.respond({
    id,
    type: 'search-progress',
    scanned: opts.scanned ?? 256,
    total: 256,
    hits: offsets.length,
    offsets
  });
  fake.worker.respond({ id, type: 'search-done', truncated: opts.truncated === true });
}

describe('renderHex：搜索工具条', () => {
  it('搜索控件齐备：input/大小写开关/上下导航/状态位/取消按钮（默认隐藏）', () => {
    const { inst, target, search, caseToggle, cancel, status } = setup();
    expect(search.className).toBe('vv-hex-search');
    expect(search.placeholder).toContain('hex');
    expect(caseToggle.getAttribute('aria-label')).toContain('区分大小写');
    expect(target.querySelector('.vv-hex-search-prev')).not.toBeNull();
    expect(target.querySelector('.vv-hex-search-next')).not.toBeNull();
    expect(status.textContent).toBe('');
    expect(cancel.style.display).toBe('none');
    inst.destroy();
    target.remove();
  });

  it('Enter 发起 hex 搜索：请求含 needle/副本数据；进度与命中状态位、两档高亮渲染', async () => {
    const { inst, target, dump, search, status, cancel, fakes } = setup();
    search.value = 'dead';
    pressEnter(search);
    await waitForSearchRequest(fakes[1]!);
    expect(fakes).toHaveLength(2);
    const req = fakes[1]!.requests[0] as SearchRequest;
    expect(req.kind).toBe('search');
    expect(req.needle).toEqual(new Uint8Array([0xde, 0xad]));
    expect(req.data).toEqual(BUF); // 副本
    expect(req.data).not.toBe(BUF);
    expect(cancel.style.display).toBe(''); // 搜索中显示取消
    respondSearch(fakes[1]!, (fakes[1]!.requests[0] as { id: number }).id, [20, 200]);
    expect(status.textContent).toBe('1/2 处命中'); // done 后自动定位首个命中
    expect(cancel.style.display).toBe('none');
    // 命中行（行 1：偏移 0x10）有高亮段；当前命中（首个）带 active 档
    const active = [...dump.querySelectorAll('.vv-hex-hit-active')];
    expect(active.length).toBeGreaterThan(0);
    expect(active.some((s) => s.textContent === 'de ad')).toBe(true); // hex 列
    expect(active.some((s) => s.textContent === '..')).toBe(true); // ASCII 列同档
    const rows = [...dump.querySelectorAll('.vv-hex-row')];
    const plainRow = rows.find((r) => r.textContent!.startsWith('00000000'))!;
    expect(plainRow.querySelectorAll('.vv-hex-hit')).toHaveLength(0); // 无命中行整串
    inst.destroy();
    target.remove();
  });

  it('奇数位 hex：aria-invalid + 内联提示，不发起搜索', async () => {
    const { inst, target, search, status, fakes } = setup();
    search.value = 'abc';
    pressEnter(search);
    await flush();
    expect(search.getAttribute('aria-invalid')).toBe('true');
    expect(status.textContent).toBe('hex 位数须为偶数');
    expect(fakes).toHaveLength(1); // 搜索 worker 未创建
    inst.destroy();
    target.remove();
  });

  it('大小写开关默认敏感（spec）；取消勾选为不敏感；hex 模式禁用开关', async () => {
    const { inst, target, search, caseToggle, fakes } = setup();
    expect(caseToggle.checked).toBe(true); // spec §Global Constraints：默认敏感
    search.value = 'Hi'; // 含非 hex 字符 → 文本模式
    pressEnter(search);
    await waitForSearchRequest(fakes[1]!);
    expect((fakes[1]!.requests[0] as { caseInsensitive?: boolean }).caseInsensitive).toBe(false);
    inst.destroy();
    target.remove();

    const b = setup();
    b.search.value = 'Hi';
    b.caseToggle.checked = false; // 取消「区分大小写」→ 不敏感
    pressEnter(b.search);
    await waitForSearchRequest(b.fakes[1]!);
    expect((b.fakes[1]!.requests[0] as { caseInsensitive?: boolean }).caseInsensitive).toBe(true);
    b.inst.destroy();
    b.target.remove();

    const c = setup();
    c.search.value = 'dead';
    c.search.dispatchEvent(new Event('input', { bubbles: true })); // 程序赋值需手动派发
    expect(c.caseToggle.disabled).toBe(true); // hex 模式禁用大小写开关
    pressEnter(c.search);
    await waitForSearchRequest(c.fakes[1]!);
    expect((c.fakes[1]!.requests[0] as { caseInsensitive?: boolean }).caseInsensitive).toBe(false);
    c.inst.destroy();
    c.target.remove();
  });

  it('导航：Enter 下一处 / Shift+Enter 上一处（循环），active 档随动并滚动定位', async () => {
    const { inst, target, dump, search, status, fakes } = setup();
    search.value = 'dead';
    pressEnter(search);
    await waitForSearchRequest(fakes[1]!);
    const searchFake = fakes[1]!;
    const id = (searchFake.requests[0] as { id: number }).id;
    respondSearch(searchFake, id, [20, 200]);
    expect(status.textContent).toBe('1/2 处命中');
    expect(dump.scrollTop).toBe(1 * 18); // 首个命中行 1 定位（jsdom 视口 0）
    pressEnter(search); // 输入未变 → 下一处
    expect(status.textContent).toBe('2/2 处命中');
    expect(dump.scrollTop).toBe(12 * 18); // 行 12
    const activeRow = [...dump.querySelectorAll('.vv-hex-row')].find((r) =>
      r.querySelector('.vv-hex-hit-active')
    );
    expect(activeRow!.textContent!.startsWith('000000c0')).toBe(true); // 200 ∈ 行 12（0xc0..0xcf）
    pressEnter(search, { shift: true }); // 上一处
    expect(status.textContent).toBe('1/2 处命中');
    pressEnter(search, { shift: true }); // 循环到末处
    expect(status.textContent).toBe('2/2 处命中');
    inst.destroy();
    target.remove();
  });

  it('截断：done truncated → 状态位「n 处命中（截断）」', async () => {
    const { inst, target, search, status, fakes } = setup();
    search.value = 'dead';
    pressEnter(search);
    await waitForSearchRequest(fakes[1]!);
    respondSearch(fakes[1]!, (fakes[1]!.requests[0] as { id: number }).id, [20], { truncated: true });
    expect(status.textContent).toBe('1/1 处命中（截断）');
    inst.destroy();
    target.remove();
  });

  it('取消按钮：搜索中可见，点击发取消请求并复位状态；旧 id 迟到消息不扰', async () => {
    const { inst, target, search, status, cancel, fakes } = setup();
    search.value = 'dead';
    pressEnter(search);
    await waitForSearchRequest(fakes[1]!); // client 就绪（否则 searchClient 为 null，点击无效）
    expect(cancel.style.display).toBe('');
    cancel.click();
    expect(fakes[1]!.requests.some((r) => (r as { kind?: string }).kind === 'search-cancel')).toBe(true);
    expect(cancel.style.display).toBe('none');
    expect(status.textContent).toBe('已取消');
    fakes[1]!.worker.respond({
      id: (fakes[1]!.requests[0] as { id: number }).id,
      type: 'search-progress',
      scanned: 256,
      total: 256,
      hits: 2,
      offsets: [20, 200]
    });
    expect(status.textContent).toBe('已取消'); // 已取消的搜索不再更新 UI
    inst.destroy();
    target.remove();
  });

  it('IME 组合期 Enter 不发起搜索（isComposing 过滤）', async () => {
    const { inst, target, search, fakes } = setup();
    search.value = 'dead';
    pressEnter(search, { composing: true });
    await flush();
    expect(fakes).toHaveLength(1); // 搜索 worker 未创建
    inst.destroy();
    target.remove();
  });

  it('新搜索自动取消旧任务：旧 id 的进度消息被丢弃，新搜索正常收尾', async () => {
    const { inst, target, search, status, fakes } = setup();
    search.value = 'dead';
    pressEnter(search);
    // 首个请求须真实发出（client 就绪）再发起第二个——否则第一次的 client 回调
    // 因 seq 已被取代而不发请求，两条请求的时序前提不成立
    await waitForSearchRequest(fakes[1]!);
    search.value = 'beef';
    pressEnter(search);
    await waitForSearchRequest(fakes[1]!, 2);
    expect(fakes[1]!.requests).toHaveLength(2);
    const idA = (fakes[1]!.requests[0] as { id: number }).id;
    const idB = (fakes[1]!.requests[1] as { id: number }).id;
    fakes[1]!.worker.respond({ id: idA, type: 'search-progress', scanned: 999, total: 999, hits: 1, offsets: [0] });
    expect(status.textContent).toBe('0/256'); // 旧任务进度被丢，仍是新任务初始进度
    fakes[1]!.worker.respond({ id: idB, type: 'search-progress', scanned: 128, total: 256, hits: 1, offsets: [190] });
    expect(status.textContent).toBe('128/256');
    fakes[1]!.worker.respond({ id: idB, type: 'search-done', truncated: false });
    expect(status.textContent).toBe('1/1 处命中'); // done 后自动定位首个命中
    inst.destroy();
    target.remove();
  });

  it('无 Worker 环境：主线程 scanAll 兜底，命中与高亮照常', async () => {
    const { inst, target, dump, search, status } = setup(BUF, () => null);
    search.value = 'dead';
    pressEnter(search);
    await flush();
    expect(status.textContent).toBe('1/2 处命中'); // done 后自动定位首个命中
    expect(dump.querySelectorAll('.vv-hex-hit-active').length).toBeGreaterThan(0);
    inst.destroy();
    target.remove();
  });
});

// ---- io-streaming Task 6：窗口模式搜索（need/chunk 协议，无 data 请求）----

describe('renderHex：窗口模式搜索（need/chunk 协议）', () => {
  /** fake 全量文件：字节值 = 偏移 mod 256（'deadbeef' 命中 @222 起每 256 字节重复） */
  const FULL = Uint8Array.from({ length: 200_000 }, (_, i) => i & 0xff);
  const HEAD = FULL.slice(0, 8192);

  /** fake read：按 ByteRange（end 含）切片并记录调用 */
  function readOf(calls: Array<{ start: number; end: number }>) {
    return async (r: { start: number; end: number }): Promise<Uint8Array<ArrayBuffer>> => {
      calls.push({ start: r.start, end: r.end });
      const end = Math.min(r.end, FULL.length - 1);
      return FULL.slice(r.start, end + 1);
    };
  }

  function setupWindow(
    read: (r: { start: number; end: number }) => Promise<Uint8Array<ArrayBuffer>>,
    createWorker?: () => Worker | null
  ): {
    inst: ReturnType<typeof renderHex>;
    target: HTMLElement;
    dump: HTMLElement;
    search: HTMLInputElement;
    status: HTMLElement;
    cancel: HTMLButtonElement;
    fakes: ReturnType<typeof makeFake>[];
  } {
    const target = document.createElement('div');
    document.body.append(target);
    const fakes: ReturnType<typeof makeFake>[] = [];
    const inst = renderHex(HEAD, target, {
      createWorker:
        createWorker ??
        (() => {
          const f = makeFake();
          fakes.push(f);
          return f.worker as unknown as Worker; // 第 1 次=结构树（不响应），第 2 次=搜索
        })
    }, { size: FULL.length, head: HEAD, read });
    return {
      inst,
      target,
      dump: target.querySelector('.vv-hex-dump') as HTMLElement,
      search: target.querySelector('.vv-hex-search') as HTMLInputElement,
      status: target.querySelector('.vv-hex-search-status') as HTMLElement,
      cancel: target.querySelector('.vv-hex-search-cancel') as HTMLButtonElement,
      fakes
    };
  }

  it('窗口模式走 need/chunk 协议：请求无 data、read 按区间供块（不全量预读），命中照常', async () => {
    const calls: Array<{ start: number; end: number }> = [];
    const { inst, target, dump, search, status, cancel, fakes } = setupWindow(readOf(calls));
    await flush();
    search.value = 'deadbeef';
    pressEnter(search);
    await waitForSearchRequest(fakes[1]!);
    // 搜索请求为窗口形态：无 data、带 size（worker 不再收到全量副本）
    const req = fakes[1]!.requests[0] as SearchWindowRequest;
    expect('data' in req).toBe(false);
    expect(req.size).toBe(FULL.length);
    expect(req.needle).toEqual(new Uint8Array([0xde, 0xad, 0xbe, 0xef]));
    expect(cancel.style.display).toBe('');
    // worker 需要首 1MB → 末块钳制即全文件 → client 经 ctx.read 供块（end 含换算）
    const id = req.id;
    fakes[1]!.worker.respond({ id, type: 'search-need', start: 0, end: FULL.length });
    await flush();
    // 无全量回退读（T5 过渡方案已移除）：触达偏移 0 的 read 仅 need 供块这一次
    //（结构树尾窗读不涉偏移 0，与供块读可区分）
    expect(calls.filter((c) => c.start === 0)).toEqual([{ start: 0, end: FULL.length - 1 }]);
    const chunk = fakes[1]!.requests[1] as SearchChunkRequest;
    expect(chunk).toMatchObject({ id, type: 'search-chunk', start: 0 });
    expect(chunk.bytes).toEqual(FULL);
    // 测试扮演 worker：progress + done（命中 @222/@478，行 13/行 29）
    fakes[1]!.worker.respond({ id, type: 'search-progress', scanned: FULL.length, total: FULL.length, hits: 2, offsets: [222, 478] });
    fakes[1]!.worker.respond({ id, type: 'search-done', truncated: false });
    expect(status.textContent).toBe('1/2 处命中'); // done 后自动定位首个命中
    expect(dump.querySelectorAll('.vv-hex-hit-active').length).toBeGreaterThan(0);
    inst.destroy();
    target.remove();
  });

  it('窗口模式供数读失败：状态位「搜索数据读取失败」+ 复位忙碌（发 cancel，不悬挂）', async () => {
    const { inst, target, search, status, cancel, fakes } = setupWindow(async () => {
      throw new Error('io gone');
    });
    await flush();
    search.value = 'deadbeef';
    pressEnter(search);
    // 读全拒时 structReady 在尾窗 ensure 处即失败、结构树 worker 不创建——搜索
    // fake 取最后一个（正常路径为 fakes[1]，本路径为 fakes[0]）；createWorker 在
    // pressEnter 同步栈内已调用，引用同步可得
    const searchFake = fakes[fakes.length - 1]!;
    await waitForSearchRequest(searchFake);
    const id = (searchFake.requests[0] as { id: number }).id;
    searchFake.worker.respond({ id, type: 'search-need', start: 0, end: 4 });
    await flush();
    expect(status.textContent).toBe('搜索数据读取失败');
    expect(cancel.style.display).toBe('none'); // 忙碌已复位
    expect(searchFake.requests.some((r) => (r as { kind?: string }).kind === 'search-cancel')).toBe(true);
    inst.destroy();
    target.remove();
  });

  // 终审 F1：无 Worker 兜底 + head（8KB）不足全量 → 扫描前的一次全量回退读
  // reject——此前该 rejection 无 handler（unhandled rejection 且忙碌态永不复位），
  // 修复后链尾 catch 与 worker 主路径 r.error 同口径收尾
  it('无 Worker 兜底 + 窗口全量回退读失败：状态位「搜索数据读取失败」+ 复位忙碌（不悬挂）', async () => {
    const { inst, target, search, status, cancel } = setupWindow(
      async () => {
        throw new Error('io gone');
      },
      () => null // 无 Worker：走主线程 scanAll 兜底（不 import client，读闭包直接拒）
    );
    await flush();
    search.value = 'deadbeef';
    pressEnter(search);
    await flush();
    expect(status.textContent).toBe('搜索数据读取失败');
    expect(cancel.style.display).toBe('none'); // 忙碌已复位
    inst.destroy();
    target.remove();
  });
});
