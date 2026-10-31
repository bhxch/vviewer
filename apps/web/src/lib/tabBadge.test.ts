import { describe, it, expect } from 'vitest';
import type { FileSource } from '@bhxch/vviewer-core';
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

/**
 * badgeOf 判定面的最小 tab 形状：仅 source.{storeId,name,path}（Pick<FileSource,…>
 * 锚定字段名——FileSource 字段更名/收窄时此处编译错，杜绝静默漂移）。
 */
type BadgeTab = { source: Pick<FileSource, 'storeId' | 'name' | 'path'> };

/**
 * tabOf：全用例共用的最小 tab 构造，as Tab 断言集中此一处、禁止用例内散落强转。
 * 取舍——不补齐 Tab 常用字段：badgeOf 仅消费 tab.source.*（storeId/name/path），
 * 其余字段（id/scrollTop/active…）与 FileSource.store: TreeStore 等重对象同判定
 * 无关，补齐需伪造 store、徒增噪声；最小形状经 BadgeTab 类型校验后再集中断言。
 */
const tabOf = (storeId: string, name: string, path = ''): Tab => {
  const minimal: BadgeTab = { source: { storeId, name, path } };
  return minimal as Tab;
};

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

  it('A 源 duplicate 同名两 tab + 该名同存于 B 源：跨源冲突成立，两个 A 源 tab 均得徽标', () => {
    const sources = [src('remote:a', 'data'), src('remote:b', '备份')];
    const tabA1 = tabOf('remote:a', 'notes.txt');
    const tabA2 = tabOf('remote:a', 'notes.txt');
    const tabB = tabOf('remote:b', 'notes.txt');
    const tabs = [tabA1, tabA2, tabB];
    // 同源重复不妨碍跨源冲突判定：A 源两个 tab 均以 storeLabel 区分
    expect(badgeOf(sources, tabs, tabA1)).toBe('data');
    expect(badgeOf(sources, tabs, tabA2)).toBe('data');
    expect(badgeOf(sources, tabs, tabB)).toBe('备份');
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
