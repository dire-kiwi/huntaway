//! A minimal pseudo-terminal: run a command on the slave side, read and write the master
//! side asynchronously, and resize it.

use std::io;
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
use std::process::Stdio;

use anyhow::{Context, Result};
use tokio::io::unix::AsyncFd;
use tokio::process::{Child, Command};

pub struct Pty {
    master: AsyncFd<OwnedFd>,
}

fn winsize(cols: u16, rows: u16) -> libc::winsize {
    libc::winsize { ws_row: rows.max(1), ws_col: cols.max(1), ws_xpixel: 0, ws_ypixel: 0 }
}

fn cvt(r: libc::c_int) -> io::Result<libc::c_int> {
    if r < 0 { Err(io::Error::last_os_error()) } else { Ok(r) }
}

impl Pty {
    /// Start `cmd` as the session leader of a new terminal of the given size.
    pub fn spawn(mut cmd: Command, cols: u16, rows: u16) -> Result<(Pty, Child)> {
        let (mut m, mut s) = (0, 0);
        // macOS's openpty takes *mut termios and winsize, Linux's *const; mutable pointers suit both.
        let mut ws = winsize(cols, rows);
        cvt(unsafe { libc::openpty(&mut m, &mut s, std::ptr::null_mut(), std::ptr::null_mut(), &mut ws) }).context("openpty")?;
        let (master, slave) = unsafe { (OwnedFd::from_raw_fd(m), OwnedFd::from_raw_fd(s)) };
        for fd in [m, s] {
            cvt(unsafe { libc::fcntl(fd, libc::F_SETFD, libc::FD_CLOEXEC) })?;
        }
        cmd.stdin(Stdio::from(slave.try_clone()?)).stdout(Stdio::from(slave.try_clone()?)).stderr(Stdio::from(slave));
        unsafe {
            cmd.pre_exec(|| {
                // New session with the terminal (now on fd 0) as its controlling tty.
                cvt(libc::setsid())?;
                cvt(libc::ioctl(0, libc::TIOCSCTTY as _, 0))?;
                Ok(())
            });
        }
        let child = cmd.kill_on_drop(true).spawn().context("starting terminal process")?;
        let flags = cvt(unsafe { libc::fcntl(m, libc::F_GETFL) })?;
        cvt(unsafe { libc::fcntl(m, libc::F_SETFL, flags | libc::O_NONBLOCK) })?;
        // SAFETY: the OwnedFd keeps the descriptor open for as long as the AsyncFd owns it.
        let master = unsafe { AsyncFd::register(master) }.map_err(|e| e.into_parts().1)?;
        Ok((Pty { master }, child))
    }

    /// Read output. Returns 0 once the other side has closed.
    pub async fn read(&self, buf: &mut [u8]) -> io::Result<usize> {
        loop {
            let mut guard = self.master.readable().await?;
            match guard.try_io(|fd| cvt(unsafe { libc::read(fd.as_raw_fd(), buf.as_mut_ptr().cast(), buf.len()) as libc::c_int })) {
                Ok(Ok(n)) => return Ok(n as usize),
                // Linux reports a hung-up slave as EIO.
                Ok(Err(e)) if e.raw_os_error() == Some(libc::EIO) => return Ok(0),
                Ok(Err(e)) => return Err(e),
                Err(_would_block) => continue,
            }
        }
    }

    pub async fn write_all(&self, mut data: &[u8]) -> io::Result<()> {
        while !data.is_empty() {
            let mut guard = self.master.writable().await?;
            match guard.try_io(|fd| cvt(unsafe { libc::write(fd.as_raw_fd(), data.as_ptr().cast(), data.len()) as libc::c_int })) {
                Ok(Ok(n)) => data = &data[n as usize..],
                Ok(Err(e)) => return Err(e),
                Err(_would_block) => continue,
            }
        }
        Ok(())
    }

    pub fn resize(&self, cols: u16, rows: u16) -> io::Result<()> {
        let ws = winsize(cols, rows);
        cvt(unsafe { libc::ioctl(self.master.as_raw_fd(), libc::TIOCSWINSZ as _, &ws) }).map(|_| ())
    }
}
