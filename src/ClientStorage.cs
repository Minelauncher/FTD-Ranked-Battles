using System;
using System.IO;
using System.Text;
using System.Text.RegularExpressions;

namespace FtdRank
{
    // Keep writable installations in place. Read-only installations use FTD's
    // own save root, including its SaveLocation override, rather than the OS cwd.
    public static class ClientStorage
    {
        static readonly object gate = new object();
        static readonly UTF8Encoding utf8 = new UTF8Encoding(false, true);
        static bool StorageFailure(Exception e) => e is IOException || e is UnauthorizedAccessException || e is NotSupportedException;

        public static string Open(string modDirectory, string gameSaveRoot)
        {
            if (string.IsNullOrWhiteSpace(gameSaveRoot) || !Path.IsPathRooted(gameSaveRoot))
                throw new IOException("FTD did not provide an absolute save directory.");
            string fallback = Path.GetFullPath(Path.Combine(gameSaveRoot, "RankedBattles"));
            // Once fallback storage exists, keep using it even if permissions change.
            if (!Directory.Exists(fallback) && !string.IsNullOrWhiteSpace(modDirectory) && Path.IsPathRooted(modDirectory))
            {
                try { return Writable(modDirectory); }
                catch (Exception e) when (StorageFailure(e)) { }
            }
            Writable(fallback);
            string marker = Path.Combine(fallback, ".storage-ready");
            if (!File.Exists(marker))
            {
                // Copy only our state, never DLLs or arbitrary files. Retain sources
                // and finish the marker last, so an interrupted copy can resume.
                if (!string.IsNullOrWhiteSpace(modDirectory) && Directory.Exists(modDirectory))
                {
                    foreach (string name in new[] { "client.json", "pending-result.json", "client.json.bak", "pending-result.json.bak" })
                        Import(Path.Combine(modDirectory, name), Path.Combine(fallback, name));
                    foreach (string folder in new[] { "Drafts", "FleetBlueprints" })
                    {
                        string source = Path.Combine(modDirectory, folder);
                        if (!Directory.Exists(source)) continue;
                        foreach (string file in Directory.GetFiles(source))
                            if (Regex.IsMatch(Path.GetFileName(file), folder == "Drafts" ? @"\A[a-f0-9]{64}\.json(\.bak)?\z" : @"\A[a-f0-9]{64}\.blueprint\z"))
                                Import(file, Path.Combine(fallback, folder, Path.GetFileName(file)));
                    }
                }
                WriteText(marker, "1");
            }
            return fallback;
        }

        static string Writable(string directory)
        {
            string full = Path.GetFullPath(directory);
            Directory.CreateDirectory(full);
            string probe = Path.Combine(full, ".write-test-" + Guid.NewGuid().ToString("N"));
            try { using (new FileStream(probe, FileMode.CreateNew, FileAccess.Write, FileShare.None)) { } }
            finally { if (File.Exists(probe)) File.Delete(probe); }
            return full;
        }
        static void Import(string source, string destination)
        {
            if (!File.Exists(source) || File.Exists(destination)) return;
            Directory.CreateDirectory(Path.GetDirectoryName(destination));
            // A partial destination must never be mistaken for a finished copy.
            WriteBytes(destination, File.ReadAllBytes(source));
        }
        static void Recover(string path)
        {
            if (!File.Exists(path) && File.Exists(path + ".bak")) File.Move(path + ".bak", path);
        }
        public static string ReadText(string path)
        {
            lock (gate) { Recover(path); return File.Exists(path) ? File.ReadAllText(path, utf8) : null; }
        }
        public static void Delete(string path)
        {
            lock (gate)
            {
                // Remove recovery state first: an acknowledged match must not
                // reappear from a stale backup after the primary file is deleted.
                if (File.Exists(path + ".bak")) File.Delete(path + ".bak");
                if (File.Exists(path)) File.Delete(path);
            }
        }
        public static void WriteText(string path, string text)
            => WriteBytes(path, utf8.GetBytes(text));
        static void WriteBytes(string path, byte[] bytes)
        {
            lock (gate)
            {
                Directory.CreateDirectory(Path.GetDirectoryName(Path.GetFullPath(path)));
                Recover(path);
                string temp = path + "." + Guid.NewGuid().ToString("N") + ".tmp";
                try
                {
                    using (var stream = new FileStream(temp, FileMode.CreateNew, FileAccess.Write, FileShare.None))
                    { stream.Write(bytes, 0, bytes.Length); stream.Flush(true); }
                    if (!File.Exists(path)) File.Move(temp, path);
                    else
                    {
                        try { File.Replace(temp, path, null); }
                        catch (PlatformNotSupportedException) { CommitWithRename(temp, path); }
                    }
                }
                finally { if (File.Exists(temp)) File.Delete(temp); }
            }
        }
        // Mono/filesystems without File.Replace still retain the previous file
        // until the new one is installed. Recover handles a crash between moves.
        internal static void CommitWithRename(string temp, string path)
        {
            string backup = path + ".bak";
            if (File.Exists(backup)) File.Delete(backup);
            File.Move(path, backup);
            try { File.Move(temp, path); }
            catch { if (!File.Exists(path)) File.Move(backup, path); throw; }
            try { File.Delete(backup); } catch (Exception e) when (StorageFailure(e)) { }
        }
        public static void Log(string directory, Exception error)
        {
            if (string.IsNullOrEmpty(directory)) return;
            try { lock (gate) File.AppendAllText(Path.Combine(directory, "errors.log"), error + "\n", utf8); }
            catch (Exception e) when (StorageFailure(e)) { }
        }
    }
}
