import { execSync, spawn, type ChildProcess } from 'node:child_process';

/**
 * m5/m6 spec 共享的 server 生命周期 harness（终审批次 C 抽取）：
 * - cargo build（增量）+ spawn 预编译二进制 + /api/health 轮询就绪；
 * - 端口占用预检：spawn 前 health 已有响应即 fail-fast（遗留进程占口的报错
 *   原来表现为 spawn 后 os error 98 bind 失败，信息晦涩）；
 * - 停止：SIGTERM 宽限 5s 后 SIGKILL 兜底（终审 M2/M5：某些挂起态下 SIGTERM
 *   不达，遗留进程会占住端口毒化下一轮 E2E）。
 */

export interface ServerOptions {
  repoRoot: string;
  binPath: string;
  root: string;
  webDist: string;
  port: number;
  token: string;
  corsOrigin: string;
  compute?: boolean;
  /** 日志前缀（m5/m6） */
  tag: string;
}

export async function waitHealthy(url: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${url}/api/health`);
      if (res.ok) return;
    } catch {
      // 尚未就绪：继续轮询
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`vviewer server 未在 ${timeoutMs}ms 内就绪: ${url}`);
}

/** 端口占用预检：health 有任何响应（含非 200）即判定被占用，fail-fast 带明确信息。 */
export async function assertPortFree(url: string): Promise<void> {
  try {
    const res = await fetch(`${url}/api/health`);
    throw new Error(
      `端口预检失败：${url} 已有服务响应（HTTP ${res.status}）。` +
        `上一轮 E2E 的 vviewer 进程可能未退出并占用该端口，请清理遗留进程后重试` +
        `（lsof -i :${new URL(url).port}）。`
    );
  } catch (err) {
    // 我们自己抛的占用错误原样上抛；fetch 网络错误 = 无监听 = 端口空闲
    if (err instanceof Error && err.message.startsWith('端口预检失败')) throw err;
  }
}

/** 编译并启动 server（root 由调用方指向临时 fixture 目录） */
export function startVviewerServer(opts: ServerOptions): ChildProcess {
  execSync('cargo build --manifest-path server/Cargo.toml', { cwd: opts.repoRoot, stdio: 'inherit' });
  const server = spawn(
    opts.binPath,
    [
      'serve',
      '--root', opts.root,
      '--web-dist', opts.webDist,
      '--port', String(opts.port),
      '--token', opts.token,
      '--cors-origin', opts.corsOrigin,
      ...(opts.compute ? ['--compute'] : [])
    ],
    { stdio: 'inherit' }
  );
  server.on('exit', (code) => {
    if (code !== null && code !== 0) console.error(`[${opts.tag}] server 提前退出: code=${code}`);
  });
  return server;
}

/** 停止 server：SIGTERM 宽限 5s，仍存活则 SIGKILL 兜底并等待退出。 */
export async function stopServer(server: ChildProcess | null, tag: string): Promise<void> {
  if (server === null || server.exitCode !== null) return;
  const exited = new Promise<void>((resolve) => server.once('exit', () => resolve()));
  server.kill('SIGTERM');
  const exitedGracefully = await Promise.race([
    exited.then(() => true),
    new Promise<boolean>((r) => setTimeout(() => r(false), 5_000))
  ]);
  if (!exitedGracefully && server.exitCode === null) {
    console.error(`[${tag}] SIGTERM 5s 未退出，升级 SIGKILL`);
    server.kill('SIGKILL');
    await exited; // SIGKILL 必达，等待回收避免僵尸进程
  }
}
