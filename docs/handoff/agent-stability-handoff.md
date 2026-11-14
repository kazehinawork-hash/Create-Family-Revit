# Hướng dẫn triển khai: tăng độ ổn định Agent dựng hình (designStable)

> Tài liệu này dành cho agent lập trình. Làm **đúng thứ tự**, **mỗi task xong phải chạy test** trước khi sang task tiếp theo.
> Ngôn ngữ code/comment: tiếng Anh (giữ phong cách file hiện tại). Thông báo hiển thị cho người dùng (`send(...)`, `warnings`): tiếng Việt như hiện tại.

---

## 0. Chuẩn bị (bắt buộc)

1. Thư mục gốc repo: `E:\OneDrive\3.家 Jiā Home\99. 其他 Qítā Other\100. Create Family revit`. Branch hiện tại: `feature/studio-v5`.
2. Working tree **đang có thay đổi chưa commit** (designer.js, agents.js, llm.js, retry.js, config.js, test…). **KHÔNG** `git checkout`, `git stash`, `git reset` hay revert bất cứ thứ gì. Làm tiếp trên chính các file đó.
3. Chạy test gốc để biết trạng thái ban đầu và ghi lại kết quả:
   ```bash
   cd server && npm test
   ```
   Nếu có test đã đỏ từ trước → ghi tên lại, **không sửa** chúng, chỉ đảm bảo không làm đỏ thêm test nào.
4. Phạm vi: chỉ sửa `designStable` (bắt đầu ~`server/src/designer.js:1053`) và hàm phụ trợ. **KHÔNG** sửa `designExperimental`, `designSingle`, `designInSteps`, API `/api/design`, schema, hay tier-0 (`parseFastParameterEdit`).
5. Các file liên quan:
   | File | Vai trò |
   |---|---|
   | `server/src/designer.js` | `designStable`, `runTurn`, `buildBySections`, cache |
   | `server/src/agents.js` | `commandCodeJson` (đọc stdout CLI) |
   | `server/src/config.js` | khối `agent: { ... }` |
   | `server/src/retry.js` | `isPermanentError`, `isOutputLimitError` |
   | `server/src/checklist.js` | `buildSupplementPrompt`, `checkCompleteness` |
   | `server/test/design-core.test.js` | test mẫu: mock model qua `options.generate` |
   | `.env.example` | tài liệu biến môi trường |

**Các test hiện có PHẢI tiếp tục xanh** — đặc biệt trong `design-core.test.js`:
- `(b) two invalid answers, then a valid one` → đúng 3 lần gọi, `stats.attempts === 3`.
- `a valid but incomplete answer is supplemented` → đúng 2 lần gọi, message cuối chứa `Add ONLY these`.
- `still incomplete after three turns` → đúng 3 lần gọi.
- `(c) an OUTPUT_LIMIT answer splits…` → message của section sau chứa `current spec`.
- Test timeout ở ~dòng 459 → đúng 3 lần gọi.

Các con số budget ở Task 1 được chọn để giữ nguyên các kết quả trên.

---

## Task 1 — Thêm cấu hình budget (config.js + .env.example)

### 1.1 `server/src/config.js`
Trong object `agent: { ... }`, ngay **sau** dòng `retryBaseMs: ...`, thêm:

```js
    /**
     * Per-turn budgets of the stable pipeline. Each kind of extra call has its own
     * budget so a timeout or a supplement round never eats the repair turns.
     * Counts are EXTRA calls after the first one.
     */
    repairMax: Number(process.env.AGENT_REPAIR_MAX || 2),
    supplementMax: Number(process.env.AGENT_SUPPLEMENT_MAX || 2),
    layoutMax: Number(process.env.AGENT_LAYOUT_MAX || 1),
    proseMax: Number(process.env.AGENT_PROSE_MAX || 1),
    timeoutRetryMax: Number(process.env.AGENT_TIMEOUT_RETRY_MAX || 1),
    /** Hard ceiling of model calls in one turn, whatever the budgets above say. */
    turnCallsMax: Number(process.env.AGENT_TURN_CALLS_MAX || 6),
```

### 1.2 `.env.example`
Thêm cuối file:

