param([string]$OutputPath)

$ErrorActionPreference = 'Stop'
$repo = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$version = (Get-Content -LiteralPath (Join-Path $repo 'package.json') -Raw | ConvertFrom-Json).version
if ([string]::IsNullOrWhiteSpace($OutputPath)) {
    $dist = Join-Path $repo 'dist'
    New-Item -ItemType Directory -Force -Path $dist | Out-Null
    $OutputPath = Join-Path $dist "Local MCP Studio-$version-Source.zip"
} else {
    $OutputPath = [IO.Path]::GetFullPath($OutputPath)
}

$includeFiles = @(
    '.gitignore', 'README.md', 'package.json', 'package-lock.json', 'start.bat',
    'src/main.js',
    'ui/index.html', 'ui/app.js', 'ui/style.css', 'ui/icons.svg', 'ui/lilac-bunny.svg',
    'desktop/main.js',
    'native/LocalMcpStudio.cs', 'native/LocalMcpStudio.exe.manifest', 'native/build.ps1', 'native/setup.nsi',
    'server/README.md', 'server/nginx-local-mcp.conf', 'server/nginx-acme-bootstrap.conf',
    'server/sshd-match-localmcp.conf', 'server/local-mcp-cert-renew.cron', 'server/renew-cert.sh',
    'plugin-package/plugin.json', 'plugin-package/assets/lilac-bunny.svg',
    'assets/app.ico', 'assets/lilac-bunny.png', 'assets/lilac-bunny.svg', 'assets/CLOUDFLARED-LICENSE.txt',
    'scripts/pack-source.ps1'
)

$zipPath = [IO.Path]::GetFullPath($OutputPath)
$zipParent = Split-Path -Parent $zipPath
New-Item -ItemType Directory -Force -Path $zipParent | Out-Null
$prefix = [IO.Path]::GetFullPath($repo).TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar

Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zipMode = if (Test-Path -LiteralPath $zipPath) { [IO.Compression.ZipArchiveMode]::Update } else { [IO.Compression.ZipArchiveMode]::Create }
$archive = [IO.Compression.ZipFile]::Open($zipPath, $zipMode)
try {
    if ($zipMode -eq [IO.Compression.ZipArchiveMode]::Update) {
        foreach ($entry in @($archive.Entries)) { $entry.Delete() }
    }
    foreach ($relative in $includeFiles) {
        $source = [IO.Path]::GetFullPath((Join-Path $repo ($relative -replace '/', '\')))
        if (-not $source.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) { throw "Source path escaped the project: $relative" }
        if (-not (Test-Path -LiteralPath $source -PathType Leaf)) { throw "Source file is missing: $relative" }
        $entryName = $relative -replace '\\', '/'
        [void][IO.Compression.ZipFileExtensions]::CreateEntryFromFile($archive, $source, $entryName, [IO.Compression.CompressionLevel]::Optimal)
    }
} finally {
    $archive.Dispose()
}

Write-Output "Source archive created: $zipPath"
