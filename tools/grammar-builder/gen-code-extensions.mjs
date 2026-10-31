// gen-code-extensions.mjs — C 项：从 languages.json 生成 code 渲染器扩展名全集。
// 生成物入库（运行时装配依赖，lite 离线/e2e 直跑不构建 grammar 也要可用）；
// CI 经 --check 校验新鲜度。规则见 collectExtensions。
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

export const SOURCES = {
  languages: process.env.VV_LANGUAGES_JSON
    ?? join(here, '../../packages/vviewer-highlight/assets/languages.json'),
  outFile: process.env.VV_GENERATED_EXTENSIONS
    ?? join(here, '../../packages/vviewer-core/src/registry/generated-extensions.ts'),
};

/** normalize→过滤→去重→升序。可作扩展名的 token 才收（glob 形排除）。 */
export function collectExtensions(languages) {
  const out = new Set();
  for (const entry of Object.values(languages)) {
    for (const ft of entry.fileTypes ?? []) {
      const norm = String(ft).trim().toLowerCase().replace(/^\./, '');
      if (/^[a-z0-9][a-z0-9+.-]*$/.test(norm)) out.add(norm);
    }
  }
  return [...out].sort();
}

export function toModule(exts) {
  return `// 由 tools/grammar-builder/gen-code-extensions.mjs 生成（C 项）；勿手改，CI --check 校验。\n` +
    `// 来源：packages/vviewer-highlight/assets/languages.json 的 fileTypes 全集。\n` +
    `export const GENERATED_EXTENSIONS: readonly string[] = ${JSON.stringify(exts)};\n`;
}

export function verify(languages, onDisk) {
  const expected = toModule(collectExtensions(languages));
  return expected === onDisk;
}

async function main() {
  const languages = JSON.parse(readFileSync(SOURCES.languages, 'utf8'));
  const exts = collectExtensions(languages);
  if (exts.length < 100) throw new Error(`生成扩展名过少（${exts.length}），语言源异常`);
  if (!exts.includes('jsonl')) throw new Error('生成物必须含 jsonl（C/D 项契约锚点）');
  const check = process.argv.includes('--check');
  const onDisk = (() => {
    try { return readFileSync(SOURCES.outFile, 'utf8'); } catch { return ''; }
  })();
  if (check) {
    if (!verify(languages, onDisk)) {
      console.error('generated-extensions.ts 过期：请运行 node tools/grammar-builder/gen-code-extensions.mjs');
      process.exit(1);
    }
    console.log('generated-extensions.ts 已是最新');
    return;
  }
  mkdirSync(dirname(SOURCES.outFile), { recursive: true });
  writeFileSync(SOURCES.outFile, toModule(exts));
  console.log(`written: ${SOURCES.outFile} (${exts.length} extensions)`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
