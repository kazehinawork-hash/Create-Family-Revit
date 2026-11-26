/**
 * Copy owned by the App shell (web/src/App.tsx): chat plumbing, toasts,
 * confirmations, run summaries, build/export status and the demo run.
 * Counts, names and numbers arrive pre-formatted (formatNumber/durationText) so a
 * dictionary never has to know about locales. Revit terms (Family, Type, LOD,
 * connector, reference plane, spec) stay in English on purpose.
 */
import type { Translation } from "./translation";

/**
 * The Vietnamese dictionary is authored `as const` so the literal key set is the
 * source of truth; it is exported widened below, because `strings.ts` merges every
 * module with `as const` and literal values would make `en`/`zh` unassignable.
 */
const viDictionary = {
  // Welcome + attachments
  appChatGreeting:
    "Xin chào! Hãy mô tả thiết bị bạn cần dựng hoặc kéo thả tài liệu/bản vẽ (PDF, ảnh) vào đây để tôi bắt đầu thiết kế từ đầu.",
  appAttachFailed: (message: string) => `Không đính kèm được tệp: ${message}`,

  // Durations (the unit labels are part of the message)
  appDurationUnknown: "—",
  appDurationSeconds: (seconds: string) => `${seconds} s`,
  appDurationMinutes: (minutes: string, seconds: string) => `${minutes} min ${seconds} s`,

  // Live sync from MCP / external agents
  appMcpSpecReceived: (name: string, summary: string) =>
    `Đã nhận Family Spec từ MCP: ${name}.\n${summary}`,
  appMcpLoadedTitle: (name: string) => `Đã nạp 3D Family từ MCP: ${name}`,
  appMcpLoadedSub: (summary: string) => `${summary}. Hiển thị trực tiếp trên 3D Viewport.`,

  // Run summary + token accounting
  appPartsParams: (parts: string, params: string) => `${parts} chi tiết · ${params} tham số`,
  appTier: (tier: string, label: string) => `tầng ${tier}${label ? ` (${label})` : ""}`,
  appNoModel: "không gọi model",
  appCalls: (count: string) => `${count} lượt`,
  appSavedCalls: (count: string) => `tiết kiệm ${count} lượt`,
  appPromptChars: (value: string) => `prompt ${value}k`,
  appInChars: (value: string) => `vào ${value}k`,
  appOutChars: (value: string) => `ra ${value}k ký tự`,
  appMissingUnknown: "Không rõ hạng mục thiếu",

  // Chat actions
  appResend: "Gửi lại",
  appOpenApiConfig: "Mở cấu hình API",

  // Stages
  appStageReadingAttachments: "Đang đọc tài liệu đính kèm…",
  appStageReadingRequest: "Đang đọc yêu cầu…",
  appStageRecovering: "Mất kết nối, đang lấy lại kết quả…",
  appStepProgress: (label: string, index: string, total: string) =>
    `${label} xong — đang làm bước ${index}/${total}`,

  // LOD choice
  appLodSelected: (lod: string) => `Đã chọn LOD ${lod}`,
  appLodSelectedSub: "Yêu cầu chỉnh sửa tiếp theo sẽ dựng lại mô hình ở mức chi tiết này.",

  // Similar saved family
  appSimilarSaved: (name: string, percent: string) =>
    `Có family đã lưu gần giống: ${name} (khớp ${percent}%).\nBắt đầu từ mẫu này sẽ rẻ hơn tạo mới — chỉ cần sửa lại theo yêu cầu.`,
  appSimilarSavedAction: "Bắt đầu từ mẫu gần nhất",

  // Failures
  appUnknownReason: "không rõ nguyên nhân",
  appErrorJobLost:
    "⛔ Server đã restart và không còn job này, nên kết quả bị mất.\n" +
    "Gửi lại yêu cầu — nếu prompt rất dài, hãy tách phần connector và bảng màu ra, hoặc chọn model nhanh hơn.",
  appErrorJobTimeout:
    "⛔ Đã chờ 10 phút nhưng job vẫn chưa xong, nên tạm dừng lấy kết quả.\n" +
    "Bấm Gửi lại (job cũ vẫn có thể xong sau), hoặc tách yêu cầu thành phần khung → connector → vật liệu.",
  appErrorJobFailed: (message: string, hint: string) =>
    `⛔ Job kết thúc với lỗi: ${message}\n${hint}`,
  appErrorClosedNoSpec:
    "⛔ Server đóng kết nối mà chưa trả về spec — có thể API vừa restart. Bấm gửi lại yêu cầu.",
  appErrorNoResponse:
    "⛔ Không nhận được phản hồi từ server quá 15 phút nên đã dừng.\n" +
    "Thường là do API vừa restart (`npm run dev` reload khi có file thay đổi) — kiểm tra pill trạng thái rồi gửi lại.",
  appRecoveredPrefix: "Đã lấy lại kết quả sau khi mất kết nối.\n",
  appStopped: "Đã dừng.",

  // Multi-type export
  appExportTypesTitle: (count: string) => `Đang xuất ${count} type trong một file RFA…`,
  appExportTypesSub: "Revit dựng family rồi tạo từng Family Type từ danh sách.",
  appExportTypesDone: (count: string) => `Đã xuất ${count} type trong một file .rfa`,
  appExportTypesFailed: "Xuất nhiều type thất bại",

  // Portable package
  appPortableStarted: "Đang tạo gói 1-Click RFA Portable (.bat)...",
  appPortableStartedSub:
    "Không thấy Add-in Revit (bridge 8765) → tạo gói .bat (lưu ý: tham số chỉ là metadata, muốn tham số co dãn thật hãy mở Revit có Add-in).",
  appPortableDone: "Đã tải gói 1-Click RFA (.bat — tham số metadata)",
  appPortableDoneSub:
    "Giải nén và chạy '1-Click-Build.bat'. Tham số ở chế độ này chỉ là metadata; bật Add-in trong Revit rồi bấm 'Xuất RFA' để dựng RFA có tham số thật.",
  appPortableFailed: "Không thể tạo gói Portable",

  // Build in Revit
  appBuildStarted: "Đang build family trong Revit…",
  appBuildStartedSub:
    "Nếu Revit chưa mở, hệ thống sẽ tự khởi động (khoảng 1 phút). File .rfa sẽ tự tải về khi xong.",
  appBuildNotePlanes:
    "Revit giữ được dimension theo reference plane nhưng không giữ được ràng buộc mặt: hình cập nhật bằng rebuild.",
  appBuildNoteRebuild:
    "Family chạy chế độ rebuild: đổi tham số sẽ giải lại spec, dimension chỉ để tham chiếu.",
  appBuildMissingForms: (count: string) =>
    `Thiếu ${count} part/copy khi build — xem danh sách bên dưới.`,
  appBuildFailedPart: (part: string) => `Part không dựng được: ${part}`,
  appBuildNoteQa:
    "Build QA: có part cần Rebuild from spec khi đổi tham số (FreeFormElement hoặc ràng buộc chưa compile).",
  appBuildUnlabelled: (name: string) => `Chưa dẫn động: ${name}`,
  appBuildInert: (name: string) => `Có nhãn nhưng chưa kéo được hình: ${name}`,
  appBuildResultTitle: (name: string, revitVersion: string) =>
    `Đã xuất ${name}.rfa (Revit ${revitVersion}).`,
  appBuildDriving: (driving: string, locks: string) =>
    `${driving} tham số dẫn động · ${locks} ràng buộc hình học`,
  appBuildQaWarnings: (count: string) => `${count} cảnh báo`,
  appBuildDoneMissing: (count: string) => `Build xong nhưng thiếu ${count} part/copy`,
  appBuildDoneRebuild: "Revit family built — rebuild-from-spec",
  appBuildDoneSuccess: "Revit family built successfully!",
  appBuildDoneNeedsRebuild: "Build xong — cần Rebuild from spec khi đổi tham số",
  appBuildMissingHint:
    "Xem notes hoặc Documents\\FamilyAgent\\logs\\autosync.log để biết part nào lỗi.",
  appBuildRebuildSub: "Đổi tham số trong Revit sẽ tự giải lại spec, ra đúng hình như localhost.",
  appBuildNoDrivingWarning:
    "Cảnh báo: chưa có tham số nào được gắn nhãn dimension — đổi thông số sẽ không đổi hình.",
  appBuildDrivingSub: (driving: string, path: string) =>
    `${driving} tham số dẫn động hình học · ${path}`,
  appBridgeOffTitle: "Chưa bật Studio Bridge trong Revit",
  appBridgeOffSub:
    "Vào tab 'Family Agent' trên Revit và bấm nút 'Studio bridge' (hoặc 'Build pending')",
  appBuildFailed: "Dựng family thất bại",

  // Save
  appSaveDone: "Đã lưu mô hình thành công!",
  appSaveFailed: (message: string) => `Lưu thất bại: ${message}`,
  appSaveAsPrompt: "Tên bản mới:",
  appSaveAsDone: "Đã lưu thành bản mới!",
  appSaveAsSub: (name: string) => `Tên: ${name}`,

  // Library groups
  appGroupCreated: (name: string) => `Đã tạo nhóm "${name}"`,
  appGroupCreateFailed: (message: string) => `Không tạo được nhóm: ${message}`,
  appGroupRenamed: (name: string) => `Đã đổi tên nhóm thành "${name}"`,
  appGroupRenameFailed: (message: string) => `Không đổi được tên nhóm: ${message}`,
  appGroupDeleted: (name: string) => `Đã xoá nhóm "${name}"`,
  appGroupDeletedSub: "Các family trong nhóm đã chuyển về Chưa nhóm.",
  appGroupDeleteFailed: (message: string) => `Không xoá được nhóm: ${message}`,
  appMovedToGroup: (group: string) => `Đã chuyển vào nhóm "${group}"`,
  appMovedToUngrouped: "Đã chuyển về Chưa nhóm",
  appMoveFailed: (message: string) => `Không chuyển được nhóm: ${message}`,

  // History, trash and the open model
  appRevisionUnreadable: "Không đọc được bản lưu này",
  appRevisionRestored: "Đã khôi phục bản lưu",
  appSendNotePrompt: (text: string) => `Sửa theo ghi chú trên mô hình: “${text}”`,
  appSendAllNotesPrompt: (count: string) => `Xử lý ${count} ghi chú trên mô hình.`,
  appModelReloaded: (name: string) =>
    `Đã nạp lại mô hình đã lưu: ${name}.\nBạn có thể tiếp tục trò chuyện để yêu cầu chỉnh sửa hoặc thay đổi thông số.`,
  appModelOpened: (name: string) => `Đã mở mô hình: ${name}`,
  appModelOpenFailed: (message: string) => `Không thể mở mô hình: ${message}`,
  appModelRenamed: "Đã đổi tên mô hình",
  appModelRenameFailed: (message: string) => `Đổi tên thất bại: ${message}`,
  appDeleteFailed: (message: string) => `Xoá thất bại: ${message}`,
  appRestoreFailed: (message: string) => `Khôi phục thất bại: ${message}`,
  appPurgeFailed: (message: string) => `Xoá vĩnh viễn thất bại: ${message}`,
  appEmptyTrashFailed: (message: string) => `Dọn thùng rác thất bại: ${message}`,

  // New model
  appConfirmNewModel:
    "Bắt đầu mô hình mới? Hãy chắc chắn bạn đã bấm Save nếu muốn lưu mô hình hiện tại.",

  // Demo presets (the simulated agent run)
  appDemoPromptFcu: "Dựng FCU âm trần nối ống gió Daikin FXDQ-SPV1 (Demo Preset)",
  appDemoPromptPump: "Dựng bơm ly tâm trục ngang Grundfos NB 50-200 (Demo Preset)",
  appDemoPromptYStrainer:
    "Dựng Y lọc DN80 PN16 bích 8 bulong, nhánh 45 độ, nắp bulong (Demo Preset)",
  appDemoPromptYStrainerTube:
    "Dựng Y lọc DN80 nhánh tube 45°, bích và nắp vuông góc trục nhánh (Demo Preset)",
  appDemoPromptElbow: "Dựng cút gió 90 độ nối ren DN50 (Demo Preset)",
  appDemoStageReading: "Đang đọc bản vẽ và tài liệu kỹ thuật...",
  appDemoStageThinking: "Phân tích đầu nối MEP, kích thước & mặt phẳng làm việc...",
  appDemoBuildStep: (name: string, index: string, total: string) =>
    `Đang dựng: ${name} (${index}/${total})`,
  appDemoMainFrame: "Khung chính",
  appDemoPartFallback: (index: string) => `Part ${index}`,
  appDemoStageChecking: "Kiểm tra ràng buộc công thức & MEP connector...",
  appDemoDone: (name: string, parts: string, params: string) =>
    `⚡ [Giả lập Agent - 0 token] Đã hoàn thành thiết kế ${name}.\n${parts} parts · ${params} parameters`,
  appDemoNote:
    "Chạy giả lập kiểm thử giao diện & hiệu ứng dựng tuần tự từng part thời gian thực thành công.",
  appDemoToastDone: (name: string) => `Đã hoàn thành dựng mô hình: ${name}`,

  // Accessibility labels
  appWorkspaceTabs: "Khu vực làm việc",
  appResizeAgentPanel: "Đổi độ rộng bảng agent",
  appResizeParamPanel: "Đổi độ rộng bảng tham số",

  // Design outcome + error advice
  appOutcomeUnchanged: "⚠ Chưa áp dụng được thay đổi — giữ nguyên mô hình",
  appOutcomeBuiltErrors: (name: string, count: number) =>
    `⚠ Đã dựng ${name} nhưng còn ${count} lỗi`,
  appOutcomeIncomplete: (name: string) => `⚠ Chưa đầy đủ — ${name}`,
  appOutcomeCreated: (name: string) => `Đã tạo ${name}.`,
  appOutcomeUpdated: (name: string) => `Đã cập nhật ${name}.`,
  appAdviceAuth: "Kiểm tra lại API key.",
  appAdviceOverloaded: "Nhà cung cấp đang quá tải — đợi vài giây rồi thử lại.",
  appAdviceNetwork: "Mất kết nối tới model — kiểm tra mạng rồi thử lại.",
  appAdviceTimeout: "Model chạy quá lâu — thử chọn model nhanh hơn hoặc chia nhỏ yêu cầu.",
  appAdviceOutputLimit: "Câu trả lời dài quá giới hạn — chia nhỏ yêu cầu rồi thử lại.",
  appAdviceInvalidRequest: "Yêu cầu không hợp lệ — kiểm tra lại nội dung đã gửi.",
  appAdviceUnknown: "Chưa rõ nguyên nhân — bấm Gửi lại để thử.",
} as const;

