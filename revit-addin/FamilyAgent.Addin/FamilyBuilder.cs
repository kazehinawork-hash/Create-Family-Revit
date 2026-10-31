using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Text;
using Autodesk.Revit.ApplicationServices;
using Autodesk.Revit.DB;
using Autodesk.Revit.UI;
using FamilyAgent.Core;
using CoreParameterSet = FamilyAgent.Core.ParameterSet;

namespace FamilyAgent.Addin
{
    public sealed class BuildResult
    {
        public bool Ok { get; set; }
        public string Path { get; set; }
        public string RevitVersion { get; set; }
        public List<string> Warnings { get; set; } = new List<string>();
        public string Error { get; set; }
        public object Stats { get; set; }
    }

    internal static partial class FamilyBuilder
    {
        private const double MmPerFoot = 304.8;
        private const double DegToRad = Math.PI / 180.0;

        /// <summary>
        /// Diagnostic: opens a built .rfa, changes one parameter and reports whether the
        /// geometry rebuilt. Proves the constraints really flex in the saved file.
        /// </summary>
        public static object Inspect(UIApplication uiApp, string path, string parameter, double percent)
        {
            if (string.IsNullOrWhiteSpace(path) || !File.Exists(path))
                throw new FileNotFoundException("Family not found", path);

            // Headless open: the document can be closed reliably, unlike a UI tab opened
            // with OpenAndActivateDocument which keeps the .rfa locked for the next build.
            var document = uiApp.Application.OpenDocumentFile(path);

            try
            {
                var manager = document.FamilyManager;
                var planes = new FilteredElementCollector(document)
                    .OfClass(typeof(ReferencePlane))
                    .Cast<ReferencePlane>()
                    .ToList();
                var dimensions = new FilteredElementCollector(document)
                    .OfClass(typeof(Dimension))
                    .Cast<Dimension>()
                    .ToList();

                var labelled = 0;
                var labelledNames = new List<string>();
                foreach (var dimension in dimensions)
                {
                    try
                    {
                        var label = dimension.FamilyLabel;
                        if (label == null) continue;
                        labelled += 1;
                        labelledNames.Add(label.Definition?.Name ?? "?");
                    }
                    catch
                    {
                        // Some dimension types cannot carry a label.
                    }
                }

                var parameterNames = new List<string>();
                foreach (Autodesk.Revit.DB.FamilyParameter candidate in manager.Parameters)
                {
                    try
                    {
                        if (candidate.Definition != null) parameterNames.Add(candidate.Definition.Name);
                    }
                    catch
                    {
                        // Ignore stale parameters.
                    }
                }

                var familyParameter = FindParameter(manager, parameter);
                if (familyParameter == null)
                {
                    return new
                    {
                        ok = false,
                        error = $"Parameter \"{parameter}\" not found in {Path.GetFileName(path)}",
                        planes = planes.Count,
                        dimensions = dimensions.Count,
                        labelled,
                        labelledNames,
                        parameterNames,
                        pinned = planes.Count(plane => plane.Pinned),
                    };
                }

                var current = document.FamilyManager.CurrentType?.AsDouble(familyParameter) ?? 0;
                var before = ModelSignature(document);
                var moved = false;
                var commit = "n/a";

                using (var transaction = new Transaction(document, "Family Agent — inspect"))
                {
                    transaction.Start();
                    manager.Set(familyParameter, current * (1.0 + percent / 100.0) + 0.001);
                    document.Regenerate();
                    moved = Math.Abs(before - ModelSignature(document)) > 1e-9;
                    commit = transaction.RollBack().ToString();
                }

                return new
                {
                    ok = true,
                    parameter,
                    valueMm = Math.Round(current * MmPerFoot, 1),
                    percent,
                    commit,
                    moved,
                    planes = planes.Count,
                    pinned = planes.Count(plane => plane.Pinned),
                    dimensions = dimensions.Count,
                    labelled,
                    labelledNames,
                    parameterNames,
                };
            }
            finally
            {
                try
                {
                    document.Close(false);
                }
                catch
                {
                    // Fall through to the UI close below.
                }

                try
                {
                    var stillOpen = uiApp.Application.Documents
                        .Cast<Document>()
                        .Any(open => string.Equals(open.PathName, path, StringComparison.OrdinalIgnoreCase));

                    if (stillOpen) uiApp.ActiveUIDocument?.SaveAndClose();
                }
                catch
                {
                    // Leave it open rather than crash the inspect.
                }
            }
        }

