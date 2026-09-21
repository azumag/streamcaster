<#
.SYNOPSIS
    BLMF 手元 OSC コントローラ一式と VRChat カメラコントロールをまとめて起動する。

.DESCRIPTION
    起動するもの:
      1. 専用ポータブル Sub OBS  : BLMF-2026-Windows-Sub-PoC (profile/collection = BLMF Windows Sub PoC)
      2. 専用ポータブル Main OBS : BLMF-2026-Main-PoC (BLMF_WINDOWS_LOCAL_TEST) / obs-websocket 4456
      3. カメラコントロール      : camera-control (UI 8765) を中継構成で起動
                                   VRChat 出力 9002 で受信 -> 生 OSC を 9001 へ転送
      4. 手元 OSC コントローラ   : run-windows-local-osc.cjs -> http://127.0.0.1:18765
                                   UDP 9001 受信 / Main は WebSocket / Sub はファイル経由

    このスクリプトに機種固有のパスは持たせない。OBS・コントローラ・カメラの
    場所とポートは設定ファイルに書く。既定は同じディレクトリの
    blmf-launcher.local.json で、-ConfigPath か環境変数 BLMF_LAUNCHER_CONFIG
    でも指定できる。blmf-launcher.example.json を複製して作ること。
    実際の設定は機密ではないが機種固有なので、*.local.json として版管理外。

    カメラ専用トークンは廃止され、localhost からはそのまま操作できる。
    Tailscale 経由のときだけ Serve の身元ヘッダを要求する。

    VRChat 側は一度だけ Steam のプロパティ > 起動オプションに次を設定する:
        --osc=9000:127.0.0.1:9002

    起動時にシーン・配信・録画は変更しない。

.EXAMPLE
    .\Start-BLMF-Local.ps1              # 全部起動
    .\Start-BLMF-Local.ps1 -NoCamera    # カメラコントロールなし
    .\Start-BLMF-Local.ps1 -NoObs       # OBS は起動済み前提
    .\Start-BLMF-Local.ps1 -Stop        # コントローラとカメラを停止 (OBS は残す)
    .\Start-BLMF-Local.ps1 -Stop -StopObs
#>
[CmdletBinding()]
param(
    [string]$ConfigPath,
    [switch]$NoObs,
    [switch]$NoCamera,
    [switch]$NoBrowser,
    [switch]$Stop,
    [switch]$StopObs,
    [switch]$Force
)

$ErrorActionPreference = 'Stop'

function Write-Step  ($m) { Write-Host "==> $m" -ForegroundColor Cyan }
function Write-Ok    ($m) { Write-Host "  OK  $m" -ForegroundColor Green }
function Write-Warn2 ($m) { Write-Host "  !!  $m" -ForegroundColor Yellow }
function Write-Err2  ($m) { Write-Host "  NG  $m" -ForegroundColor Red }
function Write-Info  ($m) { Write-Host "      $m" -ForegroundColor DarkGray }

# ---------------------------------------------------------------- 設定

# 機種固有の場所はすべてここから来る。既定値をコードに埋めると、別のPCで
# 黙って間違った場所を指すことになるため、設定が無ければ止める。
if (-not $ConfigPath) { $ConfigPath = $env:BLMF_LAUNCHER_CONFIG }
if (-not $ConfigPath) { $ConfigPath = Join-Path $PSScriptRoot 'blmf-launcher.local.json' }
if (-not (Test-Path -LiteralPath $ConfigPath)) {
    Write-Err2 "設定ファイルがありません: $ConfigPath"
    Write-Info 'blmf-launcher.example.json を複製し、この環境のパスに書き換えてください。'
    exit 1
}
$config = Get-Content -LiteralPath $ConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json
$cam    = $config.cameraControl

function Get-ConfiguredPath ($value, $label) {
    if (-not $value) { Write-Err2 "設定に $label がありません ($ConfigPath)"; exit 1 }
    return [IO.Path]::GetFullPath([Environment]::ExpandEnvironmentVariables($value))
}

$RuntimeRoot = Get-ConfiguredPath $config.runtime.root 'runtime.root'
function Resolve-Runtime ($value, $fallback) {
    if ($value) { return [IO.Path]::GetFullPath([Environment]::ExpandEnvironmentVariables($value)) }
    return Join-Path $RuntimeRoot $fallback
}

