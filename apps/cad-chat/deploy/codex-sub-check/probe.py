"""Read subscription metadata using the service account's Codex login."""

import base64
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import re
import select
import stat
import subprocess
import sys
import time


def send(proc, message):
    proc.stdin.write(json.dumps(message).encode() + b"\n")
    proc.stdin.flush()


def response(proc, request_id, timeout):
    deadline = time.monotonic() + timeout
    pending = bytearray()
    while True:
        remaining = deadline - time.monotonic()
        if remaining <= 0 or not select.select([proc.stdout], [], [], remaining)[0]:
            raise TimeoutError
        chunk = os.read(proc.stdout.fileno(), 65536)
        if not chunk:
            raise EOFError
        pending.extend(chunk)
        lines = pending.split(b"\n")
        pending = lines.pop()
        for line in lines:
            try:
                message = json.loads(line)
            except (ValueError, UnicodeError):
                continue
            if isinstance(message, dict) and message.get("id") == request_id:
                return message


def refresh_account(binary):
    proc = subprocess.Popen(
        [binary, "app-server", "--listen", "stdio://"],
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
    )
    try:
        client = {"name": "codex-sub-check", "title": "codex-sub-check", "version": "1"}
        send(proc, {"id": 1, "method": "initialize", "params": {
            "clientInfo": client, "capabilities": {"experimentalApi": True},
        }})
        if "error" in response(proc, 1, 30):
            return None
        send(proc, {"method": "initialized"})
        send(proc, {"id": 2, "method": "account/read", "params": {"refreshToken": True}})
        reply = response(proc, 2, 60)
        if "error" in reply:
            return None
        return reply.get("result", {}).get("account")
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait()
        proc.stdin.close()
        proc.stdout.close()


def plan_type(value):
    if isinstance(value, str) and re.fullmatch(r"[A-Za-z0-9_-]{1,40}", value):
        return value
    return None


def check(binary, home, state):
    try:
        login = subprocess.run(
            [binary, "login", "status"], stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT, timeout=20, check=False,
        )
        if b"logged in using chatgpt" not in login.stdout.lower():
            state["status"] = "login_invalid"
            return
        account = refresh_account(binary)
    except (subprocess.TimeoutExpired, TimeoutError, EOFError, BrokenPipeError):
        state["status"] = "login_invalid"
        return
    if not isinstance(account, dict) or account.get("type") != "chatgpt":
        state["status"] = "login_invalid"
        return
    state["planType"] = plan_type(account.get("planType"))
    with (home / "auth.json").open(encoding="utf-8") as source:
        payload = json.load(source)["tokens"]["id_token"].split(".")[1]
    claims = json.loads(base64.urlsafe_b64decode(payload + "=" * (-len(payload) % 4)))
    auth = claims["https://api.openai.com/auth"]
    state["planType"] = plan_type(auth.get("chatgpt_plan_type")) or state["planType"]
    until = auth.get("chatgpt_subscription_active_until")
    if isinstance(until, str):
        expiry = datetime.fromisoformat(until[:-1] + "+00:00" if until.endswith("Z") else until)
        if expiry.tzinfo is not None:
            state["activeUntil"] = expiry.isoformat().replace("+00:00", "Z")
            state["status"] = "ok" if datetime.now(timezone.utc) < expiry else "expired"


def clean_sessions(directory):
    cutoff = time.time() - 7 * 86400
    for _, dirs, files, fd in os.fwalk(directory, topdown=False, follow_symlinks=False):
        for name in files:
            try:
                info = os.stat(name, dir_fd=fd, follow_symlinks=False)
                if stat.S_ISREG(info.st_mode) and info.st_mtime < cutoff:
                    os.unlink(name, dir_fd=fd)
            except OSError:
                pass
        for name in dirs:
            try:
                os.rmdir(name, dir_fd=fd)
            except OSError:
                pass


def main():
    state = {"status": "unknown", "activeUntil": None, "planType": None}
    try:
        home = Path(os.environ.get("CODEX_HOME") or Path(os.environ["HOME"]) / ".codex")
        try:
            check(sys.argv[1], home, state)
        finally:
            try:
                clean_sessions(home / "sessions")
            except Exception:
                pass
    except Exception:
        state["status"] = "unknown"
    state["checkedAt"] = datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")
    print(json.dumps(state))


if __name__ == "__main__":
    main()