        public static BuildResult Build(Application app, string json)
        {
            var started = DateTime.UtcNow;
            var result = new BuildResult { RevitVersion = app.VersionNumber };
            Document document = null;
            var stage = "reading the spec";
            var buildFailures = new FailureCollector();

            try
            {
                var spec = SpecLoader.Load(json);
                var parameters = ParameterResolver.Resolve(spec);
                var model = GeometryResolver.Resolve(spec, parameters);
                var materials = MaterialLookup(spec);
                result.Warnings.AddRange(model.Warnings);

                if (model.Parts.Count == 0)
                    throw new InvalidOperationException(
                        "No geometry could be resolved from the spec. " + string.Join(" ", model.Warnings));

                stage = "opening the family template";
                var template = TemplateCatalog.Resolve(app, spec);
                document = app.NewFamilyDocument(template);

                PlaneSkeleton skeleton;
                List<Element> forms;
                var partByForm = new Dictionary<long, ResolvedPart>();

                stage = "building the family";
                using (var transaction = SilentTransaction(document, "Family Agent — build family", buildFailures))
                {
                    transaction.Start();

                    var manager = document.FamilyManager;
                    CreateFamilyType(manager, spec);
                    CreateParameters(document, manager, parameters, result.Warnings);
                    skeleton = CreateReferencePlanes(document, manager, parameters, model, result.Warnings);
                    forms = CreateGeometry(document, model, materials, result.Warnings, partByForm);

                    var status = transaction.Commit();
                    if (status != TransactionStatus.Committed)
                    {
                        throw new InvalidOperationException(
                            $"Revit rolled the family back ({status}): {string.Join(" ", buildFailures.Messages.Take(5))}");
                    }
                }

                foreach (var message in buildFailures.Messages.Take(5)) result.Warnings.Add(message);

                stage = "dimensioning the reference planes";
                var refDimensions = CreateDimensions(document, skeleton.Dimensions, result.Warnings);

                stage = "locking the geometry to the reference planes";
                var locks = LockGeometry(document, skeleton, forms, partByForm, out var lockedFormAxes, result.Warnings);

                stage = "dimensioning the part faces";
                var faceDimensions = CreateFaceDimensions(
                    document, skeleton, forms, parameters, lockedFormAxes, out var solvedFaces, result.Warnings);
                var radialDimensions = CreateRadialDimensions(
                    document, skeleton, forms, parameters, solvedFaces, result.Warnings);
                var inert = skeleton.Inert().Where(name => !solvedFaces.Contains(name)).ToList();

                stage = "self-checking the parameters";
                var flex = string.Empty;
                try
                {
                    flex = SelfCheck(document, parameters);
                }
                catch (Exception ex)
                {
                    flex = "error: " + ex.Message;
                }

                if (flex.Contains("still") || flex.Contains("X "))
                {
                    result.Warnings.Add("Flex check: " + flex);
                }

                result.Stats = new
                {
                    parts = model.Parts.Count,
                    instances = model.Instances,
                    forms = forms.Count(f => f is Extrusion),
                    voids = forms.Count(f => f is Extrusion extrusion && !extrusion.IsSolid),
                    refPlanes = skeleton.Created,
                    refDimensions,
                    locks,
                    lod = spec.Lod,
                    driving = skeleton.Driving,
                    unlabelled = skeleton.Unlabelled,
                    inert,
                    flex,
                    faceDimensions,
                    radialDimensions,
                    parameters = parameters.Ordered.Count,
                    bounds = new
                    {
                        x = Math.Round(model.Bounds.Size.X),
                        y = Math.Round(model.Bounds.Size.Y),
                        z = Math.Round(model.Bounds.Size.Z),
                    },
                    elapsedMs = (int)(DateTime.UtcNow - started).TotalMilliseconds,
                };

                stage = "saving the family";
                PrepareViews(document, spec.Lod);

                stage = "storing the spec";
                using (var transaction = new Transaction(document, "Family Agent — store spec"))
                {
                    transaction.Start();
                    SpecStore.Save(document, json);
                    transaction.Commit();
                }

                stage = "saving the family";
                var directory = OutputDirectory();
                Directory.CreateDirectory(directory);
                var path = Path.Combine(directory, Slug(spec.Name) + ".rfa");

                document.SaveAs(path, new SaveAsOptions { OverwriteExistingFile = true, MaximumBackups = 1 });
                result.Path = path;
                result.Ok = true;
            }
            catch (Exception ex)
            {
                result.Ok = false;
                result.Error = $"{stage}: {ex.Message}" +
                               (buildFailures.Messages.Count > 0
                                   ? " (" + string.Join(" ", buildFailures.Messages.Take(3)) + ")"
                                   : string.Empty);
            }
            finally
            {
                if (document != null)
                {
                    try { document.Close(false); }
                    catch { /* leave the document open rather than lose the result */ }
                }
            }

            return result;
        }

        /// <summary>
        /// Rebuilds the active family from the spec stored inside it, using the parameter
        /// values the user currently has in Revit. This is the parity path for behaviour the
        /// constraint solver cannot express: geometry is recomputed exactly like the studio
        /// preview instead of relying on a partial constraint graph.
        /// </summary>
        public static BuildResult Rebuild(UIApplication uiApp)
        {
            var document = uiApp?.ActiveUIDocument?.Document;
            if (document == null) throw new InvalidOperationException("Open a family document first.");
            return Rebuild(document);
        }

