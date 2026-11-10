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
| 200 | khối bao, phối cảnh, định tuyến sơ bộ | 3–10 parts, 4–10 tham số |
| 300 | thiết kế thực tế + cổng kết nối MEP, bóc khối lượng | 5–20 parts, 6–24 tham số |
| 350 | phối hợp MEP / kiểm tra va chạm: bích, tai treo, giá đỡ, clearance | 10–40 parts, 10–26 tham số |
| 400 | chi tiết chế tạo/lắp ráp: bích, gioăng, bulông, lỗ khoan | 20–80 parts (phức tạp đến 150), 16–40 tham số |

Mức LOD được gửi kèm mỗi yêu cầu, ghi vào spec (`lod`) và vào `notes`, đồng thời đặt
`Detail Level` của view 3D trong Revit tương ứng Coarse / Medium / Fine. Đổi LOD rồi gửi
một yêu cầu chỉnh sửa là mô hình được dựng lại ở mức chi tiết mới.

Toolbar khung 3D có nút **HD** (mặc định bật) tăng mật độ lưới preview (chord ~4 mm,
tối đa 192 segment) cho cylinder/frustum/bend/tube và bo góc; tắt để về **Standard**
(chord ~10 mm, tối đa 96) khi máy yếu. Nút **Iso / Front / Top / Right** cạnh **Fit** đổi
góc nhìn nhanh.

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
- **Rebuild from spec**: spec JSON được nhúng vào file `.rfa`. Sau khi sửa tham số trong
  Revit, bấm **Rebuild from spec** trên tab Family Agent — hình học được tính lại từ spec
  bằng **giá trị tham số hiện tại** trong Revit, cho kết quả giống studio (không phụ thuộc
  constraint solver). Đây là cách đạt parity đầy đủ cho các trường hợp ràng buộc chưa
  compile được.
- Nút khác: **Build from file…** (chọn một spec JSON bất kỳ), **Studio bridge** (bật/tắt).

Tắt bridge tự động: đặt biến môi trường `FAMILY_AGENT_BRIDGE=0` trước khi mở Revit.

### Build mặc định: native form + reference plane, không hard-lock

Mặc định builder tạo **geometry + parameter + material + connector**, đồng thời tạo
**reference plane và dimension** cho các tham số chính (`IncludeConstraints = true`).
Các mặt hình học **không bị hard-lock**, nên đổi tham số không gây lỗi
"Constraints are not satisfied": add-in tự rebuild hình từ spec đã nhúng khi parameter
hoặc family type thay đổi, dùng **giá trị driver hiện tại** trong Revit. Parameter
formula được tính lại từ driver (không bị override), nên hình cập nhật giống localhost.
Nếu rebuild lỗi hoặc thiếu part, xem log tại
`Documents\FamilyAgent\logs\autosync.log`.

Muốn bật hard face locking (file nặng hơn, có thể gặp constraint solver), đặt
`FAMILY_AGENT_LOCK_GEOMETRY=1` trước khi mở Revit. `FAMILY_AGENT_PARAMETRIC` không còn
được dùng.

### Build parity & QA

Studio hiển thị badge **native / blend / sweptblend / freeform** cho từng part và cảnh
báo trước khi build nếu preview sẽ khác `.rfa`: loft > 2 section, frustum trục X/Y,
bend có bán kính baked, cut biến part thành FreeFormElement. Toggle **Info** trong tab
Parts hiện advisory không chặn build: mặt khít nhau (z-fighting) và part lớn bị chôn
trong part khác. Sau khi build, server so số part/instance/connector/bounds/parameter
thực tế với spec và trả `qa` trong kết quả; stats còn có `totalForms` (form thực tế),
`missingForms` và `failedParts` để UI báo chính xác part/copy nào không dựng được.
Part FreeForm hoặc ràng buộc chưa compile được đánh dấu **cần Rebuild from spec**.
Loft chạy trục X/Y hoặc >2 section được dựng bằng **FreeForm loft fallback** để không
mất part; auto-heal vẫn tách loft trục Z >2 section thành các part 2-section native.

### Quy trình khuyến nghị: localhost → RFA → QA

Studio là nơi **thiết kế và chỉnh tham số**; file `.rfa` là bản build để dùng/kiểm tra trong Revit.

