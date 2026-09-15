import ctypes as c, json, time, argparse, os
from pathlib import Path
p=argparse.ArgumentParser()
p.add_argument('--home',required=True)
a=p.parse_args()
home=Path(a.home).resolve()
dll=home/'sub/ndi-runtime/Processing.NDI.Lib.x64.dll'
search_path=os.add_dll_directory(str(dll.parent))
ndi=c.CDLL(str(dll))
class Source(c.Structure):
    _fields_=[('name',c.c_char_p),('url',c.c_char_p)]
ndi.NDIlib_initialize.restype=c.c_bool
ndi.NDIlib_version.restype=c.c_char_p
ndi.NDIlib_find_create_v2.argtypes=[c.c_void_p]
ndi.NDIlib_find_create_v2.restype=c.c_void_p
ndi.NDIlib_find_wait_for_sources.argtypes=[c.c_void_p,c.c_uint32]
ndi.NDIlib_find_get_current_sources.argtypes=[c.c_void_p,c.POINTER(c.c_uint32)]
ndi.NDIlib_find_get_current_sources.restype=c.POINTER(Source)
ndi.NDIlib_find_destroy.argtypes=[c.c_void_p]
assert ndi.NDIlib_initialize(), 'NDI initialization failed'
finder=ndi.NDIlib_find_create_v2(None)
assert finder, 'NDI finder creation failed'
seen={}
try:
    deadline=time.monotonic()+20
    while time.monotonic()<deadline:
        ndi.NDIlib_find_wait_for_sources(finder,2000)
        count=c.c_uint32()
        sources=ndi.NDIlib_find_get_current_sources(finder,c.byref(count))
        for i in range(count.value):
            name=(sources[i].name or b'').decode('utf-8',errors='replace')
            seen[name]=(sources[i].url or b'').decode('utf-8',errors='replace')
finally:
    ndi.NDIlib_find_destroy(finder)
    ndi.NDIlib_destroy()
report={'time':time.strftime('%Y-%m-%dT%H:%M:%S%z'),'runtime':ndi.NDIlib_version().decode(),'duration_seconds':20,'sources':[{'name':k,'endpoint':v} for k,v in seen.items()],'media_receiver_started':False}
(home/'control/ndi-discovery.json').write_text(json.dumps(report,indent=2),encoding='utf-8')
print(json.dumps(report))
