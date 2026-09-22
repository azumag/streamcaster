"""The newest image inside one fixed directory, for the UI preview.

Deliberately not a file server: nothing a client sends ever reaches the
filesystem. The directory is chosen once on the command line, only image
suffixes are considered, and symlinks are skipped, so the reply can never be a
file from outside the configured folder.
"""
import os
from pathlib import Path
import time

TYPES = {'.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg'}
MAX_BYTES = 64 * 1024 * 1024
# A photo appears before it is fully written; serving it then shows a torn
# image exactly once, on the shot the operator just asked for.
SETTLE_SECONDS = 0.75
# VRChat files photos per month, so the current month plus its neighbours is
# the whole search. Scanning years of screenshots at 10 Hz is not.
FOLDERS = 3
# A named lookup may reach back through years of month folders, but not without
# a bound: this caps how many we are willing to stat for one file.
FOLDER_LIMIT = 256
ENTRIES = 4000


class Photos:
    def __init__(self, root, *, clock=time.time, ttl=1.0,
                 settle=SETTLE_SECONDS, max_bytes=MAX_BYTES):
        self.root = Path(root)
        self.clock, self.ttl, self.settle, self.max_bytes = clock, ttl, settle, max_bytes
        self.checked_at = None
        self.found = None

    def newest(self):
        """(path, mtime) of the newest readable image, or None. Cached briefly."""
        now = self.clock()
        if self.checked_at is None or now - self.checked_at >= self.ttl:
            self.checked_at, self.found = now, self.scan(now)
        return self.found

    def folders(self):
        subfolders = []
        try:
            with os.scandir(self.root) as entries:
                for entry in entries:
                    try:
                        if entry.is_dir(follow_symlinks=False):
                            subfolders.append((entry.stat().st_mtime, entry.path))
                    except OSError:
                        continue
        except OSError:
            return []
        subfolders.sort(reverse=True)
        return [self.root] + [Path(path) for _, path in subfolders[:FOLDERS]]

    def locate(self, name):
        """The file with exactly this name, if it is still in the folder.

        Presets outlive the month folder they were shot in, so this looks in
        every immediate subfolder rather than only the newest ones. The name
        comes from our own store, never from a request, and is re-checked here
        so a store edited by hand still cannot reach outside the folder.
        """
        if Path(name).name != name or Path(name).suffix.lower() not in TYPES:
            return None
        folders = [self.root]
        try:
            with os.scandir(self.root) as entries:
                for entry in entries:
                    try:
                        if entry.is_dir(follow_symlinks=False):
                            folders.append(Path(entry.path))
                    except OSError:
                        continue
        except OSError:
            return None
        for folder in folders[:1 + FOLDER_LIMIT]:
            candidate = folder / name
            try:
                if (candidate.is_file() and not candidate.is_symlink()
                        and 0 < candidate.stat().st_size <= self.max_bytes):
                    return candidate
            except OSError:
                continue
        return None

    def scan(self, now):
        best, budget = None, ENTRIES
        for folder in self.folders():
            try:
                entries = list(os.scandir(folder))
            except OSError:
                continue
            for entry in entries:
                budget -= 1
                if budget < 0:
                    return best
                if Path(entry.name).suffix.lower() not in TYPES:
                    continue
                try:
                    if not entry.is_file(follow_symlinks=False):
                        continue
                    info = entry.stat()
                except OSError:
                    continue
                if not 0 < info.st_size <= self.max_bytes:
                    continue
                if now - info.st_mtime < self.settle:
                    continue
                if best is None or info.st_mtime > best[1]:
                    best = (Path(entry.path), info.st_mtime)
        return best