1. Dựng và chỉnh mô hình trên studio đến khi ưng ý.
2. Xem badge/cảnh báo parity trong tab **Parts**; sửa các part sẽ thành FreeForm nếu cần parametric.
3. Bấm tải/build RFA.
4. Mở `.rfa` trong Revit để QA: số part, kích thước bao, connector, vật liệu, vị trí.
5. Nếu cần đổi kích thước, quay lại studio sửa rồi build/tải RFA mới.
6. Trong Revit có thể dùng **Rebuild from spec** để cập nhật nhanh theo giá trị tham số hiện tại, nhưng đây là tiện ích thủ công, không phải parametric native.

Family tải ra **không tự co giãn array/CSG/loft** như studio. Đây là chủ ý: generator không cố tạo native array (Revit API không có `NewArray`). Chỉ nên làm template native thủ công cho một dòng sản phẩm cố định nếu cần gửi người khác chỉnh parameter.

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
chạy ngược trục, `innerRadius` để làm ống), `frustum` (côn/cụt nón: `radiusBottom`,
`radiusTop`, `radiusTop: 0` thành hình nón — dùng cho côn thu, cổ gió loe, vòng quạt),
`bend` (cút tròn: tiết diện tròn `tubeRadius` quay quanh trục ở khoảng cách `radius`,
`angle` mặc định 90°; `plane` chọn mặt phẳng), `prism` (polygon 2D extruded, có
`holes` để cắt lỗ ngay trong cùng form native), `loft` (2+ profile xếp theo `axis` tại
các mốc `at` tăng dần — dùng cho chuyển tiết diện chữ nhật ↔ tròn, reducer; `.rfa` chỉ
dựng 2 section, loft dài được auto-heal tách thành các đoạn 2-section), `revolve`
(profile 2D `[radial, height]` quay quanh trục — dùng cho thân van, bầu lọc, bánh
tay, mặt bích tiện tròn), `tube` (`start`–`end` + `radius`, tùy chọn `innerRadius` —
ống/nhánh theo trục bất kỳ, bích và nắp có hướng).
`cuts` trừ khối, `array` nhân bản theo trục, `anchor` ghim mặt nào bị điều khiển mỗi trục
(`{"x":"min","y":"max"}`). Parameter `Length` có thể khai báo `axis: "x|y|z"` để chỉ
định trục dimension thay vì đoán theo tên.

Cú pháp biểu thức dùng chung cho cả TS và C#: `+ - * / % ^`, `abs sqrt round roundup
rounddown sin cos tan asin acos atan exp ln log pi()` (lượng giác theo độ), hằng số độ dài
viết kèm đơn vị (`140mm`, `1ft`).

Revit kiểm tra đơn vị trong formula nên hằng số cộng/trừ phải có đơn vị: `[Casing Height] - 140mm`
chứ không phải `- 140`.

Schema đầy đủ: [`spec/family-spec.schema.json`](spec/family-spec.schema.json) ·
Ví dụ: [`spec/examples/fcu-080.json`](spec/examples/fcu-080.json) (viết tay),
[`spec/examples/pump-dn80.json`](spec/examples/pump-dn80.json) (do agent sinh bằng DeepSeek V4 Pro) và
[`spec/examples/ystrainer-dn80.json`](spec/examples/ystrainer-dn80.json) (Y lọc DN80, preset thử
nghiệm hình học bo cong: thân frustum, nhánh 45° loft lệch tâm, bích/nắp prism có lỗ khoan) và
[`spec/examples/ystrainer-tube.json`](spec/examples/ystrainer-tube.json) (Y lọc dùng `tube`
trục bất kỳ cho nhánh, bích và nắp vuông góc trục nhánh).

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
scripts/              dev runner, parity TS↔C#, thử design qua HTTP
```

Add-in và studio hiểu **cùng một spec**; resolver TS và C# được so khớp tự động bằng
`npm run parity` trên mọi file trong `spec/examples` (parts, instances, parameters, bounds
và bounds từng part, tolerance 0.01 mm).

## 7. Test

```bash
npm test          # spec-core + server + web + self-test C# + parity TS↔C#
npm run parity    # chỉ chạy so khớp resolver TS và C#
npm run test:e2e  # Playwright: studio shell + API validation
npm run lint      # ESLint
npm run addin:test
```

