using System;
using System.IO;
using System.Net.WebSockets;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using Newtonsoft.Json.Linq;

namespace FtdRank
{
    // No Unity calls on the receive thread. The UI consumes complete JSON frames on Update.
    public sealed class ChatWire : IDisposable
    {
        readonly ClientWebSocket socket = new ClientWebSocket();
        readonly CancellationTokenSource cancel = new CancellationTokenSource();
        readonly SemaphoreSlim sendLock = new SemaphoreSlim(1, 1);
        public bool Open => socket.State == WebSocketState.Open;
        public async Task Run(string server, string token, Action<JObject> receive)
        {
            if (!Uri.TryCreate(server, UriKind.Absolute, out var origin) || origin.UserInfo.Length != 0 || origin.AbsolutePath != "/" ||
                origin.Query.Length != 0 || origin.Fragment.Length != 0 || (origin.Scheme != "https" && !(origin.Scheme == "http" && origin.IsLoopback)))
                throw new InvalidOperationException("Invalid chat server.");
            var url = new UriBuilder(origin) { Scheme = origin.Scheme == "https" ? "wss" : "ws", Path = "/chat/socket" };
            socket.Options.SetRequestHeader("Authorization", "Bearer " + token);
            socket.Options.SetRequestHeader("X-FTD-Rank-Version", RankTransport.ClientVersion);
            socket.Options.SetRequestHeader("X-FTD-Rank-Protocol", RankTransport.ProtocolVersion);
            socket.Options.KeepAliveInterval = TimeSpan.FromSeconds(30);
            using (var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancel.Token)) {
                timeout.CancelAfter(TimeSpan.FromSeconds(20));
                await socket.ConnectAsync(url.Uri, timeout.Token).ConfigureAwait(false);
            }
            var buffer = new byte[8192];
            while (!cancel.IsCancellationRequested && Open) {
                using (var message = new MemoryStream()) {
                    WebSocketReceiveResult result;
                    do {
                        result = await socket.ReceiveAsync(new ArraySegment<byte>(buffer), cancel.Token).ConfigureAwait(false);
                        if (result.MessageType == WebSocketMessageType.Close) return;
                        if (result.MessageType != WebSocketMessageType.Text || message.Length + result.Count > 256 * 1024)
                            throw new InvalidDataException("Invalid chat response.");
                        message.Write(buffer, 0, result.Count);
                    } while (!result.EndOfMessage);
                    var value = Encoding.UTF8.GetString(message.ToArray());
                    if (value != "pong") receive(JObject.Parse(value));
                }
            }
        }
        public async Task Send(JObject value)
        {
            var bytes = Encoding.UTF8.GetBytes(value.ToString(Newtonsoft.Json.Formatting.None));
            if (bytes.Length > 4096) throw new InvalidDataException("Chat message is too large.");
            await sendLock.WaitAsync(cancel.Token).ConfigureAwait(false);
            try { await socket.SendAsync(new ArraySegment<byte>(bytes), WebSocketMessageType.Text, true, cancel.Token).ConfigureAwait(false); }
            finally { sendLock.Release(); }
        }
        public void Dispose() { cancel.Cancel(); socket.Abort(); socket.Dispose(); }
    }
}