        public static BuildResult Rebuild(Document document)
        {
            var started = DateTime.UtcNow;
            if (document == null) throw new InvalidOperationException("Open a family document first.");
            if (!document.IsFamilyDocument) throw new InvalidOperationException("The active document is not a family.");

            var json = SpecStore.Load(document);
            if (string.IsNullOrWhiteSpace(json))
            {
                throw new InvalidOperationException(
                    "This family has no Family Agent spec stored. Build it from the studio first.");
            }

            var result = new BuildResult
            {
                RevitVersion = document.Application.VersionNumber,
                Path = document.PathName,
            };
            var stage = "reading the stored spec";
            var buildFailures = new FailureCollector();

            try
            {
                var spec = SpecLoader.Load(json);
                var overrides = CurrentValues(document);
                var parameters = ParameterResolver.Resolve(spec, overrides);
                var model = GeometryResolver.Resolve(spec, parameters);
                var materials = MaterialLookup(spec);
                result.Warnings.AddRange(model.Warnings);

                if (model.Parts.Count == 0)
                {
                    throw new InvalidOperationException(
                        "No geometry could be resolved from the stored spec. " + string.Join(" ", model.Warnings));
                }

                stage = "clearing the previous geometry";
                ClearGenerated(document, result.Warnings);

                PlaneSkeleton skeleton;
                List<Element> forms;
                var partByForm = new Dictionary<long, ResolvedPart>();

                stage = "rebuilding the family";
                using (var transaction = SilentTransaction(document, "Family Agent — rebuild family", buildFailures))
                {
                    transaction.Start();

                    var manager = document.FamilyManager;
                    CreateFamilyType(manager, spec);
                    CreateParameters(document, manager, parameters, result.Warnings);
                    skeleton = CreateReferencePlanes(document, manager, parameters, model, result.Warnings);
                    forms = CreateGeometry(document, model, materials, result.Warnings, partByForm);

                    var status = transaction.Commit();
                    if (status != TransactionStatus.Committed)
                    {
                        throw new InvalidOperationException(
                            $"Revit rolled the family back ({status}): {string.Join(" ", buildFailures.Messages.Take(5))}");
                    }
                }

                foreach (var message in buildFailures.Messages.Take(5)) result.Warnings.Add(message);

                stage = "dimensioning the reference planes";
                var refDimensions = CreateDimensions(document, skeleton.Dimensions, result.Warnings);

                stage = "locking the geometry to the reference planes";
                var locks = LockGeometry(document, skeleton, forms, partByForm, out var lockedFormAxes, result.Warnings);

                stage = "dimensioning the part faces";
                var faceDimensions = CreateFaceDimensions(
                    document, skeleton, forms, parameters, lockedFormAxes, out var solvedFaces, result.Warnings);
                var radialDimensions = CreateRadialDimensions(
                    document, skeleton, forms, parameters, solvedFaces, result.Warnings);
                var inert = skeleton.Inert().Where(name => !solvedFaces.Contains(name)).ToList();

                stage = "self-checking the parameters";
                var flex = string.Empty;
                try
                {
                    flex = SelfCheck(document, parameters);
                }
                catch (Exception ex)
                {
                    flex = "error: " + ex.Message;
                }

                if (flex.Contains("still") || flex.Contains("X "))
                {
                    result.Warnings.Add("Flex check: " + flex);
                }

                result.Stats = new
                {
                    parts = model.Parts.Count,
                    instances = model.Instances,
                    forms = forms.Count(f => f is Extrusion),
                    voids = forms.Count(f => f is Extrusion extrusion && !extrusion.IsSolid),
                    refPlanes = skeleton.Created,
                    refDimensions,
                    locks,
                    lod = spec.Lod,
                    driving = skeleton.Driving,
                    unlabelled = skeleton.Unlabelled,
                    inert,
                    flex,
                    faceDimensions,
                    radialDimensions,
                    parameters = parameters.Ordered.Count,
                    bounds = new
                    {
                        x = Math.Round(model.Bounds.Size.X),
                        y = Math.Round(model.Bounds.Size.Y),
                        z = Math.Round(model.Bounds.Size.Z),
                    },
                    elapsedMs = (int)(DateTime.UtcNow - started).TotalMilliseconds,
                };

                stage = "preparing views";
                PrepareViews(document, spec.Lod);

                stage = "storing the spec";
                using (var transaction = new Transaction(document, "Family Agent — store spec"))
                {
                    transaction.Start();
                    SpecStore.Save(document, json);
                    transaction.Commit();
                }

                result.Ok = true;
            }
            catch (Exception ex)
            {
                result.Ok = false;
                result.Error = $"{stage}: {ex.Message}" +
                               (buildFailures.Messages.Count > 0
                                   ? " (" + string.Join(" ", buildFailures.Messages.Take(3)) + ")"
                                   : string.Empty);
            }

            return result;
        }

        /// <summary>Current numeric values of the family, in spec units (mm, degrees).</summary>
        private static Dictionary<string, double> CurrentValues(Document document)
        {
            var values = new Dictionary<string, double>(StringComparer.OrdinalIgnoreCase);
            var manager = document.FamilyManager;
            var type = manager.CurrentType;
            if (type == null) return values;

            foreach (Autodesk.Revit.DB.FamilyParameter parameter in manager.Parameters)
            {
                try
                {
                    var name = parameter.Definition?.Name;
                    if (string.IsNullOrWhiteSpace(name)) continue;

                    if (parameter.StorageType == StorageType.Double)
                    {
                        var raw = type.AsDouble(parameter);
                        if (!raw.HasValue) continue;

                        var dataType = parameter.Definition?.GetDataType();
                        if (dataType == SpecTypeId.Length) values[name] = raw.Value * MmPerFoot;
                        else if (dataType == SpecTypeId.Angle) values[name] = raw.Value * 180.0 / Math.PI;
                        else values[name] = raw.Value;
                    }
                    else if (parameter.StorageType == StorageType.Integer)
                    {
                        var raw = type.AsInteger(parameter);
                        if (raw.HasValue) values[name] = raw.Value;
                    }
                }
                catch
                {
                    // Skip parameters the current type cannot read.
                }
            }

            return values;
        }

