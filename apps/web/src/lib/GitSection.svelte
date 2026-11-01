<script lang="ts">
  // GitSection.svelte — 右面板 Git 段基础信息卡（git 信息面板 spec §3.1，实施计划
  // Task 2）：分支 / 状态三态徽标 / 末次提交（短 hash/作者/相对日期/subject）。
  //
  // 数据链：激活时 ensureGitClient（worker 单例，isogit chunk 首次激活即拉）→
  // bindFs 登记 repoDir→store 供数 → 并发拉 probeHead（分支）/ lastCommit（末次
  // 提交）/ store.read（工作区原始字节）→ statusOf（worker 内 hashBlob(工作区字节)
  // vs HEAD blob oid——原始字节通道，CRLF/BOM 原样入 hash 不误报，spec 红线）。
  // HEAD 树无此路径 → lastCommit null + status 'untracked'（worker 分流口径，
  // T1 已验通）。
  //
  // 状态机：loading → ready | error。error 可重试（重试钮重跑 load）——worker 致命
  // 失败由 GitClient failWorker 剔除单例、ensureGitClient 创建失败不缓存 rejected
  // promise，重试即重建新 worker（chunk 拉取失败可重试语义，gitClient.ts 头注释）；
  // 请求级错误（iso 拉取失败 error 帧等）同样收敛错误态。取消：段级
  // AbortController——props 变化重拉/组件卸载时 abort 在途请求（迟到上行由
  // runSeq 代数守卫双保险丢弃）。
  import type { TreeStore } from '@bhxch/vviewer-core';
  import { ensureGitClient, type GitCommitInfo, type GitStatus } from './git/gitClient';

  let {
    repoDir,
    fileDir,
    store,
    filePath
  }: {
    /** 仓库根的 store 相对路径（probe 上行，GitFsAdapter 前缀映射消费） */
    repoDir: string;
    /** 文件目录前缀（probeHead 的探测基点） */
    fileDir: string;
    /** 文件来源 store（bindFs 登记 + 工作区原始字节读取） */
    store: TreeStore;
    /** 当前文件的 store 相对路径（lastCommit/statusOf 的 filepath） */
    filePath: string;
  } = $props();

  type Phase =
    | { s: 'loading' }
    | { s: 'error'; message: string }
    | {
        s: 'ready';
        branch: string | null;
        /** probeHead ok:false（HEAD 悬挂/仓库半损坏）→ 信息卡降级显示 */
        headOk: boolean;
        commit: GitCommitInfo | null;
        /** null = 工作区字节读失败（文件被删等），状态行降级「不可用」不误报三态 */
        status: GitStatus | null;
      };

  let phase = $state<Phase>({ s: 'loading' });

  const STATUS_LABELS: Record<GitStatus, string> = {
    clean: '无改动',
    modified: '已修改',
    untracked: '未跟踪'
  };

  /** 相对日期（spec §3.1「短 hash/作者/相对日期/subject」；超月回落日历日期）。 */
  function relativeDate(ts: number): string {
    const diff = Date.now() / 1000 - ts;
    if (diff < 60) return '刚刚';
    if (diff < 3600) return `${Math.floor(diff / 60)} 分钟前`;
    if (diff < 86400) return `${Math.floor(diff / 3600)} 小时前`;
    if (diff < 86400 * 30) return `${Math.floor(diff / 86400)} 天前`;
    return new Date(ts * 1000).toLocaleDateString();
  }

  /** 迟到上行守卫：effect 重拉/手动重试/卸载都推进代数，旧 load 的回包不再写
   *  phase；inFlight 是上一轮的段级 AbortController（重拉时先断旧请求——worker
   *  侧在途 fs 链随即 unwind，gitClient 取消语义）。 */
  let runSeq = 0;
  let inFlight: AbortController | null = null;

  async function load(rd: string, fd: string, st: TreeStore, fp: string): Promise<void> {
    inFlight?.abort();
    const my = ++runSeq;
    const ac = new AbortController();
    inFlight = ac;
    const { signal } = ac;
    const stale = (): boolean => my !== runSeq || signal.aborted;
    phase = { s: 'loading' };
    const ensure = ensureGitClient();
    if (ensure === null) {
      phase = { s: 'error', message: 'git 客户端不可用（非浏览器环境）' };
      return;
    }
    let client: Awaited<NonNullable<ReturnType<typeof ensureGitClient>>>;
    try {
      client = await ensure;
    } catch (e) {
      if (stale()) return;
      phase = { s: 'error', message: e instanceof Error ? e.message : String(e) };
      return;
    }
    // probe 命中后登记 repoDir → store 的 fs 供数（同 repoDir 换源以最新 store 为
    // 准——bindFs 内部换源强制重建 adapter）
    client.bindFs(rd, st);
    // 仓库相对路径（isogit 树内寻址口径）：lastCommit/statusOf 的 filepath 经 isogit
    // 直接在 HEAD 树内查址——不经 fs 反向通道，GitFsAdapter 的 repoDir 前缀映射管不
    // 到它，必须由调用方剥掉 store 前缀。剥前缀差了一致性就会出现「树内查无此路径」
    // 的 clean 误报 untracked（e2e GIT-01/02 首跑实证：T1 集成测试全用 repoDir=''
    // （仓库在 store 根）形态，store 路径与树内路径重合掩盖了前缀差）。
    const relPath = rd === '' ? fp : fp.startsWith(`${rd}/`) ? fp.slice(rd.length + 1) : fp;
    try {
      // 并发三路：分支 / 末次提交 / 工作区原始字节（原始通道全量——渲染归一文本
      // 不回读，CRLF 红线由字节直读保证）。字节读失败（文件已被删等）→ status
      // 无法比对，状态行降级显示「不可用」而非误报三态之一。
      const [head, last, workBytes] = await Promise.all([
        client.probeHead(rd, fd, signal),
        client.lastCommit(rd, relPath, signal),
        st.read(fp).catch(() => null)
      ]);
      let status: GitStatus | null = null;
      if (workBytes !== null) {
        status = (await client.statusOf(rd, relPath, workBytes, signal)).status;
      }
      if (stale()) return;
      phase = {
        s: 'ready',
        branch: head.ok ? (head.branch ?? null) : null,
        headOk: head.ok,
        commit: last.commit,
        status
      };
    } catch (e) {
      if (stale()) return;
      phase = { s: 'error', message: e instanceof Error ? e.message : String(e) };
    }
  }

  /** 重试钮（错误态）：重跑 load——ensureGitClient 单例已被 failWorker/创建失败
   *  路径剔除，重试即重建 worker + 重新拉 isogit chunk（可重试语义）。 */
  function retry(): void {
    void load(repoDir, fileDir, store, filePath);
  }

  // props 任一变化（组件被复用于不同 tab 的窗口期）即重拉；cleanup abort 在途 +
  // 推进代数使迟到上行失效。读 props 进局部量再传 load：effect 依赖收集显式化，
  // load 体内不触响应式面。
  $effect(() => {
    const rd = repoDir;
    const fd = fileDir;
    const st = store;
    const fp = filePath;
    void load(rd, fd, st, fp);
    return () => {
      runSeq++;
      inFlight?.abort();
    };
  });
