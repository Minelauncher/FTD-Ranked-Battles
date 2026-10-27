using System;

namespace FtdRank
{
    public sealed class BlueprintDownloadProgress
    {
        public readonly int Completed, Total;
        public readonly string Name;
        public readonly long Received;
        public readonly long? Length;
        public readonly bool Verifying;
        public BlueprintDownloadProgress(int completed, int total, string name, long received, long? length, bool verifying = false)
        { Completed = completed; Total = total; Name = name; Received = received; Length = length; Verifying = verifying; }
        public override string ToString()
        {
            if (Total > 0 && Completed == Total) return L.T("BP 다운로드 완료 / Download complete · ") + Total + "/" + Total;
            string size = (Received / 1024d).ToString("0.0") + " KiB";
            if (Length > 0) size += " / " + (Length.Value / 1024d).ToString("0.0") + " KiB · " + Math.Min(100, Received * 100d / Length.Value).ToString("0") + "%";
            return L.T("BP 다운로드 / Download · 완료 / Done ") + Completed + "/" + Total + "\n" + Name + " · " + size + (Verifying ? L.T(" · 검증 / Verifying") : "");
        }
    }
}