export const vi: Translation<typeof viDictionary> = viDictionary;

export const en: Translation<typeof vi> = {
  appChatGreeting:
    "Hi! Describe the equipment you need built, or drop documents/drawings (PDF, images) here and I'll start the design from scratch.",
  appAttachFailed: (message) => `Could not attach file: ${message}`,

  appDurationUnknown: "—",
  appDurationSeconds: (seconds) => `${seconds} s`,
  appDurationMinutes: (minutes, seconds) => `${minutes} min ${seconds} s`,

  appMcpSpecReceived: (name, summary) => `Family Spec received from MCP: ${name}.\n${summary}`,
  appMcpLoadedTitle: (name) => `3D Family loaded from MCP: ${name}`,
  appMcpLoadedSub: (summary) => `${summary}. Shown live in the 3D viewport.`,

  appPartsParams: (parts, params) => `${parts} parts · ${params} parameters`,
  appTier: (tier, label) => `tier ${tier}${label ? ` (${label})` : ""}`,
  appNoModel: "no model call",
  appCalls: (count) => `${count} calls`,
  appSavedCalls: (count) => `saved ${count} calls`,
  appPromptChars: (value) => `prompt ${value}k`,
  appInChars: (value) => `in ${value}k`,
  appOutChars: (value) => `out ${value}k chars`,
  appMissingUnknown: "Missing items unknown",

  appResend: "Send again",
  appOpenApiConfig: "Open API settings",

  appStageReadingAttachments: "Reading the attached documents…",
  appStageReadingRequest: "Reading the brief…",
  appStageRecovering: "Connection lost, recovering the result…",
  appStepProgress: (label, index, total) => `${label} done — now on step ${index}/${total}`,

  appLodSelected: (lod) => `LOD ${lod} selected`,
  appLodSelectedSub: "The next edit request rebuilds the model at this level of detail.",

  appSimilarSaved: (name, percent) =>
    `A similar saved family exists: ${name} (${percent}% match).\nStarting from that sample is cheaper than building new — just adjust it to the brief.`,
  appSimilarSavedAction: "Start from the closest sample",

  appUnknownReason: "unknown reason",
  appErrorJobLost:
    "⛔ The server restarted and no longer has this job, so the result is lost.\n" +
    "Send the request again — if the prompt is very long, split out the connector and colour sections, or pick a faster model.",
  appErrorJobTimeout:
    "⛔ Waited 10 minutes and the job never finished, so collecting the result was stopped.\n" +
    "Press Send again (the old job may still finish), or split the request into frame → connector → materials.",
  appErrorJobFailed: (message, hint) => `⛔ The job ended with an error: ${message}\n${hint}`,
  appErrorClosedNoSpec:
    "⛔ The server closed the connection without returning a spec — the API may have just restarted. Press send again.",
  appErrorNoResponse:
    "⛔ No response from the server for over 15 minutes, so the run was stopped.\n" +
    "This usually means the API restarted (`npm run dev` reloads on file changes) — check the status pill and send again.",
  appRecoveredPrefix: "Recovered the result after the connection dropped.\n",
  appStopped: "Stopped.",

  appExportTypesTitle: (count) => `Exporting ${count} types into one RFA file…`,
  appExportTypesSub: "Revit builds the family, then creates each Family Type from the list.",
  appExportTypesDone: (count) => `Exported ${count} types into one .rfa file`,
  appExportTypesFailed: "Exporting multiple types failed",

  appPortableStarted: "Creating 1-Click RFA Portable (.bat) package...",
  appPortableStartedSub:
    "Revit add-in (bridge 8765) offline → packing .bat (parameters are metadata only; open Revit with the add-in for parametric RFA).",
  appPortableDone: "Downloaded 1-Click RFA (.bat — metadata-only parameters)",
  appPortableDoneSub:
    "Unzip and run '1-Click-Build.bat'. For true parametric dimensions, open Revit with the add-in and click Export RFA.",
  appPortableFailed: "Could not create the Portable package",

  appBuildStarted: "Building the family in Revit…",
  appBuildStartedSub:
    "If Revit is not open yet it starts automatically (about 1 minute). The .rfa downloads as soon as it is done.",
  appBuildNotePlanes:
    "Revit keeps dimensions on reference planes but cannot keep face constraints: the shape updates through rebuild.",
  appBuildNoteRebuild:
    "This family runs in rebuild mode: changing a parameter re-solves the spec, dimensions are only a reference.",
  appBuildMissingForms: (count) => `Missing ${count} part/copy in the build — see the list below.`,
  appBuildFailedPart: (part) => `Part could not be built: ${part}`,
  appBuildNoteQa:
    "Build QA: some parts need Rebuild from spec after a parameter change (FreeFormElement or an uncompiled constraint).",
  appBuildUnlabelled: (name) => `Not driven: ${name}`,
  appBuildInert: (name) => `Has a label but does not move the shape: ${name}`,
  appBuildResultTitle: (name, revitVersion) => `Exported ${name}.rfa (Revit ${revitVersion}).`,
  appBuildDriving: (driving, locks) =>
    `${driving} driving parameters · ${locks} geometric constraints`,
  appBuildQaWarnings: (count) => `${count} warnings`,
  appBuildDoneMissing: (count) => `Built, but ${count} part/copy is missing`,
  appBuildDoneRebuild: "Revit family built — rebuild-from-spec",
  appBuildDoneSuccess: "Revit family built successfully!",
  appBuildDoneNeedsRebuild: "Built — needs Rebuild from spec after parameter changes",
  appBuildMissingHint:
    "Check the notes or Documents\\FamilyAgent\\logs\\autosync.log to see which part failed.",
  appBuildRebuildSub:
    "Changing a parameter in Revit re-solves the spec and gives the same shape as localhost.",
  appBuildNoDrivingWarning:
    "Warning: no parameter carries a dimension label yet — changing values will not change the shape.",
  appBuildDrivingSub: (driving, path) => `${driving} driving parameters · ${path}`,
  appBridgeOffTitle: "Studio Bridge is not enabled in Revit",
  appBridgeOffSub:
    "Open the 'Family Agent' tab in Revit and press the 'Studio bridge' button (or 'Build pending')",
  appBuildFailed: "Building the family failed",

  appSaveDone: "Model saved successfully!",
  appSaveFailed: (message) => `Save failed: ${message}`,
  appSaveAsPrompt: "New revision name:",
  appSaveAsDone: "Saved as a new revision!",
  appSaveAsSub: (name) => `Name: ${name}`,

  appGroupCreated: (name) => `Group "${name}" created`,
  appGroupCreateFailed: (message) => `Could not create the group: ${message}`,
  appGroupRenamed: (name) => `Group renamed to "${name}"`,
  appGroupRenameFailed: (message) => `Could not rename the group: ${message}`,
  appGroupDeleted: (name) => `Group "${name}" deleted`,
  appGroupDeletedSub: "The families in that group moved back to Ungrouped.",
  appGroupDeleteFailed: (message) => `Could not delete the group: ${message}`,
  appMovedToGroup: (group) => `Moved to group "${group}"`,
  appMovedToUngrouped: "Moved back to Ungrouped",
  appMoveFailed: (message) => `Could not move the group: ${message}`,

  appRevisionUnreadable: "Could not read this saved revision",
  appRevisionRestored: "Revision restored",
  appSendNotePrompt: (text: string) => `Fix this pinned model note: “${text}”`,
  appSendAllNotesPrompt: (count: string) => `Resolve ${count} model notes.`,
  appModelReloaded: (name) =>
    `Reloaded the saved model: ${name}.\nKeep chatting to request edits or change parameters.`,
  appModelOpened: (name) => `Model opened: ${name}`,
  appModelOpenFailed: (message) => `Could not open the model: ${message}`,
  appModelRenamed: "Model renamed",
  appModelRenameFailed: (message) => `Rename failed: ${message}`,
  appDeleteFailed: (message) => `Delete failed: ${message}`,
  appRestoreFailed: (message) => `Restore failed: ${message}`,
  appPurgeFailed: (message) => `Permanent delete failed: ${message}`,
  appEmptyTrashFailed: (message) => `Emptying the trash failed: ${message}`,

  appConfirmNewModel:
    "Start a new model? Make sure you pressed Save if you want to keep the current model.",

  appDemoPromptFcu:
    "Build a ceiling cassette FCU with duct connection, Daikin FXDQ-SPV1 (Demo Preset)",
  appDemoPromptPump:
    "Build a horizontal end-suction centrifugal pump, Grundfos NB 50-200 (Demo Preset)",
  appDemoPromptYStrainer:
    "Build a Y-strainer DN80 PN16, 8-bolt flanges, 45° branch, bolted cap (Demo Preset)",
  appDemoPromptYStrainerTube:
    "Build a Y-strainer DN80 with a 45° tube branch, flanges and a cap square to the branch axis (Demo Preset)",
  appDemoPromptElbow: "Build a 90° threaded duct elbow DN50 (Demo Preset)",
  appDemoStageReading: "Reading the drawing and the technical documents...",
  appDemoStageThinking: "Analysing MEP connectors, dimensions & working planes...",
  appDemoBuildStep: (name, index, total) => `Building: ${name} (${index}/${total})`,
  appDemoMainFrame: "Main frame",
  appDemoPartFallback: (index) => `Part ${index}`,
  appDemoStageChecking: "Checking formula constraints & MEP connectors...",
  appDemoDone: (name, parts, params) =>
    `⚡ [Simulated Agent - 0 token] Finished the design of ${name}.\n${parts} parts · ${params} parameters`,
  appDemoNote:
    "The simulated UI test of the step-by-step, real-time part build completed successfully.",
  appDemoToastDone: (name) => `Model build finished: ${name}`,

  appWorkspaceTabs: "Workspace",
  appResizeAgentPanel: "Resize the agent panel",
  appResizeParamPanel: "Resize the parameter panel",

  appOutcomeUnchanged: "⚠ The change could not be applied — the model is unchanged",
  appOutcomeBuiltErrors: (name, count) => `⚠ Built ${name}, but ${count} errors remain`,
  appOutcomeIncomplete: (name) => `⚠ Incomplete — ${name}`,
  appOutcomeCreated: (name) => `Created ${name}.`,
  appOutcomeUpdated: (name) => `Updated ${name}.`,
  appAdviceAuth: "Check the API key.",
  appAdviceOverloaded: "The provider is overloaded — wait a moment and retry.",
  appAdviceNetwork: "Lost the connection to the model — check the network and retry.",
  appAdviceTimeout: "The model took too long — pick a faster model or split the request.",
  appAdviceOutputLimit: "The answer exceeded the limit — split the request and retry.",
  appAdviceInvalidRequest: "Invalid request — check what was sent.",
  appAdviceUnknown: "Unknown cause — press Send again to retry.",
};

