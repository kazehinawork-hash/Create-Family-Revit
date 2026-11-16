using System;
using System.Collections.Generic;
using System.IO;
using Autodesk.Revit.ApplicationServices;
using FamilyAgent.Core;

namespace FamilyAgent.Addin
{
    internal static class TemplateCatalog
    {
        private static readonly Dictionary<string, string> ByCategory =
            new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
            {
                { "Mechanical Equipment", "Metric Mechanical Equipment.rft" },
                { "Duct Fitting", "Metric Duct Elbow.rft" },
                { "Duct Elbow", "Metric Duct Elbow.rft" },
                { "Duct Transition", "Metric Duct Transition.rft" },
                { "Duct Tee", "Metric Duct Tee.rft" },
                { "Duct Cross", "Metric Duct Cross.rft" },
                { "Pipe Fitting", "Metric Generic Model.rft" },
                // Revit 2024 has no cable-tray family template: build from a generic
                // model and let the add-in move it to Cable Tray Fitting afterwards.
                { "Cable Tray Fitting", "Metric Generic Model.rft" },
                { "Generic Model", "Metric Generic Model.rft" },
                { "Plumbing Fixture", "Metric Plumbing Fixture.rft" },
                { "Electrical Equipment", "Metric Electrical Equipment.rft" },
                { "Lighting Fixture", "Metric Lighting Fixture.rft" },
                { "Specialty Equipment", "Metric Specialty Equipment.rft" },
                { "Furniture", "Metric Furniture.rft" },
                { "Casework", "Metric Casework.rft" },
                { "Door", "Metric Door.rft" },
                { "Window", "Metric Window.rft" },
                { "Structural Framing", "Metric Structural Framing - Beams and Braces.rft" },
                { "Structural Column", "Metric Structural Column.rft" },
                { "Structural Foundation", "Metric Structural Foundation.rft" },
                { "Site", "Metric Site.rft" },
                { "Planting", "Metric Planting.rft" },
                { "Entourage", "Metric Entourage.rft" },
                { "Data Device", "Metric Data Device.rft" },
            };

        public static string Resolve(Application app, FamilySpec spec)
        {
            var requested = spec.Template;
            if (!string.IsNullOrWhiteSpace(requested) &&
                requested.EndsWith(".rft", StringComparison.OrdinalIgnoreCase) &&
                File.Exists(requested))
            {
                return requested;
            }

            var version = app.VersionNumber;
            var root = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData),
                "Autodesk",
                $"RVT {version}",
                "Family Templates");

            if (!Directory.Exists(root))
                throw new InvalidOperationException($"Revit {version} family templates were not found in {root}");

            var fileName = ByCategory.TryGetValue(spec.Category ?? string.Empty, out var mapped)
                ? mapped
                : "Metric Generic Model.rft";

            var english = Path.Combine(root, "English", fileName);
            if (File.Exists(english)) return english;

            var matches = Directory.GetFiles(root, fileName, SearchOption.AllDirectories);
            if (matches.Length > 0) return matches[0];

            throw new InvalidOperationException(
                $"Family template \"{fileName}\" was not found under {root}. Install the Revit family templates for {version}.");
        }
    }
}
