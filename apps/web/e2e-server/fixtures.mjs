// 服务端模式 e2e 夹具生成器（playwright.server.config.ts 的 webServer 前置步骤）：
// 幂等地生成 fixture 目录与样例文件，并预检 release 二进制存在（缺失时 fail-fast
// 带明确指引，而不是等 vviewer serve 启动报 "is not a directory"/file not found）。
// 写法参考既有 fixtures：samples/m1/generate.mjs（1x1 png base64 入库）+
// e2e/m5.spec.ts（fixture 放 gitignored 目录，不污染 tracked 工作树）。
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const binPath = `${repoRoot}/server/target/release/vviewer`;
// 固定路径（非每次临时目录）：reuseExistingServer 复用已运行 server 时，
// webServer.command 不再执行，夹具必须常驻才能与复用实例一致
const outDir = process.env.VV_E2E_SERVER_FIXTURE ?? `${repoRoot}/.temp/e2e-server-fixture`;

if (!existsSync(binPath)) {
  console.error(
    `[e2e-server fixtures] release 二进制不存在: ${binPath}\n` +
      `请先执行: cargo build --release --manifest-path ${repoRoot}/server/Cargo.toml`
  );
  process.exit(1);
}
if (!existsSync(`${repoRoot}/apps/web/build/index.html`)) {
  console.error(
    `[e2e-server fixtures] 前端构建产物不存在: ${repoRoot}/apps/web/build\n` +
      `请先执行: pnpm --filter web build`
  );
  process.exit(1);
}

// 样例文件：hello.js（代码高亮）/ notes.md（Markdown）/ pixel.png（1x1 图片，
// 与 samples/m1/generate.mjs 同源 base64）/ sub/data.txt（子目录树 + 搜索素材）
mkdirSync(`${outDir}/sub`, { recursive: true });

writeFileSync(
  `${outDir}/hello.js`,
  `// e2e-server fixture sample
export function greet(name) {
  const msg = \`hello, \${name}\`;
  console.log(msg);
  return msg;
}

greet('vviewer');
`
);

writeFileSync(
  `${outDir}/notes.md`,
  `# e2e-server 夹具笔记

## 要点

- 服务端模式冒烟样例
- 用于 Markdown 渲染与文件内搜索

\`\`\`js
greet('from markdown');
\`\`\`
`
);

writeFileSync(
  `${outDir}/pixel.png`,
  Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64'
  )
);

writeFileSync(
  `${outDir}/sub/data.txt`,
  `alpha bravo charlie
delta echo foxtrot
needle in subdir
`
);

console.log(`[e2e-server fixtures] ready: ${outDir}`);