$MainRoot   = Resolve-Runtime $config.runtime.mainObs 'BLMF-2026-Main-PoC'
$SubRoot    = Resolve-Runtime $config.runtime.subObs  'BLMF-2026-Windows-Sub-PoC'
$E2E        = Resolve-Runtime $config.runtime.controller 'windows-e2e'
$MainExe    = Join-Path $MainRoot 'bin\64bit\obs64.exe'
$SubExe     = Join-Path $SubRoot  'bin\64bit\obs64.exe'
$Runner     = Join-Path $E2E 'run-windows-local-osc.cjs'
$SubState   = Join-Path $E2E 'local-sub-state.json'
$RepoRoot   = Resolve-Runtime $config.runtime.nodeModulesRoot 'work\streamcaster'
$RunDir     = Join-Path $RuntimeRoot '.blmf-run'
$CamRoot    = Get-ConfiguredPath $cam.path 'cameraControl.path'
$MainWsPort = if ($config.runtime.mainWebSocketPort) { [int]$config.runtime.mainWebSocketPort } else { 4456 }
$ControllerPort = if ($config.runtime.controllerPort) { [int]$config.runtime.controllerPort } else { 18765 }
$Origin     = "http://127.0.0.1:$ControllerPort"
$OscPort    = if ($cam.forwardPort) { [int]$cam.forwardPort } else { 9001 }

if (-not (Test-Path $RunDir)) { New-Item -ItemType Directory -Path $RunDir | Out-Null }

function Get-ControllerState {
    try { return Invoke-RestMethod -Uri "$Origin/api/state" -TimeoutSec 2 } catch { return $null }
}

function Invoke-ControllerAction ($action) {
    return Invoke-RestMethod -Method Post -Uri "$Origin/api/action" -TimeoutSec 10 `
        -Headers @{ 'Origin' = $Origin; 'X-BLMF-Local' = '1' } `
        -ContentType 'application/json' -Body ("{""action"":""$action""}")
}

function Get-CameraHealth {
    try { return Invoke-RestMethod -Uri "http://127.0.0.1:$($cam.uiPort)/healthz" -TimeoutSec 2 } catch { return $null }
}

function Get-PortableObs ($exe) {
    return Get-Process obs64 -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $exe }
}

function Get-PortOwner ($port, $protocol) {
    try {
        if ($protocol -eq 'udp') { $ep = Get-NetUDPEndpoint -LocalPort $port -ErrorAction Stop | Select-Object -First 1 }
        else { $ep = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction Stop | Select-Object -First 1 }
    } catch { return $null }
    if (-not $ep) { return $null }
    $proc = $null
    try { $proc = Get-Process -Id $ep.OwningProcess -ErrorAction Stop } catch { }
    return [pscustomobject]@{ ProcessId = $ep.OwningProcess; Process = $proc }
}

# 既に終了しているプロセスの停止は失敗ではない ($ErrorActionPreference='Stop' で落とさない)
function Stop-ProcessSafely ($procId, $label) {
    try {
        Stop-Process -Id $procId -Force -ErrorAction Stop
        Write-Ok "$label (PID $procId) を停止しました"
    } catch {
        Write-Info "$label (PID $procId) は既に終了していました"
    }
}

# venv の python.exe は中継役で、実体の Python を子プロセスとして起動する。
# 記録した PID だけを止めると実体が残ってポートを掴み続けるため、子から止める。
# 親が先に死んでいても子の ParentProcessId は残るので、孤児も拾える。
function Stop-ProcessTree ($procId, $label) {
    Get-CimInstance Win32_Process -Filter "ParentProcessId=$procId" -ErrorAction SilentlyContinue |
        ForEach-Object { Stop-ProcessTree $_.ProcessId "$label (実体)" }
    Stop-ProcessSafely $procId $label
}

function Wait-PortFree ($port, $protocol, $seconds = 10) {
    for ($i = 0; $i -lt ($seconds * 2); $i++) {
        if (-not (Get-PortOwner $port $protocol)) { return $true }
        Start-Sleep -Milliseconds 500
    }
    return $false
}

