use ckb_std::error::SysError;

/// Exit codes. 1-5 come from ckb-std syscalls; the rest are this contract's.
#[repr(i8)]
pub enum Error {
    IndexOutOfBound = 1,
    ItemMissing,
    LengthNotEnough,
    Encoding,
    SyscallFailed,
    // Contract errors
    /// Type script args must be the issuer's 32-byte lock hash.
    InvalidArgs,
    /// Outputs hold more tokens than inputs (and the issuer didn't sign).
    Amount,
    /// Amounts added up past u128::MAX.
    Overflow,
}

impl From<SysError> for Error {
    fn from(err: SysError) -> Self {
        match err {
            SysError::IndexOutOfBound => Self::IndexOutOfBound,
            SysError::ItemMissing => Self::ItemMissing,
            SysError::LengthNotEnough(_) => Self::LengthNotEnough,
            SysError::Encoding => Self::Encoding,
            _ => Self::SyscallFailed,
        }
    }
}
