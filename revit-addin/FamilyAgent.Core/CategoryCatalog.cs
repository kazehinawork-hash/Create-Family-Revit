using System;
using System.Collections.Generic;

namespace FamilyAgent.Core
{
    /// <summary>
    /// Revit category name -> BuiltInCategory enum name. Mirror of CATEGORY_BUILTIN in
    /// packages/spec-core/src/types.ts; both tables must stay in sync.
    /// </summary>
    public static class CategoryCatalog
    {
        private static readonly Dictionary<string, string> BuiltInByCategory =
            new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
            {
                { "Mechanical Equipment", "OST_MechanicalEquipment" },
                { "Duct Fitting", "OST_DuctFitting" },
                { "Duct Elbow", "OST_DuctFitting" },
                { "Duct Transition", "OST_DuctFitting" },
                { "Duct Tee", "OST_DuctFitting" },
                { "Duct Cross", "OST_DuctFitting" },
                { "Pipe Fitting", "OST_PipeFitting" },
                { "Cable Tray Fitting", "OST_CableTrayFitting" },
                { "Generic Model", "OST_GenericModel" },
                { "Plumbing Fixture", "OST_PlumbingFixtures" },
                { "Electrical Equipment", "OST_ElectricalEquipment" },
                { "Lighting Fixture", "OST_LightingFixtures" },
                { "Specialty Equipment", "OST_SpecialtyEquipment" },
                { "Furniture", "OST_Furniture" },
                { "Casework", "OST_Casework" },
                { "Door", "OST_Doors" },
                { "Window", "OST_Windows" },
                { "Structural Framing", "OST_StructuralFraming" },
                { "Structural Column", "OST_StructuralColumns" },
                { "Structural Foundation", "OST_StructuralFoundation" },
                { "Site", "OST_Site" },
                { "Planting", "OST_Planting" },
                { "Entourage", "OST_Entourage" },
                { "Data Device", "OST_DataDevice" },
            };

        private static readonly HashSet<string> FittingCategories =
            new HashSet<string>(StringComparer.OrdinalIgnoreCase)
            {
                "Duct Fitting",
                "Pipe Fitting",
                "Cable Tray Fitting",
            };

        /// <summary>BuiltInCategory enum name, or null when the category is unknown.</summary>
        public static string BuiltInCategoryName(string category)
        {
            if (string.IsNullOrWhiteSpace(category)) return null;
            return BuiltInByCategory.TryGetValue(category.Trim(), out var name) ? name : null;
        }

        /// <summary>True for the MEP categories that expose a Part Type in Revit.</summary>
        public static bool IsFittingCategory(string category)
        {
            return !string.IsNullOrWhiteSpace(category) && FittingCategories.Contains(category.Trim());
        }

        /// <summary>Part Type names accepted by a family spec.</summary>
        public static readonly string[] PartTypes =
        {
            "Elbow", "Tee", "Cross", "Transition", "Union", "Other",
        };

        /// <summary>Normalizes a spec partType to the Revit enum name, or null.</summary>
        public static string PartTypeName(string partType)
        {
            if (string.IsNullOrWhiteSpace(partType)) return null;
            var trimmed = partType.Trim();
            foreach (var name in PartTypes)
            {
                if (string.Equals(name, trimmed, StringComparison.OrdinalIgnoreCase)) return name;
            }
            return null;
        }
    }
}
