using System.Linq;
using System.Reflection;
using HarmonyLib;
using BrilliantSkies.Ftd.Avatar;
using BrilliantSkies.Ftd.Avatar.Interact;
using BrilliantSkies.FromTheDepths.Game.UserInterfaces.InteractiveOverlay;

namespace FtdRank
{
    // Q tap/hold share this action after the game's key mapping has been resolved.
    // Keep block observation and all camera input alive, but never execute interaction.
    [HarmonyPatch]
    static class RankedBlockInteractionGuard
    {
        static MethodBase TargetMethod() => typeof(cInteract).GetInterfaceMap(typeof(I_cInput_cInteract))
            .TargetMethods.Single(m => m.Name.EndsWith(".Interact"));
        static bool Prefix(ref float ____qHeldFor, ref bool ____longPressFromHeldButton, I_cInteract_HUD ____i_cInteract_HUD)
        {
            if (!RankBattle.InArena) return true;
            ____qHeldFor = 0;
            ____longPressFromHeldButton = false;
            ____i_cInteract_HUD?.SetQHeldForFraction(0);
            ____i_cInteract_HUD?.SetContextualInteract(false);
            return false;
        }
    }

    [HarmonyPatch(typeof(cInteract), "PerformSecondary")]
    static class RankedBlockSecondaryGuard
    {
        static bool Prefix(ref bool __result)
        {
            if (!RankBattle.InArena) return true;
            __result = false;
            return false;
        }
    }

    [HarmonyPatch(typeof(InteractiveOverlay), nameof(InteractiveOverlay.AcquireTarget))]
    static class RankedOverlayGuard
    {
        static bool Prefix(InteractiveOverlay __instance, ref bool __result)
        {
            if (!RankBattle.InArena) return true;
            __instance.Node = null;
            __result = false;
            return false;
        }
    }
}
