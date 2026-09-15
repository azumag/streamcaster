param([Parameter(Mandatory=$true)][ValidateSet('main','sub')][string]$Role,[string]$HomePath=(Join-Path $PSScriptRoot '.runtime'))
$ErrorActionPreference='Stop'
$homeResolved=[IO.Path]::GetFullPath($HomePath)
$install=Get-Content -LiteralPath (Join-Path $homeResolved 'poc-install.json') -Raw | ConvertFrom-Json
if($install.configOnly){throw 'Configuration-only test installation cannot launch OBS.'}
$obsRoot=Join-Path $homeResolved $Role
$exe=Join-Path $obsRoot 'bin\64bit\obs64.exe'
if(Get-Process obs64 -ErrorAction SilentlyContinue | Where-Object Path -eq $exe){throw 'This dedicated OBS is already running.'}
$profile=if($Role -eq 'main'){'BLMF_WINDOWS_LOCAL_TEST'}else{'"BLMF Windows Sub PoC"'}
$previous=$env:NDI_RUNTIME_DIR_V6
try {
 $env:NDI_RUNTIME_DIR_V6=Join-Path $obsRoot 'ndi-runtime'
 Start-Process -FilePath $exe -WorkingDirectory (Split-Path $exe) -WindowStyle Normal -ArgumentList @('--portable','--multi','--profile',$profile,'--collection',$profile)
} finally {$env:NDI_RUNTIME_DIR_V6=$previous}
