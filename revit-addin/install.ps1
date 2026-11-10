param(
    [string]$Configuration = "Release",
    [string]$RevitVersion = "2024"
)

$ErrorActionPreference = "Stop"

$runningRevit = Get-Process -Name Revit -ErrorAction SilentlyContinue
if ($runningRevit) {
    $pids = ($runningRevit | Select-Object -ExpandProperty Id) -join ", "
    throw "Revit is running (PID $pids) and locks the add-in DLL. Close Revit, run 'npm run addin:install', then reopen Revit."
}

$here = $PSScriptRoot
$project = Join-Path $here "FamilyAgent.Addin\FamilyAgent.Addin.csproj"
$revitDir = "C:\Program Files\Autodesk\Revit $RevitVersion"

if (-not (Test-Path $revitDir)) {
    throw "Revit $RevitVersion was not found in $revitDir"
}

Write-Host "Building FamilyAgent.Addin ($Configuration, Revit $RevitVersion)..."
dotnet build $project -c $Configuration "-p:RevitInstallDir=$revitDir"
if ($LASTEXITCODE -ne 0) { throw "dotnet build failed" }

$output = Join-Path $here "FamilyAgent.Addin\bin\$Configuration"
$addinsRoot = Join-Path $env:APPDATA "Autodesk\Revit\Addins\$RevitVersion"
$target = Join-Path $addinsRoot "FamilyAgent"

New-Item -ItemType Directory -Force -Path $target | Out-Null
Get-ChildItem $output -Filter *.dll | Copy-Item -Destination $target -Force

$manifest = Get-Content (Join-Path $here "FamilyAgent.addin.template") -Raw
$manifest = $manifest.Replace("{{ASSEMBLY}}", (Join-Path $target "FamilyAgent.Addin.dll"))
$manifestPath = Join-Path $addinsRoot "FamilyAgent.addin"
[System.IO.File]::WriteAllText($manifestPath, $manifest, (New-Object System.Text.UTF8Encoding($false)))

Write-Host ""
Write-Host "Installed:"
Write-Host "  $target"
Write-Host "  $manifestPath"
Write-Host ""
Write-Host "Start Revit $RevitVersion - the Family Agent tab and the studio bridge (127.0.0.1:8765) start automatically."
