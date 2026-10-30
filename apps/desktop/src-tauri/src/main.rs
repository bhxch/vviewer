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
mod sticky;

use std::io::Read;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
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
    /// C4：重启在飞护栏——start_and_wait 开场置位、槽位放回/早退清位；
    /// 退出回收（[`reap_after_restart_window`]，信号与 RunEvent::Exit 两路共用）
    /// 据此等待孤儿窗口收口后再统一 kill。
    restarting: AtomicBool,
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
                restarting: AtomicBool::new(false),
            });
            // 2-7：SIGTERM/SIGINT → 与 RunEvent::Exit 同一回收路径后退出——桌面壳被
            // 信号终止时 server sidecar 不再孤儿化。Windows 如实注记：ctrlc 映射
            // CTRL_C/CTRL_BREAK；TerminateProcess 强杀无回调面（文档语义基线，
            // 台账 2-7 既往口径一致）。
            let signal_app = app.handle().clone();
            ctrlc::set_handler(move || {
                shutdown_now(&signal_app.state::<ServerState>());
            })
            .expect("注册信号处理器失败");
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
        // 应用退出（窗口关闭 / 错误窗「退出」）：回收 server 子进程——与信号
        // 退出同一 C4 护栏纪律（重启在飞毫秒窗内直调 kill_server 会孤儿化新
        // sidecar，见 reap_after_restart_window doc）
        if let RunEvent::Exit = event {
            reap_after_restart_window(&app.state::<ServerState>());
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

/// 重启编排（2-4）：后台线程 spawn+等就绪，主线程只做窗操作（macOS 约束）。
/// 结果两条路（建窗/再弹错误窗）各自回主线程分派；并发双重启由错误窗
/// 模态语义天然排除（一次仅一个待选窗）。
fn restart_async(app: AppHandle) {
    std::thread::spawn(move || match start_and_wait(&app) {
        Ok(port) => {
            let h = app.clone();
            let _ = app.run_on_main_thread(move || show_or_navigate(&h, port));
        }
        Err(failure) => {
            let h = app.clone();
            let _ = app.run_on_main_thread(move || ask_restart_or_exit(&h, failure));
        }
    });
}

/// spawn sidecar 并等待就绪行；成功返回实测端口。
fn start_and_wait(app: &AppHandle) -> Result<u16, LaunchFailure> {
    let state = app.state::<ServerState>();
    // C4：先竖护栏再出槽——孤儿窗口（kill 旧 child 至新 child 入槽）全程有
    // 护栏覆盖；RAII 清位覆盖全部早退路径
    state.restarting.store(true, Ordering::Release);
    let _restart_guard = RestartGuard(&state.restarting);
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
/// 重启编排 2-4 起异步（restart_async），错误窗不再被 15s 等待冻结。
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
                // 2-4：重启编排出主线程——同步等待 15s 曾冻结错误窗与事件循环
                let _ = h.run_on_main_thread(move || restart_async(h2));
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

/// C4：等待重启在飞窗口收口（毫秒级）。见位自旋（2ms 步进）至护栏清位；
/// 超上限按无窗口处置（防御性——早退路径由 RestartGuard RAII 清位，正常不触顶）。
fn wait_restart_window(restarting: &AtomicBool, timeout: Duration) {
    let deadline = std::time::Instant::now() + timeout;
    while restarting.load(Ordering::Acquire) {
        if std::time::Instant::now() >= deadline {
            return;
        }
        std::thread::sleep(Duration::from_millis(2));
    }
}

/// C4：重启在飞护栏 RAII——置位在构造（调用方 store(true) 后包一层）、
/// 清位在 drop：start_and_wait 的全部早退路径（Resolve 失败 / 超时 / spawn
/// 失败）不靠逐 return 记忆。
struct RestartGuard<'a>(&'a AtomicBool);

impl Drop for RestartGuard<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Release);
    }
}

/// C4：护栏等待上限（覆盖最慢 start_and_wait 收口；与 READY_TIMEOUT 同量级，
/// 独立常量避免语义耦合——护栏超时是防御性保险，不是就绪等待）。
const RESTART_WINDOW_TIMEOUT: Duration = Duration::from_secs(15);

