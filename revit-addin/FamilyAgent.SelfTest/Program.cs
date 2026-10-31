using System;
using System.Collections.Generic;
using System.IO;
using FamilyAgent.Core;

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

        private static string FindExample()
        {
            var directory = new DirectoryInfo(AppContext.BaseDirectory);
            while (directory != null)
            {
                var candidate = Path.Combine(directory.FullName, "spec", "examples", "fcu-080.json");
                if (File.Exists(candidate)) return candidate;
                directory = directory.Parent;
            }
            throw new FileNotFoundException("Could not find spec/examples/fcu-080.json");
        }

        private static int Main(string[] args)
        {
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
                ExpectClose(bounds.MaxX - bounds.MinX, 380, 1e-9, "width");
                ExpectClose(bounds.MaxZ - bounds.MinZ, 80, 1e-9, "depth");
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

            Console.WriteLine();
            Console.WriteLine(_failures == 0 ? "All core checks passed." : $"{_failures} check(s) failed.");
            return _failures == 0 ? 0 : 1;
        }
    }
}
