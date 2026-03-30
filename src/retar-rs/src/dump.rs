//! Retar compat dump — TS と同じフォーマットで中間結果を出力
//! フォーマット: 関数名\t{キーソート済みJSON}
//!
//! feature "dump" 有効時のみコード生成。無効時はモジュールが空になる。

#![cfg_attr(not(feature = "dump"), allow(dead_code, unused_imports))]

#[cfg(feature = "dump")]
use std::cell::RefCell;
#[cfg(feature = "dump")]
use crate::possibilities::Possibilities;

#[cfg(feature = "dump")]
thread_local! {
    static ENABLED: RefCell<bool> = RefCell::new(false);
    static BUFFER: RefCell<Vec<String>> = RefCell::new(Vec::new());
}

#[cfg(feature = "dump")]
pub fn enable() {
    ENABLED.with(|e| *e.borrow_mut() = true);
}

#[cfg(feature = "dump")]
pub fn disable() {
    ENABLED.with(|e| *e.borrow_mut() = false);
}

#[cfg(feature = "dump")]
pub fn reset() {
    BUFFER.with(|b| b.borrow_mut().clear());
}

#[cfg(feature = "dump")]
pub fn get_dump() -> Vec<String> {
    BUFFER.with(|b| b.borrow().clone())
}

#[cfg(feature = "dump")]
fn is_enabled() -> bool {
    ENABLED.with(|e| *e.borrow())
}

#[cfg(feature = "dump")]
fn emit(fn_name: &str, poss: &Possibilities) {
    if !is_enabled() { return; }
    let mut parts: Vec<String> = Vec::new();
    for i in 1..poss.possibilities.len() {
        parts.push(format!("\"{}\":{}", i, poss.possibilities[i]));
    }
    let json = format!("{{{}}}", parts.join(","));
    let line = format!("{}\t{}", fn_name, json);
    BUFFER.with(|b| b.borrow_mut().push(line));
}

#[cfg(feature = "dump")]
fn emit_none(fn_name: &str) {
    if !is_enabled() { return; }
    let line = format!("{}\t{{\"result\":\"none\"}}", fn_name);
    BUFFER.with(|b| b.borrow_mut().push(line));
}

#[cfg(feature = "dump")]
pub fn finalize_pre(possibilities: &Possibilities) {
    emit("finalize", possibilities);
}

#[cfg(feature = "dump")]
pub fn solve_result(result: Option<&Possibilities>) {
    match result {
        Some(p) => emit("solve_possibilities", p),
        None => emit_none("solve_possibilities"),
    }
}

#[cfg(feature = "dump")]
pub fn analyze_result(conclusions: &Possibilities) {
    emit("analyze", conclusions);
}
