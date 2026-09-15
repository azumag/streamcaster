obs=obslua
local base=script_path()
local last=''
local session=tostring(obs.os_gettime_ns())
local expected='BLMF Windows Sub PoC'
local function collect_media(scene,rows,seen,depth)
 if not scene or depth>12 then return end
 local items=obs.obs_scene_enum_items(scene)
 for _,item in ipairs(items or {}) do
  if obs.obs_sceneitem_visible(item) then
   local source=obs.obs_sceneitem_get_source(item)
   local name=obs.obs_source_get_name(source)
   local kind=obs.obs_source_get_id(source)
   if not seen[name] then
    seen[name]=true
    if kind=='ffmpeg_source' or kind=='vlc_source' then
     local row=obs.obs_data_create()
     obs.obs_data_set_string(row,'name',name)
     obs.obs_data_set_int(row,'cursor',obs.obs_source_media_get_time(source))
     obs.obs_data_set_int(row,'duration',obs.obs_source_media_get_duration(source))
     local state=obs.obs_source_media_get_state(source)
     local names={[obs.OBS_MEDIA_STATE_PLAYING]='playing',[obs.OBS_MEDIA_STATE_PAUSED]='paused',[obs.OBS_MEDIA_STATE_STOPPED]='stopped',[obs.OBS_MEDIA_STATE_ENDED]='ended',[obs.OBS_MEDIA_STATE_OPENING]='opening',[obs.OBS_MEDIA_STATE_BUFFERING]='buffering',[obs.OBS_MEDIA_STATE_ERROR]='error',[obs.OBS_MEDIA_STATE_NONE]='none'}
     obs.obs_data_set_string(row,'state',names[state] or 'unknown')
     local settings=obs.obs_source_get_settings(source)
     obs.obs_data_set_bool(row,'looping',obs.obs_data_get_bool(settings,kind=='vlc_source' and 'loop' or 'looping'))
     obs.obs_data_set_string(row,'loopScope',kind=='vlc_source' and 'playlist' or 'source')
     obs.obs_data_release(settings)
     obs.obs_data_array_push_back(rows,row);obs.obs_data_release(row)
    elseif kind=='scene' then collect_media(obs.obs_scene_from_source(source),rows,seen,depth+1)
    elseif obs.obs_sceneitem_is_group(item) then collect_media(obs.obs_sceneitem_group_get_scene(item),rows,seen,depth+1) end
   end
  end
 end
 obs.sceneitem_list_release(items)
end
local function identity()
 return obs.obs_frontend_get_current_profile()==expected and obs.obs_frontend_get_current_scene_collection()==expected
end
local function tick()
 local f=io.open(base..'local-sub-command.json','r')
 if f then
  local d=obs.obs_data_create_from_json(f:read('*a'));f:close()
  if d then
   local id=obs.obs_data_get_string(d,'id');local name=obs.obs_data_get_string(d,'scene')
   local age=os.time()-obs.obs_data_get_int(d,'issuedAt')
   if id~='' and id~=last then
    last=id
    if identity() and obs.obs_data_get_string(d,'session')==session and age>=0 and age<=3 and (name=='STANDBY' or string.match(name,'^ENTRY_.+')) then
     local scenes=obs.obs_frontend_get_scenes()
     for _,s in ipairs(scenes or {}) do if obs.obs_source_get_name(s)==name then obs.obs_frontend_set_current_scene(s);break end end
     obs.source_list_release(scenes)
    end
   end
   obs.obs_data_release(d)
  end
 end
 local d=obs.obs_data_create()
 obs.obs_data_set_string(d,'session',session)
 obs.obs_data_set_string(d,'commandId',last)
 obs.obs_data_set_int(d,'observedAt',os.time())
 obs.obs_data_set_string(d,'profile',obs.obs_frontend_get_current_profile())
 obs.obs_data_set_string(d,'collection',obs.obs_frontend_get_current_scene_collection())
 local s=obs.obs_frontend_get_current_scene();local name=s and obs.obs_source_get_name(s) or ''
 local media=obs.obs_data_array_create()
 if s then collect_media(obs.obs_scene_from_source(s),media,{},0) end
 obs.obs_data_set_array(d,'mediaSources',media);obs.obs_data_array_release(media)
 if s then obs.obs_source_release(s) end
 obs.obs_data_set_string(d,'programScene',name)
 obs.obs_data_set_bool(d,'streaming',obs.obs_frontend_streaming_active())
 obs.obs_data_set_bool(d,'recording',obs.obs_frontend_recording_active())
 local output=obs.obs_frontend_get_streaming_output()
 if output then
  for key,fn in pairs({streamBytes=obs.obs_output_get_total_bytes,streamFrames=obs.obs_output_get_total_frames,streamDropped=obs.obs_output_get_frames_dropped}) do
   if fn then local ok,value=pcall(fn,output);if ok then obs.obs_data_set_double(d,key,value) end end
  end
  obs.obs_output_release(output)
 end
 local rows=obs.obs_data_array_create();local scenes=obs.obs_frontend_get_scenes()
 for i=#scenes,1,-1 do local row=obs.obs_data_create();obs.obs_data_set_string(row,'sceneName',obs.obs_source_get_name(scenes[i]));obs.obs_data_array_push_back(rows,row);obs.obs_data_release(row) end
 obs.source_list_release(scenes);obs.obs_data_set_array(d,'scenes',rows);obs.obs_data_array_release(rows)
 local m=obs.obs_get_source_by_name('LOCAL_TEST_PLAYER');local position=m and obs.obs_source_media_get_time(m) or -1
 if m then obs.obs_source_release(m) end
 obs.obs_data_set_int(d,'mediaCursor',position)
 obs.obs_data_save_json_safe(d,base..'local-sub-state.json','tmp','bak');obs.obs_data_release(d)
 local log=io.open(base..'sub-playback.csv','a')
 if log then log:write(os.date('!%Y-%m-%dT%H:%M:%SZ')..','..name..','..position..','..tostring(obs.obs_get_active_fps())..','..tostring(obs.obs_get_lagged_frames())..'\n');log:close() end
end
function script_description() return 'Windows Sub only: dynamic scene commands with identity, session and freshness checks. No stream/output commands.' end
function script_load(settings) obs.timer_add(tick,500) end
function script_unload() obs.timer_remove(tick) end
