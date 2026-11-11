using System;
using System.Collections.Generic;
using System.IO;
using System.Reflection;
using Autodesk.Revit.DB.Events;
using Autodesk.Revit.UI;
using Autodesk.Revit.UI.Events;

namespace FamilyAgent.Addin
{
    public sealed class App : IExternalApplication
    {
        public static bool AutoSyncEnabled = true;
        private static bool _rebuilding;
        private static readonly HashSet<int> _dirtyDocHashes = new HashSet<int>();
        private static readonly Dictionary<int, string> _lastSignatures = new Dictionary<int, string>();

        public Result OnStartup(UIControlledApplication application)
        {
            AppDomain.CurrentDomain.AssemblyResolve += ResolveLocalAssembly;

            CreateRibbon(application);

            application.ControlledApplication.DocumentChanged += OnDocumentChanged;
            application.ControlledApplication.DocumentOpened += OnDocumentOpened;
            application.Idling += OnIdling;

            if (!string.Equals(
                    Environment.GetEnvironmentVariable("FAMILY_AGENT_BRIDGE"),
                    "0",
                    StringComparison.OrdinalIgnoreCase))
            {
                // Idling does not fire on the Revit start screen, so the listener has to
                // start here; build requests are queued through an ExternalEvent and only
                // execute when Revit is idle.
                BridgeServer.Instance.Start(Commands.BridgePort());
            }

            return Result.Succeeded;
        }

        public Result OnShutdown(UIControlledApplication application)
        {
            application.ControlledApplication.DocumentChanged -= OnDocumentChanged;
            application.ControlledApplication.DocumentOpened -= OnDocumentOpened;
            application.Idling -= OnIdling;
            BridgeServer.Instance.Stop();
            return Result.Succeeded;
        }

        private static void OnDocumentOpened(object sender, DocumentOpenedEventArgs e)
        {
            try
            {
                var doc = e.Document;
                if (doc == null || !doc.IsFamilyDocument) return;
                var sig = FamilyBuilder.ParameterSignature(doc);
                if (!string.IsNullOrEmpty(sig))
                {
                    _lastSignatures[doc.GetHashCode()] = sig;
                }
            }
            catch
            {
            }
        }

        private static void OnDocumentChanged(object sender, DocumentChangedEventArgs e)
        {
            if (_rebuilding || !AutoSyncEnabled) return;

            try
            {
                var doc = e.GetDocument();
                if (doc == null || !doc.IsFamilyDocument) return;

                foreach (var txName in e.GetTransactionNames())
                {
                    if (txName != null && txName.StartsWith("Family Agent", StringComparison.OrdinalIgnoreCase))
                    {
                        return;
                    }
                }

                _dirtyDocHashes.Add(doc.GetHashCode());
            }
            catch
            {
            }
        }

        private static void OnIdling(object sender, IdlingEventArgs e)
        {
            if (_rebuilding || !AutoSyncEnabled || _dirtyDocHashes.Count == 0) return;

            var uiApp = sender as UIApplication;
            var doc = uiApp?.ActiveUIDocument?.Document;
            if (doc == null || !doc.IsFamilyDocument || doc.IsModifiable) return;

            var docHash = doc.GetHashCode();
            if (!_dirtyDocHashes.Remove(docHash)) return;

            try
            {
                var currentSig = FamilyBuilder.ParameterSignature(doc);
                if (string.IsNullOrEmpty(currentSig))
                {
                    LogAutoSync("Auto-sync skipped: no Family Agent spec or no readable parameter values.");
                    return;
                }

                if (!_lastSignatures.TryGetValue(docHash, out var previousSig))
                {
                    // First edit after opening/creating: rebuild so the user's new parameter values take effect.
                    _lastSignatures[docHash] = currentSig;
                }
                else if (string.Equals(previousSig, currentSig, StringComparison.Ordinal))
                {
                    return;
                }

                _rebuilding = true;
                try
                {
                    var result = FamilyBuilder.Rebuild(doc);
                    if (result.Ok)
                    {
                        _lastSignatures[docHash] = FamilyBuilder.ParameterSignature(doc);
                        if (result.Warnings.Count > 0)
                        {
                            LogAutoSync(
                                $"Rebuild OK with {result.Warnings.Count} warning(s): " +
                                string.Join("; ", result.Warnings.GetRange(0, Math.Min(6, result.Warnings.Count))));
                        }
                    }
                    else
                    {
                        LogAutoSync($"Rebuild failed: {result.Error}");
                    }
                }
                finally
                {
                    _rebuilding = false;
                }
            }
            catch (Exception ex)
            {
                _rebuilding = false;
                LogAutoSync("Auto-sync exception: " + ex);
            }
        }

