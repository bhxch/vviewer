import { describe, it, expect } from 'vitest';
import type { Tab } from './openFlow.svelte';
import type { WorkspaceSource } from './workspaceStore';
import { badgeOf } from './tabBadge';

const src = (storeId: string, storeLabel: string): WorkspaceSource => ({
  kind: 'remote',
  storeId,
  storeLabel
});

const tabOf = (storeId: string, name: string, path = '') =>
  ({ source: { storeId, name, path } }) as Tab;

describe('badgeOf', () => {
  it('单源 workspace：不显示徽标', () => {
    const sources = [src('remote:a', 'data')];
    expect(badgeOf(sources, tabOf('remote:a', 'notes.txt'))).toBeNull();
  });

  it('多源组已登记来源：返回 storeLabel', () => {
    const sources = [src('remote:a', 'data'), src('remote:b', '备份 · 根1')];
    expect(badgeOf(sources, tabOf('remote:b', 'notes.txt'))).toBe('备份 · 根1');
  });

  it('多源组未登记来源（openFiles 单文件 tab）：无徽标', () => {
    const sources = [src('remote:a', 'data'), src('remote:b', '备份')];
    expect(badgeOf(sources, tabOf('localfiles:x', 'demo.txt'))).toBeNull();
  });

  it('远端目录来源（label=host=displayName 常态同文）：目录 tab 徽标照常显示', () => {
    const sources = [src('remote:a', 'data'), src('remote:b', 'host.example:8321')];
    expect(badgeOf(sources, tabOf('remote:b', 'host.example:8321'))).toBe('host.example:8321');
  });

  it('远端单文件来源（storeLabel=文件名=tab 名）：文件 tab 同文不显示，避免冗余', () => {
    const sources = [src('remote:a', 'data'), src('remote:b:notes', 'notes.txt')];
    expect(badgeOf(sources, tabOf('remote:b:notes', 'notes.txt', 'notes.txt'))).toBeNull();
  });

  it('病理同形（目录源 label 恰等于源内文件名）：一并抑制——tab 形状无法区分，可接受', () => {
    const sources = [src('remote:a', 'data'), src('remote:b', 'notes.txt')];
    expect(badgeOf(sources, tabOf('remote:b', 'notes.txt', 'sub/notes.txt'))).toBeNull();
  });
});
