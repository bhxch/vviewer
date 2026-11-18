// check-release-wiring.mjs — 发布链接线门禁（评审 critical ① + important ④）。
//
// 背景（两条同源缺陷）：
// ① 随 npm 发布的 @bhxch/vviewer-markdown 把默认 grammar base 钉死在占位版本
//    `0.0.0-FIRST-TAG`——npm 版本不可变，该版本永不存在 → 6 层 manifest 全 404 →
//    引擎初始化异常被 catch 吞掉 → 外部消费者静默降级 hljs；且**全仓无任何 CI/release
//    门禁校准该版本号**（首发 tag 定稿也需改源码，漏改即永久失效）。
// ② VV_GRAMMAR_PACK_COUNT 在任何 workflow 里都没被注入（恒为缺省 '1'）→ 生产构建的
//    unpkg/cn 两档恒只展开 p1 一个子包（静默丢掉 5/6 语言，缺层仅 console.warn）；
//    且 apps/web 的 npm scope 写死 @bhxch，与发布变量 vars.NPM_SCOPE 不连通。
//
// 本门禁把「三处口径」锁成一条链：
//   ① .github/workflows/release.yml 的 workflow 级 VV_NPM_PACKAGE_COUNT（子包数真相源）
//   ② packages/vviewer-markdown 的 GRAMMAR_PACK_COUNT / GRAMMAR_PACK_SCOPE（包内默认）
//   ③ apps/web 的 VV_NPM_SCOPE / VV_GRAMMAR_PACK_COUNT 注入（release + pages 两个构建面）
// 任一漂移即红（退出码 1）。纯文本解析（不引 yaml 依赖）——只认本仓既定的
// `KEY: 'value'` / `KEY=value` 两种写法，命中不了即报「未接线」而非静默通过。
//
// 用法：node tools/check-release-wiring/check-release-wiring.mjs

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(HERE, '..', '..');

/** 受检文件（相对仓库根）——单一清单，改动即改这里。 */
export const CHECKED_FILES = {
  release: '.github/workflows/release.yml',
  pages: '.github/workflows/pages-deploy.yml',
  markdownDefault: 'packages/vviewer-markdown/src/highlightDefault.ts',
  webProfiles: 'apps/web/src/lib/cdnProfiles.ts'
};

/**
 * 读 workflow 级 `KEY: 'value'` 形式的 env 值（引号可有可无）。
 * @param {string} text workflow 文本
 * @param {string} key env 名
 * @returns {string | null} 值（未命中 null）
 */
export function readWorkflowEnvValue(text, key) {
  const re = new RegExp(`^\\s*${key}:\\s*['"]?([^'"\n#]+?)['"]?\\s*$`, 'm');
  const m = re.exec(text);
  return m ? m[1].trim() : null;
}

/**
 * 读 `echo "KEY=VALUE" >> "$GITHUB_ENV"` 形式的注入（注入面存在性）。
 * @param {string} text workflow 文本
 * @param {string} key env 名
 * @returns {boolean} 是否存在该注入
 */
export function hasEnvInjection(text, key) {
  return new RegExp(`echo\\s+"${key}=`, 'm').test(text);
}

/**
 * 读 `vars.KEY || 'fallback'` 形态的缺省字面量（发布变量回落值）。
 * @param {string} text workflow 文本
 * @param {string} key 仓库变量名
 * @returns {string | null} 回落字面量（未命中 null）
 */
export function readScopeFallback(text, key = 'NPM_SCOPE') {
  const m = new RegExp(`vars\\.${key}\\s*\\|\\|\\s*'([^']+)'`).exec(text);
  return m ? m[1] : null;
}

/**
 * 读 TS 源码里的 `export const NAME = <数字>`（包内层数常量）。
 * @param {string} text 源码文本
 * @param {string} name 常量名
 * @returns {number | null} 数值（未命中 null）
 */
export function readNumericConst(text, name) {
  const m = new RegExp(`export const ${name}\\s*=\\s*(\\d+)`).exec(text);
  return m ? Number(m[1]) : null;
}

/**
 * 读 TS 源码里的字符串常量（取声明体内**最后一个**字符串字面量——声明体可含类型
 * 标注里的字面量名，如 `env?: { VV_NPM_SCOPE?: string }`，取末位才是缺省值）。
 * @param {string} text 源码文本
 * @param {string} name 常量名
 * @returns {string | null} 字面量（未命中 null）
 */
export function readStringConst(text, name) {
  const decl = new RegExp(`export const ${name}\\s*=([\\s\\S]{0,400}?);`).exec(text);
  if (!decl) return null;
  const literals = [...decl[1].matchAll(/'([^']*)'/g)].map((m) => m[1]);
  return literals.length > 0 ? literals[literals.length - 1] : null;
}

/**
 * 剥注释（行注释 + 块注释）——占位版本扫描只看代码面：注释里的历史版本号是**说明**
 * （如「此前钉死 0.0.0-FIRST-TAG」），不是生效值，误判即门禁噪声。
 * @param {string} text 源码文本
 * @returns {string} 去注释后的文本
 */
export function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

/**
 * 占位版本段检测：npm 版本不可变，占位版本号永不存在于线上 → 层全 404 静默降级。
 * @param {string} text 源码文本（注释已由 stripComments 剥离）
 * @returns {string[]} 命中的占位标记
 */
