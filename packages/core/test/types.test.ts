import { describe, it, expect } from 'vitest';
import type { TreeStore, Renderer, TreeNode } from '../src/types';

describe('types', () => {
  it('TreeStore can be structurally implemented', async () => {
    const store: TreeStore = {
      id: 'test',
      displayName: () => 'test',
      listChildren: async () => [{ name: 'a.txt', path: 'a.txt', kind: 'file' } as TreeNode],
      read: async () => new Uint8Array([1])
    };
    expect((await store.listChildren(''))[0]!.name).toBe('a.txt');
  });
  it('Renderer interface is structural', () => {
    const r: Renderer = {
      id: 'text', label: '文本', extensions: ['txt'],
      render: async () => ({ destroy() {} })
    };
    expect(r.extensions).toContain('txt');
  });
});
