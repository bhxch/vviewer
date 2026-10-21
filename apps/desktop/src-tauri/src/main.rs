//! VViewer 桌面薄壳入口（Tauri 2）。
//!
//! 薄壳纪律（plan 2026-10-19 Global Constraints）：无 IPC/无原生菜单/无托盘/
//! 无自动更新。职责仅四件：
//!
//! 1. spawn server sidecar（`serve --port 0 --web-dist <resource> --root <home>`，
//!    绑 127.0.0.1、无 token）；
//! 2. 15s 内逐行解析 stdout 就绪行 `VV_READY port=<n>`（协议见 [`ready`]）；
//! 3. 就绪 → 主窗导航 `http://127.0.0.1:<n>/`；失败/运行中退出 → 原生错误窗
//!    （含 stderr 摘要与「重启服务」按钮）；
//! 4. 退出回收子进程；单实例（二次启动唤起既有窗口）。
//!
//! 前端零内嵌：`build.frontendDist` 省略（codegen 空 assets），页面由 sidecar
//! 以 `--web-dist` 伺服，窗口直接外链 localhost——无 tauri:// 面，无 IPC 面。

mod ready;

use std::io::Read;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tauri::path::BaseDirectory;
use tauri::{AppHandle, Manager, RunEvent, Url, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

use ready::{spawn_stdout_reader, wait_for_ready, ReadyEvent, WaitFailure, READY_TIMEOUT};

/// 主窗口标签（single-instance 唤起与重启复用按标签寻窗）。
const MAIN_WINDOW_LABEL: &str = "main";

/// stderr 摘要保留的尾部字节数（错误窗文案引用）。
const STDERR_TAIL_LIMIT: usize = 2000;

/// 就绪后子进程存活监视的轮询间隔。
const EXIT_POLL_INTERVAL: Duration = Duration::from_millis(500);

/// 壳托管的 server 子进程态（`app.manage` 托管，经 `AppHandle` 跨线程取用）。
///
/// `generation` 为重启代际：每次 spawn 递增，旧存活监视线程发现代际不符即退场，
/// 防止崩溃→重启循环里叠加多个监视线程重复弹窗。
struct ServerState {
    child: Mutex<Option<Child>>,
    generation: AtomicU64,
    stderr_tail: Arc<Mutex<String>>,
}

/// 启动失败的分类（错误窗文案来源）。
enum LaunchFailure {
    /// sidecar / web-dist / 浏览根解析落空。
    Resolve(String),
    /// spawn 系统调用本身失败（可执行文件不可执行等）。
    Spawn(String),
    /// 15s 未捕获就绪行（已 kill 挂起子进程）。
    Timeout,
    /// server 先于就绪行退出（stdout EOF）。
    Exited,
}

impl LaunchFailure {
    fn describe(&self) -> String {
        match self {
            Self::Resolve(msg) => format!("组件缺失：{msg}"),
            Self::Spawn(msg) => format!("无法启动服务进程：{msg}"),
            Self::Timeout => "等待服务就绪超时（15 秒）未捕获 VV_READY 行。".into(),
            Self::Exited => "服务进程在就绪前退出。".into(),
        }
    }
}

/// dialog 插件注册单点：main 的 Builder 链与 C1 契约测试同源调用此函数。
///
/// 契约：**必须注册**——[`DialogExt`] 的取态入口（`.dialog()`）内部是
/// `state::<Dialog<R>>()`，未注册即 panic；届时 bootstrap 的三条错误窗路径
/// （启动失败 / 运行中崩溃 / 主窗创建失败）将全部随之崩溃，错误兜底整体失效。
fn dialog_plugin<R: tauri::Runtime>() -> tauri::plugin::TauriPlugin<R> {
    tauri_plugin_dialog::init()
}

fn main() {
    let app = tauri::Builder::default()
        // single-instance 必须首个注册（插件要求）：二次启动参数转投既有实例，
        // 本回调在既有实例内触发——唤起主窗
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            if let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL) {
                let _ = window.show();
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }))
        .plugin(dialog_plugin())
        .setup(|app| {
            app.manage(ServerState {
                child: Mutex::new(None),
                generation: AtomicU64::new(0),
                stderr_tail: Arc::new(Mutex::new(String::new())),
            });
            // 首次启动编排：setup 已在事件循环建立之后、run 泵事件之前——同步
            // spawn+等待就绪（典型 <1s，上限 15s；此时尚无窗口可画，阻塞无碍），
            // 主窗创建保持主线程（macOS 约束）。失败路径的错误窗经插件
            // run_on_main_thread 分派，事件循环泵起后呈现。
            bootstrap(app.handle());
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("Tauri 应用构建失败（tauri.conf.json 结构或图标缺失）");

    app.run(|app, event| {
        // 应用退出（窗口关闭 / 错误窗「退出」）：回收 server 子进程
        if let RunEvent::Exit = event {
            kill_server(&app.state::<ServerState>());
        }
    });
}

/// 启动编排：成功建/导主窗；失败弹「重启服务/退出」错误窗，选重启则回环重试。
fn bootstrap(app: &AppHandle) {
    match start_and_wait(app) {
        Ok(port) => show_or_navigate(app, port),
        Err(failure) => ask_restart_or_exit(app, failure),
    }
}

/// spawn sidecar 并等待就绪行；成功返回实测端口。
fn start_and_wait(app: &AppHandle) -> Result<u16, LaunchFailure> {
    let state = app.state::<ServerState>();
    // 重启形态：先回收旧子进程；代际 +1 使旧存活监视线程退场
    kill_server(&state);
    state.generation.fetch_add(1, Ordering::SeqCst);
    let generation = state.generation.load(Ordering::SeqCst);

    let sidecar = resolve_sidecar().map_err(LaunchFailure::Resolve)?;
    let web_dist = resolve_web_dist(app).map_err(LaunchFailure::Resolve)?;
    // 浏览根：家目录（本地查看器的入口根；目录浏览经前端 UI 完成）
    let root = default_root().ok_or_else(|| {
        LaunchFailure::Resolve("未找到用户家目录（HOME/USERPROFILE），无法确定浏览根".into())
    })?;

    let mut child = Command::new(&sidecar)
        .arg("serve")
        .arg("--port")
        .arg("0")
        .arg("--web-dist")
        .arg(&web_dist)
        .arg("--root")
        .arg(&root)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| LaunchFailure::Spawn(format!("{}：{e}", sidecar.display())))?;

    // stderr 摘要收集（尾部环形，供错误窗引用）
    let stderr_tail = state.stderr_tail.clone();
    *stderr_tail.lock().unwrap() = String::new();
    if let Some(stderr) = child.stderr.take() {
        std::thread::spawn(move || collect_stderr(stderr, stderr_tail));
    }

    let (tx, rx) = std::sync::mpsc::channel();
    match child.stdout.take() {
        Some(stdout) => spawn_stdout_reader(std::io::BufReader::new(stdout), tx),
        None => {
            // stdout 不可捕获（不应发生）：直接按退出路径走
            let _ = tx.send(ReadyEvent::Ended);
        }
    }
    *state.child.lock().unwrap() = Some(child);

    match wait_for_ready(&rx, READY_TIMEOUT) {
        Ok(port) => {
            spawn_exit_monitor(app.clone(), generation);
            Ok(port)
        }
        Err(WaitFailure::Timeout) => {
            // 挂起子进程（可能仍在启动）——kill 后报超时
            kill_server(&state);
            Err(LaunchFailure::Timeout)
        }
        Err(WaitFailure::Ended) => Err(LaunchFailure::Exited),
    }
}

