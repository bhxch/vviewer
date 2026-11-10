#!/usr/bin/env node
// check-foreign-deps.mjs — @file-viewer/* 外部依赖白名单门禁（plan-3 foreign 批引入的锁版纪律）。
// 校验 apps/web/package.json 中所有 @file-viewer/* 依赖：
//   (a) 精确版本（无 ^ ~ >= < * x 等范围前缀/通配）——外部渲染链版本漂移即整链失效，故死锁 patch 版；
//   (b) 与 pnpm-lock.yaml apps/web importer 的解析版本一致（防「声明精确但 lock 未跟进」漂移）；
//   (c) CDN 版本交叉（终审修复波 M1）：apps/web/src/lib/foreignAssets.ts 缺省 CDN 直链的
//       assets-standard@x.y.z 与 @file-viewer/core 版本比对——资产系（assets-*）与 core 同版号
//       发布，core 版本即资产系版本，任一侧单独 bump 都会令 CDN 直链指向旧资产树（worker/
//       wasm 404 或新旧错配），不一致即 violation。
// 违规列明细并 exit 1；零 @file-viewer 依赖（plan-3-not-applied 状态）放行并提示。
// 解析走最小行结构正则（沿 check-notices.mjs 惯例，不引 yaml 依赖）；--check 为 CI 显式语义
//（本脚本只有校验一种模式，无旗标同义）。
// 用法：node tools/check-foreign-deps.mjs [--check]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');

export const PATHS = {
  webPkg: process.env.VV_WEB_PACKAGE_JSON ?? path.join(repoRoot, 'apps/web/package.json'),
  lock: process.env.VV_PNPM_LOCK ?? path.join(repoRoot, 'pnpm-lock.yaml'),
  foreignAssets: process.env.VV_FOREIGN_ASSETS_TS ?? path.join(repoRoot, 'apps/web/src/lib/foreignAssets.ts'),
  repoRoot
};

export const FOREIGN_PREFIX = '@file-viewer/';
export const IMPORTER = 'apps/web';

/** 精确版本判定：仅 x.y.z（可带 -prerelease/+build 后缀），拒绝 ^ ~ >= < * x-range/workspace */
export function isExactVersion(spec) {
  return /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(spec);
}

/** lockfile 解析版本取主版本（pnpm 对带 peer 的条目记为 x.y.z(peer@a.b.c)，peer 括号后缀不参与比较） */
export function lockBaseVersion(lockVersion) {
  const i = lockVersion.indexOf('(');
  return i < 0 ? lockVersion : lockVersion.slice(0, i);
}

/**
 * pnpm-lock importers 段单 importer 的依赖解析表 {name: {specifier, version}}。
 * 覆盖 dependencies / devDependencies / optionalDependencies 三段；importer 边界
 * 以 2 空格缩进标题（下一个 importer 或顶层段）为准。
 */
export function parseImporterDeps(lockText, importer) {
  const lines = lockText.split('\n');
  const header = `  ${importer}:`;
  let start = lines.findIndex((l) => l === header);
  if (start < 0) return {};
  const out = {};
  let section = null;
  let current = null;
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (/^\S/.test(line) || /^ {2}\S/.test(line)) break; // 顶层段或下一 importer：单 importer 块结束
    if (/^ {4}\S.*:\s*$/.test(line)) {
      section = line.trim().replace(/:$/, '');
      current = null;
      continue;
    }
    const d = line.match(/^ {6}'?([^':]+)'?:\s*$/);
    if (d && ['dependencies', 'devDependencies', 'optionalDependencies'].includes(section)) {
      current = d[1];
      out[current] = {};
      continue;
    }
    if (current) {
      const f = line.match(/^ {8}(specifier|version):\s*(.*)$/);
      if (f) out[current][f[1]] = f[2].trim();
    }
  }
  return out;
}

/**
 * 白名单校验：扫描 pkgJson 的 dependencies + devDependencies（+optionalDependencies）中
 * @file-viewer/* 键，返回 {violations, count}。violations 元素：
 *   {name, kind: 'range', spec}                     — 声明非精确版本
 *   {name, kind: 'lock-mismatch', spec, resolved}   — lock 解析版本与声明不一致（含 link:）
 *   {name, kind: 'lock-missing', spec}              — lock 中无该包条目
 */
export function checkForeignDeps(pkgJson, lockDeps) {
  const violations = [];
  let count = 0;
  for (const section of ['dependencies', 'devDependencies', 'optionalDependencies']) {
    const deps = pkgJson[section];
    if (!deps) continue;
    for (const [name, spec] of Object.entries(deps)) {
      if (!name.startsWith(FOREIGN_PREFIX)) continue;
      count++;
      if (!isExactVersion(spec)) {
        violations.push({ name, kind: 'range', spec });
        continue;
      }
      const entry = lockDeps[name];
      if (!entry) {
        violations.push({ name, kind: 'lock-missing', spec });
        continue;
      }
      const resolved = lockBaseVersion(entry.version ?? '');
      if (entry.version?.startsWith('link:') || resolved !== spec) {
        violations.push({ name, kind: 'lock-mismatch', spec, resolved: entry.version ?? '(无 version 字段)' });
      }
    }
  }
  return { violations, count };
}

