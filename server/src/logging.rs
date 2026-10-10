//! 日志装配（BUG-68）：默认过滤收紧 + 可选 --log-file 单备份滚动。
//!
//! 默认 EnvFilter `info,notify=error`：notify crate 的扫描 WARN（poll 周期
//! 重扫对不可读路径的逐条报错）默认静默，可观测性由 watch.rs 自身的
//! 降级/自愈日志承担；`RUST_LOG` 可整体覆盖（如 `info,notify=warn` 排查）。
//! `--log-file` 时日志写文件，超 10MB 滚动为 `<PATH>.old`（单备份覆盖式）。

use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

/// 无 RUST_LOG 时的默认过滤：notify 内部 WARN（含 poll 重扫报错）默认静默。
pub const DEFAULT_FILTER: &str = "info,notify=error";

/// 单文件滚动阈值：当前日志超过该字节数即滚动。
const LOG_ROTATE_BYTES: u64 = 10 * 1024 * 1024;

/// 由可选的 `RUST_LOG` 值构造过滤器（纯函数，spec §5.3 可测化）：None（未设置）
/// 用默认过滤 `info,notify=error`；Some(v) 时显式值整体覆盖默认（如
/// `info,notify=warn` 排查）。
fn build_filter(rust_log: Option<&str>) -> tracing_subscriber::EnvFilter {
    match rust_log {
        Some(v) => tracing_subscriber::EnvFilter::new(v),
        None => tracing_subscriber::EnvFilter::new(DEFAULT_FILTER),
    }
}

/// 装配全局 subscriber。`log_file = Some(path)` 时写文件（ANSI 关闭、滚动），
/// None 维持 stdout。启动期参数错误由调用方转为 exit code（本函数只报 IO 错误）。
pub fn init_tracing(log_file: Option<&Path>) -> io::Result<()> {
    let filter = build_filter(std::env::var("RUST_LOG").ok().as_deref());
    match log_file {
        Some(p) => {
            let writer = RotatingWriter::new(p)?;
            tracing_subscriber::fmt()
                .with_env_filter(filter)
                .with_ansi(false)
                .with_writer(move || writer.clone())
                .init();
        }
        None => {
            tracing_subscriber::fmt().with_env_filter(filter).init();
        }
    }
    Ok(())
}

/// 滚动文件 Writer：Append 打开，写入累计超 cap 时 rename 为 `<path>.old`
/// （覆盖旧备份）后重建当前文件。Clone 共享同一状态（MakeWriter 闭包用）。
#[derive(Clone)]
pub struct RotatingWriter {
    inner: Arc<Mutex<RotatingState>>,
}

struct RotatingState {
    path: PathBuf,
    file: std::fs::File,
    written: u64,
    cap: u64,
}

impl RotatingWriter {
    pub fn new(path: &Path) -> io::Result<Self> {
        Self::with_capacity(path, LOG_ROTATE_BYTES)
    }

    fn with_capacity(path: &Path, cap: u64) -> io::Result<Self> {
        if let Some(parent) = path.parent() {
            if !parent.as_os_str().is_empty() {
                std::fs::create_dir_all(parent)?;
            }
        }
        let file = std::fs::OpenOptions::new().create(true).append(true).open(path)?;
        let written = file.metadata()?.len();
        Ok(Self {
            inner: Arc::new(Mutex::new(RotatingState { path: path.to_path_buf(), file, written, cap })),
        })
    }
}

impl Write for RotatingWriter {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        let mut st = self.inner.lock().expect("log writer 锁中毒");
        if st.written >= st.cap {
            st.file.flush()?;
            let mut old = st.path.as_os_str().to_owned();
            old.push(".old");
            std::fs::rename(&st.path, PathBuf::from(old))?;
            st.file = std::fs::OpenOptions::new().create(true).append(true).open(&st.path)?;
            st.written = 0;
        }
        st.file.write_all(buf)?;
        st.written += buf.len() as u64;
        Ok(buf.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        self.inner.lock().expect("log writer 锁中毒").file.flush()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};