```
# Stable design pipeline budgets (extra calls after the first answer, per turn)
# AGENT_REPAIR_MAX=2
# AGENT_SUPPLEMENT_MAX=2
# AGENT_LAYOUT_MAX=1
# AGENT_PROSE_MAX=1
# AGENT_TIMEOUT_RETRY_MAX=1
# AGENT_TURN_CALLS_MAX=6
```

### 1.3 Kiểm tra
`cd server && npm test` → không đổi so với bước 0.

---

## Task 2 — Viết lại vòng lặp `runTurn`: budget riêng + message không phình

Vị trí: `server/src/designer.js`, trong `designStable`, hàm `const runTurn = async (text, spec, { enforceCompleteness = true, section = false } = {}) => { ... }` (~dòng 1275–1504).

### 2.1 Đưa `warnings` lên trên
Hiện `const warnings = [];` nằm **sau** `runTurn` (~dòng 1506). **Cắt** dòng đó và **dán** ngay trước dòng `const runTurn = async ...` để `runTurn` dùng được trực tiếp.

### 2.2 Thêm hàm dựng message "sạch" (đặt ngay trước `runTurn`)

```js
  /**
   * Every model call gets a fresh, bounded conversation: system + documents + the
   * spec to work on + one instruction. Repairs never append to the previous turn,
   * so the prompt does not grow with the number of attempts.
   */
  const freshMessages = (instruction, baseSpec, { dependencyMap = true, focus = "" } = {}) => {
    const out = [systemMessage, ...documents];

    if (baseSpec) {
      const map = dependencyMap ? parameterDependencySummary(baseSpec, 6000, focus) : "";
      const dependencyBlock = map
        ? `${map}\n\nUse this map before changing anything: update the base parameter and every dependent parameter/part it reaches. Do not hard-code a value that the map says is derived.\n\n`
        : "";
      out.push({
        role: "user",
        content: `Here is the current spec. Apply my next request to it.\n${dependencyBlock}${JSON.stringify(baseSpec)}`,
      });
    }

    const request = `${instruction}\n\n---\n${JSON_OUTPUT_CONTRACT}`;
    out.push({
      role: "user",
      content: imageParts.length > 0 ? [{ type: "text", text: request }, ...imageParts] : request,
    });
    return out;
  };
```

> Lưu ý: chuỗi `"Here is the current spec. Apply my next request to it."` phải giữ **nguyên văn** (test `(c)` tìm `current spec`).

### 2.3 Thêm hàm chấm điểm ứng viên (đặt ngay sau `freshMessages`)

```js
  /** Lower is better, compared element by element. */
  const scoreOf = (candidate) => {
    const gaps = hasRequirements && candidate?.spec ? gapsFor(candidate) : null;
    return [
      candidate?.ok ? 0 : 1,
      gaps ? gaps.missing.length : 0,
      candidate?.errors?.length ?? 999,
      candidate?.issues?.length ?? 999,
      -(candidate?.spec?.parts?.length ?? 0),
    ];
  };

  /** True when `next` should replace `best`. A full tie keeps the newer answer. */
  const isBetter = (next, best) => {
    if (!best) return true;
    const a = scoreOf(next);
    const b = scoreOf(best);
    for (let index = 0; index < a.length; index += 1) {
      if (a[index] !== b[index]) return a[index] < b[index];
    }
    return true;
  };
```

### 2.4 Thay toàn bộ thân `runTurn`
Xoá **toàn bộ** nội dung bên trong `runTurn` (từ `const messages = [systemMessage, ...documents];` đến `return { analysis, attempts, gaps: latestGaps };`) và thay bằng đoạn dưới. Đọc kỹ comment — logic giữ nguyên hành vi cũ, chỉ đổi cách đếm lượt và cách dựng message.

