import { LlmError } from "./llm.js";

/**
 * Provider errors are classified here so every backend (cmdc CLI, codex, claude,
 * direct API) follows one retry/fallback policy.
 */

const TRANSIENT_STATUS = new Set([429, 500, 502, 503, 504]);
const PERMANENT_STATUS = new Set([400, 401, 403]);

/** Our own per-step budget already has its own condensed retry — not a provider outage. */
const LOCAL_TIMEOUT = /Agent run timed out after|whole request used its time budget/i;

const TRANSIENT_TEXT =
  /(UNAVAILABLE|high demand|overloaded|rate.?limit|quota|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|socket hang up|fetch failed|network error|temporarily unavailable|deepseek api error \(5\d\d\))/i;

export function statusOf(error) {
  const direct = Number(error?.status);
  if (Number.isFinite(direct) && direct >= 100) return direct;

  const text = String(error?.message ?? "");
  const match = text.match(/\b(429|500|502|503|504|400|401|403)\b/);
  return match ? Number(match[1]) : null;
}

export function isPermanentError(error) {
  const status = statusOf(error);
  if (status && PERMANENT_STATUS.has(status)) return true;
  return /api key is missing|missing for|invalid api key|unauthorized|forbidden/i.test(
    String(error?.message ?? ""),
  );
}

/**
 * The model wrote until the CLI cut it off. Retrying or switching model reproduces
 * the same over-long answer, so the brief has to be split instead.
 */
export function isOutputLimitError(error) {
  for (let current = error, depth = 0; current && depth < 4; current = current.cause, depth += 1) {
    if (current.code === "OUTPUT_LIMIT" || /\(OUTPUT_LIMIT\)/.test(String(current.message ?? ""))) {
      return true;
    }
  }
  return false;
}

export function isTransientError(error) {
  const text = String(error?.message ?? "");
  if (LOCAL_TIMEOUT.test(text)) return false;
  if (isOutputLimitError(error)) return false;
  if (error?.name === "AbortError" || /was cancelled/i.test(text)) return false;
  if (isPermanentError(error)) return false;

  const status = statusOf(error);
  if (status && TRANSIENT_STATUS.has(status)) return true;
  return TRANSIENT_TEXT.test(text);
}

/** 2 s, 5 s, 12 s for the default base of 2000 ms. */
export function retryDelays({ retryMax = 3, baseMs = 2000, jitter } = {}) {
  const factors = [1, 2.5, 6];
  return Array.from({ length: Math.max(0, retryMax) }, (_, index) => {
    const factor = factors[index] ?? 2 ** (index + 1);
    const noise = jitter ? jitter() : Math.random() * 250;
    return Math.round(baseMs * factor + noise);
  });
}

export function defaultSleep(ms, signal) {
  if (!signal) return new Promise((resolve) => setTimeout(resolve, ms));

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);

    function onAbort() {
      clearTimeout(timer);
      reject(new Error("Agent run was cancelled"));
    }

    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Retry one model on transient failures. A failed attempt stays inside its own
 * timeout; the waiting time is charged to the caller's total budget.
 */
export async function withProviderRetry(run, options = {}) {
  const {
    retryMax = 3,
    baseMs = 2000,
    jitter,
    signal,
    sleep = defaultSleep,
    onRetry,
    model,
  } = options;

  const delays = retryDelays({ retryMax, baseMs, jitter });
  let attempts = 0;

  for (;;) {
    attempts += 1;
    try {
      return await run(attempts);
    } catch (error) {
      error.attempts = attempts;

      const canRetry = isTransientError(error) && attempts <= retryMax;
      if (!canRetry || signal?.aborted) throw error;

      const wait = Number.isFinite(error.retryAfterMs)
        ? error.retryAfterMs
        : (delays[attempts - 1] ?? baseMs);

      onRetry?.({ attempt: attempts, max: retryMax, waitMs: wait, error, model });
      console.warn(
        `[design] retry model=${model || "default"} after=${Math.round(wait / 1000)}s ` +
          `attempt=${attempts}/${retryMax} reason=${String(error.message).slice(0, 140)}`,
      );

      await sleep(wait, signal);
    }
  }
}

/** True when the failure came from the model/provider rather than the spec itself. */
export function isProviderError(error) {
  const text = String(error?.message ?? "");
  return Boolean(
    statusOf(error) ||
      error?.models?.length ||
      error?.transient ||
      /unknown model|high demand|rate.?limit|fetch failed|ECONN|api key|model request failed/i.test(text),
  );
}

