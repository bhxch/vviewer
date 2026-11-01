<script lang="ts">
  // GitSection.svelte — 右面板 Git 段（git 信息面板 spec §3/§4）：T2 信息卡 +
  // T3 blame 说明行 / diff 折叠区 / 文件历史 log 列表。
  //
  // 数据链：激活时 ensureGitClient（worker 单例，isogit chunk 首次激活即拉）→
  // bindFs 登记 repoDir→store 供数 → 并发拉 probeHead（分支）/ lastCommit（末次
  // 提交）/ store.read（工作区原始字节）→ statusOf（worker 内 hashBlob(工作区字节)
  // vs HEAD blob oid——原始字节通道，CRLF/BOM 原样入 hash 不误报，spec 红线）。
  // HEAD 树无此路径 → lastCommit null + status 'untracked'（worker 分流口径，
  // T1 已验通）。T3 增量：fileLog（≤50，eager）/ blobAt（diff 两侧字节，主线程
  // unifiedDiff 归一渲染）/ 逐提交 diff（log 条目展开时复用同一通道）。
  //
  // filepath 口径（T2 报告 Interfaces 节）：isogit 树内寻址 = repoRelPath 剥
  // repoDir 前缀（gitUi.ts 单源）；工作区字节 = store.read store 寻址——两轨分立。
  //
  // 状态机：loading → ready | error。error 可重试（重试钮重跑 load）；请求级错误
  // 收敛各自子状态（diffState/logState/commitDiffs），不掀整卡。取消：load 级
  // AbortController + runSeq 代数守卫；diff/log/详情各持独立 AC 与代数，互不
  // 误伤（展开 diff 时拉 log 不互相打断）。
  import type { TreeStore } from '@bhxch/vviewer-core';
  import { ensureGitClient, type GitCommitInfo, type GitStatus } from './git/gitClient';
  import { LOG_MAX_ENTRIES, normalizeBlobText, splitLines, unifiedDiff } from './git/gitDiff';
  import { calendarTime, relativeDate, repoRelPath, subjectOf } from './git/gitUi';
  import GitDiffView, { type GitDiffUiState } from './GitDiffView.svelte';

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

  /** log 列表子状态（eager 拉取，错误不掀信息卡）。 */
  type LogPhase =
    | { s: 'loading' }
    | { s: 'error'; message: string }
    | { s: 'ready'; entries: GitCommitInfo[]; truncated: boolean };

  let phase = $state<Phase>({ s: 'loading' });
  let logPhase = $state<LogPhase>({ s: 'loading' });

  // ---------- T3 子状态：diff 折叠区 / log 条目展开 ----------
  /** diff 折叠默认收起（spec §4），展开即拉；跨文件切换保持开合台账、数据重拉 */
  let diffOpen = $state(false);
  let diffState = $state<GitDiffUiState>({ s: 'idle' });
  /** 展开的 log 条目（单开互斥）；该提交该文件 diff 按下标缓存 */
  let expandedLog = $state<number | null>(null);
  let commitDiffs = $state<Record<number, GitDiffUiState>>({});

  const STATUS_LABELS: Record<GitStatus, string> = {
    clean: '无改动',
    modified: '已修改',
    untracked: '未跟踪'
  };

  /** diff 折叠钮模式标注（spec §3.3 规则的 UI 面）：未跟踪提示 / 工作区 vs HEAD /
   *  HEAD vs HEAD^（含状态不可用但有历史的回落）。 */
  const diffLabel = $derived.by(() => {
    if (phase.s !== 'ready') return '';
    if (phase.commit === null) return '（未跟踪文件无 diff）';
    return phase.status === 'modified' ? '（工作区 vs HEAD）' : '（末次提交 HEAD^ vs HEAD）';
  });

  /** 迟到上行守卫：effect 重拉/手动重试/卸载都推进代数，旧 load 的回包不再写
   *  phase；inFlight 是上一轮的段级 AbortController（重拉时先断旧请求——worker
   *  侧在途 fs 链随即 unwind，gitClient 取消语义）。 */
  let runSeq = 0;
  let inFlight: AbortController | null = null;
  // T3 子拉取的独立取消面：各自 AC + 代数（load 重拉统一作废，互不误伤）
  let diffSeq = 0;
  let diffAC: AbortController | null = null;
  let logSeq = 0;
  let logAC: AbortController | null = null;
  let detailRun = 0; // 条目 diff 借 runSeq 判代（量级小，不设独立 AC）
  /** 工作区原始字节暂存（load 读得后供 diff modified 模式复用；store 寻址原始通道） */
  let workBytes: Uint8Array | null = null;

  function errMsg(e: unknown): string {
    return e instanceof Error ? e.message : String(e);
  }

  /** 经参数读取（绕开 TS 对组件作用域 let 的闭包收窄——cleanup 处被误窄为 null）。 */
  function abortAC(ac: AbortController | null): void {
    ac?.abort();
  }

  async function load(rd: string, fd: string, st: TreeStore, fp: string): Promise<void> {
    inFlight?.abort();
    diffSeq++; // 作废在途 diff/log/详情（其 AC 随下方各自 abort）
    logSeq++;
    detailRun = runSeq + 1; // 借「未来代」使旧 detail 回包必 stale
    diffAC?.abort();
    logAC?.abort();
    const my = ++runSeq;
    const ac = new AbortController();
    inFlight = ac;
    const { signal } = ac;
    const stale = (): boolean => my !== runSeq || signal.aborted;
    phase = { s: 'loading' };
    logPhase = { s: 'loading' };
    diffState = { s: 'idle' };
    expandedLog = null;
    commitDiffs = {};
    workBytes = null;
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
      phase = { s: 'error', message: errMsg(e) };
      return;
    }
    // probe 命中后登记 repoDir → store 的 fs 供数（同 repoDir 换源以最新 store 为
    // 准——bindFs 内部换源强制重建 adapter）
    client.bindFs(rd, st);
    // 仓库相对路径（isogit 树内寻址口径）：log/blobAt/blame 的 filepath 经 isogit
    // 直接在树内查址——不经 fs 反向通道，GitFsAdapter 的 repoDir 前缀映射管不
    // 到它（gitUi.repoRelPath 单源，T2 实证 bug 的防回归锚）。
    const relPath = repoRelPath(rd, fp);
    try {
      // 并发三路：分支 / 末次提交 / 工作区原始字节（原始通道全量——渲染归一文本
      // 不回读，CRLF 红线由字节直读保证）。字节读失败（文件已被删等）→ status
      // 无法比对，状态行降级显示「不可用」而非误报三态之一。
      const [head, last, work] = await Promise.all([
        client.probeHead(rd, fd, signal),
        client.lastCommit(rd, relPath, signal),
        st.read(fp).catch(() => null)
      ]);
      let status: GitStatus | null = null;
      if (work !== null) {
        status = (await client.statusOf(rd, relPath, work, signal)).status;
      }
      if (stale()) return;
      workBytes = work; // diff modified 模式的 worktree 侧（原始字节，显示层再归一）
      phase = {
        s: 'ready',
        branch: head.ok ? (head.branch ?? null) : null,
        headOk: head.ok,
        commit: last.commit,
        status
      };
      // 文件历史 eager 拉取（spec §4 布局固定段；≤50 条有界）；diff 折叠若开着
      //（跨文件台账）随新文件重拉
      void loadLog(client, rd, relPath, signal);
      if (diffOpen) void loadDiff(client, rd, relPath);
    } catch (e) {
      if (stale()) return;
      phase = { s: 'error', message: errMsg(e) };
    }
  }

  /** 重试钮（错误态）：重跑 load——ensureGitClient 单例已被 failWorker/创建失败
   *  路径剔除，重试即重建 worker + 重新拉 isogit chunk（可重试语义）。 */
  function retry(): void {
    void load(repoDir, fileDir, store, filePath);
  }

  // ---------- diff 折叠区（spec §3.3：未提交 → 工作区 vs HEAD；clean → HEAD vs
  // HEAD^；untracked → 提示态。两侧字节归一后 unifiedDiff——显示层归一一致，与
  // 状态判定的原始字节 hash 通道分轨，见 gitDiff.ts 头注释） ----------

  function toggleDiff(): void {
    diffOpen = !diffOpen;
    if (diffOpen && diffState.s === 'idle') void startDiff();
  }

  function startDiff(): Promise<void> {
    const ensure = ensureGitClient();
    if (ensure === null) {
      diffState = { s: 'error', message: 'git 客户端不可用' };
      return Promise.resolve();
    }
    return ensure.then(
      (client) => loadDiff(client, repoDir, repoRelPath(repoDir, filePath)),
      (e: unknown) => {
        diffState = { s: 'error', message: errMsg(e) };
      }
    );
  }

  async function loadDiff(
    client: Awaited<NonNullable<ReturnType<typeof ensureGitClient>>>,
    rd: string,
    relPath: string
  ): Promise<void> {
    const my = ++diffSeq;
    const stale = (): boolean => my !== diffSeq;
    const ac = new AbortController();
    diffAC = ac;
    const commit = phase.s === 'ready' ? phase.commit : null;
    if (commit === null) {
      diffState = { s: 'empty', note: '未跟踪文件无 diff（HEAD 树无此路径）' };
      return;
    }
    if (phase.s === 'ready' && phase.status === 'modified' && workBytes !== null) {
      diffState = { s: 'loading' };
      try {
        const head = await client.blobAt(rd, 'HEAD', relPath, ac.signal);
        if (stale()) return;
        if (head === null) {
          diffState = { s: 'empty', note: 'HEAD 树无此路径' };
          return;
        }
        diffState = {
          s: 'ready',
          diff: unifiedDiff(
            splitLines(normalizeBlobText(head.bytes)),
            splitLines(normalizeBlobText(workBytes))
          )
        };
      } catch (e) {
        if (!stale()) diffState = { s: 'error', message: errMsg(e) };
      }
      return;
    }
    // clean（或工作区字节不可用但有末次提交的回落）：HEAD vs HEAD^——末次提交
    // 的改动；HEAD^ 无此路径（根提交/文件由末次提交新增）→ 空基线（全 +）
    diffState = { s: 'loading' };
    try {
      const [parent, head] = await Promise.all([
        client.blobAt(rd, 'HEAD^', relPath, ac.signal),
        client.blobAt(rd, 'HEAD', relPath, ac.signal)
      ]);
      if (stale()) return;
      if (head === null) {
        diffState = { s: 'empty', note: 'HEAD 树无此路径' };
        return;
      }
      diffState = {
        s: 'ready',
        diff: unifiedDiff(
          splitLines(parent === null ? '' : normalizeBlobText(parent.bytes)),
          splitLines(normalizeBlobText(head.bytes))
        )
      };
    } catch (e) {
      if (!stale()) diffState = { s: 'error', message: errMsg(e) };
    }
  }

  // ---------- 文件历史 log（spec §3.4：≤50 条；点击展开详情 + 逐提交 diff） ----------

  async function loadLog(
    client: Awaited<NonNullable<ReturnType<typeof ensureGitClient>>>,
    rd: string,
    relPath: string,
    signal: AbortSignal
  ): Promise<void> {
    const my = ++logSeq;
    const stale = (): boolean => my !== logSeq || signal.aborted;
    try {
      const res = await client.fileLog(rd, relPath, LOG_MAX_ENTRIES, signal);
      if (stale()) return;
      logPhase = { s: 'ready', entries: res.entries, truncated: res.truncated };
    } catch (e) {
      if (!stale()) logPhase = { s: 'error', message: errMsg(e) };
    }
  }

  function toggleLogItem(i: number): void {
    if (expandedLog === i) {
      expandedLog = null;
      return;
    }
    expandedLog = i;
    if (commitDiffs[i] === undefined) void loadCommitDiff(i);
  }

  /** 该提交该文件的 diff（复用 diff 通道）：目标侧恒为该提交 oid 的 blob；基线侧
   *  = 文件历史上前一状态（log filepath 过滤保证相邻条目即此文件的前一变更点），
   *  首条目无前条 → oid^（git 首父；无父/该时点无文件 → 空基线全 +）。 */
  async function loadCommitDiff(i: number): Promise<void> {
    if (logPhase.s !== 'ready') return;
    const entry = logPhase.entries[i];
    if (entry === undefined) return;
    const baseRef = i + 1 < logPhase.entries.length ? logPhase.entries[i + 1]!.oid : `${entry.oid}^`;
    const rd = repoDir;
    const relPath = repoRelPath(repoDir, filePath);
    const my = ++detailRun;
    commitDiffs = { ...commitDiffs, [i]: { s: 'loading' } };
    const ensure = ensureGitClient();
    if (ensure === null) {
      commitDiffs = { ...commitDiffs, [i]: { s: 'error', message: 'git 客户端不可用' } };
      return;
    }
    try {
      const client = await ensure;
      const [base, target] = await Promise.all([
        client.blobAt(rd, baseRef, relPath),
        client.blobAt(rd, entry.oid, relPath)
      ]);
      if (my !== detailRun) return;
      if (target === null) {
        commitDiffs = { ...commitDiffs, [i]: { s: 'empty', note: '该提交树内无此文件' } };
        return;
      }
      commitDiffs = {
        ...commitDiffs,
        [i]: {
          s: 'ready',
          diff: unifiedDiff(
            splitLines(base === null ? '' : normalizeBlobText(base.bytes)),
            splitLines(normalizeBlobText(target.bytes))
          )
        }
      };
    } catch (e) {
      if (my === detailRun) commitDiffs = { ...commitDiffs, [i]: { s: 'error', message: errMsg(e) } };
    }
  }

  // props 任一变化（组件被复用于不同 tab 的窗口期）即重拉；cleanup（props 切换或
  // 组件卸载同径）abort 全部在途 + 推进代数使迟到上行失效。读 props 进局部量再传
  // load：effect 依赖收集显式化，load 体内不触响应式面。
  $effect(() => {
    const rd = repoDir;
    const fd = fileDir;
    const st = store;
    const fp = filePath;
    void load(rd, fd, st, fp);
    return () => {
      runSeq++;
      diffSeq++;
      logSeq++;
      inFlight?.abort();
      abortAC(diffAC);
      abortAC(logAC);
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
        <div class="vv-git-row"><dt>说明</dt><dd>{subjectOf(phase.commit.message)}</dd></div>
      {:else}
        <div class="vv-git-row"><dt>末次提交</dt><dd>无（未跟踪文件）</dd></div>
      {/if}
    </dl>
    {#if phase.commit !== null}
      <!-- blame 说明行（spec §4）：hover 即查提示 + 200 截断标注（仅对有历史的文件） -->
      <p class="vv-git-note vv-git-blame-hint">悬停代码行可查看提交归属；文件历史超 200 提交仅最近 200 参与归属。</p>
    {/if}
    <!-- diff 折叠区（spec §3.3）：默认收起，展开即拉；模式标注随状态三态 -->
    <div class="vv-git-fold">
      <button type="button" class="vv-git-fold-btn" aria-expanded={diffOpen} onclick={toggleDiff}>
        <span class="vv-git-fold-caret" aria-hidden="true">{diffOpen ? '▾' : '▸'}</span>差异{diffLabel}
      </button>
      {#if diffOpen}
        <div class="vv-git-fold-body">
          <GitDiffView state={diffState} />
        </div>
      {/if}
    </div>
    <!-- 文件历史（spec §3.4）：≤50 条列表；点击条目展开完整详情 + 逐提交 diff -->
    <div class="vv-git-log">
      <h3 class="vv-git-log-title">文件历史</h3>
      {#if logPhase.s === 'loading'}
        <p class="vv-git-note">正在加载历史…</p>
      {:else if logPhase.s === 'error'}
        <p class="vv-git-error">{logPhase.message}</p>
      {:else if logPhase.entries.length === 0}
        <p class="vv-git-note">无历史（未跟踪文件）</p>
      {:else}
        <ul class="vv-git-log-list">
          {#each logPhase.entries as entry, i (entry.oid)}
            <li class="vv-git-log-item">
              <button type="button" class="vv-git-log-btn" aria-expanded={expandedLog === i} onclick={() => toggleLogItem(i)}>
                <span class="vv-git-mono">{entry.oid.slice(0, 7)}</span>
                <span class="vv-git-log-author">{entry.author}</span>
                <span class="vv-git-log-date">{relativeDate(entry.timestamp)}</span>
                <span class="vv-git-log-subject">{subjectOf(entry.message)}</span>
              </button>
              {#if expandedLog === i}
                <dl class="vv-git-list vv-git-log-detail">
                  <div class="vv-git-row"><dt>hash</dt><dd class="vv-git-mono">{entry.oid}</dd></div>
                  <div class="vv-git-row"><dt>作者</dt><dd>{entry.author}（{calendarTime(entry.timestamp)}）</dd></div>
                  <div class="vv-git-row"><dt>提交者</dt><dd>{entry.committer ?? entry.author}（{calendarTime(entry.committerTimestamp ?? entry.timestamp)}）</dd></div>
                  <div class="vv-git-row"><dt>说明</dt><dd class="vv-git-log-msg">{entry.message}</dd></div>
                </dl>
                <div class="vv-git-log-diff">
                  <GitDiffView state={commitDiffs[i] ?? { s: 'idle' }} />
                </div>
              {/if}
            </li>
          {/each}
        </ul>
        {#if logPhase.truncated}
          <p class="vv-git-note">仅显示最近 {LOG_MAX_ENTRIES} 条</p>
        {/if}
      {/if}
    </div>
  {/if}
</section>
