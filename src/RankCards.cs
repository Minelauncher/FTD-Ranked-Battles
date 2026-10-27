using System;
using System.Collections.Generic;
using BrilliantSkies.Ui.Consoles.Getters;
using BrilliantSkies.Ui.Consoles.Interpretters.Simple;
using BrilliantSkies.Ui.Consoles.Styles;
using BrilliantSkies.Ui.Tips;
using UnityEngine;
using Newtonsoft.Json.Linq;

namespace FtdRank
{
    public static class RankPalette
    {
        public static Color For(JToken standing)
        {
            var value = (standing as JObject)?["percentile"];
            double? p = value?.Type == JTokenType.Float || value?.Type == JTokenType.Integer ? (double?)value : null;
            if (!p.HasValue || double.IsNaN(p.Value)) return new Color(.82f, .87f, .9f);
            if (p >= 100) return new Color32(229, 204, 128, 255);
            if (p >= 99) return new Color32(245, 140, 186, 255);
            if (p >= 95) return new Color32(255, 155, 55, 255);
            if (p >= 75) return new Color32(193, 139, 255, 255);
            if (p >= 50) return new Color32(92, 169, 255, 255);
            if (p >= 25) return new Color32(91, 219, 86, 255);
            return new Color32(160, 165, 172, 255);
        }
    }
    // Console interpretters retain the game's scrolling, clipping and UI scale.
    public sealed class RankText : NoSubjectAbstract
    {
        readonly string text;
        readonly int size;
        readonly bool bold;
        GUIStyle style;
        public RankText(string text, int size = 15, bool bold = false, string tip = "")
            : base(M.m(text), M.m<BrilliantSkies.Core.IToolTip>(new ToolTip(tip))) { this.text = text; this.size = size; this.bold = bold; }
        public override string GetKeyString(string key) => "";
        protected override bool ProcessInputOnceKeyFound(List<string> words, bool apply, ref string outcome) => false;
        public override Vector2 EstimateRectRequired() => new Vector2(600, size + 10);
        public override void Draw(SO_BuiltUi styles)
        {
            if (style == null) style = RankCard.TextStyle(styles, size, bold);
            GUILayout.Label(text, style, GUILayout.ExpandWidth(true));
        }
    }

