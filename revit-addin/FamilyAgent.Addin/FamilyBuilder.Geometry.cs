using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.RegularExpressions;
using Autodesk.Revit.DB;
using Autodesk.Revit.DB.Electrical;
using Autodesk.Revit.DB.Mechanical;
using Autodesk.Revit.DB.Plumbing;
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
            var materialCache = new Dictionary<string, Material>(StringComparer.OrdinalIgnoreCase);

            foreach (var part in model.Parts)
            {
                try
                {
                    for (var index = 0; index < Math.Max(1, part.ArrayCount); index += 1)
                    {
                        var offset = ArrayOffsetMm(part, index);
                        var hasInnerRadius = part.Solid.Kind == "cylinder" && part.Solid.InnerRadius > 0;
                        var hasCuts = part.Cuts.Count > 0;

                        Element body;
                        if (CanCreateNativeFlangeExtrusion(part))
                        {
                            // A cylinder with concentric inner bore and/or parallel bolt hole cuts
                            // is extruded as a SINGLE native Revit Extrusion with 1 outer loop and multiple inner loops!
                            try
                            {
                                body = CreateNativeMultiHoleFlangeForm(document, part, offset, true);
                            }
                            catch
                            {
                                body = CreateBooleanBody(document, part, offset, warnings);
                            }
                        }
                        else if (hasCuts)
                        {
                            // Revit voids cut every intersecting solid, not only their host.
                            // A per-part boolean keeps the cut local, exactly like the studio.
                            body = CreateBooleanBody(document, part, offset, warnings);
                        }
                        else if (hasInnerRadius)
                        {
                            // A hollow cylinder (pipe, collar, flange sleeve) can be created directly as a
                            // native Revit Extrusion with concentric outer and inner loops, keeping it parametric
                            // and lightweight without resorting to a FreeFormElement.
                            body = CreateHollowCylinderForm(document, part.Solid, offset, true);
                        }
                        else
                        {
                            // A Z-axis frustum becomes a Revolution: its circular edges stay true
                            // and can take dimensions, unlike a fully tessellated Blend.
                            body = part.Solid.Kind == "frustum" && IsProfileFrustum(part.Solid)
                                ? CreateFrustumRevolve(document, part.Solid, offset, warnings)
                                : null;
                            body = body ?? CreateForm(document, part.Solid, offset, true);
                        }

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
                            warnings,
                            materialCache);

                        ApplyVisibilitySettings(document, body, part);
                        forms.Add(body);
                        if (partByForm != null && body.Id != ElementId.InvalidElementId)
                        {
                            // LockGeometry needs to know which part a form belongs to in
                            // order to honour its anchor.
                            partByForm[body.Id.Value] = part;
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

        private static Solid SolidOf(Element form)
        {
            var options = new Options { ComputeReferences = true, DetailLevel = ViewDetailLevel.Fine };
            GeometryElement geometry;
            try { geometry = form.get_Geometry(options); } catch { return null; }
            if (geometry == null) return null;

            foreach (var item in geometry)
            {
                if (item is Solid solid && solid.Volume > 1e-9) return solid;
            }
            return null;
        }

        /// <summary>
        /// Builds the part body and subtracts its cuts and bore as a real boolean. Revit
        /// void forms cut every overlapping solid in the family, so they cannot be scoped
        /// to one part; a FreeFormElement holds the result without touching its neighbours.
        /// </summary>
        private static Element CreateBooleanBody(
            Document document,
            ResolvedPart part,
            Vec3d offset,
            List<string> warnings)
        {
            Element body = part.Solid.Kind == "frustum" && IsProfileFrustum(part.Solid)
                ? CreateFrustumRevolve(document, part.Solid, offset, warnings)
                : null;
            body = body ?? CreateForm(document, part.Solid, offset, true);
            if (body == null) return null;

            var solid = SolidOf(body);
            if (solid == null)
            {
                warnings.Add($"Boolean body for \"{part.Id}\" has no solid");
                TryDelete(document, body);
                return null;
            }

            try
            {
                foreach (var cut in part.Cuts)
                {
                    // Extend the cutter solid slightly (+0.5 mm at both ends) to prevent coplanar face
                    // z-fighting and sliver artifacts during Revit BooleanOperationsUtils difference.
                    var extendedCut = cut;
                    if (cut.Kind == "cylinder")
                    {
                        extendedCut = new ResolvedSolid
                        {
                            Kind = cut.Kind,
                            Radius = cut.Radius,
                            InnerRadius = cut.InnerRadius,
                            Axis = cut.Axis,
                            Segments = cut.Segments,
                            Height = cut.Height >= 0 ? cut.Height + 1.0 : cut.Height - 1.0,
                            Base = new Vec3d(
                                cut.Base.X + (cut.Axis == "x" ? (cut.Height >= 0 ? -0.5 : 0.5) : 0),
                                cut.Base.Y + (cut.Axis == "y" ? (cut.Height >= 0 ? -0.5 : 0.5) : 0),
                                cut.Base.Z + (cut.Axis == "z" ? (cut.Height >= 0 ? -0.5 : 0.5) : 0))
                        };
                    }
                    else if (cut.Kind == "box")
                    {
                        var signZ = cut.Size.Z >= 0 ? 1.0 : -1.0;
                        extendedCut = new ResolvedSolid
                        {
                            Kind = cut.Kind,
                            Origin = new Vec3d(cut.Origin.X, cut.Origin.Y, cut.Origin.Z - signZ * 0.5),
                            Size = new Vec3d(cut.Size.X, cut.Size.Y, cut.Size.Z + signZ * 1.0),
                            RotationZ = cut.RotationZ,
                            CornerRadius = cut.CornerRadius
                        };
                    }
                    else if (cut.Kind == "prism")
                    {
                        var signP = cut.To >= cut.From ? 1.0 : -1.0;
                        extendedCut = new ResolvedSolid
                        {
                            Kind = cut.Kind,
                            Plane = cut.Plane,
                            Points = cut.Points,
                            Holes = cut.Holes,
                            From = cut.From - signP * 0.5,
                            To = cut.To + signP * 0.5
                        };
                    }

                    var cutter = CreateForm(document, extendedCut, offset, true);
                    if (cutter == null) continue;

                    var cutterSolid = SolidOf(cutter);
                    if (cutterSolid == null)
                    {
                        TryDelete(document, cutter);
                        continue;
                    }

                    var result = BooleanOperationsUtils.ExecuteBooleanOperation(
                        solid, cutterSolid, BooleanOperationsType.Difference);
                    TryDelete(document, cutter);

                    if (result == null || result.Volume <= 1e-9)
                    {
                        warnings.Add($"Cut on \"{part.Id}\" removed the whole part");
                        TryDelete(document, body);
                        return null;
                    }
                    solid = result;
                }

                if (part.Solid.Kind == "cylinder" && part.Solid.InnerRadius > 0)
                {
                    var bore = CreateCylinderForm(
                        document, part.Solid, offset, part.Solid.InnerRadius, true, true);
                    if (bore != null)
                    {
                        var boreSolid = SolidOf(bore);
                        if (boreSolid != null)
                        {
                            var result = BooleanOperationsUtils.ExecuteBooleanOperation(
                                solid, boreSolid, BooleanOperationsType.Difference);
                            if (result != null && result.Volume > 1e-9) solid = result;
                        }
                        TryDelete(document, bore);
                    }
                }

                var freeform = FreeFormElement.Create(document, solid);
                if (freeform == null)
                {
                    warnings.Add($"Boolean result for \"{part.Id}\" was rejected by Revit");
                    TryDelete(document, body);
                    return null;
                }

                TryDelete(document, body);
                return freeform;
            }
            catch (Exception ex)
            {
                warnings.Add($"Boolean cut on \"{part.Id}\" failed: {ex.Message}");
                TryDelete(document, body);
                return null;
            }
        }

        private static void TryDelete(Document document, Element element)
        {
            try
            {
                if (element != null && element.Id != ElementId.InvalidElementId) document.Delete(element.Id);
            }
            catch
            {
                // A form that is already gone is harmless.
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
                case "loft": return CreateLoftForm(document, solid, offset, isSolid);
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
            return Extrude(document, plane, points, null, length, isSolid);
        }

        /// <summary>
        /// One extrusion with optional inner loops. Revit keeps multiple loops in a single
        /// sketch profile, so a grille or flange can be one native form instead of a stack
        /// of global void cuts.
        /// </summary>
        private static Extrusion Extrude(
            Document document,
            Plane plane,
            IList<XYZ> points,
            IList<IList<XYZ>> holes,
            double length,
            bool isSolid)
        {
            if (!(Math.Abs(length) > 1e-9)) throw new InvalidOperationException("extrusion has a zero depth");

            var sketchPlane = SketchPlane.Create(document, plane);

            var profile = new CurveArrArray();
            profile.Append(LoopArray(points));
            if (holes != null)
            {
                foreach (var hole in holes)
                {
                    if (hole != null && hole.Count >= 3) profile.Append(LoopArray(hole));
                }
            }

            try
            {
                return document.FamilyCreate.NewExtrusion(isSolid, profile, sketchPlane, length);
            }
            catch
            {
                var reversed = new List<XYZ>(points);
                reversed.Reverse();
                var altProfile = new CurveArrArray();
                altProfile.Append(LoopArray(reversed));
                if (holes != null)
                {
                    foreach (var hole in holes)
                    {
                        if (hole == null || hole.Count < 3) continue;
                        var revHole = new List<XYZ>(hole);
                        revHole.Reverse();
                        altProfile.Append(LoopArray(revHole));
                    }
                }
                return document.FamilyCreate.NewExtrusion(isSolid, altProfile, sketchPlane, length);
            }
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
            var minHalf = Math.Min(halfWidth, halfDepth);
            // If the corner radius or box thickness is close to Revit's short-curve tolerance (~0.8 mm),
            // skip corner rounding or clamp so no zero-length straight segments or micro-chords are emitted.
            var maxSafeRadius = Math.Max(0, minHalf - Ft(0.9));
            var radius = Math.Min(Ft(Math.Max(0, solid.CornerRadius)), maxSafeRadius);

            var plane = Plane.CreateByOriginAndBasis(center, u, v);
            var sketchPlane = SketchPlane.Create(document, plane);
            var profile = new CurveArrArray();
            var loop = BuildRectLoop(plane, center, u, v, halfWidth, halfDepth, radius);
            profile.Append(loop);

            return document.FamilyCreate.NewExtrusion(isSolid, profile, sketchPlane, height);
        }

        /// <summary>
        /// Creates a rectangular CurveArray profile with true Arc corners (if radius > 1.2mm)
        /// or sharp corners (Line.CreateBound).
        /// Using true Arc curves prevents dense faceted shading edges in Revit Hidden Line views.
        /// </summary>
        private static CurveArray BuildRectLoop(
            Plane plane,
            XYZ center,
            XYZ u,
            XYZ v,
            double halfWidth,
            double halfDepth,
            double radius)
        {
            var loop = new CurveArray();

            if (radius > Ft(1.2) && (halfWidth - radius) >= Ft(0.8) && (halfDepth - radius) >= Ft(0.8))
            {
                var innerX = halfWidth - radius;
                var innerY = halfDepth - radius;

                // Center points of the 4 corner arcs
                var c1 = center + u * innerX + v * innerY;
                var c2 = center - u * innerX + v * innerY;
                var c3 = center - u * innerX - v * innerY;
                var c4 = center + u * innerX - v * innerY;

                // Arc 1: (x > 0, y > 0) from angle 0 to PI/2
                var p1_start = c1 + u * radius;
                var p1_end = c1 + v * radius;
                var arc1 = Arc.Create(p1_start, p1_end, c1 + (u + v).Normalize() * radius);

                // Line top: from c1 top to c2 top
                var p2_start = c2 + v * radius;
                var lineTop = Line.CreateBound(p1_end, p2_start);

                // Arc 2: (x < 0, y > 0) from PI/2 to PI
                var p2_end = c2 - u * radius;
                var arc2 = Arc.Create(p2_start, p2_end, c2 + (-u + v).Normalize() * radius);

                // Line left: from c2 left to c3 left
                var p3_start = c3 - u * radius;
                var lineLeft = Line.CreateBound(p2_end, p3_start);

                // Arc 3: (x < 0, y < 0) from PI to 3*PI/2
                var p3_end = c3 - v * radius;
                var arc3 = Arc.Create(p3_start, p3_end, c3 + (-u - v).Normalize() * radius);

                // Line bottom: from c3 bottom to c4 bottom
                var p4_start = c4 - v * radius;
                var lineBottom = Line.CreateBound(p3_end, p4_start);

                // Arc 4: (x > 0, y < 0) from 3*PI/2 to 2*PI
                var p4_end = c4 + u * radius;
                var arc4 = Arc.Create(p4_start, p4_end, c4 + (u - v).Normalize() * radius);

                // Line right: from c4 right to c1 right
                var lineRight = Line.CreateBound(p4_end, p1_start);

                loop.Append(arc1);
                loop.Append(lineTop);
                loop.Append(arc2);
                loop.Append(lineLeft);
                loop.Append(arc3);
                loop.Append(lineBottom);
                loop.Append(arc4);
                loop.Append(lineRight);
            }
            else
            {
                var pt1 = center - u * halfWidth - v * halfDepth;
                var pt2 = center + u * halfWidth - v * halfDepth;
                var pt3 = center + u * halfWidth + v * halfDepth;
                var pt4 = center - u * halfWidth + v * halfDepth;

                loop.Append(Line.CreateBound(pt1, pt2));
                loop.Append(Line.CreateBound(pt2, pt3));
                loop.Append(Line.CreateBound(pt3, pt4));
                loop.Append(Line.CreateBound(pt4, pt1));
            }

            return loop;
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

            // Use a true two-arc circular loop when radius >= 1 mm so Revit renders a smooth
            // cylindrical surface with no vertical facet lines, matching the Three.js Smooth Shading.
            if (radiusMm >= 1.0)
            {
                var sketchPlane = SketchPlane.Create(document, plane);
                var profile = new CurveArrArray();
                var arcLoop = new CurveArray();
                arcLoop.Append(Arc.Create(plane, radius, 0, Math.PI));
                arcLoop.Append(Arc.Create(plane, radius, Math.PI, 2 * Math.PI));
                profile.Append(arcLoop);
                return document.FamilyCreate.NewExtrusion(isSolid, profile, sketchPlane, end);
            }

            var segments = SegmentsFor(radiusMm, solid.Segments);
            var points = new List<XYZ>(segments);

            for (var i = 0; i < segments; i += 1)
            {
                var angle = 2 * Math.PI * i / segments;
                points.Add(start + plane.XVec * (Math.Cos(angle) * radius) + plane.YVec * (Math.Sin(angle) * radius));
            }

            return Extrude(document, plane, points, end, isSolid);
        }

        private static Extrusion CreateHollowCylinderForm(
            Document document,
            ResolvedSolid solid,
            Vec3d offset,
            bool isSolid)
        {
            var outerRadius = Ft(solid.Radius);
            var innerRadius = Ft(solid.InnerRadius);
            var length = Ft(Math.Abs(solid.Height));

            if (outerRadius <= 0 || innerRadius <= 0 || length <= 0)
                throw new InvalidOperationException("hollow cylinder has a non-positive dimension");
            if (innerRadius >= outerRadius)
                throw new InvalidOperationException("inner radius cannot be greater than or equal to outer radius");

            var direction = AxisUnit(solid.Axis) * (solid.Height >= 0 ? 1 : -1);
            var basePoint = new XYZ(
                Ft(solid.Base.X + offset.X),
                Ft(solid.Base.Y + offset.Y),
                Ft(solid.Base.Z + offset.Z));

            var plane = PlaneAt(basePoint, direction);
            var sketchPlane = SketchPlane.Create(document, plane);
            var profile = new CurveArrArray();

            if (solid.InnerRadius >= 1.0)
            {
                var outerLoop = new CurveArray();
                outerLoop.Append(Arc.Create(plane, outerRadius, 0, Math.PI));
                outerLoop.Append(Arc.Create(plane, outerRadius, Math.PI, 2 * Math.PI));
                profile.Append(outerLoop);

                var innerLoop = new CurveArray();
                innerLoop.Append(Arc.Create(plane, innerRadius, 0, Math.PI));
                innerLoop.Append(Arc.Create(plane, innerRadius, Math.PI, 2 * Math.PI));
                profile.Append(innerLoop);
            }
            else
            {
                var segments = SegmentsFor(solid.Radius, solid.Segments);
                var outerPoints = CirclePoints(plane, basePoint, outerRadius, segments);
                var innerPoints = CirclePoints(plane, basePoint, innerRadius, segments);
                profile.Append(LoopArray(outerPoints));
                profile.Append(LoopArray(innerPoints));
            }

            return document.FamilyCreate.NewExtrusion(isSolid, profile, sketchPlane, length);
        }

        private static double Distance2D(double a, double b) => Math.Sqrt(a * a + b * b);

        private static bool CanCreateNativeFlangeExtrusion(ResolvedPart part)
        {
            if (part.Cuts.Count == 0) return false;

            if (part.Solid.Kind == "cylinder")
            {
                var axis = part.Solid.Axis;
                var flangeRadius = part.Solid.Radius;
                var innerBore = part.Solid.InnerRadius;

                // Every cut must be a parallel cylinder along the same axis
                for (var i = 0; i < part.Cuts.Count; i += 1)
                {
                    var cut = part.Cuts[i];
                    if (cut.Kind != "cylinder" || cut.Axis != axis) return false;
                    if (cut.Radius <= 0) return false;

                    // Compute cut center distance to flange center on the perpendicular plane
                    var dx = cut.Base.X - part.Solid.Base.X;
                    var dy = cut.Base.Y - part.Solid.Base.Y;
                    var dz = cut.Base.Z - part.Solid.Base.Z;
                    var dist = axis == "x" ? Distance2D(dy, dz) : axis == "y" ? Distance2D(dx, dz) : Distance2D(dx, dy);

                    // Hole must be fully within outer rim (with safe margin)
                    if (dist + cut.Radius > flangeRadius - 0.78) return false;

                    // Hole must not intersect inner bore (if bore exists)
                    if (innerBore > 0 && dist - cut.Radius < innerBore + 0.78) return false;

                    // Hole must not intersect another hole
                    for (var j = i + 1; j < part.Cuts.Count; j += 1)
                    {
                        var other = part.Cuts[j];
                        var ox = cut.Base.X - other.Base.X;
                        var oy = cut.Base.Y - other.Base.Y;
                        var oz = cut.Base.Z - other.Base.Z;
                        var holeDist = axis == "x" ? Distance2D(oy, oz) : axis == "y" ? Distance2D(ox, oz) : Distance2D(ox, oy);
                        if (holeDist < cut.Radius + other.Radius + 0.78) return false;
                    }
                }
                return true;
            }

            if (part.Solid.Kind == "box")
            {
                var halfX = Math.Abs(part.Solid.Size.X) / 2.0;
                var halfY = Math.Abs(part.Solid.Size.Y) / 2.0;
                var centerX = part.Solid.Origin.X;
                var centerY = part.Solid.Origin.Y;

                // Box baseplate/flange: cuts must be perpendicular holes along Z axis
                for (var i = 0; i < part.Cuts.Count; i += 1)
                {
                    var cut = part.Cuts[i];
                    if (cut.Kind != "cylinder" || cut.Axis != "z") return false;
                    if (cut.Radius <= 0) return false;

                    // Hole must stay inside box footprint
                    var dx = Math.Abs(cut.Base.X - centerX);
                    var dy = Math.Abs(cut.Base.Y - centerY);
                    if (dx + cut.Radius > halfX - 0.78 || dy + cut.Radius > halfY - 0.78) return false;

                    // Hole must not intersect another hole
                    for (var j = i + 1; j < part.Cuts.Count; j += 1)
                    {
                        var other = part.Cuts[j];
                        var hx = cut.Base.X - other.Base.X;
                        var hy = cut.Base.Y - other.Base.Y;
                        var holeDist = Distance2D(hx, hy);
                        if (holeDist < cut.Radius + other.Radius + 0.78) return false;
                    }
                }
                return true;
            }

            return false;
        }

        private static Extrusion CreateNativeMultiHoleFlangeForm(
            Document document,
            ResolvedPart part,
            Vec3d offset,
            bool isSolid)
        {
            var solid = part.Solid;

            if (solid.Kind == "box")
            {
                var width = Ft(Math.Abs(solid.Size.X));
                var depth = Ft(Math.Abs(solid.Size.Y));
                var height = Ft(Math.Abs(solid.Size.Z));

                if (width <= 0 || depth <= 0 || height <= 0)
                    throw new InvalidOperationException("box baseplate has non-positive dimensions");

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
                var minHalf = Math.Min(halfWidth, halfDepth);
                var maxSafeRadius = Math.Max(0, minHalf - Ft(0.9));
                var radius = Math.Min(Ft(Math.Max(0, solid.CornerRadius)), maxSafeRadius);

                var plane = Plane.CreateByOriginAndBasis(center, u, v);
                var sketchPlane = SketchPlane.Create(document, plane);
                var profile = new CurveArrArray();

                // 1. Outer box rim (with true arc corners or lines)
                var outerLoop = BuildRectLoop(plane, center, u, v, halfWidth, halfDepth, radius);
                profile.Append(outerLoop);

                // 2. Bolt hole loops from cuts
                foreach (var cut in part.Cuts)
                {
                    var holeRadius = Ft(cut.Radius);
                    var holeBase = new XYZ(
                        Ft(cut.Base.X + offset.X),
                        Ft(cut.Base.Y + offset.Y),
                        Ft(zBase));

                    var holePlane = Plane.CreateByOriginAndBasis(holeBase, u, v);
                    var holeLoop = new CurveArray();
                    holeLoop.Append(Arc.Create(holePlane, holeRadius, 0, Math.PI));
                    holeLoop.Append(Arc.Create(holePlane, holeRadius, Math.PI, 2 * Math.PI));
                    profile.Append(holeLoop);
                }

                return document.FamilyCreate.NewExtrusion(isSolid, profile, sketchPlane, height);
            }

            var outerRadius = Ft(solid.Radius);
            var length = Ft(Math.Abs(solid.Height));

            if (outerRadius <= 0 || length <= 0)
                throw new InvalidOperationException("flange cylinder has non-positive dimensions");

            var direction = AxisUnit(solid.Axis) * (solid.Height >= 0 ? 1 : -1);
            var basePoint = new XYZ(
                Ft(solid.Base.X + offset.X),
                Ft(solid.Base.Y + offset.Y),
                Ft(solid.Base.Z + offset.Z));

            var cylPlane = PlaneAt(basePoint, direction);
            var cylSketchPlane = SketchPlane.Create(document, cylPlane);
            var cylProfile = new CurveArrArray();

            // 1. Outer rim loop
            var outerCylLoop = new CurveArray();
            outerCylLoop.Append(Arc.Create(cylPlane, outerRadius, 0, Math.PI));
            outerCylLoop.Append(Arc.Create(cylPlane, outerRadius, Math.PI, 2 * Math.PI));
            cylProfile.Append(outerCylLoop);

            // 2. Concentric inner bore loop (if any)
            if (solid.InnerRadius > 0 && solid.InnerRadius < solid.Radius)
            {
                var innerRadius = Ft(solid.InnerRadius);
                var innerLoop = new CurveArray();
                innerLoop.Append(Arc.Create(cylPlane, innerRadius, 0, Math.PI));
                innerLoop.Append(Arc.Create(cylPlane, innerRadius, Math.PI, 2 * Math.PI));
                cylProfile.Append(innerLoop);
            }

            // 3. Bolt hole loops from cuts
            foreach (var cut in part.Cuts)
            {
                var holeRadius = Ft(cut.Radius);
                var holeBase = new XYZ(
                    Ft(cut.Base.X + offset.X),
                    Ft(cut.Base.Y + offset.Y),
                    Ft(cut.Base.Z + offset.Z));

                // Project hole center onto the flange sketch plane so all loops are strictly coplanar
                var delta = holeBase - basePoint;
                var projectedCenter = holeBase - direction * delta.DotProduct(direction);
                var holePlane = Plane.CreateByOriginAndBasis(projectedCenter, cylPlane.XVec, cylPlane.YVec);
                var holeLoop = new CurveArray();
                holeLoop.Append(Arc.Create(holePlane, holeRadius, 0, Math.PI));
                holeLoop.Append(Arc.Create(holePlane, holeRadius, Math.PI, 2 * Math.PI));
                cylProfile.Append(holeLoop);
            }

            return document.FamilyCreate.NewExtrusion(isSolid, cylProfile, cylSketchPlane, length);
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
            if (Math.Min(bottomRadius, topRadius) * MmPerFoot >= 1.0)
            {
                var topCenter = basePoint + direction * height;
                var topPlane = Plane.CreateByOriginAndBasis(topCenter, plane.XVec, plane.YVec);

                var profile1Arc = new CurveArray();
                profile1Arc.Append(Arc.Create(plane, bottomRadius, 0, Math.PI));
                profile1Arc.Append(Arc.Create(plane, bottomRadius, Math.PI, 2 * Math.PI));

                var profile2Arc = new CurveArray();
                profile2Arc.Append(Arc.Create(topPlane, topRadius, 0, Math.PI));
                profile2Arc.Append(Arc.Create(topPlane, topRadius, Math.PI, 2 * Math.PI));

                return document.FamilyCreate.NewBlend(
                    isSolid,
                    profile1Arc,
                    profile2Arc,
                    SketchPlane.Create(document, plane));
            }

            var segments = SegmentsFor(Math.Max(bottomRadius, topRadius) * MmPerFoot, solid.Segments);
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

        private static int SegmentsFor(double radiusMm, int requested)
        {
            var radius = Math.Max(Math.Abs(radiusMm), 0.1);
            var circumference = 2 * Math.PI * radius;
            // Keep every profile segment above Revit's short-curve tolerance (about
            // 0.8 mm) instead of blindly honouring a 48-segment request on a Ø10 boss.
            var maxByChord = Math.Max(8, (int)Math.Floor(circumference / 1.5));
            var desired = Math.Max(12, Math.Max(requested, (int)Math.Ceiling(circumference / 10)));
            return Math.Min(96, Math.Min(desired, maxByChord));
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
        /// A round elbow is swept as a solid ring/tube along its circular arc and materialised
        /// as a FreeFormElement (or native Sweep), matching the studio preview's exact
        /// coordinate basis (u, v, n) without sketch-plane revolution handedness ambiguity.
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
            var angle = solid.Angle * DegToRad;
            var end = start + angle;
            var mid = start + angle * 0.5;

            XYZ PointOnArc(double theta)
            {
                var dir = (u * Math.Cos(theta) + v * Math.Sin(theta)).Normalize();
                return center + dir * radius;
            }

            var radialStart = (u * Math.Cos(start) + v * Math.Sin(start)).Normalize();
            var tangentStart = (-u * Math.Sin(start) + v * Math.Cos(start)).Normalize();
            var profileCenter = center + radialStart * radius;

            // Ensure right-handed basis (radialStart, bitangent, tangentStart) so the profile
            // loop is strictly counter-clockwise relative to the path tangent at parameter 0.
            var bitangent = tangentStart.CrossProduct(radialStart).Normalize();
            CurveLoop loop;
            if (solid.TubeRadius >= 1.0)
            {
                var profilePlane = Plane.CreateByOriginAndBasis(profileCenter, radialStart, bitangent);
                loop = new CurveLoop();
                loop.Append(Arc.Create(profilePlane, tube, 0, Math.PI));
                loop.Append(Arc.Create(profilePlane, tube, Math.PI, 2 * Math.PI));
            }
            else
            {
                var segments = SegmentsFor(solid.TubeRadius, solid.Segments);
                var points = new List<XYZ>(segments);
                for (var i = 0; i < segments; i += 1)
                {
                    var t = 2 * Math.PI * i / segments;
                    points.Add(
                        profileCenter
                        + radialStart * (Math.Cos(t) * tube)
                        + bitangent * (Math.Sin(t) * tube));
                }
                loop = Loop(points);
            }

            Curve pathCurve;
            if (Math.Abs(solid.Angle) >= 359.9)
            {
                var arcPlane = Plane.CreateByOriginAndBasis(center, u, v);
                pathCurve = Arc.Create(arcPlane, radius, 0, 2 * Math.PI);
            }
            else
            {
                pathCurve = Arc.Create(PointOnArc(start), PointOnArc(end), PointOnArc(mid));
            }

            var pathLoop = new CurveLoop();
            pathLoop.Append(pathCurve);

            var sweptSolid = GeometryCreationUtilities.CreateSweptGeometry(
                pathLoop,
                0,
                pathCurve.GetEndParameter(0),
                new List<CurveLoop> { loop });

            return FreeFormElement.Create(document, sweptSolid);
        }

        private static Extrusion CreatePrismForm(Document document, ResolvedSolid solid, Vec3d offset, bool isSolid)
        {
            var rawDepthMm = Math.Abs(solid.To - solid.From);
            if (rawDepthMm <= 1e-9) throw new InvalidOperationException("prism has a zero depth");

            // Revit requires extrusion depth to be at least ShortCurveTolerance (~0.85 mm = 1/360 ft).
            // For decorative face graphics (like gauge scale markings with 0.7 mm depth), clamp to 0.9 mm
            // to satisfy Revit's tolerance without affecting visual fidelity.
            var depthMm = Math.Max(0.9, rawDepthMm);
            var length = Ft(depthMm);

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

            XYZ Project(Vec2d point)
            {
                var a = Ft(point.A);
                var b = Ft(point.B);

                switch (solid.Plane)
                {
                    case "xz":
                        return origin + u * (a + Ft(offset.X)) + v * (b + Ft(offset.Z));
                    case "yz":
                        return origin + u * (a + Ft(offset.Y)) + v * (b + Ft(offset.Z));
                    default:
                        return origin + u * (a + Ft(offset.X)) + v * (b + Ft(offset.Y));
                }
            }

            var points = new List<XYZ>();
            foreach (var point in solid.Points) points.Add(Project(point));

            if (points.Count < 3) throw new InvalidOperationException("prism needs at least 3 points");

            var holes = new List<IList<XYZ>>();
            foreach (var hole in solid.Holes)
            {
                if (hole == null || hole.Count < 3) continue;
                var loop = new List<XYZ>();
                foreach (var point in hole) loop.Add(Project(point));
                holes.Add(loop);
            }

            var normal = u.CrossProduct(v);
            var desired = axisUnit * Math.Sign(solid.To - solid.From);
            var end = desired.DotProduct(normal) > 0 ? length : -length;

            return Extrude(document, Plane.CreateByOriginAndBasis(origin, u, v), points, holes, end, isSolid);
        }

        private static SweepProfile CreateLoftProfile(Document document, IList<Vec2d> points)
        {
            var loops = new CurveArrArray();
            var loop = new CurveArray();
            for (var index = 0; index < points.Count; index += 1)
            {
                var start = points[index];
                var end = points[(index + 1) % points.Count];
                loop.Append(Line.CreateBound(
                    new XYZ(Ft(start.A), Ft(start.B), 0),
                    new XYZ(Ft(end.A), Ft(end.B), 0)));
            }
            loops.Append(loop);
            return document.Application.Create.NewCurveLoopsProfile(loops);
        }

        private static Element CreateLoftForm(
            Document document,
            ResolvedSolid solid,
            Vec3d offset,
            bool isSolid)
        {
            if (solid.Sections == null || solid.Sections.Count < 2)
                throw new InvalidOperationException("loft needs at least two profiles");

            // A family SweptBlend takes exactly two profiles. For longer lofts the studio
            // preview keeps every section; the .rfa keeps the two end sections and the
            // validator reports that the middle ones were skipped.
            var first = solid.Sections[0];
            var last = solid.Sections[solid.Sections.Count - 1];
            var bottom = CreateLoftProfile(document, first.Points);
            var top = CreateLoftProfile(document, last.Points);

            XYZ PathPoint(double at)
            {
                switch (solid.Axis)
                {
                    case "x":
                        return new XYZ(Ft(at + offset.X), Ft(offset.Y), Ft(offset.Z));
                    case "y":
                        return new XYZ(Ft(offset.X), Ft(at + offset.Y), Ft(offset.Z));
                    default:
                        return new XYZ(Ft(offset.X), Ft(offset.Y), Ft(at + offset.Z));
                }
            }

            var pathStart = PathPoint(first.At);
            var pathEnd = PathPoint(last.At);
            var path = Line.CreateBound(pathStart, pathEnd);

            var along = solid.Axis == "x" ? XYZ.BasisX : solid.Axis == "y" ? XYZ.BasisY : XYZ.BasisZ;
            var across = solid.Axis == "z" ? XYZ.BasisX : solid.Axis == "x" ? XYZ.BasisY : XYZ.BasisX;
            var pathPlane = SketchPlane.Create(
                document,
                Plane.CreateByOriginAndBasis(pathStart, along, across));

            return document.FamilyCreate.NewSweptBlend(isSolid, path, pathPlane, bottom, top);
        }

        private static int CreateConnectors(
            Document document,
            FamilySpec spec,
            CoreParameterSet parameters,
            IList<Element> forms,
            List<string> warnings)
        {
            if (spec.Connectors == null || spec.Connectors.Count == 0) return 0;

            double Value(Num? value, double fallback)
            {
                if (value == null) return fallback;
                var number = value.Value;
                if (!number.IsExpression) return number.Value;
                try { return Expression.Evaluate(number.Expression, parameters.Lookup); }
                catch { return fallback; }
            }

            var created = 0;
            using (var transaction = SilentTransaction(
                       document, "Family Agent — MEP connectors", new FailureCollector()))
            {
                transaction.Start();

                var createdElements = new List<ConnectorElement>();

                foreach (var connector in spec.Connectors)
                {
                    try
                    {
                        var origin = new XYZ(
                            Ft(Value(connector.Origin.X, 0)),
                            Ft(Value(connector.Origin.Y, 0)),
                            Ft(Value(connector.Origin.Z, 0)));
                        var direction = new XYZ(
                            Value(connector.DirectionVector.X, 0),
                            Value(connector.DirectionVector.Y, 0),
                            Value(connector.DirectionVector.Z, -1));
                        if (direction.GetLength() < 1e-9) direction = new XYZ(0, 0, -1);
                        direction = direction.Normalize();

                        Element host;
                        string diagnosis;
                        var face = FindConnectorFace(forms, origin, direction, out host, out diagnosis);
                        if (face == null)
                        {
                            warnings.Add(
                                $"Connector \"{connector.Id ?? connector.Name}\" found no face at its origin ({diagnosis})");
                            continue;
                        }

                        var shape = string.Equals(
                            connector.Shape, "rectangular", StringComparison.OrdinalIgnoreCase)
                            ? ConnectorProfileType.Rectangular
                            : ConnectorProfileType.Round;

                        var element = CreateConnectorElement(
                            document, connector.SystemType, shape, face.Reference);
                        if (element == null)
                        {
                            warnings.Add($"Connector \"{connector.Id ?? connector.Name}\" was rejected by Revit");
                            continue;
                        }

                        // Associate connector dimensions and MEP properties to Family Parameters
                        ConfigureConnectorParameters(document, element, connector, parameters);

                        createdElements.Add(element);
                        created += 1;
                    }
                    catch (Exception ex)
                    {
                        warnings.Add($"Connector \"{connector.Id ?? connector.Name}\" failed: {ex.Message}");
                    }
                }

                // Primary Connector & Link Connectors (e.g. for Valves, Strainers, inline MEP fittings)
                if (createdElements.Count > 0)
                {
                    try
                    {
                        // Designate primary connector
                        var primary = createdElements.FirstOrDefault(c =>
                            Regex.IsMatch(c.Name ?? "", @"(inlet|supply|in|primary)", RegexOptions.IgnoreCase))
                            ?? createdElements[0];
                        if (primary != null && !primary.IsPrimary)
                        {
                            primary.AssignAsPrimary();
                        }

                        // Link two-way connectors (e.g. 2 pipe/duct connectors on inline components)
                        if (createdElements.Count == 2)
                        {
                            var cA = createdElements[0];
                            var cB = createdElements[1];
                            if (cA.Domain == cB.Domain && cA.GetLinkedConnectorElement() == null)
                            {
                                cA.SetLinkedConnectorElement(cB);
                            }
                        }
                    }
                    catch (Exception ex)
                    {
                        warnings.Add($"Linking connectors notice: {ex.Message}");
                    }
                }

                var status = transaction.Commit();
                if (status != TransactionStatus.Committed)
                {
                    warnings.Add($"MEP connectors were rolled back ({status})");
                    return 0;
                }
            }

            return created;
        }

        private static PlanarFace FindConnectorFace(
            IList<Element> forms,
            XYZ origin,
            XYZ direction,
            out Element host,
            out string diagnosis)
        {
            host = null;
            PlanarFace best = null;
            var bestDist = double.PositiveInfinity;
            var bestAlong = double.NegativeInfinity;
            var maxDistance = 300.0 / MmPerFoot;
            var faces = 0;
            var noReference = 0;
            var alignedCount = 0;
            var inRange = 0;

            foreach (var form in forms)
            {
                var solid = SolidOf(form);
                if (solid == null) continue;

                foreach (Face candidate in solid.Faces)
                {
                    faces += 1;
                    var face = candidate as PlanarFace;
                    if (face == null) continue;
                    if (face.Reference == null)
                    {
                        noReference += 1;
                        continue;
                    }

                    var normal = face.FaceNormal;
                    if (normal.GetLength() < 1e-9) continue;
                    normal = normal.Normalize();

                    // Connector direction must be parallel/aligned with face normal
                    var alignment = Math.Abs(normal.DotProduct(direction));
                    if (alignment < 0.95) continue;
                    alignedCount += 1;

                    // Signed distance from face origin to connector origin along direction
                    var along = face.Origin.Subtract(origin).DotProduct(direction);
                    if (along < -1.0 / MmPerFoot || along > maxDistance) continue;
                    inRange += 1;

                    // Distance from connector origin to the face plane
                    var distToPlane = Math.Abs(along);

                    // Prioritize face closest to connector origin (|along| smallest).
                    // If multiple faces are equally close, pick the one pointing in the connector direction.
                    if (distToPlane < bestDist - 1e-5 || (Math.Abs(distToPlane - bestDist) <= 1e-5 && along > bestAlong))
                    {
                        best = face;
                        bestDist = distToPlane;
                        bestAlong = along;
                        host = form;
                    }
                }
            }

            diagnosis =
                $"faces={faces}, noRef={noReference}, aligned={alignedCount}, inRange={inRange}, " +
                $"bestAlong={Math.Round(bestAlong * MmPerFoot, 2)}mm, bestDist={Math.Round(bestDist * MmPerFoot, 2)}mm";
            return best;
        }

        private static string NormalizeSystemType(string value)
        {
            var text = Regex.Replace(
                (value ?? string.Empty).Trim().ToLowerInvariant().Replace("_", " ").Replace("-", " "),
                @"\s+",
                " ");

            switch (text)
            {
                case "supply air": return "supplyair";
                case "return air": return "returnair";
                case "exhaust air": return "exhaustair";
                case "other air": return "otherair";
                case "hydronic supply": return "hydronicsupply";
                case "hydronic return": return "hydronicreturn";
                case "sanitary": return "sanitary";
                case "domestic cold water": return "domesticcoldwater";
                case "domestic hot water": return "domestichotwater";
                case "power unbalanced": return "powerunbalanced";
                case "power balanced": return "powerbalanced";
                case "electrical": return "electrical";
                case "fire protection wet": return "fireprotectwet";
                case "fire protection dry": return "fireprotectdry";
                case "fire protection preaction": return "fireprotectpreaction";
                case "fire protection other": return "fireprotectother";
                default: return text.Replace(" ", string.Empty);
            }
        }

        private static ConnectorElement CreateConnectorElement(
            Document document,
            string systemType,
            ConnectorProfileType shape,
            Reference reference)
        {
            switch (NormalizeSystemType(systemType))
            {
                case "returnair":
                    return ConnectorElement.CreateDuctConnector(
                        document, DuctSystemType.ReturnAir, shape, reference);
                case "exhaustair":
                    return ConnectorElement.CreateDuctConnector(
                        document, DuctSystemType.ExhaustAir, shape, reference);
                case "otherair":
                    return ConnectorElement.CreateDuctConnector(
                        document, DuctSystemType.OtherAir, shape, reference);
                case "hydronicsupply":
                    return ConnectorElement.CreatePipeConnector(
                        document, PipeSystemType.SupplyHydronic, reference);
                case "hydronicreturn":
                    return ConnectorElement.CreatePipeConnector(
                        document, PipeSystemType.ReturnHydronic, reference);
                case "sanitary":
                    return ConnectorElement.CreatePipeConnector(
                        document, PipeSystemType.Sanitary, reference);
                case "domesticcoldwater":
                    return ConnectorElement.CreatePipeConnector(
                        document, PipeSystemType.DomesticColdWater, reference);
                case "domestichotwater":
                    return ConnectorElement.CreatePipeConnector(
                        document, PipeSystemType.DomesticHotWater, reference);
                case "fireprotectwet":
                    return ConnectorElement.CreatePipeConnector(
                        document, PipeSystemType.FireProtectWet, reference);
                case "fireprotectdry":
                    return ConnectorElement.CreatePipeConnector(
                        document, PipeSystemType.FireProtectDry, reference);
                case "fireprotectpreaction":
                    return ConnectorElement.CreatePipeConnector(
                        document, PipeSystemType.FireProtectPreaction, reference);
                case "fireprotectother":
                    return ConnectorElement.CreatePipeConnector(
                        document, PipeSystemType.FireProtectOther, reference);
                case "powerunbalanced":
                    return ConnectorElement.CreateElectricalConnector(
                        document, ElectricalSystemType.PowerUnBalanced, reference);
                case "powerbalanced":
                    return ConnectorElement.CreateElectricalConnector(
                        document, ElectricalSystemType.PowerBalanced, reference);
                case "electrical":
                    return ConnectorElement.CreateElectricalConnector(
                        document, ElectricalSystemType.PowerCircuit, reference);
                default:
                    return ConnectorElement.CreateDuctConnector(
                        document, DuctSystemType.SupplyAir, shape, reference);
            }
        }

        private static void ConfigureConnectorParameters(
            Document document,
            ConnectorElement element,
            MepConnector connector,
            CoreParameterSet parameters)
        {
            if (element == null || connector == null) return;
            var manager = document.FamilyManager;

            void TryAssociateOrSet(BuiltInParameter bip, Num? num, double fallbackVal, bool isRadius = false)
            {
                var p = element.get_Parameter(bip);
                if (p == null || p.IsReadOnly) return;

                if (num.HasValue)
                {
                    var n = num.Value;
                    if (n.IsExpression)
                    {
                        var expr = n.Expression.Trim();
                        // If expression directly references a parameter like "[Nominal Diameter]" or "[Duct Width]"
                        var matchName = expr.Trim('[', ']');
                        var famParam = FindParameter(manager, matchName);
                        if (famParam != null)
                        {
                            try
                            {
                                manager.AssociateElementParameterToFamilyParameter(p, famParam);
                                return;
                            }
                            catch { }
                        }

                        try
                        {
                            var evaluated = Expression.Evaluate(expr, parameters.Lookup);
                            var ft = Ft(isRadius ? evaluated / 2.0 : evaluated);
                            p.Set(ft);
                            return;
                        }
                        catch { }
                    }
                    else if (n.Value > 0)
                    {
                        var ft = Ft(isRadius ? n.Value / 2.0 : n.Value);
                        p.Set(ft);
                        return;
                    }
                }

                if (fallbackVal > 0)
                {
                    try { p.Set(Ft(isRadius ? fallbackVal / 2.0 : fallbackVal)); } catch { }
                }
            }

            if (element.Shape == ConnectorProfileType.Round)
            {
                // Pipe or round duct radius
                TryAssociateOrSet(BuiltInParameter.CONNECTOR_RADIUS, connector.Diameter, 50, isRadius: true);
            }
            else if (element.Shape == ConnectorProfileType.Rectangular)
            {
                TryAssociateOrSet(BuiltInParameter.CONNECTOR_WIDTH, connector.Width, 200);
                TryAssociateOrSet(BuiltInParameter.CONNECTOR_HEIGHT, connector.Height, 200);
            }

            // Associate Flow and Pressure Drop if present
            if (connector.Flow.HasValue)
            {
                TryAssociateOrSet(BuiltInParameter.RBS_PIPE_FLOW_PARAM, connector.Flow, 0);
                TryAssociateOrSet(BuiltInParameter.RBS_DUCT_FLOW_PARAM, connector.Flow, 0);
            }

            if (connector.PressureDrop.HasValue)
            {
                TryAssociateOrSet(BuiltInParameter.RBS_PIPE_PRESSUREDROP_PARAM, connector.PressureDrop, 0);
                TryAssociateOrSet(BuiltInParameter.RBS_DUCT_PRESSURE_DROP, connector.PressureDrop, 0);
                TryAssociateOrSet(BuiltInParameter.RBS_PRESSURE_DROP, connector.PressureDrop, 0);
            }

            // Configure Flow Direction based on connector direction or name
            try
            {
                var directionStr = (connector.Direction ?? "").Trim().ToLowerInvariant();
                var nameStr = (connector.Name ?? connector.Id ?? "").Trim().ToLowerInvariant();

                // 1 = In, 2 = Out, 0 = Bidirectional
                var flowDirVal = 0;
                if (directionStr == "in" || Regex.IsMatch(nameStr, @"(inlet|supply|in|return_in|primary)"))
                {
                    flowDirVal = 1; // In
                }
                else if (directionStr == "out" || Regex.IsMatch(nameStr, @"(outlet|exhaust|out|return_out|secondary)"))
                {
                    flowDirVal = 2; // Out
                }

                // Check pipe flow direction parameter
                var pPipeDir = element.get_Parameter(BuiltInParameter.RBS_PIPE_FLOW_DIRECTION_PARAM);
                if (pPipeDir != null && !pPipeDir.IsReadOnly)
                {
                    pPipeDir.Set(flowDirVal);
                }

                // Check duct flow direction parameter
                var pDuctDir = element.get_Parameter(BuiltInParameter.RBS_DUCT_FLOW_DIRECTION_PARAM);
                if (pDuctDir != null && !pDuctDir.IsReadOnly)
                {
                    pDuctDir.Set(flowDirVal);
                }
            }
            catch { }
        }

        private static void ApplyVisibilitySettings(Document document, Element body, ResolvedPart part)
        {
            if (body is GenericForm form)
            {
                try
                {
                    var isClearance = Regex.IsMatch(
                        (part.Id ?? "") + " " + (part.Name ?? ""),
                        @"(clearance|maintenance|access[_\s-]?zone|service[_\s-]?area|pull[_\s-]?space)",
                        RegexOptions.IgnoreCase);

                    // If clearance, assign Clearance subcategory with custom dashed style & coarse hidden
                    if (isClearance)
                    {
                        try
                        {
                            var familyCat = document.OwnerFamily?.FamilyCategory;
                            if (familyCat != null && familyCat.CanAddSubcategory)
                            {
                                Category clearanceSubcat = null;
                                if (familyCat.SubCategories.Contains("Clearance"))
                                {
                                    clearanceSubcat = familyCat.SubCategories.get_Item("Clearance");
                                }
                                else
                                {
                                    clearanceSubcat = document.Settings.Categories.NewSubcategory(familyCat, "Clearance");
                                    clearanceSubcat.LineColor = new Color(255, 128, 0); // Orange indicator
                                    var dashedPattern = LinePatternElement.GetLinePatternElementByName(document, "Hidden")
                                        ?? LinePatternElement.GetLinePatternElementByName(document, "Dashed");
                                    if (dashedPattern != null)
                                    {
                                        clearanceSubcat.SetLinePatternId(dashedPattern.Id, GraphicsStyleType.Projection);
                                    }
                                }

                                if (clearanceSubcat != null)
                                {
                                    form.Subcategory = clearanceSubcat;
                                }
                            }
                        }
                        catch { }
                    }

                    // Small fasteners, bolts, labels or trim are set to Medium/Fine to keep Coarse views clean
                    // Clearance is also hidden in Coarse views by default for clean 2D documentation
                    var isSmallDetail = Regex.IsMatch(
                        part.Name ?? "",
                        @"(bolt|nut|screw|washer|pin|label|tag|indicator|hole)",
                        RegexOptions.IgnoreCase);

                    var vis = new FamilyElementVisibility(FamilyElementVisibilityType.Model)
                    {
                        IsShownInCoarse = !isSmallDetail && !isClearance,
                        IsShownInMedium = true,
                        IsShownInFine = true,
                        IsShownInFrontBack = true,
                        IsShownInLeftRight = true,
                        IsShownInPlanRCPCut = true
                    };
                    form.SetVisibility(vis);
                }
                catch
                {
                    // Some generic forms may not accept visibility overrides.
                }
            }
        }

        private static CurveLoop Loop(IList<XYZ> points)
        {
            const double minEdgeFt = 0.85 / MmPerFoot;
            var filtered = new List<XYZ>(points.Count);
            foreach (var pt in points)
            {
                if (filtered.Count == 0 || pt.DistanceTo(filtered[filtered.Count - 1]) >= minEdgeFt)
                {
                    filtered.Add(pt);
                }
            }
            if (filtered.Count > 3 && filtered[filtered.Count - 1].DistanceTo(filtered[0]) < minEdgeFt)
            {
                filtered.RemoveAt(filtered.Count - 1);
            }
            if (filtered.Count < 3) filtered = new List<XYZ>(points);

            var loop = new CurveLoop();
            for (var i = 0; i < filtered.Count; i += 1)
            {
                loop.Append(Line.CreateBound(filtered[i], filtered[(i + 1) % filtered.Count]));
            }
            return loop;
        }

    }
}
