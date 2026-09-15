param([string]$HomePath=(Join-Path $PSScriptRoot '.runtime'))
$ErrorActionPreference='Stop'
$previous=$env:BLMF_POC_HOME
try {
 $env:BLMF_POC_HOME=[IO.Path]::GetFullPath($HomePath)
 $node=(Get-Command node.exe).Source
 Start-Process -FilePath $node -ArgumentList ('"'+(Join-Path $PSScriptRoot 'run.cjs')+'"') -WorkingDirectory $PSScriptRoot -WindowStyle Hidden
} finally {$env:BLMF_POC_HOME=$previous}
Write-Output 'Controller launch requested. Open http://127.0.0.1:18765/ (or the port in control/ui.local.json).'
