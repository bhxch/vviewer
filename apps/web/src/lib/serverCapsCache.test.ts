// serverCapsCache.test.ts — 能力缓存纯存储层的结构测试（FE-1 新增）：三组
// sessionStorage 键的读写 round-trip、损坏 JSON/非数组脏值容错（返回 [] 表示
// 未知）、computeLanguages/diagrams 未宣告清缓存、lastServer 记录形状校验与
// 归一。searchEngineCache.test.ts 同款装置（jsdom sessionStorage）。
import { afterEach, describe, expect, it } from 'vitest';
import {
  loadCapabilities,
  loadComputeLanguages,
  loadDiagramCapabilities,
  loadLastServer,
  saveCapabilities,
  saveComputeLanguages,
  saveDiagramCapabilities,
  saveLastServer
} from './serverCapsCache';

describe('serverCapsCache 能力缓存', () => {
  afterEach(() => {
    sessionStorage.clear();
  });

  it('capabilities round-trip：save 过滤非字符串成员后落盘，load 读回', () => {
    saveCapabilities(['file-server', 'kroki-proxy', 42]);
    expect(loadCapabilities()).toEqual(['file-server', 'kroki-proxy']);
  });

  it('computeLanguages round-trip + 未宣告（非数组）清缓存表示未知', () => {
    saveComputeLanguages(['rust', 'python']);
    expect(loadComputeLanguages()).toEqual(['rust', 'python']);
    saveComputeLanguages(undefined);
    expect(loadComputeLanguages()).toEqual([]);
    // 再写后再清：清的是旧缓存（旧服务端未宣告），非跳过
    saveComputeLanguages(['rust']);
    saveComputeLanguages('bogus');
    expect(loadComputeLanguages()).toEqual([]);
  });

  it('diagramCapabilities round-trip + 未宣告清缓存', () => {
    saveDiagramCapabilities(['graphviz', 'mermaid']);
    expect(loadDiagramCapabilities()).toEqual(['graphviz', 'mermaid']);
    saveDiagramCapabilities(undefined);
    expect(loadDiagramCapabilities()).toEqual([]);
  });

  it('损坏 JSON 容错：三组 load 均返回 []（表示未知）', () => {
    sessionStorage.setItem('vv:capabilities', '{not json');
    sessionStorage.setItem('vv:compute-languages', '{not json');
    sessionStorage.setItem('vv:diagram-capabilities', '{not json');
    expect(loadCapabilities()).toEqual([]);
    expect(loadComputeLanguages()).toEqual([]);
    expect(loadDiagramCapabilities()).toEqual([]);
  });

  it('非数组脏值容错：load 返回 []', () => {
    sessionStorage.setItem('vv:capabilities', '"file-server"');
    sessionStorage.setItem('vv:compute-languages', '42');
    sessionStorage.setItem('vv:diagram-capabilities', '{"a":1}');
    expect(loadCapabilities()).toEqual([]);
    expect(loadComputeLanguages()).toEqual([]);
    expect(loadDiagramCapabilities()).toEqual([]);
  });
});

describe('serverCapsCache lastServer 记录', () => {
  afterEach(() => {
    sessionStorage.clear();
  });

  it('round-trip：base + token（null 原样）', () => {
    saveLastServer('http://x:1', null);
    expect(loadLastServer()).toEqual({ baseUrl: 'http://x:1', token: null });
    saveLastServer('http://x:1', 'tok');
    expect(loadLastServer()).toEqual({ baseUrl: 'http://x:1', token: 'tok' });
  });

  it('无记录返回 null', () => {
    expect(loadLastServer()).toBeNull();
  });

  it('损坏 JSON / 非法形状返回 null（连接表单预填回落空）', () => {
    sessionStorage.setItem('vviewer-last-server', '{not json');
    expect(loadLastServer()).toBeNull();
    sessionStorage.setItem('vviewer-last-server', JSON.stringify({ token: 't' }));
    expect(loadLastServer()).toBeNull();
    sessionStorage.setItem('vviewer-last-server', JSON.stringify({ baseUrl: '', token: 't' }));
    expect(loadLastServer()).toBeNull();
  });

  it('token 空串归一 null', () => {
    sessionStorage.setItem('vviewer-last-server', JSON.stringify({ baseUrl: 'http://x', token: '' }));
    expect(loadLastServer()).toEqual({ baseUrl: 'http://x', token: null });
  });
});
