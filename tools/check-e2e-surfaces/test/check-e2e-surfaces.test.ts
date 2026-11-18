// check-e2e-surfaces.test.ts — e2e 消费面/语料完整性门禁的单测（评审 important ⑯ +
// minor「两个新护栏脚本零单测」）。
//
// 覆盖面：纯函数面（checkSurface 存在性/形态、parseStage 参数解析、checkCorpusIntegrity
// 的逐条比对四态）+ 仓内实况（真实语料逐条比对通过）。
import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CONSUMER_SURFACES,
  PRODUCER_ONLY_SURFACES,
  checkCorpusIntegrity,
  checkSurface,
  parseStage
} from '../../check-e2e-surfaces.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');

function tmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `vv-surfaces-${prefix}-`));
}

/** 造一个最小语料树（manifest + 一个源的一个文件） */
function makeCorpus(files: Array<{ path: string; content: string; size?: number; sha?: string }>): string {
  const root = tmpDir('corpus');
  const corpusRoot = path.join(root, 'apps/web/e2e/fixtures/corpus');
  const srcDir = path.join(corpusRoot, 'src1');
  fs.mkdirSync(srcDir, { recursive: true });
  const entries = files.map((f) => {
    const abs = path.join(srcDir, f.path);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, f.content);
    return {
      path: f.path,
      size: f.size ?? Buffer.byteLength(f.content),
      sha256: f.sha ?? createHash('sha256').update(f.content).digest('hex')
    };
  });
  fs.writeFileSync(
    path.join(corpusRoot, 'manifest.json'),
    JSON.stringify({ generatedAt: 'x', sources: [{ id: 'src1', files: entries }], counts: {}, failures: [] }),
    'utf8'
  );
  return root;
}

describe('纯函数面 · checkSurface', () => {
  it('存在性 + 形态：目录面要求目录、文件面要求文件', () => {
    const root = tmpDir('surface');
    fs.mkdirSync(path.join(root, 'a-dir'));
    fs.writeFileSync(path.join(root, 'a-file'), 'x');
    expect(checkSurface(root, { path: 'a-dir', type: 'dir' }).ok).toBe(true);
    expect(checkSurface(root, { path: 'a-file', type: 'file' }).ok).toBe(true);
    expect(checkSurface(root, { path: 'a-dir', type: 'file' }).ok).toBe(false);
    expect(checkSurface(root, { path: 'a-file', type: 'dir' }).ok).toBe(false);
    expect(checkSurface(root, { path: 'missing', type: 'file' }).ok).toBe(false);
  });
});

describe('纯函数面 · parseStage', () => {
  it('--stage=producer / --stage producer / 缺省 consumer', () => {
    expect(parseStage(['--stage=producer'])).toBe('producer');
    expect(parseStage(['--stage', 'producer'])).toBe('producer');
    expect(parseStage([])).toBe('consumer');
  });
});

describe('纯函数面 · checkCorpusIntegrity（语料逐条完整性）', () => {
  it('逐条齐全 → ok（path/size/sha256 三项比对）', () => {
    const root = makeCorpus([{ path: 'a.md', content: 'hello' }]);
    const r = checkCorpusIntegrity(root);
    expect(r.ok).toBe(true);
    expect(r.checked).toBe(1);
  });

  it('缺件 → 红（列出缺失路径）——语料缺件曾致受影响用例静默 skip', () => {
    const root = makeCorpus([{ path: 'a.md', content: 'hello' }]);
    fs.rmSync(path.join(root, 'apps/web/e2e/fixtures/corpus/src1/a.md'));
    const r = checkCorpusIntegrity(root);
    expect(r.ok).toBe(false);
    expect(r.missing).toEqual(['src1/a.md']);
  });

  it('体积不符 → 红（内容被截断/换版）', () => {
    const root = makeCorpus([{ path: 'a.md', content: 'hello', size: 999 }]);
    const r = checkCorpusIntegrity(root);
    expect(r.ok).toBe(false);
    expect(r.sizeMismatch.length).toBe(1);
  });

  it('内容漂移（sha256 不符）→ 红；关闭 hash 校验则仅比对存在性与体积', () => {
    const root = makeCorpus([{ path: 'a.md', content: 'hello', sha: 'f'.repeat(64) }]);
    const withHash = checkCorpusIntegrity(root);
    expect(withHash.ok).toBe(false);
    expect(withHash.hashMismatch).toEqual(['src1/a.md']);
    const noHash = checkCorpusIntegrity(root, { verifyHash: false });
    expect(noHash.ok).toBe(true);
  });

  it('manifest 缺失 → 红（附 reason，不静默放过）', () => {
    const root = tmpDir('no-manifest');
    const r = checkCorpusIntegrity(root);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('manifest 缺失');
  });
});

describe('仓内实况 · 消费面清单与真实语料', () => {
  it('消费面清单：每项有 path/type/why（缺项即自检失效）', () => {
    for (const s of [...CONSUMER_SURFACES, ...PRODUCER_ONLY_SURFACES]) {
      expect(typeof s.path).toBe('string');
      expect(['file', 'dir']).toContain(s.type);
      expect(typeof s.why).toBe('string');
      expect(s.why.length).toBeGreaterThan(0);
    }
  });

  it('消费面清单的**路径集合**锁定（评审 minor：此前只校验条目形状，不校验集合 → 清单漂移无报警面）', () => {
    // 新增/移除/改名消费面必须在此登记（登记即 diff 可核对）——「spec 进程直读仓库树/
    // 构建产物」的面靠人工盘点，集合锁定后盘点漏项即红。
    expect(CONSUMER_SURFACES.map((s) => s.path)).toEqual([
      'packages/vviewer-core/src/registry/generated-extensions.ts',
      'packages/vviewer-highlight/assets/themes.json',
      'packages/vviewer-highlight/assets/languages.json',
      'apps/web/.svelte-kit/output/server/manifest.js',
      'apps/web/.svelte-kit/output/client',
      'apps/web/build/index.html',
      'apps/web/build/sw.js',
      'apps/web/build/_app/immutable',
      'server/target/debug/vviewer',
      'apps/web/e2e/fixtures/corpus/manifest.json'
    ]);
    expect(PRODUCER_ONLY_SURFACES.map((s) => s.path)).toEqual([
      'server/grammars-manifest.json',
      'packages/vviewer-highlight/assets/queries',
      'tools/grammar-builder/out/grammars',
      'apps/web/static/grammars',
      'apps/web/static/tree-sitter.wasm'
    ]);
  });

  it('真实语料逐条比对通过（语料在位时）', () => {
    const manifest = path.join(REPO_ROOT, 'apps/web/e2e/fixtures/corpus/manifest.json');
    if (!fs.existsSync(manifest)) return; // 语料未下载（干净克隆）→ 跳过
    const r = checkCorpusIntegrity(REPO_ROOT);
    expect(r.missing).toEqual([]);
    expect(r.sizeMismatch).toEqual([]);
    expect(r.hashMismatch).toEqual([]);
    expect(r.checked).toBeGreaterThan(0);
  });
});
