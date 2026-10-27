using System;
using System.IO;
using System.Linq;
using System.Collections.Generic;
using FtdRank;
using HarmonyLib;
using BrilliantSkies.Core.Timing;
using BrilliantSkies.Ftd.Modes.MainMenu.Ui;
using BrilliantSkies.Modding;
using BrilliantSkies.Ui.Consoles.Interpretters.Simple;
using BrilliantSkies.Ui.Displayer;
using Steamworks;
using UnityEngine;

public sealed class VersionProbe : GamePlugin
{
    public string name => "Version notice probe";
    public System.Version version => new System.Version(0, 1);
    static readonly Type info = typeof(RankedPlugin).Assembly.GetType("FtdRank.ModInformation");
    static readonly Type parser = typeof(RankedPlugin).Assembly.GetType("FtdRank.WorkshopVersion");
    static int stage, requests;
    static string root, key;
    static MainMenuUi menu;
    static readonly List<string> proof = new List<string>();
    public void OnSave() { }
    public void OnLoad()
    {
        root = Path.GetFullPath(Path.Combine(Path.GetDirectoryName(typeof(VersionProbe).Assembly.Location), "../../../.."));
        Application.runInBackground = true;
        File.WriteAllText(Path.Combine(root, "version-progress.txt"), "Probe loaded\n");
        // Never contact an unrelated Workshop item: all requests made by this test return Invalid locally.
        new Harmony("ftdrank.test.version").Patch(AccessTools.Method(typeof(SteamUGC), "RequestUGCDetails"),
            prefix: new HarmonyMethod(typeof(VersionProbe), nameof(FakeRequest)));
        GameEvents.UpdateEvent.RegWithEvent(Update);
    }
    static bool FakeRequest(ref SteamAPICall_t __result) { requests++; __result = SteamAPICall_t.Invalid; return false; }
    static object Get(string field) => AccessTools.Field(info, field).GetValue(null);
    static void Set(string field, object value) => AccessTools.Field(info, field).SetValue(null, value);
    static object Call(string method, params object[] args) => AccessTools.Method(info, method).Invoke(null, args);
    static object Parse(string method, params object[] args) => AccessTools.Method(parser, method).Invoke(null, args);
    static void Check(bool ok, string text) { if (!ok) throw new Exception(text); }
    static bool HasUpdate => ModProblems.AllModProblems.ContainsKey(key + ".Update");
    static void Arm()
    {
        Call("Stop"); Set("finished", false); Set("attempts", 1); Set("workshopId", 123456UL);
    }
    static void Deliver(string description, EResult result = EResult.k_EResultOK, ulong id = 123456, bool io = false)
    {
        // Steam fills a fixed byte buffer through marshalling; the property setter does not allocate that buffer.
        object details = new SteamUGCDetails_t { m_nPublishedFileId = new PublishedFileId_t(id), m_eResult = result };
        var bytes = new byte[8000]; System.Text.Encoding.UTF8.GetBytes(description ?? "").CopyTo(bytes, 0);
        AccessTools.Field(typeof(SteamUGCDetails_t), "m_rgchDescription_").SetValue(details, bytes);
        var response = new SteamUGCRequestUGCDetailsResult_t { m_details = (SteamUGCDetails_t)details };
        Call("OnDetails", response, io);
    }
    static string[] Labels() => menu.Windows.SelectMany(w => w.Screen.Segments).SelectMany(s => s.Interpretters)
        .OfType<StringDisplay>().Select(d => (string)AccessTools.Method(typeof(StringDisplay), "GetDisplayString").Invoke(d, null)).ToArray();
    static void Update(ITimeStep step)
    {
        if (stage == 99) return;
        try
        {
            if (Time.frameCount % 120 == 0) File.WriteAllText(Path.Combine(root, "version-progress.txt"), "stage=" + stage + " time=" + Time.realtimeSinceStartup + " menus=" + RankedPlugin.MenuBuilt);
            if (RankedPlugin.MenuBuilt == 0 || Time.realtimeSinceStartup < 12) return;
            if (menu == null)
            {
                // An isolated profile may start with the player selector over the native menu.
                menu = new MainMenuUi(new MainMenu()); menu.ActivateGui(GuiActivateType.Force);
            }
            if (stage == 0)
            {
                key = (string)Get("noticeKey");
                var active = ModProblems.AllModProblems[key];
                Check(active.Name == "Ranked Battles v" + RankTransport.ClientVersion + " Active!" && !active.IsError && active.Guid == Guid.Empty, "Active notice missing or error/disable control set");
                Check(Labels().Any(s => s.Contains(active.Name)), "Native menu did not build the Active version label");
                Check((bool)Get("finished") && !(bool)Get("registered") && requests == 0, "ID 0 started Workshop polling");
                int count = ModProblems.Count; Call("Initialize"); Check(ModProblems.Count == count, "Repeated initialization duplicated notice");
                proof.Add("PASS actual native main-menu version label, ID 0 makes no requests, initialization is idempotent");
                foreach (string value in new[] { null, "", "{", "{}", "{\"workshop_id\":-1}", "{\"workshop_id\":1.5}", "{\"workshop_id\":{}}", "{\"workshop_id\":\"not-an-id\"}" })
                    Check((ulong)Parse("ReadId", value) == 0, "Bad metadata enabled Workshop request");
                Check((ulong)Parse("ReadId", "{\"workshop_id\":\"123456\"}") == 123456 && (ulong)Parse("ReadId", "{\"workshop_id\":123456}") == 123456, "String/numeric ID rejected");
                var metadataPath = Path.Combine(Path.GetDirectoryName(key), "plugin.json");
                string metadata = File.ReadAllText(metadataPath);
                try
                {
                    File.WriteAllText(metadataPath, metadata.Replace("\"workshop_id\":\"0\"", "\"workshop_id\":\"123456\""));
                    Set("started", false); Set("finished", false);
                    Exception backgroundError = null;
                    var loader = new System.Threading.Thread(() => { try { Call("Initialize"); } catch (Exception e) { backgroundError = e; } });
                    loader.Start(); loader.Join();
                    Check(backgroundError == null && (bool)Get("registered") && !(bool)Get("finished") && (ulong)Get("workshopId") == 123456,
                        "Adding an ID did not enable checking from FTD's background plugin loader");
                    Call("Stop");
                }
                finally { File.WriteAllText(metadataPath, metadata); }
                var installed = new System.Version("0.6.15");
                Check(Parse("NewerVersion", "Text\r\n Mod latest version 0.6.16 \r\n", installed)?.ToString() == "0.6.16", "New version not recognized");
                Check(Parse("NewerVersion", "Mod latest version 0.6.100", installed)?.ToString() == "0.6.100", "Lexical comparison used");
                foreach (string value in new[] { null, "", "Mod latest version invalid", "Mod latest version 0.6.14", "Mod latest version 0.6.15", "Mod latest version 0.6.15.0", "Release 99.0.0", "Mod latest version <b>99.0.0</b>" })
                    Check(Parse("NewerVersion", value, installed) == null, "False update alert");
                proof.Add("PASS setting a later ID enables checking from a worker thread; metadata/numeric version parsing (older/equal/newer/malformed/zero revision)");
                // Protect a real loader error and another mod's alert while adding our separate informational row.
                var error = ModProblems.AddModProblem("Fixture error", Path.GetDirectoryName(key), "Keep this error", true);
                var other = ModProblems.AddModProblem("Other mod", key + ".Other", "Keep this notice", false);
                int errors = ModProblems.ErrorsCount;
                Arm(); Deliver("Mod latest version 99.0.0", io: true); Check(!HasUpdate && !(bool)Get("finished"), "I/O failure reported an update");
                Deliver("Mod latest version 99.0.0", result: EResult.k_EResultFail); Check(!HasUpdate && !(bool)Get("finished"), "Failed API response reported an update");
                Deliver("Mod latest version 99.0.0", id: 999); Check(!HasUpdate && !(bool)Get("finished"), "Wrong Workshop item accepted");
                foreach (string desc in new[] { "", "Mod latest version bogus", "Mod latest version 0.6.14", "Mod latest version 0.6.15.0" })
                { Arm(); Deliver(desc); Check(!HasUpdate && (bool)Get("finished"), "Non-newer response raised an alert or continued polling"); }
                Arm(); Set("attempts", 0); requests = 0;
                for (int i = 0; i < 5; i++) { Set("nextRequest", 0f); Call("Tick", (object)null); }
                Check(requests == 3 && (bool)Get("finished"), "Invalid requests were not bounded at three");
                Arm(); Set("attempts", 3); Set("inFlight", true); Set("deadline", 0f); Set("nextRequest", 0f); Call("Tick", (object)null);
                Check((bool)Get("finished") && !(bool)Get("inFlight"), "Timed-out request did not stop");
                proof.Add("PASS callback errors/wrong item rejected, retries and timeout bounded (Steam transport stubbed)");
                Arm(); Deliver("Mod latest version 0.6.16");
                Check(HasUpdate && ModProblems.AllModProblems[key + ".Update"].Description == "New version available: v0.6.16", "New release notice missing");
                Check(!(bool)Get("registered") && (bool)Get("finished"), "Successful check did not stop");
                Check(ReferenceEquals(ModProblems.AllModProblems[error.Path], error) && ReferenceEquals(ModProblems.AllModProblems[other.Path], other) && ModProblems.ErrorsCount == errors, "Existing alerts/errors changed");
                count = ModProblems.Count; Deliver("Mod latest version 99.0.0"); Check(ModProblems.Count == count && !ModProblems.AllModProblems[key + ".Update"].Description.Contains("99"), "Late callback altered final notice");
                stage = 1; return;
            }
            Check(Labels().Any(s => s.Contains("New version available: v0.6.16")), "Native menu was not rebuilt for update notice");
            proof.Add("PASS newer release appears in rebuilt native Alerts; existing errors/notices remain; late callback ignored");
            File.WriteAllLines(Path.Combine(root, "version-pass.txt"), proof); stage = 99; Application.Quit();
        }
        catch (Exception e) { File.WriteAllText(Path.Combine(root, "version-failed.txt"), e.ToString()); stage = 99; Application.Quit(); }
    }
}