    /// 滚动：写入超过 cap 后当前文件滚动为 `.old`（覆盖旧备份），当前文件从零继续。
    #[test]
    fn rotating_writer_rolls_over_capacity() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("vviewer.log");
        let mut w = RotatingWriter::with_capacity(&path, 1_000).unwrap();
        let line = "x".repeat(99) + "\n";
        for _ in 0..30 {
            w.write_all(line.as_bytes()).unwrap();
        }
        w.flush().unwrap();
        let old = std::fs::read(dir.path().join("vviewer.log.old")).unwrap_or_default();
        let cur = std::fs::read(&path).unwrap();
        assert!(!old.is_empty(), "滚动后应存在非空 .old 备份");
        assert!(cur.len() <= 1_000 + line.len(), "当前文件应在新窗口内: {cur_len}", cur_len = cur.len());
        // 滚动后继续可写（句柄有效）
        w.write_all(b"after-rotate\n").unwrap();
        w.flush().unwrap();
        assert!(std::fs::read_to_string(&path).unwrap().contains("after-rotate"));
    }

    /// 追加语义：重启（重建 Writer）后从既有文件长度续计（不因 restart 立即滚动错乱）。
    #[test]
    fn rotating_writer_resumes_existing_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("vviewer.log");
        std::fs::write(&path, "z".repeat(900)).unwrap();
        let mut w = RotatingWriter::with_capacity(&path, 1_000).unwrap();
        w.write_all(b"tail\n").unwrap();
        w.flush().unwrap();
        assert_eq!(std::fs::read(&path).unwrap().len(), 905, "未超 cap 不应滚动");
        assert!(!path.with_extension("log.old").exists(), "不应提前滚动");
    }

    /// 把 log crate 记录桥接进当前 dispatcher 后，`build_filter(None)`（即默认
    /// 过滤）应静默 notify 的扫描 WARN（BUG-68 抑制层），其他 target 的 WARN
    /// 正常通过。
    #[test]
    fn default_filter_silences_notify_scan_warns() {
        let _ = tracing_log::LogTracer::init(); // 全局仅生效一次，重复调用失败可忽略
        let sink: Arc<Mutex<Vec<u8>>> = Arc::new(Mutex::new(Vec::new()));
        struct SharedSink(Arc<Mutex<Vec<u8>>>);
        impl std::io::Write for SharedSink {
            fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
                self.0.lock().unwrap().extend_from_slice(buf);
                Ok(buf.len())
            }
            fn flush(&mut self) -> std::io::Result<()> {
                Ok(())
            }
        }
        let w = sink.clone();
        let subscriber = tracing_subscriber::fmt()
            .with_ansi(false)
            .with_env_filter(build_filter(None))
            .with_writer(move || SharedSink(w.clone()))
            .finish();
        tracing::subscriber::with_default(subscriber, || {
            log::warn!(target: "notify::poll::data", "walkdir error scanning fake");
            log::warn!(target: "vviewer::logging_test", "visible warn");
        });
        let out = String::from_utf8(sink.lock().unwrap().clone()).unwrap();
        assert!(!out.contains("notify::poll::data"), "notify 扫描 WARN 应被默认过滤: {out}");
        assert!(out.contains("visible warn"), "其他 target 不应被误伤: {out}");
    }

    /// 显式 `RUST_LOG` 整体覆盖默认过滤：`info,notify=warn` 下 notify 扫描
    /// WARN 可见（spec §5.3 后半句——排查时可主动放开）。
    #[test]
    fn explicit_rust_log_overrides_default_and_shows_notify_warns() {
        let _ = tracing_log::LogTracer::init(); // 全局仅生效一次，重复调用失败可忽略
        let sink: Arc<Mutex<Vec<u8>>> = Arc::new(Mutex::new(Vec::new()));
        struct SharedSink(Arc<Mutex<Vec<u8>>>);
        impl std::io::Write for SharedSink {
            fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
                self.0.lock().unwrap().extend_from_slice(buf);
                Ok(buf.len())
            }
            fn flush(&mut self) -> std::io::Result<()> {
                Ok(())
            }
        }
        let w = sink.clone();
        let subscriber = tracing_subscriber::fmt()
            .with_ansi(false)
            .with_env_filter(build_filter(Some("info,notify=warn")))
            .with_writer(move || SharedSink(w.clone()))
            .finish();
        tracing::subscriber::with_default(subscriber, || {
            log::warn!(target: "notify::poll::data", "walkdir error scanning fake");
        });
        let out = String::from_utf8(sink.lock().unwrap().clone()).unwrap();
        assert!(
            out.contains("notify::poll::data"),
            "显式 RUST_LOG 下 notify 扫描 WARN 应可见: {out}"
        );
    }

    #[test]
    fn default_filter_constant_is_notify_error() {
        assert_eq!(DEFAULT_FILTER, "info,notify=error");
    }
}
