# ZAのWork-Zone — Windows 本机构建。在解压后的仓库根目录运行。
# 用法：powershell -ExecutionPolicy Bypass -File .\setup-windows.ps1
$ErrorActionPreference = "Stop"
Set-Location -Path $PSScriptRoot

function Refresh-Path {
  $machine = [Environment]::GetEnvironmentVariable("Path", "Machine")
  $user = [Environment]::GetEnvironmentVariable("Path", "User")
  $env:Path = "$machine;$user"
}

function Have($name) {
  return [bool](Get-Command $name -ErrorAction SilentlyContinue)
}

Write-Host "检查 ZAのWork-Zone 的 Windows 构建环境"
Refresh-Path

if (-not (Have "node")) {
  Write-Host "缺少 Node.js。正在安装 22 ..."
  winget install --id OpenJS.NodeJS.22 -e --accept-package-agreements --accept-source-agreements
  Refresh-Path
}
$nodeMajor = [int]((node -p "process.versions.node.split('.')[0]"))
if ($nodeMajor -lt 22) {
  throw "Node 是 $nodeMajor。请安装 22 或 24，不要用 18。"
}

if (-not (Have "rustup")) {
  Write-Host "缺少 Rust。正在安装 rustup ..."
  winget install --id Rustlang.Rustup -e --accept-package-agreements --accept-source-agreements
  Refresh-Path
}
if (-not (Have "rustup")) {
  throw "rustup 已安装但不在 PATH。请新开一个终端后重跑本脚本。"
}

$hostLine = rustc -vV | Select-String "^host:"
if ($hostLine -notmatch "x86_64-pc-windows-msvc") {
  Write-Host "当前 Rust 宿主不是 MSVC，正在切换 ..."
  rustup toolchain install stable-x86_64-pc-windows-msvc
  rustup default stable-x86_64-pc-windows-msvc
}

$vswhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
if (-not (Test-Path $vswhere)) {
  Write-Host "缺少 Visual Studio Installer。正在安装 Build Tools（需要管理员，大约几 GB）..."
  winget install --id Microsoft.VisualStudio.2022.BuildTools -e --accept-package-agreements --accept-source-agreements --override "--passive --wait --add Microsoft.VisualStudio.Workload.VCTools --add Microsoft.VisualStudio.Component.VC.Tools.x86.x64 --add Microsoft.VisualStudio.Component.Windows11SDK.22621"
}
if (-not (Test-Path $vswhere)) {
  throw "找不到 vswhere。请用管理员 PowerShell 重跑，或手动安装 VS 2022 Build Tools（勾选“使用 C++ 的桌面开发”）。"
}
$vs = & $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
if (-not $vs) {
  throw "装了 Visual Studio，但没有 MSVC x64。请加上「使用 C++ 的桌面开发」工作负载后重跑。"
}
$devcmd = Join-Path $vs "Common7\Tools\VsDevCmd.bat"
if (-not (Test-Path $devcmd)) {
  throw "找不到 $devcmd"
}
Write-Host "注入 MSVC 环境：$devcmd"
cmd /c "`"$devcmd`" -no_logo -arch=x64 -host_arch=x64 && set" | ForEach-Object {
  if ($_ -match "^(.*?)=(.*)$") {
    [Environment]::SetEnvironmentVariable($matches[1], $matches[2], "Process")
  }
}

if (-not (Test-Path "package-lock.json")) {
  throw "这不是仓库根目录。请把 zip 解压到能直接看到 package.json 的那一层。"
}

# npm 会把弃用警告写到 stderr。PowerShell 5.1 在 ErrorActionPreference=Stop 下会把原生程序的
# stderr 当成终止错误，npm ci 刚开口就被打断。这里放宽为 Continue，失败仍由 $LASTEXITCODE 判断。
$ErrorActionPreference = "Continue"
Write-Host "安装 npm 依赖（含 @tauri-apps/cli）"
npm ci
if ($LASTEXITCODE -ne 0) { throw "npm ci 失败" }

Write-Host "编译安装包。第一次大约 10 到 20 分钟。"
npm run desktop:build
if ($LASTEXITCODE -ne 0) { throw "tauri build 失败" }

$setup = Get-ChildItem -Path "src-tauri\target\release\bundle\nsis\*-setup.exe" | Select-Object -First 1
if (-not $setup) { throw "编译结束但没有找到 NSIS 安装包。" }
Write-Host "安装包：$($setup.FullName)"
Write-Host "请用户运行它。未签名，SmartScreen 选「更多信息」再「仍要运行」。不要关闭 Defender。"
