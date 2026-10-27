using System;
using System.IO;
using FtdRank;
using Newtonsoft.Json.Linq;

static class Program
{
    static void Check(bool condition, string message) { if (!condition) throw new Exception(message); }
    static void Reject(Action action) { try { action(); } catch (InvalidOperationException) { return; } throw new Exception("Invalid outcome accepted"); }
    static void Main()
    {
        L.Select("ko");
        var cases = JArray.Parse(File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "health-outcomes.json")));
        foreach (var c in cases)
        {
            var d = BattleOutcome.Decide((bool)c["judgment"], (bool)c["timeout"], (bool)c["gone"][0], (bool)c["gone"][1],
                (double)c["health"][0], (double)c["health"][1], (double)c["seconds"]);
            Check((double)d["score"] == (double)c["score"] && (string)d["outcome"]["kind"] == (string)c["kind"], (string)c["name"]);
            Check(JToken.DeepEquals(d, JObject.Parse(d.ToString())), "Pending result roundtrip lost evidence");
            Check(BattleOutcome.HealthSummary(d).Contains("상대"), "Missing health summary");
            if ((string)c["kind"] == "judgment") Check(BattleOutcome.Label(d) == ((double)c["score"] == 1 ? "판정승" : "판정패"), "Wrong outcome label");
        }
        Reject(() => BattleOutcome.Decide(true, false, false, false, 1, .5, 10));
        Reject(() => BattleOutcome.Decide(true, true, false, false, double.NaN, .5, 600));
        Reject(() => BattleOutcome.Decide(true, true, false, false, .5, .5, double.PositiveInfinity));
        Reject(() => BattleOutcome.UsesJudgment(JObject.Parse("{resultPolicy:'future'}")));
        Check(!BattleOutcome.UsesJudgment(new JObject()), "Legacy ticket changed");
        Check(BattleOutcome.UsesJudgment(new JObject { ["resultPolicy"] = BattleOutcome.Policy }), "New policy not enabled");
        Check(BattleOutcome.Health(1.001) == 1 && BattleOutcome.Health(-.01) == 0, "Health clamp");
        Check(BattleOutcome.Label(JObject.Parse("{score:1,outcome:{kind:'opponent-surrender'}}")) == "상대 항복 · 승리", "Opponent surrender label");
        Check(BattleOutcome.Label(JObject.Parse("{score:1,outcome:{kind:'opponent-expired'}}")) == "상대 미제출 · 승리", "Opponent expiry label");
        foreach (var c in JArray.Parse(File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "material-outcomes.json"))))
        {
            var m = c["values"];
            var d = BattleOutcome.DecideMaterials((double)c["seconds"] >= 600, (bool)c["gone"][0], (bool)c["gone"][1],
                (double)c["health"][0], (double)c["health"][1], (double)c["seconds"],
                BattleOutcome.MaterialBalance((double)m[0][0], (double)m[0][1]), BattleOutcome.MaterialBalance((double)m[1][0], (double)m[1][1]));
            Check((double)d["score"] == (double)c["score"] && (string)d["outcome"]["kind"] == (string)c["kind"], (string)c["name"]);
            Check(JToken.DeepEquals(d,JObject.Parse(d.ToString())), "Material result persistence");
            foreach (string language in new[]{"ko","en","ja"}) { L.Select(language); Check(!BattleOutcome.MaterialSummary(d).Contains("Outcome."), "Untranslated material summary"); }
        }
        Reject(()=>BattleOutcome.MaterialBalance(double.NaN,0)); Reject(()=>BattleOutcome.MaterialBalance(0,-1));
        Reject(()=>BattleOutcome.MaterialBalance(double.PositiveInfinity,0));
        Check(BattleOutcome.UsesJudgment(new JObject { ["resultPolicy"] = BattleOutcome.HealthPolicy }), "Existing health tickets changed");
        Console.WriteLine("PASS health and material policies: 13 shared cases, supply/health reversal, exact ties, precision, elimination, old tickets, persistence, translated summaries and invalid evidence.");
    }
}
