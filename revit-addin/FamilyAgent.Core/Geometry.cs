using System;
using System.Collections.Generic;

namespace FamilyAgent.Core
{
    public static class GeometryResolver
    {
        public static ResolvedModel Resolve(FamilySpec spec, ParameterSet parameters)
        {
            var model = new ResolvedModel();
            model.Warnings.AddRange(parameters.Errors);

            var lookup = parameters.Lookup ??
                         (name => throw new ExpressionException($"Unknown parameter \"{name}\""));

            double Num(Num? value, string path, double? fallback = null)
            {
                if (value == null)
                {
                    if (fallback.HasValue) return fallback.Value;
                    throw new ExpressionException($"{path} is required");
                }

                var num = value.Value;
                if (!num.IsExpression) return num.Value;

                var text = (num.Expression ?? string.Empty).Trim();
                if (text.Length == 0)
                {
                    if (fallback.HasValue) return fallback.Value;
                    throw new ExpressionException($"{path} is empty");
                }

                try
                {
                    return Expression.Evaluate(text, lookup);
                }
                catch (ExpressionException ex)
                {
                    throw new ExpressionException($"{path}: {ex.Message}");
                }
            }

            Vec3d Vec(Vec3 value, string path) => new Vec3d(
                Num(value.X, $"{path}.x"),
                Num(value.Y, $"{path}.y"),
                Num(value.Z, $"{path}.z"));

            ResolvedSolid ResolveSolid(SolidPrimitive raw, string path)
            {
                if (raw == null) throw new ExpressionException($"{path} is missing");
                var kind = (raw.Kind ?? string.Empty).Trim().ToLowerInvariant();

                if (kind == "box")
                {
                    var size = Vec(raw.Size, $"{path}.size");
                    var limit = Math.Min(Math.Abs(size.X), Math.Abs(size.Y)) / 2;
                    var corner = Math.Min(
                        Math.Max(Num(raw.CornerRadius, $"{path}.cornerRadius", 0), 0),
                        limit);
                    return new ResolvedSolid
                    {
                        Kind = "box",
                        Origin = Vec(raw.Origin, $"{path}.origin"),
                        Size = size,
                        RotationZ = Num(raw.RotationZ, $"{path}.rotationZ", 0),
                        CornerRadius = corner,
                    };
                }

                if (kind == "cylinder")
                {
                    var axis = (raw.Axis ?? "z").Trim().ToLowerInvariant();
                    if (axis != "x" && axis != "y" && axis != "z")
                        throw new ExpressionException($"{path}.axis must be x, y or z");

                    var radius = Num(raw.Radius, $"{path}.radius");
                    if (!(radius > 0)) throw new ExpressionException($"{path}.radius must be greater than zero");

                    var inner = Num(raw.InnerRadius, $"{path}.innerRadius", 0);
                    if (inner < 0 || inner >= radius)
                        throw new ExpressionException($"{path}.innerRadius must be between 0 and radius");

                    return new ResolvedSolid
                    {
                        Kind = "cylinder",
                        Base = Vec(raw.Base, $"{path}.base"),
                        Radius = radius,
                        InnerRadius = inner,
                        Height = Num(raw.Height, $"{path}.height"),
                        Axis = axis,
                        Segments = Math.Min(96, Math.Max(12, raw.Segments ?? 48)),
                    };
                }

                if (kind == "prism")
                {
                    var plane = (raw.Plane ?? "xy").Trim().ToLowerInvariant();
                    if (plane != "xy" && plane != "xz" && plane != "yz")
                        throw new ExpressionException($"{path}.plane must be xy, xz or yz");
                    if (raw.Points == null || raw.Points.Count < 3)
                        throw new ExpressionException($"{path}.points needs at least 3 [a, b] pairs");

                    var points = new List<Vec2d>();
                    for (var i = 0; i < raw.Points.Count; i += 1)
                    {
                        var pair = raw.Points[i];
                        if (pair == null || pair.Count < 2)
                            throw new ExpressionException($"{path}.points[{i}] must be an [a, b] pair");
                        points.Add(new Vec2d(
                            Num(pair[0], $"{path}.points[{i}][0]"),
                            Num(pair[1], $"{path}.points[{i}][1]")));
                    }

                    return new ResolvedSolid
                    {
                        Kind = "prism",
                        Plane = plane,
                        Points = points,
                        From = Num(raw.From, $"{path}.from"),
                        To = Num(raw.To, $"{path}.to"),
                    };
                }

                throw new ExpressionException($"{path}.kind must be box, cylinder or prism");
            }

            for (var index = 0; index < spec.Parts.Count; index += 1)
            {
                var raw = spec.Parts[index];
                var path = $"parts[{index}]";

                try
                {
                    if (raw == null) throw new ExpressionException($"{path} must be an object");

                    var part = new ResolvedPart
                    {
                        Id = string.IsNullOrWhiteSpace(raw.Id) ? $"part-{index + 1}" : raw.Id,
                        Name = string.IsNullOrWhiteSpace(raw.Name) ? $"Part {index + 1}" : raw.Name,
                        Material = raw.Material,
                        Color = raw.Color,
                        Solid = ResolveSolid(raw.Solid, $"{path}.solid"),
                    };

                    if (raw.Cuts != null)
                    {
                        for (var cutIndex = 0; cutIndex < raw.Cuts.Count; cutIndex += 1)
                            part.Cuts.Add(ResolveSolid(raw.Cuts[cutIndex], $"{path}.cuts[{cutIndex}]"));
                    }

                    if (raw.Array != null)
                    {
                        var count = (int)Math.Round(Num(raw.Array.Count, $"{path}.array.count", 1));

                        if (count > 500)
                            throw new ExpressionException($"{path}.array.count must be 500 or less");

                        if (count > 1)
                        {
                            part.ArrayCount = count;
                            part.ArrayAxis = (raw.Array.Axis ?? "x").Trim().ToLowerInvariant();
                            if (part.ArrayAxis != "x" && part.ArrayAxis != "y" && part.ArrayAxis != "z")
                                throw new ExpressionException($"{path}.array.axis must be x, y or z");
                            part.ArraySpacing = Num(raw.Array.Spacing, $"{path}.array.spacing", 0);
                        }
                    }

                    model.Parts.Add(part);
                }
                catch (Exception ex)
                {
                    model.Warnings.Add($"{path}: {ex.Message}");
                }
            }

            foreach (var part in model.Parts)
            {
                var single = BoundsOf(part.Solid);
                for (var i = 0; i < part.ArrayCount; i += 1)
                {
                    var offset = AxisOffset(part.ArrayAxis, part.ArraySpacing * i);
                    model.Bounds.Grow(new Vec3d(single.MinX + offset.X, single.MinY + offset.Y, single.MinZ + offset.Z));
                    model.Bounds.Grow(new Vec3d(single.MaxX + offset.X, single.MaxY + offset.Y, single.MaxZ + offset.Z));
                    model.Instances += 1;
                }
            }

            return model;
        }

