//! `#[event(fetch)]` 入口：状态装配（isolate 惰性单例）→ dispatch。
//!
//! 装配失败（VV_TOKEN 缺失、VV_MOUNTS JSON/字段缺失等配置错误）→ 对外统一
//! 500 通用消息（**M-3**：字段级字面不回显访客可见面——native TOML 配置错误
//! 走 stderr/exit 2 的语义在 Workers 的对应 = 详情 `console_error!` 进运行时
//! 日志「wrangler dev/tail/控制台」，访客只见通用面）；handler 异常 → Err
//! 上抛（Workers 运行时 500 面，worker-macros respond_with_errors 同款语义）。

use worker::{event, Context, Env, Request, Response};

use crate::response::json_error;
use crate::{dispatch, state};

#[event(fetch)]
async fn main(req: Request, env: Env, _ctx: Context) -> worker::Result<Response> {
    let state = match state::init(&env) {
        Ok(state) => state,
        Err(msg) => {
            worker::console_error!("vviewer-worker: configuration rejected: {msg}");
            return json_error(500, "internal server error");
        }
    };
    dispatch::handle(req, &env, state).await
}
