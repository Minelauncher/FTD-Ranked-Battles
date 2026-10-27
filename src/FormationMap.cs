using System;

namespace FtdRank
{
    // Same scale on both axes, with the enemy/front at the top. Independent of Unity for tests.
    public readonly struct FormationMap
    {
        public readonly double Left, Top, Width, Height, Scale, HalfWidth, Depth;
        public FormationMap(double left, double top, double width, double height, double halfWidth, double depth)
        {
            HalfWidth = Math.Max(0, halfWidth); Depth = Math.Max(0, depth);
            Scale = Math.Max(.000001, Math.Min(Math.Max(1, width) / Math.Max(1, 2 * HalfWidth), Math.Max(1, height) / Math.Max(1, Depth)));
            Width = 2 * HalfWidth * Scale; Height = Depth * Scale;
            Left = left + (width - Width) / 2; Top = top + (height - Height) / 2;
        }
        public double ScreenX(double x) => Left + (x + HalfWidth) * Scale;
        public double ScreenY(double z) => Top - z * Scale;
        public double WorldX(double x) => FleetPlan.Round(Math.Max(-HalfWidth, Math.Min(HalfWidth, (x - Left) / Scale - HalfWidth)));
        public double WorldZ(double y) => FleetPlan.Round(Math.Max(-Depth, Math.Min(0, -(y - Top) / Scale)));
        public double SnapX(double x, double step) => FleetPlan.Round(Math.Max(-HalfWidth, Math.Min(HalfWidth, step > 0 ? Math.Round(x / step) * step : x)));
        public double SnapZ(double z, double step) => FleetPlan.Round(Math.Max(-Depth, Math.Min(0, step > 0 ? Math.Round(z / step) * step : z)));
    }
}
