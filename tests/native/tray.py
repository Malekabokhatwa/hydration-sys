#!/usr/bin/env python3
"""Drive a StatusNotifierItem's dbusmenu like a tray host would.
usage: tray.py list | tray.py click <label-substring>"""
import sys
import gi
gi.require_version("Gio", "2.0")
from gi.repository import Gio, GLib

bus = Gio.bus_get_sync(Gio.BusType.SESSION)

def call(dest, path, iface, method, args=None, reply=None):
    return bus.call_sync(dest, path, iface, method, args, GLib.VariantType(reply) if reply else None, 0, 5000, None)

def items():
    v = call("org.kde.StatusNotifierWatcher", "/StatusNotifierWatcher", "org.freedesktop.DBus.Properties", "Get",
             GLib.Variant("(ss)", ("org.kde.StatusNotifierWatcher", "RegisteredStatusNotifierItems")), "(v)")
    return v.unpack()[0]

def find_item():
    for it in items():
        # "<bus name>/<object path>" (either a unique :1.x name or a well-known one)
        dest, _, path = it.partition("/")
        path = "/" + path if path else "/StatusNotifierItem"
        if not Gio.dbus_is_name(dest):
            continue
        try:
            title = call(dest, path, "org.freedesktop.DBus.Properties", "Get", GLib.Variant("(ss)", ("org.kde.StatusNotifierItem", "Id")), "(v)").unpack()[0]
            menu = call(dest, path, "org.freedesktop.DBus.Properties", "Get", GLib.Variant("(ss)", ("org.kde.StatusNotifierItem", "Menu")), "(v)").unpack()[0]
        except (GLib.Error, AttributeError):
            continue
        if "tray_icon_tray_app_main" in path or "hydration" in str(title).lower():
            return dest, menu, title
    sys.exit("no hydration tray item registered")

def flatten(node, out):
    nid, props, children = node
    if "label" in props:
        out.append((nid, props["label"], props.get("enabled", True), props.get("toggle-state", -1)))
    for c in children:
        flatten(c, out)
    return out

dest, menu, title = find_item()
layout = call(dest, menu, "com.canonical.dbusmenu", "GetLayout", GLib.Variant("(iias)", (0, -1, [])), "(u(ia{sv}av))").unpack()[1]
entries = flatten(layout, [])
if sys.argv[1] == "list":
    print(f"item id={title}")
    for nid, label, enabled, toggle in entries:
        print(f"{nid}\t{'on ' if enabled else 'off'}\t{toggle}\t{label}")
elif sys.argv[1] == "click":
    want = sys.argv[2].lower()
    for nid, label, enabled, _ in entries:
        if want in label.lower().replace("_", ""):
            call(dest, menu, "com.canonical.dbusmenu", "Event", GLib.Variant("(isvu)", (nid, "clicked", GLib.Variant("i", 0), 0)))
            print(f"clicked {label}")
            break
    else:
        sys.exit(f"no menu item matching {want!r}")
