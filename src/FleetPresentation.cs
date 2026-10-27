using System;
using System.Linq;
using System.Text;
using System.Text.RegularExpressions;
using Newtonsoft.Json.Linq;

namespace FtdRank
{
    public static class FleetPresentation
    {
        public static string DefaultName => L.T("내 함대 / My fleet");
        public static string Name(JToken fleet) => (string)fleet?["name"] ?? DefaultName;
        public static JObject ForMatch(JObject ticket, JObject entry) => ticket?["ownerFleet"] as JObject ?? entry?["fleet"] as JObject;
        public static string CheckedName(string value)
        {
            string name = (value ?? "").Normalize(NormalizationForm.FormKC).Trim();
            int length = 0;
            for (int i = 0; i < name.Length; i++, length++)
                if (char.IsHighSurrogate(name[i]) && i + 1 < name.Length && char.IsLowSurrogate(name[i + 1])) i++;
            if (length < 1 || length > 40 || Regex.IsMatch(name, @"[\x00-\x1f\x7f]"))
                throw new InvalidOperationException(L.T("함대 이름: 1~40자 / Fleet name: 1–40 characters."));
            return name;
        }
        public static string Composition(JObject fleet)
        {
            var units = fleet?["units"] as JArray;
            return units == null ? "" : string.Join(" · ", units.GroupBy(u => (string)u["hash"]).Select(g => ((string)g.First()["name"] ?? "BP") + " ×" + g.Count()));
        }
    }
}
