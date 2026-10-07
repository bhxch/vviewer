import { describe, it, expect } from 'vitest';
import { createRegistry, RegistryError } from '../src/registry/registry';
import type { Renderer } from '../src/types';

const mk = (id: string, exts: string[]): Renderer => ({
  id, label: id, extensions: exts, render: async () => ({ destroy() {} })
});

describe('createRegistry', () => {
  it('install & lookup by extension/id', () => {
    const reg = createRegistry();
    const text = mk('text', ['txt', 'log']);
    reg.install(text);
    expect(reg.byExtension('TXT')?.id).toBe('text');
    expect(reg.byId('text')).toBe(text);
    expect(reg.all()).toHaveLength(1);
  });
  it('conflicting ownership throws RegistryError', () => {
    const reg = createRegistry();
    reg.install(mk('a', ['bin']));
    expect(() => reg.install(mk('b', ['bin']))).toThrow(RegistryError);
  });
  it('install 归一化扩展名小写：大小写变体视为同一扩展名（查得到且冲突可检）', () => {
    const reg = createRegistry();
    reg.install(mk('text', ['txt']));
    // 大写注册不再各占一键：查询小写即命中，且与既有小写注册冲突可检
    expect(() => reg.install(mk('other', ['TXT']))).toThrow(RegistryError);
    const upper = mk('upper', ['MD', 'Markdown']);
    reg.install(upper);
    expect(reg.byExtension('md')?.id).toBe('upper');
    expect(reg.byExtension('markdown')?.id).toBe('upper');
  });
  it('unknown extension returns undefined', () => {
    expect(createRegistry().byExtension('zzz')).toBeUndefined();
  });
});
