using System;
using System.IO;
using System.Linq;
using System.Windows.Forms;
using Autodesk.Revit.Attributes;
using Autodesk.Revit.DB;
using Autodesk.Revit.UI;

namespace FamilyAgent.Addin
{
    internal static class Commands
    {
        public static int BridgePort()
        {
            var configured = Environment.GetEnvironmentVariable("FAMILY_AGENT_BRIDGE_PORT");
            return int.TryParse(configured, out var port) ? port : 8765;
        }

        public static void ShowResult(BuildResult result)
        {
            if (result.Ok)
            {
                var warnings = result.Warnings.Count == 0
                    ? string.Empty
                    : $"\n\n{result.Warnings.Count} warning(s):\n- " + string.Join("\n- ", result.Warnings.Take(6));

                TaskDialog.Show("Family Agent", $"Family built in {result.RevitVersion}.\n\n{result.Path}{warnings}");
                return;
            }

            TaskDialog.Show("Family Agent", $"Build failed.\n\n{result.Error}");
        }
    }

    [Transaction(TransactionMode.Manual)]
    [Regeneration(RegenerationOption.Manual)]
    public sealed class BuildFromFileCommand : IExternalCommand
    {
        public Result Execute(ExternalCommandData commandData, ref string message, ElementSet elements)
        {
            using (var dialog = new OpenFileDialog
                   {
                       Title = "Pick a family spec",
                       Filter = "Family spec (*.json)|*.json|All files (*.*)|*.*",
                       CheckFileExists = true,
                   })
            {
                if (dialog.ShowDialog() != DialogResult.OK) return Result.Cancelled;

                try
                {
                    var json = File.ReadAllText(dialog.FileName);
                    var result = FamilyBuilder.Build(commandData.Application.Application, json);
                    Commands.ShowResult(result);
                }
                catch (Exception ex)
                {
                    TaskDialog.Show("Family Agent", ex.ToString());
                }
            }

            return Result.Succeeded;
        }
    }

    [Transaction(TransactionMode.Manual)]
    [Regeneration(RegenerationOption.Manual)]
    public sealed class BuildPendingCommand : IExternalCommand
    {
        public Result Execute(ExternalCommandData commandData, ref string message, ElementSet elements)
        {
            var directory = FamilyBuilder.QueueDirectory();

            if (!Directory.Exists(directory))
            {
                TaskDialog.Show("Family Agent", $"No queued specs found.\n\n{directory}");
                return Result.Cancelled;
            }

            var newest = Directory.GetFiles(directory, "*.json")
                .OrderByDescending(File.GetLastWriteTimeUtc)
                .FirstOrDefault();

            if (newest == null)
            {
                TaskDialog.Show("Family Agent", "The queue is empty.");
                return Result.Cancelled;
            }

            try
            {
                var json = File.ReadAllText(newest);
                var result = FamilyBuilder.Build(commandData.Application.Application, json);
                Commands.ShowResult(result);

                if (result.Ok)
                {
                    try { File.Delete(newest); } catch { }
                }
            }
            catch (Exception ex)
            {
                TaskDialog.Show("Family Agent", ex.ToString());
            }

            return Result.Succeeded;
        }
    }

    [Transaction(TransactionMode.Manual)]
    [Regeneration(RegenerationOption.Manual)]
    public sealed class RebuildCommand : IExternalCommand
    {
        public Result Execute(ExternalCommandData commandData, ref string message, ElementSet elements)
        {
            try
            {
                var result = FamilyBuilder.Rebuild(commandData.Application);
                Commands.ShowResult(result);
            }
            catch (Exception ex)
            {
                TaskDialog.Show("Family Agent", ex.Message);
            }

            return Result.Succeeded;
        }
    }

    [Transaction(TransactionMode.Manual)]
    [Regeneration(RegenerationOption.Manual)]
    public sealed class ToggleBridgeCommand : IExternalCommand
    {
        public Result Execute(ExternalCommandData commandData, ref string message, ElementSet elements)
        {
            if (BridgeServer.Instance.IsRunning)
            {
                BridgeServer.Instance.Stop();
                TaskDialog.Show("Family Agent", "Studio bridge stopped.");
                return Result.Succeeded;
            }

            var port = Commands.BridgePort();
            var started = BridgeServer.Instance.Start(port);

            TaskDialog.Show(
                "Family Agent",
                started
                    ? $"Studio bridge listening on http://127.0.0.1:{port}\n\nPress “Build Revit family” in the studio."
                    : $"Could not start the bridge on port {port}. Another process may be using it.");

            return Result.Succeeded;
        }
    }
}