        private static Vec3d AxisOffset(string axis, double distance)
        {
            if (axis == "x") return new Vec3d(distance, 0, 0);
            if (axis == "y") return new Vec3d(0, distance, 0);
            return new Vec3d(0, 0, distance);
        }

        public static Bounds3 BoundsOf(ResolvedSolid solid)
        {
            var bounds = new Bounds3();

            if (solid.Kind == "box")
            {
                var halfX = Math.Abs(solid.Size.X) / 2;
                var halfY = Math.Abs(solid.Size.Y) / 2;
                var angle = solid.RotationZ * Math.PI / 180;
                var cos = Math.Cos(angle);
                var sin = Math.Sin(angle);
                var zMin = Math.Min(solid.Origin.Z, solid.Origin.Z + solid.Size.Z);
                var zMax = Math.Max(solid.Origin.Z, solid.Origin.Z + solid.Size.Z);

                foreach (var sx in new[] { -1, 1 })
                {
                    foreach (var sy in new[] { -1, 1 })
                    {
                        var dx = sx * halfX;
                        var dy = sy * halfY;
                        var x = solid.Origin.X + dx * cos - dy * sin;
                        var y = solid.Origin.Y + dx * sin + dy * cos;
                        bounds.Grow(new Vec3d(x, y, zMin));
                        bounds.Grow(new Vec3d(x, y, zMax));
                    }
                }

                return bounds;
            }

            if (solid.Kind == "cylinder")
            {
                var end = solid.Base;
                if (solid.Axis == "x") end.X += solid.Height;
                else if (solid.Axis == "y") end.Y += solid.Height;
                else end.Z += solid.Height;

                var rx = solid.Axis == "x" ? 0 : solid.Radius;
                var ry = solid.Axis == "y" ? 0 : solid.Radius;
                var rz = solid.Axis == "z" ? 0 : solid.Radius;

                bounds.Grow(new Vec3d(
                    Math.Min(solid.Base.X, end.X) - rx,
                    Math.Min(solid.Base.Y, end.Y) - ry,
                    Math.Min(solid.Base.Z, end.Z) - rz));
                bounds.Grow(new Vec3d(
                    Math.Max(solid.Base.X, end.X) + rx,
                    Math.Max(solid.Base.Y, end.Y) + ry,
                    Math.Max(solid.Base.Z, end.Z) + rz));
                return bounds;
            }

            var minA = double.PositiveInfinity;
            var maxA = double.NegativeInfinity;
            var minB = double.PositiveInfinity;
            var maxB = double.NegativeInfinity;

            foreach (var point in solid.Points)
            {
                minA = Math.Min(minA, point.A);
                maxA = Math.Max(maxA, point.A);
                minB = Math.Min(minB, point.B);
                maxB = Math.Max(maxB, point.B);
            }

            var low = Math.Min(solid.From, solid.To);
            var high = Math.Max(solid.From, solid.To);

            if (solid.Plane == "xy")
            {
                bounds.Grow(new Vec3d(minA, minB, low));
                bounds.Grow(new Vec3d(maxA, maxB, high));
            }
            else if (solid.Plane == "xz")
            {
                bounds.Grow(new Vec3d(minA, low, minB));
                bounds.Grow(new Vec3d(maxA, high, maxB));
            }
            else
            {
                bounds.Grow(new Vec3d(low, minA, minB));
                bounds.Grow(new Vec3d(high, maxA, maxB));
            }

            return bounds;
        }
    }
}
