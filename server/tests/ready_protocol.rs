//! Task 1 集成测试（plan 2026-10-19 多端发布阶段一）：`--port 0` 内核分配端口 +
//! `VV_READY port=<n>` 就绪行端到端验证——桌面薄壳（Task 2 shell）spawn 协议的
//! server 侧自证。
//!
//! 既有集成测试均 oneshot router（无 spawn 先例）；本测试为仓库首个 spawn 形态，
//! 经 std::process::Command + env!("CARGO_BIN_EXE_vviewer") 标准机制起真实二进制：
//! 读 stdout 至就绪行 → 解析端口 → 对该端口裸 TCP GET /api/health 断言 200。

use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpStream;
use std::process::{Child, Command, Stdio};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// 就绪行解析（与 Task 2 shell 侧解析器同前缀契约——行首精确匹配 `VV_READY port=`；
/// 差异：此间尾部 `u16::parse` 容忍前导 `+`，壳侧严格数字校验拒绝之。纯净性由
/// server 输出侧锁定——本测试断言输出行恰为 `VV_READY port=<n>`，解析器放宽不
/// 掩盖协议破坏）。
fn parse_ready_port(line: &str) -> Option<u16> {
    line.strip_prefix("VV_READY port=")?.parse().ok()
}

#[test]
fn ready_parser_accepts_exact_wire_format() {
    assert_eq!(parse_ready_port("VV_READY port=8321"), Some(8321));
    assert_eq!(parse_ready_port("VV_READY port=0"), Some(0));
}

#[test]
fn ready_parser_rejects_noise_and_garbage() {
    assert_eq!(
        parse_ready_port("noise VV_READY port=8321"),
        None,
        "前缀噪声不认"
    );
    assert_eq!(
        parse_ready_port("2026-10-19T00:00:00Z  INFO vviewer: VV_READY port=1"),
        None,
        "日志形态前缀不认"
    );
    assert_eq!(parse_ready_port("VV_READY port=abc"), None, "非数字容错");
    assert_eq!(parse_ready_port("VV_READY port="), None);
    assert_eq!(parse_ready_port("VV_READY port=99999"), None, "u16 溢出");
    assert_eq!(parse_ready_port("VV_READY  port=8321"), None, "多空格不认");
    assert_eq!(parse_ready_port(""), None);
}

/// panic 时也不留孤儿进程占端口。
struct KillOnDrop(Child);

