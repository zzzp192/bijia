param(
    [string]$Version = (Get-Date -Format "yyyyMMdd"),
    [switch]$SkipTests = $false
)

$ErrorActionPreference = "Stop"
$ProjectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot "..\.."))
$PackagingDir = Join-Path $ProjectRoot "packaging\windows"
$ReleaseDir = Join-Path $ProjectRoot "release"
$StageDir = Join-Path $PackagingDir ".stage"
$PayloadZip = Join-Path $PackagingDir ".stage_payload.zip"
$InstallerOutput = Join-Path $ReleaseDir "Bijia-Setup-$Version.exe"
$CscCompiler = "C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe"

Write-Host "==================================================" -ForegroundColor Cyan
Write-Host " 工业标准品多平台比价系统 Windows 在线引导式单文件打包" -ForegroundColor Cyan
Write-Host " 架构: Thin Online Bootstrap Installer (<10 MB)" -ForegroundColor Cyan
Write-Host " 版本: $Version" -ForegroundColor Cyan
Write-Host " 输出: $InstallerOutput" -ForegroundColor Cyan
Write-Host "==================================================" -ForegroundColor Cyan

# 1. 运行自动化测试套件
if (-not $SkipTests) {
    Write-Host "`n[1/6] 正在运行自动化测试套件..." -ForegroundColor Yellow
    $PythonExe = Join-Path $ProjectRoot ".venv\Scripts\python.exe"
    if (-not (Test-Path $PythonExe)) {
        $PythonExe = "python"
    }
    & $PythonExe -m pytest "$ProjectRoot\tests"
    if ($LASTEXITCODE -ne 0) {
        throw "测试用例未全部通过，打包中止！"
    }
    Write-Host "测试用例全部通过！" -ForegroundColor Green
} else {
    Write-Host "`n[1/6] 跳过测试运行 (-SkipTests)" -ForegroundColor Gray
}

# 2. 确保高清图标存在
$IconPath = Join-Path $PackagingDir "assets\app.ico"
if (-not (Test-Path $IconPath)) {
    Write-Host "`n[2/6] 正在生成高分辨率多尺寸图标..." -ForegroundColor Yellow
    $GenScript = Join-Path $PackagingDir "assets\generate_icon.py"
    py -3 $GenScript
}

# 3. 准备轻量化源码载荷暂存区 (Thin)
Write-Host "`n[3/6] 正在准备轻量化源码载荷暂存区..." -ForegroundColor Yellow
$StageScript = Join-Path $PackagingDir "stage_package.py"
py -3 $StageScript --stage --project-root $ProjectRoot --stage-dir $StageDir
if ($LASTEXITCODE -ne 0) {
    throw "准备暂存区失败！"
}

# 4. 编译原生引导启动器 (Bijia.exe) 与安全卸载向导 (Uninstall.exe)
Write-Host "`n[4/6] 正在编译原生引导启动器 (Bijia.exe) 与安全卸载向导 (Uninstall.exe)..." -ForegroundColor Yellow
$CommonValidatorCs = Join-Path $PackagingDir "src\Common\PathSecurityValidator.cs"

$LauncherManifest = Join-Path $PackagingDir "src\Launcher\App.manifest"
$LauncherProgramCs = Join-Path $PackagingDir "src\Launcher\Program.cs"
$LauncherJobObjectCs = Join-Path $PackagingDir "src\Launcher\JobObject.cs"
$LauncherBootstrapCs = Join-Path $PackagingDir "src\Launcher\RuntimeBootstrap.cs"
$LauncherBootstrapFormCs = Join-Path $PackagingDir "src\Launcher\BootstrapForm.cs"
$StageLauncherExe = Join-Path $StageDir "Bijia.exe"

$LauncherArgs = @(
    "/nologo",
    "/optimize+",
    "/target:winexe",
    "-win32manifest:$LauncherManifest",
    "-win32icon:$IconPath",
    "-r:System.dll,System.Core.dll,System.Drawing.dll,System.Windows.Forms.dll,System.IO.Compression.dll,System.IO.Compression.FileSystem.dll",
    "-out:$StageLauncherExe",
    $LauncherProgramCs,
    $LauncherJobObjectCs,
    $LauncherBootstrapCs,
    $LauncherBootstrapFormCs
)
& $CscCompiler $LauncherArgs

