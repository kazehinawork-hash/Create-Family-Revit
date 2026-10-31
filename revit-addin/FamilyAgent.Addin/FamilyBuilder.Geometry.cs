using System;
using System.Collections.Generic;
using System.Linq;
using Autodesk.Revit.DB;
using FamilyAgent.Core;
using CoreParameterSet = FamilyAgent.Core.ParameterSet;

namespace FamilyAgent.Addin
{
    internal static partial class FamilyBuilder
    {
        // -------------------------------------------------------------- geometry

        private static List<Element> CreateGeometry(
            Document document,
            ResolvedModel model,
            IDictionary<string, MaterialDef> materials,
            List<string> warnings,
            IDictionary<long, ResolvedPart> partByForm)
        {
            var forms = new List<Element>();

            foreach (var part in model.Parts)
            {
                try
                {
                    for (var index = 0; index < Math.Max(1, part.ArrayCount); index += 1)
                    {
                        var offset = ArrayOffsetMm(part, index);

                        // A Z-axis frustum becomes a Revolution: its circular edges stay true
                        // and can take dimensions, unlike a fully tessellated Blend.
                        Element body = null;
                        if (part.Solid.Kind == "frustum" && IsProfileFrustum(part.Solid))
                        {
                            body = CreateFrustumRevolve(document, part.Solid, offset, warnings);
                        }

                        body = body ?? CreateForm(document, part.Solid, offset, true);

                        if (body == null)
                        {
                            warnings.Add($"Part \"{part.Id}\" produced no solid");
                            continue;
                        }

                        try
                        {
                            body.Name = part.ArrayCount > 1 ? $"{part.Name} {index + 1}" : part.Name;
                        }
                        catch
                        {
                            // Forms do not always accept a name.
                        }

                        AssignMaterial(
                            document,
                            body,
                            MaterialName(part, materials),
                            MaterialColor(part, materials),
                            warnings);
                        forms.Add(body);
                        if (partByForm != null && body.Id != ElementId.InvalidElementId)
                        {
                            // LockGeometry needs to know which part a form belongs to in
                            // order to honour its anchor.
                            partByForm[body.Id.Value] = part;
                        }

                        if (part.Solid.Kind == "cylinder" && part.Solid.InnerRadius > 0)
                        {
                            try
                            {
                                var bore = CreateCylinderForm(
                                    document, part.Solid, offset, part.Solid.InnerRadius, false, true);
                                if (bore != null) forms.Add(bore);
                            }
                            catch (Exception ex)
                            {
                                warnings.Add($"Bore on \"{part.Id}\" failed: {ex.Message}");
                            }
                        }

                        foreach (var cut in part.Cuts)
                        {
                            try
                            {
                                var cutter = CreateForm(document, cut, offset, false);
                                if (cutter != null) forms.Add(cutter);
                            }
                            catch (Exception ex)
                            {
                                warnings.Add($"Cut on \"{part.Id}\" failed: {ex.Message}");
                            }
                        }
                    }
                }
                catch (Exception ex)
                {
                    warnings.Add($"Part \"{part.Id}\" failed: {ex.Message}");
                }
            }

            return forms;
        }

        private static Vec3d ArrayOffsetMm(ResolvedPart part, int index)
        {
            var distance = part.ArraySpacing * index;
            switch (part.ArrayAxis)
            {
                case "y": return new Vec3d(0, distance, 0);
                case "z": return new Vec3d(0, 0, distance);
                default: return new Vec3d(distance, 0, 0);
            }
        }

        private static Element CreateForm(Document document, ResolvedSolid solid, Vec3d offset, bool isSolid)
        {
            switch (solid.Kind)
            {
                case "box": return CreateBoxForm(document, solid, offset, isSolid);
                case "cylinder": return CreateCylinderForm(document, solid, offset, solid.Radius, isSolid, false);
                case "frustum": return CreateFrustumForm(document, solid, offset, isSolid);
                case "bend": return CreateBendForm(document, solid, offset, isSolid);
                case "prism": return CreatePrismForm(document, solid, offset, isSolid);
                default: return null;
            }
        }

