using System;
using System.Collections.Generic;
using System.Globalization;

namespace FamilyAgent.Core
{
    public struct Vec3d
    {
        public double X;
        public double Y;
        public double Z;

        public Vec3d(double x, double y, double z)
        {
            X = x;
            Y = y;
            Z = z;
        }
    }

    public struct Vec2d
    {
        public double A;
        public double B;

        public Vec2d(double a, double b)
        {
            A = a;
            B = b;
        }
    }

    public sealed class ResolvedParameter
    {
        public string Name = string.Empty;
        public string Type = "Length";
        public string Group = "Dimensions";
        public string Formula;
        public string Description;
        public string Error;
        public bool Instance;
        public double? Number;
        public string Text;
        public bool? YesNo;
    }

    public sealed class ParameterSet
    {
        public List<ResolvedParameter> Ordered = new List<ResolvedParameter>();
        public Dictionary<string, ResolvedParameter> ByKey =
            new Dictionary<string, ResolvedParameter>(StringComparer.OrdinalIgnoreCase);
        public List<string> Errors = new List<string>();
        public Func<string, double> Lookup;
    }

    public sealed class ResolvedSolid
    {
        public string Kind;
        public Vec3d Origin;
        public Vec3d Size;
        public Vec3d Base;
        public double Radius;
        public double InnerRadius;
        public double Height;
        public double RotationZ;
        public double CornerRadius;
        public double From;
        public double To;
        public string Axis = "z";
        public string Plane = "xy";
        public List<Vec2d> Points = new List<Vec2d>();
        public int Segments = 48;
    }

    public sealed class ResolvedPart
    {
        public string Id;
        public string Name;
        public string Material;
        public string Color;
        public ResolvedSolid Solid;
        public List<ResolvedSolid> Cuts = new List<ResolvedSolid>();
        public int ArrayCount = 1;
        public string ArrayAxis = "x";
        public double ArraySpacing;
    }

    public sealed class Bounds3
    {
        public double MinX = double.PositiveInfinity;
        public double MinY = double.PositiveInfinity;
        public double MinZ = double.PositiveInfinity;
        public double MaxX = double.NegativeInfinity;
        public double MaxY = double.NegativeInfinity;
        public double MaxZ = double.NegativeInfinity;

        public bool IsValid => !double.IsInfinity(MinX) && !double.IsInfinity(MaxX);

        public Vec3d Size => new Vec3d(
            IsValid ? MaxX - MinX : 0,
            IsValid ? MaxY - MinY : 0,
            IsValid ? MaxZ - MinZ : 0);

        public void Grow(Vec3d point)
        {
            MinX = Math.Min(MinX, point.X);
            MinY = Math.Min(MinY, point.Y);
            MinZ = Math.Min(MinZ, point.Z);
            MaxX = Math.Max(MaxX, point.X);
            MaxY = Math.Max(MaxY, point.Y);
            MaxZ = Math.Max(MaxZ, point.Z);
        }
    }

    public sealed class ResolvedModel
    {
        public List<ResolvedPart> Parts = new List<ResolvedPart>();
        public List<string> Warnings = new List<string>();
        public int Instances;
        public Bounds3 Bounds = new Bounds3();
    }

    public static class ParameterResolver
    {
        private static readonly HashSet<string> NumericTypes =
            new HashSet<string>(StringComparer.OrdinalIgnoreCase) { "Length", "Angle", "Number", "Integer" };

        public static bool IsNumeric(string type) => NumericTypes.Contains(type ?? "Length");

