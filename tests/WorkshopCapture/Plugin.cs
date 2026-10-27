using System;
using System.IO;
using System.Linq;
using FtdRank;
using HarmonyLib;
using BrilliantSkies.Modding;
using BrilliantSkies.Core.Timing;
using BrilliantSkies.Ftd.Modes.MainMenu.Ui;
using BrilliantSkies.Ftd.Modes.CustomBattleMode;
using BrilliantSkies.Ui.Consoles;
using BrilliantSkies.Ui.Consoles.Examples;
using BrilliantSkies.Ui.Examples.OptionsMenu;
using BrilliantSkies.Ui.Displayer;
using Newtonsoft.Json.Linq;
using UnityEngine;

// Development-only screenshot director. Shipped mod DLLs are unchanged.
// Uses FTD/Unity APIs, a private SaveLocation and a localhost preview server.
public sealed class WorkshopCapture : GamePlugin
{
    public string name => "Workshop screenshot director";
    public Version version => new Version(0,1,0);
    static string root, output;
    static int stage;
    static float next, started;
    static FtdOptionsMenuUi options;
    static bool beauty;
    static bool chatOnly;
    static bool statusOnly;
    static int resultFault;
    static System.Threading.Tasks.TaskCompletionSource<JObject> resultReply;
    static bool chatSent;
    static NicknameColorUi colorUi;
    static CustomBattleVehicle subject;
    public void OnSave() { }
    public void OnLoad()
    {
        root=Path.GetFullPath(Path.Combine(Path.GetDirectoryName(typeof(WorkshopCapture).Assembly.Location),"../../../.."));
        var settings=JObject.Parse(File.ReadAllText(Path.Combine(root,"capture-settings.json")));
        output=settings["output"].Value<string>(); chatOnly=settings["chatOnly"]?.Value<bool>()==true;
        statusOnly=settings["statusOnly"]?.Value<bool>()==true;
        Directory.CreateDirectory(output); Application.runInBackground=true;
        GameEvents.UpdateEvent.RegWithEvent(Update);
    }
    static void Log(string s) => File.AppendAllText(Path.Combine(root,"capture.log"),s+"\n");
    static void Advance(int s, float wait=4) { stage=s; next=Time.realtimeSinceStartup+wait; }
    static string pendingShot;
    static bool Shot(string name)
    {
        if(pendingShot==name) {
            if(!File.Exists(Path.Combine(output,name+".png"))) throw new Exception("FTD did not render the screenshot: "+name);
            pendingShot=null; return true;
        }
        ScreenCapture.CaptureScreenshot(Path.Combine(output,name+".png"));
        Log("Capture "+name+" at "+Screen.width+"x"+Screen.height);
        pendingShot=name; next=Time.realtimeSinceStartup+1; return false;
    }
    static void Tab(string name)
    {
        RankClient.Status=statusOnly ? "" : "Preview session"; RankClient.RefreshUi(); RankClient.FocusTab(L.T(name));
        foreach(var w in RankClient.Ui.Windows) AccessTools.Field(typeof(ConsoleWindow),"_scroll").SetValue(w,Vector2.zero);
    }
    static void Pose()
    {
        if(subject==null || !subject.Exists) subject=CustomBattleModeProgression.State.Teams[0].Vehicles.FirstOrDefault(v=>v.Exists);
        if(subject==null) return;
        var c=RankSpectator.NativeCamera; if(c==null) return;
        var rotation=subject.Construct.MainThreadRotation;
        var centre=subject.Position;
        var position=centre+rotation*new Vector3(-32,17,-43);
        position.y=Mathf.Max(position.y,25);
        c.MoveFreeCameraTo(position);
        c.FreeCamera.Transform.rotation=Quaternion.LookRotation(centre+rotation*new Vector3(0,0,8)-position,Vector3.up);
        c.FreeCamera.MouseLook.Match();
    }
    static void ChatUpdate()
    {
        switch(stage) {
            case 1: RankClient.Open(); Advance(2, 4); break;
            case 2:
                if(!RankClient.Connected) return;
                Tab("Chat.Title"); RankClient.OpenChat(); Advance(3, 5); break;
            case 3:
                if(!RankChat.Connected || RankChat.Messages.Count<6) return;
                if(!chatSent) { if(!RankChat.CanSend) { RankChat.Draft="My fleet is ready. See you in the next match!"; if(!RankChat.CanSend) return; } RankChat.Submit(); chatSent=true; return; }
                if(RankChat.Sending || RankChat.Messages.Count<7) return;
                if(RankChat.Cooldown<=0 || RankChat.Draft.Length>0) throw new Exception("Chat send acknowledgement or countdown missing");
                if(!Shot("01-chat-en")) return;
                RankChat.SearchText="fleet"; RankChat.Search(); Advance(4, 3); break;
            case 4:
                if(RankChat.Searching || !RankChat.SearchMode) return;
                if(!Shot("02-chat-search")) return;
                RankClient.SetLanguage("ko"); RankClient.FocusTab(L.T("Chat.Title")); RankClient.OpenChat(); Advance(5, 5); break;
            case 5:
                if(!RankChat.Connected) return;
                if(!Shot("03-chat-ko")) return;
                RankClient.SetLanguage("ja"); RankClient.FocusTab(L.T("Chat.Title")); RankClient.OpenChat(); Advance(6, 5); break;
            case 6:
                if(!RankChat.Connected) return;
                if(!Shot("04-chat-ja")) return;
                RankClient.SetLanguage("en"); RankClient.FocusTab(L.T("계정 / Account"));
                colorUi=new NicknameColorUi(); colorUi.ActivateGui(GuiActivateType.Stack); Advance(7, 4); break;
            case 7:
                if(!Shot("05-nickname-color")) return;
                colorUi.DeactivateGui(); RankClient.SaveNicknameColor("#EEAA55"); Advance(8, 3); break;
            case 8:
                if(RankClient.Text(RankClient.Me,"nicknameColor")!="#EEAA55") throw new Exception("Native profile save failed: "+RankClient.Status);
                RankClient.LoadStandings(); Advance(81,3); break;
            case 81:
                Tab("순위 / Ranking"); Advance(9, 2); break;
            case 9:
                if(!Shot("06-ranking-colors")) return;
                Screen.SetResolution(1280,800,false); Tab("Chat.Title"); RankClient.OpenChat(); Advance(10, 5); break;
            case 10:
                if(!RankChat.Connected) return;
                if(!Shot("07-chat-1280")) return;
                RankClient.SaveNicknameColor(null); Advance(11,3); break;
            case 11:
                if(RankClient.Text(RankClient.Me,"nicknameColor").Length!=0) throw new Exception("Native color reset failed: "+RankClient.Status);
                File.WriteAllText(Path.Combine(root,"capture-done"),"Chat and nickname colors captured in the actual game; local demo data.");
                Application.Quit(); stage=99; break;
        }
    }
    static bool ResultFault(ref System.Threading.Tasks.Task<JObject> __result)
    {
        if(resultFault==0) return true;
        __result=resultFault==1 ? resultReply.Task : System.Threading.Tasks.Task.FromException<JObject>(new RankApiException(resultFault==3 ? 401 : 503,"Preview connection failure"));
        return false;
    }
    static void StatusUpdate()
    {
        switch(stage) {
            case 1: RankClient.Open(); Advance(2,1); break;
            case 2:
                if(RankClient.Busy || !RankClient.Connected || RankClient.Tournament==null) return;
                RankClient.Match(); Advance(3,1); break;
            case 3:
                if(RankClient.Busy) return;
                if(RankClient.Ticket==null) throw new Exception("No preview match: "+RankClient.Status);
                RankClient.SetLanguage("ko"); Tab("전투 / Battle"); Advance(4,2); break;
            case 4:
                if(!Shot("01-match-ready-ko")) return;
                RankClient.SetLanguage("en"); Tab("전투 / Battle"); Advance(5,1); break;
            case 5:
                if(!Shot("02-match-ready-en")) return;
                RankClient.SetLanguage("ko"); Tab("함대 / Fleet"); Advance(6,1); break;
            case 6:
                if(!Shot("03-fleet-locked-ko")) return;
                RankClient.StartBattle(); Advance(7,1); break;
            case 7:
                if(RankClient.Busy || !RankBattle.Running) return;
                new Harmony("ftdrank.preview.result-status").Patch(AccessTools.Method(typeof(RankTransport),nameof(RankTransport.SubmitMatchResult)),
                    prefix:new HarmonyMethod(typeof(WorkshopCapture),nameof(ResultFault)));
                resultReply=new System.Threading.Tasks.TaskCompletionSource<JObject>(); resultFault=1;
                RankBattle.Surrender(); Advance(8,1); break;
            case 8:
                if(!Shot("04-result-sending-ko")) return;
                resultFault=2; resultReply.SetException(new RankApiException(503,"Preview connection failure")); Advance(9,.1f); break;
            case 9:
                if(RankClient.Busy || RankClient.ResultDelivery!=ResultDeliveryState.Waiting) return;
                if(!Shot("05-result-retry-ko")) return;
                RankClient.SetLanguage("en"); Tab("함대 / Fleet"); Advance(10,.1f); break;
            case 10:
                if(RankClient.Busy || RankClient.ResultDelivery!=ResultDeliveryState.Waiting) return;
                if(!Shot("06-result-retry-en")) return;
                resultFault=3; RankClient.SubmitResult(); Advance(11,.5f); break;
            case 11:
                if(RankClient.Busy) return;
                if(RankClient.Connected) throw new Exception("Preview 401 did not expire the session");
                RankClient.SetLanguage("ko"); Tab("계정 / Account"); Advance(12,1); break;
            case 12:
                if(!Shot("07-result-sign-in-ko")) return;
                resultFault=0; RankClient.Connect(); Advance(13,1); break;
            case 13:
                if(RankClient.Busy || RankClient.PendingResult!=null) return;
                if(RankClient.Ticket!=null || RankClient.Receipt==null || !RankClient.CanEditFleet) throw new Exception("Preview recovery did not unlock fleet");
                Tab("전투 / Battle"); Advance(14,1); break;
            case 14:
                if(!Shot("08-result-confirmed-ko")) return;
                File.WriteAllText(Path.Combine(root,"capture-done"),"Actual FTD UI: match reservation, fleet lock, sending, retry, expired login and confirmed surrender. Local demo only.");
                Application.Quit(); stage=99; break;
        }
    }
    static void Update(ITimeStep step)
    {
        try {
            if(stage==99) return;
            if(stage==0) {
                if(GAME_STATE.GetGameType()!=enumGameType.mainmenu || RankedPlugin.MenuBuilt==0 || Time.realtimeSinceStartup<12) return;
                if(!new Uri(RankClient.Settings.Server).IsLoopback) throw new Exception("Preview refuses a remote server");
                started=Time.realtimeSinceStartup;
                Screen.SetResolution(1920,1080,false); RankClient.SetLanguage("en");
                Advance(1,5); return;
            }
            if(Time.realtimeSinceStartup-started>450) throw new Exception("Capture timed out: stage "+stage+" "+RankClient.Status);
            if(beauty && RankBattle.Running) Pose();
            if(Time.realtimeSinceStartup<next) return;
            if(statusOnly) { StatusUpdate(); return; }
            if(RankClient.Busy) return;
            if(chatOnly) { ChatUpdate(); return; }
            switch(stage) {
                case 1: if(!Shot("00-main-menu")) return; RankClient.Open(); Advance(2,7); break;
                case 2:
                    if(!RankClient.Connected || RankClient.Tournament==null) return;
                    Tab("대회 / Events"); Advance(3); break;
                case 3: if(!Shot("01-events")) return; Tab("함대 / Fleet"); Advance(4); break;
                case 4: if(!Shot("02-formation")) return; RankClient.LoadStandings(); Advance(5); break;
                case 5: Tab("순위 / Ranking"); Advance(6); break;
                case 6: if(!Shot("03-ranking-demo")) return;
                    options=new FtdOptionsMenuUi(new OptionsMenu()); options.ActivateGui(GuiActivateType.Stack);
                    var w=options.Windows.First(); w.Screen=w.AllScreens.OfType<RankKeyOptions>().Single(); Advance(7); break;
                case 7: if(!Shot("04-key-options")) return; options.DeactivateGui(); Tab("전투 / Battle"); RankClient.Match(); Advance(8); break;
                case 8:
                    if(RankClient.Ticket==null) throw new Exception("No preview match: "+RankClient.Status);
                    Tab("전투 / Battle"); Advance(9); break;
                case 9: if(!Shot("05-match")) return; RankClient.StartBattle(); Advance(10); break;
                case 10:
                    if(!RankBattle.Running) return;
                    GuiDisplayer.GetSingleton().CloseAllUis();
                    subject=CustomBattleModeProgression.State.Teams[0].Vehicles.First(v=>v.Exists);
                    RankSpectator.Follow(subject); Advance(11,5); break;
                case 11: if(!Shot("06-spectator-follow")) return; RankSpectator.Free(); beauty=true; Advance(12,4); break;
                case 12: if(!Shot("07-air-battle")) return; Advance(13,8); break;
                case 13: if(!Shot("08-air-battle")) return; Advance(14,8); break;
                case 14: if(!Shot("09-air-battle")) return; beauty=false; RankSpectator.OpenMenu(); Advance(15); break;
                case 15: if(!Shot("10-spectator-menu")) return; GuiDisplayer.GetSingleton().CloseAllUis();
                    RankSpectator.Overview(); Advance(16,4); break;
                case 16: if(!Shot("11-battle-overview")) return; Advance(17,2); break;
                case 17: File.WriteAllText(Path.Combine(root,"capture-done"),"Screenshots complete; local demo data only."); stage=98; break;
                case 98:
                    // Keep this process available briefly for extra captures, then end only this test game.
                    Application.Quit(); stage=99; break;
            }
        } catch(Exception e) { File.WriteAllText(Path.Combine(root,"capture-failed.txt"),e.ToString()); stage=99; }
    }
}
