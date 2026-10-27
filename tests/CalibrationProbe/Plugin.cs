using System;
using System.IO;
using System.Linq;
using BrilliantSkies.Modding;
using BrilliantSkies.Core.Timing;
using BrilliantSkies.Ftd.Modes.CustomBattleMode;
using BrilliantSkies.Ftd.Terrain;
using FtdRank;
using Newtonsoft.Json.Linq;
using UnityEngine;

// Test-only driver. Calls the unchanged production battle runner with a frozen
// offline ticket. Each case runs in a fresh isolated, hidden, muted process.
public sealed class CalibrationProbe : GamePlugin
{
    public string name => "Aircraft rating calibration";
    public Version version => new Version(0,1,0);
    static string root;
    static JObject input;
    static JArray samples = new JArray(), initial;
    static int stage;
    static float launchAt, battleAt, nextSample, lastProgress, lastElapsed;
    static float minFixed = float.MaxValue, maxFixed, minScale = float.MaxValue, maxScale;
    public void OnSave() { }
    public void OnLoad()
    {
        root = Path.GetFullPath(Path.Combine(Path.GetDirectoryName(typeof(CalibrationProbe).Assembly.Location), "../../../.."));
        input = JObject.Parse(File.ReadAllText(Path.Combine(root,"case.json")));
        Application.runInBackground = true;
        AudioListener.volume = 0; AudioListener.pause = true;
        GameEvents.UpdateEvent.RegWithEvent(Update);
    }
    static void Check(bool condition, string message) { if (!condition) throw new Exception(message); }
    static JArray Snapshot()
    {
        return new JArray(CustomBattleModeProgression.State.Teams.Select(t => new JObject {
            ["name"] = t.Setup.Name, ["alive"] = t.GetAliveFraction(), ["disqualified"] = t.Disqualified,
            ["materials"] = t.GetMaterials(CustomBattleModeProgression.State.Settings),
            ["vehicles"] = new JArray(t.Vehicles.Select(v => new JObject {
                ["name"] = v.Name, ["exists"] = v.Exists, ["alive"] = v.GetAliveFraction(),
                ["x"] = v.Position.x, ["altitude"] = v.Position.y, ["z"] = v.Position.z,
                ["speed"] = v.Velocity.magnitude,
                ["ground"] = StaticTerrainAltitude.AltitudeForGameWorldPositionInMainFrame(v.Position) })) }));
    }
    static void Update(ITimeStep dt)
    {
        if (stage == 99) return;
        try
        {
            if (stage == 0)
            {
                if (GAME_STATE.GetGameType() != enumGameType.mainmenu || RankedPlugin.MenuBuilt == 0 || Time.realtimeSinceStartup < 12) return;
                RankClient.Connected = false; // No server or account ledger participates in calibration.
                RankClient.PendingResult = null;
                RankClient.Ticket = (JObject)input["ticket"].DeepClone();
                RankBattle.Launch(); launchAt = Time.realtimeSinceStartup; stage = 1;
                return;
            }
            if (stage == 1)
            {
                Check(Time.realtimeSinceStartup-launchAt < 150,"Battle load timeout: "+RankClient.Status);
                if (RankBattle.Loading) return;
                Check(RankBattle.Running,"Battle failed to start: "+RankClient.Status);
                var state = CustomBattleModeProgression.State;
                Check(state.Teams.Count==2,"Expected two teams"); initial = new JArray();
                for(int i=0;i<2;i++)
                {
                    var t = state.Teams[i]; var units = input["ticket"][i==0 ? "ownerFleet" : "opponentFleet"]["units"];
                    Check(t.Setup.Blueprints.Count==units.Count(),"Wrong BP count");
                    Check(Math.Abs(t.Setup.TotalMaterialCost+t.Setup.StartingMaterial-(double)input["ticket"]["rules"]["teamBudget"])<.1,"Wrong budget");
                    for(int j=0;j<units.Count();j++)
                    {
                        var bp=t.Setup.Blueprints[j]; var local=Quaternion.Inverse(t.Setup.GLobalRotation)*(bp.GLobalPosition-t.Setup.GLobalPosition);
                        Check(Math.Abs(local.x-(double)units[j]["x"])<.01 && Math.Abs(local.z-(double)units[j]["z"])<.01,"Formation mismatch");
                        Check(Math.Abs(bp.GLobalPosition.y-(double)units[j]["altitude"])<.01,"Altitude mismatch");
                    }
                    initial.Add(new JObject { ["bpCount"]=t.Setup.Blueprints.Count,["vehicleCount"]=t.Vehicles.Count,
                        ["spawnCost"]=t.Setup.TotalMaterialCost,["supply"]=t.Setup.StartingMaterial });
                }
                battleAt=lastProgress=Time.realtimeSinceStartup; stage=2;
            }
            if(stage==2)
            {
                if(RankBattle.Running)
                {
                    Check(Math.Abs(GameSpeedManager.Instance.gameSpeedFactor-1)<.001,"Battle speed is not 1x");
                    minFixed=Math.Min(minFixed,Time.fixedDeltaTime); maxFixed=Math.Max(maxFixed,Time.fixedDeltaTime);
                    minScale=Math.Min(minScale,Time.timeScale); maxScale=Math.Max(maxScale,Time.timeScale);
                    if(RankBattle.Elapsed>lastElapsed+.5f) { lastElapsed=RankBattle.Elapsed; lastProgress=Time.realtimeSinceStartup; }
                    Check(Time.realtimeSinceStartup-lastProgress<90,"Simulation stopped progressing");
                    if(RankBattle.Elapsed>=nextSample)
                    {
                        samples.Add(new JObject { ["seconds"]=RankBattle.Elapsed,["teams"]=Snapshot() }); nextSample+=15;
                        RankClient.Save(Path.Combine(root,"progress.json"),new { game=input["game"],seconds=RankBattle.Elapsed,wall=Time.realtimeSinceStartup-battleAt });
                    }
                    return;
                }
                // Production removes the temporary battle directory after persisting
                // PendingResult. Offline verification reads that durable submission.
                Check(RankClient.PendingResult != null,"Battle stopped without a result: "+RankClient.Status);
                var result=(JObject)RankClient.PendingResult.DeepClone();
                result["seconds"]=result["outcome"]?["seconds"]?.DeepClone();
                Check((string)result["matchId"]==(string)input["game"]["id"],"Wrong result identity");
                Check((double)result["seconds"]>0 && (double)result["seconds"]<=(double)input["ticket"]["rules"]["duration"]+1,"Invalid duration");
                RankClient.Save(Path.Combine(root,"calibration-result.json"),new JObject {
                    ["passed"]=true,["game"]=input["game"].DeepClone(),["result"]=result,["initial"]=initial,
                    ["wallSeconds"]=Time.realtimeSinceStartup-battleAt,["fixedDeltaMin"]=minFixed,["fixedDeltaMax"]=maxFixed,
                    ["timeScaleMin"]=minScale,["timeScaleMax"]=maxScale,["samples"]=samples,["final"]=Snapshot(),["muted"]=true });
                stage=99;
            }
        }
        catch(Exception e) { File.WriteAllText(Path.Combine(root,"calibration-fatal.txt"),e.ToString()); stage=99; }
    }
}