function Save-Pid ($name, $procId) { Set-Content -Path (Join-Path $RunDir "$name.pid") -Value $procId -Encoding ascii }
function Get-SavedProcess ($name) {
    $file = Join-Path $RunDir "$name.pid"
    if (-not (Test-Path $file)) { return $null }
    $procId = (Get-Content $file -Raw).Trim()
    try { return Get-Process -Id $procId -ErrorAction Stop } catch { return $null }
}

# ---------------------------------------------------------------- 停止

function Stop-PortableObs ($label, $exe) {
    $proc = Get-PortableObs $exe
    if (-not $proc) { return }
    $proc | ForEach-Object { $_.CloseMainWindow() | Out-Null }
    Start-Sleep -Seconds 3
    $still = Get-PortableObs $exe
    if ($still) { Write-Warn2 "$label OBS がまだ終了していません (PID $($still.Id))。手動で閉じてください。" }
    else { Write-Ok "$label OBS を終了しました" }
}

if ($Stop) {
    Write-Step '停止します'
    $state = Get-ControllerState
    if ($state -and $state.service -eq 'blmf-manual-osc') {
        $null = Invoke-ControllerAction 'shutdown'
        Write-Ok 'OSC コントローラに停止を要求しました (受付済みの操作は完了してから終了)'
    } else {
        Write-Warn2 'OSC コントローラは起動していません'
    }
    $camPidFile = Join-Path $RunDir 'camera-control.pid'
    if (Test-Path $camPidFile) {
        # 中継役が消えていても実体が残っていることがあるので、生死に関わらずツリーごと止める
        Stop-ProcessTree ((Get-Content $camPidFile -Raw).Trim()) 'カメラコントロール'
        Remove-Item $camPidFile -Force
    } else {
        Write-Warn2 'カメラコントロールは起動していません'
    }
    if ($StopObs) {
        Stop-PortableObs 'Main' $MainExe
        Stop-PortableObs 'Sub'  $SubExe
    } else {
        Write-Info 'OBS は起動したままです (閉じるなら -Stop -StopObs)'
    }
    return
}

# ---------------------------------------------------------------- 事前チェック

Write-Step '構成を確認します'

$required = @(
    @{ Path = $MainExe; Name = '専用 Main OBS' },
    @{ Path = $SubExe;  Name = '専用 Sub OBS' },
    @{ Path = $Runner;  Name = 'コントローラ本体 (run-windows-local-osc.cjs)' },
    @{ Path = (Join-Path $E2E 'local-sub-observer.lua'); Name = 'Sub 観測スクリプト (lua)' },
    @{ Path = (Join-Path $RepoRoot 'node_modules\obs-websocket-js'); Name = 'obs-websocket-js' }
)
if (-not $NoCamera -and $cam.enabled) {
    $required += @{ Path = (Join-Path $CamRoot '.venv\Scripts\python.exe'); Name = 'カメラコントロールの venv' }
    $required += @{ Path = (Join-Path $CamRoot 'server.py'); Name = 'カメラコントロール本体' }
}
foreach ($item in $required) {
    if (-not (Test-Path -LiteralPath $item.Path)) {
        Write-Err2 "$($item.Name) が見つかりません: $($item.Path)"
        exit 1
    }
}
Write-Ok '必要なファイルを確認しました'

$node = Get-Command node.exe -ErrorAction SilentlyContinue
if (-not $node) { Write-Err2 'node.exe が見つかりません'; exit 1 }

$existing = Get-ControllerState
if ($existing -and $existing.service -eq 'blmf-manual-osc') {
    Write-Ok "OSC コントローラは起動済みです ($Origin)"
    if (-not $NoBrowser) { Start-Process $Origin }
    return
}

