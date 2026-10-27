using System;
using System.IO;
using BrilliantSkies.Modding;
using BrilliantSkies.Core.Timing;
using BrilliantSkies.Ftd.Modes.MainMenu.Ui;
using BrilliantSkies.Ftd.Maps.Generation;
using BrilliantSkies.Ftd.Planets;
using BrilliantSkies.Ftd.Planets.World;
using BrilliantSkies.FromTheDepths.Planets.Map;
using Newtonsoft.Json;
using UnityEngine;

// Development-only export of the same terrain samples used by FTD's campaign map.
// Never shipped in the ranked mod or Worker. No changes to the installed worlds.
public sealed class MapExport : GamePlugin
{
    public string name => "Ranked map export";
    public Version version => new Version(0, 1, 0);
    static string root;
    static int stage;
    public void OnSave() { }
    public void OnLoad()
    {
        root = Path.GetFullPath(Path.Combine(Path.GetDirectoryName(typeof(MapExport).Assembly.Location), "../../../.."));
        Application.runInBackground = true;
        GameEvents.UpdateEvent.RegWithEvent(Update);
    }
    static void Update(ITimeStep step)
    {
        if (stage == 99 || GAME_STATE.GetGameType() != enumGameType.mainmenu || Time.realtimeSinceStartup < 12) return;
        try
        {
            if (stage == 0) { new MainMenu().LoadNeter(); Export("neter"); stage = 1; }
            else { new MainMenu().LoadAote(); Export("aote"); File.WriteAllText(Path.Combine(root, "map-export-pass"), "PASS"); stage = 99; }
        }
        catch (Exception e) { stage = 99; File.WriteAllText(Path.Combine(root, "map-export-error.txt"), e.ToString()); }
    }
    static void Export(string id)
    {
        var layout = WorldSpecification.i.BoardLayout;
        var generator = new MapGenerator { heightMap = new float[MapConstants.HeightMapResolution, MapConstants.HeightMapResolution] };
        for (int x = 0; x < layout.EastWestTerrainCount; x++)
            for (int y = 0; y < layout.NorthSouthTerrainCount; y++)
                generator.GenerateHeightMapForTerrain(x, y, false);
        // Exclude MapConstants' rendering margins and unused terminal row/column.
        int width = MapConstants.HeightMapResolutionPerTerrain * layout.EastWestTerrainCount;
        int height = MapConstants.HeightMapResolutionPerTerrain * layout.NorthSouthTerrainCount;
        using (var writer = new BinaryWriter(File.Create(Path.Combine(root, id + ".heights"))))
            for (int north = 0; north < height; north++)
                for (int east = 0; east < width; east++)
                    writer.Write(generator.heightMap[MapConstants.MarginNorthSouth + north, MapConstants.MarginEastWest + east] * layout.TerrainHeight + layout.SeaBed);
        var origin = StaticCoordTransforms.BoardSectionToUniversalPosition(-0.5f, -0.5f);
        var end = StaticCoordTransforms.BoardSectionToUniversalPosition(layout.EastWestBoardSectionCount - 0.5f, layout.NorthSouthBoardSectionCount - 0.5f);
        File.WriteAllText(Path.Combine(root, id + ".json"), JsonConvert.SerializeObject(new {
            world = id, gameVersion = "4.3.4.1", width, height,
            eastMax = layout.EastWestBoardSectionCount, northMax = layout.NorthSouthBoardSectionCount,
            tileSize = layout.BoardSectionSize, originX = origin.x, originZ = origin.z, endX = end.x, endZ = end.z,
            rowOrder = "south-to-north", columnOrder = "west-to-east",
            source = "FTD MapGenerator.GenerateHeightMapForTerrain; world data; full playable rectangle without map margins"
        }, Formatting.Indented));
    }
}
