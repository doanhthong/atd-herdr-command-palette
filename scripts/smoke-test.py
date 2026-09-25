#!/usr/bin/env python3
"""Smoke-test src/palette.js by driving it through a real pty.

Popups have no pane ID and aren't reachable through pane.* APIs (see the
Herdr plugin docs), so there's no way to script keystrokes into a *running
popup* via the socket. This spawns `node src/palette.js` directly instead,
attached to a real pseudo-terminal, with the same HERDR_ENV / HERDR_SOCKET_PATH
env vars Herdr would inject — exercising the exact same code path a popup
would run, against your live Herdr server.

Run from the repo root, inside a Herdr pane (so HERDR_SOCKET_PATH is already
set) or with it exported manually:

    python3 scripts/smoke-test.py

Requires only the Python 3 standard library.
"""

import os
import re
import select
import subprocess
import sys
import time

ANSI_RE = re.compile(rb"\x1b\[[0-9;?]*[A-Za-z]")


def strip(b):
    return ANSI_RE.sub(b"", b).decode("utf8", "replace")


def run(name, keys_with_delays, total_timeout=6):
    print(f"\n=== {name} ===")
    import pty

    master, slave = pty.openpty()
    env = dict(os.environ)
    env["HERDR_ENV"] = "1"
    env.setdefault("HERDR_SOCKET_PATH", os.path.expanduser("~/.config/herdr/herdr.sock"))
    env["HERDR_PLUGIN_CONTEXT_JSON"] = "{}"
    repo_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    proc = subprocess.Popen(
        ["node", "src/palette.js"],
        stdin=slave, stdout=slave, stderr=slave,
        cwd=repo_root, env=env, close_fds=True,
    )
    os.close(slave)
    output = b""
    start = time.time()
    ki = 0
    next_send = time.time() + 0.3
    while time.time() - start < total_timeout:
        if proc.poll() is not None:
            break
        r, _, _ = select.select([master], [], [], 0.1)
        if master in r:
            try:
                chunk = os.read(master, 65536)
            except OSError:
                break
            if not chunk:
                break
            output += chunk
        if ki < len(keys_with_delays) and time.time() >= next_send:
            data, delay = keys_with_delays[ki]
            os.write(master, data.encode())
            ki += 1
            next_send = time.time() + delay
    time.sleep(0.3)
    try:
        proc.terminate()
    except Exception:
        pass
    code = proc.poll()
    ok = code == 0
    print("exit code:", code, "OK" if ok else "!! UNEXPECTED EXIT CODE !!")
    if b"Traceback" in output or b"TypeError" in output or b"is not a function" in output:
        ok = False
        print("!!! POSSIBLE CRASH DETECTED IN RAW OUTPUT !!!")
    frames = [f for f in output.split(b"\x1b[2J\x1b[H") if f.strip()]
    print(f"--- {len(frames)} non-empty frames; last meaningful frame ---")
    print(strip(frames[-1])[:3000] if frames else "(none)")
    return ok


def main():
    results = []

    # Zero-param action, executed for real (ping is read-only/harmless).
    results.append(run("ping (zero-param action, executes for real)", [
        ("ping", 0.3),
        ("\r", 0.4),
        (" ", 1.0),  # dismiss result screen
    ]))

    # Enum-param action, back out without executing.
    results.append(run("pane.split (enum param, Escape back to top, Escape to quit)", [
        ("pane.split", 0.3),
        ("\r", 0.4),
        ("\x1b", 0.4),
        ("\x1b", 0.4),
    ]))

    # Destructive action must require confirmation; choose "No, cancel".
    results.append(run("server.stop (destructive confirm -> cancel, never invoked)", [
        ("server.stop", 0.3),
        ("\r", 0.4),
        ("\x1b[B", 0.3),  # down to "No, cancel"
        ("\r", 0.4),
        ("\x1b", 0.4),
    ]))

    # Dynamic id-param picker backed by a live pane.list call.
    results.append(run("pane.focus (dynamic id-param picker via live pane.list)", [
        ("Pane: Focus", 0.3),
        ("\r", 0.6),
        ("\x1b", 0.4),
        ("\x1b", 0.4),
    ]))

    # Quick action space picker renders; back out before anything is created.
    results.append(run("New Claude tab (space picker, Escape back, Escape to quit)", [
        ("New Claude tab", 0.3),
        ("\r", 0.4),
        ("\x1b", 0.4),
        ("\x1b", 0.4),
    ]))

    print(f"\n{sum(results)}/{len(results)} scenarios exited cleanly")
    sys.exit(0 if all(results) else 1)


if __name__ == "__main__":
    main()
