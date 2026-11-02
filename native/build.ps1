param([switch]$Preview, [string]$ReaPackagePath)

$ErrorActionPreference = 'Stop'
function Get-Sha256Hex([string]$Path) {
    $stream = [IO.File]::OpenRead($Path)
    $sha256 = [Security.Cryptography.SHA256]::Create()
    try { return [BitConverter]::ToString($sha256.ComputeHash($stream)).Replace('-', '').ToLowerInvariant() }
    finally { $sha256.Dispose(); $stream.Dispose() }
}

$repo = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$version = (Get-Content -LiteralPath (Join-Path $repo 'package.json') -Raw | ConvertFrom-Json).version
$stage = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot 'stage'))
$expectedStage = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot 'stage'))
if ($stage -ne $expectedStage -or -not $stage.StartsWith([IO.Path]::GetFullPath($PSScriptRoot), [StringComparison]::OrdinalIgnoreCase)) {
    throw "Unexpected staging path: $stage"
}
if (Test-Path -LiteralPath $stage) {
    $emptyStage = Join-Path $PSScriptRoot ('.stage-empty-' + $PID)
    New-Item -ItemType Directory -Force -Path $emptyStage | Out-Null
    $robocopy = (Get-Command robocopy.exe -ErrorAction Stop).Source
    & $robocopy $emptyStage $stage /MIR /R:1 /W:1 /NFL /NDL /NP /NJH /NJS /NC /NS /MT:24
    if ($LASTEXITCODE -ge 8) { throw "Clearing the build stage failed with robocopy exit code $LASTEXITCODE." }
    Remove-Item -LiteralPath $emptyStage -Force
    Remove-Item -LiteralPath $stage -Force
}
New-Item -ItemType Directory -Force -Path $stage | Out-Null

$compilerVersion = '4.12.0'
$toolRoot = Join-Path $env:LOCALAPPDATA "LocalMcpStudio\BuildTools\Roslyn\$compilerVersion"
$csc = Join-Path $toolRoot 'tasks\net472\csc.exe'
if (-not (Test-Path -LiteralPath $csc)) {
    New-Item -ItemType Directory -Force -Path $toolRoot | Out-Null
    $archive = Join-Path $toolRoot "Microsoft.Net.Compilers.Toolset.$compilerVersion.nupkg"
    if (-not (Test-Path -LiteralPath $archive)) {
        Invoke-WebRequest -Uri "https://www.nuget.org/api/v2/package/Microsoft.Net.Compilers.Toolset/$compilerVersion" -OutFile $archive
    }
    $zip = Join-Path $toolRoot "Microsoft.Net.Compilers.Toolset.$compilerVersion.zip"
    Copy-Item -LiteralPath $archive -Destination $zip -Force
    Expand-Archive -LiteralPath $zip -DestinationPath $toolRoot -Force
}
if (-not (Test-Path -LiteralPath $csc)) { throw "Roslyn compiler missing after extraction: $csc" }

$pf = Get-ChildItem -LiteralPath (Join-Path $env:windir 'Microsoft.NET\assembly\GAC_MSIL\PresentationFramework') -Filter PresentationFramework.dll -Recurse | Select-Object -First 1
$pc = Get-ChildItem -LiteralPath (Join-Path $env:windir 'Microsoft.NET\assembly\GAC_64\PresentationCore') -Filter PresentationCore.dll -Recurse | Select-Object -First 1
$wb = Get-ChildItem -LiteralPath (Join-Path $env:windir 'Microsoft.NET\assembly\GAC_MSIL\WindowsBase') -Filter WindowsBase.dll -Recurse | Select-Object -First 1
$framework = Join-Path $env:windir 'Microsoft.NET\Framework64\v4.0.30319'
if (-not $pf -or -not $pc -or -not $wb) { throw 'WPF reference assemblies were not found. Install .NET Framework 4.8 on this build machine.' }

$appExe = Join-Path $stage 'LocalMcpStudio.exe'
$cscArgs = @(
    '/nologo', '/langversion:latest', '/target:winexe', '/platform:x64', '/optimize+',
    "/out:$appExe",
    "/win32icon:$(Join-Path $repo 'assets\app.ico')",
    "/win32manifest:$(Join-Path $PSScriptRoot 'LocalMcpStudio.exe.manifest')",
    "/reference:$($pf.FullName)", "/reference:$($pc.FullName)", "/reference:$($wb.FullName)",
    "/reference:$(Join-Path $framework 'System.Xaml.dll')",
    '/reference:System.Net.Http.dll', '/reference:System.Windows.Forms.dll',
    (Join-Path $PSScriptRoot 'LocalMcpStudio.cs')
)
if ($Preview) { $cscArgs += '/define:LOCALMCP_PREVIEW' }
& $csc @cscArgs
if ($LASTEXITCODE -ne 0) { throw "Native UI compilation failed with exit code $LASTEXITCODE" }

