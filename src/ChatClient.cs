using System;
using System.Collections.Concurrent;
using System.Linq;
using System.Threading.Tasks;
using Newtonsoft.Json.Linq;

namespace FtdRank
{
    public static class RankChat
    {
        static ChatWire wire;
        static readonly ConcurrentQueue<Action> queue = new ConcurrentQueue<Action>();
        static int generation;
        static double offset, retryAfter;
        static string ownerKey = "", pendingBody = "", pendingNonce = "", pendingChannel = "";
        public static string Draft = "", Channel = "general", Status = "Chat.Offline";
        public static JArray Channels = new JArray(), Messages = new JArray();
        public static bool Connecting, Sending;
        public static int SlowSeconds = 30;
        public static double NextSend;
        public static int ChangeCounter;
        public static string SearchText = "", SearchQuery = "";
        public static bool Searching, SearchMode;
        public static long? SearchBefore;
        public static int SearchScanned;
        static double searchReady;
        public static bool CanSearch => Connected && !Searching && Now >= searchReady && SearchText.Trim().Length >= 2;
        public static bool Connected => wire?.Open == true && !Connecting;
        static double Now => DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() / 1000.0;
        public static int Cooldown => Math.Max(0, (int)Math.Ceiling(NextSend - (Now + offset)));
        public static int CharacterCount(string text) { int count = 0; foreach (char c in text) if (!char.IsLowSurrogate(c)) count++; return count; }
        public static bool CanSend => Connected && !Sending && Cooldown == 0 && !string.IsNullOrWhiteSpace(Draft) && CharacterCount(Draft.Trim()) <= 300;
        public static void Pump() { while (queue.TryDequeue(out var next)) next(); }
        public static void Close() { generation++; wire?.Dispose(); wire = null; Connecting = Sending = Searching = false; Status = "Chat.Offline"; }
        public static void Connect(string server, string token, string owner)
        {
            if (Connecting || Connected || Now < retryAfter || string.IsNullOrEmpty(token)) return;
            Close(); retryAfter = Now + 5;
            string key = server + "/" + owner;
            if (ownerKey != key) { Draft = pendingBody = pendingNonce = pendingChannel = SearchText = ""; NextSend = 0; ownerKey = key; }
            SearchMode = false; SearchBefore = null;
            Messages.Clear(); Channels.Clear(); Channel = "general";
            var current = wire = new ChatWire(); int id = generation;
            Connecting = true; Status = "Chat.Connecting";
            Task.Run(async () => {
                try { await current.Run(server, token, msg => queue.Enqueue(() => { if (id == generation) Apply(msg); })); }
                catch (Exception) { queue.Enqueue(() => { if (id == generation) Status = "Chat.Failed"; }); }
                finally { queue.Enqueue(() => { if (id == generation) { Connecting = Sending = Searching = false; if (Status != "Chat.Failed") Status = "Chat.Offline"; } }); }
            });
        }
        static void Send(JObject data)
        {
            var current = wire; int id = generation;
            Task.Run(async () => {
                try { if (current == null) throw new InvalidOperationException(); await current.Send(data); }
                catch { queue.Enqueue(() => { if (id == generation) { Sending = Searching = false; Status = "Chat.Failed"; } }); }
            });
        }
        public static void Submit()
        {
            if (!CanSend) return;
            var body = Draft.Trim();
            if (body != pendingBody || pendingNonce.Length == 0 || pendingChannel != Channel) { pendingBody = body; pendingChannel = Channel; pendingNonce = Guid.NewGuid().ToString("N"); }
            Sending = true; Send(new JObject { ["type"] = "send", ["channel"] = Channel, ["body"] = body, ["nonce"] = pendingNonce });
        }
        public static void Join(string channel, bool refresh = false)
        {
            if (!Connected || Sending || Searching || (!refresh && channel == Channel)) return;
            Send(new JObject { ["type"] = "join", ["channel"] = channel });
        }
        public static void Search(bool older = false)
        {
            if (!CanSearch || (older && (!SearchMode || SearchBefore == null))) return;
            string query = older ? SearchQuery : SearchText.Trim();
            var request = new JObject { ["type"] = "search", ["query"] = query };
            if (older) request["before"] = SearchBefore.Value;
            Searching = true; searchReady = Now + 3; Send(request);
        }
        public static void Older()
        {
            if (!Connected || Messages.Count == 0) return;
            Send(new JObject { ["type"] = "history", ["before"] = Messages[0]["id"] });
        }
        static void Apply(JObject msg)
        {
            if (msg["serverTime"] != null) offset = (double)msg["serverTime"] - Now;
            if (msg["nextSend"] != null) NextSend = (double)msg["nextSend"];
            if (msg["settings"]?["slowSeconds"] != null) SlowSeconds = (int)msg["settings"]["slowSeconds"];
            if (msg["channels"] is JArray channels) Channels = channels;
            switch ((string)msg["type"]) {
                case "hello": Connecting = false; goto case "history";
                case "history": Channel = (string)msg["channel"]; Messages = (JArray)msg["messages"]; SearchMode = Searching = false; SearchBefore = null; Status = ""; ChangeCounter++; break;
                case "older":
                    if ((string)msg["channel"] != Channel) break;
                    Messages = new JArray(((JArray)msg["messages"]).Concat(Messages).GroupBy(m => (long)m["id"]).Select(g => g.First()).OrderBy(m => (long)m["id"]).Take(500)); ChangeCounter++; break;
                case "message":
                    var m = msg["message"];
                    if (!SearchMode && (string)m["channel"] == Channel && !Messages.Any(old => (long)old["id"] == (long)m["id"])) { Messages.Add(m); Messages = new JArray(Messages.OrderBy(old => (long)old["id"]).Skip(Math.Max(0, Messages.Count - 500))); ChangeCounter++; }
                    break;
                case "search":
                    Searching = false;
                    if ((string)msg["channel"] != Channel) break;
                    SearchMode = true; SearchQuery = (string)msg["query"]; SearchBefore = (long?)msg["nextBefore"];
                    SearchScanned = (int)msg["scanned"]; Messages = (JArray)msg["messages"]; Status = ""; ChangeCounter++; break;
                case "profile":
                    foreach (var row in Messages.Where(m => (string)m["owner"] == (string)msg["owner"])) row["nicknameColor"] = msg["nicknameColor"]?.DeepClone();
                    ChangeCounter++; break;
                case "ack":
                    if ((string)msg["nonce"] == pendingNonce) { Sending = false; if (Draft.Trim() == pendingBody) Draft = ""; pendingNonce = pendingBody = ""; Status = ""; }
                    break;
                case "error": Sending = Searching = false; Status = (string)msg["error"]; break;
            }
        }
    }
    public static partial class RankClient
    {
        public static void OpenChat() { if (Connected) RankChat.Connect(Settings.Server, Token, Text(Me, "id")); }
        public static void ToggleChatBlock(string owner, string name = null)
        {
            var old = Settings.ChatBlocked.ToArray();
            var names = new System.Collections.Generic.Dictionary<string, string>(Settings.ChatBlockedNames);
            if (!Settings.ChatBlocked.Remove(owner)) Settings.ChatBlocked.Add(owner);
            if (name != null) Settings.ChatBlockedNames[owner] = name;
            try { Save(ConfigPath, Settings); } catch { Settings.ChatBlocked = old.ToList(); Settings.ChatBlockedNames = names; }
        }
    }
}