```js
    const budget = {
      repair: config.agent.repairMax,
      supplement: config.agent.supplementMax,
      layout: config.agent.layoutMax,
      prose: config.agent.proseMax,
      timeout: config.agent.timeoutRetryMax,
    };
    const callsMax = Math.max(1, config.agent.turnCallsMax);
    // An edit keeps the user's family: a candidate that blows up its size is suspect.
    const editBefore = spec && !section ? boundsOf(spec) : null;

    let messages = freshMessages(text, spec, { focus: text });
    let analysis = null;
    let bestAnalysis = null;
    let attempts = 0;
    let timeoutCap = Number.POSITIVE_INFINITY;
    let latestGaps = null;
    let nextReason = null;

    while (attempts < callsMax) {
      const remaining = deadline - Date.now();
      if (attempts > 0 && remaining <= 5000) break;
      attempts += 1;

      const timeoutMs = Math.max(
        5000,
        Math.min(
          turnTimeoutMs({ hasCurrentSpec: Boolean(spec) && !section, remainingMs: remaining }),
          timeoutCap,
        ),
      );

      if (attempts === 1) {
        send({ type: "stage", stage: "generating", message: "Đang dựng…" });
      } else if (nextReason) {
        send({ type: "stage", stage: "repairing", message: nextReason });
        nextReason = null;
      }

      let result;
      const turnStartedAt = Date.now();
      const ticker = setInterval(() => {
        const seconds = Math.round((Date.now() - turnStartedAt) / 1000);
        send({ type: "stage", stage: "working", message: `Đang dựng… ${seconds}s` });
      }, 15000);
      ticker.unref?.();

      try {
        modelCalls += 1;
        result = await generate(messages, {
          ...(model ? { model } : {}),
          ...(customApiConfig ? { customApiConfig } : {}),
          ...(commandCodeApiKey ? { commandCodeApiKey } : {}),
          ...(signal ? { signal } : {}),
          timeoutMs,
          onProgress: (message) => send({ type: "stage", stage: "working", message }),
        });
      } catch (error) {
        // Cancelled by the user / closed request: never swallow.
        if (signal?.aborted || error?.name === "AbortError") throw error;
        // Cut off at the token limit: the caller splits and retries.
        if (isOutputLimitError(error)) throw error;

        if (
          isTimeoutError(error) &&
          budget.timeout > 0 &&
          attempts < callsMax &&
          deadline - Date.now() > 60000
        ) {
          if (!spec) {
            const sections = splitNewBrief(text, 0);
            if (sections && sections.length > 1) throw error;
          }
          budget.timeout -= 1;
          timeoutCap = Math.max(60000, Math.round(timeoutMs / 2));
          send({
            type: "stage",
            stage: "retrying",
            message: `Hết thời gian lượt ${attempts} — thử lại với yêu cầu gọn hơn`,
          });
          messages = freshMessages(`${text}\n\n${TIMEOUT_RETRY}`, spec, { focus: text });
          continue;
        }

        // A later call failed but an earlier one produced a spec: keep it instead of
        // throwing the user's whole request away. Only a permanent error (bad key,
        // 400) still propagates when nothing was built.
        if (bestAnalysis?.spec) {
          console.warn(`[design] attempt ${attempts} failed, keeping the best spec so far:`, error?.message);
          warnings.push(
            `Lượt ${attempts} lỗi (${error?.message ?? error}) — giữ bản tốt nhất đã dựng.`,
          );
          analysis = bestAnalysis;
          break;
        }

        if (error?.name !== "LlmError") throw error;

        const proseText = typeof error.text === "string" ? error.text.trim() : "";
        if (!proseText || budget.prose <= 0 || attempts >= callsMax) throw error;

        budget.prose -= 1;
        send({
          type: "stage",
          stage: "repairing",
          message: "The answer was prose — asking for the JSON spec again",
        });
        messages = freshMessages(`${PROSE_REPAIR}\n\nOriginal request:\n${text}`, spec, { focus: text });
        continue;
      } finally {
        clearInterval(ticker);
      }

      usage = result.usage ?? usage;
      console.log(
        `[design] attempt ${attempts} answered in ${Math.round((Date.now() - startedAt) / 1000)}s` +
          `${result.usage?.total_tokens ? `, ${result.usage.total_tokens} tokens` : ""}`,
      );
      send({ type: "stage", stage: "checking", message: "Đang tự kiểm tra…" });

      if (result?.json && typeof result.json === "object") {
        result.json = autoHealSpec(result.json);
      }
      analysis = analyzeSpec(result.json);

      // An edit whose answer changed the family's size/part count wildly is not
      // allowed to replace a sane earlier candidate.
      const drifted =
        editBefore && analysis.ok && bestAnalysis?.ok
          ? geometryDrift(editBefore, analysis.model?.bounds, spec, analysis.spec)
          : null;
      if (!drifted && isBetter(analysis, bestAnalysis)) {
        bestAnalysis = analysis;
      } else if (drifted) {
        console.warn(`[design] attempt ${attempts} drifted, keeping the earlier spec: ${drifted}`);
      }

      if (attempts >= callsMax) break;

      if (analysis.ok) {
        if (enforceCompleteness && hasRequirements) {
          const gaps = gapsFor(analysis);
          latestGaps = gaps;
          if (!gaps.ok && budget.supplement > 0) {
            budget.supplement -= 1;
            send({ type: "stage", stage: "completing", message: `Thiếu ${describeGaps(gaps)} — bổ sung` });
            messages = freshMessages(buildSupplementPrompt(gaps.missing, text), result.json, {
              focus: text,
            });
            continue;
          }
        }

        const layoutIssues = analysis.issues.filter((issue) => issue.path.startsWith("logic."));
        const severeLayout = layoutIssues.some((issue) => issue.path.startsWith("logic.drain-pan"));
        if (
          process.env.LAYOUT_PASS !== "0" &&
          (severeLayout || layoutIssues.length >= 2) &&
          budget.layout > 0
        ) {
          budget.layout -= 1;
          nextReason = `Sửa ${layoutIssues.length} lỗi hình học`;
          send({
            type: "stage",
            stage: "repairing",
            message: nextReason,
            issues: layoutIssues.slice(0, 12),
          });
          messages = freshMessages(
            `Original request:\n${text}\n\n${repairInstructions(result.json, layoutIssues, text)}`,
            result.json,
            { dependencyMap: false },
          );
          continue;
        }
        break;
      }

      if (budget.repair <= 0) break;
      budget.repair -= 1;
      send({
        type: "stage",
        stage: "repairing",
        message: `Còn ${analysis.errors.length} lỗi`,
        issues: analysis.errors.slice(0, 12),
      });
      messages = freshMessages(
        `Original request:\n${text}\n\n${repairInstructions(result.json, analysis.errors, text)}`,
        result.json,
        { dependencyMap: false },
      );
    }

    if (bestAnalysis && (!analysis || isBetter(bestAnalysis, analysis))) {
      analysis = bestAnalysis;
    }
    // The returned gaps must describe the spec actually returned.
    if (hasRequirements && enforceCompleteness && analysis?.spec) latestGaps = gapsFor(analysis);

    return { analysis, attempts, gaps: latestGaps };
```

