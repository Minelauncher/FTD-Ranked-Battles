using FtdRank;
using System.Text;
using System.Text.Json;

static void Check(bool ok,string name) { if(!ok)throw new Exception(name); }
var root=Path.Combine(Path.GetTempPath(),"RankStorage-"+Guid.NewGuid().ToString("N"),"한글 日本語 café path");
Directory.CreateDirectory(root);
var mod=Path.Combine(root,"Mods","RankedBattles");
var saves=Path.Combine(root,"Custom SaveLocation");
string hash=new string('a',64);
try {
 Check(ClientStorage.Open(mod,saves)==Path.GetFullPath(mod),"Writable mod location changed");
 Check(!Directory.Exists(Path.Combine(saves,"RankedBattles")),"Unneeded fallback created");
 var config=Path.Combine(mod,"client.json");
 ClientStorage.WriteText(config,"{\"name\":\"한글・日本語・café\"}");
 Check(ClientStorage.ReadText(config)=="{\"name\":\"한글・日本語・café\"}","Unicode roundtrip");
 Check(!File.ReadAllBytes(config).Take(3).SequenceEqual(Encoding.UTF8.GetPreamble()),"Unexpected BOM");
 Parallel.For(0,24,i=>ClientStorage.WriteText(config,JsonSerializer.Serialize(new {id=i,text=new string((char)('A'+i),4096)})));
 var json=JsonDocument.Parse(ClientStorage.ReadText(config));
 Check(json.RootElement.GetProperty("text").GetString()==new string((char)('A'+json.RootElement.GetProperty("id").GetInt32()),4096),"Concurrent write torn");
 Check(Directory.GetFiles(mod,"*.tmp").Length==0,"Write temporary files leaked");
 var old=ClientStorage.ReadText(config);
 try { ClientStorage.CommitWithRename(Path.Combine(root,"absent.tmp"),config); throw new Exception("Missing replacement accepted"); }
 catch(FileNotFoundException) { }
 Check(ClientStorage.ReadText(config)==old,"Rename failure lost old state");
 var next=Path.Combine(mod,"complete.tmp");File.WriteAllText(next,"new state");
 ClientStorage.CommitWithRename(next,config);Check(ClientStorage.ReadText(config)=="new state","Rename commit");
 File.Move(config,config+".bak");File.WriteAllText(config+".unfinished.tmp","truncated");
 Check(ClientStorage.ReadText(config)=="new state","Interrupted rename did not recover");
 if(OperatingSystem.IsWindows()) {
  using(var locked=new FileStream(config,FileMode.Open,FileAccess.Read,FileShare.None)) {
   try { ClientStorage.WriteText(config,"must not overwrite");throw new Exception("Locked file overwritten"); }
   catch(IOException) { }
  }
  Check(ClientStorage.ReadText(config)=="new state","Locked destination lost data");
 }
 var blocked=Path.Combine(root,"cannot-be-a-directory");File.WriteAllText(blocked,"occupied");
 var fallback=ClientStorage.Open(blocked,saves);
 Check(fallback==Path.Combine(saves,"RankedBattles"),"Unwritable installation has no fallback");
 var isolated=ClientStorage.Open(null,Path.Combine(root,"Isolated SaveLocation"));
 Check(isolated!=fallback && File.Exists(Path.Combine(isolated,".storage-ready")),"Empty Assembly.Location or SaveLocation isolation");
 var importSaves=Path.Combine(root,"Import SaveLocation");Directory.CreateDirectory(Path.Combine(importSaves,"RankedBattles"));
 var pending=Path.Combine(mod,"pending-result.json");File.WriteAllText(pending,"{\"score\":1}");
 Directory.CreateDirectory(Path.Combine(mod,"Drafts"));Directory.CreateDirectory(Path.Combine(mod,"FleetBlueprints"));
 var bp=Path.Combine(mod,"FleetBlueprints",hash+".blueprint");var bpBytes=Encoding.UTF8.GetBytes("{\"Name\":\"日本語 함대\"}");File.WriteAllBytes(bp,bpBytes);
 File.WriteAllText(Path.Combine(mod,"Drafts",hash+".json"),"{\"name\":\"편대\"}");
 File.WriteAllText(Path.Combine(mod,"0Harmony.dll"),"not state");
 var imported=ClientStorage.Open(mod,importSaves);
 Check(File.ReadAllBytes(Path.Combine(imported,"client.json")).SequenceEqual(File.ReadAllBytes(config)),"Account bytes changed");
 Check(File.ReadAllBytes(Path.Combine(imported,"FleetBlueprints",hash+".blueprint")).SequenceEqual(bpBytes),"Blueprint hash changed");
 Check(File.Exists(Path.Combine(imported,"Drafts",hash+".json")) && File.Exists(pending),"Draft omitted or source removed");
 Check(!File.Exists(Path.Combine(imported,"0Harmony.dll")),"DLL imported as state");
 File.Copy(Path.Combine(imported,"pending-result.json"),Path.Combine(imported,"pending-result.json.bak"));
 ClientStorage.Delete(Path.Combine(imported,"pending-result.json"));
 Check(ClientStorage.ReadText(Path.Combine(imported,"pending-result.json"))==null,"Acknowledged result recovered from stale backup");
 Check(ClientStorage.Open(mod,importSaves)==imported && !File.Exists(Path.Combine(imported,"pending-result.json")),"Acknowledged result resurrected or storage switched back");
 var matchId=new string('b',32);var match=Path.Combine(imported,"Matches",matchId);Directory.CreateDirectory(match);
 File.WriteAllBytes(Path.Combine(match,hash+".blueprint"),bpBytes);
 File.WriteAllText(Path.Combine(match,hash+".blueprint."+Guid.NewGuid().ToString("N")+".tmp"),"partial");
 File.WriteAllText(Path.Combine(match,"result.json.bak"),"old result");
 File.WriteAllText(Path.Combine(match,"user-note.txt"),"keep");
 Check(!MatchStorage.Clear(imported,matchId) && Directory.GetFiles(match).Length==1,"Temporary cleanup touched unrelated files or kept owned leftovers");
 Check(!MatchStorage.Clear(imported,"../"+matchId),"Traversal accepted");
 ClientStorage.Log(blocked,new Exception("Cannot log here"));
 try { ClientStorage.Open(null,"relative-folder");throw new Exception("Relative save root accepted"); } catch(IOException) { }
 Console.WriteLine("PASS storage: Unicode paths/UTF-8, concurrent writes, rename rollback/crash recovery, locked files, read-only fallback, state import, isolated roots, no result resurrection, scoped cleanup and failed logging.");
} finally {
 // Own unique temporary tree only; never recurse over a user or game directory.
 var owned=Path.GetFullPath(Path.GetDirectoryName(root)!);
 Check(owned.StartsWith(Path.GetFullPath(Path.GetTempPath()),StringComparison.Ordinal) && System.Text.RegularExpressions.Regex.IsMatch(Path.GetFileName(owned), @"\ARankStorage-[a-f0-9]{32}\z"),"Unsafe test cleanup path");
 Directory.Delete(owned,true);
}
