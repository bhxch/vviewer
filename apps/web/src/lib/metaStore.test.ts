import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
// 类型擦除 import：锁定 FileMetaState 消费侧类型形状（vitest 转译时擦除，不触发
// .svelte.ts 运行时加载；真形状检查由 svelte-check 门禁覆盖）
import type { FileMetaState } from './metaStore.svelte';

// metaStore.test.ts — C 项 Task 6：fileMeta.openWith 数据形状锁定。
// 根 vitest 无 svelte 插件，.svelte.ts 的 $state 模块无法直接 import（先例
// globalSearch.test.ts 以 vi.mock 隔离依赖；本模块是纯状态、无可 mock 的依赖面），
// 故降级为源码契约断言：锁定 openWith 字段形状、初始 null 与清空语义三条契约。
// 运行时往返（setFileMeta 写入/清空）与下拉联动由 e2e 兜底。

// null 类型参数（占位引用，防类型漂移：字段改名时此处随 svelte-check 报错）
type _ShapeCheck = FileMetaState;

// vitest 会转译 import.meta.url（theme.test.ts 同款处理）：双 cwd 兼容根/apps/web
const source = readFileSync(
  ['apps/web/src/lib/metaStore.svelte.ts', 'src/lib/metaStore.svelte.ts']
    .map((p) => resolve(p))
    .find((p) => existsSync(p))!,
  'utf8'
);

describe('fileMeta.openWith 数据形状（C 项 Task 6）', () => {
  it('FileMetaState 声明 openWith: FileOpenWith | null（形状收敛至导出接口，终审 Minor）', () => {
    expect(source).toMatch(/openWith:\s*FileOpenWith\s*\|\s*null/);
  });

  it('FileOpenWith 接口声明 current/manual/options 字段（形状单一来源）', () => {
    expect(source).toMatch(
      /interface FileOpenWith\s*\{[\s\S]*?current: string;[\s\S]*?manual: boolean;[\s\S]*?options:\s*\{\s*id: string;\s*label: string\s*\}\[\]/
    );
  });

  it('初始状态 openWith 为 null（未打开文件不显示下拉）', () => {
    expect(source).toMatch(/openWith:\s*null/);
  });

  it('setFileMeta(null) 或未带 openWith 时清空（?? null 覆盖旧值）', () => {
    expect(source).toMatch(/fileMeta\.openWith = meta\?\.openWith \?\? null/);
  });
});
