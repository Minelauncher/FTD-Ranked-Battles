using System;
using Newtonsoft.Json.Linq;

namespace FtdRank
{
    // Ticket policy is immutable, so already-issued health matches can still finish.
    public static class BattleOutcome
    {
        public const string Policy = "remaining-materials-v1";
        public const string HealthPolicy = "total-health-v1";
        public static bool UsesJudgment(JToken ticket)
        {
            var policy = (string)ticket?["resultPolicy"];
            if (policy == null) return false; // Already-issued legacy matches remain draws on timeout.
            if (policy != Policy && policy != HealthPolicy) throw new InvalidOperationException(L.T("지원하지 않는 경기 판정 방식입니다. 모드를 업데이트하세요."));
            return true;
        }
        public static double Health(double value)
        {
            if (double.IsNaN(value) || double.IsInfinity(value)) throw new InvalidOperationException(L.T("편대 체력비를 계산할 수 없습니다."));
            return Math.Max(0, Math.Min(1, value));
        }
        public static JObject Decide(bool judgment, bool timeout, bool ownGone, bool otherGone,
            double ownHealth, double otherHealth, double seconds)
        {
            if (double.IsNaN(seconds) || double.IsInfinity(seconds) || seconds < 0) throw new InvalidOperationException(L.T("전투 시간이 올바르지 않습니다."));
            ownHealth = ownGone ? 0 : Health(ownHealth); otherHealth = otherGone ? 0 : Health(otherHealth);
            double score; string kind;
            if (ownGone && otherGone) { score = .5; kind = "mutual-elimination"; }
            else if (ownGone || otherGone) { score = ownGone ? 0 : 1; kind = "elimination"; }
            else if (!timeout) throw new InvalidOperationException(L.T("아직 종료되지 않은 전투입니다."));
            else if (judgment && ownHealth != otherHealth) { score = ownHealth > otherHealth ? 1 : 0; kind = "judgment"; }
            else { score = .5; kind = "timeout-draw"; }
            return new JObject { ["score"] = score, ["outcome"] = new JObject {
                ["kind"] = kind, ["remaining"] = new JArray(ownHealth, otherHealth),
                ["eliminated"] = new JArray(ownGone, otherGone), ["seconds"] = seconds } };
        }
        public static double Materials(double value)
        {
            if (double.IsNaN(value) || double.IsInfinity(value) || value < 0 || value > 1e12)
                throw new InvalidOperationException(L.T("Outcome.InvalidMaterials"));
            return Math.Round(value, 3, MidpointRounding.AwayFromZero);
        }
        public static JObject MaterialBalance(double vehicle, double supply)
        {
            vehicle = Materials(vehicle); supply = Materials(supply);
            return new JObject { ["vehicle"] = vehicle, ["supply"] = supply, ["total"] = Materials(vehicle + supply) };
        }
        public static JObject DecideMaterials(bool timeout, bool ownGone, bool otherGone,
            double ownHealth, double otherHealth, double seconds, JObject own, JObject other)
        {
            var decision = Decide(false, timeout, ownGone, otherGone, ownHealth, otherHealth, seconds);
            var balances = new JArray(ownGone ? MaterialBalance(0, 0) : MaterialBalance((double)own["vehicle"], (double)own["supply"]),
                otherGone ? MaterialBalance(0, 0) : MaterialBalance((double)other["vehicle"], (double)other["supply"]));
            decision["outcome"]["materials"] = balances;
            if (!ownGone && !otherGone)
            {
                double a = (double)balances[0]["total"], b = (double)balances[1]["total"];
                decision["score"] = a == b ? .5 : a > b ? 1 : 0;
                decision["outcome"]["kind"] = a == b ? "timeout-draw" : "judgment";
            }
            return decision;
        }
        public static string MaterialSummary(JToken result)
        {
            var m = result?["outcome"]?["materials"] as JArray;
            return m?.Count == 2 ? L.F("Outcome.MaterialSummary", (double)m[0]["total"], (double)m[1]["total"],
                (double)m[0]["vehicle"], (double)m[0]["supply"], (double)m[1]["vehicle"], (double)m[1]["supply"]) : "";
        }
        public static string Label(JToken result)
        {
            double score = (double?)result?["score"] ?? .5;
            string kind = (string)result?["outcome"]?["kind"];
            if (kind == "surrender") return L.T("항복패");
            if (kind == "submission-expired") return L.T("결과 미제출 · 패배");
            if (kind == "opponent-surrender") return L.T("상대 항복 · 승리");
            if (kind == "opponent-expired") return L.T("상대 미제출 · 승리");
            if (kind == "judgment") return score == 1 ? L.T("판정승") : L.T("판정패");
            if (kind == "elimination") return score == 1 ? L.T("전멸승") : L.T("전멸패");
            if (kind == "mutual-elimination") return L.T("동시 전멸 · 무승부");
            if (kind == "timeout-draw") return L.T("시간 종료 · 무승부");
            return score == 1 ? L.T("승리") : score == 0 ? L.T("패배") : L.T("무승부");
        }
        public static string HealthSummary(JToken result)
        {
            var remaining = result?["outcome"]?["remaining"] as JArray;
            return remaining?.Count == 2 ? L.T("종료 체력비 · 내 편대 ") + ((double)remaining[0] * 100).ToString("0.######") +
                L.T("% / 상대 ") + ((double)remaining[1] * 100).ToString("0.######") + "%" : "";
        }
    }
}
