import { defineConfig } from '@playwright/test';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 服务端模式 e2e 专用配置（与 playwright.config.ts 互不影响）：
 * - testDir 独立为 ./e2e-server；
 * - webServer 直接启动 release 二进制（server/target/release/vviewer serve），
 *   同源伺服 web-dist 与夹具目录（区别于既有 e2e 的 vite preview :4173 +
 *   spec 内 spawn 跨源 server :8399，见 e2e/m5.spec.ts 注释）；
 * - 前置 fixtures.mjs 生成夹具并预检二进制/构建产物，`exec` 让 shell 进程
 *   被服务器二进制替换——Playwright 停止 webServer 时按该 PID 发 SIGTERM，
 *   不会遗留孤儿 server 占住端口（参照 serverHarness.stopServer 的教训）；
 * - 端口 4174 与既有 4173/8399/8449 错开；readiness 用免鉴权 /api/health
 *   （server/src/routes/health.rs），比根路径更能区分「vviewer 已就绪」与
 *   「残留进程占口」。
 */
const configDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(configDir, '../..');
const PORT = 4174;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const BIN = join(repoRoot, 'server/target/release/vviewer');
const WEB_DIST = join(repoRoot, 'apps/web/build');
const FIXTURE = process.env.VV_E2E_SERVER_FIXTURE ?? join(repoRoot, '.temp/e2e-server-fixture');

export default defineConfig({
  testDir: './e2e-server',
  // 单 worker：全组共用一个 server 实例与夹具目录，避免并发 fs 变更互扰
  workers: 1,
  // 共享机器外部负载波动，瞬态失败重试一次（与 playwright.config.ts 同口径）
  retries: 1,
  use: { baseURL: BASE_URL },
  webServer: {
    command: `node ${join(configDir, 'e2e-server/fixtures.mjs')} && exec ${BIN} serve --root ${FIXTURE} --web-dist ${WEB_DIST} --port ${PORT}`,
    url: `${BASE_URL}/api/health`,
    reuseExistingServer: !process.env.CI,
    timeout: 30_000
  },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }]
});