# VRChat の OSC 送信先は受信で確かめる。
# VRChat は Easy Anti-Cheat 下でコマンドラインを読めず、Steam は起動中
# localconfig.vdf を書き出さないので、どちらを見ても「未設定」に見えることがある。
# 実際にこのセッションで、正しく設定済みの環境を未設定と誤判定した。
# カメラサーバーが受信ポートを握っているため、判定はサーバーの状態から読む。
function Test-VrchatOscTraffic {
    $python = Join-Path $CamRoot '.venv\Scripts\python.exe'
    $probe  = Join-Path $CamRoot 'state_probe.py'
    if (-not (Test-Path $python) -or -not (Test-Path $probe)) { return $null }
    $line = & $python $probe --url "http://127.0.0.1:$($cam.uiPort)" `
        --feedback-port $cam.feedbackPort --seconds 2 2>&1 | Select-Object -Last 1
    return [pscustomobject]@{ Receiving = ($LASTEXITCODE -eq 0); Line = [string]$line }
}

# ---------------------------------------------------------------- カメラコントロール

# カメラ専用トークンは廃止された。localhost からの接続は物理アクセスとして扱われ、
# Tailscale 経由のときだけ Serve の身元ヘッダが必要になる。

# このランチャーが起動したもの以外の camera-control を探す (旧設定のインスタンス)
function Get-ForeignCameraProcess {
    $mine = Get-SavedProcess 'camera-control'
    $mineId = if ($mine) { $mine.Id } else { -1 }
    return Get-CimInstance Win32_Process -Filter "Name='python.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -like '*camera-control*' -and $_.CommandLine -like '*server.py*' -and $_.ProcessId -ne $mineId }
}

function Start-CameraControl {
    $mine = Get-SavedProcess 'camera-control'
    $health = Get-CameraHealth
    if ($mine -and $health -and $health.service -eq 'streamcaster-camera-control') {
        Write-Ok "カメラコントロールは起動済み (http://127.0.0.1:$($cam.uiPort))"
        return $true
    }
    # 別の場所・別設定で動いている camera-control は中継構成の邪魔になる
    $foreign = @(Get-ForeignCameraProcess)
    if ($foreign.Count -gt 0) {
        foreach ($item in $foreign) {
            Write-Warn2 "別の camera-control が動作中 (PID $($item.ProcessId))"
            Write-Info ($item.CommandLine.Substring(0, [Math]::Min(150, $item.CommandLine.Length)))
        }
        if ($Force) {
            foreach ($item in $foreign) { Stop-ProcessSafely $item.ProcessId '旧 camera-control' }
            $freed = (Wait-PortFree $cam.uiPort 'tcp') -and (Wait-PortFree $cam.forwardPort 'udp')
            if (-not $freed) {
                Write-Err2 "旧インスタンスの停止後もポートが解放されません (TCP $($cam.uiPort) / UDP $($cam.forwardPort))"
                return $false
            }
            Write-Ok '旧インスタンスを停止しました (-Force)'
        } else {
            Write-Err2 '中継構成で起動し直すため、上記を停止する必要があります。-Force を付けて実行してください。'
            return $false
        }
    }
    $owner = Get-PortOwner $cam.feedbackPort 'udp'
    if ($owner) {
        Write-Err2 "UDP $($cam.feedbackPort) が使用中です (PID $($owner.ProcessId) $($owner.Process.ProcessName))"
        return $false
    }
    $python = Join-Path $CamRoot '.venv\Scripts\python.exe'
    $arguments = @('server.py',
        '--port', $cam.uiPort,
        '--feedback-port', $cam.feedbackPort,
        '--forward-port', $cam.forwardPort,
        '--osc-port', $cam.oscPort)
    if ($cam.enablePoseWrite) { $arguments += '--enable-pose-write' }
    # VRChat が写真を書き出すフォルダ。UI はこの中の最新1枚だけを読む。
    if ($cam.photoDir) { $arguments += @('--photo-dir', (Get-ConfiguredPath $cam.photoDir 'cameraControl.photoDir')) }
    $out = Join-Path $RunDir 'camera-control.log'
    $err = Join-Path $RunDir 'camera-control.err'
    $proc = Start-Process -FilePath $python -ArgumentList $arguments -WorkingDirectory $CamRoot `
        -WindowStyle Hidden -PassThru -RedirectStandardOutput $out -RedirectStandardError $err
    Save-Pid 'camera-control' $proc.Id
    for ($i = 0; $i -lt 40; $i++) {
        Start-Sleep -Milliseconds 500
        if ($proc.HasExited) { break }
        $health = Get-CameraHealth
        if ($health -and $health.service -eq 'streamcaster-camera-control') {
            Write-Ok "カメラコントロール: http://127.0.0.1:$($cam.uiPort) (PID $($proc.Id))"
            Write-Info "使用中: $CamRoot"
            Write-Info "VRChat 受信 $($cam.feedbackPort) -> $($cam.forwardPort) へ転送 / VRChat 送信 $($cam.oscPort)"
            return $true
        }
    }
    Write-Warn2 'カメラコントロールを起動できませんでした'
    if (Test-Path $err) { Get-Content $err -Tail 10 | ForEach-Object { Write-Info $_ } }
    return $false
}

