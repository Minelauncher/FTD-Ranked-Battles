using System;
using System.IO;
using System.Linq;
using System.Text;
using System.Globalization;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;
using Assets.Scripts.Gui;
using Assets.Scripts.Persistence;
using BrilliantSkies.Ui.CustomBattleMode;
using BrilliantSkies.Ui.Special.PopUps;

namespace FtdRank
{
    public static partial class RankClient
    {
        public static JArray Tournaments = new JArray(), Draft = new JArray();
        public static JObject Tournament, Entry;
        public static string DraftName = FleetPresentation.DefaultName;
        public static bool ShowMatchFormation;
        public static int SelectedUnit = -1;
        public static int GridColumns = 3;
        public static float GridSideways = 100, GridBackwards = 100;
        public static JObject Rules => Tournament?["rules"] as JObject;
        public static bool DraftMatchesSubmission => DraftName.Trim() == FleetPresentation.Name(Entry?["fleet"]) && FleetPlan.SamePlacement(Draft, Entry?["fleet"]?["units"] as JArray);
        public static bool CanEditFleet => Connected && Tournament != null && !Busy && Ticket == null && PendingResult == null && !RankBattle.Running && !RankBattle.Loading;
        public static bool CanChangeTournament => !Busy && Ticket == null && PendingResult == null && !RankBattle.Running && !RankBattle.Loading;
        public static string DraftError
        {
            get { try { FleetPresentation.CheckedName(DraftName); FleetPlan.Validate(Draft, Rules); return ""; } catch (Exception e) { return e.Message; } }
        }
        static string DraftPath
        {
            get
            {
                string key = RankTransport.Hash(Encoding.UTF8.GetBytes(Settings.Server + "|" + Text(Me, "id") + "|" + Text(Tournament, "id")));
                return Path.Combine(DirectoryPath, "Drafts", key + ".json");
            }
        }
        static string BlueprintPath(string hash) => Path.Combine(DirectoryPath, "FleetBlueprints", hash + ".blueprint");
        public static void SaveDraft()
        {
            if (Tournament == null || Me == null) return;
            Directory.CreateDirectory(Path.GetDirectoryName(DraftPath));
            Save(DraftPath, new { name = DraftName, units = Draft });
        }
        public static void LoadTournaments()
        {
            if (!Connected) return;
            string server = Settings.Server, token = Token;
            Run(L.T("대회 목록을 불러오는 중…"), () => Request(server, token, "GET", "/tournaments"), r =>
            {
                Tournaments = r["tournaments"] as JArray ?? new JArray();
                Status = "";
                string selected = Text(Ticket?["tournament"], "id");
                if (selected.Length == 0) Settings.SelectedTournaments.TryGetValue(server, out selected);
                var t = Tournaments.OfType<JObject>().FirstOrDefault(item => Text(item, "id") == selected)
                    ?? Tournaments.OfType<JObject>().FirstOrDefault(item => Text(item, "status") == "open")
                    ?? Tournaments.OfType<JObject>().FirstOrDefault();
                if (t != null) SelectTournament(Text(t, "id"), true);
            });
        }
        public static void SelectTournament(string id, bool restoring = false)
        {
            if (!restoring && !CanChangeTournament) return;
            string server = Settings.Server, token = Token;
            Run(L.T("대회와 제출 함대를 불러오는 중…"), () => Request(server, token, "GET", "/tournaments/" + id), r =>
            {
                Tournament = (JObject)r["tournament"]; Entry = r["entry"] as JObject;
                EventRating = r["rating"] as JObject; Standing = r["standing"] as JObject; History = r["history"] as JArray ?? new JArray(); ResetStandings();
                Settings.SelectedTournaments[server] = id; Save(ConfigPath, Settings);
                Draft = Entry?["fleet"]?["units"]?.DeepClone() as JArray ?? new JArray();
                DraftName = FleetPresentation.Name(Entry?["fleet"]);
                string draftWarning = "";
                if (File.Exists(DraftPath))
                {
                    try { var saved = JObject.Parse(File.ReadAllText(DraftPath)); Draft = saved["units"] as JArray ?? Draft; DraftName = (string)saved["name"] ?? DraftName; }
                    catch (Exception) { draftWarning = L.T("편집안 읽기 실패 · 제출본 복원 / Draft unreadable; submission restored"); }
                }
                SelectedUnit = Draft.Count > 0 ? 0 : -1;
                // Reconnecting to deliver a saved result must retain its confirmation card.
                if (!restoring || Text(Receipt, "tournamentId") != id) Receipt = null;
                ServerOffset = Number(r, "serverTime") - DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() / 1000.0;
                Status = Entry != null && Entry["current"]?.Value<bool>() != true
                    ? L.T("규칙 변경: 함대 재제출 필요 / Rules changed: resubmit fleet") : draftWarning;
            });
        }
        public static void AddFleetBlueprint()
        {
            if (!CanEditFleet) return;
            GuiPopUp.Instance.Add(new PopupTreeView(L.T("함대에 기체 추가"), FtdGuiUtils.GetFileBrowserFor(GameFolders.GetCombinedBlueprintFolder(saving: false)), (name, accepted) =>
            {
                if (!accepted || !CanEditFleet) return;
                try
                {
                    if (Draft.Count >= FleetPlan.Value(Rules, "maxUnits")) throw new InvalidOperationException(L.T("기체 배치 수 제한에 도달했습니다."));
                    var bp = new CustomBattleBlueprint(name);
                    if (bp.File == null || bp.File.Corrupt || bp.Blueprint == null) throw new InvalidOperationException(L.T("BP를 읽을 수 없습니다."));
                    double cost = FleetPlan.Round(bp.MaterialCost);
                    if (double.IsNaN(cost) || double.IsInfinity(cost) || cost < 0) throw new InvalidOperationException(L.T("기체 비용을 계산하지 못했습니다."));
                    string text = bp.File.FileSource.LoadData<JObject>().ToString(Formatting.None);
                    BlueprintBlocks.Check(text, Rules, bp.Name);
                    string hash = RankTransport.Hash(Encoding.UTF8.GetBytes(text));
                    Directory.CreateDirectory(Path.Combine(DirectoryPath, "FleetBlueprints"));
                    ClientStorage.WriteText(BlueprintPath(hash), text);
                    double altitude = Math.Max(FleetPlan.Value(Rules, "minAltitude"), Math.Min(0, FleetPlan.Value(Rules, "maxAltitude")));
                    Draft.Add(new JObject { ["hash"] = hash, ["name"] = bp.Name, ["cost"] = cost, ["x"] = 0,
                        ["z"] = -Math.Min(Draft.Count * 100, FleetPlan.Value(Rules, "formationDepth")), ["altitude"] = altitude, ["yaw"] = 0 });
                    SelectedUnit = Draft.Count - 1; SaveDraft(); Status = "";
                }
                catch (Exception e) { Status = e.GetBaseException().Message; }
                RefreshUi();
            }));
        }
        public static void SetBlueprintQuantity(string hash, string input)
        {
            if (!CanEditFleet) return;
            try
            {
                if (!int.TryParse(input, NumberStyles.None, CultureInfo.InvariantCulture, out int count))
                    throw new InvalidOperationException(L.T("수량은 0 이상의 정수로 입력하세요."));
                var selected = SelectedUnit >= 0 && SelectedUnit < Draft.Count ? Draft[SelectedUnit] : null;
                var copy = FleetPlan.WithQuantity(Draft, hash, count, Rules);
                // Shrinking a group removes its last placements, preserving the earlier ones.
                int next = selected == null ? -1 : copy.ToList().FindIndex(u => JToken.DeepEquals(u, selected));
                Draft = copy; SelectedUnit = next >= 0 ? next : Draft.Count > 0 ? 0 : -1;
                SaveDraft(); Status = "";
            }
            catch (Exception e) { Status = e.GetBaseException().Message; }
            RefreshUi();
        }
        public static void ChooseReplacementBlueprint(bool allOfType)
        {
            if (!CanEditFleet || SelectedUnit < 0 || SelectedUnit >= Draft.Count) return;
            var snapshot = Draft; int index = SelectedUnit;
            GuiPopUp.Instance.Add(new PopupTreeView(allOfType ? L.T("같은 BP 전체 교체") : L.T("선택한 한 척의 BP 교체"),
                FtdGuiUtils.GetFileBrowserFor(GameFolders.GetCombinedBlueprintFolder(saving: false)), (name, accepted) =>
                {
                    if (!accepted || !CanEditFleet || !ReferenceEquals(snapshot, Draft)) return;
                    ReplaceFleetBlueprint(name, index, allOfType, true);
                }));
        }
        public static void ReplaceFleetBlueprint(string file, int index, bool allOfType, bool inGameFolder = false)
        {
            if (!CanEditFleet) return;
            try
            {
                var bp = new CustomBattleBlueprint(file, inGameFolder);
                if (bp.File == null || bp.File.Corrupt || bp.Blueprint == null) throw new InvalidOperationException(L.T("BP를 읽을 수 없습니다."));
                double cost = FleetPlan.Round(bp.MaterialCost);
                if (double.IsNaN(cost) || double.IsInfinity(cost) || cost < 0) throw new InvalidOperationException(L.T("기체 비용을 계산하지 못했습니다."));
                string text = bp.File.FileSource.LoadData<JObject>().ToString(Formatting.None);
                BlueprintBlocks.Check(text, Rules, bp.Name);
                string hash = RankTransport.Hash(Encoding.UTF8.GetBytes(text));
                var copy = FleetPlan.WithBlueprint(Draft, index, new JObject { ["hash"] = hash, ["name"] = bp.Name, ["cost"] = cost }, allOfType, Rules);
                Directory.CreateDirectory(Path.Combine(DirectoryPath, "FleetBlueprints"));
                ClientStorage.WriteText(BlueprintPath(hash), text);
                Draft = copy; SelectedUnit = index; SaveDraft();
                Status = "";
            }
            catch (Exception e) { Status = e.GetBaseException().Message; }
            RefreshUi();
        }
        public static void MoveFleetUnit(int index, double x, double z)
        {
            if (!CanEditFleet || index < 0 || index >= Draft.Count) return;
            if (double.IsNaN(x) || double.IsNaN(z) || double.IsInfinity(x) || double.IsInfinity(z)) return;
            Draft[index]["x"] = FleetPlan.Round(Math.Max(-Number(Rules, "formationHalfWidth"), Math.Min(Number(Rules, "formationHalfWidth"), x)));
            Draft[index]["z"] = FleetPlan.Round(Math.Max(-Number(Rules, "formationDepth"), Math.Min(0, z)));
            SelectedUnit = index; SaveDraft(); RefreshUi();
        }
        public static void DuplicateUnit()
        {
            if (!CanEditFleet || SelectedUnit < 0 || SelectedUnit >= Draft.Count) return;
            if (Draft.Count >= FleetPlan.Value(Rules, "maxUnits")) { Status = L.T("배치 수 제한에 도달했습니다."); RefreshUi(); return; }
            var copy = (JObject)Draft[SelectedUnit].DeepClone();
            copy["z"] = Math.Max(-FleetPlan.Value(Rules, "formationDepth"), Number(copy, "z") - 100);
            Draft.Add(copy); SelectedUnit = Draft.Count - 1; SaveDraft(); RefreshUi();
        }
        public static void RemoveUnit()
        {
            if (!CanEditFleet || SelectedUnit < 0 || SelectedUnit >= Draft.Count) return;
            Draft.RemoveAt(SelectedUnit); SelectedUnit = Math.Min(SelectedUnit, Draft.Count - 1); SaveDraft(); RefreshUi();
        }
        public static void ArrangeGrid()
        {
            if (!CanEditFleet) return;
            var copy = (JArray)Draft.DeepClone(); FleetPlan.Grid(copy, GridColumns, GridSideways, GridBackwards);
            // Budget errors may be fixed later, but keep the layout inside the server's spawn area.
            if (copy.Any(u => Math.Abs(Number(u, "x")) > Number(Rules, "formationHalfWidth") || Number(u, "z") < -Number(Rules, "formationDepth")))
            { Status = L.T("이 간격은 대회 배치 영역을 벗어납니다."); RefreshUi(); return; }
            Draft = copy; SaveDraft(); RefreshUi();
        }
        public static void RestoreSubmittedFleet()
        {
            if (!CanEditFleet || Entry == null) return;
            Draft = (JArray)Entry["fleet"]["units"].DeepClone(); DraftName = FleetPresentation.Name(Entry["fleet"]); SelectedUnit = Draft.Count > 0 ? 0 : -1; SaveDraft(); RefreshUi();
        }
        public static void SubmitFleet()
        {
            if (!CanEditFleet) return;
            try
            {
                FleetPlan.Validate(Draft, Rules);
                string fleetName = FleetPresentation.CheckedName(DraftName);
                var units = (JArray)Draft.DeepClone();
                // Recalculate cached BP costs in the current game's block/mod environment before sending.
                foreach (var u in units.GroupBy(u => Text(u, "hash")).Select(g => g.First()))
                {
                    string path = BlueprintPath(Text(u, "hash"));
                    if (!File.Exists(path)) continue; // a restored server entry already owns this immutable BP
                    if (RankTransport.Hash(File.ReadAllBytes(path)) != Text(u, "hash")) throw new InvalidOperationException(L.T("보관된 BP가 변경되었습니다. 기체를 다시 추가하세요."));
                    BlueprintBlocks.Check(File.ReadAllText(path), Rules, Text(u, "name"));
                    double actual = FleetPlan.Round(new CustomBattleBlueprint(path, false).MaterialCost);
                    if (double.IsNaN(actual) || double.IsInfinity(actual) || Math.Abs(actual - Number(u, "cost")) > .001)
                        throw new InvalidOperationException(L.T("기체 비용이 변경되었습니다. 해당 기체를 다시 추가하세요."));
                }
                string server = Settings.Server, token = Token, id = Text(Tournament, "id");
                int revision = (int)Number(Tournament, "revision");
                Run(L.T("함대 BP와 진형을 제출하는 중…"), async () =>
                {
                    foreach (var u in units.GroupBy(u => Text(u, "hash")).Select(g => g.First()))
                    {
                        string path = BlueprintPath(Text(u, "hash"));
                        if (File.Exists(path)) await RankTransport.UploadFleetBlueprint(server, token, File.ReadAllText(path), Number(u, "cost"));
                    }
                    return await Request(server, token, "PUT", "/tournaments/" + id + "/entry", new { revision, fleetName, units });
                }, r =>
                {
                    Entry = (JObject)r["entry"]; DraftName = FleetPresentation.Name(Entry["fleet"]); SaveDraft();
                    ServerOffset = Number(r, "serverTime") - DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() / 1000.0;
                    Status = L.T("제출 완료 / Submitted");
                });
            }
            catch (Exception e) { Status = e.GetBaseException().Message; RefreshUi(); }
        }
    }
}
