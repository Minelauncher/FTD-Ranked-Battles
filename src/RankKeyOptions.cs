using System;
using BrilliantSkies.Ui.Consoles;
using BrilliantSkies.Ui.Consoles.Examples;
using BrilliantSkies.Ui.Consoles.Getters;
using BrilliantSkies.Ui.Consoles.Interpretters.Simple;
using BrilliantSkies.Ui.Consoles.Interpretters.Subjective;
using BrilliantSkies.Ui.Consoles.Interpretters.Subjective.Buttons;
using BrilliantSkies.Ui.Displayer;
using BrilliantSkies.Ui.Tips;
using UnityEngine;

namespace FtdRank
{
    public sealed class RankKeyOptions : SuperScreen
    {
        static readonly Func<ConsoleWindow, ConsoleUiScreen> factory = w => new RankKeyOptions(w);
        string status = "";
        public static void Register()
        {
            if (!FtdOptionsMenuUi.ExtraScreens.Contains(factory)) FtdOptionsMenuUi.ExtraScreens.Add(factory);
        }
        public RankKeyOptions(ConsoleWindow window) : base(window)
        {
            Name = new Content("Ranked Battles", new ToolTip(L.T("Keys.Title")));
        }
        public override void Build()
        {
            CreateHeader(L.T("Keys.Title"));
            CreateStandardSegment().AddInterpretter(StringDisplay.Quick(L.T("Keys.Scope")));
            var table = CreateTableSegment(3, 4); table.SqueezeTable = false;
            int row = 0;
            foreach (var a in RankKeyBindings.Actions) {
                var action = a;
                table.AddInterpretter(StringDisplay.Quick(RankKeyBindings.ActionName(action)), row, 0);
                table.AddInterpretter(new SubjectiveButton<RankAction>(action,
                    M.m((RankAction i) => RankClient.Settings.Keys.Label(i)),
                    M.m<RankAction>(new ToolTip(L.T("Keys.Change"))), null,
                    i => new RankKeyCaptureUi(i).ActivateGui(GuiActivateType.Stack)), row, 1);
                table.AddInterpretter(Button.Quick(L.T("Keys.Disable"), L.T("Keys.Disable"),
                    () => { RankClient.SetKey(action, KeyCode.None, RankKeyModifiers.None, out status); }), row, 2);
                row++;
            }
            CreateSpace(12);
            CreateStandardSegment().AddInterpretter(Button.Quick(L.T("Keys.Restore"), L.T("Keys.Restore"),
                () => { RankClient.RestoreKeys(out status); }));
            CreateStandardSegment().AddInterpretter(SubjectiveDisplay<RankKeyOptions>.Quick(this,
                M.m((RankKeyOptions i) => i.status)));
        }
    }

    public sealed class RankKeyCaptureUi : ConsoleUi<object>
    {
        readonly RankAction action;
        string status;
        readonly int openedFrame;
        public RankKeyCaptureUi(RankAction action) : base(new object()) { this.action = action; openedFrame = Time.frameCount; }
        public override void SetGuiSettings()
        {
            base.SetGuiSettings(); GuiSettings.PausesPlay = !RankBattle.Running; GuiSettings.AllowSidebars = false;
        }
        protected override ConsoleWindow BuildInterface(string suggestedName = "")
        {
            var window = NewWindow(0, RankKeyBindings.ActionName(action), WindowSizing.GetSizeCentral(.45f, .35f));
            window.DisplayTextPrompt = false; window.DisplayStoreForLaterButton = false;
            window.Screen.CreateStandardSegment().AddInterpretter(StringDisplay.Quick(L.T("Keys.Press")));
            window.Screen.CreateStandardSegment().AddInterpretter(SubjectiveDisplay<RankKeyCaptureUi>.Quick(this,
                M.m((RankKeyCaptureUi i) => i.status ?? "")));
            window.Screen.CreateStandardSegment().AddInterpretter(Button.Quick(L.T("Keys.Cancel"), L.T("Keys.Cancel"), () => DeactivateGui()));
            return window;
        }
        // The event is consumed before native buttons see Return/Space. ESC cancels,
        // and the click that opened this dialog cannot become a mouse binding.
        public void Capture(Event input)
        {
            if (!MenuActive || input == null || input.type != EventType.KeyDown || input.keyCode == KeyCode.None) return;
            var key = input.keyCode;
            var modifiers = (input.shift ? RankKeyModifiers.Shift : 0) | (input.control ? RankKeyModifiers.Control : 0)
                | (input.alt ? RankKeyModifiers.Alt : 0) | (input.command ? RankKeyModifiers.Command : 0);
            input.Use();
            if (key == KeyCode.Escape) { DeactivateGui(); return; }
            if (RankKeyBindings.IsModifier(key)) return;
            if (RankClient.SetKey(action, key, modifiers, out status)) DeactivateGui();
        }
        public override void OnGui()
        {
            if (Time.frameCount > openedFrame) Capture(Event.current);
            if (MenuActive) base.OnGui();
        }
        public override void EscapePressed() => DeactivateGui();
    }
}
