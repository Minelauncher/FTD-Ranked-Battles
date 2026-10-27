using System;
using Newtonsoft.Json.Linq;

namespace FtdRank
{
    public static class BattlefieldRules
    {
        public static string World(JToken rules)
        {
            if (rules == null) throw new InvalidOperationException(L.T("전장 규칙이 없습니다."));
            // Compatibility only for already-issued pre-0.4.2 Neter tickets.
            var token = rules["world"];
            if (token == null) return "neter";
            if (token.Type == JTokenType.String && ((string)token == "neter" || (string)token == "aote")) return (string)token;
            throw new InvalidOperationException(L.T("지원하지 않는 전장입니다. 네터 또는 AOTE가 필요합니다."));
        }
        public static string Name(JToken rules) => World(rules) == "aote" ? "AOTE" : L.T("네터 / Neter");
        public static string Summary(JToken rules) => Name(rules) + " · E " + FleetPlan.Value(rules, "boardEast").ToString("0.###") + " / N " + FleetPlan.Value(rules, "boardNorth").ToString("0.###");
        public static void Validate(JObject rules)
        {
            int max = World(rules) == "aote" ? 11 : 19;
            double east = FleetPlan.Value(rules, "boardEast"), north = FleetPlan.Value(rules, "boardNorth");
            if (east < 0 || east > max || north < 0 || north > max) throw new InvalidOperationException(Name(rules) + L.T("의 전장 좌표 범위는 동·북 0~") + max + L.T("칸입니다."));
        }
    }
}
