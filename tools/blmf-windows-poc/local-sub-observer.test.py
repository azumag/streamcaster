"""Run the observer's actual collector in OBS's bundled LuaJIT, with read-only OBS doubles."""
import ctypes
import os
from pathlib import Path

base = Path(__file__).resolve().parent
runtime = Path(os.environ['BLMF_OBS_BIN']).resolve()
os.add_dll_directory(str(runtime))
lua = ctypes.CDLL(str(runtime / 'lua51.dll'))
lua.luaL_newstate.restype = ctypes.c_void_p
lua.luaL_openlibs.argtypes = [ctypes.c_void_p]
lua.luaL_loadstring.argtypes = [ctypes.c_void_p, ctypes.c_char_p]
lua.lua_pcall.argtypes = [ctypes.c_void_p, ctypes.c_int, ctypes.c_int, ctypes.c_int]
lua.lua_tolstring.argtypes = [ctypes.c_void_p, ctypes.c_int, ctypes.c_void_p]
lua.lua_tolstring.restype = ctypes.c_char_p
lua.lua_close.argtypes = [ctypes.c_void_p]
collector = (base / 'local-sub-observer.lua').read_text(encoding='utf-8').split('local function identity()')[0]
mock = r'''
local released,settingsReleased=0,0
obslua={}
local o=obslua
function script_path() return '' end
o.os_gettime_ns=function() return 1 end
for i,name in ipairs({'PLAYING','PAUSED','STOPPED','ENDED','OPENING','BUFFERING','ERROR','NONE'}) do o['OBS_MEDIA_STATE_'..name]=i end
o.obs_scene_enum_items=function(s) return s end
o.obs_sceneitem_visible=function(i) return i.visible~=false end
o.obs_sceneitem_get_source=function(i) return i.source end
o.obs_source_get_name=function(s) return s.name end
o.obs_source_get_id=function(s) return s.kind end
o.obs_data_create=function() return {} end
o.obs_data_set_string=function(d,k,v) d[k]=v end
o.obs_data_set_int=o.obs_data_set_string
o.obs_data_set_bool=o.obs_data_set_string
o.obs_source_media_get_time=function(s) return s.cursor or 0 end
o.obs_source_media_get_duration=function(s) return s.duration or 0 end
o.obs_source_media_get_state=function(s) return s.state or o.OBS_MEDIA_STATE_PLAYING end
o.obs_source_get_settings=function(s) return s.settings or {} end
o.obs_data_get_bool=function(d,k) assert(k=='loop' or k=='looping');return d[k]==true end
o.obs_data_release=function(d) settingsReleased=settingsReleased+1 end
o.obs_data_array_push_back=function(d,v) table.insert(d,v) end
o.obs_scene_from_source=function(s) return s.items end
o.obs_sceneitem_is_group=function(i) return i.source.kind=='group' end
o.obs_sceneitem_group_get_scene=function(i) return i.source.items end
o.sceneitem_list_release=function() released=released+1 end
local function item(s,visible) return {source=s,visible=visible} end
local function movie(name,kind) return {name=name,kind=kind or 'ffmpeg_source',cursor=1200,duration=10000,settings={looping=true,loop=true,local_file='PRIVATE_FILE',playlist='PRIVATE_LIST'}} end
'''
cases = r'''
local a=movie('A');local b=movie('B','vlc_source');b.state=o.OBS_MEDIA_STATE_PAUSED
local hidden=movie('Hidden');local hiddenChild=movie('Hidden child')
local group={name='Group',kind='group',items={item(b),item(hidden,false)}}
local nested={name='Nested',kind='scene',items={item(a),item(group)}}
local root={item(a,false),item(nested),item(a),item({name='Hidden scene',kind='scene',items={item(hiddenChild)}},false),item({name='Image',kind='image_source'})}
local rows={};collect_media(root,rows,{},0)
assert(#rows==2 and rows[1].name=='A' and rows[2].name=='B','visible nested/group media deduplication')
assert(rows[1].state=='playing' and rows[2].state=='paused')
assert(rows[1].cursor==1200 and rows[1].duration==10000 and rows[1].looping)
assert(rows[1].loopScope=='source' and rows[2].loopScope=='playlist')
for _,r in ipairs(rows) do for k in pairs(r) do assert(({name=true,state=true,cursor=true,duration=true,looping=true,loopScope=true})[k],'unexpected exported field') end end
assert(released==3 and settingsReleased==4,'references released')
local empty={};collect_media({item(a,false)},empty,{},0);assert(#empty==0)
local cycle={name='Cycle',kind='scene',items={}};cycle.items={item(cycle),item(a)}
rows={};collect_media(cycle.items,rows,{},0);assert(#rows==1)
for _,state in ipairs({'PLAYING','PAUSED','STOPPED','ENDED','OPENING','BUFFERING','ERROR','NONE'}) do
 a.state=o['OBS_MEDIA_STATE_'..state];a.cursor=-1;a.duration=0;rows={};collect_media({item(a)},rows,{},0)
 assert(rows[1].state==string.lower(state) and rows[1].cursor==-1 and rows[1].duration==0)
end
print('PASS: actual Lua collector: nested scenes, groups, hidden ancestors, duplicates, cycles, states, unknown time, allowlist and reference release')
'''
state = lua.luaL_newstate()
try:
    lua.luaL_openlibs(state)
    result = lua.luaL_loadstring(state, (mock + collector + cases).encode())
    if not result:
        result = lua.lua_pcall(state, 0, 0, 0)
    if result:
        raise RuntimeError(lua.lua_tolstring(state, -1, None).decode())
finally:
    lua.lua_close(state)
