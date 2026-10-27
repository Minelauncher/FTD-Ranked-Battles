using System.Linq;
using System.Collections.Generic;
using System.Reflection.Emit;
using HarmonyLib;
using BrilliantSkies.Ftd.Avatar.Movement;
using BrilliantSkies.Ftd.Avatar.HUD;
using BrilliantSkies.Ftd.Avatar.Control;
using BrilliantSkies.Ftd.Planets.World;
using BrilliantSkies.Ftd.Cameras;
using BrilliantSkies.Ftd.Modes.CustomBattleMode;
using BrilliantSkies.Ftd.Terrain;
using BrilliantSkies.Ui.Consoles.Styles;
using BrilliantSkies.Ui.Displayer;
using CamControl;
using UnityEngine;

namespace FtdRank
{
    public sealed class RankSpectator : MonoBehaviour, ICameraMode
    {
        public enum View { Free, Follow, Overview, Top }
        public static RankSpectator Instance { get; private set; }
        public static bool Active => Instance != null && Instance.Valid;
        public static cCameraControl NativeCamera => cHud.GetSingleton()?.CameraControl?._i_cHud_cCameraControl as cCameraControl;
        public static string Description => !Active ? L.T("전장 준비 / Preparing") :
            Instance.view == View.Free ? L.T("자유 시점 / Free camera") :
            (Instance.view == View.Top ? L.T("위에서 보기 / Top view") : Instance.view == View.Overview ? L.T("전체 보기 / Overview") : L.T("추적 / Follow")) +
            (Instance.target != null && Instance.target.Exists ? " · " + RankClient.Safe(Instance.target.Name) : "");
        public View CurrentView => NativeCamera?.IsConstructMode == true ? View.Follow : view;
        public CustomBattleVehicle Target => target;
        View view;
        CustomBattleVehicle target;
        float yaw = 0, pitch = 25, distance = 500;
        bool active;
        public bool Valid => active && RankBattle.InArena;
        public bool SmoothEntrance => false;
        public bool SmoothExit => false;
        public Transform Transform => transform;
        public Vector3 BasePosition { get => transform.position; set => transform.position = value; }
        public Vector3 LocalPositionRelativeToTransform => Vector3.zero;
        public Quaternion LocalRotationRelativeToTransform => Quaternion.identity;
        public void Enter(ICameraMode previousMode) { }
        public void Reenter() { }
        public void Supersede(ICameraMode nextMode) { }
        public void Exit() { Destroy(gameObject); }
        public static void Begin()
        {
            if (!Active) Instance = new GameObject("Ranked spectator camera").AddComponent<RankSpectator>();
            Instance.active = true;
            NativeCamera?.TurnOffFireMode();
            Overview();
        }
        public static void End() { if (Instance != null) { Instance.active = false; Destroy(Instance.gameObject); Instance = null; } }
        static CustomBattleVehicle[] Vehicles() => CustomBattleModeProgression.State.Teams
            .SelectMany(t => t.Vehicles).Where(v => v.Exists).ToArray();
        public static void OpenMenu() { if (RankBattle.InArena) new SpectatorUi().ActivateGui(GuiActivateType.Stack); }
        public static void Free()
        {
            if (!Active) return;
            Instance.view = View.Free;
            NativeCamera?.EnterFreeCameraMode();
        }
        public static void Follow(CustomBattleVehicle vehicle)
        {
            if (!Active || vehicle == null || !vehicle.Exists) return;
            Instance.target = vehicle; Instance.view = View.Follow; Instance.pitch = 22;
            Instance.yaw = vehicle.Construct.MainThreadRotation.eulerAngles.y;
            Instance.distance = Mathf.Clamp(vehicle.Construct.AllBasics.GetActualMaxDimension() * 2.5f, 35, 1500);
            var control = NativeCamera;
            if (control != null) {
                control.FocusThisConstruct(vehicle.Construct);
                control.ConstructCamera.PivotDistance = Instance.distance;
            } else Instance.PlaceCamera();
        }
        public static void Cycle(int direction)
        {
            if (!Active) return;
            var list = Vehicles(); if (list.Length == 0) { Overview(); return; }
            int index = System.Array.IndexOf(list, Instance.target);
            Follow(list[index < 0 ? (direction < 0 ? list.Length - 1 : 0) : (index + direction + list.Length) % list.Length]);
        }
        public static void Overview()
        {
            if (!Active) return;
            Instance.target = null; Instance.view = View.Overview; Instance.yaw = 0; Instance.pitch = 38;
            var positions = Positions();
            var bounds = new Bounds(positions.Length > 0 ? positions[0] : Vector3.zero, Vector3.one * 100);
            foreach (var p in positions) bounds.Encapsulate(p);
            Instance.distance = Mathf.Clamp(bounds.size.magnitude * .9f, 150, 10000);
            Instance.PlaceCamera();
        }
        public static void Top()
        {
            if (!Active) return;
            Instance.view = View.Top; Instance.PlaceCamera();
        }
        void Update()
        {
            if (!Valid) return;
            var control = NativeCamera;
            if (control?.IsConstructMode == true) {
                target = Vehicles().FirstOrDefault(v => v.Construct == control.AnchorConstruct);
                view = View.Follow;
            } else if (view == View.Follow && control?.IsFreeMode == true) view = View.Free;
            switch (RankClient.Settings.Keys.Pressed(Input.GetKeyDown, Input.GetKey, GuiDisplayer.HasOpenWindow)) {
                case RankAction.FreeCamera: Free(); break;
                case RankAction.PreviousVehicle: Cycle(-1); break;
                case RankAction.NextVehicle: Cycle(1); break;
                case RankAction.TopView: Top(); break;
            }
        }
        static Vector3[] Positions()
        {
            var list = Vehicles();
            return list.Length > 0 ? list.Select(v => v.Position).ToArray() :
                CustomBattleModeProgression.State.Settings.Teams.SelectMany(t => t.Blueprints).Select(bp => bp.GLobalPosition).ToArray();
        }
        public void LateUpdateFromCamControllerWhenActive()
        {
            if (!Valid) return;
            if (target != null && !target.Exists) { target = null; Overview(); }
            if (!GuiDisplayer.HasOpenWindow && GuiDisplayBase.MouseOverGuiElement == MouseOverGuiElementStatus.None)
            {
                if (Input.GetMouseButton(1))
                {
                    yaw += Input.GetAxis("Mouse X") * 3;
                    pitch = Mathf.Clamp(pitch - Input.GetAxis("Mouse Y") * 3, -80, 85);
                }
                float wheel = Input.mouseScrollDelta.y;
                if (view == View.Free)
                {
                    transform.rotation = Quaternion.Euler(pitch, yaw, 0);
                    CameraManager.GetSingleton().CamControl.PlayerControlOfCamera(this, false);
                    transform.position += transform.forward * wheel * 20;
                }
                else distance = Mathf.Clamp(distance * Mathf.Pow(.88f, wheel), 15, 10000);
            }
            if (view != View.Free) PlaceCamera();
        }
        void PlaceCamera()
        {
            Vector3 centre;
            if (target != null && target.Exists) centre = target.Position;
            else
            {
                var list = Positions(); centre = Vector3.zero;
                foreach (var v in list) centre += v;
                if (list.Length > 0) centre /= list.Length;
            }
            Quaternion rotation = Quaternion.Euler(view == View.Top ? 89.9f : pitch, yaw, 0);
            Vector3 position = centre - rotation * Vector3.forward * distance;
            position.y = Mathf.Max(position.y, WorldSpecification.i.Physics.WaterLevel + 20,
                StaticTerrainAltitude.AltitudeForGameWorldPositionInMainFrame(position) + 10);
            rotation = Quaternion.LookRotation(centre - position, Vector3.up);
            transform.SetPositionAndRotation(position, rotation);
            var control = NativeCamera;
            if (control != null) {
                control.MoveFreeCameraTo(position);
                control.FreeCamera.Transform.rotation = rotation;
                control.FreeCamera.MouseLook.Match();
            } else CameraManager.GetSingleton().CamControl.AddCameraMode(this);
        }
        void OnGUI()
        {
            if (!Valid || GuiDisplayer.HasOpenWindow) return;
            var style = new GUIStyle(ConsoleStyles.Instance.Styles.Buttons.Button.Style) { fontSize = 13, wordWrap = true };
            if (GUI.Button(new Rect(12, Screen.height - 78, Mathf.Min(680, Screen.width - 24), 66),
                Description + " · " + L.T("Keys.CameraMenu") + "\n" + RankClient.Settings.Keys.Summary, style)) OpenMenu();
        }
    }
    [HarmonyPatch(typeof(CamController), nameof(CamController.AddCameraMode))]
    static class RankedCameraGuard
    {
        static bool Prefix(ICameraMode cameraMode) => !RankSpectator.Active || ReferenceEquals(cameraMode, RankSpectator.Instance)
            || ReferenceEquals(cameraMode, RankSpectator.NativeCamera?.FreeCamera)
            || ReferenceEquals(cameraMode, RankSpectator.NativeCamera?.ConstructCamera);
    }

