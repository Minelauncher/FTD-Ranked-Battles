using System;
using System.IO;
using System.Text.RegularExpressions;

namespace FtdRank
{
    // Only files created by ranked battle preparation; never a user's BP library.
    public static class MatchStorage
    {
        public static bool Clear(string modDirectory, string matchId)
        {
            if (!Regex.IsMatch(matchId ?? "", @"\A[a-f0-9]{32}\z")) return false;
            string root = Path.GetFullPath(Path.Combine(modDirectory, "Matches"));
            string target = Path.GetFullPath(Path.Combine(root, matchId));
            if (!target.StartsWith(root + Path.DirectorySeparatorChar, StringComparison.Ordinal)) return false;
            try
            {
                if (!Directory.Exists(target)) return true;
                if ((File.GetAttributes(root) & FileAttributes.ReparsePoint) != 0 || (File.GetAttributes(target) & FileAttributes.ReparsePoint) != 0) return false;
                foreach (string file in Directory.GetFiles(target))
                {
                    string name = Path.GetFileName(file);
                    if (!Regex.IsMatch(name, @"\A(result\.json|[a-f0-9]{64}\.blueprint)(\.bak|\.[a-f0-9]{32}\.tmp)?\z")) continue;
                    if ((File.GetAttributes(file) & FileAttributes.ReparsePoint) == 0) File.Delete(file);
                }
                if (Directory.GetFileSystemEntries(target).Length == 0) Directory.Delete(target, false);
                return !Directory.Exists(target);
            }
            catch (IOException) { return false; }
            catch (UnauthorizedAccessException) { return false; }
        }
        public static void Sweep(string modDirectory)
        {
            string root = Path.Combine(modDirectory, "Matches");
            try
            {
                if (!Directory.Exists(root) || (File.GetAttributes(root) & FileAttributes.ReparsePoint) != 0) return;
                foreach (string dir in Directory.GetDirectories(root)) Clear(modDirectory, Path.GetFileName(dir));
            }
            catch (IOException) { }
            catch (UnauthorizedAccessException) { }
        }
    }
}
