using System;
using System.IO;
using System.Linq;
using BrilliantSkies.Modding;
using BrilliantSkies.Core.Timing;
using BrilliantSkies.Ui.CustomBattleMode;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;
using UnityEngine;

// Local development tool: obtain prices from the installed game's block registry.
public sealed class CampaignCatalog : GamePlugin
{
    public string name => "Campaign catalog";
    public Version version => new Version(0,1,0);
    static string root;
    static bool done;
    public void OnSave() { }
    public void OnLoad()
    {
        root = Path.GetFullPath(Path.Combine(Path.GetDirectoryName(typeof(CampaignCatalog).Assembly.Location), "../../../.."));
        Application.runInBackground = true;
        GameEvents.UpdateEvent.RegWithEvent(Update);
    }
    static void Update(ITimeStep step)
    {
        if (done || GAME_STATE.GetGameType() != enumGameType.mainmenu || Time.realtimeSinceStartup < 12) return;
        done = true;
        try
        {
            var result = new JArray();
            foreach (string path in JArray.Parse(File.ReadAllText(Path.Combine(root,"catalog-request.json"))))
            {
                var bp = new CustomBattleBlueprint(path, false);
                if (bp.Blueprint == null || float.IsNaN(bp.MaterialCost)) throw new Exception("Unable to load " + path);
                result.Add(new JObject { ["path"] = path, ["name"] = bp.Name,
                    ["cost"] = Math.Round((double)bp.MaterialCost, 3, MidpointRounding.AwayFromZero),
                    ["vehicles"] = bp.VehicleCount, ["blocks"] = bp.BlockCount });
            }
            File.WriteAllText(Path.Combine(root,"catalog-result.json"),result.ToString(Formatting.Indented));
        }
        catch (Exception e) { File.WriteAllText(Path.Combine(root,"catalog-error.txt"),e.ToString()); }
    }
}
