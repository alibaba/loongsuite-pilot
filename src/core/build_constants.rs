//! Compile-time stand-in for `__PROPRIETARY_BUILD__`.
//!
//! The TypeScript bundle replaces the global at build time. The Rust crate
//! uses the `proprietary` feature for the same split.

pub const PROPRIETARY_BUILD: bool = cfg!(feature = "proprietary");
