using System;
using System.Linq;
using Newtonsoft.Json.Linq;

namespace FtdRank
{
    // Shared by the game and its standalone integration tests. Tournament values
    // must come from the server; absent rules never silently become local defaults.
    public static class FleetPlan
    {
        public static double Value(JToken obj, string key)
        {
            var token = obj?[key];
            if (token == null || (token.Type != JTokenType.Integer && token.Type != JTokenType.Float)) throw new InvalidOperationException(L.T("서버 규칙/함대 값 누락: ") + key);
            double n = token.Value<double>();
            if (double.IsNaN(n) || double.IsInfinity(n)) throw new InvalidOperationException(L.T("올바르지 않은 수: ") + key);
            return n;
        }
        public static double Round(double n) => Math.Round(n, 3, MidpointRounding.AwayFromZero);
        public static double Cost(JArray units) => Round(units.Sum(u => Value(u, "cost")));
        public static double SubmittedSupply(JObject fleet, JObject rules)
        {
            var units = fleet?["units"] as JArray;
            Validate(units, rules);
            double cost = Cost(units), supply = Value(fleet, "supply");
            // Match tickets freeze the submitter's game-calculated prices. A
            // different block/mod environment must not reprice either fleet.
            if (supply < 0 || Math.Abs(cost - Value(fleet, "spawnCost")) > .001 ||
                Math.Abs(supply - Round(Value(rules, "teamBudget") - cost)) > .001)
                throw new InvalidOperationException(L.T("함대의 소환비와 보급 자원이 대회 예산과 일치하지 않습니다."));
            return supply;
        }
        public static bool SamePlacement(JArray a, JArray b)
        {
            if (a == null || b == null || a.Count != b.Count) return false;
            for (int i = 0; i < a.Count; i++)
            {
                if ((string)a[i]["hash"] != (string)b[i]["hash"]) return false;
                foreach (string key in new[] { "x", "z", "altitude", "yaw" })
                    if ((double?)a[i][key] != (double?)b[i][key]) return false;
            }
            return true;
        }
        // Editing uses copies so an invalid quantity/replacement cannot partially change a draft.
        public static JArray WithQuantity(JArray units, string hash, int count, JObject rules)
        {
            var existing = units.Where(u => (string)u["hash"] == hash).ToList();
            if (existing.Count == 0) throw new InvalidOperationException(L.T("수량을 바꿀 기체를 찾지 못했습니다."));
            int limit = (int)Math.Min(100, Value(rules, "maxUnits"));
            if (count < 0 || count > limit - units.Count + existing.Count)
                throw new InvalidOperationException(L.T("이 기체의 수량은 0~") + (limit - units.Count + existing.Count) + L.T("척까지 입력할 수 있습니다."));
            var copy = (JArray)units.DeepClone(); int keep = count;
            for (int i = 0; i < copy.Count; i++)
                if ((string)copy[i]["hash"] == hash && keep-- <= 0) copy.RemoveAt(i--);
            // Existing positions stay untouched. New copies occupy free grid points if available.
            for (int i = existing.Count; i < count; i++)
            {
                var added = (JObject)existing[0].DeepClone();
                double half = Value(rules, "formationHalfWidth"), depth = Value(rules, "formationDepth");
                int columns = half > 0 ? Math.Min(101, (int)(half * 2 / 100) + 2) : 1;
                int rows = depth > 0 ? Math.Min(101, (int)(depth / 100) + 2) : 1;
                bool found = false;
                for (int row = 0; row < rows && !found; row++)
                    for (int col = 0; col < columns && !found; col++)
                    {
                        double x = columns == 1 ? 0 : Round(-half + 2 * half * col / (columns - 1));
                        double z = rows == 1 ? 0 : Round(-depth * row / (rows - 1));
                        if (copy.Any(u => Math.Abs(Value(u, "x") - x) < 1 && Math.Abs(Value(u, "z") - z) < 1)) continue;
                        added["x"] = x; added["z"] = z; found = true;
                    }
                if (!found) { added["x"] = 0; added["z"] = 0; }
                copy.Add(added);
            }
            return copy;
        }
        public static JArray WithBlueprint(JArray units, int index, JObject blueprint, bool allOfType, JObject rules)
        {
            if (index < 0 || index >= units.Count) throw new InvalidOperationException(L.T("교체할 기체를 선택하세요."));
            var copy = (JArray)units.DeepClone(); string previous = (string)units[index]["hash"];
            for (int i = 0; i < copy.Count; i++)
                if (i == index || (allOfType && (string)copy[i]["hash"] == previous))
                    foreach (string key in new[] { "hash", "name", "cost" }) copy[i][key] = blueprint[key].DeepClone();
            if (copy.Select(u => (string)u["hash"]).Distinct().Count() > Value(rules, "maxBlueprints"))
                throw new InvalidOperationException(L.T("교체하면 BP 종류 수 제한을 초과합니다. 같은 BP 전체 교체 또는 다른 기체 제거를 사용하세요."));
            return copy;
        }
        public static void Validate(JArray units, JObject rules)
        {
            if (rules == null || units == null || units.Count < 1 || units.Count > Value(rules, "maxUnits") || units.Count > 100)
                throw new InvalidOperationException(L.T("대회의 기체 배치 수를 확인하세요."));
            if (units.Select(u => u["hash"]?.Value<string>()).Distinct().Count() > Value(rules, "maxBlueprints")) throw new InvalidOperationException(L.T("대회의 BP 종류 수 제한을 초과했습니다."));
            foreach (var u in units)
            {
                var hash = u["hash"]?.Value<string>();
                if (hash == null || hash.Length != 64 || hash.Any(c => !(c >= '0' && c <= '9') && !(c >= 'a' && c <= 'f'))) throw new InvalidOperationException(L.T("BP 해시가 올바르지 않습니다."));
                Range(u, "cost", 0, 1000000000);
                Range(u, "x", -Value(rules, "formationHalfWidth"), Value(rules, "formationHalfWidth"));
                Range(u, "z", -Value(rules, "formationDepth"), 0);
                Range(u, "altitude", Value(rules, "minAltitude"), Value(rules, "maxAltitude"));
                Range(u, "yaw", -180, 180);
            }
            if (Cost(units) > Value(rules, "teamBudget")) throw new InvalidOperationException(L.T("기체 소환비가 팀 예산을 초과했습니다."));
        }
        static void Range(JToken obj, string key, double min, double max)
        {
            double n = Value(obj, key);
            if (n < min || n > max) throw new InvalidOperationException(key + L.T(" 값이 대회 허용 범위를 벗어났습니다."));
        }
        public static void Grid(JArray units, int columns, double sideways, double backwards)
        {
            if (columns < 1 || sideways < 0 || backwards < 0 || double.IsNaN(sideways) || double.IsNaN(backwards)) throw new ArgumentOutOfRangeException();
            for (int i = 0; i < units.Count; i++)
            {
                int row = i / columns, count = Math.Min(columns, units.Count - row * columns);
                // Same ordering and centre as CustomBattleSetupTeam.SetBlueprintGlobalPositions.
                units[i]["x"] = Round(((count - 1) / 2.0 - i % columns) * sideways);
                units[i]["z"] = Round(-row * backwards);
            }
        }
    }
}
