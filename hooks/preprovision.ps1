#!/usr/bin/env pwsh
# azd preprovision hook — fail closed unless authentication is configured.
# Values come from the azd environment (azd exports them to hooks). Secret values are never printed.
$ErrorActionPreference = 'Stop'

function Get-AzdValue([string]$name) {
    $value = [Environment]::GetEnvironmentVariable($name)
    if ([string]::IsNullOrWhiteSpace($value)) {
        $value = (azd env get-value $name 2>$null | Out-String).Trim()
        if ($LASTEXITCODE -ne 0) { $value = '' }
    }
    return $value
}

# AUTH_MODE is read from the azd environment ONLY, never from the process environment:
# run-local.ps1 sets $env:AUTH_MODE = 'disabled' in developer shells, which must not decide a deployment.
# Checked first so that no other path (including ALLOW_INSECURE_NO_AUTH) can skip it.
function Get-AzdEnvOnlyValue([string]$name) {
    $value = (azd env get-value $name 2>$null | Out-String).Trim()
    if ($LASTEXITCODE -ne 0) { $value = '' }
    return $value
}

if ((Get-AzdEnvOnlyValue 'AUTH_MODE').ToLowerInvariant() -eq 'disabled') {
    Write-Host 'ERROR: refusing to provision: AUTH_MODE=disabled is set in the azd environment.' -ForegroundColor Red
    Write-Host 'It makes every caller an admin and the deployed backend refuses it on Azure Container Apps anyway.' -ForegroundColor Red
    Write-Host 'Fix it with: azd env set AUTH_MODE easyauth' -ForegroundColor Yellow
    Write-Host 'To test production as an admin use Entra bearer tokens (AUTH_EXTRA_CLIENT_APPS): docs/provisioning.md section 3.1' -ForegroundColor Yellow
    exit 1
}

$insecure = (Get-AzdValue 'ALLOW_INSECURE_NO_AUTH').ToLowerInvariant() -eq 'true'
$required = @('AUTH_CLIENT_ID', 'AUTH_CLIENT_SECRET', 'ALLOWED_OBJECT_IDS')
$missing = @($required | Where-Object { [string]::IsNullOrWhiteSpace((Get-AzdValue $_)) })

if ($missing.Count -gt 0) {
    if ($insecure) {
        Write-Host ''
        Write-Host '############################################################################' -ForegroundColor Red
        Write-Host '#  WARNING: ALLOW_INSECURE_NO_AUTH=true — provisioning WITHOUT Easy Auth.' -ForegroundColor Red
        Write-Host "#  Missing: $($missing -join ', ')" -ForegroundColor Red
        Write-Host '#  The app will be public and read-only: nobody can sign in or act as admin.' -ForegroundColor Red
        Write-Host '############################################################################' -ForegroundColor Red
        Write-Host ''
        exit 0
    }
    Write-Host "ERROR: refusing to provision without authentication. Missing azd env values: $($missing -join ', ')" -ForegroundColor Red
    Write-Host 'Set them with: azd env set AUTH_CLIENT_ID <app-id>; azd env set AUTH_CLIENT_SECRET <secret>; azd env set ALLOWED_OBJECT_IDS <oid1,oid2>' -ForegroundColor Yellow
    Write-Host 'Or, for a throw-away public read-only demo only: azd env set ALLOW_INSECURE_NO_AUTH true' -ForegroundColor Yellow
    exit 1
}

$guid = '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
$bad = @()
if ((Get-AzdValue 'AUTH_CLIENT_ID').Trim() -notmatch $guid) { $bad += 'AUTH_CLIENT_ID' }
$tenant = Get-AzdValue 'AUTH_TENANT_ID'
if (-not [string]::IsNullOrWhiteSpace($tenant) -and $tenant.Trim() -notmatch $guid) { $bad += 'AUTH_TENANT_ID' }
foreach ($oid in (Get-AzdValue 'ALLOWED_OBJECT_IDS').Split(',')) {
    if ($oid.Trim() -notmatch $guid) { $bad += 'ALLOWED_OBJECT_IDS'; break }
}
if ($bad.Count -gt 0) {
    Write-Host "ERROR: expected GUID value(s) in: $($bad -join ', ') (ALLOWED_OBJECT_IDS is a comma-separated list of GUIDs)" -ForegroundColor Red
    exit 1
}

Write-Host 'preprovision: Easy Auth configuration present (AUTH_CLIENT_ID, AUTH_CLIENT_SECRET, ALLOWED_OBJECT_IDS).' -ForegroundColor Green
exit 0
