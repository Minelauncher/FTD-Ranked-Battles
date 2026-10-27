$ErrorActionPreference='Stop'
if(Get-Process From_The_Depths -ErrorAction SilentlyContinue){throw 'User game is running; no process will be stopped.'}
$source=Split-Path $PSScriptRoot -Parent
$project=Split-Path (Split-Path $source -Parent) -Parent
$root=Join-Path ([IO.Path]::GetTempPath()) ('FR\missing-block-'+[guid]::NewGuid().ToString('N').Substring(0,10))
$save=Join-Path $root 'SaveData\From The Depths'
$mods=Join-Path $save 'Mods'
New-Item -ItemType Directory -Path $mods -Force | Out-Null
$profile=Join-Path $project 'RankIsolationProbe\A\SaveData\From The Depths'
foreach($name in @('Options.dat','Player Profiles')){Copy-Item -LiteralPath (Join-Path $profile $name) -Destination $save -Recurse}
Copy-Item -LiteralPath (Join-Path $source 'dist\RankedBattles') -Destination $mods -Recurse
$probe=Join-Path $mods 'MissingBlockProbe'
New-Item -ItemType Directory -Path $probe | Out-Null
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'MissingBlockProbe\bin\Release\netstandard2.1\MissingBlockProbe.dll') -Destination $probe
@{name='MissingBlockProbe';version='0.1.0';gameversion='4.3.4.1';filename='MissingBlockProbe.dll';depends=@('Ranked Battles');conflicts=@()} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $probe 'plugin.json')
@{Authors='Local integration test';Version='00000000-0000-0000-0000-000000000000';ComponentId=@{Guid='9d5a0514-1f51-4c17-82ec-7a03cc8d27a8';Name='MissingBlockProbe'}} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $probe 'header.header')
Set-Content -LiteralPath (Join-Path $root 'SaveLocation.txt') -Value (Join-Path $root 'SaveData') -NoNewline -Encoding utf8
Copy-Item -LiteralPath (Join-Path $project 'RankIsolationProbe\A\steam_appid.txt') -Destination $root
@{Settings=@(@{'$type'='BrilliantSkies.Boot.Settings.BootSetting_NoSplashScreen, Ftd'});Instructions=@();DeleteOnRead=$false} | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $root 'boot.json')
$game=$null
try {
 $arguments=@(('"'+(Join-Path $root 'boot.json')+'"'),'-batchmode','-nosound','-screen-fullscreen','0','-screen-width','1280','-screen-height','800','-logFile',('"'+(Join-Path $root 'game.log')+'"'))
 $game=Start-Process -FilePath 'C:\Program Files (x86)\Steam\steamapps\common\From The Depths\From_The_Depths.exe' -WorkingDirectory $root -ArgumentList $arguments -WindowStyle Hidden -PassThru
 Write-Output "TestRoot=$root GamePID=$($game.Id)"
 $deadline=(Get-Date).AddSeconds(120)
 while(-not(Test-Path -LiteralPath (Join-Path $root 'missing-block-pass.txt'))){
  if(Test-Path -LiteralPath (Join-Path $root 'missing-block-failed.txt')){throw (Get-Content -LiteralPath (Join-Path $root 'missing-block-failed.txt') -Raw)}
  if($game.WaitForExit(1000)){
   if(Test-Path -LiteralPath (Join-Path $root 'missing-block-pass.txt')){break}
   if(Test-Path -LiteralPath (Join-Path $root 'missing-block-failed.txt')){throw (Get-Content -LiteralPath (Join-Path $root 'missing-block-failed.txt') -Raw)}
   throw 'FTD exited before the probe completed'
  }
  if((Get-Date) -gt $deadline){throw 'Missing block probe timed out'}
 }
 Get-Content -LiteralPath (Join-Path $root 'missing-block-pass.txt')
} finally {
 if($game -and -not $game.HasExited){if(-not $game.WaitForExit(5000)){Stop-Process -Id $game.Id;[void]$game.WaitForExit(5000)}}
 $archive=Join-Path $PSScriptRoot ('runs\missing-block-'+(Get-Date -Format 'yyyyMMdd-HHmmss'))
 New-Item -ItemType Directory -Path $archive -Force | Out-Null
 foreach($name in @('game.log','missing-block-pass.txt','missing-block-failed.txt','missing-block-progress.txt')){
  if(Test-Path -LiteralPath (Join-Path $root $name)){Copy-Item -LiteralPath (Join-Path $root $name) -Destination $archive}
 }
 if(Test-Path -LiteralPath (Join-Path $save 'Logs')){Copy-Item -LiteralPath (Join-Path $save 'Logs') -Destination $archive -Recurse}
 Write-Output "Archive=$archive"
}
