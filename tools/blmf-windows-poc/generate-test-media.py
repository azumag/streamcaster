"""Create a 30-second 1080p60 test clip with stereo test tones. Never overwrite media."""
import argparse
from pathlib import Path
import subprocess

p = argparse.ArgumentParser(description=__doc__)
p.add_argument('--home', required=True)
p.add_argument('--ffmpeg', default='ffmpeg')
a = p.parse_args()
dest = Path(a.home).resolve() / 'sub/media/local-test.mp4'
if not (Path(a.home) / 'poc-install.json').exists():
    p.error('Run setup first')
if dest.exists():
    p.error('Test media already exists; refusing overwrite')
subprocess.run([a.ffmpeg, '-hide_banner', '-loglevel', 'error', '-n',
                '-f', 'lavfi', '-i', 'testsrc2=size=1920x1080:rate=60',
                '-f', 'lavfi', '-i', 'aevalsrc=0.1*sin(2*PI*440*t)|0.1*sin(2*PI*880*t):s=48000',
                '-t', '30', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '20',
                '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k', str(dest)], check=True)
print('Generated 1080p60 test pattern, left 440Hz/right 880Hz. No OBS changes.')
