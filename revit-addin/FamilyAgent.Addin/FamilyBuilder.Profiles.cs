using System;
using System.Collections.Generic;
using Autodesk.Revit.DB;
using FamilyAgent.Core;

namespace FamilyAgent.Addin
{
    internal static partial class FamilyBuilder
    {
        private static bool IsProfileFrustum(ResolvedSolid solid)
        {
            return string.Equals(solid.Axis, "z", StringComparison.OrdinalIgnoreCase) &&
                   solid.Height > 1e-9 &&
                   solid.RadiusBottom > 1e-9;
        }

        /// <summary>
        /// Builds a Z-axis frustum as a native Revolution of its trapezoid profile. A
        /// Revolution keeps true circular edges (a Blend is fully tessellated), so the later
        /// face and radial dimension passes can still label its height and radii.
        ///
        /// The profile touches the axis, which Revit's NewRevolveForms refuses, so the
        /// curve-array overload is the only viable native form here. Radii are therefore
        /// baked; height is driven by the face dimension created afterwards.
        /// </summary>
        private static Element CreateFrustumRevolve(
            Document document,
            ResolvedSolid solid,
            Vec3d offset,
            List<string> warnings)
        {
            if (!IsProfileFrustum(solid)) return null;

            var height = Ft(solid.Height);
            var bottom = Ft(solid.RadiusBottom);
            var top = Ft(solid.RadiusTop);
            if (height <= 1e-9 || bottom <= 1e-9) return null;

            try
            {
                var origin = new XYZ(
                    Ft(solid.Base.X + offset.X),
                    Ft(solid.Base.Y + offset.Y),
                    Ft(solid.Base.Z + offset.Z));

                var u = XYZ.BasisX;
                var v = XYZ.BasisZ;
                XYZ At(double du, double dv) => origin + u * du + v * dv;

                var profile = new CurveArray();
                profile.Append(Line.CreateBound(At(0, 0), At(bottom, 0)));
                profile.Append(Line.CreateBound(At(bottom, 0), At(top, height)));
                if (top > 1e-6)
                {
                    profile.Append(Line.CreateBound(At(top, height), At(0, height)));
                }
                profile.Append(Line.CreateBound(At(0, height), At(0, 0)));

                var loops = new CurveArrArray();
                loops.Append(profile);

                var sketch = SketchPlane.Create(
                    document,
                    Plane.CreateByOriginAndBasis(origin, u, v));
                var axis = Line.CreateUnbound(origin, XYZ.BasisZ);

                return document.FamilyCreate.NewRevolution(
                    true,
                    loops,
                    sketch,
                    axis,
                    0,
                    2 * Math.PI);
            }
            catch (Exception ex)
            {
                if (warnings.Count < 40) warnings.Add($"Frustum revolution: {ex.Message}");
                return null;
            }
        }
    }
}