        /// <summary>Deletes the geometry and dimensions a previous build created.</summary>
        private static void ClearGenerated(Document document, List<string> warnings)
        {
            using (var transaction = new Transaction(document, "Family Agent — clear generated geometry"))
            {
                transaction.Start();

                var ids = new List<ElementId>();
                ids.AddRange(new FilteredElementCollector(document).OfClass(typeof(Dimension)).ToElementIds());
                ids.AddRange(new FilteredElementCollector(document).OfClass(typeof(Extrusion)).ToElementIds());
                ids.AddRange(new FilteredElementCollector(document).OfClass(typeof(Blend)).ToElementIds());
                ids.AddRange(new FilteredElementCollector(document).OfClass(typeof(Revolution)).ToElementIds());
                ids.AddRange(new FilteredElementCollector(document).OfClass(typeof(Sweep)).ToElementIds());
                ids.AddRange(new FilteredElementCollector(document).OfClass(typeof(CurveElement)).ToElementIds());
                ids.AddRange(new FilteredElementCollector(document).OfClass(typeof(ReferencePlane)).ToElementIds());

                foreach (var id in ids)
                {
                    try
                    {
                        if (document.GetElement(id) != null) document.Delete(id);
                    }
                    catch
                    {
                        // Template-owned planes/lines cannot be deleted; leaving them is harmless.
                    }
                }

                transaction.Commit();
            }
        }

        /// <summary>
        /// Templates open their 3D view in hidden line, which makes a solid family read as
        /// a wireframe. Save it shaded so the built family matches the studio preview, and
        /// follow the chosen LOD for the view detail level.
        /// </summary>
        private static void PrepareViews(Document document, int? lod)
        {
            var detail = lod == 200
                ? ViewDetailLevel.Coarse
                : lod == 400
                    ? ViewDetailLevel.Fine
                    : ViewDetailLevel.Medium;

            try
            {
                using (var transaction = new Transaction(document, "Family Agent — prepare views"))
                {
                    transaction.Start();

                    foreach (var view in new FilteredElementCollector(document)
                                 .OfClass(typeof(View3D))
                                 .Cast<View3D>()
                                 .Where(candidate => !candidate.IsTemplate && candidate.CanBePrinted))
                    {
                        view.DisplayStyle = DisplayStyle.ShadingWithEdges;
                        view.DetailLevel = detail;
                    }

                    transaction.Commit();
                }
            }
            catch
            {
                // View setup is cosmetic; never fail a build because of it.
            }
        }

        // ------------------------------------------------------------ parameters

        private static void CreateFamilyType(FamilyManager manager, FamilySpec spec)
        {
            try
            {
                if (!string.IsNullOrWhiteSpace(spec.TypeName))
                {
                    var type = manager.NewType(spec.TypeName.Trim());
                    manager.CurrentType = type;
                }
            }
            catch
            {
                // The template may already contain a type with that name.
            }

            // FamilyManager.Set writes through the current type. New templates usually have
            // one, but an empty family document can leave CurrentType null and every value
            // is then rejected with "There is no current type".
            if (manager.CurrentType != null) return;

            try
            {
                var existing = manager.Types.Cast<FamilyType>().FirstOrDefault();
                manager.CurrentType = existing ?? manager.NewType("Type 1");
            }
            catch
            {
                // Fall through: the build reports the rejected values.
            }
        }

        private static void CreateParameters(
            Document document,
            FamilyManager manager,
            CoreParameterSet parameters,
            List<string> warnings)
        {
            foreach (var parameter in parameters.Ordered)
            {
                if (!string.IsNullOrEmpty(parameter.Error))
                {
                    warnings.Add($"Parameter \"{parameter.Name}\" skipped: {parameter.Error}");
                    continue;
                }

                try
                {
                    var familyParameter = FindParameter(manager, parameter.Name);

                    if (familyParameter == null)
                    {
                        familyParameter = manager.AddParameter(
                            parameter.Name,
                            GroupFor(parameter.Group),
                            SpecFor(parameter.Type),
                            parameter.Instance);
                    }

                    if (familyParameter == null)
                    {
                        warnings.Add($"Parameter \"{parameter.Name}\" was not created by Revit");
                        continue;
                    }

                    ApplyValue(manager, familyParameter, parameter, warnings);
                }
                catch (Exception ex)
                {
                    warnings.Add($"Parameter \"{parameter.Name}\" was not created: {ex.Message}");
                }
            }
        }

        private static Autodesk.Revit.DB.FamilyParameter FindParameter(FamilyManager manager, string name)
        {
            foreach (Autodesk.Revit.DB.FamilyParameter parameter in manager.Parameters)
            {
                if (string.Equals(parameter.Definition?.Name, name, StringComparison.OrdinalIgnoreCase))
                {
                    return parameter;
                }
            }

            return null;
        }

        private static void ApplyValue(
            FamilyManager manager,
            Autodesk.Revit.DB.FamilyParameter target,
            ResolvedParameter parameter,
            List<string> warnings)
        {
            if (!string.IsNullOrWhiteSpace(parameter.Formula))
            {
                try
                {
                    manager.SetFormula(target, parameter.Formula);
                    return;
                }
                catch (Exception ex)
                {
                    warnings.Add(
                        $"Formula on \"{parameter.Name}\" was rejected ({ex.Message}); the computed value was used instead.");
                }
            }

            try
            {
                if (parameter.Text != null)
                {
                    manager.Set(target, parameter.Text);
                    return;
                }

                if (parameter.YesNo.HasValue)
                {
                    manager.Set(target, parameter.YesNo.Value ? 1 : 0);
                    return;
                }

                if (!parameter.Number.HasValue) return;
                var value = parameter.Number.Value;

                if (IsType(parameter.Type, "Length"))
                {
                    manager.Set(target, value / MmPerFoot);
                }
                else if (IsType(parameter.Type, "Angle"))
                {
                    manager.Set(target, value * DegToRad);
                }
                else if (IsType(parameter.Type, "Integer"))
                {
                    manager.Set(target, (int)Math.Round(value));
                }
                else
                {
                    manager.Set(target, value);
                }
            }
            catch (Exception ex)
            {
                warnings.Add($"Value for \"{parameter.Name}\" was rejected: {ex.Message}");
            }
        }

