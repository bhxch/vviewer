import { describe, it, expect } from 'vitest';

// fake-indexeddb 提供 IDB 实现（session 迁移通道用例需要）
import 'fake-indexeddb/auto';
import {
  createWorkspaceState,
  migrateLegacyTabs,
  sourceKindOf,
  workspaceStore,
  type WorkspaceSource,
  type WorkspacesSnapshot
} from './workspaceStore';
import { loadWorkspaces, saveTabs, saveWorkspaces, type TabSnapshot } from './stores/session';

/** 构造测试来源（默认 remote 形态） */
const src = (storeId: string, extra: Partial<WorkspaceSource> = {}): WorkspaceSource => ({
  kind: 'remote',
  storeId,
  storeLabel: storeId,
  ...extra
});

/** 构造旧版扁平 TabSnapshot（默认 localfs 文件形态） */
const snap = (id: string, over: Partial<TabSnapshot> = {}): TabSnapshot => ({
  id,
  storeId: 'localfs:demo',
  storeLabel: 'demo',
  path: 'a.txt',
  name: 'a.txt',
  kind: 'restorable',
  scrollTop: 0,
  active: false,
  ...over
});

describe('createWorkspaceState', () => {
  it('空态 ensureNonEmpty 建默认（w1/默认/无来源），幂等', () => {
    const ws = createWorkspaceState();
    expect(ws.list).toHaveLength(0);
    expect(ws.activeId).toBe('');
    ws.ensureNonEmpty();
    expect(ws.list).toHaveLength(1);
    expect(ws.list[0]).toMatchObject({ id: 'w1', name: '默认', sources: [] });
    expect(ws.activeId).toBe('w1');
    expect(typeof ws.list[0]!.createdAt).toBe('number');
    ws.ensureNonEmpty(); // 已非空：不再新建
    expect(ws.list).toHaveLength(1);
  });

  it('add 追加工作区（id 顺序、激活切换）；rename/setActive 生效', () => {
    const ws = createWorkspaceState();
    ws.ensureNonEmpty();
    const b = ws.add('第二区');
    expect(b.id).toBe('w2');
    expect(b.sources).toEqual([]);
    expect(ws.activeId).toBe('w2'); // 新建即激活
    ws.rename('w2', '改名');
    expect(ws.list.find((w) => w.id === 'w2')?.name).toBe('改名');
    ws.setActive('w1');
    expect(ws.activeId).toBe('w1');
    ws.setActive('nope'); // 不存在的 id：不改动
    expect(ws.activeId).toBe('w1');
  });

  it('addSource 按 storeId 去重：重复返回既有且不追加', () => {
    const ws = createWorkspaceState();
    ws.ensureNonEmpty();
    const first = ws.addSource('w1', src('remote:aaaa1111', { rootIndex: 1 }));
    const again = ws.addSource('w1', src('remote:aaaa1111', { rootIndex: 2 }));
    expect(again).toBe(first); // 同 storeId：返回既有对象
    expect(ws.list[0]!.sources).toHaveLength(1);
    expect(ws.list[0]!.sources[0]!.rootIndex).toBe(1); // 保留首次入组值
    const other = ws.addSource('w1', src('remote:bbbb2222', { basePath: 'docs' }));
    expect(other).not.toBe(first);
    expect(ws.list[0]!.sources).toHaveLength(2);
  });

  it('removeSource 移除指定来源；未知 storeId 无害', () => {
    const ws = createWorkspaceState();
    ws.ensureNonEmpty();
    ws.addSource('w1', src('remote:aaaa1111'));
    ws.addSource('w1', src('remote:bbbb2222'));
    ws.removeSource('w1', 'remote:aaaa1111');
    expect(ws.list[0]!.sources.map((s) => s.storeId)).toEqual(['remote:bbbb2222']);
    ws.removeSource('w1', 'remote:gone'); // 无此来源：不抛错不变更
    expect(ws.list[0]!.sources).toHaveLength(1);
  });

  it('remove 最后一个工作区：先建默认再删，activeId 指向新默认', () => {
    const ws = createWorkspaceState();
    ws.ensureNonEmpty();
    ws.rename('w1', '被删区');
    const oldId = ws.activeId;
    ws.remove(oldId);
    expect(ws.list).toHaveLength(1);
    expect(ws.list[0]!.id).not.toBe(oldId);
    expect(ws.list[0]!.name).toBe('默认');
    expect(ws.activeId).toBe(ws.list[0]!.id);
  });

  it('remove 非最后一个：列表收缩；删 active 时回落首个', () => {
    const ws = createWorkspaceState();
    ws.ensureNonEmpty();
    ws.add('B');
    ws.add('C');
    ws.setActive('w3');
    ws.remove('w3');
    expect(ws.list.map((w) => w.id)).toEqual(['w1', 'w2']);
    expect(ws.activeId).toBe('w1');
    ws.remove('w1');
    expect(ws.activeId).toBe('w2');
  });

  it('nextId：空态 w1 起序；非连续 id（快照恢复）取最大+1', () => {
    const ws = createWorkspaceState();
    expect(ws.nextId()).toBe('w1');
    ws.ensureNonEmpty();
    expect(ws.nextId()).toBe('w2');
    ws.replaceAll({
      activeId: 'w1',
      workspaces: [
        { id: 'w1', name: 'A', sources: [], createdAt: 1, tabs: [], activeTabId: null },
        { id: 'w5', name: 'B', sources: [], createdAt: 2, tabs: [], activeTabId: null }
      ]
    });
    expect(ws.nextId()).toBe('w6');
  });

  it('replaceAll 快照往返：模型字段无损；activeId 失配回落第一个', () => {
    const ws = createWorkspaceState();
    const original: WorkspacesSnapshot = {
      activeId: 'w2',
      workspaces: [
        {
          id: 'w1',
          name: 'A',
          sources: [src('remote:cccc3333', { rootIndex: 1, basePath: 'docs', storeBase: 'http://x:1' })],
          createdAt: 111,
          tabs: [snap('t9', { active: true })],
          activeTabId: 't9'
        },
        { id: 'w2', name: 'B', sources: [], createdAt: 222, tabs: [], activeTabId: null }
      ]
    };
    ws.replaceAll(original);
    expect(ws.activeId).toBe('w2');
    expect(ws.list.map((w) => ({ id: w.id, name: w.name, createdAt: w.createdAt }))).toEqual([
      { id: 'w1', name: 'A', createdAt: 111 },
      { id: 'w2', name: 'B', createdAt: 222 }
    ]);
    expect(ws.list[0]!.sources).toEqual(original.workspaces[0]!.sources);
    // activeId 指向不存在的工作区 → 回落第一个
    ws.replaceAll({ activeId: 'w9', workspaces: original.workspaces });
    expect(ws.activeId).toBe('w1');
    expect(ws.list).toHaveLength(2);
  });

  it('mergeSnapshot：既有组按 id 并入缺失来源（快照值不覆写既有），快照独有组整组追加', () => {
    const ws = createWorkspaceState();
    ws.ensureNonEmpty();
    // 用户已建态：默认 w1 已登记来源 remote:user1（快点击竞态里 restore 前入模型）
    ws.addSource('w1', src('remote:user1'));
    ws.mergeSnapshot({
      activeId: 'w1',
      workspaces: [
        {
          id: 'w1',
          name: '上次会话名',
          sources: [src('remote:snap1'), src('remote:user1', { rootIndex: 9 })],
          createdAt: 111,
          tabs: [],
          activeTabId: null
        },
        { id: 'w2', name: '快照新组', sources: [src('remote:snap2')], createdAt: 222, tabs: [], activeTabId: null }
      ]
    });
    expect(ws.list.map((w) => w.id)).toEqual(['w1', 'w2']);
    // 用户态为先：既有组不采纳快照的 name/createdAt
    expect(ws.list[0]!.name).toBe('默认');
    expect(ws.list[0]!.createdAt).not.toBe(111);
    // 同 id 组：仅并入缺失来源，既有来源对象原样保留（快照 rootIndex:9 不覆写）
    expect(ws.list[0]!.sources.map((s) => s.storeId)).toEqual(['remote:user1', 'remote:snap1']);
    expect(ws.list[0]!.sources[0]!.rootIndex).toBeUndefined();
    // 快照独有组：整组追加（含快照元数据）
    expect(ws.list[1]).toMatchObject({ id: 'w2', name: '快照新组', createdAt: 222 });
    expect(ws.list[1]!.sources.map((s) => s.storeId)).toEqual(['remote:snap2']);
  });

  it('mergeSnapshot：不改写活动组；空态兜底建默认；重复合并幂等（storeId 去重）', () => {
    const ws = createWorkspaceState();
    ws.ensureNonEmpty();
    ws.addSource('w1', src('remote:user1')); // 用户活动
    ws.mergeSnapshot({
      activeId: 'w9', // 快照 activeId 指向不存在的组：不改写当前活动组
      workspaces: [{ id: 'w1', name: '默认', sources: [], createdAt: 1, tabs: [], activeTabId: null }]
    });
    expect(ws.activeId).toBe('w1');
    // 幂等：同一快照再合并，来源不重复
    ws.mergeSnapshot({
      activeId: 'w1',
      workspaces: [{ id: 'w1', name: '默认', sources: [src('remote:user1')], createdAt: 1, tabs: [], activeTabId: null }]
    });
    expect(ws.list[0]!.sources).toHaveLength(1);
    // 空态工厂直接合并空快照：不变式兜底建默认
    const fresh = createWorkspaceState();
    fresh.mergeSnapshot({ activeId: 'w1', workspaces: [] });
    expect(fresh.list).toHaveLength(1);
    expect(fresh.activeId).toBe('w1');
  });

  it('onWorkspacesChanged：变更触发且回调收到副本；退订生效', () => {
    const ws = createWorkspaceState();
    const seen: string[] = [];
    const off = ws.onWorkspacesChanged((s) => seen.push(s.activeId));
    ws.ensureNonEmpty();
    expect(seen).toEqual(['w1']);
    off();
    ws.add('X');
    expect(seen).toEqual(['w1']); // 退订后不再触发
  });
});