/// 建（首次）或导（重启）主窗到实测端口。
fn show_or_navigate(app: &AppHandle, port: u16) {
    let url = Url::parse(&format!("http://127.0.0.1:{port}/"))
        .expect("静态 URL 模板必为合法 URL");
    match app.get_webview_window(MAIN_WINDOW_LABEL) {
        Some(window) => {
            if window.navigate(url).is_err() {
                // 导航失败（理论不应发生）：销毁重建兜底
                let _ = window.destroy();
                build_main_window(app, port);
            } else {
                let _ = window.show();
                let _ = window.set_focus();
            }
        }
        None => build_main_window(app, port),
    }
}

fn build_main_window(app: &AppHandle, port: u16) {
    let url = Url::parse(&format!("http://127.0.0.1:{port}/"))
        .expect("静态 URL 模板必为合法 URL");
    if let Err(e) = WebviewWindowBuilder::new(app, MAIN_WINDOW_LABEL, WebviewUrl::External(url))
        .title("VViewer")
        .inner_size(1280.0, 800.0)
        .min_inner_size(640.0, 480.0)
        .build()
    {
        // 窗口创建失败：错误窗兜底（重启/退出）
        ask_restart_or_exit(app, LaunchFailure::Spawn(format!("创建主窗口失败：{e}")));
    }
}

