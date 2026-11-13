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
            IDictionary<long, ResolvedPart> partByForm,
            List<string> failedParts)
        {
            var forms = new List<Element>();
            var materialCache = new Dictionary<string, Material>(StringComparer.OrdinalIgnoreCase);

            void AddBody(Element body, ResolvedPart part, string name, string failureLabel)
            {
                if (body == null)
                {
                    warnings.Add($"Part \"{failureLabel}\" produced no solid");
                    failedParts?.Add($"{failureLabel}: produced no solid");
                    return;
                }

                try
                {
                    body.Name = name;
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

            foreach (var part in model.Parts)
            {
                for (var index = 0; index < Math.Max(1, part.ArrayCount); index += 1)
                {
                    var label = part.ArrayCount > 1 ? $"{part.Id}[{index + 1}]" : part.Id;
                    try
                    {
                        var offset = ArrayOffsetMm(part, index);
                        var hasInnerRadius = part.Solid.Kind == "cylinder" && part.Solid.InnerRadius > 0;
                        var hasCuts = part.Cuts.Count > 0;
                        var displayName = part.ArrayCount > 1 ? $"{part.Name} {index + 1}" : part.Name;

                        if (TrySplitPrismByThroughCuts(part, out var splitPieces))
                        {
                            // The studio preview shows the pieces left by a through-cut;
                            // build each piece as its own native prism instead of dropping
                            // the notch and keeping one uncut body.
                            var createdPieces = 0;
                            for (var pieceIndex = 0; pieceIndex < splitPieces.Count; pieceIndex += 1)
                            {
                                var pieceName = part.ArrayCount > 1
                                    ? $"{part.Name} {index + 1}.{pieceIndex + 1}"
                                    : $"{part.Name} {pieceIndex + 1}";
                                var pieceLabel = $"{label}.{pieceIndex + 1}";
                                try
                                {
                                    var pieceBody = CreateNativeMultiHolePrismForm(
                                        document,
                                        part,
                                        offset,
                                        true,
                                        splitPieces[pieceIndex],
                                        new List<List<Vec2d>>());
                                    if (pieceBody != null) createdPieces += 1;
                                    AddBody(pieceBody, part, pieceName, pieceLabel);
                                }
                                catch (Exception ex)
                                {
                                    warnings.Add($"Part \"{pieceLabel}\" failed: {ex.Message}");
                                    failedParts?.Add($"{pieceLabel}: {ex.Message}");
                                }
                            }

                            if (createdPieces > 0) continue;
                            // Fall through to the normal single-body path so a bad split
                            // still leaves the part visible instead of losing it.
                        }

                        Element body;
                        if (CanCreateNativePrismExtrusion(
                                part, out var prismOuter, out var prismHoles, warnings))
                        {
                            // A prism whose cuts are holes perpendicular to the extrusion is
                            // one native Extrusion with inner loops, not a fragile boolean.
                            try
                            {
                                body = CreateNativeMultiHolePrismForm(
                                    document, part, offset, true, prismOuter, prismHoles);
                            }
                            catch
                            {
                                body = CreateBooleanBody(document, part, offset, warnings);
                            }
                        }
                        else if (CanCreateNativeFlangeExtrusion(part))
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
                            // Native host + void cutters keeps the form an Extrusion, which is
                            // the only shape whose faces can be locked to reference planes.
                            // Voids cut every form they touch, so only use them when the cut
                            // stays inside this part; the boolean covers the rest.
                            body = TryCreateVoidCutBody(document, part, offset, warnings) ??
                                   CreateBooleanBody(document, part, offset, warnings);
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

                        AddBody(body, part, displayName, label);
                    }
                    catch (Exception ex)
                    {
                        warnings.Add($"Part \"{label}\" failed: {ex.Message}");
                        failedParts?.Add($"{label}: {ex.Message}");
                    }
                }
            }

            return forms;
        }

        /// <summary>
        /// Joining overlapping forms of the same material removes the internal faces that
        /// separate cast parts would otherwise expose in sections and hidden-line views.
        /// Different materials are left alone so a brass bolt does not repaint the body.
        /// Set FAMILY_AGENT_JOIN=0 to keep every form separate.
        /// </summary>
        private static readonly bool JoinSameMaterial = !string.Equals(
            Environment.GetEnvironmentVariable("FAMILY_AGENT_JOIN"),
            "0",
            StringComparison.OrdinalIgnoreCase);

        private static int JoinOverlappingForms(
            Document document,
            IList<Element> forms,
            IDictionary<long, ResolvedPart> partByForm,
            IDictionary<string, MaterialDef> materials,
            List<string> warnings)
        {
            if (!JoinSameMaterial || forms == null || forms.Count < 2 || partByForm == null)
                return 0;

            // JoinGeometryUtils only works in project documents; a family document throws
            // "document is not a project document" for every pair. Skip joins there.
            if (document.IsFamilyDocument) return 0;

            var candidates = new List<(Element Form, string Material, BoundingBoxXYZ Box)>();
            foreach (var form in forms)
            {
                if (form == null || form.Id == ElementId.InvalidElementId) continue;
                if (!partByForm.TryGetValue(form.Id.Value, out var part)) continue;
                var material = MaterialName(part, materials) ?? string.Empty;
                if (material.Length == 0) continue;

                BoundingBoxXYZ box = null;
                try { box = form.get_BoundingBox(null); } catch { }
                if (box == null) continue;
                candidates.Add((form, material, box));
            }

            var joins = 0;
            for (var i = 0; i < candidates.Count; i += 1)
            {
                for (var j = i + 1; j < candidates.Count; j += 1)
                {
                    var a = candidates[i];
                    var b = candidates[j];
                    if (!string.Equals(a.Material, b.Material, StringComparison.OrdinalIgnoreCase))
                        continue;
                    if (!BoxesOverlap(a.Box, b.Box)) continue;

                    try
                    {
                        if (JoinGeometryUtils.AreElementsJoined(document, a.Form, b.Form)) continue;
                        JoinGeometryUtils.JoinGeometry(document, a.Form, b.Form);
                        joins += 1;
                    }
                    catch (Exception ex)
                    {
                        if (warnings.Count < 40) warnings.Add($"Join \"{a.Material}\": {ex.Message}");
                    }
                }
            }

            return joins;
        }

        private static bool BoxesOverlap(BoundingBoxXYZ a, BoundingBoxXYZ b)
        {
            // A small overlap tolerance catches touching cast faces, not distant parts.
            var tolerance = 0.5 / MmPerFoot;
            return a.Min.X <= b.Max.X + tolerance &&
                   a.Max.X >= b.Min.X - tolerance &&
                   a.Min.Y <= b.Max.Y + tolerance &&
                   a.Max.Y >= b.Min.Y - tolerance &&
                   a.Min.Z <= b.Max.Z + tolerance &&
                   a.Max.Z >= b.Min.Z - tolerance;
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
        /// Builds a plate as a native extrusion and punches its cuts with void extrusions
        /// instead of a boolean. Only an Extrusion can have its faces locked to reference
        /// planes, so this is what keeps webs, rungs and incline segments parametric instead
        /// of turning them into FreeFormElements. Voids cut every form they touch, so the
        /// build falls back to the boolean when a cut reaches outside its own part.
        /// </summary>
        private static Element TryCreateVoidCutBody(
            Document document,
            ResolvedPart part,
            Vec3d offset,
            List<string> warnings)
        {
            if (part.Solid.Kind != "prism" && part.Solid.Kind != "box") return null;
            if (part.Cuts.Count == 0) return null;
            if (!CutsStayInside(part)) return null;

            Element body;
            try
            {
                body = CreateForm(document, part.Solid, offset, true);
            }
            catch (Exception ex)
            {
                warnings.Add($"Void host for \"{part.Id}\" failed: {ex.Message}");
                return null;
            }

            if (body == null) return null;

            var voids = 0;
            foreach (var cut in part.Cuts)
            {
                try
                {
                    if (CreateForm(document, cut, offset, false) != null) voids += 1;
                }
                catch (Exception ex)
                {
                    warnings.Add($"Void cut on \"{part.Id}\" failed: {ex.Message}");
                }
            }

            if (voids == 0)
            {
                TryDelete(document, body);
                return null;
            }

            if (voids < part.Cuts.Count)
            {
                warnings.Add(
                    $"Part \"{part.Id}\": {part.Cuts.Count - voids} void cut(s) could not be created.");
            }

            return body;
        }

        /// <summary>
        /// True when a cut can only punch its own part: it must stay inside on the two
        /// in-plane axes and may only poke through the third (the plate normal). The through
        /// axis is the shortest one, which is how a bolt hole "thickness + 2 mm" cutter is
        /// recognised as a hole rather than a notch.
        /// </summary>
        private static bool CutsStayInside(ResolvedPart part)
        {
            const double insideTolerance = 0.3;
            const double throughOvershoot = 3.0;

            Bounds3 host;
            try
            {
                host = GeometryResolver.BoundsOf(part.Solid);
            }
            catch
            {
                return false;
            }

            if (!host.IsValid) return false;

            var hostMin = new[] { host.MinX, host.MinY, host.MinZ };
            var hostMax = new[] { host.MaxX, host.MaxY, host.MaxZ };

            foreach (var cut in part.Cuts)
            {
                Bounds3 box;
                try
                {
                    box = GeometryResolver.BoundsOf(cut);
                }
                catch
                {
                    return false;
                }

                if (!box.IsValid) return false;

                var min = new[] { box.MinX, box.MinY, box.MinZ };
                var max = new[] { box.MaxX, box.MaxY, box.MaxZ };

                var through = 0;
                for (var axis = 1; axis < 3; axis += 1)
                {
                    if (max[axis] - min[axis] < max[through] - min[through]) through = axis;
                }

                for (var axis = 0; axis < 3; axis += 1)
                {
                    var overshoot = axis == through ? throughOvershoot : insideTolerance;
                    if (min[axis] < hostMin[axis] - overshoot) return false;
                    if (max[axis] > hostMax[axis] + overshoot) return false;
                }
            }

            return true;
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

            var appliedCuts = 0;
            var cutsFailed = false;

            foreach (var cut in part.Cuts)
            {
                Element cutter = null;
                try
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

                    cutter = CreateForm(document, extendedCut, offset, true);
                    if (cutter == null)
                    {
                        cutsFailed = true;
                        warnings.Add($"Cutter for \"{part.Id}\" produced no solid");
                        continue;
                    }

                    var cutterSolid = SolidOf(cutter);
                    if (cutterSolid == null)
                    {
                        cutsFailed = true;
                        warnings.Add($"Cutter for \"{part.Id}\" has no solid");
                        continue;
                    }

                    var result = BooleanOperationsUtils.ExecuteBooleanOperation(
                        solid, cutterSolid, BooleanOperationsType.Difference);

                    if (result == null || result.Volume <= 1e-9)
                    {
                        cutsFailed = true;
                        warnings.Add($"Cut on \"{part.Id}\" removed the whole part; kept the previous solid");
                        continue;
                    }

                    solid = result;
                    appliedCuts += 1;
                }
                catch (Exception ex)
                {
                    cutsFailed = true;
                    warnings.Add($"Boolean cut on \"{part.Id}\" failed: {ex.Message}");
                }
                finally
                {
                    TryDelete(document, cutter);
                }
            }

            if (part.Solid.Kind == "cylinder" && part.Solid.InnerRadius > 0)
            {
                try
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
                catch (Exception ex)
                {
                    warnings.Add($"Bore on \"{part.Id}\" failed: {ex.Message}");
                }
            }

            // A failed cut must never delete the whole part. Keeping the uncut native body
            // is better than a missing web/flange in the .rfa; the warning names the part.
            if (appliedCuts == 0 && cutsFailed)
            {
                warnings.Add($"Part \"{part.Id}\": cuts failed, kept the uncut native body.");
                return body;
            }

            try
            {
                var freeform = FreeFormElement.Create(document, solid);
                if (freeform == null)
                {
                    warnings.Add(
                        $"Boolean result for \"{part.Id}\" was rejected by Revit; kept the uncut native body.");
                    return body;
                }

                TryDelete(document, body);
                return freeform;
            }
            catch (Exception ex)
            {
                warnings.Add(
                    $"Boolean result for \"{part.Id}\" failed: {ex.Message}; kept the uncut native body.");
                return body;
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
                case "revolve": return CreateRevolutionForm(document, solid, offset, isSolid);
                case "tube": return CreateTubeForm(document, solid, offset, isSolid);
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

        /// <summary>
        /// A prism whose cuts are circular holes perpendicular to its extrusion can be a
        /// single native Extrusion with inner loops. This is what keeps thin cable-ladder
        /// webs/flanges/hem parts alive: the generic boolean path is fragile on 2 mm plates.
        /// </summary>
        private static bool CanCreateNativePrismExtrusion(
            ResolvedPart part,
            out List<Vec2d> outerPoints,
            out List<List<Vec2d>> cutHoles,
            List<string> warnings)
        {
            outerPoints = new List<Vec2d>();
            cutHoles = new List<List<Vec2d>>();
            if (part.Solid.Kind != "prism" || part.Cuts.Count == 0) return false;
            var plane = part.Solid.Plane;
            if (plane != "xy" && plane != "xz" && plane != "yz") return false;
            if (part.Solid.Points == null || part.Solid.Points.Count < 3) return false;

            var points = new List<Vec2d>(part.Solid.Points);
            var normalAxis = plane == "xy" ? "z" : plane == "xz" ? "y" : "x";
            var low = Math.Min(part.Solid.From, part.Solid.To);
            var high = Math.Max(part.Solid.From, part.Solid.To);
            var circles = new List<(double A, double B, double R)>();
            var rectangles = new List<(double AMin, double AMax, double BMin, double BMax)>();
            var bakedNotches = 0;

            void Skip(int index, string reason)
            {
                warnings.Add(
                    $"Prism \"{part.Id}\": cut {index + 1} {reason}; kept the part native and skipped this cut.");
            }

            for (var index = 0; index < part.Cuts.Count; index += 1)
            {
                var cut = part.Cuts[index];
                if (cut.Kind == "cylinder")
                {
                    if (cut.Axis != normalAxis || cut.Radius <= 0)
                    {
                        Skip(index, "is not a perpendicular circular hole");
                        continue;
                    }

                    var normal = PlaneNormalCoord(plane, cut.Base);
                    var normalEnd = normal + cut.Height;
                    var cutLow = Math.Min(normal, normalEnd);
                    var cutHigh = Math.Max(normal, normalEnd);
                    if (cutLow > low + 0.5 || cutHigh < high - 0.5)
                    {
                        Skip(index, "does not pass through the prism thickness");
                        continue;
                    }

                    var a = PlaneA(plane, cut.Base);
                    var b = PlaneB(plane, cut.Base);
                    if (!PointInPolygon(a, b, points))
                    {
                        Skip(index, "is outside the outer profile");
                        continue;
                    }

                    var tooClose = false;
                    for (var edge = 0; edge < points.Count; edge += 1)
                    {
                        var start = points[edge];
                        var end = points[(edge + 1) % points.Count];
                        if (DistanceToSegment(a, b, start, end) < cut.Radius + 0.8)
                        {
                            tooClose = true;
                            break;
                        }
                    }
                    if (tooClose)
                    {
                        Skip(index, "is closer than 0.8 mm to the outer profile");
                        continue;
                    }

                    var overlaps = false;
                    foreach (var other in circles)
                    {
                        var distance = Math.Sqrt(
                            (a - other.A) * (a - other.A) + (b - other.B) * (b - other.B));
                        if (distance < cut.Radius + other.R + 0.8)
                        {
                            overlaps = true;
                            break;
                        }
                    }
                    if (overlaps)
                    {
                        Skip(index, "overlaps another hole");
                        continue;
                    }

                    circles.Add((a, b, cut.Radius));
                    continue;
                }

                if (cut.Kind != "box") return false;
                if (Math.Abs(cut.RotationZ) > 1e-6)
                {
                    Skip(index, "is rotated");
                    continue;
                }

                double normalLow;
                double normalHigh;
                double aMin;
                double aMax;
                double bMin;
                double bMax;
                switch (plane)
                {
                    case "xy":
                        normalLow = cut.Origin.Z;
                        normalHigh = cut.Origin.Z + cut.Size.Z;
                        aMin = cut.Origin.X - Math.Abs(cut.Size.X) / 2;
                        aMax = cut.Origin.X + Math.Abs(cut.Size.X) / 2;
                        bMin = cut.Origin.Y - Math.Abs(cut.Size.Y) / 2;
                        bMax = cut.Origin.Y + Math.Abs(cut.Size.Y) / 2;
                        break;
                    case "xz":
                        normalLow = cut.Origin.Y - Math.Abs(cut.Size.Y) / 2;
                        normalHigh = cut.Origin.Y + Math.Abs(cut.Size.Y) / 2;
                        aMin = cut.Origin.X - Math.Abs(cut.Size.X) / 2;
                        aMax = cut.Origin.X + Math.Abs(cut.Size.X) / 2;
                        bMin = cut.Origin.Z;
                        bMax = cut.Origin.Z + cut.Size.Z;
                        break;
                    default:
                        normalLow = cut.Origin.X - Math.Abs(cut.Size.X) / 2;
                        normalHigh = cut.Origin.X + Math.Abs(cut.Size.X) / 2;
                        aMin = cut.Origin.Y - Math.Abs(cut.Size.Y) / 2;
                        aMax = cut.Origin.Y + Math.Abs(cut.Size.Y) / 2;
                        bMin = cut.Origin.Z;
                        bMax = cut.Origin.Z + cut.Size.Z;
                        break;
                }

                if (Math.Min(normalLow, normalHigh) > low + 0.5 ||
                    Math.Max(normalLow, normalHigh) < high - 0.5)
                {
                    Skip(index, "does not pass through the prism thickness");
                    continue;
                }

                if (bMax < bMin)
                {
                    (bMin, bMax) = (bMax, bMin);
                }

                var corners = new[]
                {
                    new Vec2d(aMin, bMin),
                    new Vec2d(aMax, bMin),
                    new Vec2d(aMax, bMax),
                    new Vec2d(aMin, bMax),
                };

                var inside = PointInPolygon(corners[0].A, corners[0].B, points) &&
                             PointInPolygon(corners[1].A, corners[1].B, points) &&
                             PointInPolygon(corners[2].A, corners[2].B, points) &&
                             PointInPolygon(corners[3].A, corners[3].B, points);

                var crosses = false;
                if (inside)
                {
                    for (var edge = 0; edge < points.Count && !crosses; edge += 1)
                    {
                        var start = points[edge];
                        var end = points[(edge + 1) % points.Count];
                        for (var corner = 0; corner < 4; corner += 1)
                        {
                            if (DistanceToSegment(
                                    corners[corner].A,
                                    corners[corner].B,
                                    start,
                                    end) < 0.2)
                            {
                                crosses = true;
                                break;
                            }
                            if (SegmentsIntersect(
                                    corners[corner],
                                    corners[(corner + 1) % 4],
                                    start,
                                    end))
                            {
                                crosses = true;
                                break;
                            }
                        }
                    }
                }

                if (!inside || crosses)
                {
                    // A notch that crosses the outer boundary cannot be an inner loop.
                    // Bake it into the outer polygon so the part stays one native Extrusion.
                    if (TryBakeNotch(points, aMin, aMax, bMin, bMax, out var baked))
                    {
                        points = baked;
                        bakedNotches += 1;
                        continue;
                    }

                    Skip(index, "crosses the outer profile and could not be baked into the prism");
                    continue;
                }

                var overlapsRectangle = false;
                foreach (var other in rectangles)
                {
                    if (aMin < other.AMax - 0.8 && aMax > other.AMin + 0.8 &&
                        bMin < other.BMax - 0.8 && bMax > other.BMin + 0.8)
                    {
                        overlapsRectangle = true;
                        break;
                    }
                }
                if (overlapsRectangle)
                {
                    Skip(index, "overlaps another hole");
                    continue;
                }

                rectangles.Add((aMin, aMax, bMin, bMax));
            }

            foreach (var circle in circles)
            {
                var segments = 32;
                var loop = new List<Vec2d>();
                for (var index = segments - 1; index >= 0; index -= 1)
                {
                    var angle = 2 * Math.PI * index / segments;
                    loop.Add(new Vec2d(
                        circle.A + circle.R * Math.Cos(angle),
                        circle.B + circle.R * Math.Sin(angle)));
                }
                cutHoles.Add(loop);
            }

            foreach (var rectangle in rectangles)
            {
                cutHoles.Add(new List<Vec2d>
                {
                    new Vec2d(rectangle.AMin, rectangle.BMin),
                    new Vec2d(rectangle.AMin, rectangle.BMax),
                    new Vec2d(rectangle.AMax, rectangle.BMax),
                    new Vec2d(rectangle.AMax, rectangle.BMin),
                });
            }

            outerPoints = points;
            return cutHoles.Count > 0 || bakedNotches > 0;
        }

        private static bool TryBakeNotch(
            IList<Vec2d> polygon,
            double aMin,
            double aMax,
            double bMin,
            double bMax,
            out List<Vec2d> result)
        {
            result = null;
            if (polygon == null || polygon.Count < 3) return false;

            var corners = new[]
            {
                new Vec2d(aMin, bMin),
                new Vec2d(aMax, bMin),
                new Vec2d(aMax, bMax),
                new Vec2d(aMin, bMax),
            };

            var inside = new List<Vec2d>();
            foreach (var corner in corners)
            {
                if (PointInPolygon(corner.A, corner.B, polygon)) inside.Add(corner);
            }
            if (inside.Count != 2) return false;

            var hits = new List<(int Edge, double T, Vec2d Point)>();
            for (var edge = 0; edge < polygon.Count; edge += 1)
            {
                var p0 = polygon[edge];
                var p1 = polygon[(edge + 1) % polygon.Count];
                for (var side = 0; side < 4; side += 1)
                {
                    if (!TrySegmentIntersection(
                            p0, p1, corners[side], corners[(side + 1) % 4],
                            out var t, out _, out var point))
                    {
                        continue;
                    }

                    if (t <= 1e-7 || t >= 1 - 1e-7) continue;

                    var duplicate = false;
                    foreach (var hit in hits)
                    {
                        if (hit.Edge == edge && Math.Abs(hit.T - t) < 1e-6)
                        {
                            duplicate = true;
                            break;
                        }
                    }
                    if (!duplicate) hits.Add((edge, t, point));
                }
            }

            if (hits.Count != 2 || hits[0].Edge != hits[1].Edge) return false;

            var edgeIndex = hits[0].Edge;
            var first = hits[0].T <= hits[1].T ? hits[0] : hits[1];
            var second = hits[0].T <= hits[1].T ? hits[1] : hits[0];
            var startPoint = polygon[edgeIndex];
            var endPoint = polygon[(edgeIndex + 1) % polygon.Count];
            var dx = endPoint.A - startPoint.A;
            var dy = endPoint.B - startPoint.B;

            var ordered = inside
                .OrderBy(corner => (corner.A - startPoint.A) * dx + (corner.B - startPoint.B) * dy)
                .ToList();
            if (ordered.Count != 2) return false;

            var orders = new[]
            {
                ordered,
                new List<Vec2d> { ordered[1], ordered[0] },
            };

            foreach (var order in orders)
            {
                var candidate = new List<Vec2d>(polygon.Count + 4);
                for (var index = 0; index < polygon.Count; index += 1)
                {
                    candidate.Add(polygon[index]);
                    if (index == edgeIndex)
                    {
                        candidate.Add(first.Point);
                        candidate.Add(order[0]);
                        candidate.Add(order[1]);
                        candidate.Add(second.Point);
                    }
                }

                if (IsSimplePolygon(candidate))
                {
                    result = candidate;
                    return true;
                }
            }

            return false;
        }

        private static bool TrySegmentIntersection(
            Vec2d p0,
            Vec2d p1,
            Vec2d q0,
            Vec2d q1,
            out double t,
            out double u,
            out Vec2d point)
        {
            t = 0;
            u = 0;
            point = default;
            var rx = p1.A - p0.A;
            var ry = p1.B - p0.B;
            var sx = q1.A - q0.A;
            var sy = q1.B - q0.B;
            var denominator = rx * sy - ry * sx;
            if (Math.Abs(denominator) < 1e-9) return false;

            var qpx = q0.A - p0.A;
            var qpy = q0.B - p0.B;
            t = (qpx * sy - qpy * sx) / denominator;
            u = (qpx * ry - qpy * rx) / denominator;
            if (t < -1e-7 || t > 1 + 1e-7 || u < -1e-7 || u > 1 + 1e-7) return false;

            point = new Vec2d(p0.A + rx * t, p0.B + ry * t);
            return true;
        }

        private static bool IsSimplePolygon(IList<Vec2d> polygon)
        {
            if (polygon == null || polygon.Count < 3) return false;

            for (var index = 0; index < polygon.Count; index += 1)
            {
                var a = polygon[index];
                var b = polygon[(index + 1) % polygon.Count];
                if (Math.Abs(a.A - b.A) < 1e-6 && Math.Abs(a.B - b.B) < 1e-6) return false;

                for (var other = index + 1; other < polygon.Count; other += 1)
                {
                    if (other == index ||
                        (other + 1) % polygon.Count == index ||
                        (index + 1) % polygon.Count == other)
                    {
                        continue;
                    }

                    if (SegmentsIntersect(
                            a, b, polygon[other], polygon[(other + 1) % polygon.Count]))
                    {
                        return false;
                    }
                }
            }

            return true;
        }

        /// <summary>
        /// A box cut through the full thickness of a thin strip (the miter relief on a
        /// cable-ladder flange) splits the profile into separate pieces. Revit cannot
        /// boolean that on a 2 mm prism, so build each piece as its own native prism.
        /// </summary>
        private static bool TrySplitPrismByThroughCuts(
            ResolvedPart part,
            out List<List<Vec2d>> pieces)
        {
            pieces = null;
            if (part.Solid.Kind != "prism" ||
                part.Solid.Points == null ||
                part.Solid.Points.Count < 3 ||
                part.Solid.Holes.Count > 0)
            {
                return false;
            }

            var plane = part.Solid.Plane;
            if (plane != "xy" && plane != "xz" && plane != "yz") return false;
            var low = Math.Min(part.Solid.From, part.Solid.To);
            var high = Math.Max(part.Solid.From, part.Solid.To);
            var current = new List<List<Vec2d>> { new List<Vec2d>(part.Solid.Points) };
            var splitCount = 0;

            foreach (var cut in part.Cuts)
            {
                if (cut.Kind != "box" || Math.Abs(cut.RotationZ) > 1e-6) return false;

                BoxCutRanges(
                    plane, cut, out var normalLow, out var normalHigh,
                    out var aMin, out var aMax, out var bMin, out var bMax);
                if (Math.Min(normalLow, normalHigh) > low + 0.5 ||
                    Math.Max(normalLow, normalHigh) < high - 0.5)
                {
                    return false;
                }

                var next = new List<List<Vec2d>>();
                var removedAny = false;

                foreach (var piece in current)
                {
                    var middle = ClipHalfPlane(
                        ClipHalfPlane(piece, true, aMin), false, aMax);
                    if (middle.Count < 3 || Math.Abs(PolygonArea(middle)) < 1e-6)
                    {
                        next.Add(piece);
                        continue;
                    }

                    var minB = middle.Min(point => point.B);
                    var maxB = middle.Max(point => point.B);
                    if (bMin > minB + 0.5 || bMax < maxB - 0.5) return false;

                    var left = ClipHalfPlane(piece, false, aMin);
                    var right = ClipHalfPlane(piece, true, aMax);
                    if (left.Count < 3 && right.Count < 3) return false;

                    if (left.Count >= 3 && Math.Abs(PolygonArea(left)) > 1e-6)
                    {
                        next.Add(CleanPolygon(left));
                    }
                    if (right.Count >= 3 && Math.Abs(PolygonArea(right)) > 1e-6)
                    {
                        next.Add(CleanPolygon(right));
                    }
                    removedAny = true;
                }

                if (!removedAny) return false;
                current = next;
                splitCount += 1;
            }

            if (splitCount == 0 || current.Count <= 1) return false;

            pieces = current;
            return true;
        }

        private static void BoxCutRanges(
            string plane,
            ResolvedSolid cut,
            out double normalLow,
            out double normalHigh,
            out double aMin,
            out double aMax,
            out double bMin,
            out double bMax)
        {
            switch (plane)
            {
                case "xy":
                    normalLow = cut.Origin.Z;
                    normalHigh = cut.Origin.Z + cut.Size.Z;
                    aMin = cut.Origin.X - Math.Abs(cut.Size.X) / 2;
                    aMax = cut.Origin.X + Math.Abs(cut.Size.X) / 2;
                    bMin = cut.Origin.Y - Math.Abs(cut.Size.Y) / 2;
                    bMax = cut.Origin.Y + Math.Abs(cut.Size.Y) / 2;
                    break;
                case "xz":
                    normalLow = cut.Origin.Y - Math.Abs(cut.Size.Y) / 2;
                    normalHigh = cut.Origin.Y + Math.Abs(cut.Size.Y) / 2;
                    aMin = cut.Origin.X - Math.Abs(cut.Size.X) / 2;
                    aMax = cut.Origin.X + Math.Abs(cut.Size.X) / 2;
                    bMin = cut.Origin.Z;
                    bMax = cut.Origin.Z + cut.Size.Z;
                    break;
                default:
                    normalLow = cut.Origin.X - Math.Abs(cut.Size.X) / 2;
                    normalHigh = cut.Origin.X + Math.Abs(cut.Size.X) / 2;
                    aMin = cut.Origin.Y - Math.Abs(cut.Size.Y) / 2;
                    aMax = cut.Origin.Y + Math.Abs(cut.Size.Y) / 2;
                    bMin = cut.Origin.Z;
                    bMax = cut.Origin.Z + cut.Size.Z;
                    break;
            }

            if (bMax < bMin)
            {
                (bMin, bMax) = (bMax, bMin);
            }
        }

        private static List<Vec2d> ClipHalfPlane(
            IList<Vec2d> polygon,
            bool keepGreater,
            double limit)
        {
            var result = new List<Vec2d>();
            if (polygon == null || polygon.Count < 3) return result;

            for (var index = 0; index < polygon.Count; index += 1)
            {
                var current = polygon[index];
                var next = polygon[(index + 1) % polygon.Count];
                var currentInside = keepGreater
                    ? current.A >= limit - 1e-7
                    : current.A <= limit + 1e-7;
                var nextInside = keepGreater
                    ? next.A >= limit - 1e-7
                    : next.A <= limit + 1e-7;

                if (currentInside) result.Add(current);
                if (currentInside == nextInside) continue;

                var delta = next.A - current.A;
                if (Math.Abs(delta) < 1e-12) continue;
                var t = (limit - current.A) / delta;
                if (t > 1e-7 && t < 1 - 1e-7)
                {
                    result.Add(new Vec2d(limit, current.B + (next.B - current.B) * t));
                }
            }

            return result;
        }

        private static List<Vec2d> CleanPolygon(IList<Vec2d> polygon)
        {
            var result = new List<Vec2d>();
            foreach (var point in polygon)
            {
                if (result.Count > 0)
                {
                    var last = result[result.Count - 1];
                    if (Math.Abs(last.A - point.A) < 1e-6 &&
                        Math.Abs(last.B - point.B) < 1e-6)
                    {
                        continue;
                    }
                }
                result.Add(point);
            }

            if (result.Count > 1)
            {
                var first = result[0];
                var last = result[result.Count - 1];
                if (Math.Abs(first.A - last.A) < 1e-6 &&
                    Math.Abs(first.B - last.B) < 1e-6)
                {
                    result.RemoveAt(result.Count - 1);
                }
            }

            return result;
        }

        private static double PolygonArea(IList<Vec2d> polygon)
        {
            if (polygon == null || polygon.Count < 3) return 0;
            var area = 0.0;
            for (var index = 0; index < polygon.Count; index += 1)
            {
                var a = polygon[index];
                var b = polygon[(index + 1) % polygon.Count];
                area += a.A * b.B - b.A * a.B;
            }
            return area / 2;
        }

        private static Element CreateNativeMultiHolePrismForm(
            Document document,
            ResolvedPart part,
            Vec3d offset,
            bool isSolid,
            IList<Vec2d> outerPoints,
            IList<List<Vec2d>> cutHoles)
        {
            var plane = part.Solid.Plane;
            var holes = new List<List<Vec2d>>();
            foreach (var hole in part.Solid.Holes)
            {
                holes.Add(hole);
            }
            foreach (var hole in cutHoles)
            {
                holes.Add(hole);
            }

            var synthetic = new ResolvedSolid
            {
                Kind = "prism",
                Plane = plane,
                Points = new List<Vec2d>(outerPoints),
                Holes = holes,
                From = part.Solid.From,
                To = part.Solid.To,
            };

            return CreatePrismForm(document, synthetic, offset, isSolid);
        }

        private static bool SegmentsIntersect(Vec2d a, Vec2d b, Vec2d c, Vec2d d)
        {
            double Cross(Vec2d p, Vec2d q, Vec2d r) =>
                (q.A - p.A) * (r.B - p.B) - (q.B - p.B) * (r.A - p.A);

            var d1 = Cross(a, b, c);
            var d2 = Cross(a, b, d);
            var d3 = Cross(c, d, a);
            var d4 = Cross(c, d, b);
            return ((d1 > 1e-9 && d2 < -1e-9) || (d1 < -1e-9 && d2 > 1e-9)) &&
                   ((d3 > 1e-9 && d4 < -1e-9) || (d3 < -1e-9 && d4 > 1e-9));
        }

        private static double PlaneA(string plane, Vec3d point)
        {
            return plane == "xy" || plane == "xz" ? point.X : point.Y;
        }

        private static double PlaneB(string plane, Vec3d point)
        {
            return plane == "xy" ? point.Y : point.Z;
        }

        private static double PlaneNormalCoord(string plane, Vec3d point)
        {
            return plane == "xy" ? point.Z : plane == "xz" ? point.Y : point.X;
        }

        private static bool PointInPolygon(double a, double b, IList<Vec2d> polygon)
        {
            var inside = false;
            for (int i = 0, j = polygon.Count - 1; i < polygon.Count; j = i, i += 1)
            {
                var pi = polygon[i];
                var pj = polygon[j];
                var crosses = (pi.B > b) != (pj.B > b) &&
                              a < (pj.A - pi.A) * (b - pi.B) /
                                  ((pj.B - pi.B) == 0 ? 1e-12 : (pj.B - pi.B)) + pi.A;
                if (crosses) inside = !inside;
            }
            return inside;
        }

        private static double DistanceToSegment(double a, double b, Vec2d start, Vec2d end)
        {
            var dx = end.A - start.A;
            var dy = end.B - start.B;
            var lengthSquared = dx * dx + dy * dy;
            if (lengthSquared <= 1e-12)
            {
                return Math.Sqrt((a - start.A) * (a - start.A) + (b - start.B) * (b - start.B));
            }

            var t = Math.Min(1, Math.Max(0, ((a - start.A) * dx + (b - start.B) * dy) / lengthSquared));
            var px = start.A + dx * t;
            var py = start.B + dy * t;
            return Math.Sqrt((a - px) * (a - px) + (b - py) * (b - py));
        }

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
            var pathArray = new CurveArray();
            var arcPlane = Plane.CreateByOriginAndBasis(center, u, v);
            var pathSketchPlane = SketchPlane.Create(document, arcPlane);

            if (Math.Abs(solid.Angle) >= 359.9)
            {
                pathCurve = Arc.Create(arcPlane, radius, 0, 2 * Math.PI);
                var arc1 = Arc.Create(arcPlane, radius, 0, Math.PI);
                var arc2 = Arc.Create(arcPlane, radius, Math.PI, 2 * Math.PI);
                pathArray.Append(arc1);
                pathArray.Append(arc2);
            }
            else
            {
                pathCurve = Arc.Create(PointOnArc(start), PointOnArc(end), PointOnArc(mid));
                pathArray.Append(pathCurve);
            }

            // 1. Attempt native Revit Sweep first: native forms flex with parameters and keep true geometry
            try
            {
                var profileArray = new CurveArray();
                foreach (var c in loop) profileArray.Append(c);
                var profileArrArr = new CurveArrArray();
                profileArrArr.Append(profileArray);
                var sweepProfile = document.Application.Create.NewCurveLoopsProfile(profileArrArr);

                return document.FamilyCreate.NewSweep(
                    isSolid,
                    pathArray,
                    pathSketchPlane,
                    sweepProfile,
                    0,
                    ProfilePlaneLocation.Start);
            }
            catch
            {
                // 2. Fallback to FreeFormElement if Revit native sweep rejects the sketch/path
                var pathLoop = new CurveLoop();
                pathLoop.Append(pathCurve);

                var sweptSolid = GeometryCreationUtilities.CreateSweptGeometry(
                    pathLoop,
                    0,
                    pathCurve.GetEndParameter(0),
                    new List<CurveLoop> { loop });

                return FreeFormElement.Create(document, sweptSolid);
            }
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

            // Native SweptBlend only takes two profiles and its profile orientation is
            // reliable on Z. For X/Y or more than two sections, keep every section as a
            // FreeFormElement instead of silently dropping the middle/rotating the profile.
            if (solid.Axis != "z" || solid.Sections.Count > 2)
            {
                return CreateLoftFreeForm(document, solid, offset);
            }

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

            try
            {
                return document.FamilyCreate.NewSweptBlend(isSolid, path, pathPlane, bottom, top);
            }
            catch
            {
                // Revit can reject a SweptBlend on some profile/path combinations. A
                // FreeForm loft keeps the part in the family instead of losing it.
                return CreateLoftFreeForm(document, solid, offset);
            }
        }

        /// <summary>
        /// Lofts every resolved section through GeometryCreationUtilities, then stores the
        /// result as a FreeFormElement. Used for X/Y lofts, longer lofts and as a fallback
        /// when a native SweptBlend is rejected: the part stays visible, but loses the
        /// native form/constraint (Rebuild from spec is the update path).
        /// </summary>
        private static Element CreateLoftFreeForm(
            Document document,
            ResolvedSolid solid,
            Vec3d offset)
        {
            var loops = new List<CurveLoop>();
            foreach (var section in solid.Sections)
            {
                if (section.Points == null || section.Points.Count < 3) continue;

                var loop = new CurveLoop();
                for (var index = 0; index < section.Points.Count; index += 1)
                {
                    var start = section.Points[index];
                    var end = section.Points[(index + 1) % section.Points.Count];
                    loop.Append(Line.CreateBound(
                        LoftSectionPoint(solid.Axis, section.At, start, offset),
                        LoftSectionPoint(solid.Axis, section.At, end, offset)));
                }
                loops.Add(loop);
            }

            if (loops.Count < 2)
                throw new InvalidOperationException("loft needs at least two usable profiles");

            var geometry = GeometryCreationUtilities.CreateLoftGeometry(
                loops,
                new SolidOptions(ElementId.InvalidElementId, ElementId.InvalidElementId));

            return FreeFormElement.Create(document, geometry);
        }

        private static XYZ LoftSectionPoint(
            string axis,
            double at,
            Vec2d point,
            Vec3d offset)
        {
            switch (axis)
            {
                case "x":
                    return new XYZ(
                        Ft(at + offset.X),
                        Ft(point.A + offset.Y),
                        Ft(point.B + offset.Z));
                case "y":
                    return new XYZ(
                        Ft(point.A + offset.X),
                        Ft(at + offset.Y),
                        Ft(point.B + offset.Z));
                default:
                    return new XYZ(
                        Ft(point.A + offset.X),
                        Ft(point.B + offset.Y),
                        Ft(at + offset.Z));
            }
        }

        /// <summary>
        /// A straight round tube between two arbitrary points. Native Sweep first, then a
        /// swept-solid FreeFormElement if Revit rejects the sketch. This is the primitive
        /// for inclined branches, oriented flanges and sloped pipe work.
        /// </summary>
        private static Element CreateTubeForm(
            Document document,
            ResolvedSolid solid,
            Vec3d offset,
            bool isSolid)
        {
            var start = new XYZ(
                Ft(solid.Start.X + offset.X),
                Ft(solid.Start.Y + offset.Y),
                Ft(solid.Start.Z + offset.Z));
            var end = new XYZ(
                Ft(solid.End.X + offset.X),
                Ft(solid.End.Y + offset.Y),
                Ft(solid.End.Z + offset.Z));

            var vector = end - start;
            var length = vector.GetLength();
            if (length <= 1e-9) throw new InvalidOperationException("tube start and end must differ");
            if (solid.Radius <= 0) throw new InvalidOperationException("tube has a zero radius");

            var direction = vector.Normalize();
            var radius = Ft(solid.Radius);
            var inner = Ft(solid.InnerRadius);

            var pathArray = new CurveArray();
            pathArray.Append(Line.CreateBound(start, end));

            var helper = Math.Abs(direction.Z) < 0.9 ? XYZ.BasisZ : XYZ.BasisX;
            var across = direction.CrossProduct(helper).Normalize();
            var pathPlane = SketchPlane.Create(
                document,
                Plane.CreateByOriginAndBasis(start, direction, across));

            var profilePlane = PlaneAt(start, direction);
            var profileLoops = new CurveArrArray();
            profileLoops.Append(CircleLoop(profilePlane, radius));
            if (solid.InnerRadius > 0) profileLoops.Append(CircleLoop(profilePlane, inner));
            var sweepProfile = document.Application.Create.NewCurveLoopsProfile(profileLoops);

            try
            {
                return document.FamilyCreate.NewSweep(
                    isSolid,
                    pathArray,
                    pathPlane,
                    sweepProfile,
                    0,
                    ProfilePlaneLocation.Start);
            }
            catch
            {
                var outer = SweptTubeSolid(start, end, radius);
                if (outer == null) throw new InvalidOperationException("tube sweep failed");

                var result = outer;
                if (solid.InnerRadius > 0)
                {
                    var overshoot = direction * Ft(0.5);
                    var cutter = SweptTubeSolid(start - overshoot, end + overshoot, inner);
                    if (cutter != null)
                    {
                        try
                        {
                            var diff = BooleanOperationsUtils.ExecuteBooleanOperation(
                                outer,
                                cutter,
                                BooleanOperationsType.Difference);
                            if (diff != null && diff.Volume > 1e-9) result = diff;
                        }
                        catch
                        {
                            // Keep the outer tube rather than dropping the part.
                        }
                    }
                }

                return FreeFormElement.Create(document, result);
            }
        }

        private static CurveArray CircleLoop(Plane plane, double radius)
        {
            var loop = new CurveArray();
            loop.Append(Arc.Create(plane, radius, 0, Math.PI));
            loop.Append(Arc.Create(plane, radius, Math.PI, 2 * Math.PI));
            return loop;
        }

        private static Solid SweptTubeSolid(XYZ start, XYZ end, double radius)
        {
            var vector = end - start;
            var length = vector.GetLength();
            if (length <= 1e-9 || radius <= 0) return null;

            var direction = vector.Normalize();
            var line = Line.CreateBound(start, end);
            var path = new CurveLoop();
            path.Append(line);

            var profilePlane = PlaneAt(start, direction);
            var profile = new CurveLoop();
            profile.Append(Arc.Create(profilePlane, radius, 0, Math.PI));
            profile.Append(Arc.Create(profilePlane, radius, Math.PI, 2 * Math.PI));

            try
            {
                return GeometryCreationUtilities.CreateSweptGeometry(
                    path,
                    0,
                    line.GetEndParameter(0),
                    new List<CurveLoop> { profile });
            }
            catch
            {
                return null;
            }
        }

        /// <summary>
        /// A native revolution of a 2D profile around an axis line (X, Y, or Z).
        /// Revolve produces true cylindrical/spherical surfaces that keep parametric dimensions.
        /// </summary>
        private static Element CreateRevolutionForm(
            Document document,
            ResolvedSolid solid,
            Vec3d offset,
            bool isSolid)
        {
            if (solid.Points == null || solid.Points.Count < 3)
                throw new InvalidOperationException("revolve needs at least 3 profile points");

            var origin = new XYZ(
                Ft(solid.Origin.X + offset.X),
                Ft(solid.Origin.Y + offset.Y),
                Ft(solid.Origin.Z + offset.Z));

            XYZ u, v, axisDir;
            switch (solid.Axis)
            {
                case "x":
                    axisDir = XYZ.BasisX;
                    u = XYZ.BasisY;
                    v = XYZ.BasisX;
                    break;
                case "y":
                    axisDir = XYZ.BasisY;
                    u = XYZ.BasisX;
                    v = XYZ.BasisY;
                    break;
                default:
                    axisDir = XYZ.BasisZ;
                    u = XYZ.BasisX;
                    v = XYZ.BasisZ;
                    break;
            }

            var plane = Plane.CreateByOriginAndBasis(origin, u, v);
            var sketchPlane = SketchPlane.Create(document, plane);
            var axisLine = Line.CreateUnbound(origin, axisDir);

            var loop = new CurveArray();
            for (var i = 0; i < solid.Points.Count; i += 1)
            {
                var start = solid.Points[i];
                var end = solid.Points[(i + 1) % solid.Points.Count];
                var p1 = origin + u * Ft(start.A) + v * Ft(start.B);
                var p2 = origin + u * Ft(end.A) + v * Ft(end.B);
                if (p1.DistanceTo(p2) > 0.0026) // > ~0.8mm short-curve tolerance
                {
                    loop.Append(Line.CreateBound(p1, p2));
                }
            }

            var loops = new CurveArrArray();
            loops.Append(loop);

            var startRad = solid.StartAngle * DegToRad;
            var angleRad = Math.Abs(solid.Angle) > 1e-6 ? solid.Angle * DegToRad : 2 * Math.PI;
            var endRad = startRad + angleRad;

            return document.FamilyCreate.NewRevolution(
                isSolid,
                loops,
                sketchPlane,
                axisLine,
                startRad,
                endRad);
        }

        /// <summary>
        /// A family connector must be hosted by a planar reference. A cable-ladder
        /// opening is hollow, so there is no solid face at its centre. Create an
        /// invisible reference plane through the connector origin with the connector
        /// direction as normal; no visible "host tab" solid is needed.
        /// </summary>
        private static ReferencePlane CreateConnectorHostPlane(
            Document document,
            XYZ origin,
            XYZ direction,
            out string diagnosis)
        {
            diagnosis = string.Empty;
            var view = document.ActiveView
                ?? new FilteredElementCollector(document)
                    .OfClass(typeof(View3D))
                    .Cast<View3D>()
                    .FirstOrDefault(candidate => !candidate.IsTemplate)
                ?? new FilteredElementCollector(document)
                    .OfClass(typeof(View))
                    .Cast<View>()
                    .FirstOrDefault(candidate => !candidate.IsTemplate);

            if (view == null)
            {
                diagnosis = "no view available for a reference plane";
                return null;
            }

            var helper = Math.Abs(direction.Z) < 0.9 ? XYZ.BasisZ : XYZ.BasisX;
            var lineDir = direction.CrossProduct(helper);
            if (lineDir.GetLength() < 1e-9) lineDir = direction.CrossProduct(XYZ.BasisY);
            if (lineDir.GetLength() < 1e-9) lineDir = direction.CrossProduct(XYZ.BasisX);
            lineDir = lineDir.Normalize();

            // Keep the datum line short and centred on the connector origin.
            // Revit places the connector at one end/midpoint of this line; the old
            // 300 mm line pushed it hundreds of millimetres away from the studio origin.
            var halfLine = 1.0 / MmPerFoot;
            var bubbleEnd = origin - lineDir * halfLine;
            var freeEnd = origin + lineDir * halfLine;

            var candidates = new[]
            {
                direction.CrossProduct(lineDir),
                lineDir.CrossProduct(direction),
                direction,
                -direction,
            };

            foreach (var candidate in candidates)
            {
                if (candidate.GetLength() < 1e-9) continue;

                ReferencePlane plane = null;
                try
                {
                    plane = document.FamilyCreate.NewReferencePlane(
                        bubbleEnd, freeEnd, candidate.Normalize(), view);
                }
                catch (Exception ex)
                {
                    diagnosis = "NewReferencePlane: " + ex.Message;
                    continue;
                }

                var normal = plane.Normal;
                if (normal == null || normal.GetLength() < 1e-9)
                {
                    TryDelete(document, plane);
                    diagnosis = "reference plane has no normal";
                    continue;
                }

                var dot = normal.Normalize().DotProduct(direction);
                if (dot > 0.95)
                {
                    try { plane.Name = "Family Agent Connector Host"; } catch { }
                    diagnosis = $"plane normal dot={Math.Round(dot, 3)}";
                    return plane;
                }

                TryDelete(document, plane);
            }

            diagnosis = "no reference plane normal aligned with the connector direction";
            return null;
        }

        /// <summary>
        /// Revit connectors require a planar face, not a reference plane. Create a
        /// thin host solid at the connector origin, hidden in every view, and use its
        /// face. It never appears in the studio or in the rendered family.
        /// </summary>
        private static Element CreateConnectorHostTab(
            Document document,
            XYZ origin,
            XYZ direction,
            double widthMm,
            double heightMm,
            IList<Element> forms,
            bool fullSize)
        {
            // A small tab is enough for the connector coordinate system; Revit does
            // not require the host face to be as large as the connector profile.
            var width = fullSize ? Math.Max(12.0, widthMm) : 12.0;
            var height = fullSize ? Math.Max(12.0, heightMm) : 12.0;
            const double thickness = 2.0;
            var ox = origin.X * MmPerFoot;
            var oy = origin.Y * MmPerFoot;
            var oz = origin.Z * MmPerFoot;

            Vec3d boxOrigin;
            Vec3d size;
            if (Math.Abs(direction.X) >= Math.Abs(direction.Y) &&
                Math.Abs(direction.X) >= Math.Abs(direction.Z))
            {
                var sign = direction.X >= 0 ? 1.0 : -1.0;
                size = new Vec3d(thickness, width, height);
                // ResolvedSolid.Origin is the box CENTRE, so half the thickness keeps
                // one face exactly on the connector origin with the body behind it.
                boxOrigin = new Vec3d(ox + sign * thickness / 2.0, oy, oz - height / 2.0);
            }
            else if (Math.Abs(direction.Y) >= Math.Abs(direction.Z))
            {
                var sign = direction.Y >= 0 ? 1.0 : -1.0;
                size = new Vec3d(width, thickness, height);
                boxOrigin = new Vec3d(ox, oy + sign * thickness / 2.0, oz - height / 2.0);
            }
            else
            {
                var sign = direction.Z >= 0 ? 1.0 : -1.0;
                size = new Vec3d(width, height, thickness);
                // Z is the exception: an extrusion uses origin.Z as the BOTTOM of the box.
                boxOrigin = new Vec3d(ox, oy, oz - (sign >= 0 ? thickness : 0));
            }

            var solid = new ResolvedSolid
            {
                Kind = "box",
                Origin = boxOrigin,
                Size = size,
                RotationZ = 0,
                CornerRadius = 0,
            };

            var tab = CreateForm(document, solid, new Vec3d(0, 0, 0), true);
            if (tab == null) return null;

            try { tab.Name = "Family Agent Connector Host"; } catch { }
            try
            {
                if (tab is GenericForm form)
                {
                    form.SetVisibility(new FamilyElementVisibility(FamilyElementVisibilityType.Model)
                    {
                        IsShownInCoarse = false,
                        IsShownInMedium = false,
                        IsShownInFine = false,
                        IsShownInFrontBack = false,
                        IsShownInLeftRight = false,
                        IsShownInPlanRCPCut = false,
                    });
                }
            }
            catch
            {
                // A hidden host is best effort; the connector can still use the face.
            }

            try
            {
                document.ActiveView?.HideElements(new List<ElementId> { tab.Id });
            }
            catch
            {
                // Hiding in the active view is cosmetic; the host face remains valid.
            }

            forms.Add(tab);
            return tab;
        }

        private static double ConnectorValue(Num? value, double fallback, CoreParameterSet parameters)
        {
            if (value == null) return fallback;
            var number = value.Value;
            if (!number.IsExpression) return number.Value;
            try { return Expression.Evaluate(number.Expression, parameters.Lookup); }
            catch { return fallback; }
        }

        private static void ResolveConnectorFrame(
            MepConnector connector,
            CoreParameterSet parameters,
            out XYZ origin,
            out XYZ direction,
            out XYZ widthAxis,
            out double widthMm,
            out double heightMm,
            out bool isRound)
        {
            origin = new XYZ(
                Ft(ConnectorValue(connector.Origin.X, 0, parameters)),
                Ft(ConnectorValue(connector.Origin.Y, 0, parameters)),
                Ft(ConnectorValue(connector.Origin.Z, 0, parameters)));
            direction = new XYZ(
                ConnectorValue(connector.DirectionVector.X, 0, parameters),
                ConnectorValue(connector.DirectionVector.Y, 0, parameters),
                ConnectorValue(connector.DirectionVector.Z, -1, parameters));
            if (direction.GetLength() < 1e-9) direction = new XYZ(0, 0, -1);
            direction = direction.Normalize();

            isRound = !string.Equals(
                connector.Shape, "rectangular", StringComparison.OrdinalIgnoreCase);
            widthMm = isRound
                ? ConnectorValue(connector.Diameter, 50, parameters)
                : ConnectorValue(connector.Width, 200, parameters);
            heightMm = isRound
                ? widthMm
                : ConnectorValue(connector.Height, 200, parameters);

            var up = Math.Abs(direction.Z) < 0.9 ? XYZ.BasisZ : XYZ.BasisY;
            widthAxis = up.CrossProduct(direction);
            if (widthAxis.GetLength() < 1e-9)
            {
                widthAxis = XYZ.BasisX.CrossProduct(direction);
            }
            if (widthAxis.GetLength() < 1e-9) widthAxis = XYZ.BasisY;
            widthAxis = widthAxis.Normalize();

            // The face width axis must stay the same for both connector directions
            // on the same plane; do not flip it with the flow sign.
            if (Math.Abs(widthAxis.X) >= Math.Abs(widthAxis.Y) &&
                Math.Abs(widthAxis.X) >= Math.Abs(widthAxis.Z))
            {
                if (widthAxis.X < 0) widthAxis = -widthAxis;
            }
            else if (Math.Abs(widthAxis.Y) >= Math.Abs(widthAxis.Z))
            {
                if (widthAxis.Y < 0) widthAxis = -widthAxis;
            }
            else if (widthAxis.Z < 0)
            {
                widthAxis = -widthAxis;
            }
        }

        /// <summary>
        /// Revit reports ConnectorElement.Origin either as the profile centre or as one of
        /// its four corners, and which one depends on the host face. Try every reading and
        /// keep the one closest to where the connector is supposed to sit.
        /// </summary>
        private static XYZ ProfileCentre(
            ConnectorElement element,
            bool isRound,
            XYZ widthAxis,
            XYZ heightAxis,
            double halfWidth,
            double halfHeight,
            XYZ target,
            out string reading)
        {
            reading = "centre";
            if (element == null) return target;

            var best = element.Origin;
            var bestDistance = best.DistanceTo(target);
            if (isRound) return best;

            foreach (var sx in new[] { -1.0, 1.0 })
            {
                foreach (var sy in new[] { -1.0, 1.0 })
                {
                    var point = element.Origin +
                                widthAxis * (sx * halfWidth) +
                                heightAxis * (sy * halfHeight);
                    var distance = point.DistanceTo(target);
                    if (distance >= bestDistance - 1e-9) continue;

                    best = point;
                    bestDistance = distance;
                    reading = sx > 0 ? (sy > 0 ? "corner++" : "corner+-") : (sy > 0 ? "corner-+" : "corner--");
                }
            }

            return best;
        }

        private static string FormatPoint(XYZ point)
        {
            if (point == null) return "?";

            return $"{Math.Round(point.X * MmPerFoot, 1)}, " +
                   $"{Math.Round(point.Y * MmPerFoot, 1)}, " +
                   $"{Math.Round(point.Z * MmPerFoot, 1)}";
        }

        private static string ConnectorKey(MepConnector connector)
        {
            var key = connector?.Id;
            if (string.IsNullOrWhiteSpace(key)) key = connector?.Name;
            return key ?? string.Empty;
        }

        /// <summary>
        /// Builds one hidden host tab per connector and returns it by connector id. The
        /// connector step must use ITS OWN tab: searching every form for the nearest face
        /// attaches connectors to the flange or rung that happens to be closer.
        /// </summary>
        private static Dictionary<string, Element> CreateConnectorHosts(
            Document document,
            FamilySpec spec,
            CoreParameterSet parameters,
            IList<Element> forms,
            IDictionary<long, ResolvedPart> partByForm,
            List<string> warnings)
        {
            var hosts = new Dictionary<string, Element>(StringComparer.OrdinalIgnoreCase);
            if (spec.Connectors == null || spec.Connectors.Count == 0) return hosts;

            foreach (var connector in spec.Connectors)
            {
                try
                {
                    ResolveConnectorFrame(
                        connector, parameters, out var origin, out var direction,
                        out var widthAxis, out var widthMm, out var heightMm, out _);

                    // Build the tab on the spec centre. CreateConnectors measures where
                    // Revit anchors the profile and moves the tab itself.
                    var tab = CreateConnectorHostTab(
                        document, origin, direction, widthMm, heightMm, forms, false);
                    if (tab == null)
                    {
                        warnings.Add(
                            $"Connector \"{connector.Id ?? connector.Name}\" host stub could not be built");
                        continue;
                    }

                    if (partByForm != null)
                    {
                        partByForm[tab.Id.Value] = new ResolvedPart
                        {
                            Id = "connector-host-" + (connector.Id ?? connector.Name),
                            Name = "Connector Host",
                            Cuts = new List<ResolvedSolid>(),
                        };
                    }

                    hosts[ConnectorKey(connector)] = tab;
                }
                catch (Exception ex)
                {
                    warnings.Add($"Connector host \"{connector.Id ?? connector.Name}\" failed: {ex.Message}");
                }
            }

            return hosts;
        }

        /// <summary>
        /// Planar faces of the connector's own tab, ordered by how close their plane is to
        /// the spec origin along the flow direction: the near face first, the opposite one
        /// second, so the caller can fall back without touching any other form.
        /// </summary>
        private static List<PlanarFace> ConnectorFacesOf(
            Element tab,
            XYZ origin,
            XYZ direction,
            out string diagnosis)
        {
            var faces = new List<PlanarFace>();
            diagnosis = "no host tab";

            var solid = tab == null ? null : SolidOf(tab);
            if (solid == null) return faces;

            var seen = new List<PlanarFace>();
            var parallel = 0;
            foreach (Face candidate in solid.Faces)
            {
                var face = candidate as PlanarFace;
                if (face == null || face.Reference == null) continue;

                var normal = face.FaceNormal;
                if (normal.GetLength() < 1e-9) continue;

                if (Math.Abs(normal.Normalize().DotProduct(direction)) < 0.95) continue;
                parallel += 1;
                seen.Add(face);
            }

            faces = seen
                .OrderBy(face => Math.Abs(face.Origin.Subtract(origin).DotProduct(direction)))
                .ToList();

            diagnosis =
                $"tabFaces={solid.Faces.Size}, parallel={parallel}, " +
                $"nearest={Math.Round(Math.Abs(faces[0].Origin.Subtract(origin).DotProduct(direction)) * MmPerFoot, 2)}mm";
            return faces;
        }

        private static int CreateConnectors(
            Document document,
            FamilySpec spec,
            CoreParameterSet parameters,
            IList<Element> forms,
            IDictionary<string, Element> hosts,
            List<string> warnings)
        {
            if (spec.Connectors == null || spec.Connectors.Count == 0) return 0;

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
                        ResolveConnectorFrame(
                            connector, parameters, out var origin, out var direction,
                            out var widthAxis, out var widthMm, out var heightMm, out var isRound);

                        // Use the connector's own hidden tab, placed on the spec origin.
                        // The tab is a plain box built from the spec centre; no width/2
                        // pre-shift, because where Revit anchors the profile is measured
                        // below instead of assumed.
                        hosts.TryGetValue(ConnectorKey(connector), out var tab);
                        if (tab == null)
                        {
                            tab = CreateConnectorHostTab(
                                document, origin, direction, widthMm, heightMm, forms, false);
                        }

                        if (tab == null)
                        {
                            warnings.Add(
                                $"Connector \"{connector.Id ?? connector.Name}\" has no host tab");
                            continue;
                        }

                        document.Regenerate();

                        var shape = isRound
                            ? ConnectorProfileType.Round
                            : ConnectorProfileType.Rectangular;

                        var candidates = ConnectorFacesOf(tab, origin, direction, out var diagnosis);
                        if (candidates.Count == 0)
                        {
                            warnings.Add(
                                $"Connector \"{connector.Id ?? connector.Name}\" found no host face on its tab ({diagnosis})");
                            continue;
                        }

                        // Put the face origin exactly on the spec origin first.
                        var align = origin.Subtract(candidates[0].Origin);
                        if (align.GetLength() > 1e-9)
                        {
                            ElementTransformUtils.MoveElement(document, tab.Id, align);
                            document.Regenerate();
                            candidates = ConnectorFacesOf(tab, origin, direction, out diagnosis);
                            if (candidates.Count == 0)
                            {
                                warnings.Add(
                                    $"Connector \"{connector.Id ?? connector.Name}\" lost its tab face after moving ({diagnosis})");
                                continue;
                            }
                        }

                        // Probe once to learn where Revit anchors the profile: on the face
                        // origin (centre case) or at a profile corner (rectangle case).
                        var probe = CreateConnectorElement(
                            document, connector.SystemType, shape, candidates[0].Reference);
                        if (probe == null)
                        {
                            warnings.Add(
                                $"Connector \"{connector.Id ?? connector.Name}\" was rejected by Revit ({diagnosis})");
                            continue;
                        }

                        // Read where Revit actually put the profile: it reports either the
                        // centre or one of the four corners, and the choice depends on the
                        // host face, so measure all five readings and keep the closest.
                        var faceOrigin = candidates[0].Origin;
                        var heightAxisUnit = direction.CrossProduct(widthAxis);
                        if (heightAxisUnit.GetLength() < 1e-9) heightAxisUnit = direction.CrossProduct(XYZ.BasisZ);
                        heightAxisUnit = heightAxisUnit.Normalize();

                        var halfWidth = Ft(widthMm / 2.0);
                        var halfHeight = Ft(heightMm / 2.0);

                        var element = probe;
                        var connectorCenter = ProfileCentre(
                            element, isRound, widthAxis, heightAxisUnit, halfWidth, halfHeight,
                            origin, out var anchorKind);
                        var bestOffset = connectorCenter.DistanceTo(origin);
                        var probeOrigin = probe.Origin;
                        var correction = 0.0;

                        if (bestOffset > 1.0 / MmPerFoot)
                        {
                            // Move the hidden tab by the measured error and rebuild once.
                            var move = origin.Subtract(connectorCenter);
                            correction = move.GetLength() * MmPerFoot;
                            TryDelete(document, probe);
                            ElementTransformUtils.MoveElement(document, tab.Id, move);
                            document.Regenerate();

                            candidates = ConnectorFacesOf(tab, origin, direction, out diagnosis);
                            if (candidates.Count == 0)
                            {
                                warnings.Add(
                                    $"Connector \"{connector.Id ?? connector.Name}\" lost its tab face after the correction move ({diagnosis})");
                                continue;
                            }

                            element = CreateConnectorElement(
                                document, connector.SystemType, shape, candidates[0].Reference);
                            if (element == null)
                            {
                                warnings.Add(
                                    $"Connector \"{connector.Id ?? connector.Name}\" was rejected by Revit after the correction move ({diagnosis})");
                                continue;
                            }

                            connectorCenter = ProfileCentre(
                                element, isRound, widthAxis, heightAxisUnit, halfWidth, halfHeight,
                                origin, out anchorKind);
                            bestOffset = connectorCenter.DistanceTo(origin);
                        }

                        if (bestOffset > 1.0 / MmPerFoot)
                        {
                            warnings.Add(
                                $"Connector \"{connector.Id ?? connector.Name}\" host is offset " +
                                $"{Math.Round(bestOffset * MmPerFoot, 1)} mm from the spec origin " +
                                $"(reading={anchorKind}, " +
                                $"correction={Math.Round(correction, 1)}mm, " +
                                $"spec=({FormatPoint(origin)}), " +
                                $"face=({FormatPoint(faceOrigin)}), " +
                                $"element=({FormatPoint(element.Origin)}), " +
                                $"tried=({FormatPoint(probeOrigin)}), {diagnosis})");
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
                case "cabletray":
                    return ConnectorElement.CreateCableTrayConnector(document, reference);
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
