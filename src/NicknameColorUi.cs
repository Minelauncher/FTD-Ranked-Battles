using System;
using BrilliantSkies.Ui.Consoles;
using BrilliantSkies.Ui.Consoles.Getters;
using BrilliantSkies.Ui.Consoles.Interpretters.Simple;
using BrilliantSkies.Ui.Consoles.Interpretters.Subjective;
using BrilliantSkies.Ui.Consoles.Interpretters.Subjective.Buttons;
using BrilliantSkies.Ui.Consoles.Interpretters.Subjective.Numbers;
using BrilliantSkies.Ui.Consoles.Interpretters.Subjective.Texts;
using BrilliantSkies.Ui.Consoles.Styles;
using BrilliantSkies.Ui.Tips;
using UnityEngine;

namespace FtdRank
{
    public sealed class NicknameColorUi : ConsoleUi<object>
    {
        string hex = NicknameColor.Normalize(RankClient.Text(RankClient.Me, "nicknameColor")) ?? "#FFFFFF";
        string error = "";
        public NicknameColorUi() : base(new object()) { }
        public override void SetGuiSettings() { base.SetGuiSettings(); GuiSettings.PausesPlay = !RankBattle.Running; GuiSettings.AllowSidebars = false; }
        void Save(string value) { if (RankClient.Busy) return; RankClient.SaveNicknameColor(value); DeactivateGui(); }
        protected override ConsoleWindow BuildInterface(string suggestedName = "")
        {
            var w = NewWindow(0, L.T("Profile.Color"), WindowSizing.GetSizeCentral(.5f, Mathf.Clamp(460f / Screen.height, .4f, .7f)));
            w.DisplayTextPrompt = false; w.DisplayStoreForLaterButton = false;
            w.Screen.CreateStandardSegment().AddInterpretter(new Preview(() => hex));
            w.Screen.CreateStandardSegment().AddInterpretter(StringDisplay.Quick(L.T("Profile.Shared")));
            var field = TextInput<NicknameColorUi>.Quick(this, M.m((NicknameColorUi ui) => ui.hex), "RGB / HEX", new ToolTip("#RRGGBB"), (ui, value) => { ui.hex = value.Length > 7 ? value.Substring(0, 7) : value; });
            field.AllowRichTextInEditor = false; w.Screen.CreateStandardSegment().AddInterpretter(field);
            foreach (int channel in new[] { 0, 1, 2 }) {
                int c = channel;
                w.Screen.CreateStandardSegment().AddInterpretter(SubjectiveFloatClampedWithBar<NicknameColorUi>.Quick(this, 0, 255, 1,
                    M.m((NicknameColorUi ui) => Component((Color32)NicknameColor.Read(ui.hex, Color.white), c)),
                    new[] { "R {0}", "G {0}", "B {0}" }[c], (ui, value) => {
                        Color32 color = NicknameColor.Read(ui.hex, Color.white);
                        if (c == 0) color.r = (byte)Mathf.RoundToInt(value); else if (c == 1) color.g = (byte)Mathf.RoundToInt(value); else color.b = (byte)Mathf.RoundToInt(value);
                        ui.hex = "#" + color.r.ToString("X2") + color.g.ToString("X2") + color.b.ToString("X2");
                    }, new ToolTip("0–255")));
            }
            w.Screen.CreateStandardSegment().AddInterpretter(SubjectiveDisplay<NicknameColorUi>.Quick(this, M.m((NicknameColorUi ui) => ui.error)));
            w.Screen.CreateStandardSegment().AddInterpretter(Button.Quick(L.T("Profile.Save"), L.T("Profile.Save"), () => {
                string value = NicknameColor.Normalize(hex); if (value == null) error = L.T("Profile.Invalid"); else Save(value);
            }));
            w.Screen.CreateStandardSegment().AddInterpretter(Button.Quick(L.T("Profile.Default"), L.T("Profile.Default"), () => Save(null)));
            w.Screen.CreateStandardSegment().AddInterpretter(Button.Quick(L.T("Keys.Cancel"), L.T("Keys.Cancel"), () => DeactivateGui()));
            return w;
        }
        static float Component(Color32 color, int c) => c == 0 ? color.r : c == 1 ? color.g : color.b;
        sealed class Preview : NoSubjectAbstract
        {
            readonly Func<string> hex;
            public Preview(Func<string> hex) : base(M.m(""), M.m<BrilliantSkies.Core.IToolTip>(new ToolTip(""))) { this.hex = hex; }
            public override string GetKeyString(string key) => "";
            protected override bool ProcessInputOnceKeyFound(System.Collections.Generic.List<string> words, bool apply, ref string outcome) => false;
            public override Vector2 EstimateRectRequired() => new Vector2(300, 64);
            public override void Draw(SO_BuiltUi styles) {
                var style = RankCard.TextStyle(styles, 26, true); style.normal.textColor = NicknameColor.Read(hex(), UnityEngine.Color.white);
                style.padding.left = 12;
                GUILayout.Label(RankClient.Safe(RankClient.Text(RankClient.Me, "name")), style, GUILayout.Height(48));
            }
        }
    }
}
