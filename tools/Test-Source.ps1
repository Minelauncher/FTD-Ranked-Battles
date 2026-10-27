param([string]$GameManaged)
$ErrorActionPreference='Stop'
$root=Split-Path $PSScriptRoot -Parent
foreach($name in @('ClientStorage','FleetEditing','BattleOutcome','Languages','KeyBindings','BlockInspector')){
 $argsList=@('run','--project',(Join-Path $root "tests/$name/$name.csproj"),'-c','Release')
 if($GameManaged){$argsList+="-p:GameManaged=$GameManaged"}
 if($name -eq 'BlockInspector'){$argsList+=@('--',(Join-Path $root 'server/cloudflare/test/block-inspections.json'))}
 dotnet @argsList
 if($LASTEXITCODE -ne 0){throw "Failed source check: $name"}
}
Write-Output 'All six client source checks passed. No game process or live service was used.'