### 2.5 Dọn dẹp
1. `MAX_ATTEMPTS` (~dòng 61) **vẫn được dùng** ở `designSingle` (~dòng 2644) → **không xoá** hằng số.
2. Kiểm tra import đầu file `designer.js`: `buildSupplementPrompt`, `isOutputLimitError` đã được import (đang dùng ở code cũ). `boundsOf`, `geometryDrift` là hàm cùng file (khai báo bằng `function` nên hoisting OK). Nếu ESLint báo thiếu import → thêm cho đúng nguồn (`./checklist.js`, `./retry.js`).
3. Hàm `compactSpec` có thể không còn được `designStable` dùng; **không xoá** nếu chỗ khác còn dùng (grep `compactSpec(` trước).

### 2.6 Kiểm tra
```bash
cd server && npm test
```
Tất cả test cũ phải xanh. Nếu test `(b)` fail vì regex `/Missing Parameter/` → kiểm tra message repair có chứa `repairInstructions(...)` (danh sách lỗi) không.

---

## Task 3 — `buildBySections`: chỉ chuyền spec hợp lệ sang mục sau

Vị trí: `buildBySections` (~dòng 1510–1557).

### 3.1 Sửa thân vòng `for`
Thay khối `try { ... } catch (stepError) { ... }` bằng:

```js
      try {
        const stepOutcome = await runTurn(step.prompt, spec, {
          enforceCompleteness: index === steps.length - 1,
          section: true,
        });
        totalAttempts += stepOutcome.attempts;
        if (stepOutcome.gaps) finalGaps = stepOutcome.gaps;

        if (stepOutcome.analysis?.ok) {
          // Only a valid spec is a safe base for the next section.
          spec = stepOutcome.analysis.spec;
          stepsDone += 1;
        } else {
          warnings.push(
            `Bước "${step.label}" chưa hợp lệ: ${formatIssues(stepOutcome.analysis?.errors ?? [])} — bỏ qua, giữ bản trước.`,
          );
        }
      } catch (stepError) {
        if (signal?.aborted || stepError?.name === "AbortError") throw stepError;
        if (isOutputLimitError(stepError)) {
          warnings.push(`Bước "${step.label}" vượt giới hạn độ dài — dừng chia nhỏ.`);
          break;
        }
        const reason = stepError?.message ?? String(stepError);
        // One slow section should not cancel the remaining ones.
        if (isTimeoutError(stepError)) {
          warnings.push(`Bước "${step.label}" hết thời gian — bỏ qua, dựng tiếp các bước sau.`);
          continue;
        }
        warnings.push(`Bước "${step.label}" lỗi (${reason}) — giữ phần đã dựng.`);
        break;
      }
```

