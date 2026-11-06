//! Read-only SID evidence from the same already-opened object handle.
use std::io;
pub(super) fn owned_by_current_user_handle(
    handle: windows_sys::Win32::Foundation::HANDLE,
) -> io::Result<bool> {
    use windows_sys::Win32::{
        Foundation::{CloseHandle, HANDLE},
        Security::{
            EqualSid, GetAce, GetKernelObjectSecurity, GetSecurityDescriptorDacl,
            GetSecurityDescriptorOwner, GetTokenInformation, TokenOwner, TokenUser,
            ACCESS_ALLOWED_ACE, DACL_SECURITY_INFORMATION, OWNER_SECURITY_INFORMATION, TOKEN_OWNER,
            TOKEN_QUERY, TOKEN_USER,
        },
        System::{
            SystemServices::ACCESS_ALLOWED_ACE_TYPE,
            Threading::{GetCurrentProcess, OpenProcessToken},
        },
    };
    struct Token(HANDLE);
    impl Drop for Token {
        fn drop(&mut self) {
            unsafe {
                CloseHandle(self.0);
            }
        }
    }
    let mut raw = std::ptr::null_mut();
    // SAFETY: live process pseudo-handle, valid out pointer, read-only token access.
    if unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut raw) } == 0 {
        return Err(io::Error::last_os_error());
    }
    let token = Token(raw);
    let mut needed = 0;
    // The first query obtains a bounded byte count; usize buffers keep native struct alignment.
    unsafe {
        GetKernelObjectSecurity(
            handle,
            OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
            std::ptr::null_mut(),
            0,
            &mut needed,
        );
    }
    if needed == 0 || needed > 64 * 1024 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "invalid owner descriptor size",
        ));
    }
    let mut descriptor = vec![0usize; (needed as usize).div_ceil(std::mem::size_of::<usize>())];
    if unsafe {
        GetKernelObjectSecurity(
            handle,
            OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
            descriptor.as_mut_ptr().cast(),
            needed,
            &mut needed,
        )
    } == 0
    {
        return Err(io::Error::last_os_error());
    }
    let mut owner = std::ptr::null_mut();
    let mut defaulted = 0;
    if unsafe {
        GetSecurityDescriptorOwner(descriptor.as_mut_ptr().cast(), &mut owner, &mut defaulted)
    } == 0
        || owner.is_null()
    {
        return Err(io::Error::last_os_error());
    }
    for kind in [TokenUser, TokenOwner] {
        let mut needed = 0;
        unsafe {
            GetTokenInformation(token.0, kind, std::ptr::null_mut(), 0, &mut needed);
        }
        if needed == 0 || needed > 64 * 1024 {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "invalid token owner size",
            ));
        }
        let mut bytes = vec![0usize; (needed as usize).div_ceil(std::mem::size_of::<usize>())];
        if unsafe {
            GetTokenInformation(
                token.0,
                kind,
                bytes.as_mut_ptr().cast(),
                needed,
                &mut needed,
            )
        } == 0
        {
            return Err(io::Error::last_os_error());
        }
        // TokenOwner is Windows' effective default owner of objects created by this
        // token (including elevated accounts). It supplements the individual SID;
        // matching installId is still independently mandatory for directory moves.
        let sid = unsafe {
            if kind == TokenUser {
                (*(bytes.as_ptr().cast::<TOKEN_USER>())).User.Sid
            } else {
                (*(bytes.as_ptr().cast::<TOKEN_OWNER>())).Owner
            }
        };
        if !sid.is_null() && unsafe { EqualSid(owner, sid) } != 0 {
            if kind == TokenUser {
                return Ok(true);
            }
            // A shared default owner group alone does not prove individual-user ownership.
            let mut user_needed = 0;
            unsafe {
                GetTokenInformation(
                    token.0,
                    TokenUser,
                    std::ptr::null_mut(),
                    0,
                    &mut user_needed,
                );
            }
            if user_needed == 0 || user_needed > 64 * 1024 {
                return Ok(false);
            }
            let mut user =
                vec![0usize; (user_needed as usize).div_ceil(std::mem::size_of::<usize>())];
            if unsafe {
                GetTokenInformation(
                    token.0,
                    TokenUser,
                    user.as_mut_ptr().cast(),
                    user_needed,
                    &mut user_needed,
                )
            } == 0
            {
                return Err(io::Error::last_os_error());
            }
            let user_sid = unsafe { (*(user.as_ptr().cast::<TOKEN_USER>())).User.Sid };
            let mut present = 0;
            let mut dacl = std::ptr::null_mut();
            let mut defaulted = 0;
            if unsafe {
                GetSecurityDescriptorDacl(
                    descriptor.as_mut_ptr().cast(),
                    &mut present,
                    &mut dacl,
                    &mut defaulted,
                )
            } == 0
                || present == 0
                || dacl.is_null()
            {
                return Ok(false);
            }
            for index in 0..unsafe { (*dacl).AceCount } as u32 {
                let mut ace = std::ptr::null_mut();
                if unsafe { GetAce(dacl, index, &mut ace) } == 0 {
                    return Err(io::Error::last_os_error());
                }
                let allowed = ace.cast::<ACCESS_ALLOWED_ACE>();
                if unsafe { (*allowed).Header.AceType as u32 } != ACCESS_ALLOWED_ACE_TYPE {
                    continue;
                }
                let ace_sid = unsafe { std::ptr::addr_of!((*allowed).SidStart).cast_mut().cast() };
                let mask = unsafe { (*allowed).Mask };
                if mask & (0x1000_0000 | 0x4000_0000 | 0x0000_0002) != 0
                    && unsafe { EqualSid(user_sid, ace_sid) } != 0
                {
                    return Ok(true);
                }
            }
            return Ok(false);
        }
    }
    Ok(false)
}
