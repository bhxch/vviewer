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
    let child = Command::new(env!("CARGO_BIN_EXE_vviewer"))
        .args(["serve", "--port", "0", "--root"])
        .arg(dir.path())
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn vviewer serve --port 0");
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

    assert_eq!(health_status(port), 200, "解析出的端口应已伺服 /api/health");
}

/// 1-14：显式端口路径不再输出就绪行（终审裁决：多一行仅人读噪声）——
/// 壳侧消费面只有 --port 0，wire 契约不变。
#[test]
fn explicit_port_emits_no_ready_line() {
    // 空闲端口：std TcpListener bind :0 取内核分配值后即放（取放间理论竞窗，
    // 任务简报口径一致接受）
    let free_port = {
        let listener = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
        listener.local_addr().unwrap().port()
    };
    let dir = tempfile::tempdir().unwrap();
    let child = Command::new(env!("CARGO_BIN_EXE_vviewer"))
        .args(["serve", "--port", &free_port.to_string(), "--root"])
        .arg(dir.path())
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn vviewer serve --port <explicit>");
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

    // 无就绪行可等：以 /api/health 200 为伺服信号（health_status 自带连接重试
    // 兜底）。就绪行若存在必先于 accept 循环输出且 stdout 行缓冲即刷——200
    // 时点该行必已入通道；再宽限排水至管道静默，杜绝在途行漏读。
    assert_eq!(
        health_status(free_port),
        200,
        "显式端口应正常伺服 /api/health"
    );
    let mut all_lines: Vec<String> = Vec::new();
    // Timeout 与 Disconnected 同义退出（仅断言已收行，无需区分）
    while let Ok(line) = rx.recv_timeout(Duration::from_millis(100)) {
        all_lines.push(line);
    }

    assert!(
        !all_lines.iter().any(|l| l.starts_with("VV_READY port=")),
        "显式端口路径不得输出就绪行; stdout: {all_lines:?}"
    );
}

/// 裸 TCP 探针：不加 HTTP 客户端 dev-dep，HTTP/1.1 + Connection: close 读到 EOF，
/// 取状态行第二段为状态码。VV_READY 于 bind 后输出，连接理论即成；重试仅为
/// accept 循环启动前的毫秒级窗口兜底。
fn health_status(port: u16) -> u16 {
    for _ in 0..50 {
        if let Ok(mut stream) = TcpStream::connect(("127.0.0.1", port)) {
            stream
                .set_read_timeout(Some(Duration::from_secs(5)))
                .unwrap();
            stream
                .write_all(
                    b"GET /api/health HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n",
                )
                .unwrap();
            let mut buf = String::new();
            let _ = stream.read_to_string(&mut buf);
            return buf
                .split_whitespace()
                .nth(1)
                .and_then(|s| s.parse::<u16>().ok())
                .unwrap_or(0);
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    panic!("无法连接 127.0.0.1:{port}");
}
