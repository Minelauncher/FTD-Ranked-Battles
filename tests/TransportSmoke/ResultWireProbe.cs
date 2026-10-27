using System;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using FtdRank;
using Newtonsoft.Json.Linq;

static class ResultWireProbe
{
    public static async Task Run()
    {
        var listener = new TcpListener(IPAddress.Loopback, 0); listener.Start();
        string url = "http://127.0.0.1:" + ((IPEndPoint)listener.LocalEndpoint).Port;
        using var stop = new CancellationTokenSource();
        int requests = 0;
        var serving = Task.Run(async () => {
            while (!stop.IsCancellationRequested)
            {
                using var socket = await listener.AcceptTcpClientAsync(stop.Token);
                using var stream = socket.GetStream();
                using var reader = new StreamReader(stream, Encoding.UTF8, false, 1024, true);
                string request = await reader.ReadLineAsync(); string header; int length = 0;
                while (!string.IsNullOrEmpty(header = await reader.ReadLineAsync()))
                    if (header.StartsWith("Content-Length:", StringComparison.OrdinalIgnoreCase)) length = int.Parse(header.Substring(15));
                if (length > 0) { var body = new char[length]; await reader.ReadBlockAsync(body, 0, length); }
                int n = Interlocked.Increment(ref requests); int code; string response;
                if (n == 1 || n == 2) { code = n == 1 ? 503 : 401; response = "<html>Service unavailable</html>"; }
                else if (n == 3 || n == 5) {
                    if (!request.StartsWith("GET /matches/probe ")) throw new Exception("Recovery did not read the authoritative result");
                    code = 200; response = "{\"status\":\"completed\",\"receipt\":{\"matchId\":\"probe\",\"after\":984,\"games\":1}}";
                }
                else if (n == 4) { code = 409; response = "{\"error\":\"Already completed\"}"; }
                else { await Task.Delay(30000, stop.Token); continue; }
                byte[] bytes = Encoding.UTF8.GetBytes(response);
                byte[] head = Encoding.ASCII.GetBytes($"HTTP/1.1 {code} Test\r\nContent-Length: {bytes.Length}\r\nConnection: close\r\n\r\n");
                await stream.WriteAsync(head); await stream.WriteAsync(bytes);
            }
        });
        try
        {
            foreach (int wanted in new[] { 503, 401 })
            {
                try { await RankTransport.SubmitMatchResult(url, null, "probe", true, new JObject()); throw new Exception("Expected HTTP error"); }
                catch (RankApiException error) when (error.StatusCode == wanted) { }
            }
            var recovered = await RankTransport.SubmitMatchResult(url, null, "probe", true, new JObject(), true);
            if ((string)recovered["matchId"] != "probe" || requests != 3) throw new Exception("Recovery made an unnecessary POST");
            var conflict = await RankTransport.SubmitMatchResult(url, null, "probe", true, new JObject());
            if (!JToken.DeepEquals(conflict, recovered) || requests != 5) throw new Exception("409 recovery changed result");
            var watch = Stopwatch.StartNew();
            try { await RankTransport.SubmitMatchResult(url, null, "probe", true, new JObject()); throw new Exception("Stalled result did not time out"); }
            catch (OperationCanceledException) { }
            if (watch.Elapsed.TotalSeconds < 14 || watch.Elapsed.TotalSeconds > 20) throw new Exception("Result request is not bounded to 15 seconds");
            Console.WriteLine("PASS result transport: non-JSON 503/401 status, GET-before-retry without POST, conflict receipt recovery, 15-second stalled-request timeout.");
        }
        finally { stop.Cancel(); listener.Stop(); try { await serving; } catch (OperationCanceledException) { } }
    }
}
