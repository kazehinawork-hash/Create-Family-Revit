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

            string Side(string value)
            {
                var text = (value ?? string.Empty).Trim().ToLowerInvariant();
                return text == "min" || text == "max" ? text : null;
            }

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

                if (kind == "frustum")
                {
                    var axis = (raw.Axis ?? "z").Trim().ToLowerInvariant();
                    if (axis != "x" && axis != "y" && axis != "z")
                        throw new ExpressionException($"{path}.axis must be x, y or z");

                    var radiusBottom = Num(raw.RadiusBottom, $"{path}.radiusBottom");
                    var radiusTop = Num(raw.RadiusTop, $"{path}.radiusTop");
                    if (radiusBottom < 0 || radiusTop < 0)
                        throw new ExpressionException($"{path} radii must be zero or greater");
                    if (radiusBottom <= 0 && radiusTop <= 0)
                        throw new ExpressionException($"{path} needs at least one radius greater than zero");

                    var height = Num(raw.Height, $"{path}.height");
                    if (Math.Abs(height) < 1e-9)
                        throw new ExpressionException($"{path}.height must not be zero");

                    return new ResolvedSolid
                    {
                        Kind = "frustum",
                        Base = Vec(raw.Base, $"{path}.base"),
                        RadiusBottom = radiusBottom,
                        RadiusTop = radiusTop,
                        Height = height,
                        Axis = axis,
                        Segments = Math.Min(96, Math.Max(12, raw.Segments ?? 48)),
                    };
                }

                if (kind == "bend")
                {
                    var plane = (raw.Plane ?? "xy").Trim().ToLowerInvariant();
                    if (plane != "xy" && plane != "xz" && plane != "yz")
                        throw new ExpressionException($"{path}.plane must be xy, xz or yz");

                    var radius = Num(raw.Radius, $"{path}.radius");
                    var tube = Num(raw.TubeRadius, $"{path}.tubeRadius");
                    if (!(radius > 0)) throw new ExpressionException($"{path}.radius must be greater than zero");
                    if (!(tube > 0)) throw new ExpressionException($"{path}.tubeRadius must be greater than zero");
                    if (tube >= radius) throw new ExpressionException($"{path}.tubeRadius must be smaller than radius");

                    var angle = Num(raw.Angle, $"{path}.angle", 90);
                    if (!(angle > 0) || angle > 360)
                        throw new ExpressionException($"{path}.angle must be between 0 and 360 degrees");

                    return new ResolvedSolid
                    {
                        Kind = "bend",
                        Center = Vec(raw.Center, $"{path}.center"),
                        Radius = radius,
                        TubeRadius = tube,
                        Angle = angle,
                        StartAngle = Num(raw.StartAngle, $"{path}.startAngle", 0),
                        Plane = plane,
                        Segments = Math.Min(96, Math.Max(8, raw.Segments ?? 48)),
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

                    var holes = new List<List<Vec2d>>();
                    if (raw.Holes != null)
                    {
                        for (var holeIndex = 0; holeIndex < raw.Holes.Count; holeIndex += 1)
                        {
                            var rawHole = raw.Holes[holeIndex];
                            if (rawHole == null || rawHole.Count < 3)
                                throw new ExpressionException($"{path}.holes[{holeIndex}] needs at least 3 [a, b] pairs");

                            var hole = new List<Vec2d>();
                            for (var pointIndex = 0; pointIndex < rawHole.Count; pointIndex += 1)
                            {
                                var pair = rawHole[pointIndex];
                                if (pair == null || pair.Count < 2)
                                    throw new ExpressionException(
                                        $"{path}.holes[{holeIndex}][{pointIndex}] must be an [a, b] pair");
                                hole.Add(new Vec2d(
                                    Num(pair[0], $"{path}.holes[{holeIndex}][{pointIndex}][0]"),
                                    Num(pair[1], $"{path}.holes[{holeIndex}][{pointIndex}][1]")));
                            }
                            holes.Add(hole);
                        }
                    }

                    return new ResolvedSolid
                    {
                        Kind = "prism",
                        Plane = plane,
                        Points = points,
                        Holes = holes,
                        From = Num(raw.From, $"{path}.from"),
                        To = Num(raw.To, $"{path}.to"),
                    };
                }

                if (kind == "loft")
                {
                    var axis = (raw.Axis ?? "z").Trim().ToLowerInvariant();
                    if (axis != "x" && axis != "y" && axis != "z")
                        throw new ExpressionException($"{path}.axis must be x, y or z");

                    var segments = Math.Min(96, Math.Max(8, raw.Segments ?? 32));
                    if (raw.Sections == null || raw.Sections.Count < 2)
                        throw new ExpressionException($"{path}.sections needs at least two profiles");

                    List<Vec2d> ProfilePoints(LoftProfile profile, string profilePath)
                    {
                        if (profile == null) throw new ExpressionException($"{profilePath} is required");
                        var profileKind = (profile.Kind ?? string.Empty).Trim().ToLowerInvariant();

                        if (profileKind == "circle")
                        {
                            var radius = Num(profile.Radius, $"{profilePath}.radius");
                            if (!(radius > 0))
                                throw new ExpressionException($"{profilePath}.radius must be greater than zero");
                            var points = new List<Vec2d>(segments);
                            for (var step = 0; step < segments; step += 1)
                            {
                                var angle = 2 * Math.PI * step / segments;
                                points.Add(new Vec2d(Math.Cos(angle) * radius, Math.Sin(angle) * radius));
                            }
                            return points;
                        }

                        if (profileKind == "rect")
                        {
                            var width = Num(profile.Width, $"{profilePath}.width");
                            var height = Num(profile.Height, $"{profilePath}.height");
                            if (!(width > 0) || !(height > 0))
                                throw new ExpressionException($"{profilePath}.width and height must be greater than zero");

                            var halfWidth = width / 2;
                            var halfHeight = height / 2;
                            var corner = Math.Min(
                                Math.Max(Num(profile.CornerRadius, $"{profilePath}.cornerRadius", 0), 0),
                                Math.Min(halfWidth, halfHeight));

                            if (corner <= 1e-9)
                            {
                                return new List<Vec2d>
                                {
                                    new Vec2d(-halfWidth, -halfHeight),
                                    new Vec2d(halfWidth, -halfHeight),
                                    new Vec2d(halfWidth, halfHeight),
                                    new Vec2d(-halfWidth, halfHeight),
                                };
                            }

                            var rounded = new List<Vec2d>();
                            var centers = new[,]
                            {
                                { halfWidth - corner, halfHeight - corner, 0.0 },
                                { -(halfWidth - corner), halfHeight - corner, Math.PI / 2 },
                                { -(halfWidth - corner), -(halfHeight - corner), Math.PI },
                                { halfWidth - corner, -(halfHeight - corner), 3 * Math.PI / 2 },
                            };
                            for (var cornerIndex = 0; cornerIndex < 4; cornerIndex += 1)
                            {
                                for (var step = 0; step <= 8; step += 1)
                                {
                                    var angle = centers[cornerIndex, 2] + step * (Math.PI / 2) / 8;
                                    rounded.Add(new Vec2d(
                                        centers[cornerIndex, 0] + Math.Cos(angle) * corner,
                                        centers[cornerIndex, 1] + Math.Sin(angle) * corner));
                                }
                            }
                            return rounded;
                        }

                        if (profileKind == "polygon")
                        {
                            if (profile.Points == null || profile.Points.Count < 3)
                                throw new ExpressionException($"{profilePath}.points needs at least 3 [a, b] pairs");
                            var points = new List<Vec2d>();
                            for (var pointIndex = 0; pointIndex < profile.Points.Count; pointIndex += 1)
                            {
                                var pair = profile.Points[pointIndex];
                                if (pair == null || pair.Count < 2)
                                    throw new ExpressionException(
                                        $"{profilePath}.points[{pointIndex}] must be an [a, b] pair");
                                points.Add(new Vec2d(
                                    Num(pair[0], $"{profilePath}.points[{pointIndex}][0]"),
                                    Num(pair[1], $"{profilePath}.points[{pointIndex}][1]")));
                            }
                            return points;
                        }

                        throw new ExpressionException($"{profilePath}.kind must be circle, rect or polygon");
                    }

                    var sections = new List<ResolvedLoftSection>();
                    for (var sectionIndex = 0; sectionIndex < raw.Sections.Count; sectionIndex += 1)
                    {
                        var section = raw.Sections[sectionIndex];
                        if (section == null || section.Profile == null)
                            throw new ExpressionException($"{path}.sections[{sectionIndex}] is incomplete");

                        sections.Add(new ResolvedLoftSection
                        {
                            At = Num(section.At, $"{path}.sections[{sectionIndex}].at"),
                            Points = ProfilePoints(section.Profile, $"{path}.sections[{sectionIndex}].profile"),
                        });
                    }

                    for (var sectionIndex = 1; sectionIndex < sections.Count; sectionIndex += 1)
                    {
                        if (!(sections[sectionIndex].At > sections[sectionIndex - 1].At))
                            throw new ExpressionException($"{path}.sections must be ordered by increasing at");
                    }

                    var pointCount = segments;
                    foreach (var section in sections)
                        pointCount = Math.Max(pointCount, section.Points.Count);

                    foreach (var section in sections)
                    {
                        section.Points = ResampleLoop(section.Points, pointCount);
                        if (section.Points.Count < 3)
                            throw new ExpressionException($"{path} has a profile with no usable perimeter");
                    }

                    return new ResolvedSolid
                    {
                        Kind = "loft",
                        Axis = axis,
                        Sections = sections,
                        Segments = segments,
                    };
                }

                throw new ExpressionException($"{path}.kind must be box, cylinder, frustum, bend, prism or loft");
            }

            for (var index = 0; index < spec.Parts.Count; index += 1)
            {
                var raw = spec.Parts[index];
                var path = $"parts[{index}]";

                try
                {
                    if (raw == null) throw new ExpressionException($"{path} must be an object");

                    var anchor = raw.Anchor == null
                        ? null
                        : new ResolvedAnchor
                        {
                            X = Side(raw.Anchor.X),
                            Y = Side(raw.Anchor.Y),
                            Z = Side(raw.Anchor.Z),
                        };

                    if (anchor != null && anchor.X == null && anchor.Y == null && anchor.Z == null)
                        anchor = null;

                    var part = new ResolvedPart
                    {
                        Id = string.IsNullOrWhiteSpace(raw.Id) ? $"part-{index + 1}" : raw.Id,
                        Name = string.IsNullOrWhiteSpace(raw.Name) ? $"Part {index + 1}" : raw.Name,
                        Material = raw.Material,
                        Color = raw.Color,
                        Solid = ResolveSolid(raw.Solid, $"{path}.solid"),
                        Anchor = anchor,
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

        private static double SignedArea2D(IList<Vec2d> points)
        {
            var area = 0.0;
            for (var index = 0; index < points.Count; index += 1)
            {
                var a = points[index];
                var b = points[(index + 1) % points.Count];
                area += a.A * b.B - b.A * a.B;
            }
            return area / 2;
        }

        private static List<Vec2d> ResampleLoop(IList<Vec2d> points, int count)
        {
            if (points == null || points.Count == 0 || count < 3) return new List<Vec2d>();

            var loop = new List<Vec2d>(points);
            if (SignedArea2D(loop) < 0) loop.Reverse();

            var cumulative = new List<double> { 0 };
            for (var index = 0; index < loop.Count; index += 1)
            {
                var a = loop[index];
                var b = loop[(index + 1) % loop.Count];
                cumulative.Add(cumulative[index] + Math.Sqrt(
                    (b.A - a.A) * (b.A - a.A) + (b.B - a.B) * (b.B - a.B)));
            }

            var total = cumulative[cumulative.Count - 1];
            if (!(total > 1e-9)) return new List<Vec2d>();

            var result = new List<Vec2d>(count);
            var segment = 0;
            for (var index = 0; index < count; index += 1)
            {
                var distance = total * index / count;
                while (segment < loop.Count - 1 && cumulative[segment + 1] < distance) segment += 1;
                var a = loop[segment];
                var b = loop[(segment + 1) % loop.Count];
                var span = cumulative[segment + 1] - cumulative[segment];
                var t = span > 1e-12 ? (distance - cumulative[segment]) / span : 0;
                result.Add(new Vec2d(a.A + (b.A - a.A) * t, a.B + (b.B - a.B) * t));
            }
            return result;
        }

        private static Vec3d LoftPoint(string axis, double at, double a, double b)
        {
            if (axis == "x") return new Vec3d(at, a, b);
            if (axis == "y") return new Vec3d(a, at, b);
            return new Vec3d(a, b, at);
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

            if (solid.Kind == "frustum")
            {
                var end = solid.Base;
                if (solid.Axis == "x") end.X += solid.Height;
                else if (solid.Axis == "y") end.Y += solid.Height;
                else end.Z += solid.Height;

                var radius = Math.Max(solid.RadiusBottom, solid.RadiusTop);
                var rx = solid.Axis == "x" ? 0 : radius;
                var ry = solid.Axis == "y" ? 0 : radius;
                var rz = solid.Axis == "z" ? 0 : radius;

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

            if (solid.Kind == "bend")
            {
                var start = solid.StartAngle * Math.PI / 180;
                var sweep = solid.Angle * Math.PI / 180;
                var u = solid.Plane == "yz" ? new Vec3d(0, 1, 0) : new Vec3d(1, 0, 0);
                var v = solid.Plane == "xy" ? new Vec3d(0, 1, 0) : new Vec3d(0, 0, 1);
                var steps = Math.Max(8, Math.Min(256,
                    (int)Math.Ceiling(Math.Abs(sweep) * (solid.Radius + solid.TubeRadius) / 10)));

                for (var index = 0; index <= steps; index += 1)
                {
                    var angle = start + sweep * index / steps;
                    var cos = Math.Cos(angle);
                    var sin = Math.Sin(angle);

                    var rx = u.X * cos + v.X * sin;
                    var ry = u.Y * cos + v.Y * sin;
                    var rz = u.Z * cos + v.Z * sin;

                    var cx = solid.Center.X + rx * solid.Radius;
                    var cy = solid.Center.Y + ry * solid.Radius;
                    var cz = solid.Center.Z + rz * solid.Radius;
                    bounds.Grow(new Vec3d(cx, cy, cz));

                    var tx = -u.X * sin + v.X * cos;
                    var ty = -u.Y * sin + v.Y * cos;
                    var tz = -u.Z * sin + v.Z * cos;
                    var ex = solid.TubeRadius * Math.Sqrt(Math.Max(0, 1 - tx * tx));
                    var ey = solid.TubeRadius * Math.Sqrt(Math.Max(0, 1 - ty * ty));
                    var ez = solid.TubeRadius * Math.Sqrt(Math.Max(0, 1 - tz * tz));

                    bounds.Grow(new Vec3d(cx - ex, cy - ey, cz - ez));
                    bounds.Grow(new Vec3d(cx + ex, cy + ey, cz + ez));
                }

                return bounds;
            }

            if (solid.Kind == "loft")
            {
                foreach (var section in solid.Sections)
                {
                    foreach (var point in section.Points)
                    {
                        bounds.Grow(LoftPoint(solid.Axis, section.At, point.A, point.B));
                    }
                }
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
