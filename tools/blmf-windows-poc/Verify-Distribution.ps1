param([Parameter(Mandatory=$true)][string]$Distribution)
$ErrorActionPreference='Stop'
$manifest=Get-Content -LiteralPath (Join-Path $PSScriptRoot 'distribution-manifest.json') -Raw | ConvertFrom-Json
foreach($file in $manifest.files){
 $path=Join-Path $Distribution $file.path
 if(-not(Test-Path -LiteralPath $path -PathType Leaf)){throw ('Missing component: '+$file.path)}
 if((Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLower() -ne $file.sha256){throw ('Component differs from validated PoC: '+$file.path)}
}
Write-Output 'Required OBS, DistroAV, Spout2 and NDI component hashes match the validated PoC.'
