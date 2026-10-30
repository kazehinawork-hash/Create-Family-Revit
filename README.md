# Family Agent

Studio dựng **family Revit** bằng agent: bạn mô tả thiết bị bằng lời, agent sinh ra một **spec JSON**
có tham số hoá, studio hiển thị 3D và bảng parameters, rồi add-in Revit dựng file `.rfa` thật.

```
 mô tả  ──►  agent (Command Code CLI / OpenAI)  ──►  spec JSON
                                                      │
                              ┌───────────────────────┼───────────────────────┐
                              ▼                       ▼                       ▼
                       studio 3D (Three.js)    parameters panel      add-in Revit 2024
                                                                          │
                                                                    Documents\FamilyAgent\out\*.rfa
```

---

## 1. Yêu cầu

| Thành phần | Ghi chú |
|---|---|
| Node.js ≥ 20 | đã có 24 |
| Command Code CLI (`cmdc`) | mặc định dùng chính CLI này làm agent, cần `cmdc login` một lần |
| Revit 2024 | để build `.rfa` (phần này làm sau cũng được) |
| .NET SDK 8+ | chỉ cần khi build add-in |

## 2. Chạy studio

```bash
npm install --include=dev
npm run dev
```

Mở **http://localhost:5173**.

> Máy này có `NODE_ENV=production` toàn cục nên `npm install` mặc định bỏ devDependencies —
> luôn thêm `--include=dev` khi cài lần đầu.

`npm run dev` chạy song song:
- API + agent tại `http://localhost:8787`
- Vite dev server tại `http://localhost:5173` (proxy `/api` sang 8787)

Bản production: `npm run build && npm start` → mở `http://localhost:8787`.

## 3. Agent

Mặc định: **Command Code headless** — server gọi

```
cmdc -p --output-format json --skip-onboarding -m <model>
```

và đọc `finalText` của frame cuối. Không cần API key, dùng login sẵn có trên máy.

**Chọn model ngay trong studio**: dropdown ở góc phải panel Agent (`cmdc default`, DeepSeek V4
Pro, Claude Sonnet, Qwen, GLM…). Model được gửi kèm mỗi request; để `cmdc default` thì dùng
model mặc định của CLI. Model không nằm trong gói của bạn sẽ trả lỗi từ CLI và hiện ngay
trong khung chat.

Cấu hình trong `.env` (copy từ `.env.example`):

```ini
AGENT_PROVIDER=commandcode      # hoặc openai
COMMAND_CODE_MODEL=             # model mặc định, để trống = model của CLI
COMMAND_CODE_EFFORT=            # off | high | max, để trống = mặc định của model
AGENT_TIMEOUT=600000
```

Thời gian tham khảo trên máy này: `deepseek/deepseek-v4-pro` dựng một bơm ly tâm DN80
(9 parts, 22 tham số) trong ~100 giây; `deepseek/deepseek-v4.1-flash` (mặc định) khoảng
3–4 phút cho một FCU 16 parts. Model reasoning có thể "suy nghĩ" 5–10 phút với prompt lớn —
không phải treo.

Trong lúc chạy, khung 3D hiện **bảng tiến trình**: *Read the brief → Design the family →
Check the model*, bước đang chạy được tô đậm kèm hoạt động thật từ CLI (`Thinking`,
`Reading the document`, `Writing the spec`) và đồng hồ `mm:ss`. Nút **Stop** (ô vuông đỏ)
huỷ giữa chừng và tắt luôn tiến trình `cmdc` phía sau.

### Chọn mức chi tiết LOD

Trên thanh trên cùng có nút **LOD 200 / 300 / 350 / 400** (mặc định 300, lưu lại cho lần mở sau):

| LOD | Dùng cho | Quy mô |
| --- | --- | --- |
| 200 | khối bao, phối cảnh, định tuyến sơ bộ | 3–8 parts, 4–10 tham số |
| 300 | thiết kế thực tế + cổng kết nối MEP, bóc khối lượng | 4–16 parts, 6–24 tham số |
| 350 | phối hợp MEP / kiểm tra va chạm: bích, tai treo, giá đỡ, clearance | 10–30 parts, 10–26 tham số |
| 400 | chi tiết chế tạo/lắp ráp: bích, gioăng, bulông, lỗ khoan | 18–45 parts, 16–40 tham số |

