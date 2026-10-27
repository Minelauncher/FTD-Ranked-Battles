using System.Collections.Generic;
using BrilliantSkies.Ftd.Modes.CustomBattleMode;
using Newtonsoft.Json.Linq;

namespace FtdRank
{
    public static class BattleMaterials
    {
        public static JObject Capture(CustomBattleTeam team)
        {
            if (team.Disqualified) return BattleOutcome.MaterialBalance(0, 0);
            double vehicle = 0, supply = team.Faction.InstanceOfFaction.ResourceStore.iMaterial.fQuantity;
            var constructs = new HashSet<MainConstruct>();
            var stores = new HashSet<object>();
            foreach (var v in team.ExistingVehicles)
            {
                if (v.Disqualified || !constructs.Add(v.Construct)) continue;
                // Each drone is already a separate team vehicle. Include turrets/pistons,
                // but neither drones nor resource contents here: both are counted separately.
                vehicle += v.Construct.AllBasics.GetResourceCost(ValueQueryType.AliveSub).Material;
                var force = v.Construct.GetForce();
                if (stores.Add(force)) supply += force.Material.fQuantity;
            }
            return BattleOutcome.MaterialBalance(vehicle, supply);
        }
    }
}
