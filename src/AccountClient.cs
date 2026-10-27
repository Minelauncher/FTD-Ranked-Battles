using System;
using System.Linq;
using Newtonsoft.Json.Linq;

namespace FtdRank
{
    public static partial class RankClient
    {
        public static bool AccountLocked => Ticket != null || PendingResult != null || RankBattle.InArena;
        public static bool NeedsCredentials => Auth?["needsCredentials"]?.Value<bool>() == true;
        public static bool PasswordResetRequired => Auth?["passwordResetRequired"]?.Value<bool>() == true;
        public static string SavedUsername => Settings.Connections.TryGetValue(Settings.Server, out var c) ? c.Username ?? "" : "";
        public static void SaveNicknameColor(string color)
        {
            if (!Connected || Busy) return;
            Run(L.T("Profile.Saving"), () => Request(Settings.Server, Token, "PUT", "/me/profile", new { nicknameColor = color }), result => {
                Me = (JObject)result["account"];
                string owner = Text(Me, "id");
                foreach (var row in Standings.Where(a => Text(a, "id") == owner)) row["nicknameColor"] = color;
                foreach (var row in RankChat.Messages.Where(a => Text(a, "owner") == owner)) row["nicknameColor"] = color;
                Status = L.T("Profile.Saved");
            });
        }
        public static void Authenticate(AccountForm form)
        {
            if (Busy || RankBattle.Running || RankBattle.Loading) return;
            string mode = form.Mode;
            if (mode != "login" && mode != "register" && mode != "claim" && mode != "password") return;
            if (mode == "register" && AccountLocked) { Status = L.T("저장된 경기의 계정으로 로그인하세요."); RefreshUi(); return; }
            string error = form.ValidationError();
            if (error != null) { Status = error; RefreshUi(); return; }
            string server = Settings.Server, token = Token;
            string registrationEmail = mode == "register" ? (form.Email ?? "").Trim() : "";
            string registrationPassword = registrationEmail.Length > 0 ? form.Password : "";
            string requiredId = AccountLocked ? Text(PendingResult, "accountId", Text(Me, "id", Settings.Connections.TryGetValue(server, out var c) ? c.AccountId : "")) : "";
            var body = new JObject { ["username"] = form.Username, ["nickname"] = form.Nickname, ["password"] = form.Password,
                ["newPassword"] = form.NewPassword, ["expectedAccountId"] = requiredId };
            form.ClearSecrets();
            Run(mode == "register" ? L.T("회원가입을 서버에 등록하는 중…") : L.T("계정 정보를 확인하는 중…"), () => Request(server, mode == "claim" || mode == "password" ? token : null, "POST", "/auth/" + mode, body), result =>
            {
                string id = Text(result["account"], "id");
                if (requiredId.Length > 0 && requiredId != id) throw new InvalidOperationException(L.T("저장된 경기와 같은 계정으로 로그인하세요."));
                Settings.Connections[server] = new Connection { Token = Text(result, "token"), AccountId = id, Username = Text(result["auth"], "username") };
                Save(ConfigPath, Settings);
                if (Text(Me, "id") != id) { Me = Ticket = Receipt = EventRating = Standing = null; History.Clear(); ResetStandings(); Tournaments.Clear(); Tournament = Entry = null; Draft = new JArray(); SelectedUnit = -1; }
                Auth = result["auth"] as JObject;
                form.Mode = "login";
                if (registrationEmail.Length > 0)
                {
                    // Save the account/session before sending mail so a delivery failure cannot undo signup.
                    Me = result["account"] as JObject; Connected = true;
                    form.Mode = "email"; form.Email = registrationEmail;
                    SendRegistrationEmail(form, server, Text(result, "token"), registrationPassword);
                }
                else Connect();
            });
        }
        static void SendRegistrationEmail(AccountForm form, string server, string token, string password)
        {
            var body = new JObject { ["email"] = form.Email, ["password"] = password };
            Run(L.T("Registration.Sending"), async () => {
                try { return await Request(server, token, "POST", "/auth/email/request", body); }
                finally { body["password"] = ""; }
            }, result => {
                form.EmailChallenge = Text(result, "challengeId");
                form.EmailNotice = "Registration.EmailSent";
                Connect();
            }, error => {
                form.EmailNotice = "Registration.EmailFailed";
                form.EmailError = error is RankApiException ? error.GetBaseException().Message : "Recovery.SendFailed";
                Connect();
            });
        }
        public static void RecoverAccount(AccountForm form, bool verify)
        {
            if (Busy || RankBattle.Running || RankBattle.Loading) return;
            bool link = form.Mode == "email";
            if (!link && form.Mode != "recovery") return;
            string address = form.Email.Trim();
            if (!AccountForm.ValidEmail(address)) { Status = L.T("Recovery.InvalidEmail"); RefreshUi(); return; }
            if (verify && (form.EmailCode.Length != 8 || form.EmailCode.Any(c => c < '0' || c > '9'))) { Status = L.T("Recovery.InvalidCode"); RefreshUi(); return; }
            var body = new JObject { ["email"] = address, ["password"] = form.Password, ["code"] = form.EmailCode, ["challengeId"] = form.EmailChallenge };
            form.Password = form.EmailCode = "";
            form.EmailNotice = form.EmailError = "";
            string route = "/auth/" + (link ? "email/" : "recovery/") + (verify ? "verify" : "request");
            Run(L.T("Recovery.Working"), () => Request(Settings.Server, link ? Token : null, "POST", route, body), result => {
                if (!verify) { form.EmailChallenge = Text(result, "challengeId"); form.RecoveryToken = ""; form.RecoveryAccounts = new JArray(); Status = L.T("Recovery.CodeSent"); }
                else if (link) { Auth = result["auth"] as JObject; form.ClearSecrets(); form.Mode = "login"; Status = L.T("Recovery.EmailSaved"); }
                else { form.RecoveryToken = Text(result, "recoveryToken"); form.RecoveryAccounts = result["accounts"] as JArray ?? new JArray(); form.EmailChallenge = ""; Status = L.T("Recovery.AccountsFound"); }
            });
        }
        public static void ResetRecoveredAccount(AccountForm form, string id, string username)
        {
            if (Busy || RankBattle.Running || RankBattle.Loading || string.IsNullOrEmpty(form.RecoveryToken)) return;
            var body = new JObject { ["email"] = form.Email.Trim(), ["recoveryToken"] = form.RecoveryToken, ["accountId"] = id };
            Run(L.T("Recovery.Working"), () => Request(Settings.Server, null, "POST", "/auth/recovery/reset", body), result => {
                form.ClearSecrets(); form.Mode = "login"; form.Username = username; Status = L.T("Recovery.PasswordSent");
            });
        }
        public static void Logout()
        {
            if (Busy || AccountLocked || NeedsCredentials) return;
            RankChat.Close();
            string server = Settings.Server, token = Token;
            Run(L.T("로그아웃 중…"), () => Request(server, token, "POST", "/auth/logout", new { }), result =>
            {
                Settings.Connections.Remove(server); Save(ConfigPath, Settings);
                Connected = false; Me = Ticket = Receipt = Auth = EventRating = Standing = null; History.Clear(); ResetStandings();
                Tournaments.Clear(); Tournament = Entry = null; Draft = new JArray(); SelectedUnit = -1;
                Ui?.Account.ClearSecrets(); Status = L.T("로그아웃했습니다.");
            });
        }
    }
}
