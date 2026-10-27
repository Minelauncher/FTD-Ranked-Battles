using System;
using System.Linq;
using System.IO;
using FtdRank;
using Newtonsoft.Json.Linq;

static class Program
{
    static void Check(bool value, string message) { if (!value) throw new Exception(message); }
    static void Near(double a, double b, string message) => Check(Math.Abs(a-b) <= .0011, message + ": " + a + " != " + b);
    static void Reject(Action action) { bool failed = false; try { action(); } catch (InvalidOperationException) { failed = true; } Check(failed, "Invalid edit accepted"); }
    static JObject Unit(char hash, int i) => new JObject { ["hash"] = new string(hash,64), ["name"] = "Ship " + hash, ["cost"] = 10000,
        ["x"] = i*45-90, ["z"] = -i*65, ["altitude"] = 10+i*20, ["yaw"] = i*15 };
    static void Main()
    {
        var rules = JObject.Parse("{maxUnits:20,maxBlueprints:3,teamBudget:100000,formationHalfWidth:500,formationDepth:1000,minAltitude:-100,maxAltitude:500}");
        var units = new JArray(Unit('a',0),Unit('b',1),Unit('a',2),Unit('a',3)); var original = units.DeepClone(); string a = new string('a',64);
        var budgetFleet = new JObject { ["units"] = units.DeepClone(), ["spawnCost"] = 40000, ["supply"] = 60000 };
        Near(FleetPlan.SubmittedSupply(budgetFleet, rules), 60000, "Submitted starting supply");
        foreach (string field in new[] { "spawnCost", "supply" }) {
            var broken = (JObject)budgetFleet.DeepClone(); broken[field] = (double)broken[field] + 1;
            Reject(() => FleetPlan.SubmittedSupply(broken, rules));
            broken[field] = double.NaN; Reject(() => FleetPlan.SubmittedSupply(broken, rules));
            broken.Remove(field); Reject(() => FleetPlan.SubmittedSupply(broken, rules));
        }
        var altered = (JObject)budgetFleet.DeepClone(); altered["units"][0]["cost"] = 1;
        Reject(() => FleetPlan.SubmittedSupply(altered, rules));
        altered = (JObject)budgetFleet.DeepClone(); altered["spawnCost"] = 100001; altered["supply"] = -1;
        altered["units"][0]["cost"] = 70001; Reject(() => FleetPlan.SubmittedSupply(altered, rules));
        altered = (JObject)budgetFleet.DeepClone(); altered["units"][0]["cost"] = 70000; altered["spawnCost"] = 100000; altered["supply"] = 0;
        Near(FleetPlan.SubmittedSupply(altered, rules), 0, "Exact-budget fleet");
        Reject(() => FleetPlan.SubmittedSupply(null, rules));
        Check(FleetPlan.SamePlacement(units,(JArray)original),"Restored server fleet appears edited");
        var draft=(JArray)original.DeepClone(); draft[0]["x"]=(double)draft[0]["x"];
        Check(FleetPlan.SamePlacement(draft,units),"Integer/float serialization appears edited");
        foreach(string key in new[]{"x","z","altitude","yaw"}) {
            draft=(JArray)original.DeepClone(); draft[0][key]=(double)draft[0][key]+1;
            Check(!FleetPlan.SamePlacement(draft,units),"Edited formation appears submitted: "+key);
        }
        Check(!FleetPlan.SamePlacement(units,null),"Missing submission appears saved");
        var more = FleetPlan.WithQuantity(units,a,8,rules);
        Check(!FleetPlan.SamePlacement(more,units),"Edited quantity appears submitted");
        Check(more.Count==9 && more.Count(u=>(string)u["hash"]==a)==8,"Group quantity");
        for(int i=0;i<units.Count;i++) Check(JToken.DeepEquals(more[i],units[i]),"Quantity moved an existing unit");
        Check(more.Skip(4).Select(u=>u["x"]+"/"+u["z"]).Distinct().Count()==5,"New placements overlap each other");
        var less = FleetPlan.WithQuantity(units,a,1,rules);
        Check(less.Count==2 && JToken.DeepEquals(less[0],units[0]) && JToken.DeepEquals(less[1],units[1]),"Shrink did not keep earliest placements");
        Check(FleetPlan.WithQuantity(units,a,0,rules).Count==1,"Zero quantity");
        Reject(()=>FleetPlan.WithQuantity(units,a,21,rules)); Reject(()=>FleetPlan.WithQuantity(units,a,-1,rules));
        Reject(()=>FleetPlan.WithQuantity(units,new string('e',64),1,rules));
        var replacement=Unit('c',8); replacement["cost"]=20000;
        foreach(bool all in new[]{false,true})
        {
            var changed=FleetPlan.WithBlueprint(units,2,replacement,all,rules);
            for(int i=0;i<units.Count;i++)
            {
                foreach(string key in new[]{"x","z","altitude","yaw"}) Check(JToken.DeepEquals(changed[i][key],units[i][key]),"Replacement lost placement: "+key);
                bool affected=i==2 || (all && (string)units[i]["hash"]==a);
                Check((string)changed[i]["hash"]==(affected?(string)replacement["hash"]:(string)units[i]["hash"]),"Wrong replacement scope");
            }
            Near(FleetPlan.Cost(changed),all?70000:50000,"Replacement cost");
        }
        var tight=(JObject)rules.DeepClone(); tight["maxBlueprints"]=2;
        Reject(()=>FleetPlan.WithBlueprint(units,2,replacement,false,tight));
        Check(FleetPlan.WithBlueprint(units,2,replacement,true,tight).Count==4,"Whole-group replacement should fit type cap");
        Check(JToken.DeepEquals(original,units),"Source draft mutated by edits or failures");
        foreach(var dimensions in new[]{(800d,300d,500d,1000d),(280d,600d,0d,1000d),(500d,250d,500d,0d),(100d,100d,0d,0d),(480d,200d,.125d,.375d)})
        {
            var (w,h,half,depth)=dimensions; var map=new FormationMap(23,41,w,h,half,depth);
            foreach(double x in new[]{-half,0,half}) foreach(double z in new[]{0,-depth/2,-depth})
            { Near(map.WorldX(map.ScreenX(x)),x,"X roundtrip"); Near(map.WorldZ(map.ScreenY(z)),z,"Z roundtrip"); }
            Check(map.ScreenY(0)<=map.ScreenY(-depth),"Front should be at top");
            Near(map.WorldX(-1e6),-half,"Left clamp"); Near(map.WorldX(1e6),half,"Right clamp");
            Near(map.WorldZ(-1e6),0,"Front clamp"); Near(map.WorldZ(1e6),-depth,"Rear clamp");
        }
        var snap=new FormationMap(0,0,600,300,500,1000);
        Near(snap.SnapX(126.7,10),130,"Shift snap"); Near(snap.SnapZ(-126.7,10),-130,"Negative snap"); Near(snap.SnapX(126.735,0),126.735,"Free move");
        var submitted=new JObject { ["fleet"]=new JObject { ["name"]="제출 편대", ["units"]=units.DeepClone() } };
        var ticket=new JObject { ["ownerFleet"]=new JObject { ["name"]="매칭 편대", ["units"]=units.DeepClone() } };
        Check(ReferenceEquals(FleetPresentation.ForMatch(null,submitted),submitted["fleet"]),"Pre-match preview must use submitted fleet");
        Check(ReferenceEquals(FleetPresentation.ForMatch(ticket,submitted),ticket["ownerFleet"]),"Issued match must keep its original fleet");
        Check(FleetPresentation.Composition((JObject)submitted["fleet"]).Contains("Ship a ×3"),"Preview quantity lost");
        Check(FleetPresentation.CheckedName("  Ａ 함대  ")=="A 함대","Fleet name normalization");
        Check(FleetPresentation.CheckedName(new string('함',40)).Length==40,"40-character fleet name rejected");
        Reject(()=>FleetPresentation.CheckedName(" ")); Reject(()=>FleetPresentation.CheckedName(new string('a',41))); Reject(()=>FleetPresentation.CheckedName("a\nb"));
        foreach(double maximum in new[]{11d,19d}) foreach(double east in new[]{0,maximum/2,maximum}) foreach(double north in new[]{0,maximum/2,maximum}) foreach(double zoom in new[]{1d,8d}) {
            var view=new BattlefieldView(east,north,maximum,zoom);
            Check(view.Left>=0&&view.Top>=0&&view.Left+view.Size<=1&&view.Top+view.Size<=1,"Terrain crop leaves map");
            Check(view.MarkerX>=0&&view.MarkerX<=1&&view.MarkerY>=0&&view.MarkerY<=1,"Terrain marker leaves viewport");
            Near(view.Left+view.MarkerX*view.Size,east/maximum,"Map east orientation");
            Near(view.Top+view.MarkerY*view.Size,1-north/maximum,"Map north orientation");
        }
        string root=Path.Combine(Path.GetTempPath(),"ftd-match-storage-"+Guid.NewGuid().ToString("N")), mid=new string('1',32);
        Directory.CreateDirectory(Path.Combine(root,"Matches",mid)); Directory.CreateDirectory(Path.Combine(root,"FleetBlueprints"));
        File.WriteAllText(Path.Combine(root,"pending-result.json"),"retry me");
        File.WriteAllText(Path.Combine(root,"FleetBlueprints","own.blueprint"),"keep me");
        File.WriteAllText(Path.Combine(root,"Matches",mid,new string('a',64)+".blueprint"),"download");
        File.WriteAllText(Path.Combine(root,"Matches",mid,"result.json"),"temporary");
        Check(!MatchStorage.Clear(root,"../FleetBlueprints"),"Traversal accepted");
        Check(MatchStorage.Clear(root,mid),"Finished-match files not removed");
        Check(File.Exists(Path.Combine(root,"pending-result.json"))&&File.Exists(Path.Combine(root,"FleetBlueprints","own.blueprint")),"Cleanup deleted retry result or own BP");
        Directory.CreateDirectory(Path.Combine(root,"Matches",mid));
        File.WriteAllText(Path.Combine(root,"Matches",mid,new string('a',64)+".blueprint"),"crash leftovers");
        File.WriteAllText(Path.Combine(root,"Matches",mid,"personal.txt"),"unrelated");
        MatchStorage.Sweep(root);
        Check(!File.Exists(Path.Combine(root,"Matches",mid,new string('a',64)+".blueprint")),"Crash BP left behind");
        Check(File.Exists(Path.Combine(root,"Matches",mid,"personal.txt")),"Unknown file deleted");
        Check(Path.GetFullPath(root).StartsWith(Path.GetFullPath(Path.GetTempPath()),StringComparison.OrdinalIgnoreCase),"Unexpected test path");
        Directory.Delete(root,true);
        Console.WriteLine("PASS: named submitted/matched fleet preview, north-up terrain crops, safe match cleanup preserving own BP and queued results.");
        Console.WriteLine("PASS: quantities, stable placements, atomic limits, single/all BP replacement, costs, map orientation, resize/degenerate bounds, drag clamp and snap.");
        Console.WriteLine("PASS: submitted budget/supply consistency, changed costs, invalid or missing numbers, over-budget and exact-budget fleets.");
    }
}