/// 错误窗（原生 dialog）：含失败描述 + stderr 摘要，按钮「重启服务/退出」。
///
/// 非阻塞 `.show()`：回调在插件分派线程触发——重启经 `run_on_main_thread` 回
/// 主线程编排（窗口创建的 macOS 约束）；退出 `app.exit(1)`（触发 RunEvent::Exit
/// 回收子进程）。窗体不提前关闭——「关闭末窗即退出」默认语义会抢在用户选择前
/// 杀掉应用，重启时经 [`show_or_navigate`] 原窗导航。
fn ask_restart_or_exit(app: &AppHandle, failure: LaunchFailure) {
    let state = app.state::<ServerState>();
    let mut body = failure.describe();
    match failure {
        LaunchFailure::Timeout | LaunchFailure::Exited => {
            body.push_str("\n\n");
            body.push_str(&stderr_summary(&state));
        }
        _ => {}
    }
    let handle = app.clone();
    app.dialog()
        .message(body)
        .title("VViewer 启动失败")
        .kind(MessageDialogKind::Error)
        .buttons(MessageDialogButtons::OkCancelCustom(
            "重启服务".into(),
            "退出".into(),
        ))
        .show(move |restart| {
            if restart {
                let h = handle.clone();
                let h2 = h.clone();
                let _ = h.run_on_main_thread(move || bootstrap(&h2));
            } else {
                handle.exit(1);
            }
        });
}

/// 起子进程存活监视线程：运行中退出 → 错误窗（重启/退出）。代际不符即退场。
fn spawn_exit_monitor(app: AppHandle, generation: u64) {
    std::thread::spawn(move || loop {
        std::thread::sleep(EXIT_POLL_INTERVAL);
        let state = app.state::<ServerState>();
        if state.generation.load(Ordering::SeqCst) != generation {
            // 已重启：新监视接管，本线程退场
            return;
        }
        let mut guard = state.child.lock().unwrap();
        let Some(child) = guard.as_mut() else {
            // 子进程已被回收（应用退出路径）
            return;
        };
        match child.try_wait() {
            Ok(Some(status)) => {
                guard.take();
                drop(guard);
                ask_restart_or_exit(
                    &app,
                    LaunchFailure::Exited,
                );
                let _ = status; // stderr 摘要比退出码更有诊断价值，文案见 describe
            }
            Ok(None) => {}
            Err(_) => {
                // 2-2：try_wait Err 形态也须 reap（guard.take() 裸丢弃在部分平台
                // 留僵尸——与 kill_server 同纪律 kill+wait；kill 幂等可失败）
                if let Some(mut child) = guard.take() {
                    let _ = child.kill();
                    let _ = child.wait();
                }
                drop(guard);
                ask_restart_or_exit(&app, LaunchFailure::Exited);
            }
        }
    });
}

/// 回收子进程（kill + wait 防僵尸）。幂等：child 槽位 take 后为 None。
fn kill_server(state: &ServerState) {
    if let Some(mut child) = state.child.lock().unwrap().take() {
        let _ = child.kill();
        let _ = child.wait();
    }
}

/// stderr 尾部摘要（错误窗文案）。
fn stderr_summary(state: &ServerState) -> String {
    let tail = state.stderr_tail.lock().unwrap();
    if tail.trim().is_empty() {
        "（server 无 stderr 输出）".into()
    } else {
        format!("—— server stderr 尾部 ——\n{}", tail.trim_end())
    }
}

