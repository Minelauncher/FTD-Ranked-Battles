using System;
using System.Linq;
using System.Collections.Generic;
using BrilliantSkies.Ui.Consoles.Getters;
using BrilliantSkies.Ui.Consoles.Interpretters.Simple;
using BrilliantSkies.Ui.Consoles.Styles;
using BrilliantSkies.Ui.Tips;
using Newtonsoft.Json.Linq;
using UnityEngine;

namespace FtdRank
{
    // Drawn inside the game's console scroll view, using the same input coordinates and clipping.
    public sealed class FormationCanvas : NoSubjectAbstract
    {
        int dragging = -1, captured;
        JArray source;
        Vector2 grabOffset;
        double previewX, previewZ;
        bool moved;
        GUIStyle label, annotation;
        readonly JArray snapshot;
        readonly JObject snapshotRules;
        int previewSelected = -1;
        JArray Units => snapshot ?? RankClient.Draft;
        JObject Rules => snapshotRules ?? RankClient.Rules;
        int Selected { get => snapshot != null ? previewSelected : RankClient.SelectedUnit; set { if (snapshot != null) previewSelected = value; else RankClient.SelectedUnit = value; } }
        float Height => snapshot != null ? 320 : 480;
        static FormationCanvas active;
        public FormationCanvas(JArray units = null, JObject rules = null) : base(M.m(L.T("진형 배치도")), M.m<BrilliantSkies.Core.IToolTip>(new ToolTip(L.T("위에서 본 기체 중심과 방향. 번호를 선택하여 확인합니다. 편집 화면에서는 드래그로 이동합니다.")))) { snapshot = units; snapshotRules = rules; }
        public override string GetKeyString(string key) => "";
        protected override bool ProcessInputOnceKeyFound(List<string> words, bool apply, ref string outcome) => false;
        public override Vector2 EstimateRectRequired() => new Vector2(600, Height);
        public static void CancelActive() { active?.Cancel(); }
        void Cancel()
        {
            if (captured != 0 && GUIUtility.hotControl == captured) GUIUtility.hotControl = 0;
            dragging = -1; captured = 0; source = null; moved = false;
            if (active == this) active = null;
        }
        FormationMap Map(Rect panel) => new FormationMap(panel.x + 65, panel.y + 55, Math.Max(1, panel.width - 130), Math.Max(1, panel.height - 113),
            RankClient.Number(Rules, "formationHalfWidth"), RankClient.Number(Rules, "formationDepth"));
        Vector2 Point(FormationMap map, JToken unit) => new Vector2((float)map.ScreenX(map.SnapX(RankClient.Number(unit, "x"), 0)),
            (float)map.ScreenY(map.SnapZ(RankClient.Number(unit, "z"), 0)));
        void HandleInput(Rect panel, int control)
        {
            Event e = Event.current; var map = Map(panel); var units = Units;
            if (dragging >= 0 && (!RankClient.CanEditFleet || !ReferenceEquals(source, units) || GUIUtility.hotControl != captured)) Cancel();
            if (dragging >= 0 && e.type == EventType.KeyDown && e.keyCode == KeyCode.Escape) { Cancel(); e.Use(); return; }
            if (e.type == EventType.MouseDown && e.button == 0 && panel.Contains(e.mousePosition) && GUIUtility.hotControl == 0)
            {
                int hit = -1; float best = 18 * 18;
                for (int i = 0; i < units.Count; i++)
                {
                    float distance = (Point(map, units[i]) - e.mousePosition).sqrMagnitude;
                    if (distance <= best) { best = distance; hit = i; }
                }
                if (hit < 0) return;
                Selected = hit;
                if (snapshot != null) { e.Use(); return; }
                if (!RankClient.CanEditFleet) { e.Use(); RankClient.RefreshUi(); return; }
                dragging = hit; source = units; captured = control; active = this; GUIUtility.hotControl = control;
                grabOffset = e.mousePosition - Point(map, units[hit]);
                previewX = RankClient.Number(units[hit], "x"); previewZ = RankClient.Number(units[hit], "z"); moved = false;
                GUI.FocusControl(""); e.Use();
            }
            else if (dragging >= 0 && e.type == EventType.MouseDrag && e.button == 0)
            {
                double step = e.alt ? 0 : e.shift ? 10 : 1;
                previewX = map.SnapX(map.WorldX(e.mousePosition.x - grabOffset.x), step);
                previewZ = map.SnapZ(map.WorldZ(e.mousePosition.y - grabOffset.y), step);
                moved = true; e.Use();
            }
            else if (dragging >= 0 && e.rawType == EventType.MouseUp && e.button == 0)
            {
                int index = dragging; bool commit = moved; double x = previewX, z = previewZ;
                Cancel(); e.Use();
                if (commit) RankClient.MoveFleetUnit(index, x, z); else RankClient.RefreshUi();
            }
        }
        static void Fill(Rect rect, Color color)
        {
            Color old = GUI.color;
            GUI.color = color; GUI.DrawTexture(rect, Texture2D.whiteTexture); GUI.color = old;
        }
        static void Line(Vector2 from, Vector2 to, Color color, float width = 1)
        {
            Matrix4x4 old = GUI.matrix; Vector2 delta = to - from;
            try
            {
                GUIUtility.RotateAroundPivot(Mathf.Atan2(delta.y, delta.x) * Mathf.Rad2Deg, from);
                Fill(new Rect(from.x, from.y - width / 2, delta.magnitude, width), color);
            }
            finally { GUI.matrix = old; }
        }
        public override void Draw(SO_BuiltUi styles)
        {
            Rect panel = GUILayoutUtility.GetRect(100, Height, GUILayout.ExpandWidth(true));
            int control = GUIUtility.GetControlID(719204, FocusType.Passive, panel);
            HandleInput(panel, control);
            if (Event.current.type != EventType.Repaint) return;
            var map = Map(panel); var units = Units;
            if (label == null) label = new GUIStyle(styles.Display.DisplayText.Style) { fontSize = 12, alignment = TextAnchor.MiddleCenter, wordWrap = false, richText = false, clipping = TextClipping.Clip };
            label.normal.textColor = UnityEngine.Color.white;
            Fill(panel, new Color(.075f, .12f, .16f));
            GUI.Label(new Rect(panel.x, panel.y + 2, panel.width, 23), L.T("↑ 적 방향 / Enemy · H: 고도 / Alt · °: 방향 / Heading"), label);
            Color grid = new Color(.24f, .36f, .42f), border = new Color(.45f, .73f, .78f);
            double step = Math.Pow(10, Math.Floor(Math.Log10(Math.Max(1, Math.Max(map.HalfWidth * 2, map.Depth) / 6))));
            if (Math.Max(map.HalfWidth * 2, map.Depth) / step > 12) step *= 5;
            for (double x = Math.Ceiling(-map.HalfWidth / step) * step; x <= map.HalfWidth; x += step)
                Line(new Vector2((float)map.ScreenX(x), (float)map.Top), new Vector2((float)map.ScreenX(x), (float)(map.Top + map.Height)), grid);
            for (double z = 0; z >= -map.Depth; z -= step)
                Line(new Vector2((float)map.Left, (float)map.ScreenY(z)), new Vector2((float)(map.Left + map.Width), (float)map.ScreenY(z)), grid);
            Vector2 tl = new Vector2((float)map.Left, (float)map.Top), br = new Vector2((float)(map.Left + map.Width), (float)(map.Top + map.Height));
            Line(tl, new Vector2(br.x, tl.y), border, 2); Line(tl, new Vector2(tl.x, br.y), border);
            Line(br, new Vector2(br.x, tl.y), border); Line(br, new Vector2(tl.x, br.y), border);
            GUI.Label(new Rect((float)map.Left, (float)map.Top - 27, (float)Math.Max(90, map.Width), 22), L.T("가로 / Width ") + (map.HalfWidth * 2).ToString("0.#") + "m", label);
            GUI.Label(new Rect(panel.x, (float)map.Top + (float)map.Height / 2 - 22, 64, 44), L.T("깊이 / Depth\n") + map.Depth.ToString("0.#") + "m", label);
            GUI.Label(new Rect((float)map.Left - 35, (float)map.Top - 4, 33, 22), "0", label);
            GUI.Label(new Rect((float)map.Left - 60, (float)(map.Top + map.Height) - 17, 58, 22), "−" + map.Depth.ToString("0.#"), label);
            // Draw the selected marker last so it remains visible in overlapping formations.
            for (int pass = 0; pass < 2; pass++) for (int i = 0; i < units.Count; i++)
            {
                bool selected = i == Selected; if (selected != (pass == 1)) continue;
                var unit = units[i]; Vector2 point = i == dragging ? new Vector2((float)map.ScreenX(previewX), (float)map.ScreenY(previewZ)) : Point(map, unit);
                Color color = selected ? new Color(1, .72f, .25f) : new Color(.3f, .77f, .9f);
                double x = RankClient.Number(unit, "x"), z = RankClient.Number(unit, "z");
                if (Math.Abs(x) > map.HalfWidth || z > 0 || z < -map.Depth) color = new Color(1, .35f, .35f);
                float angle = (float)RankClient.Number(unit, "yaw") * Mathf.Deg2Rad;
                Vector2 forward = new Vector2(Mathf.Sin(angle), -Mathf.Cos(angle)), right = new Vector2(forward.y, -forward.x);
                Vector2 tip = point + forward * 23;
                Line(point, tip, color, 2); Line(tip, tip - forward * 7 + right * 4, color, 2); Line(tip, tip - forward * 7 - right * 4, color, 2);
                Fill(new Rect(point.x - 12, point.y - 10, 24, 20), color);
                Fill(new Rect(point.x - 10, point.y - 8, 20, 16), new Color(.05f, .12f, .16f));
                GUI.Label(new Rect(point.x - 12, point.y - 10, 24, 20), (i + 1).ToString(), label);
            }
            if (annotation == null) annotation = new GUIStyle(label) { fontSize = 10, alignment = TextAnchor.MiddleLeft, padding = new RectOffset(4, 4, 0, 0), margin = new RectOffset(), fixedHeight = 0, fixedWidth = 0 };
            var occupied = new List<Rect>();
            for (int i = 0; i < units.Count; i++)
            {
                var unit = units[i];
                string text = "H" + RankClient.Number(unit, "altitude").ToString("0.#") + "m · " + RankClient.Number(unit, "yaw").ToString("0.#") + "°";
                float width = Mathf.Clamp(annotation.CalcSize(new GUIContent(text)).x, 64, 120);
                var point = i == dragging ? new Vector2((float)map.ScreenX(previewX), (float)map.ScreenY(previewZ)) : Point(map, unit); Rect tag = new Rect();
                foreach (var offset in new[] { new Vector2(24,-10), new Vector2(-width-24,-10), new Vector2(24,12), new Vector2(-width-24,12) })
                {
                    tag = new Rect(Mathf.Clamp(point.x + offset.x, panel.x + 2, panel.xMax - width - 2), Mathf.Clamp(point.y + offset.y, panel.y + 25, panel.yMax - 49), width, 16);
                    if (!occupied.Any(r => r.Overlaps(tag))) break;
                }
                occupied.Add(tag); Fill(tag, new Color(.035f,.08f,.11f,.92f));
                GUI.Label(tag, text, annotation);
            }
            string footer = "X ±" + map.HalfWidth + "m · Z " + map.Depth + L.T("m · 격자 / Grid ") + step + "m";
            if (Selected >= 0 && Selected < units.Count)
            {
                var u = units[Selected]; string name = RankClient.Text(u, "name"); if (name.Length > 24) name = name.Substring(0, 24) + "…";
                footer = (Selected + 1) + ". " + name + "  X " + (dragging >= 0 ? previewX : RankClient.Number(u, "x")).ToString("0.#") +
                    " / Z " + (dragging >= 0 ? previewZ : RankClient.Number(u, "z")).ToString("0.#") + L.T("m · 고도 / Alt ") + RankClient.Number(u, "altitude").ToString("0.#") + "m · " + RankClient.Number(u, "yaw").ToString("0.#") + "°";
            }
            GUI.Label(new Rect(panel.x + 5, panel.yMax - 26, panel.width - 10, 23), footer, label);
        }
    }
}
