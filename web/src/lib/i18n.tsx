import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

import {
  dictionaries,
  localizeIssueMessage,
  type Language,
  type Strings,
} from "./strings";
import { translateServerMessage } from "./server-messages";

const STORAGE_KEY = "family.language.v1";

export const LANGUAGE_OPTIONS: Array<{ id: Language; label: string }> = [
  { id: "vi", label: "VI" },
  { id: "en", label: "EN" },
  { id: "zh", label: "中文" },
];

const LOCALES: Record<Language, string> = {
  vi: "vi-VN",
  en: "en-US",
  zh: "zh-CN",
};

const HTML_LANGS: Record<Language, string> = { vi: "vi", en: "en", zh: "zh-CN" };

type StorageLike = Pick<Storage, "getItem" | "setItem">;

function storageOrDefault(storage?: StorageLike | null): StorageLike | null {
  if (storage) return storage;
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

/** Stored choice; broken storage (privacy mode, quota) falls back to Vietnamese. */
export function readLanguage(storage?: StorageLike | null): Language {
  try {
    const value = storageOrDefault(storage)?.getItem(STORAGE_KEY);
    return value === "en" || value === "zh" ? value : "vi";
  } catch {
    return "vi";
  }
}

export function writeLanguage(language: Language, storage?: StorageLike | null): void {
  try {
    storageOrDefault(storage)?.setItem(STORAGE_KEY, language);
  } catch {
    // The UI still switches for this session.
  }
}

export interface I18nValue {
  language: Language;
  setLanguage: (language: Language) => void;
  locale: string;
  t: Strings;
  formatDate: (value: number | string | Date, options?: Intl.DateTimeFormatOptions) => string;
  formatDateTime: (value: number | string | Date) => string;
  formatNumber: (value: number, options?: Intl.NumberFormatOptions) => string;
  localizeIssue: (
    message: string,
    code?: string,
    params?: Record<string, unknown>,
  ) => string;
}

const I18nContext = createContext<I18nValue | null>(null);

export function LanguageProvider({ children }: { children: ReactNode }) {
  const [language, setLanguageState] = useState<Language>(() => readLanguage());

  useEffect(() => {
    document.documentElement.lang = HTML_LANGS[language];
  }, [language]);

  const setLanguage = useCallback((next: Language) => {
    writeLanguage(next);
    setLanguageState(next);
  }, []);

  const value = useMemo<I18nValue>(() => {
    const locale = LOCALES[language];
    const t = dictionaries[language];
    return {
      language,
      setLanguage,
      locale,
      t,
      formatDate: (input, options) => {
        try {
          return new Date(input).toLocaleDateString(locale, options);
        } catch {
          return "";
        }
      },
      formatDateTime: (input) => {
        try {
          return new Date(input).toLocaleString(locale);
        } catch {
          return "";
        }
      },
      formatNumber: (input, options) => {
        try {
          return input.toLocaleString(locale, options);
        } catch {
          return String(input);
        }
      },
      localizeIssue: (message, code, params) =>
        translateServerMessage(language, code, params, localizeIssueMessage(message, t)),
    };
  }, [language, setLanguage]);

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nValue {
  const value = useContext(I18nContext);
  if (!value) throw new Error("useI18n must be used inside LanguageProvider");
  return value;
}
