using System;
using System.IO;
using System.Linq;
using FtdRank;
using HarmonyLib;
using BrilliantSkies.Ui.Consoles.Examples;
using BrilliantSkies.Ui.Examples.OptionsMenu;
using BrilliantSkies.Ui.Consoles.Interpretters.Simple;
using BrilliantSkies.Ui.Consoles.Interpretters.Subjective.Buttons;
using BrilliantSkies.Ui.Displayer;
using UnityEngine;

public static class KeyProbe
{
    static void Check(bool ok, string error) { if (!ok) throw new Exception(error); }
    static void Click(Button button) => ((Action)AccessTools.Field(typeof(Button), "_fnEffect").GetValue(button))();
    public static void Run()
    {
        int count = FtdOptionsMenuUi.ExtraScreens.Count;
        RankKeyOptions.Register(); RankKeyOptions.Register();
        Check(FtdOptionsMenuUi.ExtraScreens.Count == count, "Options registered more than once");
        var options = new FtdOptionsMenuUi(new OptionsMenu()); options.ActivateGui(GuiActivateType.Stack);
        var window = options.Windows.First();
        Check(window.AllScreens.Count(s => s is RankKeyOptions) == 1, "Native options missing Ranked Battles tab");
        var tab = window.AllScreens.OfType<RankKeyOptions>().Single(); window.Screen = tab;
        var controls = tab.Segments.SelectMany(s => s.Interpretters).ToArray();
        var change = controls.OfType<SubjectiveButton<RankAction>>().ToArray();
        var buttons = controls.OfType<Button>().ToArray();
        Check(change.Length == 4 && buttons.Length == 5, "Missing four key/unbind controls or reset button");
        var path = Path.Combine(RankClient.DirectoryPath, "client.json");
        string original = File.ReadAllText(path);
        var capture = new RankKeyCaptureUi(RankAction.FreeCamera); capture.ActivateGui(GuiActivateType.Stack);
        capture.Capture(new Event { type=EventType.MouseDown, button=0 });
        Check(capture.MenuActive && RankClient.Settings.Keys.FreeCamera == KeyCode.F6, "Mouse click captured");
        capture.Capture(new Event { type=EventType.KeyDown, keyCode=KeyCode.LeftShift, modifiers=EventModifiers.Shift });
        Check(capture.MenuActive && File.ReadAllText(path)==original,"Modifier alone completed capture");
        capture.Capture(new Event { type=EventType.KeyDown, keyCode=KeyCode.F8, modifiers=EventModifiers.Shift });
        Check(capture.MenuActive && RankClient.Settings.Keys.FreeCamera == KeyCode.F6 && File.ReadAllText(path) == original, "Duplicate applied or closed capture");
        var accepted = new Event { type=EventType.KeyDown, keyCode=KeyCode.K, modifiers=EventModifiers.Shift|EventModifiers.Control };
        capture.Capture(accepted);
        Check(!capture.MenuActive && accepted.type == EventType.Used && RankClient.Settings.Keys.FreeCamera == KeyCode.K, "Key capture failed");
        RankClient.Initialize();
        Check(RankClient.Settings.Keys.FreeCamera == KeyCode.K && RankClient.StorageReady, "Changed key not restored on reload");
        Check(RankClient.Settings.Keys.Modifiers(RankAction.FreeCamera)==(RankKeyModifiers.Shift|RankKeyModifiers.Control),"Captured modifiers did not persist");
        Check(RankClient.Settings.Keys.Summary.Contains("Ctrl+Shift+K"),"Camera help omits saved modifiers");
        Click(buttons[1]); // Previous vehicle unbind, through the native button callback.
        RankClient.Initialize();
        Check(RankClient.Settings.Keys.PreviousVehicle == KeyCode.None, "Unbind button did not persist");
        capture = new RankKeyCaptureUi(RankAction.NextVehicle); capture.ActivateGui(GuiActivateType.Stack);
        capture.Capture(new Event { type=EventType.KeyDown, keyCode=KeyCode.Escape });
        Check(!capture.MenuActive && RankClient.Settings.Keys.NextVehicle == KeyCode.F8, "Escape changed a binding");
        capture = new RankKeyCaptureUi(RankAction.NextVehicle); capture.ActivateGui(GuiActivateType.Stack);
        capture.DeactivateGui(); capture.Capture(new Event { type=EventType.KeyDown, keyCode=KeyCode.J });
        Check(RankClient.Settings.Keys.NextVehicle == KeyCode.F8, "Closed capture still listens");
        // Make a real save failure in this isolated test profile; live keys must not change.
        File.Move(path, path + ".key-probe-backup"); Directory.CreateDirectory(path);
        try {
            Check(!RankClient.SetKey(RankAction.TopView, KeyCode.J, RankKeyModifiers.Shift, out var message) && !string.IsNullOrEmpty(message), "Save failure not reported");
            Check(RankClient.Settings.Keys.TopView == KeyCode.F9, "Failed save altered the active binding");
        } finally { Directory.Delete(path); File.Move(path + ".key-probe-backup", path); }
        // A default key is occupied by another action: reset must replace all four atomically.
        Check(RankClient.SetKey(RankAction.TopView, KeyCode.F6, RankKeyModifiers.Shift, out _), "Could not arrange reset collision");
        Click(buttons[4]); RankClient.Initialize();
        Check(RankKeyBindings.Actions.Select(RankClient.Settings.Keys.Get).SequenceEqual(new[] {KeyCode.F6,KeyCode.F7,KeyCode.F8,KeyCode.F9}), "Restore defaults did not persist all four keys");
        Check(RankKeyBindings.Actions.All(a=>RankClient.Settings.Keys.Modifiers(a)==RankKeyModifiers.Shift),"Restore defaults omitted Shift");
        options.DeactivateGui();
    }
}
