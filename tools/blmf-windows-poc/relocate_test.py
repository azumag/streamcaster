"""A moved installation must be repairable without disturbing working paths."""
import json
from pathlib import Path
import re
import shutil
import tempfile
import unittest

import setup
from relocate import relocate


class RelocateTests(unittest.TestCase):
    def setUp(self):
        self.temp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.temp, True)
        self.origin = self.temp / 'origin'
        setup.create(self.origin, config_only=True)
        # A real installation has the test clip in place.
        (self.origin / 'sub/media/local-test.mp4').write_bytes(b'')
        (self.origin / 'main/recordings').mkdir(exist_ok=True)
        (self.origin / 'sub/recordings').mkdir(exist_ok=True)

    def moved(self):
        destination = self.temp / 'moved'
        shutil.move(str(self.origin), str(destination))
        return destination

    @staticmethod
    def scene(home, role, name):
        return json.loads((home / role / 'config/obs-studio/basic/scenes' / (name + '.json'))
                          .read_text(encoding='utf-8'))

    @staticmethod
    def file_path(home, role, ident):
        text = (home / role / 'config/obs-studio/basic/profiles' / ident / 'basic.ini') \
            .read_text(encoding='utf-8')
        return re.search(r'(?m)^FilePath=(.*)$', text).group(1)

    def test_broken_script_and_media_are_repaired(self):
        home = self.moved()
        changed, notes = relocate(home)
        self.assertTrue(changed)
        doc = self.scene(home, 'sub', 'BLMF_WINDOWS_SUB_POC')
        self.assertEqual(doc['modules']['scripts-tool'][0]['path'],
                         (home / 'control/local-sub-observer.lua').as_posix())
        player = next(s for s in doc['sources'] if s['name'] == 'LOCAL_TEST_PLAYER')
        self.assertEqual(player['settings']['local_file'],
                         (home / 'sub/media/local-test.mp4').as_posix())
        self.assertEqual(notes, [])

    def test_broken_recording_path_is_repaired_within_its_own_role(self):
        home = self.moved()
        relocate(home)
        for role, ident in (('main', 'BLMF_WINDOWS_LOCAL_TEST'), ('sub', 'BLMF_WINDOWS_SUB_POC')):
            self.assertEqual(self.file_path(home, role, ident),
                             (home / role / 'recordings').as_posix())

    def test_a_working_path_is_never_rewritten(self):
        # The rig in use keeps the script elsewhere and records to its own folder.
        home = self.moved()
        elsewhere = home / 'windows-e2e'
        elsewhere.mkdir()
        shutil.copy2(home / 'control/local-sub-observer.lua', elsewhere / 'local-sub-observer.lua')
        evidence = home / 'evidence'
        evidence.mkdir()
        scene = home / 'sub/config/obs-studio/basic/scenes/BLMF_WINDOWS_SUB_POC.json'
        doc = json.loads(scene.read_text(encoding='utf-8'))
        doc['modules']['scripts-tool'][0]['path'] = (elsewhere / 'local-sub-observer.lua').as_posix()
        scene.write_text(json.dumps(doc, ensure_ascii=False, indent=2), encoding='utf-8')
        ini = home / 'main/config/obs-studio/basic/profiles/BLMF_WINDOWS_LOCAL_TEST/basic.ini'
        ini.write_text(re.sub(r'(?m)^FilePath=.*$', 'FilePath=' + evidence.as_posix(),
                              ini.read_text(encoding='utf-8')), encoding='utf-8')
        relocate(home)
        after = json.loads(scene.read_text(encoding='utf-8'))
        self.assertEqual(after['modules']['scripts-tool'][0]['path'],
                         (elsewhere / 'local-sub-observer.lua').as_posix())
        self.assertEqual(self.file_path(home, 'main', 'BLMF_WINDOWS_LOCAL_TEST'), evidence.as_posix())

    def test_ambiguous_candidates_are_reported_not_guessed(self):
        home = self.moved()
        spare = home / 'spare'
        spare.mkdir()
        shutil.copy2(home / 'control/local-sub-observer.lua', spare / 'local-sub-observer.lua')
        (home / 'control/local-sub-observer.lua').unlink()
        changed, notes = relocate(home)
        # One copy under home, none under the role root, so it is still unique.
        doc = self.scene(home, 'sub', 'BLMF_WINDOWS_SUB_POC')
        self.assertEqual(doc['modules']['scripts-tool'][0]['path'],
                         (spare / 'local-sub-observer.lua').as_posix())
        shutil.copy2(spare / 'local-sub-observer.lua', home / 'control/local-sub-observer.lua')
        scene = home / 'sub/config/obs-studio/basic/scenes/BLMF_WINDOWS_SUB_POC.json'
        doc['modules']['scripts-tool'][0]['path'] = 'C:/gone/local-sub-observer.lua'
        scene.write_text(json.dumps(doc, ensure_ascii=False, indent=2), encoding='utf-8')
        changed, notes = relocate(home)
        self.assertTrue(any('candidates' in note for note in notes))
        after = json.loads(scene.read_text(encoding='utf-8'))
        self.assertEqual(after['modules']['scripts-tool'][0]['path'], 'C:/gone/local-sub-observer.lua')

    def test_a_file_that_is_gone_everywhere_is_reported(self):
        home = self.moved()
        (home / 'control/local-sub-observer.lua').unlink()
        changed, notes = relocate(home)
        self.assertTrue(any('no local-sub-observer.lua found' in note for note in notes))

    def test_escaped_backslash_paths_keep_that_style(self):
        home = self.moved()
        path = home / 'main/config/obs-studio/basic/profiles/BLMF_WINDOWS_LOCAL_TEST/basic.ini'
        path.write_text(re.sub(r'(?m)^FilePath=.*$', 'FilePath=C:\\\\\\\\gone\\\\\\\\recordings',
                               path.read_text(encoding='utf-8')), encoding='utf-8')
        relocate(home)
        self.assertEqual(self.file_path(home, 'main', 'BLMF_WINDOWS_LOCAL_TEST'),
                         str(home / 'main/recordings').replace('\\', '\\\\'))

    def test_rerunning_in_place_changes_nothing(self):
        home = self.moved()
        self.assertTrue(relocate(home)[0])
        self.assertEqual(relocate(home)[0], [])

    def test_operator_added_sources_are_left_alone(self):
        home = self.moved()
        path = home / 'sub/config/obs-studio/basic/scenes/BLMF_WINDOWS_SUB_POC.json'
        doc = json.loads(path.read_text(encoding='utf-8'))
        doc['sources'].append({'name': 'VENUE_AUDIO', 'settings': {'local_file': 'D:/venue/bgm.wav'}})
        path.write_text(json.dumps(doc, ensure_ascii=False, indent=2), encoding='utf-8')
        relocate(home)
        after = json.loads(path.read_text(encoding='utf-8'))
        kept = next(s for s in after['sources'] if s['name'] == 'VENUE_AUDIO')
        self.assertEqual(kept['settings']['local_file'], 'D:/venue/bgm.wav')


if __name__ == '__main__':
    unittest.main()
