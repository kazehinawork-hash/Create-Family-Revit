using System;
using System.Collections.Generic;
using System.Linq;
using System.Text;
using Autodesk.Revit.DB;
using FamilyAgent.Core;
using CoreParameterSet = FamilyAgent.Core.ParameterSet;

namespace FamilyAgent.Addin
{
    internal static partial class FamilyBuilder
    {
        /// <summary>
        /// Dimensions are created once the planes are committed, so their references are
        /// regenerated, and in a transaction that downgrades Revit's "cannot be ignored"
        /// errors to a rollback instead of a modal dialog that would stall the bridge.
        /// </summary>
        private static int CreateDimensions(
            Document document,
            List<PlaneDimension> pending,
            List<string> warnings)
        {
            if (pending == null || pending.Count == 0) return 0;

            // Fast path: the whole skeleton in one transaction. Normally nothing fails and
            // this is several times quicker than a subtransaction per dimension.
            var fast = new FailureCollector();
            var fastCreated = 0;

            try
            {
                using (var transaction = SilentTransaction(document, "Family Agent — reference dimensions", fast))
                {
                    transaction.Start();

                    var scratch = new List<string>();
                    foreach (var dimension in pending)
                    {
                        if (dimension.Create(document, scratch)) fastCreated += 1;
                    }

                    if (transaction.Commit() == TransactionStatus.Committed) return fastCreated;
                }
            }
            catch
            {
                // Fall through to the one-by-one path below.
            }

            var failures = new FailureCollector();
            var created = 0;

            try
            {
                using (var transaction = SilentTransaction(document, "Family Agent — reference dimensions", failures))
                {
                    transaction.Start();

                    foreach (var dimension in pending)
                    {
                        // One transaction per dimension: a single unsatisfiable constraint then
                        // drops only that dimension instead of the whole skeleton.
                        try
                        {
                            using (var step = new SubTransaction(document))
                            {
                                step.Start();

                                if (!dimension.Create(document, warnings))
                                {
                                    step.RollBack();
                                    continue;
                                }

                                if (step.Commit() == TransactionStatus.Committed) created += 1;
                            }
                        }
                        catch (Exception ex)
                        {
                            warnings.Add($"Dimension \"{dimension.Name}\" was rejected: {ex.Message}");
                        }
                    }

                    var status = transaction.Commit();
                    if (status != TransactionStatus.Committed)
                    {
                        warnings.Add(
                            $"Reference dimensions were rolled back ({status}): {string.Join(" ", failures.Messages.Take(3))}");
                        return 0;
                    }
                }
            }
            catch (Exception ex)
            {
                warnings.Add($"Reference dimensions stopped: {ex.Message}");
            }

            foreach (var message in failures.Messages.Take(3)) warnings.Add(message);
            return created;
        }

