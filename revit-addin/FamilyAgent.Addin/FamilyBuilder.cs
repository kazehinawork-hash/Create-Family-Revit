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
        /** Family Types created from spec.types. */
        public int Types { get; set; }
    }

    internal static partial class FamilyBuilder
    {
        private const double MmPerFoot = 304.8;
        private const double DegToRad = Math.PI / 180.0;

        /// <summary>
        /// Reference planes and reference dimensions are always created so every parameter
        /// has a visible, movable reference plane in the RFA.
        /// Face/radial locking is enabled by default so type parameters flex the geometry
        /// natively inside a project, without the studio add-in. Set
        /// FAMILY_AGENT_LOCK_GEOMETRY=0 to fall back to baked geometry + auto-rebuild.
        /// </summary>
        public static bool IncludeConstraints = true;
        public static bool LockFacesToPlanes =
            !string.Equals(
                Environment.GetEnvironmentVariable("FAMILY_AGENT_LOCK_GEOMETRY"),
                "0",
                StringComparison.OrdinalIgnoreCase);

        /// <summary>
        /// Baked multi-size build: every row of spec.types gets its own resolved geometry and
        /// its own "Show &lt;type&gt;" visibility switch. A project shows one set per type, so
        /// picking a type changes the shape without any constraint stretching a sketch — the
        /// failure mode that used to delete mitre extrusions ("Base sketch is invalid").
        /// </summary>
        public static BuildResult BuildBakedMulti(Application app, string json)
        {
            var started = DateTime.UtcNow;
            var result = new BuildResult { RevitVersion = app.VersionNumber };
            Document document = null;
            var stage = "reading the spec";
            var buildFailures = new FailureCollector();

            try
            {
                var spec = SpecLoader.Load(json);
                if (spec.Types == null || spec.Types.Count == 0)
                {
                    throw new InvalidOperationException("spec.types is empty; nothing to build.");
                }

                var baseParameters = ParameterResolver.Resolve(spec);
                var materials = MaterialLookup(spec);
                var formulaKeys = new HashSet<string>(
                    (spec.Parameters ?? new List<FamilyAgent.Core.FamilyParameter>())
                        .Where(parameter => !string.IsNullOrWhiteSpace(parameter.Formula))
                        .Select(parameter => (parameter.Name ?? string.Empty).Trim().ToLowerInvariant()),
                    StringComparer.Ordinal);

                stage = "opening the family template";
                var template = TemplateCatalog.Resolve(app, spec);
                document = app.NewFamilyDocument(template);

                var showParameters = new List<Autodesk.Revit.DB.FamilyParameter>();
                var typeNames = new List<string>();
                var firstForms = new List<Element>();
                var firstPartByForm = new Dictionary<long, ResolvedPart>();
                var firstParameters = baseParameters;

                stage = "building the baked sizes";
                using (var transaction = SilentTransaction(
                           document, "Family Agent — build baked sizes", buildFailures))
                {
                    transaction.Start();
                    var manager = document.FamilyManager;
                    CreateFamilyType(manager, spec);
                    CreateParameters(document, manager, baseParameters, result.Warnings, populateOtherTypes: false);

                    for (var index = 0; index < spec.Types.Count; index += 1)
                    {
                        var row = spec.Types[index];
                        var name = (row?.Name ?? string.Empty).Trim();
                        if (name.Length == 0) name = $"Type {index + 1}";
                        typeNames.Add(name);

                        var overrides = (row?.Values ?? new Dictionary<string, double>())
                            .Where(pair => !formulaKeys.Contains((pair.Key ?? string.Empty).Trim().ToLowerInvariant()))
                            .ToDictionary(pair => pair.Key, pair => pair.Value, StringComparer.OrdinalIgnoreCase);

                        var parameters = ParameterResolver.Resolve(spec, overrides);
                        var model = GeometryResolver.Resolve(spec, parameters);
                        var partByForm = new Dictionary<long, ResolvedPart>();
                        var failedParts = new List<string>();

                        var forms = CreateGeometry(
                            document, model, materials, result.Warnings, partByForm, failedParts);
                        if (failedParts.Count > 0)
                        {
                            result.Warnings.Add($"Type \"{name}\": {failedParts.Count} part(s) could not be built");
                        }

                        var show = manager.AddParameter(
                            "Show " + name, GroupFor("Graphics"), SpecFor("YesNo"), false);
                        if (show == null)
                        {
                            result.Warnings.Add($"Type \"{name}\": visibility parameter could not be created");
                            continue;
                        }

                        showParameters.Add(show);

                        foreach (var form in forms)
                        {
                            try
                            {
                                var visible = form.get_Parameter(BuiltInParameter.IS_VISIBLE_PARAM);
                                if (visible != null)
                                {
                                    manager.AssociateElementParameterToFamilyParameter(visible, show);
                                }
                            }
                            catch (Exception ex)
                            {
                                result.Warnings.Add(
                                    $"Type \"{name}\": visibility of \"{form.Name}\" failed: {ex.Message}");
                            }
                        }

                        if (index == 0)
                        {
                            firstForms = forms;
                            firstPartByForm = partByForm;
                            firstParameters = parameters;
                        }
                    }

                    var status = transaction.Commit();
                    if (status != TransactionStatus.Committed)
                    {
                        throw new InvalidOperationException(
                            $"Revit rolled the family back ({status}): {string.Join(" ", buildFailures.Messages.Take(5))}");
                    }
                }

                foreach (var message in buildFailures.Messages.Take(5)) result.Warnings.Add(message);

                stage = "creating the family types";
                var typeWarnings = new FailureCollector();
                using (var transaction = SilentTransaction(
                           document, "Family Agent — baked types", typeWarnings))
                {
                    transaction.Start();
                    var manager = document.FamilyManager;
                    var created = new List<FamilyType>();

                    for (var index = 0; index < typeNames.Count && index < showParameters.Count; index += 1)
                    {
                        // The template's first type may already carry this name (spec.typeName).
                        FamilyType familyType;
                        try
                        {
                            familyType = manager.NewType(typeNames[index]);
                        }
                        catch
                        {
                            familyType = manager.Types
                                .Cast<FamilyType>()
                                .FirstOrDefault(type => string.Equals(
                                    type.Name, typeNames[index], StringComparison.OrdinalIgnoreCase));
                        }

                        if (familyType == null)
                        {
                            result.Warnings.Add($"Type \"{typeNames[index]}\" could not be created");
                            continue;
                        }

                        manager.CurrentType = familyType;
                        created.Add(familyType);

                        for (var other = 0; other < showParameters.Count; other += 1)
                        {
                            try { manager.Set(showParameters[other], other == index ? 1 : 0); }
                            catch (Exception ex)
                            {
                                result.Warnings.Add($"Type \"{typeNames[index]}\" visibility: {ex.Message}");
                            }
                        }

                        foreach (var pair in spec.Types[index].Values ?? new Dictionary<string, double>())
                        {
                            if (formulaKeys.Contains((pair.Key ?? string.Empty).Trim().ToLowerInvariant())) continue;
                            var parameter = FindParameter(manager, pair.Key);
                            if (parameter == null) continue;
                            try { manager.Set(parameter, pair.Value / MmPerFoot); }
                            catch { /* informational only */ }
                        }
                    }

                    // Template types carry no geometry here; drop the ones we did not create.
                    // FamilyManager can only delete the current type, so switch first.
                    var wanted = new HashSet<string>(
                        typeNames.Take(showParameters.Count), StringComparer.OrdinalIgnoreCase);

                    foreach (var existing in manager.Types.Cast<FamilyType>().ToList())
                    {
                        if (existing == null) continue;
                        if (wanted.Contains(existing.Name ?? string.Empty)) continue;
                        if (manager.Types.Size <= 1) break;

                        try
                        {
                            manager.CurrentType = existing;
                            manager.DeleteCurrentType();
                        }
                        catch
                        {
                            // Revit keeps the last type; nothing else to do.
                        }
                    }

                    var firstCreated = manager.Types.Cast<FamilyType>()
                        .FirstOrDefault(type => wanted.Contains(type.Name ?? string.Empty));
                    if (firstCreated != null) manager.CurrentType = firstCreated;

                    var status = transaction.Commit();
                    if (status != TransactionStatus.Committed)
                    {
                        result.Warnings.Add($"Family types were rolled back ({status}).");
                    }
                }

                foreach (var message in typeWarnings.Messages.Take(3)) result.Warnings.Add(message);

                if (firstForms.Count > 0)
                {
                    stage = "creating MEP connectors";
                    var connectorFailures = new FailureCollector();
                    IDictionary<string, Element> firstHosts = new Dictionary<string, Element>();
                    using (var transaction = SilentTransaction(
                               document, "Family Agent — MEP connectors", connectorFailures))
                    {
                        transaction.Start();
                        firstHosts = CreateConnectorHosts(
                            document, spec, firstParameters, firstForms, firstPartByForm, result.Warnings);
                        if (transaction.Commit() != TransactionStatus.Committed)
                        {
                            result.Warnings.Add(
                                "MEP connector hosts were rolled back: " +
                                string.Join(" ", connectorFailures.Messages.Take(2)));
                        }
                    }

                    CreateConnectors(
                        document, spec, firstParameters, firstForms, firstHosts, result.Warnings);

                    result.Warnings.Add(
                        "MEP connectors were built for the first type only; the other types reuse them.");
                }

                stage = "preparing views";
                PrepareViews(document, spec.Lod);

                stage = "storing the spec";
                using (var transaction = new Transaction(document, "Family Agent — store spec"))
                {
                    transaction.Start();
                    SpecStore.Save(document, json);
                    SpecStore.SaveMode(document, "baked-multi");
                    transaction.Commit();
                }

                stage = "saving the family";
                var directory = OutputDirectory();
                Directory.CreateDirectory(directory);
                var path = Path.Combine(directory, Slug(spec.Name) + ".rfa");
                document.SaveAs(path, new SaveAsOptions { OverwriteExistingFile = true, MaximumBackups = 1 });

                result.Path = path;
                result.Types = typeNames.Count;
                result.Stats = new
                {
                    mode = "baked-multi",
                    types = typeNames,
                    showParameters = showParameters.Count,
                    elapsedMs = (int)(DateTime.UtcNow - started).TotalMilliseconds,
                };
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
        /// Diagnostic: loads the built .rfa into an empty project and drives its type
        /// parameters, which is the only place a family can lose geometry ("Can't make
        /// Extrusion"). Reports, per parameter set, the failures Revit raised and the
        /// bounding box in millimetres so it can be compared with the studio preview.
        /// </summary>
        public static object InspectProject(
            UIApplication uiApp,
            string path,
            IList<KeyValuePair<string, double>> values,
            IList<string> typeNames = null)
        {
            if (string.IsNullOrWhiteSpace(path) || !File.Exists(path))
                throw new FileNotFoundException("Family not found", path);

            var started = DateTime.UtcNow;
            Document project = null;

            try
            {
                project = uiApp.Application.NewProjectDocument(UnitSystem.Metric);

                Family loaded = null;
                using (var transaction = SilentTransaction(
                           project, "Family Agent — load family", new FailureCollector()))
                {
                    transaction.Start();
                    project.LoadFamily(path, out loaded);
                    transaction.Commit();
                }

                var symbols = loaded == null
                    ? new List<FamilySymbol>()
                    : loaded.GetFamilySymbolIds()
                        .Select(id => project.GetElement(id) as FamilySymbol)
                        .Where(symbol => symbol != null)
                        .ToList();

                // The family only regenerates its geometry once an instance exists; that is
                // also the moment Revit reports "Can't make Extrusion".
                var loadFailures = new FailureCollector();
                FamilyInstance instance = null;
                if (symbols.Count > 0)
                {
                    using (var transaction = SilentTransaction(
                               project, "Family Agent — place instance", loadFailures))
                    {
                        transaction.Start();
                        try
                        {
                            if (!symbols[0].IsActive) symbols[0].Activate();
                            instance = project.Create.NewFamilyInstance(
                                XYZ.Zero, symbols[0], Autodesk.Revit.DB.Structure.StructuralType.NonStructural);
                            project.Regenerate();
                        }
                        catch (Exception ex)
                        {
                            loadFailures.Messages.Add(ex.Message);
                        }

                        transaction.Commit();
                    }
                }

                var runs = new List<object>();

                // Baked multi-size families are verified by switching the instance type:
                // the shape is per type, not per parameter value.
                foreach (var typeName in typeNames ?? new List<string>())
                {
                    var failures = new FailureCollector();
                    var symbol = symbols.FirstOrDefault(candidate =>
                        string.Equals(candidate.Name, typeName, StringComparison.OrdinalIgnoreCase));
                    try
                    {
                        using (var transaction = SilentTransaction(
                                   project, "Family Agent — switch to " + typeName, failures))
                        {
                            transaction.Start();
                            if (symbol == null)
                            {
                                failures.Messages.Add($"Type \"{typeName}\" not found");
                            }
                            else
                            {
                                if (!symbol.IsActive) symbol.Activate();
                                if (instance != null) instance.Symbol = symbol;
                                project.Regenerate();
                            }

                            transaction.Commit();
                        }
                    }
                    catch (Exception ex)
                    {
                        failures.Messages.Add(ex.Message);
                    }

                    runs.Add(new
                    {
                        parameter = typeName,
                        valueMm = 0.0,
                        applied = new List<string> { symbol == null ? "missing" : "switch" },
                        failures = failures.Messages,
                        failureCount = failures.Messages.Count,
                        bounds = InstanceBounds(instance),
                    });
                }

                foreach (var entry in values)
                {
                    var failures = new FailureCollector();
                    var applied = new List<string>();
                    try
                    {
                        using (var transaction = SilentTransaction(
                                   project, "Family Agent — drive " + entry.Key, failures))
                        {
                            transaction.Start();

                            foreach (var symbol in symbols)
                            {
                                var parameter = symbol.LookupParameter(entry.Key);
                                if (parameter == null)
                                {
                                    applied.Add($"{symbol.Name}: parameter missing");
                                    continue;
                                }

                                var ok = parameter.Set(entry.Value / MmPerFoot);
                                applied.Add($"{symbol.Name}: set={ok}");
                            }

                            project.Regenerate();
                            transaction.Commit();
                        }
                    }
                    catch (Exception ex)
                    {
                        failures.Messages.Add(ex.Message);
                    }

                    runs.Add(new
                    {
                        parameter = entry.Key,
                        valueMm = entry.Value,
                        applied,
                        failures = failures.Messages,
                        failureCount = failures.Messages.Count,
                        bounds = InstanceBounds(instance),
                    });
                }

                return new
                {
                    ok = true,
                    runs,
                    symbols = symbols.Count,
                    instance = instance != null,
                    loadFailures = loadFailures.Messages,
                    elapsedMs = (int)(DateTime.UtcNow - started).TotalMilliseconds,
                };
            }
            finally
            {
                try
                {
                    project?.Close(false);
                }
                catch
                {
                    // Keep the harness from masking the result.
                }
            }
        }

        /// <summary>Bounding extents of the placed instance, in millimetres.</summary>
        private static object InstanceBounds(FamilyInstance instance)
        {
            if (instance == null) return new { x = 0.0, y = 0.0, z = 0.0, forms = 0 };

            try
            {
                var box = instance.get_BoundingBox(null);
                if (box == null) return new { x = 0.0, y = 0.0, z = 0.0, forms = 0 };

                return new
                {
                    x = Math.Round((box.Max.X - box.Min.X) * MmPerFoot),
                    y = Math.Round((box.Max.Y - box.Min.Y) * MmPerFoot),
                    z = Math.Round((box.Max.Z - box.Min.Z) * MmPerFoot),
                    forms = 1,
                };
            }
            catch
            {
                return new { x = 0.0, y = 0.0, z = 0.0, forms = 0 };
            }
        }

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

                // Connector origins let a test compare the built family with the spec.
                var connectorOrigins = new FilteredElementCollector(document)
                    .OfClass(typeof(ConnectorElement))
                    .Cast<ConnectorElement>()
                    .Select(element => new
                    {
                        name = element.Name,
                        x = Math.Round(element.Origin.X * MmPerFoot, 1),
                        y = Math.Round(element.Origin.Y * MmPerFoot, 1),
                        z = Math.Round(element.Origin.Z * MmPerFoot, 1),
                    })
                    .ToList();

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
                var failures = new FailureCollector();

                using (var transaction = SilentTransaction(document, "Family Agent — inspect", failures))
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
                    changedToMm = Math.Round((current * (1.0 + percent / 100.0)) * MmPerFoot, 1),
                    percent,
                    commit,
                    moved,
                    failures = failures.Messages,
                    failureCount = failures.Messages.Count,
                    planes = planes.Count,
                    pinned = planes.Count(plane => plane.Pinned),
                    dimensions = dimensions.Count,
                    labelled,
                    labelledNames,
                    parameterNames,
                    connectors = connectorOrigins,
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

                PlaneSkeleton skeleton = null;
                List<Element> forms;
                var partByForm = new Dictionary<long, ResolvedPart>();
                IDictionary<string, Element> connectorHosts = new Dictionary<string, Element>();
                var joins = 0;
                var failedParts = new List<string>();

                stage = "building the family";
                using (var transaction = SilentTransaction(document, "Family Agent — build family", buildFailures))
                {
                    transaction.Start();

                    var manager = document.FamilyManager;
                    CreateFamilyType(manager, spec);
                    CreateParameters(document, manager, parameters, result.Warnings, populateOtherTypes: true);
                    if (IncludeConstraints)
                    {
                        skeleton = CreateReferencePlanes(document, manager, parameters, model, result.Warnings);
                    }
                    forms = CreateGeometry(
                        document, model, materials, result.Warnings, partByForm, failedParts);
                    joins = JoinOverlappingForms(
                        document, forms, partByForm, materials, result.Warnings);
                    connectorHosts = CreateConnectorHosts(
                        document, spec, parameters, forms, partByForm, result.Warnings);

                    var status = transaction.Commit();
                    if (status != TransactionStatus.Committed)
                    {
                        throw new InvalidOperationException(
                            $"Revit rolled the family back ({status}): {string.Join(" ", buildFailures.Messages.Take(5))}");
                    }
                }

                foreach (var message in buildFailures.Messages.Take(5)) result.Warnings.Add(message);

                var refDimensions = 0;
                var locks = 0;
                var faceDimensions = 0;
                var radialDimensions = 0;
                var inert = new List<string>();
                var flex = string.Empty;
                var constraintMode = "rebuild";
                var probeFailures = 0;

                if (IncludeConstraints && skeleton != null)
                {
                    var lockedFormAxes = new HashSet<string>(StringComparer.Ordinal);
                    var solvedFaces = new HashSet<string>(StringComparer.OrdinalIgnoreCase);

                    if (LockFacesToPlanes)
                    {
                        stage = "locking the geometry to the reference planes";
                        locks = LockGeometry(
                            document, skeleton, forms, partByForm, out lockedFormAxes, result.Warnings);
                    }

                    // Planes are dimensioned after the locks, so a formula parameter never
                    // labels a plane a form is already aligned to.
                    stage = "dimensioning the reference planes";
                    refDimensions = CreateDimensions(document, skeleton, skeleton.Dimensions, result.Warnings);

                    if (LockFacesToPlanes)
                    {
                        stage = "dimensioning the part faces";
                        faceDimensions = CreateFaceDimensions(
                            document, spec, skeleton, forms, partByForm, parameters,
                            lockedFormAxes, out solvedFaces, result.Warnings);
                        radialDimensions = CreateRadialDimensions(
                            document, skeleton, forms, parameters, solvedFaces, result.Warnings);
                    }

                    // Revit is the judge: flex every driver and drop whatever it refuses, so
                    // the saved family always stays editable when loaded into a project.
                    stage = "validating the constraints";
                    try
                    {
                        flex = ValidateConstraints(
                            document, parameters, result.Warnings, LockFacesToPlanes,
                            out constraintMode, out probeFailures);
                    }
                    catch (Exception ex)
                    {
                        constraintMode = "rebuild";
                        flex = "error: " + ex.Message;
                    }

                    // Inert means "labelled but shapes nothing": a formula parameter only
                    // reports, and a dimension on a void cut cannot drive it, yet both still
                    // size real geometry. Only parameters absent from every part expression
                    // are truly inert.
                    var formulaNames = new HashSet<string>(
                        parameters.Ordered
                            .Where(parameter => !string.IsNullOrWhiteSpace(parameter.Formula))
                            .Select(parameter => parameter.Name),
                        StringComparer.OrdinalIgnoreCase);
                    var drivenParts = ParameterPartDependencies(spec);
                    inert = skeleton.Inert()
                        .Where(name => !solvedFaces.Contains(name) && !formulaNames.Contains(name))
                        .Where(name => !(drivenParts.TryGetValue(name, out var parts) && parts.Count > 0))
                        .ToList();

                    if (constraintMode != "constraints")
                    {
                        locks = 0;
                        faceDimensions = 0;
                        radialDimensions = 0;
                    }
                }

                if (failedParts.Count > 0)
                {
                    result.Warnings.Add(
                        $"{failedParts.Count} part/copy không dựng được: {string.Join("; ", failedParts.Take(8))}");
                }

                stage = "creating MEP connectors";
                var connectors = CreateConnectors(
                    document, spec, parameters, forms, connectorHosts, result.Warnings);

                result.Stats = new
                {
                    parts = model.Parts.Count,
                    instances = model.Instances,
                    forms = forms.Count(f => f is Extrusion),
                    lofts = forms.Count(f => f.GetType() == typeof(Form)),
                    sweptBlends = forms.Count(f => f is SweptBlend),
                    freeforms = forms.Count(f => f is FreeFormElement),
                    freeformParts = forms
                        .Where(form => form is FreeFormElement)
                        .Select(form => partByForm != null &&
                                        partByForm.TryGetValue(form.Id.Value, out var source)
                            ? source.Id
                            : form.Name)
                        .ToList(),
                    voids = forms.Count(f => f is Extrusion extrusion && !extrusion.IsSolid),
                    refPlanes = skeleton?.Created ?? 0,
                    refDimensions,
                    locks,
                    mode = constraintMode,
                    qaPass = constraintMode == "constraints" && probeFailures == 0 && failedParts.Count == 0,
                    probeFailures,
                    joins,
                    totalForms = forms.Count,
                    missingForms = Math.Max(0, model.Instances - forms.Count),
                    failedParts,
                    lod = spec.Lod,
                    driving = skeleton?.Driving ?? new List<string>(),
                    unlabelled = skeleton?.Unlabelled ?? new List<string>(),
                    inert,
                    flex,
                    faceDimensions,
                    radialDimensions,
                    connectors,
                    parameters = parameters.Ordered.Count,
                    volumeMm3 = Math.Round(TotalVolume(forms) * Math.Pow(MmPerFoot, 3)),
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
                    SpecStore.SaveMode(document, constraintMode);
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

                // Only driver parameters should override the spec. If a formula parameter is
                // also overridden, the resolver pins it to the current Revit value instead of
                // recomputing it from the edited driver, so parts look stale after a change.
                var formulaKeys = new HashSet<string>(
                    spec.Parameters
                        .Where(parameter => parameter != null && !string.IsNullOrWhiteSpace(parameter.Formula))
                        .Select(parameter => (parameter.Name ?? string.Empty).Trim().ToLowerInvariant()),
                    StringComparer.Ordinal);
                var driverOverrides = overrides
                    .Where(entry => !formulaKeys.Contains(entry.Key.Trim().ToLowerInvariant()))
                    .ToDictionary(entry => entry.Key, entry => entry.Value, StringComparer.OrdinalIgnoreCase);

                var parameters = ParameterResolver.Resolve(spec, driverOverrides);
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

                PlaneSkeleton skeleton = null;
                List<Element> forms;
                var partByForm = new Dictionary<long, ResolvedPart>();
                IDictionary<string, Element> connectorHosts = new Dictionary<string, Element>();
                var joins = 0;
                var failedParts = new List<string>();

                stage = "rebuilding the family";
                using (var transaction = SilentTransaction(document, "Family Agent — rebuild family", buildFailures))
                {
                    transaction.Start();

                    var manager = document.FamilyManager;
                    var activeUserType = manager.CurrentType;
                    if (activeUserType == null)
                    {
                        CreateFamilyType(manager, spec);
                    }
                    CreateParameters(document, manager, parameters, result.Warnings, populateOtherTypes: false);
                    if (IncludeConstraints)
                    {
                        skeleton = CreateReferencePlanes(document, manager, parameters, model, result.Warnings);
                    }
                    forms = CreateGeometry(
                        document, model, materials, result.Warnings, partByForm, failedParts);
                    joins = JoinOverlappingForms(
                        document, forms, partByForm, materials, result.Warnings);
                    connectorHosts = CreateConnectorHosts(
                        document, spec, parameters, forms, partByForm, result.Warnings);

                    var status = transaction.Commit();
                    if (status != TransactionStatus.Committed)
                    {
                        throw new InvalidOperationException(
                            $"Revit rolled the family back ({status}): {string.Join(" ", buildFailures.Messages.Take(5))}");
                    }
                }

                foreach (var message in buildFailures.Messages.Take(5)) result.Warnings.Add(message);

                var refDimensions = 0;
                var locks = 0;
                var faceDimensions = 0;
                var radialDimensions = 0;
                var inert = new List<string>();
                var flex = string.Empty;
                var constraintMode = "rebuild";
                var probeFailures = 0;

                if (IncludeConstraints && skeleton != null)
                {
                    var lockedFormAxes = new HashSet<string>(StringComparer.Ordinal);
                    var solvedFaces = new HashSet<string>(StringComparer.OrdinalIgnoreCase);

                    if (LockFacesToPlanes)
                    {
                        stage = "locking the geometry to the reference planes";
                        locks = LockGeometry(
                            document, skeleton, forms, partByForm, out lockedFormAxes, result.Warnings);
                    }

                    // Planes are dimensioned after the locks, so a formula parameter never
                    // labels a plane a form is already aligned to.
                    stage = "dimensioning the reference planes";
                    refDimensions = CreateDimensions(document, skeleton, skeleton.Dimensions, result.Warnings);

                    if (LockFacesToPlanes)
                    {
                        stage = "dimensioning the part faces";
                        faceDimensions = CreateFaceDimensions(
                            document, spec, skeleton, forms, partByForm, parameters,
                            lockedFormAxes, out solvedFaces, result.Warnings);
                        radialDimensions = CreateRadialDimensions(
                            document, skeleton, forms, parameters, solvedFaces, result.Warnings);
                    }

                    // Revit is the judge: flex every driver and drop whatever it refuses, so
                    // the saved family always stays editable when loaded into a project.
                    stage = "validating the constraints";
                    try
                    {
                        flex = ValidateConstraints(
                            document, parameters, result.Warnings, LockFacesToPlanes,
                            out constraintMode, out probeFailures);
                    }
                    catch (Exception ex)
                    {
                        constraintMode = "rebuild";
                        flex = "error: " + ex.Message;
                    }

                    // Inert means "labelled but shapes nothing": a formula parameter only
                    // reports, and a dimension on a void cut cannot drive it, yet both still
                    // size real geometry. Only parameters absent from every part expression
                    // are truly inert.
                    var formulaNames = new HashSet<string>(
                        parameters.Ordered
                            .Where(parameter => !string.IsNullOrWhiteSpace(parameter.Formula))
                            .Select(parameter => parameter.Name),
                        StringComparer.OrdinalIgnoreCase);
                    var drivenParts = ParameterPartDependencies(spec);
                    inert = skeleton.Inert()
                        .Where(name => !solvedFaces.Contains(name) && !formulaNames.Contains(name))
                        .Where(name => !(drivenParts.TryGetValue(name, out var parts) && parts.Count > 0))
                        .ToList();

                    if (constraintMode != "constraints")
                    {
                        locks = 0;
                        faceDimensions = 0;
                        radialDimensions = 0;
                    }
                }

                if (failedParts.Count > 0)
                {
                    result.Warnings.Add(
                        $"{failedParts.Count} part/copy không dựng được: {string.Join("; ", failedParts.Take(8))}");
                }

                stage = "creating MEP connectors";
                var connectors = CreateConnectors(
                    document, spec, parameters, forms, connectorHosts, result.Warnings);

                result.Stats = new
                {
                    parts = model.Parts.Count,
                    instances = model.Instances,
                    forms = forms.Count(f => f is Extrusion),
                    lofts = forms.Count(f => f.GetType() == typeof(Form)),
                    sweptBlends = forms.Count(f => f is SweptBlend),
                    freeforms = forms.Count(f => f is FreeFormElement),
                    freeformParts = forms
                        .Where(form => form is FreeFormElement)
                        .Select(form => partByForm != null &&
                                        partByForm.TryGetValue(form.Id.Value, out var source)
                            ? source.Id
                            : form.Name)
                        .ToList(),
                    voids = forms.Count(f => f is Extrusion extrusion && !extrusion.IsSolid),
                    refPlanes = skeleton?.Created ?? 0,
                    refDimensions,
                    locks,
                    mode = constraintMode,
                    qaPass = constraintMode == "constraints" && probeFailures == 0 && failedParts.Count == 0,
                    probeFailures,
                    joins,
                    totalForms = forms.Count,
                    missingForms = Math.Max(0, model.Instances - forms.Count),
                    failedParts,
                    lod = spec.Lod,
                    driving = skeleton?.Driving ?? new List<string>(),
                    unlabelled = skeleton?.Unlabelled ?? new List<string>(),
                    inert,
                    flex,
                    faceDimensions,
                    radialDimensions,
                    connectors,
                    parameters = parameters.Ordered.Count,
                    volumeMm3 = Math.Round(TotalVolume(forms) * Math.Pow(MmPerFoot, 3)),
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
                    SpecStore.SaveMode(document, constraintMode);
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

        private static double TotalVolume(IList<Element> forms)
        {
            var volume = 0.0;
            var options = new Options { ComputeReferences = false, DetailLevel = ViewDetailLevel.Fine };
            foreach (var form in forms)
            {
                var generic = form as GenericForm;
                if (generic == null || !generic.IsSolid) continue;

                GeometryElement geometry;
                try { geometry = form.get_Geometry(options); } catch { continue; }
                if (geometry == null) continue;

                foreach (var item in geometry)
                {
                    if (item is Solid solid && solid.Volume > 0) volume += solid.Volume;
                }
            }
            return volume;
        }

        /// <summary>
        /// True when a parameter edit cannot be carried by the native constraint graph, so
        /// the family has to re-solve its stored spec to stay identical to the studio:
        /// geometry that lost its parameters (boolean, sweep and loft results become
        /// FreeFormElements), or a derived parameter that no dimension carries (a miter
        /// offset measured to a fold edge instead of to a face, for example).
        /// </summary>
        public static bool NeedsGeometryRebuild(Document document)
        {
            if (document == null || !document.IsFamilyDocument) return false;

            // A baked multi-size family carries one geometry set per type and must not rebuild.
            var storedMode = SpecStore.LoadMode(document);
            if (string.Equals(storedMode, "baked-multi", StringComparison.OrdinalIgnoreCase)) return false;
            if (!string.IsNullOrWhiteSpace(storedMode) &&
                !string.Equals(storedMode, "constraints", StringComparison.OrdinalIgnoreCase))
            {
                return true;
            }

            try
            {
                if (new FilteredElementCollector(document).OfClass(typeof(FreeFormElement)).Any())
                {
                    return true;
                }
            }
            catch
            {
                // A collector failure is not a reason to force a rebuild.
            }

            try
            {
                var labelled = LabelledParameters(document);
                foreach (Autodesk.Revit.DB.FamilyParameter parameter in document.FamilyManager.Parameters)
                {
                    try
                    {
                        if (!string.IsNullOrWhiteSpace(parameter.Formula) && !labelled.Contains(parameter.Id))
                        {
                            return true;
                        }
                    }
                    catch
                    {
                        // Reporting/shared parameters can refuse a formula read; they drive nothing.
                    }
                }
            }
            catch
            {
            }

            return false;
        }

        /// <summary>
        /// Computes a fingerprint of the active FamilyType and its parameter values so
        /// the auto-sync monitor can detect when the user edits a parameter or switches
        /// Family Types in Revit and immediately rebuild the 3D geometry from the spec.
        /// </summary>
        public static string ParameterSignature(Document document)
        {
            if (document == null || !document.IsFamilyDocument) return string.Empty;
            try
            {
                var json = SpecStore.Load(document);
                if (string.IsNullOrWhiteSpace(json)) return string.Empty;

                var values = CurrentValues(document);
                if (values.Count == 0) return "__empty__";
                var sb = new StringBuilder();
                sb.Append(document.FamilyManager.CurrentType?.Name ?? "");
                foreach (var kv in values.OrderBy(k => k.Key, StringComparer.OrdinalIgnoreCase))
                {
                    sb.Append('|').Append(kv.Key).Append('=').Append(Math.Round(kv.Value, 4).ToString(CultureInfo.InvariantCulture));
                }
                return sb.ToString();
            }
            catch
            {
                return string.Empty;
            }
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
                ids.AddRange(new FilteredElementCollector(document).OfClass(typeof(SweptBlend)).ToElementIds());
                ids.AddRange(new FilteredElementCollector(document).OfClass(typeof(Form)).ToElementIds());
                ids.AddRange(new FilteredElementCollector(document).OfClass(typeof(FreeFormElement)).ToElementIds());
                ids.AddRange(new FilteredElementCollector(document).OfClass(typeof(CurveElement)).ToElementIds());
                ids.AddRange(new FilteredElementCollector(document).OfClass(typeof(ReferencePlane)).ToElementIds());
                ids.AddRange(new FilteredElementCollector(document).OfClass(typeof(ConnectorElement)).ToElementIds());

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

            // Tạo sẵn các Type tiêu chuẩn của catalogue vào thẳng Family (nếu là dòng van giảm áp Fivalco)
            var isFivalcoPrv = (spec.Name ?? string.Empty).IndexOf("F6316", StringComparison.OrdinalIgnoreCase) >= 0 ||
                               (spec.Name ?? string.Empty).IndexOf("PPR", StringComparison.OrdinalIgnoreCase) >= 0;
            if (isFivalcoPrv)
            {
                var standardTypes = new[]
                {
                    "DN50 PN16 (2\")",
                    "DN65 PN16 (2-1/2\")",
                    "DN80 PN16 (3\")",
                    "DN100 PN16 (4\")",
                    "DN125 PN16 (5\")",
                    "DN150 PN16 (6\")",
                    "DN200 PN16 (8\")"
                };

                foreach (var name in standardTypes)
                {
                    try
                    {
                        manager.NewType(name);
                    }
                    catch
                    {
                        // Bỏ qua nếu type đã tồn tại
                    }
                }

                // Đặt lại CurrentType về type mặc định của spec
                try
                {
                    var defaultName = string.IsNullOrWhiteSpace(spec.TypeName) ? standardTypes[0] : spec.TypeName.Trim();
                    var match = manager.Types.Cast<FamilyType>().FirstOrDefault(t => string.Equals(t.Name, defaultName, StringComparison.OrdinalIgnoreCase));
                    if (match != null) manager.CurrentType = match;
                }
                catch
                {
                }
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
            List<string> warnings,
            bool populateOtherTypes = true)
        {
            var initialType = manager.CurrentType;
            var allTypes = manager.Types.Cast<FamilyType>().ToList();
            var createdParams = new List<(Autodesk.Revit.DB.FamilyParameter Target, ResolvedParameter Source)>();

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
                    createdParams.Add((familyParameter, parameter));
                }
                catch (Exception ex)
                {
                    warnings.Add($"Parameter \"{parameter.Name}\" was not created: {ex.Message}");
                }
            }

            // Ensure every FamilyType in the document receives valid baseline values
            // (and catalogue presets if applicable) instead of 0.0 which breaks formulas.
            if (populateOtherTypes && allTypes.Count > 1)
            {
                var presetTable = new Dictionary<string, Dictionary<string, double>>(StringComparer.OrdinalIgnoreCase)
                {
                    ["DN50 PN16 (2\")"] = new Dictionary<string, double>(StringComparer.OrdinalIgnoreCase)
                        { ["Nominal Diameter"] = 50, ["Face to Face Length"] = 230, ["Flange Diameter"] = 165, ["Flange Thickness"] = 19, ["Raised Face Diameter"] = 99, ["Bolt Circle Diameter"] = 125, ["Bolt Hole Diameter"] = 18 },
                    ["DN65 PN16 (2-1/2\")"] = new Dictionary<string, double>(StringComparer.OrdinalIgnoreCase)
                        { ["Nominal Diameter"] = 65, ["Face to Face Length"] = 290, ["Flange Diameter"] = 185, ["Flange Thickness"] = 19, ["Raised Face Diameter"] = 118, ["Bolt Circle Diameter"] = 145, ["Bolt Hole Diameter"] = 18 },
                    ["DN80 PN16 (3\")"] = new Dictionary<string, double>(StringComparer.OrdinalIgnoreCase)
                        { ["Nominal Diameter"] = 80, ["Face to Face Length"] = 310, ["Flange Diameter"] = 200, ["Flange Thickness"] = 19, ["Raised Face Diameter"] = 132, ["Bolt Circle Diameter"] = 160, ["Bolt Hole Diameter"] = 18 },
                    ["DN100 PN16 (4\")"] = new Dictionary<string, double>(StringComparer.OrdinalIgnoreCase)
                        { ["Nominal Diameter"] = 100, ["Face to Face Length"] = 350, ["Flange Diameter"] = 220, ["Flange Thickness"] = 19, ["Raised Face Diameter"] = 156, ["Bolt Circle Diameter"] = 180, ["Bolt Hole Diameter"] = 18 },
                    ["DN125 PN16 (5\")"] = new Dictionary<string, double>(StringComparer.OrdinalIgnoreCase)
                        { ["Nominal Diameter"] = 125, ["Face to Face Length"] = 400, ["Flange Diameter"] = 250, ["Flange Thickness"] = 19, ["Raised Face Diameter"] = 184, ["Bolt Circle Diameter"] = 210, ["Bolt Hole Diameter"] = 18 },
                    ["DN150 PN16 (6\")"] = new Dictionary<string, double>(StringComparer.OrdinalIgnoreCase)
                        { ["Nominal Diameter"] = 150, ["Face to Face Length"] = 480, ["Flange Diameter"] = 285, ["Flange Thickness"] = 19, ["Raised Face Diameter"] = 211, ["Bolt Circle Diameter"] = 240, ["Bolt Hole Diameter"] = 22 },
                    ["DN200 PN16 (8\")"] = new Dictionary<string, double>(StringComparer.OrdinalIgnoreCase)
                        { ["Nominal Diameter"] = 200, ["Face to Face Length"] = 600, ["Flange Diameter"] = 340, ["Flange Thickness"] = 20, ["Raised Face Diameter"] = 266, ["Bolt Circle Diameter"] = 295, ["Bolt Hole Diameter"] = 22 },
                };

                foreach (var famType in allTypes)
                {
                    if (famType == null || (initialType != null && famType.Name == initialType.Name)) continue;

                    try
                    {
                        manager.CurrentType = famType;
                        presetTable.TryGetValue(famType.Name ?? string.Empty, out var presets);

                        foreach (var (target, source) in createdParams)
                        {
                            if (!string.IsNullOrWhiteSpace(source.Formula)) continue;
                            if (presets != null && presets.TryGetValue(source.Name, out var presetMm))
                            {
                                try { manager.Set(target, presetMm / MmPerFoot); } catch { }
                                continue;
                            }

                            var currentVal = famType.AsDouble(target);
                            if (!currentVal.HasValue || Math.Abs(currentVal.Value) < 1e-9)
                            {
                                ApplyValue(manager, target, source, new List<string>());
                            }
                        }
                    }
                    catch
                    {
                        // Ignore errors on non-active types
                    }
                }

                if (initialType != null)
                {
                    try { manager.CurrentType = initialType; } catch { }
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
                    // The studio expression language accepts a "mm" unit suffix,
                    // Revit formulas do not. Strip it so e.g. "Count + 1mm" works.
                    var formula = System.Text.RegularExpressions.Regex.Replace(
                        parameter.Formula, @"(?<=\d)\s*mm\b", string.Empty,
                        System.Text.RegularExpressions.RegexOptions.IgnoreCase);
                    manager.SetFormula(target, formula);
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
            public readonly List<IPlaneDimension> Dimensions = new List<IPlaneDimension>();
            public readonly List<string> Driving = new List<string>();
            public readonly List<string> Unlabelled = new List<string>();
            /** Parameter name -> the plane its dimension drives, so we can tell if it moves anything. */
            public readonly Dictionary<string, SkeletonPlane> DrivenPlanes =
                new Dictionary<string, SkeletonPlane>(StringComparer.OrdinalIgnoreCase);
            /** Shared constraint graph: a second dimension between connected nodes overconstrains. */
            public readonly ConstraintGraph Constraints = new ConstraintGraph();

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

            /// <summary>
            /// True when a form face is already aligned to this plane. A formula parameter
            /// must not label a locked plane: Revit refuses to change it and rolls the
            /// dimension back.
            /// </summary>
            public bool IsUsed(ReferencePlane plane)
            {
                if (plane == null) return false;

                foreach (var entry in Planes)
                {
                    if (entry?.Plane == null) continue;
                    if (!string.Equals(entry.Plane.UniqueId, plane.UniqueId, StringComparison.Ordinal)) continue;
                    if (entry.Used) return true;
                }

                return false;
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
            string explicitAxis,
            double millimetres,
            ResolvedModel model,
            CoordinateSet coordinates)
        {
            var requested = (explicitAxis ?? string.Empty).Trim().ToLowerInvariant();
            if (requested == "x") return PlaneAxis.X;
            if (requested == "y") return PlaneAxis.Y;
            if (requested == "z") return PlaneAxis.Z;

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

                // An unlabelled dimension does not drive anything but still participates
                // in the constraint graph; on parameter-heavy families it overconstrains
                // the reference planes. Only labelled dimensions are useful here.
                if (label == null) return;

                var key = $"{from.UniqueId}|{to.UniqueId}|{view.Id}";
                if (!usedPairs.Add(key)) return;

                var fromKey = ConstraintGraph.PlaneKey(from);
                var toKey = ConstraintGraph.PlaneKey(to);
                if (skeleton.Constraints.WouldOverconstrain(fromKey, toKey))
                {
                    warnings.Add(
                        $"Skipped overconstraining dimension \"{label.Definition?.Name}\" " +
                        $"({from.Name} ↔ {to.Name})");
                    return;
                }
                skeleton.Constraints.Connect(fromKey, toKey);

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

                // A derived coordinate still needs one defining dimension. The dimension is
                // plane-to-plane, so a formula parameter reports the value it computes
                // instead of driving a form face; the union-find below rejects duplicates.
                var label = familyParameter != null && labelled.Add(familyParameter.Id)
                    ? familyParameter
                    : null;

                var axis = ChooseAxis(parameter.Name, parameter.Axis, value, model, coordinates);

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

                // A pair sitting symmetrically around the centre gets an EQ chain, so both
                // halves stay equal and the width cannot drift off-centre when it changes.
                var centerPlaneForAxis = axis == PlaneAxis.X ? centerLeftRight : centerFrontBack;
                var pairCenter = (lowOffset + highOffset) / 2;
                if (label != null && centerPlaneForAxis != null && Math.Abs(pairCenter) <= 0.05 / MmPerFoot)
                {
                    var middlePoint = new XYZ(centerX, centerY, 0);
                    skeleton.Dimensions.Add(new EqualPlaneDimension(
                        skeleton.Plan, low, centerPlaneForAxis, high, lowPoint, middlePoint, highPoint));
                }
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
                    try
                    {
                        var id = failure.GetFailureDefinitionId();
                        if (id != null) text = $"{text} [{id.Guid}]";
                    }
                    catch
                    {
                        // Older Revit builds can omit the definition id; the text is enough.
                    }

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
            List<string> warnings,
            IDictionary<string, Material> cache = null)
        {
            if (string.IsNullOrWhiteSpace(name)) return;

            try
            {
                var material = FindOrCreateMaterial(document, name, color, warnings, cache);
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
            List<string> warnings,
            IDictionary<string, Material> cache = null)
        {
            if (cache != null && cache.TryGetValue(name, out var cached)) return cached;

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

            if (material != null)
            {
                ApplyColor(material, color, warnings);
                if (cache != null) cache[name] = material;
            }
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