if ($LASTEXITCODE -ne 0) {
    throw "编译 Bijia.exe 失败！"
}
Write-Host "Bijia.exe (带引导配置向导) 编译成功。" -ForegroundColor Green

$UninstallerManifest = Join-Path $PackagingDir "src\Uninstaller\App.manifest"
$UninstallerSrc = Join-Path $PackagingDir "src\Uninstaller\Program.cs"
$StageUninstallerExe = Join-Path $StageDir "Uninstall.exe"

$UninstallerArgs = @(
    "/nologo",
    "/optimize+",
    "/target:winexe",
    "-win32manifest:$UninstallerManifest",
    "-win32icon:$IconPath",
    "-r:System.dll,System.Core.dll,System.Drawing.dll,System.Windows.Forms.dll",
    "-out:$StageUninstallerExe",
    $UninstallerSrc,
    $CommonValidatorCs
)
& $CscCompiler $UninstallerArgs

if ($LASTEXITCODE -ne 0) {
    throw "编译 Uninstall.exe 失败！"
}
Write-Host "Uninstall.exe 编译成功。" -ForegroundColor Green

# 复制图标至暂存根目录
Copy-Item -LiteralPath $IconPath -Destination (Join-Path $StageDir "app.ico")

# 重新压缩内嵌载荷 (包含编译好的二进制与源码)
Write-Host "`n[5/6] 正在封装完整轻量化内嵌载荷 (Payload Archive)..." -ForegroundColor Yellow
py -3 $StageScript --zip --stage-dir $StageDir --zip-path $PayloadZip
if ($LASTEXITCODE -ne 0) {
    throw "打包载荷压缩包失败！"
}

# 5. 构建单文件轻量化安装程序 (Bijia-Setup-Version.exe)
Write-Host "`n[6/6] 正在构建单文件 Windows 安装分发包: $InstallerOutput ..." -ForegroundColor Yellow
if (-not (Test-Path $ReleaseDir)) {
    New-Item -ItemType Directory -Path $ReleaseDir -Force | Out-Null
}
if (Test-Path $InstallerOutput) {
    Remove-Item -Force $InstallerOutput
}

$InstallerManifest = Join-Path $PackagingDir "src\Installer\App.manifest"
$InstallerSrc = Join-Path $PackagingDir "src\Installer\Program.cs"

$ResIcon = "-res:{0},AppIcon" -f $IconPath
$ResPayload = "-res:{0},PayloadResource" -f $PayloadZip

$InstallerArgs = @(
    "/nologo",
    "/optimize+",
    "/target:winexe",
    "-win32manifest:$InstallerManifest",
    "-win32icon:$IconPath",
    "-r:System.dll,System.Core.dll,System.Drawing.dll,System.Windows.Forms.dll,System.IO.Compression.dll,System.IO.Compression.FileSystem.dll",
    $ResIcon,
    $ResPayload,
    "-out:$InstallerOutput",
    $InstallerSrc,
    $CommonValidatorCs
)
& $CscCompiler $InstallerArgs

if ($LASTEXITCODE -ne 0) {
    throw "构建安装包 EXE 失败！"
}

# 清理临时文件
py -3 $StageScript --clean --stage-dir $StageDir --zip-path $PayloadZip

# 计算文件大小与 SHA-256 哈希
$FileInfo = Get-Item -LiteralPath $InstallerOutput
$Hash = (Get-FileHash -LiteralPath $InstallerOutput -Algorithm SHA256).Hash
$SizeMB = [Math]::Round($FileInfo.Length / 1MB, 2)
$SizeKB = [Math]::Round($FileInfo.Length / 1KB, 2)

Write-Host "`n==================================================" -ForegroundColor Green
Write-Host " 打包成功！单文件轻量化 Windows 安装程序已就绪：" -ForegroundColor Green
Write-Host " 文件路径: $InstallerOutput" -ForegroundColor White
Write-Host " 文件大小: $SizeMB MB ($SizeKB KB)" -ForegroundColor White
Write-Host " SHA-256:  $Hash" -ForegroundColor White
Write-Host "==================================================" -ForegroundColor Green

if ($SizeMB -gt 10) {
    throw "致命错误：安装包体积 ($SizeMB MB) 超出 10 MB 规定上限！"
}

[PSCustomObject]@{
    Artifact = $InstallerOutput
    SizeMB   = $SizeMB
    SizeKB   = $SizeKB
    SHA256   = $Hash
    Version  = $Version
}
