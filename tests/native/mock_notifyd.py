#!/usr/bin/env python3
"""Mock org.freedesktop.Notifications + StatusNotifierWatcher for the private
test bus. Logs every Notify call as a JSON line and can fire ActionInvoked
when a file named `invoke-<key>` appears in the control directory."""
import json, os, sys, time
import gi
gi.require_version("Gio", "2.0")
from gi.repository import Gio, GLib

LOG = sys.argv[1]
CTRL = sys.argv[2]
XML = """
<node>
 <interface name="org.freedesktop.Notifications">
  <method name="GetCapabilities"><arg type="as" direction="out"/></method>
  <method name="GetServerInformation"><arg type="s" direction="out"/><arg type="s" direction="out"/><arg type="s" direction="out"/><arg type="s" direction="out"/></method>
  <method name="Notify">
   <arg type="s" direction="in"/><arg type="u" direction="in"/><arg type="s" direction="in"/><arg type="s" direction="in"/>
   <arg type="s" direction="in"/><arg type="as" direction="in"/><arg type="a{sv}" direction="in"/><arg type="i" direction="in"/>
   <arg type="u" direction="out"/>
  </method>
  <method name="CloseNotification"><arg type="u" direction="in"/></method>
  <signal name="ActionInvoked"><arg type="u"/><arg type="s"/></signal>
  <signal name="NotificationClosed"><arg type="u"/><arg type="u"/></signal>
 </interface>
 <interface name="org.kde.StatusNotifierWatcher">
  <method name="RegisterStatusNotifierItem"><arg type="s" direction="in"/></method>
  <method name="RegisterStatusNotifierHost"><arg type="s" direction="in"/></method>
  <property name="RegisteredStatusNotifierItems" type="as" access="read"/>
  <property name="IsStatusNotifierHostRegistered" type="b" access="read"/>
  <property name="ProtocolVersion" type="i" access="read"/>
  <signal name="StatusNotifierItemRegistered"><arg type="s"/></signal>
 </interface>
</node>"""
node = Gio.DBusNodeInfo.new_for_xml(XML)
state = {"next": 1, "last": 0, "conn": None, "items": []}

def log(obj):
    with open(LOG, "a") as f:
        f.write(json.dumps(obj) + "\n")

def on_call(conn, sender, path, iface, method, params, inv):
    if method == "GetCapabilities":
        inv.return_value(GLib.Variant("(as)", (["actions", "body", "persistence"],)))
    elif method == "GetServerInformation":
        inv.return_value(GLib.Variant("(ssss)", ("mock-notifyd", "test", "1.0", "1.2")))
    elif method == "Notify":
        app, replaces, icon, summary, body, actions, hints, timeout = params.unpack()
        nid = replaces or state["next"]
        if not replaces:
            state["next"] += 1
        state["last"] = nid
        log({"t": time.time(), "id": nid, "replaces": replaces, "app": app, "summary": summary, "body": body, "actions": actions, "icon": icon, "hints": sorted(hints.keys())})
        inv.return_value(GLib.Variant("(u)", (nid,)))
    elif method == "CloseNotification":
        inv.return_value(None)
    elif method == "RegisterStatusNotifierItem":
        item = params.unpack()[0]
        state["items"].append(sender + item if item.startswith("/") else item)
        log({"t": time.time(), "tray_registered": item, "sender": sender})
        inv.return_value(None)
    else:
        inv.return_value(None)

def get_prop(conn, sender, path, iface, prop):
    if prop == "RegisteredStatusNotifierItems":
        return GLib.Variant("as", state["items"])
    if prop == "IsStatusNotifierHostRegistered":
        return GLib.Variant("b", True)
    return GLib.Variant("i", 0)

def poll():
    for name in os.listdir(CTRL):
        if name.startswith("invoke-") and state["conn"]:
            key = name[len("invoke-"):]
            os.remove(os.path.join(CTRL, name))
            state["conn"].emit_signal(None, "/org/freedesktop/Notifications", "org.freedesktop.Notifications", "ActionInvoked", GLib.Variant("(us)", (state["last"], key)))
            log({"t": time.time(), "invoked": key, "id": state["last"]})
    return True

def on_bus(conn, name):
    state["conn"] = conn
    conn.register_object("/org/freedesktop/Notifications", node.interfaces[0], on_call, None, None)
    conn.register_object("/StatusNotifierWatcher", node.interfaces[1], on_call, get_prop, None)

Gio.bus_own_name(Gio.BusType.SESSION, "org.freedesktop.Notifications", 0, on_bus, None, None)
Gio.bus_own_name(Gio.BusType.SESSION, "org.kde.StatusNotifierWatcher", 0, None, None, None)
GLib.timeout_add(200, poll)
log({"t": time.time(), "ready": True})
GLib.MainLoop().run()