</script>

<section class="vv-git" aria-label="Git 信息">
  <h2 class="vv-git-title">Git</h2>
  {#if phase.s === 'loading'}
    <p class="vv-git-note">正在读取 git 信息…</p>
  {:else if phase.s === 'error'}
    <p class="vv-git-error">{phase.message}</p>
    <button type="button" class="vv-git-retry" onclick={retry}>重试</button>
  {:else}
    <dl class="vv-git-list">
      <div class="vv-git-row">
        <dt>分支</dt>
        <dd>{phase.headOk ? (phase.branch ?? '（游离 HEAD）') : '不可用'}</dd>
      </div>
      <div class="vv-git-row">
        <dt>状态</dt>
        <dd>
          {#if phase.status !== null}<span class="vv-git-dot vv-git-dot-{phase.status}" aria-hidden="true"></span>{STATUS_LABELS[phase.status]}{:else}不可用{/if}
        </dd>
      </div>
      {#if phase.commit}
        <div class="vv-git-row"><dt>末次提交</dt><dd class="vv-git-mono">{phase.commit.oid.slice(0, 7)}</dd></div>
        <div class="vv-git-row"><dt>作者</dt><dd>{phase.commit.author}</dd></div>
        <div class="vv-git-row"><dt>时间</dt><dd>{relativeDate(phase.commit.timestamp)}</dd></div>
        <div class="vv-git-row"><dt>说明</dt><dd>{phase.commit.message.split('\n', 1)[0]}</dd></div>
      {:else}
        <div class="vv-git-row"><dt>末次提交</dt><dd>无（未跟踪文件）</dd></div>
      {/if}
    </dl>
  {/if}
</section>
