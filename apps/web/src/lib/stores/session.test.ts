// apps/web/src/lib/stores/session.test.ts
import { describe, it, expect, vi } from 'vitest';

// fake-indexeddb 提供 IDB 实现
import 'fake-indexeddb/auto';
import { loadSession, saveTabs, saveDirHandle } from './session';
import { loadSettings, saveSettings } from './settings';

describe('session store', () => {
  it('saves and loads tabs', async () => {
    const tabs = [{ id: 't1', storeId: 's1', storeLabel: 'x', path: 'a.txt', name: 'a.txt', kind: 'restorable' as const, scrollTop: 42, active: true }];
    await saveTabs(tabs);
    const { tabs: loaded } = await loadSession();
    expect(loaded).toEqual(tabs);
  });
  it('round-trips optional storeBase on remote tab snapshots', async () => {
    const tabs = [{ id: 't2', storeId: 'remote:abcd1234', storeLabel: '127.0.0.1:8321', storeBase: 'http://127.0.0.1:8321', path: '', name: 'srv', kind: 'rename-only' as const, scrollTop: 0, active: true }];
    await saveTabs(tabs);
    const { tabs: loaded } = await loadSession();
    expect(loaded).toEqual(tabs);
    expect(loaded[0]?.storeBase).toBe('http://127.0.0.1:8321');
  });
  it('settings round-trip with defaults', () => {
    expect(loadSettings()).toEqual({
      themeMode: 'system',
      codeThemeLight: 'onelight',
      codeThemeDark: 'serika-dark',
      excludedPatterns: [],
      autoRefresh: true
    });
    saveSettings({ themeMode: 'dark', codeThemeLight: 'onelight', codeThemeDark: 'serika-dark', excludedPatterns: ['node_modules'], autoRefresh: false });
    expect(loadSettings().themeMode).toBe('dark');
  });
  it('dir handle round trip stores the handle object', async () => {
    const fake = { name: 'proj', kind: 'directory' } as unknown as FileSystemDirectoryHandle;
    await saveDirHandle(fake);
    const { lastDirHandle } = await loadSession();
    expect(lastDirHandle?.name).toBe('proj');
  });
});
