param([string]$HomePath=(Join-Path $PSScriptRoot '.runtime'))
$ErrorActionPreference='Stop'
$status=Get-Content -LiteralPath (Join-Path $HomePath 'control/controller-status.json') -Raw | ConvertFrom-Json
$origin=$status.origin
if($origin -notmatch '^http://127\.0\.0\.1:\d+$'){throw 'Invalid controller origin'}
$state=Invoke-RestMethod "$origin/api/state" -TimeoutSec 3
if($state.service -ne 'blmf-manual-osc'){throw 'Unexpected service'}
$null=Invoke-RestMethod "$origin/api/action" -Method Post -ContentType application/json -Headers @{Origin=$origin;'X-BLMF-Local'='1'} -Body '{"action":"shutdown"}'
Write-Output 'Controller shutdown requested; no OBS output stop or scene restoration is scheduled.'
