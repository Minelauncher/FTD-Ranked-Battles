using System.Collections.Generic;
using System.IO;
using BrilliantSkies.Ui.Consoles.Getters;
using BrilliantSkies.Ui.Consoles.Interpretters.Simple;
using BrilliantSkies.Ui.Consoles.Styles;
using BrilliantSkies.Ui.Tips;
using UnityEngine;

namespace FtdRank
{
    public sealed class LanguageFlags : NoSubjectAbstract
    {
        public static readonly string[] Languages = { "ko", "ja", "en" };
        static readonly string[] names = { "한국어", "日本語", "English" };
        static readonly Dictionary<string, Texture2D> images = new Dictionary<string, Texture2D>();
        public LanguageFlags() : base(M.m(L.T("Language")), M.m<BrilliantSkies.Core.IToolTip>(new ToolTip(L.T("Language scope")))) { }
        public override string GetKeyString(string key) => "";
        protected override bool ProcessInputOnceKeyFound(List<string> words, bool apply, ref string outcome) => false;
        public override Vector2 EstimateRectRequired() => new Vector2(300, 64);
        public static Texture2D Flag(string language)
        {
            if (images.TryGetValue(language, out var image)) return image;
            using (var input = typeof(LanguageFlags).Assembly.GetManifestResourceStream("FtdRank.Flags." + language + ".png"))
            using (var buffer = new MemoryStream()) {
                input.CopyTo(buffer); image = new Texture2D(2, 2, TextureFormat.RGBA32, false);
                if (!ImageConversion.LoadImage(image, buffer.ToArray())) { Object.Destroy(image); return null; }
                image.wrapMode = TextureWrapMode.Clamp; images[language] = image; return image;
            }
        }
        public override void Draw(SO_BuiltUi styles)
        {
            var panel = GUILayoutUtility.GetRect(100, 64, GUILayout.ExpandWidth(true));
            for (int i = 0; i < Languages.Length; i++) {
                string language = Languages[i];
                var rect = new Rect(panel.x + i * 102, panel.y + 2, 94, 58);
                Color saved = GUI.color;
                GUI.color = L.Language == language ? new Color(1, .77f, .32f) : new Color(.3f, .4f, .47f);
                GUI.DrawTexture(rect, Texture2D.whiteTexture); GUI.color = saved;
                GUI.DrawTexture(new Rect(rect.x + 4, rect.y + 4, 86, 50), Flag(language), ScaleMode.ScaleToFit);
                if (GUI.Button(rect, new GUIContent("", names[i]), GUIStyle.none)) RankClient.SetLanguage(language);
            }
        }
    }
}