describe('migrateLegacyTabs（旧扁平 tabs 快照 → 单 workspace）', () => {
  it('sources 仅由目录 tab（path===\'\'）派生，非 \'\' 不产生 source；tabs 原样保留', () => {
    const legacy = [
      snap('t1', { path: '', name: 'demo' }),
      snap('t2', {
        storeId: 'remote:abcd1234',
        storeLabel: '127.0.0.1:8321',
        storeBase: 'http://127.0.0.1:8321',
        path: '',
        name: '127.0.0.1:8321',
        kind: 'rename-only',
        active: true
      }),
      snap('t3', { path: 'src/main.rs', name: 'main.rs' }), // 文件 tab：不产生 source
      snap('t4', { storeId: 'single:x:1:2', storeLabel: 'x', path: 'x', name: 'x', kind: 'rename-only' })
    ];
    const m = migrateLegacyTabs(legacy);
    expect(m.activeId).toBe('w1');
    expect(m.workspaces).toHaveLength(1);
    const w = m.workspaces[0]!;
    expect(w.id).toBe('w1');
    expect(w.name).toBe('默认');
    expect(w.sources).toEqual([
      { kind: 'localfs', storeId: 'localfs:demo', storeLabel: 'demo' },
      { kind: 'remote', storeId: 'remote:abcd1234', storeLabel: '127.0.0.1:8321', storeBase: 'http://127.0.0.1:8321' }
    ]);
    expect(w.tabs).toEqual(legacy); // tabs 原样
    expect(w.activeTabId).toBe('t2'); // 组内活动 tab
    expect(typeof w.createdAt).toBe('number');
  });

  it('同 storeId 的多个目录 tab 只派生一个 source', () => {
    const legacy = [
      snap('t1', { storeId: 'localfs:demo', path: '', name: 'demo' }),
      snap('t2', { storeId: 'localfs:demo', path: '', name: 'demo' })
    ];
    const m = migrateLegacyTabs(legacy);
    expect(m.workspaces[0]!.sources).toEqual([{ kind: 'localfs', storeId: 'localfs:demo', storeLabel: 'demo' }]);
  });

  it('空快照 → 单空默认 workspace，activeTabId null', () => {
    const m = migrateLegacyTabs([]);
    expect(m.activeId).toBe('w1');
    expect(m.workspaces[0]).toMatchObject({
      id: 'w1',
      name: '默认',
      sources: [],
      tabs: [],
      activeTabId: null
    });
  });

  it('size 字段随迁移原样保留（项 3：restore 链 size 回环的迁移面；无 size 的旧条目形状不变）', () => {
    const legacy = [
      snap('t1', { path: 'a/big.jsonl', name: 'big.jsonl', size: 4096 }),
      snap('t2', { path: 'b/x.txt', name: 'x.txt' }) // 旧快照无 size 字段
    ];
    const tabs = migrateLegacyTabs(legacy).workspaces[0]!.tabs;
    expect(tabs[0]?.size).toBe(4096);
    expect('size' in (tabs[1] ?? {})).toBe(false);
  });
});

