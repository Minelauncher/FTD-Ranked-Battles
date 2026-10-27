using FtdRank;
using Newtonsoft.Json.Linq;
using System.Globalization;
using System.Text.RegularExpressions;
static void Check(bool ok, string message) { if (!ok) throw new Exception(message); }
var culture = CultureInfo.CurrentCulture.Name;
using var reader = new StreamReader(typeof(L).Assembly.GetManifestResourceStream("FtdRank.Languages.json")!);
var catalog = JObject.Parse(reader.ReadToEnd());
var userName = "랭크전 / Ranked Battles";
var fleet = new JObject { ["name"] = userName };
var registration = new AccountForm { Mode="register", Username="pilot_123", Nickname="パイロット", Password="example88", Confirm="example88" };
// Same raw server error is rendered again after every flag change, without a new request.
var versionError = "모드 업데이트가 필요합니다. 서버 최소 버전: 0.7.2 / 통신 규격: 1";
var pageResponse = new JObject { ["page"]=2, ["total"]=205, ["pageSize"]=100, ["totalPages"]=3,
 ["accounts"]=new JArray(Enumerable.Range(101,100).Select(rank=>new JObject { ["rank"]=rank })) };
var rankingPage = RankingPage.Read(pageResponse);
Check(rankingPage.First == 101 && rankingPage.Last == 200 && rankingPage.HasPrevious && rankingPage.HasNext, "Middle page bounds/navigation failed");
var emptyPage = RankingPage.Read(new JObject { ["page"]=1, ["total"]=0, ["pageSize"]=100, ["totalPages"]=1, ["accounts"]=new JArray() });
Check(emptyPage.First == 0 && emptyPage.Last == 0 && !emptyPage.HasPrevious && !emptyPage.HasNext, "Empty page has navigation");
var finalPage = RankingPage.Read(new JObject { ["page"]=3, ["total"]=205, ["pageSize"]=100, ["totalPages"]=3, ["accounts"]=new JArray(Enumerable.Range(201,5)) });
Check(finalPage.First == 201 && finalPage.Last == 205 && finalPage.HasPrevious && !finalPage.HasNext, "Last partial page bounds failed");
foreach (var invalid in new[] { new JObject(), (JObject)pageResponse.DeepClone(), (JObject)pageResponse.DeepClone() }.Select((r,i)=> { if(i==1)r["page"]=4; if(i==2)r["accounts"]=new JArray(); return r; })) {
 bool rejected=false; try { RankingPage.Read(invalid); } catch (Newtonsoft.Json.JsonException) { rejected=true; }
 Check(rejected,"Invalid ranking response was accepted");
}
foreach (string language in new[] { "ko", "ja", "en" }) {
 L.Select(language);
 Check(rankingPage.Summary == L.F("Ranking.Page",2,3) && rankingPage.Range == L.F("Ranking.Range",101,200,205), "Ranking did not follow flag changes");
 foreach (var entry in catalog.Properties()) {
  Check(entry.Value[language]?.Type == JTokenType.String && ((string)entry.Value[language]!).Length > 0, "Missing translation: " + entry.Name);
  Check(Regex.Matches((string)entry.Value["ko"]!, @"\{\d+[^}]*\}").Select(m=>m.Value).Order().SequenceEqual(Regex.Matches((string)entry.Value[language]!, @"\{\d+[^}]*\}").Select(m=>m.Value).Order()), "Format placeholders differ: " + entry.Name);
  L.F(entry.Name, Enumerable.Repeat<object>(10.5, 12).ToArray());
 }
 Check(registration.ValidationError() == null, "Language changed valid credentials");
 Check(registration.Nickname == "パイロット", "Language changed nickname");
 Check(FleetPresentation.Name(fleet) == userName, "User fleet name translated as a UI key");
 Check(L.F("기체 / Unit {0}", userName).Contains(userName), "Format argument was translated");
 Check(L.Message("아이디 또는 비밀번호가 올바르지 않습니다.") != (language == "ko" ? "" : "아이디 또는 비밀번호가 올바르지 않습니다."), "Server login error not translated");
 var update = L.Message(versionError);
 Check(update == L.F("Client.UpdateRequired", "0.7.2", "1"), "Version rejection did not follow the selected flag");
 Check(update.Contains("Content → Mods → Download"), "Version rejection lost update instructions");
 Check(L.Message("모드 업데이트가 필요합니다. 서버 최소 버전: 12.34.56789 / 통신 규격: 25") == L.F("Client.UpdateRequired", "12.34.56789", "25"), "Version or protocol requirement was hardcoded");
 foreach (string other in new[] { "Example: " + versionError, versionError + " extra", "모드 업데이트가 필요합니다. 서버 최소 버전: unknown / 통신 규격: 1" })
  Check(L.Message(other) == other, "Unknown status was rewritten as a version rejection");
 Check(CultureInfo.CurrentCulture.Name == culture, "Global culture changed");
 Check(L.T("A user-defined event / 名称") == "A user-defined event / 名称", "Unknown text was altered");
 registration.Confirm = "different99";
 Check(registration.ValidationError() == L.T("비밀번호가 서로 다릅니다. / Passwords do not match."), "Validation message not translated");
 registration.Confirm = registration.Password;
 foreach (var address in new[] { "", "   ", "Pilot+rank@Example.COM", " name@example.com " }) {
  registration.Email = address; Check(registration.ValidationError() == null, "Optional signup email rejected: " + address);
 }
 foreach (var address in new[] { "missing-domain@", "two@@example.com", "a@example.com\nother", "a@localhost", new string('a', 250) + "@example.com" }) {
  registration.Email = address; Check(registration.ValidationError() == L.T("Recovery.InvalidEmail"), "Invalid signup email accepted");
 }
 registration.Email = "";
}
L.Select("invalid"); Check(L.Language == "en", "Invalid saved language has no fallback");
Console.WriteLine($"PASS {catalog.Count} translations × 3 languages: version rejection follows flag changes with dynamic version/protocol and update instructions; format integrity, validation, preserved user text and unchanged global culture.");
