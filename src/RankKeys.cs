using System;
using System.Collections.Generic;
using System.Linq;
using Newtonsoft.Json;
using UnityEngine;

namespace FtdRank
{
    public enum RankAction { FreeCamera, PreviousVehicle, NextVehicle, TopView }
    [Flags] public enum RankKeyModifiers { None = 0, Shift = 1, Control = 2, Alt = 4, Command = 8 }

    // One key plus modifiers per action. None is an explicit, persistent opt-out.
    public sealed class RankKeyBindings
    {
        public KeyCode FreeCamera = KeyCode.F6;
        public KeyCode PreviousVehicle = KeyCode.F7;
        public KeyCode NextVehicle = KeyCode.F8;
        public KeyCode TopView = KeyCode.F9;
        public RankKeyModifiers? FreeCameraModifiers, PreviousVehicleModifiers, NextVehicleModifiers, TopViewModifiers;
        public static IEnumerable<RankAction> Actions => (RankAction[])Enum.GetValues(typeof(RankAction));
        public KeyCode Get(RankAction action)
        {
            switch (action) {
                case RankAction.FreeCamera: return FreeCamera;
                case RankAction.PreviousVehicle: return PreviousVehicle;
                case RankAction.NextVehicle: return NextVehicle;
                case RankAction.TopView: return TopView;
                default: throw new ArgumentOutOfRangeException(nameof(action));
            }
        }
        public RankKeyModifiers Modifiers(RankAction action)
        {
            RankKeyModifiers? stored;
            switch (action) {
                case RankAction.FreeCamera: stored = FreeCameraModifiers; break;
                case RankAction.PreviousVehicle: stored = PreviousVehicleModifiers; break;
                case RankAction.NextVehicle: stored = NextVehicleModifiers; break;
                case RankAction.TopView: stored = TopViewModifiers; break;
                default: throw new ArgumentOutOfRangeException(nameof(action));
            }
            // Old default F6-F9 bindings gain Shift; custom keys and unbound actions stay as saved.
            return stored ?? (Get(action) == (KeyCode)((int)KeyCode.F6 + (int)action) ? RankKeyModifiers.Shift : RankKeyModifiers.None);
        }
        void Set(RankAction action, KeyCode key, RankKeyModifiers modifiers)
        {
            switch (action) {
                case RankAction.FreeCamera: FreeCamera = key; FreeCameraModifiers = modifiers; break;
                case RankAction.PreviousVehicle: PreviousVehicle = key; PreviousVehicleModifiers = modifiers; break;
                case RankAction.NextVehicle: NextVehicle = key; NextVehicleModifiers = modifiers; break;
                case RankAction.TopView: TopView = key; TopViewModifiers = modifiers; break;
                default: throw new ArgumentOutOfRangeException(nameof(action));
            }
        }
        public static bool IsModifier(KeyCode key) => key == KeyCode.LeftShift || key == KeyCode.RightShift ||
            key == KeyCode.LeftControl || key == KeyCode.RightControl || key == KeyCode.LeftAlt || key == KeyCode.RightAlt ||
            key == KeyCode.LeftCommand || key == KeyCode.RightCommand || key == KeyCode.LeftWindows || key == KeyCode.RightWindows || key == KeyCode.AltGr;
        public static bool Allowed(KeyCode key) => key == KeyCode.None ||
            (key != KeyCode.Escape && !IsModifier(key) && key < KeyCode.Mouse0 && Enum.IsDefined(typeof(KeyCode), key));
        public static bool Allowed(RankKeyModifiers modifiers) => (modifiers & ~(RankKeyModifiers.Shift | RankKeyModifiers.Control | RankKeyModifiers.Alt | RankKeyModifiers.Command)) == 0;
        public bool TryChange(RankAction action, KeyCode key, RankKeyModifiers modifiers, out RankKeyBindings updated, out string error)
        {
            updated = null; error = null;
            if (!Allowed(key) || !Allowed(modifiers)) { error = L.T("Keys.KeyboardOnly"); return false; }
            if (key == KeyCode.None) modifiers = RankKeyModifiers.None;
            foreach (var other in Actions)
                if (other != action && key != KeyCode.None && Get(other) == key && Modifiers(other) == modifiers) {
                    error = L.F("Keys.Duplicate", Label(key, modifiers), ActionName(other)); return false;
                }
            updated = (RankKeyBindings)MemberwiseClone(); updated.Set(action, key, modifiers); return true;
        }
        public RankKeyBindings Normalize()
        {
            var result = (RankKeyBindings)MemberwiseClone();
            var used = new HashSet<(KeyCode, RankKeyModifiers)>();
            foreach (var action in Actions) {
                var key = Get(action); var modifiers = Modifiers(action);
                // A hand-edited or corrupt binding must never dispatch two actions.
                if (!Allowed(key) || !Allowed(modifiers) || (key != KeyCode.None && !used.Add((key, modifiers)))) key = KeyCode.None;
                result.Set(action, key, key == KeyCode.None ? RankKeyModifiers.None : modifiers);
            }
            return result;
        }
        public static RankKeyModifiers HeldModifiers(Func<KeyCode, bool> held)
        {
            var result = RankKeyModifiers.None;
            if (held(KeyCode.LeftShift) || held(KeyCode.RightShift)) result |= RankKeyModifiers.Shift;
            if (held(KeyCode.LeftControl) || held(KeyCode.RightControl)) result |= RankKeyModifiers.Control;
            if (held(KeyCode.LeftAlt) || held(KeyCode.RightAlt) || held(KeyCode.AltGr)) result |= RankKeyModifiers.Alt;
            if (held(KeyCode.LeftCommand) || held(KeyCode.RightCommand) || held(KeyCode.LeftWindows) || held(KeyCode.RightWindows)) result |= RankKeyModifiers.Command;
            return result;
        }
        public RankAction? Pressed(Func<KeyCode, bool> pressed, Func<KeyCode, bool> held, bool blocked)
        {
            if (blocked) return null;
            var modifiers = HeldModifiers(held);
            foreach (var action in Actions) {
                var key = Get(action);
                if (key != KeyCode.None && Allowed(key) && Modifiers(action) == modifiers && pressed(key)) return action;
            }
            return null;
        }
        public static string ActionName(RankAction action) => L.T("Keys." + action);
        public static string Label(KeyCode key, RankKeyModifiers modifiers)
        {
            if (key == KeyCode.None) return L.T("Keys.Disabled");
            string prefix = "";
            if ((modifiers & RankKeyModifiers.Control) != 0) prefix += "Ctrl+";
            if ((modifiers & RankKeyModifiers.Alt) != 0) prefix += "Alt+";
            if ((modifiers & RankKeyModifiers.Shift) != 0) prefix += "Shift+";
            if ((modifiers & RankKeyModifiers.Command) != 0) prefix += "Cmd+";
            return prefix + (key >= KeyCode.Alpha0 && key <= KeyCode.Alpha9 ? ((int)key - (int)KeyCode.Alpha0).ToString() : key.ToString());
        }
        public string Label(RankAction action) => Label(Get(action), Modifiers(action));
        [JsonIgnore] public string Summary => string.Join(" · ", Actions.Select(a => ActionName(a) + ": " + Label(a)));
    }
}
