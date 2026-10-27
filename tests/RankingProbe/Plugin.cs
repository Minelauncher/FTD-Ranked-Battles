using System;
using System.IO;
using System.Linq;
using System.Threading.Tasks;
using FtdRank;
using HarmonyLib;
using BrilliantSkies.Core.Timing;
using BrilliantSkies.Ftd.Modes.MainMenu.Ui;
using BrilliantSkies.Modding;
using BrilliantSkies.Ui.Consoles;
using BrilliantSkies.Ui.Consoles.Interpretters.Simple;
using BrilliantSkies.Ui.Consoles.Interpretters.Subjective.Buttons;
using Newtonsoft.Json.Linq;
using UnityEngine;

// Hidden native-UI integration test. Requests are intercepted; no live accounts are used.
public sealed class RankingProbe : GamePlugin
{
    public string name => "Ranking pagination probe";
    public Version version => new Version(0,1);
    static string root, route;
    static int stage, requests, expectedRequests;
    static TaskCompletionSource<JObject> pending;
    static float deadline;
    public void OnSave() { }
    public void OnLoad()
    {
        root=Path.GetFullPath(Path.Combine(Path.GetDirectoryName(typeof(RankingProbe).Assembly.Location),"../../../.."));
        Application.runInBackground=true;
        new Harmony("ftdrank.test.ranking").Patch(AccessTools.Method(typeof(RankTransport),nameof(RankTransport.Request)),
            prefix:new HarmonyMethod(typeof(RankingProbe),nameof(Request)));
        GameEvents.UpdateEvent.RegWithEvent(Update);
        deadline=Time.realtimeSinceStartup+90;
    }
    static bool Request(string route, ref Task<JObject> __result)
    {
        RankingProbe.route=route; requests++;
        pending=new TaskCompletionSource<JObject>(); __result=pending.Task; return false;
    }
    static JObject Page(int number)
    {
        return new JObject { ["tournamentId"]="page-test", ["page"]=number, ["pageSize"]=100, ["total"]=205, ["totalPages"]=3,
            ["accounts"]=new JArray(Enumerable.Range((number-1)*100+1,number==3?5:100).Select(i=>new JObject {
                ["id"]="player-"+i,["name"]="Player "+i,["rating"]=2000-i,["games"]=1,["rank"]=i,["total"]=205,["percentile"]=100.0*(205-i)/204 })) };
    }
    static void Check(bool ok,string text) { if(!ok)throw new Exception(text); }
    static ConsoleWindow Window => RankClient.Ui.Windows.First();
    static SubjectiveButton<MainMenu>[] Buttons(string key) => Window.Screen.Segments.SelectMany(s=>s.Interpretters)
        .OfType<SubjectiveButton<MainMenu>>().Where(b=>b.GetDisplayString()==L.T(key)).ToArray();
    static void Click(string key,bool bottom=false)
    {
        var buttons=Buttons(key); Check(buttons.Length>0,"Missing native button: "+key);
        var button=bottom?buttons.Last():buttons.First();
        ((Action<MainMenu>)AccessTools.Field(button.GetType(),"_fnEffect").GetValue(button))(new MainMenu());
    }
    static void Inspect(int page)
    {
        Check(RankClient.Ranking.Page==page,"Displayed page differs from response");
        Check(Buttons("Ranking.Previous").Length==(page==3?1:2),"Top/bottom navigation missing");
        var labels=Window.Screen.Segments.SelectMany(s=>s.Interpretters).OfType<StringDisplay>()
            .Select(d=>(string)AccessTools.Method(typeof(StringDisplay),"GetDisplayString").Invoke(d,null)).ToArray();
        Check(labels.Contains(L.F("Ranking.Page",page,3)),"Native page label missing");
        Check(Window.Screen.Segments.SelectMany(s=>s.Interpretters).Count(i=>i.GetType().Name=="RankCard")== (page==3?5:100),"Ranking card count differs");
    }
    static void Update(ITimeStep step)
    {
        if(stage==99)return;
        try {
            if(Time.realtimeSinceStartup>deadline)throw new Exception("Pagination probe timeout, stage="+stage);
            if(RankedPlugin.MenuBuilt==0 || Time.realtimeSinceStartup<12)return;
            if(stage==0) {
                Check(RankClient.StorageReady,"Isolated client storage unavailable");
                RankClient.Settings.Server="http://127.0.0.1:1";
                RankClient.Settings.Connections[RankClient.Settings.Server]=new Connection {Token="fixture",AccountId="fixture",Username="fixture"};
                RankClient.Me=new JObject { ["id"]="fixture",["name"]="Fixture" };
                RankClient.Tournament=new JObject { ["id"]="page-test",["name"]="Page test",["status"]="open",["rules"]=JObject.Parse(
                    "{\"world\":\"neter\",\"teamBudget\":100000,\"maxUnits\":10,\"maxBlueprints\":10,\"duration\":600,\"distance\":1000,\"boardEast\":1.5,\"boardNorth\":1.5,\"formationHalfWidth\":500,\"formationDepth\":1000,\"minAltitude\":-100,\"maxAltitude\":500,\"replacementSeconds\":60}") };
                RankClient.Connected=true; RankClient.ResetStandings(); L.Select("en");
                RankClient.Open(false); RankClient.FocusTab(L.T("순위 / Ranking")); Window.Screen.OnSelectTab(); stage=1; return;
            }
            if(stage==1 && pending!=null) { Check(route.EndsWith("?page=1"),"Tab did not load page 1");pending.SetResult(Page(1));stage=2;return; }
            if(stage==2 && !RankClient.Busy) {
                Inspect(1); int count=requests; Click("Ranking.Previous");Check(requests==count&&!RankClient.Busy,"First page allowed previous");
                AccessTools.Field(typeof(ConsoleWindow),"_scroll").SetValue(Window,new Vector2(0,5000));
                expectedRequests=requests+1;
                Click("Ranking.Next",true); Check(RankClient.Busy,"Next did not start request");
                Click("Ranking.Next"); stage=3;return;
            }
            if(stage==3 && route.EndsWith("?page=2")) { Check(requests==expectedRequests,"Busy navigation duplicated request");pending.SetResult(Page(2));stage=4;return; }
            if(stage==4 && !RankClient.Busy) {
                Inspect(2); Check(((Vector2)AccessTools.Field(typeof(ConsoleWindow),"_scroll").GetValue(Window)).y==0,"Page navigation retained bottom scroll");
                RankClient.SetLanguage("ja");Inspect(2);RankClient.SetLanguage("ko");Inspect(2);RankClient.SetLanguage("en");
                Click("Ranking.Next"); stage=5;return;
            }
            if(stage==5 && route.EndsWith("?page=3")) { pending.SetException(new System.Net.Http.HttpRequestException("Fixture offline"));stage=6;return; }
            if(stage==6 && !RankClient.Busy) { Inspect(2); Click("Ranking.Next");stage=7;return; }
            if(stage==7 && RankClient.Busy && !pending.Task.IsCompleted) { pending.SetResult(Page(3));stage=8;return; }
            if(stage==8 && !RankClient.Busy) {
                Inspect(3); int count=requests;Click("Ranking.Next");Check(requests==count&&!RankClient.Busy,"Last page allowed next");
                Click("새로고침 / Refresh");stage=9;return;
            }
            if(stage==9 && RankClient.Busy && !pending.Task.IsCompleted) { Check(route.EndsWith("?page=3"),"Refresh reset the page");pending.SetResult(Page(3));stage=10;return; }
            if(stage==10 && !RankClient.Busy) {
                Inspect(3); RankClient.ResetStandings();Check(!RankClient.Ranking.Loaded&&RankClient.Ranking.Page==1&&RankClient.Standings.Count==0,"Reset retained another event's page");
                File.WriteAllText(Path.Combine(root,"ranking-pass.txt"),"PASS native FTD ranking controls: tab loads page 1; top/bottom previous/next; busy and boundary guards; 100/100/5 cards; page labels in EN/JA/KO; scroll resets; failed download keeps old page; refresh retains page; event/account reset. HTTP transport stubbed; no screen rendering or live data.\n");
                stage=99;Application.Quit();
            }
        } catch(Exception e) { File.WriteAllText(Path.Combine(root,"ranking-failed.txt"),e.ToString());stage=99;Application.Quit(); }
    }
}
