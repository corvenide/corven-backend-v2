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
    /// Lock args must be 32-byte owner lock hash + 8-byte unlock block.
    InvalidArgs,
    /// No input is locked by the owner's lock.
    NotOwner,
    /// `since` must be an absolute block number.
    InvalidSince,
    /// `since` is before the unlock block.
    TooEarly,
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