        /// <summary>
        /// Native family forms are the requirement: extrusions (and void extrusions for cuts)
        /// stay editable in Revit and can be constrained to reference planes, unlike the free
        /// form elements the builder used before.
        /// </summary>
        private static Extrusion Extrude(
            Document document,
            Plane plane,
            IList<XYZ> points,
            double length,
            bool isSolid)
        {
            if (!(Math.Abs(length) > 1e-9)) throw new InvalidOperationException("extrusion has a zero depth");

            var sketchPlane = SketchPlane.Create(document, plane);

            var curveArray = new CurveArray();
            foreach (var curve in Loop(points)) curveArray.Append(curve);

            var profile = new CurveArrArray();
            profile.Append(curveArray);

            return document.FamilyCreate.NewExtrusion(isSolid, profile, sketchPlane, length);
        }

        private static Plane PlaneAt(XYZ origin, XYZ normal)
        {
            var w = normal.Normalize();
            var helper = Math.Abs(w.Z) < 0.9 ? XYZ.BasisZ : XYZ.BasisX;
            var u = w.CrossProduct(helper).Normalize();
            var v = w.CrossProduct(u).Normalize();
            return Plane.CreateByOriginAndBasis(origin, u, v);
        }

        private static XYZ AxisUnit(string axis)
        {
            switch (axis)
            {
                case "x": return XYZ.BasisX;
                case "y": return XYZ.BasisY;
                default: return XYZ.BasisZ;
            }
        }

        private static Extrusion CreateBoxForm(Document document, ResolvedSolid solid, Vec3d offset, bool isSolid)
        {
            var width = Ft(Math.Abs(solid.Size.X));
            var depth = Ft(Math.Abs(solid.Size.Y));
            var height = Ft(Math.Abs(solid.Size.Z));

            if (width <= 0 || depth <= 0 || height <= 0)
                throw new InvalidOperationException("box has a zero dimension");

            var angle = solid.RotationZ * DegToRad;
            var u = new XYZ(Math.Cos(angle), Math.Sin(angle), 0);
            var v = new XYZ(-Math.Sin(angle), Math.Cos(angle), 0);

            var zBase = Math.Min(solid.Origin.Z, solid.Origin.Z + solid.Size.Z) + offset.Z;
            var center = new XYZ(
                Ft(solid.Origin.X + offset.X),
                Ft(solid.Origin.Y + offset.Y),
                Ft(zBase));

            var halfWidth = width / 2;
            var halfDepth = depth / 2;
            var radius = Ft(Math.Max(0, solid.CornerRadius));

            var points = radius > 1e-6
                ? RoundedRectPoints(center, u, v, halfWidth, halfDepth, Math.Min(radius, Math.Min(halfWidth, halfDepth) - 1e-9))
                : new List<XYZ>
                {
                    center - u * halfWidth - v * halfDepth,
                    center + u * halfWidth - v * halfDepth,
                    center + u * halfWidth + v * halfDepth,
                    center - u * halfWidth + v * halfDepth,
                };

            return Extrude(document, Plane.CreateByOriginAndBasis(center, u, v), points, height, isSolid);
        }

        /// <summary>
        /// Polyline outline of a rectangle with rounded corners, counter-clockwise in the (u, v) basis.
        /// Revit profiles are built from lines, so the arcs are tessellated.
        /// </summary>
        private static List<XYZ> RoundedRectPoints(
            XYZ center,
            XYZ u,
            XYZ v,
            double halfWidth,
            double halfDepth,
            double radius)
        {
            const int segmentsPerCorner = 8;
            var innerX = halfWidth - radius;
            var innerY = halfDepth - radius;
            var cornerX = new[] { innerX, -innerX, -innerX, innerX };
            var cornerY = new[] { innerY, innerY, -innerY, -innerY };
            var cornerStart = new[] { 0.0, Math.PI / 2, Math.PI, 3 * Math.PI / 2 };

            var points = new List<XYZ>(4 * (segmentsPerCorner + 1));
            for (var corner = 0; corner < 4; corner += 1)
            {
                for (var step = 0; step <= segmentsPerCorner; step += 1)
                {
                    var angle = cornerStart[corner] + step * (Math.PI / 2) / segmentsPerCorner;
                    points.Add(
                        center
                        + u * (cornerX[corner] + Math.Cos(angle) * radius)
                        + v * (cornerY[corner] + Math.Sin(angle) * radius));
                }
            }

            return points;
        }