export function findPlaceholderVersions(text) {
  const hits = [];
  const patterns = [
    /FIRST-TAG/g,
    /0\.0\.0-[A-Za-z-]+/g,
    /@latest\b/g
  ];
  for (const re of patterns) {
    for (const m of text.matchAll(re)) hits.push(m[0]);
  }
  return hits;
}

/**
 * 汇总门禁问题（纯函数：输入为文件文本，输出为问题清单——空清单 = 通过）。
 * @param {{release: string, pages: string, markdownDefault: string, webProfiles: string}} files
 * @returns {string[]} 问题描述
 */
export function collectProblems(files) {
  const problems = [];

  // ① 发布链子包数（真相源）
  const packCount = readWorkflowEnvValue(files.release, 'VV_NPM_PACKAGE_COUNT');
  if (packCount === null) {
    problems.push('release.yml 未声明 workflow 级 VV_NPM_PACKAGE_COUNT（子包数真相源缺失）');
  } else if (!/^\d+$/.test(packCount) || Number(packCount) < 1) {
    problems.push(`release.yml 的 VV_NPM_PACKAGE_COUNT 非法：${packCount}`);
  }

  // ② 包内默认（markdown 包）
  const pkgCount = readNumericConst(files.markdownDefault, 'GRAMMAR_PACK_COUNT');
  if (pkgCount === null) {
    problems.push('highlightDefault.ts 未声明 GRAMMAR_PACK_COUNT（包内默认层数常量缺失）');
  }
  const pkgScope = readStringConst(files.markdownDefault, 'GRAMMAR_PACK_SCOPE');
  if (pkgScope === null) {
    problems.push('highlightDefault.ts 未声明 GRAMMAR_PACK_SCOPE（包内默认 scope 常量缺失）');
  }
  const placeholders = findPlaceholderVersions(stripComments(files.markdownDefault));
  if (placeholders.length > 0) {
    problems.push(
      `highlightDefault.ts 含占位/钉死版本段：${[...new Set(placeholders)].join(', ')}——` +
        'npm 版本不可变，占位版本永不存在 → 层全 404 静默降级 hljs'
    );
  }

  // ③ 三处层数口径一致
  if (packCount !== null && pkgCount !== null && Number(packCount) !== pkgCount) {
    problems.push(`子包数漂移：release.yml=${packCount} vs 包内 GRAMMAR_PACK_COUNT=${pkgCount}`);
  }

  // ④ 构建面注入（release + pages 两处）
  for (const [label, text] of [
    ['release.yml', files.release],
    ['pages-deploy.yml', files.pages]
  ]) {
    if (!hasEnvInjection(text, 'VV_GRAMMAR_PACK_COUNT')) {
      problems.push(`${label} 未注入 VV_GRAMMAR_PACK_COUNT（unpkg/cn 档恒按缺省 1 展开，静默丢层）`);
    }
    if (!hasEnvInjection(text, 'VV_NPM_SCOPE')) {
      problems.push(`${label} 未注入 VV_NPM_SCOPE（scope 与发布变量不连通）`);
    }
  }

  // ⑤ scope 口径一致（发布回落值 = 包内常量 = web 缺省值）
  const releaseScope = readScopeFallback(files.release);
  const pagesScope = readScopeFallback(files.pages);
  for (const [label, scope] of [
    ['release.yml', releaseScope],
    ['pages-deploy.yml', pagesScope]
  ]) {
    if (scope === null) {
      problems.push(`${label} 未给 vars.NPM_SCOPE 回落字面量（scope 缺省不可知）`);
    } else if (pkgScope !== null && scope !== pkgScope) {
      problems.push(`scope 漂移：${label} 回落 ${scope} vs 包内 GRAMMAR_PACK_SCOPE=${pkgScope}`);
    }
  }
  const webScope = readStringConst(files.webProfiles, 'GRAMMAR_PACK_SCOPE');
  if (webScope === null) {
    problems.push('cdnProfiles.ts 未声明 GRAMMAR_PACK_SCOPE（web 侧 scope 常量缺失）');
  } else if (pkgScope !== null && webScope !== pkgScope) {
    problems.push(`scope 漂移：cdnProfiles.ts ${webScope} vs 包内 GRAMMAR_PACK_SCOPE=${pkgScope}`);
  }

  return problems;
}

/**
 * 读仓内受检文件并跑门禁。
 * @param {string} repoRoot 仓库根
 * @returns {{problems: string[], files: Record<string, string>}}
 */
export function checkRepo(repoRoot = REPO_ROOT) {
  const files = {};
  for (const [key, rel] of Object.entries(CHECKED_FILES)) {
    files[key] = fs.readFileSync(path.join(repoRoot, rel), 'utf8');
  }
  return { problems: collectProblems(files), files };
}

// CLI 直跑形态
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const { problems } = checkRepo();
  if (problems.length > 0) {
    console.error('[release-wiring] 发布链接线门禁不通过：');
    for (const p of problems) console.error(`  - ${p}`);
    process.exitCode = 1;
  } else {
    console.log('[release-wiring] 发布链接线门禁通过（子包数 / scope / 占位版本三处口径一致）');
  }
}
