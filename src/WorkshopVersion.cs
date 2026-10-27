using System;
using System.Globalization;
using System.IO;
using Newtonsoft.Json.Linq;

namespace FtdRank
{
    internal static class WorkshopVersion
    {
        const string Prefix = "Mod latest version ";

        internal static ulong ReadId(string metadata)
        {
            if (string.IsNullOrWhiteSpace(metadata)) return 0;
            try
            {
                var token = JObject.Parse(metadata)["workshop_id"];
                if (token == null || (token.Type != JTokenType.String && token.Type != JTokenType.Integer)) return 0;
                return ulong.TryParse(token.ToString().Trim(), NumberStyles.None, CultureInfo.InvariantCulture, out var id) ? id : 0;
            }
            catch (Newtonsoft.Json.JsonException) { return 0; }
        }

        internal static Version NewerVersion(string description, Version installed)
        {
            if (string.IsNullOrEmpty(description)) return null;
            using (var reader = new StringReader(description))
            {
                string line;
                while ((line = reader.ReadLine()) != null)
                {
                    line = line.Trim();
                    if (!line.StartsWith(Prefix, StringComparison.OrdinalIgnoreCase)) continue;
                    if (!Version.TryParse(line.Substring(Prefix.Length).Trim(), out var latest)) continue;
                    // System.Version treats omitted components as -1; 1.2.3 and 1.2.3.0 are the same release.
                    return Normalize(latest).CompareTo(Normalize(installed)) > 0 ? latest : null;
                }
            }
            return null;
        }

        static Version Normalize(Version v) => new Version(v.Major, v.Minor, Math.Max(0, v.Build), Math.Max(0, v.Revision));
    }
}