    // Only the native camera's ownership check is relaxed. Construct ownership never changes.
    [HarmonyPatch(typeof(cCameraControl), nameof(cCameraControl.RunLateUpdate))]
    static class RankedCameraFocusGuard
    {
        static void ClearInvalidFocus(ConstructFocusMode mode) {
            if (!RankBattle.InArena || mode.ConstructToFocus == null || mode.ConstructToFocus.Destroyed) mode.WipeFocus();
        }
        static IEnumerable<CodeInstruction> Transpiler(IEnumerable<CodeInstruction> instructions) {
            var wipe = AccessTools.Method(typeof(ConstructFocusMode), nameof(ConstructFocusMode.WipeFocus));
            foreach (var instruction in instructions) {
                if (instruction.Calls(wipe)) { instruction.opcode = OpCodes.Call; instruction.operand = AccessTools.Method(typeof(RankedCameraFocusGuard), nameof(ClearInvalidFocus)); }
                yield return instruction;
            }
        }
    }
    [HarmonyPatch(typeof(bControl), "ControlMode", MethodType.Getter)]
    static class RankedVehicleInputGuard {
        static bool Prefix(ref ConstructControlMode __result) {
            if (!RankBattle.InArena) return true;
            __result = ConstructControlMode.Off_Camera; return false;
        }
    }
    [HarmonyPatch(typeof(cControl), nameof(cControl.ToggleControlMode))]
    static class RankedControlToggleGuard { static bool Prefix() => !RankBattle.InArena; }
    [HarmonyPatch(typeof(cFireControl), "DetermineIfAbleToControlWeapons")]
    static class RankedFireGuard { static bool Prefix(ref bool __result) { if (!RankBattle.InArena) return true; __result = false; return false; } }
    [HarmonyPatch(typeof(cFireControl), "ToggleMeAi")]
    static class RankedWeaponSlotGuard { static bool Prefix() => !RankBattle.InArena; }
    [HarmonyPatch(typeof(cFireControl), nameof(cFireControl.ToggleFireMode))]
    static class RankedFireToggleGuard { static bool Prefix(cFireControl __instance) => !RankBattle.InArena || __instance.IsInFireMode; }
    [HarmonyPatch]
    static class RankedManualFireGuard {
        static System.Reflection.MethodBase TargetMethod() => AccessTools.GetDeclaredMethods(typeof(cFireControl)).Single(m => m.Name.EndsWith(".Fire"));
        static bool Prefix() => !RankBattle.InArena;
    }
    [HarmonyPatch(typeof(cCameraControl), "TargetConstruct", MethodType.Setter)]
    static class RankedCameraTargetScope {
        internal static int Depth;
        static void Prefix() { if (RankBattle.InArena) Depth++; }
        static void Finalizer() { if (Depth > 0) Depth--; }
    }
    [HarmonyPatch(typeof(AITargetControl), nameof(AITargetControl.MakePrioritisedTarget))]
    static class RankedCameraTargetGuard { static bool Prefix() => RankedCameraTargetScope.Depth == 0; }
}