$assets = Join-Path $stage 'assets'
$sourceAssets = Join-Path $repo 'assets'
New-Item -ItemType Directory -Force -Path $assets | Out-Null
foreach ($file in @('app.ico', 'lilac-bunny.png', 'lilac-bunny.svg', 'CLOUDFLARED-LICENSE.txt')) {
    Copy-Item -LiteralPath (Join-Path $sourceAssets $file) -Destination $assets
}
$cloudflaredVersion = '2026.10.7'
$cloudflaredHash = '2493dbc168923bb3e59e5e7716f71deced92992eea9acd6e9d74f84ac7751343'
$cloudflaredSource = Join-Path $sourceAssets 'cloudflared.exe'
if (-not (Test-Path -LiteralPath $cloudflaredSource)) {
    $cloudflaredCache = Join-Path $env:LOCALAPPDATA "LocalMcpStudio\BuildTools\cloudflared\$cloudflaredVersion\cloudflared.exe"
    if (-not (Test-Path -LiteralPath $cloudflaredCache)) {
        New-Item -ItemType Directory -Force -Path (Split-Path -Parent $cloudflaredCache) | Out-Null
        $download = "$cloudflaredCache.download"
        Invoke-WebRequest -Uri "https://github.com/cloudflare/cloudflared/releases/download/$cloudflaredVersion/cloudflared-windows-amd64.exe" -OutFile $download
        $downloadHash = Get-Sha256Hex $download
        if ($downloadHash -ne $cloudflaredHash) { Remove-Item -LiteralPath $download -Force; throw "cloudflared SHA-256 mismatch: $downloadHash" }
        Move-Item -LiteralPath $download -Destination $cloudflaredCache -Force
    }
    $cloudflaredSource = $cloudflaredCache
}
$actualCloudflaredHash = Get-Sha256Hex $cloudflaredSource
if ($actualCloudflaredHash -ne $cloudflaredHash) { throw "cloudflared SHA-256 mismatch: $actualCloudflaredHash" }
Copy-Item -LiteralPath $cloudflaredSource -Destination (Join-Path $assets 'cloudflared.exe')
Copy-Item -LiteralPath (Join-Path $repo 'src') -Destination $stage -Recurse
Copy-Item -LiteralPath (Join-Path $repo 'README.md') -Destination (Join-Path $stage 'README.txt')
New-Item -ItemType Directory -Force -Path (Join-Path $stage 'runtime') | Out-Null
$node = (Get-Command node.exe -ErrorAction Stop).Source
$runtimeVersionText = (& $node --version | Out-String).Trim()
if ($LASTEXITCODE -ne 0) { throw 'Could not read the bundled Node.js runtime version.' }
try { $runtimeVersion = [version]$runtimeVersionText.TrimStart('v') } catch { throw "Unexpected Node.js version '$runtimeVersionText'." }
$reaNodeCompatible = ($runtimeVersion.Major -eq 22 -and $runtimeVersion -ge [version]'22.23.4') -or ($runtimeVersion.Major -eq 24 -and $runtimeVersion -ge [version]'24.22.1') -or ($runtimeVersion.Major -ge 26 -and $runtimeVersion -ge [version]'26.12.1')
if (-not $reaNodeCompatible) { throw "REA 6.8.0 requires Node.js 22.23.4+, 24.22.1+, or 26.12.1+; found $runtimeVersionText." }
Copy-Item -LiteralPath $node -Destination (Join-Path $stage 'runtime\node.exe')

$runtimePackage = '{"name":"local-mcp-studio-native-backend","version":"' + $version + '","private":true,"dependencies":{"ssh2":"1.17.0"}}'
[IO.File]::WriteAllText((Join-Path $stage 'package.json'), $runtimePackage, [Text.UTF8Encoding]::new($false))
$npm = (Get-Command npm.cmd -ErrorAction Stop).Source
& $npm install --prefix $stage --omit=dev --ignore-scripts --no-audit --no-fund --no-package-lock
if ($LASTEXITCODE -ne 0) { throw "Installing the native backend dependency failed with exit code $LASTEXITCODE" }

