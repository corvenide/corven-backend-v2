//! Time lock: cells that only their owner can spend, and only after a block.
//!
//! Lock args (40 bytes):
//!   0..32   the owner's lock script hash
//!   32..40  unlock block number (u64, little endian)
//!
//! A cell under this lock can be spent when:
//! - the owner authorizes the transaction: some input is locked by the owner's
//!   own lock (e.g. their secp256k1 lock, which checks their signature), and
//! - each input under this lock sets `since` to an absolute block number at or
//!   after the unlock block. CKB itself enforces `since`, so the transaction
//!   can't be committed earlier.

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
    high_level::{load_cell_lock_hash, load_input_since, load_script, QueryIter},
};
use error::Error;

/// `since` flags live in the top byte; 0 = absolute block number.
const SINCE_FLAGS_MASK: u64 = 0xff00_0000_0000_0000;
const SINCE_VALUE_MASK: u64 = 0x00ff_ffff_ffff_ffff;

pub fn program_entry() -> i8 {
    match verify() {
        Ok(()) => 0,
        Err(err) => err as i8,
    }
}

fn verify() -> Result<(), Error> {
    let script = load_script()?;
    let args = script.args().raw_data();

    if args.len() != 40 {
        return Err(Error::InvalidArgs);
    }

    let owner_lock_hash = &args[..32];
    let mut unlock = [0u8; 8];
    unlock.copy_from_slice(&args[32..40]);
    let unlock_block = u64::from_le_bytes(unlock);

    let owner_signed = QueryIter::new(load_cell_lock_hash, Source::Input).any(|hash| hash[..] == owner_lock_hash[..]);
    if !owner_signed {
        return Err(Error::NotOwner);
    }

    for since in QueryIter::new(load_input_since, Source::GroupInput) {
        if since & SINCE_FLAGS_MASK != 0 {
            return Err(Error::InvalidSince);
        }
        if since & SINCE_VALUE_MASK < unlock_block {
            debug!("since block {} is before unlock block {}", since & SINCE_VALUE_MASK, unlock_block);
            return Err(Error::TooEarly);
        }
    }

    Ok(())
}
