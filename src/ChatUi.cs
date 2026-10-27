using System;
using System.Collections.Generic;
using System.Linq;
using Newtonsoft.Json.Linq;
using BrilliantSkies.Ftd.Modes.MainMenu.Ui;
using BrilliantSkies.Ui.Consoles;
using BrilliantSkies.Ui.Consoles.Getters;
using BrilliantSkies.Ui.Consoles.Interpretters.Simple;
using BrilliantSkies.Ui.Consoles.Interpretters.Subjective.Buttons;
using BrilliantSkies.Ui.Consoles.Styles;
using BrilliantSkies.Ui.Displayer;
using BrilliantSkies.Ui.Tips;
using UnityEngine;

namespace FtdRank
{
    sealed class ChatTab : RankTab
    {
        readonly ConsoleWindow window;
        public ChatTab(ConsoleWindow window, MainMenu menu) : base(window, menu, L.T("Chat.Title"), L.T("Chat.Title")) { this.window = window; }
        public override bool DisableTabChangeHotKeys => true;
        public override Action OnSelectTab => RankClient.OpenChat;
        public override Action<OnDeselectTabSource> OnDeselectTab => _ => RankChat.Close();
        public override void Build()
        {
            if (!RankClient.Connected) Line(L.T("Chat.SignIn"));
            else CreateStandardSegment().AddInterpretter(new ChatCanvas(() => window.GetRectRequired().height));
            Done(false);
        }
    }
    public sealed class ChatCanvas : NoSubjectAbstract
    {
        readonly Func<float> windowHeight;
        Vector2 scroll, channelsScroll;
        GUIStyle body, small, name, title, entry, button, selected, panel, separator;
        bool searching, follow = true;
        int seen = -1;
        string channel = "";
        float contentHeight, previousHeight, pendingAnchor;
        public ChatCanvas(Func<float> windowHeight = null) : base(M.m(""), M.m<BrilliantSkies.Core.IToolTip>(new ToolTip(""))) { this.windowHeight = windowHeight; }
        public override string GetKeyString(string key) => "";
        protected override bool ProcessInputOnceKeyFound(List<string> words, bool apply, ref string outcome) => false;
        public override Vector2 EstimateRectRequired() => new Vector2(780, 560);
        void Styles(SO_BuiltUi styles)
        {
            if (body != null) return;
            int size = Mathf.Clamp(styles.FontSize, 17, 21);
            body = RankCard.TextStyle(styles, size); small = RankCard.TextStyle(styles, size - 3);
            small.normal.textColor = new Color(.68f, .76f, .8f);
            title = RankCard.TextStyle(styles, size + 5, true); name = RankCard.TextStyle(styles, size, true);
            entry = new GUIStyle(styles.TextEdit.TextEnter.Style) { richText = false, wordWrap = false, fontSize = size, fixedHeight = 0 };
            button = new GUIStyle(styles.Buttons.Button.Style) { richText = false, wordWrap = true, fontSize = size - 2, fixedHeight = 0 };
            selected = new GUIStyle(button) { fontStyle = FontStyle.Bold, fontSize = size - 1 };
            selected.normal.textColor = new Color(.55f, .87f, 1);
            panel = new GUIStyle(styles.Windows.ConsoleWindow.Style); separator = new GUIStyle(styles.Windows.Separator.Style);
        }
        bool Button(Rect r, string key, bool enabled = true) {
            bool saved = GUI.enabled; GUI.enabled = saved && enabled; bool clicked = GUI.Button(r, L.T(key), button); GUI.enabled = saved; return clicked;
        }
        static bool Enter(string control) => Event.current.type == EventType.KeyDown && (Event.current.keyCode == KeyCode.Return || Event.current.keyCode == KeyCode.KeypadEnter)
            && GUI.GetNameOfFocusedControl() == control && string.IsNullOrEmpty(Input.compositionString);
        void Latest() { follow = true; RankChat.Join(RankChat.Channel, true); }
        public override void Draw(SO_BuiltUi styles)
        {
            Styles(styles);
            float height = Mathf.Max(340, Mathf.Min(windowHeight?.Invoke() ?? Screen.height, Screen.height - 24) - 112);
            Rect area = GUILayoutUtility.GetRect(100, height, GUILayout.ExpandWidth(true));
            if (area.width < 100) return;
            float rail = Mathf.Clamp(area.width * .22f, 160, 245), gap = 16;
            Rect left = new Rect(area.x, area.y, rail, area.height);
            Rect right = new Rect(left.xMax + gap, area.y, Math.Max(200, area.width - rail - gap), area.height);
            GUI.Box(left, GUIContent.none, panel);
            GUI.Label(new Rect(left.x + 14, left.y + 12, rail - 28, 30), L.T("Chat.Channels"), name);
            Rect channelView = new Rect(left.x + 8, left.y + 50, rail - 16, left.height - 118);
            var channels = RankChat.Channels.OrderBy(c => (string)c["id"] == "general" ? 0 : 1).ToArray();
            channelsScroll = GUI.BeginScrollView(channelView, channelsScroll, new Rect(0, 0, channelView.width - 18, channels.Length * 64), false, false);
            for (int i = 0; i < channels.Length; i++) {
                var c = channels[i]; string id = (string)c["id"], label = id == "general" ? L.T("Chat.General") : RankClient.Safe((string)c["name"]);
                bool enabled = GUI.enabled; GUI.enabled = enabled && !RankChat.Sending && !RankChat.Searching && RankChat.Connected;
                if (GUI.Button(new Rect(0, i * 64, channelView.width - 20, 56), label, id == RankChat.Channel ? selected : button)) { follow = true; RankChat.Join(id); }
                GUI.enabled = enabled;
            }
            GUI.EndScrollView();
            if (Button(new Rect(left.x + 10, left.yMax - 52, rail - 20, 36), "Chat.Blocked")) new ChatPeopleUi().ActivateGui(GuiActivateType.Stack);

            var current = RankChat.Channels.FirstOrDefault(c => (string)c["id"] == RankChat.Channel);
            GUI.Label(new Rect(right.x, right.y + 2, right.width - 116, 36), RankChat.Channel == "general" ? L.T("Chat.General") : RankClient.Safe((string)current?["name"]), title);
            bool showSearch = searching || RankChat.SearchMode;
            if (Button(new Rect(right.xMax - 106, right.y, 106, 34), RankChat.Connected ? showSearch ? "Chat.CloseSearch" : "Chat.Search" : "Chat.Connect", !RankChat.Connecting)) {
                if (RankChat.Connected) { searching = !showSearch; if (!searching && RankChat.SearchMode) Latest(); } else RankClient.OpenChat();
            }
            string status = RankChat.Status.Length > 0 ? L.T(RankChat.Status) : L.T("Chat.Connected");
            GUI.Label(new Rect(right.x, right.y + 38, right.width, 26), status, small);
            float top = right.y + 70;
            // Allocate input IDs before message rows, so receiving messages preserves keyboard focus.
            Rect input = new Rect(right.x, right.yMax - 48, right.width - 108, 44);
            GUI.SetNextControlName("RankedChatMessage");
            RankChat.Draft = GUI.TextField(input, RankChat.Draft, 600, entry);
            bool enter = Enter("RankedChatMessage");
            if (Button(new Rect(input.xMax + 10, input.y, 98, input.height), "Chat.Send", RankChat.CanSend) || (enter && RankChat.CanSend)) { RankChat.Submit(); follow = true; }
            if (enter) Event.current.Use();
            GUI.Label(new Rect(input.x, input.y - 25, 120, 23), RankChat.CharacterCount(RankChat.Draft.Trim()) + " / 300", small);
            var rightSmall = new GUIStyle(small) { alignment = TextAnchor.UpperRight };
            GUI.Label(new Rect(input.x + 125, input.y - 25, input.width - 125, 23), RankChat.Cooldown > 0 ? L.F("Chat.Cooldown", RankChat.Cooldown) : L.T("Chat.Enter"), rightSmall);
            if (Button(new Rect(right.xMax - 98, input.y - 28, 98, 24), "Chat.Info")) new ChatPeopleUi(info: true).ActivateGui(GuiActivateType.Stack);
            if (showSearch) {
                GUI.SetNextControlName("RankedChatSearch");
                RankChat.SearchText = GUI.TextField(new Rect(right.x, top, right.width - 108, 36), RankChat.SearchText, 100, entry);
                bool searchEnter = Enter("RankedChatSearch");
                if (Button(new Rect(right.xMax - 98, top, 98, 36), "Chat.Search", RankChat.CanSearch) || (searchEnter && RankChat.CanSearch)) { follow = true; RankChat.Search(); }
                if (searchEnter) Event.current.Use();
                top += 44;
            }
            if (Button(new Rect(right.x, top, 220, 30), RankChat.SearchMode ? "Chat.SearchOlder" : "Chat.Older",
                RankChat.Connected && (RankChat.SearchMode ? RankChat.SearchBefore != null && RankChat.CanSearch : RankChat.Messages.Count > 0))) {
                follow = false; pendingAnchor = contentHeight; if (RankChat.SearchMode) { pendingAnchor = 0; RankChat.Search(true); } else RankChat.Older();
            }
            if (RankChat.SearchMode) GUI.Label(new Rect(right.x + 230, top + 4, Math.Max(50, right.width - 340), 26), L.F("Chat.Found", RankChat.Messages.Count), small);
            if (Button(new Rect(right.xMax - 98, top, 98, 30), "Chat.Latest", RankChat.Connected && !RankChat.Sending && !RankChat.Searching)) Latest();
            top += 40;
            Rect log = new Rect(right.x, top, right.width, Math.Max(110, input.y - 36 - top));
            GUI.Box(log, GUIContent.none, panel);
            float width = log.width - 42, y = 12;
            var messages = RankChat.Messages.Where(m => !RankClient.Settings.ChatBlocked.Contains((string)m["owner"])).ToArray();
            var heights = messages.Select(m => Math.Max(28, body.CalcHeight(new GUIContent(Message(m)), Math.Max(80, width))) + 46).ToArray();
            contentHeight = 24 + heights.Sum();
            if (channel != RankChat.Channel) { channel = RankChat.Channel; follow = true; }
            if (seen != RankChat.ChangeCounter) {
                if (pendingAnchor > 0) { scroll.y += Math.Max(0, contentHeight - pendingAnchor); pendingAnchor = 0; }
                else if (follow) scroll.y = Math.Max(0, contentHeight - log.height);
                seen = RankChat.ChangeCounter;
            }
            if (follow && previousHeight != log.height) scroll.y = Math.Max(0, contentHeight - log.height);
            previousHeight = log.height;
            Vector2 oldScroll = scroll;
            scroll = GUI.BeginScrollView(log, scroll, new Rect(0, 0, log.width - 20, Math.Max(contentHeight, log.height - 1)), false, false);
            if (messages.Length == 0) GUI.Label(new Rect(20, 30, width - 16, 75), L.T(RankChat.SearchMode ? "Chat.NoResults" : "Chat.Empty"), small);
            for (int i = 0; i < messages.Length; i++) {
                if (y + heights[i] < scroll.y || y > scroll.y + log.height) { y += heights[i]; continue; }
                var m = messages[i]; string owner = (string)m["owner"], nick = RankClient.Safe((string)m["name"]);
                var nickStyle = new GUIStyle(name); nickStyle.normal.textColor = NicknameColor.Read((string)m["nicknameColor"], new Color(.72f, .88f, .94f));
                Rect nickRect = new Rect(14, y, Math.Max(80, width - 155), 27);
                GUI.Label(nickRect, nick, nickStyle);
                if (owner != "administrator" && owner != RankClient.Text(RankClient.Me, "id") && GUI.Button(nickRect, GUIContent.none, GUIStyle.none)) new ChatPeopleUi(owner, nick).ActivateGui(GuiActivateType.Stack);
                string time = DateTimeOffset.FromUnixTimeSeconds((long)m["created"]).ToLocalTime().ToString("MM-dd HH:mm");
                GUI.Label(new Rect(width - 140, y + 3, 154, 23), time, rightSmall);
                GUI.Label(new Rect(14, y + 29, width, heights[i] - 46), Message(m), body);
                y += heights[i]; GUI.Box(new Rect(14, y - 7, width, 1), GUIContent.none, separator);
            }
            GUI.EndScrollView();
            if (scroll.y != oldScroll.y) follow = scroll.y >= Math.Max(0, contentHeight - log.height) - 12;
        }
        static string Message(JToken m) => m["hidden"]?.Value<bool>() == true ? L.T("Chat.Hidden") : RankClient.Safe((string)m["body"]);
    }
    sealed class ChatPeopleUi : ConsoleUi<object>
    {
        readonly string owner, nick;
        readonly bool info;
        public ChatPeopleUi(string owner = null, string nick = null, bool info = false) : base(new object()) { this.owner = owner; this.nick = nick; this.info = info; }
        public override void SetGuiSettings() { base.SetGuiSettings(); GuiSettings.PausesPlay = !RankBattle.Running; GuiSettings.AllowSidebars = false; }
        protected override ConsoleWindow BuildInterface(string suggestedName = "") {
            var w = NewWindow(0, nick ?? L.T(info ? "Chat.Info" : "Chat.Blocked"), WindowSizing.GetSizeCentral(.45f, .45f));
            w.DisplayTextPrompt = false; w.DisplayStoreForLaterButton = false;
            if (info) w.Screen.CreateStandardSegment().AddInterpretter(StringDisplay.Quick(L.T("Chat.Stored")));
            else if (owner != null) w.Screen.CreateStandardSegment().AddInterpretter(Button.Quick(L.T("Chat.Block"), L.T("Chat.Block"), () => { RankClient.ToggleChatBlock(owner, nick); DeactivateGui(); }));
            else {
                int i = 0;
                foreach (string id in RankClient.Settings.ChatBlocked.ToArray()) {
                    string label = RankClient.Settings.ChatBlockedNames.TryGetValue(id, out var saved) ? RankClient.Safe(saved) : L.F("Chat.BlockedUser", ++i);
                    w.Screen.CreateStandardSegment().AddInterpretter(Button.Quick(label + " · " + L.T("Chat.Unblock"), L.T("Chat.Unblock"), () => { RankClient.ToggleChatBlock(id); TriggerRebuild(); }));
                }
                if (RankClient.Settings.ChatBlocked.Count == 0) w.Screen.CreateStandardSegment().AddInterpretter(StringDisplay.Quick(L.T("Chat.NoneBlocked")));
            }
            w.Screen.CreateStandardSegment().AddInterpretter(Button.Quick(L.T("Chat.Close"), L.T("Chat.Close"), () => DeactivateGui()));
            return w;
        }
    }
}
