using System;
using Autodesk.Revit.DB;
using Autodesk.Revit.DB.ExtensibleStorage;

namespace FamilyAgent.Addin
{
    /// <summary>
    /// Stores the source spec inside the generated family using Extensible Storage, so the
    /// family can rebuild its own geometry after the user edits parameters in Revit.
    /// </summary>
    internal static class SpecStore
    {
        private static readonly Guid SchemaGuid = new Guid("8f3c2a91-5b7e-4c1d-9a2f-6d4e8b1c3a57");

        private static Schema GetSchema()
        {
            var existing = Schema.Lookup(SchemaGuid);
            if (existing != null) return existing;

            var builder = new SchemaBuilder(SchemaGuid);
            builder.SetSchemaName("FamilyAgentSpec");
            builder.SetReadAccessLevel(AccessLevel.Public);
            builder.SetWriteAccessLevel(AccessLevel.Public);
            builder.AddSimpleField("Json", typeof(string));
            return builder.Finish();
        }

        public static void Save(Document document, string json)
        {
            if (document == null || string.IsNullOrWhiteSpace(json)) return;

            var family = document.OwnerFamily;
            if (family == null) return;

            var schema = GetSchema();
            var entity = new Entity(schema);
            entity.Set("Json", json);
            family.SetEntity(entity);
        }

        public static string Load(Document document)
        {
            if (document == null) return null;

            var family = document.OwnerFamily;
            if (family == null) return null;

            var schema = Schema.Lookup(SchemaGuid);
            if (schema == null) return null;

            var entity = family.GetEntity(schema);
            if (!entity.IsValid()) return null;

            try
            {
                return entity.Get<string>("Json");
            }
            catch
            {
                return null;
            }
        }

        private static readonly Guid ModeSchemaGuid = new Guid("2c7d5e10-9a34-4f68-b1e2-73c5a90d4b18");

        private static Schema GetModeSchema()
        {
            var existing = Schema.Lookup(ModeSchemaGuid);
            if (existing != null) return existing;

            var builder = new SchemaBuilder(ModeSchemaGuid);
            builder.SetSchemaName("FamilyAgentMode");
            builder.SetReadAccessLevel(AccessLevel.Public);
            builder.SetWriteAccessLevel(AccessLevel.Public);
            builder.AddSimpleField("Mode", typeof(string));
            return builder.Finish();
        }

        /// <summary>
        /// How the family follows its parameters: "constraints" when the native dimension
        /// graph survived the flex check, "rebuild" when the add-in has to re-solve the spec.
        /// </summary>
        public static void SaveMode(Document document, string mode)
        {
            if (document == null || string.IsNullOrWhiteSpace(mode)) return;

            var family = document.OwnerFamily;
            if (family == null) return;

            var schema = GetModeSchema();
            var entity = new Entity(schema);
            entity.Set("Mode", mode);
            family.SetEntity(entity);
        }

        public static string LoadMode(Document document)
        {
            if (document == null) return null;

            var family = document.OwnerFamily;
            if (family == null) return null;

            var schema = Schema.Lookup(ModeSchemaGuid);
            if (schema == null) return null;

            var entity = family.GetEntity(schema);
            if (!entity.IsValid()) return null;

            try
            {
                return entity.Get<string>("Mode");
            }
            catch
            {
                return null;
            }
        }
    }
}
