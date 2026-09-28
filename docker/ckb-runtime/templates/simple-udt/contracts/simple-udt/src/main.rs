//! Simple UDT: a fungible token type script (the sUDT pattern, RFC 0025).
//!
//! Each token cell stores its amount as a u128, little endian, in the first
//! 16 bytes of its data. The type script's args hold the issuer's lock hash:
//!
//! - Owner mode: if any input is locked by the issuer's lock, anything goes
//!   (this is how new tokens are minted).
//! - Otherwise tokens can only move: the total amount in this token's output
//!   cells must not exceed the total in its input cells.

#![cfg_attr(not(any(feature = "library", test)), no_std)]
#![cfg_attr(not(test), no_main)]

#[cfg(any(feature = "library", test))]
extern crate alloc;

#[cfg(not(any(feature = "library", test)))]
ckb_std::entry!(program_entry);
#[cfg(not(any(feature = "library", test)))]
ckb_std::default_alloc!(16384, 1258306, 64);

#[path = "error.rs"]
mod error;

use ckb_std::{
    ckb_constants::Source,
    debug,
    high_level::{load_cell_data, load_cell_lock_hash, load_script, QueryIter},
};
use error::Error;

pub fn program_entry() -> i8 {
    match verify() {
        Ok(()) => 0,
        Err(err) => err as i8,
    }
}

fn verify() -> Result<(), Error> {
    let script = load_script()?;
    let args = script.args().raw_data();

    // args = the issuer's lock script hash
    if args.len() != 32 {
        return Err(Error::InvalidArgs);
    }

    let owner_mode = QueryIter::new(load_cell_lock_hash, Source::Input).any(|hash| hash[..] == args[..]);
    if owner_mode {
        debug!("owner mode: issuer signed the transaction");
        return Ok(());
    }

    let input_amount = sum_amounts(Source::GroupInput)?;
    let output_amount = sum_amounts(Source::GroupOutput)?;
    debug!("inputs {} -> outputs {}", input_amount, output_amount);

    if output_amount > input_amount {
        return Err(Error::Amount);
    }

    Ok(())
}

/// Total amount held by this token's cells in `source`.
fn sum_amounts(source: Source) -> Result<u128, Error> {
    let mut total: u128 = 0;

    for data in QueryIter::new(load_cell_data, source) {
        if data.len() < 16 {
            return Err(Error::Encoding);
        }

        let mut amount = [0u8; 16];
        amount.copy_from_slice(&data[..16]);
        total = total.checked_add(u128::from_le_bytes(amount)).ok_or(Error::Overflow)?;
    }

    Ok(total)
}
