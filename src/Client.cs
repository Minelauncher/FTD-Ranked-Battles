using System;
using System.IO;
using System.Collections.Generic;
using System.Collections.Concurrent;
using System.Linq;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Text;
using System.Threading.Tasks;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;
using BrilliantSkies.Ui.Displayer;
using BrilliantSkies.Ui.Special.PopUps;
using BrilliantSkies.Ui.CustomBattleMode;
using Assets.Scripts.Gui;
using Assets.Scripts.Persistence;

namespace FtdRank
{
    public sealed class Connection { public string Token; public string AccountId; public string Username; }
    public sealed class ClientSettings
    {
        public string Server = "https://ftd-ranked.ftd-ranked.workers.dev";
        public string Name = "Captain";
        public string Language = "en";
        public RankKeyBindings Keys = new RankKeyBindings();
        public List<string> ChatBlocked = new List<string>();
        public Dictionary<string, string> ChatBlockedNames = new Dictionary<string, string>();
        public ClientSettings WithKeys(RankKeyBindings keys) { var copy = (ClientSettings)MemberwiseClone(); copy.Keys = keys; return copy; }
        public Dictionary<string, Connection> Connections = new Dictionary<string, Connection>();
        public Dictionary<string, string> SelectedTournaments = new Dictionary<string, string>();
    }
    public static partial class RankClient
    {
        public static string DirectoryPath { get; private set; }
        public static ClientSettings Settings = new ClientSettings();
        static string storageError;
        public static bool StorageReady { get; private set; }
        public static JObject Me, Ticket, Receipt, Auth, EventRating, Standing;
        public static JArray Standings = new JArray(), History = new JArray();
        public static RankingPage Ranking = new RankingPage();
        static string status = "로그인하고 시작하세요. / Sign in to play.";
        public static string Status { get => storageError == null ? L.Message(status) : L.T("로컬 저장소를 열 수 없습니다. / Cannot open local storage.") + "\n" + storageError; set => status = value; }
        public static bool Busy, Connected;
        public static volatile BlueprintDownloadProgress DownloadProgress;
        public static RankUi Ui;
        public static JObject PendingResult;
        public static double ServerOffset;
        static readonly ConcurrentQueue<Action> callbacks = new ConcurrentQueue<Action>();
        static string ConfigPath => Path.Combine(DirectoryPath, "client.json");
        static string PendingPath => Path.Combine(DirectoryPath, "pending-result.json");
        public static double Now => DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() / 1000.0 + ServerOffset;
        public static string Text(JToken item, string key, string fallback = "") => item?[key]?.Value<string>() ?? fallback;
        public static double Number(JToken item, string key, double fallback = 0) => item?[key]?.Value<double>() ?? fallback;
        public static string Safe(string text) => (text ?? "").Replace("<", "‹").Replace(">", "›");
        public static void Initialize()
        {
            StorageReady = false; storageError = null;
            try
            {
                string location = typeof(RankClient).Assembly.Location;
                DirectoryPath = ClientStorage.Open(string.IsNullOrEmpty(location) ? null : Path.GetDirectoryName(location), BrilliantSkies.Core.Constants.Get.PermanentPaths.RootDir().ToString());
                string config = ClientStorage.ReadText(ConfigPath), pending = ClientStorage.ReadText(PendingPath);
                Settings = config == null ? new ClientSettings() : JsonConvert.DeserializeObject<ClientSettings>(config) ?? throw new JsonException("Invalid client.json");
                Settings.Connections = Settings.Connections ?? new Dictionary<string, Connection>();
                Settings.SelectedTournaments = Settings.SelectedTournaments ?? new Dictionary<string, string>();
                Settings.Keys = (Settings.Keys ?? new RankKeyBindings()).Normalize();
                Settings.ChatBlocked = Settings.ChatBlocked ?? new List<string>();
                Settings.ChatBlockedNames = Settings.ChatBlockedNames ?? new Dictionary<string, string>();
                if (string.IsNullOrWhiteSpace(Settings.Server)) Settings.Server = new ClientSettings().Server;
                L.Select(Settings.Language);
                PendingResult = pending == null ? null : JObject.Parse(pending);
                TrackResult(PendingResult, true);
                StorageReady = true;
                MatchStorage.Sweep(DirectoryPath); // Crash leftovers; queued result lives outside Matches.
            }
            catch (Exception e)
            {
                // Keep the menu available, but do not overwrite unreadable state or
                // accept a new match while a pending result cannot be recovered.
                storageError = e.GetBaseException().Message;
                UnityEngine.Debug.LogWarning("Ranked Battles storage initialization failed: " + e.GetType().Name);
            }
        }
        public static void Save(string path, object data)
        {
            if (!StorageReady) throw new IOException(Status);
            ClientStorage.WriteText(path, JsonConvert.SerializeObject(data, Formatting.Indented));
        }
        public static void Update()
        {
            while (callbacks.TryDequeue(out var callback)) callback();
            PumpResult();
            Ui?.UpdateMatchHeader();
            RankChat.Pump();
        }
        public static bool SetKey(RankAction action, UnityEngine.KeyCode key, RankKeyModifiers modifiers, out string message)
        {
            if (!Settings.Keys.TryChange(action, key, modifiers, out var keys, out message)) return false;
            return SaveKeys(keys, out message);
        }
        public static bool RestoreKeys(out string message) => SaveKeys(new RankKeyBindings(), out message);
        static bool SaveKeys(RankKeyBindings keys, out string message)
        {
            try {
                var updated = Settings.WithKeys(keys);
                Save(ConfigPath, updated); Settings = updated;
                message = L.T("Keys.Saved"); return true;
            } catch (Exception e) {
                message = L.F("Keys.SaveFailed", Safe(e.GetBaseException().Message)); return false;
            }
        }
        public static void RefreshUi() { FormationCanvas.CancelActive(); Ui?.TriggerRebuild(); }
        public static void SetLanguage(string language)
        {
            string selected = Ui?.Windows.FirstOrDefault()?.Screen.GetType().Name;
            Settings.Language = L.Normalize(language); L.Select(Settings.Language);
            try { if (StorageReady) Save(ConfigPath, Settings); } catch (Exception e) { Status = e.Message; }
            RefreshUi();
            if (Ui != null) foreach (var window in Ui.Windows) {
                var tab = window.AllScreens.FirstOrDefault(s => s.GetType().Name == selected);
                if (tab != null) window.Screen = tab;
            }
            // Rebuild the underlying native menu so our entry changes immediately too.
            (GuiDisplayer.GetSingleton()?.GetLatestOfType(typeof(BrilliantSkies.Ftd.Modes.MainMenu.Ui.MainMenuUi)) as BrilliantSkies.Ftd.Modes.MainMenu.Ui.MainMenuUi)?.TriggerRebuild();
        }
        public static void Open(bool refresh = true)
        {
            Ui = new RankUi();
            Ui.ActivateGui(GuiActivateType.Stack);
            FocusTab(!Connected ? L.T("계정") : Ticket != null || PendingResult != null || Receipt != null || RankBattle.InArena ? L.T("전투") : L.T("대회"));
            if (refresh && !Connected && HasSavedLogin && !Busy) Connect();
            if (refresh && Connected && !Busy && !RankBattle.Running && !RankBattle.Loading) Refresh();
        }
        public static void FocusTab(string name)
        {
            if (Ui == null) return;
            foreach (var window in Ui.Windows)
            {
                var screen = window.AllScreens.FirstOrDefault(s => s.Name.Display == name || s.Name.Display.StartsWith(name + " / ", StringComparison.Ordinal));
                if (screen != null) window.Screen = screen;
            }
        }
        static string Token => Settings.Connections.TryGetValue(Settings.Server, out var c) ? c.Token : null;
        public static bool HasSavedLogin => !string.IsNullOrEmpty(Token);
        static Task<JObject> Request(string server, string token, string method, string route, object body = null)
            => RankTransport.Request(server, token, method, route, body);
        public static void Run(string status, Func<Task<JObject>> work, Action<JObject> done, Action<Exception> failed = null)
        {
            if (!StorageReady) { RefreshUi(); return; }
            if (Busy) return;
            Busy = true; Status = status; RefreshUi();
            Task.Run(async () =>
            {
                try { var result = await work(); callbacks.Enqueue(() => { Busy = false; DownloadProgress = null; try { done(result); } catch (Exception e) { Status = e.Message; failed?.Invoke(e); } RefreshUi(); }); }
                catch (Exception e) { callbacks.Enqueue(() => { Busy = false; DownloadProgress = null; if (e is RankApiException api && api.StatusCode == 401) { Connected = false; FocusTab(L.T("계정")); } Status = e is HttpRequestException || e is TaskCanceledException ? L.T("연결 실패. 다시 시도하세요. / Connection failed. Retry.") : e.GetBaseException().Message; failed?.Invoke(e); RefreshUi(); }); }
            });
        }
        public static void Connect()
        {
            string server = Settings.Server, token = Token;
            if (string.IsNullOrEmpty(token)) { Status = L.T("로그인 또는 회원가입 / Sign in or register"); FocusTab(L.T("계정")); RefreshUi(); return; }
            Run(L.T("서버에 연결 중…"), async () =>
            {
                var health = await Request(server, null, "GET", "/health");
                if (Text(health, "service") != "ftd-ranked-battles") throw new InvalidOperationException(L.T("FTD 랭크 서버 주소를 입력하세요."));
                if (!(health["capabilities"] is JArray features) || !features.Values<string>().Contains("bilateral-ratings-v1")) throw new InvalidOperationException(L.T("양쪽 레이팅 정산을 지원하는 서버가 필요합니다."));
                var result = await RankTransport.LoadAccount(server, token, false);
                result["connectionToken"] = token;
                return result;
            }, result =>
            {
                Settings.Connections[server] = new Connection { Token = Text(result, "connectionToken"), AccountId = Text(result["account"], "id"), Username = Text(result["auth"], "username") };
                Save(ConfigPath, Settings); Connected = true; ApplyMe(result); Status = "";
                if (PasswordResetRequired) { RankChat.Close(); if (Ui != null) Ui.Account.Mode = "password"; Status = L.T("Recovery.ChangeRequired"); FocusTab(L.T("계정")); return; }
                if (PendingResult != null && Text(PendingResult, "server") == server && Text(PendingResult, "accountId") == Text(Me, "id"))
                    SubmitPendingResult(LoadTournaments);
                else LoadTournaments();
            });
        }
        static void ApplyMe(JObject result)
        {
            Me = result["account"] as JObject;
            Auth = result["auth"] as JObject;
            Ticket = result["pending"] as JObject;
            History = result["history"] as JArray ?? new JArray();
            EventRating = result["rating"] as JObject;
            Standing = result["standing"] as JObject;
            ServerOffset = Number(result, "serverTime") - DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() / 1000.0;
        }
        public static void Refresh()
        {
            string server = Settings.Server, token = Token;
            string id = Text(Tournament, "id");
            Run(L.T("전적을 불러오는 중…"), () => RankTransport.LoadAccount(server, token, false, id), r => { ApplyMe(r); Status = ""; });
        }
        public static void ResetStandings() { Standings = new JArray(); Ranking = new RankingPage(); }
        public static void LoadStandings() => LoadStandings(Ranking.Page);
        public static void LoadStandings(int page)
        {
            if (Tournament == null || !Connected || Busy || page < 1) return;
            string server = Settings.Server, token = Token;
            string id = Text(Tournament, "id");
            Run(L.T("순위를 불러오는 중…"), () => Request(server, token, "GET", "/tournaments/" + id + "/ladder?page=" + page), r => {
                if (server != Settings.Server || token != Token || id != Text(Tournament, "id")) return;
                var next = RankingPage.Read(r); // Keep the current page intact if the request fails.
                if (Text(r, "tournamentId") != id) throw new JsonException(L.T("Ranking.InvalidResponse"));
                bool changed = !Ranking.Loaded || Ranking.Page != next.Page;
                Ranking = next; Standings = (JArray)r["accounts"]; Status = "";
                if (changed) Ui?.ResetRankingScroll();
            });
        }
        public static void Match()
        {
            if (!Connected || Busy || Ticket != null || PendingResult != null || RankBattle.Running || RankBattle.Loading) return;
            if (Tournament == null) { Status = L.T("대회 탭에서 참가할 대회를 선택하세요."); RefreshUi(); return; }
            string server = Settings.Server, token = Token;
            string id = Text(Tournament, "id");
            Run(L.T("이 대회의 상대 함대를 찾는 중…"), () => Request(server, token, "POST", "/tournaments/" + id + "/matches", new { }), r => { Ticket = r; Receipt = null; Standing = r["owner"]?["standing"] as JObject; Status = ""; });
        }
        public static void StartBattle()
        {
            if (Busy || Ticket == null || PendingResult != null || RankBattle.Loading || RankBattle.Running) return;
            if (Number(Ticket, "expiresAt", double.MaxValue) <= Now) { Refresh(); return; }
            string server = Settings.Server, token = Token;
            var ticket = (JObject)Ticket.DeepClone();
            // Keep the pending ticket available for retry/cancellation if a BP download fails.
            DownloadProgress = new BlueprintDownloadProgress(0, 0, L.T("연결 중 / Connecting"), 0, null);
            Run(L.T("경기 BP를 불러오는 중…"), () => RankTransport.LoadTicket(server, token, ticket, p => DownloadProgress = p), r => { Ticket = r; RankBattle.Launch(); });
        }
        public static void Cancel()
        {
            if (Ticket == null || PendingResult != null || RankBattle.Loading) return;
            string id = Text(Ticket, "id");
            GuiPopUp.Instance.Add(new PopupConfirmation(L.T("항복하시겠습니까?"), L.T("이 경기는 내 패배와 상대 승리로 기록되고 양쪽 레이팅에 반영됩니다."), accepted =>
            {
                if (!accepted || Busy || Ticket == null || Text(Ticket, "id") != id) return;
                if (PendingResult == null) RankBattle.Surrender();
            }, L.T("항복 · 패배 처리"), L.T("계속 진행")));
        }
        public static void EditServer()
        {
            GuiPopUp.Instance.Add(new PopupTextInput(L.T("랭크 서버"), L.T("사용할 서버의 주소를 입력하세요."), Settings.Server, L.T("서버 주소"), (value, ok) =>
            {
                if (!ok) return;
                if (!Uri.TryCreate(value.Trim().TrimEnd('/'), UriKind.Absolute, out var uri) || (uri.Scheme != "https" && !(uri.Scheme == "http" && uri.IsLoopback)) || uri.Fragment.Length > 0 || uri.Query.Length > 0 || uri.UserInfo.Length > 0 || uri.AbsolutePath != "/") { Status = L.T("HTTPS 서버 주소를 입력하세요. HTTP는 로컬 시험용입니다."); RefreshUi(); return; }
                Settings.Server = uri.GetLeftPart(UriPartial.Authority); Save(ConfigPath, Settings);
                Connected = false; Me = Ticket = Receipt = Auth = EventRating = Standing = null; History.Clear(); ResetStandings(); Status = L.T("서버에 연결하세요.");
                Tournaments.Clear(); Tournament = Entry = null; Draft = new JArray(); SelectedUnit = -1;
                RefreshUi();
            }));
        }
        public static void EditName()
        {
            GuiPopUp.Instance.Add(new PopupTextInput(L.T("참가자 이름"), L.T("처음 연결할 때 이 이름으로 계정을 만듭니다."), Settings.Name, L.T("이름"), (value, ok) =>
            { if (ok && !string.IsNullOrWhiteSpace(value)) { Settings.Name = value.Trim(); Save(ConfigPath, Settings); RefreshUi(); } }));
        }
    }
}
