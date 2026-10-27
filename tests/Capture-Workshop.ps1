param([string]$OutputName='screenshots-v1',[switch]$ChatOnly,[switch]$StatusOnly,[switch]$ShowWindow)
$ErrorActionPreference='Stop'
if(Get-Process From_The_Depths -ErrorAction SilentlyContinue){throw 'User game is running; no process will be stopped.'}
if($OutputName -notmatch '^[a-z0-9-]+$'){throw 'Invalid output name'}
$source=Split-Path $PSScriptRoot -Parent
$project=Split-Path (Split-Path $source -Parent) -Parent
$root=Join-Path ([IO.Path]::GetTempPath()) ('FR\preview-'+[guid]::NewGuid().ToString('N').Substring(0,10))
$save=Join-Path $root 'SaveData\From The Depths'
$mods=Join-Path $save 'Mods'
$output=Join-Path $source ('workshop\'+$OutputName)
if(Test-Path -LiteralPath $output){throw 'Screenshot output already exists'}
New-Item -ItemType Directory -Path $mods,$output -Force | Out-Null
@{output=$output;chatOnly=[bool]$ChatOnly;statusOnly=[bool]$StatusOnly} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $root 'capture-settings.json') -Encoding utf8
$profile=Join-Path $project 'RankIsolationProbe\A\SaveData\From The Depths'
foreach($name in @('Options.dat','Player Profiles')){Copy-Item -LiteralPath (Join-Path $profile $name) -Destination $save -Recurse}
Copy-Item -LiteralPath (Join-Path $source 'dist\RankedBattles') -Destination $mods -Recurse
$probe=Join-Path $mods 'WorkshopCapture'
New-Item -ItemType Directory -Path $probe | Out-Null
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'WorkshopCapture\bin\Release\netstandard2.1\WorkshopCapture.dll') -Destination $probe
@{name='WorkshopCapture';version='0.1.0';gameversion='4.3.4.1';filename='WorkshopCapture.dll';depends=@('Ranked Battles');conflicts=@()} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $probe 'plugin.json')
@{Authors='Local preview';Version='00000000-0000-0000-0000-000000000000';ComponentId=@{Guid='01ac7b20-61aa-4ea5-a9cb-8c94d747d6f1';Name='WorkshopCapture'}} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $probe 'header.header')
Set-Content -LiteralPath (Join-Path $root 'SaveLocation.txt') -Value (Join-Path $root 'SaveData') -NoNewline -Encoding utf8
Copy-Item -LiteralPath (Join-Path $project 'RankIsolationProbe\A\steam_appid.txt') -Destination $root
@{Settings=@(@{'$type'='BrilliantSkies.Boot.Settings.BootSetting_NoSplashScreen, Ftd'});Instructions=@();DeleteOnRead=$false} | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $root 'boot.json')
$server=Start-Process -FilePath (Get-Command node.exe).Source -ArgumentList @(('"'+(Join-Path $source 'server\cloudflare\tools\serve-workshop-preview.mjs')+'"'),('"'+$root+'"')) -WorkingDirectory $root -WindowStyle Hidden -RedirectStandardError (Join-Path $root 'server-errors.log') -RedirectStandardOutput (Join-Path $root 'server.log') -PassThru
$game=$null
try {
 $deadline=(Get-Date).AddSeconds(60)
 while(-not(Test-Path -LiteralPath (Join-Path $root 'fixture-ready'))){if($server.HasExited -or (Get-Date) -gt $deadline){throw ('Preview server failed: '+(Get-Content -LiteralPath (Join-Path $root 'server-errors.log') -Raw))};Start-Sleep -Milliseconds 200}
 # ShowWindow requires an explicit request for a visible game. Hidden is the default.
 $arguments=@(('"'+(Join-Path $root 'boot.json')+'"'),'-nosound','-screen-fullscreen','0','-screen-width','1920','-screen-height','1080','-logFile',('"'+(Join-Path $root 'game.log')+'"'))
 $windowStyle=if($ShowWindow){'Normal'}else{'Hidden'}
 $game=Start-Process -FilePath 'C:\Program Files (x86)\Steam\steamapps\common\From The Depths\From_The_Depths.exe' -WorkingDirectory $root -ArgumentList $arguments -WindowStyle $windowStyle -PassThru
 Write-Output "CaptureRoot=$root GamePID=$($game.Id)"
 $seconds=if($ChatOnly -or $StatusOnly){180}else{500}
 $deadline=(Get-Date).AddSeconds($seconds)
 while(-not(Test-Path -LiteralPath (Join-Path $root 'capture-done'))){
  if(Test-Path -LiteralPath (Join-Path $root 'capture-failed.txt')){throw (Get-Content -LiteralPath (Join-Path $root 'capture-failed.txt') -Raw)}
  if($game.WaitForExit(1000)){
   if(Test-Path -LiteralPath (Join-Path $root 'capture-done')){break}
   throw 'FTD exited before capture completed'
  }
  if((Get-Date) -gt $deadline){throw 'Screenshot capture timed out'}
 }
 Write-Output "Screenshots=$output"
} finally {
 if($game -and -not $game.HasExited){if(-not $game.WaitForExit(5000)){Stop-Process -Id $game.Id;[void]$game.WaitForExit(5000)}}
 if(-not $server.HasExited){Stop-Process -Id $server.Id;[void]$server.WaitForExit(5000)}
 foreach($name in @('capture.log','capture-done','capture-settings.json','capture-failed.txt','game.log','server-errors.log','preview-data.json')){
  if(Test-Path -LiteralPath (Join-Path $root $name)){Copy-Item -LiteralPath (Join-Path $root $name) -Destination $output}
 }
}
