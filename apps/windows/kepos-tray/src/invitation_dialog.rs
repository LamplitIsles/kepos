use std::ptr::null_mut;

use windows_sys::Win32::Foundation::{HWND, LPARAM, WPARAM};
use windows_sys::Win32::UI::WindowsAndMessaging::{
    DialogBoxIndirectParamW, EndDialog, GetDlgItemTextW, GetWindowLongPtrW, MessageBoxW,
    SendDlgItemMessageW, SetWindowLongPtrW, BS_DEFPUSHBUTTON, DLGTEMPLATE, DS_CENTER,
    DS_MODALFRAME, DS_SETFONT, ES_AUTOHSCROLL, GWLP_USERDATA, IDCANCEL, IDOK, MB_ICONERROR, MB_OK,
    WM_CLOSE, WM_COMMAND, WM_INITDIALOG, WS_BORDER, WS_CAPTION, WS_CHILD, WS_POPUP, WS_SYSMENU,
    WS_TABSTOP, WS_VISIBLE,
};

const INVITATION_EDIT: i32 = 100;
const EM_LIMITTEXT: u32 = 0x00c5;
const MAX_INPUT_UNITS: usize = 1024;

/// Display a native modal dialog without reading the clipboard automatically.
pub fn show(owner: HWND) -> Result<Option<String>, String> {
    let template = dialog_template();
    let mut invitation: Option<String> = None;
    let result = unsafe {
        DialogBoxIndirectParamW(
            null_mut(),
            template.as_ptr().cast::<DLGTEMPLATE>(),
            owner,
            Some(dialog_proc),
            (&mut invitation as *mut Option<String>) as LPARAM,
        )
    };
    if result == -1 {
        Err("Cannot open the invitation window.".into())
    } else {
        Ok(invitation)
    }
}

unsafe extern "system" fn dialog_proc(
    window: HWND,
    message: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> isize {
    match message {
        WM_INITDIALOG => {
            SetWindowLongPtrW(window, GWLP_USERDATA, lparam);
            SendDlgItemMessageW(window, INVITATION_EDIT, EM_LIMITTEXT, MAX_INPUT_UNITS, 0);
            1
        }
        WM_COMMAND => match (wparam & 0xffff) as i32 {
            IDOK => {
                let mut input = [0u16; MAX_INPUT_UNITS + 1];
                let length = GetDlgItemTextW(
                    window,
                    INVITATION_EDIT,
                    input.as_mut_ptr(),
                    input.len() as i32,
                ) as usize;
                let invitation = String::from_utf16(&input[..length]).ok();
                let invitation = invitation.as_deref().map(str::trim).unwrap_or("");
                if !invitation.starts_with("kepos1:") || invitation.len() > 256 {
                    MessageBoxW(
                        window,
                        wide("Enter a valid Kepos invitation.").as_ptr(),
                        wide("Kepos VPN").as_ptr(),
                        MB_OK | MB_ICONERROR,
                    );
                    return 1;
                }
                let output = GetWindowLongPtrW(window, GWLP_USERDATA) as *mut Option<String>;
                if !output.is_null() {
                    *output = Some(invitation.to_owned());
                }
                EndDialog(window, IDOK as isize);
                1
            }
            IDCANCEL => {
                EndDialog(window, IDCANCEL as isize);
                1
            }
            _ => 0,
        },
        WM_CLOSE => {
            EndDialog(window, IDCANCEL as isize);
            1
        }
        _ => 0,
    }
}

fn wide(text: &str) -> Vec<u16> {
    text.encode_utf16().chain(Some(0)).collect()
}

/// Standard in-memory Win32 dialog template, aligned to DWORD boundaries.
fn dialog_template() -> Vec<u32> {
    let mut words = Vec::<u16>::new();
    fn dword(words: &mut Vec<u16>, value: u32) {
        words.push(value as u16);
        words.push((value >> 16) as u16);
    }
    fn string(words: &mut Vec<u16>, value: &str) {
        words.extend(value.encode_utf16());
        words.push(0);
    }
    fn control(words: &mut Vec<u16>, style: u32, pos: [u16; 4], id: u16, class: u16, title: &str) {
        if words.len() % 2 != 0 {
            words.push(0);
        }
        dword(words, style);
        dword(words, 0);
        words.extend(pos);
        words.push(id);
        words.extend([0xffff, class]);
        string(words, title);
        words.push(0); // no creation data
    }

    dword(
        &mut words,
        WS_POPUP
            | WS_VISIBLE
            | WS_CAPTION
            | WS_SYSMENU
            | DS_MODALFRAME as u32
            | DS_SETFONT as u32
            | DS_CENTER as u32,
    );
    dword(&mut words, 0);
    words.extend([4, 0, 0, 270, 88]); // four controls; x, y, width, height
    words.extend([0, 0]); // no menu or custom window class
    string(&mut words, "Pair with receiver");
    words.push(9);
    string(&mut words, "Segoe UI");

    let child = WS_CHILD | WS_VISIBLE;
    control(
        &mut words,
        child,
        [10, 10, 250, 12],
        101,
        0x0082,
        "Paste or enter the invitation:",
    );
    control(
        &mut words,
        child | WS_BORDER | WS_TABSTOP | ES_AUTOHSCROLL as u32,
        [10, 25, 250, 15],
        INVITATION_EDIT as u16,
        0x0081,
        "",
    );
    control(
        &mut words,
        child | WS_TABSTOP | BS_DEFPUSHBUTTON as u32,
        [149, 58, 52, 16],
        IDOK as u16,
        0x0080,
        "Pair",
    );
    control(
        &mut words,
        child | WS_TABSTOP,
        [208, 58, 52, 16],
        IDCANCEL as u16,
        0x0080,
        "Cancel",
    );

    if words.len() % 2 != 0 {
        words.push(0);
    }
    words
        .chunks_exact(2)
        .map(|pair| u32::from(pair[0]) | (u32::from(pair[1]) << 16))
        .collect()
}
