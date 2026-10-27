using System;
using System.Text;
using System.Text.RegularExpressions;
using Newtonsoft.Json.Linq;

namespace FtdRank
{
    public sealed class AccountForm
    {
        public string Mode = "login", Username = "", Nickname = "", Password = "", Confirm = "", NewPassword = "";
        public string Email = "", EmailCode = "", EmailChallenge = "", RecoveryToken = "";
        public string EmailNotice = "", EmailError = "";
        public JArray RecoveryAccounts = new JArray();
        public void ClearSecrets() { Password = Confirm = NewPassword = EmailCode = EmailChallenge = RecoveryToken = EmailNotice = EmailError = ""; RecoveryAccounts = new JArray(); }
        public string ValidationError()
        {
            const string pattern = @"\A[a-z0-9][a-z0-9_.-]{7,31}\z";
            if (Mode != "password" && !Regex.IsMatch((Username ?? "").Trim().ToLowerInvariant(), pattern))
                return L.T("아이디: 8~32자, 영문·숫자 및 _ . - / Username: 8–32 characters.");
            if (!ValidPassword(Password)) return L.T("비밀번호: 8~32자 / Password: 8–32 characters.");
            if (Mode == "login") return null;
            if (Mode == "register" || Mode == "claim")
            {
                string nick = Regex.Replace((Nickname ?? "").Normalize(NormalizationForm.FormKC).Trim(), " +", " ");
                if (CodePoints(nick) < 2 || CodePoints(nick) > 24 || !Regex.IsMatch(nick, @"\A[\p{L}\p{M}\p{N} _.\-]+\z") || !Regex.IsMatch(nick, @"[\p{L}\p{N}]"))
                    return L.T("닉네임: 2~24자, 한글·영문·숫자·공백 및 _ . - / Nickname: 2–24 characters.");
            }
            string changed = Mode == "password" ? NewPassword : Password;
            if (!ValidPassword(changed))
                return L.T("비밀번호: 8~32자 / Password: 8–32 characters.");
            if (changed != Confirm) return L.T("비밀번호가 서로 다릅니다. / Passwords do not match.");
            if (Mode == "register" && !string.IsNullOrWhiteSpace(Email) && !ValidEmail(Email)) return L.T("Recovery.InvalidEmail");
            return null;
        }
        public static bool ValidEmail(string value)
        {
            string email = (value ?? "").Trim().ToLowerInvariant();
            return email.Length <= 254 && Regex.IsMatch(email, @"\A[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,63}\z");
        }
        static bool ValidPassword(string value)
        {
            int length = value == null ? 0 : CodePoints(value);
            return length >= 8 && length <= 32 && !Regex.IsMatch(value, @"[\x00-\x1f\x7f]");
        }
        static int CodePoints(string value)
        {
            int count = 0;
            for (int i = 0; i < value.Length; i++, count++)
                if (char.IsHighSurrogate(value[i]) && i + 1 < value.Length && char.IsLowSurrogate(value[i + 1])) i++;
            return count;
        }
    }
}
