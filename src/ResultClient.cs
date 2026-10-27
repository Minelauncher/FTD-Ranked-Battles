using System;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Net.Http;
using System.Threading.Tasks;
using Newtonsoft.Json.Linq;
using UnityEngine;

namespace FtdRank
{
    public enum ResultDeliveryState { Ready, Sending, Waiting, SignInRequired, NeedsAttention }

    public static partial class RankClient
    {
        // This clock keeps running while FTD is paused and ignores server clock corrections.
        static readonly Stopwatch resultClock = Stopwatch.StartNew();
        static readonly int[] retrySeconds = { 2, 5, 10, 30, 60 };
        static JObject trackedResult, acceptedResult;
        static bool resultDurable, recoverResultFirst;
        static int resultFailures;
        static double retryAt;
        static ResultDeliveryState delivery;
        static Action afterResult;
        static bool ResultAccountMatches => Connected && Text(PendingResult, "server") == Settings.Server && Text(PendingResult, "accountId") == Text(Me, "id");
        public static ResultDeliveryState ResultDelivery => PendingResult != null && !ResultAccountMatches ? ResultDeliveryState.SignInRequired : delivery;
        public static int ResultRetryIn => Math.Max(0, (int)Math.Ceiling(retryAt - resultClock.Elapsed.TotalSeconds));
        public static bool MatchLocked => Ticket != null || PendingResult != null || RankBattle.Running || RankBattle.Loading;

        static void TrackResult(JObject result, bool durable)
        {
            trackedResult = result; acceptedResult = null; resultDurable = durable;
            recoverResultFirst = true; resultFailures = 0; retryAt = 0;
            delivery = ResultDeliveryState.Ready; afterResult = null;
        }
        static void EnsureTrackedResult()
        {
            if (!ReferenceEquals(trackedResult, PendingResult)) TrackResult(PendingResult, false);
        }

