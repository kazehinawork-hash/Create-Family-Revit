# HYBRID WEB & LOCAL ARCHITECTURE SPECIFICATION
**Create-Family-Revit: Local-First + Hybrid Web + Shared Family Engine**

> **Phiên bản:** 1.0.0  
> **Ngày lập:** 2026-11-11  
> **Tác giả:** Principal Software Architect & Revit API Engineer  
> **Repository:** `https://github.com/kazehinawork-hash/Create-Family-Revit`

---

## 1. TỔNG QUAN VÀ MỤC TIÊU HỆ THỐNG

Dự án phát triển **Create-Family-Revit** từ ứng dụng đơn lẻ chạy trên Windows (Local Studio) thành một nền tảng hoạt động song song theo mô hình **Local-First + Hybrid Web**, dùng chung hạt nhân hình học và định dạng đặc tả Family Spec:

1. **Local Mode (Bảo toàn 100%):**
   - Chạy trên máy Windows cục bộ (Vite dev server + Node.js Express backend).
   - Sử dụng các Agent CLI miễn phí/nội bộ (`cmdc`, `agy`, `gemini`, `claude`, `codex`) không phát sinh chi phí API.
   - Kết nối Revit qua Revit Add-in (`FamilyAgent.Addin`) và tạo file `.rfa` 1-click trực tiếp trên máy.
   - Xem trước mô hình 3D (Three.js), flex tham số thời gian thực, không phụ thuộc kết nối Internet hay dịch vụ đám mây.
2. **Hybrid Web Mode (Mở rộng mới):**
   - Cho phép người dùng truy cập giao diện Studio qua trình duyệt web ở bất kỳ đâu (Cloudflare Pages/Workers).
   - Xác thực người dùng, quản lý dự án, lưu trữ Family Spec trên đám mây (Cloudflare D1 & R2).
   - Sinh Family Spec bằng AI qua Cloud Provider API (OpenAI/Anthropic/Gemini) với hạn mức quota và kiểm soát token nghiêm ngặt.
   - Xem trước mô hình 3D trên Web bằng đúng Three.js viewer engine dùng chung.
   - **Tạo file `.rfa` thật:** Gửi lệnh qua Cloud Job Queue $\rightarrow$ **Windows Revit Connector** nhận job $\rightarrow$ Revit Builder trên Windows xử lý dựng Family $\rightarrow$ Upload `.rfa` hoàn chỉnh lên Cloud R2 để người dùng tải về.

---

## 2. HIỆN TRẠNG REPOSITORY (AUDIT REPORT)

### 2.1. Cấu trúc mã nguồn thực tế
- **`packages/spec-core` (TypeScript - Isomorphic):**
  - Chứa toàn bộ lõi toán học, giải biểu thức tham số (`expr.ts`), topology (`topology.ts`), phân tích hình học (`geometry.ts`), tính toán dung sai và parity native Revit (`parity.ts`), kiểm tra sức khỏe hình học (`geometry-health.ts`), validation schema (`validate.ts`).
  - Độc lập 100% với môi trường thực thi (chạy được cả trên Node.js, Trình duyệt và Cloudflare Workers).
- **`server/` (Node.js Express - Local Backend):**
  - Quản lý tương tác Agent CLI (`agents.js`: gọi `cmdc`, `gemini`, `claude`, `codex`, `agy` qua CLI spawned process).
  - Phục vụ Local API v1 (`routes/api-v1.js`: `/api/v1/status`, `/spec/validate`, `/spec/preview`, `/build`, `/jobs`).
  - Quản lý tiến trình dựng RFA cục bộ và tạo gói Portable 1-click (`portable.js`, `jobs.js`, `build-qa.js`).
  - LLM client fallback qua HTTP nếu được cấu hình (`llm.js`).
- **`web/` (React + Vite + Three.js - Frontend):**
  - Studio UI: Thanh công cụ (`TopBar.tsx`), khung chat tương tác với Agent (`ChatPanel.tsx`), bảng điều khiển tham số (`ParameterPanel.tsx`), và viewport 3D Three.js (`Viewer.tsx`, `three-build.ts`).
  - Xử lý dựng hình 3D phía client qua Web Worker (`geometry.worker.ts`).
