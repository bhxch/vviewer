import { describe, it, expect } from 'vitest';
import type { Tab } from './openFlow.svelte';
import type { WorkspaceSource } from './workspaceStore';
import { badgeOf } from './tabBadge';

// 多根 spec Task 1：徽标从「多源恒显 storeLabel」翻转为「同名跨源消歧」——旧断言
// 「多源组已登记来源即返回 storeLabel」（tab 名唯一也恒显）随本翻转删除。

const src = (storeId: string, storeLabel: string): WorkspaceSource => ({
  kind: 'remote',
  storeId,
  storeLabel
});

const tabOf = (storeId: string, name: string, path = '') =>
  ({ source: { storeId, name, path } }) as Tab;

describe('badgeOf', () => {
  it('单源 workspace：不显示徽标（不变）', () => {
    const sources = [src('remote:a', 'data')];
    const tab = tabOf('remote:a', 'notes.txt');
    expect(badgeOf(sources, [tab], tab)).toBeNull();
  });

  it('两来源、tab 名互不相同：无歧义，双方均无徽标（翻转旧恒显行为）', () => {
    const sources = [src('remote:a', 'data'), src('remote:b', '备份 · 根1')];
    const tabA = tabOf('remote:a', 'notes.txt');
    const tabB = tabOf('remote:b', 'todo.txt');
    const tabs = [tabA, tabB];
    expect(badgeOf(sources, tabs, tabA)).toBeNull();
    expect(badgeOf(sources, tabs, tabB)).toBeNull();
  });

  it('两来源、同名文件各一 tab：双方均返回各自 storeLabel', () => {
    const sources = [src('remote:a', 'data'), src('remote:b', '备份')];
    const tabA = tabOf('remote:a', 'notes.txt', 'notes.txt');
    const tabB = tabOf('remote:b', 'notes.txt', 'notes.txt');
    const tabs = [tabA, tabB];
    expect(badgeOf(sources, tabs, tabA)).toBe('data');
    expect(badgeOf(sources, tabs, tabB)).toBe('备份');
  });

  it('三来源、同名只出现在其中两源：仅那两个 tab 有徽标，第三源 tab 无', () => {
    const sources = [src('remote:a', 'data'), src('remote:b', '备份'), src('remote:c', '其他')];
    const tabA = tabOf('remote:a', 'notes.txt');
    const tabB = tabOf('remote:b', 'notes.txt');
    const tabC = tabOf('remote:c', 'todo.txt');
    const tabs = [tabA, tabB, tabC];
    expect(badgeOf(sources, tabs, tabA)).toBe('data');
    expect(badgeOf(sources, tabs, tabB)).toBe('备份');
    expect(badgeOf(sources, tabs, tabC)).toBeNull();
  });

  it('同一来源内 duplicate 两个同名 tab：同源不算冲突，双方均无徽标', () => {
    const sources = [src('remote:a', 'data'), src('remote:b', '备份')];
    const tabA1 = tabOf('remote:a', 'notes.txt');
    const tabA2 = tabOf('remote:a', 'notes.txt');
    const tabs = [tabA1, tabA2];
    expect(badgeOf(sources, tabs, tabA1)).toBeNull();
    expect(badgeOf(sources, tabs, tabA2)).toBeNull();
  });

  it('同名冲突 + remote 单文件来源抑制：该 tab 无徽标、对手 tab 正常（不对称成立）', () => {
    const sources = [src('remote:a', 'data'), src('remote:b:notes', 'notes.txt')];
    const tabA = tabOf('remote:a', 'notes.txt');
    const tabSingle = tabOf('remote:b:notes', 'notes.txt', 'notes.txt');
    const tabs = [tabA, tabSingle];
    // 单文件来源侧（storeLabel=文件名=tab 名）：同文退化重复，抑制
    expect(badgeOf(sources, tabs, tabSingle)).toBeNull();
    // 目录源侧不受单文件来源影响，正常以 storeLabel 区分
    expect(badgeOf(sources, tabs, tabA)).toBe('data');
  });

  it('目录 tab（path===""）同名跨源：参与冲突、徽标照常显示', () => {
    const sources = [src('remote:b1', 'host.example:8321'), src('remote:b2', 'host.example:8321')];
    const tabDir1 = tabOf('remote:b1', 'host.example:8321');
    const tabDir2 = tabOf('remote:b2', 'host.example:8321');
    const tabs = [tabDir1, tabDir2];
    expect(badgeOf(sources, tabs, tabDir1)).toBe('host.example:8321');
    expect(badgeOf(sources, tabs, tabDir2)).toBe('host.example:8321');
  });

  it('名册只含已登记来源的 tab：未登记 storeId（openFiles 单文件）同名不触发冲突，自身恒 null', () => {
    const sources = [src('remote:a', 'data'), src('remote:b', '备份')];
    const registered = tabOf('remote:a', 'notes.txt');
    const openFile = tabOf('localfiles:x', 'notes.txt');
    const tabs = [registered, openFile];
    // 未登记 tab 的同名不触发冲突：已登记 tab 仍无徽标
    expect(badgeOf(sources, tabs, registered)).toBeNull();
    // 未登记 tab 自身恒无徽标（无来源可标）
    expect(badgeOf(sources, tabs, openFile)).toBeNull();
  });
});