$cameraOn = $false
if ((-not $NoCamera) -and $cam.enabled) {
    Write-Step 'カメラコントロールを起動します (中継構成)'
    $cameraOn = Start-CameraControl
}

# ---------------------------------------------------------------- OSC ポートの確認

$udpOwner = Get-PortOwner $OscPort 'udp'
if ($udpOwner) {
    $ownerPath = $udpOwner.Process.Path
    if ($ownerPath -and $ownerPath -like '*camera-control*') {
        Write-Err2 "UDP $OscPort を旧設定のカメラコントロール (PID $($udpOwner.ProcessId)) が掴んでいます"
        Write-Info "中継構成では受信は $($cam.feedbackPort)、$OscPort は転送先として空けておく必要があります。"
        if ($Force) {
            Stop-ProcessSafely $udpOwner.ProcessId '旧 camera-control'
            if (-not (Wait-PortFree $OscPort 'udp')) {
                Write-Err2 "UDP $OscPort が解放されません"
                exit 1
            }
        } else {
            Write-Info '停止してよければ -Force を付けて実行してください。'
            exit 1
        }
    } else {
        Write-Err2 "OSC 受信ポート UDP $OscPort が使用中です (PID $($udpOwner.ProcessId) $($udpOwner.Process.ProcessName))"
        if ($udpOwner.Process) { Write-Info $udpOwner.Process.Path }
        exit 1
    }
}

$httpOwner = Get-PortOwner $ControllerPort 'tcp'
if ($httpOwner) {
    Write-Err2 "TCP $ControllerPort が別プロセスに使用されています (PID $($httpOwner.ProcessId))"
    exit 1
}

# ---------------------------------------------------------------- OBS 起動