    public sealed class RankCard : NoSubjectAbstract
    {
        public readonly string Title, Meta, Detail, Value;
        public readonly bool Selected;
        readonly Color accent;
        readonly Action action;
        readonly Func<bool> enabled;
        readonly int valueSize;
        readonly int titleSize, metaSize, detailSize;
        readonly bool tintText;
        readonly bool richTitle;
        GUIStyle titleStyle, metaStyle, detailStyle, valueStyle;
        float lastWidth = 640;
        public RankCard(string title, string meta = "", string detail = "", string value = "",
            Color? accent = null, bool selected = false, Action action = null, Func<bool> enabled = null, int valueSize = 26, bool tintText = false, bool richTitle = false,
            int titleSize = 22, int metaSize = 13, int detailSize = 15)
            : base(M.m(title), M.m<BrilliantSkies.Core.IToolTip>(new ToolTip(action == null ? "" : L.T("대회 선택 / Select event"))))
        {
            Title = title; Meta = meta ?? ""; Detail = detail ?? ""; Value = value ?? "";
            this.accent = accent ?? new Color(.38f, .72f, .82f); Selected = selected;
            this.action = action; this.enabled = enabled; this.valueSize = valueSize; this.tintText = tintText;
            this.richTitle = richTitle;
            this.titleSize = titleSize; this.metaSize = metaSize; this.detailSize = detailSize;
        }
        public override string GetKeyString(string key) => "";
        protected override bool ProcessInputOnceKeyFound(List<string> words, bool apply, ref string outcome) => false;
        public override Vector2 EstimateRectRequired() => new Vector2(600, 110);
        internal static GUIStyle TextStyle(SO_BuiltUi styles, int size, bool bold = false) => new GUIStyle(styles.Display.DisplayText.Style) {
            fontSize = size, fontStyle = bold ? FontStyle.Bold : FontStyle.Normal,
            alignment = TextAnchor.UpperLeft, wordWrap = true, richText = false,
            fixedHeight = 0, fixedWidth = 0, stretchWidth = true,
            padding = new RectOffset(), margin = new RectOffset(), clipping = TextClipping.Clip
        };
        static float TextHeight(GUIStyle style, string text, float width) => text.Length == 0 ? 0 : style.CalcHeight(new GUIContent(text), Math.Max(80, width));
        static void Fill(Rect rect, Color color)
        {
            Color saved = GUI.color; GUI.color = color;
            GUI.DrawTexture(rect, Texture2D.whiteTexture); GUI.color = saved;
        }
        public override void Draw(SO_BuiltUi styles)
        {
            if (titleStyle == null) {
                titleStyle = TextStyle(styles, titleSize, true); metaStyle = TextStyle(styles, metaSize);
                titleStyle.richText = richTitle;
                detailStyle = TextStyle(styles, detailSize); valueStyle = TextStyle(styles, valueSize, true);
                titleStyle.normal.textColor = tintText ? accent : new Color(.95f, .97f, 1);
                metaStyle.normal.textColor = tintText ? accent : new Color(.68f, .76f, .82f);
                detailStyle.normal.textColor = tintText ? accent : new Color(.84f, .89f, .93f);
                valueStyle.normal.textColor = accent; valueStyle.alignment = TextAnchor.UpperRight;
            }
            float inner = Math.Max(160, lastWidth - 32);
            float valueWidth = Value.Length == 0 ? 0 : Mathf.Clamp(valueStyle.CalcSize(new GUIContent(Value)).x + 12, 65, inner * .38f);
            float titleHeight = Math.Max(TextHeight(titleStyle, Title, inner - valueWidth), TextHeight(valueStyle, Value, valueWidth));
            float metaHeight = TextHeight(metaStyle, Meta, inner), detailHeight = TextHeight(detailStyle, Detail, inner);
            float height = 28 + titleHeight + (metaHeight > 0 ? metaHeight + 7 : 0) + (detailHeight > 0 ? detailHeight + 9 : 0);
            Rect panel = GUILayoutUtility.GetRect(100, height, GUILayout.ExpandWidth(true));
            if (panel.width > 100) lastWidth = panel.width;
            bool canSelect = action != null && !RankClient.Busy && (enabled == null || enabled());
            if (Event.current.type == EventType.Repaint) {
                bool hover = canSelect && panel.Contains(Event.current.mousePosition);
                Fill(panel, Selected ? new Color(.12f, .23f, .29f, .97f) : hover ? new Color(.12f, .20f, .26f, .97f) : new Color(.065f, .105f, .15f, .96f));
                Fill(new Rect(panel.x, panel.y, 3, panel.height), accent);
                Fill(new Rect(panel.x + 3, panel.yMax - 1, panel.width - 3, 1), new Color(.25f, .36f, .43f));
                if (Selected) Fill(new Rect(panel.x, panel.y, panel.width, 1), accent);
                float width = Math.Max(160, panel.width - 32), y = panel.y + 14;
                GUI.Label(new Rect(panel.x + 16, y, width - valueWidth, titleHeight), Title, titleStyle);
                if (Value.Length > 0) GUI.Label(new Rect(panel.xMax - 16 - valueWidth, y, valueWidth, titleHeight), Value, valueStyle);
                y += titleHeight;
                if (metaHeight > 0) { y += 7; GUI.Label(new Rect(panel.x + 16, y, width, metaHeight), Meta, metaStyle); y += metaHeight; }
                if (detailHeight > 0) { y += 9; GUI.Label(new Rect(panel.x + 16, y, width, detailHeight), Detail, detailStyle); }
            }
            if (action != null) {
                bool saved = GUI.enabled;
                GUI.enabled = saved && canSelect;
                bool clicked = GUI.Button(panel, new GUIContent("", L.T("대회 선택 / Select event")), GUIStyle.none);
                GUI.enabled = saved;
                if (clicked) action();
            }
        }
    }
}
