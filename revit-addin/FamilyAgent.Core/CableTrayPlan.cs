using System;
using System.Collections.Generic;

namespace FamilyAgent.Core
{
    public sealed class PlanSegment
    {
        public double StartX;
        public double StartY;
        public double EndX;
        public double EndY;
    }

    /// <summary>
    /// Builds 2D plan-view coarse centerline segments (in feet) from each cable tray fitting
    /// connector inward to the fitting centreline intersection.
    /// </summary>
    public static class CableTrayPlan
    {
        private const double MmPerFoot = 304.8;

        private static double Value(Num? value, double fallback, ParameterSet parameters)
        {
            if (!value.HasValue) return fallback;
            var number = value.Value;
            if (!number.IsExpression) return number.Value;
            try
            {
                return Expression.Evaluate(number.Expression, parameters.Lookup);
            }
            catch
            {
                return fallback;
            }
        }

        public static List<PlanSegment> Build(
            IList<MepConnector> connectors,
            ParameterSet parameters,
            Bounds3 bounds)
        {
            var segments = new List<PlanSegment>();
            if (connectors == null || !bounds.IsValid) return segments;

            var centerX = (bounds.MinX + bounds.MaxX) / 2.0 / MmPerFoot;
            var centerY = (bounds.MinY + bounds.MaxY) / 2.0 / MmPerFoot;
            var spanX = (bounds.MaxX - bounds.MinX) / MmPerFoot;
            var spanY = (bounds.MaxY - bounds.MinY) / MmPerFoot;
            var horizontalMain = spanX >= spanY;

            foreach (var connector in connectors)
            {
                if (connector == null) continue;

                var startX = Value(connector.Origin.X, 0.0, parameters) / MmPerFoot;
                var startY = Value(connector.Origin.Y, 0.0, parameters) / MmPerFoot;
                var dirX = Value(connector.DirectionVector.X, 0.0, parameters);
                var dirY = Value(connector.DirectionVector.Y, 0.0, parameters);
                var len = Math.Sqrt(dirX * dirX + dirY * dirY);

                double endX;
                double endY;
                if (len < 1e-9)
                {
                    endX = centerX;
                    endY = centerY;
                }
                else
                {
                    var inX = -dirX / len;
                    var inY = -dirY / len;
                    if (horizontalMain)
                    {
                        if (Math.Abs(inY) < 1e-9)
                        {
                            endX = centerX;
                            endY = centerY;
                        }
                        else
                        {
                            var t = (centerY - startY) / inY;
                            if (t <= 1e-6)
                            {
                                endX = centerX;
                                endY = centerY;
                            }
                            else
                            {
                                endX = startX + inX * t;
                                endY = centerY;
                            }
                        }
                    }
                    else if (Math.Abs(inX) < 1e-9)
                    {
                        endX = centerX;
                        endY = centerY;
                    }
                    else
                    {
                        var t = (centerX - startX) / inX;
                        if (t <= 1e-6)
                        {
                            endX = centerX;
                            endY = centerY;
                        }
                        else
                        {
                            endX = centerX;
                            endY = startY + inY * t;
                        }
                    }
                }

                var minX = bounds.MinX / MmPerFoot;
                var maxX = bounds.MaxX / MmPerFoot;
                var minY = bounds.MinY / MmPerFoot;
                var maxY = bounds.MaxY / MmPerFoot;

                segments.Add(new PlanSegment
                {
                    StartX = Math.Min(maxX, Math.Max(minX, startX)),
                    StartY = Math.Min(maxY, Math.Max(minY, startY)),
                    EndX = Math.Min(maxX, Math.Max(minX, endX)),
                    EndY = Math.Min(maxY, Math.Max(minY, endY)),
                });
            }

            return segments;
        }
    }
}
