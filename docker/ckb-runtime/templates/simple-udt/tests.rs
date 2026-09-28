//! Tests for the simple-udt token. Run with `make test` (after `make build`).
//!
//! Wallets are simulated with the always-success lock and different args, so
//! each "user" has a distinct lock hash.

use crate::Loader;
use ckb_testtool::builtin::ALWAYS_SUCCESS;
use ckb_testtool::ckb_types::{bytes::Bytes, core::TransactionBuilder, packed::*, prelude::*};
use ckb_testtool::context::Context;

const MAX_CYCLES: u64 = 10_000_000;

// Exit codes from contracts/simple-udt/src/error.rs
const ERROR_AMOUNT: i8 = 7;

struct Setup {
    context: Context,
    issuer_lock: Script,
    alice_lock: Script,
    token: Script,
}

fn setup() -> Setup {
    let mut context = Context::default();
    let _ = Loader::default();

    let udt_out_point = context.deploy_cell_by_name("simple-udt");
    let lock_out_point = context.deploy_cell(ALWAYS_SUCCESS.clone());

    let issuer_lock = context.build_script(&lock_out_point, Bytes::from(vec![1])).expect("issuer lock");
    let alice_lock = context.build_script(&lock_out_point, Bytes::from(vec![2])).expect("alice lock");

    // The token's type script args = the issuer's lock hash.
    let token = context
        .build_script(&udt_out_point, issuer_lock.calc_script_hash().as_bytes())
        .expect("token script");

    Setup { context, issuer_lock, alice_lock, token }
}

fn amount(value: u128) -> Bytes {
    Bytes::from(value.to_le_bytes().to_vec())
}

fn token_cell(setup: &Setup, lock: &Script) -> CellOutput {
    CellOutput::new_builder()
        .capacity(1_000u64)
        .lock(lock.clone())
        .type_(Some(setup.token.clone()))
        .build()
}

fn input(out_point: OutPoint) -> CellInput {
    CellInput::new_builder().previous_output(out_point).build()
}

fn assert_error(result: Result<u64, ckb_testtool::ckb_error::Error>, code: i8) {
    let err = result.expect_err("transaction should fail").to_string();
    assert!(err.contains(&format!("error code {code} ")), "expected error code {code}, got: {err}");
}

#[test]
fn issuer_can_mint() {
    let mut s = setup();
    let issuer_cell = s.context.create_cell(
        CellOutput::new_builder().capacity(1_000u64).lock(s.issuer_lock.clone()).build(),
        Bytes::new(),
    );

    let tx = TransactionBuilder::default()
        .input(input(issuer_cell))
        .output(token_cell(&s, &s.alice_lock))
        .output_data(amount(1_000).pack())
        .build();
    let tx = s.context.complete_tx(tx);

    let cycles = s.context.verify_tx(&tx, MAX_CYCLES).expect("mint by issuer");
    println!("consume cycles: {cycles}");
}

#[test]
fn holder_can_transfer() {
    let mut s = setup();
    let balance = s.context.create_cell(token_cell(&s, &s.alice_lock), amount(1_000));

    let tx = TransactionBuilder::default()
        .input(input(balance))
        .outputs(vec![token_cell(&s, &s.alice_lock), token_cell(&s, &s.issuer_lock)])
        .outputs_data(vec![amount(600), amount(400)].pack())
        .build();
    let tx = s.context.complete_tx(tx);

    let cycles = s.context.verify_tx(&tx, MAX_CYCLES).expect("transfer");
    println!("consume cycles: {cycles}");
}

#[test]
fn transfer_cannot_create_tokens() {
    let mut s = setup();
    let balance = s.context.create_cell(token_cell(&s, &s.alice_lock), amount(1_000));

    let tx = TransactionBuilder::default()
        .input(input(balance))
        .outputs(vec![token_cell(&s, &s.alice_lock), token_cell(&s, &s.alice_lock)])
        .outputs_data(vec![amount(800), amount(300)].pack())
        .build();
    let tx = s.context.complete_tx(tx);

    assert_error(s.context.verify_tx(&tx, MAX_CYCLES), ERROR_AMOUNT);
}

#[test]
fn only_issuer_can_mint() {
    let mut s = setup();
    let alice_cell = s.context.create_cell(
        CellOutput::new_builder().capacity(1_000u64).lock(s.alice_lock.clone()).build(),
        Bytes::new(),
    );

    let tx = TransactionBuilder::default()
        .input(input(alice_cell))
        .output(token_cell(&s, &s.alice_lock))
        .output_data(amount(100).pack())
        .build();
    let tx = s.context.complete_tx(tx);

    assert_error(s.context.verify_tx(&tx, MAX_CYCLES), ERROR_AMOUNT);
}
