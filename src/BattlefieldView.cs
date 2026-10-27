using System;

namespace FtdRank
{
    // North-up image coordinates; same playable rectangle as the administrator map.
    public readonly struct BattlefieldView
    {
        public readonly double X, Y, Left, Top, Size;
        public BattlefieldView(double east, double north, double maximum, double zoom)
        {
            if (double.IsNaN(east) || double.IsNaN(north) || double.IsInfinity(east) || double.IsInfinity(north) || maximum <= 0 || east < 0 || east > maximum || north < 0 || north > maximum)
                throw new InvalidOperationException(L.T("전장 좌표가 지도 범위를 벗어납니다."));
            X = east / maximum; Y = 1 - north / maximum;
            Size = 1 / Math.Max(1, Math.Min(8, zoom));
            Left = Math.Max(0, Math.Min(1 - Size, X - Size / 2));
            Top = Math.Max(0, Math.Min(1 - Size, Y - Size / 2));
        }
        public double MarkerX => (X - Left) / Size;
        public double MarkerY => (Y - Top) / Size;
    }
}
