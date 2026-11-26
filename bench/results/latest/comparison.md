# Family Agent Design Benchmark

- Mode: `stub` | Model: `default` | Runs/case: `1`

## Summary (Before vs After Sheet-Metal Macro)

| Scope | Metric | Before | After | Delta |
|---|---|---:|---:|---:|
| All (24) | Pass Rate | 13/24 | 24/24 | +11 |
| All (24) | Avg Score | 84.3 | 98.5 | +14.2 |
| Tray Macro (11) | Pass Rate | 0/11 | 11/11 | +11 |
| Tray Macro (11) | Avg Score | 68.6 | 99.6 | +31.0 |

## Per-case Results

| # | Case | Group | Before | After | Delta | Bounds (mm) | Macro |
|---|---|---|---:|---:|---:|---|---|
| 1 | `tray-straight-400x100` | tray-macro | 83 (FAIL) | 100 (OK) | +17.0 | 1000×403.6×100 | yes |
| 2 | `tray-elbow-90-400x100` | tray-macro | 78 (FAIL) | 100 (OK) | +22.0 | 701.8×701.8×100 | yes |
| 3 | `ladder-elbow-90-500x100` | tray-macro | 65 (FAIL) | 96 (OK) | +31.0 | 1101.8×1101.8×100 | yes |
| 4 | `tray-elbow-45-300x100` | tray-macro | 61 (FAIL) | 100 (OK) | +39.0 | 875.3×576.8×100 | yes |
| 5 | `tray-z-offset-400x100` | tray-macro | 61 (FAIL) | 100 (OK) | +39.0 | 800×903.6×100 | yes |
| 6 | `tray-elbow-90-lid-400x100` | tray-macro | 81 (FAIL) | 100 (OK) | +19.0 | 701.8×701.8×101.8 | yes |
| 7 | `tray-elbow-no-flange-200x50` | tray-macro | 64 (FAIL) | 100 (OK) | +36.0 | 451.5×451.5×50 | yes |
| 8 | `tray-s-offset-45-300x75` | tray-macro | 61 (FAIL) | 100 (OK) | +39.0 | 1047.5×550.5×75 | yes |
| 9 | `tray-u-turn-180-400x100` | tray-macro | 70 (FAIL) | 100 (OK) | +30.0 | 601.8×903.6×100 | yes |
| 10 | `tray-step-45-elbow-500x100` | tray-macro | 61 (FAIL) | 100 (OK) | +39.0 | 1131.7×783.7×100 | yes |
| 11 | `ladder-mitered-tee-400x300` | ladder-fitting | 96 (OK) | 96 (OK) | +0.0 | 940×485×100 | no |
| 12 | `ladder-mitered-cross-400x400` | ladder-fitting | 96 (OK) | 96 (OK) | +0.0 | 940×940×100 | no |
| 13 | `tray-tee-equal-400x100` | tray-fitting | 96 (OK) | 96 (OK) | +0.0 | 940×535×100 | no |
| 14 | `tray-cross-unequal-400x200` | tray-fitting | 92 (OK) | 92 (OK) | +0.0 | 940×740×100 | no |
| 15 | `tray-reducer-concentric-400x200` | tray-fitting | 100 (OK) | 100 (OK) | +0.0 | 350×401.8×100 | no |
| 16 | `tray-reducer-eccentric-500x300` | tray-fitting | 100 (OK) | 100 (OK) | +0.0 | 350×501.8×100 | no |
| 17 | `tray-vertical-inside-riser-400x100` | tray-vertical | 100 (OK) | 100 (OK) | +0.0 | 450.9×400×450 | no |
| 18 | `tray-vertical-outside-elbow-400x100` | tray-vertical | 100 (OK) | 100 (OK) | +0.0 | 450.9×400×450 | no |
| 19 | `tray-straight-slotted-600x100` | tray-macro | 70 (FAIL) | 100 (OK) | +30.0 | 1000×604×100 | yes |
| 20 | `tray-splice-plate-h100` | tray-accessory | 100 (OK) | 100 (OK) | +0.0 | 200×15.5×100 | no |
| 21 | `duct-transition-400x200-to-300` | mep-general | 100 (OK) | 100 (OK) | +0.0 | 400×300×430 | no |
| 22 | `pipe-y-strainer-dn80` | mep-general | 94 (OK) | 94 (OK) | +0.0 | 310×200×261 | no |
| 23 | `strut-channel-p1000-1000` | mep-general | 99 (OK) | 99 (OK) | +0.0 | 1000×41×41 | no |
| 24 | `ahu-compact-1200x700x600` | mep-general | 96 (OK) | 96 (OK) | +0.0 | 1260×700×600 | no |