Mức LOD được gửi kèm mỗi yêu cầu, ghi vào spec (`lod`) và vào `notes`, đồng thời đặt
`Detail Level` của view 3D trong Revit tương ứng Coarse / Medium / Fine. Đổi LOD rồi gửi
một yêu cầu chỉnh sửa là mô hình được dựng lại ở mức chi tiết mới.

### Dựng theo datasheet PDF

Bấm **biểu tượng kẹp giấy** cạnh ô chat để đính kèm `pdf`, ảnh chụp bản vẽ, `docx`, `xlsx`,
`csv` (tối đa 20 MB). Khi gửi:

1. File được lưu vào `.uploads/`. PDF được **trích text ngay trên server** (`pdf-parse`) rồi
   đưa vào prompt — nhanh và ổn định hơn để agent tự mở file.
2. Với ảnh/`docx`/`xlsx`, file được copy vào workspace tạm và agent đọc bằng `read_file`.
3. Kích thước, cụm chi tiết, kết nối, vật liệu trong tài liệu được ưu tiên hơn suy đoán.

Lưu ý:
- Tính năng này cần `AGENT_PROVIDER=commandcode` (agent đọc file bằng tool của CLI).
- PDF scan không có lớp text sẽ khó hơn — nên ưu tiên PDF xuất từ CAD/Word, hoặc dùng model
  có vision.
- Nếu tài liệu có nhiều model, hãy nói rõ trong prompt: *"chỉ dựng model 080"*.

Dùng endpoint kiểu OpenAI:

```ini
AGENT_PROVIDER=openai
OPENAI_API_KEY=sk-...
OPENAI_BASE_URL=https://api.openai.com/v1
OPENAI_MODEL=gpt-4o
```

## 4. Build file .rfa

```bash
npm run addin:install      # build + copy add-in vào %APPDATA%\Autodesk\Revit\Addins\2024
```

Sau đó mở Revit 2024:

- Tab **Family Agent** xuất hiện.
- Add-in tự bật **studio bridge** ở `http://127.0.0.1:8765`.
- Trong studio bấm **Build Revit family** → Revit dựng family và lưu vào
  `Documents\FamilyAgent\out\<tên>.rfa`.
- Nếu Revit chưa mở, spec được đưa vào `Documents\FamilyAgent\queue\`; mở Revit và bấm
  **Build pending**.
- Nút khác: **Build from file…** (chọn một spec JSON bất kỳ), **Studio bridge** (bật/tắt).

Tắt bridge tự động: đặt biến môi trường `FAMILY_AGENT_BRIDGE=0` trước khi mở Revit.

## 5. Spec là gì

Đơn vị **mm**, trục **Z hướng lên**, gốc family ở tâm mặt bằng trên sàn (`z = 0`).
Mọi trường số nhận số hoặc biểu thức, tham số tham chiếu bằng `[Tên Tham Số]`.

```jsonc
{
  "schemaVersion": "1.0",
  "name": "Wall Mounted Electric Panel Heater 1200",
  "category": "Mechanical Equipment",
  "parameters": [
    { "name": "Overall Width", "type": "Length", "group": "Dimensions", "value": 1200 },
    { "name": "Casing Depth", "type": "Length", "group": "Dimensions",
      "formula": "[Overall Depth] - 40mm" }
  ],
  "materials": [{ "name": "White Painted Steel", "color": "#e8e6e1" }],
  "parts": [
    {
      "id": "outlet-louvre",
      "name": "Outlet Louvre",
      "material": "White Painted Steel",
      "solid": {
        "kind": "box",
        "origin": { "x": 0, "y": "-([Casing Depth] / 2)", "z": 16 },
        "size": { "x": "[Overall Width] - 20mm", "y": "[Louvre Depth]", "z": 2 }
      },
      "array": { "count": "[Louvre Count]", "axis": "z", "spacing": "[Louvre Spacing]" }
    }
  ]
}
```

Primitive: `box` (origin = tâm mặt đáy; `cornerRadius` bo 4 góc đứng, đơn vị mm, tự kẹp
về nửa cạnh ngắn), `cylinder` (base = tâm mặt đáy, `height` âm để
chạy ngược trục, `innerRadius` để làm ống), `prism` (polygon 2D extruded).
`cuts` trừ khối, `array` nhân bản theo trục.

Cú pháp biểu thức dùng chung cho cả TS và C#: `+ - * / % ^`, `abs sqrt round roundup
rounddown sin cos tan asin acos atan exp ln log pi()` (lượng giác theo độ), hằng số độ dài
viết kèm đơn vị (`140mm`, `1ft`).

Revit kiểm tra đơn vị trong formula nên hằng số cộng/trừ phải có đơn vị: `[Casing Height] - 140mm`
chứ không phải `- 140`.

Schema đầy đủ: [`spec/family-spec.schema.json`](spec/family-spec.schema.json) ·
Ví dụ: [`spec/examples/fcu-080.json`](spec/examples/fcu-080.json) (viết tay) và
[`spec/examples/pump-dn80.json`](spec/examples/pump-dn80.json) (do agent sinh bằng DeepSeek V4 Pro).

## 6. Cấu trúc

```
packages/spec-core/   types + parser biểu thức + resolve tham số/hình học (dùng chung web & server)
web/                  studio: chat, viewer Three.js, parameter panel
server/               Express: /api/design (SSE), /api/build, /api/health
  prompts/designer.md prompt thiết kế
  prompts/repair.md   prompt sửa lỗi sau khi validate
