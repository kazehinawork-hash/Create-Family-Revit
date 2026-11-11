# HANDOVER — Create-Family-Revit (DG App Integration & Phase F0/F1 POC)

> **Nhánh làm việc:** `Tich_hop_API_ket_noi_app_khac`  
> **Phiên bản API Contract:** 1.0 (Tuân thủ `00_SHARED_API_CONTRACT.md`)  
> **Cập nhật ngày:** 2026-11-07  
> **Trạng thái:** Phase F0 (Audit) & Phase F1 (Contract-first POC) **HOÀN THÀNH 100% PASS TESTS**.

---

## 1. Mục tiêu & Kiến trúc đã triển khai

- Biến **Create-Family-Revit** thành Windows App độc lập sở hữu Family Engine, cung cấp **Local REST API v1** chuẩn hóa trên loopback (`127.0.0.1:8787`).
- Ứng dụng DG (DG App) đóng vai trò điều phối thông qua MCP Adapter, gửi Family Spec JSON đã thiết kế sẵn.
- **Chế độ `external_spec` (Zero AI invocation):**
  - Khi nhận spec từ DG app, Create-Family-Revit sử dụng trực tiếp `packages/spec-core` để Validate, tính toán hình học (Bounding Box, Part Bounds, Parameters, Connectors) và gọi Revit Add-in dựng hình mà **tuyệt đối không gọi OpenAI API hay Command Code CLI**.
  - Workflow Studio web cũ (`/api/design`, `/api/build`) vẫn giữ nguyên vẹn 100%, không bị ảnh hưởng.

---

## 2. API v1 Contract Endpoints đã bổ sung (`/api/v1/`)

Tất cả các endpoint trả về định dạng Envelope chuẩn theo Contract:
```json
{
  "api_version": "1.0",
  "request_id": "<uuid>",
  "ok": true,
  "data": { ... },
  "error": null
}
```

| Method | Endpoint | Mục đích | Input / Params | Ghi chú |
|---|---|---|---|---|
| `GET` | `/api/v1/status` | Khám phá capabilities, phiên bản app, schema & trạng thái Revit | None | `capabilities: ["validate", "preview", "build", "job_status", "external_spec"]` |
| `POST` | `/api/v1/spec/validate` | Xác thực Spec bằng `spec-core` (Zero AI) | `{ spec: {...}, schema_version?: "1.0" }` | Trả về `valid`, `spec_hash`, `diagnostics`, `geometry_summary` |
| `POST` | `/api/v1/spec/preview` | Tạo preview gắn liền với `spec_hash` | `{ spec: {...} }` | Trả về `preview_id`, `spec_hash`, `geometry_summary`, `warnings` |
| `POST` | `/api/v1/build` | Enqueue build job, kiểm tra approval & idempotency | `{ spec, preview_id?, spec_hash?, approval_token?, idempotency_key? }` | Trả HTTP 202 Accepted với `job_id`, hoặc 200 duplicate |
| `GET` | `/api/v1/jobs/:job_id` | Kiểm tra trạng thái và tiến độ job | Param `job_id` | Status: `queued`, `awaiting_revit`, `running`, `succeeded`, `failed` |
| `GET` | `/api/v1/jobs` | Danh sách 50 jobs gần nhất | None | Hỗ trợ lưu trữ file-backed trong `.jobs/` |

---

## 3. Bảo mật & Cơ chế an toàn (Safety & Idempotency)

1. **Authentication (Tùy chọn):** Nếu cấu hình `DG_API_KEY` hoặc `FAMILY_API_KEY` trong `.env`, API yêu cầu header `Authorization: Bearer <key>` hoặc `X-API-Key: <key>`. Nếu không cấu hình, tin cậy loopback theo mặc định.
2. **Approval Verification:** Khi `REQUIRE_BUILD_APPROVAL=1`, endpoint `/api/v1/build` bắt buộc phải có `approval_token`.
3. **Chống Preview cũ/thay đổi (`PREVIEW_STALE`):** Nếu gửi kèm `preview_id`, server kiểm tra hash của Spec hiện tại với hash khi tạo preview; nếu spec bị sửa đổi, từ chối build ngay lập tức.
4. **Idempotency Key:** Hỗ trợ `idempotency_key` tránh tạo nhiều job / nhiều file RFA trùng lặp khi DG app retry kết nối.
5. **Revit Bridge Safety:** Nếu Revit chưa bật hoặc bridge chưa phản hồi, job tự động chuyển sang trạng thái `awaiting_revit` (tiến độ 30%) và không cố gắng ép buộc treo tiến trình.

---

## 4. Kết quả kiểm thử (Test Evidence)

Toàn bộ 4 tầng test suite đều đạt **PASS 100%**:
1. **`@family/spec-core`:** 61 tests PASS (Dependencies, Geometry Health, Golden Runtime, Smoke Specs, Spec Core).
2. **`@family/server`:** 37 tests PASS (bao gồm 9 Contract Tests mới trong `server/test/api-v1-contract.test.js`).
3. **`@family/web`:** 12 tests PASS (Three-build geometry).
4. **`revit-addin` SelfTest:** ALL core checks PASS (Arithmetic, parameters, units, degrees, frustum, bend, part anchor, loft).

---

## 5. Danh sách files mới & thay đổi

- `server/src/jobs.js`: Quản lý vòng đời Job, Preview, Spec Hash, Idempotency & file-backed persistence.
- `server/src/routes/api-v1.js`: Router Express `/api/v1` chuẩn hóa theo Shared Contract.
- `server/src/index.js`: Đăng ký `/api/v1` router vào máy chủ Express chính.
- `server/test/api-v1-contract.test.js`: Bộ Contract Tests tự động xác minh từng kịch bản giao tiếp DG ↔ Family.
- `HANDOVER.md`: Tài liệu bàn giao này.

---

## 6. Kế hoạch bước tiếp theo (Phase F2 / F3)

- **Phase F2 (Revit 2024.3 Live Integration):**
  - Mở Revit 2024.3, kiểm tra nạp Add-in qua Bridge (`http://127.0.0.1:8765`), gửi job từ API v1 và kiểm chứng file `.rfa` đầu ra thực tế.
  - Kiểm tra tương thích cổng/single-writer giữa DG Bridge và Family Agent Bridge.
- **Phase F3 (Windows Packaging):**
  - Đóng gói ứng dụng chạy độc lập (Node backend + web UI built sẵn) có launcher `.bat` hoặc script khởi chạy headless cho DG app kết nối.