        /// <summary>
        /// Locks each solid to at most one driven plane per axis — the face furthest from the
        /// form's own centre. NewAlignment returns a locked dimension, so moving a labelled
        /// plane drags the face with it; locking both opposite faces to two independent
        /// parameters lets them cross and Revit refuses to rebuild the extrusion.
        /// </summary>
        private static int LockGeometry(
            Document document,
            PlaneSkeleton skeleton,
            IList<Element> forms,
            IDictionary<long, ResolvedPart> partByForm,
            out HashSet<string> lockedFormAxes,
            List<string> warnings)
        {
            lockedFormAxes = new HashSet<string>(StringComparer.Ordinal);
            if (forms == null || forms.Count == 0) return 0;
            if (skeleton.Plan == null && skeleton.Elevation == null) return 0;

            var options = new Options { ComputeReferences = true, DetailLevel = ViewDetailLevel.Fine };
            var failures = new FailureCollector();
            var locked = 0;

            using (var transaction = SilentTransaction(document, "Family Agent — lock geometry", failures))
            {
                transaction.Start();

                foreach (var form in forms)
                {
                    // Voids are cutters: constraining them makes Revit fail to rebuild the
                    // cut ("Can't make Extrusion") as soon as a driving parameter moves.
                    var solidForm = form as Extrusion;
                    if (solidForm == null || !solidForm.IsSolid) continue;

                    var faces = new List<FaceCandidate>();
                    CollectFaces(form, options, skeleton, faces);

                    ResolvedPart part = null;
                    if (partByForm != null) partByForm.TryGetValue(form.Id.Value, out part);

                    foreach (PlaneAxis axis in new[] { PlaneAxis.X, PlaneAxis.Y, PlaneAxis.Z })
                    {
                        var best = ChooseFace(faces, axis, part?.Anchor);
                        if (best == null) continue;

                        var view = axis == PlaneAxis.Z ? skeleton.Elevation : skeleton.Plan;
                        if (view == null) continue;

                        try
                        {
                            document.FamilyCreate.NewAlignment(view, best.Plane.GetReference(), best.Face.Reference);
                            best.Entry.Used = true;
                            lockedFormAxes.Add($"{form.Id.Value}:{axis}");
                            locked += 1;
                        }
                        catch (Exception ex)
                        {
                            // One stubborn face must not cost the whole family its constraints.
                            if (failures.Messages.Count < 3) warnings.Add($"Lock \"{form.Name}\": {ex.Message}");
                        }
                    }
                }

                var status = transaction.Commit();
                if (status != TransactionStatus.Committed)
                {
                    warnings.Add(
                        $"Geometry locks were rolled back ({status}): {string.Join(" ", failures.Messages.Take(3))}");
                    return 0;
                }
            }

            return locked;
        }

        private sealed class FaceCandidate
        {
            public PlaneAxis Axis;
            public double Coordinate;
            public Face Face;
            public ReferencePlane Plane;
            public SkeletonPlane Entry;
        }

        /// <summary>
        /// Dimensions between two faces of the same solid whose distance equals a parameter,
        /// labelled with that parameter. Thicknesses and local widths ("Glass Thickness",
        /// "Door Width") never sit on a datum plane, so this is the only way they can drive
        /// geometry. Only same-solid pairs are used: cross-part dimensions would fight the
        /// alignment locks and make Revit roll the rebuild back.
        /// </summary>
        private static int CreateFaceDimensions(
            Document document,
            PlaneSkeleton skeleton,
            IList<Element> forms,
            CoreParameterSet parameters,
            HashSet<string> lockedFormAxes,
            out HashSet<string> solved,
            List<string> warnings)
        {
            solved = new HashSet<string>(StringComparer.OrdinalIgnoreCase);

            var inert = skeleton.Inert();
            if (inert.Count == 0 || forms == null || forms.Count == 0) return 0;

            var options = new Options { ComputeReferences = true, DetailLevel = ViewDetailLevel.Fine };
            var perForm = new List<(long Id, Dictionary<PlaneAxis, List<FaceCandidate>> Faces)>();

            foreach (var form in forms)
            {
                // Extrusions and blends both expose planar faces; a labelled face-to-face
                // dimension is what makes a thickness or a frustum height drive the form.
                var solidForm = form as GenericForm;
                if (solidForm == null || !solidForm.IsSolid) continue;

                var byAxis = new Dictionary<PlaneAxis, List<FaceCandidate>>
                {
                    { PlaneAxis.X, new List<FaceCandidate>() },
                    { PlaneAxis.Y, new List<FaceCandidate>() },
                    { PlaneAxis.Z, new List<FaceCandidate>() },
                };

                CollectAllFaces(solidForm, options, byAxis);
                if (byAxis.Values.Any(list => list.Count > 1)) perForm.Add((form.Id.Value, byAxis));
            }

            if (perForm.Count == 0) return 0;

            var created = 0;
            var failures = new FailureCollector();

            try
            {
                using (var transaction = SilentTransaction(document, "Family Agent — driving dimensions", failures))
                {
                    transaction.Start();

                    foreach (var name in inert)
                    {
                        var parameter = parameters.Ordered.FirstOrDefault(candidate =>
                            string.Equals(candidate.Name, name, StringComparison.OrdinalIgnoreCase));
                        if (parameter == null || !parameter.Number.HasValue) continue;

                        var value = Math.Abs(parameter.Number.Value);
                        if (value < 1) continue;

                        var familyParameter = FindParameter(document.FamilyManager, name);
                        if (familyParameter == null) continue;

                        var axis = AxisFor(name);

                        var done = false;
                        foreach (var candidateAxis in new[] { axis, PlaneAxis.X, PlaneAxis.Y, PlaneAxis.Z })
                        {
                            if (done) break;

                            var view = candidateAxis == PlaneAxis.Z ? skeleton.Elevation : skeleton.Plan;
                            if (view == null) continue;

                            foreach (var form in perForm)
                            {
                                // A form already locked on this axis would end up with two
                                // constraints on the same direction: editing either parameter
                                // then fails with "Dimension over-constrains the family".
                                if (lockedFormAxes.Contains($"{form.Id}:{candidateAxis}")) continue;

                                var faces = form.Faces[candidateAxis];

                                for (var i = 0; i < faces.Count && !done; i += 1)
                                {
                                    for (var j = i + 1; j < faces.Count && !done; j += 1)
                                    {
                                        var distance = Math.Abs(faces[j].Coordinate - faces[i].Coordinate);
                                        if (Math.Abs(distance - Ft(value)) > 0.05 / MmPerFoot) continue;

                                        if (TryLabelPair(document, view, faces[i], faces[j], familyParameter, warnings))
                                        {
                                            created += 1;
                                            solved.Add(name);
                                            done = true;
                                        }
                                    }
                                }

                                if (done) break;
                            }
                        }
                    }

                    transaction.Commit();
                }
            }
            catch (Exception ex)
            {
                warnings.Add($"Face dimensions stopped: {ex.Message}");
            }

            return created;
        }