function attemptCount(error) {
  return Number.isFinite(error?.attempts) ? Number(error.attempts) : 1;
}

/** Short Vietnamese message for the chat; the raw text goes to `detail` and the log. */
export function describeProviderError(error, { attempts, models = [] } = {}) {
  const status = statusOf(error);
  const retries = Math.max(0, (attempts ?? attemptCount(error)) - 1);
  const retryNote = retries > 0 ? ` Đã thử lại ${retries} lần.` : "";
  const modelNote = models.length > 1 ? ` Đã thử ${models.length} model dự phòng.` : "";
  const text = String(error?.message ?? "");

  const unknownModel = text.match(/unknown model "([^"]+)"(?:[\s\S]*?Did you mean "([^"]+)")?/i);
  if (unknownModel) {
    return (
      `Model ${unknownModel[1]} không tồn tại.` +
      (unknownModel[2] ? ` Gợi ý: ${unknownModel[2]}.` : " Chọn lại model trong ô chọn.")
    );
  }

  if (status === 503 || /high demand|UNAVAILABLE|overloaded/i.test(text)) {
    return `Nhà cung cấp model đang quá tải tạm thời (503).${retryNote}${modelNote}`.trim();
  }
  if (status === 429 || /rate.?limit|quota/i.test(text)) {
    return `Model bị giới hạn tần suất (429).${retryNote}${modelNote}`.trim();
  }
  if (status === 500 || status === 502 || status === 504) {
    return `Nhà cung cấp model lỗi tạm thời (${status}).${retryNote}${modelNote}`.trim();
  }
  if (isPermanentError(error)) {
    return `Model từ chối yêu cầu (${status ?? "cấu hình"}). Kiểm tra API key/quyền truy cập — không thử lại được.`;
  }
  if (/ECONNRESET|ECONNREFUSED|ETIMEDOUT|fetch failed|socket hang up|network/i.test(text)) {
    return `Mất kết nối tới nhà cung cấp model.${retryNote}`.trim();
  }

  return `Không gọi được model: ${text.replace(/\s+/g, " ").slice(0, 160)}`;
}

/**
 * Try each model in order. A permanent error (400/401/403, missing key) stops the
 * chain; transient errors retry, then move to the next model.
 */
export async function runWithModelFallback({
  models = [],
  run,
  retryMax = 3,
  baseMs = 2000,
  jitter,
  signal,
  sleep,
  onRetry,
  onFallback,
  logger = console,
} = {}) {
  const chain = models.filter(Boolean);
  const failures = [];

  for (let index = 0; index < chain.length; index += 1) {
    const model = chain[index];

    try {
      const result = await withProviderRetry(() => run(model), {
        retryMax,
        baseMs,
        jitter,
        signal,
        sleep,
        onRetry,
        model,
      });

      result.requestedModel = chain[0];
      result.usedModel = result.model ?? model;
      if (result.usedModel !== chain[0]) {
        logger.warn(
          `[design] model mismatch: requested=${chain[0]} actual=${result.usedModel}` +
            " (the CLI may be ignoring an unknown model id)",
        );
      }

      return result;
    } catch (error) {
      // Keep the original error (and its code): the designer reacts to it by splitting.
      if (isOutputLimitError(error)) throw error;

      failures.push({ model, error });
      const permanent = isPermanentError(error);
      logger.warn(
        `[design] model=${model} failed attempts=${attemptCount(error)}` +
          ` permanent=${permanent} detail=${String(error.message).slice(0, 200)}`,
      );

      const next = chain[index + 1];
      if (permanent || signal?.aborted || !next) {
        const modelsTried = failures.map((failure) => failure.model);
        const friendly = describeProviderError(error, {
          attempts: attemptCount(error),
          models: modelsTried,
        });
        const finalError = new LlmError(
          modelsTried.length > 1 ? `${friendly} Model đã thử: ${modelsTried.join(" → ")}.` : friendly,
          statusOf(error) ?? undefined,
        );
        finalError.detail = String(error.message ?? error).slice(0, 1500);
        finalError.attempts = attemptCount(error);
        finalError.models = modelsTried;
        finalError.transient = !permanent;
        finalError.cause = error;
        throw finalError;
      }

      onFallback?.({ from: model, to: next, error });
      logger.warn(`[design] fallback ${model} -> ${next}`);
    }
  }

  throw new LlmError("Không có model nào để chạy.");
}
