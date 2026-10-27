using System.Collections.Generic;
using System.Linq;
using System.Reflection;
using HarmonyLib;
using BrilliantSkies.Ftd.Modes.CustomBattleMode;
using BrilliantSkies.Ftd.Modes.MainMenu.Ui;
using BrilliantSkies.FromTheDepths.Game.UserInterfaces;
using BrilliantSkies.FromTheDepths.Game.UserInterfaces.InteractiveOverlay;
using BrilliantSkies.Ftd.Constructs.UI;
using BrilliantSkies.Ui.Consoles;
using BrilliantSkies.Ui.Consoles.Getters;
using BrilliantSkies.Ui.Consoles.Interpretters.Subjective;
using BrilliantSkies.Ui.Consoles.Interpretters.Subjective.Texts;
using BrilliantSkies.Ui.Displayer;
using BrilliantSkies.Ui.Displayer.Types;

namespace FtdRank
{
    // Keep ordinary custom battles intact; only the ranked arena gets these restrictions.
    [HarmonyPatch]
    static class RankedStateGuard
    {
        static IEnumerable<MethodBase> TargetMethods() => new[] { "Start", "Reset", "Init", "SetMainframePosition" }
            .Select(name => (MethodBase)AccessTools.Method(typeof(CustomBattleModeState), name));
        static bool Prefix() => RankBattle.NativeChangeAllowed;
    }
    [HarmonyPatch]
    static class RankedArenaUiGuard
    {
        static IEnumerable<MethodBase> TargetMethods() => AccessTools.GetDeclaredMethods(typeof(GuiDisplayBase))
            .Where(m => m.Name.EndsWith(".ActivateUi") || m.Name.EndsWith(".ActivateUiToggle"));
        static bool Prefix(IGui_GuiSystem __0, ref bool __result)
        {
            if (!RankBattle.InArena) return true;
            // These windows issue vehicle/AI orders or edit the arena. Guard activation
            // itself so remapped keys, HUD buttons and toggle routes cannot reopen them.
            bool blocked = __0.GetType().Namespace == "BrilliantSkies.Ui.CustomBattleMode"
                || __0 is InteractiveOverlayGui || __0 is AiControlUi
                || __0 is ConstructableInfoUi || __0 is FleetControlGUI;
            if (!blocked) return true;
            __result = false; return false;
        }
    }
    [HarmonyPatch(typeof(GameMenuUi), "BuildInterface")]
    static class RankedEscapeMenu
    {
        static void Postfix(ConsoleWindow __result)
        {
            if (RankBattle.InArena) __result.SetMultipleTabs(new ArenaTab(__result, new MainMenu()));
        }
    }
    [HarmonyPatch(typeof(GuiDisplayBase), nameof(GuiDisplayBase.IsGUITryingToPauseGame))]
    static class RankedMenuPauseGuard
    {
        static bool Prefix(ref bool __result)
        {
            if (!RankBattle.Running || CustomBattleModeProgression.State._hasFinished) return true;
            __result = false; return false;
        }
    }
    [HarmonyPatch(typeof(GameSpeedManager), nameof(GameSpeedManager.TogglePause))]
    static class RankedPauseKeyGuard
    {
        static bool Prefix() => !RankBattle.Running || CustomBattleModeProgression.State._hasFinished;
    }
    [HarmonyPatch(typeof(MainMenu), nameof(MainMenu.ReturnToMainMenu))]
    static class RankedExitGuard
    {
        static bool Prefix()
        {
            if (!RankBattle.InArena || (!RankBattle.Running && !RankBattle.Loading)) return true;
            if (!RankBattle.Loading) RankClient.Cancel();
            return false;
        }
    }
    public sealed class SpectatorUi : ConsoleUi<MainMenu>
    {
        public SpectatorUi() : base(new MainMenu()) { }
        public override void SetGuiSettings()
        {
            base.SetGuiSettings(); GuiSettings.PausesPlay = false; GuiSettings.AllowSidebars = false;
        }
        protected override ConsoleWindow BuildInterface(string suggestedName = "")
        {
            var window = NewWindow(0, L.T("관전 / Spectator"), new ScaledRectangle(30, 35, 510, 720));
            window.DisplayTextPrompt = false; window.DisplayStoreForLaterButton = false;
            window.SetMultipleTabs(new ArenaTab(window, _focus)); return window;
        }
    }
    sealed class ArenaTab : RankTab
    {
        public ArenaTab(ConsoleWindow w, MainMenu m) : base(w, m, L.T("랭크전 관전 / Spectator"), L.T("시점·기체 선택 / Camera and vehicles")) { }
        void Camera(string text, System.Action select)
            => Action(text, L.T("시점 전환 / Switch camera"), () => { select(); Window.CloseWindow(); }, !RankSpectator.Active);
        public override void Build()
        {
            MatchNotice();
            var live = CreateStandardSegment().AddInterpretter(SubjectiveDisplay<MainMenu>.Quick(_focus,
                M.m((MainMenu m) => RankSpectator.Description + "\n" + RankBattle.Elapsed.ToString("0") + "s · 1×")));
            live.WrapText = true;
            if (RankBattle.Running) Line(L.T("메뉴를 열어도 전투는 계속됩니다. / Battle continues while this menu is open."));
            Action(L.T("전투로 복귀 / Resume"), L.T("창 닫기 / Close"), () => Window.CloseWindow());
            Camera(L.T("전체 보기 / Overview"), RankSpectator.Overview);
            Camera(L.T("자유 시점 / Free camera"), RankSpectator.Free);
            Camera(L.T("위에서 보기 / Top view"), RankSpectator.Top);
            Line(L.T("Keys.Mouse") + "\n" + RankClient.Settings.Keys.Summary);
            var state = CustomBattleModeProgression.State;
            if (RankSpectator.Active)
                for (int i = 0; i < state.Teams.Count; i++)
                {
                    MakeHeader((i == 0 ? L.T("내 편대 / Yours · ") : L.T("상대 / Opponent · ")) + RankClient.Safe(state.Teams[i].Setup.Name), L.T("기체 선택 / Select vehicle"));
                    foreach (var v in state.Teams[i].Vehicles)
                    {
                        var vehicle = v;
                        Action(RankClient.Safe(v.Name) + (v.Exists ? " · " + (v.GetAliveFraction() * 100).ToString("0") + "%" : L.T(" · 파괴 / Lost")),
                            L.T("기체 추적 / Follow vehicle"), () => { if (vehicle.Exists) { RankSpectator.Follow(vehicle); Window.CloseWindow(); } }, !v.Exists);
                    }
                }
            Action(L.T("설정 / Options"), L.T("화면·소리·입력 / Display, sound and controls"), () => _focus.OpenOptions());
            Action(L.T("랭크전 기록 / Ranked results"), L.T("함대·전적 / Fleet and results"), () => { Window.CloseWindow(); RankClient.Open(false); });
            if (RankBattle.Running) Action(L.T("항복 / Surrender"), L.T("확인 후 패배 처리 / Confirm to concede"), RankClient.Cancel);
            else if (!RankBattle.Loading) Action(L.T("메인 메뉴 / Main menu"), L.T("메뉴로 복귀 / Return"), RankBattle.Return);
            Done(false);
        }
    }
}
