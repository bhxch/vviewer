//! 就绪协议解析与等待（plan 2026-10-19 Task 2；server 侧契约见 server/src/main.rs
//! `ready_line`——bind 成功后向 stdout 输出恰好一行 `VV_READY port=<n>`）。
//!
//! 带入注记（Task 1）：
//! 1. 就绪行前有行数不定的启动日志（含 ANSI 装饰）——逐行 strip_prefix 匹配，
//!    不假设首行；
//! 2. 壳侧解析严格数字校验——拒绝前导 `+`/`-` 与一切非数字装饰。

use std::io::BufRead;
use std::sync::mpsc::{Receiver, RecvTimeoutError, Sender};
use std::time::Duration;

/// 就绪行前缀（wire 契约由 server 侧单测锁定：`VV_READY port=<n>` 纯净行）。
pub const READY_LINE_PREFIX: &str = "VV_READY port=";

/// 就绪等待超时（plan Global Constraints：15s 未捕获即失败）。
pub const READY_TIMEOUT: Duration = Duration::from_secs(15);

/// stdout 读取线程向等待方上报的事件。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReadyEvent {
    /// 捕获到就绪行，携带实测端口。
    Ready(u16),
    /// stdout 到达 EOF——子进程已退出（或其 stdout 已关闭）。
    Ended,
}

/// [`wait_for_ready`] 的失败形态。stderr 摘要由壳层收集器拼装（本模块不持 IO 状态）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WaitFailure {
    /// 超时（[`READY_TIMEOUT`]）未捕获就绪行。
    Timeout,
    /// stdout 先于就绪行 EOF——server 退出。
    Ended,
}

/// 解析单行就绪行：`VV_READY port=<n>` → `Some(n)`。
///
/// 严格规则：前缀精确匹配（行首，拒绝 ANSI/日志装饰）；`<n>` 非空且全为 ASCII
/// 数字（拒绝 `+`/`-` 号、空白与其他尾巴）；超出 u16 视为无端口。
pub fn parse_ready_line(line: &str) -> Option<u16> {
    let rest = line.strip_prefix(READY_LINE_PREFIX)?;
    if rest.is_empty() || !rest.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    rest.parse().ok()
}

/// 等待就绪事件：收到 [`ReadyEvent::Ready`] 即成功；[`ReadyEvent::Ended`]（含
/// 通道断开）→ [`WaitFailure::Ended`]；`timeout` 内无事件 → [`WaitFailure::Timeout`]。
pub fn wait_for_ready(rx: &Receiver<ReadyEvent>, timeout: Duration) -> Result<u16, WaitFailure> {
    match rx.recv_timeout(timeout) {
        Ok(ReadyEvent::Ready(port)) => Ok(port),
        Ok(ReadyEvent::Ended) | Err(RecvTimeoutError::Disconnected) => Err(WaitFailure::Ended),
        Err(RecvTimeoutError::Timeout) => Err(WaitFailure::Timeout),
    }
}

