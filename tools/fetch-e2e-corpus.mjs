#!/usr/bin/env node
// fetch-e2e-corpus.mjs — 下载 e2e markdown 渲染语料到 apps/web/e2e/fixtures/markpad-md/。
// 语料为 bhxch/Markpad@master 全部 *.md/*.markdown（实测 27 个 ≈424KB），保留仓库内相对
// 路径（嵌套目录照建）。真实文件不入库（避免上游许可证问题，目录已 gitignore），本脚本
// 即初始化测试环境的一步：本地手动跑，CI e2e job 在 playwright test 前同样执行
// （GITHUB_TOKEN 传 github.token 提升 API 限流，匿名 60 → 1000 req/h）。
// 行为：GitHub trees API 列清单 → raw.githubusercontent.com 逐个下载（非 2xx 或内容以
// "<!DOCTYPE html" 开头视为错误页，按失败重试 2 次，仍失败记入失败清单继续）→ 幂等可
// 重跑（已存在且 size 与清单一致则跳过）→ 写 manifest.json（每文件 path/size/sha256 +
// git blob sha 校验，防 CDN 损坏）。清单拉取失败、清单为空或全部文件失败时以非 0 退出。
// 用法：node tools/fetch-e2e-corpus.mjs   （可选 env GITHUB_TOKEN）
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = 'bhxch/Markpad';
const REF = 'master';
const TREE_API = `https://api.github.com/repos/${REPO}/git/trees/${REF}?recursive=1`;
const RAW_BASE = `https://raw.githubusercontent.com/${REPO}/${REF}/`;
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const corpusDir = join(root, 'apps', 'web', 'e2e', 'fixtures', 'markpad-md');
const MAX_ATTEMPTS = 3; // 首次 + 重试 2 次

const log = (...m) => console.log('[fetch-e2e-corpus]', ...m);
const err = (...m) => console.error('[fetch-e2e-corpus]', ...m);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function ghHeaders() {
  const h = { Accept: 'application/vnd.github+json', 'User-Agent': 'vviewer-e2e-corpus' };
  if (process.env.GITHUB_TOKEN) h.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  return h;
}

/** git blob sha1（与 trees API 清单的 sha 比对，校验下载内容未损坏） */
function gitBlobSha(buf) {
  return createHash('sha1').update(`blob ${buf.length}\0`).update(buf).digest('hex');
}

const sha256 = (data) => createHash('sha256').update(data).digest('hex');

/** 下载单个 raw 文件：非 2xx 或 HTML 错误页均按失败，共尝试 MAX_ATTEMPTS 次（线性退避） */
async function fetchRaw(path) {
  // 逐段编码：防路径中 '#'/空格等改变 URL 语义（Markpad 路径均为 ASCII，防御性处理）
  const url = RAW_BASE + path.split('/').map(encodeURIComponent).join('/');
  let lastErr;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    if (attempt > 1) await sleep(300 * attempt);
    try {
      const res = await fetch(url, { headers: ghHeaders() });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.subarray(0, 14).toString('latin1').toLowerCase() === '<!doctype html') {
        throw new Error('返回 HTML 错误页（疑似拦截/限流页）');
      }
      return buf;
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr;
}

/** 路径必须可安全映射进语料目录内（trees API 正常返回相对路径，防御异常值越界写） */
function safeSegments(path) {
  const segs = path.split('/');
  if (path.startsWith('/') || segs.some((s) => s === '' || s === '.' || s === '..')) return null;
  return segs;
}

async function main() {
  // 1. 列 markdown 清单
  let tree;
  try {
    const res = await fetch(TREE_API, { headers: ghHeaders() });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    tree = await res.json();
  } catch (e) {
    err(`trees API 拉取失败：${e.message}`);
    process.exitCode = 1;
    return;
  }
  if (tree.truncated) {
    err('trees API 返回 truncated=true（清单不完整），拒绝继续');
    process.exitCode = 1;
    return;
  }
  const mdFiles = tree.tree.filter((e) => e.type === 'blob' && /\.(md|markdown)$/.test(e.path));
  if (mdFiles.length === 0) {
    err('清单中无 markdown 文件，中止');
    process.exitCode = 1;
    return;
  }
  const totalKb = (mdFiles.reduce((n, e) => n + e.size, 0) / 1024).toFixed(1);
  log(`清单：${mdFiles.length} 个 markdown，共 ${totalKb} KB`);

  // 2. 逐个落位（幂等：已存在且 size 与清单一致则跳过）
  const files = [];
  const failures = [];
  let downloaded = 0;
  let skipped = 0;
  for (const entry of mdFiles) {
    const segs = safeSegments(entry.path);
    if (!segs) {
      failures.push({ path: entry.path, error: '非法路径' });
      continue;
    }
    const dest = join(corpusDir, ...segs);
    if (existsSync(dest) && statSync(dest).size === entry.size) {
      skipped++;
      files.push({ path: entry.path, size: entry.size, sha256: sha256(readFileSync(dest)), gitSha: entry.sha });
      log(`skipped: ${entry.path}（size 一致）`);
      continue;
    }
    try {
      const buf = await fetchRaw(entry.path);
      const gitSha = gitBlobSha(buf);
      if (entry.sha && gitSha !== entry.sha) {
        throw new Error(`git blob sha 不一致（期望 ${entry.sha.slice(0, 8)}…，实得 ${gitSha.slice(0, 8)}…）`);
      }
      mkdirSync(dirname(dest), { recursive: true });
      writeFileSync(dest, buf);
      downloaded++;
      files.push({ path: entry.path, size: buf.length, sha256: sha256(buf), gitSha });
      log(`downloaded: ${entry.path}（${buf.length} bytes）`);
    } catch (e) {
      failures.push({ path: entry.path, error: String(e.message || e) });
      err(`失败（${MAX_ATTEMPTS} 次尝试后）：${entry.path} — ${e.message}`);
    }
  }

  // 3. manifest（与语料同目录，随目录一并 gitignore）
  const manifest = {
    source: `${REPO}@${REF}`,
    fetchedAt: new Date().toISOString(),
    counts: { total: mdFiles.length, downloaded, skipped, failed: failures.length },
    failures,
    files
  };
  mkdirSync(corpusDir, { recursive: true });
  const manifestPath = join(corpusDir, 'manifest.json');
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');

  // 4. 汇总与退出码：仅清单失败/清单为空（上方已退）/全部文件失败 → 非 0；
  //    部分失败 → 失败清单写入 manifest.failures 并告警，不阻断（缺个别语料由 e2e 用例自身暴露）
  log(`完成：共 ${mdFiles.length}（下载 ${downloaded}，幂等跳过 ${skipped}，失败 ${failures.length}）；manifest → ${manifestPath}`);
  if (failures.length > 0) {
    err(`${failures.length} 个文件失败（已记入 manifest.failures）：`);
    for (const f of failures) err(`  - ${f.path}: ${f.error}`);
  }
  if (downloaded + skipped === 0) {
    err('全部文件下载失败，语料不可用');
    process.exitCode = 1;
  }
}

await main();
