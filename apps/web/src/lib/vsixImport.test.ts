// apps/web/src/lib/vsixImport.test.ts — 主题库存储 + JSON/VSIX 导入解析单测。
// zip 构造用真实 jszip（devDependency，与 render-archive 的 ^3.10.1 对齐）；
// IndexedDB 用 fake-indexeddb/auto（session.test.ts 同款先例）。
// 注意：fake-indexeddb 的 'vviewer' 库在本文件内持久，故 v1→v2 迁移用例
// 必须最先声明执行（后续用例再开 v2 时不再触发 upgrade）。
import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import JSZip from 'jszip';
import { deleteTheme, listThemes as listImportedThemes, loadSession, putTheme, type ImportedTheme } from './stores/session';
import { importThemeFiles, listVsixThemes, MAX_THEME_JSON_BYTES } from './vsixImport';

const NIGHT_OWL = JSON.stringify({
  name: 'Night Owl',
  type: 'dark',
  colors: { 'editor.background': '#011627' },
  tokenColors: [{ scope: 'comment', settings: { foreground: '#5f7a61' } }]
});
const DAY_OWL = JSON.stringify({ name: 'Day Owl', type: 'light', colors: { 'editor.background': '#fbfbfb' } });
const PKG = (themes: unknown): string => JSON.stringify({ name: 'owl-themes', contributes: { themes } });

async function zipToVsixFile(entries: Record<string, string>): Promise<File> {
  const zip = new JSZip();
  for (const [path, content] of Object.entries(entries)) zip.file(path, content);
  const bytes = await zip.generateAsync({ type: 'uint8array' });
  // jszip 类型面为 Uint8Array<ArrayBufferLike>（BlobPart 拒收）；运行时是自有
  // ArrayBuffer，拷贝一层即得 Uint8Array<ArrayBuffer>（零断言，量级 KB 无感）
  return new File([new Uint8Array(bytes)], 'owl.vsix');
}

const GOOD_VSIX_ENTRIES = {
  'extension/package.json': PKG([
    { label: 'Night Owl', path: './themes/night-owl.json' },
    { label: 'Day Owl', path: 'themes\\day-owl.json' }
  ]),
  'extension/themes/night-owl.json': NIGHT_OWL,
  'extension/themes/day-owl.json': DAY_OWL
};

describe('session themes store（IndexedDB v1→v2 迁移与 CRUD）', () => {
  it('v1 既有 kv 数据升级到 v2 后保留，themes store 可写', async () => {
    // 手工以 v1 形态建库写入（升版前的存量用户形态）
    await new Promise<void>((resolve, reject) => {
      const req = indexedDB.open('vviewer', 1);
      req.onupgradeneeded = () => req.result.createObjectStore('kv');
      req.onsuccess = () => {
        const tx = req.result.transaction('kv', 'readwrite');
        tx.objectStore('kv').put([{ id: 't1', path: 'a.txt' }], 'tabs');
        tx.oncomplete = () => {
          req.result.close();
          resolve();
        };
        tx.onerror = () => reject(tx.error);
      };
      req.onerror = () => reject(req.error);
    });
    // 新代码以 v2 打开：kv 存量可读、themes 可写（升版不丢数据）
    const { tabs } = await loadSession();
    expect(tabs).toEqual([{ id: 't1', path: 'a.txt' }]);
    const t: ImportedTheme = {
      id: 'imported:migrate1',
      name: 'Migrated',
      kind: 'dark',
      colors: { 'editor.background': '#000000' },
      tokenColors: [],
      source: 'json',
      addedAt: 1
    };
    await putTheme(t);
    expect(await listImportedThemes()).toContainEqual(t);
    await deleteTheme(t.id);
    expect(await listImportedThemes()).not.toContainEqual(t);
  });
});

describe('listVsixThemes（多主题 VSIX 预览列举）', () => {
  it('列出 contributes.themes 两条，路径剥 ./ 且反斜杠转正斜杠', async () => {
    const list = await listVsixThemes(await zipToVsixFile(GOOD_VSIX_ENTRIES));
    expect(list).toEqual([
      { label: 'Night Owl', path: 'themes/night-owl.json' },
      { label: 'Day Owl', path: 'themes/day-owl.json' }
    ]);
  });

  it('缺 contributes.themes / 缺 package.json → 报「未找到主题」', async () => {
    const noThemes = await zipToVsixFile({ 'extension/package.json': JSON.stringify({ name: 'x' }) });
    await expect(listVsixThemes(noThemes)).rejects.toThrow('未找到主题');
    const noPkg = await zipToVsixFile({ 'extension/themes/night-owl.json': NIGHT_OWL });
    await expect(listVsixThemes(noPkg)).rejects.toThrow('未找到主题');
  });
});