        private static ForgeTypeId GroupFor(string group)
        {
            switch ((group ?? string.Empty).Trim().ToLowerInvariant())
            {
                case "dimensions": return GroupTypeId.Geometry;
                case "constraints": return GroupTypeId.Constraints;
                case "identity data": return GroupTypeId.IdentityData;
                case "graphics": return GroupTypeId.Graphics;
                case "materials and finishes": return GroupTypeId.Materials;
                case "mechanical": return GroupTypeId.Mechanical;
                case "electrical": return GroupTypeId.Electrical;
                case "plumbing": return GroupTypeId.Plumbing;
                case "energy analysis": return GroupTypeId.EnergyAnalysis;
                case "structural": return GroupTypeId.Structural;
                case "construction": return GroupTypeId.Construction;
                case "visibility": return GroupTypeId.Visibility;
                case "fire protection": return GroupTypeId.FireProtection;
                case "general": return GroupTypeId.General;
                case "data": return GroupTypeId.Data;
                default: return GroupTypeId.Data;
            }
        }

        private static ForgeTypeId SpecFor(string type)
        {
            switch ((type ?? "Length").Trim().ToLowerInvariant())
            {
                case "angle": return SpecTypeId.Angle;
                case "number": return SpecTypeId.Number;
                case "integer": return SpecTypeId.Int.Integer;
                case "text": return SpecTypeId.String.Text;
                case "yesno": return SpecTypeId.Boolean.YesNo;
                default: return SpecTypeId.Length;
            }
        }

        private static bool IsType(string type, string expected) =>
            string.Equals(type ?? string.Empty, expected, StringComparison.OrdinalIgnoreCase);

        // --------------------------------------------------------- reference planes

        private enum PlaneAxis
        {
            X,
            Y,
            Z,
        }

        /// <summary>A reference plane that sits at a known coordinate on one axis.</summary>
        private sealed class SkeletonPlane
        {
            public PlaneAxis Axis;
            public double Coordinate;
            public ReferencePlane Plane;
            public bool Drives;
            /** True once a solid face is locked to this plane, i.e. the parameter moves geometry. */
            public bool Used;
        }

        /// <summary>
        /// Reference planes plus the dimensions that label them. Planes are placed on the
        /// coordinates the model actually occupies, so a face can be locked onto them and the
        /// labelled parameter really drives the solids.
        /// </summary>
        private sealed class PlaneSkeleton
        {
            public View Plan;
            public View Elevation;
            public int Created;
            public readonly List<SkeletonPlane> Planes = new List<SkeletonPlane>();
            public readonly List<PlaneDimension> Dimensions = new List<PlaneDimension>();
            public readonly List<string> Driving = new List<string>();
            public readonly List<string> Unlabelled = new List<string>();
            /** Parameter name -> the plane its dimension drives, so we can tell if it moves anything. */
            public readonly Dictionary<string, SkeletonPlane> DrivenPlanes =
                new Dictionary<string, SkeletonPlane>(StringComparer.OrdinalIgnoreCase);

            public SkeletonPlane FindEntry(PlaneAxis axis, double coordinate)
            {
                SkeletonPlane best = null;
                var bestDistance = 1.0 / MmPerFoot;

                foreach (var candidate in Planes)
                {
                    if (candidate.Axis != axis) continue;

                    var distance = Math.Abs(candidate.Coordinate - coordinate);
                    if (distance > bestDistance) continue;

                    best = candidate;
                    bestDistance = distance;
                }

                return best;
            }

            public List<string> Inert()
            {
                var inert = new List<string>();
                foreach (var pair in DrivenPlanes)
                {
                    if (!pair.Value.Used) inert.Add(pair.Key);
                }

                return inert;
            }

            public ReferencePlane Find(PlaneAxis axis, double coordinate)
            {
                SkeletonPlane best = null;
                var bestDistance = 1.0 / MmPerFoot;

                foreach (var candidate in Planes)
                {
                    if (candidate.Axis != axis) continue;

                    var distance = Math.Abs(candidate.Coordinate - coordinate);
                    if (distance > bestDistance) continue;

                    best = candidate;
                    bestDistance = distance;
                }

                return best?.Plane;
            }

            public bool Drives(PlaneAxis axis, double coordinate)
            {
                foreach (var candidate in Planes)
                {
                    if (candidate.Axis != axis || !candidate.Drives) continue;

                    // Tight tolerance: an alignment needs the face to sit exactly on the plane,
                    // a near miss makes NewAlignment throw "not geometrically aligned".
                    if (Math.Abs(candidate.Coordinate - coordinate) <= 0.05 / MmPerFoot) return true;
                }

                return false;
            }

            public void Register(PlaneAxis axis, double coordinate, ReferencePlane plane, bool drives)
            {
                foreach (var candidate in Planes)
                {
                    if (candidate.Axis != axis) continue;
                    if (Math.Abs(candidate.Coordinate - coordinate) > 1.0 / MmPerFoot) continue;

                    candidate.Drives |= drives;
                    return;
                }

                Planes.Add(new SkeletonPlane
                {
                    Axis = axis,
                    Coordinate = coordinate,
                    Plane = plane,
                    Drives = drives,
                });
            }
        }

