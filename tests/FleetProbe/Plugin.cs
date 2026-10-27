using System;
using System.IO;
using System.Linq;
using System.Text;
using System.Collections.Generic;
using BrilliantSkies.Modding;
using BrilliantSkies.Core.Timing;
using BrilliantSkies.Core.Constants;
using BrilliantSkies.Ftd.Modes.CustomBattleMode;
using BrilliantSkies.Ftd.Modes.MainMenu.Ui;
using BrilliantSkies.Ftd.Planets;
using BrilliantSkies.Core.UniverseRepresentation;
using BrilliantSkies.Ui.CustomBattleMode;
using BrilliantSkies.Ui.Displayer;
using BrilliantSkies.Ftd.Planets.Instances;
using BrilliantSkies.Ftd.Planets.Instances.Headers;
using BrilliantSkies.Ftd.Planets.World;
using BrilliantSkies.Ftd.Cameras;
using BrilliantSkies.Ftd.Avatar.Control;
using FtdRank;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;
using UnityEngine;

public sealed class FleetProbe : GamePlugin
{
    public string name => "Fleet integration probe";
    public Version version => new Version(0, 1, 0);
    static string root;
    static int stage;
    static JArray fixtureUnits, initialTeams, flightReport;
    static JObject ticket, receipt, mapTest, worldReport;
    static string opponentToken;
    static bool opponentReady;
    static bool SystemOpponent => mapTest?["systemOpponent"]?.Value<bool>() == true;
    static bool Surrender => mapTest?["surrender"]?.Value<bool>() == true;
    static bool ResultRecovery => mapTest?["resultRecovery"]?.Value<bool>() == true;
    static int authResultRequests;
    static string accountId;
    static float authWait;
    static float started;
    static int loadingCameraSamples;
    static FileStream pendingLock;
    static float lowestLoadingCamera = float.MaxValue;
    static float lowestRenderedCamera = float.MaxValue;
    static readonly List<string> menuLabels = new List<string>();
    public void OnSave() { }
    public void OnLoad()
    {
        root = Path.GetFullPath(Path.Combine(Path.GetDirectoryName(typeof(FleetProbe).Assembly.Location), "../../../.."));
        mapTest = JObject.Parse(File.ReadAllText(Path.Combine(root, "map-test.json")));
        Application.runInBackground = true;
        if (mapTest["groundLoad"]?.Value<bool>() == true) { GroundLoadProbe.Start(root); return; }
        if (!string.IsNullOrEmpty((string)mapTest["liveChatSettings"])) { _ = System.Threading.Tasks.Task.Run(LiveChat); return; }
        GameEvents.UpdateEvent.RegWithEvent(Update);
    }
    static async System.Threading.Tasks.Task LiveChat()
    {
        bool passed = false;JObject proof = null;
        using (var wire = new ChatWire()) {
            try {
                const string server = "https://ftd-ranked.ftd-ranked.workers.dev";
                var saved = JObject.Parse(File.ReadAllText((string)mapTest["liveChatSettings"]));
                string token = (string)saved["Connections"]?[server]?["Token"];
                Require(!string.IsNullOrEmpty(token), "Saved login unavailable");
                var running = wire.Run(server, token, msg => {
                    if ((string)msg["type"] == "hello") {
                        Require((int)msg["settings"]["slowSeconds"] == 30, "Unexpected live cooldown");
                        proof = new JObject { ["passed"] = true, ["nativeSecureWebSocket"] = true, ["channels"] = ((JArray)msg["channels"]).Count, ["slowSeconds"] = 30, ["postedMessages"] = 0 };
                        wire.Send(new JObject { ["type"] = "search", ["query"] = "native connection verification" }).GetAwaiter().GetResult();
                    } else if ((string)msg["type"] == "search") { passed = true; wire.Dispose(); }
                    else if ((string)msg["type"] == "error") throw new Exception("Live chat command rejected");
                });
                if (await System.Threading.Tasks.Task.WhenAny(running, System.Threading.Tasks.Task.Delay(30000)) != running) throw new TimeoutException();
                try { await running; } catch when (passed) { }
                Require(passed, "Live search response missing");
                File.WriteAllText(Path.Combine(root,"fleet-pass.json"),proof.ToString());
                Log("PASS actual Unity/Mono secure WebSocket to Cloudflare, existing login, 30-second setting and read-only search; no public message posted");
            } catch (Exception error) { File.WriteAllText(Path.Combine(root,"fleet-fatal.txt"),"Live chat verification failed: "+error.GetType().Name); }
        }
    }
    static void Log(string message) => File.AppendAllText(Path.Combine(root, "fleet-probe.log"), message + "\n");
    static void Require(bool condition, string error) { if (!condition) throw new Exception(error); }
    static void Update(ITimeStep dt)
    {
        if (stage == 99) return;
        try
        {
            if (stage == 0)
            {
                if (GAME_STATE.GetGameType() != enumGameType.mainmenu || RankedPlugin.MenuBuilt == 0 || Time.realtimeSinceStartup < 12) return;
                started = Time.realtimeSinceStartup;
                Require(RankClient.StorageReady, "Client storage failed: " + RankClient.Status);
                if (mapTest["storageFallback"]?.Value<bool>() == true)
                    Require(RankClient.DirectoryPath == Path.Combine(root,"SaveData","From The Depths","RankedBattles"), "FTD SaveLocation fallback was not selected");
                var configPath = Path.Combine(RankClient.DirectoryPath,"client.json");
                var savedConfig = File.ReadAllText(configPath);
                ClientStorage.WriteText(configPath,"{"); RankClient.Initialize();
                Require(!RankClient.StorageReady && File.ReadAllText(configPath)=="{", "Unreadable config was overwritten or accepted");
                bool sent = false;
                RankClient.Run("must stay blocked", () => { sent=true; return System.Threading.Tasks.Task.FromResult(new JObject()); }, _ => { });
                Require(!sent, "Storage failure allowed network mutation");
                ClientStorage.WriteText(configPath,savedConfig); RankClient.Initialize();
                Require(RankClient.StorageReady, "Config recovery did not restore the client");
                new HarmonyLib.Harmony("ftdrank.test.menu-label").Patch(
                    HarmonyLib.AccessTools.Method(typeof(MainMenuAbstractTab),"B",new[]{typeof(string),typeof(string),typeof(Texture2D),typeof(Action<MainMenu>)}),
                    prefix:new HarmonyLib.HarmonyMethod(typeof(FleetProbe),nameof(CaptureMenuLabel)));
                var ordinary = new CustomBattleModeState { IsRunning = true };
                ordinary.Reset();
                Require(!ordinary.IsRunning && ordinary.InSetup, "Rank guard leaked into ordinary custom battle");
                InteractionProbe.OutsideArena();
                // Deliberately begin on the OTHER world to exercise automatic switching.
                var menu = new MainMenu();
                if ((string)mapTest["world"] == "aote") menu.LoadNeter(); else menu.LoadAote();
                Log("Initial world: " + Planet.i.File.Header.Name.ScrapableEnglish);
                RankClient.Open(false);
                InspectLanguages();
                KeyProbe.Run(); Log("PASS native Options tab, key capture, duplicate rejection, unbind/reload, cancel/close, failed save rollback and atomic defaults");
                RankClient.Ui.Account.Mode = "register"; RankClient.RefreshUi(); authWait = Time.realtimeSinceStartup + 3;
                stage = 20; Log("Open native account registration form"); return;
            }
            if (Time.realtimeSinceStartup - started > 210) throw new Exception("Timed out in stage " + stage + ": " + RankClient.Status);
            if (ResultRecovery) ResultRecoveryProbe.Tick();
            if (RankClient.Busy) return;
            switch (stage)
            {
                case 20:
                    if (Time.realtimeSinceStartup < authWait) return;
                    RankClient.Authenticate(new AccountForm { Mode = "register", Username = "fleet_captain", Nickname = "검사 조종사", Password = "fixture-password-2026", Confirm = "fixture-password-2026" }); stage = 21; break;
                case 21:
                    Require(RankClient.Connected && RankClient.Tournament != null, "Registration failed: " + RankClient.Status);
                    accountId = RankClient.Text(RankClient.Me, "id");
                    Require(RankClient.Ui.Windows.First().Screen.Name.Display == L.T("계정 / Account"), "Missing native account tab");
                    Require(!File.ReadAllText(Path.Combine(RankClient.DirectoryPath, "client.json")).Contains("fixture-password-2026"), "Password saved to config");
                    authWait = Time.realtimeSinceStartup + 3; stage = 22; break;
                case 22:
                    if (Time.realtimeSinceStartup < authWait) return;
                    RankClient.Logout(); stage = 23; break;
                case 23:
                    Require(!RankClient.Connected, "Logout failed");
                    RankClient.Authenticate(new AccountForm { Mode = "login", Username = "FLEET_CAPTAIN", Password = "fixture-password-2026" }); stage = 24; break;
                case 24:
                    Require(RankClient.Connected && RankClient.Text(RankClient.Me, "id") == accountId, "Login did not restore same account");
                    RankClient.Ui.Account.Mode = "password"; RankClient.RefreshUi(); authWait = Time.realtimeSinceStartup + 3; stage = 26; break;
                case 26:
                    if (Time.realtimeSinceStartup < authWait) return;
                    RankClient.Authenticate(new AccountForm { Mode = "password", Password = "fixture-password-2026", NewPassword = "changed-password-2026", Confirm = "changed-password-2026" }); stage = 27; break;
                case 27:
                    Require(RankClient.Connected && RankClient.Text(RankClient.Me, "id") == accountId, "Password change failed");
                    RankClient.Ui.Account.Password = "memory-clear-test";
                    RankClient.Ui.DeactivateGui();
                    Require(RankClient.Ui.Account.Password.Length == 0, "Closing account UI retained password");
                    RankClient.Open(false); Log("PASS native registration, logout, login, password change, password clearing");
                    RankClient.FocusTab(L.T("Chat.Title"));RankClient.OpenChat();authWait=Time.realtimeSinceStartup+25;stage=80;break;
                case 80:
                    if(!RankChat.Connected){Require(Time.realtimeSinceStartup<authWait,"Native WebSocket connection failed: "+RankChat.Status);return;}
                    Require(RankChat.SlowSeconds==30 && RankChat.Channels.Count==1,"Unsubmitted account must only see general chat");
                    Require(RankClient.Ui.Windows.First().Screen.Segments.SelectMany(s=>s.Interpretters).Any(i=>i is ChatCanvas),"Chat canvas missing");
                    RankChat.Draft="한글 日本語 native chat";RankChat.Submit();authWait=Time.realtimeSinceStartup+10;stage=81;break;
                case 81:
                    if(RankChat.Sending || RankChat.Messages.Count==0){Require(Time.realtimeSinceStartup<authWait,"Native chat send failed: "+RankChat.Status);return;}
                    Require(RankChat.Draft=="" && RankChat.Cooldown>0 && RankChat.Cooldown<=30,"Chat acknowledgement/cooldown missing");
                    RankChat.Draft="must wait";Require(!RankChat.CanSend,"Cooldown did not disable sending");RankChat.Draft="";
                    RankChat.Join("event:standard-100k");authWait=Time.realtimeSinceStartup+10;stage=82;break;
                case 82:
                    if(!RankChat.Status.Contains("Submit a fleet")){Require(Time.realtimeSinceStartup<authWait,"Unsubmitted event channel was not denied");return;}
                    Require(RankChat.Channel=="general" && RankChat.Cooldown>0,"Denied channel switch changed state or bypassed cooldown");
                    RankChat.Join("general");authWait=Time.realtimeSinceStartup+10;stage=83;break;
                case 83:
                    if(RankChat.Channel!="general"){Require(Time.realtimeSinceStartup<authWait,"General channel switch failed");return;}
                    RankChat.SearchText="日本語";RankChat.Search();authWait=Time.realtimeSinceStartup+10;stage=84;break;
                case 84:
                    if(!RankChat.SearchMode || RankChat.Searching){Require(Time.realtimeSinceStartup<authWait,"Native chat search failed: "+RankChat.Status);return;}
                    Require(RankChat.Messages.Count==1 && RankChat.SearchScanned==1,"Search result mismatch");
                    RankChat.Join("general",true);authWait=Time.realtimeSinceStartup+10;stage=85;break;
                case 85:
                    if(RankChat.SearchMode){Require(Time.realtimeSinceStartup<authWait,"Return from search failed");return;}
                    RankClient.FocusTab(L.T("대회 / Events"));RankChat.Close();
                    Log("PASS native Unity WebSocket, Korean/Japanese chat, search, event channels and upper-right cooldown state; visual pointer check not performed");stage=1;break;
                case 1:
                    if (!RankClient.Connected || RankClient.Tournament == null) return;
                    Setup(); stage = 2; break;
                case 2:
                    Require(opponentReady, "Opponent fixture setup failed: " + RankClient.Status);
                    RankClient.SelectTournament("standard-100k", true); stage = 3; break;
                case 3:
                    RankClient.FocusTab("대회");
                    Require(RankClient.Ui.Windows.First().Screen.Segments.SelectMany(s => s.Interpretters).Any(i => i is BattlefieldCanvas), "Terrain preview absent");
                    var eventCards = RankClient.Ui.Windows.First().Screen.Segments.SelectMany(s => s.Interpretters).OfType<RankCard>().ToArray();
                    Require(eventCards.Length == RankClient.Tournaments.Count && eventCards.Count(c => c.Selected) == 1, "Event cards/selection absent");
                    foreach (string world in new[] { "neter", "aote" }) {
                        var texture = (Texture2D)HarmonyLib.AccessTools.Method(typeof(BattlefieldCanvas), "Map").Invoke(null, new object[] {world});
                        Require(texture != null && texture.width == (world == "neter" ? 950 : 990), "Embedded map failed to load in Unity");
                    }
                    RankClient.Draft = (JArray)fixtureUnits.DeepClone(); RankClient.SelectedUnit = 0;
                    RankClient.DraftName = "검증 항공 편대";
                    RankClient.SaveDraft(); EditorProbe.Start(root); authWait = Time.realtimeSinceStartup + 15; stage = 30; break;
                case 30:
                    if (EditorProbe.Error != null) throw new Exception(EditorProbe.Error);
                    if (EditorProbe.Phase < 9) { Require(Time.realtimeSinceStartup < authWait, "Canvas input timeout, phase=" + EditorProbe.Phase + " draws=" + EditorProbe.Draws); return; }
                    EditorProbe.Finish(); Log("PASS native quantities, BP replacement, mapped move/commit/boundary/persistence; pointer events verified=" + EditorProbe.PointerVerified);
                    if (!EditorProbe.PointerVerified) { RankClient.SubmitFleet(); stage = 4; break; }
                    authWait = Time.realtimeSinceStartup + 2; stage = 31; break;
                case 31:
                    if (Time.realtimeSinceStartup < authWait) return;
                    ScreenCapture.CaptureScreenshot(Path.Combine(root, "fleet-editor.png"));
                    authWait = Time.realtimeSinceStartup + 2; stage = 32; break;
                case 32:
                    if (Time.realtimeSinceStartup < authWait) return;
                    RankClient.SubmitFleet(); stage = 4; break;
                case 4:
                    Require(RankClient.Entry != null, "Fleet submission failed: " + RankClient.Status);
                    RankClient.RefreshUi(); RankClient.Match(); stage = 5; break;
                case 5:
                    Require(RankClient.Ticket != null, "Matching failed: " + RankClient.Status);
                    ticket = (JObject)RankClient.Ticket.DeepClone();
                    Require((string)ticket["ownerFleet"]["name"] == "검증 항공 편대", "Named fleet lost in match");
                    RankClient.ShowMatchFormation = true; RankClient.RefreshUi(); RankClient.FocusTab("전투");
                    Require(RankClient.Ui.Windows.First().Screen.Segments.SelectMany(s => s.Interpretters).Any(i => i is FormationCanvas), "Match formation preview absent");
                    if (SystemOpponent) Require(ticket["opponent"]["system"]?.Value<bool>() == true, "Expected a login-disabled system opponent");
                    RankClient.RefreshUi(); RankClient.StartBattle(); stage = 6; break;
                case 6:
                    if (RankBattle.Loading) {
                        if (RankSpectator.Active) {
                            float y = CameraManager.GetSingleton().CamControl.CurrentMode.Transform.position.y;
                            lowestLoadingCamera = Mathf.Min(lowestLoadingCamera, y); loadingCameraSamples++;
                            Require(y >= WorldSpecification.i.Physics.WaterLevel, "Loading camera is underwater: " + y);
                            if (loadingCameraSamples > 2) {
                                float rendered = Get.CamData.Position.y;
                                lowestRenderedCamera = Mathf.Min(lowestRenderedCamera, rendered);
                                Require(rendered >= WorldSpecification.i.Physics.WaterLevel, "Rendered loading camera is underwater: " + rendered);
                            }
                        }
                        return;
                    }
                    Require(RankBattle.Running, "Battle did not start: " + RankClient.Status);
                    Require(loadingCameraSamples > 0, "No loading camera samples");
                    InspectSpawn(); InspectArena(); MaterialProbe.Check(CustomBattleModeProgression.State); stage = 7; Log("Multi-vehicle spawn, arena guard, material accounting and spectator validated");
                    if (ResultRecovery) { ResultRecoveryProbe.VerifyDurableSurrender(); ResultRecoveryProbe.Arm(); }
                    if (Surrender) SurrenderFromEscapeMenu();
                    break;
                case 7:
                    if (SystemOpponent && flightReport == null && RankBattle.Elapsed >= 8) InspectFlight();
                    if (RankBattle.Running) return;
                    if (RankClient.PendingResult != null) return;
                    Require(RankClient.Receipt != null, "No result: " + RankClient.Status);
                    if (ResultRecovery) { ResultRecoveryProbe.VerifySettled(); Log("PASS rejected request and lost committed response automatically recover; fleet unlocks and ratings settle once"); }
                    receipt = (JObject)RankClient.Receipt.DeepClone();
                    if (!Surrender) { Require(receipt["outcome"]?["materials"] is JArray, "Material outcome missing"); Require(BattleOutcome.MaterialSummary(receipt).Length > 0, "Material result summary missing"); }
                    if (Surrender) Require((double)receipt["score"] == 0 && (string)receipt["outcome"]["kind"] == "surrender", "Native surrender did not submit a loss");
                    RankClient.Open(false); RankClient.RefreshUi();
                    Require(RankClient.Ui.Windows.First().Screen.Name.Display == L.T("전투 / Battle"), "Result must open the battle tab");
                    Require(RankClient.Ui.Windows.First().Screen.Segments.SelectMany(s => s.Interpretters).OfType<RankCard>().Any(c => c.Title.Contains(BattleOutcome.Label(receipt))), "Result card absent");
                    Require(!Directory.Exists(Path.Combine(RankClient.DirectoryPath,"Matches",(string)ticket["id"])), "Completed match left downloaded BP files behind");
                    Require(Directory.GetFiles(Path.Combine(RankClient.DirectoryPath,"FleetBlueprints"),"*.blueprint").Length>0,"Cleanup deleted owned BP cache");
                    Require(RankClient.Ui.Windows.First().AllScreens.Count == 7, "Expected tournament, fleet, battle, history, ranking, chat and connection tabs");
                    Log("Result: " + receipt.ToString(Formatting.None));
                    if (SystemOpponent)
                    {
                        var fixture = JObject.Parse(File.ReadAllText(Path.Combine(root, "fixture.json")));
                        RankClient.Run("기본 상대 검사", async () => await RankTransport.Request(RankClient.Settings.Server, (string)fixture["adminToken"], "GET", "/admin/tournaments/standard-100k/opponents"), result => {
                            var opponent = result["opponents"].First(o => (string)o["id"] == (string)ticket["opponent"]["id"]);
                            Require(Math.Abs((double)opponent["rating"] - Math.Max(0,(double)ticket["opponent"]["rating"]-(double)receipt["delta"]))<.001, "System opponent rating did not settle");
                        });
                    }
                    else RankClient.Run("검사", async () => await RankTransport.LoadAccount(RankClient.Settings.Server, opponentToken, false, "standard-100k"), result => {
                        Require(RankClient.Number(result["rating"], "games") == 1 && Math.Abs(RankClient.Number(result["rating"], "rating")-(double)receipt["opponentAfter"]) < .001, "Opponent result missing");
                        Require((bool)result["history"][0]["initiated"] == false && (double)result["history"][0]["score"] == 1-(double)receipt["score"], "Passive battle history missing");
                    });
                    stage = 8; break;
                case 8:
                    RankClient.Refresh(); stage = 9; break;
                case 9:
                    Require(RankClient.History.Any(h => RankClient.Text(h, "matchId") == RankClient.Text(receipt, "matchId")), "History missing actual battle");
                    Require(RankClient.Number(RankClient.EventRating,"games") == 1 && RankClient.Number(RankClient.EventRating,"rating") == (double)receipt["after"], "Event rating did not refresh");
                    Require(RankClient.Status.Length == 0, "Redundant history status remains");
                    RankClient.FocusTab("전적");
                    Require(RankClient.Ui.Windows.First().Screen.Segments.SelectMany(s => s.Interpretters).OfType<RankCard>().Count() == RankClient.History.Count, "History rows lack separate cards");
                    RankClient.LoadStandings(); stage = 42; break;
                case 42:
                    RankClient.FocusTab("순위");
                    Require(RankClient.Ui.Windows.First().Screen.Segments.SelectMany(s => s.Interpretters).OfType<RankCard>().Count() == RankClient.Standings.Count, "Ladder cards absent");
                    var ownRow = RankClient.Standings.First(r => RankClient.Text(r,"id") == accountId);
                    Require(RankPalette.For(ownRow) == RankPalette.For(RankClient.Standing), "Own rating and ladder colours disagree");
                    Log("PASS event/history/result/ladder cards, live percentile colour consistency, concise idle status");
                    RankClient.SelectTournament("probe-second-cup",true); stage = 40; break;
                case 40:
                    Require(RankClient.Number(RankClient.EventRating,"rating") == 1000 && RankClient.Number(RankClient.EventRating,"games") == 0 && RankClient.History.Count == 0, "Other event inherited rating or history");
                    RankClient.SelectTournament("standard-100k",true); stage = 41; break;
                case 41:
                    Require(RankClient.Number(RankClient.EventRating,"rating") == (double)receipt["after"] && RankClient.History.Count == 1, "Selecting original event lost its ledger");
                    RankBattle.Return(); stage = 10; break;
                case 10:
                    if (GAME_STATE.GetGameType() != enumGameType.mainmenu) return;
                    Require(!RankSpectator.Active, "Spectator survived arena exit");
                    InteractionProbe.OutsideArena();
                    Log("PASS vehicle/AI UI restrictions removed after ranked arena exit");
                    // Simulate an offline result from another PC, then a local file
                    // temporarily locked by sync/antivirus during acknowledgement.
                    var stale = BattleOutcome.Decide(true, false, true, false, 0, 1, 1);
                    stale["server"] = RankClient.Settings.Server; stale["accountId"] = accountId; stale["matchId"] = ticket["id"];
                    RankClient.PendingResult = stale;
                    string pendingPath = Path.Combine(RankClient.DirectoryPath,"pending-result.json");
                    RankClient.Save(pendingPath,stale);
                    RankClient.Initialize(); // Reload the durable queue, as after restarting the game.
                    pendingLock = new FileStream(pendingPath,FileMode.Open,FileAccess.Read,FileShare.Read);
                    RankClient.SubmitResult(); stage = 90; break;
                case 90:
                    Require(RankClient.PendingResult != null && RankClient.AccountLocked, "Failed queue deletion unlocked the account");
                    Require(File.Exists(Path.Combine(RankClient.DirectoryPath,"pending-result.json")), "Locked queue disappeared");
                    Require(RankClient.MatchStateTitle == L.T("Result.CleanupWaiting"), "Confirmed receipt must explain local cleanup delay");
                    pendingLock.Dispose(); pendingLock = null;
                    stage = 91; break;
                case 91:
                    if (RankClient.PendingResult != null) return;
                    Require(RankClient.Connected && RankClient.PendingResult == null && !File.Exists(Path.Combine(RankClient.DirectoryPath,"pending-result.json")), "Reconnect did not automatically settle the durable result");
                    Require(RankClient.Number(RankClient.EventRating,"games") == 1 && RankClient.Number(RankClient.EventRating,"rating") == (double)receipt["after"], "Recovery applied ratings more than once");
                    Log("PASS restart restores pending result; locked acknowledgement keeps account guarded and automatically retries cleanup without duplicate rating");
                    if (!ResultRecovery) goto case 95;
                    ResultRecoveryProbe.Unauthorized = true;
                    authResultRequests = ResultRecoveryProbe.Requests;
                    var authStale = new JObject { ["score"] = 0, ["cancel"] = true, ["server"] = RankClient.Settings.Server, ["accountId"] = accountId, ["matchId"] = ticket["id"] };
                    RankClient.Save(Path.Combine(RankClient.DirectoryPath, "pending-result.json"), authStale);
                    RankClient.Initialize(); RankClient.Connected = false; RankClient.Ticket = RankClient.Receipt = null;
                    RankClient.Connect(); stage = 92; break;
                case 92:
                    Require(!RankClient.Connected && RankClient.ResultDelivery == ResultDeliveryState.SignInRequired, "401 did not pause result delivery");
                    Require(RankClient.PendingResult != null && RankClient.AccountLocked, "401 discarded the pending result");
                    authWait = Time.realtimeSinceStartup + 6; stage = 93; break;
                case 93:
                    if (Time.realtimeSinceStartup < authWait) return;
                    Require(ResultRecoveryProbe.Requests == authResultRequests + 1, "Expired login caused repeated result requests");
                    ResultRecoveryProbe.Unauthorized = false;
                    RankClient.Authenticate(new AccountForm { Mode = "login", Username = "FLEET_CAPTAIN", Password = "changed-password-2026" }); stage = 94; break;
                case 94:
                    if (RankClient.PendingResult != null) return;
                    Require(RankClient.Connected && RankClient.CanEditFleet && RankClient.Ticket == null, "Sign-in did not resume and unlock pending result");
                    Require(RankClient.Number(RankClient.EventRating, "games") == 1, "Sign-in recovery duplicated rating settlement");
                    Log("PASS expired login stops retries; native sign-in automatically recovers saved result and unlocks fleet");
                    goto case 95;
                case 95:
                    Require(!SystemOpponent || Surrender || (flightReport != null && flightReport.Count == initialTeams.Sum(t => (int)t["vehicles"])),
                        "Missing aircraft flight samples, including carried vehicles");
                    File.WriteAllText(Path.Combine(root, "fleet-pass.json"), new JObject {
                        ["passed"] = true, ["initialTeams"] = initialTeams, ["receipt"] = receipt, ["materialAccounting"] = MaterialProbe.Report,
                        ["worldReport"] = worldReport,
                        ["nativeMenuBuilds"] = RankedPlugin.MenuBuilt, ["nativeLobbyBuilds"] = RankedPlugin.LobbyBuilt,
                        ["returnedToMenu"] = true, ["resultTabVerified"] = true
                        , ["accountFlowsVerified"] = true
                        , ["fleetEditorVerified"] = true
                        , ["systemOpponentVerified"] = SystemOpponent
                        , ["flightReport"] = flightReport
                        , ["temporaryMatchFilesRemoved"] = true, ["namedFleetVerified"] = true, ["terrainTexturesLoaded"] = true
                        , ["arenaGuardVerified"] = true, ["spectatorVerified"] = true, ["blueprintNamesVerified"] = true
                        , ["eventRatingUiVerified"] = true, ["surrenderVerified"] = Surrender
                        , ["cardUiVerified"] = true, ["ratingColourVerified"] = true
                        , ["modLanguagesVerified"] = true, ["nativeLanguageUnchanged"] = true, ["flagTexturesLoaded"] = true
                        , ["nativeCameraVerified"] = true, ["loadingCameraSamples"] = loadingCameraSamples, ["lowestLoadingCamera"] = lowestLoadingCamera
                        , ["lowestRenderedCamera"] = lowestRenderedCamera
                        , ["storageFallbackVerified"] = mapTest["storageFallback"]?.Value<bool>() == true
                        , ["storageFailureRecoveryVerified"] = true, ["englishMenuVerified"] = true
                        , ["rankKeyOptionsVerified"] = true
                        , ["pendingResultRecoveryVerified"] = true
                        , ["automaticResultRecoveryVerified"] = ResultRecovery
                    }.ToString(Formatting.Indented)); stage = 99; break;
            }
        }
        catch (Exception e) { pendingLock?.Dispose(); File.WriteAllText(Path.Combine(root, "fleet-fatal.txt"), e.ToString()); stage = 99; }
    }
    static void CaptureMenuLabel(string name) => menuLabels.Add(name);
    static void InspectLanguages()
    {
        Require(RankPalette.For(JValue.CreateNull()) == RankPalette.For(null), "System opponent null standing fails colour fallback");
        var nativeText = MainMenuBasicsTab._locFile.Get("Button_Create", "Designer Mode").ToString();
        var culture = System.Globalization.CultureInfo.CurrentCulture.Name;
        RankClient.Ui.Account.Username = "unchanged_user"; RankClient.Ui.Account.Nickname = "Captain / かんちょう / 함장";
        RankClient.Ui.Account.Password = "keep-during-language-switch";
        RankClient.Status = "로그인하고 시작하세요. / Sign in to play.";
        foreach (string language in new[] { "en", "ja", "ko" }) {
            RankClient.SetLanguage(language);
            menuLabels.Clear();
            new MainMenuBasicsTab(RankClient.Ui.Windows.First(),new MainMenu()).Build();
            Require(menuLabels.Count(n=>n=="Ranked Battles")==1, "Main menu entry is not English: " + language);
            var window = RankClient.Ui.Windows.First();
            Require(window.Screen.GetType().Name == "ServerTab", "Language switch left account tab");
            Require(window.Screen.Name.Display == L.T("계정 / Account"), "Tab title was not translated");
            Require(window.Screen.Segments.SelectMany(s => s.Interpretters).Any(i => i is LanguageFlags), "Flag buttons missing");
            Require(RankClient.Ui.Account.Password == "keep-during-language-switch" && RankClient.Ui.Account.Nickname == "Captain / かんちょう / 함장", "Language switch changed entered fields");
            Require(RankClient.Status == L.T("로그인하고 시작하세요. / Sign in to play."), "Live status language stale");
            Require((string)JObject.Parse(File.ReadAllText(Path.Combine(RankClient.DirectoryPath,"client.json")))["Language"] == language, "Language not saved");
            foreach (string flag in LanguageFlags.Languages) Require(LanguageFlags.Flag(flag)?.width == 384, "Flag resource missing");
            Require(nativeText == MainMenuBasicsTab._locFile.Get("Button_Create", "Designer Mode").ToString(), "Native game language changed");
            Require(culture == System.Globalization.CultureInfo.CurrentCulture.Name, "Global culture changed");
        }
        L.Select("en"); RankClient.Initialize(); Require(L.Language == "ko", "Saved language was not restored");
        RankClient.Ui.Account.ClearSecrets();
        Log("PASS KO/JA/EN switching, current account tab and fields preserved, saved language restored, real flag textures loaded, native game language/culture untouched");
    }
    static void Setup()
    {
        var fixture = JObject.Parse(File.ReadAllText(Path.Combine(root, "fixture.json")));
        string server = fixture["server"].Value<string>(), admin = fixture["adminToken"].Value<string>();
        string bpRoot = Path.Combine(Application.streamingAssetsPath, "Blueprints/Neter/DWG");
        var candidates = new List<Tuple<string, double, string>>();
        foreach (string relative in SystemOpponent ? new[] { "DWG/Duster", "SS/Falcon", "DWG/FlyingSquirrel" }
            : new[] { "DWG/BabyPaddlegun", "DWG/Sloop", "DWG/Grouper", "DWG/Corsair", "DWG/Marauder", "DWG/Duster" })
        {
            string file = Path.Combine(bpRoot, "..", relative + ".blueprint"); if (!File.Exists(file)) continue;
            string name = Path.GetFileNameWithoutExtension(file);
            var bp = new CustomBattleBlueprint(file, false); double cost = FleetPlan.Round(bp.MaterialCost);
            Log(name + " native material cost=" + cost);
            if (cost > 1000 && cost <= 100000) candidates.Add(Tuple.Create(name, cost, JObject.Parse(File.ReadAllText(file)).ToString(Formatting.None)));
        }
        Require(candidates.Count >= 1, "No fixture fleet fits 100k");
        var chosen = candidates.Where(c => c.Item2 <= 49000).OrderBy(c => c.Item2).Take(2).ToList();
        if (chosen.Count == 1) chosen.Add(chosen[0]);
        fixtureUnits = new JArray();
        Directory.CreateDirectory(Path.Combine(RankClient.DirectoryPath, "FleetBlueprints"));
        for (int i = 0; i < chosen.Count; i++)
        {
            var bp = chosen[i]; string hash = RankTransport.Hash(Encoding.UTF8.GetBytes(bp.Item3));
            File.WriteAllText(Path.Combine(RankClient.DirectoryPath, "FleetBlueprints", hash + ".blueprint"), bp.Item3, new UTF8Encoding(false));
            fixtureUnits.Add(new JObject { ["hash"] = hash, ["name"] = bp.Item1, ["cost"] = bp.Item2,
                ["x"] = i == 0 ? -80 : 80, ["z"] = i == 0 ? 0 : -120, ["altitude"] = mapTest["altitude"], ["yaw"] = i == 0 ? 0 : 15 });
        }
        var tournament = (JObject)RankClient.Tournament.DeepClone();
        tournament["rules"]["duration"] = 15; tournament["rules"]["replacementSeconds"] = 0;
        tournament["rules"]["distance"] = 1000; tournament["rules"]["maxUnits"] = 10; tournament["rules"]["maxBlueprints"] = 10;
        foreach (string key in new[] { "world", "boardEast", "boardNorth" }) tournament["rules"][key] = mapTest[key];
        tournament["expectedRevision"] = tournament["revision"];
        RankClient.Run("로컬 전투 검사 준비", async () => {
            var configured = await RankTransport.Request(server, admin, "PUT", "/admin/tournaments/standard-100k", tournament);
            var second = (JObject)configured["tournament"].DeepClone(); second["id"] = "probe-second-cup"; second["name"] = "Second probe event"; second["expectedRevision"] = 0;
            await RankTransport.Request(server, admin, "PUT", "/admin/tournaments/probe-second-cup", second);
            if (SystemOpponent)
            {
                var defaults = await RankTransport.Request(server, admin, "POST", "/admin/tournaments/standard-100k/opponents/defaults", new { });
                Require(defaults["opponents"].Count() == 3, "Missing campaign defaults");
                foreach (var p in defaults["opponents"])
                {
                    foreach (var u in p["fleet"]["units"])
                    {
                        var native = candidates.Single(c => c.Item1 == (string)u["name"]);
                        Require(Math.Abs(native.Item2 - (double)u["cost"]) < .001, "Bundled campaign cost differs from native FTD");
                    }
                    if ((string)p["preset"] != "air-dwg-flying-squirrel")
                        await RankTransport.Request(server, admin, "PUT", "/admin/opponents/" + (string)p["id"] + "/enabled", new { enabled = false, expectedRevision = (int)p["revision"] });
                }
                return defaults;
            }
            var opponent = await RankTransport.Request(server, null, "POST", "/auth/register", new { username = "fleet_opponent", nickname = "검사 상대", password = "fixture-password-2026" });
            opponentToken = opponent["token"].Value<string>();
            foreach (var bp in chosen) await RankTransport.UploadFleetBlueprint(server, opponentToken, bp.Item3, bp.Item2);
            return await RankTransport.Request(server, opponentToken, "PUT", "/tournaments/standard-100k/entry",
                new { revision = configured["tournament"]["revision"].Value<int>(), units = fixtureUnits });
        }, r => { opponentReady = true; Log("Opponent fleet submitted"); });
    }
    static void InspectSpawn()
    {
        var state = CustomBattleModeProgression.State; initialTeams = new JArray();
        string expectedWorld = (string)mapTest["world"] == "aote" ? "Ashes of the Empire" : "Neter";
        Require(Planet.i.File.Header.Name.ScrapableEnglish == expectedWorld, "Battle used the wrong world");
        Require((string)ticket["rules"]["world"] == (string)mapTest["world"], "Server world snapshot differs");
        Require(Math.Abs(state.Settings.BoardSectionEast - (double)mapTest["boardEast"]) < .001 && Math.Abs(state.Settings.BoardSectionNorth - (double)mapTest["boardNorth"]) < .001, "Battle coordinates differ");
        var expected = StaticCoordTransforms.BoardSectionToUniversalPosition((float)mapTest["boardEast"] - .5f, (float)mapTest["boardNorth"] - .5f);
        var actual = PlanetList.MainFrame.FramePositionToUniversalPosition(Vector3.zero);
        Require(Math.Abs(expected.x - actual.x) < .01 && Math.Abs(expected.z - actual.z) < .01, "World frame did not move to the selected coordinates");
        worldReport = new JObject { ["world"] = expectedWorld, ["boardEast"] = state.Settings.BoardSectionEast, ["boardNorth"] = state.Settings.BoardSectionNorth,
            ["universalX"] = actual.x, ["universalZ"] = actual.z, ["switchedFromOtherWorld"] = true };
        Require(state.Teams.Count == 2, "Expected two teams");
        for (int i = 0; i < 2; i++)
        {
            var team = state.Teams[i]; var fleet = ticket[i == 0 ? "ownerFleet" : "opponentFleet"];
            var units = (JArray)fleet["units"];
            Require(team.Setup.Blueprints.Count == units.Count && team.Vehicles.Count >= units.Count, "Multi-BP spawn count differs");
            Require(Math.Abs(team.Setup.TotalMaterialCost + team.Setup.StartingMaterial - 100000) < .05, "Budget != 100k");
            var positions = new JArray();
            for (int j = 0; j < units.Count; j++)
            {
                var bp = team.Setup.Blueprints[j]; var local = Quaternion.Inverse(team.Setup.GLobalRotation) * (bp.GLobalPosition - team.Setup.GLobalPosition);
                string hash = (string)units[j]["hash"];
                var stored = JObject.Parse(File.ReadAllText(Path.Combine(RankClient.DirectoryPath,"Matches",(string)ticket["id"],hash+".blueprint")));
                Require(bp.Name == ((string)stored["Blueprint"]["blueprintName"] ?? (string)stored["Blueprint"]["Name"]), "Internal BP name was not preserved");
                Require(!System.Text.RegularExpressions.Regex.IsMatch(bp.Name ?? "", "^[a-fA-F0-9]{64}$"), "Hash name remains on blueprint");
                Require(team.Vehicles.Any(v => v.Name == bp.Name), "Runtime vehicle name differs from blueprint name");
                Require(Math.Abs(local.x - RankClient.Number(units[j], "x")) < .01 && Math.Abs(local.z - RankClient.Number(units[j], "z")) < .01, "Native spawn overwrote formation");
                Require(Math.Abs(bp.GLobalPosition.y - RankClient.Number(units[j], "altitude")) < .01, "Altitude differs");
                float angle = Quaternion.Angle(bp.GLobalRotation, team.Setup.GLobalRotation * Quaternion.Euler(0, (float)RankClient.Number(units[j], "yaw"), 0));
                Require(angle < .05, "Heading differs");
                positions.Add(new JObject { ["x"] = bp.GLobalPosition.x, ["z"] = bp.GLobalPosition.z, ["altitude"] = bp.GLobalPosition.y });
            }
            double resources = team.GetMaterials(state.Settings);
            Require(resources <= team.Setup.StartingMaterial + 1 && resources >= team.Setup.StartingMaterial - 500, "Unexpected resource allocation");
            initialTeams.Add(new JObject { ["blueprints"] = units.Count, ["vehicles"] = team.Vehicles.Count,
                ["spawnCost"] = team.Setup.TotalMaterialCost, ["supply"] = team.Setup.StartingMaterial,
                ["measuredResources"] = resources, ["positions"] = positions });
        }
    }
    static void SurrenderFromEscapeMenu()
    {
        var menu = new GameMenuUi(new MainMenu()); menu.TriggerRebuild(); menu.ActivateGui(GuiActivateType.Stack);
        var button = menu.Windows.First().Screen.Segments.SelectMany(s => s.Interpretters)
            .OfType<BrilliantSkies.Ui.Consoles.Interpretters.Subjective.Buttons.SubjectiveButton<MainMenu>>()
            .Single(b => b.GetDisplayString() == L.T("항복 / Surrender"));
        var click = (Action<MainMenu>)HarmonyLib.AccessTools.Field(button.GetType(), "_fnEffect").GetValue(button);
        var popups = (System.Collections.IList)HarmonyLib.AccessTools.Field(typeof(BrilliantSkies.Ui.Special.PopUps.GuiPopUp), "_popUps")
            .GetValue(BrilliantSkies.Ui.Special.PopUps.GuiPopUp.Instance);
        // Invoke the exact ESC button and native confirmation callbacks. Batchmode
        // does not draw OnGUI, so remove each completed popup as Display() would.
        click(new MainMenu());
        var popup = popups.Cast<object>().OfType<BrilliantSkies.Ui.Special.PopUps.PopupConfirmation>().Last();
        var confirmation = (BrilliantSkies.Ui.Special.PopUps.Internal.PopConfirmation)HarmonyLib.AccessTools.Field(popup.GetType(), "_focus").GetValue(popup);
        confirmation.Reject(); popups.Remove(popup);
        Require(RankBattle.Running && RankClient.PendingResult == null, "Rejecting surrender changed the match");
        click(new MainMenu());
        popup = popups.Cast<object>().OfType<BrilliantSkies.Ui.Special.PopUps.PopupConfirmation>().Last();
        confirmation = (BrilliantSkies.Ui.Special.PopUps.Internal.PopConfirmation)HarmonyLib.AccessTools.Field(popup.GetType(), "_focus").GetValue(popup);
        confirmation.Accept(); popups.Remove(popup);
        Require(!RankBattle.Running && RankClient.PendingResult != null && (bool?)RankClient.PendingResult["cancel"] == true,
            "ESC surrender did not queue a durable loss");
        Log("ESC surrender confirmation accepted; simulation stopped, durable loss queued, request running=" + RankClient.Busy);
    }
    static void InspectArena()
    {
        var state = CustomBattleModeProgression.State;
        var first = state.Teams[0].Vehicles[0];
        float start = state.StartTime;
        state.Reset(); state.Start(); state.Init(); state.SetMainframePosition();
        Require(state.IsRunning && !state.InSetup && state.StartTime == start && ReferenceEquals(first,state.Teams[0].Vehicles[0]), "Native reset/restart altered ranked state");
        var setup = new CustomBattleSetupUi(state.Settings);
        Require(!GuiDisplayBase.GetInternal().ActivateUi(setup, GuiActivateType.Stack), "Setup UI activation was allowed");
        var menu = new GameMenuUi(new MainMenu()); menu.TriggerRebuild();
        Require(menu.Windows.First().AllScreens.Count == 1 && menu.Windows.First().Screen.GetType().Name == "ArenaTab", "ESC retained vanilla setup tab");
        menu.ActivateGui(GuiActivateType.Stack);
        Require(!GuiDisplayer.GetSingleton().IsGUITryingToPauseGame(), "Ranked menu pauses battle");
        bool paused = GameSpeedManager.Instance.GamePaused;
        GameSpeedManager.Instance.TogglePause();
        Require(GameSpeedManager.Instance.GamePaused == paused && !paused, "Pause hotkey changes ranked time");
        menu.DeactivateGui();
        Require(InstanceSpecification.i.Header.CommonSettings.AccessToMap == AccessToMap.Disabled && InstanceSpecification.i.Header.CommonSettings.WarpAbility == WarpAbility.Off, "Ranked map/warp controls remain enabled");
        Require(RankSpectator.Active, "Spectator did not start");
        var random = UnityEngine.Random.state;
        Vector3 position = first.Construct.MainThreadPosition;
        Quaternion rotation = first.Construct.MainThreadRotation;
        float health = first.GetAliveFraction();
        RankSpectator.Follow(first);
        var native = RankSpectator.NativeCamera;
        Require(native != null && native.IsConstructMode && native.AnchorConstruct == first.Construct, "Native construct camera not selected");
        float zoom = native.ConstructCamera.PivotDistance;
        native.ConstructCamera.PivotDistance = zoom + 10;
        Require(native.ConstructCamera.PivotDistance > zoom, "Native pivot zoom failed");
        Vector3 originalFocus = native.ConstructCamera.FocusPosition;
        native.ConstructCamera.SetOffSet(new Vector3(10, 5, 0));
        Require(Vector3.Distance(originalFocus, native.ConstructCamera.FocusPosition) > 5, "Native relative movement failed");
        native.ConstructCamera.SetOffSet(Vector3.zero);
        Require(native.OpenFocusOptionEditorWindow(), "Native camera editor did not open");
        Require(GuiDisplayer.HasOpenWindow && !GuiDisplayer.GetSingleton().IsGUITryingToPauseGame(), "Native camera editor paused battle");
        GuiDisplayer.GetSingleton().CloseAllUis();
        Require(!native.IsInFireMode, "Spectator fire mode is enabled");
        var fire = native._i_cCameraControl_cFireControl as cFireControl;
        Require(fire != null, "Native fire control missing");
        fire.TurnOnFireMode(); Require(!fire.IsInFireMode, "Spectator can enable manual weapons");
        HarmonyLib.AccessTools.PropertySetter(typeof(bFireControl), "IsInFireMode").Invoke(fire, new object[] { true });
        fire.TurnOffFireMode(); Require(!fire.IsInFireMode, "An inherited fire mode could not be cleared");
        HarmonyLib.AccessTools.GetDeclaredMethods(typeof(cFireControl)).Single(m => m.Name.EndsWith(".Fire")).Invoke(fire, new object[] { true });
        Require(!HarmonyLib.Traverse.Create(fire).Field("_fireHeld").GetValue<bool>(), "Forced manual fire was not blocked");
        var control = UnityEngine.Object.FindFirstObjectByType<cControl>();
        Require(control != null && control.ControlMode == ConstructControlMode.Off_Camera && !control.ToggleControlMode(), "Spectator can control vehicle");
        Require(RankSpectator.Instance.Target == first && RankSpectator.Instance.CurrentView == RankSpectator.View.Follow, "Follow target failed");
        RankSpectator.Top(); Require(RankSpectator.Instance.CurrentView == RankSpectator.View.Top, "Top view failed");
        RankSpectator.Cycle(1); Require(RankSpectator.Instance.Target != first, "Next target failed");
        RankSpectator.Cycle(-1); Require(RankSpectator.Instance.Target == first, "Previous target failed");
        var enemy = state.Teams[1].Vehicles.First(v => v.Exists);
        RankSpectator.Follow(enemy);
        native.RunLateUpdate(); native.RunLateUpdate();
        Require(native.AnchorConstruct == enemy.Construct && native.IsConstructMode, "Enemy follow was cleared by team check");
        RankSpectator.Free(); Require(RankSpectator.Instance.CurrentView == RankSpectator.View.Free, "Free view failed");
        RankSpectator.Overview();
        Require(native.IsFreeMode, "Overview did not use native free camera");
        Require(native.FreeCamera.Transform.position.y >= WorldSpecification.i.Physics.WaterLevel + 19, "Initial camera is underwater");
        Require(random.Equals(UnityEngine.Random.state), "Camera consumed battle RNG");
        Require(position == first.Construct.MainThreadPosition && rotation == first.Construct.MainThreadRotation && health == first.GetAliveFraction(), "Camera changed vehicle state");
        Require(ReferenceEquals(CameraManager.GetSingleton().CamControl.CurrentMode, native.FreeCamera), "Native free camera is not active");
        InteractionProbe.InArena(first.Construct);
        Require(position == first.Construct.MainThreadPosition && rotation == first.Construct.MainThreadRotation && health == first.GetAliveFraction(), "Interaction guards changed vehicle state");
        Log("PASS Q tap/hold, block secondary, radial acquisition, C AI UI and vehicle/strategic UI blocked; native camera editor retained");
        Log("PASS ESC/reset/setup/pause/map/warp guards; native free/construct HUD camera, friendly/enemy follow, pivot zoom, top/overview, vehicle/fire input blocked, no RNG/vehicle mutation");
    }
    static void InspectFlight()
    {
        flightReport = new JArray();
        foreach (var team in CustomBattleModeProgression.State.Teams)
            foreach (var v in team.Vehicles)
            {
                double speed = new Vector2(v.Velocity.x, v.Velocity.z).magnitude;
                flightReport.Add(new JObject { ["name"] = v.Name, ["elapsed"] = RankBattle.Elapsed,
                    ["altitude"] = v.Position.y, ["horizontalSpeed"] = speed, ["aliveFraction"] = v.GetAliveFraction() });
                Require(v.Exists && v.Position.y > 20 && speed > 5, "Aircraft did not establish flight: " + v.Name + " " + flightReport);
            }
        Log("PASS airborne aircraft: " + flightReport.ToString(Formatting.None));
    }
}