### 3.2 Kiểm tra
`npm test` xanh (test `(c)` và test timeout ~dòng 459).

---

## Task 4 — Không cache kết quả thiếu / có cảnh báo

Vị trí: dòng cuối `designStable` (~1648):
```js
  if (resultKey && analysis.ok) writeCachedResult(resultKey, { analysis, stats });
```
Thay bằng:
```js
  // Only a clean, complete answer may be replayed: an incomplete one cached for 30
  // minutes would come back every time the user resends the same brief.
  const cacheable =
    analysis.ok && (!completeness || completeness.ok) && warnings.length === 0;
  if (resultKey && cacheable) writeCachedResult(resultKey, { analysis, stats });
```
**Không** sửa dòng cache tier-0 (~1111) và các dòng cache trong pipeline experimental.

Kiểm tra: `npm test` (test `cached answers do not reach the model twice` vẫn xanh).

---

## Task 5 — `commandCodeJson`: bỏ regex tham lam trên stdout

Vị trí: `server/src/agents.js`, trong `commandCodeJson` (~dòng 627–632):
```js
    if (!text) {
      const match = result.stdout.match(/\{[\s\S]*\}/);
      if (match) {
        text = match[0];
      }
    }
```

### 5.1 Thêm hàm export (đặt ngay sau `extractResult`, ~dòng 80)

```js
/**
 * Last-resort answer lookup when the CLI printed no `result` frame. stdout is a
 * stream of one-JSON-per-line frames, so a greedy /\{.*\}/ grabs garbage spanning
 * many frames. Walk the lines from the end instead and take the first one that is
 * either a spec or a frame carrying the final text.
 */
export function extractAnswerText(stdout) {
  const lines = String(stdout ?? "").split(/\r?\n/);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index].trim();
    if (!line.startsWith("{")) continue;
    let value;
    try {
      value = JSON.parse(line);
    } catch {
      continue;
    }
    if (!value || typeof value !== "object") continue;
    if (Array.isArray(value.parts) || typeof value.schemaVersion === "string") return line;
    for (const key of ["finalText", "response", "text", "content"]) {
      if (typeof value[key] === "string" && value[key].includes("{")) return value[key].trim();
    }
  }
  // A plain (non-framed) answer: the whole stdout is the JSON object.
  const whole = String(stdout ?? "").trim();
  if (whole.startsWith("{") && whole.endsWith("}")) return whole;
  return "";
}
```

### 5.2 Thay đoạn regex
```js
    if (!text) {
      text = extractAnswerText(result.stdout);
    }
```
Giữ nguyên khối `if (!text) { ... throw ... "Agent completed without returning a spec" }` ngay sau đó.

### 5.3 Kiểm tra
`npm test` xanh.

---

## Task 6 — Test mới

### 6.1 Thêm vào cuối `server/test/design-core.test.js`
File đã có sẵn `ladderSpec()`, `brokenSpec()`, `crossSpec()` và `beforeEach(clearCachedResults)` — dùng lại.

