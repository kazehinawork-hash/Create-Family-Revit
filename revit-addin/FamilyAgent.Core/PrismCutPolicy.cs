using System;

namespace FamilyAgent.Core
{
    /// <summary>
    /// Shared rule for prism cuts that cannot become an inner loop (blind, rotated,
    /// crossing the profile). A thick prism simply goes through the generic boolean
    /// path; only a genuinely thin plate keeps the native form and skips the cut.
    /// Mirrored by MIN_REMAINING_MM / THIN_PRISM_MM in spec-core/src/topology.ts.
    /// </summary>
    public static class PrismCutPolicy
    {
        public const double MinRemainingMm = 0.8;
        public const double ThinPrismMm = 3.0;

        /// <summary>Material left under a blind cut, or +infinity for a through cut.</summary>
        public static double RemainingForBlindCut(
            double prismLow,
            double prismHigh,
            double cutLow,
            double cutHigh)
        {
            var low = Math.Min(cutLow, cutHigh);
            var high = Math.Max(cutLow, cutHigh);
            var reachesLow = low <= prismLow + 0.01;
            var reachesHigh = high >= prismHigh - 0.01;
            if (reachesLow && reachesHigh) return double.PositiveInfinity;
            // A cut open at one face only has to keep the opposite wall thick enough.
            if (reachesLow) return Math.Max(0, prismHigh - high);
            if (reachesHigh) return Math.Max(0, low - prismLow);
            return Math.Max(0, Math.Min(low - prismLow, prismHigh - high));
        }

        /// <summary>True when a boolean cut is too fragile, so the native form wins.</summary>
        public static bool IsTooThinForBoolean(double prismThickness, double remainingMm = double.PositiveInfinity)
        {
            return prismThickness < ThinPrismMm || remainingMm < MinRemainingMm;
        }
    }
}
