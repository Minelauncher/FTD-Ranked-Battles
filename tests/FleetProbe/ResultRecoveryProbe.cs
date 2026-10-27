using System;
using System.IO;
using System.Linq;
using System.Net.Http;
using System.Threading;
using System.Threading.Tasks;
using HarmonyLib;
using FtdRank;
using Newtonsoft.Json.Linq;

// Faults are confined to the local fixture and never shipped with the mod.
static class ResultRecoveryProbe
{
    public static int Posts, Requests, RetryStates;
    public static bool Unauthorized;
    static int seenPosts;
    static bool enabled, injectNetwork;
    public static void Arm()
    {
        if (!new Uri(RankClient.Settings.Server).IsLoopback) throw new Exception("Recovery faults require a local fixture");
        if (!enabled)
        {
            new Harmony("ftdrank.test.result-recovery").Patch(AccessTools.Method(typeof(RankTransport), nameof(RankTransport.Request)),
                prefix: new HarmonyMethod(typeof(ResultRecoveryProbe), nameof(Before)),
                postfix: new HarmonyMethod(typeof(ResultRecoveryProbe), nameof(After)));
            enabled = true;
        }
        injectNetwork = true;
    }
    public static void VerifyDurableSurrender()
    {
        string file = Path.Combine(RankClient.DirectoryPath, "pending-result.json");
        File.WriteAllText(file, "{}");
        using (var held = new FileStream(file, FileMode.Open, FileAccess.Read, FileShare.Read))
        {
            RankBattle.Surrender();
            Check(RankBattle.Running && RankClient.PendingResult == null, "Failed durable save stopped the battle");
            Check(RankClient.Status == L.T("Result.SurrenderSaveFailed"), "Save failure was not explained");
        }
        File.Delete(file);
    }
    static bool Before(string method, string route, ref Task<JObject> __result, out bool __state)
    {
        __state = false;
        if (!route.StartsWith("/matches/", StringComparison.Ordinal) || route.Contains("blueprints")) return true;
        Interlocked.Increment(ref Requests);
        if (Unauthorized) { __result = Task.FromException<JObject>(new RankApiException(401, "Test expired login")); return false; }
        if (!injectNetwork || method != "POST") return true;
        int n = Interlocked.Increment(ref Posts);
        if (n == 1) { __result = Task.FromException<JObject>(new RankApiException(503, "Test unavailable")); return false; }
        if (n == 2) __state = true;
        return true;
    }
    static void After(ref Task<JObject> __result, bool __state)
    {
        if (__state) __result = LoseResponse(__result);
    }
    static async Task<JObject> LoseResponse(Task<JObject> work)
    {
        await work.ConfigureAwait(false);
        throw new HttpRequestException("Test response lost AFTER server commit");
    }
    public static void Tick()
    {
        if (!injectNetwork || RankClient.PendingResult == null || RankClient.Busy || RankClient.ResultDelivery != ResultDeliveryState.Waiting) return;
        if (Posts == seenPosts || Posts > 2) return;
        seenPosts = Posts; RetryStates++;
        Check(File.Exists(Path.Combine(RankClient.DirectoryPath, "pending-result.json")), "Retry has no durable result");
        Check(!RankClient.CanEditFleet && RankClient.AccountLocked, "Retry unlocked the fleet prematurely");
        Check(RankClient.ResultRetryIn > 0 && RankClient.ResultRetryIn <= (Posts == 1 ? 2 : 5), "Incorrect automatic retry interval");
        RankClient.RefreshUi(); RankClient.FocusTab(L.T("함대")); RankClient.Ui.UpdateMatchHeader();
        Check(RankClient.Ui.Windows.First().Name.Contains(L.T("Result.SurrenderWaiting")), "Scrolled window header hides match status");
        Check(RankClient.Ui.Windows.First().Screen.Segments.SelectMany(s => s.Interpretters).OfType<RankCard>()
            .Any(c => c.Title == L.T("Result.SurrenderWaiting") && c.Detail == L.T("Result.Locked")), "Fleet lock explanation is absent");
    }
    public static void VerifySettled()
    {
        Check(Posts == 2 && RetryStates == 2, "Expected one rejected submission and one committed submission, both automatically recovered");
        Check(RankClient.PendingResult == null && RankClient.Ticket == null && RankClient.CanEditFleet, "Recovered match remains locked");
        injectNetwork = false;
    }
    static void Check(bool ok, string message) { if (!ok) throw new Exception(message); }
}
