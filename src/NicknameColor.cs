using System;
using System.Globalization;
using Newtonsoft.Json.Linq;
using UnityEngine;

namespace FtdRank
{
    public static class NicknameColor
    {
        public static string Normalize(string value)
        {
            if (value == null || value.Length != 7 || value[0] != '#') return null;
            for (int i = 1; i < 7; i++) if (!Uri.IsHexDigit(value[i])) return null;
            return value.ToUpperInvariant();
        }
        public static Color Read(string value, Color fallback)
        {
            var hex = Normalize(value); if (hex == null) return fallback;
            int rgb = int.Parse(hex.Substring(1), NumberStyles.HexNumber, CultureInfo.InvariantCulture);
            return new Color32((byte)(rgb >> 16), (byte)(rgb >> 8), (byte)rgb, 255);
        }
        // Only generated color markup is enabled; names never supply rich-text tags.
        public static string Rich(string name, string value)
        {
            string safe = RankClient.Safe(name), hex = Normalize(value);
            return hex == null ? safe : "<color=" + hex + ">" + safe + "</color>";
        }
        public static string Rich(JToken account) => Rich(RankClient.Text(account, "name"), RankClient.Text(account, "nicknameColor"));
    }
}
