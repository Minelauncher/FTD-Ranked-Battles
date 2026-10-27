param([ValidateSet('neter','aote')][string]$World='neter',[double]$East=1.5,[double]$North=1.5,[double]$Altitude=10,[switch]$SystemOpponent,[switch]$Surrender,[switch]$ResultRecovery,[switch]$GroundLoad,[switch]$StorageFallback,[string]$LiveChatSettings)
$ErrorActionPreference='Stop'
if(Get-Process From_The_Depths -ErrorAction SilentlyContinue){throw 'Close existing FTD first. User game will not be stopped.'}
$source=Split-Path $PSScriptRoot -Parent
$project=Split-Path (Split-Path $source -Parent) -Parent
$root=Join-Path ([IO.Path]::GetTempPath()) ('FR\'+[guid]::NewGuid().ToString('N').Substring(0,10))
if($root -match '[^\x00-\x7F]'){throw 'ASCII TEMP required for Unity/Harmony.'}
$save=Join-Path $root 'SaveData\From The Depths'
$mods=Join-Path $save 'Mods'
New-Item -ItemType Directory -Path $mods -Force | Out-Null
@{world=$World;boardEast=$East;boardNorth=$North;altitude=$Altitude;systemOpponent=[bool]$SystemOpponent;surrender=[bool]$Surrender;resultRecovery=[bool]$ResultRecovery;groundLoad=[bool]$GroundLoad;storageFallback=[bool]$StorageFallback;liveChatSettings=$LiveChatSettings} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $root 'map-test.json') -Encoding utf8
if($GroundLoad){Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'campaign-data/event-expansion.json') -Destination (Join-Path $root 'ground-plan.json')}
$profile=Join-Path $project 'RankIsolationProbe\A\SaveData\From The Depths'
foreach($name in @('Options.dat','Player Profiles')){Copy-Item -LiteralPath (Join-Path $profile $name) -Destination $save -Recurse}
Copy-Item -LiteralPath (Join-Path $source 'dist\RankedBattles') -Destination $mods -Recurse
if($StorageFallback){New-Item -ItemType Directory -Path (Join-Path $save 'RankedBattles') | Out-Null}
$probe=Join-Path $mods 'FleetProbe'
New-Item -ItemType Directory -Path $probe | Out-Null
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'FleetProbe\bin\Release\netstandard2.1\FleetProbe.dll') -Destination $probe
@{name='FleetProbe';version='0.1.0';gameversion='4.3.4.1';filename='FleetProbe.dll';depends=@('Ranked Battles');conflicts=@()} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $probe 'plugin.json')
@{Authors='Local integration test';Version='00000000-0000-0000-0000-000000000000';ComponentId=@{Guid='f050f85f-91db-4854-b137-59bde272c939';Name='FleetProbe'}} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $probe 'header.header')
Set-Content -LiteralPath (Join-Path $root 'SaveLocation.txt') -Value (Join-Path $root 'SaveData') -NoNewline -Encoding utf8
Copy-Item -LiteralPath (Join-Path $project 'RankIsolationProbe\A\steam_appid.txt') -Destination $root
@{Settings=@(@{'$type'='BrilliantSkies.Boot.Settings.BootSetting_NoSplashScreen, Ftd'});Instructions=@();DeleteOnRead=$false} | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $root 'boot.json')
$node=(Get-Command node.exe).Source
$server=Start-Process -FilePath $node -ArgumentList @(('"'+(Join-Path $source 'server\cloudflare\tools\serve-local-test.mjs')+'"'),('"'+$root+'"')) -WorkingDirectory $root -WindowStyle Hidden -RedirectStandardError (Join-Path $root 'server-errors.log') -RedirectStandardOutput (Join-Path $root 'server.log') -PassThru
$game=$null
try {
 $deadline=(Get-Date).AddSeconds(25)
 while(-not(Test-Path -LiteralPath (Join-Path $root 'fixture-ready'))){if($server.HasExited -or (Get-Date) -gt $deadline){throw 'Local Cloudflare fixture failed.'};Start-Sleep -Milliseconds 200}
 # Hidden battle tests verify editor state/commit paths; visible pointer/visual checks are separate.
 $arguments=@(('"'+(Join-Path $root 'boot.json')+'"'),'-batchmode','-nosound','-screen-fullscreen','0','-screen-width','1280','-screen-height','800','-logFile',('"'+(Join-Path $root 'game.log')+'"'))
 $game=Start-Process -FilePath 'C:\Program Files (x86)\Steam\steamapps\common\From The Depths\From_The_Depths.exe' -WorkingDirectory $root -ArgumentList $arguments -WindowStyle Hidden -PassThru
 Write-Output "TestRoot=$root GamePID=$($game.Id)"
 $deadline=(Get-Date).AddSeconds(300)
 while(-not(Test-Path -LiteralPath (Join-Path $root 'fleet-pass.json'))){
  if(Test-Path -LiteralPath (Join-Path $root 'fleet-fatal.txt')){throw (Get-Content -LiteralPath (Join-Path $root 'fleet-fatal.txt') -Raw)}
  if($game.WaitForExit(1000)){throw 'FTD exited early.'}
  if((Get-Date) -gt $deadline){throw 'FTD fleet probe timed out.'}
 }
 Get-Content -LiteralPath (Join-Path $root 'fleet-pass.json')
} finally {
 if($game -and -not $game.HasExited){Stop-Process -Id $game.Id;[void]$game.WaitForExit(5000)}
 if(-not $server.HasExited){Stop-Process -Id $server.Id;[void]$server.WaitForExit(5000)}
 $archive=Join-Path $PSScriptRoot ('runs\fleet-'+$World+'-'+(Get-Date -Format 'yyyyMMdd-HHmmss'))
 New-Item -ItemType Directory -Path $archive -Force | Out-Null
 foreach($name in @('game.log','fleet-pass.json','fleet-fatal.txt','fleet-probe.log','server-errors.log','server.log','map-test.json','editor-pass.json','fleet-editor.png','editor-before.png','editor-state.txt')){
  if(Test-Path -LiteralPath (Join-Path $root $name)){Copy-Item -LiteralPath (Join-Path $root $name) -Destination $archive}
 }
 if(Test-Path -LiteralPath (Join-Path $save 'Logs')){Copy-Item -LiteralPath (Join-Path $save 'Logs') -Destination $archive -Recurse}
 $rankData=if($StorageFallback){Join-Path $save 'RankedBattles'}else{Join-Path $mods 'RankedBattles'}
 $matches=Join-Path $rankData 'Matches'
 if(Test-Path -LiteralPath $matches){
  $result=Get-ChildItem -LiteralPath $matches -Filter 'result.json' -Recurse -File | Select-Object -First 1
  if($result){Copy-Item -LiteralPath $result.FullName -Destination (Join-Path $archive 'battle-result.json')}
 }
 if(Test-Path -LiteralPath (Join-Path $rankData 'errors.log')){Copy-Item -LiteralPath (Join-Path $rankData 'errors.log') -Destination $archive}
 Write-Output "Archive=$archive"
}
