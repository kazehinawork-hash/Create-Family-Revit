using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using FamilyAgent.Core;
using Newtonsoft.Json;

namespace FamilyAgent.SelfTest
{
    internal static class Program
    {
        private static int _failures;

        private static void Check(string name, Action test)
        {
            try
            {
                test();
                Console.WriteLine($"PASS  {name}");
            }
            catch (Exception ex)
            {
                _failures += 1;
                Console.WriteLine($"FAIL  {name}");
                Console.WriteLine($"      {ex.Message}");
            }
        }

        private static void Expect(bool condition, string message)
        {
            if (!condition) throw new Exception(message);
        }

        private static void ExpectClose(double actual, double expected, double tolerance, string message)
        {
            if (Math.Abs(actual - expected) > tolerance)
                throw new Exception($"{message}: expected {expected}, got {actual}");
        }

        private static string FindExamplesDir()
        {
            var directory = new DirectoryInfo(AppContext.BaseDirectory);
            while (directory != null)
            {
                var candidate = Path.Combine(directory.FullName, "spec", "examples");
                if (Directory.Exists(candidate)) return candidate;
                directory = directory.Parent;
            }
            throw new DirectoryNotFoundException("Could not find spec/examples");
        }

        private static string FindExample()
        {
            var candidate = Path.Combine(FindExamplesDir(), "fcu-080.json");
            if (File.Exists(candidate)) return candidate;
            throw new FileNotFoundException("Could not find spec/examples/fcu-080.json");
        }

        private static int Main(string[] args)
        {
            if (args != null && args.Any(argument => argument == "--dump-parity"))
            {
                return DumpParity();
            }

            var lookup = new Func<string, double>(name =>
            {
                switch (name.ToLowerInvariant())
                {
                    case "casing length": return 1910;
                    case "flange width": return 30;
                    default: throw new ExpressionException($"Unknown parameter \"{name}\"");
                }
            });

            Check("arithmetic precedence", () =>
            {
                ExpectClose(Expression.Evaluate("1 + 2 * 3", lookup), 7, 1e-9, "1 + 2 * 3");
                ExpectClose(Expression.Evaluate("2 ^ 3 ^ 2", lookup), 512, 1e-9, "2 ^ 3 ^ 2");
            });

            Check("parameter references", () =>
            {
                ExpectClose(Expression.Evaluate("[Casing Length] + 2 * [Flange Width]", lookup), 1970, 1e-6, "overall width");
            });

            Check("unit literals", () =>
            {
                ExpectClose(Expression.Evaluate("1in + 1ft", lookup), 330.2, 1e-6, "inches and feet");
                ExpectClose(Expression.Evaluate("560mm - 140mm", lookup), 420, 1e-9, "mm literals");
            });

            Check("functions use degrees", () =>
            {
                ExpectClose(Expression.Evaluate("sin(30)", lookup), 0.5, 1e-9, "sin 30");
                ExpectClose(Expression.Evaluate("round(2.5)", lookup), 3, 1e-9, "round half away");
                ExpectClose(Expression.Evaluate("pi()", lookup), Math.PI, 1e-9, "pi()");
            });

            Check("division by zero is reported", () =>
            {
                try
                {
                    Expression.Evaluate("1 / 0", lookup);
                    throw new Exception("expected an exception");
                }
                catch (ExpressionException ex)
                {
                    Expect(ex.Message.Contains("zero"), "message should mention zero");
                }
            });

            Check("example spec loads and resolves", () =>
            {
                var json = File.ReadAllText(FindExample());
                var spec = SpecLoader.Load(json);
                var parameters = ParameterResolver.Resolve(spec);
                var model = GeometryResolver.Resolve(spec, parameters);

                Expect(spec.Name.StartsWith("Trane"), "family name");
                Expect(model.Warnings.Count == 0, $"unexpected warnings: {string.Join("; ", model.Warnings)}");
                Expect(model.Parts.Count == 13, $"expected 13 parts, got {model.Parts.Count}");

                var size = model.Bounds.Size;
                ExpectClose(size.X, 2020, 0.01, "overall width");
                ExpectClose(size.Z, 605, 0.01, "overall height");

                var casingLength = parameters.ByKey["Casing Length"];
                Expect(casingLength.Formula == null, "Casing Length is a base size");
                ExpectClose(casingLength.Number ?? -1, 1910, 0.01, "Casing Length value");
            });

            Check("frustum resolves with the larger-radius bounds", () =>
            {
                const string json = @"{
                  ""name"": ""Cone"",
                  ""category"": ""Generic Model"",
                  ""parameters"": [],
                  ""parts"": [{
                    ""id"": ""cone"",
                    ""name"": ""Cone"",
                    ""solid"": {
                      ""kind"": ""frustum"",
                      ""base"": { ""x"": 0, ""y"": 0, ""z"": 0 },
                      ""radiusBottom"": 200,
                      ""radiusTop"": 80,
                      ""height"": 300
                    }
                  }]
                }";

                var spec = SpecLoader.Load(json);
                var parameters = ParameterResolver.Resolve(spec);
                var model = GeometryResolver.Resolve(spec, parameters);

                Expect(model.Warnings.Count == 0, $"unexpected warnings: {string.Join("; ", model.Warnings)}");
                Expect(model.Parts.Count == 1, "one part");

                var solid = model.Parts[0].Solid;
                Expect(solid.Kind == "frustum", "kind");
                ExpectClose(solid.RadiusBottom, 200, 1e-9, "radiusBottom");
                ExpectClose(solid.RadiusTop, 80, 1e-9, "radiusTop");

                var bounds = GeometryResolver.BoundsOf(solid);
                ExpectClose(bounds.MaxX - bounds.MinX, 400, 1e-9, "width");
                ExpectClose(bounds.MaxZ - bounds.MinZ, 300, 1e-9, "height");
            });