        /// <summary>Coordinates the resolved model actually occupies, in millimetres.</summary>
        private sealed class CoordinateSet
        {
            private readonly Dictionary<PlaneAxis, List<double>> _values =
                new Dictionary<PlaneAxis, List<double>>
                {
                    { PlaneAxis.X, new List<double>() },
                    { PlaneAxis.Y, new List<double>() },
                    { PlaneAxis.Z, new List<double>() },
                };

            public void Add(ResolvedSolid solid, Vec3d offset)
            {
                var bounds = GeometryResolver.BoundsOf(solid);
                _values[PlaneAxis.X].Add(bounds.MinX + offset.X);
                _values[PlaneAxis.X].Add(bounds.MaxX + offset.X);
                _values[PlaneAxis.Y].Add(bounds.MinY + offset.Y);
                _values[PlaneAxis.Y].Add(bounds.MaxY + offset.Y);
                _values[PlaneAxis.Z].Add(bounds.MinZ + offset.Z);
                _values[PlaneAxis.Z].Add(bounds.MaxZ + offset.Z);
            }

            public bool Has(PlaneAxis axis, double millimeters)
            {
                foreach (var value in _values[axis])
                {
                    if (Math.Abs(value - millimeters) <= 1) return true;
                }

                return false;
            }

            public int Count(PlaneAxis axis, double millimeters)
            {
                var count = 0;
                foreach (var value in _values[axis])
                {
                    if (Math.Abs(value - millimeters) <= 1) count += 1;
                }

                return count;
            }
        }

        private static CoordinateSet ModelCoordinates(ResolvedModel model)
        {
            var coordinates = new CoordinateSet();

            foreach (var part in model.Parts)
            {
                for (var index = 0; index < Math.Max(1, part.ArrayCount); index += 1)
                {
                    coordinates.Add(part.Solid, ArrayOffsetMm(part, index));
                }
            }

            return coordinates;
        }

        /// <summary>
        /// Picks the axis a length parameter really measures along: the axis whose overall
        /// size matches the value, then the axis with the most faces sitting on it. Guessing
        /// from the name alone puts e.g. "Panel Thickness" on Z when the panels are thick in X.
        /// </summary>
        private static PlaneAxis ChooseAxis(
            string name,
            double millimetres,
            ResolvedModel model,
            CoordinateSet coordinates)
        {
            var preferred = AxisFor(name);
            var order = new[] { preferred, PlaneAxis.X, PlaneAxis.Y, PlaneAxis.Z };

            foreach (var axis in order)
            {
                var size = axis == PlaneAxis.X
                    ? model.Bounds.Size.X
                    : axis == PlaneAxis.Y
                        ? model.Bounds.Size.Y
                        : model.Bounds.Size.Z;

                if (Math.Abs(size - millimetres) <= 1) return axis;
            }

            var best = preferred;
            var bestCount = coordinates.Count(preferred, millimetres) + coordinates.Count(preferred, -millimetres);

            foreach (var axis in order)
            {
                var count = coordinates.Count(axis, millimetres) + coordinates.Count(axis, -millimetres);
                if (count > bestCount)
                {
                    best = axis;
                    bestCount = count;
                }
            }

            return best;
        }

