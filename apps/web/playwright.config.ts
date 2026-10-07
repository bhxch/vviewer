import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  // 8 核机器默认 4 worker，双 project 并发跑 tree-sitter wasm 用例 CPU 已饱和；
  // 收敛到 3 降低资源竞争引发的瞬态超时（总时长影响 ~秒级）
  workers: 3,
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
      // spec 内树行点击经 e2e/mobile-helpers.ts 的 openDrawerIfNarrow 适配
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