/**
 * M1（终审修复波）：CDN URL 版本交叉门禁。apps/web/src/lib/foreignAssets.ts 的
 * FOREIGN_ASSETS_CDN_DEFAULT 直链钉死 assets-standard@x.y.z（版本锁定纪律：禁 ^/~），
 * 而资产系（assets-*）与 @file-viewer/core 同版号发布——core 版本即资产系版本锚。
 * 正则取全文首个 assets-standard@x.y.z：常量与文件头注记同版号书写，单侧漏改即红
 * （版本纪律门禁的强制一致性偏置）。无命中返回 null（正则漂移/常量移位面，校验层
 * 单列 violation，不静默放行）。
 */
export function extractForeignAssetsCdnVersion(sourceText) {
  const m = sourceText.match(/assets-standard@(\d+\.\d+\.\d+)/);
  return m ? m[1] : null;
}

/** core 版本锚：apps/web 依赖三段回退取 @file-viewer/core 精确版本（checkForeignDeps
 * 已先验其精确性），无依赖返回 null（plan-3-not-applied 放行）。 */
export function coreVersionOf(pkgJson) {
  for (const section of ['dependencies', 'devDependencies', 'optionalDependencies']) {
    const v = pkgJson[section]?.['@file-viewer/core'];
    if (v) return v;
  }
  return null;
}

/**
 * 交叉校验（纯函数）：core 锚缺失（零依赖）放行；CDN 版本 null 或与 core 锚不一致
 * 均 violation。返回 null = 通过。
 */
export function checkCdnAssetVersion(cdnVersion, coreVersion) {
  if (!coreVersion) return null;
  if (!cdnVersion) return { kind: 'cdn-version-unparsed', coreVersion };
  if (cdnVersion !== coreVersion) return { kind: 'cdn-version-mismatch', cdnVersion, coreVersion };
  return null;
}

export function main() {
  const pkgJson = JSON.parse(fs.readFileSync(PATHS.webPkg, 'utf8'));
  const lockText = fs.readFileSync(PATHS.lock, 'utf8');
  const { violations, count } = checkForeignDeps(pkgJson, parseImporterDeps(lockText, IMPORTER));
  if (count === 0) {
    console.log(`[check-foreign-deps] OK：${IMPORTER} 无 ${FOREIGN_PREFIX}* 依赖（plan-3-not-applied 状态，白名单门禁放行）。`);
    return { violations, count };
  }
  // M1：CDN 版本交叉（有依赖面才校验；foreignAssets.ts 不可读视同无法解析，不静默放行）
  let cdnVersion;
  try {
    cdnVersion = extractForeignAssetsCdnVersion(fs.readFileSync(PATHS.foreignAssets, 'utf8'));
  } catch {
    cdnVersion = null;
  }
  const cdnViolation = checkCdnAssetVersion(cdnVersion, coreVersionOf(pkgJson));
  if (cdnViolation) violations.push(cdnViolation);
  if (violations.length > 0) {
    console.error(`[check-foreign-deps] ${violations.length} 处违规（@file-viewer/* 白名单：精确锁版 + lockfile 一致 + CDN 版本交叉）：`);
    for (const v of violations) {
      if (v.kind === 'range') console.error(`  - ${v.name}: 声明「${v.spec}」含范围前缀/通配，须精确版本`);
      else if (v.kind === 'lock-missing') console.error(`  - ${v.name}: 声明「${v.spec}」，但 pnpm-lock ${IMPORTER} 无该包条目`);
      else if (v.kind === 'lock-mismatch') console.error(`  - ${v.name}: 声明「${v.spec}」，lock 解析为「${v.resolved}」不一致`);
      else if (v.kind === 'cdn-version-mismatch')
        console.error(`  - foreignAssets.ts 缺省 CDN assets-standard@${v.cdnVersion} 与 core 锚 ${v.coreVersion} 不一致（资产系与 core 同版号发布，同步 bump）`);
      else if (v.kind === 'cdn-version-unparsed')
        console.error(`  - foreignAssets.ts 未提取到 assets-standard@x.y.z 直链版本（正则漂移或常量移位），须人工核对`);
    }
    process.exitCode = 1;
  } else {
    console.log(
      `[check-foreign-deps] OK：${count} 个 @file-viewer/* 依赖全部精确锁版且与 pnpm-lock.yaml（${IMPORTER}）一致，CDN 直链 assets-standard@${cdnVersion} 与 core 版本交叉一致。`
    );
  }
  return { violations, count };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
