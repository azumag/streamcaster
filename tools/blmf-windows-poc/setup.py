"""Generate a new, isolated two-OBS installation; never import account settings.

Use Setup.ps1 on Windows to protect the destination ACL before configuration creation.
--config-only is for reproducibility tests; it does not install or launch OBS.
"""
import argparse
import json
from pathlib import Path
import secrets
import shutil
import uuid

HERE = Path(__file__).resolve().parent
MAIN = 'BLMF_WINDOWS_LOCAL_TEST'
SUB = 'BLMF Windows Sub PoC'
SUB_ID = 'BLMF_WINDOWS_SUB_POC'


def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')


def source(name, kind, settings):
    return dict(name=name, uuid=str(uuid.uuid4()), id=kind, versioned_id=kind,
                settings=settings, mixers=1, sync=0, flags=0, volume=1.0,
                enabled=True, muted=False, monitoring_type=0, private_settings={})


def item(src, number=1):
    return dict(name=src['name'], source_uuid=src['uuid'], visible=True, locked=False,
                rot=0, pos={'x': 0, 'y': 0}, scale={'x': 1, 'y': 1}, align=5,
                bounds_type=2, bounds_align=0, bounds={'x': 1920, 'y': 1080}, id=number)


def collection(name, scenes, sources, current):
    return dict(name=name, current_scene=current, current_program_scene=current,
                scene_order=[{'name': s['name']} for s in scenes], sources=sources + scenes,
                groups=[], transitions=[], quick_transitions=[], current_transition='Cut',
                transition_duration=0, saved_projectors=[])


def create(home, distribution=None, config_only=False):
    home = Path(home).resolve()
    # The PowerShell wrapper may create an EMPTY, ACL-protected directory first.
    if home.exists() and any(home.iterdir()):
        raise ValueError('destination_not_empty')
    if not config_only:
        distribution = Path(distribution).resolve()
        for relative in ['bin/64bit/obs64.exe', 'data', 'obs-plugins',
                         'obs-plugins/64bit/distroav.dll', 'obs-plugins/64bit/win-spout.dll',
                         'ndi-runtime/Processing.NDI.Lib.x64.dll']:
            if not (distribution / relative).exists():
                raise ValueError('distribution_missing_required_component')
        if distribution == home or distribution.is_relative_to(home) or home.is_relative_to(distribution):
            raise ValueError('overlapping_distribution_destination')
    home.mkdir(parents=True, exist_ok=True)
    control = home / 'control'
    control.mkdir()
    shutil.copy2(HERE / 'local-sub-observer.lua', control / 'local-sub-observer.lua')
    for role, name, ident, port in [('main', MAIN, MAIN, 4456), ('sub', SUB, SUB_ID, 4466)]:
        root = home / role
        root.mkdir()
        if not config_only:
            # Deliberately omit config, logs, services, user plugins and media.
            for folder in ('bin', 'data', 'obs-plugins', 'ndi-runtime'):
                shutil.copytree(distribution / folder, root / folder)
        (root / 'portable_mode.txt').touch()
        (root / 'media').mkdir()
        (root / 'recordings').mkdir()
        cfg = root / 'config/obs-studio'
        profile = cfg / 'basic/profiles' / ident
        profile.mkdir(parents=True)
        (cfg / 'global.ini').write_text('[General]\nFirstRun=false\nEnableAutoUpdates=false\n', encoding='utf-8')
        (cfg / 'user.ini').write_text(
            f'[General]\nFirstRun=false\nEnableAutoUpdates=false\n[Basic]\nProfile={name}\n'
            f'ProfileDir={ident}\nSceneCollection={name}\nSceneCollectionFile={ident}\n'
            '[NDIPlugin]\nAutoCheckForUpdates=false\n'
            f'MainOutputEnabled={"true" if role == "sub" else "false"}\n'
            'MainOutputName=BLMF_WINDOWS_SUB_POC\nPreviewOutputEnabled=false\n', encoding='utf-8')
        (profile / 'basic.ini').write_text(
            f'[General]\nName={name}\n[Video]\nBaseCX=1920\nBaseCY=1080\nOutputCX=1920\nOutputCY=1080\n'
            'FPSType=0\nFPSCommon=60\n[Audio]\nSampleRate=48000\nChannelSetup=Stereo\n'
            '[Output]\nMode=Simple\n[SimpleOutput]\nStreamEncoder=nvenc\n'
            f'VBitrate={2000 if role == "sub" else 6000}\nABitrate=160\n'
            f'FilePath={(root / "recordings").as_posix()}\nRecFormat2=mkv\nRecQuality=Small\nRecEncoder=nvenc\n', encoding='utf-8')
        # Enable Main only after local network restrictions have been checked by the operator.
        write_json(cfg / 'plugin_config/obs-websocket/config.json',
                   dict(server_enabled=False, server_port=port, auth_required=True,
                        server_password=secrets.token_urlsafe(32), alerts_enabled=False))
        if role == 'sub':
            write_json(profile / 'service.json', {'type': 'rtmp_custom', 'settings': {
                'server': 'rtmp://ingest.vrcdn.live/live', 'key': '', 'use_auth': False}})
            movie = source('LOCAL_TEST_PLAYER', 'ffmpeg_source', {
                'is_local_file': True, 'local_file': (root / 'media/local-test.mp4').as_posix(),
                'looping': True, 'restart_on_activate': False, 'close_when_inactive': False, 'hw_decode': True})
            blue = source('TEST_BLUE', 'color_source_v3', {'color': 4294901760, 'width': 1920, 'height': 1080})
            scenes = [source('STANDBY', 'scene', {'items': []}),
                      source('ENTRY_001', 'scene', {'items': [item(movie)]}),
                      source('ENTRY_002', 'scene', {'items': [item(blue)]})]
            doc = collection(name, scenes, [movie, blue], 'STANDBY')
            doc['modules'] = {'scripts-tool': [{'path': (control / 'local-sub-observer.lua').as_posix(), 'settings': {}}]}
        else:
            # Bind NDI and Spout senders from actual discovery in the OBS source properties.
            ndi = source('WINDOWS_SUB_FULL_NDI', 'ndi_source', {
                'ndi_source_name': '', 'ndi_bw_mode': 0, 'ndi_behavior': 0, 'ndi_audio': True})
            spout = source('VRCHAT_SPOUT', 'spout_capture', {})
            scenes = [source('VRC_VENUE', 'scene', {'items': [item(spout)]}),
                      source('ENTRY_FULLSCREEN', 'scene', {'items': [item(ndi)]})]
            doc = collection(name, scenes, [ndi, spout], 'VRC_VENUE')
        # Global desktop/microphone captures intentionally absent. Venue audio is configured
        # as a scene-local source by the operator, never in ENTRY_FULLSCREEN.
        write_json(cfg / 'basic/scenes' / (ident + '.json'), doc)
    write_json(home / 'poc-install.json', {'format': 1, 'configOnly': config_only})


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--home', required=True)
    parser.add_argument('--distribution')
    parser.add_argument('--config-only', action='store_true')
    args = parser.parse_args()
    if not args.config_only and not args.distribution:
        parser.error('--distribution required except for --config-only')
    create(args.home, args.distribution, args.config_only)
    print('Created isolated configuration. OBS was not launched; WebSockets and streaming remain disabled.')