describe('importThemeFiles', () => {
  it('合法 vsix：两条全部导入成功（source vsix、id 形态、入库可查）', async () => {
    const { imported, errors } = await importThemeFiles([await zipToVsixFile(GOOD_VSIX_ENTRIES)]);
    expect(errors).toEqual([]);
    expect(imported).toMatchObject([
      { name: 'Night Owl', kind: 'dark', source: 'vsix' },
      { name: 'Day Owl', kind: 'light', source: 'vsix' }
    ]);
    for (const t of imported) expect(t.id).toMatch(/^imported:[0-9a-z]{8}$/);
    const stored = await listImportedThemes();
    for (const t of imported) expect(stored.find((s) => s.id === t.id)).toMatchObject({ name: t.name });
  });

  it('无 contributes.themes → errors 含「未找到主题」，无导入', async () => {
    const noThemes = await zipToVsixFile({ 'extension/package.json': JSON.stringify({ name: 'x' }) });
    const { imported, errors } = await importThemeFiles([noThemes]);
    expect(imported).toEqual([]);
    expect(errors.length).toBe(1);
    expect(errors[0]).toContain('未找到主题');
  });

  it('单主题 JSON 超 1MB → 该条报错跳过，其余成功', async () => {
    const big = JSON.stringify({
      name: 'Big',
      type: 'dark',
      colors: { 'editor.background': '#011627', filler: 'x'.repeat(MAX_THEME_JSON_BYTES) }
    });
    const entries = {
      'extension/package.json': PKG([
        { label: 'Big', path: './themes/big.json' },
        { label: 'Night Owl', path: './themes/night-owl.json' }
      ]),
      'extension/themes/big.json': big,
      'extension/themes/night-owl.json': NIGHT_OWL
    };
    const { imported, errors } = await importThemeFiles([await zipToVsixFile(entries)]);
    expect(imported.map((t) => t.name)).toEqual(['Night Owl']);
    expect(errors.length).toBe(1);
    expect(errors[0]).toContain('Big');
    expect(errors[0]).toContain('1MB');
  });

  it('坏 JSON 主题 → 报错跳过其余成功', async () => {
    const entries = {
      'extension/package.json': PKG([
        { label: 'Broken', path: './themes/broken.json' },
        { label: 'Night Owl', path: './themes/night-owl.json' }
      ]),
      'extension/themes/broken.json': '{ not json',
      'extension/themes/night-owl.json': NIGHT_OWL
    };
    const { imported, errors } = await importThemeFiles([await zipToVsixFile(entries)]);
    expect(imported.map((t) => t.name)).toEqual(['Night Owl']);
    expect(errors.length).toBe(1);
    expect(errors[0]).toContain('Broken');
  });

  it('主题 JSON 缺 name 时用清单 label 兜底（真实 VSIX 主题常无 name）', async () => {
    const nameless = JSON.stringify({ type: 'dark', colors: { 'editor.background': '#011627' } });
    const entries = {
      'extension/package.json': PKG([{ label: 'Label Wins', path: './themes/nameless.json' }]),
      'extension/themes/nameless.json': nameless
    };
    const { imported, errors } = await importThemeFiles([await zipToVsixFile(entries)]);
    expect(errors).toEqual([]);
    expect(imported[0]).toMatchObject({ name: 'Label Wins', kind: 'dark', source: 'vsix' });
  });

  it('.json 单文件直读：合法入库（source json），deleteTheme 删除生效', async () => {
    const { imported, errors } = await importThemeFiles([new File([NIGHT_OWL], 'my-owl.json')]);
    expect(errors).toEqual([]);
    expect(imported[0]).toMatchObject({ name: 'Night Owl', kind: 'dark', source: 'json' });
    const ids = (await listImportedThemes()).map((t) => t.id);
    expect(ids).toContain(imported[0]!.id);
    await deleteTheme(imported[0]!.id);
    expect((await listImportedThemes()).map((t) => t.id)).not.toContain(imported[0]!.id);
  });

  it('.json 缺 name → 文件名基名兜底；坏 JSON / 不支持类型 → 报错不中断', async () => {
    const nameless = JSON.stringify({ type: 'dark', colors: { 'editor.background': '#011627' } });
    const { imported, errors } = await importThemeFiles([
      new File([nameless], 'fallback-name.json'),
      new File(['{ not json'], 'bad.json'),
      new File(['hello'], 'readme.txt')
    ]);
    expect(imported).toMatchObject([{ name: 'fallback-name', source: 'json' }]);
    expect(errors.length).toBe(2);
    expect(errors[0]).toContain('bad.json');
    expect(errors[1]).toContain('readme.txt');
  });
});
