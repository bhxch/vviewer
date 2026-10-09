#!/usr/bin/env node
// grammar 许可证聚合：从源树收集 LICENSE/COPYING 与 package.json.license，
// 产出 server/GRAMMAR_LICENSES.md（随二进制分发，满足 MIT/Apache 等条款的
// 许可文本随附义务；spec §2.2）。需先 --fetch 全量源树。
// 用法：node tools/grammar-builder/gen-licenses.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const sources = process.env.VV_GRAMMAR_SOURCES ?? path.join(here, 'out/grammars');
const manifest = JSON.parse(fs.readFileSync(path.join(here, '../../server/grammars-manifest.json'), 'utf8'));

function firstLicenseFile(dir) {
    for (const f of fs.readdirSync(dir)) {
        // 简报正则漏配 COPYING.*（clojure/janet-simple 为 COPYING.txt/CC0），补上
        if (/^(LICENSE|COPYING|COPYING\..*|LICENSE\..*|LICENSE-.*)$/i.test(f)) return path.join(dir, f);
    }
    // SPDX 风格 LICENSES/<SPDX-ID>.txt（nim、slint）
    const licensesDir = path.join(dir, 'LICENSES');
    if (fs.existsSync(licensesDir)) {
        for (const f of fs.readdirSync(licensesDir)) {
            if (/\.txt$/i.test(f)) return path.join(licensesDir, f);
        }
    }
    return null;
}

const rows = [];
for (const g of manifest.grammars) {
    const dir = path.join(sources, g.dir);
    if (!fs.existsSync(dir)) { rows.push({ name: g.name, license: '(源未取)', file: '' }); continue; }
    const lic = firstLicenseFile(dir);
    const pkg = path.join(dir, g.subpath, 'package.json');
    let declared = '';
    try { declared = JSON.parse(fs.readFileSync(pkg, 'utf8')).license ?? ''; } catch { /* 无 package.json */ }
    rows.push({ name: g.name, license: declared || (lic ? '见文件' : '未找到'), file: lic ? path.relative(path.join(here, '../..'), lic) : '' });
}

const body = [
    '# Grammar Licenses',
    '',
    'vviewer 服务端二进制静态链接了以下 tree-sitter grammar（源码按 pinned rev 编译）。',
    '各 grammar 的许可证文本见其源仓 LICENSE 文件（路径相对仓库根；完整文本随',
    '`tools/grammar-builder/out/grammars/` 源树分发于构建环境）。',
    '',
    '| grammar | declared license | license file |',
    '| --- | --- | --- |',
    ...rows.map((r) => `| ${r.name} | ${r.license} | ${r.file} |`),
    '',
].join('\n');
fs.writeFileSync(path.join(here, '../../server/GRAMMAR_LICENSES.md'), body);
console.log(`[gen-licenses] ${rows.length} entries -> server/GRAMMAR_LICENSES.md`);