if ([string]::IsNullOrWhiteSpace($ReaPackagePath)) { $ReaPackagePath = $env:LOCALMCP_REA_PACKAGE }
if ([string]::IsNullOrWhiteSpace($ReaPackagePath)) {
    $globalNodeModules = (& $npm root -g | Out-String).Trim()
    if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($globalNodeModules)) { throw 'Could not resolve the global npm package directory for REA.' }
    $ReaPackagePath = Join-Path $globalNodeModules 'rea-agents'
}
$ReaPackagePath = [IO.Path]::GetFullPath($ReaPackagePath)
$reaManifest = Join-Path $ReaPackagePath 'package.json'
if (-not (Test-Path -LiteralPath $reaManifest) -or -not (Test-Path -LiteralPath (Join-Path $ReaPackagePath 'scripts\rea.mjs')) -or -not (Test-Path -LiteralPath (Join-Path $ReaPackagePath 'dist\mcp-catalog-full.json'))) {
    throw "REA MCP package 6.8.0 is incomplete at '$ReaPackagePath'. Install the user's REA package or pass -ReaPackagePath."
}
$reaVersion = (Get-Content -LiteralPath $reaManifest -Raw | ConvertFrom-Json).version
if ($reaVersion -ne '6.8.0') { throw "Expected REA MCP package 6.8.0, found '$reaVersion'." }
$reaCatalogPath = Join-Path $ReaPackagePath 'dist\mcp-catalog-full.json'
$reaToolCountText = (& $node -e "const fs=require('node:fs'); process.stdout.write(String(JSON.parse(fs.readFileSync(process.argv[1],'utf8')).tools.length))" $reaCatalogPath | Out-String).Trim()
if ($LASTEXITCODE -ne 0 -or $reaToolCountText -notmatch '^\d+$') { throw 'Could not read REA MCP tool count from its full catalog.' }
$reaTarget = Join-Path $stage 'rea'
New-Item -ItemType Directory -Force -Path $reaTarget | Out-Null
$robocopy = (Get-Command robocopy.exe -ErrorAction Stop).Source
& $robocopy $ReaPackagePath $reaTarget /E /COPY:DAT /DCOPY:DAT /R:1 /W:1 /NFL /NDL /NP /NJH /NJS /NC /NS /MT:24
if ($LASTEXITCODE -ge 8) { throw "Copying REA's package files failed with robocopy exit code $LASTEXITCODE." }
Write-Output "Bundled REA MCP $reaVersion ($reaToolCountText tools)"

if ($Preview) {
    Start-Process -FilePath $appExe -WorkingDirectory $stage
    return
}

$dist = Join-Path $repo 'dist'
New-Item -ItemType Directory -Force -Path $dist | Out-Null
$portable = Join-Path $dist "Local MCP Studio-$version-Portable.zip"
if (Test-Path -LiteralPath $portable) { Remove-Item -LiteralPath $portable -Force }
Compress-Archive -Path (Join-Path $stage '*') -DestinationPath $portable -CompressionLevel Optimal

$nsisExe = (Get-Command makensis.exe -ErrorAction SilentlyContinue).Source
if (-not $nsisExe) {
    foreach ($candidate in @(
        (Join-Path $env:ProgramFiles 'NSIS\makensis.exe'),
        (Join-Path ${env:ProgramFiles(x86)} 'NSIS\makensis.exe')
    )) {
        if (Test-Path -LiteralPath $candidate) { $nsisExe = $candidate; break }
    }
}
if (-not $nsisExe) {
    $builderCache = Join-Path $env:LOCALAPPDATA 'electron-builder\Cache'
    $nsis = if (Test-Path -LiteralPath $builderCache) { Get-ChildItem -LiteralPath $builderCache -Filter makensis.exe -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1 }
    if ($nsis) { $nsisExe = $nsis.FullName }
}
if (-not $nsisExe) { throw 'NSIS 3.x was not found. Install NSIS 3.x to build the setup executable.' }
Push-Location $PSScriptRoot
try { & $nsisExe "/DPRODUCT_VERSION=$version" 'setup.nsi'; if ($LASTEXITCODE -ne 0) { throw "NSIS failed with exit code $LASTEXITCODE" } }
finally { Pop-Location }
Write-Output "Native build complete: $portable and dist\Local MCP Studio-$version-Setup-x64.exe"