/// stderr 收集线程：追加进环形尾部（保留最后 [`STDERR_TAIL_LIMIT`] 字节）。
/// 2-3：不完整 UTF-8 尾字节能跨读保留（向后找块内最后边界，剩余 ≤3 字节
/// 留待下块；EOF 时剩余 lossy 兜底）——逐块 lossy 会把被读边界撕开的
/// 多字节字符变成 U+FFFD 观感噪声。
fn collect_stderr<R: Read>(mut reader: R, tail: Arc<Mutex<String>>) {
    let mut buf = [0u8; 512];
    let mut pending: Vec<u8> = Vec::new();
    loop {
        match reader.read(&mut buf) {
            Ok(0) | Err(_) => {
                let mut t = tail.lock().unwrap();
                t.push_str(&String::from_utf8_lossy(&pending));
                trim_tail(&mut t);
                return;
            }
            Ok(n) => {
                pending.extend_from_slice(&buf[..n]);
                // 块内最后一个 UTF-8 边界：尾部最多 3 字节可能是被切开的多字节
                // 序列前缀；超过 3 字节仍无边界即非法序列，整块 lossy 兜底
                let mut split = pending.len();
                let limit = split.saturating_sub(3);
                while split > limit && !is_char_boundary(&pending, split) {
                    split -= 1;
                }
                let flushed = String::from_utf8_lossy(&pending[..split]).into_owned();
                pending.drain(..split);
                let mut t = tail.lock().unwrap();
                t.push_str(&flushed);
                trim_tail(&mut t);
            }
        }
    }
}

/// 环形尾部裁剪（UTF-8 字符边界对齐；从 collect_stderr 各刷写点共用）。
fn trim_tail(t: &mut String) {
    let len = t.len();
    if len > STDERR_TAIL_LIMIT {
        let cut = len - STDERR_TAIL_LIMIT;
        let cut = (cut..len).find(|&i| t.is_char_boundary(i)).unwrap_or(len);
        t.drain(..cut);
    }
}

/// 字节序列的 UTF-8 边界判定（std 无 `[u8]::is_char_boundary`，手写等价）：
/// index 处非续字节（0b10xxxxxx）即边界；index == len 时须整段为合法 UTF-8
/// 才算边界——尾部不完整前缀（被读边界撕开的多字节序列）不算，留待下块。
fn is_char_boundary(bytes: &[u8], index: usize) -> bool {
    match bytes.get(index) {
        Some(&b) => (b & 0xC0) != 0x80,
        None => std::str::from_utf8(bytes).is_ok(),
    }
}

/// sidecar 路径解析（候选序见 binaries/README.md）。
fn resolve_sidecar() -> Result<PathBuf, String> {
    let triple = env!("VV_TARGET_TRIPLE");
    // Windows 可执行名必须带 .exe（externalBin 落盘与探测两态一致），
    // 其余平台无扩展名
    let ext = if cfg!(windows) { ".exe" } else { "" };
    let with_triple = format!("vviewer-server-{triple}{ext}");
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            // 手动布局兜底（bundler 对 externalBin 实际保留 triple 命名 + 平台
            // 扩展名——即候选②；本裸名 bundler 不产出，仅为手动拷贝形态容错）
            candidates.push(dir.join(format!("vviewer-server{ext}")));
            // release：externalBin 打包落盘形态（triple 命名保留，置于主程序同目录）
            candidates.push(dir.join(&with_triple));
        }
    }
    // dev（tauri dev / cargo run）：src-tauri/binaries/<name>-<triple>[.exe]
    let dev = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("binaries")
        .join(&with_triple);
    candidates.push(dev.clone());
    candidates
        .iter()
        .find(|p| p.is_file())
        .cloned()
        .ok_or_else(|| {
            format!(
                "server sidecar（vviewer-server）不存在，已尝试：{}。本地开发请先 \
                 `cargo build --release --manifest-path server/Cargo.toml` 并复制为 \
                 binaries/vviewer-server-<target-triple>（Windows 追加 .exe，见 \
                 binaries/README.md）",
                candidates
                    .iter()
                    .map(|p| p.display().to_string())
                    .collect::<Vec<_>>()
                    .join("；")
            )
        })
}

/// 前端构建产物路径解析（兼容 dev/release 两形态，候选序即优先级）。
fn resolve_web_dist(app: &AppHandle) -> Result<PathBuf, String> {
    // 1) 显式覆盖：VV_WEB_DIST（本地手动形态）
    if let Some(p) = std::env::var_os("VV_WEB_DIST") {
        let p = PathBuf::from(p);
        if p.is_dir() {
            return Ok(p);
        }
    }
    // 2) release：resources 打包 `../../web/build/` → $RESOURCE/_up_/_up_/web/build
    //    （官方净化规则：相对路径中的 `..` 落盘为 `_up_`，目录结构保留）
    let bundled = app
        .path()
        .resolve("_up_/_up_/web/build", BaseDirectory::Resource);
    if let Ok(p) = bundled {
        if p.is_dir() {
            return Ok(p);
        }
    }
    // 3) dev / 源码树直跑：编译期锚定仓库内 apps/web/build
    let dev = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../web/build");
    if dev.is_dir() {
        return Ok(dev);
    }
    Err("前端构建产物 apps/web/build 不存在（先 `pnpm --filter web build`；\
         或以 VV_WEB_DIST 环境变量指定）"
        .into())
}