        /// <summary>
        /// Builds the reference-plane skeleton: centre planes, the base level, and one plane
        /// per length parameter sitting on a real face where possible, dimensioned and
        /// labelled so the parameter drives that plane.
        /// </summary>
        private static PlaneSkeleton CreateReferencePlanes(
            Document document,
            FamilyManager manager,
            CoreParameterSet parameters,
            ResolvedModel model,
            List<string> warnings)
        {
            var skeleton = new PlaneSkeleton
            {
                Plan = FindView(document, ViewType.FloorPlan),
                Elevation = FindView(document, ViewType.Elevation),
            };

            if (skeleton.Plan == null && skeleton.Elevation == null) return skeleton;
            skeleton.Plan = skeleton.Plan ?? skeleton.Elevation;
            skeleton.Elevation = skeleton.Elevation ?? skeleton.Plan;

            var extent = Math.Max(Math.Max(model.Bounds.Size.X, model.Bounds.Size.Y), model.Bounds.Size.Z);
            var half = Ft(Math.Max(extent * 0.7, 400));

            var centerX = Ft(model.Bounds.IsValid ? (model.Bounds.MinX + model.Bounds.MaxX) / 2 : 0);
            var centerY = Ft(model.Bounds.IsValid ? (model.Bounds.MinY + model.Bounds.MaxY) / 2 : 0);

            var coordinates = ModelCoordinates(model);
            var labelled = LabelledParameters(document);
            var usedPairs = new HashSet<string>(StringComparer.Ordinal);

            ReferencePlane Add(string name, PlaneAxis axis, double coordinate, View view, bool drives)
            {
                var existing = skeleton.Find(axis, coordinate);
                if (existing != null)
                {
                    skeleton.Register(axis, coordinate, existing, drives);
                    return existing;
                }

                try
                {
                    var plane = FindPlane(document, name) ??
                                AddPlane(document, view, name, axis, coordinate, half);
                    if (plane == null) return null;

                    skeleton.Register(axis, coordinate, plane, drives);
                    skeleton.Created += 1;
                    return plane;
                }
                catch (Exception ex)
                {
                    warnings.Add($"Reference plane \"{name}\": {ex.Message}");
                    return null;
                }
            }

            void Dim(View view, ReferencePlane from, ReferencePlane to, XYZ start, XYZ end,
                Autodesk.Revit.DB.FamilyParameter label)
            {
                if (view == null || from == null || to == null) return;

                var key = $"{from.UniqueId}|{to.UniqueId}|{view.Id}";
                if (!usedPairs.Add(key)) return;

                skeleton.Dimensions.Add(new PlaneDimension(view, from, to, start, end, label));
            }

            void Track(string name, PlaneAxis axis, double coordinate)
            {
                var entry = skeleton.FindEntry(axis, coordinate);
                if (entry != null) skeleton.DrivenPlanes[name] = entry;
            }

            var centerLeftRight = Add("Center (Left/Right)", PlaneAxis.X, 0, skeleton.Plan, false);
            var centerFrontBack = Add("Center (Front/Back)", PlaneAxis.Y, 0, skeleton.Plan, false);
            var baseLevel = Add("Ref. Level", PlaneAxis.Z, 0, skeleton.Elevation, false);

            foreach (var parameter in parameters.Ordered)
            {
                if (!IsType(parameter.Type, "Length")) continue;
                if (!string.IsNullOrEmpty(parameter.Error)) continue;
                if (!parameter.Number.HasValue) continue;

                var value = Math.Abs(parameter.Number.Value);
                if (value < 1) continue;

                var familyParameter = FindParameter(manager, parameter.Name);

                // Formula parameters are excluded: Revit rejects them as driving labels in
                // this family context, and the build then rolls back.
                var label = familyParameter != null &&
                            string.IsNullOrWhiteSpace(parameter.Formula) &&
                            labelled.Add(familyParameter.Id)
                    ? familyParameter
                    : null;

                var axis = ChooseAxis(parameter.Name, value, model, coordinates);

                if (label != null)
                {
                    skeleton.Driving.Add(parameter.Name);
                }
                else
                {
                    var reason = familyParameter == null
                        ? "no such parameter"
                        : parameter.Instance
                            ? "instance parameter"
                            : !string.IsNullOrWhiteSpace(parameter.Formula)
                                ? "formula parameter"
                                : "already driven";
                    skeleton.Unlabelled.Add($"{parameter.Name} ({reason})");
                }

                if (axis == PlaneAxis.Z)
                {
                    var coordinate = Ft(value);
                    var plane = Add(parameter.Name, axis, coordinate, skeleton.Elevation, label != null);
                    if (plane != null)
                    {
                        Dim(skeleton.Elevation, baseLevel, plane, XYZ.Zero, new XYZ(0, 0, coordinate), label);
                        if (label != null) Track(parameter.Name, axis, coordinate);
                    }

                    continue;
                }

                var sign = coordinates.Has(axis, value) ? 1
                    : coordinates.Has(axis, -value) ? -1
                    : 0;

                if (sign != 0)
                {
                    // The parameter measures a real face from the datum: label that face.
                    var coordinate = Ft(sign * value);
                    var plane = Add(parameter.Name, axis, coordinate, skeleton.Plan, label != null);
                    if (plane == null) continue;

                    var datum = axis == PlaneAxis.X ? centerLeftRight : centerFrontBack;
                    var from = axis == PlaneAxis.X
                        ? new XYZ(0, centerY, 0)
                        : new XYZ(centerX, 0, 0);
                    var to = axis == PlaneAxis.X
                        ? new XYZ(coordinate, centerY, 0)
                        : new XYZ(centerX, coordinate, 0);

                    Dim(skeleton.Plan, datum, plane, from, to, label);
                    if (label != null) Track(parameter.Name, axis, coordinate);
                    continue;
                }

                // Otherwise fall back to a symmetric pair around the model centre.
                var center = axis == PlaneAxis.X ? centerX : centerY;
                var lowOffset = center - Ft(value) / 2;
                var highOffset = center + Ft(value) / 2;

                var low = Add(
                    axis == PlaneAxis.X ? $"{parameter.Name} Left" : $"{parameter.Name} Front",
                    axis,
                    lowOffset,
                    skeleton.Plan,
                    label != null);
                var high = Add(
                    axis == PlaneAxis.X ? $"{parameter.Name} Right" : $"{parameter.Name} Back",
                    axis,
                    highOffset,
                    skeleton.Plan,
                    label != null);

                if (low == null || high == null) continue;

                var lowPoint = axis == PlaneAxis.X
                    ? new XYZ(lowOffset, centerY, 0)
                    : new XYZ(centerX, lowOffset, 0);
                var highPoint = axis == PlaneAxis.X
                    ? new XYZ(highOffset, centerY, 0)
                    : new XYZ(centerX, highOffset, 0);

                Dim(skeleton.Plan, low, high, lowPoint, highPoint, label);
                if (label != null) Track(parameter.Name, axis, highOffset);
            }

            return skeleton;
        }

        /// <summary>
        /// Wraps a transaction so Revit reports failures to us instead of stopping the
        /// build with a modal dialog the bridge can never dismiss.
        /// </summary>
        private static Transaction SilentTransaction(
            Document document,
            string name,
            FailureCollector collector)
        {
            var transaction = new Transaction(document, name);
            var options = transaction.GetFailureHandlingOptions();
            options.SetFailuresPreprocessor(collector);
            options.SetForcedModalHandling(false);
            options.SetClearAfterRollback(true);
            transaction.SetFailureHandlingOptions(options);
            return transaction;
        }

        private sealed class FailureCollector : IFailuresPreprocessor
        {
            public readonly List<string> Messages = new List<string>();

