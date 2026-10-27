param([Parameter(Mandatory=$true)][string]$RunDirectory,[switch]$Resume)
$ErrorActionPreference='Stop'
$run=(Resolve-Path -LiteralPath $RunDirectory).Path
$source=Split-Path $PSScriptRoot -Parent
$project=Split-Path (Split-Path $source -Parent) -Parent
$manifest=Get-Content -LiteralPath (Join-Path $run 'manifest.json') -Raw | ConvertFrom-Json
$rankDll=Join-Path $source 'dist\RankedBattles\RankedBattles.dll'
if((Get-FileHash -LiteralPath $rankDll -Algorithm SHA256).Hash.ToLowerInvariant() -ne $manifest.rankDllSha256){throw 'Ranked DLL differs from frozen manifest.'}
if((Test-Path -LiteralPath (Join-Path $run 'batch-status.json')) -and -not $Resume){throw 'Existing batch requires -Resume.'}
foreach($match in $manifest.games){
 $output=Join-Path $run ('games\'+('{0:D2}' -f [int]$match.index))
 $completed=Join-Path $output 'calibration-result.json'
 if(Test-Path -LiteralPath $completed){
  $saved=Get-Content -LiteralPath $completed -Raw | ConvertFrom-Json
  if(-not $saved.passed -or $saved.game.id -ne $match.id){throw 'Invalid saved result.'}
  continue
 }
 if(Get-Process From_The_Depths -ErrorAction SilentlyContinue){throw 'An FTD process is already running. It will not be stopped.'}
 $root=Join-Path ([IO.Path]::GetTempPath()) ('FC\'+[guid]::NewGuid().ToString('N').Substring(0,10))
 if($root -match '[^\x00-\x7F]'){throw 'ASCII TEMP required.'}
 $save=Join-Path $root 'SaveData\From The Depths'; $mods=Join-Path $save 'Mods'
 New-Item -ItemType Directory -Path $mods -Force | Out-Null
 $profile=Join-Path $project 'RankIsolationProbe\A\SaveData\From The Depths'
 foreach($name in @('Options.dat','Player Profiles')){Copy-Item -LiteralPath (Join-Path $profile $name) -Destination $save -Recurse}
 Copy-Item -LiteralPath (Join-Path $source 'dist\RankedBattles') -Destination $mods -Recurse
 $probe=Join-Path $mods 'CalibrationProbe'; New-Item -ItemType Directory -Path $probe | Out-Null
 Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'CalibrationProbe\bin\Release\netstandard2.1\CalibrationProbe.dll') -Destination $probe
 @{name='CalibrationProbe';version='0.1.0';gameversion='4.3.4.1';filename='CalibrationProbe.dll';depends=@('Ranked Battles');conflicts=@()} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $probe 'plugin.json')
 @{Authors='Local calibration';Version='00000000-0000-0000-0000-000000000000';ComponentId=@{Guid='b60a06fe-7db5-41e8-a4f5-d78203637654';Name='CalibrationProbe'}} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $probe 'header.header')
 Copy-Item -LiteralPath (Join-Path $output 'case.json') -Destination $root
 Set-Content -LiteralPath (Join-Path $root 'SaveLocation.txt') -Value (Join-Path $root 'SaveData') -NoNewline -Encoding utf8
 Copy-Item -LiteralPath (Join-Path $project 'RankIsolationProbe\A\steam_appid.txt') -Destination $root
 @{Settings=@(@{'$type'='BrilliantSkies.Boot.Settings.BootSetting_NoSplashScreen, Ftd'});Instructions=@();DeleteOnRead=$false} | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $root 'boot.json')
 $game=$null
 try {
  $args=@(('"'+(Join-Path $root 'boot.json')+'"'),'-batchmode','-nosound','-screen-fullscreen','0','-screen-width','1280','-screen-height','800','-logFile',('"'+(Join-Path $root 'game.log')+'"'))
  $game=Start-Process -FilePath 'C:\Program Files (x86)\Steam\steamapps\common\From The Depths\From_The_Depths.exe' -WorkingDirectory $root -ArgumentList $args -WindowStyle Hidden -PassThru
  @{status='running';index=$match.index;total=$manifest.games.Count;owner=$match.owner;opponent=$match.opponent;seed=$match.seed;gamePid=$game.Id;testRoot=$root} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $run 'batch-status.json')
  Write-Output "START $($match.index)/$($manifest.games.Count): $($match.owner) vs $($match.opponent), seed=$($match.seed), PID=$($game.Id)"
  $deadline=(Get-Date).AddSeconds(900)
  while(-not(Test-Path -LiteralPath (Join-Path $root 'calibration-result.json'))){
   if(Test-Path -LiteralPath (Join-Path $root 'calibration-fatal.txt')){throw (Get-Content -LiteralPath (Join-Path $root 'calibration-fatal.txt') -Raw)}
   if($game.WaitForExit(1000)){throw 'FTD exited before producing a result.'}
   if((Get-Date) -gt $deadline){throw 'Battle watchdog timeout.'}
  }
  $report=Get-Content -LiteralPath (Join-Path $root 'calibration-result.json') -Raw | ConvertFrom-Json
  if(-not $report.passed -or $report.game.id -ne $match.id){throw 'Result validation failed.'}
  Write-Output "DONE $($match.index): score=$($report.result.score), seconds=$($report.result.seconds), wall=$($report.wallSeconds)"
 } finally {
  if($game -and -not $game.HasExited){Stop-Process -Id $game.Id;[void]$game.WaitForExit(10000)}
  foreach($name in @('calibration-result.json','calibration-fatal.txt','progress.json','game.log')){
   if(Test-Path -LiteralPath (Join-Path $root $name)){Copy-Item -LiteralPath (Join-Path $root $name) -Destination $output -Force}
  }
  if(Test-Path -LiteralPath (Join-Path $save 'Logs')){Copy-Item -LiteralPath (Join-Path $save 'Logs') -Destination $output -Recurse -Force}
  if(Test-Path -LiteralPath (Join-Path $mods 'RankedBattles\errors.log')){Copy-Item -LiteralPath (Join-Path $mods 'RankedBattles\errors.log') -Destination $output -Force}
 }
}
@{status='complete';total=$manifest.games.Count} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $run 'batch-status.json')
Write-Output 'Calibration complete.'
