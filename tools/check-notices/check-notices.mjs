#!/usr/bin/env node
// check-notices.mjs — THIRD_PARTY_NOTICES 完整性辅助检查（warning-only，恒 exit 0）。
// 汇总 pnpm-lock importers 的运行时直接依赖（dependencies 段；跳过 @vviewer/* workspace
// 链接与 devDependencies——后者不随运行时分发），从 node_modules/<pkg>/package.json 读
// license 字段，与 NOTICES 表格登记名对比，缺登记者列出。作为 ci.yml web job 末尾
// 辅助步骤输出提示，不阻断（引入新运行时依赖忘登记时在 CI 日志可见）。
// 用法：node tools/check-notices.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../..');

export const PATHS = {
  lock: process.env.VV_PNPM_LOCK ?? path.join(repoRoot, 'pnpm-lock.yaml'),
  notices: process.env.VV_NOTICES ?? path.join(repoRoot, 'THIRD_PARTY_NOTICES.md'),
  repoRoot
};

/**
 * pnpm-lock importers 段的运行时直接依赖去重清单。
 * 只认 `dependencies:` 段 6 空格缩进的条目（8 空格的 specifier/version 字段天然不匹配）；
 * @vviewer/* workspace 链接不是第三方，跳过。
 */
export function collectRuntimeDeps(lockText) {
  const m = lockText.match(/\nimporters:\n(.*?)\n\npackages:/s);
  if (!m) return [];
  const out = [];
  let section = null;
  for (const line of m[1].split('\n')) {
    if (/^ {2}\S.*:\s*$/.test(line)) {
      section = null; // 下一个 importer
      continue;
    }
    if (/^ {4}dependencies:\s*$/.test(line)) {
      section = 'runtime';
      continue;
    }
    if (/^ {4}(devDependencies|optionalDependencies):\s*$/.test(line)) {
      section = null;
      continue;
    }
    const d = line.match(/^ {6}'?([^\s:]+)'?:/);
    if (d && section === 'runtime') {
      const name = d[1];
      if (name.startsWith('@vviewer/')) continue;
      if (!out.includes(name)) out.push(name);
    }
  }
  return out;
}

/** NOTICES 表格第一列组件名（跳过表头与分隔行） */
export function parseNoticesNames(mdText) {
  const names = [];
  for (const line of mdText.split('\n')) {
    const m = line.match(/^\| ([^|]+?) \|/);
    if (!m) continue;
    const name = m[1].trim();
    if (name === '' || name === '组件' || name.startsWith('-') || name.startsWith(':')) continue;
    names.push(name);
  }
  return names;
}

/** 依赖名是否已登记：全等，或登记项以 "<dep>（" 开头（带中文注记的登记名，如 xlsx（SheetJS community）） */
export function isRegistered(dep, registered) {
  return registered.some((n) => n === dep || n.startsWith(`${dep}（`));
}

/** 读 <dir>/node_modules/<name>/package.json 的 license 字段；未安装返回 null */
export function readLicense(dir, name) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'node_modules', name, 'package.json'), 'utf8'));
    const lic = pkg.license;
    if (typeof lic === 'string') return lic;
    if (lic && typeof lic === 'object' && typeof lic.type === 'string') return lic.type;
    if (Array.isArray(pkg.licenses)) {
      return pkg.licenses.map((l) => (typeof l === 'string' ? l : l?.type)).filter(Boolean).join(',');
    }
    return 'UNKNOWN';
  } catch {
    return null;
  }
}

/** 依次在根与各 workspace 包的 node_modules 找依赖的 license（pnpm 符号链接按 importer 就近） */
export function findLicense(repoRoot, name) {
  const candidates = [repoRoot, path.join(repoRoot, 'apps/web'), ...fs.readdirSync(path.join(repoRoot, 'packages')).map((p) => path.join(repoRoot, 'packages', p))];
  for (const dir of candidates) {
    const lic = readLicense(dir, name);
    if (lic !== null) return lic;
  }
  return null;
}

export function main() {
  const deps = collectRuntimeDeps(fs.readFileSync(PATHS.lock, 'utf8'));
  const registered = parseNoticesNames(fs.readFileSync(PATHS.notices, 'utf8'));
  const missing = [];
  for (const dep of deps) {
    if (!isRegistered(dep, registered)) {
      missing.push({ name: dep, license: findLicense(repoRoot, dep) ?? 'unknown（node_modules 未安装）' });
    }
  }
  if (missing.length > 0) {
    console.warn(`[check-notices] ${missing.length} 个运行时直接依赖未在 THIRD_PARTY_NOTICES.md 登记（warning-only）：`);
    for (const m of missing) console.warn(`  - ${m.name}（license: ${m.license}）`);
    console.warn('[check-notices] 请补登记或确认其为开发期依赖（devDependencies 不检查）。');
  } else {
    console.log(`[check-notices] OK：${deps.length} 个运行时直接依赖均已登记。`);
  }
  return { deps, registered, missing };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
