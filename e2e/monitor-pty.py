"""Drive the compiled fixture monitor through a PTY and save its visible frame.

Run with: uv run --with pyte python e2e/monitor-pty.py OUTPUT_DIRECTORY
"""

import codecs
import fcntl
import os
from pathlib import Path
import pty
import select
import struct
import subprocess
import sys
import tempfile
import termios
import time

import pyte


def capture(columns, output):
    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 40, columns, 0, 0))
    screen = pyte.Screen(columns, 40)
    stream = pyte.Stream(screen)
    decoder = codecs.getincrementaldecoder("utf-8")("replace")
    raw = bytearray()
    with tempfile.TemporaryDirectory(prefix="foreman-pty-") as home:
        env = {"HOME": home, "PATH": os.environ["PATH"], "TERM": "xterm-256color", "COLORTERM": "truecolor", "FORCE_COLOR": "3", "LOG_LEVEL": "none"}
        child = subprocess.Popen(["dist/monitor-fixture", "monitor"], stdin=slave, stdout=slave, stderr=slave, env=env, start_new_session=True)
        os.close(slave)

        def read_until(predicate):
            deadline = time.monotonic() + 10
            while not (predicate() and raw.rfind(b"\x1b[?2026l") > raw.rfind(b"\x1b[?2026h")):
                if child.poll() is not None:
                    raise AssertionError(f"monitor exited {child.returncode}: {bytes(raw)!r}")
                if time.monotonic() > deadline:
                    raise TimeoutError("monitor did not render the expected frame")
                if select.select([master], [], [], 0.1)[0]:
                    data = os.read(master, 65536)
                    raw.extend(data)
                    stream.feed(decoder.decode(data))

        try:
            read_until(lambda: "idle runs older than 24h" in "\n".join(screen.display) and "other repo: its own session supervises it" in "\n".join(screen.display) and "Reading current runs" not in "\n".join(screen.display) and "foreman status --all" not in "\n".join(screen.display) and "\n".join(screen.display).count("q2 pending") >= 2)
            frame = "\n".join(line.rstrip() for line in screen.display)
            (output / f"monitor-{columns}.txt").write_text(frame + "\n")
            assert "claude-codex" in frame and "other repo: its own session supervises it" in frame
            assert "idle runs older than 24h" in frame
            assert "48;2;18;20;18" in raw.decode("utf-8", "replace")
            os.write(master, b"?")
            read_until(lambda: "Monitor help" in "\n".join(screen.display) and "fix-hooks" not in "\n".join(screen.display))
            os.write(master, b"?")
            read_until(lambda: "fix-hooks" in "\n".join(screen.display) and "Monitor help" not in "\n".join(screen.display) and "finished" in "\n".join(screen.display))
            os.write(master, b"a")
            read_until(lambda: "a all runs" in screen.display[-1] and "finished" not in "\n".join(screen.display))
            os.write(master, b"q")
            deadline = time.monotonic() + 10
            while child.poll() is None:
                if time.monotonic() > deadline:
                    raise TimeoutError("monitor did not quit")
                if select.select([master], [], [], 0.1)[0]:
                    try:
                        raw.extend(os.read(master, 65536))
                    except OSError:
                        break
            assert child.wait(timeout=10) == 0
            assert b"\x1b[?1049h" in raw and b"\x1b[?1049l" in raw
            (output / f"monitor-{columns}.ansi").write_bytes(raw)
            print(f"{columns} columns: frame, help, filter, q and alternate-screen restoration passed")
        finally:
            if child.poll() is None:
                child.kill()
                child.wait()
            os.close(master)


destination = Path(sys.argv[1])
destination.mkdir(parents=True, exist_ok=True)
for width in [70, 100, 140]:
    capture(width, destination)
