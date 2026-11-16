using System;
using System.Collections.Generic;
using Autodesk.Revit.DB;
using FamilyAgent.Core;

namespace FamilyAgent.Addin
{
    /// <summary>
    /// Revit picks the family category from the template, and the metric templates do
    /// not match every spec category (Revit 2024 has no cable-tray template at all).
    /// This applies the category from the spec after the document is created, plus the
    /// MEP Part Type for fitting categories.
    /// </summary>
    internal static class FamilyCategoryAssigner
    {
        private static readonly Dictionary<string, PartType> PartTypeValues =
            new Dictionary<string, PartType>(StringComparer.OrdinalIgnoreCase)
            {
                { "Elbow", PartType.Elbow },
                { "Tee", PartType.Tee },
                { "Cross", PartType.Cross },
                { "Transition", PartType.Transition },
                { "Union", PartType.Union },
                // Revit has no "Other" part type; Normal is the neutral value.
                { "Other", PartType.Normal },
            };

        public static void Apply(Document document, FamilySpec spec, List<string> warnings)
        {
            if (document == null || spec == null) return;

            var family = document.OwnerFamily;
            if (family == null) return;

            var categoryName = (spec.Category ?? string.Empty).Trim();
            var builtInName = CategoryCatalog.BuiltInCategoryName(categoryName);
            if (string.IsNullOrEmpty(builtInName)) return;

            if (!Enum.TryParse(builtInName, out BuiltInCategory builtIn))
            {
                warnings?.Add(
                    $"Không ánh xạ được category \"{categoryName}\" sang BuiltInCategory ({builtInName}); giữ category của template.");
                return;
            }

            var target = Category.GetCategory(document, builtIn);
            if (target == null)
            {
                warnings?.Add(
                    $"Revit không có category \"{categoryName}\"; giữ category của template.");
                return;
            }

            var categoryChanged =
                family.FamilyCategory == null ||
                family.FamilyCategory.Id.IntegerValue != target.Id.IntegerValue;

            PartType? partType = null;
            if (IsFitting(builtIn))
            {
                var requested = CategoryCatalog.PartTypeName(spec.PartType);
                if (!string.IsNullOrEmpty(requested) &&
                    PartTypeValues.TryGetValue(requested, out var resolved))
                {
                    partType = resolved;
                }
            }

            if (!categoryChanged && partType == null) return;

            using (var transaction = new Transaction(document, "Family Agent — family category"))
            {
                transaction.Start();
                try
                {
                    if (categoryChanged) family.FamilyCategory = target;

                    if (partType.HasValue)
                    {
                        var parameter = family.get_Parameter(BuiltInParameter.FAMILY_CONTENT_PART_TYPE);
                        if (parameter != null && !parameter.IsReadOnly)
                        {
                            parameter.Set((int)partType.Value);
                        }
                        else
                        {
                            warnings?.Add(
                                $"Không đặt được Part Type \"{spec.PartType}\" cho category \"{categoryName}\".");
                        }
                    }

                    transaction.Commit();
                }
                catch (Exception ex)
                {
                    if (transaction.GetStatus() != TransactionStatus.Committed)
                    {
                        try { transaction.RollBack(); } catch { }
                    }
                    warnings?.Add(
                        $"Không đổi được Family Category sang \"{categoryName}\" ({ex.Message}); giữ category của template.");
                }
            }
        }

        private static bool IsFitting(BuiltInCategory category)
        {
            return category == BuiltInCategory.OST_DuctFitting ||
                   category == BuiltInCategory.OST_PipeFitting ||
                   category == BuiltInCategory.OST_CableTrayFitting;
        }
    }
}