revit-addin/
  FamilyAgent.Core/   bản C# của spec-core (parser, resolver) — test được ngoài Revit
  FamilyAgent.Addin/  add-in Revit 2024: ribbon, bridge HTTP, dựng family
  FamilyAgent.SelfTest/ console test cho Core
spec/                 JSON Schema + spec mẫu
scripts/              dev runner, thử design qua HTTP
```

Add-in và studio hiểu **cùng một spec**; resolver TS và C# được test song song để ra cùng
kích thước (ví dụ FCU mẫu: 1970 × 1720 × 596 mm, 17 parts).

## 7. Test

```bash
npm test          # spec-core (vitest) + self-test C#
npm run addin:test
```

Thử agent mà không cần UI:

```bash
node scripts/try-design.mjs "Horizontal fan coil 080, 1910 x 1600 x 560 casing"
```

## 8. Giới hạn hiện tại

- **Hình học được "nung" tại lúc build.** Tham số và formula được tạo trong family, nhưng
  hình học chưa ràng buộc vào reference plane + dimension, nên sửa tham số trong Revit
  không làm model co giãn. Muốn đổi kích thước: sửa trong studio → build lại.
- Formula nào Revit từ chối (sai đơn vị, tham chiếu vòng) sẽ được thay bằng giá trị đã tính,
  kèm cảnh báo trong kết quả build.
- Chưa có MEP connector, chưa tạo nhiều type, chưa có tag/schedule/annotation.
- Add-in build cho đúng phiên bản Revit đang cài:
  `install.ps1 -RevitVersion 2025 -p:RevitInstallDir "..."` nếu cần bản khác.

## 9. Sự cố thường gặp

| Hiện tượng | Xử lý |
|---|---|
| Agent báo `cmd not recognized` | cài `npm i -g command-code`, chạy `cmdc login` |
| Agent treo quá lâu | tăng `AGENT_TIMEOUT`, hoặc đặt `COMMAND_CODE_MODEL` sang model nhanh hơn |
| Build trả về `mode: queue` | Revit chưa mở / bridge chưa chạy → mở Revit, bấm **Build pending** |
| Revit báo lỗi khi load add-in | kiểm tra `%APPDATA%\Autodesk\Revit\Addins\2024\FamilyAgent.addin` trỏ đúng DLL |
| Cổng 8787/5173 bận | đổi `PORT` trong `.env`, hoặc `npm run dev -w web -- --port 5174` |
