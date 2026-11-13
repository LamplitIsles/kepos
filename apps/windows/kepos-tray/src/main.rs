#![cfg_attr(windows, windows_subsystem = "windows")]

mod presentation;

#[cfg(windows)]
mod windows;

#[cfg(windows)]
mod invitation_dialog;

#[cfg(windows)]
fn main() {
    if let Err(error) = windows::run() {
        windows::show_error(&error);
    }
}

#[cfg(not(windows))]
fn main() {
    eprintln!("Kepos tray is available on Windows.");
}