```js
test("a timeout on the first call does not eat the repair budget", async () => {
  const calls = [];
  const result = await design({
    prompt: "khung đỡ thiết bị 500x120",
    currentSpec: null,
    lod: 300,
    emit: () => {},
    model: "cheap-model",
    generate: async (messages) => {
      calls.push(messages);
      if (calls.length === 1) throw new Error("Agent run timed out after 300s");
      if (calls.length === 2) return { json: brokenSpec(), text: "", usage: null };
      return { json: ladderSpec("Sau sửa"), text: "", usage: null };
    },
  });

  assert.equal(calls.length, 3, "timeout + broken + repaired");
  assert.equal(result.analysis.ok, true);
  assert.equal(result.analysis.spec.name, "Sau sửa");
});

test("a supplement answer that loses parts never replaces the better spec", async () => {
  const calls = [];
  const result = await design({
    prompt: "ngã tư thang cáp 400x100, 4 thành góc, 6 bậc thang, 4 connector",
    currentSpec: null,
    lod: 300,
    emit: () => {},
    model: "cheap-model",
    generate: async () => {
      calls.push(1);
      // 1st: rails + connectors (no rungs). Later: an almost empty spec.
      const spec = calls.length === 1 ? crossSpec({ withRungs: false }) : ladderSpec("Rỗng");
      return { json: spec, text: "", usage: null };
    },
  });

  assert.notEqual(result.analysis.spec.name, "Rỗng", "the regressed answer must not win");
});

test("a provider error after a first spec keeps that spec instead of failing", async () => {
  const calls = [];
  const result = await design({
    prompt: "khung đỡ thiết bị 500x120",
    currentSpec: null,
    lod: 300,
    emit: () => {},
    model: "cheap-model",
    generate: async () => {
      calls.push(1);
      if (calls.length === 1) return { json: brokenSpec(), text: "", usage: null };
      throw new Error("socket hang up");
    },
  });

  assert.equal(calls.length, 2);
  assert.equal(result.analysis.spec.name, "Hỏng");
  assert.ok(result.stats.warnings.some((item) => /socket hang up/.test(item)));
});

test("an incomplete result is never cached", async () => {
  let calls = 0;
  const run = () =>
    design({
      prompt: "khung đỡ thiết bị 500x120, 6 bậc thang",
      currentSpec: null,
      lod: 300,
      emit: () => {},
      model: "cheap-model",
      generate: async () => {
        calls += 1;
        return { json: ladderSpec(), text: "", usage: null };
      },
    });

  const first = await run();
  assert.equal(first.stats.complete, false);
  const callsAfterFirst = calls;
  const second = await run();
  assert.ok(calls > callsAfterFirst, "the second run must reach the model again");
  assert.notEqual(second.stats.cached, true);
});

test("repair prompts do not grow with the number of attempts", async () => {
  const sizes = [];
  await design({
    prompt: "khung đỡ thiết bị 500x120",
    currentSpec: null,
    lod: 300,
    emit: () => {},
    model: "cheap-model",
    generate: async (messages) => {
      sizes.push(JSON.stringify(messages).length);
      return { json: brokenSpec(), text: "", usage: null };
    },
  });

  assert.equal(sizes.length, 3);
  assert.ok(sizes[2] <= sizes[1] * 1.1, `3rd prompt ${sizes[2]} vs 2nd ${sizes[1]}`);
});
```

### 6.2 Test section: mục lỗi không được làm nền cho mục sau
**Trước khi viết**, in ra prompt từng section để biết route theo chuỗi nào:
```bash
cd server && node --input-type=module -e "import { splitNewBrief } from './src/designer.js'; console.log(JSON.stringify(splitNewBrief('## Khung\nKhung thép 1200 x 600 mm.\n\n## Cửa thăm\nCửa thăm 300 x 300 mm ở mặt trước.\n\n## Chân đế\nChân đế cao 150 mm.', 0), null, 2))"
```
Xác nhận mỗi `step.prompt` chỉ chứa text của section của nó. Rồi thêm test:

```js
test("an invalid section is skipped and never becomes the base of the next one", async () => {
  const brief = [
    "## Khung", "Khung thép 1200 x 600 mm.", "",
    "## Cửa thăm", "Cửa thăm 300 x 300 mm ở mặt trước.", "",
    "## Chân đế", "Chân đế cao 150 mm.",
  ].join("\n");

  const calls = [];
  const result = await design({
    prompt: brief,
    currentSpec: null,
    lod: 300,
    emit: () => {},
    model: "cheap-model",
    generate: async (messages) => {
      calls.push(messages);
      if (calls.length === 1) {
        const error = new Error("Model output ended (OUTPUT_LIMIT)");
        error.code = "OUTPUT_LIMIT";
        throw error;
      }
      const last = String(messages.at(-1).content);
      if (last.includes("Chân đế cao")) return { json: ladderSpec("Chân đế"), text: "", usage: null };
      if (last.includes("Cửa thăm 300")) return { json: brokenSpec(), text: "", usage: null };
      return { json: ladderSpec("Khung"), text: "", usage: null };
    },
  });

  const lastCall = calls.at(-1).map((message) => String(message.content)).join("\n");
  assert.match(lastCall, /"name":"Khung"/, "section 3 builds on the last valid spec");
  assert.doesNotMatch(lastCall, /Missing Parameter/, "the broken section is not carried");
  assert.equal(result.analysis.ok, true);
  assert.ok(result.stats.warnings.some((item) => /Cửa thăm|chưa hợp lệ/.test(item)));
});
```
> Nếu `step.label` không phải "Cửa thăm" thì regex warning chỉ cần khớp `chưa hợp lệ`.