- **`revit-addin/` (C# .NET Framework 4.8 - Revit Engine):**
  - `FamilyAgent.Core`: Resolver biểu thức và cấu trúc hình học tương đồng 1:1 với `packages/spec-core`.
  - `FamilyAgent.Addin`: Chạy bên trong Autodesk Revit (hỗ trợ Revit 2021-2026), dựng các hình học Native Form (`Extrusion`, `Revolve`, `Sweep`, `SweptBlend`, `Blend`) và gán Reference Planes, Dimension Constraints, Connector MEP.
  - `FamilyAgent.SelfTest`: Bộ kiểm thử parity giữa C# Resolver và TS Resolver (đạt độ lệch $\Delta < 0.01\text{ mm}$).

### 2.2. Khả năng tái sử dụng cho Web Mode
| Thành phần | Vị trí hiện tại | Khả năng tái sử dụng trên Cloud / Web | Ghi chú điều chỉnh |
|---|---|---|---|
| **Family Spec Schema & Validation** | `packages/spec-core` | **100% Tái sử dụng** | Đóng gói thành npm package/bundle cho cả Web và Cloudflare Workers |
| **Three.js Viewport & Mesh Builder** | `web/src/lib/three-build.ts` | **100% Tái sử dụng** | Dùng chung cho Web Studio |
| **API Contract & DTO Envelope** | `server/src/routes/api-v1.js` | **100% Tái sử dụng** | Chuẩn hóa schema contract dùng chung giữa Local Express và Cloudflare Workers |
| **Revit Family Builder Engine** | `revit-addin/` | **100% Tái sử dụng** | Tái sử dụng nguyên vẹn thông qua Windows Revit Connector |
| **Agent CLI Runner** | `server/src/agents.js` | **Chỉ dùng cho Local** | Web Mode dùng Cloud AI Provider API có rate limit & quota |
| **Local File System Storage** | `server/src/files.js` | **Chỉ dùng cho Local** | Web Mode chuyển sang Cloudflare D1 (metadata) + R2 (file `.rfa`) |

---

## 3. THIẾT KẾ KIẾN TRÚC MỤC TIÊU (TARGET ARCHITECTURE)

```text
                                  GITHUB MONOREPO
                                         |
               +-------------------------+-------------------------+
               |                                                   |
         [LOCAL MODE]                                      [HYBRID WEB MODE]
               |                                                   |
     Local Studio (Vite:3000)                             Cloudflare Pages UI
               |                                                   |
     Local Express (:8787)                                Cloudflare Workers API
         |           \                                      /         |         \
    Agent CLI     Local API v1                       Auth / D1    Queues    R2 Storage
   (Free local)  (spec/preview)                      (Projects)  (Jobs)    (Family RFAs)
         |             |                                              |
         +------+------+                                              | HTTPS Long Poll / WebSocket
                |                                                     | (Outbound only)
                |                                          +----------v-----------+
                |                                          |  WINDOWS CONNECTOR   |
                |                                          | (Local Service/Tray) |
                |                                          +----------+-----------+
                |                                                     |
                +-----------------------------------------------------+
                                         |
                                         v
                              [AUTODESK REVIT ENGINE]
                               (FamilyAgent.Addin)
                                         |
                                         v
                                  .RFA FAMILY FILE
```

### 3.1. Phân định ranh giới và an toàn bảo mật
1. **Windows Revit Connector (Zero Inbound Port):**
   - Connector chạy trên máy Windows có Revit, chỉ tạo kết nối **chiều ra (Outbound HTTPS)** đến Cloudflare API.
   - Tuyệt đối không mở port lắng nghe trên Internet, không cần cấu hình NAT/Port Forwarding, không để lộ máy Windows.
   - Nhận job đã được mã hóa và xác thực chữ ký (HMAC SHA-256 / Bearer token định danh Worker).
   - Kiểm tra Schema Validation của Spec trước khi gửi vào Revit API. Từ chối thực thi bất kỳ lệnh shell hoặc command tùy ý nào.
2. **Quản lý khóa bí mật & Cô lập:**
   - Client Web không giữ bất kỳ API key nào của AI provider hoặc Cloudflare credentials.
   - Mọi thao tác AI trên Web đi qua Cloudflare Workers, có giới hạn Rate Limit (ví dụ: tối đa 10 requests/phút/user), Token Budget tối đa cho mỗi phiên thiết kế.
   - Chế độ Local tuyệt đối không gọi lên Cloudflare nếu người dùng không kích hoạt tính năng đồng bộ.

---

## 4. CHUẨN HÓA API CONTRACTS & WORKFLOW

### 4.1. Vòng đời của Job dựng Family (Job Lifecycle)
```text
[Web / Local Studio] 
        |  (Submit Spec)
        v
    [QUEUED] ──(Timeout / Expire)──> [CANCELLED]
        |
        |  (Connector polls & acquires lease)
        v
   [ASSIGNED]
        |
        |  (Revit Builder starts creating forms & parameters)
        v
  [PROCESSING] ──(Revit Exception / Invalid Spec)──> [FAILED]
        |
        |  (RFA exported & uploaded to R2 / Local folder)
        v
  [COMPLETED] ──> Download URL ready (.rfa)
```

### 4.2. Đặc tả dữ liệu dùng chung (Shared Data Contracts)
- `FamilySpec`: Mô hình hình học JSON định nghĩa các `parts`, `parameters`, `connectors`, `materials`.
- `FamilyBuildRequest`:
  ```json
  {
    "job_id": "job_cf_01HX...",
    "spec_hash": "a1b2c3d4...",
    "spec": { ... },
    "options": {
      "lod": 300,
      "native_only": true,
      "timeout_seconds": 120
    },
    "idempotency_key": "idem_9f8e7d..."
  }
  ```
- `FamilyBuildResult`:
  ```json
  {
    "job_id": "job_cf_01HX...",
    "status": "completed",
    "artifacts": {
      "rfa_url": "https://r2.family-studio.com/.../valve.rfa",
      "rfa_size_bytes": 524288
    },
    "metrics": {
      "duration_ms": 3420,
      "parts_built": 12,
      "native_forms": 12,
      "freeform_count": 0
    },
    "warnings": []
  }
  ```

---

## 5. LỘ TRÌNH TRIỂN KHAI THEO GIAI ĐOẠN

### Giai đoạn 1: Audit Repository & Kiến trúc (Hoàn tất)
- [x] Rà soát cấu trúc monorepo, kiểm tra test suite baseline.
- [x] Lập tài liệu kiến trúc chuẩn `docs/HYBRID_WEB_ARCHITECTURE.md`.

### Giai đoạn 2: Chuẩn hóa Shared Core (`packages/spec-core`)
- [ ] Bổ sung module `contracts` trong `packages/spec-core` định nghĩa:
  - `JobStatus`, `FamilyBuildRequest`, `FamilyBuildResult`, `BuilderCapabilities`.
- [ ] Bổ sung unit tests cho contract validation và serialization.
- [ ] Đảm bảo 100% build và test của `spec-core` vượt qua mà không ảnh hưởng Local server.

### Giai đoạn 3: Cloudflare Web Backend (`apps/cloud-worker` hoặc `cloud/`)
- [ ] Thiết lập worker xử lý API:
  - `/api/v1/health`
  - `/api/v1/auth` (Session / API Key)
  - `/api/v1/jobs` (Enqueue, status, claim dành cho connector)
- [ ] Mô phỏng / cấu hình D1 schema cho projects & jobs.
- [ ] Thiết lập AI Provider Adapter (OpenAI / Claude / Gemini) có quota guard.

### Giai đoạn 4: Windows Revit Connector (`connector/`)
- [ ] Xây dựng dịch vụ Node.js/CLI gọn nhẹ trên Windows:
  - Quản lý cấu hình kết nối (Cloud Endpoint, Connector Token).
  - Định kỳ poll job (`GET /api/v1/connector/jobs/poll`).
  - Giao tiếp với Revit thông qua Portable Runner hoặc TCP/Named Pipes hiện hữu của Add-in.
  - Tự động nhận diện Revit đang chạy hoặc kích hoạt headless portable builder.
  - Upload file `.rfa` và cập nhật kết quả (`POST /api/v1/connector/jobs/:id/complete`).

### Giai đoạn 5: Tích hợp Frontend Web & DG App MCP Adapter
- [ ] Cấu hình Web build mode (nhận biết môi trường Cloudflare vs Localhost).
- [ ] Tích hợp giao diện theo dõi tiến trình Job dựng RFA từ xa trên Web Studio.
- [ ] Xác nhận giao tiếp DG App MCP Adapter qua Local API v1.

---

## 6. MA TRẬN RỦI RO VÀ PHƯƠNG ÁN PHÒNG NGỪA

| Rủi ro | Mức độ | Phương án phòng ngừa |
|---|---|---|
| **Làm gãy quy trình Local Mode** | Cao | Toàn bộ code mới đặt trong packages/modules riêng biệt; giữ nguyên các lệnh chạy `npm run dev` và `run_app.bat`. |
| **Lộ khóa API hoặc bí mật hệ thống** | Cao | Không lưu secret ở frontend; tách biệt config giữa Cloudflare Environment Bindings và `.env` cục bộ. |
| **Xung đột Revit API thread** | Trung bình | Windows Connector chỉ dispatch lệnh vào đúng UI thread/ExternalEvent của Revit Add-in đã được kiểm chứng. |
| **Chi phí AI vượt tầm kiểm soát trên Web** | Trung bình | Áp dụng hạn mức cứng (hard limit): tối đa request/giờ, từ chối prompt vượt quá 2000 tokens, chặn lặp vô hạn. |
| **Mất kết nối giữa Connector và Cloud** | Thấp | Cơ chế Job Lease có thời hạn (heartbeat TTL 60s); nếu connector chết giữa chừng, job tự động trả lại hàng đợi (retry tối đa 3 lần). |

