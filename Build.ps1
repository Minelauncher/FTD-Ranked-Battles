param([switch]$Tests,[string]$GameManaged,[string]$HarmonyPath)
$ErrorActionPreference='Stop'
$buildArgs=@('build',(Join-Path $PSScriptRoot 'src/RankedBattles.csproj'),'-c','Release')
if($GameManaged){$buildArgs+="-p:GameManaged=$GameManaged"}
if($HarmonyPath){$buildArgs+="-p:HarmonyPath=$HarmonyPath"}
dotnet @buildArgs
if($LASTEXITCODE -ne 0){throw 'Ranked Battles build failed.'}
if($Tests){
 dotnet run --project (Join-Path $PSScriptRoot 'tests/ClientStorage/ClientStorage.csproj') -c Release
 if($LASTEXITCODE -ne 0){throw 'Client storage tests failed.'}
}
$dist=Join-Path $PSScriptRoot 'dist/RankedBattles'
New-Item -ItemType Directory -Path $dist -Force | Out-Null
$files=@('plugin.json','header.header','README.txt','RankedBattles.dll','0Harmony.dll')
if(Test-Path -LiteralPath (Join-Path $PSScriptRoot 'header.jpg')){
 $files+='header.jpg'
 Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'header.jpg') -Destination $dist
}
foreach($name in @('plugin.json','header.header','README.txt')){Copy-Item -LiteralPath (Join-Path $PSScriptRoot $name) -Destination $dist}
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'src/bin/Release/netstandard2.1/RankedBattles.dll') -Destination $dist
if(-not $HarmonyPath){$HarmonyPath=Join-Path $PSScriptRoot 'lib/0Harmony.dll'}
Copy-Item -LiteralPath $HarmonyPath -Destination $dist
$version=(Get-Content -LiteralPath (Join-Path $PSScriptRoot 'plugin.json') -Raw | ConvertFrom-Json).version
# Explicit names and POSIX ZIP separators; never package credentials or test state.
Add-Type -AssemblyName System.IO.Compression, System.IO.Compression.FileSystem
$zip=Join-Path $PSScriptRoot "dist/RankedBattles-$version.zip"
$stream=[IO.File]::Open($zip,[IO.FileMode]::Create)
$archive=[IO.Compression.ZipArchive]::new($stream,[IO.Compression.ZipArchiveMode]::Create)
try {
 foreach($name in $files){[IO.Compression.ZipFileExtensions]::CreateEntryFromFile($archive,(Join-Path $dist $name),"RankedBattles/$name") | Out-Null}
} finally {$archive.Dispose();$stream.Dispose()}
Write-Output $dist
Write-Output $zip
