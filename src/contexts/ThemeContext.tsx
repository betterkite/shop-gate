"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

export type ColorMode = "light" | "dark";

type ThemeContextValue = {
  colorMode: ColorMode;
  setColorMode: (mode: ColorMode) => void;
  toggleColorMode: () => void;
};

const STORAGE_KEY = "quantpilot-color-mode";
const ThemeContext = createContext<ThemeContextValue | null>(null);

function readStoredColorMode(): ColorMode {
  if (typeof window === "undefined") return "light";
  return window.localStorage.getItem(STORAGE_KEY) === "dark" ? "dark" : "light";
}

function applyColorMode(mode: ColorMode) {
  if (typeof document === "undefined") return;
  document.documentElement.classList.toggle("dark", mode === "dark");
  document.documentElement.style.colorScheme = mode;
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [colorMode, setColorModeState] = useState<ColorMode>("light");

  useEffect(() => {
    const storedMode = readStoredColorMode();
    setColorModeState(storedMode);
    applyColorMode(storedMode);
  }, []);

  const setColorMode = useCallback((mode: ColorMode) => {
    setColorModeState(mode);
    applyColorMode(mode);
    try {
      window.localStorage.setItem(STORAGE_KEY, mode);
    } catch {
      // Browser storage can be unavailable in private or embedded contexts.
    }
  }, []);

  const toggleColorMode = useCallback(() => {
    setColorMode(colorMode === "dark" ? "light" : "dark");
  }, [colorMode, setColorMode]);

  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key !== STORAGE_KEY) return;
      const nextMode = event.newValue === "dark" ? "dark" : "light";
      setColorModeState(nextMode);
      applyColorMode(nextMode);
    };

    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const value = useMemo(
    () => ({ colorMode, setColorMode, toggleColorMode }),
    [colorMode, setColorMode, toggleColorMode],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
  const context = useContext(ThemeContext);
  if (!context) {
    throw new Error("useTheme must be used within ThemeProvider");
  }
  return context;
}