/// 退出回收尾段（C4 核心语义；信号退出与 RunEvent::Exit 两路共用）：先等重启
/// 在飞窗口收口再 kill——「旧 child 已出槽（start_and_wait kill_server）、新
/// child 未入槽（:202 放回）」的毫秒级窗口内触发退出时，新 sidecar 由本函数在
/// 窗口收口（槽位放回）后统一回收，不再孤儿化。RunEvent::Exit 复用同款纪律：
/// 直调 kill_server 在该窗口内同样孤儿化新 sidecar。双检：kill 前后各查一次
/// 护栏，恰在重启开场置位前后到达时复查见位即回到等待；wait#2 收口（含超时
/// 放行分支）后再 kill 一轮（幂等）——复查路径下新 sidecar 已在槽位，在此
/// 统一回收。残余窗口（知情接受）：末次 kill 通过至调用方后续动作（exit /
/// 事件循环终结）之间重启线程恰好开场的纳秒级交错——原缺陷窗口毫秒级且后果
/// 可控（孤儿 sidecar 存活至机器重启，--port 0 无端口冲突），线性化需第二
/// 标志位 + 重启 bail-out，复杂度不成比例。正常关闭（restarting=false）时
/// wait 立即返回、kill 一轮命中一轮空转（幂等），零开销不变。
fn reap_after_restart_window(state: &ServerState) {
    wait_restart_window(&state.restarting, RESTART_WINDOW_TIMEOUT);
    kill_server(state);
    if state.restarting.load(Ordering::Acquire) {
        wait_restart_window(&state.restarting, RESTART_WINDOW_TIMEOUT);
    }
    // 复查/超时收口后的二次回收（幂等）：复查路径新 sidecar 已入槽，无人回收
    // 即成孤儿——补收使 doc「窗口收口后统一回收」声明与代码一致
    kill_server(state);
}

