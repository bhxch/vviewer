import adapter from '@sveltejs/adapter-static';
export default {
  kit: {
    adapter: adapter({ fallback: 'index.html' }),
    alias: { '@vviewer/core': '../../packages/core/src/index.ts' }
  }
};
