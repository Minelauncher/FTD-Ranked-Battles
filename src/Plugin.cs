using System;
using System.IO;
using HarmonyLib;
using BrilliantSkies.Core.Timing;
using BrilliantSkies.Modding;
using UnityEngine;

namespace FtdRank
{
    public sealed class RankedPlugin : GamePlugin
    {
        public string name => "Ranked Battles";
        public Version version => new Version(RankTransport.ClientVersion);
        public static int MenuBuilt, LobbyBuilt;
        public void OnLoad()
        {
            RankClient.Initialize();
            RankKeyOptions.Register();
            new Harmony("ftdrank.menu").PatchAll(typeof(RankedPlugin).Assembly);
            GameEvents.UpdateEvent.RegWithEvent(Update);
            ModInformation.Initialize();
        }
        public void OnSave() { }
        static void Update(ITimeStep step)
        {
            try
            {
                if (RankBattle.InArena && !RankBattle.Loading && !RankBattle.Running && GAME_STATE.GetGameType() == enumGameType.mainmenu) RankBattle.InArena = false;
                RankClient.Update(); RankBattle.Update();
            }
            catch (Exception e) { ClientStorage.Log(RankClient.DirectoryPath, e); }
        }
    }
}
