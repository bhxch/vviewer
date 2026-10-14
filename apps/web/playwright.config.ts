import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  // 本地 8 核机器 3 worker 并发平衡时长与资源竞争（实测一轮 35s ↔ 3.1m）；CI runner
  // 仅 2-4 核且共享给 vite preview + 多浏览器实例，3 worker 争抢使流式计量/扫描进度
  // 类时序断言系统性漂红（2026-10-14 CI 首跑 28 failed，2 核受限本地复现同病）——
  // CI 收敛单 worker：页面前后台节流与 CPU 争抢面消除，时长换确定性
  workers: process.env.CI ? 1 : 3,
  // 共享机器存在外部负载波动（实测一轮总时长 35s ↔ 3.1m），瞬态失败重试一次
  retries: 1,
  use: { baseURL: 'http://127.0.0.1:4173' },
  webServer: {
    command: 'pnpm vite preview --host 127.0.0.1 --port 4173 --strictPort',
    url: 'http://127.0.0.1:4173',
    reuseExistingServer: !process.env.CI
  },
  projects: [
    { name: 'chromium', use: { browserName: 'chromium' } },
    {
      // M7 Task 4：移动视口冒烟（375×667 + 触摸 + Pixel 7 UA）。
      // 既有 m1-m7 spec 也在该 project 下跑：≤900px 断点下文件树/右栏收进抽屉，
      // spec 内树行点击经 e2e/drawer.ts 的 openDrawerIfNarrow 适配
      name: 'mobile',
      use: {
        browserName: 'chromium',
        viewport: { width: 375, height: 667 },
        hasTouch: true,
        deviceScaleFactor: 2,
        userAgent:
          'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36'
      }
    }
  ]
});
