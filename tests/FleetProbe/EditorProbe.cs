using System;
using System.IO;
using System.Linq;
using HarmonyLib;
using FtdRank;
using Newtonsoft.Json.Linq;
using UnityEngine;

// Development-only: sends Unity mouse events through the real native canvas handler.
// No OS input, user profile, production account or production module test hooks.
public static class EditorProbe
{
    public static int Phase = -1, Draws;
    public static string Error, Root;
    public static bool PointerVerified;
    static JArray original;
    static double keepAltitude, keepYaw;
    static void Check(bool b, string message) { if (!b) throw new Exception(message); }
    public static void Start(string root, bool verifyPointer = false)
    {
        Root = root; original = (JArray)RankClient.Draft.DeepClone(); string hash = (string)original[0]["hash"];
        RankClient.SetBlueprintQuantity(hash, "3"); Check(RankClient.Draft.Count==4,"Native quantity change failed: "+RankClient.Status);
        for(int i=0;i<original.Count;i++) Check(JToken.DeepEquals(original[i],RankClient.Draft[i]),"Quantity moved an old placement");
        var positions=(JArray)RankClient.Draft.DeepClone();
        string other=Path.Combine(RankClient.DirectoryPath,"FleetBlueprints",(string)original[1]["hash"]+".blueprint");
        RankClient.ReplaceFleetBlueprint(other,0,false);
        Check((string)RankClient.Draft[0]["hash"]==(string)original[1]["hash"] && (string)RankClient.Draft[2]["hash"]==hash,"Single BP replacement failed");
        string first=Path.Combine(RankClient.DirectoryPath,"FleetBlueprints",hash+".blueprint");
        RankClient.ReplaceFleetBlueprint(first,0,true);
        Check(RankClient.Draft.All(u=>(string)u["hash"]==hash),"Group BP replacement failed");
        for(int i=0;i<positions.Count;i++) foreach(string key in new[]{"x","z","altitude","yaw"})
            Check(JToken.DeepEquals(positions[i][key],RankClient.Draft[i][key]),"Native replacement lost placement "+key);
        RankClient.SetBlueprintQuantity(hash,"bad"); Check(RankClient.Draft.Count==4,"Invalid quantity mutated draft");
        RankClient.Draft=(JArray)original.DeepClone(); RankClient.SelectedUnit=0; RankClient.SaveDraft();
        keepAltitude=(double)original[0]["altitude"]; keepYaw=(double)original[0]["yaw"];
        if (!verifyPointer)
        {
            // Headless runs cannot produce Unity GUI events. Exercise the exact commit path instead.
            var map=new FormationMap(20,30,600,300,RankClient.Number(RankClient.Rules,"formationHalfWidth"),RankClient.Number(RankClient.Rules,"formationDepth"));
            RankClient.MoveFleetUnit(0,map.SnapX(map.WorldX(map.ScreenX(123)),10),map.SnapZ(map.WorldZ(map.ScreenY(-234)),10));
            Check((double)RankClient.Draft[0]["x"]==120 && (double)RankClient.Draft[0]["z"]==-230,"Mapped move commit failed");
            RankClient.MoveFleetUnit(0,5000,5000);
            Check((double)RankClient.Draft[0]["x"]==500 && (double)RankClient.Draft[0]["z"]==0,"Move commit did not clamp");
            Check((double)RankClient.Draft[0]["altitude"]==keepAltitude && (double)RankClient.Draft[0]["yaw"]==keepYaw,"Move commit changed height/heading");
            RankClient.FocusTab("함대");
            Check(RankClient.Ui.Windows.First().Screen.Segments.SelectMany(s=>s.Interpretters).Any(i=>i is FormationCanvas),"Native formation canvas is absent");
            Phase=9; return;
        }
        new Harmony("ftdrank.test.editor").Patch(AccessTools.Method(typeof(FormationCanvas),"HandleInput"),
            prefix:new HarmonyMethod(typeof(EditorProbe),nameof(BeforeInput)),postfix:new HarmonyMethod(typeof(EditorProbe),nameof(AfterInput)));
        RankClient.Status="진형 편집 검사 · 수량 입력 / 드래그 배치 / 위치 유지 BP 교체";
        RankClient.RefreshUi(); RankClient.FocusTab("함대"); Phase=0;
        ScreenCapture.CaptureScreenshot(Path.Combine(root,"editor-before.png"));
        File.WriteAllText(Path.Combine(root,"editor-state.txt"),
            "Active UIs: "+string.Join(",",BrilliantSkies.Ui.Displayer.GuiDisplayBase.GetBaseSingleton().ActiveGuis.Select(g=>g.GetType().FullName))+
            "\nPopups: "+BrilliantSkies.Ui.Special.PopUps.GuiPopUp.Instance.PopUpQueueCount+
            "\nWindows: "+string.Join(",",RankClient.Ui.Windows.Select(w=>w.Screen.Name.Display+":"+w.Screen.Segments.Count+":"+string.Join("/",w.Screen.Segments.SelectMany(s=>s.Interpretters).Select(i=>i.GetType().Name)))));
    }
    static void BeforeInput(FormationCanvas __instance, Rect panel, ref Event __state)
    {
        if(Event.current.type!=EventType.Repaint) return; Draws++;
        if(Phase<0 || Phase>=9 || Error!=null || panel.width<100) return;
        try
        {
            var map=(FormationMap)AccessTools.Method(typeof(FormationCanvas),"Map").Invoke(__instance,new object[]{panel});
            EventType type = Phase%3==0 ? EventType.MouseDown : Phase%3==1 ? EventType.MouseDrag : EventType.MouseUp;
            double x=RankClient.Number(RankClient.Draft[0],"x"), z=RankClient.Number(RankClient.Draft[0],"z");
            if(Phase==1 || Phase==2) { x=123; z=-234; }
            if(Phase==4 || Phase==5) { x=-5000; z=-5000; }
            if(Phase==7 || Phase==8) { x=5000; z=5000; }
            __state=Event.current;
            Event.current=new Event { type=type,button=0,mousePosition=new Vector2((float)map.ScreenX(x),(float)map.ScreenY(z)),shift=Phase==1 };
            if(Phase==5) Event.current=new Event { type=EventType.KeyDown,keyCode=KeyCode.Escape };
        }
        catch(Exception e) { Error=e.ToString(); }
    }
    static void AfterInput(Event __state)
    {
        if(__state==null) return;
        try
        {
            if(Phase==2 || Phase==5) Check((double)RankClient.Draft[0]["x"]==120 && (double)RankClient.Draft[0]["z"]==-230,"Drag snap/cancel failed in phase "+Phase);
            if(Phase==8) Check((double)RankClient.Draft[0]["x"]==500 && (double)RankClient.Draft[0]["z"]==0,"Drag did not clamp to server bounds");
            Check((double)RankClient.Draft[0]["altitude"]==keepAltitude && (double)RankClient.Draft[0]["yaw"]==keepYaw,"Dragging changed height or heading");
            if(Phase==2 || Phase==5 || Phase==8) Check(GUIUtility.hotControl==0,"Drag retained mouse capture");
            Phase++;
            if(Phase==9) PointerVerified=true;
        }
        catch(Exception e) { Error=e.ToString(); }
        finally { Event.current=__state; }
    }
    public static void Finish()
    {
        Check(Error==null,Error); Check(Phase==9,"Unity canvas did not receive input");
        RankClient.MoveFleetUnit(0,120,-230);
        string key=RankTransport.Hash(System.Text.Encoding.UTF8.GetBytes(RankClient.Settings.Server+"|"+RankClient.Text(RankClient.Me,"id")+"|"+RankClient.Text(RankClient.Tournament,"id")));
        var saved=JObject.Parse(File.ReadAllText(Path.Combine(RankClient.DirectoryPath,"Drafts",key+".json")));
        Check(JToken.DeepEquals(saved["units"],RankClient.Draft),"Drag changes were not persisted");
        File.WriteAllText(Path.Combine(Root,"editor-pass.json"),new JObject { ["quantity"]=true,["replaceSingleAndGroup"]=true,["coordinateMappingAndCommit"]=true,
            ["dragPointerVerified"]=PointerVerified,["dragBoundaryCommit"]=true,["savedDraft"]=true,["nativeCanvasDraws"]=Draws,["units"]=RankClient.Draft.DeepClone() }.ToString());
    }
}

