using System;
using System.Linq;
using HarmonyLib;
using BrilliantSkies.Ftd.Modes.MainMenu.Ui;
using BrilliantSkies.Ui.Consoles;
using BrilliantSkies.Ui.Consoles.Getters;
using BrilliantSkies.Ui.Consoles.Interpretters;
using BrilliantSkies.Ui.Consoles.Interpretters.Simple;
using BrilliantSkies.Ui.Consoles.Interpretters.Subjective;
using BrilliantSkies.Ui.Consoles.Interpretters.Subjective.Buttons;
using BrilliantSkies.Ui.Consoles.Interpretters.Subjective.Numbers;
using BrilliantSkies.Ui.Consoles.Interpretters.Subjective.Texts;
using BrilliantSkies.Ui.Consoles.Segments;
using BrilliantSkies.Ui.Consoles.Styles;
using BrilliantSkies.Ui.Elements;
using BrilliantSkies.Ui.Tips;
using BrilliantSkies.Ui.Displayer;
using Newtonsoft.Json.Linq;
using UnityEngine;

namespace FtdRank
{
    [HarmonyPatch(typeof(MainMenuBasicsTab), nameof(MainMenuBasicsTab.Build))]
    static class BasicsEntry
    {
        static void Postfix(MainMenuBasicsTab __instance) => Add(__instance, 1);
        internal static void Add(MainMenuAbstractTab tab, int index)
        {
            var button = tab.B("Ranked Battles", "Asynchronous battles", R_Icons.MenuLeaderboards.Get(), _ => RankClient.Open());
            // Share the native button column, icon sizing and Blank spacing instead of adding a separate row.
            var groups = tab.Segments.OfType<ScreenSegmentStandard>()
                .Where(s => s.Interpretters.OfType<SubjectiveButtonWithSeparateIcon<MainMenu>>().Any()).ToArray();
            var group = tab is MainMenuBasicsTab ? groups.FirstOrDefault() : groups.LastOrDefault();
            if (group != null)
            {
                var buttons = group.Interpretters.OfType<SubjectiveButtonWithSeparateIcon<MainMenu>>().ToArray();
                var anchor = tab is MainMenuBasicsTab ? buttons[Math.Min(1, buttons.Length - 1)] : buttons.Last();
                int position = group.Interpretters.IndexOf(anchor) + 1;
                group.Interpretters.Insert(position, new Blank());
                group.Interpretters.Insert(position + 1, button);
            }
            else
            {
                var row = tab.CreateStandardSegment(); row.SpaceAbove = tab._topBottomSpace;
                row.AddInterpretter(button);
                tab.Segments.Remove(row); tab.Segments.Insert(Math.Min(index, tab.Segments.Count), row);
            }
            RankedPlugin.MenuBuilt++;
        }
    }
    [HarmonyPatch(typeof(MainMenuSinglePlayerTab), nameof(MainMenuSinglePlayerTab.Build))]
    static class SinglePlayerEntry { static void Postfix(MainMenuSinglePlayerTab __instance) => BasicsEntry.Add(__instance, 0); }

