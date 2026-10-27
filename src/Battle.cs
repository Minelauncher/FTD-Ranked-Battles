using System;
using System.IO;
using System.Linq;
using BrilliantSkies.Core.Help;
using BrilliantSkies.Core.Timing;
using BrilliantSkies.Core.UniverseRepresentation;
using BrilliantSkies.Ftd.Modes.Changing;
using BrilliantSkies.Ftd.Modes.CustomBattleMode;
using BrilliantSkies.Ftd.Modes.MainMenu.Ui;
using BrilliantSkies.Ftd.Terrain;
using BrilliantSkies.Ftd.Planets;
using BrilliantSkies.Ftd.Planets.Factions;
using BrilliantSkies.Ftd.Planets.Instances;
using BrilliantSkies.Ftd.Planets.Instances.Headers;
using BrilliantSkies.Ftd.Planets.World;
using BrilliantSkies.Ui.CustomBattleMode;
using BrilliantSkies.Ui.Displayer;
using UnityEngine;
using HarmonyLib;
using Newtonsoft.Json.Linq;

namespace FtdRank
{
    public static class RankBattle
    {
        public static bool Loading, Running, InArena;
        public static float Elapsed;
        static bool prepared;
        static float prepareAt, savedScale;
        static CustomBattleSettings settings;
        static JObject activeTicket;
        static string matchId, setupError;
        static int nativeChangeDepth;
        internal static bool NativeChangeAllowed => !InArena || nativeChangeDepth > 0;
        static void NativeChange(Action action) { nativeChangeDepth++; try { action(); } finally { nativeChangeDepth--; } }
        static void ResetPreviousBattle()
        {
            var state = CustomBattleModeProgression.State;
            // Native Reset removes factions through the CURRENT planet. Discard
            // detached team references left by an earlier world, never look them
            // up by ID (the new planet can reuse that ID for a campaign faction).
            state.Teams.RemoveAll(team => !FactionSpecifications.i.Factions.Contains(team.Faction));
            NativeChange(state.Reset);
        }
        public static void ClearTemporaryData()
        {
            if (Running || Loading) return;
            MatchStorage.Clear(RankClient.DirectoryPath, matchId);
            activeTicket?.Remove("blueprints");
            if (RankClient.Text(RankClient.Ticket, "id") == matchId) RankClient.Ticket?.Remove("blueprints");
        }
        public static void Launch()
        {
            if (RankClient.Busy || RankClient.Ticket == null || Running || Loading || RankClient.PendingResult != null) return;
            if (ModeChanger.Instance.IsChanging) { RankClient.Status = L.T("현재 화면 전환이 끝난 뒤 전투를 시작하세요."); RankClient.RefreshUi(); return; }
            try
            {
                activeTicket = (JObject)RankClient.Ticket.DeepClone();
                BattleOutcome.UsesJudgment(activeTicket);
                matchId = RankClient.Text(RankClient.Ticket, "id");
                var dir = Path.Combine(RankClient.DirectoryPath, "Matches", matchId);
                Directory.CreateDirectory(dir);
                var rules = RankClient.Ticket["rules"] as JObject;
                if (rules == null || !(RankClient.Ticket["ownerFleet"] is JObject)) throw new InvalidOperationException(L.T("이전 형식의 매칭입니다. 항복한 뒤 대회에서 다시 매칭하세요."));
                BattlefieldRules.Validate(rules);
                settings = new CustomBattleSettings {
                    BoardSectionEast = (float)FleetPlan.Value(rules, "boardEast"), BoardSectionNorth = (float)FleetPlan.Value(rules, "boardNorth"),
                    SpawnDistanceBetweenTeams = (float)FleetPlan.Value(rules, "distance"), SymmetricMaterial = false,
                    ResourceDrop = (float)FleetPlan.Value(rules, "resourceDrop") };
                settings.Rules.DisqualificationRulesEnabled = false;
                settings.Rules.TooDamaged.Enabled = rules["tooDamagedEnabled"].Value<bool>();
                settings.Rules.TooDamaged.Value = (float)FleetPlan.Value(rules, "tooDamagedFraction");
                settings.Rules.DamagedAndSinking.Enabled = rules["sinkingEnabled"].Value<bool>();
                settings.Rules.DamagedAndSinking.Value = (float)FleetPlan.Value(rules, "sinkingFraction");
                settings.Rules.SustainedByRepairs.Enabled = rules["sustainedEnabled"].Value<bool>();
                settings.Rules.SustainedByRepairs.Value = (float)FleetPlan.Value(rules, "sustainedSeconds");
                // Let the ladder distinguish time expiry from a genuine team victory.
                settings.Rules.TimeLimit.Enabled = false;
                Loading = true; prepared = false; setupError = null; savedScale = Time.timeScale; prepareAt = Time.realtimeSinceStartup;
                RankClient.Status = BattlefieldRules.Summary(rules) + L.T(" 전장을 준비하는 중…"); RankClient.RefreshUi();
                ModeChanger.Instance.InitiateChangeSequence(new RankedSequence());
            }
            catch (Exception e) { ClientStorage.Log(RankClient.DirectoryPath, e); Loading = false; ClearTemporaryData(); RankClient.Status = e.GetBaseException().Message; RankClient.RefreshUi(); }
        }
        static CustomBattleSetupTeam CreateTeam(string side, string dir, JObject rules)
        {
            var fleet = (JObject)activeTicket[side + "Fleet"];
            double supply = FleetPlan.SubmittedSupply(fleet, rules);
            var units = (JArray)fleet["units"];
            bool own = side == "owner";
            var team = new CustomBattleSetupTeam(RankClient.Safe(FleetPresentation.Name(fleet) + " · " + RankClient.Text(activeTicket[side], "name"))) {
                IsPlayerTeam = own, FleetColors = new[] { own ? Color.blue : Color.red, Color.gray, Color.white, Color.gray } };
            foreach (var u in units)
            {
                string hash = u["hash"].Value<string>(), text = activeTicket["blueprints"]?[hash]?.Value<string>();
                if (text == null || RankTransport.Hash(System.Text.Encoding.UTF8.GetBytes(text)) != hash) throw new InvalidOperationException(L.T("함대 BP를 다시 불러오세요."));
                BlueprintBlocks.Check(text, rules, (string)u["name"]);
                string file = Path.Combine(dir, hash + ".blueprint"); ClientStorage.WriteText(file, text);
                var bp = new CustomBattleBlueprint(file, false) { SpawnAltitude = (float)FleetPlan.Value(u, "altitude"), SpawnAngle = (float)FleetPlan.Value(u, "yaw") };
                // Native Load() otherwise replaces the BP's name with its hash filename.
                bp.Blueprint = bp.File.Load(imposeName: false);
                if (string.IsNullOrWhiteSpace(bp.Blueprint.blueprintName)) bp.Blueprint.blueprintName = (string)u["name"] ?? L.T("기체 / Vehicle");
                double actual = FleetPlan.Round(bp.MaterialCost);
                if (double.IsNaN(actual) || double.IsInfinity(actual) || actual < 0)
                    throw new InvalidOperationException(L.T("기체 비용을 계산하지 못했습니다.") + " " + bp.Name);
                team.AddBlueprint(bp);
            }
            // Native custom battles spawn the vehicles, then allocate this
            // supply separately; no local spawn-price refund or surcharge.
            team.StartingMaterial = (float)supply;
            return team;
        }
        internal static void ApplyFormation(CustomBattleSettings target)
        {
            if (!ReferenceEquals(settings, target) || (!Loading && !Running && !InArena)) return;
            for (int i = 0; i < target.Teams.Count; i++)
            {
                var team = target.Teams[i];
                var units = (JArray)activeTicket[i == 0 ? "ownerFleet" : "opponentFleet"]["units"];
                for (int j = 0; j < team.Blueprints.Count; j++)
                {
                    var unit = units[j]; var bp = team.Blueprints[j];
                    Vector3 p = team.GLobalPosition + team.GLobalRotation * new Vector3((float)FleetPlan.Value(unit, "x"), 0, (float)FleetPlan.Value(unit, "z"));
                    p.y = (float)FleetPlan.Value(unit, "altitude"); bp.GLobalPosition = p;
                    bp.GLobalRotation = team.GLobalRotation * Quaternion.AngleAxis((float)FleetPlan.Value(unit, "yaw"), Vector3.up);
                }
            }
        }
        sealed class RankedSequence : CustomBattleModeChangeSequence
        {
            public override void AwakeFromChange()
            {
                // ModeChanger has now removed the previous scene's vehicles. Use
                // the game's native world switch before creating the battle instance.
                InArena = true;
                try
                {
                    // Remove old battle factions while their planet is still active.
                    // Switching first makes native RemoveTeams target the wrong world.
                    ResetPreviousBattle();
                    var rules = (JObject)activeTicket["rules"]; var menu = new MainMenu();
                    if (BattlefieldRules.World(rules) == "aote") menu.LoadAote(); else menu.LoadNeter();
                    var layout = WorldSpecification.i.BoardLayout;
                    if (settings.BoardSectionEast > layout.EastWestBoardSectionCount || settings.BoardSectionNorth > layout.NorthSouthBoardSectionCount)
                        throw new InvalidOperationException(L.T("현재 설치된 월드의 크기가 대회 좌표와 맞지 않습니다."));
                    NativeChange(() => base.AwakeFromChange());
                    InstanceSpecification.i.Header.CommonSettings.AccessToMap = AccessToMap.Disabled;
                    InstanceSpecification.i.Header.CommonSettings.WarpAbility = WarpAbility.Off;
                    GuiDisplayer.GetSingleton().CloseAllUis();
                    var dir = Path.Combine(RankClient.DirectoryPath, "Matches", matchId);
                    foreach (string side in new[] { "owner", "opponent" }) settings.Teams.Add(CreateTeam(side, dir, rules));
                    if (settings.Teams.Any(t => t.Blueprints.Any(bp => bp.Blueprint == null))) throw new InvalidOperationException(L.T("기체 BP를 불러오지 못했습니다."));
                    var state = CustomBattleModeProgression.State;
                    state.Settings = settings; NativeChange(state.Init); settings.SetBlueprintGlobalPositions();
                    // SpawnPlayer parks the avatar at -500m; give the loading scene a safe camera immediately.
                    RankSpectator.Begin();
                    prepareAt = Time.realtimeSinceStartup; prepared = true;
                }
                catch (Exception e) { ClientStorage.Log(RankClient.DirectoryPath, e); setupError = e.GetBaseException().Message; }
            }
        }
        static bool GroundReady(Vector3 position)
        {
            var coord = StaticCoordTransforms.UniversalPositionToTerrainCoord(PlanetList.MainFrame.FramePositionToUniversalPosition(position)).ToBoardAndTerrain();
            if (!coord.IsValid) throw new InvalidOperationException(L.T("기체 배치가 맵 경계를 벗어납니다. 대회 좌표나 진형을 수정하세요."));
            var terrain = coord.IsValid ? TerrainJobHandler.Instance.terrainPool.Get(coord) : null;
            return terrain != null && terrain.State == TerrainParent.TerrainGenerationState.Finished && terrain.gameObject.activeInHierarchy;
        }
        public static void Update()
        {
            if (!Loading && !Running) return;
            try
            {
                var state = CustomBattleModeProgression.State;
                if (Loading)
                {
                    if (ModeChanger.Instance.IsChanging) return;
                    if (setupError != null) throw new InvalidOperationException(setupError);
                    if (Time.realtimeSinceStartup - prepareAt > 120) throw new InvalidOperationException(L.T("전장 준비 시간이 초과되었습니다. 다시 시도하세요."));
                    if (!prepared) return;
                    if (Time.realtimeSinceStartup - prepareAt < 5 || !settings.Teams.SelectMany(t => t.Blueprints).All(bp => GroundReady(bp.GLobalPosition))) return;
                    UnityEngine.Random.InitState((int)RankClient.Number(activeTicket, "seed"));
                    Aux.SetSeed((int)RankClient.Number(activeTicket, "seed"));
                    NativeChange(state.Start);
                    if (state.Teams.Count != 2 || state.Teams.Any(t => t.Vehicles.Count == 0)) throw new InvalidOperationException(L.T("기체 생성에 실패했습니다. 점수는 갱신하지 않았습니다."));
                    GuiDisplayer.GetSingleton().CloseAllUis();
                    if (GameSpeedManager.Instance.GamePaused) GameSpeedManager.Instance.TogglePause();
                    GameSpeedManager.Instance.gameSpeedFactor = 1; Running = true; Loading = false; Elapsed = 0;
                    RankSpectator.Begin();
                    RankClient.Status = L.T("전투 관전 중");
                    // Native custom-battle camera permits free observation, not avatar combat.
                    return;
                }
                bool inMode = GAME_STATE.GetGameType() == enumGameType.instance && InstanceSpecification.i.Header.IsCustomBattle;
                if (!inMode || !state.IsRunning) { Running = false; ClearTemporaryData(); Time.timeScale = savedScale; RankClient.Status = L.T("전투가 중단되었습니다. 기한 안에 같은 매칭을 다시 시작하세요. 항복하거나 기한이 지나면 패배합니다."); RankClient.RefreshUi(); return; }
                Elapsed = GameTimer.Instance.GameTime - state.StartTime;
                GameSpeedManager.Instance.gameSpeedFactor = 1;
                bool bothGone = state.Teams.All(t => t.Disqualified);
                bool timeout = Elapsed >= FleetPlan.Value(activeTicket["rules"], "duration");
                if (!state._hasFinished && !bothGone && !timeout) return;
                var decision = (string)activeTicket["resultPolicy"] == BattleOutcome.Policy
                    ? BattleOutcome.DecideMaterials(timeout, state.Teams[0].Disqualified, state.Teams[1].Disqualified,
                        state.Teams[0].GetAliveFraction(), state.Teams[1].GetAliveFraction(), Elapsed,
                        BattleMaterials.Capture(state.Teams[0]), BattleMaterials.Capture(state.Teams[1]))
                    : BattleOutcome.Decide(BattleOutcome.UsesJudgment(activeTicket), timeout,
                    state.Teams[0].Disqualified, state.Teams[1].Disqualified,
                    state.Teams[0].GetAliveFraction(), state.Teams[1].GetAliveFraction(), Elapsed);
                double score = (double)decision["score"];
                state.BattleFinished(); Running = false;
                try { RankClient.Save(Path.Combine(RankClient.DirectoryPath, "Matches", matchId, "result.json"), new {
                    matchId, score, seconds = Elapsed, timeout, winner = score == .5 ? (int?)null : score == 1 ? 0 : 1,
                    resultPolicy = (string)activeTicket["resultPolicy"], outcome = decision["outcome"],
                    world = BattlefieldRules.World(activeTicket["rules"]), boardEast = settings.BoardSectionEast, boardNorth = settings.BoardSectionNorth,
                    teams = state.Teams.Select(t => new { name = t.Setup.Name, alive = t.GetAliveFraction() }) }); }
                catch (Exception e) { Debug.LogWarning("Ranked battle diagnostics could not be saved: " + e.GetType().Name); }
                RankClient.RecordResult(decision); RankClient.Open();
            }
            catch (Exception e)
            {
                ClientStorage.Log(RankClient.DirectoryPath, e);
                Running = Loading = false; Time.timeScale = savedScale;
                ClearTemporaryData();
                RankClient.Status = e.GetBaseException().Message; RankClient.Open(false);
            }
        }
        public static void Return()
        {
            if (Running || Loading || RankClient.Busy) return;
            ClearTemporaryData();
            if (InArena) ResetPreviousBattle();
            InArena = false; Time.timeScale = savedScale;
            RankSpectator.End();
            ModeChanger.Instance.InitiateChangeSequence(new MainMenuChangeSequence());
        }
        public static void Surrender()
        {
            if (Loading || RankClient.Ticket == null || RankClient.PendingResult != null) return;
            if (!RankClient.QueueResult(new JObject { ["score"] = 0, ["cancel"] = true }, true)) { RankClient.Open(false); return; }
            if (Running) CustomBattleModeProgression.State.BattleFinished();
            Running = false;
            ClearTemporaryData();
            RankClient.SubmitResult();
            RankClient.Open(false);
        }
    }
    // SpawnAll recomputes the grid immediately before spawning. Apply the saved
    // formation after that recomputation, scoped to this ranked settings instance.
    [HarmonyPatch(typeof(CustomBattleSettings), nameof(CustomBattleSettings.SetBlueprintGlobalPositions))]
    static class RankedFormationPatch
    {
        static void Postfix(CustomBattleSettings __instance) => RankBattle.ApplyFormation(__instance);
    }
}
