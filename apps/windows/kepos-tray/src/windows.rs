use std::ptr::{null, null_mut};
use std::thread;
use std::time::Duration;

use kepos_vpn::{Backend, BackendOptions, Command, StatePaths};
use tray_icon::{menu::{Menu, MenuEvent, MenuItem, PredefinedMenuItem}, Icon, TrayIconBuilder};
use windows_sys::Win32::Foundation::{GlobalFree, HWND};
use windows_sys::Win32::System::DataExchange::{CloseClipboard, EmptyClipboard, OpenClipboard, SetClipboardData};
use windows_sys::Win32::System::Memory::{GlobalAlloc, GlobalLock, GlobalUnlock, GMEM_MOVEABLE};
use windows_sys::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DestroyWindow, DispatchMessageW, MessageBoxW, PeekMessageW,
    TranslateMessage, IDYES, MB_ICONERROR, MB_ICONQUESTION, MB_OK, MB_YESNO, MSG,
    PM_REMOVE, WM_QUIT,
};

use crate::presentation;

const UNICODE_TEXT: u32 = 13;

pub fn run() -> Result<(), String> {
    let executable = std::env::current_exe().map_err(|error| error.to_string())?;
    let bundle = executable.parent().ok_or("Cannot find the Kepos folder")?.join("kepos-worklet.bundle");
    let paths = StatePaths::from_environment().map_err(|error| error.to_string())?;
    let mut backend = Backend::start(BackendOptions::new(paths, bundle)).map_err(|error| error.to_string())?;
    // The hidden owner lets Windows associate copied text with this app.
    let owner = unsafe { CreateWindowExW(0, wide("STATIC").as_ptr(), wide("Kepos VPN").as_ptr(), 0,
        0, 0, 0, 0, null_mut(), null_mut(), null_mut(), null()) };
    if owner.is_null() { return Err("Cannot create the Kepos tray window".into()); }

    let status = MenuItem::new("Kepos VPN: starting…", false, None);
    let detail = MenuItem::new("", false, None);
    let show_key = MenuItem::with_id("show-key", "View public key…", false, None);
    let copy = MenuItem::with_id("copy", "Copy public key", false, None);
    let pair = MenuItem::with_id("pair", "Pair with invitation…", false, None);
    let acknowledge = MenuItem::with_id("ack", "I checked the receiver…", false, None);
    let connect = MenuItem::with_id("connect", "Connect", false, None);
    let disconnect = MenuItem::with_id("disconnect", "Disconnect", false, None);
    let quit = MenuItem::with_id("quit", "Quit Kepos VPN", true, None);
    let menu = Menu::with_items(&[&status, &detail, &PredefinedMenuItem::separator(), &show_key, &copy,
        &pair, &acknowledge, &connect, &disconnect, &PredefinedMenuItem::separator(), &quit])
        .map_err(|error| error.to_string())?;
    let _tray = TrayIconBuilder::new().with_menu(Box::new(menu)).with_tooltip("Kepos VPN")
        .with_icon(icon()?).build().map_err(|error| error.to_string())?;

    'running: loop {
        let mut message: MSG = unsafe { std::mem::zeroed() };
        while unsafe { PeekMessageW(&mut message, null_mut(), 0, 0, PM_REMOVE) } != 0 {
            if message.message == WM_QUIT { break 'running; }
            unsafe { TranslateMessage(&message); DispatchMessageW(&message); }
        }
        let snapshot = backend.snapshot();
        let view = presentation::menu(&snapshot, backend.is_running());
        status.set_text(view.status);
        detail.set_text(view.detail.unwrap_or("Ready"));
        show_key.set_enabled(view.copy_key);
        copy.set_enabled(view.copy_key);
        pair.set_enabled(view.pair);
        acknowledge.set_enabled(view.acknowledge);
        connect.set_enabled(view.connect);
        disconnect.set_enabled(view.disconnect);

        while let Ok(event) = MenuEvent::receiver().try_recv() {
            // Check the latest state again so stale menu events cannot bypass the gate.
            let current = backend.snapshot();
            let current_view = presentation::menu(&current, backend.is_running());
            match event.id.0.as_str() {
                "show-key" if current_view.copy_key => {
                    if let Some(key) = current.public_key {
                        unsafe { MessageBoxW(owner, wide(&key).as_ptr(), wide("Kepos VPN public key").as_ptr(), MB_OK); }
                    }
                }
                "copy" if current_view.copy_key => {
                    if let Some(key) = current.public_key {
                        if let Err(error) = copy_text(owner, &key) { show_error(&error); }
                    }
                }
                "pair" if current_view.pair => match crate::invitation_dialog::show(owner) {
                    Ok(Some(invitation)) => {
                        // The state may change while the modal dialog is open.
                        if presentation::menu(&backend.snapshot(), backend.is_running()).pair {
                            send(&backend, Command::Pair(invitation));
                        } else {
                            show_error("Pairing is no longer available. Check Kepos VPN's status and try again.");
                        }
                    }
                    Ok(None) => {}
                    Err(error) => show_error(&error),
                },
                "ack" if current_view.acknowledge => {
                    if confirm(owner, "Have you checked the receiver's authorized devices using this device's public key? Only continue after checking.") {
                        send(&backend, Command::AcknowledgePairUnknown);
                    }
                }
                "connect" if current_view.connect => send(&backend, Command::Connect),
                "disconnect" if current_view.disconnect => send(&backend, Command::Disconnect),
                "quit" => break 'running,
                _ => {}
            }
        }
        thread::sleep(Duration::from_millis(100));
    }
    backend.shutdown();
    unsafe { DestroyWindow(owner); }
    Ok(())
}