/// 起 stdout 读取线程：逐行读到底，遇就绪行上报 [`ReadyEvent::Ready`]（不中断
/// 读取——继续 drain 防 server stdout 写满阻塞），EOF 上报 [`ReadyEvent::Ended`]。
pub fn spawn_stdout_reader<R: BufRead + Send + 'static>(reader: R, tx: Sender<ReadyEvent>) {
    std::thread::spawn(move || {
        for line in reader.lines() {
            let Ok(line) = line else { break };
            // \r\n 输出形态（lines() 保留行尾 \r）剥离后再匹配——严格解析不吞 \r
            if let Some(port) = parse_ready_line(line.trim_end_matches('\r')) {
                // 通道对端可能已放弃等待（超时路径）：发送失败静默忽略
                let _ = tx.send(ReadyEvent::Ready(port));
            }
        }
        let _ = tx.send(ReadyEvent::Ended);
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;
    use std::sync::mpsc;
    use std::time::Duration;

    // ---------- parse_ready_line：正常行 ----------

    #[test]
    fn parses_plain_ready_line() {
        assert_eq!(parse_ready_line("VV_READY port=8080"), Some(8080));
        assert_eq!(parse_ready_line("VV_READY port=0"), Some(0));
        assert_eq!(parse_ready_line("VV_READY port=1"), Some(1));
        assert_eq!(parse_ready_line("VV_READY port=65535"), Some(65535));
    }

    #[test]
    fn accepts_leading_zeros_as_digits() {
        // 全数字即合法（内核分配端口不会产生前导零，此处仅锁定宽容语义不误拒）
        assert_eq!(parse_ready_line("VV_READY port=0080"), Some(80));
    }

    // ---------- parse_ready_line：前缀噪声与位置 ----------

    #[test]
    fn rejects_startup_log_lines() {
        // Task 1 带入：就绪行前有行数不定的启动日志（含 ANSI 装饰）
        assert_eq!(parse_ready_line(""), None);
        assert_eq!(
            parse_ready_line("vviewer listening on http://127.0.0.1:8321"),
            None
        );
        // ANSI 装饰行（前缀不在行首即不匹配）
        assert_eq!(
            parse_ready_line("\u{1b}[32mVV_READY port=8080\u{1b}[0m"),
            None
        );
        // 就绪行内容被夹在日志中间
        assert_eq!(
            parse_ready_line("info:VV_READY port=8080 dispatched"),
            None
        );
    }

    // ---------- parse_ready_line：严格数字容错 ----------

    #[test]
    fn rejects_sign_prefixes() {
        // Task 1 带入：壳侧严格数字校验，拒绝前导 +/-
        assert_eq!(parse_ready_line("VV_READY port=+8080"), None);
        assert_eq!(parse_ready_line("VV_READY port=-1"), None);
    }

    #[test]
    fn rejects_empty_and_garbage_ports() {
        assert_eq!(parse_ready_line("VV_READY port="), None);
        assert_eq!(parse_ready_line("VV_READY port=8080 extra"), None);
        assert_eq!(parse_ready_line("VV_READY port=80 80"), None);
        assert_eq!(parse_ready_line("VV_READY  port=8080"), None);
        assert_eq!(parse_ready_line("vv_ready port=8080"), None);
    }

    #[test]
    fn rejects_port_overflow() {
        assert_eq!(parse_ready_line("VV_READY port=65536"), None);
        assert_eq!(parse_ready_line("VV_READY port=99999999"), None);
    }

    #[test]
    fn rejects_trailing_cr_without_help() {
        // BufReader::lines() 在 \r\n 输出下保留行尾 \r——严格语义下不吞错误源，
        // \r 由读取线程剥离（见 strip_carriage_return 单测）
        assert_eq!(parse_ready_line("VV_READY port=8080\r"), None);
    }

    #[test]
    fn strips_carriage_return_before_parse() {
        let line = "VV_READY port=8080\r";
        let stripped = line.trim_end_matches('\r');
        assert_eq!(parse_ready_line(stripped), Some(8080));
    }

    // ---------- spawn_stdout_reader：噪声流中捕获就绪行 ----------

    #[test]
    fn reader_finds_ready_line_after_noise_and_drains_to_eof() {
        let output = "\u{1b}[2m2026-10-19T00:00:00Z\u{1b}[0m boot\n\
                      vviewer listening on http://127.0.0.1:8321\n\
                      VV_READY port=8321\n\
                      post-ready log line\n";
        let (tx, rx) = mpsc::channel();
        spawn_stdout_reader(Cursor::new(output.to_string()), tx);
        // 首个事件即就绪（不要求首行）
        let first = rx
            .recv_timeout(Duration::from_secs(5))
            .expect("reader should report an event");
        assert_eq!(first, ReadyEvent::Ready(8321));
        // 读取线程持续 drain 至 EOF（ Ends 晚于 Ready ）
        let second = rx
            .recv_timeout(Duration::from_secs(5))
            .expect("reader should report EOF");
        assert_eq!(second, ReadyEvent::Ended);
    }

    #[test]
    fn reader_reports_ended_when_stdout_closes_without_ready_line() {
        let (tx, rx) = mpsc::channel();
        spawn_stdout_reader(Cursor::new("only logs\n".to_string()), tx);
        let event = rx
            .recv_timeout(Duration::from_secs(5))
            .expect("reader should report EOF");
        assert_eq!(event, ReadyEvent::Ended);
    }

    #[test]
    fn reader_tolerates_trailing_cr_on_ready_line() {
        let (tx, rx) = mpsc::channel();
        spawn_stdout_reader(Cursor::new("VV_READY port=9000\r\n".to_string()), tx);
        let event = rx
            .recv_timeout(Duration::from_secs(5))
            .expect("reader should report an event");
        assert_eq!(event, ReadyEvent::Ready(9000));
    }

    // ---------- wait_for_ready：成功/退出/超时语义 ----------

    #[test]
    fn wait_returns_port_on_ready_event() {
        let (tx, rx) = mpsc::channel();
        tx.send(ReadyEvent::Ready(1234)).unwrap();
        assert_eq!(wait_for_ready(&rx, Duration::from_secs(5)), Ok(1234));
    }

    #[test]
    fn wait_maps_ended_to_failure() {
        let (tx, rx) = mpsc::channel();
        tx.send(ReadyEvent::Ended).unwrap();
        assert_eq!(
            wait_for_ready(&rx, Duration::from_secs(5)),
            Err(WaitFailure::Ended)
        );
    }

    #[test]
    fn wait_maps_dropped_channel_to_ended() {
        let (tx, rx) = mpsc::channel::<ReadyEvent>();
        drop(tx);
        assert_eq!(
            wait_for_ready(&rx, Duration::from_secs(5)),
            Err(WaitFailure::Ended)
        );
    }

    #[test]
    fn wait_times_out_on_silent_channel() {
        let (_tx, rx) = mpsc::channel::<ReadyEvent>();
        assert_eq!(
            wait_for_ready(&rx, Duration::from_millis(10)),
            Err(WaitFailure::Timeout)
        );
    }
}
