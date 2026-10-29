using System;
using System.Collections.Generic;
using System.Globalization;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;

namespace FamilyAgent.Core
{
    /// <summary>A number or an expression string, as returned by the model.</summary>
    [JsonConverter(typeof(NumConverter))]
    public struct Num
    {
        public double Value;
        public string Expression;

        public bool IsExpression => !string.IsNullOrWhiteSpace(Expression);

        public static Num Of(double value) => new Num { Value = value };
        public static implicit operator Num(double value) => Of(value);
        public static implicit operator Num(string expression) => new Num { Expression = expression };
    }

    public sealed class NumConverter : JsonConverter<Num>
    {
        public override Num ReadJson(JsonReader reader, Type objectType, Num existingValue, bool hasExistingValue, JsonSerializer serializer)
        {
            switch (reader.TokenType)
            {
                case JsonToken.Integer:
                case JsonToken.Float:
                    return new Num { Value = Convert.ToDouble(reader.Value, CultureInfo.InvariantCulture) };
                case JsonToken.String:
                    return new Num { Expression = (string)reader.Value };
                case JsonToken.Null:
                    return default;
                default:
                    throw new JsonSerializationException($"Expected a number or an expression string, got {reader.TokenType}");
            }
        }

        public override void WriteJson(JsonWriter writer, Num value, JsonSerializer serializer)
        {
            if (value.IsExpression) writer.WriteValue(value.Expression);
            else writer.WriteValue(value.Value);
        }
    }

    public struct Vec3
    {
        public Num X;
        public Num Y;
        public Num Z;

        public Vec3(double x, double y, double z)
        {
            X = Num.Of(x);
            Y = Num.Of(y);
            Z = Num.Of(z);
        }

        public Vec3(Num x, Num y, Num z)
        {
            X = x;
            Y = y;
            Z = z;
        }

        public bool IsSet => Math.Abs(X.Value) > double.Epsilon || Math.Abs(Y.Value) > double.Epsilon || Math.Abs(Z.Value) > double.Epsilon || X.IsExpression || Y.IsExpression || Z.IsExpression;
    }

    public sealed class SolidPrimitive
    {
        public string Kind { get; set; }
        public Vec3 Origin { get; set; }
        public Vec3 Size { get; set; }
        public Vec3 Base { get; set; }
        public Num? Radius { get; set; }
        public Num? InnerRadius { get; set; }
        public Num? Height { get; set; }
        public Num? RotationZ { get; set; }
        public Num? CornerRadius { get; set; }
        public Num? From { get; set; }
        public Num? To { get; set; }
        public string Axis { get; set; }
        public string Plane { get; set; }
        public List<List<Num>> Points { get; set; }
        public int? Segments { get; set; }
    }

    public sealed class PartArray
    {
        public Num Count { get; set; } = Num.Of(1);
        public string Axis { get; set; } = "x";
        public Num Spacing { get; set; }
    }

    public sealed class FamilyPart
    {
        public string Id { get; set; }
        public string Name { get; set; }
        public string Material { get; set; }
        public string Color { get; set; }
        public SolidPrimitive Solid { get; set; }
        public List<SolidPrimitive> Cuts { get; set; }
        public PartArray Array { get; set; }
    }

    public sealed class FamilyParameter
    {
        public string Name { get; set; }
        public string Type { get; set; }
        public string Group { get; set; }
        public object Value { get; set; }
        public string Formula { get; set; }
        public bool Instance { get; set; }
        public string Description { get; set; }
    }

    public sealed class MaterialDef
    {
        public string Name { get; set; }
        public string Color { get; set; }
        public double? Metalness { get; set; }
        public double? Roughness { get; set; }
    }

    public sealed class FamilySpec
    {
        public string SchemaVersion { get; set; }
        public string Name { get; set; }
        public string TypeName { get; set; }
        public string Category { get; set; }
        public string Template { get; set; }
        public string Units { get; set; }
        public string RevitVersion { get; set; }
        public int? Lod { get; set; }
        public string Description { get; set; }
        public List<FamilyParameter> Parameters { get; set; } = new List<FamilyParameter>();
        public List<FamilyPart> Parts { get; set; } = new List<FamilyPart>();
        public List<MaterialDef> Materials { get; set; }
        public List<string> Notes { get; set; }
    }

    public sealed class SpecException : Exception
    {
        public SpecException(string message) : base(message) { }
    }

    public static class SpecLoader
    {
        private static readonly JsonSerializerSettings Settings = new JsonSerializerSettings
        {
            MissingMemberHandling = MissingMemberHandling.Ignore,
            NullValueHandling = NullValueHandling.Ignore,
            DateParseHandling = DateParseHandling.None,
        };

        public static FamilySpec Load(string json)
        {
            if (string.IsNullOrWhiteSpace(json))
                throw new SpecException("The spec is empty");

            FamilySpec spec;
            try
            {
                spec = JsonConvert.DeserializeObject<FamilySpec>(json, Settings);
            }
            catch (JsonException ex)
            {
                throw new SpecException($"The spec is not valid JSON: {ex.Message}");
            }

            if (spec == null) throw new SpecException("The spec is empty");

            var problems = new List<string>();
            if (string.IsNullOrWhiteSpace(spec.Name)) spec.Name = "Untitled Family";
            if (string.IsNullOrWhiteSpace(spec.Category)) spec.Category = "Generic Model";
            if (spec.Parameters == null) spec.Parameters = new List<FamilyParameter>();
            if (spec.Parts == null) spec.Parts = new List<FamilyPart>();

            if (spec.Parts.Count == 0) problems.Add("parts must contain at least one part");

            foreach (var part in spec.Parts)
            {
                if (part == null) continue;
                if (part.Solid == null) problems.Add($"part \"{part.Id ?? part.Name ?? "?"}\" has no solid");
                if (part.Cuts == null) part.Cuts = new List<SolidPrimitive>();
                if (part.Array == null) part.Array = new PartArray { Count = Num.Of(1), Axis = "x", Spacing = Num.Of(0) };
                if (string.IsNullOrWhiteSpace(part.Id)) part.Id = part.Name ?? "part";
                if (string.IsNullOrWhiteSpace(part.Name)) part.Name = part.Id;
            }

            if (problems.Count > 0) throw new SpecException(string.Join("; ", problems));

            return spec;
        }

        public static JObject ParseLoose(string json)
        {
            try
            {
                return JObject.Parse(json);
            }
            catch (JsonException)
            {
                return null;
            }
        }
    }
}