        /// <summary>
        /// Append-only log for parameter auto-sync, so a family that does not react to a
        /// parameter change has a concrete reason on disk. Path:
        /// Documents\FamilyAgent\logs\autosync.log
        /// </summary>
        private static void LogAutoSync(string message)
        {
            try
            {
                var directory = Path.Combine(
                    Environment.GetFolderPath(Environment.SpecialFolder.MyDocuments),
                    "FamilyAgent",
                    "logs");
                Directory.CreateDirectory(directory);
                File.AppendAllText(
                    Path.Combine(directory, "autosync.log"),
                    $"{DateTime.Now:O} {message}{Environment.NewLine}");
            }
            catch
            {
                // Logging must never break Revit's idling loop.
            }
        }

        private static Assembly ResolveLocalAssembly(object sender, ResolveEventArgs args)
        {
            try
            {
                var name = new AssemblyName(args.Name).Name;
                var directory = Path.GetDirectoryName(typeof(App).Assembly.Location);
                if (directory == null) return null;

                var candidate = Path.Combine(directory, name + ".dll");
                return File.Exists(candidate) ? Assembly.LoadFrom(candidate) : null;
            }
            catch
            {
                return null;
            }
        }

        private static void CreateRibbon(UIControlledApplication application)
        {
            const string tabName = "Family Agent";

            try
            {
                application.CreateRibbonTab(tabName);
            }
            catch
            {
                // The tab is already there when Revit reloads an add-in.
            }

            var panel = application.CreateRibbonPanel(tabName, "Build");
            var assemblyPath = typeof(App).Assembly.Location;

            var buildFile = new PushButtonData(
                "FamilyAgentBuildFile",
                "Build from\nfile…",
                assemblyPath,
                "FamilyAgent.Addin.BuildFromFileCommand")
            {
                ToolTip = "Build a .rfa from a family spec JSON file.",
                LongDescription =
                    "Loads a spec produced by the Family Agent studio and builds the family in Revit.",
            };

            var buildPending = new PushButtonData(
                "FamilyAgentBuildPending",
                "Build\npending",
                assemblyPath,
                "FamilyAgent.Addin.BuildPendingCommand")
            {
                ToolTip = "Build the newest family spec queued by the studio.",
            };

            var bridge = new PushButtonData(
                "FamilyAgentBridge",
                "Studio\nbridge",
                assemblyPath,
                "FamilyAgent.Addin.ToggleBridgeCommand")
            {
                ToolTip = "Start or stop the local studio bridge (127.0.0.1:8765).",
            };

            var rebuild = new PushButtonData(
                "FamilyAgentRebuild",
                "Rebuild\nfrom spec",
                assemblyPath,
                "FamilyAgent.Addin.RebuildCommand")
            {
                ToolTip = "Rebuild the geometry from the spec stored in this family, using the current parameter values.",
                LongDescription =
                    "Recomputes every part from the stored Family Agent spec after you edit parameters in Revit.",
            };

            panel.AddItem(buildFile);
            panel.AddItem(buildPending);
            panel.AddItem(rebuild);
            panel.AddSeparator();
            panel.AddItem(bridge);
        }
    }
}
