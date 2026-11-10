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
            return Math.Abs(solid.Height) > 1e-9 &&
                   (solid.RadiusBottom > 1e-9 || solid.RadiusTop > 1e-9);
        }

        /// <summary>
        /// Builds a frustum on any axis as a native Revolution of its trapezoid profile.
        /// A Revolution keeps true circular edges (a Blend is fully tessellated), so the
        /// form stays native and the height can still take a face dimension.
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

            var height = Ft(Math.Abs(solid.Height));
            var bottom = Ft(solid.Height >= 0 ? solid.RadiusBottom : solid.RadiusTop);
            var top = Ft(solid.Height >= 0 ? solid.RadiusTop : solid.RadiusBottom);
            if (height <= 1e-9 || (bottom <= 1e-9 && top <= 1e-9)) return null;

            try
            {
                var origin = new XYZ(
                    Ft(solid.Base.X + offset.X),
                    Ft(solid.Base.Y + offset.Y),
                    Ft(solid.Base.Z + offset.Z));

                XYZ axisUnit;
                XYZ radial;
                switch (solid.Axis)
                {
                    case "x":
                        axisUnit = XYZ.BasisX;
                        radial = XYZ.BasisY;
                        break;
                    case "y":
                        axisUnit = XYZ.BasisY;
                        radial = XYZ.BasisZ;
                        break;
                    default:
                        axisUnit = XYZ.BasisZ;
                        radial = XYZ.BasisX;
                        break;
                }

                // Negative height runs the frustum backwards along the axis; the radii
                // are already swapped above so the profile still starts at the base.
                var direction = axisUnit * (solid.Height >= 0 ? 1 : -1);
                XYZ At(double along, double radius) => origin + direction * along + radial * radius;

                var profile = new CurveArray();
                if (bottom > 1e-9)
                {
                    profile.Append(Line.CreateBound(At(0, 0), At(0, bottom)));
                }
                profile.Append(Line.CreateBound(At(0, bottom), At(height, top)));
                if (top > 1e-9)
                {
                    profile.Append(Line.CreateBound(At(height, top), At(height, 0)));
                }
                profile.Append(Line.CreateBound(At(height, 0), At(0, 0)));

                var loops = new CurveArrArray();
                loops.Append(profile);

                var sketch = SketchPlane.Create(
                    document,
                    Plane.CreateByOriginAndBasis(origin, direction, radial));
                var axis = Line.CreateUnbound(origin, direction);

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
