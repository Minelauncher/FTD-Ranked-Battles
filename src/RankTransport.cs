using System;
using System.IO;
using System.Linq;
using System.Collections.Generic;
using System.Globalization;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;

namespace FtdRank
{
    public sealed class RankApiException : InvalidOperationException
    {
        public int StatusCode { get; }
        public RankApiException(int statusCode, string message) : base(message) { StatusCode = statusCode; }
    }
    // Kept independent from Unity so the exact game transport can be integration-tested.
    public static class RankTransport
    {
        public const string ClientVersion = "0.7.7";
        public const string ProtocolVersion = "1";
        const int BlueprintLimit = 8 * 1024 * 1024;
        static readonly HttpClient http = new HttpClient(new HttpClientHandler { UseProxy = false, AllowAutoRedirect = false }) { Timeout = TimeSpan.FromSeconds(60) };
        public static string Hash(byte[] bytes)
        {
            using (var sha = SHA256.Create()) return BitConverter.ToString(sha.ComputeHash(bytes)).Replace("-", "").ToLowerInvariant();
        }
        static HttpRequestMessage Message(string server, string token, string method, string route)
        {
            if (!Uri.TryCreate(server, UriKind.Absolute, out var uri) || uri.UserInfo.Length != 0 || uri.Query.Length != 0 || uri.Fragment.Length != 0 || uri.AbsolutePath != "/" ||
                (uri.Scheme != "https" && !(uri.Scheme == "http" && uri.IsLoopback)))
                throw new InvalidOperationException(L.T("HTTPS 서버 주소를 사용하세요. HTTP는 로컬 시험 서버에만 허용됩니다."));
            var request = new HttpRequestMessage(new HttpMethod(method), server + route);
            request.Headers.Add("X-FTD-Rank-Version", ClientVersion);
            request.Headers.Add("X-FTD-Rank-Protocol", ProtocolVersion);
            if (!string.IsNullOrEmpty(token)) request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
            return request;
        }
        static async Task<JObject> ReadJson(HttpResponseMessage response)
        {
            var text = await response.Content.ReadAsStringAsync().ConfigureAwait(false);
            JObject result;
            try { result = JObject.Parse(text); }
            catch (JsonException)
            {
                // Proxies can return HTML on 429/5xx. Preserve the HTTP status so
                // result recovery still retries, and non-JSON 401 still requests sign-in.
                if (!response.IsSuccessStatusCode) throw new RankApiException((int)response.StatusCode, L.T("서버 요청에 실패했습니다."));
                throw new InvalidOperationException(L.T("서버 응답 형식이 올바르지 않습니다. 서버 주소를 확인하세요."));
            }
            if (!response.IsSuccessStatusCode) throw new RankApiException((int)response.StatusCode, result["error"]?.Value<string>() ?? L.T("서버 요청에 실패했습니다."));
            return result;
        }
        public static async Task<JObject> Request(string server, string token, string method, string route, object body = null, CancellationToken cancellation = default)
        {
            using (var request = Message(server, token, method, route))
            {
                if (body != null) request.Content = new StringContent(JsonConvert.SerializeObject(body), Encoding.UTF8, "application/json");
                using (var response = await http.SendAsync(request, cancellation).ConfigureAwait(false)) return await ReadJson(response).ConfigureAwait(false);
            }
        }
        public static async Task<JObject> UploadFleetBlueprint(string server, string token, string blueprint, double cost)
        {
            var bytes = Encoding.UTF8.GetBytes(blueprint);
            if (bytes.Length > BlueprintLimit) throw new InvalidOperationException(L.T("BP 파일 크기는 최대 8 MiB입니다."));
            var bp = ValidateBlueprint(blueprint);
            using (var request = Message(server, token, "POST", "/blueprints/raw"))
            {
                request.Content = new ByteArrayContent(bytes);
                request.Content.Headers.ContentType = new MediaTypeHeaderValue("application/octet-stream");
                request.Headers.Add("X-Blueprint-Sha256", Hash(bytes));
                request.Headers.Add("X-Blueprint-Name", Uri.EscapeDataString((bp["Name"]?.Value<string>() ?? "Vehicle").Substring(0, Math.Min(100, (bp["Name"]?.Value<string>() ?? "Vehicle").Length))));
                request.Headers.Add("X-Blueprint-Cost", cost.ToString("0.###", CultureInfo.InvariantCulture));
                using (var response = await http.SendAsync(request).ConfigureAwait(false)) return await ReadJson(response).ConfigureAwait(false);
            }
        }
        public static async Task<JObject> SubmitMatchResult(string server, string token, string id, bool cancel, JObject body, bool recoverFirst = false)
        {
            using (var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(15)))
            {
                async Task<JObject> Recover()
                {
                    var saved = await Request(server, token, "GET", "/matches/" + id, cancellation: timeout.Token).ConfigureAwait(false);
                    return (string)saved["status"] == "completed" && saved["receipt"] is JObject receipt && (string)receipt["matchId"] == id ? receipt : null;
                }
                // A lost response does not mean the server rejected the result.
                if (recoverFirst) { var receipt = await Recover().ConfigureAwait(false); if (receipt != null) return receipt; }
                try { return await Request(server, token, "POST", "/matches/" + id + (cancel ? "/cancel" : "/result"), cancel ? new JObject() : body, timeout.Token).ConfigureAwait(false); }
                catch (RankApiException e) when (e.StatusCode == 409)
                {
                    var receipt = await Recover().ConfigureAwait(false);
                    if (receipt != null) return receipt;
                    throw;
                }
            }
        }
        static JObject ValidateBlueprint(string text)
        {
            var bp = JObject.Parse(text);
            if (!(bp["Blueprint"]?["BlockIds"] is JArray ids) || ids.Count == 0 || !(bp["ItemDictionary"] is JObject))
                throw new InvalidOperationException(L.T("FTD BP 파일 형식이 올바르지 않습니다."));
            return bp;
        }
        public static async Task<JObject> LoadTicket(string server, string token, JObject ticket, Action<BlueprintDownloadProgress> progress = null)
        {
            if (ticket == null) return null;
            var files = new List<(string hash, string route, string name)>();
            string matchId = ticket["id"]?.Value<string>();
            if (matchId == null || matchId.Length != 32 || matchId.Any(c => !Uri.IsHexDigit(c))) throw new InvalidOperationException(L.T("경기 ID가 올바르지 않습니다."));
            if (!(ticket["ownerFleet"] is JObject)) throw new InvalidOperationException(L.T("대회 함대 정보가 없는 경기입니다."));
            {
                var seen = new HashSet<string>();
                foreach (string side in new[] { "ownerFleet", "opponentFleet" })
                {
                    var units = ticket[side]?["units"] as JArray;
                    FleetPlan.Validate(units, ticket["rules"] as JObject);
                    foreach (var unit in units)
                    {
                        string hash = (string)unit["hash"];
                        if (seen.Add(hash)) files.Add((hash, "/matches/" + matchId + "/fleet-blueprints/" + hash, (string)unit["name"] ?? "BP"));
                    }
                }
            }
            var blueprints = new JObject(); int completed = 0;
            foreach (var file in files)
            {
                progress?.Invoke(new BlueprintDownloadProgress(completed, files.Count, file.name, 0, null));
                var text = await DownloadBlueprint(server, token, file.route, file.hash,
                    (received, length, checking) => progress?.Invoke(new BlueprintDownloadProgress(completed, files.Count, file.name, received, length, checking))).ConfigureAwait(false);
                blueprints[file.hash] = text;
                completed++;
                long size = Encoding.UTF8.GetByteCount(text);
                progress?.Invoke(new BlueprintDownloadProgress(completed, files.Count, file.name, size, size));
            }
            ticket["blueprints"] = blueprints;
            return ticket;
        }
        static async Task<string> DownloadBlueprint(string server, string token, string route, string hash, Action<long, long?, bool> progress)
        {
            using (var request = Message(server, token, "GET", route))
            using (var response = await http.SendAsync(request, HttpCompletionOption.ResponseHeadersRead).ConfigureAwait(false))
            {
                if (!response.IsSuccessStatusCode) await ReadJson(response).ConfigureAwait(false);
                long? length = response.Content.Headers.ContentLength;
                progress?.Invoke(0, length, false);
                if (length > BlueprintLimit) throw new InvalidOperationException(L.T("BP 파일이 너무 큽니다."));
                using (var stream = await response.Content.ReadAsStreamAsync().ConfigureAwait(false))
                using (var buffer = new MemoryStream())
                using (var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(60)))
                {
                    var chunk = new byte[65536]; int count;
                    while ((count = await stream.ReadAsync(chunk, 0, chunk.Length, timeout.Token).ConfigureAwait(false)) != 0)
                    {
                        if (buffer.Length + count > BlueprintLimit) throw new InvalidOperationException(L.T("BP 파일이 너무 큽니다."));
                        buffer.Write(chunk, 0, count);
                        progress?.Invoke(buffer.Length, length, false);
                    }
                    progress?.Invoke(buffer.Length, length, true);
                    var bytes = buffer.ToArray();
                    if (Hash(bytes) != hash) throw new InvalidOperationException(L.T("경기 BP 체크섬이 일치하지 않습니다."));
                    var text = new UTF8Encoding(false, true).GetString(bytes); ValidateBlueprint(text); return text;
                }
            }
        }
        public static async Task<JObject> LoadAccount(string server, string token, bool loadBlueprints = true, string tournament = null)
        {
            var result = await Request(server, token, "GET", "/me" + (string.IsNullOrEmpty(tournament) ? "" : "?tournament=" + Uri.EscapeDataString(tournament))).ConfigureAwait(false);
            if (loadBlueprints && result["pending"] is JObject ticket) await LoadTicket(server, token, ticket).ConfigureAwait(false);
            return result;
        }
    }
}
