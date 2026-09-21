"""Repair an installation's OBS paths after the directory has been moved.

OBS stores media, script and recording locations as absolute strings, so moving
a runtime home breaks them: the Sub observer script fails to load and recordings
are written to a path that no longer exists.

Only paths that are actually broken are touched, and only when the replacement
is unambiguous. A working path is never "corrected", because an operator may
have pointed it somewhere deliberately, and a guess would silently swap a live
file for a stale copy. Anything uncertain is reported for a human instead.
"""
import argparse
import json
from pathlib import Path
import re

SCRIPT = 'local-sub-observer.lua'
MEDIA = 'local-test.mp4'


def read_json(path):
    return json.loads(path.read_text(encoding='utf-8'))


def write_json(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')


def roles(home):
    """Every OBS root under this home, whatever the installation named them."""
    return sorted(path.parents[1] for path in home.glob('*/config/obs-studio'))


def repair(current, root, home, notes, *, directory=False):
    """The path this value should have now, or None to leave it untouched."""
    if not current:
        return None
    here = Path.is_dir if directory else Path.is_file
    existing = Path(current)
    if here(existing):
        return None  # Not broken: whatever it points at is really there.
    name = existing.name
    for scope in (root, home):
        found = sorted(path for path in scope.rglob(name) if here(path))
        if len(found) == 1:
            return found[0]
        if len(found) > 1:
            notes.append(f'{current}: {len(found)} candidates named {name}; left unchanged')
            return None
    notes.append(f'{current}: missing and no {name} found under {home}; left unchanged')
    return None


def relocate_scenes(home, root, notes):
    changed = []
    for path in sorted((root / 'config/obs-studio/basic/scenes').glob('*.json')):
        doc = read_json(path)
        before = json.dumps(doc, ensure_ascii=False)
        for entry in doc.get('modules', {}).get('scripts-tool', []):
            if entry.get('path', '').endswith(SCRIPT):
                target = repair(entry['path'], root, home, notes)
                if target:
                    entry['path'] = target.as_posix()
        for source in doc.get('sources', []):
            settings = source.get('settings', {})
            if isinstance(settings.get('local_file'), str):
                target = repair(settings['local_file'], root, home, notes)
                if target:
                    settings['local_file'] = target.as_posix()
        if json.dumps(doc, ensure_ascii=False) != before:
            write_json(path, doc)
            changed.append(path)
    return changed


def relocate_profiles(root, home, notes):
    changed = []
    for path in sorted((root / 'config/obs-studio/basic/profiles').glob('*/basic.ini')):
        text = path.read_text(encoding='utf-8')
        found = re.search(r'(?m)^FilePath=(.*)$', text)
        if not found:
            continue
        # OBS writes either forward slashes or doubled backslashes here, and its
        # ini reader does not treat them alike. Keep whichever style is in use.
        escaped = '\\\\' in found.group(1)
        current = found.group(1).replace('\\\\', '\\') if escaped else found.group(1)
        target = repair(current, root, home, notes, directory=True)
        if not target:
            continue
        value = str(target).replace('\\', '\\\\') if escaped else target.as_posix()
        path.write_text(text.replace(found.group(0), 'FilePath=' + value), encoding='utf-8')
        changed.append(path)
    return changed


def relocate(home):
    home = Path(home).resolve()
    changed, notes = [], []
    for root in roles(home):
        changed += relocate_scenes(home, root, notes)
        changed += relocate_profiles(root, home, notes)
    return changed, notes


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--home', required=True)
    args = parser.parse_args()
    updated, skipped = relocate(args.home)
    for path in updated:
        print('repaired', path)
    for note in skipped:
        print('SKIPPED', note)
    print(f'{len(updated)} file(s) repaired, {len(skipped)} left for a human.'
          ' Close OBS before running this; OBS rewrites its configuration on exit.')