Chấm chất lượng spec (schema, logic, tỉ lệ part gắn tham số, tham số chết):

```bash
npm run eval
npm run eval -- --json          # máy đọc
npm run eval -- --specs spec/examples
```

Xem số draw call của viewer: mở studio với `?debug=1`.

Thử agent mà không cần UI:

```bash
node scripts/try-design.mjs "Horizontal fan coil 080, 1910 x 1600 x 560 casing"
```

## 8. Giới hạn hiện tại

- **Hình học dùng form native** (Extrusion / Void / Blend / Revolution / SweptBlend / Sweep)
  và được lock vào reference plane ở **một mặt mỗi trục**, với dimension mặt–mặt cùng solid.
  Part có `cuts` hoặc `innerRadius` thường được **boolean + `FreeFormElement`** để cut chỉ
  tác dụng trong part đó; các part này không còn native form/constraint, đổi tham số phải
  dùng **Rebuild from spec**. Cylinder/box có lỗ song song đúng trục được giữ thành một
  native extrusion nhiều lỗ; tube rỗng thử ring profile native trước khi fallback.
- **Frustum** dựng bằng `Revolution` native cho **mọi trục X/Y/Z** (kể cả height âm).
  Chiều cao drive được nhờ dimension mặt–mặt; bán kính vẫn là **reference dimension** nên
  chưa co giãn. `NewRevolveForms` (profile line + dimension) bị Revit từ chối khi profile
  chạm trục ("operation is not permitted in this type of family"), nên muốn bán kính drive
  cần nested family hoặc sketch profile khác. Build trả `flex` trong stats để thấy tham số
  nào còn "still".
- **Bend**: dựng bằng native `Sweep` (fallback `FreeFormElement` nếu Revit từ chối sketch);
  `radius`/`tubeRadius` chưa có dimension nên chưa drive. `anchor` hiện chỉ chọn mặt bị lock
  mỗi trục (vẫn một mặt/trục), chưa phải ràng buộc hai chiều đầy đủ.
- **Tube**: `tube` nối `start`–`end` theo **trục bất kỳ**, dựng bằng native `Sweep`; đây là
  primitive cho nhánh 45°, bích/nắp có hướng và ống xiên. `innerRadius` tạo ống rỗng.
  Chưa có sweep theo polyline (nhiều đoạn cong liên tiếp).
- **Loft**: loft trục Z đúng 2 section dùng `SweptBlend` native; profile được resample về
  cùng số điểm nên chuyển được chữ nhật ↔ tròn. Auto-heal tự tách loft Z >2 section thành
  chuỗi part 2-section. Loft trục X/Y hoặc >2 section (spec thủ công) dùng **FreeForm
  loft fallback** để giữ đủ hình, nhưng mất native form/constraint. Loft chưa có
  dimension nên đổi tham số phải dùng **Rebuild from spec**.
- **Cut trong Revit**: part có `cuts`/`innerRadius` thường được boolean ngay trong builder
  và lưu bằng `FreeFormElement`, nên void không còn cắt part khác. Đổi lại part đó mất
  native form/constraint; `Rebuild from spec` là đường cập nhật. Part không có cut vẫn native.
- **Join hình học**: form chồng nhau **cùng vật liệu** được `JoinGeometryUtils.JoinGeometry`
  sau khi dựng, để section/hidden-line không lộ mặt trong của khối đúc. Khác vật liệu thì
  giữ rời (tránh bulong đồng thau đổi màu thân). Tắt bằng `FAMILY_AGENT_JOIN=0`.
- **MEP connector**: đã tạo `ConnectorElement` cho duct/pipe/electrical theo `origin` +
  `directionVector` trỏ vào một face của form. Flow/pressure trong spec hiện chưa ghi vào
  connector; chỉ hình học kết nối và system type được tạo.
- **Chưa có transform xoay tự do cho part**: đã có `tube` trục bất kỳ; các primitive còn lại
  vẫn theo trục X/Y/Z hoặc `plane` cố định.
- Formula nào Revit từ chối (sai đơn vị, tham chiếu vòng) sẽ được thay bằng giá trị đã tính,
  kèm cảnh báo trong kết quả build.
- Chưa tạo nhiều type, chưa có tag/schedule/annotation.
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
