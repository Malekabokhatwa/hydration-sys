// Prevents an extra console window on Windows in release.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // WebKitGTK's DMA-BUF renderer can stop repainting on hybrid Intel/NVIDIA
    // Wayland setups: input and the DOM keep working, but the window shows a
    // stale frame until it is resized. The shared-memory path is plenty for
    // this small UI. Set before any thread starts; an explicit value wins.
    #[cfg(target_os = "linux")]
    if std::env::var_os("WEBKIT_DISABLE_DMABUF_RENDERER").is_none() {
        std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
    }
    hydration_sys_lib::run()
}
