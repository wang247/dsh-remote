# 本地构建 APK（自动准备 JDK17 + Android SDK 到 %TEMP%\dsh-apk-build，需能访问外网）
param([string]$BuildDir = "$env:TEMP\dsh-apk-build", [ValidateSet("debug","release")] [string]$Mode = "debug")
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot

Write-Host "== 准备工具链（$BuildDir）=="
$env:DSH_BUILD_DIR = $BuildDir
node "$root\bridge\scripts\download-toolchain.mjs"

# 解压 JDK（首次）
$jdkDir = Join-Path $BuildDir "jdk17"
if (-not (Test-Path (Join-Path $jdkDir "bin\java.exe"))) {
  Write-Host "== 解压 JDK =="
  Expand-Archive -Path (Join-Path $BuildDir "jdk17.zip") -DestinationPath $BuildDir -Force
  Get-ChildItem $BuildDir -Directory | Where-Object { $_.Name -like "jdk-17*" } | ForEach-Object { Move-Item $_.FullName $jdkDir -ErrorAction SilentlyContinue }
  if (-not (Test-Path (Join-Path $jdkDir "bin\java.exe"))) { throw "JDK 解压失败" }
}

# 解压 cmdline-tools + 装 SDK 组件（首次）
$sdkDir = Join-Path $BuildDir "sdk"
$cmdline = Join-Path $sdkDir "cmdline-tools"
if (-not (Test-Path (Join-Path $cmdline "latest\bin\sdkmanager.bat"))) {
  Write-Host "== 解压 cmdline-tools =="
  New-Item -ItemType Directory -Force -Path $cmdline | Out-Null
  Expand-Archive -Path (Join-Path $BuildDir "cmdline-tools.zip") -DestinationPath (Join-Path $cmdline "tmp") -Force
  Get-ChildItem (Join-Path $cmdline "tmp") -Directory | Where-Object { $_.Name -eq "cmdline-tools" } | ForEach-Object { Move-Item (Join-Path $_.FullName "*") (Join-Path $cmdline "latest") -Force }
  Remove-Item (Join-Path $cmdline "tmp") -Recurse -Force
}
if (-not (Test-Path (Join-Path $sdkDir "platforms"))) {
  Write-Host "== 安装 Android SDK 组件（platform-tools / build-tools / platform 34）=="
  $env:JAVA_HOME = $jdkDir
  $env:ANDROID_HOME = $sdkDir
  $sdk = Join-Path $cmdline "latest\bin\sdkmanager.bat"
  cmd /c "echo y | `"$sdk`" --sdk_root=`"$sdkDir`" platform-tools `"build-tools;34.0.0`" `"platforms;android-34`""
}

Write-Host "== 构建 web + 同步 + 出 APK =="
$env:JAVA_HOME = $jdkDir
$env:ANDROID_HOME = $sdkDir
Push-Location (Join-Path $root "app")
npm run build
npx cap sync android
Push-Location android
if ($Mode -eq "debug") { .\gradlew.bat assembleDebug } else { .\gradlew.bat assembleRelease }
Pop-Location
Pop-Location
Write-Host ""
Write-Host "✅ APK 已生成: app\android\app\build\outputs\apk\$Mode\app-$Mode.apk"