### 6.3 Test parser stdout — tạo file mới `server/test/cli-answer.test.js`

```js
import assert from "node:assert/strict";
import test from "node:test";

import { extractAnswerText } from "../src/agents.js";

test("takes the final text frame, not a span across frames", () => {
  const stdout = [
    '{"type":"progress","message":"thinking {not json"}',
    '{"type":"tool","input":{"path":"a.txt"}}',
    '{"type":"assistant","finalText":"{\\"schemaVersion\\":\\"1.0\\",\\"parts\\":[]}"}',
  ].join("\n");
  assert.equal(extractAnswerText(stdout), '{"schemaVersion":"1.0","parts":[]}');
});

test("accepts a bare spec line", () => {
  const stdout = 'log line\n{"schemaVersion":"1.0","parts":[{"id":"a"}]}\n';
  assert.equal(extractAnswerText(stdout), '{"schemaVersion":"1.0","parts":[{"id":"a"}]}');
});

test("returns empty when nothing usable is printed", () => {
  assert.equal(extractAnswerText('{"type":"progress"}\n{"type":"tool"}'), "");
  assert.equal(extractAnswerText("plain text only"), "");
});
```

### 6.4 Chạy
```bash
cd server && npm test
```
Toàn bộ xanh (trừ các test đã đỏ từ bước 0, nếu có).

---

## Task 7 — Kiểm tra cuối & bàn giao

1. `cd server && npm test` → xanh.
2. Từ gốc repo chạy lint nếu có cấu hình: `npx eslint server/src/designer.js server/src/agents.js server/src/config.js`.
3. `git diff --stat` — chỉ các file sau được đổi trong đợt này: `server/src/designer.js`, `server/src/agents.js`, `server/src/config.js`, `.env.example`, `server/test/design-core.test.js`, `server/test/cli-answer.test.js` (mới).
4. Chạy thử thật (nếu có CLI/API): mở studio, gửi brief "ngã tư thang cáp 400x100, 4 thành góc, 6 bậc thang, 4 connector". Xem log server: số dòng `[design] attempt N answered` ≤ 6, kết quả có đủ bậc thang hoặc `warnings` ghi rõ phần thiếu.
5. **Không commit** trừ khi người dùng cho phép. Nếu được phép, commit theo từng task:
   - `feat(design): per-kind attempt budgets and bounded repair prompts`
   - `fix(design): carry only valid section specs forward`
   - `fix(design): never cache incomplete results`
   - `fix(agents): parse CLI answer frame by frame`
   - `test(design): stability fault-injection cases`
6. Báo cáo lại: danh sách task đã xong, kết quả `npm test` (số pass/fail), và bất kỳ chỗ nào phải làm khác hướng dẫn kèm lý do.

---

## Bảng lỗi thường gặp

| Triệu chứng | Nguyên nhân / Cách xử lý |
|---|---|
| `ReferenceError: warnings is not defined` / TDZ | Chưa chuyển `const warnings = []` lên trước `runTurn` (2.1). |
| Test `(b)` báo 4 lần gọi | `repairMax` đang là 3 — phải là **2** (số lượt *thêm*). |
| Test supplement báo 3 lần gọi | Chấm điểm sai khiến vòng chưa `break`; kiểm tra `gapsFor` trả `ok: true` cho `crossSpec()`. |
| Test `(c)` fail `current spec` | Đã đổi câu `"Here is the current spec..."` trong `freshMessages` — trả về nguyên văn. |
| `gapsFor` ném lỗi với spec null | `scoreOf` phải kiểm `candidate?.spec` trước khi gọi `gapsFor` (đã có trong mẫu). |
| `isTimeoutError is not defined` trong buildBySections | Hàm ở cùng file (~dòng 858), khai báo `function` → dùng được; kiểm tra lỗi chính tả. |
