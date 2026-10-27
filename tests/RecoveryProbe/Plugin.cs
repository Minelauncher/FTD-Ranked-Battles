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
using BrilliantSkies.Ui.Consoles.Interpretters.Subjective.Buttons;
using BrilliantSkies.Ui.Consoles.Interpretters.Subjective.Texts;
using Newtonsoft.Json.Linq;
using UnityEngine;

// Actual FTD account controls, isolated save, mocked transport. Never sends mail.
public sealed class RecoveryProbe : GamePlugin
{
 public string name=>"Recovery UI probe"; public Version version=>new Version(0,1);
 static string root,route,token; static JObject body; static int stage,requests;
 static TaskCompletionSource<JObject> pending; static float deadline;
 static int signupCase;
 static string captureOutput, pendingShot; static float nextShot;
 static void PreviewAccount(){
  RankClient.Connected=true;
  RankClient.Me=new JObject{["id"]="preview-account",["name"]="Sky Captain",["nicknameColor"]="#65C5FF"};
  RankClient.Auth=new JObject{["username"]="sky_captain",["recoveryEmail"]="captain@example.com",["emailVerified"]=true};
 }
 static void PreviewTab(){
  RankClient.Status="";RankClient.RefreshUi();RankClient.FocusTab(L.T("계정"));
  foreach(var w in RankClient.Ui.Windows)AccessTools.Field(typeof(ConsoleWindow),"_scroll").SetValue(w,Vector2.zero);
  nextShot=Time.realtimeSinceStartup+3;
 }
 static bool Shot(string name){
  var file=Path.Combine(captureOutput,name+".png");
  if(pendingShot==name){if(!File.Exists(file))throw new Exception("Screenshot not rendered: "+name);pendingShot=null;return true;}
  ScreenCapture.CaptureScreenshot(file);pendingShot=name;nextShot=Time.realtimeSinceStartup+1;return false;
 }
 static void CaptureUpdate(){
  if(Time.realtimeSinceStartup<nextShot)return;
  switch(stage){
   case 0:
    RankClient.Settings.Server="http://127.0.0.1:1";RankClient.Settings.Connections.Clear();
    PreviewAccount();L.Select("ko");RankClient.Open(false);stage=40;nextShot=Time.realtimeSinceStartup+2;break;
   case 40:
    if(!RankClient.Ui.Windows.Any())return;Form.Mode="login";PreviewTab();stage=41;break;
   case 41:
    if(!Shot("01-account-ko"))return;RankClient.SetLanguage("en");PreviewTab();stage=42;break;
   case 42:
    if(!Shot("02-account-en"))return;RankClient.Connected=false;RankClient.Auth=RankClient.Me=null;
    Form.ClearSecrets();Form.Mode="register";Form.Username="";Form.Nickname="";Form.Email="";RankClient.SetLanguage("ko");PreviewTab();stage=43;break;
   case 43:
    if(!Shot("03-register-ko"))return;RankClient.SetLanguage("en");PreviewTab();stage=44;break;
   case 44:
    if(!Shot("04-register-en"))return;PreviewAccount();RankClient.Auth["recoveryEmail"]=null;RankClient.Auth["emailVerified"]=false;
    Form.ClearSecrets();Form.Mode="email";Form.Email="captain@example.com";Form.EmailChallenge="preview-code";Form.EmailNotice="Registration.EmailSent";
    RankClient.SetLanguage("ko");PreviewTab();stage=45;break;
   case 45:
    if(!Shot("05-verification-ko"))return;
    File.WriteAllText(Path.Combine(root,"recovery-pass.txt"),"PASS actual FTD UI screenshots at "+Screen.width+"x"+Screen.height+". Isolated demo account, muted; no live requests or emails.\n");stage=99;Application.Quit();break;
  }
 }
 static JObject SignupAccount()=>new JObject{["token"]="signup-token-"+signupCase,["account"]=new JObject{["id"]="signup-"+signupCase,["name"]="Signup Fixture"},["auth"]=new JObject{["username"]="signup_fixture"}};
 static bool Field(string key)=>Window.Screen.Segments.SelectMany(s=>s.Interpretters).OfType<TextInput<AccountForm>>().Any(f=>f.GetDisplayString()==L.T(key));
 static void StartSignup(){
  RankClient.Connected=false;RankClient.Me=RankClient.Auth=null;Form.ClearSecrets();Form.Mode="login";Form.Email="";RankClient.RefreshUi();Click("회원가입 / Register");
  foreach(var language in new[]{"en","ko","ja"}){RankClient.SetLanguage(language);Check(Field("Registration.EmailOptional"),"Missing optional email field: "+language);}RankClient.SetLanguage("en");
  Form.Username="signup_fixture";Form.Nickname="Signup Fixture";Form.Password=Form.Confirm="fixture-password";
  if(signupCase==1){Form.Email="wrong@@example.com";int before=requests;Click("가입 완료 / Create account");Check(!RankClient.Busy&&requests==before,"Invalid signup email reached server");}
  Form.Email=signupCase==0?"":"signup@example.com";Click("가입 완료 / Create account");stage=21;
 }
 static void Finish(){
  File.WriteAllText(Path.Combine(root,"recovery-pass.txt"),"PASS actual FTD account controls: EN/KO/JA recovery; optional signup email; no-email signup sends no mail; invalid email blocked before signup; account/session saved before mail; signup code screen requires no repeated password; verified email applied; quota rejection and network failure preserve account and offer retry. Hidden, muted, mocked network; no real mail or user state.\n");stage=99;Application.Quit();
 }
 public void OnSave(){}
 public void OnLoad(){
  root=Path.GetFullPath(Path.Combine(Path.GetDirectoryName(typeof(RecoveryProbe).Assembly.Location),"../../../.."));
  var captureSettings=Path.Combine(root,"account-capture.json");
  if(File.Exists(captureSettings))captureOutput=(string)JObject.Parse(File.ReadAllText(captureSettings))["output"];
  Application.runInBackground=true;
  new Harmony("ftdrank.test.recovery").Patch(AccessTools.Method(typeof(RankTransport),nameof(RankTransport.Request)),prefix:new HarmonyMethod(typeof(RecoveryProbe),nameof(Request)));
  GameEvents.UpdateEvent.RegWithEvent(Update);deadline=Time.realtimeSinceStartup+90;
 }
 static bool Request(string route,string token,object body,ref Task<JObject> __result){
  if(captureOutput!=null){__result=Task.FromException<JObject>(new Exception("Preview session: network disabled"));return false;}
  RecoveryProbe.route=route;RecoveryProbe.token=token;RecoveryProbe.body=body==null?new JObject():JObject.FromObject(body);requests++;
  pending=new TaskCompletionSource<JObject>();__result=pending.Task;return false;
 }
 static ConsoleWindow Window=>RankClient.Ui.Windows.First(); static AccountForm Form=>RankClient.Ui.Account;
 static void Check(bool value,string message){if(!value)throw new Exception(message);}
 static SubjectiveButton<MainMenu>[] Buttons(string key)=>Window.Screen.Segments.SelectMany(s=>s.Interpretters).OfType<SubjectiveButton<MainMenu>>().Where(b=>b.GetDisplayString()==L.T(key)).ToArray();
 static void Click(string key){var b=Buttons(key).FirstOrDefault();Check(b!=null,"Missing native button: "+key);((Action<MainMenu>)AccessTools.Field(b.GetType(),"_fnEffect").GetValue(b))(new MainMenu());}
 static void Languages(string key){foreach(var lang in new[]{"en","ko","ja"}){RankClient.SetLanguage(lang);Check(Buttons(key).Length>0,"Missing translated native button: "+key+" "+lang);}RankClient.SetLanguage("en");}
 static bool Ready=>pending!=null&&!pending.Task.IsCompleted;
 static void Update(ITimeStep step){
  if(stage==99)return;
  try{
   if(Time.realtimeSinceStartup>deadline)throw new Exception("Recovery probe timed out at "+stage);
   if(RankedPlugin.MenuBuilt==0||Time.realtimeSinceStartup<12)return;
   if(captureOutput!=null){CaptureUpdate();return;}
   if(stage==0){
    Check(RankClient.StorageReady,"Isolated storage not ready");RankClient.Settings.Server="http://127.0.0.1:1";RankClient.Connected=false;L.Select("en");RankClient.Open(false);stage=100;return;
   }
   if(stage==100){
    if(!RankClient.Ui.Windows.Any())return;RankClient.FocusTab(L.T("계정"));if(Window.Screen==null)return;
    Languages("Recovery.FindAccount");Click("Recovery.FindAccount");Check(Form.Mode=="recovery","Wrong recovery mode");Form.Email="test@example.com";Click("Recovery.SendCode");stage=1;return;
   }
   if(stage==1&&Ready){Check(route=="/auth/recovery/request"&&string.IsNullOrEmpty(token),"Wrong unauthenticated code request");pending.SetResult(new JObject{["challengeId"]="challenge",["sent"]=true});stage=2;return;}
   if(stage==2&&!RankClient.Busy){
    Languages("Recovery.Verify");int n=requests;Form.EmailCode="1234567";Click("Recovery.Verify");Check(requests==n&&!RankClient.Busy,"Invalid-length code sent");Form.EmailCode="12345678";Click("Recovery.Verify");stage=3;return;
   }
   if(stage==3&&Ready){Check(route=="/auth/recovery/verify"&&(string)body["code"]=="12345678","Wrong verification payload");pending.SetResult(new JObject{["recoveryToken"]="grant",["accounts"]=new JArray(new JObject{["id"]="fixture",["username"]="fixture_user",["nickname"]="Fixture"})});stage=4;return;}
   if(stage==4&&!RankClient.Busy){Languages("Recovery.ResetPassword");Check(Form.EmailCode==""&&Form.EmailChallenge=="","Code retained after verification");Click("Recovery.ResetPassword");stage=5;return;}
   if(stage==5&&Ready){Check(route=="/auth/recovery/reset"&&(string)body["email"]=="test@example.com"&&(string)body["accountId"]=="fixture"&&(string)body["recoveryToken"]=="grant","Reset changed verified target");pending.SetResult(new JObject{["reset"]=true});stage=6;return;}
   if(stage==6&&!RankClient.Busy){
    Check(Form.Mode=="login"&&Form.Username=="fixture_user"&&Form.RecoveryToken==""&&!Form.RecoveryAccounts.Any(),"Recovery did not return to clean login");
    RankClient.Settings.Connections[RankClient.Settings.Server]=new Connection{Token="fixture-token",AccountId="fixture",Username="fixture_user"};
    RankClient.Me=new JObject{["id"]="fixture",["name"]="Fixture"};RankClient.Auth=new JObject{["username"]="fixture_user",["recoveryEmail"]="old@example.com"};RankClient.Connected=true;RankClient.RefreshUi();
    Languages("Recovery.EmailSettings");Click("Recovery.EmailSettings");Check(Form.Email=="old@example.com","Existing email not shown");Form.Email="new@example.com";Form.Password="fixture-password";Click("Recovery.SendCode");stage=7;return;
   }
   if(stage==7&&Ready){Check(route=="/auth/email/request"&&token=="fixture-token"&&(string)body["password"]=="fixture-password","Linking did not use current password and session");Check(Form.Password=="","Password retained in form");pending.SetResult(new JObject{["challengeId"]="email-challenge",["sent"]=true});stage=8;return;}
   if(stage==8&&!RankClient.Busy){Check((string)RankClient.Auth["recoveryEmail"]=="old@example.com","Email changed before verification");Form.EmailCode="87654321";Click("Recovery.Verify");stage=9;return;}
   if(stage==9&&Ready){Check(route=="/auth/email/verify"&&(string)body["challengeId"]=="email-challenge","Wrong link verification");pending.SetResult(new JObject{["auth"]=new JObject{["username"]="fixture_user",["recoveryEmail"]="new@example.com",["emailVerified"]=true}});stage=10;return;}
   if(stage==10&&!RankClient.Busy){
    Check(Form.Mode=="login"&&Form.EmailCode==""&&(string)RankClient.Auth["recoveryEmail"]=="new@example.com","Verified email not applied");
    RankClient.Auth["passwordResetRequired"]=true;RankClient.RefreshUi();Check(Form.Mode=="password"&&!Buttons("Recovery.EmailSettings").Any(),"Temporary login not forced into password change");Languages("변경 적용 / Save password");
    StartSignup();return;
   }
   if(stage==21&&Ready){
    Check(route=="/auth/register"&&(string)body["password"]=="fixture-password","Wrong signup request");Check(Form.Password==""&&Form.Confirm=="","Signup retained form password");
    pending.SetResult(SignupAccount());stage=signupCase==0?23:22;return;
   }
   if(stage==22&&Ready){
    Check(route=="/auth/email/request"&&token=="signup-token-"+signupCase&&(string)body["email"]=="signup@example.com"&&(string)body["password"]=="fixture-password","Signup did not send authenticated verification");
    var saved=JObject.Parse(File.ReadAllText(Path.Combine(RankClient.DirectoryPath,"client.json")));
    Check((string)saved["Connections"][RankClient.Settings.Server]["Token"]==token,"Session not saved before mail");Check(!saved.ToString().Contains("fixture-password"),"Password persisted to disk");
    if(signupCase==1)pending.SetResult(new JObject{["challengeId"]="signup-challenge",["sent"]=true});
    else if(signupCase==2)pending.SetException(new RankApiException(429,"Recovery.DailyLimit"));
    else pending.SetException(new System.Net.Http.HttpRequestException("Fixture offline"));
    stage=23;return;
   }
   if(stage==23&&Ready){
    if(route=="/health")pending.SetResult(new JObject{["service"]="ftd-ranked-battles",["capabilities"]=new JArray("bilateral-ratings-v1")});
    else if(route=="/me")pending.SetResult(SignupAccount());
    else if(route=="/tournaments"){pending.SetResult(new JObject{["tournaments"]=new JArray()});stage=24;}
    else throw new Exception("Unexpected signup follow-up: "+route);
    return;
   }
   if(stage==24&&!RankClient.Busy){
    Check(RankClient.Connected&&(string)RankClient.Me["id"]=="signup-"+signupCase,"Signup account lost after mail");
    if(signupCase==0){Check(Form.Mode=="login"&&Form.EmailChallenge=="","Empty email unexpectedly started verification");signupCase++;StartSignup();return;}
    Check(Form.Mode=="email"&&Form.Password=="","Signup lost email screen or retained password");
    if(signupCase==1){
     Check(Form.EmailChallenge=="signup-challenge"&&Form.EmailNotice=="Registration.EmailSent","Signup code context missing");
     Languages("Recovery.Verify");Check(!Field("현재 암호 / Current password")&&!Field("Recovery.Email"),"Code screen asks for password or lets target change");
     Form.EmailCode="12345678";Click("Recovery.Verify");stage=25;return;
    }
    Check(Form.EmailChallenge==""&&Form.EmailNotice=="Registration.EmailFailed"&&Field("현재 암호 / Current password")&&Buttons("Recovery.SendCode").Any(),"Failed mail blocked signup or retry");
    Check(Form.EmailError==(signupCase==2?"Recovery.DailyLimit":"Recovery.SendFailed"),"Mail failure message lost");
    Languages("Recovery.SendCode");Click("Recovery.Back");Check(Form.Mode=="login"&&RankClient.Connected,"Skipping email lost account");
    if(signupCase==3){Finish();return;}signupCase++;StartSignup();return;
   }
   if(stage==25&&Ready){
    Check(route=="/auth/email/verify"&&token=="signup-token-1"&&(string)body["code"]=="12345678"&&(string)body["password"]=="","Signup verification unexpectedly needs password again");
    pending.SetResult(new JObject{["auth"]=new JObject{["username"]="signup_fixture",["recoveryEmail"]="signup@example.com",["emailVerified"]=true}});stage=26;return;
   }
   if(stage==26&&!RankClient.Busy){Check(Form.Mode=="login"&&Form.EmailChallenge==""&&(string)RankClient.Auth["recoveryEmail"]=="signup@example.com","Signup verification did not complete");signupCase++;StartSignup();return;}
  }catch(Exception e){File.WriteAllText(Path.Combine(root,"recovery-failed.txt"),"Stage "+stage+"\n"+e);stage=99;Application.Quit();}
 }
}
