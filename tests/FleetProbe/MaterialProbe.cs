using System;
using System.Linq;
using BrilliantSkies.Ftd.Modes.CustomBattleMode;
using FtdRank;
using Newtonsoft.Json.Linq;

static class MaterialProbe
{
    public static readonly JArray Report=new JArray();
    static void Require(bool ok,string message) { if(!ok)throw new Exception("Material probe: "+message); }
    public static void Check(CustomBattleModeState state)
    {
        foreach(var team in state.Teams)
        {
            var before=BattleMaterials.Capture(team);
            Require(Math.Abs((double)before["supply"]-team.GetMaterials(state.Settings))<.1,"Native supply mismatch");
            Require((double)before["vehicle"]>0 && (double)before["total"]>0,"Spawn value missing");
            // Traverse actual live block items independently, including nested turrets.
            double independent=0;
            foreach(var v in team.ExistingVehicles)
            {
                var main=v.Construct;
                independent+=main.AllBasics.AliveAndDead.Blocks.Take(main.AllBasics.AliveAndDead.Count).Where(b=>b!=null&&b.IsAlive).Sum(b=>(double)b.item.Cost.Material);
                foreach(var sub in main.AllBasics.AllSubconstructsBelowUs)
                    independent+=sub.AllBasics.AliveAndDead.Blocks.Take(sub.AllBasics.AliveAndDead.Count).Where(b=>b!=null&&b.IsAlive).Sum(b=>(double)b.item.Cost.Material);
            }
            Require(Math.Abs(independent-(double)before["vehicle"])<.1,"Alive block material sum mismatch");
            // Native reserve consumption must lower the score without changing vehicle value.
            var reserve=team.Faction.InstanceOfFaction.ResourceStore.iMaterial;
            float saved=reserve.fQuantity;
            reserve.fQuantity=saved+123.25f;
            var increased=BattleMaterials.Capture(team);
            Require(Math.Abs((double)increased["total"]-(double)before["total"]-123.25)<.1,"Reserve ignored or doubled");
            reserve.fQuantity=saved;
            // A duplicated drone/main reference must not inflate the score.
            var first=team._vehicles.First();team._vehicles.Add(first);
            var duplicate=BattleMaterials.Capture(team);team._vehicles.RemoveAt(team._vehicles.Count-1);
            Require(JToken.DeepEquals(duplicate,before),"Duplicate vehicle double counted");
            var block=first.Construct.AllBasics.AliveAndDead.Blocks.Take(first.Construct.AllBasics.AliveAndDead.Count)
                .Last(b=>b!=null&&b.IsAlive&&b.item.Cost.Material>0);
            float health=block.CurrentHealth;
            block.SetCurrentHealth(block.MaximumHealth*.5f);
            Require((double)BattleMaterials.Capture(team)["vehicle"]==(double)before["vehicle"],"Partial HP discounted material value");
            block.SetCurrentHealth(health);
            block.SetCurrentHealth(0);block.SeparateBlock(null,true,true);
            var damaged=BattleMaterials.Capture(team);
            Require((double)damaged["vehicle"]<(double)before["vehicle"],"Destroyed block still counted");
            Report.Add(new JObject { ["before"]=before,["afterDestroyedBlock"]=damaged,["nativeSupplyChecked"]=true,
                ["independentLiveBlockCost"]=independent,["duplicateNotCounted"]=true,["partialHpKeepsCost"]=true,["reserveDeltaChecked"]=true });
        }
    }
}
