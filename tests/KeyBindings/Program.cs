using FtdRank;
using Newtonsoft.Json;
using UnityEngine;
static void Check(bool ok, string message) { if (!ok) throw new Exception(message); }
foreach (var language in new[] { "ko", "ja", "en" }) {
 L.Select(language);
 var keys = JsonConvert.DeserializeObject<RankKeyBindings>("{}")!;
 Check(keys.Get(RankAction.FreeCamera) == KeyCode.F6 && keys.TopView == KeyCode.F9 && RankKeyBindings.Actions.All(a=>keys.Modifiers(a)==RankKeyModifiers.Shift), "Defaults must require Shift");
 foreach(var action in RankKeyBindings.Actions) {
  Check(keys.Pressed(k=>k==keys.Get(action),_=>false,false)==null,"Bare function key still triggers ranked shortcut");
  foreach(var shift in new[]{KeyCode.LeftShift,KeyCode.RightShift})
   Check(keys.Pressed(k=>k==keys.Get(action),k=>k==shift,false)==action,"Shift chord did not dispatch");
  Check(keys.Pressed(k=>k==keys.Get(action),k=>k==KeyCode.LeftShift||k==KeyCode.LeftControl,false)==null,"Extra modifier triggered a different chord");
 }
 Check(!keys.TryChange(RankAction.TopView, KeyCode.F6, RankKeyModifiers.Shift, out _, out var error) && error.Contains("Shift+F6"), "Duplicate chord allowed or lacks useful explanation");
 Check(keys.TopView == KeyCode.F9, "Rejected key mutated original");
 var combination=RankKeyModifiers.Control|RankKeyModifiers.Shift;
 Check(keys.TryChange(RankAction.FreeCamera, KeyCode.K, combination, out var updated, out _), "Rebind failed");
 Check(keys.FreeCamera == KeyCode.F6, "Proposed binding mutated live settings");
 Check(updated.Pressed(k => k == KeyCode.K,k=>k==KeyCode.RightShift||k==KeyCode.RightControl,false) == RankAction.FreeCamera, "New chord did not dispatch");
 Check(updated.Pressed(k => k == KeyCode.K,_=>false,false) == null, "Chord accepted without modifiers");
 Check(updated.Pressed(k => k == KeyCode.F6,k=>k==KeyCode.LeftShift,false) == null, "Old key still dispatches");
 Check(updated.Pressed(_ => throw new Exception("Polled input while menu is open"),_=>throw new Exception("Polled held input while menu is open"),true) == null, "Menu did not suppress shortcut");
 var chordReload=JsonConvert.DeserializeObject<RankKeyBindings>(JsonConvert.SerializeObject(updated))!.Normalize();
 Check(chordReload.Modifiers(RankAction.FreeCamera)==combination && chordReload.Label(RankAction.FreeCamera)=="Ctrl+Shift+K","Chord did not survive reload");
 Check(updated.TryChange(RankAction.FreeCamera, KeyCode.None, combination, out updated, out _), "Unbind failed");
 Check(updated.TryChange(RankAction.TopView, KeyCode.None, RankKeyModifiers.None, out updated, out _), "Several disabled keys counted as duplicates");
 var reload = JsonConvert.DeserializeObject<RankKeyBindings>(JsonConvert.SerializeObject(updated))!.Normalize();
 Check(reload.FreeCamera == KeyCode.None && reload.TopView == KeyCode.None, "Disabled setting lost in serialization");
 Check(reload.Pressed(k => k == KeyCode.None || k == KeyCode.K || k == KeyCode.F9,_=>false,false) == null, "Disabled action fires");
 Check(reload.Summary.Contains(L.T("Keys.Disabled")) && !reload.Summary.Contains("F9"), "Help contains stale default");
 foreach(var key in new[]{KeyCode.Escape,KeyCode.Mouse0,KeyCode.LeftShift,KeyCode.RightControl,KeyCode.LeftApple,KeyCode.LeftCommand})
  Check(!keys.TryChange(RankAction.FreeCamera,key,RankKeyModifiers.None,out _,out _),"Reserved/mouse/modifier-only input accepted");
 Check(!keys.TryChange(RankAction.FreeCamera,KeyCode.K,(RankKeyModifiers)128,out _,out _),"Invalid modifiers accepted");
 Check(keys.TryChange(RankAction.TopView,KeyCode.F6,RankKeyModifiers.None,out var plain,out _),"Distinct bare/chord bindings counted as duplicate");
 Check(plain.Pressed(k=>k==KeyCode.F6,_=>false,false)==RankAction.TopView && plain.Pressed(k=>k==KeyCode.F6,k=>k==KeyCode.LeftShift,false)==RankAction.FreeCamera,"Exact modifier matching failed");
 plain=JsonConvert.DeserializeObject<RankKeyBindings>(JsonConvert.SerializeObject(plain))!.Normalize();
 Check(plain.Modifiers(RankAction.TopView)==RankKeyModifiers.None,"Explicit bare binding gained Shift after reload");
 var legacy=JsonConvert.DeserializeObject<RankKeyBindings>("{\"FreeCamera\":287,\"PreviousVehicle\":107,\"NextVehicle\":0,\"TopView\":290}")!.Normalize();
 Check(legacy.Modifiers(RankAction.FreeCamera)==RankKeyModifiers.Shift && legacy.Modifiers(RankAction.PreviousVehicle)==RankKeyModifiers.None && legacy.NextVehicle==KeyCode.None && legacy.Modifiers(RankAction.TopView)==RankKeyModifiers.Shift,"Old defaults/custom/unbound migration failed");
 var damaged = new RankKeyBindings { FreeCamera=KeyCode.K,PreviousVehicle=KeyCode.K,NextVehicle=(KeyCode)99999,TopView=KeyCode.Escape }.Normalize();
 Check(damaged.FreeCamera==KeyCode.K && damaged.PreviousVehicle==KeyCode.None && damaged.NextVehicle==KeyCode.None && damaged.TopView==KeyCode.None,"Invalid or duplicate chords survived");
}
Console.WriteLine("PASS Shift defaults, bare-key suppression, both modifier sides, exact chord matching, duplicates, capture persistence, legacy defaults/custom keys, disable, invalid settings and KO/JA/EN help.");