            public FailureProcessingResult PreprocessFailures(FailuresAccessor failuresAccessor)
            {
                var result = FailureProcessingResult.Continue;

                foreach (var failure in failuresAccessor.GetFailureMessages())
                {
                    var text = failure.GetDescriptionText();
                    if (!string.IsNullOrWhiteSpace(text) && !Messages.Contains(text))
                        Messages.Add(text);

                    if (failure.GetSeverity() == FailureSeverity.Warning)
                    {
                        failuresAccessor.DeleteWarning(failure);
                        continue;
                    }

                    // A severe error left unresolved would be shown in a modal dialog that the
                    // bridge can never dismiss, hanging Revit. Roll the change back instead and
                    // surface the text as a warning.
                    result = FailureProcessingResult.ProceedWithRollBack;
                }

                return result;
            }
        }

        // ------------------------------------------------------------- materials

        private static IDictionary<string, MaterialDef> MaterialLookup(FamilySpec spec)
        {
            var lookup = new Dictionary<string, MaterialDef>(StringComparer.OrdinalIgnoreCase);
            foreach (var material in spec.Materials ?? new List<MaterialDef>())
            {
                if (string.IsNullOrWhiteSpace(material?.Name)) continue;
                if (!lookup.ContainsKey(material.Name)) lookup.Add(material.Name, material);
            }
            return lookup;
        }

        private static string MaterialName(ResolvedPart part, IDictionary<string, MaterialDef> materials)
        {
            if (!string.IsNullOrWhiteSpace(part.Material)) return part.Material;
            if (!string.IsNullOrWhiteSpace(part.Color)) return part.Name;
            return null;
        }

        private static string MaterialColor(ResolvedPart part, IDictionary<string, MaterialDef> materials)
        {
            if (!string.IsNullOrWhiteSpace(part.Color)) return part.Color;

            if (!string.IsNullOrWhiteSpace(part.Material) &&
                materials.TryGetValue(part.Material, out var material))
            {
                return material.Color;
            }

            return null;
        }

        private static void AssignMaterial(
            Document document,
            Element element,
            string name,
            string color,
            List<string> warnings)
        {
            if (string.IsNullOrWhiteSpace(name)) return;

            try
            {
                var material = FindOrCreateMaterial(document, name, color, warnings);
                if (material == null) return;

                var parameter = element.get_Parameter(BuiltInParameter.MATERIAL_ID_PARAM);
                if (parameter == null || parameter.IsReadOnly) return;
                parameter.Set(material.Id);
            }
            catch (Exception ex)
            {
                warnings.Add($"Material \"{name}\": {ex.Message}");
            }
        }

        private static Material FindOrCreateMaterial(
            Document document,
            string name,
            string color,
            List<string> warnings)
        {
            var existing = new FilteredElementCollector(document)
                .OfClass(typeof(Material))
                .Cast<Material>()
                .FirstOrDefault(material => string.Equals(material.Name, name, StringComparison.OrdinalIgnoreCase));

            var material = existing;

            if (material == null)
            {
                try
                {
                    var id = Material.Create(document, name);
                    material = document.GetElement(id) as Material;
                }
                catch (Exception ex)
                {
                    warnings.Add($"Material \"{name}\" could not be created: {ex.Message}");
                    return null;
                }
            }

            if (material != null) ApplyColor(material, color, warnings);
            return material;
        }

        private static void ApplyColor(Material material, string hex, List<string> warnings)
        {
            if (string.IsNullOrWhiteSpace(hex)) return;

            var value = hex.Trim().TrimStart('#');
            if (value.Length == 3)
            {
                value = new string(new[]
                {
                    value[0], value[0], value[1], value[1], value[2], value[2],
                });
            }

            if (value.Length != 6 ||
                !int.TryParse(value, NumberStyles.HexNumber, CultureInfo.InvariantCulture, out var rgb))
            {
                warnings.Add($"Material \"{material.Name}\" color \"{hex}\" is not a hex value");
                return;
            }

            try
            {
                material.Color = new Color(
                    (byte)((rgb >> 16) & 0xFF),
                    (byte)((rgb >> 8) & 0xFF),
                    (byte)(rgb & 0xFF));
            }
            catch (Exception ex)
            {
                warnings.Add($"Material \"{material.Name}\" color: {ex.Message}");
            }
        }

        // ------------------------------------------------------------- utilities

        private static double Ft(double millimeters) => millimeters / MmPerFoot;

        private static XYZ ToXyz(Vec3d point) => new XYZ(Ft(point.X), Ft(point.Y), Ft(point.Z));

        public static string OutputDirectory()
        {
            var configured = Environment.GetEnvironmentVariable("FAMILY_AGENT_OUT");
            if (!string.IsNullOrWhiteSpace(configured)) return configured;

            return Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.MyDocuments), "FamilyAgent", "out");
        }

        public static string QueueDirectory()
        {
            var configured = Environment.GetEnvironmentVariable("FAMILY_QUEUE_DIR");
            if (!string.IsNullOrWhiteSpace(configured)) return configured;

            return Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.MyDocuments), "FamilyAgent", "queue");
        }

        private static string Slug(string name)
        {
            var builder = new StringBuilder();
            foreach (var ch in (name ?? "family").ToLowerInvariant())
            {
                if (char.IsLetterOrDigit(ch)) builder.Append(ch);
                else if (builder.Length > 0 && builder[builder.Length - 1] != '-') builder.Append('-');
            }

            var slug = builder.ToString().Trim('-');
            if (slug.Length == 0) slug = "family";
            return slug.Length > 80 ? slug.Substring(0, 80) : slug;
        }
    }
}