        /// <summary>
        /// Radii cannot be measured face-to-face: a circle needs a radial dimension. This
        /// finds the circular edges of blends and cylinders whose radius matches a base
        /// length parameter, then labels them so the parameter drives the profile.
        /// </summary>
        private static int CreateRadialDimensions(
            Document document,
            PlaneSkeleton skeleton,
            IList<Element> forms,
            CoreParameterSet parameters,
            HashSet<string> solved,
            List<string> warnings)
        {
            if (skeleton.Plan == null || forms == null || forms.Count == 0) return 0;

            var candidates = parameters.Ordered
                .Where(parameter =>
                    !solved.Contains(parameter.Name) &&
                    IsType(parameter.Type, "Length") &&
                    parameter.Number.HasValue &&
                    Math.Abs(parameter.Number.Value) > 0.5)
                .ToList();
            if (candidates.Count == 0) return 0;

            var options = new Options { ComputeReferences = true, DetailLevel = ViewDetailLevel.Fine };
            var circles = new List<(Reference Reference, double Radius, XYZ Point)>();

            foreach (var form in forms)
            {
                var solidForm = form as GenericForm;
                if (solidForm == null || !solidForm.IsSolid) continue;

                GeometryElement geometry;
                try { geometry = form.get_Geometry(options); } catch { continue; }
                if (geometry == null) continue;

                foreach (var geometryObject in geometry)
                {
                    var solid = geometryObject as Solid;
                    if (solid == null) continue;

                    foreach (Edge edge in solid.Edges)
                    {
                        if (edge.Reference == null) continue;

                        Curve curve;
                        try { curve = edge.AsCurve(); } catch { continue; }

                        var arc = curve as Arc;
                        if (arc == null) continue;

                        // Only circles in plan can take a radial dimension in the plan view.
                        if (Math.Abs(Math.Abs(arc.Normal.Z) - 1) > 0.01) continue;

                        XYZ point;
                        try { point = arc.Evaluate(0.0, true); } catch { continue; }
                        circles.Add((edge.Reference, arc.Radius, point));
                    }
                }
            }

            if (circles.Count == 0) return 0;

            var created = 0;

            foreach (var parameter in candidates)
            {
                var target = Ft(Math.Abs(parameter.Number.Value));
                var match = circles.FirstOrDefault(circle =>
                    Math.Abs(circle.Radius - target) < 0.5 / MmPerFoot);
                if (match.Reference == null) continue;

                var familyParameter = FindParameter(document.FamilyManager, parameter.Name);
                if (familyParameter == null) continue;

                try
                {
                    using (var step = new Transaction(document, "Family Agent — radial dimension"))
                    {
                        step.Start();

                        var dimension = document.FamilyCreate.NewRadialDimension(
                            skeleton.Plan,
                            match.Reference,
                            match.Point);

                        if (dimension == null)
                        {
                            step.RollBack();
                            continue;
                        }

                        dimension.FamilyLabel = familyParameter;
                        if (dimension.FamilyLabel == null)
                        {
                            step.RollBack();
                            continue;
                        }

                        if (step.Commit() == TransactionStatus.Committed)
                        {
                            created += 1;
                            solved.Add(parameter.Name);
                        }
                    }
                }
                catch (Exception ex)
                {
                    if (warnings.Count < 40)
                    {
                        warnings.Add($"Radial dimension for \"{parameter.Name}\": {ex.Message}");
                    }
                }
            }

            return created;
        }