export const zh: Translation<typeof vi> = {
  appChatGreeting:
    "你好！请描述需要构建的设备，或在此拖入文档/图纸（PDF、图片），我会从零开始设计。",
  appAttachFailed: (message) => `无法附加文件：${message}`,

  appDurationUnknown: "—",
  appDurationSeconds: (seconds) => `${seconds} 秒`,
  appDurationMinutes: (minutes, seconds) => `${minutes} 分 ${seconds} 秒`,

  appMcpSpecReceived: (name, summary) => `已从 MCP 接收 Family Spec：${name}。\n${summary}`,
  appMcpLoadedTitle: (name) => `已从 MCP 载入 3D Family：${name}`,
  appMcpLoadedSub: (summary) => `${summary}。已直接显示在 3D 视口中。`,

  appPartsParams: (parts, params) => `${parts} 个零件 · ${params} 个参数`,
  appTier: (tier, label) => `第 ${tier} 档${label ? `（${label}）` : ""}`,
  appNoModel: "未调用模型",
  appCalls: (count) => `${count} 次调用`,
  appSavedCalls: (count) => `节省 ${count} 次调用`,
  appPromptChars: (value) => `prompt ${value}k`,
  appInChars: (value) => `输入 ${value}k`,
  appOutChars: (value) => `输出 ${value}k 字符`,
  appMissingUnknown: "缺少项目不明",

  appResend: "重新发送",
  appOpenApiConfig: "打开 API 设置",

  appStageReadingAttachments: "正在读取附件…",
  appStageReadingRequest: "正在读取需求…",
  appStageRecovering: "连接中断，正在重新获取结果…",
  appStepProgress: (label, index, total) => `${label} 完成 — 正在执行第 ${index}/${total} 步`,

  appLodSelected: (lod) => `已选择 LOD ${lod}`,
  appLodSelectedSub: "下一次修改请求将按此详细程度重新构建模型。",

  appSimilarSaved: (name, percent) =>
    `有相近的已保存 family：${name}（匹配 ${percent}%）。\n从该样例开始比新建更省 —— 只需按需求调整即可。`,
  appSimilarSavedAction: "从最接近的样例开始",

  appUnknownReason: "原因不明",
  appErrorJobLost:
    "⛔ 服务器已重启，此 job 已不存在，结果已丢失。\n" +
    "请重新发送请求 —— 如果 prompt 很长，请把连接口与配色部分拆开，或选择更快的模型。",
  appErrorJobTimeout:
    "⛔ 已等待 10 分钟但 job 仍未完成，因此暂停获取结果。\n" +
    "请点击重新发送（旧 job 之后仍可能完成），或将请求拆分为框架 → 连接口 → 材质。",
  appErrorJobFailed: (message, hint) => `⛔ Job 以错误结束：${message}\n${hint}`,
  appErrorClosedNoSpec: "⛔ 服务器关闭连接但没有返回 spec —— 可能是 API 刚刚重启。请重新发送请求。",
  appErrorNoResponse:
    "⛔ 超过 15 分钟未收到服务器响应，已停止。\n" +
    "通常是 API 刚刚重启（`npm run dev` 会在文件变更时重载）—— 检查状态指示后重新发送。",
  appRecoveredPrefix: "连接中断后已重新取得结果。\n",
  appStopped: "已停止。",

  appExportTypesTitle: (count) => `正在将 ${count} 个 type 导出到一个 RFA 文件…`,
  appExportTypesSub: "Revit 先构建 family，再按列表逐个创建 Family Type。",
  appExportTypesDone: (count) => `已将 ${count} 个 type 导出到一个 .rfa 文件`,
  appExportTypesFailed: "导出多个 type 失败",

  appPortableStarted: "正在生成 1-Click RFA Portable（.bat）包...",
  appPortableStartedSub:
    "未检测到 Revit 插件（bridge 8765）→ 打包 .bat（参数仅为元数据；如需真实参数驱动，请先打开带插件的 Revit）。",
  appPortableDone: "已下载 1-Click RFA（.bat — 参数仅为元数据）",
  appPortableDoneSub:
    "解压后运行 '1-Click-Build.bat'。若需真实可驱动参数，请在 Revit 启动插件后再点击导出 RFA。",
  appPortableFailed: "无法生成 Portable 包",

  appBuildStarted: "正在 Revit 中构建 family…",
  appBuildStartedSub: "如果 Revit 尚未打开，系统会自动启动（约 1 分钟）。完成后 .rfa 会自动下载。",
  appBuildNotePlanes:
    "Revit 能保留基于参照平面的 dimension，但无法保留面约束：形状通过 rebuild 更新。",
  appBuildNoteRebuild: "该 family 采用 rebuild 模式：修改参数会重新求解 spec，dimension 仅供参考。",
  appBuildMissingForms: (count) => `构建时缺少 ${count} 个 part/copy —— 见下方列表。`,
  appBuildFailedPart: (part) => `无法构建的 part：${part}`,
  appBuildNoteQa:
    "Build QA：部分 part 在修改参数后需要 Rebuild from spec（FreeFormElement 或尚未编译的约束）。",
  appBuildUnlabelled: (name) => `未驱动：${name}`,
  appBuildInert: (name) => `有标签但无法驱动形状：${name}`,
  appBuildResultTitle: (name, revitVersion) => `已导出 ${name}.rfa（Revit ${revitVersion}）。`,
  appBuildDriving: (driving, locks) => `${driving} 个驱动参数 · ${locks} 个几何约束`,
  appBuildQaWarnings: (count) => `${count} 个警告`,
  appBuildDoneMissing: (count) => `构建完成但缺少 ${count} 个 part/copy`,
  appBuildDoneRebuild: "Revit family 构建完成 —— rebuild-from-spec",
  appBuildDoneSuccess: "Revit family 构建成功！",
  appBuildDoneNeedsRebuild: "构建完成 —— 修改参数后需要 Rebuild from spec",
  appBuildMissingHint:
    "查看 notes 或 Documents\\FamilyAgent\\logs\\autosync.log 了解哪个 part 出错。",
  appBuildRebuildSub: "在 Revit 中修改参数会重新求解 spec，形状与 localhost 一致。",
  appBuildNoDrivingWarning: "警告：还没有参数带 dimension 标签 —— 修改数值不会改变形状。",
  appBuildDrivingSub: (driving, path) => `${driving} 个驱动几何的参数 · ${path}`,
  appBridgeOffTitle: "Revit 中尚未启用 Studio Bridge",
  appBridgeOffSub:
    "在 Revit 中打开 'Family Agent' 选项卡并点击 'Studio bridge' 按钮（或 'Build pending'）",
  appBuildFailed: "构建 family 失败",

  appSaveDone: "模型保存成功！",
  appSaveFailed: (message) => `保存失败：${message}`,
  appSaveAsPrompt: "新副本名称：",
  appSaveAsDone: "已保存为新副本！",
  appSaveAsSub: (name) => `名称：${name}`,

  appGroupCreated: (name) => `已创建分组 "${name}"`,
  appGroupCreateFailed: (message) => `无法创建分组：${message}`,
  appGroupRenamed: (name) => `分组已重命名为 "${name}"`,
  appGroupRenameFailed: (message) => `无法重命名分组：${message}`,
  appGroupDeleted: (name) => `已删除分组 "${name}"`,
  appGroupDeletedSub: "该分组中的 family 已移回未分组。",
  appGroupDeleteFailed: (message) => `无法删除分组：${message}`,
  appMovedToGroup: (group) => `已移动到分组 "${group}"`,
  appMovedToUngrouped: "已移回未分组",
  appMoveFailed: (message) => `无法移动分组：${message}`,

  appRevisionUnreadable: "无法读取此存档版本",
  appRevisionRestored: "存档版本已恢复",
  appSendNotePrompt: (text: string) => `按模型备注修改：“${text}”`,
  appSendAllNotesPrompt: (count: string) => `处理 ${count} 条模型备注。`,
  appModelReloaded: (name) => `已重新载入保存的模型：${name}。\n可以继续对话以请求修改或更改参数。`,
  appModelOpened: (name) => `已打开模型：${name}`,
  appModelOpenFailed: (message) => `无法打开模型：${message}`,
  appModelRenamed: "模型已重命名",
  appModelRenameFailed: (message) => `重命名失败：${message}`,
  appDeleteFailed: (message) => `删除失败：${message}`,
  appRestoreFailed: (message) => `恢复失败：${message}`,
  appPurgeFailed: (message) => `永久删除失败：${message}`,
  appEmptyTrashFailed: (message) => `清空回收站失败：${message}`,

  appConfirmNewModel: "开始新模型？如果想保留当前模型，请确认已点击 Save。",

  appDemoPromptFcu: "构建带风管接头的吊顶式 FCU，Daikin FXDQ-SPV1（Demo Preset）",
  appDemoPromptPump: "构建卧式端吸离心泵，Grundfos NB 50-200（Demo Preset）",
  appDemoPromptYStrainer:
    "构建 Y 型过滤器 DN80 PN16，8 螺栓法兰，45° 支管，螺栓端盖（Demo Preset）",
  appDemoPromptYStrainerTube:
    "构建 Y 型过滤器 DN80，45° 管式支管，法兰与垂直于支管轴线的端盖（Demo Preset）",
  appDemoPromptElbow: "构建 90° 螺纹风管弯头 DN50（Demo Preset）",
  appDemoStageReading: "正在读取图纸与技术文档...",
  appDemoStageThinking: "正在分析 MEP 连接口、尺寸与工作平面...",
  appDemoBuildStep: (name, index, total) => `正在构建：${name}（${index}/${total}）`,
  appDemoMainFrame: "主体框架",
  appDemoPartFallback: (index) => `零件 ${index}`,
  appDemoStageChecking: "正在检查公式约束与 MEP 连接口...",
  appDemoDone: (name, parts, params) =>
    `⚡ [模拟 Agent - 0 token] 已完成 ${name} 的设计。\n${parts} 个零件 · ${params} 个参数`,
  appDemoNote: "模拟运行已完成：逐件实时构建的界面流程与动效均正常。",
  appDemoToastDone: (name) => `模型构建完成：${name}`,

  appWorkspaceTabs: "工作区",
  appResizeAgentPanel: "调整 agent 面板宽度",
  appResizeParamPanel: "调整参数面板宽度",

  appOutcomeUnchanged: "⚠ 无法应用更改——模型保持不变",
  appOutcomeBuiltErrors: (name, count) => `⚠ 已构建 ${name}，但仍有 ${count} 个错误`,
  appOutcomeIncomplete: (name) => `⚠ 不完整——${name}`,
  appOutcomeCreated: (name) => `已创建 ${name}。`,
  appOutcomeUpdated: (name) => `已更新 ${name}。`,
  appAdviceAuth: "请检查 API key。",
  appAdviceOverloaded: "服务提供商过载——请稍候重试。",
  appAdviceNetwork: "与模型的连接中断——请检查网络后重试。",
  appAdviceTimeout: "模型运行时间过长——请选择更快的模型或拆分请求。",
  appAdviceOutputLimit: "回答超出长度限制——请拆分请求后重试。",
  appAdviceInvalidRequest: "请求无效——请检查发送的内容。",
  appAdviceUnknown: "原因未知——再次点击发送重试。",
};
