using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Text.RegularExpressions;
using Newtonsoft.Json;

namespace FtdRank
{
    // Private to this mod. Never changes Loc, the game profile, or thread culture.
    public static class L
    {
        static readonly Dictionary<string, Dictionary<string, string>> catalog = Load();
        static readonly Regex updateRequired = new Regex(@"\A모드 업데이트가 필요합니다\. 서버 최소 버전: (?<version>[0-9]{1,5}\.[0-9]{1,5}\.[0-9]{1,5}) / 통신 규격: (?<protocol>[0-9]{1,5})\z", RegexOptions.CultureInvariant);
        public static string Language { get; private set; } = "en";
        public static string Normalize(string language) => language == "ko" || language == "ja" ? language : "en";
        public static void Select(string language) => Language = Normalize(language);
        static Dictionary<string, Dictionary<string, string>> Load()
        {
            using (var stream = typeof(L).Assembly.GetManifestResourceStream("FtdRank.Languages.json"))
            using (var reader = new StreamReader(stream))
                return JsonConvert.DeserializeObject<Dictionary<string, Dictionary<string, string>>>(reader.ReadToEnd());
        }
        public static string T(string key) => catalog.TryGetValue(key, out var entry) ? entry[Language] : key;
        public static string F(string key, params object[] args) => string.Format(CultureInfo.InvariantCulture, T(key), args);
        // A status may have been produced before the language button was pressed.
        // Translate known messages and the exact version-policy error format.
        // Keep the original status so switching flags also updates a displayed error.
        // Player and server names never enter this path.
        public static string Message(string message)
        {
            if (string.IsNullOrEmpty(message)) return message ?? "";
            if (catalog.ContainsKey(message)) return T(message);
            var update = updateRequired.Match(message);
            if (update.Success) return F("Client.UpdateRequired", update.Groups["version"].Value, update.Groups["protocol"].Value);
            foreach (var entry in catalog.Values)
                if (entry.ContainsValue(message)) return entry[Language];
            return message;
        }
    }
}
