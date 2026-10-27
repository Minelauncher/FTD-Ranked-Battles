using System;
using System.IO;
using System.Linq;
using System.Collections.Generic;
using System.Threading.Tasks;
using FtdRank;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;

class Program
{
    static void Require(bool condition, string message) { if (!condition) throw new Exception(message); }
    static async Task Main(string[] args)
    {
        if (args.Length == 1 && args[0] == "--result-wire") { await ResultWireProbe.Run(); return; }
        if (args.Length != 3 || !Uri.TryCreate(args[0], UriKind.Absolute, out var uri) || !uri.IsLoopback)
            throw new ArgumentException("Run only against an isolated local fixture: <url> <own.blueprint> <opponent.blueprint>");
        string server = args[0].TrimEnd('/');
        var form = new AccountForm { Mode = "register", Username = "ui_test1", Nickname = "시험 비행사", Password = "short", Confirm = "short" };
        Require(form.ValidationError() != null && form.Password == "short" && form.Confirm == "short", "Invalid registration must keep entered fields");
        form.Password = "valid-password-2026";
        Require(form.ValidationError() != null, "Mismatched confirmation accepted");
        form.Confirm = form.Password; Require(form.ValidationError() == null, "Valid registration rejected");
        foreach (int length in new[] { 7, 8, 32, 33 })
        {
            bool valid = length >= 8 && length <= 32;
            form.Username = new string('u', length);
            Require((form.ValidationError() == null) == valid, "Username boundary differs");
            form.Username = "ui_test1";
            foreach (string symbol in new[] { "a", "🚀" })
            {
                form.Password = form.Confirm = string.Concat(Enumerable.Repeat(symbol, length));
                Require((form.ValidationError() == null) == valid, "Password code point boundary differs");
            }
            form.Password = form.Confirm = "valid-password-2026";
        }
        form.Mode = "password"; form.NewPassword = form.Confirm = "change88";
        Require(form.ValidationError() == null, "Eight-character password change rejected");
        form.NewPassword = form.Confirm = new string('p', 33);
        Require(form.ValidationError() != null, "Overlong password change accepted");
        form.Mode = "login"; form.Username = "short";
        Require(form.ValidationError() != null, "Short username exception remains");
        form.Username = "ui_test1"; form.Password = new string('p', 33);
        Require(form.ValidationError() != null, "Overlong login exception remains");
        form.Mode = "login"; form.Password = ""; Require(form.ValidationError() != null, "Empty login accepted");
        Console.WriteLine("PASS: registration validation preserves input and handles confirmation and Unicode length.");
        var health = await RankTransport.Request(server, null, "GET", "/health");
        bool objects = health["capabilities"] is JArray capabilities && capabilities.Values<string>().Contains("blueprint-objects-v1");
        Require(objects, "Cloudflare object transport must be advertised");
        var boundary = await RankTransport.Request(server, null, "POST", "/auth/register", new { username = new string('u', 32), nickname = "경계 검사", password = "eight888" });
        var boundaryLogin = await RankTransport.Request(server, null, "POST", "/auth/login", new { username = new string('U', 32), password = "eight888" });
        Require((string)boundaryLogin["account"]["id"] == (string)boundary["account"]["id"], "32-character username / 8-character password login failed");
        await RankTransport.Request(server, (string)boundaryLogin["token"], "POST", "/auth/password", new { password = "eight888", newPassword = string.Concat(Enumerable.Repeat("🚀", 32)) });
        await RankTransport.Request(server, null, "POST", "/auth/login", new { username = new string('u', 32), password = string.Concat(Enumerable.Repeat("🚀", 32)) });
        Console.WriteLine("PASS: C# transport accepts 32-character username and 8–32 code point passwords.");
        var a = await RankTransport.Request(server, null, "POST", "/auth/register", new { username = "transport_a", nickname = "Alpha 조종사", password = "transport-test-password" });
        var b = await RankTransport.Request(server, null, "POST", "/auth/register", new { username = "transport_b", nickname = "Bravo 조종사", password = "transport-test-password" });
        string ta = a["token"].Value<string>(), tb = b["token"].Value<string>();
        string own = JObject.Parse(File.ReadAllText(args[1])).ToString(Formatting.None);
        string opponent = JObject.Parse(File.ReadAllText(args[2])).ToString(Formatting.None);
        // Transport fixtures use declared costs; the in-game probe separately checks native FTD costs.
        int revision = (int)(await RankTransport.Request(server, ta, "GET", "/tournaments/standard-100k"))["tournament"]["revision"];
        var bpA = await RankTransport.UploadFleetBlueprint(server, ta, own, 20000);
        var bpB = await RankTransport.UploadFleetBlueprint(server, ta, opponent, 10000);
        await RankTransport.UploadFleetBlueprint(server, tb, opponent, 10000);
        Func<string, JObject> unit = h => new JObject { ["hash"] = h, ["x"] = 0, ["z"] = 0, ["altitude"] = 0, ["yaw"] = 0 };
        var units = new JArray(unit(bpA["blueprint"]["hash"].Value<string>()), unit(bpB["blueprint"]["hash"].Value<string>()), unit(bpB["blueprint"]["hash"].Value<string>()));
        FleetPlan.Grid(units, 2, 120, 150);
        Require(units[0]["x"].Value<double>() == 60 && units[1]["x"].Value<double>() == -60 && units[2]["x"].Value<double>() == 0 && units[2]["z"].Value<double>() == -150, "Native grid ordering/last-row centering differs");
        var submitted = await RankTransport.Request(server, ta, "PUT", "/tournaments/standard-100k/entry", new { revision, fleetName = "테스트 항공 편대", units });
        Require(submitted["entry"]["fleet"]["spawnCost"].Value<double>() == 40000 && submitted["entry"]["fleet"]["supply"].Value<double>() == 60000, "Fleet budget is not spawn plus supply");
        units[0]["x"] = 135; units[0]["altitude"] = 40; units[0]["yaw"] = 90;
        var moved = await RankTransport.Request(server, ta, "PUT", "/tournaments/standard-100k/entry", new { revision, units });
        Require(JToken.DeepEquals(moved["entry"]["replaceAt"], submitted["entry"]["replaceAt"])
            && JToken.DeepEquals(moved["entry"]["compositionUpdated"], submitted["entry"]["compositionUpdated"]), "Formation edit restarted composition cooldown");
        foreach (var changed in new[] { new JArray(units.Take(2)), new JArray(units.Select(_ => unit(bpB["blueprint"]["hash"].Value<string>()))) })
        {
            bool cooldown = false;
            try { await RankTransport.Request(server, ta, "PUT", "/tournaments/standard-100k/entry", new { revision, units = changed }); }
            catch (RankApiException e) { cooldown = e.StatusCode == 409; }
            Require(cooldown, "BP or quantity replacement must be rejected during cooldown");
        }
        await RankTransport.Request(server, tb, "PUT", "/tournaments/standard-100k/entry", new { revision, units = new JArray(unit(bpB["blueprint"]["hash"].Value<string>())) });
        var fm = await RankTransport.Request(server, ta, "POST", "/tournaments/standard-100k/matches", new { });
        var metadata = await RankTransport.LoadAccount(server, ta, false, "standard-100k");
        Require(metadata["pending"]["blueprints"] == null, "Metadata refresh downloaded BPs");
        var altered = (JObject)fm.DeepClone();
        altered["ownerFleet"]["units"][0]["hash"] = new string('0',64);
        bool rejected = false;
        try { await RankTransport.LoadTicket(server, ta, altered); }
        catch (Exception e) when (e is RankApiException || e is InvalidOperationException) { rejected=true; }
        Require(rejected, "Tampered BP reference accepted");
        var progress = new List<BlueprintDownloadProgress>();
        var hydrated = await RankTransport.LoadTicket(server, ta, fm, p => progress.Add(p));
        Require((string)hydrated["ownerFleet"]["name"] == "테스트 항공 편대", "Formation update or matching lost fleet name");
        Require(progress.Count > 4 && progress.All(p => p.Total == 2), "Download count must use unique BP files");
        Require(progress[0].Completed == 0 && progress[^1].Completed == 2, "Download start/completion missing");
        Require(progress.Any(p => p.Received > 0 && p.Length > 0 && p.Completed < p.Total), "Byte progress missing");
        Require(progress.Any(p => p.Verifying), "Checksum verification progress missing");
        Require(progress.Zip(progress.Skip(1),(a,b)=>b.Completed>=a.Completed).All(x=>x), "Completed file count decreased");
        Console.WriteLine("PASS: named fleet snapshot and unique BP download count, streamed byte progress, verification and completion.");
        Require(((JObject)hydrated["blueprints"]).Count == 2, "Repeated BP should download once across both fleets");
        Require(hydrated["blueprints"][bpA["blueprint"]["hash"].Value<string>()].Value<string>() == own, "Fleet BP bytes changed");
        Require(hydrated["ownerFleet"]["units"][2]["z"].Value<double>() == -150, "Formation changed in transport");
        Require(hydrated["ownerFleet"]["units"][0]["x"].Value<double>() == 135
            && hydrated["ownerFleet"]["units"][0]["altitude"].Value<double>() == 40
            && hydrated["ownerFleet"]["units"][0]["yaw"].Value<double>() == 90, "Immediate formation edit missing from battle snapshot");
        Console.WriteLine("PASS: immediate formation edit, preserved cooldown, BP/quantity rejection, edited formation in battle snapshot.");
        var resumed = await RankTransport.LoadAccount(server, ta, true, "standard-100k");
        Require(resumed["pending"]["blueprints"] != null, "Fleet recovery must hydrate every BP");
        Require((string)fm["resultPolicy"] == BattleOutcome.Policy, "Missing judgment policy");
        var judged = BattleOutcome.Decide(true, true, false, false, .65, .6, (double)fm["duration"]);
        var receipts2 = await Task.WhenAll(Enumerable.Range(0, 6).Select(_ => RankTransport.Request(server, ta, "POST", "/matches/" + fm["id"] + "/result", judged)));
        Require(receipts2.All(r => JToken.DeepEquals(r, receipts2[0])), "Fleet receipt differs on retry");
        var conflicting = BattleOutcome.Decide(true, false, true, false, 0, 1, 1);
        var recovered = await RankTransport.SubmitMatchResult(server, ta, (string)fm["id"], false, conflicting);
        Require(JToken.DeepEquals(recovered, receipts2[0]), "Conflicting offline result did not recover the existing server receipt");
        // JS serializes whole-valued numbers as integers; compare values rather than JToken numeric storage types.
        Action<JToken> sameOutcome = actual => {
            var wanted = judged["outcome"];
            Require((string)actual["kind"] == (string)wanted["kind"] && (double)actual["seconds"] == (double)wanted["seconds"], "Outcome kind/time changed");
            for (int i = 0; i < 2; i++) Require((double)actual["remaining"][i] == (double)wanted["remaining"][i]
                && (bool)actual["eliminated"][i] == (bool)wanted["eliminated"][i], "Outcome health/elimination changed");
        };
        sameOutcome(receipts2[0]["outcome"]);
        Require(BattleOutcome.Label(receipts2[0]) == "판정승", "Judgment label lost in transport");
        sameOutcome((await RankTransport.LoadAccount(server, ta, true, "standard-100k"))["history"][0]["outcome"]);
        Require((await RankTransport.LoadAccount(server, tb, true, "standard-100k"))["rating"]["games"].Value<int>() == 1, "Fleet opponent result missing");
        Console.WriteLine("PASS: actual fleet C# upload, multi-BP download/deduplication, formation ordering, 100k budget, recovery and settlement.");
        Require(a["recoveryCode"] == null, "Registration must not issue recovery codes");
        var reset = await RankTransport.Request(server, ta, "POST", "/auth/password", new { password = "transport-test-password", newPassword = "replacement-password" });
        bool revoked = false;
        try { await RankTransport.LoadAccount(server, ta, false); } catch (RankApiException e) { revoked = e.StatusCode == 401; }
        Require(revoked, "Password change did not revoke previous session");
        var login = await RankTransport.Request(server, null, "POST", "/auth/login", new { username = "TRANSPORT_A", password = "replacement-password" });
        var authMe = await RankTransport.LoadAccount(server, (string)login["token"], false, "standard-100k");
        Require((string)authMe["account"]["id"] == (string)a["account"]["id"] && (int)authMe["rating"]["games"] == 1, "Password change changed account ledger");
        Require((await RankTransport.Request(server, (string)login["token"], "GET", "/tournaments/standard-100k"))["entry"]["fleet"]["units"].Count() == 3, "Password change lost formation");
        string activeToken = (string)login["token"];
        var abandoned = await RankTransport.Request(server, activeToken, "POST", "/tournaments/standard-100k/matches", new { });
        Require((double)abandoned["expiresAt"] == (double)abandoned["created"] + 1800, "Missing server submission deadline");
        var reloaded = await RankTransport.LoadAccount(server, activeToken, false);
        Require((string)reloaded["pending"]["id"] == (string)abandoned["id"] &&
            (double)reloaded["pending"]["expiresAt"] == (double)abandoned["expiresAt"], "Reconnect changed the match or deadline");
        var lost = await RankTransport.Request(server, activeToken, "POST", "/matches/" + abandoned["id"] + "/cancel", new { });
        Require((double)lost["score"] == 0 && (int)lost["games"] == 2 && BattleOutcome.Label(lost) == "항복패", "Surrender did not settle a loss");
        var late = await RankTransport.Request(server, activeToken, "POST", "/matches/" + abandoned["id"] + "/result", judged);
        Require(JToken.DeepEquals(late, lost), "A queued result overwrote the authoritative forfeit");
        Console.WriteLine("PASS: actual C# reconnect preserves deadline, surrender loses once, queued result receives authoritative receipt.");
        await RankTransport.Request(server, (string)login["token"], "POST", "/auth/logout", new { });
        var restoredLogin = await RankTransport.Request(server, null, "POST", "/auth/login", new { username = "transport_a", password = "replacement-password" });
        var restoredFleet = (await RankTransport.Request(server, (string)restoredLogin["token"], "GET", "/tournaments/standard-100k"))["entry"]["fleet"]["units"] as JArray;
        Require(FleetPlan.SamePlacement(restoredFleet, units), "Sign out/in did not restore submitted BP counts, altitude and formation");
        Require(FleetPlan.SamePlacement((JArray)restoredFleet.DeepClone(), restoredFleet), "Restored fleet appears unsubmitted");
        Console.WriteLine("PASS: sign out/in restores submitted BP counts, positions, altitude and heading.");
        bool insecure = false;
        try { await RankTransport.Request("http://example.com", null, "POST", "/auth/login", new { password = "not-sent" }); }
        catch (InvalidOperationException) { insecure = true; }
        Require(insecure, "Credentials must not be transmitted over remote HTTP");
        Console.WriteLine("PASS: actual C# registration, password change, login, logout, session revocation, preserved fleet/ledger, remote HTTP rejection.");
    }
}
