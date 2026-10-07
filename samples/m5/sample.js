// M5 样例：配合 `pnpm server:dev`（serve --root samples/m5）在浏览器连接
// http://127.0.0.1:8321 验证 RemoteStore / SSE 变更推送 / X-VV 检测头。
function fib(n) {
  return n < 2 ? n : fib(n - 1) + fib(n - 2);
}
console.log(fib(10));
