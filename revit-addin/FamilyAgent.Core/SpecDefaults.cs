using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.RegularExpressions;

namespace FamilyAgent.Core
{
    public static class SpecDefaults
    {
        private static readonly Regex Reference = new Regex(@"\[([^\]]+)\]", RegexOptions.Compiled);

        private static readonly Regex FineFallback = new Regex(
            @"(bolt|nut|screw|washer|pin|label|tag|indicator|hole|bu\s*lông|đai\s*ốc|vít|long\s*đen|nhãn|lỗ)",
            RegexOptions.IgnoreCase | RegexOptions.Compiled);

        private static readonly Regex MediumFallback = new Regex(
            @"(rung|splice|tấm\s*nối|thanh\s*nối|bậc)",
            RegexOptions.IgnoreCase | RegexOptions.Compiled);

        public static bool IsFitting(string category)
        {
            return !string.IsNullOrWhiteSpace(category) &&
                   category.Trim().EndsWith("Fitting", StringComparison.OrdinalIgnoreCase);
        }

        public static void ApplyFittingDefaults(FamilySpec spec)
        {
            if (spec?.Connectors == null || spec.Parameters == null || !IsFitting(spec.Category))
            {
                return;
            }

            var byName = new Dictionary<string, FamilyParameter>(StringComparer.OrdinalIgnoreCase);
            foreach (var parameter in spec.Parameters)
            {
                if (parameter != null && !string.IsNullOrWhiteSpace(parameter.Name))
                {
                    byName[parameter.Name] = parameter;
                }
            }

            var instanceParams = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            foreach (var connector in spec.Connectors)
            {
                AddReferences(connector?.Width, byName, instanceParams);
                AddReferences(connector?.Height, byName, instanceParams);
                AddReferences(connector?.Diameter, byName, instanceParams);
            }

            var changed = true;
            while (changed)
            {
                changed = false;
                foreach (var parameter in spec.Parameters)
                {
                    if (parameter != null &&
                        !string.IsNullOrWhiteSpace(parameter.Formula) &&
                        References(parameter.Formula).Any(instanceParams.Contains) &&
                        instanceParams.Add(parameter.Name))
                    {
                        changed = true;
                    }
                }
            }

            foreach (var name in instanceParams)
            {
                if (byName.TryGetValue(name, out var parameter))
                {
                    parameter.Instance = true;
                }
            }
        }

        private static void AddReferences(
            Num? value,
            IDictionary<string, FamilyParameter> byName,
            ISet<string> references)
        {
            if (!value.HasValue || !value.Value.IsExpression) return;
            var text = value.Value.Expression.Trim();
            var list = References(text);
            if (list.Count == 0 && byName.ContainsKey(text))
            {
                references.Add(text);
                return;
            }
            foreach (var item in list)
            {
                if (byName.ContainsKey(item)) references.Add(item);
            }
        }

        private static List<string> References(string expression)
        {
            var list = new List<string>();
            foreach (Match match in Reference.Matches(expression ?? string.Empty))
            {
                var name = match.Groups[1].Value.Trim();
                if (name.Length > 0) list.Add(name);
            }
            return list;
        }

        public static string DetailLevel(string detail, string name)
        {
            var text = (detail ?? string.Empty).Trim().ToLowerInvariant();
            switch (text)
            {
                case "fine":
                case "medium":
                case "coarse":
                    return text;
                default:
                    var input = name ?? string.Empty;
                    if (FineFallback.IsMatch(input)) return "fine";
                    if (MediumFallback.IsMatch(input)) return "medium";
                    return "coarse";
            }
        }
    }
}
