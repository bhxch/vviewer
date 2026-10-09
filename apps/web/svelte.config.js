import adapter from '@sveltejs/adapter-static';

// 子路径托管（GitHub Pages 项目站点 /<repo>/ 等）：VV_BASE_PATH 注入（如 /vviewer）。
// 默认空 = 根路径，本地 dev/e2e/自建服务器部署行为不变。同名变量供 vite.config.ts
// 的 PWA manifest（start_url/scope）取用，两处必须取同一值。
const base = process.env.VV_BASE_PATH ?? '';

export default {
  kit: {
    adapter: adapter({ fallback: 'index.html' }),
    paths: { base },
    alias: { '@vviewer/core': '../../packages/core/src/index.ts' }
  }
};