        private static void CollectAllFaces(
            Element form,
            Options options,
            IDictionary<PlaneAxis, List<FaceCandidate>> byAxis)
        {
            GeometryElement geometry;
            try
            {
                geometry = form.get_Geometry(options);
            }
            catch
            {
                return;
            }

            if (geometry == null) return;

            foreach (var geometryObject in geometry)
            {
                var solid = geometryObject as Solid;
                if (solid == null) continue;

                foreach (Face face in solid.Faces)
                {
                    var planar = face as PlanarFace;
                    if (planar == null || face.Reference == null) continue;

                    var normal = planar.FaceNormal;
                    PlaneAxis axis;
                    double coordinate;

                    if (Math.Abs(normal.X) > 0.999)
                    {
                        axis = PlaneAxis.X;
                        coordinate = planar.Origin.X;
                    }
                    else if (Math.Abs(normal.Y) > 0.999)
                    {
                        axis = PlaneAxis.Y;
                        coordinate = planar.Origin.Y;
                    }
                    else if (Math.Abs(normal.Z) > 0.999)
                    {
                        axis = PlaneAxis.Z;
                        coordinate = planar.Origin.Z;
                    }
                    else
                    {
                        continue;
                    }

                    byAxis[axis].Add(new FaceCandidate
                    {
                        Axis = axis,
                        Coordinate = coordinate,
                        Face = face,
                    });
                }
            }
        }

        private static bool TryLabelPair(
            Document document,
            View view,
            FaceCandidate a,
            FaceCandidate b,
            Autodesk.Revit.DB.FamilyParameter label,
            List<string> warnings)
        {
            var from = a.Coordinate <= b.Coordinate ? a : b;
            var to = from == a ? b : a;

            var start = from.Axis switch
            {
                PlaneAxis.X => new XYZ(from.Coordinate, 0, 0),
                PlaneAxis.Y => new XYZ(0, from.Coordinate, 0),
                _ => new XYZ(0, 0, from.Coordinate),
            };
            var end = to.Axis switch
            {
                PlaneAxis.X => new XYZ(to.Coordinate, 0, 0),
                PlaneAxis.Y => new XYZ(0, to.Coordinate, 0),
                _ => new XYZ(0, 0, to.Coordinate),
            };

            try
            {
                using (var step = new SubTransaction(document))
                {
                    step.Start();

                    var references = new ReferenceArray();
                    references.Append(from.Face.Reference);
                    references.Append(to.Face.Reference);

                    var dimension = document.FamilyCreate.NewDimension(view, Line.CreateBound(start, end), references);
                    if (dimension == null)
                    {
                        step.RollBack();
                        return false;
                    }

                    dimension.FamilyLabel = label;
                    if (dimension.FamilyLabel == null)
                    {
                        step.RollBack();
                        return false;
                    }

                    if (step.Commit() != TransactionStatus.Committed)
                    {
                        return false;
                    }
                }

                return true;
            }
            catch (Exception ex)
            {
                if (warnings.Count < 40) warnings.Add($"Dimension for \"{label.Definition?.Name}\": {ex.Message}");
                return false;
            }
        }

