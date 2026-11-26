# HANDOVER — CREATE-FAMILY-REVIT

> **Nhánh hiện tại:** `feature/studio-v12` (kế thừa `main` với các bản phát hành `#36`–`#40`)  
> **Kiến trúc cốt lõi:** `LLM → Spec JSON → @family/spec-core → Studio 3D (Three.js) & Revit 2024 Add-in (.rfa)`

---

## 1. Kiến trúc tổng thể

```
Mô tả / Ảnh / Datasheet PDF
        │
        ▼
  Agent Server (server/src/designer.js)
  ├─ Prompt blocks có điều kiện (server/src/prompt-blocks.js + server/prompts/designer.md)
  ├─ Auto-heal & patch merge (autoHealSpec, server/src/patch.js)
  └─ Validate + Expand Macros + Migrate (packages/spec-core)
        │
        ▼
  Spec JSON (schemaVersion: "1.0", specVersion: 2)
        │
        ├──────────────────────────────────┐
        ▼                                  ▼
  Web Studio (web/)                Revit 2024 Add-in (revit-addin/)
  ├─ Three.js Viewer + CAD Grid    ├─ FamilyAgent.Core (C# spec-core parity)
  ├─ Parameter / Types / Notes     ├─ FamilyAgent.Addin (HTTP bridge :8765)
  └─ Library / Trash / History     └─ Build .rfa native + Reference Planes + Types
```

### Các package chính
- [`packages/spec-core`](packages/spec-core): TypeScript core dùng chung cho web và server:
  - [`types.ts`](packages/spec-core/src/types.ts), [`expr.ts`](packages/spec-core/src/expr.ts), [`parameters.ts`](packages/spec-core/src/parameters.ts), [`geometry.ts`](packages/spec-core/src/geometry.ts)
  - [`macros.ts`](packages/spec-core/src/macros.ts): Macro thép tấm `trayRun` bung thành các `prism` khép kín và `connectors`.
  - [`migrate.ts`](packages/spec-core/src/migrate.ts): Di trú spec cũ (`specVersion < 2` / lỗi regex đơn vị `1mm0mm`) khi load trên server & web, không ghi đè file gốc trừ khi người dùng bấm Lưu.
  - [`validate.ts`](packages/spec-core/src/validate.ts), [`analyze.ts`](packages/spec-core/src/analyze.ts), [`topology.ts`](packages/spec-core/src/topology.ts), [`parity.ts`](packages/spec-core/src/parity.ts), [`geometry-health.ts`](packages/spec-core/src/geometry-health.ts).
  - [`contracts.ts`](packages/spec-core/src/contracts.ts): Shared DTO/Envelope cho API v1 và Hybrid Cloud Worker.
- [`server`](server): Express API (`:8787`), chạy agent CLI (`cmdc`/`agy`/`codex`/`claude`) hoặc Direct OpenAI-compatible API, SSE streaming, library groups & trash, job persistence (`.jobs/`), và Local API v1 ([`server/src/routes/api-v1.js`](server/src/routes/api-v1.js)).
- [`web`](web): React 19 + Vite + Three.js Studio (`:5173`), lazy-load các panel phụ (`LibraryPanel`, `ApiKeyPanel`, `TypesPanel`, `NotesPanel`), dynamic import cho `read-excel-file` và mẫu thử JSON.
- [`revit-addin`](revit-addin): C# .NET Framework 4.8 add-in cho Revit 2024 (`FamilyAgent.Core`, `FamilyAgent.Addin`, `FamilyAgent.SelfTest`).
- [`cloud`](cloud) & [`connector`](connector): Cloudflare Worker API + Windows Revit Connector cho chế độ Hybrid Web (tham khảo [`docs/HYBRID_WEB_ARCHITECTURE.md`](docs/HYBRID_WEB_ARCHITECTURE.md)).
- [`bench`](bench): Bộ 24 đề benchmark thiết kế + chấm điểm tự động + ảnh preview PNG.

---

## 2. Pipeline thiết kế: Stable vs Experimental

Cấu hình qua biến môi trường `AGENT_EXPERIMENTAL_PIPELINE` trong [`server/src/config.js`](server/src/config.js):

