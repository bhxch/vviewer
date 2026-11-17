// assets.test.ts — 扩展离线资产采集契约（spec H T1 Step 2）。
//
// 覆盖面（计划 T1 Step 2 明列）：
// - queries 语言过滤：按 manifest 语言集取目录、缺目录跳过
// - pdf worker 采集清单：modern/legacy 两文件均需存在且非空
// - katex 字体清单：20 个 woff2 名单与体积
// - 主题裁剪：输出只含两键
// - icon 存在性
// - 缺件时错误信息含修复命令
//
// 纯函数直测 .mjs 实现（vitest 直解析 .mjs；tsc 侧靠 scripts/collect-assets.d.mts 声明）。
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  FIX_COMMANDS,
  PACKAGED_THEMES,
  REPO_ROOT,
  assertIcon,
  listKatexFonts,
  missingSourceError,
  planPdfWorkers,
  readGrammarManifest,
  resolvePkgDir,
  selectQueryLanguages,
  trimThemes
} from '../scripts/collect-assets.mjs';

const APP_DIR = path.join(REPO_ROOT, 'apps/vscode');

function tmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `vv-vscode-${prefix}-`));
}

function writeFile(file: string, content = 'x'): string {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, 'utf8');
  return file;
}

describe('资产采集 · grammar manifest', () => {
  it('读出 manifest 的 grammars 键集（canonical 语言名）', () => {
    const dir = tmpDir('grammars');
    writeFile(
      path.join(dir, 'manifest.json'),
      JSON.stringify({ grammars: { bash: { file: 'bash.wasm' }, python: { file: 'python.wasm' } } })
    );
    const { languages } = readGrammarManifest(dir);
    expect(languages).toEqual(['bash', 'python']);
  });

  it('manifest 缺失即 fail-fast，错误信息含可执行修复命令', () => {
    const dir = tmpDir('grammars-missing');
    expect(() => readGrammarManifest(dir)).toThrow(/资产源缺失/);
    expect(() => readGrammarManifest(dir)).toThrow(new RegExp(escapeRe(FIX_COMMANDS.grammars)));
  });

  it('manifest 无 grammars 键即 fail-fast（含修复命令）', () => {
    const dir = tmpDir('grammars-bad');
    writeFile(path.join(dir, 'manifest.json'), JSON.stringify({ note: 'x' }));
    expect(() => readGrammarManifest(dir)).toThrow(/修复命令/);
  });
});

describe('资产采集 · queries 语言过滤', () => {
  it('仅取 manifest 语言集命中项；缺目录跳过（不入 missing 即抛错）', () => {
    const dir = tmpDir('queries');
    fs.mkdirSync(path.join(dir, 'bash'));
    fs.mkdirSync(path.join(dir, 'python'));
    fs.mkdirSync(path.join(dir, 'extra'));
    const { selected, missing } = selectQueryLanguages(['bash', 'python', 'rust'], dir);
    expect(selected).toEqual(['bash', 'python']);
    expect(missing).toEqual(['rust']);
  });

  it('queries 目录缺失即 fail-fast（含修复命令）', () => {
    expect(() => selectQueryLanguages(['bash'], path.join(tmpDir('queries-none'), 'nope'))).toThrow(
      new RegExp(escapeRe(FIX_COMMANDS.queries))
    );
  });
});

describe('资产采集 · pdfjs worker 双分支', () => {
  it('modern/legacy 两文件均纳入清单且非空', () => {
    const dir = tmpDir('pdfjs');
    writeFile(path.join(dir, 'build/pdf.worker.min.mjs'), 'modern-worker');
    writeFile(path.join(dir, 'legacy/build/pdf.worker.min.mjs'), 'legacy-worker');
    const plan = planPdfWorkers(dir);
    expect(plan.map((w) => w.id)).toEqual(['modern', 'legacy']);
    expect(plan.map((w) => w.outRel)).toEqual(['pdf/pdf.worker.min.mjs', 'pdf/pdf.worker.legacy.min.mjs']);
    expect(plan.every((w) => w.bytes > 0)).toBe(true);
  });

  it('任一分支缺失即 fail-fast（含修复命令）', () => {
    const dir = tmpDir('pdfjs-missing');
    writeFile(path.join(dir, 'build/pdf.worker.min.mjs'), 'modern');
    expect(() => planPdfWorkers(dir)).toThrow(new RegExp(escapeRe(FIX_COMMANDS.packages)));
  });

  it('分支文件为空即 fail-fast（空文件非「无内容」）', () => {
    const dir = tmpDir('pdfjs-empty');
    writeFile(path.join(dir, 'build/pdf.worker.min.mjs'), '');
    writeFile(path.join(dir, 'legacy/build/pdf.worker.min.mjs'), 'legacy');
    expect(() => planPdfWorkers(dir)).toThrow(/为空文件/);
  });
});

