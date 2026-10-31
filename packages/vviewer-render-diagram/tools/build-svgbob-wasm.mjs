// tools/build-svgbob-wasm.mjs — svgbob wasm 引擎产物构建（spec §7）：svgbob 0.7.6
// 编译到 wasm32-unknown-unknown，经 wasm-bindgen 产出 JS glue + wasm 到
// packages/vviewer-render-diagram/src/markdown/svgbob-wasm-gen/（js/wasm 不入库，构建期生成；
// svgbob_wasm.d.ts 手写入库，仅类型声明）。要点：①wasm-bindgen CLI 供给与版本硬校验
// （runner 不预装 CLI；三级供给：PATH → 自供给缓存 → 官方 release 预编译二进制下载，
// 镜像 grammar 工具链 binaryen 的「预编译 + ~/.cache 缓存」形态；glue 与 wasm 内
// runtime 必须严格同版，错配在运行时才炸，构建期拦住）；②cargo release 构建
// （opt-level=s + lto）；③wasm-opt 有则 -Oz 无则 warn 跳过（CI 沿 setup-grammars
// 已缓存的 binaryen ~/.cache/tree-sitter/binaryen），优化结果直出中转目录不回写
// target/（fingerprint 管辖产物）；④bindgen --target web；⑤打印产物体积。gen 目录
// js/wasm 先清后写防陈旧混排。bindgen 不直接 --out-dir 到 gen：其生成的 .d.ts 与
// 手写入库版签名不同，会覆盖入库文件，故经 crate 内 out/ 中转只拷 js/wasm。
// 无第三方依赖；在仓库根运行（CI 与本地一致）。
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// 仓库根相对路径（脚本在仓库根运行：根 package.json gen:svgbob-wasm 与 CI 调用一致）
const CRATE = 'packages/vviewer-render-diagram/tools/svgbob-wasm';
const GEN = 'packages/vviewer-render-diagram/src/markdown/svgbob-wasm-gen';
const TARGET_WASM = join(CRATE, 'target/wasm32-unknown-unknown/release/svgbob_wasm.wasm');
const OPT_WASM = join(CRATE, 'out/optimized/svgbob_wasm.wasm');
// bindgen 中转目录（crate 内 .gitignore 排除）：全量输出留这里，gen 只取 js/wasm
const BINDGEN_OUT = join(CRATE, 'out/bindgen');
// wasm-bindgen CLI 自供给缓存（CI 由 actions/cache 承载该路径，键按 Cargo.toml 失效）
const CLI_CACHE = join(homedir(), '.cache/svgbob/wasm-bindgen-cli');
const ARTIFACTS = ['svgbob_wasm.js', 'svgbob_wasm_bg.wasm'];

const fail = (msg) => {
  console.error(`build-svgbob-wasm: ${msg}`);
  process.exit(1);
};
const run = (cmd, args, opts = {}) => {
  console.log(`+ ${[cmd, ...args].join(' ')}`);
  execFileSync(cmd, args, { stdio: 'inherit', ...opts });
};

// ① 版本一致性校验：Cargo.toml 声明的 wasm-bindgen 版本与 CLI 实装必须同版
const manifest = readFileSync(join(CRATE, 'Cargo.toml'), 'utf8');
const depMatch = manifest.match(/^wasm-bindgen\s*=\s*["']([^"']+)["']/m);
if (!depMatch) fail(`${CRATE}/Cargo.toml 未找到 wasm-bindgen 依赖声明`);
const depVer = depMatch[1].replace(/^[\^~=]+\s*/, '');