1. **Stable Pipeline (mặc định: `AGENT_EXPERIMENTAL_PIPELINE=0`)**:
   - Một model xuyên suốt một hội thoại (giữ nguyên model người dùng chọn), tối đa 3 lượt sửa (`repair`) nếu spec còn lỗi validate/biểu thức.
   - Hỗ trợ `fast-edit` cục bộ (0 lượt gọi model) cho các chỉnh sửa tham số đơn giản.
   - Hỗ trợ **patch turns** ([`server/src/patch.js`](server/src/patch.js)): các lượt chỉnh sửa nhỏ/theo mục tiêu chỉ trả `addParts`/`updateParts`/`removePartIds`/`updateParameters`/`updateMacros`, giữ nguyên phần còn lại.
   - Gửi kèm khối `ĐỐI TƯỢNG ĐƯỢC CHỌN` khi người dùng chọn part hoặc ghim ghi chú trên 3D (`targets`).
2. **Experimental Pipeline (`AGENT_EXPERIMENTAL_PIPELINE=1`)**:
   - Bật thêm deterministic template cho họ thang cáp ([`server/src/templates/cable-ladder.js`](server/src/templates/cable-ladder.js)), tier routing theo độ phức tạp, checklist completeness + supplement turns, vision evidence từ ảnh/PDF, rule packs và plausibility repair.

---

## 3. Macro thép tấm (`trayRun`) & Migration spec cũ

### Macro `trayRun`
- Định nghĩa tại [`packages/spec-core/src/macros.ts`](packages/spec-core/src/macros.ts), mô tả schema tại [`spec/family-spec.schema.json`](spec/family-spec.schema.json), tài liệu prompt tại [`server/prompts/designer.md`](server/prompts/designer.md) (chỉ tiêm vào prompt khi brief liên quan máng/thang cáp/thép tấm qua [`server/src/prompt-blocks.js`](server/src/prompt-blocks.js)).
- Cho phép khai báo tuyến máng/thang gồm chuỗi `straight` + `bend` (`45°` / `90°`, `left` / `right`), tự động tính giao tuyến vát góc khép kín (bottom plate, side walls, top flanges, optional lid) và 2 MEP connector hai đầu, vẫn giữ toàn bộ toạ độ dạng công thức theo parameter.
- Phần tử sinh ra gắn dấu `from` để lần bung tiếp theo tái tạo đồng bộ, tránh trùng lặp khi chỉnh sửa macro.

### Spec Version & Migration (`specVersion: 2`)
- [`packages/spec-core/src/migrate.ts`](packages/spec-core/src/migrate.ts) cung cấp `migrateSpec(raw)` và `repairCorruptedUnits(expr)`:
  - Sửa lỗi regex đơn vị cũ bị nhân đôi (ví dụ `1mm0mm` → `10mm`, `15mm0mm` → `150mm`, `10mmmm` → `10mm`) — đồng thời sửa tận gốc regex lookahead ở [`server/src/designer.js`](server/src/designer.js).
  - Chuẩn hoá `schemaVersion: "1.0"`, `units: "mm"`, `parameters`, `parts`, gắn `specVersion: 2`.
- Được gọi tự động trong `validateSpec`, khi server tải model/history (`GET /api/models/:id`, `GET /api/models/:id/history/:stamp`) và khi web mở model — **chỉ đọc/migrate trong bộ nhớ, không ghi đè file gốc trên đĩa cho đến khi người dùng bấm Lưu**.
- Các mẫu legacy kiểm thử CI lưu tại [`spec/examples/legacy`](spec/examples/legacy). [`packages/spec-core/test/smoke-specs.test.ts`](packages/spec-core/test/smoke-specs.test.ts) bỏ qua các file `_*` (như `_library.json`) và file không có spec; lỗi trên `saved-models/` cục bộ chỉ cảnh báo log, không chặn CI.

---

## 4. Tổng hợp tính năng mới (#36 – #40)