describe('资产采集 · katex 字体清单', () => {
  it('只取 woff2（woff/ttf 不取——web 端同款取舍）', () => {
    const dir = tmpDir('katex');
    fs.mkdirSync(path.join(dir, 'fonts'), { recursive: true });
    for (let i = 0; i < 20; i++) writeFile(path.join(dir, 'fonts', `KaTeX_Test-${i}.woff2`), 'f');
    writeFile(path.join(dir, 'fonts', 'KaTeX_Test.woff'), 'f');
    writeFile(path.join(dir, 'fonts', 'KaTeX_Test.ttf'), 'f');
    const fonts = listKatexFonts(dir);
    expect(fonts).toHaveLength(20);
    expect(fonts.every((f) => f.endsWith('.woff2'))).toBe(true);
  });

  it('字体目录缺失即 fail-fast（含修复命令）', () => {
    expect(() => listKatexFonts(tmpDir('katex-none'))).toThrow(
      new RegExp(escapeRe(FIX_COMMANDS.packages))
    );
  });

  it('真实仓内 katex dist：20 个 woff2 且逐个非空', () => {
    const dist = resolvePkgDir('katex', APP_DIR, 'entry');
    const fonts = listKatexFonts(dist);
    expect(fonts).toHaveLength(20);
    for (const font of fonts) {
      expect(fs.statSync(path.join(dist, 'fonts', font)).size).toBeGreaterThan(0);
    }
  });
});

describe('资产采集 · 主题裁剪', () => {
  it('输出只含 onelight 与 serika-dark 两键', () => {
    const trimmed = trimThemes({
      onelight: { keyword: '#cf222e' },
      'serika-dark': { keyword: '#c792ea' },
      'dracula': { keyword: '#ff79c6' }
    });
    expect(Object.keys(trimmed)).toEqual(['onelight', 'serika-dark']);
    expect(PACKAGED_THEMES).toEqual(['onelight', 'serika-dark']);
  });

  it('缺键即 fail-fast（含修复命令）', () => {
    expect(() => trimThemes({ onelight: {} })).toThrow(new RegExp(escapeRe(FIX_COMMANDS.themes)));
  });

  it('真实仓内 themes.json 裁剪后仍只含两键', () => {
    const themesPath = path.join(REPO_ROOT, 'packages/vviewer-highlight/assets/themes.json');
    const themes = JSON.parse(fs.readFileSync(themesPath, 'utf8')) as Record<string, unknown>;
    expect(Object.keys(themes).length).toBeGreaterThan(100);
    const trimmed = trimThemes(themes);
    expect(Object.keys(trimmed)).toEqual(['onelight', 'serika-dark']);
  });
});

describe('资产采集 · icon', () => {
  it('存在且非空', () => {
    const dir = tmpDir('icon');
    const file = writeFile(path.join(dir, 'icon.png'), 'png-bytes');
    expect(assertIcon(file).bytes).toBeGreaterThan(0);
  });

  it('缺失即 fail-fast（含修复命令）', () => {
    expect(() => assertIcon(path.join(tmpDir('icon-none'), 'icon.png'))).toThrow(
      new RegExp(escapeRe(FIX_COMMANDS.icon))
    );
  });

  it('真实仓内 icon.png 是 ≥128×128 的 PNG（vsce 禁 SVG）', () => {
    const iconPath = path.join(APP_DIR, 'media/icon.png');
    expect(assertIcon(iconPath).bytes).toBeGreaterThan(0);
    const buf = fs.readFileSync(iconPath);
    expect(buf.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    // IHDR：偏移 8 起「IHDR」+ 4 字节长 + width(4) + height(4)
    const width = buf.readUInt32BE(16);
    const height = buf.readUInt32BE(20);
    expect(width).toBeGreaterThanOrEqual(128);
    expect(height).toBeGreaterThanOrEqual(128);
  });
});

describe('资产采集 · 真实仓内源齐备（构建前置可见性）', () => {
  it('grammar manifest 的语言集非空且 queries 命中大部分语言', () => {
    const { languages } = readGrammarManifest(path.join(REPO_ROOT, 'apps/web/static/grammars'));
    expect(languages.length).toBeGreaterThan(0);
    const { selected, missing } = selectQueryLanguages(
      languages,
      path.join(REPO_ROOT, 'packages/vviewer-highlight/assets/queries')
    );
    expect(selected.length).toBeGreaterThan(0);
    expect(missing.every((lang) => !selected.includes(lang))).toBe(true);
  });
});

describe('资产采集 · 错误信息形态', () => {
  it('missingSourceError 的 message 含修复命令原文', () => {
    const err = missingSourceError('某某源', 'pnpm gen:sources');
    expect(err.message).toContain('资产源缺失');
    expect(err.message).toContain('pnpm gen:sources');
  });
});

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
