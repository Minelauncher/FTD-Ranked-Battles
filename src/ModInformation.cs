using System;
using System.IO;
using BrilliantSkies.Core.Timing;
using BrilliantSkies.Ftd.Modes.MainMenu.Ui;
using BrilliantSkies.Modding;
using HarmonyLib;
using Steamworks;
using UnityEngine;

namespace FtdRank
{
    internal static class ModInformation
    {
        const int MaximumAttempts = 3;
        const float RequestTimeout = 10f;
        static bool started, registered, finished, inFlight;
        static int attempts;
        static ulong workshopId;
        static float nextRequest, deadline;
        static string noticeKey;
        static CallResult<SteamUGCRequestUGCDetailsResult_t> call;
        static WeakReference<MainMenuUi> menu;

        internal static void RememberMenu(MainMenuUi instance) => menu = new WeakReference<MainMenuUi>(instance);

        internal static void Initialize()
        {
            if (started) return;
            started = true;
            // Read release metadata beside the DLL, even when player data uses the writable fallback directory.
            string directory = Path.GetDirectoryName(typeof(ModInformation).Assembly.Location) ?? "";
            noticeKey = Path.Combine(directory, "RankedBattles.VersionNotice");
            ModProblems.AddModProblem("Ranked Battles v" + RankTransport.ClientVersion + " Active!", noticeKey, "", false);
            try
            {
                string metadata = Path.Combine(directory, "plugin.json");
                workshopId = WorkshopVersion.ReadId(File.Exists(metadata) ? File.ReadAllText(metadata) : null);
                if (workshopId == 0) { finished = true; return; }
                // FTD loads plugins on a worker thread. Unity time and Steam calls belong in Tick on the game thread.
                nextRequest = 0f;
                GameEvents.Twice_Second.RegWithEvent(Tick);
                registered = true;
            }
            catch (Exception e) { Stop(); Log(e); }
        }

        static void Tick(ITimeStep step)
        {
            if (finished) return;
            float now = Time.realtimeSinceStartup;
            if (inFlight)
            {
                if (now < deadline) return;
                ReleaseCall();
                inFlight = false;
            }
            if (now < nextRequest) return;
            if (attempts >= MaximumAttempts) { Stop(); return; }
            attempts++;
            nextRequest = now + 2f;
            try
            {
                var request = SteamUGC.RequestUGCDetails(new PublishedFileId_t(workshopId), 0);
                if (request == SteamAPICall_t.Invalid) return;
                call = new CallResult<SteamUGCRequestUGCDetailsResult_t>(OnDetails);
                inFlight = true;
                deadline = now + RequestTimeout;
                call.Set(request);
            }
            catch (Exception e) { Stop(); Log(e); }
        }

        static void OnDetails(SteamUGCRequestUGCDetailsResult_t response, bool ioFailure)
        {
            if (finished) return;
            inFlight = false;
            ReleaseCall();
            if (ioFailure || response.m_details.m_eResult != EResult.k_EResultOK
                || response.m_details.m_nPublishedFileId.m_PublishedFileId != workshopId)
            {
                if (attempts >= MaximumAttempts) Stop();
                return;
            }
            Stop();
            System.Version latest;
            try { latest = WorkshopVersion.NewerVersion(response.m_details.m_rgchDescription, new System.Version(RankTransport.ClientVersion)); }
            catch (Exception e) { Log(e); return; } // Malformed native string data must not escape a Steam callback.
            if (latest == null) return;
            // A separate key leaves actual loader errors and other mods' notices untouched.
            ModProblems.AddModProblem("Ranked Battles", noticeKey + ".Update", "New version available: v" + latest, false);
            // The menu may be underneath the account/options/profile window, outside the active GUI stack level.
            if (menu != null && menu.TryGetTarget(out var currentMenu)) currentMenu.TriggerRebuild();
        }

        static void ReleaseCall()
        {
            call?.Dispose();
            call = null;
        }

        static void Stop()
        {
            finished = true;
            inFlight = false;
            if (registered) { GameEvents.Twice_Second.UnregWithEvent(Tick); registered = false; }
            ReleaseCall();
        }

        static void Log(Exception e) => Debug.LogWarning("Ranked Battles update check unavailable: " + e.GetType().Name);
    }

    [HarmonyPatch(typeof(MainMenuUi), "BuildInterface")]
    static class VersionNoticeMenu
    {
        static void Postfix(MainMenuUi __instance) => ModInformation.RememberMenu(__instance);
    }
}