impl Drop for KillOnDrop {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

#[test]
fn serve_port_zero_assigns_kernel_port_and_emits_ready_line() {
    let dir = tempfile::tempdir().unwrap();
    // flag 不传（false）：--port 0 内核分配路径输出就绪行是 1-14 既有语义，
    // 不依赖显式 opt-in——本测试即该语义的存量锚
    let (mut child, rx, stderr_buf) = spawn_serve(dir.path(), "0", false);

    // 就绪等待：15s 与 plan 壳侧超时一致；子进程提前退出即报 stderr 摘要
    let deadline = Instant::now() + Duration::from_secs(15);
    let mut pre_ready_lines: Vec<String> = Vec::new();
    let (ready_line, port) = loop {
        match rx.recv_timeout(Duration::from_millis(100)) {
            Ok(line) => {
                if let Some(p) = parse_ready_port(&line) {
                    break (line, p);
                }
                pre_ready_lines.push(line);
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => panic!(
                "stdout 在 VV_READY 前关闭; 已读 {pre_ready_lines:?}; stderr:\n{}",
                stderr_buf.lock().unwrap()
            ),
            Err(mpsc::RecvTimeoutError::Timeout) => {}
        }
        assert!(
            Instant::now() < deadline,
            "15s 内未收到 VV_READY 行; 已读 {pre_ready_lines:?}; stderr:\n{}",
            stderr_buf.lock().unwrap()
        );
        if let Some(status) = child.0.try_wait().unwrap() {
            panic!(
                "server 在 VV_READY 前退出: {status}; stderr:\n{}",
                stderr_buf.lock().unwrap()
            );
        }
    };

    assert_eq!(
        ready_line,
        format!("VV_READY port={port}"),
        "就绪行必须纯净（恰好一行、无前缀装饰）"
    );
    assert_ne!(port, 0, "--port 0 应得到内核分配端口");
    assert!(
        pre_ready_lines
            .iter()
            .any(|l| l.contains(&format!("listening on http://127.0.0.1:{port}"))),
        "listening 日志应使用实测端口（非配置值 0）; 已读 {pre_ready_lines:?}"
    );

    assert!(
        wait_health_ok(port, Duration::from_secs(15)),
        "解析出的端口应已伺服 /api/health（127.0.0.1:{port}）"
    );
}

/// 1-14：显式端口路径不再输出就绪行（终审裁决：多一行仅人读噪声）——
/// 壳侧消费面只有 --port 0，wire 契约不变。判据照反向锚：health 200 证明
/// 就绪行打印点已过（此测试即无 flag 静默语义的唯一断言点，宽限排水取 500ms
/// 上限——原两例 100ms/500ms 仅排水窗之差，终审留置项合并为一）。
#[test]
fn explicit_port_emits_no_ready_line() {
    let free_port = pick_free_port();
    let dir = tempfile::tempdir().unwrap();
    // _child 仅 RAII 持有（KillOnDrop 保进程至测试结束），stderr_buf 供断言诊断
    let (_child, rx, stderr_buf) = spawn_serve(dir.path(), &free_port.to_string(), false);

    // 无就绪行可等：以 /api/health 200 为伺服信号（wait_health_ok 自带 deadline
    // 内连接重试兜底）。就绪行若存在必先于 accept 循环输出且 stdout 行缓冲即刷——
    // 200 时点该行必已入通道；再宽限排水至管道静默（500ms），杜绝在途行漏读。
    assert!(
        wait_health_ok(free_port, Duration::from_secs(15)),
        "显式端口应正常伺服 /api/health（127.0.0.1:{free_port}）"
    );
    let mut all_lines: Vec<String> = Vec::new();
    // Timeout 与 Disconnected 同义退出（仅断言已收行，无需区分）
    while let Ok(line) = rx.recv_timeout(Duration::from_millis(500)) {
        all_lines.push(line);
    }

    assert!(
        !all_lines.iter().any(|l| l.starts_with("VV_READY port=")),
        "显式端口路径不得输出就绪行; stdout: {all_lines:?}; stderr:\n{}",
        stderr_buf.lock().unwrap()
    );
}

/// Task 1（桌面粘性端口前置）：`--emit-ready-line` 为显式端口的就绪行显式
/// opt-in 通道——桌面薄壳两种端口形态恒传此 flag 的 server 侧前提。断言
/// 该行纯净（恰为 `VV_READY port=<n>`，端口与 --port 实参一致）且真实伺服。
#[test]
fn serve_explicit_port_with_flag_emits_ready_line() {
    let port = pick_free_port();
    let dir = tempfile::tempdir().unwrap();
    let (mut child, rx, stderr_buf) = spawn_serve(dir.path(), &port.to_string(), true);

    // 就绪等待：15s 与 plan 壳侧超时一致；子进程提前退出即报 stderr 摘要
    let deadline = Instant::now() + Duration::from_secs(15);
    let mut pre_ready_lines: Vec<String> = Vec::new();
    let ready_line = loop {
        match rx.recv_timeout(Duration::from_millis(100)) {
            Ok(line) => {
                if line.starts_with("VV_READY port=") {
                    break line;
                }
                pre_ready_lines.push(line);
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => panic!(
                "stdout 在 VV_READY 前关闭; 已读 {pre_ready_lines:?}; stderr:\n{}",
                stderr_buf.lock().unwrap()
            ),
            Err(mpsc::RecvTimeoutError::Timeout) => {}
        }
        assert!(
            Instant::now() < deadline,
            "15s 内未收到 VV_READY 行; 已读 {pre_ready_lines:?}; stderr:\n{}",
            stderr_buf.lock().unwrap()
        );
        if let Some(status) = child.0.try_wait().unwrap() {
            panic!(
                "server 在 VV_READY 前退出: {status}; stderr:\n{}",
                stderr_buf.lock().unwrap()
            );
        }
    };

    assert_eq!(
        ready_line,
        format!("VV_READY port={port}"),
        "就绪行必须纯净且端口与 --port 实参一致"
    );
    assert!(
        wait_health_ok(port, Duration::from_secs(15)),
        "带 flag 的显式端口应正常伺服 /api/health（127.0.0.1:{port}）"
    );
}

/// 2-1：状态行解析失败必须携带响应原文（诊断完整性——unwrap_or(0) 使
/// 「为何非 200」不可诊断）。
#[test]
fn parse_status_line_carries_diagnosis_on_failure() {
    assert_eq!(parse_status_line("HTTP/1.1 200 OK\r\n"), Ok(200));
    assert_eq!(
        parse_status_line("HTTP/1.0 500 Internal Server Error\r\n"),
        Ok(500)
    );
    let err = parse_status_line("garbage\r\n").unwrap_err();
    assert!(err.contains("garbage"), "错误须携带原文: {err}");
    assert!(parse_status_line("HTTP/1.1\r\n").is_err(), "缺状态码段");
}

/// 解析状态行第二段为状态码；失败 Err 携带响应头原文片段（2-1：诊断
/// 完整性——明文优于魔法值 0）。
fn parse_status_line(head: &str) -> Result<u16, String> {
    let code = head
        .split_whitespace()
        .nth(1)
        .ok_or_else(|| format!("状态行缺失码段: {head}"))?;
    code.parse::<u16>()
        .map_err(|_| format!("状态码非数字: {head}"))
}

/// 挑一个当前空闲的 TCP 端口（bind :0 → 取 local_addr → drop；微小竞窗可接受，
/// 显式端口测试没有 --port 0 可用）。
fn pick_free_port() -> u16 {
    std::net::TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port()
}

/// spawn serve（--root <dir> --port <port_arg> [--emit-ready-line]），返回
/// (KillOnDrop, stdout 行 Receiver, stderr 累积缓冲)——stdout/stderr 排水形态
/// 照 serve_port_zero_assigns_kernel_port_and_emits_ready_line 测试体搬移。
fn spawn_serve(
    dir: &std::path::Path,
    port_arg: &str,
    emit_ready_line: bool,
) -> (KillOnDrop, mpsc::Receiver<String>, Arc<Mutex<String>>) {
    let mut cmd = Command::new(env!("CARGO_BIN_EXE_vviewer"));
    cmd.args(["serve", "--port", port_arg, "--root"]).arg(dir);
    // 就绪行 opt-in 通道（Task 1 粘性端口前提）：显式端口测试经布尔参切换
    if emit_ready_line {
        cmd.arg("--emit-ready-line");
    }
    let child = cmd
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn vviewer serve");
    let mut child = KillOnDrop(child);

    // stderr 排水线程：防管道缓冲写满阻塞子进程；内容留存供失败诊断
    let stderr = child.0.stderr.take().unwrap();
    let stderr_buf = Arc::new(Mutex::new(String::new()));
    {
        let stderr_buf = Arc::clone(&stderr_buf);
        std::thread::spawn(move || {
            let mut r = BufReader::new(stderr);
            let mut buf = String::new();
            loop {
                buf.clear();
                match r.read_line(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(_) => stderr_buf.lock().unwrap().push_str(&buf),
                }
            }
        });
    }

    // stdout 逐行经通道转发（读线程阻塞式，主线程超时轮询）
    let stdout = child.0.stdout.take().unwrap();
    let (tx, rx) = mpsc::channel::<String>();
    std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines() {
            match line {
                Ok(l) => {
                    if tx.send(l).is_err() {
                        break;
                    }
                }
                Err(_) => break,
            }
        }
    });

    (child, rx, stderr_buf)
}

/// 裸 TCP 探针：不加 HTTP 客户端 dev-dep，HTTP/1.1 + Connection: close 读到 EOF，
/// 取状态行判定 200。VV_READY 于 bind 后输出，连接理论即成；deadline 内每
/// 100ms 一探的重试仅为 accept 循环启动前的毫秒级窗口兜底（显式截止上限，
/// 替代原 50×100ms 固定循环）。deadline 内未连通返回 false；连通但状态行解析
/// 失败/非 200 即 panic——协议破坏是确定性失败，重试无意义（2-1 诊断完整性）。
fn wait_health_ok(port: u16, timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    loop {
        if let Ok(mut stream) = TcpStream::connect(("127.0.0.1", port)) {
            stream
                .set_read_timeout(Some(Duration::from_secs(5)))
                .unwrap();
            stream
                .write_all(
                    b"GET /api/health HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n",
                )
                .unwrap();
            let mut head = String::new();
            let _ = stream.read_to_string(&mut head);
            match parse_status_line(&head) {
                Ok(200) => return true,
                Ok(other) => panic!("health 返回非 200 状态码 {other}; 响应头: {head}"),
                Err(msg) => panic!("{msg}"),
            }
        }
        if Instant::now() >= deadline {
            return false;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
}