fn send(backend: &Backend, command: Command) {
    if backend.try_command(command).is_err() {
        show_error("Kepos VPN has stopped. Restart the app to continue.");
    }
}

fn wide(text: &str) -> Vec<u16> { text.encode_utf16().chain(Some(0)).collect() }

pub fn show_error(text: &str) {
    unsafe { MessageBoxW(null_mut(), wide(text).as_ptr(), wide("Kepos VPN").as_ptr(), MB_OK | MB_ICONERROR); }
}

fn confirm(owner: HWND, text: &str) -> bool {
    unsafe { MessageBoxW(owner, wide(text).as_ptr(), wide("Kepos VPN").as_ptr(), MB_YESNO | MB_ICONQUESTION) == IDYES }
}

fn copy_text(owner: HWND, text: &str) -> Result<(), String> {
    unsafe {
        let data = wide(text);
        let memory = GlobalAlloc(GMEM_MOVEABLE, data.len() * 2);
        if memory.is_null() { return Err("Cannot copy the public key".into()); }
        let ptr = GlobalLock(memory).cast::<u16>();
        if ptr.is_null() { GlobalFree(memory); return Err("Cannot copy the public key".into()); }
        std::ptr::copy_nonoverlapping(data.as_ptr(), ptr, data.len());
        GlobalUnlock(memory);
        if OpenClipboard(owner) == 0 { GlobalFree(memory); return Err("Cannot open the clipboard".into()); }
        let success = EmptyClipboard() != 0 && !SetClipboardData(UNICODE_TEXT, memory).is_null();
        CloseClipboard();
        if !success { GlobalFree(memory); return Err("Cannot copy the public key".into()); }
        Ok(())
    }
}

fn icon() -> Result<Icon, String> {
    let mut rgba = Vec::with_capacity(16 * 16 * 4);
    for y in 0..16_i32 {
        for x in 0..16_i32 {
            let circle = (x - 7).pow(2) + (y - 7).pow(2) <= 49;
            let letter = (x == 5 && (4..=11).contains(&y)) ||
                ((6..=10).contains(&x) && (y == 7 - (x - 6) || y == 7 + (x - 6)));
            rgba.extend_from_slice(if !circle { &[0, 0, 0, 0] } else if letter {
                &[255, 255, 255, 255]
            } else { &[38, 105, 74, 255] });
        }
    }
    Icon::from_rgba(rgba, 16, 16).map_err(|error| error.to_string())
}