        // A voluntary surrender must be durable before we stop the simulation.
        // A natural outcome cannot be replayed safely, so retain it in memory even if saving fails.
        public static bool QueueResult(JObject decision, bool requireDurable)
        {
            if (PendingResult != null || Ticket == null) return false;
            var pending = (JObject)decision.DeepClone();
            pending["server"] = Settings.Server; pending["accountId"] = Text(Me, "id"); pending["matchId"] = Text(Ticket, "id");
            try { Save(PendingPath, pending); }
            catch (Exception e)
            {
                if (requireDurable) { Status = L.T("Result.SurrenderSaveFailed"); RefreshUi(); return false; }
                PendingResult = pending; TrackResult(pending, false); ResultFailed(e); RefreshUi(); return true;
            }
            PendingResult = pending; TrackResult(pending, true); recoverResultFirst = false;
            return true;
        }
        public static void RecordResult(JObject decision)
        {
            if (!QueueResult(decision, false)) return;
            RankBattle.ClearTemporaryData();
            if (resultDurable) SubmitResult();
        }
        public static void SubmitResult() => SubmitPendingResult(null);
        static void SubmitPendingResult(Action after)
        {
            if (PendingResult == null || Busy || RankBattle.Running || RankBattle.Loading || !StorageReady) return;
            EnsureTrackedResult();
            if (after != null) afterResult = after;
            if (!ResultAccountMatches) { OpenResultAccount(); return; }
            var pending = PendingResult;
            try
            {
                if (!resultDurable) { Save(PendingPath, pending); resultDurable = true; }
                if (acceptedResult != null) { FinishResult(acceptedResult); RefreshUi(); return; }
                var body = new JObject { ["score"] = pending["score"].DeepClone() };
                if (pending["outcome"] != null) body["outcome"] = pending["outcome"].DeepClone();
                string server = Settings.Server, token = Token, id = Text(pending, "matchId");
                bool cancel = (bool?)pending["cancel"] == true, recover = recoverResultFirst;
                recoverResultFirst = true; delivery = ResultDeliveryState.Sending;
                Run(L.T("Result.Sending"), () => RankTransport.SubmitMatchResult(server, token, id, cancel, body, recover), r =>
                {
                    if (!ReferenceEquals(pending, PendingResult)) return;
                    if (Text(r, "matchId") != id || r["after"] == null || r["games"] == null)
                        throw new InvalidOperationException(L.T("Result.InvalidReceipt"));
                    acceptedResult = r; FinishResult(r);
                }, e => { if (ReferenceEquals(pending, PendingResult)) ResultFailed(e); });
            }
            catch (Exception e) { ResultFailed(e); RefreshUi(); }
        }
        static void FinishResult(JObject receipt)
        {
            string id = Text(PendingResult, "matchId");
            // A sync tool can lock this file. Keep the guard, cache the receipt and
            // retry local acknowledgement without submitting the rating again.
            ClientStorage.Delete(PendingPath);
            Receipt = receipt;
            if (Text(receipt, "tournamentId") == Text(Tournament, "id"))
            {
                EventRating = new JObject { ["rating"] = receipt["after"], ["games"] = receipt["games"] };
                Standing = null; Standings.Clear();
                if (!History.Any(h => Text(h, "matchId") == id)) History.Insert(0, receipt);
            }
            MatchStorage.Clear(DirectoryPath, id);
            if (Text(Ticket, "id") == id) Ticket = null; // Do not hide a newer match created on another PC.
            PendingResult = null;
            var after = afterResult; TrackResult(null, false); Status = "";
            if (after != null) after(); else Refresh();
        }
        static void ResultFailed(Exception error)
        {
            recoverResultFirst = true;
            if (error is RankApiException auth && auth.StatusCode == 401)
            {
                Connected = false; delivery = ResultDeliveryState.SignInRequired; Status = L.T("Result.SignIn"); return;
            }
            bool transient = error is HttpRequestException || error is OperationCanceledException || error is IOException || error is UnauthorizedAccessException
                || error is RankApiException api && (api.StatusCode == 408 || api.StatusCode == 429 || api.StatusCode >= 500);
            if (!transient)
            {
                delivery = ResultDeliveryState.NeedsAttention; Status = error.GetBaseException().Message; return;
            }
            retryAt = resultClock.Elapsed.TotalSeconds + retrySeconds[Math.Min(resultFailures++, retrySeconds.Length - 1)];
            delivery = ResultDeliveryState.Waiting;
            Status = ""; // The persistent notice explains the retry and lock instead of a generic failure.
        }
        static void PumpResult()
        {
            if (PendingResult == null) return;
            EnsureTrackedResult();
            if (Busy || !StorageReady || !ResultAccountMatches || RankBattle.Running || RankBattle.Loading) return;
            if (delivery == ResultDeliveryState.Ready || delivery == ResultDeliveryState.Waiting && ResultRetryIn == 0)
                SubmitPendingResult(null);
        }
        public static void OpenResultAccount() { FocusTab(L.T("계정")); RefreshUi(); }
        public static string MatchStateTitle
        {
            get
            {
                if (PendingResult != null)
                {
                    if (ResultDelivery == ResultDeliveryState.SignInRequired) return L.T("Result.SignIn");
                    if (ResultDelivery == ResultDeliveryState.NeedsAttention) return L.T("Result.Attention");
                    if (!resultDurable) return L.T("Result.SaveWaiting");
                    if (acceptedResult != null) return L.T("Result.CleanupWaiting");
                    if (ResultDelivery == ResultDeliveryState.Sending) return L.T("Result.Sending");
                    return L.T((bool?)PendingResult["cancel"] == true ? "Result.SurrenderWaiting" : "Result.Waiting");
                }
                if (RankBattle.Loading || DownloadProgress != null) return L.T("Match.Preparing");
                if (RankBattle.Running) return L.T("Match.Running");
                return Ticket != null ? L.T("Match.Ready") : "";
            }
        }
        public static string MatchStateDetail => PendingResult != null
            ? !resultDurable ? L.T("Result.SaveWarning") : L.T("Result.Locked")
            : L.T("Match.Locked");
        public static string ResultRetryText => ResultDelivery == ResultDeliveryState.Waiting
            ? L.F("Result.RetryIn", ResultRetryIn)
            : ResultDelivery == ResultDeliveryState.SignInRequired ? L.T("Result.AccountHint") : "";
        public static Color MatchStateColor => PendingResult == null ? new Color(.32f, .72f, 1f)
            : ResultDelivery == ResultDeliveryState.SignInRequired || ResultDelivery == ResultDeliveryState.NeedsAttention || !resultDurable
                ? new Color(1f, .48f, .38f) : new Color(1f, .75f, .3f);
    }
}
