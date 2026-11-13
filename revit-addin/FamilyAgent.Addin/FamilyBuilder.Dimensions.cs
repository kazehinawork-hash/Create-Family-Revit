using System;
using System.Collections.Generic;
using System.Linq;
using System.Text;
using System.Text.RegularExpressions;
using Autodesk.Revit.DB;
using FamilyAgent.Core;
using Newtonsoft.Json;
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
            PlaneSkeleton skeleton,
            List<IPlaneDimension> pending,
            List<string> warnings)
        {
            if (pending == null || pending.Count == 0) return 0;

            // A formula parameter may only label a free plane: Revit refuses to change a
            // parameter that a form is already aligned to and rolls the dimension back.
            if (skeleton != null)
            {
                var allowed = new List<IPlaneDimension>(pending.Count);
                foreach (var dimension in pending)
                {
                    var plane = dimension as PlaneDimension;
                    var label = plane?.Label;
                    if (label != null &&
                        !string.IsNullOrWhiteSpace(label.Formula) &&
                        (skeleton.IsUsed(plane.From) || skeleton.IsUsed(plane.To)))
                    {
                        warnings.Add(
                            $"Skipped formula dimension \"{label.Definition?.Name}\": its plane is locked to a form.");
                        continue;
                    }

                    allowed.Add(dimension);
                }

                pending = allowed;
                if (pending.Count == 0) return 0;
            }

            // Fast path: the whole skeleton in one transaction. Revit rejects a dimension
            // whose label is a formula parameter, and one rejection rolls the whole batch
            // back, so a failure here falls through to the per-dimension path below.
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

            var created = 0;
            foreach (var dimension in pending)
            {
                // One transaction per dimension: a label Revit refuses then costs only that
                // dimension instead of rolling the whole plane skeleton back.
                var failures = new FailureCollector();
                try
                {
                    using (var transaction = SilentTransaction(
                               document, "Family Agent — reference dimension", failures))
                    {
                        transaction.Start();

                        var scratch = new List<string>();
                        var added = dimension.Create(document, scratch);
                        var status = transaction.Commit();

                        if (!added || status != TransactionStatus.Committed)
                        {
                            var reason = failures.Messages.FirstOrDefault() ?? status.ToString();
                            warnings.Add($"Dimension \"{dimension.Name}\" was rejected: {reason}");
                            continue;
                        }

                        created += 1;
                    }
                }
                catch (Exception ex)
                {
                    warnings.Add($"Dimension \"{dimension.Name}\" was rejected: {ex.Message}");
                }
            }

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
                    // Extrusions, blends and revolutions all derive from GenericForm; the
                    // blend/revolution cases still get the axis-aligned faces they expose.
                    var solidForm = form as GenericForm;
                    if (solidForm == null || !solidForm.IsSolid) continue;

                    var faces = new List<FaceCandidate>();
                    CollectFaces(form, options, skeleton, faces);

                    ResolvedPart part = null;
                    if (partByForm != null) partByForm.TryGetValue(form.Id.Value, out part);

                    // The connector-host tab is a 2 mm plate that only carries the connector
                    // coordinate system. Aligning its faces makes Revit report "Base sketch
                    // for extrusion is invalid" as soon as a driver moves, so leave it free.
                    if (part != null && !string.IsNullOrEmpty(part.Id) &&
                        part.Id.StartsWith("connector-host-", StringComparison.OrdinalIgnoreCase))
                    {
                        continue;
                    }

                    foreach (PlaneAxis axis in new[] { PlaneAxis.X, PlaneAxis.Y, PlaneAxis.Z })
                    {
                        var view = axis == PlaneAxis.Z ? skeleton.Elevation : skeleton.Plan;
                        if (view == null) continue;

                        var onAxis = faces
                            .Where(face => face.Axis == axis && face.Plane != null && face.Face?.Reference != null)
                            .ToList();
                        if (onAxis.Count < 2) continue;

                        // Lock BOTH extremes, not only the outer face. A slanted edge only
                        // follows its parameters when both of its end planes are attached;
                        // constraining one side leaves the sketch the wrong size, and Revit
                        // then deletes the extrusion ("Base sketch for extrusion is invalid").
                        var low = onAxis.OrderBy(face => face.Coordinate).First();
                        var high = onAxis.OrderByDescending(face => face.Coordinate).First();

                        foreach (var candidate in new[] { low, high })
                        {
                            var planeKey = ConstraintGraph.PlaneKey(candidate.Plane);
                            var faceKey = ConstraintGraph.FaceKey(document, candidate.Face.Reference);
                            if (skeleton.Constraints.WouldOverconstrain(planeKey, faceKey))
                            {
                                warnings.Add($"Skipped overconstraining lock \"{form.Name}\" ({axis})");
                                continue;
                            }

                            try
                            {
                                document.FamilyCreate.NewAlignment(
                                    view, candidate.Plane.GetReference(), candidate.Face.Reference);
                                skeleton.Constraints.Connect(planeKey, faceKey);
                                candidate.Entry.Used = true;
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
        /// Union-find over plane/face constraints. A dimension or alignment may only join
        /// two components that are not connected yet; joining the same component is the
        /// "Dimension overconstrains the Family" cycle Revit reports in Family Types.
        /// </summary>
        private sealed class ConstraintGraph
        {
            private readonly Dictionary<string, string> _parent =
                new Dictionary<string, string>(StringComparer.Ordinal);

            public static string PlaneKey(ReferencePlane plane) => "plane:" + plane.UniqueId;

            public static string FaceKey(Document document, Reference reference)
            {
                try
                {
                    return "face:" + reference.ConvertToStableRepresentation(document);
                }
                catch
                {
                    return "face:" + reference.ElementId.Value;
                }
            }

            private string Find(string key)
            {
                if (!_parent.TryGetValue(key, out var parent))
                {
                    _parent[key] = key;
                    return key;
                }

                if (parent == key) return key;
                var root = Find(parent);
                _parent[key] = root;
                return root;
            }

            public bool WouldOverconstrain(string a, string b)
            {
                return Find(a) == Find(b);
            }

            public void Connect(string a, string b)
            {
                var ra = Find(a);
                var rb = Find(b);
                if (ra != rb) _parent[ra] = rb;
            }
        }

        /// <summary>
        /// Dimensions between two faces of the same solid whose distance equals a parameter,
        /// labelled with that parameter. Thicknesses and local widths ("Glass Thickness",
        /// "Door Width") never sit on a datum plane, so this is the only way they can drive
        /// geometry. Only same-solid pairs are used: cross-part dimensions would fight the
        /// alignment locks and make Revit roll the rebuild back.
        /// </summary>
        /// <summary>
        /// Maps each parameter to the parts/cuts whose expressions reference it, then
        /// propagates through formula parameters. Without this map a face dimension can
        /// label the first face pair with the same value, e.g. Rung Height on a flange.
        /// </summary>
        private static Dictionary<string, HashSet<string>> ParameterPartDependencies(FamilySpec spec)
        {
            var map = new Dictionary<string, HashSet<string>>(StringComparer.OrdinalIgnoreCase);

            foreach (var part in spec.Parts ?? new List<FamilyPart>())
            {
                if (part == null || string.IsNullOrWhiteSpace(part.Id)) continue;

                var json = JsonConvert.SerializeObject(new
                {
                    part.Solid,
                    part.Cuts,
                    part.Array,
                    part.Anchor,
                });

                foreach (Match match in Regex.Matches(json, @"\[([^\]]+)\]"))
                {
                    var name = match.Groups[1].Value.Trim();
                    if (name.Length == 0) continue;

                    if (!map.TryGetValue(name, out var parts))
                    {
                        parts = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
                        map[name] = parts;
                    }
                    parts.Add(part.Id);
                }
            }

            var formulas = (spec.Parameters ?? new List<FamilyAgent.Core.FamilyParameter>())
                .Where(parameter => parameter != null && !string.IsNullOrWhiteSpace(parameter.Formula))
                .ToList();

            var changed = true;
            var guard = 0;
            while (changed && guard < 20)
            {
                changed = false;
                guard += 1;

                foreach (var parameter in formulas)
                {
                    if (!map.TryGetValue(parameter.Name, out var parts) || parts.Count == 0) continue;

                    List<string> dependencies;
                    try
                    {
                        dependencies = Expression.Dependencies(parameter.Formula);
                    }
                    catch
                    {
                        continue;
                    }

                    foreach (var dependency in dependencies)
                    {
                        if (!map.TryGetValue(dependency, out var target))
                        {
                            target = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
                            map[dependency] = target;
                        }

                        foreach (var part in parts)
                        {
                            if (target.Add(part)) changed = true;
                        }
                    }
                }
            }

            return map;
        }

        private static int CreateFaceDimensions(
            Document document,
            FamilySpec spec,
            PlaneSkeleton skeleton,
            IList<Element> forms,
            IDictionary<long, ResolvedPart> partByForm,
            CoreParameterSet parameters,
            HashSet<string> lockedFormAxes,
            out HashSet<string> solved,
            List<string> warnings)
        {
            solved = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            if (skeleton == null || forms == null || forms.Count == 0) return 0;
            if (skeleton.Plan == null && skeleton.Elevation == null) return 0;

            var graph = skeleton.Constraints ?? new ConstraintGraph();
            var options = new Options { ComputeReferences = true, DetailLevel = ViewDetailLevel.Fine };
            var dependencies = ParameterPartDependencies(spec);
            var perForm = new List<(long Id, string PartId, Dictionary<PlaneAxis, List<FaceCandidate>> Faces)>();

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
                if (byAxis.Values.Any(list => list.Count > 1))
                {
                    var partId = partByForm != null &&
                                 partByForm.TryGetValue(form.Id.Value, out var sourcePart)
                        ? sourcePart.Id
                        : null;

                    // The connector stub is already dimensioned by its host-plane locks.
                    // A second face dimension on its width would be a duplicate constraint.
                    if (!string.IsNullOrEmpty(partId) &&
                        partId.StartsWith("connector-host-", StringComparison.OrdinalIgnoreCase))
                    {
                        continue;
                    }

                    perForm.Add((form.Id.Value, partId, byAxis));
                }
            }

            if (perForm.Count == 0) return 0;

            var created = 0;
            var failures = new FailureCollector();

            try
            {
                using (var transaction = SilentTransaction(document, "Family Agent — driving dimensions", failures))
                {
                    transaction.Start();

                    foreach (var parameter in parameters.Ordered)
                    {
                        if (!IsType(parameter.Type, "Length")) continue;
                        if (!parameter.Number.HasValue) continue;
                        if (solved.Contains(parameter.Name)) continue;

                        var value = Math.Abs(parameter.Number.Value);
                        if (value < 1) continue;

                        // One unlabelable parameter must not stop the rest: Revit throws null
                        // reference and overconstraint failures per form, and the outer catch
                        // used to abort every remaining parameter.
                        try
                        {
                            var familyParameter = FindParameter(document.FamilyManager, parameter.Name);
                            if (familyParameter == null) continue;

                            // The plane-to-plane dimension already drives this parameter; a
                            // face dimension on the same value is the duplicate Revit reports
                            // as "overconstrains the Family".
                            if (skeleton.Driving.Contains(parameter.Name, StringComparer.OrdinalIgnoreCase))
                            {
                                continue;
                            }

                            var axis = AxisFor(parameter.Name, parameter.Axis);
                            dependencies.TryGetValue(parameter.Name, out var targetParts);

                            var searchForms = perForm;
                            if (targetParts != null && targetParts.Count > 0)
                            {
                                // Prefer the parts whose expressions reference this parameter,
                                // but keep every other form as a fallback: the value may live
                                // on a derived/split form that the expression map cannot see.
                                var preferred = perForm
                                    .Where(form => !string.IsNullOrEmpty(form.PartId) &&
                                                   targetParts.Contains(form.PartId))
                                    .ToList();
                                var others = perForm.Except(preferred).ToList();
                                searchForms = preferred.Concat(others).ToList();
                            }

                            var done = false;
                            foreach (var candidateAxis in new[] { axis, PlaneAxis.X, PlaneAxis.Y, PlaneAxis.Z })
                            {
                                if (done) break;

                                var view = candidateAxis == PlaneAxis.Z ? skeleton.Elevation : skeleton.Plan;
                                if (view == null) continue;

                                foreach (var form in searchForms)
                                {
                                    if (!form.Faces.TryGetValue(candidateAxis, out var faces)) continue;
                                    if (faces == null || faces.Count < 2) continue;

                                    for (var i = 0; i < faces.Count && !done; i += 1)
                                    {
                                        for (var j = i + 1; j < faces.Count && !done; j += 1)
                                        {
                                            var distance = Math.Abs(faces[j].Coordinate - faces[i].Coordinate);
                                            if (Math.Abs(distance - Ft(value)) > 0.05 / MmPerFoot) continue;

                                            if (TryLabelPair(
                                                    document, view, faces[i], faces[j],
                                                    familyParameter, graph, warnings))
                                            {
                                                created += 1;
                                                solved.Add(parameter.Name);
                                                done = true;
                                            }
                                        }
                                    }

                                    if (done) break;
                                }
                            }

                            // Cross-part parameters (relief gap, rung height, upper run) live
                            // between two forms. Only use forms whose part expressions name
                            // this parameter: a global fallback attaches the label to an
                            // unrelated form and locks the wrong geometry.
                            if (!done && targetParts != null && targetParts.Count > 0)
                            {
                                var targetForms = perForm
                                    .Where(form => !string.IsNullOrEmpty(form.PartId) &&
                                                   targetParts.Contains(form.PartId))
                                    .ToList();

                                foreach (var candidateAxis in new[] { axis, PlaneAxis.X, PlaneAxis.Y, PlaneAxis.Z })
                                {
                                    if (done) break;

                                    var view = candidateAxis == PlaneAxis.Z ? skeleton.Elevation : skeleton.Plan;
                                    if (view == null) continue;

                                    var flat = new List<(long FormId, FaceCandidate Face)>();
                                    foreach (var form in targetForms)
                                    {
                                        if (!form.Faces.TryGetValue(candidateAxis, out var faces)) continue;
                                        if (faces == null) continue;
                                        foreach (var face in faces) flat.Add((form.Id, face));
                                    }

                                    for (var i = 0; i < flat.Count && !done; i += 1)
                                    {
                                        for (var j = i + 1; j < flat.Count && !done; j += 1)
                                        {
                                            if (flat[i].FormId == flat[j].FormId) continue;

                                            var distance = Math.Abs(
                                                flat[j].Face.Coordinate - flat[i].Face.Coordinate);
                                            if (Math.Abs(distance - Ft(value)) > 0.05 / MmPerFoot) continue;

                                            if (TryLabelPair(
                                                    document, view, flat[i].Face, flat[j].Face,
                                                    familyParameter, graph, warnings))
                                            {
                                                created += 1;
                                                solved.Add(parameter.Name);
                                                done = true;
                                            }
                                        }
                                    }
                                }
                            }
                        }
                        catch (Exception ex)
                        {
                            warnings.Add($"Face dimension \"{parameter.Name}\" failed: {ex.Message}");
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
            if (skeleton == null || skeleton.Plan == null || forms == null || forms.Count == 0) return 0;

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
            ConstraintGraph graph,
            List<string> warnings)
        {
            if (document == null || view == null || label == null || graph == null) return false;
            if (a?.Face == null || b?.Face == null) return false;
            if (a.Face.Reference == null || b.Face.Reference == null) return false;

            var from = a.Coordinate <= b.Coordinate ? a : b;
            var to = from == a ? b : a;

            var fromKey = ConstraintGraph.FaceKey(document, from.Face.Reference);
            var toKey = ConstraintGraph.FaceKey(document, to.Face.Reference);
            if (graph.WouldOverconstrain(fromKey, toKey))
            {
                warnings.Add(
                    $"Skipped overconstraining face dimension \"{label.Definition?.Name}\"");
                return false;
            }

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

                    // Catch an overconstraint immediately instead of leaving it for the
                    // first Family Types edit to fail with 29 modal errors.
                    document.Regenerate();

                    if (step.Commit() != TransactionStatus.Committed)
                    {
                        return false;
                    }

                    graph.Connect(fromKey, toKey);
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
        /// Flexes every driver the way the user would in the type dialog and keeps only the
        /// constraints Revit can honour. A family that cannot maintain its locks or faces
        /// must not ship: it would fail to load, or refuse every parameter edit in a project.
        /// Returns the probe report and the mode that survived.
        /// </summary>
        private static string ValidateConstraints(
            Document document,
            CoreParameterSet parameters,
            List<string> warnings,
            bool formLocked,
            out string mode,
            out int probeFailures)
        {
            var report = new StringBuilder();
            probeFailures = 0;

            report.Append(ProbeFlex(document, parameters, out var failed));
            probeFailures = failed.Count;
            if (failed.Count == 0)
            {
                mode = formLocked ? "constraints" : "planes";
                return report.ToString();
            }

            // Face locks and face dimensions move form geometry. When Revit refuses them the
            // failure surfaces as "Unable to maintain shape offsets" or an invalid base
            // sketch, so drop those constraints and keep the plane dimensions.
            var firstFailed = new List<string>(failed);
            var droppedForms = RemoveDimensions(document, warnings, dimension => ReferencesForm(document, dimension));
            report.Append("dropped-form-dims=").Append(droppedForms).Append("; ");

            report.Append(ProbeFlex(document, parameters, out failed));
            probeFailures = failed.Count;
            if (failed.Count == 0)
            {
                if (droppedForms > 0)
                {
                    warnings.Add(
                        $"Revit không giữ được hình khi đổi {string.Join(", ", firstFailed.Take(4))}: " +
                        $"đã bỏ {droppedForms} ràng buộc mặt, giữ dimension theo reference plane.");
                }

                mode = "planes";
                return report.ToString();
            }

            warnings.Add(
                "Revit không dựng lại được hình khi đổi " + string.Join(", ", failed.Take(5)) +
                ": đã bỏ toàn bộ dimension, family chỉ cập nhật qua rebuild từ spec.");
            RemoveDimensions(document, warnings, dimension => true);
            mode = "rebuild";
            return report.ToString();
        }

        /// <summary>
        /// Runs every driver through the full factor range and reports the ones Revit could
        /// not regenerate: a resolved warning ("automatically resolved", "Can't make
        /// Extrusion") counts as a failure, because Revit gets there by deleting geometry.
        /// Each probe is rolled back, so the family keeps its values.
        /// </summary>
        private static string ProbeFlex(
            Document document,
            CoreParameterSet parameters,
            out List<string> failed)
        {
            var report = new StringBuilder();
            failed = new List<string>();

            var manager = document.FamilyManager;
            var currentType = manager.CurrentType;
            if (currentType == null) return "no current type; ";

            var before = ModelSignature(document);

            // Every driver must survive the full range the type dialog can produce, not just
            // a gentle nudge: 300 -> 600 doubles it, 400 -> 300 shrinks it by a quarter.
            var factors = new[] { 0.5, 0.67, 1.5, 2.0 };

            foreach (var parameter in parameters.Ordered)
            {
                if (!IsType(parameter.Type, "Length")) continue;
                if (!string.IsNullOrWhiteSpace(parameter.Formula)) continue;
                if (!parameter.Number.HasValue) continue;

                var familyParameter = FindParameter(manager, parameter.Name);
                if (familyParameter == null) continue;

                var current = currentType.AsDouble(familyParameter);
                if (!current.HasValue || Math.Abs(current.Value) < 1e-9) continue;

                var label = parameter.Name + ": ";
                var moved = false;
                var probeFailures = new List<string>();

                foreach (var factor in factors)
                {
                    var failures = new FailureCollector();
                    try
                    {
                        using (var transaction = SilentTransaction(
                                   document, "Family Agent — flex probe", failures))
                        {
                            transaction.Start();
                            manager.Set(familyParameter, current.Value * factor + 0.001);
                            document.Regenerate();

                            if (Math.Abs(before - ModelSignature(document)) > 1e-9) moved = true;

                            // Roll back: the probe only measures, the family keeps its values.
                            var status = transaction.RollBack();
                            if (status != TransactionStatus.RolledBack)
                            {
                                probeFailures.Add($"rollback={status}");
                            }
                        }
                    }
                    catch (Exception ex)
                    {
                        probeFailures.Add(ex.Message);
                    }

                    foreach (var message in failures.Messages)
                    {
                        probeFailures.Add(message);
                    }
                }

                report.Append(label).Append(moved ? "MOVE" : "still");

                if (probeFailures.Count > 0)
                {
                    failed.Add(parameter.Name);
                    report.Append(" failures=").Append(probeFailures.Count)
                        .Append(' ').Append(string.Join(" | ", probeFailures.Take(2)));
                }

                report.Append("; ");
            }

            return report.ToString();
        }

        /// <summary>Deletes the dimensions matching the filter, in one silent transaction.</summary>
        private static int RemoveDimensions(
            Document document,
            List<string> warnings,
            Func<Dimension, bool> predicate)
        {
            var ids = new List<ElementId>();
            foreach (var dimension in new FilteredElementCollector(document)
                         .OfClass(typeof(Dimension))
                         .Cast<Dimension>())
            {
                try
                {
                    if (!predicate(dimension)) continue;
                    ids.Add(dimension.Id);
                }
                catch
                {
                    // Template dimensions can refuse a read; they are left untouched.
                }
            }

            if (ids.Count == 0) return 0;

            var deleted = 0;
            try
            {
                using (var transaction = SilentTransaction(
                           document, "Family Agent — drop rejected dimensions", new FailureCollector()))
                {
                    transaction.Start();
                    foreach (var id in ids)
                    {
                        try
                        {
                            if (document.GetElement(id) == null) continue;
                            document.Delete(id);
                            deleted += 1;
                        }
                        catch
                        {
                            // A template-owned dimension may be undeletable; keep going.
                        }
                    }
                    transaction.Commit();
                }
            }
            catch (Exception ex)
            {
                warnings.Add("Could not drop rejected dimensions: " + ex.Message);
            }

            return deleted;
        }

        /// <summary>
        /// Three-reference dimension with AreSegmentsEqual on: Revit's "EQ" constraint,
        /// which keeps a centred parameter symmetric about the middle reference plane.
        /// </summary>
        private static bool AddEqualDimension(
            Document document,
            View view,
            ReferencePlane low,
            ReferencePlane center,
            ReferencePlane high,
            XYZ start,
            XYZ middle,
            XYZ end,
            List<string> warnings)
        {
            if (document == null || view == null || low == null || center == null || high == null) return false;

            try
            {
                using (var step = new SubTransaction(document))
                {
                    step.Start();

                    var references = new ReferenceArray();
                    references.Append(low.GetReference());
                    references.Append(center.GetReference());
                    references.Append(high.GetReference());

                    var dimension = document.FamilyCreate.NewDimension(
                        view, Line.CreateBound(start, end), references);
                    if (dimension == null)
                    {
                        step.RollBack();
                        return false;
                    }

                    dimension.AreSegmentsEqual = true;
                    document.Regenerate();

                    if (step.Commit() != TransactionStatus.Committed) return false;
                    return true;
                }
            }
            catch (Exception ex)
            {
                if (warnings.Count < 40) warnings.Add($"EQ dimension \"{low.Name} / {high.Name}\": {ex.Message}");
                return false;
            }
        }

        /// <summary>
        /// True when a dimension ties form geometry (a face or an edge) instead of two
        /// reference planes — those are the ones Revit cannot always honour on baked forms.
        /// </summary>
        private static bool ReferencesForm(Document document, Dimension dimension)
        {
            foreach (var item in dimension.References)
            {
                var reference = item as Reference;
                if (reference == null) continue;

                var element = document.GetElement(reference.ElementId);
                if (element != null && !(element is ReferencePlane)) return true;
            }
            return false;
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
                    .Cast<Element>())
                .Concat(new FilteredElementCollector(document)
                    .OfClass(typeof(Form))
                    .Cast<Element>()
                    .Where(element => element.GetType() == typeof(Form)))
                .Concat(new FilteredElementCollector(document)
                    .OfClass(typeof(SweptBlend))
                    .Cast<Element>())
                .Concat(new FilteredElementCollector(document)
                    .OfClass(typeof(FreeFormElement))
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

        /// <summary>A queued reference-plane dimension, created after the locks exist.</summary>
        private interface IPlaneDimension
        {
            string Name { get; }
            bool Create(Document document, List<string> warnings);
        }

        private sealed class PlaneDimension : IPlaneDimension
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

            public Autodesk.Revit.DB.FamilyParameter Label => _label;
            public ReferencePlane From => _from;
            public ReferencePlane To => _to;

            public bool Create(Document document, List<string> warnings)
            {
                return AddDimension(document, _view, _from, _to, _start, _end, _label, warnings);
            }
        }

        /// <summary>
        /// An unlabelled EQ chain across three planes. Paired with the labelled overall
        /// dimension it keeps a symmetric parameter centred instead of letting one side
        /// drift, and because it only touches reference planes it can never overconstrain
        /// the form faces.
        /// </summary>
        private sealed class EqualPlaneDimension : IPlaneDimension
        {
            private readonly View _view;
            private readonly ReferencePlane _low;
            private readonly ReferencePlane _center;
            private readonly ReferencePlane _high;
            private readonly XYZ _start;
            private readonly XYZ _middle;
            private readonly XYZ _end;

            public EqualPlaneDimension(
                View view,
                ReferencePlane low,
                ReferencePlane center,
                ReferencePlane high,
                XYZ start,
                XYZ middle,
                XYZ end)
            {
                _view = view;
                _low = low;
                _center = center;
                _high = high;
                _start = start;
                _middle = middle;
                _end = end;
            }

            public string Name => $"{_low.Name} = {_high.Name} (EQ)";

            public bool Create(Document document, List<string> warnings)
            {
                return AddEqualDimension(
                    document, _view, _low, _center, _high, _start, _middle, _end, warnings);
            }
        }

        private static PlaneAxis AxisFor(string name, string explicitAxis = null)
        {
            var requested = (explicitAxis ?? string.Empty).Trim().ToLowerInvariant();
            if (requested == "x") return PlaneAxis.X;
            if (requested == "y") return PlaneAxis.Y;
            if (requested == "z") return PlaneAxis.Z;

            var text = (name ?? string.Empty).ToLowerInvariant();

            if (text.Contains("width") || text.Contains("length") || text.Contains("left") ||
                text.Contains("right") || text.Contains("rộng") || text.Contains("ngang") ||
                text.Contains("dài") || text.Contains("trái") || text.Contains("phải"))
                return PlaneAxis.X;
            if (text.Contains("depth") || text.Contains("front") || text.Contains("back") ||
                text.Contains("sâu") || text.Contains("trước") || text.Contains("sau"))
                return PlaneAxis.Y;
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
