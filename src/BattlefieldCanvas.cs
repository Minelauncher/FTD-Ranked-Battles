using System;
using System.IO;
using System.Collections.Generic;
using BrilliantSkies.Ui.Consoles.Getters;
using BrilliantSkies.Ui.Consoles.Interpretters.Simple;
using BrilliantSkies.Ui.Consoles.Styles;
using BrilliantSkies.Ui.Tips;
using Newtonsoft.Json.Linq;
using UnityEngine;

namespace FtdRank
{
    public sealed class BattlefieldCanvas : NoSubjectAbstract
    {
        readonly JObject rules;
        static readonly Dictionary<string, Texture2D> maps = new Dictionary<string, Texture2D>();
        GUIStyle label;
        public BattlefieldCanvas(JObject rules) : base(M.m(L.T("전장 지형 / Terrain")), M.m<BrilliantSkies.Core.IToolTip>(new ToolTip(L.T("전장 중심과 주변 지형 / Battlefield centre and nearby terrain")))) { this.rules = rules; }
        public override string GetKeyString(string key) => "";
        protected override bool ProcessInputOnceKeyFound(List<string> words, bool apply, ref string outcome) => false;
        public override Vector2 EstimateRectRequired() => new Vector2(550, 285);
        static Texture2D Map(string world)
        {
            if (maps.TryGetValue(world, out var image)) return image;
            using (var input = typeof(BattlefieldCanvas).Assembly.GetManifestResourceStream("FtdRank.Maps." + world + ".png"))
            using (var buffer = new MemoryStream())
            {
                if (input == null) return null;
                input.CopyTo(buffer); image = new Texture2D(2, 2, TextureFormat.RGBA32, false);
                if (!ImageConversion.LoadImage(image, buffer.ToArray())) { UnityEngine.Object.Destroy(image); return null; }
                image.wrapMode = TextureWrapMode.Clamp; maps[world] = image; return image;
            }
        }
        void DrawMap(Rect rect, Texture2D texture, BattlefieldView view, string title)
        {
            GUI.DrawTextureWithTexCoords(rect, texture, new Rect((float)view.Left, (float)(1 - view.Top - view.Size), (float)view.Size, (float)view.Size));
            float x = rect.x + (float)view.MarkerX * rect.width, y = rect.y + (float)view.MarkerY * rect.height;
            Color previous = GUI.color;
            GUI.color = UnityEngine.Color.black;
            GUI.DrawTexture(new Rect(Mathf.Clamp(x - 9, rect.x, rect.xMax - 18), Mathf.Clamp(y - 3, rect.y, rect.yMax - 6), 18, 6), Texture2D.whiteTexture);
            GUI.DrawTexture(new Rect(Mathf.Clamp(x - 3, rect.x, rect.xMax - 6), Mathf.Clamp(y - 9, rect.y, rect.yMax - 18), 6, 18), Texture2D.whiteTexture);
            GUI.color = new Color(1, .8f, .2f);
            GUI.DrawTexture(new Rect(Mathf.Clamp(x - 8, rect.x, rect.xMax - 16), Mathf.Clamp(y - 1, rect.y, rect.yMax - 2), 16, 2), Texture2D.whiteTexture);
            GUI.DrawTexture(new Rect(Mathf.Clamp(x - 1, rect.x, rect.xMax - 2), Mathf.Clamp(y - 8, rect.y, rect.yMax - 16), 2, 16), Texture2D.whiteTexture);
            GUI.color = previous;
            GUI.Label(new Rect(rect.x, rect.y - 23, rect.width, 22), title, label);
        }
        public override void Draw(SO_BuiltUi styles)
        {
            var panel = GUILayoutUtility.GetRect(100, 285, GUILayout.ExpandWidth(true));
            if (Event.current.type != EventType.Repaint) return;
            if (label == null) label = new GUIStyle(styles.Display.DisplayText.Style) { fontSize = 12, alignment = TextAnchor.MiddleCenter, richText = false };
            string world = BattlefieldRules.World(rules); var texture = Map(world);
            if (texture == null) { GUI.Label(panel, L.T("지도를 불러오지 못했습니다. / Map unavailable"), label); return; }
            double max = world == "aote" ? 11 : 19, east = FleetPlan.Value(rules, "boardEast"), north = FleetPlan.Value(rules, "boardNorth");
            float size = Math.Min(235, (panel.width - 35) / 2), left = panel.x + (panel.width - 2 * size - 25) / 2;
            DrawMap(new Rect(left, panel.y + 24, size, size), texture, new BattlefieldView(east, north, max, 1), L.T("전체 지도 / World · N ↑"));
            DrawMap(new Rect(left + size + 25, panel.y + 24, size, size), texture, new BattlefieldView(east, north, max, 8), L.T("전장 주변 / Battlefield · 8×"));
            GUI.Label(new Rect(panel.x, panel.yMax - 22, panel.width, 22), L.T("+ 전장 중심 / Centre · 파랑: 물 / Blue: water · 초록·갈색: 육지 / Green/brown: land"), label);
        }
    }
}
