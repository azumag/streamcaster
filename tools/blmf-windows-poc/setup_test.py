import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('poc_setup', HERE / 'setup.py')
setup = importlib.util.module_from_spec(spec)
spec.loader.exec_module(setup)


class SetupTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        # Resolve here too: setup.create() resolves `home`, and on Windows CI
        # runners the temp dir can be reported in short (8.3) form, which
        # would otherwise mismatch the long-form path create() returns.
        self.home = (Path(self.tmp.name) / 'new installation').resolve()

    def test_isolated_config_safe_defaults_and_portability(self):
        setup.create(self.home, config_only=True)
        for role, ident in [('main', setup.MAIN), ('sub', setup.SUB_ID)]:
            cfg = self.home / role / 'config/obs-studio'
            ws = json.loads((cfg / 'plugin_config/obs-websocket/config.json').read_text())
            self.assertFalse(ws['server_enabled'])
            self.assertTrue(ws['auth_required'])
            self.assertGreaterEqual(len(ws['server_password']), 32)
            doc = json.loads((cfg / 'basic/scenes' / (ident + '.json')).read_text())
            self.assertNotIn('DesktopAudioDevice1', doc)
            self.assertNotIn('AuxAudioDevice1', doc)
            self.assertEqual(doc['current_program_scene'], 'VRC_VENUE' if role == 'main' else 'STANDBY')
            if role == 'main':
                ndi = next(s for s in doc['sources'] if s['id'] == 'ndi_source')
                self.assertEqual(ndi['settings']['ndi_source_name'], '')
                self.assertEqual(ndi['settings']['ndi_bw_mode'], 0)
            else:
                lua = Path(doc['modules']['scripts-tool'][0]['path'])
                self.assertEqual(lua, self.home / 'control/local-sub-observer.lua')
                self.assertTrue(lua.exists())
                media = next(s for s in doc['sources'] if s['id'] == 'ffmpeg_source')
                self.assertEqual(Path(media['settings']['local_file']), self.home / 'sub/media/local-test.mp4')
                service = json.loads((cfg / 'basic/profiles' / ident / 'service.json').read_text())
                self.assertEqual(service['settings']['key'], '')

    def test_refuses_existing_installation_without_modification(self):
        setup.create(self.home, config_only=True)
        before = {str(p): p.read_bytes() for p in self.home.rglob('*') if p.is_file()}
        with self.assertRaises(ValueError):
            setup.create(self.home, config_only=True)
        self.assertEqual(before, {str(p): p.read_bytes() for p in self.home.rglob('*') if p.is_file()})

    def test_distribution_copy_excludes_credentials_and_logs(self):
        dist = Path(self.tmp.name) / 'distribution'
        for relative in ['bin/64bit/obs64.exe', 'data/test.txt', 'obs-plugins/64bit/distroav.dll',
                         'obs-plugins/64bit/win-spout.dll', 'ndi-runtime/Processing.NDI.Lib.x64.dll',
                         'config/account.txt', 'logs/private.txt']:
            target = dist / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text('test fixture')
        setup.create(self.home, distribution=dist)
        for role in ['main', 'sub']:
            self.assertTrue((self.home / role / 'bin/64bit/obs64.exe').exists())
            self.assertFalse((self.home / role / 'config/account.txt').exists())
            self.assertFalse((self.home / role / 'logs').exists())

    def test_missing_distribution_fails_before_creating_home(self):
        with self.assertRaises(ValueError):
            setup.create(self.home, distribution=Path(self.tmp.name) / 'missing')
        self.assertFalse(self.home.exists())


if __name__ == '__main__':
    unittest.main()
