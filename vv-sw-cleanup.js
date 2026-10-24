// 构建期生成（vite.config.ts genSwCleanup）：BUILD_REVISION=0.1.0-hsgbe，勿手改。
// BUG-60：activate 清理非当前修订号的 vv-* 运行时缓存（cleanupOutdatedCaches 仅清
// workbox-precache-* 前缀；cacheName 拼 BUILD_REVISION 的运行时缓存换版后永久残留、
// 随部署次数线性累积——本脚本随部署换版携带新 REV，旧 REV 缓存清理一次到位）。
self.addEventListener('activate', (event) => {
  const current = ["vv-grammars-0.1.0-hsgbe","vv-runtime-0.1.0-hsgbe","vv-queries-0.1.0-hsgbe","vv-diagram-svgbob-0.1.0-hsgbe","vv-cdn-engines-0.1.0-hsgbe"];
  event.waitUntil(
    (async () => {
      try {
        const names = await self.caches.keys();
        await Promise.all(
          names
            .filter((n) => /^(vv-grammars|vv-runtime|vv-queries|vv-diagram-svgbob|vv-cdn-engines)-/.test(n) && !current.includes(n))
            .map((n) => self.caches.delete(n))
        );
      } catch {
        // 清理失败不阻塞激活：纯存储卫生，非功能路径
      }
    })()
  );
});