        public static ParameterSet Resolve(FamilySpec spec)
        {
            var set = new ParameterSet();
            var byName = new Dictionary<string, FamilyParameter>(StringComparer.OrdinalIgnoreCase);

            foreach (var parameter in spec.Parameters)
            {
                if (parameter == null || string.IsNullOrWhiteSpace(parameter.Name)) continue;
                if (string.IsNullOrWhiteSpace(parameter.Type)) parameter.Type = "Length";
                if (byName.ContainsKey(parameter.Name))
                {
                    set.Errors.Add($"Duplicate parameter \"{parameter.Name}\" ignored");
                    continue;
                }
                byName[parameter.Name] = parameter;
            }

            var resolving = new HashSet<string>(StringComparer.OrdinalIgnoreCase);

            double Lookup(string name)
            {
                if (!byName.TryGetValue(name, out var parameter))
                    throw new ExpressionException($"Unknown parameter \"{name}\"");
                if (!IsNumeric(parameter.Type))
                    throw new ExpressionException($"Parameter \"{parameter.Name}\" is not a number (type {parameter.Type})");
                var resolved = ResolveOne(parameter);
                if (resolved.Number == null)
                    throw new ExpressionException($"Parameter \"{parameter.Name}\" has no numeric value");
                return resolved.Number.Value;
            }

            ResolvedParameter ResolveOne(FamilyParameter parameter)
            {
                if (set.ByKey.TryGetValue(parameter.Name, out var done)) return done;
                if (!resolving.Add(parameter.Name))
                    throw new ExpressionException($"Circular reference in formulas involving \"{parameter.Name}\"");

                try
                {
                    var resolved = Compute(parameter);
                    set.ByKey[parameter.Name] = resolved;
                    set.Ordered.Add(resolved);
                    return resolved;
                }
                finally
                {
                    resolving.Remove(parameter.Name);
                }
            }

            ResolvedParameter Compute(FamilyParameter parameter)
            {
                var resolved = new ResolvedParameter
                {
                    Name = parameter.Name,
                    Type = parameter.Type,
                    Group = string.IsNullOrWhiteSpace(parameter.Group)
                        ? (parameter.Type == "Length" || parameter.Type == "Angle" ? "Dimensions" : "Data")
                        : parameter.Group,
                    Instance = parameter.Instance,
                    Description = parameter.Description,
                    Formula = string.IsNullOrWhiteSpace(parameter.Formula) ? null : parameter.Formula.Trim(),
                };

                if (string.Equals(parameter.Type, "Text", StringComparison.OrdinalIgnoreCase))
                {
                    resolved.Text = parameter.Value == null
                        ? string.Empty
                        : Convert.ToString(parameter.Value, CultureInfo.InvariantCulture);
                    return resolved;
                }

                if (string.Equals(parameter.Type, "YesNo", StringComparison.OrdinalIgnoreCase))
                {
                    resolved.YesNo = ToBoolean(parameter.Value);
                    return resolved;
                }

                if (resolved.Formula != null)
                {
                    try
                    {
                        resolved.Number = Normalise(parameter.Type, Expression.Evaluate(resolved.Formula, Lookup));
                    }
                    catch (Exception ex)
                    {
                        resolved.Error = ex.Message;
                        resolved.Number = 0;
                    }
                    return resolved;
                }

                if (parameter.Value is string text && !string.IsNullOrWhiteSpace(text))
                {
                    try
                    {
                        resolved.Number = Normalise(parameter.Type, Expression.Evaluate(text, Lookup));
                    }
                    catch (Exception ex)
                    {
                        resolved.Error = ex.Message;
                        resolved.Number = 0;
                    }
                    return resolved;
                }

                resolved.Number = Normalise(parameter.Type, ToNumber(parameter.Value));
                return resolved;
            }

            foreach (var parameter in byName.Values)
            {
                try
                {
                    var resolved = ResolveOne(parameter);
                    if (!string.IsNullOrEmpty(resolved.Error))
                        set.Errors.Add($"{parameter.Name}: {resolved.Error}");
                }
                catch (Exception ex)
                {
                    set.Errors.Add($"{parameter.Name}: {ex.Message}");
                    var fallback = new ResolvedParameter
                    {
                        Name = parameter.Name,
                        Type = parameter.Type,
                        Group = parameter.Group ?? "Dimensions",
                        Instance = parameter.Instance,
                        Formula = parameter.Formula,
                        Error = ex.Message,
                        Number = 0,
                    };
                    set.ByKey[parameter.Name] = fallback;
                    set.Ordered.Add(fallback);
                }
            }

            set.Lookup = Lookup;
            return set;
        }

        private static double Normalise(string type, double value) =>
            string.Equals(type, "Integer", StringComparison.OrdinalIgnoreCase)
                ? Math.Round(value, MidpointRounding.AwayFromZero)
                : value;

        private static double ToNumber(object value)
        {
            if (value == null) return 0;
            if (value is bool flag) return flag ? 1 : 0;
            if (value is double d) return d;
            if (value is float f) return f;
            if (value is long l) return l;
            if (value is int i) return i;
            if (double.TryParse(Convert.ToString(value, CultureInfo.InvariantCulture), NumberStyles.Float,
                    CultureInfo.InvariantCulture, out var parsed))
                return parsed;
            return 0;
        }

        private static bool ToBoolean(object value)
        {
            if (value == null) return false;
            if (value is bool flag) return flag;
            var text = Convert.ToString(value, CultureInfo.InvariantCulture)?.Trim().ToLowerInvariant();
            return text == "true" || text == "yes" || text == "1";
        }
    }

}
