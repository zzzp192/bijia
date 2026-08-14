param(
    [string]$Version = (Get-Date -Format "yyyyMMdd")
)

$ErrorActionPreference = "Stop"
$ProjectRoot = [System.IO.Path]::GetFullPath($PSScriptRoot)
$ReleaseRoot = Join-Path $ProjectRoot "release"
$PackageName = "bijia-release-$Version"
$StageRoot = Join-Path $ReleaseRoot $PackageName
$ZipPath = Join-Path $ReleaseRoot "$PackageName.zip"

if (-not $StageRoot.StartsWith($ReleaseRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Unsafe staging path: $StageRoot"
}
if (Test-Path -LiteralPath $StageRoot) {
    throw "Staging directory already exists: $StageRoot"
}
if (Test-Path -LiteralPath $ZipPath) {
    throw "Release archive already exists: $ZipPath"
}

New-Item -ItemType Directory -Path $StageRoot -Force | Out-Null

function Copy-ReleaseTree {
    param(
        [Parameter(Mandatory = $true)][string]$RelativeSource,
        [string]$RelativeDestination = $RelativeSource
    )

    $Source = Join-Path $ProjectRoot $RelativeSource
    $Destination = Join-Path $StageRoot $RelativeDestination
    $SourcePrefix = $Source.TrimEnd([char[]]@('\', '/')) + [System.IO.Path]::DirectorySeparatorChar
    Get-ChildItem -LiteralPath $Source -Recurse -File | Where-Object {
        $_.Name -notmatch '\.py[co]$' -and
        $_.FullName -notmatch '[\\/]__pycache__[\\/]' -and
        $_.FullName -notmatch '[\\/]\.git[\\/]'
    } | ForEach-Object {
        $RelativeFile = $_.FullName.Substring($SourcePrefix.Length)
        $TargetFile = Join-Path $Destination $RelativeFile
        $TargetDirectory = Split-Path -Parent $TargetFile
        New-Item -ItemType Directory -Path $TargetDirectory -Force | Out-Null
        Copy-Item -LiteralPath $_.FullName -Destination $TargetFile
    }
}

foreach ($Directory in @("adapters", "backend", "browser", "fixtures", "frontend", "matching")) {
    Copy-ReleaseTree $Directory
}

New-Item -ItemType Directory -Path (Join-Path $StageRoot "scripts") -Force | Out-Null
Copy-Item -LiteralPath (Join-Path $ProjectRoot "scripts\open_login_browser.py") -Destination (Join-Path $StageRoot "scripts\open_login_browser.py")

Copy-ReleaseTree "vendor"

foreach ($File in @("run_server.py", "install.bat", "start.bat", "README_FIRST.txt", "README.md", "CHANGELOG.md", "THIRD_PARTY.md", ".gitignore")) {
    Copy-Item -LiteralPath (Join-Path $ProjectRoot $File) -Destination (Join-Path $StageRoot $File)
}

foreach ($EmptyDirectory in @("cookies", "browser_profiles", "data")) {
    $DirectoryPath = Join-Path $StageRoot $EmptyDirectory
    New-Item -ItemType Directory -Path $DirectoryPath -Force | Out-Null
    Set-Content -LiteralPath (Join-Path $DirectoryPath ".gitkeep") -Value "" -Encoding Ascii
}

$ForbiddenFiles = Get-ChildItem -LiteralPath $StageRoot -Recurse -File | Where-Object {
    $_.Name -in @(".env", "taobao.json", "bijia.db") -or
    $_.Extension -in @(".db", ".sqlite", ".sqlite3", ".log", ".cookie", ".session", ".token") -or
    ($_.FullName -match '[\\/](cookies|browser_profiles|data)[\\/]' -and $_.Name -ne ".gitkeep")
}
if ($ForbiddenFiles) {
    throw "Sensitive or runtime files entered the staging directory: $($ForbiddenFiles.FullName -join ', ')"
}

Compress-Archive -LiteralPath $StageRoot -DestinationPath $ZipPath -CompressionLevel Optimal
$Hash = (Get-FileHash -LiteralPath $ZipPath -Algorithm SHA256).Hash
$SizeMB = [Math]::Round((Get-Item -LiteralPath $ZipPath).Length / 1MB, 2)

[PSCustomObject]@{
    Archive = $ZipPath
    SizeMB = $SizeMB
    SHA256 = $Hash
}