        private static Extrusion CreateCylinderForm(
            Document document,
            ResolvedSolid solid,
            Vec3d offset,
            double radiusMm,
            bool isSolid,
            bool asBore)
        {
            var radius = Ft(radiusMm);
            var length = Ft(Math.Abs(solid.Height));

            if (radius <= 0 || length <= 0) throw new InvalidOperationException("cylinder has a zero dimension");

            var direction = AxisUnit(solid.Axis) * (solid.Height >= 0 ? 1 : -1);
            var basePoint = new XYZ(
                Ft(solid.Base.X + offset.X),
                Ft(solid.Base.Y + offset.Y),
                Ft(solid.Base.Z + offset.Z));

            // A bore has to overshoot both ends to cut the tube cleanly.
            var start = asBore ? basePoint - direction * Ft(0.6) : basePoint;
            var end = asBore ? length + Ft(1.2) : length;

            var plane = PlaneAt(start, direction);
            var segments = Math.Max(12, solid.Segments);
            var points = new List<XYZ>(segments);

            for (var i = 0; i < segments; i += 1)
            {
                var angle = 2 * Math.PI * i / segments;
                points.Add(start + plane.XVec * (Math.Cos(angle) * radius) + plane.YVec * (Math.Sin(angle) * radius));
            }

            return Extrude(document, plane, points, end, isSolid);
        }

        /// <summary>
        /// A truncated cone is a native Blend between two circular profiles. Revit calls it
        /// a blend, but it edits like any other family form and flexes with the parameters.
        /// </summary>
        private static Element CreateFrustumForm(
            Document document,
            ResolvedSolid solid,
            Vec3d offset,
            bool isSolid)
        {
            var height = Ft(Math.Abs(solid.Height));
            if (height <= 1e-9) throw new InvalidOperationException("frustum has a zero height");

            var direction = AxisUnit(solid.Axis) * (solid.Height >= 0 ? 1 : -1);
            var basePoint = new XYZ(
                Ft(solid.Base.X + offset.X),
                Ft(solid.Base.Y + offset.Y),
                Ft(solid.Base.Z + offset.Z));

            // Radii follow the extrusion direction, so a negative height swaps the ends.
            var bottomRadius = Ft(solid.Height >= 0 ? solid.RadiusBottom : solid.RadiusTop);
            var topRadius = Ft(solid.Height >= 0 ? solid.RadiusTop : solid.RadiusBottom);

            // A blend profile cannot collapse to a point; a cone keeps a hairline top.
            const double minRadius = 0.5 / MmPerFoot;
            bottomRadius = Math.Max(bottomRadius, minRadius);
            topRadius = Math.Max(topRadius, minRadius);

            var plane = PlaneAt(basePoint, direction);
            var segments = Math.Max(12, solid.Segments);
            var bottom = CirclePoints(plane, basePoint, bottomRadius, segments);
            var top = CirclePoints(plane, basePoint + direction * height, topRadius, segments);

            var profile1 = LoopArray(bottom);
            var profile2 = LoopArray(top);
            return document.FamilyCreate.NewBlend(
                isSolid,
                profile1,
                profile2,
                SketchPlane.Create(document, plane));
        }

        private static List<XYZ> CirclePoints(Plane plane, XYZ center, double radius, int segments)
        {
            var points = new List<XYZ>(segments);
            for (var i = 0; i < segments; i += 1)
            {
                var angle = 2 * Math.PI * i / segments;
                points.Add(
                    center
                    + plane.XVec * (Math.Cos(angle) * radius)
                    + plane.YVec * (Math.Sin(angle) * radius));
            }
            return points;
        }

        private static CurveArray LoopArray(IList<XYZ> points)
        {
            var array = new CurveArray();
            foreach (var curve in Loop(points)) array.Append(curve);
            return array;
        }