/// 信号退出语义体（2-7；C4 护栏）：共用回收尾段（[`reap_after_restart_window`]）
/// 后 exit(0)。
fn shutdown_now(state: &ServerState) {
    reap_after_restart_window(state);
    std::process::exit(0);
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
    use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
    use std::sync::{Arc, Mutex};

    use super::collect_stderr;
    use super::dialog_plugin;
    use super::kill_server;
    use super::reap_after_restart_window;
    use super::wait_restart_window;
    use super::RestartGuard;
    use super::ServerState;
    use tauri_plugin_dialog::DialogExt;

    /// C1 契约锚：dialog 插件经同一 `init::<R>()`（[`dialog_plugin`]）注册后，
    /// `DialogExt` 取态入口（错误窗三条路径的唯一入口）可取 state 不 panic——
    /// 未注册时 `state::<Dialog<R>>()` 直接 panic，错误兜底整体失效。
    ///
    /// 局限（如实注记）：main 的 Builder 链无法在 mock runtime 下实例化（Wry
    /// 需真实窗口系统），本测试锁定的是「注册后取态可用」的插件行为面；链上
    /// 调用经 `dialog_plugin()` 单点函数约束（main 与本测试同源），删除链上
    /// `.plugin(dialog_plugin())` 行需人工评审把关。删行防线另有
    /// builder_chain_registers_dialog_plugin 源码锚（2-6），双保险成立。
    #[test]
    fn dialog_plugin_registers_manager_state() {
        let app = tauri::test::mock_app();
        app.handle()
            .plugin(dialog_plugin())
            .expect("dialog 插件注册成功");
        // 未注册形态下此行 panic：state::<Dialog<R>>() 缺席
        let _dialog = app.dialog();
    }

    /// 2-6 源码锚：main 的 Builder 链必须含 dialog 插件注册行。mock 契约测试
    /// （上方）锁「注册后取态可用」，本锚锁「链上确实注册了」——Wry 不可 mock，
    /// 删行防线=本锚+人工评审双保险（include_str 把源码烙进测试二进制，
    /// 无盘上文件依赖）。
    #[test]
    fn builder_chain_registers_dialog_plugin() {
        const SRC: &str = include_str!("main.rs");
        // 检索串经 concat! 拼装且锚定换行+8 空格缩进：字面量若原样烙进本文件
        // （断言自指）、或命中 mock 测试的 12 空格缩进调用 / doc 提及，contains
        // 即恒真、锚沦为 vacuous——全文件仅 main 链上那一行可匹配，删行必红。
        assert!(
            SRC.contains(concat!("\n        .plugin(", "dialog_plugin())")),
            "Builder 链缺 dialog 插件注册——错误窗三条路径将随 DialogExt state() panic 整体失效"
        );
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

    /// 2-7：shutdown_now 语义体——kill_server（kill+wait 防僵尸）后 exit(0)。
    /// exit 的进程终止面不可在测试内实跑（会杀掉测试进程），锁 kill 半边：
    /// 真实子进程塞进 [`ServerState`] 槽位后**直调 kill_server**（非平行实现），
    /// 断言槽位 take 且子进程已被收尸——kill+wait 丢其一时 /proc/<pid> 条目
    /// 仍在（丢 kill → 存活；丢 wait → zombie 悬挂），本测试即翻红。
    ///
    /// （ctrlc 的 handler 注册与进程退出面不可 headless 单测——诚实边界照 2-6
    /// 先例注记；本测试锁语义体的可测半边。`sleep` 在 Windows CI 缺席——
    /// `#[cfg(unix)]` 门控本测试；收尸判定走 /proc 进程表，macOS 无 /proc
    /// 退化为槽位断言，如实注记。）
    #[cfg(unix)]
    #[test]
    fn shutdown_reaps_child_process() {
        let child = std::process::Command::new("sleep")
            .arg("30")
            .spawn()
            .expect("sleep 可用（coreutils）");
        let pid = child.id();
        let state = ServerState {
            child: Mutex::new(Some(child)),
            generation: AtomicU64::new(0),
            stderr_tail: Arc::new(Mutex::new(String::new())),
            restarting: AtomicBool::new(false),
        };
        kill_server(&state);
        // 幂等锚：child 槽位 take 后为 None（二次调用无目标）
        assert!(state.child.lock().unwrap().is_none());
        // 已 reap：/proc/<pid> 条目随收尸消失
        #[cfg(target_os = "linux")]
        assert!(
            !std::path::Path::new(&format!("/proc/{pid}")).exists(),
            "子进程须已被 kill_server 收尸（/proc/{pid} 仍在即存活/zombie 悬挂）"
        );
        #[cfg(not(target_os = "linux"))]
        let _ = pid;
    }

    /// C4：退出回收尾段组合函数（[`reap_after_restart_window`]）——正常关闭
    /// （护栏清位）形态下两段 wait 立即返回、kill 一轮命中；信号退出与
    /// RunEvent::Exit 两路复用同款纪律。真实 sleep 子进程塞槽后 flag=false 直调，
    /// 断言槽位空 + 子进程已被收尸——断言形态照 [`shutdown_reaps_child_process`]
    /// （kill+wait 丢其一时 /proc/<pid> 条目仍在，本测试即翻红；Windows CI 的
    /// sleep 缺席与 macOS 无 /proc 的退化口径同前测）。
    #[cfg(unix)]
    #[test]
    fn reap_after_restart_window_reaps_child_process() {
        let child = std::process::Command::new("sleep")
            .arg("30")
            .spawn()
            .expect("sleep 可用（coreutils）");
        let pid = child.id();
        let state = ServerState {
            child: Mutex::new(Some(child)),
            generation: AtomicU64::new(0),
            stderr_tail: Arc::new(Mutex::new(String::new())),
            restarting: AtomicBool::new(false),
        };
        reap_after_restart_window(&state);
        assert!(state.child.lock().unwrap().is_none());
        // 已 reap：/proc/<pid> 条目随收尸消失
        #[cfg(target_os = "linux")]
        assert!(
            !std::path::Path::new(&format!("/proc/{pid}")).exists(),
            "子进程须已被 reap_after_restart_window 收尸（/proc/{pid} 仍在即存活/zombie 悬挂）"
        );
        #[cfg(not(target_os = "linux"))]
        let _ = pid;
    }

    /// C4：护栏等待——在飞时阻塞至清位（后台线程延时清位）。
    #[test]
    fn restart_window_wait_blocks_until_cleared() {
        let flag = std::sync::Arc::new(AtomicBool::new(true));
        let f = flag.clone();
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(30));
            f.store(false, Ordering::Release);
        });
        let t0 = std::time::Instant::now();
        wait_restart_window(&flag, std::time::Duration::from_secs(5));
        assert!(
            t0.elapsed() >= std::time::Duration::from_millis(25),
            "见位须等待至清位（elapsed={:?}）",
            t0.elapsed()
        );
    }

    /// C4：护栏等待超时上限（防御性死等保险——早退路径由 RAII 清位，正常不触顶）。
    #[test]
    fn restart_window_wait_times_out_defensively() {
        let flag = AtomicBool::new(true);
        let t0 = std::time::Instant::now();
        wait_restart_window(&flag, std::time::Duration::from_millis(20));
        assert!(t0.elapsed() >= std::time::Duration::from_millis(15));
    }

    /// C4：RestartGuard RAII 清位（start_and_wait 全部早退路径的防线）。
    #[test]
    fn restart_guard_clears_on_drop() {
        let flag = AtomicBool::new(true);
        {
            let _g = RestartGuard(&flag);
            assert!(flag.load(Ordering::Acquire));
        }
        assert!(!flag.load(Ordering::Acquire), "guard drop 须清位");
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
