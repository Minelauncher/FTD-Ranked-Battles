using System;
using System.IO;
using System.Linq;
using System.Collections.Generic;
using System.Threading.Tasks;
using BrilliantSkies.Core.Timing;
using BrilliantSkies.Ftd.Modes.MainMenu.Ui;
using BrilliantSkies.Ftd.Modes.CustomBattleMode;
using BrilliantSkies.Ftd.Planets;
using BrilliantSkies.Ui.CustomBattleMode;
using FtdRank;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;
using UnityEngine;

// Replays the shipped 250k starter fleets and their declared costs on a private server.
static class GroundLoadProbe
{
    static string root, opponentToken;
    static int stage, round;
    static bool configured, roundConfigured;
    static float began, battleAt;
    static JObject plan, ground;
    static readonly Dictionary<string, string> blueprints = new Dictionary<string, string>();
    static readonly JArray rounds = new JArray();
    public static void Start(string directory) { root = directory; GameEvents.UpdateEvent.RegWithEvent(Update); }
    static void Log(string text) => File.AppendAllText(Path.Combine(root, "fleet-probe.log"), text + "\n");
    static void Check(bool ok, string text) { if (!ok) throw new Exception(text + " | " + RankClient.Status); }
    static void Update(ITimeStep time)
    {
        if (stage == 99) return;
        try
        {
            if (stage == 0)
            {
                if (GAME_STATE.GetGameType() != enumGameType.mainmenu || RankedPlugin.MenuBuilt == 0) return;
                Check(new Uri(RankClient.Settings.Server).IsLoopback, "Ground probe requires local server");
                began = Time.realtimeSinceStartup;
                plan = JObject.Parse(File.ReadAllText(Path.Combine(root, "ground-plan.json")));
                ground = (JObject)plan["events"].First(e => (string)e["id"] == "ground-250k");
                new MainMenu().LoadNeter(); RankClient.Open(false);
                RankClient.Authenticate(new AccountForm { Mode = "register", Username = "ground_probe", Nickname = "Ground probe", Password = "ground-test-2026", Confirm = "ground-test-2026" }); stage = 1; return;
            }
            if (Time.realtimeSinceStartup - began > 250) throw new Exception("Ground probe timeout at " + stage + ": " + RankClient.Status);
            if (RankClient.Busy) return;
            switch (stage)
            {
                case 1:
                    Check(RankClient.Connected && RankClient.Tournament != null, "Ground registration failed");
                    foreach (var unit in ground["opponents"].SelectMany(p => p["fleet"]["units"]).GroupBy(u => (string)u["name"]).Select(g => g.First()))
                    {
                        var item = plan["blueprintFiles"].First(b => (string)b["name"] == (string)unit["name"]);
                        string path = (string)item["path"];
                        var bp = new CustomBattleBlueprint(path, false);
                        Log((string)unit["name"] + " submitted=" + unit["cost"] + " native=" + FleetPlan.Round(bp.MaterialCost));
                        blueprints[(string)unit["name"]] = JObject.Parse(File.ReadAllText(path)).ToString(Formatting.None);
                    }
                    RankClient.Run("Configure ground fixture", Configure, _ => configured = true); stage = 2; break;
                case 2:
                    Check(configured, "Ground fixture failed");
                    ConfigureRound(); stage = 3; break;
                case 3:
                    Check(roundConfigured, "Ground fleet submission failed");
                    RankClient.SelectTournament("standard-100k", true); stage = 4; break;
                case 4:
                    Check(RankClient.Entry != null, "Ground fleet entry missing");
                    RankClient.Match(); stage = 5; break;
                case 5:
                    Check(RankClient.Ticket != null, "Ground match failed");
                    battleAt = Time.realtimeSinceStartup; RankClient.StartBattle(); stage = 6; break;
                case 6:
                    if (RankBattle.Loading) return;
                    Check(RankBattle.Running, "Ground battle returned to lobby during loading");
                    Check(Planet.i.File.Header.Name.ScrapableEnglish == "Ashes of the Empire", "AOTE world was not loaded");
                    var state = CustomBattleModeProgression.State;
                    Check(state.Teams.Count == 2 && state.Teams.All(t => t.Vehicles.Count > 0), "Ground fleets did not spawn");
                    var report = new JObject { ["round"] = round, ["world"] = Planet.i.File.Header.Name.ScrapableEnglish,
                        ["loadSeconds"] = Time.realtimeSinceStartup - battleAt,
                        ["east"] = state.Settings.BoardSectionEast, ["north"] = state.Settings.BoardSectionNorth,
                        ["teams"] = new JArray(state.Teams.Select(t => new JObject { ["vehicles"] = t.Vehicles.Count,
                            ["spawn"] = t.Setup.TotalMaterialCost, ["supply"] = t.Setup.StartingMaterial })) };
                    rounds.Add(report); Log("PASS spawned ground round " + report.ToString(Formatting.None));
                    RankBattle.Surrender(); stage = 7; break;
                case 7:
                    if (RankClient.PendingResult != null) return;
                    Check(RankClient.Receipt != null && RankClient.Ticket == null, "Ground surrender did not settle");
                    RankBattle.Return(); stage = 8; break;
                case 8:
                    if (GAME_STATE.GetGameType() != enumGameType.mainmenu) return;
                    if (++round < 2) { new MainMenu().LoadNeter(); ConfigureRound(); stage = 3; break; }
                    File.WriteAllText(Path.Combine(root, "fleet-pass.json"), new JObject { ["passed"] = true,
                        ["ground250kStarterFleets"] = true, ["rounds"] = rounds }.ToString(Formatting.Indented)); stage = 99; break;
            }
        }
        catch (Exception e) { File.WriteAllText(Path.Combine(root, "fleet-fatal.txt"), e.ToString()); stage = 99; }
    }
    static string OwnerToken => RankClient.Settings.Connections[RankClient.Settings.Server].Token;
    static async Task<JObject> Configure()
    {
        var fixture = JObject.Parse(File.ReadAllText(Path.Combine(root, "fixture.json")));
        var tournament = (JObject)RankClient.Tournament.DeepClone();
        var rules = (JObject)ground["rules"].DeepClone(); rules["duration"] = 15; rules["replacementSeconds"] = 0;
        tournament["rules"] = rules; tournament["expectedRevision"] = tournament["revision"];
        await RankTransport.Request(RankClient.Settings.Server, (string)fixture["adminToken"], "PUT", "/admin/tournaments/standard-100k", tournament);
        var opponent = await RankTransport.Request(RankClient.Settings.Server, null, "POST", "/auth/register", new { username = "ground_opponent", nickname = "Ground opponent", password = "ground-test-2026" });
        opponentToken = (string)opponent["token"];
        foreach (var unit in ground["opponents"].SelectMany(p => p["fleet"]["units"]).GroupBy(u => (string)u["name"]).Select(g => g.First()))
            foreach (string token in new[] { OwnerToken, opponentToken })
                await RankTransport.UploadFleetBlueprint(RankClient.Settings.Server, token, blueprints[(string)unit["name"]], (double)unit["cost"]);
        return new JObject();
    }
    static void ConfigureRound() { roundConfigured = false; RankClient.Run("Submit frozen ground fleets", async () => {
        var current = await RankTransport.Request(RankClient.Settings.Server, OwnerToken, "GET", "/tournaments/standard-100k");
        for (int side = 0; side < 2; side++)
        {
            var preset = ground["opponents"][round == 0 ? side : side == 0 ? 2 : 0];
            var units = (JArray)preset["fleet"]["units"].DeepClone();
            foreach (var unit in units) unit["hash"] = RankTransport.Hash(System.Text.Encoding.UTF8.GetBytes(blueprints[(string)unit["name"]]));
            await RankTransport.Request(RankClient.Settings.Server, side == 0 ? OwnerToken : opponentToken, "PUT", "/tournaments/standard-100k/entry", new {
                revision = (int)current["tournament"]["revision"], fleetName = (string)preset["name"], units });
        }
        return new JObject();
    }, _ => roundConfigured = true); }
}
