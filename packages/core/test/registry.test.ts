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
  it('unknown extension returns undefined', () => {
    expect(createRegistry().byExtension('zzz')).toBeUndefined();
  });
});
