param([Parameter(Mandatory=$true)][string]$Distribution, [string]$HomePath=(Join-Path $PSScriptRoot '.runtime'))
$ErrorActionPreference='Stop'
& (Join-Path $PSScriptRoot 'Verify-Distribution.ps1') -Distribution $Distribution
$target=[IO.Path]::GetFullPath($HomePath)
if(Test-Path -LiteralPath $target){throw 'Destination already exists. Choose a NEW installation directory.'}
$null=New-Item -ItemType Directory -Path $target
$acl=Get-Acl -LiteralPath $target
$acl.SetAccessRuleProtection($true,$false)
foreach($sid in @([Security.Principal.WindowsIdentity]::GetCurrent().User, [Security.Principal.SecurityIdentifier]'S-1-5-18', [Security.Principal.SecurityIdentifier]'S-1-5-32-544')) {
 $rule=New-Object Security.AccessControl.FileSystemAccessRule($sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow')
 $acl.AddAccessRule($rule)
}
Set-Acl -LiteralPath $target -AclObject $acl
& python (Join-Path $PSScriptRoot 'setup.py') --home $target --distribution $Distribution
if($LASTEXITCODE -ne 0){throw 'Setup failed. Destination left for inspection; no OBS was launched.'}
Write-Output 'Setup complete. Follow README for sender selection and authenticated local Main WebSocket setup.'
