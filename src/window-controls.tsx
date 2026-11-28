import { useEffect, useState } from "react";

// The desktop app draws no native frame on Windows (src-tauri/src/main.rs), so the page draws the caption buttons
// and works them through Tauri's window API, which the app grants to the connected server.
type TauriWindow = {
  minimize(): Promise<void>;
  toggleMaximize(): Promise<void>;
  close(): Promise<void>;
  isMaximized(): Promise<boolean>;
};

const currentWindow = (): TauriWindow | undefined =>
  (
    window as {
      __TAURI__?: { window?: { getCurrentWindow(): TauriWindow } };
    }
  ).__TAURI__?.window?.getCurrentWindow();

const onWindows = () => document.documentElement.dataset.desktop === "windows";

// Glyphs from Segoe Fluent Icons, the font Windows 11 draws its own caption buttons with.
const glyphs = {
  minimize: "\uE921",
  maximize: "\uE922",
  restore: "\uE923",
  close: "\uE8BB",
};

export function WindowControls() {
  const [maximized, setMaximized] = useState(false);
  useEffect(() => {
    const win = onWindows() ? currentWindow() : undefined;
    if (!win) return;
    const sync = () => void win.isMaximized().then(setMaximized);
    sync();
    window.addEventListener("resize", sync);
    return () => window.removeEventListener("resize", sync);
  }, []);
  if (!onWindows()) return null;
  const button =
    "grid h-8 w-[46px] place-items-center text-[10px] text-muted-foreground [font-family:'Segoe_Fluent_Icons','Segoe_MDL2_Assets'] hover:text-foreground";
  return (
    <div className="fixed right-0 top-0 z-50 flex">
      <button
        aria-label="Minimize"
        title="Minimize"
        onClick={() => void currentWindow()?.minimize()}
        className={`${button} hover:bg-foreground/10`}
      >
        {glyphs.minimize}
      </button>
      <button
        aria-label={maximized ? "Restore" : "Maximize"}
        title={maximized ? "Restore" : "Maximize"}
        onClick={() => void currentWindow()?.toggleMaximize()}
        className={`${button} hover:bg-foreground/10`}
      >
        {maximized ? glyphs.restore : glyphs.maximize}
      </button>
      <button
        aria-label="Close"
        title="Close"
        onClick={() => void currentWindow()?.close()}
        className={`${button} hover:bg-[#c42b1c] hover:text-white`}
      >
        {glyphs.close}
      </button>
    </div>
  );
}
