fn main() {
    // Every IPC command the webview may call is listed here so the capability
    // file can grant them one by one (nothing is allowed implicitly).
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "get_snapshot",
            "log_drink",
            "undo_last",
            "delete_entry",
            "update_settings",
            "complete_onboarding",
            "snooze",
            "pause_today",
            "resume_reminders",
            "test_notification",
            "set_autostart",
            "confirm_tray",
            "export_json",
            "export_text",
            "import_pick",
            "import_confirm",
            "import_cancel",
            "reset_all",
            "mark_boot_shown",
            "dismiss_notice",
            "hide_window",
            "quit_app",
        ]),
    ))
    .expect("failed to run tauri-build");
}
