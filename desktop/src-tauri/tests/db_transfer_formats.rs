//! Standalone transfer harness: integration targets receive the Windows v6 common-controls manifest.
//! Source reuse also exercises injected XLSX limits without exposing a testing API to the WebView.
#![allow(dead_code)]
pub use nc_forge::{config, security, sql_export, state};
#[path = "../src/db_transfer.rs"]
mod db_transfer;
#[path = "../src/db_transfer_destination.rs"]
mod db_transfer_destination;
#[path = "../src/db_transfer_job.rs"]
mod db_transfer_job;
#[path = "../src/db_transfer_xlsx.rs"]
mod db_transfer_xlsx;
