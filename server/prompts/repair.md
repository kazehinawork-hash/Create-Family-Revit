The spec you returned failed validation or quality checks. Fix every issue below and return the complete corrected JSON object only.

Problems to resolve:
{{issues}}

Rules:
- Keep every part, parameter and material that already works. Change only what the issues require.
- Return the FULL spec, not a patch, a diff or a commentary.
- Every internal part (fans, coils, motors, filters) must sit strictly inside the casing.
- The condensate drain pan sits directly under the cooling coil, covers its footprint, and the drain outlet is at its lowest point.
- Pipe stubs and duct collars protrude outward from the casing with non-zero size.
- Every driving dimension is a parameter in group 'Dimensions', and every parameter is used.
- Derived sizes are formulas referencing their parent parameter, never copied numbers.
- No markdown fences, no prose. Raw JSON only.
