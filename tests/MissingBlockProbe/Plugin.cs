using System;
using System.IO;
using System.Linq;
using System.Text;
using System.Reflection;
using System.Threading.Tasks;
using Assets.Scripts.Persistence;
using BrilliantSkies.Core.FilesAndFolders;
using BrilliantSkies.Core.Timing;
using BrilliantSkies.Ftd.Modes.CustomBattleMode;
using BrilliantSkies.Modding;
using BrilliantSkies.Modding.Containers;
using BrilliantSkies.Ui.CustomBattleMode;
using FtdRank;
using HarmonyLib;
using Newtonsoft.Json.Linq;
using UnityEngine;

// Exercises the installed native loader, using a copied campaign BP with an
// unregistered GUID to model a mod block whose definition is not installed.
public sealed class MissingBlockProbe : GamePlugin
{
    public string name => "Missing block loading probe";
    public Version version => new Version(0,1);
    static string root;
    static int stage, requests;
    static float began;
    static JObject proof;
    static JArray allocated;
    static readonly Guid woodGuid=new Guid("9a0ae372-beb4-4009-b14e-36ed0715af73");
    static readonly Guid missingGuid=new Guid("cfe290df-5694-4868-819e-26d6f06911c0");
    public void OnSave() { }
    public void OnLoad() {
        root=Path.GetFullPath(Path.Combine(Path.GetDirectoryName(typeof(MissingBlockProbe).Assembly.Location),"../../../.."));
        Application.runInBackground=true; GameEvents.UpdateEvent.RegWithEvent(Update);
        var harmony=new Harmony("ftdrank.test.submitted-cost");
        harmony.Patch(AccessTools.Method(typeof(RankTransport),nameof(RankTransport.Request)),prefix:new HarmonyMethod(typeof(MissingBlockProbe),nameof(Request)));
        harmony.Patch(AccessTools.Method(typeof(CustomBattleModeState),"DoResources"),postfix:new HarmonyMethod(typeof(MissingBlockProbe),nameof(Resources)));
    }
    static bool Request(ref Task<JObject> __result) { requests++; __result=Task.FromException<JObject>(new Exception("No server requests allowed in isolated probe")); return false; }
    static void Resources(CustomBattleModeState __instance) {
        allocated=new JArray(__instance.Teams.Select(t=>new JObject { ["vehicles"]=t.Vehicles.Count, ["localSpawnCost"]=t.Setup.TotalMaterialCost,
            ["startingSupply"]=t.Setup.StartingMaterial, ["allocatedSupply"]=t.GetMaterials(__instance.Settings) }));
    }
    static void Check(bool ok,string why) { if(!ok)throw new Exception(why); }
    static Blueprint Load(string file) => new BlueprintFile(new FilesystemFileSource(file)).Load(false);
    static int Compare(JToken raw,Blueprint before,Blueprint after,int fileId,int woodId) {
        Check(before.BlockIds.Length==after.BlockIds.Length,"Loader removed blocks"); int count=0;
        for(int i=0;i<before.BlockIds.Length;i++) {
            bool replace=(int)raw["BlockIds"][i]==fileId;
            Check(after.BlockIds[i]==(replace?woodId:before.BlockIds[i]),"Unexpected runtime block translation");
            if(replace)count++;
        }
        Check(before.SCs.Count==after.SCs.Count,"Subconstruct structure changed");
        for(int i=0;i<before.SCs.Count;i++)count+=Compare(raw["SCs"][i],before.SCs[i],after.SCs[i],fileId,woodId);
        return count;
    }
    static void Update(ITimeStep step) {
        if(stage==99 || RankedPlugin.MenuBuilt==0 || Time.realtimeSinceStartup<12)return;
        try {
            if(stage==1) {
                Check(Time.realtimeSinceStartup-began<110,"Battle spawn timeout: "+RankClient.Status);
                if(RankBattle.Loading)return;
                Check(RankBattle.Running,"Battle did not run: "+RankClient.Status);
                if(RankBattle.Elapsed<2)return;
                Check(allocated!=null && allocated.Count==2,"Native resource allocation missing");
                for(int i=0;i<2;i++) {
                    var matchFleet=RankClient.Ticket[i==0?"ownerFleet":"opponentFleet"];
                    Check((int)allocated[i]["vehicles"]>0,"Team did not spawn");
                    Check(Math.Abs((double)allocated[i]["allocatedSupply"]-(double)matchFleet["supply"])<.02,"Local prices changed actual starting supply");
                    Check(Math.Abs((double)allocated[i]["localSpawnCost"]-(double)matchFleet["spawnCost"])>1,"Fixture must exercise different prices");
                    allocated[i]["submittedSpawnCost"]=matchFleet["spawnCost"].DeepClone();
                }
                Check(requests==0,"Probe unexpectedly called ranked API");
                proof["teams"]=allocated;proof["combatSpawnTested"]=true;proof["battleSeconds"]=(double)RankBattle.Elapsed;
                File.WriteAllText(Path.Combine(root,"missing-block-pass.txt"),proof.ToString());
                stage=99;Application.Quit();return;
            }
            L.Select("en");
            var items=Configured.i.Get<ModificationComponentContainerItem>();
            int wood=items.FindTheRuntimeIdOrMinus1(woodGuid);
            Check(wood>=0 && items.FindTheRuntimeIdOrMinus1(missingGuid)==-1,"Fixture GUIDs invalid");
            string source=Path.Combine(Application.dataPath,"StreamingAssets","Blueprints","Neter","DWG","Marauder.blueprint");
            string original=File.ReadAllText(source);
            var document=JObject.Parse(original); var dictionary=(JObject)document["ItemDictionary"];
            int fileId=((JArray)document["Blueprint"]["BlockIds"]).Values<int>().GroupBy(i=>i)
                .OrderByDescending(g=>g.Count()).First(g=>new Guid((string)dictionary[g.Key.ToString()])!=woodGuid).Key;
            string originalGuid=(string)dictionary[fileId.ToString()];
            dictionary[fileId.ToString()]=missingGuid.ToString();
            string changed=document.ToString(Newtonsoft.Json.Formatting.None);
            string baseFile=Path.Combine(root,"original.blueprint"), changedFile=Path.Combine(root,"missing.blueprint");
            File.WriteAllText(baseFile,original);File.WriteAllText(changedFile,changed);
            var before=Load(baseFile);var after=Load(changedFile);
            int converted=Compare(document["Blueprint"],before,after,fileId,wood);
            Check(converted>0,"Fixture changed no placed blocks");
            double beforeCost=FleetPlan.Round(before.CalculateResourceCost(ValueQueryType.SubsAndDrones).Material);
            double afterCost=FleetPlan.Round(after.CalculateResourceCost(ValueQueryType.SubsAndDrones).Material);
            Check(beforeCost!=afterCost,"Fixture must exercise the ranked cost mismatch");
            var report=BlueprintBlocks.Inspect(changed);
            BlueprintBlocks.Check(changed,new JObject { ["bannedBlocks"]=new JArray() },"Missing block fixture");
            Check((int)report["counts"][missingGuid.ToString()]==converted,"Raw BP inspection lost unknown GUID");
            string hash=RankTransport.Hash(Encoding.UTF8.GetBytes(changed));
            var units=new JArray(new JObject { ["hash"]=hash,["name"]="Missing block fixture",["cost"]=beforeCost,["x"]=0,["z"]=0,["altitude"]=0,["yaw"]=0 });
            var fleet=new JObject { ["units"]=units,["name"]="Fixture",["spawnCost"]=beforeCost,["supply"]=100000-beforeCost };
            var ticket=new JObject { ["ownerFleet"]=fleet,["owner"]=new JObject { ["name"]="Fixture" },["blueprints"]=new JObject { [hash]=changed } };
            var rules=JObject.Parse("{\"teamBudget\":100000,\"maxUnits\":10,\"maxBlueprints\":10,\"formationHalfWidth\":500,\"formationDepth\":1000,\"minAltitude\":-100,\"maxAltitude\":500,\"bannedBlocks\":[]}");
            AccessTools.Field(typeof(RankBattle),"activeTicket").SetValue(null,ticket);
            var accepted=(CustomBattleSetupTeam)AccessTools.Method(typeof(RankBattle),"CreateTeam").Invoke(null,new object[]{"owner",root,rules});
            Check(accepted.Blueprints.Count==1 && Math.Abs(accepted.StartingMaterial-(100000-beforeCost))<.02,"Original submitted supply was not preserved");
            units[0]["cost"]=20000;fleet["spawnCost"]=20000;fleet["supply"]=10000;rules["teamBudget"]=30000;
            accepted=(CustomBattleSetupTeam)AccessTools.Method(typeof(RankBattle),"CreateTeam").Invoke(null,new object[]{"owner",root,rules});
            Check(accepted.TotalMaterialCost>30000 && accepted.StartingMaterial==10000,"Local cost above budget incorrectly repriced or rejected fleet");
            rules["teamBudget"]=100000;
            units[0]["cost"]=afterCost;fleet["spawnCost"]=afterCost;fleet["supply"]=100000-afterCost;
            accepted=(CustomBattleSetupTeam)AccessTools.Method(typeof(RankBattle),"CreateTeam").Invoke(null,new object[]{"owner",root,rules});
            Check(accepted.Blueprints.Count==1,"Matching substituted cost did not pass preparation");
            ticket["blueprints"][hash]=changed+" ";
            MustReject(root,rules,"Hash tampering accepted");ticket["blueprints"][hash]=changed;
            rules["bannedBlocks"]=new JArray(new JObject { ["guid"]=missingGuid.ToString(),["name"]="Fixture banned block" });MustReject(root,rules,"Banned block accepted");rules["bannedBlocks"]=new JArray();
            proof=new JObject { ["unityApplicationVersion"]=Application.version,["fixture"]="Copied Marauder BP; one placed block GUID replaced by an unregistered GUID; no third-party block mod installed",
                ["originalGuid"]=originalGuid,["unknownGuid"]=missingGuid.ToString(),["fallbackGuid"]=woodGuid.ToString(),["fallbackName"]="Wood Block",
                ["replacedBlocks"]=converted,["blocksBefore"]=before.CalculateTotalBlockCount(),["blocksAfter"]=after.CalculateTotalBlockCount(),
                ["originalCost"]=beforeCost,["fallbackCost"]=afterCost,["nativeLoadSucceeded"]=true,["rawRankedInspectorAccepted"]=true,
                ["rankedPreflightAcceptedOriginalCost"]=true,["rankedPreflightAcceptedFallbackCost"]=true,["localCostAboveBudgetAccepted"]=true,
                ["hashTamperingRejected"]=true,["bannedBlockRejected"]=true,
                ["combatSpawnTested"]=false,["publicServerRequests"]=0 };
            units[0]["cost"]=beforeCost;fleet["spawnCost"]=beforeCost;fleet["supply"]=100000-beforeCost;
            ticket["opponentFleet"]=fleet.DeepClone();ticket["opponentFleet"]["units"][0]["cost"]=20000;
            ticket["opponentFleet"]["spawnCost"]=20000;ticket["opponentFleet"]["supply"]=80000;
            ticket["opponent"]=new JObject { ["name"]="Opponent fixture" };ticket["id"]=new string('1',32);ticket["seed"]=417;
            ticket["resultPolicy"]=BattleOutcome.Policy;
            foreach(var p in JObject.Parse("{world:'neter',boardEast:1.5,boardNorth:1.5,distance:1000,duration:600,resourceDrop:0,tooDamagedEnabled:true,tooDamagedFraction:0.2,sinkingEnabled:false,sinkingFraction:0.5,sustainedEnabled:false,sustainedSeconds:60}").Properties())rules[p.Name]=p.Value;
            ticket["rules"]=rules;RankClient.Settings.Server="http://127.0.0.1:1";RankClient.Ticket=ticket;
            began=Time.realtimeSinceStartup;RankBattle.Launch();stage=1;
        } catch(Exception e) { File.WriteAllText(Path.Combine(root,"missing-block-failed.txt"),e.ToString());stage=99;Application.Quit(); }
    }
    static void MustReject(string directory,JObject rules,string message) {
        bool rejected=false;
        try { AccessTools.Method(typeof(RankBattle),"CreateTeam").Invoke(null,new object[]{"owner",directory,rules}); }
        catch(TargetInvocationException e) { rejected=e.InnerException is InvalidOperationException; }
        Check(rejected,message);
    }
}
