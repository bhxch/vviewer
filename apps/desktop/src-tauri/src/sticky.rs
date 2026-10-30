//! 粘性端口持久化（plan 2026-10-30 桌面粘性端口 Task 2）：壳侧把上次成功端口
//! 落盘到 AppConfigDir 下的 [`STICKY_FILE`]，供下次启动优先复用（壳启动编排
//! start_and_wait 消费），减少 `--port 0` 随机端口的漂移。
//!
//! 容错纪律：持久化是优化不是依赖——读侧任何异常形态（文件缺失/JSON 损坏/
//! 字段缺失/端口 0 占位）一律 `None` 静默降级，调用方回落 `--port 0` 形态；
//! 写侧任何 IO/序列化错误同样静默吞（无日志无 panic）：落盘失败只损失下次的
//! 端口粘性，不影响本次已实测成功的端口。纯函数面：不持状态、不感知 Tauri
//! （AppConfigDir 由调用方解析后传入），真实文件系统行为由七例单测锁定。

/// 粘性端口落盘文件名（AppConfigDir 下）。
pub const STICKY_FILE: &str = "desktop-shell.json";

/// 读粘性端口：文件缺失/JSON 损坏/字段缺失/端口 0 一律 None，不 panic 无告警。
pub fn read_sticky_port(dir: &std::path::Path) -> Option<u16> {
    let Ok(text) = std::fs::read_to_string(dir.join(STICKY_FILE)) else {
        return None;
    };
    let value: serde_json::Value = serde_json::from_str(&text).ok()?;
    // as_u64 天然拒绝负数/浮点/字符串形态；u16 溢出与 0 占位同样按缺失处置
    let port = value.get("port")?.as_u64()?;
    u16::try_from(port).ok().filter(|&p| p != 0)
}

/// 写粘性端口：create_dir_all + 覆写 JSON `{"port": n}`；任何 IO/序列化错误
/// 静默吞（持久化是优化不是依赖，理由见模块 doc）。
pub fn write_sticky_port(dir: &std::path::Path, port: u16) {
    let Ok(()) = std::fs::create_dir_all(dir) else { return };
    let body = serde_json::json!({ "port": port }).to_string();
    let Ok(()) = std::fs::write(dir.join(STICKY_FILE), body) else { return };
}

#[cfg(test)]
mod tests {
    use super::{read_sticky_port, write_sticky_port, STICKY_FILE};

    /// 每测独立临时目录（pid + 纳秒命名，防并行/跨跑串扰），真实文件系统行为。
    fn temp_dir(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "vv-sticky-{}-{}-{name}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("系统时钟不可能早于 UNIX_EPOCH")
                .as_nanos(),
        ));
        let _ = std::fs::remove_dir_all(&dir);
        dir
    }

    #[test]
    fn roundtrip_writes_and_reads_back() {
        let dir = temp_dir("roundtrip");
        write_sticky_port(&dir, 8080);
        assert_eq!(read_sticky_port(&dir), Some(8080));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn missing_file_is_none() {
        let dir = temp_dir("missing");
        assert_eq!(read_sticky_port(&dir), None);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn corrupt_json_is_none() {
        let dir = temp_dir("corrupt");
        std::fs::create_dir_all(&dir).expect("临时目录创建成功");
        std::fs::write(dir.join(STICKY_FILE), "not json").expect("写入损坏态文件成功");
        assert_eq!(read_sticky_port(&dir), None);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn zero_port_is_none() {
        let dir = temp_dir("zero");
        std::fs::create_dir_all(&dir).expect("临时目录创建成功");
        std::fs::write(dir.join(STICKY_FILE), r#"{"port":0}"#).expect("写入零端口文件成功");
        assert_eq!(read_sticky_port(&dir), None);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn missing_port_field_is_none() {
        let dir = temp_dir("nofield");
        std::fs::create_dir_all(&dir).expect("临时目录创建成功");
        std::fs::write(dir.join(STICKY_FILE), "{}").expect("写入口径外 JSON 成功");
        assert_eq!(read_sticky_port(&dir), None);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn write_creates_missing_dir() {
        // 两级不存在的目录：write 侧 create_dir_all 补齐后 read 命中
        let base = temp_dir("mkdirs");
        let deep = base.join("level-a").join("level-b");
        write_sticky_port(&deep, 9000);
        assert_eq!(read_sticky_port(&deep), Some(9000));
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn write_failure_never_panics() {
        // dir 是普通文件：create_dir_all 必败——write 须静默返回（不 panic、
        // 不破坏既有文件），持久化失败不外溢
        let base = temp_dir("file-clash");
        std::fs::create_dir_all(&base).expect("临时目录创建成功");
        let file = base.join("occupant");
        std::fs::write(&file, "keep").expect("占位文件写入成功");
        write_sticky_port(&file, 12345);
        assert!(file.is_file(), "落盘失败不得破坏既有文件");
        let _ = std::fs::remove_dir_all(&base);
    }
}
