//! Tests for the time-lock contract. Run with `make test` (after `make build`).
//!
//! The owner's wallet is simulated with the always-success lock; in a real
//! transaction it would be their secp256k1 lock, which checks a signature.

use crate::Loader;
use ckb_testtool::builtin::ALWAYS_SUCCESS;
use ckb_testtool::ckb_types::{bytes::Bytes, core::TransactionBuilder, packed::*, prelude::*};
use ckb_testtool::context::Context;

const MAX_CYCLES: u64 = 10_000_000;
const UNLOCK_BLOCK: u64 = 1_000;

// Exit codes from contracts/time-lock/src/error.rs
const ERROR_NOT_OWNER: i8 = 7;
const ERROR_INVALID_SINCE: i8 = 8;
const ERROR_TOO_EARLY: i8 = 9;

struct Setup {
    context: Context,
    owner_lock: Script,
    stranger_lock: Script,
    time_lock: Script,
}

fn setup() -> Setup {
    let mut context = Context::default();
    let _ = Loader::default();

    let time_lock_out_point = context.deploy_cell_by_name("time-lock");
    let wallet_out_point = context.deploy_cell(ALWAYS_SUCCESS.clone());

    let owner_lock = context.build_script(&wallet_out_point, Bytes::from(vec![1])).expect("owner lock");
    let stranger_lock = context.build_script(&wallet_out_point, Bytes::from(vec![2])).expect("stranger lock");

    // args = owner lock hash (32 bytes) + unlock block number (u64 LE)
    let mut args = owner_lock.calc_script_hash().as_bytes().to_vec();
    args.extend_from_slice(&UNLOCK_BLOCK.to_le_bytes());
    let time_lock = context.build_script(&time_lock_out_point, Bytes::from(args)).expect("time lock");

    Setup { context, owner_lock, stranger_lock, time_lock }
}

fn cell(lock: &Script) -> CellOutput {
    CellOutput::new_builder().capacity(1_000u64).lock(lock.clone()).build()
}

/// Spends a time-locked cell with `since`, authorized by a cell under `authorizer`.
fn spend(s: &mut Setup, since: u64, authorizer: Script) -> Result<u64, ckb_testtool::ckb_error::Error> {
    let locked = s.context.create_cell(cell(&s.time_lock), Bytes::new());
    let wallet = s.context.create_cell(cell(&authorizer), Bytes::new());

    let tx = TransactionBuilder::default()
        .input(CellInput::new_builder().previous_output(locked).since(since).build())
        .input(CellInput::new_builder().previous_output(wallet).build())
        .output(cell(&s.owner_lock))
        .output_data(Bytes::new().pack())
        .build();
    let tx = s.context.complete_tx(tx);
    s.context.verify_tx(&tx, MAX_CYCLES)
}

fn assert_error(result: Result<u64, ckb_testtool::ckb_error::Error>, code: i8) {
    let err = result.expect_err("transaction should fail").to_string();
    assert!(err.contains(&format!("error code {code} ")), "expected error code {code}, got: {err}");
}

#[test]
fn owner_can_spend_after_unlock_block() {
    let mut s = setup();
    let owner = s.owner_lock.clone();
    let cycles = spend(&mut s, UNLOCK_BLOCK, owner).expect("unlocked");
    println!("consume cycles: {cycles}");
}

#[test]
fn cannot_spend_before_unlock_block() {
    let mut s = setup();
    let owner = s.owner_lock.clone();
    assert_error(spend(&mut s, UNLOCK_BLOCK - 1, owner), ERROR_TOO_EARLY);
}

#[test]
fn stranger_cannot_spend() {
    let mut s = setup();
    let stranger = s.stranger_lock.clone();
    assert_error(spend(&mut s, UNLOCK_BLOCK, stranger), ERROR_NOT_OWNER);
}

#[test]
fn since_must_be_an_absolute_block_number() {
    let mut s = setup();
    let owner = s.owner_lock.clone();
    // Relative flag set (highest bit).
    assert_error(spend(&mut s, (1u64 << 63) | UNLOCK_BLOCK, owner), ERROR_INVALID_SINCE);
}
