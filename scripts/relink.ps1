# Re-create the node_modules junction that resolves @deepseek-ai/* imports
# for this bundle. Point it at a live DSH installation (the npx cache of the
# dsh version you boot with, or any directory whose node_modules contains the
# @deepseek-ai packages).
$ErrorActionPreference = "Stop"
$target = "C:\Users\cwtan\AppData\Local\npm-cache\_npx\1e7f6d9597241db0\node_modules"
$link = Join-Path $PSScriptRoot "..\node_modules"
if (-not (Test-Path $target)) { throw "DSH install anchor not found: $target" }
if (Test-Path $link) { (Get-Item $link).Delete() }
New-Item -ItemType Junction -Path $link -Target $target | Out-Null
Write-Host "linked: $link -> $target"