- **#36 (Studio v5)**: Patch turns gọn prompt theo block; quản lý nhóm thư viện ([`_library.json`](server/src/library.js)); layout responsive 3 cột / mobile tabs; Design Tokens + Dark/Light/System theme ([`web/src/lib/theme.ts`](web/src/lib/theme.ts)).
- **#37 (Trash, Thumbnail 16:9 & Cache)**: Thùng rác khôi phục trong 30 ngày (`saved-models/.trash`); chụp ảnh thumbnail isometric 16:9 offscreen tự động bù cho model cũ; cache theo lượt sửa ([`server/src/result-cache.js`](server/src/result-cache.js)); Revit part category/partType và boolean fallback.
- **#38 (Đa ngôn ngữ & Mã thông báo)**: Giao diện `VI / EN / 中文` ([`web/src/lib/i18n.tsx`](web/src/lib/i18n.tsx), [`web/src/lib/strings.ts`](web/src/lib/strings.ts)); server trả `code` + `params` để web dịch theo ngôn ngữ đang chọn ([`server/src/message-codes.js`](server/src/message-codes.js)); giới hạn lịch sử `HISTORY_KEEP`.
- **#39 (CAD Grid & Render 3D)**: Render MSAA trực tiếp (pixel ratio tối đa 3x), lưới vô cực không gian thực với LOD blending và camera fade, giữ section caps, pick/hover và xuất PNG sắc nét.
- **#40 (Targets, Notes & Spec Diff)**:
  - Menu chuột phải trong 3D: *Gửi vào chat* (chọn nhiều part với Ctrl+Click) và *Ghi chú tại đây* (ghim toạ độ + pháp tuyến mặt).
  - Tab **Ghi chú** ([`web/src/components/NotesPanel.tsx`](web/src/components/NotesPanel.tsx)), tự đánh dấu đã xử lý sau lượt sửa thành công, lưu kèm file model.
  - Hiển thị diff part/tham số theo từng lượt Agent ([`web/src/lib/spec-diff.ts`](web/src/lib/spec-diff.ts)).
  - Sidebar thư viện kéo giãn được + menu nhóm qua React Portal ([`web/src/components/LibraryPanel.tsx`](web/src/components/LibraryPanel.tsx)).

---

## 5. Hướng dẫn chạy Test & Benchmark

### Lint & Test toàn dự án
```bash
npm run lint                       # ESLint toàn workspace
npm run build:core                 # Build @family/spec-core
npm test -w @family/spec-core      # Unit tests + legacy migration + smoke specs (108 tests)
npm test -w server                 # Server unit + contract + bench CI tests (282 tests)
npm test -w web                    # Web unit tests (89 tests)
npm run build -w web               # Type-check + Vite production build
npm run test:e2e                   # Playwright E2E (cần dev server hoặc tự bật qua config)
npm run addin:test                 # C# FamilyAgent.SelfTest (.NET 8)
npm run parity                     # Kiểm tra đối khớp resolver TS ↔ C#
```

### Benchmark thiết kế (`bench/`)
Bộ 24 đề ([`bench/cases.json`](bench/cases.json)) tập trung vào phụ kiện thang/máng cáp (cút 90°/45°, Z-offset, chữ U, có nắp/không mép gập, tê/thập, côn thu, co lên/xuống, đục lỗ, tấm nối) kèm 4 mẫu MEP đối chứng, chấm điểm 0–100 theo:
- Hợp lệ & đủ số part/connector (30đ)
- Sai số kích thước bao `bounds` theo trục ± tolerance (25đ)
- Tham số bắt buộc & tỉ lệ tham số hóa (20đ)
- Chi tiết bắt buộc & đặc trưng thép tấm: lỗ/rãnh (`holesOrSlots`), vát góc/miter (`miteredOrChamfer`), mép gập (`foldedFlange`) (25đ)

```bash
# Chạy CI stub (so sánh Trước vs Sau macro thép tấm, tạo report.json + comparison.md + PNG preview)
npm run bench:ci

# Chạy với model LLM thật qua pipeline thật
node bench/run.mjs --model deepseek/deepseek-v4.1-flash --runs 1 --mode after
```

Kết quả baseline stub (`bench/results/latest/comparison.md`):
- **Toàn bộ 24 đề:** Trước macro `11/24` đạt (`84.3/100`) → Sau macro `24/24` đạt (`98.5/100`).
- **Nhóm 11 đề dùng macro `trayRun`:** Trước macro `0/11` đạt (`68.6/100`) → Sau macro `11/11` đạt (`99.6/100`).