        private static void CollectFaces(
            Element form,
            Options options,
            PlaneSkeleton skeleton,
            List<FaceCandidate> faces)
        {
            GeometryElement geometry;
            try
            {
                geometry = form.get_Geometry(options);
            }
            catch
            {
                return;
            }

            if (geometry == null) return;

            foreach (var geometryObject in geometry)
            {
                var solid = geometryObject as Solid;
                if (solid == null) continue;

                foreach (Face face in solid.Faces)
                {
                    var planar = face as PlanarFace;
                    if (planar == null || face.Reference == null) continue;

                    var normal = planar.FaceNormal;
                    PlaneAxis axis;
                    double coordinate;

                    if (Math.Abs(normal.X) > 0.999)
                    {
                        axis = PlaneAxis.X;
                        coordinate = planar.Origin.X;
                    }
                    else if (Math.Abs(normal.Y) > 0.999)
                    {
                        axis = PlaneAxis.Y;
                        coordinate = planar.Origin.Y;
                    }
                    else if (Math.Abs(normal.Z) > 0.999)
                    {
                        axis = PlaneAxis.Z;
                        coordinate = planar.Origin.Z;
                    }
                    else
                    {
                        continue;
                    }

                    if (!skeleton.Drives(axis, coordinate)) continue;

                    var entry = skeleton.FindEntry(axis, coordinate);
                    if (entry == null) continue;

                    faces.Add(new FaceCandidate
                    {
                        Axis = axis,
                        Coordinate = coordinate,
                        Face = face,
                        Plane = entry.Plane,
                        Entry = entry,
                    });
                }
            }
        }

        private static FaceCandidate ChooseFace(
            List<FaceCandidate> faces,
            PlaneAxis axis,
            ResolvedAnchor anchor)
        {
            var onAxis = faces.Where(candidate => candidate.Axis == axis).ToList();
            if (onAxis.Count == 0) return null;
            if (onAxis.Count == 1) return onAxis[0];

            var side = anchor?.ForAxis(
                axis == PlaneAxis.X ? "x" : axis == PlaneAxis.Y ? "y" : "z");

            // An explicit anchor is a modelling decision ("this door grows to the right"),
            // so honour it before the default outermost-face guess.
            if (side == "min") return onAxis.OrderBy(candidate => candidate.Coordinate).First();
            if (side == "max") return onAxis.OrderByDescending(candidate => candidate.Coordinate).First();

            // The face furthest from the datum wins: that is the one an overall dimension
            // measures, and the one that cannot collapse the form onto itself.
            return onAxis.OrderByDescending(candidate => Math.Abs(candidate.Coordinate)).First();
        }