/// 浏览根：家目录（HOME / USERPROFILE）。
fn default_root() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
        .filter(|p| p.is_dir())
}

#[cfg(test)]
mod tests {
    use std::io::Read;
    use std::sync::{Arc, Mutex};

    use super::collect_stderr;
    use super::dialog_plugin;
    use tauri_plugin_dialog::DialogExt;

    /// C1 契约锚：dialog 插件经同一 `init::<R>()`（[`dialog_plugin`]）注册后，
    /// `DialogExt` 取态入口（错误窗三条路径的唯一入口）可取 state 不 panic——
    /// 未注册时 `state::<Dialog<R>>()` 直接 panic，错误兜底整体失效。
    ///
    /// 局限（如实注记）：main 的 Builder 链无法在 mock runtime 下实例化（Wry
    /// 需真实窗口系统），本测试锁定的是「注册后取态可用」的插件行为面；链上
    /// 调用经 `dialog_plugin()` 单点函数约束（main 与本测试同源），删除链上
    /// `.plugin(dialog_plugin())` 行需人工评审把关。
    #[test]
    fn dialog_plugin_registers_manager_state() {
        let app = tauri::test::mock_app();
        app.handle()
            .plugin(dialog_plugin())
            .expect("dialog 插件注册成功");
        // 未注册形态下此行 panic：state::<Dialog<R>>() 缺席
        let _dialog = app.dialog();
    }

    /// 2-3：多字节字符被读边界切开时，摘要不得出现 U+FFFD（不完整尾巴跨读保留）。
    #[test]
    fn collect_stderr_keeps_multibyte_chars_across_chunk_boundary() {
        struct ChunkReader { data: Vec<u8>, pos: usize, chunk: usize }
        impl Read for ChunkReader {
            fn read(&mut self, out: &mut [u8]) -> std::io::Result<usize> {
                let end = (self.pos + self.chunk).min(self.data.len());
                let n = end - self.pos;
                out[..n].copy_from_slice(&self.data[self.pos..end]);
                self.pos = end;
                Ok(n)
            }
        }
        // "中" = 3 字节，读块大小 1 强制三块拼接；前后夹 ASCII 定位边界
        let payload = b"ok\xe4\xb8\xadend".to_vec();
        let tail = Arc::new(Mutex::new(String::new()));
        collect_stderr(ChunkReader { data: payload, pos: 0, chunk: 1 }, tail.clone());
        let s = tail.lock().unwrap().clone();
        assert_eq!(s, "ok中end", "跨块字符必须完整: {s:?}");
    }

    /// 2-3：EOF 时 pending 非空（尾巴不完整即断流）——EOF 分支 lossy 兜底，
    /// 不完整尾字节按 U+FFFD 收尾且不吞前置完整字符（新实现的 EOF 刷写行为锚：
    /// 缺失该刷写时尾部字节被静默丢弃，此测试即翻转）。
    #[test]
    fn collect_stderr_flushes_incomplete_tail_lossy_at_eof() {
        struct ChunkReader { data: Vec<u8>, pos: usize, chunk: usize }
        impl Read for ChunkReader {
            fn read(&mut self, out: &mut [u8]) -> std::io::Result<usize> {
                let end = (self.pos + self.chunk).min(self.data.len());
                let n = end - self.pos;
                out[..n].copy_from_slice(&self.data[self.pos..end]);
                self.pos = end;
                Ok(n)
            }
        }
        // "中" 的前两字节后断流：无法跨读保留，EOF lossy 兜底为单个 U+FFFD
        let payload = b"ab\xe4\xb8".to_vec();
        let chunk = payload.len();
        let tail = Arc::new(Mutex::new(String::new()));
        collect_stderr(ChunkReader { data: payload, pos: 0, chunk }, tail.clone());
        let s = tail.lock().unwrap().clone();
        assert_eq!(s, "ab\u{fffd}", "EOF 不完整尾巴须 lossy 兜底且不丢前置字符: {s:?}");
    }
}