    public sealed class RankUi : ConsoleUi<MainMenu>
    {
        public readonly AccountForm Account = new AccountForm { Username = RankClient.SavedUsername };
        public RankUi() : base(new MainMenu()) { }
        public void ResetRankingScroll()
        {
            // FTD exposes no scroll reset API. Touch only this mod's ranking window.
            foreach (var window in Windows)
                if (window.Screen is RankingTab)
                    AccessTools.Field(typeof(ConsoleWindow), "_scroll")?.SetValue(window, Vector2.zero);
        }
        public void UpdateMatchHeader()
        {
            foreach (var window in Windows)
            {
                window.Name = L.T("랭크전 / Ranked Battles") + (RankClient.MatchLocked ? " · " + RankClient.MatchStateTitle : "");
                window.HeaderTint = RankClient.MatchLocked ? RankClient.MatchStateColor : Color.white;
            }
        }
        public override void OnDeactivateGui() { FormationCanvas.CancelActive(); RankChat.Close(); Account.ClearSecrets(); base.OnDeactivateGui(); }
        public override void SetGuiSettings()
        {
            base.SetGuiSettings(); GuiSettings.PausesPlay = !RankBattle.Running; GuiSettings.AllowSidebars = true;
        }
        protected override ConsoleWindow BuildInterface(string suggestedName = "")
        {
            var window = NewWindow(0, L.T("랭크전 / Ranked Battles"), new ScaledRectangle(160, 40, 960, 780));
            window.DisplayTextPrompt = false; window.DisplayStoreForLaterButton = false;
            window.SetMultipleTabs(new TournamentTab(window, _focus), new FleetTab(window, _focus), new LobbyTab(window, _focus), new HistoryTab(window, _focus), new RankingTab(window, _focus), new ChatTab(window, _focus), new ServerTab(window, _focus, Account));
            RankedPlugin.LobbyBuilt++;
            return window;
        }
    }
    sealed class TournamentTab : RankTab
    {
        public TournamentTab(ConsoleWindow w, MainMenu m) : base(w, m, L.T("대회 / Events"), L.T("대회와 규칙 / Events and rules")) { }
        public override void Build()
        {
            Status(false);
            if (!RankClient.Connected) { Action(L.T("로그인 / Sign in"), L.T("계정 열기 / Open account"), RankClient.Connect); Done(false); return; }
            Action(L.T("새로고침 / Refresh"), L.T("대회 목록 / Event list"), RankClient.LoadTournaments, !RankClient.CanChangeTournament);
            foreach (var t in RankClient.Tournaments.OfType<JObject>())
            {
                string id = RankClient.Text(t, "id");
                bool selected = RankClient.Text(RankClient.Tournament, "id") == id;
                var rules = t["rules"];
                string state = RankClient.Text(t, "status") == "open" ? L.T("접수 중 / Open") : RankClient.Text(t, "status") == "locked" ? L.T("접수 마감 / Locked") : L.T("종료 / Closed");
                Card(new RankCard(RankClient.Text(t, "name"), BattlefieldRules.Summary(rules),
                    L.F("{0} · 예산 / Budget {1:N0} · {2:0.#}분 / min", state, RankClient.Number(rules, "teamBudget"), RankClient.Number(rules, "duration") / 60),
                    selected ? L.T("선택됨 / Selected") : "", selected ? new Color(.95f, .73f, .3f) : (Color?)null,
                    selected, () => RankClient.SelectTournament(id), () => RankClient.CanChangeTournament, 12));
            }
            var current = RankClient.Tournament;
            if (current != null)
            {
                var r = current["rules"]; string status = RankClient.Text(current, "status");
                MakeHeader(L.T("대회 규칙 / Event rules"), L.T("선택한 대회 / Selected event"));
                Line(RankClient.Safe(RankClient.Text(current, "description")));
                Line(RankClient.Safe(BlueprintBlocks.Summary(r)));
                Line(RankClient.Safe(BattlefieldRules.Summary(r)));
                if ((string)current["resultPolicy"] == BattleOutcome.Policy) Line(L.T("Outcome.MaterialRule"));
                CreateStandardSegment().AddInterpretter(new BattlefieldCanvas((JObject)r));
                Line(L.F("{0}\n예산 / Budget {1:N0} · 기체 / Units {2} · BP {3}\n시간 / Time {4}s · 거리 / Distance {5}m", (status == "open" ? L.T("접수 중 / Open") : status == "locked" ? L.T("제출 마감 / Locked") : L.T("종료 / Closed")), RankClient.Number(r, "teamBudget"), RankClient.Number(r, "maxUnits"), RankClient.Number(r, "maxBlueprints"), RankClient.Number(r, "duration"), RankClient.Number(r, "distance")));
            }
            if (!RankClient.Tournaments.Any()) Line(L.T("등록된 대회 없음 / No events"));
            Done(false);
        }
    }
    sealed class FleetTab : RankTab
    {
        sealed class QuantityForm { public string Hash, Value; }
        public FleetTab(ConsoleWindow w, MainMenu m) : base(w, m, L.T("함대 / Fleet"), L.T("기체·진형 편집 / Ships and formation")) { }
        public override System.Action<OnDeselectTabSource> OnDeselectTab => _ => FormationCanvas.CancelActive();
        void Slider(JObject item, string key, string label, double min, double max, bool editable)
        {
            if (!editable || min == max) { Line(label.Replace("{0}", RankClient.Number(item, key).ToString("0.###"))); return; }
            CreateStandardSegment().AddInterpretter(SubjectiveFloatClampedWithBar<JObject>.Quick(item, (float)min, (float)max, .1f,
                M.m((JObject value) => (float)RankClient.Number(value, key)), label,
                (value, f) => { if (RankClient.CanEditFleet) { value[key] = FleetPlan.Round(f); RankClient.SaveDraft(); } }, new ToolTip(L.T("드래그하거나 수치를 입력하여 조절합니다."))));
        }
        public override void Build()
        {
            Status(); var t = RankClient.Tournament; var rules = RankClient.Rules; var units = RankClient.Draft;
            if (t == null) { Line(L.T("대회를 먼저 선택하세요. / Select an event first.")); Done(false); return; }
            bool edit = RankClient.CanEditFleet;
            var nameField = TextInput<MainMenu>.Quick(_focus, M.m((MainMenu m) => RankClient.DraftName), L.T("함대 이름 / Fleet name"),
                new ToolTip(L.T("1~40자 · 이름 수정은 교체 대기 없음 / 1–40 characters; no rename cooldown")), (m, value) => { if (RankClient.CanEditFleet) { RankClient.DraftName = value.Length > 160 ? value.Substring(0, 160) : value; RankClient.SaveDraft(); } });
            nameField.AllowRichTextInEditor = false; nameField.AllowEditing = M.m<MainMenu>(edit);
            CreateStandardSegment().AddInterpretter(nameField);
            var draftState = CreateStandardSegment().AddInterpretter(SubjectiveDisplay<MainMenu>.Quick(_focus, M.m((MainMenu m) =>
                RankClient.Entry == null ? L.T("미제출 / Not submitted") : RankClient.DraftMatchesSubmission
                ? L.T("제출한 함대 / Submitted fleet") : L.T("미제출 변경 있음 / Unsaved changes — 매칭은 제출본 사용 / Matches use submitted fleet"))));
            draftState.WrapText = true;
            double cost = units.Sum(u => RankClient.Number(u, "cost")), budget = RankClient.Number(rules, "teamBudget");
            Line(L.F("기체 / Spawn {0:N0} + 보급 / Supply {1:N0} = 예산 / Budget {2:N0}\n기체 / Units {3}/{4} · BP {5}/{6}", cost, budget - cost, budget, units.Count, RankClient.Number(rules, "maxUnits"), units.Select(u => RankClient.Text(u, "hash")).Distinct().Count(), RankClient.Number(rules, "maxBlueprints")));
            Line(L.T("드래그 배치 / Drag to move · Shift: 10m · Alt: 자유 / Free · Esc: 취소 / Cancel"));
            CreateStandardSegment().AddInterpretter(new FormationCanvas());
            var draftError = CreateStandardSegment().AddInterpretter(SubjectiveDisplay<MainMenu>.Quick(_focus,
                M.m((MainMenu m) => RankClient.DraftError.Length == 0 ? "" : L.T("확인 필요 / Check: ") + RankClient.Safe(RankClient.DraftError))));
            draftError.WrapText = true;
            if (RankClient.Entry != null)
            {
                double wait = RankClient.Number(RankClient.Entry, "replaceAt") - RankClient.Now;
                bool formationFree = RankClient.Entry["compositionUpdated"] != null;
                if (!RankClient.MatchLocked) {
                    Line(RankClient.Entry["current"]?.Value<bool>() != true ? L.T("규칙 변경: 재제출 필요 / Rules changed: resubmit") : wait > 0 ? L.T("BP·수량 교체 / Replacement in ") + TimeSpan.FromSeconds(wait).ToString(@"d\d\ hh\:mm") : L.T("BP·수량 교체 가능 / Replacement available"));
                    if (formationFree) Line(L.T("진형 수정은 대기 없음 / Formation changes: no cooldown"));
                }
                Action(L.T("되돌리기 / Restore"), L.T("제출한 진형 복원 / Restore submitted fleet"), RankClient.RestoreSubmittedFleet, !edit);
            }
            Action(L.T("기체 추가 / Add blueprint"), L.T("BP 선택 / Select blueprint"), RankClient.AddFleetBlueprint, !edit);
            MakeHeader(L.T("수량 / Quantity"), L.T("0: 모두 제거 / Remove all"));
            foreach (var group in units.GroupBy(u => RankClient.Text(u, "hash")))
            {
                var form = new QuantityForm { Hash = group.Key, Value = group.Count().ToString() };
                var row = CreateStandardHorizontalSegment();
                var field = TextInput<QuantityForm>.Quick(form, M.m((QuantityForm q) => q.Value), RankClient.Safe(RankClient.Text(group.First(), "name")),
                    new ToolTip(L.T("수량을 입력한 뒤 적용하세요. 기존 기체 위치는 유지됩니다.")), (q, value) => q.Value = value.Length > 4 ? value.Substring(0, 4) : value);
                field.AllowRichTextInEditor = false; field.AllowEditing = M.m<QuantityForm>(edit);
                row.AddInterpretter(field);
                var apply = row.AddInterpretter(B(L.T("적용 / Apply"), L.T("0: 모두 제거 / Remove all"), _ => RankClient.SetBlueprintQuantity(form.Hash, form.Value)));
                apply.FadeOut = M.m<MainMenu>(!edit);
            }
            MakeHeader(L.T("기체 / Units"), L.T("선택하여 편집 / Select to edit"));
            for (int i = 0; i < units.Count; i++)
            {
                int index = i; var u = units[i];
                Action($"{(i == RankClient.SelectedUnit ? "▶ " : "")}{i + 1}. {RankClient.Safe(RankClient.Text(u, "name"))} · {RankClient.Number(u, "cost"):N0}",
                    L.F("X {0} / Z {1} / 고도 {2} / 방향 {3}°", RankClient.Number(u, "x"), RankClient.Number(u, "z"), RankClient.Number(u, "altitude"), RankClient.Number(u, "yaw")),
                    () => { RankClient.SelectedUnit = index; RankClient.RefreshUi(); });
            }
            if (RankClient.SelectedUnit >= 0 && RankClient.SelectedUnit < units.Count)
            {
                var u = (JObject)units[RankClient.SelectedUnit];
                MakeHeader(L.F("기체 / Unit {0}", RankClient.SelectedUnit + 1), L.T("위치·방향 / Position and heading"));
                Slider(u, "x", L.T("좌우 / X {0}m"), -RankClient.Number(rules, "formationHalfWidth"), RankClient.Number(rules, "formationHalfWidth"), edit);
                Slider(u, "z", L.T("앞뒤 / Z {0}m"), -RankClient.Number(rules, "formationDepth"), 0, edit);
                Slider(u, "altitude", L.T("고도 / Altitude {0}m"), RankClient.Number(rules, "minAltitude"), RankClient.Number(rules, "maxAltitude"), edit);
                Slider(u, "yaw", L.T("방향 / Heading {0}°"), -180, 180, edit);
                Action(L.T("BP 교체 / Replace"), L.T("위치 유지 / Keep position"), () => RankClient.ChooseReplacementBlueprint(false), !edit);
                Action(L.T("같은 BP 교체 / Replace all copies"), L.T("각 위치 유지 / Keep positions"), () => RankClient.ChooseReplacementBlueprint(true), !edit);
                Action(L.T("복제 / Duplicate"), L.T("한 척 추가 / Add one copy"), RankClient.DuplicateUnit, !edit);
                Action(L.T("제거 / Remove"), L.T("선택 기체 제거 / Remove selected unit"), RankClient.RemoveUnit, !edit);
            }
            MakeHeader(L.T("자동 배치 / Grid"), L.T("행·열로 배치 / Arrange in rows"));
            if (edit)
            {
                if (RankClient.Number(rules, "maxUnits") > 1) CreateStandardSegment().AddInterpretter(SubjectiveFloatClampedWithBar<MainMenu>.Quick(_focus, 1, (float)RankClient.Number(rules, "maxUnits"), 1,
                    M.m((MainMenu m) => (float)RankClient.GridColumns), L.T("열 / Columns {0}"), (m, f) => RankClient.GridColumns = (int)f, new ToolTip(L.T("한 줄의 기체 수 / Units per row"))));
                else { RankClient.GridColumns = 1; Line(L.T("열 / Columns 1")); }
                CreateStandardSegment().AddInterpretter(SubjectiveFloatClampedWithBar<MainMenu>.Quick(_focus, 0, Math.Max(1, (float)RankClient.Number(rules, "formationHalfWidth") * 2), 1,
                    M.m((MainMenu m) => RankClient.GridSideways), L.T("좌우 간격 / Spacing {0}m"), (m, f) => RankClient.GridSideways = f, new ToolTip(L.T("같은 줄의 기체 사이 / Between units"))));
                CreateStandardSegment().AddInterpretter(SubjectiveFloatClampedWithBar<MainMenu>.Quick(_focus, 0, Math.Max(1, (float)RankClient.Number(rules, "formationDepth")), 1,
                    M.m((MainMenu m) => RankClient.GridBackwards), L.T("행 간격 / Row spacing {0}m"), (m, f) => RankClient.GridBackwards = f, new ToolTip(L.T("행 사이 / Between rows"))));
            }
            Action(L.T("자동 배치 / Arrange"), L.T("고도·방향 유지 / Keep altitude and heading"), RankClient.ArrangeGrid, !edit || units.Count == 0);
            if (RankClient.MatchLocked) MatchNotice();
            Action(L.T("제출 / Submit fleet"), L.T("함대와 진형 등록 / Submit fleet and formation"), RankClient.SubmitFleet,
                !edit || RankClient.Text(t, "status") != "open");
            Done(false);
        }
    }
    abstract class RankTab : MainMenuAbstractTab
    {
        protected RankTab(ConsoleWindow w, MainMenu m, string name, string tip) : base(w, m) { Name = new Content(name, new ToolTip(tip)); _topBottomSpace = 12; }
        protected void Line(string text) { if (!string.IsNullOrWhiteSpace(text)) CreateStandardSegment().AddInterpretter(new RankText(text)); }
        protected new void MakeHeader(string text, string tip) {
            var row = CreateStandardSegment(); row.SpaceAbove = 12; row.SpaceBelow = 5;
            row.AddInterpretter(new RankText(text, 22, true, tip));
        }
        protected void Card(RankCard card) {
            var row = CreateStandardSegment(); row.SpaceAbove = 5; row.SpaceBelow = 7; row.AddInterpretter(card);
        }
        protected void ResultCard(JToken result)
        {
            double score = RankClient.Number(result, "score", .5), delta = RankClient.Number(result, "delta");
            Color color = score == 1 ? new Color(.45f, .8f, .58f) : score == 0 ? new Color(.95f, .47f, .43f) : new Color(.8f, .73f, .45f);
            string meta = result["initiated"]?.Value<bool>() == false ? L.T("상대가 진행 / Opponent hosted") : L.T("내가 진행 / You hosted");
            double completed = RankClient.Number(result, "completed");
            if (completed > 0 && completed < 253402300799) meta = DateTimeOffset.FromUnixTimeSeconds((long)completed).ToLocalTime().ToString("MM-dd HH:mm") + " · " + meta;
            string detail = L.F("레이팅 / Rating {0:0.0} → {1:0.0}", RankClient.Number(result, "before"), RankClient.Number(result, "after"));
            var health = result["outcome"]?["remaining"] as JArray;
            string materials = BattleOutcome.MaterialSummary(result);
            if (materials.Length > 0) detail += "\n" + materials;
            else if (health?.Count == 2) detail += L.F("\n체력 / Health {0:0.0}% : {1:0.0}%", (double)health[0] * 100, (double)health[1] * 100);
            Card(new RankCard(BattleOutcome.Label(result) + " · " + NicknameColor.Rich(RankClient.Text(result, "opponentName"), RankClient.Text(result, "opponentNicknameColor")),
                meta, detail, delta.ToString("+0.0;-0.0;0.0"), color, richTitle: true));
        }
        protected void Action(string name, string tip, Action action, bool disabled = false)
        {
            var row = CreateStandardSegment(); row.SpaceAbove = 3; row.SpaceBelow = 3;
            var button = row.AddInterpretter(B(name, tip, _ => { if (!RankClient.Busy && !disabled) action(); }));
            button.FadeOut = M.m<MainMenu>(RankClient.Busy || disabled);
        }
        protected void Status(bool showEvent = true)
        {
            if (showEvent && RankClient.Tournament != null) CreateStandardSegment().AddInterpretter(new RankText(RankClient.Text(RankClient.Tournament, "name"), 20, true));
            MatchNotice();
            Line(RankClient.Safe(RankClient.Status));
            if (RankClient.DownloadProgress != null)
            {
                var progress = CreateStandardSegment().AddInterpretter(SubjectiveDisplay<MainMenu>.Quick(_focus,
                    M.m((MainMenu m) => RankClient.Safe(RankClient.DownloadProgress?.ToString() ?? ""))));
                progress.WrapText = true;
            }
        }
        protected void MatchNotice()
        {
            if (!RankClient.MatchLocked) return;
            Card(new RankCard(RankClient.MatchStateTitle, detail: RankClient.MatchStateDetail, accent: RankClient.MatchStateColor));
            if (RankClient.PendingResult != null)
            {
                var countdown = CreateStandardSegment().AddInterpretter(SubjectiveDisplay<MainMenu>.Quick(_focus,
                    M.m((MainMenu m) => RankClient.ResultRetryText)));
                countdown.WrapText = true;
                if (RankClient.ResultDelivery == ResultDeliveryState.SignInRequired)
                    Action(L.T("로그인 / Sign in"), L.T("Result.AccountHint"), RankClient.OpenResultAccount);
                else Action(L.T("Result.RetryNow"), L.T("Result.Locked"), RankClient.SubmitResult,
                    RankClient.ResultDelivery == ResultDeliveryState.Sending);
            }
            else if (!(this is LobbyTab) && !(this is ArenaTab))
                Action(L.T("Match.Open"), L.T("Match.Locked"), () => RankClient.FocusTab(L.T("전투")));
        }
    }
    sealed class LobbyTab : RankTab
    {
        public LobbyTab(ConsoleWindow w, MainMenu m) : base(w, m, L.T("전투 / Battle"), L.T("매칭·관전 / Match and watch")) { }
        public override void Build()
        {
            var me = RankClient.Me; var ticket = RankClient.Ticket; var receipt = RankClient.Receipt;
            Status();
            if (!RankClient.Connected) { Action(L.T("로그인 / Sign in"), L.T("계정 열기 / Open account"), RankClient.Connect); Done(false); return; }
            Card(new RankCard(NicknameColor.Rich(me), L.F("레이팅 / Rating · {0}전 / matches", RankClient.Number(RankClient.EventRating, "games")),
                value: RankClient.Number(RankClient.EventRating, "rating", 1000).ToString("0.0"), accent: RankPalette.For(RankClient.Standing), valueSize: 28, richTitle: true));
            var ownFleet = FleetPresentation.ForMatch(ticket, RankClient.Entry);
            if (ownFleet == null) Line(L.T("함대를 먼저 제출하세요. / Submit your fleet first."));
            else
            {
                MakeHeader(L.T("내 함대 / Your fleet · ") + RankClient.Safe(FleetPresentation.Name(ownFleet)), ticket != null ? L.T("이 경기의 함대 / Match fleet") : L.T("서버 제출본 / Submitted fleet"));
                Line(RankClient.Safe(FleetPresentation.Composition(ownFleet)));
                Line(L.F("기체 / Units {0} · 소환 / Spawn {1:N0} · 보급 / Supply {2:N0}", (ownFleet["units"] as JArray)?.Count ?? 0, RankClient.Number(ownFleet, "spawnCost"), RankClient.Number(ownFleet, "supply")));
                if (ticket == null && !RankClient.DraftMatchesSubmission) Line(L.T("미제출 편집안 있음 · 매칭은 위 함대 사용 / Unsaved draft; matching uses the fleet above"));
                Action(RankClient.ShowMatchFormation ? L.T("진형 접기 / Hide formation") : L.T("진형 확인 / View formation"), L.T("제출한 배치·고도·방향 / Submitted positions, altitude and heading"),
                    () => { RankClient.ShowMatchFormation = !RankClient.ShowMatchFormation; RankClient.RefreshUi(); });
                if (RankClient.ShowMatchFormation) CreateStandardSegment().AddInterpretter(new FormationCanvas((JArray)ownFleet["units"], ticket?["rules"] as JObject ?? RankClient.Rules));
            }
            if (RankClient.PendingResult != null) { /* Recovery controls are in the persistent match notice above. */ }
            else if (RankBattle.Running) {
                Line(L.T("관전 중 / Watching · ") + RankBattle.Elapsed.ToString("0") + "s");
                Action(L.T("관전 / Watch"), L.T("전투로 복귀 / Return to battle"), () => Window.CloseWindow());
                Action(L.T("관전 시점 / Camera"), L.T("기체 선택·추적 / Select and follow"), RankSpectator.OpenMenu);
                Action(L.T("항복 / Surrender"), L.T("패배로 기록 / Counts as a loss"), RankClient.Cancel);
            }
            else if (receipt != null && ticket == null)
            {
                ResultCard(receipt);
                Action(L.T("다음 경기 / Next match"), L.T("상대 찾기 / Find opponent"), RankClient.Match);
            }
            else if (ticket != null)
            {
                Card(new RankCard(L.T("상대 / Opponent · ") + NicknameColor.Rich(ticket["opponent"]),
                    RankClient.Text(ticket["opponentFleet"], "name"),
                    L.F("기체 / Units {0} · 제한 / Limit {1:0.#}분 / min", (ticket["opponentFleet"]?["units"] as JArray)?.Count ?? 1, RankClient.Number(ticket, "duration") / 60),
                    RankClient.Number(ticket["opponent"], "rating").ToString("0.0"), RankPalette.For(ticket["opponent"]?["standing"]), richTitle: true));
                if (ticket["rules"] != null) Line(RankClient.Safe(BattlefieldRules.Summary(ticket["rules"])));
                double remaining = RankClient.Number(ticket, "expiresAt") - RankClient.Now;
                Line(remaining > 0 ? L.T("제출 마감 / Deadline: ") + DateTimeOffset.FromUnixTimeSeconds((long)RankClient.Number(ticket, "expiresAt")).ToLocalTime().ToString("MM-dd HH:mm:ss") : L.T("제출 기한 초과 / Deadline passed"));
                Action(L.T("전투 시작 / Start battle"), L.T("1배속 관전 / Watch at 1×"), RankClient.StartBattle, RankBattle.Loading || remaining <= 0);
                Action(L.T("항복 / Surrender"), L.T("패배로 기록 / Counts as a loss"), RankClient.Cancel, RankBattle.Loading);
            }
            else
            {
                Action(L.T("상대 찾기 / Find match"), L.T("제출한 함대로 참가 / Use submitted fleet"), RankClient.Match, RankClient.Entry == null || RankClient.Entry["current"]?.Value<bool>() != true || RankClient.Text(RankClient.Tournament, "status") == "closed");
            }
            Action(L.T("새로고침 / Refresh"), L.T("최신 전적 / Latest results"), RankClient.Refresh, RankBattle.Running || RankBattle.Loading || RankClient.PendingResult != null);
            if (RankBattle.InArena) Action(L.T("메인 메뉴 / Main menu"), L.T("메뉴로 복귀 / Return to menu"), RankBattle.Return, RankBattle.Running || RankBattle.Loading);
            Done(false);
        }
    }
    sealed class HistoryTab : RankTab
    {
        public HistoryTab(ConsoleWindow w, MainMenu m) : base(w, m, L.T("전적 / History"), L.T("최근 경기 / Recent battles")) { }
        public override void Build()
        {
            Status();
            foreach (var r in RankClient.History)
                ResultCard(r);
            if (!RankClient.History.Any()) Line(L.T("완료한 경기 없음 / No completed matches"));
            Action(L.T("새로고침 / Refresh"), L.T("최근 20경기 / Last 20 matches"), RankClient.Refresh, !RankClient.Connected || RankBattle.Running || RankBattle.Loading); Done(false);
        }
    }
    sealed class RankingTab : RankTab
    {
        public RankingTab(ConsoleWindow w, MainMenu m) : base(w, m, L.T("순위 / Ranking"), L.T("참가자 레이팅 / Player ratings")) { }
        public override System.Action OnSelectTab => () => { if (!RankClient.Ranking.Loaded) RankClient.LoadStandings(); };
        void Pages()
        {
            var page = RankClient.Ranking;
            Line(page.Range);
            var row = CreateTableSegment(3, 1); row.SqueezeTable = false;
            var previous = B(L.T("Ranking.Previous"), L.T("Ranking.Previous"), _ => {
                if (!RankClient.Busy && RankClient.Connected && RankClient.Ranking.HasPrevious)
                    RankClient.LoadStandings(RankClient.Ranking.Page - 1);
            });
            previous.FadeOut = M.m<MainMenu>(RankClient.Busy || !RankClient.Connected || !page.HasPrevious);
            row.AddInterpretter(previous, 0, 0);
            row.AddInterpretter(StringDisplay.Quick(page.Summary), 0, 1);
            var next = B(L.T("Ranking.Next"), L.T("Ranking.Next"), _ => {
                if (!RankClient.Busy && RankClient.Connected && RankClient.Ranking.HasNext)
                    RankClient.LoadStandings(RankClient.Ranking.Page + 1);
            });
            next.FadeOut = M.m<MainMenu>(RankClient.Busy || !RankClient.Connected || !page.HasNext);
            row.AddInterpretter(next, 0, 2);
        }
        public override void Build()
        {
            Status();
            if (RankClient.Tournament == null) { Line(L.T("대회를 먼저 선택하세요. / Select an event first.")); Done(false); return; }
            Action(L.T("새로고침 / Refresh"), L.T("Ranking.Refresh"), RankClient.LoadStandings, !RankClient.Connected);
            if (RankClient.Ranking.Loaded) Pages();
            foreach (var a in RankClient.Standings)
                Card(new RankCard($"{RankClient.Number(a, "rank"):0}. {NicknameColor.Rich(a)}",
                    L.F("{0}전 / matches", RankClient.Number(a, "games")), value: RankClient.Number(a, "rating").ToString("0.0"),
                    accent: RankPalette.For(a), selected: RankClient.Text(a, "id") == RankClient.Text(RankClient.Me, "id"), tintText: true, richTitle: true));
            if (RankClient.Ranking.Loaded && !RankClient.Standings.Any()) Line(L.T("Ranking.Empty"));
            if (RankClient.Ranking.Loaded && RankClient.Standings.Count > 8) Pages();
            Done(false);
        }
    }
    sealed class ServerTab : RankTab
    {
        readonly AccountForm form;
        public ServerTab(ConsoleWindow w, MainMenu m, AccountForm account) : base(w, m, L.T("계정 / Account"), L.T("로그인·가입 / Sign in or register")) { form = account; }
        void AccountInfo(string text)
        {
            if (string.IsNullOrWhiteSpace(text)) return;
            var row = CreateStandardSegment(); row.SpaceAbove = 5; row.SpaceBelow = 8;
            row.AddInterpretter(new RankText(text, 19));
        }
        void Heading(string text, string tip = "")
        {
            var row = CreateStandardSegment(); row.SpaceAbove = 18; row.SpaceBelow = 8;
            row.AddInterpretter(new RankText(text, 26, true, tip));
        }
        void Profile(bool compact)
        {
            if (!compact) Heading(L.T("Account.Profile"));
            Card(new RankCard(NicknameColor.Rich(RankClient.Me),
                meta: L.T("로그인 아이디 / Username: ") + RankClient.Safe(RankClient.Text(RankClient.Auth, "username")),
                richTitle: true, titleSize: compact ? 24 : 28, metaSize: 20));
        }
        void Mode(string mode)
        {
            form.ClearSecrets(); form.Mode = mode;
            RankClient.Status = "";
            RankClient.RefreshUi();
        }
        void Input(string label, Func<AccountForm, string> get, System.Action<AccountForm, string> set, bool secret = false)
        {
            var field = new AccountInput(form, label, get, set, secret);
            field.AllowRichTextInEditor = false;
            field.AllowEditing = M.m<AccountForm>(!RankClient.Busy);
            var row = CreateStandardSegment(); row.SpaceAbove = 3; row.SpaceBelow = 3;
            row.AddInterpretter(field);
        }
        void EmailForm(bool link, bool busyBattle)
        {
            Heading(L.T(link ? "Recovery.EmailSettings" : "Recovery.FindAccount"), L.T("Recovery.EmailHelp"));
            if (!link && form.RecoveryAccounts.Any())
            {
                AccountInfo(L.T("Recovery.AccountsFound"));
                foreach (var row in form.RecoveryAccounts.OfType<JObject>())
                {
                    string id = RankClient.Text(row, "id"), username = RankClient.Text(row, "username");
                    Card(new RankCard(RankClient.Safe(username), RankClient.Safe(RankClient.Text(row, "nickname")), titleSize: 24, metaSize: 20));
                    Action(L.T("Recovery.ResetPassword"), L.T("Recovery.TemporaryHelp"), () => RankClient.ResetRecoveredAccount(form, id, username), busyBattle);
                }
                Action(L.T("로그인 / Sign in"), L.T("로그인 / Sign in"), () => Mode("login"), busyBattle);
                Done(false); return;
            }
            if (form.EmailNotice.Length > 0) AccountInfo(L.T(form.EmailNotice));
            if (form.EmailError.Length > 0)
                Card(new RankCard(L.Message(form.EmailError), accent: new Color(.95f, .65f, .35f), titleSize: 20));
            bool verifyingLink = link && !string.IsNullOrEmpty(form.EmailChallenge);
            if (verifyingLink) Card(new RankCard(L.T("Recovery.Email"), detail: RankClient.Safe(form.Email), detailSize: 22));
            else
            {
                Input(L.T("Recovery.Email"), f => f.Email, (f,v) => f.Email = v);
                if (link) Input(L.T("현재 암호 / Current password"), f => f.Password, (f,v) => f.Password = v, true);
                Action(L.T("Recovery.SendCode"), L.T("Recovery.EmailHelp"), () => RankClient.RecoverAccount(form, false), busyBattle);
            }
            if (!string.IsNullOrEmpty(form.EmailChallenge))
            {
                Input(L.T("Recovery.Code"), f => f.EmailCode, (f,v) => f.EmailCode = v.Length > 8 ? v.Substring(0,8) : v);
                Action(L.T("Recovery.Verify"), L.T("Recovery.Verify"), () => RankClient.RecoverAccount(form, true), busyBattle);
            }
            if (verifyingLink) Action(L.T("Recovery.EditOrResend"), L.T("Recovery.EditOrResend"), () => { form.ClearSecrets(); RankClient.RefreshUi(); }, busyBattle);
            Action(L.T("Recovery.Back"), L.T("Recovery.Back"), () => Mode("login"), busyBattle);
            Done(false);
        }
        public override void Build()
        {
            MatchNotice();
            AccountInfo(RankClient.Safe(RankClient.Status));
            bool busyBattle = RankBattle.Running || RankBattle.Loading;
            MakeHeader(L.T("Language"), L.T("Language scope"));
            CreateStandardSegment().AddInterpretter(new LanguageFlags());
            if (!RankClient.Connected && RankClient.HasSavedLogin)
                Action(L.T("다시 연결 / Reconnect"), L.T("저장된 로그인 / Saved session"), RankClient.Connect, busyBattle);
            if (RankClient.Connected)
            {
                if (RankClient.NeedsCredentials)
                {
                    form.Mode = "claim";
                }
                else
                {
                    if (RankClient.PasswordResetRequired) { form.Mode = "password"; AccountInfo(L.T("Recovery.ChangeRequired")); }
                    Profile(form.Mode == "email" || form.Mode == "password");
                    if (form.Mode == "email") { EmailForm(true, busyBattle); return; }
                    if (form.Mode != "password")
                    {
                        Action(L.T("Profile.Color"), L.T("Profile.Shared"), () => new NicknameColorUi().ActivateGui(GuiActivateType.Stack), busyBattle);
                        Heading(L.T("Account.Security"));
                        string email = RankClient.Text(RankClient.Auth, "recoveryEmail");
                        bool verified = email.Length > 0 && RankClient.Auth?["emailVerified"]?.Value<bool>() == true;
                        Card(new RankCard(L.T("Recovery.Email"),
                            meta: L.T(verified ? "Account.Verified" : "Recovery.NotLinked"),
                            detail: email.Length == 0 ? L.T("Account.AddEmailHint") : RankClient.Safe(email),
                            accent: verified ? new Color(.45f, .8f, .58f) : new Color(.9f, .7f, .36f),
                            titleSize: 22, metaSize: 19, detailSize: email.Length == 0 ? 19 : 22));
                        Action(L.T("Recovery.EmailSettings"), L.T("Recovery.EmailHelp"), () => { Mode("email"); form.Email = email; }, busyBattle);
                        Action(L.T("비밀번호 변경 / Change password"), L.T("새 비밀번호 설정 / Set a new password"), () => Mode("password"), busyBattle);
                        Action(L.T("로그아웃 / Sign out"), L.T("진행 중인 경기 종료 후 / After finishing your match"), RankClient.Logout, RankClient.AccountLocked);
                        Done(false); return;
                    }
                }
            }
            else
            {
                if (form.Mode == "claim" || form.Mode == "password" || form.Mode == "email") form.Mode = "login";
                var modes = CreateStandardHorizontalSegment();
                var login = modes.AddInterpretter(B(L.T("로그인 / Sign in"), L.T("로그인 양식 / Sign-in form"), _ => { if (!RankClient.Busy && !busyBattle && form.Mode != "login") Mode("login"); }));
                var register = modes.AddInterpretter(B(L.T("회원가입 / Register"), L.T("가입 양식 / Registration form"), _ => { if (!RankClient.Busy && !busyBattle && !RankClient.AccountLocked && form.Mode != "register") Mode("register"); }));
                login.FadeOut = M.m<MainMenu>(RankClient.Busy || busyBattle || form.Mode == "login");
                register.FadeOut = M.m<MainMenu>(RankClient.Busy || busyBattle || RankClient.AccountLocked || form.Mode == "register");
                if (form.Mode == "recovery") { EmailForm(false, busyBattle); return; }
            }
            string title = form.Mode == "login" ? L.T("로그인 / Sign in") : form.Mode == "register" ? L.T("회원가입 / Register") : form.Mode == "claim" ? L.T("아이디 등록 / Set username") : L.T("비밀번호 변경 / Change password");
            Heading(title);
            if (form.Mode != "password") Input(L.T("로그인 아이디 / Username"), f => f.Username, (f, v) => f.Username = v.Length > 128 ? v.Substring(0, 128) : v);
            if (form.Mode == "register" || form.Mode == "claim") Input(L.T("닉네임 / Nickname"), f => f.Nickname, (f, v) => f.Nickname = v.Length > 128 ? v.Substring(0, 128) : v);
            Input(form.Mode == "password" ? L.T("현재 암호 / Current password") : L.T("비밀번호 / Password"), f => f.Password, (f, v) => f.Password = v, true);
            if (form.Mode == "password") Input(L.T("새 암호 / New password"), f => f.NewPassword, (f, v) => f.NewPassword = v, true);
            if (form.Mode != "login")
            {
                Input(L.T("암호 확인 / Confirm password"), f => f.Confirm, (f, v) => f.Confirm = v, true);
            }
            if (form.Mode == "register")
                Input(L.T("Registration.EmailOptional"), f => f.Email, (f,v) => f.Email = v);
            if (form.Mode != "login")
                AccountInfo(form.Mode == "password" ? L.T("새 비밀번호 8~32자 / New password: 8–32 characters") : L.T("아이디·비밀번호 8~32자 / Username & password: 8–32\n아이디 / Username: A–Z, 0–9, _ . -\n공개 닉네임 2~24자 / Public nickname: 2–24"));
            if (form.Mode == "register")
                AccountInfo(L.T("Registration.EmailHelp"));
            string submit = form.Mode == "register" ? L.T("가입 완료 / Create account") : form.Mode == "login" ? L.T("로그인하기 / Sign in") : form.Mode == "claim" ? L.T("등록 완료 / Save username") : L.T("변경 적용 / Save password");
            Action(submit, form.Mode == "register" ? L.T("가입 후 자동 로그인 / Register and sign in") : L.T("확인 / Confirm"), () => RankClient.Authenticate(form), busyBattle);
            if (form.Mode == "login") Action(L.T("Recovery.FindAccount"), L.T("Recovery.EmailHelp"), () => Mode("recovery"), busyBattle);
            if (form.Mode == "password" && !RankClient.PasswordResetRequired) Action(L.T("Recovery.Back"), L.T("Recovery.Back"), () => Mode("login"), busyBattle);
            Done(false);
        }
    }
    // All account fields share one label column and editor rectangle, including masked passwords.
    sealed class AccountInput : TextInput<AccountForm>
    {
        readonly Func<AccountForm, string> get;
        readonly System.Action<AccountForm, string> set;
        readonly bool secret;
        GUIStyle labelStyle, inputStyle;
        public AccountInput(AccountForm form, string label, Func<AccountForm, string> getter, System.Action<AccountForm, string> setter, bool secret)
            : base(form, M.m(getter), M.m<AccountForm>(label), M.m<AccountForm>(new ToolTip(label)), setter, null, s => s, (f, s) => null) { get = getter; set = setter; this.secret = secret; }
        public override void Draw(SO_BuiltUi styles)
        {
            if (labelStyle == null)
            {
                labelStyle = new GUIStyle(styles.TextEdit.NameBoxLeftHandSide.Style) {
                    fontSize = 20, alignment = TextAnchor.MiddleRight, richText = false, wordWrap = true,
                    fixedWidth = 0, fixedHeight = 0, padding = new RectOffset(0, 12, 0, 0), margin = new RectOffset()
                };
                inputStyle = new GUIStyle(styles.TextEdit.TextEnter.Style) {
                    fontSize = 20, alignment = TextAnchor.MiddleLeft, richText = false, wordWrap = false,
                    fixedWidth = 0, fixedHeight = 0, clipping = TextClipping.Clip, margin = new RectOffset()
                };
            }
            Rect row = GUILayoutUtility.GetRect(100, 38, GUILayout.ExpandWidth(true));
            float labelWidth = Mathf.Min(row.width * .45f, Mathf.Clamp(row.width * .26f, 190, 300));
            GUI.Box(row, GUIContent.none, styles.TextEdit.NameBoxPanel.Style);
            GUI.Label(new Rect(row.x + 8, row.y, labelWidth - 8, row.height), GetDisplayString(), labelStyle);
            Rect input = new Rect(row.x + labelWidth, row.y + 1, Mathf.Max(60, row.width - labelWidth - 8), row.height - 2);
            PreFocus();
            bool enabled = GUI.enabled; GUI.enabled = enabled && AllowEditing.GetFromSubject(Subject);
            // Validate on submit so overlong input is reported, never silently truncated to a valid password.
            string previous = get(Subject) ?? "";
            string value = secret ? GUI.PasswordField(input, previous, '*', 128, inputStyle) : GUI.TextField(input, previous, inputStyle);
            GUI.enabled = enabled; PostFocus();
            if (enabled && AllowEditing.GetFromSubject(Subject) && value != previous) set(Subject, value);
        }
    }
}