        /// <summary>
        /// Build-time proof that the parameters work: changes each base length by 10%, asks
        /// Revit to regenerate, and reports whether the geometry followed. Setting the
        /// family parameter is the same edit the user makes in the type dialog, so it tests
        /// plane dimensions and face dimensions alike. The transaction is rolled back.
        /// </summary>
        private static string SelfCheck(Document document, CoreParameterSet parameters)
        {
            var report = new StringBuilder();
            var manager = document.FamilyManager;
            var currentType = manager.CurrentType;
            if (currentType == null) return "no current type; ";

            var before = ModelSignature(document);
            var tried = 0;

            foreach (var parameter in parameters.Ordered)
            {
                if (tried >= 4) break;
                if (!IsType(parameter.Type, "Length")) continue;
                if (!string.IsNullOrWhiteSpace(parameter.Formula)) continue;
                if (!parameter.Number.HasValue) continue;

                var familyParameter = FindParameter(manager, parameter.Name);
                if (familyParameter == null) continue;

                var current = currentType.AsDouble(familyParameter);
                if (!current.HasValue || Math.Abs(current.Value) < 1e-9) continue;
                tried += 1;

                var label = parameter.Name + ": ";

                try
                {
                    using (var transaction = SilentTransaction(document, "self-check", new FailureCollector()))
                    {
                        transaction.Start();
                        manager.Set(familyParameter, current.Value * 1.1 + 0.001);
                        document.Regenerate();

                        report.Append(label)
                            .Append(Math.Abs(before - ModelSignature(document)) > 1e-9 ? "MOVE; " : "still; ");

                        // Roll back: the probe only measures, the saved family keeps its values.
                        var status = transaction.RollBack();
                        if (status != TransactionStatus.RolledBack)
                        {
                            report.Append("rollback=").Append(status).Append("; ");
                        }
                    }
                }
                catch (Exception ex)
                {
                    report.Append(label).Append("X ").Append(ex.Message).Append("; ");
                }
            }

            return report.ToString();
        }

        private static double ModelSignature(Document document)
        {
            var signature = 0.0;
            var options = new Options { ComputeReferences = false, DetailLevel = ViewDetailLevel.Fine };

            var forms = new FilteredElementCollector(document)
                .OfClass(typeof(Extrusion))
                .Cast<Element>()
                .Concat(new FilteredElementCollector(document)
                    .OfClass(typeof(Blend))
                    .Cast<Element>())
                .Concat(new FilteredElementCollector(document)
                    .OfClass(typeof(Revolution))
                    .Cast<Element>());

            foreach (var form in forms)
            {
                var geometry = form.get_Geometry(options);
                if (geometry == null) continue;

                foreach (var geometryObject in geometry)
                {
                    var solid = geometryObject as Solid;
                    if (solid == null) continue;

                    var box = solid.GetBoundingBox();
                    if (box == null) continue;

                    var dx = box.Max.X - box.Min.X;
                    var dy = box.Max.Y - box.Min.Y;
                    var dz = box.Max.Z - box.Min.Z;

                    // Volume catches stretch, the corner sum catches a pure move.
                    signature += dx * dy * dz;
                    signature += 0.0001 * (box.Min.X + box.Min.Y + box.Min.Z + box.Max.X + box.Max.Y + box.Max.Z);
                }
            }

            return signature;
        }

        private sealed class PlaneDimension
        {
            private readonly View _view;
            private readonly ReferencePlane _from;
            private readonly ReferencePlane _to;
            private readonly XYZ _start;
            private readonly XYZ _end;
            private readonly Autodesk.Revit.DB.FamilyParameter _label;

            public PlaneDimension(
                View view,
                ReferencePlane from,
                ReferencePlane to,
                XYZ start,
                XYZ end,
                Autodesk.Revit.DB.FamilyParameter label)
            {
                _view = view;
                _from = from;
                _to = to;
                _start = start;
                _end = end;
                _label = label;
            }

            public string Name => $"{_from.Name} → {_to.Name}";

            public bool Create(Document document, List<string> warnings)
            {
                return AddDimension(document, _view, _from, _to, _start, _end, _label, warnings);
            }
        }

        private static PlaneAxis AxisFor(string name)
        {
            var text = (name ?? string.Empty).ToLowerInvariant();

            if (text.Contains("width") || text.Contains("left") || text.Contains("right")) return PlaneAxis.X;
            if (text.Contains("depth") || text.Contains("front") || text.Contains("back")) return PlaneAxis.Y;
            return PlaneAxis.Z;
        }

