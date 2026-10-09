import { describe, expect, it } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseBuildRsTable, toManifest, SOURCES } from '../gen-server-manifest.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../..');

const SAMPLE = `let grammars: Vec<(&str, &str, &str, &str)> = vec![
    ("ada", "ada", "", "tree_sitter_ada"),
    ("c-sharp", "c-sharp", "", "tree_sitter_c_sharp"),
    ("tsx", "tsx", "tsx", "tree_sitter_tsx"),
];`;

describe('gen-server-manifest', () => {
  it('解析 Markpad build.rs 静态表为排序清单', () => {
    const entries = parseBuildRsTable(SAMPLE);
    expect(entries).toEqual([
      { name: 'ada', dir: 'ada', subpath: '', cSymbol: 'tree_sitter_ada' },
      { name: 'c-sharp', dir: 'c-sharp', subpath: '', cSymbol: 'tree_sitter_c_sharp' },
      { name: 'tsx', dir: 'tsx', subpath: 'tsx', cSymbol: 'tree_sitter_tsx' },
    ]);
  });
  it('toManifest 产出 JSON 字符串且按 name 排序、带生成注记', () => {
    const json = JSON.parse(toManifest(parseBuildRsTable(SAMPLE)));
    expect(json.note).toContain('Markpad build.rs');
    expect(json.grammars.map((g) => g.name)).toEqual(['ada', 'c-sharp', 'tsx']);
  });
});

// ---------- 入库 manifest 快照与 Markpad registry 301 名单交叉验证（Step 5 硬门禁） ----------

// 数据源在仓库外（Markpad 参考仓，随上游漂移且 fresh clone 必然缺失）：快照断结构，
// 交叉验证 skipIf 守卫（与 build.test.ts 的 markpadAvailable 惯例一致）。
const manifestPath = path.join(repoRoot, 'server/grammars-manifest.json');
const markpadAvailable = existsSync(SOURCES.buildRs);

interface ManifestGrammar {
  name: string;
  dir: string;
  subpath: string;
  cSymbol: string;
}
interface ServerManifest {
  note: string;
  generatedAt: string;
  grammars: ManifestGrammar[];
}

describe('grammars-manifest.json（入库快照）', () => {
  it.skipIf(!existsSync(manifestPath))(
    '结构：按 name 排序、条目形状 (name, dir, subpath, cSymbol)、301 条（生成时点快照）',
    () => {
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as ServerManifest;
      expect(manifest.note).toContain('Markpad build.rs');
      expect(new Date(manifest.generatedAt).toISOString()).toBe(manifest.generatedAt);
      const names = manifest.grammars.map((g) => g.name);
      expect(names).toEqual([...names].sort());
      expect(names.length).toBe(301);
      for (const g of manifest.grammars) {
        expect(typeof g.name).toBe('string');
        expect(typeof g.dir).toBe('string');
        expect(typeof g.subpath).toBe('string');
        expect(g.cSymbol).toMatch(/^tree_sitter_[a-z0-9_]+$/);
      }
    },
  );

  it.skipIf(!existsSync(manifestPath) || !markpadAvailable)(
    '与 Markpad registry.rs 语言表交叉验证：双侧差集为空（spec §2.1 验收口径）',
    () => {
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as ServerManifest;
      const manifestNames = manifest.grammars.map((g) => g.name).sort();
      // registry.rs 语言表条目形状 ("name", "ffi_name")，ffi_name 可含 '-'（如 c-sharp）
      const reg = readFileSync(
        '/share/rw/repo/markpad-aio/Markpad/src-tauri/src/highlight/registry.rs',
        'utf8',
      );
      const registryNames = [
        ...reg.matchAll(/\(\s*"([a-z0-9_-]+)"\s*,\s*"[a-z0-9_-]+"\s*\)/g),
      ].map((x) => x[1]);
      expect(new Set(registryNames).size).toBe(301);
      expect(manifestNames.filter((x) => !registryNames.includes(x))).toEqual([]);
      expect(registryNames.filter((x) => !manifestNames.includes(x))).toEqual([]);
    },
  );
});