describe('单例 workspaceStore', () => {
  it('启动即非空（openFlow add/persist 的前置；replaceAll 迁移时整体覆写）', () => {
    expect(workspaceStore.list.length).toBeGreaterThanOrEqual(1);
    expect(workspaceStore.activeId).not.toBe('');
  });
});

describe('session loadWorkspaces 迁移通道', () => {
  it('workspaces 缺失回落旧 tabs 键（不删旧键）；写入后优先读新键', async () => {
    const legacy = [snap('t1', { active: true }), snap('t2')];
    await saveTabs(legacy);
    const first = await loadWorkspaces();
    expect(first.snapshot).toBeNull();
    expect(first.legacyTabs).toEqual(legacy);

    await saveWorkspaces(migrateLegacyTabs(legacy));
    const second = await loadWorkspaces();
    expect(second.snapshot?.activeId).toBe('w1');
    expect(second.snapshot?.workspaces[0]!.tabs).toEqual(legacy);
    // 旧键保留不删（降级/对照兜底）
    expect(second.legacyTabs).toEqual(legacy);
  });
});

describe('sourceKindOf（目录挂载 spec §4 阶段三：直连挂载类别，评审带入①）', () => {
  it('s3direct:/davdirect: 前缀 → direct（openFlow 创建分派与快照恢复链路的类别依据）', () => {
    expect(sourceKindOf('s3direct:1a2b3c4d')).toBe('direct');
    expect(sourceKindOf('davdirect:1a2b3c4d')).toBe('direct');
  });

  it('既有前缀零变化（remote/localfs/localfiles/url/single）', () => {
    expect(sourceKindOf('localfs:docs')).toBe('localfs');
    expect(sourceKindOf('localfiles:docs')).toBe('localfiles');
    expect(sourceKindOf('remote:abc')).toBe('remote');
    expect(sourceKindOf('remote:abc:r2:def')).toBe('remote');
    expect(sourceKindOf('url:https://x/y.txt')).toBe('url');
    expect(sourceKindOf('single:xyz')).toBe('single');
    expect(sourceKindOf('unknown:xyz')).toBe('single');
  });
});
