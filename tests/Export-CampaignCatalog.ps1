param()
$ErrorActionPreference='Stop'
if(Get-Process From_The_Depths -ErrorAction SilentlyContinue){throw 'Close existing FTD first. User game will not be stopped.'}
dotnet build (Join-Path $PSScriptRoot 'CampaignCatalog/CampaignCatalog.csproj') -c Release
if($LASTEXITCODE -ne 0){throw 'Map export plugin build failed.'}
$project=Split-Path (Split-Path (Split-Path $PSScriptRoot -Parent) -Parent) -Parent
$root=Join-Path ([IO.Path]::GetTempPath()) ('FRMaps/'+[guid]::NewGuid().ToString('N').Substring(0,10))
$save=Join-Path $root 'SaveData/From The Depths'
$probe=Join-Path $save 'Mods/CampaignCatalog'
New-Item -ItemType Directory -Path $probe -Force | Out-Null
$profile=Join-Path $project 'RankIsolationProbe/A/SaveData/From The Depths'
foreach($name in @('Options.dat','Player Profiles')){Copy-Item -LiteralPath (Join-Path $profile $name) -Destination $save -Recurse}
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'CampaignCatalog/bin/Release/netstandard2.1/CampaignCatalog.dll') -Destination $probe
@{name='CampaignCatalog';version='0.1.0';gameversion='4.3.4.1';filename='CampaignCatalog.dll';depends=@();conflicts=@()} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $probe 'plugin.json')
@{Authors='Local terrain export';Version='00000000-0000-0000-0000-000000000000';ComponentId=@{Guid='3932f9f9-9874-4499-a7ca-2f010463ca90';Name='CampaignCatalog'}} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $probe 'header.header')
Set-Content -LiteralPath (Join-Path $root 'SaveLocation.txt') -Value (Join-Path $root 'SaveData') -NoNewline -Encoding utf8
Copy-Item -LiteralPath (Join-Path $project 'RankIsolationProbe/A/steam_appid.txt') -Destination $root
@{Settings=@(@{'$type'='BrilliantSkies.Boot.Settings.BootSetting_NoSplashScreen, Ftd'});Instructions=@();DeleteOnRead=$false} | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $root 'boot.json')
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'campaign-catalog-request.json') -Destination (Join-Path $root 'catalog-request.json')
$game=$null
try {
 $arguments=@(('"'+(Join-Path $root 'boot.json')+'"'),'-batchmode','-nosound','-screen-fullscreen','0','-screen-width','1280','-screen-height','800','-logFile',('"'+(Join-Path $root 'game.log')+'"'))
 $game=Start-Process -FilePath 'C:/Program Files (x86)/Steam/steamapps/common/From The Depths/From_The_Depths.exe' -WorkingDirectory $root -ArgumentList $arguments -WindowStyle Hidden -PassThru
 Write-Output "ExportRoot=$root GamePID=$($game.Id)"
 $deadline=(Get-Date).AddSeconds(240)
 while(-not(Test-Path -LiteralPath (Join-Path $root 'catalog-result.json'))){
  if(Test-Path -LiteralPath (Join-Path $root 'catalog-error.txt')){throw (Get-Content -LiteralPath (Join-Path $root 'catalog-error.txt') -Raw)}
  if($game.WaitForExit(1000)){throw 'FTD exited early.'}
  if((Get-Date) -gt $deadline){throw 'Map export timed out.'}
 }
 $output=Join-Path $PSScriptRoot 'campaign-data'
 New-Item -ItemType Directory -Path $output -Force | Out-Null
 foreach($name in @('catalog-result.json')){Copy-Item -LiteralPath (Join-Path $root $name) -Destination $output}
 Write-Output "Map data exported to $output"
} finally { if($game -and -not $game.HasExited){Stop-Process -Id $game.Id;[void]$game.WaitForExit(5000)} }