            Check("bend resolves with an elbow envelope", () =>
            {
                const string json = @"{
                  ""name"": ""Elbow"",
                  ""category"": ""Pipe Fitting"",
                  ""parameters"": [],
                  ""parts"": [{
                    ""id"": ""elbow"",
                    ""name"": ""Elbow"",
                    ""solid"": {
                      ""kind"": ""bend"",
                      ""center"": { ""x"": 0, ""y"": 0, ""z"": 0 },
                      ""radius"": 150,
                      ""tubeRadius"": 40,
                      ""angle"": 90,
                      ""plane"": ""xy""
                    }
                  }]
                }";

                var spec = SpecLoader.Load(json);
                var parameters = ParameterResolver.Resolve(spec);
                var model = GeometryResolver.Resolve(spec, parameters);

                Expect(model.Warnings.Count == 0, $"unexpected warnings: {string.Join("; ", model.Warnings)}");
                Expect(model.Parts.Count == 1, "one part");

                var solid = model.Parts[0].Solid;
                Expect(solid.Kind == "bend", "kind");
                ExpectClose(solid.Radius, 150, 1e-9, "radius");
                ExpectClose(solid.TubeRadius, 40, 1e-9, "tubeRadius");
                ExpectClose(solid.Angle, 90, 1e-9, "angle");

                var bounds = GeometryResolver.BoundsOf(solid);
                ExpectClose(bounds.MaxX - bounds.MinX, 190, 1e-6, "width");
                ExpectClose(bounds.MaxY - bounds.MinY, 190, 1e-6, "depth");
                ExpectClose(bounds.MaxZ - bounds.MinZ, 80, 1e-6, "height");
            });

