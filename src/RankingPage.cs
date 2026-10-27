using System;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;

namespace FtdRank
{
    public sealed class RankingPage
    {
        public const int Size = 100;
        public bool Loaded { get; private set; }
        public int Page { get; private set; } = 1;
        public int Total { get; private set; }
        public int TotalPages => Math.Max(1, (int)Math.Ceiling(Total / (double)Size));
        public bool HasPrevious => Loaded && Page > 1;
        public bool HasNext => Loaded && Page < TotalPages;
        public int First => Total == 0 ? 0 : (Page - 1) * Size + 1;
        public int Last => (int)Math.Min((long)Page * Size, Total);
        public string Summary => L.F("Ranking.Page", Page, TotalPages);
        public string Range => L.F("Ranking.Range", First, Last, Total);

        public static RankingPage Read(JObject response)
        {
            var state = new RankingPage { Loaded = true, Page = response.Value<int?>("page") ?? 0,
                Total = response.Value<int?>("total") ?? -1 };
            if (state.Total < 0 || state.Page < 1 || state.Page > state.TotalPages ||
                response.Value<int?>("pageSize") != Size || response.Value<int?>("totalPages") != state.TotalPages ||
                !(response["accounts"] is JArray accounts) || accounts.Count != state.Last - state.First + (state.Total == 0 ? 0 : 1))
                throw new JsonException(L.T("Ranking.InvalidResponse"));
            return state;
        }
    }
}