        /// <summary>
        /// A round elbow is a circular profile revolved around an axis, which Revit stores
        /// as a native Revolution. The profile plane contains the axis and the radial
        /// direction, so the sweep stays planar and can be edited in the family.
        /// </summary>
        private static Element CreateBendForm(
            Document document,
            ResolvedSolid solid,
            Vec3d offset,
            bool isSolid)
        {
            var radius = Ft(solid.Radius);
            var tube = Ft(solid.TubeRadius);
            if (radius <= 0 || tube <= 0) throw new InvalidOperationException("bend has a zero radius");
            if (tube >= radius) throw new InvalidOperationException("bend tubeRadius must be smaller than radius");

            var center = new XYZ(
                Ft(solid.Center.X + offset.X),
                Ft(solid.Center.Y + offset.Y),
                Ft(solid.Center.Z + offset.Z));

            XYZ axisUnit;
            XYZ u;
            XYZ v;
            switch (solid.Plane)
            {
                case "xz":
                    axisUnit = XYZ.BasisY;
                    u = XYZ.BasisX;
                    v = XYZ.BasisZ;
                    break;
                case "yz":
                    axisUnit = XYZ.BasisX;
                    u = XYZ.BasisY;
                    v = XYZ.BasisZ;
                    break;
                default:
                    axisUnit = XYZ.BasisZ;
                    u = XYZ.BasisX;
                    v = XYZ.BasisY;
                    break;
            }

            var start = solid.StartAngle * DegToRad;
            var radial = (u * Math.Cos(start) + v * Math.Sin(start)).Normalize();
            var profileCenter = center + radial * radius;

            var plane = Plane.CreateByOriginAndBasis(profileCenter, radial, axisUnit);
            var segments = Math.Max(8, solid.Segments);
            var points = new List<XYZ>(segments);
            for (var i = 0; i < segments; i += 1)
            {
                var t = 2 * Math.PI * i / segments;
                points.Add(
                    profileCenter
                    + radial * (Math.Cos(t) * tube)
                    + axisUnit * (Math.Sin(t) * tube));
            }

            var profile = new CurveArrArray();
            profile.Append(LoopArray(points));

            var axis = Line.CreateUnbound(center, axisUnit);
            var sketchPlane = SketchPlane.Create(document, plane);
            var angle = solid.Angle * DegToRad;

            try
            {
                return document.FamilyCreate.NewRevolution(isSolid, profile, sketchPlane, axis, 0, angle);
            }
            catch
            {
                // The sketch-plane normal decides the sweep direction; -angle is the
                // same bend on the other side of the start plane.
                return document.FamilyCreate.NewRevolution(isSolid, profile, sketchPlane, axis, 0, -angle);
            }
        }

        private static Extrusion CreatePrismForm(Document document, ResolvedSolid solid, Vec3d offset, bool isSolid)
        {
            var length = Ft(Math.Abs(solid.To - solid.From));
            if (length <= 0) throw new InvalidOperationException("prism has a zero depth");

            XYZ u, v, axisUnit;
            XYZ origin;
            var baseCoordinate = Math.Min(solid.From, solid.To);

            switch (solid.Plane)
            {
                case "xz":
                    u = XYZ.BasisX;
                    v = XYZ.BasisZ;
                    axisUnit = XYZ.BasisY;
                    origin = new XYZ(0, Ft(baseCoordinate + offset.Y), 0);
                    break;
                case "yz":
                    u = XYZ.BasisY;
                    v = XYZ.BasisZ;
                    axisUnit = XYZ.BasisX;
                    origin = new XYZ(Ft(baseCoordinate + offset.X), 0, 0);
                    break;
                default:
                    u = XYZ.BasisX;
                    v = XYZ.BasisY;
                    axisUnit = XYZ.BasisZ;
                    origin = new XYZ(0, 0, Ft(baseCoordinate + offset.Z));
                    break;
            }

            var points = new List<XYZ>();
            foreach (var point in solid.Points)
            {
                var a = Ft(point.A);
                var b = Ft(point.B);

                switch (solid.Plane)
                {
                    case "xz":
                        points.Add(origin + u * (a + Ft(offset.X)) + v * (b + Ft(offset.Z)));
                        break;
                    case "yz":
                        points.Add(origin + u * (a + Ft(offset.Y)) + v * (b + Ft(offset.Z)));
                        break;
                    default:
                        points.Add(origin + u * (a + Ft(offset.X)) + v * (b + Ft(offset.Y)));
                        break;
                }
            }

            if (points.Count < 3) throw new InvalidOperationException("prism needs at least 3 points");

            var normal = u.CrossProduct(v);
            var desired = axisUnit * Math.Sign(solid.To - solid.From);
            var end = desired.DotProduct(normal) > 0 ? length : -length;

            return Extrude(document, Plane.CreateByOriginAndBasis(origin, u, v), points, end, isSolid);
        }

        private static CurveLoop Loop(IList<XYZ> points)
        {
            var loop = new CurveLoop();
            for (var i = 0; i < points.Count; i += 1)
            {
                loop.Append(Line.CreateBound(points[i], points[(i + 1) % points.Count]));
            }
            return loop;
        }

    }
}
