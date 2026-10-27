using System;
using System.IO;
using FtdRank;
using Newtonsoft.Json.Linq;
class Program
{
    static void Require(bool ok, string message) { if (!ok) throw new Exception(message); }
    static void Main(string[] args)
    {
        if (args.Length == 2 && args[0] == "--bp") { Console.WriteLine(BlueprintBlocks.Inspect(File.ReadAllText(args[1])).ToString(Newtonsoft.Json.Formatting.None)); return; }
        var cases = JArray.Parse(File.ReadAllText(args[0]));
        foreach (var f in cases)
        {
            JObject report = null; bool failed = false;
            try { report = BlueprintBlocks.Inspect(f["document"].ToString()); } catch (InvalidOperationException) { failed = true; }
            Require(failed == ((bool?)f["invalid"] == true), (string)f["name"]);
            if (!failed) Require(JToken.DeepEquals(report["counts"], f["counts"]) && (int)report["blockCount"] == (int)f["blockCount"] && (int)report["constructCount"] == (int)f["constructCount"], "Counts: " + f["name"]);
        }
        var rules = JObject.Parse("{bannedBlocks:[{guid:'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',name:'Banned'}]}");
        BlueprintBlocks.Check(cases[1]["document"].ToString(), rules, "Unused dictionary");
        bool rejected = false;
        foreach (var language in new[] { "en", "ko", "ja" })
        {
            L.Select(language);
            rejected = false;
            try { BlueprintBlocks.Check(cases[0]["document"].ToString(), rules, "Nested"); }
            catch (InvalidOperationException e) { rejected = e.Message.Contains("Nested") && e.Message.Contains("Banned 2"); }
            Require(rejected, "Nested ban must identify blueprint, block and count in " + language);
        }
        L.Select("en");
        var deep = (JObject)cases[2]["document"].DeepClone(); var leaf = (JObject)deep["Blueprint"];
        for (int i = 0; i < 64; i++) { var child = new JObject { ["BlockIds"] = new JArray(998) }; leaf["SCs"] = new JArray(child); leaf = child; }
        Require((int)BlueprintBlocks.Inspect(deep.ToString())["constructCount"] == 65, "64 nested levels must be accepted");
        leaf["SCs"] = new JArray(new JObject { ["BlockIds"] = new JArray(998) });
        rejected = false; try { BlueprintBlocks.Inspect(deep.ToString()); } catch (InvalidOperationException) { rejected = true; }
        Require(rejected, "65 nested levels must be rejected");
        Console.WriteLine("PASS: " + cases.Count + " shared inspection fixtures and local nested-ban preflight.");
    }
}
