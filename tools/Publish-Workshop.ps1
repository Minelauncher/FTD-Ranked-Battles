param([switch]$Publish,[string]$ChangeNotes='changelog.en.txt',[switch]$GalleryOnly,[switch]$DescriptionOnly,[string[]]$RefreshGalleryFiles=@(),[switch]$CoverOnly)
$ErrorActionPreference='Stop'
if(([int][bool]$GalleryOnly+[int][bool]$DescriptionOnly+[int][bool]$CoverOnly) -gt 1){throw 'Choose one metadata update mode.'}
if($RefreshGalleryFiles.Count -gt 0 -and -not $GalleryOnly){throw 'RefreshGalleryFiles requires GalleryOnly.'}
$metadataOnly=$GalleryOnly -or $DescriptionOnly -or $CoverOnly
$source=Split-Path $PSScriptRoot -Parent
$project=Split-Path (Split-Path $source -Parent) -Parent
$workshop=Join-Path $source 'workshop'
if(-not $GalleryOnly -and -not $CoverOnly){
 $descriptionBytes=[IO.File]::ReadAllBytes((Join-Path $workshop 'description.en.bbcode')).Length
 if($descriptionBytes -ge 8000){throw "Workshop description exceeds the game's 8000-byte buffer ($descriptionBytes bytes). Shorten it before launching FTD."}
}
$release=Join-Path $source 'dist\RankedBattles'
$version=(Get-Content -LiteralPath (Join-Path $release 'plugin.json') -Raw | ConvertFrom-Json).version
$content=Join-Path $workshop ('content-'+$version)
if($metadataOnly){
 $published=Get-Content -LiteralPath (Join-Path $workshop 'publish-state.json') -Raw | ConvertFrom-Json
 if(-not $published.itemId){throw 'Metadata updates require an existing Workshop item.'}
 # Resolve the actual published payload even when a newer build is waiting locally.
 $candidates=@(Get-ChildItem -LiteralPath $workshop -Directory -Filter 'content-*' | Where-Object {
  $plugin=Join-Path $_.FullName 'plugin.json'
  (Test-Path -LiteralPath $plugin) -and (Get-FileHash -LiteralPath $plugin).Hash -eq $published.verifiedHashes.'plugin.json'
 })
 if($candidates.Count -ne 1){throw 'Cannot uniquely resolve the verified published content directory.'}
 $content=$candidates[0].FullName
 $version=(Get-Content -LiteralPath (Join-Path $content 'plugin.json') -Raw | ConvertFrom-Json).version
}
$releaseRecord=Join-Path $workshop ('release-'+$version+'.json')
if(-not $metadataOnly -and -not(Test-Path -LiteralPath $releaseRecord)){
 @{version=$version;headerVersion=[guid]::NewGuid().ToString()} | ConvertTo-Json | Set-Content -LiteralPath $releaseRecord -Encoding utf8
}
$record=if(-not $metadataOnly){Get-Content -LiteralPath $releaseRecord -Raw | ConvertFrom-Json}else{$null}
$files=@('plugin.json','header.header','README.txt','RankedBattles.dll','0Harmony.dll')
if(-not $metadataOnly){
New-Item -ItemType Directory -Path $content -Force | Out-Null
foreach($name in $files){Copy-Item -LiteralPath (Join-Path $release $name) -Destination (Join-Path $content $name) -Force}
Copy-Item -LiteralPath (Join-Path $workshop 'steam-media-v2\preview.jpg') -Destination (Join-Path $content 'header.jpg') -Force
$header=Get-Content -LiteralPath (Join-Path $content 'header.header') -Raw | ConvertFrom-Json
$header.Version=$record.headerVersion
[IO.File]::WriteAllText((Join-Path $content 'header.header'),($header | ConvertTo-Json -Depth 5 -Compress))
}
$hashes=[ordered]@{}
foreach($name in ($files+'header.jpg')){$hashes[$name]=(Get-FileHash -LiteralPath (Join-Path $content $name)).Hash}
if($metadataOnly){
 foreach($name in $hashes.Keys){if($hashes[$name] -ne $published.verifiedHashes.$name){throw "Published content has changed: $name"}}
}
$gallery=@('01-events.jpg','02-formation.jpg','03-spectator.jpg','04-ranking-demo.jpg','05-chat-en.jpg') | ForEach-Object {Join-Path $workshop ('steam-media-v2\'+$_)}
foreach($name in $RefreshGalleryFiles){if($name -cnotin @($gallery | ForEach-Object {Split-Path $_ -Leaf})){throw "Unknown gallery file: $name"}}
$jobPath=Join-Path $workshop 'publish-job.json'
$previewPath=if($CoverOnly){Join-Path $workshop 'steam-media-v2\preview.jpg'}else{Join-Path $content 'header.jpg'}
@{title='Ranked Battles [Beta]';version=$version;content=$content;preview=$previewPath;gallery=@($gallery);galleryOnly=[bool]$GalleryOnly;descriptionOnly=[bool]$DescriptionOnly;coverOnly=[bool]$CoverOnly;refreshGalleryFiles=@($RefreshGalleryFiles);description=(Join-Path $workshop 'description.en.bbcode');changeNotes=(Join-Path $workshop $ChangeNotes);statePath=(Join-Path $workshop 'publish-state.json');hashes=$hashes} | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $jobPath -Encoding utf8
Write-Output "Prepared $content (six public release files, no account data)."
if(-not $Publish){Write-Output 'Preparation only; no Steam requests made.';return}
if(Get-Process From_The_Depths -ErrorAction SilentlyContinue){throw 'User game is running; no process will be stopped.'}
if(-not $GalleryOnly -and (Test-Path -LiteralPath (Join-Path $workshop 'publish-state.json'))){
 node (Join-Path $PSScriptRoot 'check-workshop-gallery.mjs')
 if($LASTEXITCODE -ne 0){throw 'Public gallery is broken. Repair with GalleryOnly before this update.'}
}
$root=Join-Path ([IO.Path]::GetTempPath()) ('FR\publish-'+[guid]::NewGuid().ToString('N').Substring(0,10))
$save=Join-Path $root 'SaveData\From The Depths'
$mods=Join-Path $save 'Mods'
$publisher=Join-Path $mods 'WorkshopPublisher'
New-Item -ItemType Directory -Path $publisher -Force | Out-Null
$profile=Join-Path $project 'RankIsolationProbe\A\SaveData\From The Depths'
foreach($name in @('Options.dat','Player Profiles')){Copy-Item -LiteralPath (Join-Path $profile $name) -Destination $save -Recurse}
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'WorkshopPublisher\bin\Release\netstandard2.1\WorkshopPublisher.dll') -Destination $publisher
@{name='WorkshopPublisher';version='0.1.0';gameversion='4.3.4.1';filename='WorkshopPublisher.dll';depends=@();conflicts=@()} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $publisher 'plugin.json')
@{Authors='Local publishing tool';Version='00000000-0000-0000-0000-000000000000';ComponentId=@{Guid='d9920ad2-6afc-4821-b88c-8148e6a5f49b';Name='WorkshopPublisher'}} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $publisher 'header.header')
Set-Content -LiteralPath (Join-Path $root 'publisher-job-path.txt') -Value $jobPath -NoNewline -Encoding utf8
Set-Content -LiteralPath (Join-Path $root 'SaveLocation.txt') -Value (Join-Path $root 'SaveData') -NoNewline -Encoding utf8
Copy-Item -LiteralPath (Join-Path $project 'RankIsolationProbe\A\steam_appid.txt') -Destination $root
@{Settings=@(@{'$type'='BrilliantSkies.Boot.Settings.BootSetting_NoSplashScreen, Ftd'});Instructions=@();DeleteOnRead=$false} | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $root 'boot.json')
$game=$null
try {
 $arguments=@(('"'+(Join-Path $root 'boot.json')+'"'),'-batchmode','-nosound','-screen-fullscreen','0','-screen-width','1280','-screen-height','800','-logFile',('"'+(Join-Path $root 'game.log')+'"'))
 $game=Start-Process -FilePath 'C:\Program Files (x86)\Steam\steamapps\common\From The Depths\From_The_Depths.exe' -WorkingDirectory $root -ArgumentList $arguments -WindowStyle Hidden -PassThru
 Write-Output "PublisherRoot=$root GamePID=$($game.Id)"
 $deadline=(Get-Date).AddSeconds(300)
 while(-not(Test-Path -LiteralPath (Join-Path $root 'publisher-done.json'))){
  if($game.WaitForExit(1000)){
   if(Test-Path -LiteralPath (Join-Path $root 'publisher-done.json')){break}
   throw 'Publisher exited before completion; inspect the saved publishing journal before retrying.'
  }
  if((Get-Date) -gt $deadline){throw 'Publisher timed out; inspect the saved item ID before retrying.'}
 }
 $result=Get-Content -LiteralPath (Join-Path $root 'publisher-done.json') -Raw | ConvertFrom-Json
 $result | ConvertTo-Json -Depth 10
 if($result.step -ne 'complete'){throw "Workshop update did not complete: $($result.step) $($result.detail)"}
 node (Join-Path $PSScriptRoot 'check-workshop-gallery.mjs')
 if($LASTEXITCODE -ne 0){throw 'Steam upload succeeded, but public gallery verification failed. Do not call this release complete.'}
} finally {
 if($game -and -not $game.HasExited){if(-not $game.WaitForExit(5000)){Stop-Process -Id $game.Id;[void]$game.WaitForExit(5000)}}
 $archive=Join-Path $workshop ('publish-runs\'+(Get-Date -Format 'yyyyMMdd-HHmmss'))
 New-Item -ItemType Directory -Path $archive -Force | Out-Null
 foreach($name in @('game.log','publisher-progress.json','publisher-done.json')){
  if(Test-Path -LiteralPath (Join-Path $root $name)){Copy-Item -LiteralPath (Join-Path $root $name) -Destination $archive}
 }
 if(Test-Path -LiteralPath (Join-Path $save 'Logs')){Copy-Item -LiteralPath (Join-Path $save 'Logs') -Destination $archive -Recurse}
 Write-Output "Archive=$archive"
}
