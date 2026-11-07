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
  use: {
    baseURL: 'http://127.0.0.1:4173',
    // CI 失败用例留 trace（网络面板/DOM 快照——真实 fetch 时序缺陷的远程取证面，
    // ci.yml 失败步上传 artifact；本地不落盘，避免拖慢）
    trace: process.env.CI ? 'retain-on-failure' : undefined
  },
  webServer: {
    // 残余 A10 处置备案（2026-11-07）：「vite preview 本地 3-worker 间歇 SSR 500」
    // 前提已被 ci-stabilize-report.md §一 证伪——heading "500" 快照实为 SvelteKit
    // 客户端错误边界就地换页（each_key_duplicate prod 恒抛，c065b35 修复），失败瞬间
    // 网络面板全 200（trace 实证），preview 服务侧零 500 响应；且 run 42340634377
    // （663fc3a）CI workers=1 全绿、本地 CI=true 等效验证绿。换静态伺服面（sirv/
    // node 脚本）的收益前提不成立，而伺服语义（SPA fallback/MIME/缓存头/Range）与
    // 1228 e2e 锚的等价性需全量重验——维持 vite preview 不换面；若未来再现「网络层
    // 5xx」实据（非客户端错误边界同形标记），再评估换面并双验。
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
