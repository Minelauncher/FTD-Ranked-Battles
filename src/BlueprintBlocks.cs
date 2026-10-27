using System;
using System.Collections.Generic;
using System.Linq;
using System.IO;
using System.Text.RegularExpressions;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;

namespace FtdRank
{
    // Raw file GUIDs are stable across per-installation runtime block numbering.
    // This is a local preflight; the server independently inspects every submission.
    public static class BlueprintBlocks
    {
        static readonly Regex GuidPattern = new Regex(@"^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$", RegexOptions.IgnoreCase);
        static InvalidOperationException Invalid(string reason) => new InvalidOperationException(L.T("BP 블록 검사 실패: ") + reason + L.T(" 게임에서 다시 저장한 BP를 사용하세요."));
        static void Canonical(JObject value, params string[] names)
        {
            if (value.Properties().Any(p => names.Any(n => string.Equals(n, p.Name, StringComparison.OrdinalIgnoreCase) && n != p.Name)))
                throw Invalid(L.T("모호한 필드가 있습니다."));
        }
        public static JObject Inspect(string text)
        {
            JObject document;
            try
            {
                using (var reader = new JsonTextReader(new StringReader(text)) { MaxDepth = 256, DateParseHandling = DateParseHandling.None })
                {
                    document = JObject.Load(reader);
                    if (reader.Read()) throw Invalid(L.T("JSON 뒤에 추가 데이터가 있습니다."));
                }
            }
            catch (Exception) { throw Invalid(L.T("JSON을 읽을 수 없습니다.")); }
            if (!(document["Blueprint"] is JObject root) || !(document["ItemDictionary"] is JObject rawDictionary)) throw Invalid(L.T("Blueprint / ItemDictionary가 없습니다."));
            Canonical(document, "Blueprint", "ItemDictionary");
            var dictionary = new Dictionary<int, string>();
            foreach (var p in rawDictionary.Properties())
            {
                if (!int.TryParse(p.Name, out int id) || id < 0 || id.ToString(System.Globalization.CultureInfo.InvariantCulture) != p.Name || p.Value.Type != JTokenType.String || !GuidPattern.IsMatch((string)p.Value))
                    throw Invalid(L.T("블록 식별 목록이 올바르지 않습니다."));
                dictionary.Add(id, ((string)p.Value).ToLowerInvariant());
            }
            var pending = new Stack<Tuple<JObject, int>>(); pending.Push(Tuple.Create(root, 0));
            var counts = new SortedDictionary<string, int>(StringComparer.Ordinal);
            int blockCount = 0, constructCount = 0;
            while (pending.Count > 0)
            {
                var next = pending.Pop(); var bp = next.Item1;
                if (next.Item2 > 64 || ++constructCount > 4096) throw Invalid(L.T("하위 BP 구조 또는 깊이가 지원 범위를 벗어났습니다."));
                Canonical(bp, "BlockIds", "SCs");
                if (!(bp["BlockIds"] is JArray ids) || (bp["SCs"] != null && bp["SCs"].Type != JTokenType.Null && !(bp["SCs"] is JArray))) throw Invalid(L.T("BlockIds / SCs 구조가 올바르지 않습니다."));
                if ((blockCount += ids.Count) > 1000000) throw Invalid(L.T("블록 수가 검사 한도를 초과했습니다."));
                foreach (var token in ids)
                {
                    if (token.Type != JTokenType.Integer || (long)token < 0 || (long)token > int.MaxValue || !dictionary.TryGetValue((int)token, out string guid)) throw Invalid(L.T("식별할 수 없는 블록 번호가 있습니다."));
                    counts[guid] = counts.TryGetValue(guid, out int count) ? count + 1 : 1;
                }
                if (counts.Count > 4096) throw Invalid(L.T("블록 종류가 검사 한도를 초과했습니다."));
                foreach (var child in (bp["SCs"] as JArray ?? new JArray()))
                {
                    if (!(child is JObject sub)) throw Invalid(L.T("하위 BP 구조가 올바르지 않습니다."));
                    pending.Push(Tuple.Create(sub, next.Item2 + 1));
                }
            }
            if (blockCount == 0) throw Invalid(L.T("배치된 블록이 없습니다."));
            return new JObject { ["version"] = 1, ["blockCount"] = blockCount, ["constructCount"] = constructCount, ["counts"] = JObject.FromObject(counts) };
        }
        public static void Check(string text, JObject rules, string name)
        {
            var report = Inspect(text);
            var blocked = (rules?["bannedBlocks"] as JArray ?? new JArray()).Where(b => (int?)report["counts"]?[(string)b["guid"]] > 0).ToArray();
            if (blocked.Length > 0) throw new InvalidOperationException(L.T("금지 블록: ") + name + " / " + string.Join(", ", blocked.Select(b => (string)b["name"] + " " + report["counts"][(string)b["guid"]] + L.T("개"))));
        }
        public static string Summary(JToken rules)
        {
            var bans = rules?["bannedBlocks"] as JArray;
            return bans == null || bans.Count == 0 ? L.T("금지 블록 없음 / No banned blocks") : L.T("금지 / Banned: ") + string.Join(", ", bans.Select(b => (string)b["name"]));
        }
    }
}
