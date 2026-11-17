#!/usr/bin/env node
// tools/e2e-list-guard.mjs — e2e 用例清单基线与守恒校验（spec G §5「用例守恒」锚的自动化）。
//
// 背景：spec G §5 的验收锚是「用例守恒：总 passed+skipped 数与单 job 基线一致」，
// 但分片实施后该锚无任何自动检查可依——plan 的诚实边界把「CI 侧用例守恒复核」整体
// 标为「待 push 后验证」，而本仓不 push，锚长期悬空。分片拓扑又天然放大「守恒」风险：
// spec 文件在**模块求值期**缺生成物/缺资产表即整文件用例 error（不是断言红），
// 分母从 1768 塌到几百，人工从 CI 日志回查成本极高。
//
// 本工具把守恒锚变成两道可执行的门：
//   ① baseline：e2e-prep 侧采集全量 `--list` 与四分片 `--list` 计数，断言
//      Σ(分片) == 全量（同 HEAD 的守恒恒等式），落 list-baseline.json 随 artifact 下发；
//   ② check：每个分片 runner 侧再采一次 `--list --shard=X/4` 计数，与基线中该分片
//      的期望值逐项比对——`--list` 会**加载全部 spec 文件**，故任一 spec 模块加载失败
//      （缺 generated-extensions.ts / themes.json 等生成物）在此步即确定性报错，
//      把「190 个用例集体 error」这类回归挡在用例执行之前。
//
// 用法：
//   node tools/e2e-list-guard.mjs baseline <listDir>
//   node tools/e2e-list-guard.mjs check <listFile> <baselineFile> <shard>   # shard 形如 1/4
import fs from 'node:fs';
import path from 'node:path';

export const SHARD_COUNT = 4;

/** 从 playwright --list 输出解析 { tests, files }；缺「Total:」行即视为加载失败 */
export function parseListOutput(text) {
  const m = /^Total:\s+(\d+)\s+tests?\s+in\s+(\d+)\s+files?\s*$/m.exec(text);
  if (!m) return null;
  return { tests: Number(m[1]), files: Number(m[2]) };
}

/** 归一分片标识（'1/4' → '1'） */
export function normalizeShard(shard) {
  const m = /^(\d+)\s*\/\s*(\d+)$/.exec(String(shard).trim());
  if (!m) return String(shard).trim();
  if (Number(m[2]) !== SHARD_COUNT) {
    throw new Error(`分片分母非 ${SHARD_COUNT}：${shard}`);
  }
  return m[1];
}

function readList(file) {
  if (!fs.existsSync(file)) {
    throw new Error(`清单文件缺失：${file}（playwright --list 未产出——spec 加载期失败即无输出）`);
  }
  const parsed = parseListOutput(fs.readFileSync(file, 'utf8'));
  if (!parsed) {
    throw new Error(`清单文件无「Total: N tests in M files」行：${file}（spec 模块加载失败即此形态）`);
  }
  return parsed;
}

function baseline(argv) {
  const dir = argv[0];
  if (!dir) throw new Error('用法：e2e-list-guard.mjs baseline <listDir>');
  const full = readList(path.join(dir, 'list-full.txt'));
  const shards = {};
  let sum = 0;
  for (let i = 1; i <= SHARD_COUNT; i += 1) {
    const s = readList(path.join(dir, `list-shard-${i}.txt`));
    shards[String(i)] = s;
    sum += s.tests;
  }
  if (sum !== full.tests) {
    throw new Error(
      `用例守恒失败：Σ(四分片)=${sum} ≠ 全量=${full.tests}（分片分配面漂移）`
    );
  }
  const out = { shardCount: SHARD_COUNT, total: full, shards };
  const outFile = path.join(dir, 'list-baseline.json');
  fs.writeFileSync(outFile, `${JSON.stringify(out, null, 2)}\n`);
  console.log(
    `[e2e-list-guard] 基线：全量 ${full.tests} 用例 / ${full.files} 文件；` +
      `四分片 ${Object.values(shards).map((s) => s.tests).join(' + ')} = ${sum}（守恒成立）`
  );
  console.log(`[e2e-list-guard] 基线文件：${outFile}`);
  return 0;
}

function check(argv) {
  const [listFile, baselineFile, shard] = argv;
  if (!listFile || !baselineFile || !shard) {
    throw new Error('用法：e2e-list-guard.mjs check <listFile> <baselineFile> <shard>');
  }
  const key = normalizeShard(shard);
  const actual = readList(listFile);
  const base = JSON.parse(fs.readFileSync(baselineFile, 'utf8'));
  const expected = base.shards?.[key];
  if (!expected) {
    throw new Error(`基线缺分片 ${key} 的期望计数（baseline 文件异常：${baselineFile}）`);
  }
  if (actual.tests !== expected.tests || actual.files !== expected.files) {
    throw new Error(
      `分片 ${shard} 用例清单漂移：实采 ${actual.tests} 用例 / ${actual.files} 文件 ≠ ` +
        `基线 ${expected.tests} 用例 / ${expected.files} 文件` +
        '（spec 集合或模块加载面变化——生成物/资产表缺失即此形态）'
    );
  }
  console.log(
    `[e2e-list-guard] 分片 ${shard} 清单对齐基线：${actual.tests} 用例 / ${actual.files} 文件`
  );
  return 0;
}

function main(argv) {
  const [cmd, ...rest] = argv;
  try {
    if (cmd === 'baseline') return baseline(rest);
    if (cmd === 'check') return check(rest);
    console.error('用法：e2e-list-guard.mjs baseline <listDir> | check <listFile> <baselineFile> <shard>');
    return 2;
  } catch (err) {
    console.error(`[e2e-list-guard] ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}

process.exitCode = main(process.argv.slice(2));
