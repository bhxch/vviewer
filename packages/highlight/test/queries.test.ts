import { describe, expect, it, vi, afterEach } from 'vitest';
import { expandQuery, expandQueryAsync, type QueryAssets } from '../src/queries';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('expandQuery（查询继承展开器）', () => {
  it('子声明 inherits 时，展开结果父内容在前、子内容在后', () => {
    const assets: QueryAssets = new Map([
      ['parent', { highlights: '(comment) @comment-parent' }],
      ['child', { highlights: '; inherits: parent\n(identifier) @ident-child' }],
    ]);
    const out = expandQuery(assets, 'child');
    expect(out).not.toBeNull();
    expect(out?.highlights).toBe('(comment) @comment-parent\n(identifier) @ident-child');
    expect(out?.injections).toBe('');
  });

  it('多层链 a→b→c 按祖先顺序展开', () => {
    const assets: QueryAssets = new Map([
      ['a', { highlights: 'A' }],
      ['b', { highlights: '; inherits: a\nB' }],
      ['c', { highlights: '; inherits: b\nC' }],
    ]);
    expect(expandQuery(assets, 'c')?.highlights).toBe('A\nB\nC');
  });

  it('逗号分隔多父按声明顺序展开（含空格；不去重）', () => {
    const assets: QueryAssets = new Map([
      ['ecma', { highlights: 'E' }],
      ['_typescript', { highlights: '; inherits: ecma\nT' }],
      ['typescript', { highlights: '; inherits: ecma, _typescript\nTS' }],
    ]);
    expect(expandQuery(assets, 'typescript')?.highlights).toBe('E\nE\nT\nTS');
  });

  it('highlights 与 injections 分别拼接', () => {
    const assets: QueryAssets = new Map([
      ['p', { highlights: 'PH', injections: 'PI' }],
      ['c', { highlights: '; inherits: p\nCH', injections: '; inherits: p\nCI' }],
    ]);
    expect(expandQuery(assets, 'c')).toEqual({ highlights: 'PH\nCH', injections: 'PI\nCI' });
  });

  it('环继承抛 Error("循环继承")', () => {
    const assets: QueryAssets = new Map([
      ['a', { highlights: '; inherits: b\nA' }],
      ['b', { highlights: '; inherits: a\nB' }],
    ]);
    expect(() => expandQuery(assets, 'a')).toThrowError('循环继承');
  });

  it('缺父目录记 console.warn 并跳过，子内容仍返回', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const assets: QueryAssets = new Map([
      ['child', { highlights: '; inherits: ghost\nCHILD' }],
    ]);
    expect(expandQuery(assets, 'child')?.highlights).toBe('CHILD');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain('ghost');
  });

  it('inherits 只认头部注释区：正文后的注释不生效', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const assets: QueryAssets = new Map([
      ['odd', { highlights: '(comment) @c\n; inherits: ghost' }],
    ]);
    expect(expandQuery(assets, 'odd')?.highlights).toBe('(comment) @c\n; inherits: ghost');
    expect(warn).not.toHaveBeenCalled();
  });

  it('语言不存在返回 null', () => {
    expect(expandQuery(new Map(), 'nope')).toBeNull();
  });

  it('菱形继承不误报环（父内容只按链路展开）', () => {
    const assets: QueryAssets = new Map([
      ['root', { highlights: 'R' }],
      ['left', { highlights: '; inherits: root\nL' }],
      ['right', { highlights: '; inherits: root\nRt' }],
      ['diamond', { highlights: '; inherits: left, right\nD' }],
    ]);
    expect(expandQuery(assets, 'diamond')?.highlights).toBe('R\nL\nR\nRt\nD');
  });
});

describe('expandQueryAsync（fetch 版查询来源）', () => {
  /** Map 形态的异步来源（模拟 Worker 端 fetch：未知语言返回 null） */
  function asyncSource(assets: QueryAssets) {
    return async (lang: string) => assets.get(lang) ?? null;
  }

  it('继承链展开结果与同步版一致', async () => {
    const assets: QueryAssets = new Map([
      ['ecma', { highlights: 'E', injections: 'EI' }],
      ['typescript', { highlights: '; inherits: ecma\nTS', injections: '; inherits: ecma\nTI' }],
    ]);
    const out = await expandQueryAsync(asyncSource(assets), 'typescript');
    expect(out).toEqual({ highlights: 'E\nTS', injections: 'EI\nTI' });
  });

  it('环继承抛 Error("循环继承")', async () => {
    const assets: QueryAssets = new Map([
      ['a', { highlights: '; inherits: b\nA' }],
      ['b', { highlights: '; inherits: a\nB' }],
    ]);
    await expect(expandQueryAsync(asyncSource(assets), 'a')).rejects.toThrowError('循环继承');
  });

  it('缺父记 warn 并跳过；语言无查询文件返回 null', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const assets: QueryAssets = new Map([
      ['child', { highlights: '; inherits: ghost\nCHILD' }],
    ]);
    const out = await expandQueryAsync(asyncSource(assets), 'child');
    expect(out?.highlights).toBe('CHILD');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(await expandQueryAsync(asyncSource(assets), 'nope')).toBeNull();
  });
});
