using System;
using System.Linq;
using System.Reflection;
using FtdRank;
using HarmonyLib;
using BrilliantSkies.Ftd.Avatar;
using BrilliantSkies.Ftd.Avatar.Interact;
using BrilliantSkies.FromTheDepths.Game.UserInterfaces;
using BrilliantSkies.FromTheDepths.Game.UserInterfaces.InteractiveOverlay;
using BrilliantSkies.Ftd.Constructs.UI;
using BrilliantSkies.Ui.Displayer;
using BrilliantSkies.Ui.Displayer.Types;
using UnityEngine;

public static class InteractionProbe
{
    static void Check(bool ok, string error) { if (!ok) throw new Exception(error); }
    static bool originalRan;
    static void Observe(bool __runOriginal) { originalRan=__runOriginal; }
    static readonly MethodInfo interact=typeof(cInteract).GetInterfaceMap(typeof(I_cInput_cInteract))
        .TargetMethods.Single(m=>m.Name.EndsWith(".Interact"));
    static readonly MethodInfo secondary=AccessTools.Method(typeof(cInteract),"PerformSecondary");
    static void ObserveCall(MethodInfo method, Action call, bool expected)
    {
        const string id="ftdrank.test.interaction";
        var observer=new Harmony(id);
        observer.Patch(method,postfix:new HarmonyMethod(typeof(InteractionProbe),nameof(Observe)));
        try {
            originalRan=!expected; call();
            Check(originalRan==expected,"Interaction original execution differs: "+method.Name);
        } finally { observer.Unpatch(method,HarmonyPatchType.All,id); }
    }
    public static void InArena(MainConstruct friendly)
    {
        Check(RankBattle.InArena,"Interaction test requires ranked arena");
        GuiDisplayer.GetSingleton().CloseAllUis();
        var component=UnityEngine.Object.FindFirstObjectByType<cInteract>();
        Check(component!=null,"Native block interaction component missing");
        var hold=AccessTools.Field(typeof(cInteract),"_qHeldFor");
        var longPress=AccessTools.Field(typeof(cInteract),"_longPressFromHeldButton");
        hold.SetValue(component,1f); longPress.SetValue(component,true);
        ObserveCall(interact,()=>((I_cInput_cInteract)component).Interact(),false);
        Check((float)hold.GetValue(component)==0 && !(bool)longPress.GetValue(component),"Held Q interaction survives ranked guard");
        ObserveCall(secondary,()=>Check(!(bool)secondary.Invoke(component,null),"Block secondary action accepted"),false);
        var overlay=new InteractiveOverlay {Node=OverlayNodeCreator.Create(friendly)};
        Check(overlay.Node!=null,"Could not arrange friendly vehicle overlay");
        Check(!overlay.AcquireTarget() && overlay.Node==null,"Q overlay acquired vehicle in ranked arena");
        var uis=new IGui_GuiSystem[]{new InteractiveOverlayGui(),new AiControlUi(new AiControl()),
            new ConstructableInfoUi(new ConstructInfo(friendly)),FleetControlGUI.Instance};
        foreach(var ui in uis) {
            foreach(var mode in new[]{GuiActivateType.Standard,GuiActivateType.Stack})
                Check(!GuiDisplayBase.GetInternal().ActivateUi(ui,mode),"Ranked control UI opened: "+ui.GetType().Name);
            Check(!GuiDisplayBase.GetInternal().ActivateUiToggle(ui,GuiActivateType.Stack,GuiActivateToggleType.Type),
                "Ranked control UI toggle accepted: "+ui.GetType().Name);
        }
        Check(!GuiDisplayer.HasOpenWindow,"Blocked vehicle/AI UI entered the GUI stack");
        // InspectArena already opens and checks the native camera editor with these guards active.
        // Opening it again in this frame hits FTD's 0.2-second editor debounce.
        RankSpectator.Overview();
    }
    public static void OutsideArena()
    {
        Check(!RankBattle.InArena,"Interaction guard did not exit ranked arena");
        var ai=new AiControlUi(new AiControl());
        Check(GuiDisplayBase.GetInternal().ActivateUi(ai,GuiActivateType.Stack),"AI UI remains blocked outside ranked");
        GuiDisplayer.GetSingleton().CloseAllUis();
        var component=UnityEngine.Object.FindFirstObjectByType<cInteract>();
        if(component!=null) ObserveCall(secondary,()=>secondary.Invoke(component,null),true);
    }
}
