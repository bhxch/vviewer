//! `#[event(fetch)]` 入口：状态装配（isolate 惰性单例）→ dispatch。
//!
//! 装配失败（VV_MOUNTS JSON/字段缺失等配置错误）→ 500 JSON（消息仅含字段
//! 名——build_mount/parse 错误面纪律）；handler 异常 → Err 上抛（Workers
//! 运行时 500 面，worker-macros respond_with_errors 同款语义）。

use worker::{event, Context, Env, Request, Response};

use crate::response::json_error;
use crate::{dispatch, state};

#[event(fetch)]
async fn main(req: Request, env: Env, _ctx: Context) -> worker::Result<Response> {
    let state = match state::init(&env) {
        Ok(state) => state,
        Err(msg) => return json_error(500, msg),
    };
    dispatch::handle(req, &env, state).await
}