function Start-PortableObs ($label, $obsRoot, $exe, $profileName) {
    $running = Get-PortableObs $exe
    if ($running) {
        Write-Ok "$label OBS は起動済み (PID $($running.Id))"
        return
    }
    $previous = $env:NDI_RUNTIME_DIR_V6
    try {
        $env:NDI_RUNTIME_DIR_V6 = Join-Path $obsRoot 'ndi-runtime'
        Start-Process -FilePath $exe -WorkingDirectory (Split-Path $exe) -WindowStyle Normal `
            -ArgumentList @('--portable', '--multi', '--disable-shutdown-check',
                            '--profile', $profileName, '--collection', $profileName) | Out-Null
    } finally { $env:NDI_RUNTIME_DIR_V6 = $previous }
    Write-Ok "$label OBS を起動しました (profile/collection: $profileName)"
}

function Test-SubStateFresh {
    if (-not (Test-Path -LiteralPath $SubState)) { return $false }
    try { $s = Get-Content -LiteralPath $SubState -Raw -Encoding UTF8 | ConvertFrom-Json } catch { return $false }
    if ($s.profile -ne 'BLMF Windows Sub PoC') { return $false }
    $age = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds() - [int64]$s.observedAt
    return ($age -ge 0 -and $age -le 3)
}

function Test-MainWebSocket {
    return [bool](Get-PortOwner $MainWsPort 'tcp')
}

function Wait-For ($label, $check, $seconds) {
    for ($i = 0; $i -lt ($seconds * 2); $i++) {
        if (& $check) { Write-Ok "$label OK"; return $true }
        Start-Sleep -Milliseconds 500
    }
    Write-Warn2 "$label が確認できませんでした (制限時間 $seconds 秒)"
    return $false
}

if (-not $NoObs) {
    Write-Step '専用 OBS を起動します (Sub -> Main)'
    Start-PortableObs 'Sub'  $SubRoot  $SubExe  'BLMF Windows Sub PoC'
    Start-Sleep -Seconds 2
    Start-PortableObs 'Main' $MainRoot $MainExe 'BLMF_WINDOWS_LOCAL_TEST'
} else {
    Write-Warn2 '-NoObs: OBS の起動はスキップします'
}

Write-Step 'OBS の準備を待ちます'
$subReady  = Wait-For 'Sub 観測 (local-sub-state.json が最新)' { Test-SubStateFresh } 90
$mainReady = Wait-For "Main WebSocket (TCP $MainWsPort)"       { Test-MainWebSocket } 90
if (-not $subReady) { Write-Info 'Sub OBS のツール > スクリプトに local-sub-observer.lua があるか確認してください。' }
if (-not $mainReady) { Write-Info "Main OBS の WebSocket サーバー設定 ($MainWsPort) を確認してください。" }

# ---------------------------------------------------------------- OSC コントローラ

Write-Step '手元 OSC コントローラを起動します'
$controller = Start-Process -FilePath $node.Source -ArgumentList ('"' + $Runner + '"') `
    -WorkingDirectory $E2E -WindowStyle Hidden -PassThru
Save-Pid 'osc-controller' $controller.Id

$state = $null
for ($i = 0; $i -lt 60; $i++) {
    Start-Sleep -Milliseconds 500
    $state = Get-ControllerState
    if ($state -and $state.service -eq 'blmf-manual-osc') { break }
    if ($controller.HasExited) { break }
    $state = $null
}

if (-not $state) {
    Write-Err2 'OSC コントローラを起動できませんでした (シーン・配信は変更していません)'
    Write-Info "UDP $OscPort / TCP $ControllerPort の空き状況と専用 OBS の状態を確認してください。"
    exit 1
}
Write-Ok "OSC コントローラ: $Origin (PID $($controller.Id))"

if (-not ($state.mainConnected -and $state.subConnected)) {
    Write-Info 'OBS への再接続を要求します...'
    try { $null = Invoke-ControllerAction 'reconnect' } catch { }
    Start-Sleep -Seconds 2
    $state = Get-ControllerState
}

Write-Info "Main OBS ($MainWsPort) : $(if($state.mainConnected){'接続'}else{'未接続'})  シーン: $($state.mainScene)"
Write-Info "Sub  OBS (file) : $(if($state.subConnected){'接続'}else{'未接続'})  シーン: $($state.subScene)"
Write-Info "OSC 受信        : $($state.udpEndpoint)"
if (-not $state.mainConnected) { Write-Warn2 'Main OBS 未接続 (プロファイル BLMF_WINDOWS_LOCAL_TEST か確認)' }
if (-not $state.subConnected)  { Write-Warn2 'Sub OBS 未接続 (Sub OBS と lua 観測を確認)' }

# ---------------------------------------------------------------- VRChat 側の確認

if ($cameraOn) {
    $traffic = Test-VrchatOscTraffic
    if ($null -eq $traffic) {
        Write-Warn2 'state_probe.py が見つからず、OSC 受信を確認できませんでした。'
    } elseif ($traffic.Receiving) {
        Write-Ok $traffic.Line
    } else {
        Write-Warn2 $traffic.Line
        Write-Info 'VRChat 未起動ならこれで正常です。起動済みなら Action Menu の OSC と、'
        Write-Info "Steam > VRChat > プロパティ > 起動オプションの --osc=$($cam.oscPort):127.0.0.1:$($cam.feedbackPort) を確認してください。"
        Write-Info 'カメラを動かしてから、このランチャーをもう一度実行すると再判定します。'
    }
}

# ---------------------------------------------------------------- 完了

if (-not $NoBrowser) {
    Start-Process $Origin
    if ($cameraOn) { Start-Process "http://127.0.0.1:$($cam.uiPort)" }
}

Write-Host ''
Write-Host '起動しました。' -ForegroundColor Green
Write-Host "  放送コントローラ : $Origin"
if ($cameraOn) {
    Write-Host "  カメラ操作       : http://127.0.0.1:$($cam.uiPort)  (「接続」を押すだけ。トークンは不要)"
}
Write-Host '  停止             : .\Start-BLMF-Local.ps1 -Stop   (OBS も閉じるなら -Stop -StopObs)'
Write-Host ''