        private static View FindView(Document document, ViewType type)
        {
            return new FilteredElementCollector(document)
                .OfClass(typeof(View))
                .Cast<View>()
                .FirstOrDefault(view => !view.IsTemplate && view.ViewType == type);
        }

        private static ReferencePlane FindPlane(Document document, string name)
        {
            return new FilteredElementCollector(document)
                .OfClass(typeof(ReferencePlane))
                .Cast<ReferencePlane>()
                .FirstOrDefault(plane => string.Equals(plane.Name, name, StringComparison.OrdinalIgnoreCase));
        }

        private static ReferencePlane AddPlane(
            Document document,
            View view,
            string name,
            PlaneAxis axis,
            double offset,
            double halfLength)
        {
            XYZ origin;
            XYZ along;
            XYZ across;

            switch (axis)
            {
                case PlaneAxis.X:
                    origin = new XYZ(offset, 0, 0);
                    along = XYZ.BasisY;
                    across = XYZ.BasisZ;
                    break;
                case PlaneAxis.Y:
                    origin = new XYZ(0, offset, 0);
                    along = XYZ.BasisX;
                    across = XYZ.BasisZ;
                    break;
                default:
                    origin = new XYZ(0, 0, offset);
                    along = XYZ.BasisX;
                    across = XYZ.BasisY;
                    break;
            }

            // NewReferencePlane takes absolute points, not directions: the plane runs through
            // the bubble/free ends and a third point offset inside the same plane. Passing a
            // unit vector as the cut direction skewed the plane and made every dimension on
            // it unsatisfiable.
            var bubbleEnd = origin - along * halfLength;
            var freeEnd = origin + along * halfLength;
            var thirdPoint = freeEnd + across * halfLength;

            var plane = document.FamilyCreate.NewReferencePlane2(bubbleEnd, freeEnd, thirdPoint, view);
            if (plane == null) return null;

            try { plane.Name = name; }
            catch { /* keep the generated name */ }

            return plane;
        }

        private static bool AddDimension(
            Document document,
            View view,
            ReferencePlane from,
            ReferencePlane to,
            XYZ start,
            XYZ end,
            Autodesk.Revit.DB.FamilyParameter label,
            List<string> warnings)
        {
            if (view == null) return false;

            try
            {
                if (start.DistanceTo(end) < 1.0 / 304.8) return false;

                var references = new ReferenceArray();
                references.Append(from.GetReference());
                references.Append(to.GetReference());

                var dimension = document.FamilyCreate.NewDimension(view, Line.CreateBound(start, end), references);
                if (dimension == null) return false;

                if (label != null)
                {
                    dimension.FamilyLabel = label;

                    // Revit silently refuses some dimensions: make that visible instead of
                    // shipping a family whose parameters drive nothing.
                    if (dimension.FamilyLabel == null)
                    {
                        warnings.Add($"Dimension \"{from.Name}\" → \"{to.Name}\" could not be labelled");
                        return false;
                    }
                }

                return true;
            }
            catch (Exception ex)
            {
                warnings.Add($"Dimension \"{from.Name}\" → \"{to.Name}\": {ex.Message}");
                return false;
            }
        }

        private static HashSet<ElementId> LabelledParameters(Document document)
        {
            var labelled = new HashSet<ElementId>();

            foreach (var dimension in new FilteredElementCollector(document)
                         .OfClass(typeof(Dimension))
                         .Cast<Dimension>())
            {
                try
                {
                    var label = dimension.FamilyLabel;
                    if (label != null) labelled.Add(label.Id);
                }
                catch
                {
                    // Some template dimensions (radial, angular, multi-segment) cannot carry a
                    // label and throw when asked for one.
                }
            }

            return labelled;
        }

    }
}
