// apps/web/src/lib/stores/session.test.ts
import { describe, it, expect, vi } from 'vitest';

// fake-indexeddb 提供 IDB 实现
import 'fake-indexeddb/auto';
import { loadSession, saveTabs, saveDirHandle, maxTabSeqOf, tabSeqOf } from './session';
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
      autoRefresh: true,
      computePolicy: 'auto'
    });
    saveSettings({ themeMode: 'dark', codeThemeLight: 'onelight', codeThemeDark: 'serika-dark', excludedPatterns: ['node_modules'], autoRefresh: false, computePolicy: 'remote' });
    expect(loadSettings().themeMode).toBe('dark');
    expect(loadSettings().computePolicy).toBe('remote');
  });
  it('settings computePolicy falls back to default on invalid value', () => {
    localStorage.setItem('vviewer:settings', JSON.stringify({ computePolicy: 'bogus' }));
    expect(loadSettings().computePolicy).toBe('auto');
    localStorage.setItem('vviewer:settings', 'not-json');
    expect(loadSettings().computePolicy).toBe('auto');
  });
  it('dir handle round trip stores the handle object', async () => {
    const fake = { name: 'proj', kind: 'directory' } as unknown as FileSystemDirectoryHandle;
    await saveDirHandle(fake);
    const { lastDirHandle } = await loadSession();
    expect(lastDirHandle?.name).toBe('proj');
  });
});

describe('tab id 序号解析（openFlow seq 快照基线）', () => {
  it('tabSeqOf：t 形态取数字，损坏/非 tab id 回 0', () => {
    expect(tabSeqOf('t12')).toBe(12);
    expect(tabSeqOf('t0')).toBe(0);
    expect(tabSeqOf('placeholder:remote:abc')).toBe(0);
    expect(tabSeqOf('')).toBe(0);
  });
  it('maxTabSeqOf：空列表 0、混入损坏 id 不影响最大值', () => {
    expect(maxTabSeqOf([])).toBe(0);
    expect(maxTabSeqOf(['t3', 't17', 'bogus'])).toBe(17);
  });
});