const probeVersion = (cmd) => {
  try {
    return execFileSync(cmd, ['--version'], { encoding: 'utf8' }).trim().split(/\s+/).pop();
  } catch {
    return null;
  }
};
const resolveBindgenCli = () => {
  // 1) PATH（本地已装场景优先）
  let ver = probeVersion('wasm-bindgen');
  if (ver) return { cmd: 'wasm-bindgen', ver };
  // 2) 自供给缓存（此前下载产物）
  const cached = join(CLI_CACHE, 'wasm-bindgen');
  ver = probeVersion(cached);
  if (ver) return { cmd: cached, ver };
  // 3) 自供给：官方 release 预编译二进制（linux x64；免 cargo install 的 2-4 分钟
  //    每跑重编译）。非 linux x64 平台请自装 CLI
  if (process.platform !== 'linux' || process.arch !== 'x64') {
    fail(`未找到 wasm-bindgen CLI——请 cargo install wasm-bindgen-cli --version ${depVer}`);
  }
  console.log(`+ 自供给 wasm-bindgen CLI（官方 release 预编译二进制 → ${CLI_CACHE}）`);
  mkdirSync(CLI_CACHE, { recursive: true });
  const url = `https://github.com/rustwasm/wasm-bindgen/releases/download/${depVer}/wasm-bindgen-${depVer}-x86_64-unknown-linux-musl.tar.gz`;
  const tarball = join(CLI_CACHE, 'wasm-bindgen-cli.tar.gz');
  run('curl', ['-fsSL', url, '-o', tarball]);
  run('tar', ['xzf', tarball, '-C', CLI_CACHE, '--strip-components=1']);
  ver = probeVersion(cached);
  if (!ver) fail(`自供给的 wasm-bindgen 不可执行——检查 ${CLI_CACHE}（删除该目录重跑可触发重新下载）`);
  return { cmd: cached, ver };
};
const bindgenCli = resolveBindgenCli();
if (bindgenCli.ver !== depVer) {
  fail(`wasm-bindgen 版本不一致：Cargo.toml 声明 ${depVer}，CLI（${bindgenCli.cmd}）为 ${bindgenCli.ver}——glue 与 wasm runtime 错配会在运行时才炸，请统一到 ${depVer}（自供给缓存可整目录删除重跑）`);
}

// ② cargo release 构建（wasm32 target 缺失时 cargo 自身报错并提示 rustup target add）
run('cargo', ['build', '--target', 'wasm32-unknown-unknown', '--release'], { cwd: CRATE });
if (!existsSync(TARGET_WASM)) fail(`cargo 构建完成但产物缺失：${TARGET_WASM}`);

// ③ wasm-opt -Oz（可选）：PATH 优先，回落 setup-grammars 缓存的 binaryen；缺则 warn 跳过。
//    优化结果直出中转目录（out/），不回写 target/——那是 cargo fingerprint 管辖产物
const findWasmOpt = () => {
  for (const p of ['wasm-opt', join(homedir(), '.cache/tree-sitter/binaryen/bin/wasm-opt')]) {
    try {
      execFileSync(p, ['--version'], { stdio: 'ignore' });
      return p;
    } catch {
      /* 下一个候选 */
    }
  }
  return null;
};
const wasmOpt = findWasmOpt();
let bindgenInput = TARGET_WASM;
if (wasmOpt) {
  // 文件名与 target 产物同名：bindgen 输出文件名跟随输入 stem，异名会产出 *_opt_* 前缀
  mkdirSync(join(CRATE, 'out/optimized'), { recursive: true });
  run(wasmOpt, ['-Oz', TARGET_WASM, '-o', OPT_WASM]);
  bindgenInput = OPT_WASM;
} else {
  console.warn('build-svgbob-wasm: wasm-opt 不可用（PATH 与 ~/.cache/tree-sitter/binaryen/bin 均无）——跳过优化，体积偏大但正确性不受影响');
}

// ④ wasm-bindgen --target web（经中转目录，不覆盖 gen 里手写入库的 d.ts）
rmSync(BINDGEN_OUT, { recursive: true, force: true });
mkdirSync(BINDGEN_OUT, { recursive: true });
run(bindgenCli.cmd, ['--target', 'web', '--out-dir', BINDGEN_OUT, bindgenInput]);

// gen 目录先清后写（只清本构建器的 js/wasm 产物，不动手写入库的 svgbob_wasm.d.ts）
mkdirSync(GEN, { recursive: true });
for (const f of readdirSync(GEN)) {
  if (/\.(js|wasm)$/.test(f)) rmSync(join(GEN, f));
}
for (const f of ARTIFACTS) {
  if (!existsSync(join(BINDGEN_OUT, f))) fail(`bindgen 输出缺失 ${f}（--target web 预期产出 ${ARTIFACTS.join(' + ')}）`);
  copyFileSync(join(BINDGEN_OUT, f), join(GEN, f));
}
if (!existsSync(join(GEN, 'svgbob_wasm.d.ts'))) {
  fail(`${GEN}/svgbob_wasm.d.ts 缺失——手写类型声明入库文件被误删，请从 git 恢复`);
}

// ⑤ 产物体积
const kb = (n) => (n / 1024).toFixed(1);
console.log('build-svgbob-wasm: 产物就绪');
for (const f of ARTIFACTS) {
  console.log(`  ${GEN}/${f}: ${kb(statSync(join(GEN, f)).size)} KB`);
}
