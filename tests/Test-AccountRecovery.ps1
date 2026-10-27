param([switch]$Capture)
$ErrorActionPreference='Stop'
if(Get-Process From_The_Depths -ErrorAction SilentlyContinue){throw 'User game is running; no process will be stopped.'}
$source=Split-Path $PSScriptRoot -Parent
$project=Split-Path (Split-Path $source -Parent) -Parent
$root=Join-Path ([IO.Path]::GetTempPath()) ('FR\recovery-'+[guid]::NewGuid().ToString('N').Substring(0,10))
$save=Join-Path $root 'SaveData\From The Depths'
$mods=Join-Path $save 'Mods'
New-Item -ItemType Directory -Path $mods -Force | Out-Null
if($Capture){
 $captureOutput=Join-Path $PSScriptRoot ('runs\account-ui-'+(Get-Date -Format 'yyyyMMdd-HHmmss'))
 New-Item -ItemType Directory -Path $captureOutput | Out-Null
 @{output=$captureOutput} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $root 'account-capture.json') -Encoding utf8
}
$profile=Join-Path $project 'RankIsolationProbe\A\SaveData\From The Depths'
foreach($name in @('Options.dat','Player Profiles')){Copy-Item -LiteralPath (Join-Path $profile $name) -Destination $save -Recurse}
Copy-Item -LiteralPath (Join-Path $source 'dist\RankedBattles') -Destination $mods -Recurse
$probe=Join-Path $mods 'RecoveryProbe'
New-Item -ItemType Directory -Path $probe | Out-Null
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'RecoveryProbe\bin\Release\netstandard2.1\RecoveryProbe.dll') -Destination $probe
@{name='RecoveryProbe';version='0.1.0';gameversion='4.3.4.1';filename='RecoveryProbe.dll';depends=@('Ranked Battles');conflicts=@()} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $probe 'plugin.json')
@{Authors='Local integration test';Version='00000000-0000-0000-0000-000000000000';ComponentId=@{Guid='8f3c86e4-e00f-46d8-9c2e-dd8df2a9de62';Name='RecoveryProbe'}} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $probe 'header.header')
Set-Content -LiteralPath (Join-Path $root 'SaveLocation.txt') -Value (Join-Path $root 'SaveData') -NoNewline -Encoding utf8
Copy-Item -LiteralPath (Join-Path $project 'RankIsolationProbe\A\steam_appid.txt') -Destination $root
@{Settings=@(@{'$type'='BrilliantSkies.Boot.Settings.BootSetting_NoSplashScreen, Ftd'});Instructions=@();DeleteOnRead=$false} | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $root 'boot.json')
$game=$null
try {
 $width=if($Capture){'1600'}else{'1280'}; $height=if($Capture){'1000'}else{'800'}
 $arguments=@(('"'+(Join-Path $root 'boot.json')+'"'),'-nosound','-screen-fullscreen','0','-screen-width',$width,'-screen-height',$height,'-logFile',('"'+(Join-Path $root 'game.log')+'"'))
 if(-not $Capture){$arguments+='-batchmode'}
 # Visible capture is used only when the user requested actual UI screenshots.
 $windowStyle=if($Capture){'Normal'}else{'Hidden'}
 $game=Start-Process -FilePath 'C:\Program Files (x86)\Steam\steamapps\common\From The Depths\From_The_Depths.exe' -WorkingDirectory $root -ArgumentList $arguments -WindowStyle $windowStyle -PassThru
 Write-Output "TestRoot=$root GamePID=$($game.Id)"
 $deadline=(Get-Date).AddSeconds(120)
 while(-not(Test-Path -LiteralPath (Join-Path $root 'recovery-pass.txt'))){
  if(Test-Path -LiteralPath (Join-Path $root 'recovery-failed.txt')){throw (Get-Content -LiteralPath (Join-Path $root 'recovery-failed.txt') -Raw)}
  if($game.WaitForExit(1000)){
   if(Test-Path -LiteralPath (Join-Path $root 'recovery-pass.txt')){break}
   if(Test-Path -LiteralPath (Join-Path $root 'recovery-failed.txt')){throw (Get-Content -LiteralPath (Join-Path $root 'recovery-failed.txt') -Raw)}
   throw 'FTD exited before the probe completed'
  }
  if((Get-Date) -gt $deadline){throw 'Recovery probe timed out'}
 }
 Get-Content -LiteralPath (Join-Path $root 'recovery-pass.txt')
 if($Capture){Write-Output "Screenshots=$captureOutput"}
} finally {
 if($game -and -not $game.HasExited){if(-not $game.WaitForExit(5000)){Stop-Process -Id $game.Id;[void]$game.WaitForExit(5000)}}
 $archive=Join-Path $PSScriptRoot ('runs\recovery-'+(Get-Date -Format 'yyyyMMdd-HHmmss'))
 New-Item -ItemType Directory -Path $archive -Force | Out-Null
 foreach($name in @('game.log','recovery-pass.txt','recovery-failed.txt','recovery-progress.txt')){
  if(Test-Path -LiteralPath (Join-Path $root $name)){Copy-Item -LiteralPath (Join-Path $root $name) -Destination $archive}
 }
 if(Test-Path -LiteralPath (Join-Path $save 'Logs')){Copy-Item -LiteralPath (Join-Path $save 'Logs') -Destination $archive -Recurse}
 Write-Output "Archive=$archive"
}