            Check("part anchor is resolved", () =>
            {
                const string json = @"{
                  ""name"": ""Anchored"",
                  ""category"": ""Generic Model"",
                  ""parameters"": [],
                  ""parts"": [{
                    ""id"": ""body"",
                    ""name"": ""Body"",
                    ""anchor"": { ""x"": ""min"", ""z"": ""max"" },
                    ""solid"": {
                      ""kind"": ""box"",
                      ""origin"": { ""x"": 0, ""y"": 0, ""z"": 0 },
                      ""size"": { ""x"": 100, ""y"": 100, ""z"": 100 }
                    }
                  }]
                }";

                var spec = SpecLoader.Load(json);
                var parameters = ParameterResolver.Resolve(spec);
                var model = GeometryResolver.Resolve(spec, parameters);

                Expect(model.Parts.Count == 1, "one part");
                var anchor = model.Parts[0].Anchor;
                Expect(anchor != null, "anchor present");
                Expect(anchor.X == "min", "x = min");
                Expect(anchor.Z == "max", "z = max");
                Expect(anchor.ForAxis("y") == null, "y unset");
            });

            Check("formula errors do not throw", () =>
            {
                var spec = new FamilySpec
                {
                    Name = "Broken",
                    Parts = new List<FamilyPart>
                    {
                        new FamilyPart
                        {
                            Id = "one",
                            Name = "One",
                            Solid = new SolidPrimitive
                            {
                                Kind = "box",
                                Origin = new Vec3(0, 0, 0),
                                Size = new Vec3("nope(", 100, 100),
                            },
                        },
                    },
                    Parameters = new List<FamilyParameter>
                    {
                        new FamilyParameter { Name = "A", Type = "Length", Formula = "[Missing] * 2" },
                    },
                };

                var parameters = ParameterResolver.Resolve(spec);
                var model = GeometryResolver.Resolve(spec, parameters);
                Expect(parameters.Errors.Count > 0, "parameter error expected");
                Expect(model.Warnings.Count > 0, "geometry warning expected");
                Expect(model.Parts.Count == 0, "broken part should be skipped");
            });

            Check("loft resolves both profiles to one ring", () =>
            {
                const string json = @"{
                  ""name"": ""Transition"",
                  ""category"": ""Duct Transition"",
                  ""parameters"": [],
                  ""parts"": [{
                    ""id"": ""transition"",
                    ""name"": ""Transition"",
                    ""solid"": {
                      ""kind"": ""loft"",
                      ""axis"": ""z"",
                      ""segments"": 16,
                      ""sections"": [
                        { ""at"": 0, ""profile"": { ""kind"": ""rect"", ""width"": 500, ""height"": 300 } },
                        { ""at"": 400, ""profile"": { ""kind"": ""circle"", ""radius"": 150 } }
                      ]
                    }
                  }]
                }";

                var spec = SpecLoader.Load(json);
                var parameters = ParameterResolver.Resolve(spec);
                var model = GeometryResolver.Resolve(spec, parameters);

                Expect(model.Warnings.Count == 0, $"unexpected warnings: {string.Join("; ", model.Warnings)}");
                Expect(model.Parts.Count == 1, "one part");
                var solid = model.Parts[0].Solid;
                Expect(solid.Kind == "loft", "kind");
                Expect(solid.Sections.Count == 2, "two sections");
                Expect(solid.Sections[0].Points.Count == solid.Sections[1].Points.Count, "same ring size");

                var bounds = GeometryResolver.BoundsOf(solid);
                ExpectClose(bounds.MaxX - bounds.MinX, 500, 1e-6, "width");
                ExpectClose(bounds.MaxY - bounds.MinY, 300, 1e-6, "depth");
                ExpectClose(bounds.MaxZ - bounds.MinZ, 400, 1e-6, "height");
            });

            Check("revolve resolves profile into native revolution envelope", () =>
            {
                const string json = @"{
                  ""name"": ""Handwheel"",
                  ""category"": ""Pipe Fitting"",
                  ""parameters"": [],
                  ""parts"": [{
                    ""id"": ""wheel"",
                    ""name"": ""Handwheel"",
                    ""solid"": {
                      ""kind"": ""revolve"",
                      ""axis"": ""z"",
                      ""origin"": { ""x"": 0, ""y"": 0, ""z"": 100 },
                      ""points"": [
                        [0, 0],
                        [80, 0],
                        [70, 20],
                        [0, 20]
                      ],
                      ""angle"": 360,
                      ""startAngle"": 0
                    }
                  }]
                }";

                var spec = SpecLoader.Load(json);
                var parameters = ParameterResolver.Resolve(spec);
                var model = GeometryResolver.Resolve(spec, parameters);

                Expect(model.Warnings.Count == 0, $"unexpected warnings: {string.Join("; ", model.Warnings)}");
                Expect(model.Parts.Count == 1, "one part");
                var solid = model.Parts[0].Solid;
                Expect(solid.Kind == "revolve", "kind");

                var bounds = GeometryResolver.BoundsOf(solid);
                ExpectClose(bounds.MaxX - bounds.MinX, 160, 1e-6, "width");
                ExpectClose(bounds.MaxY - bounds.MinY, 160, 1e-6, "depth");
                ExpectClose(bounds.MaxZ - bounds.MinZ, 20, 1e-6, "height");
            });

            Check("tube resolves an arbitrary-axis envelope", () =>
            {
                const string json = @"{
                  ""name"": ""Inclined Branch"",
                  ""category"": ""Pipe Fitting"",
                  ""parameters"": [],
                  ""parts"": [{
                    ""id"": ""branch"",
                    ""name"": ""Inclined Branch"",
                    ""solid"": {
                      ""kind"": ""tube"",
                      ""start"": { ""x"": 0, ""y"": 0, ""z"": 0 },
                      ""end"": { ""x"": 100, ""y"": 0, ""z"": 100 },
                      ""radius"": 20
                    }
                  }]
                }";

                var spec = SpecLoader.Load(json);
                var parameters = ParameterResolver.Resolve(spec);
                var model = GeometryResolver.Resolve(spec, parameters);

                Expect(model.Warnings.Count == 0, $"unexpected warnings: {string.Join("; ", model.Warnings)}");
                Expect(model.Parts.Count == 1, "one part");
                var solid = model.Parts[0].Solid;
                Expect(solid.Kind == "tube", "kind");

                var bounds = GeometryResolver.BoundsOf(solid);
                var extent = 20.0 * Math.Sqrt(0.5);
                ExpectClose(bounds.MinX, -extent, 1e-6, "min x");
                ExpectClose(bounds.MaxX, 100 + extent, 1e-6, "max x");
                ExpectClose(bounds.MinY, -20, 1e-6, "min y");
                ExpectClose(bounds.MaxY, 20, 1e-6, "max y");
                ExpectClose(bounds.MinZ, -extent, 1e-6, "min z");
                ExpectClose(bounds.MaxZ, 100 + extent, 1e-6, "max z");
            });

            Check("every example spec resolves in the C# resolver", () =>
            {
                var examples = FindExamplesDir();
                var files = Directory.GetFiles(examples, "*.json");
                Expect(files.Length >= 3, "expected at least three example specs");

                foreach (var file in files)
                {
                    var name = Path.GetFileName(file);
                    var spec = SpecLoader.Load(File.ReadAllText(file));
                    var parameters = ParameterResolver.Resolve(spec);
                    Expect(
                        parameters.Errors.Count == 0,
                        $"{name}: {string.Join("; ", parameters.Errors)}");

                    var model = GeometryResolver.Resolve(spec, parameters);
                    Expect(model.Parts.Count > 0, $"{name} produced no parts");
                    Expect(
                        model.Bounds.Size.X > 0 && model.Bounds.Size.Y > 0 && model.Bounds.Size.Z > 0,
                        $"{name} has empty bounds");
                }
            });

            Console.WriteLine();
            Console.WriteLine(_failures == 0 ? "All core checks passed." : $"{_failures} check(s) failed.");
            return _failures == 0 ? 0 : 1;
        }

        /// <summary>
        /// Machine-readable dump used by scripts/parity.mjs to compare the TS and C#
        /// resolvers on every example spec. Kept out of the normal self-test output so
        /// the console checks stay readable.
        /// </summary>
        private static int DumpParity()
        {
            var examples = FindExamplesDir();
            var files = Directory.GetFiles(examples, "*.json");
            Array.Sort(files, StringComparer.OrdinalIgnoreCase);
            var results = new List<object>();

            foreach (var file in files)
            {
                var name = Path.GetFileName(file);
                try
                {
                    var spec = SpecLoader.Load(File.ReadAllText(file));
                    var parameters = ParameterResolver.Resolve(spec);
                    var model = GeometryResolver.Resolve(spec, parameters);

                    var partBounds = new List<object>();
                    foreach (var part in model.Parts)
                    {
                        var bounds = GeometryResolver.BoundsOf(part.Solid);
                        partBounds.Add(new
                        {
                            id = part.Id,
                            min = new { x = bounds.MinX, y = bounds.MinY, z = bounds.MinZ },
                            max = new { x = bounds.MaxX, y = bounds.MaxY, z = bounds.MaxZ },
                        });
                    }

                    results.Add(new
                    {
                        file = name,
                        ok = parameters.Errors.Count == 0,
                        errors = parameters.Errors,
                        parts = model.Parts.Count,
                        instances = model.Instances,
                        parameters = parameters.Ordered.Count,
                        bounds = new
                        {
                            min = new
                            {
                                x = model.Bounds.MinX,
                                y = model.Bounds.MinY,
                                z = model.Bounds.MinZ,
                            },
                            max = new
                            {
                                x = model.Bounds.MaxX,
                                y = model.Bounds.MaxY,
                                z = model.Bounds.MaxZ,
                            },
                            size = new
                            {
                                x = model.Bounds.Size.X,
                                y = model.Bounds.Size.Y,
                                z = model.Bounds.Size.Z,
                            },
                        },
                        partBounds,
                    });
                }
                catch (Exception ex)
                {
                    results.Add(new { file = name, ok = false, error = ex.Message });
                }
            }

            Console.WriteLine(JsonConvert.SerializeObject(results, Formatting.None));
            return 0;
        }
    }
}
