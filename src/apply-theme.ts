import {
  isTheme,
  resolveTheme,
  themeType,
  themeVariants,
  type ThemeName,
} from "./themes.js";

// `data-theme` always holds a concrete palette name. A "match system" setting
// is resolved here and re-resolved when the operating system flips. Dark
// palettes also put .dark on <html>, which switches the house tokens.
const query = "(prefers-color-scheme: light)";
let current: ThemeName = "default";
let watching = false;

function show() {
  const light = window.matchMedia(query).matches;
  const theme = resolveTheme(current, light);
  const root = document.documentElement;
  root.classList.toggle("dark", themeType(theme) === "dark");
  root.dataset.theme = theme;
}

// Settings from an older or partial server reply may lack a valid theme; show Default then.
export function applyTheme(value: ThemeName | undefined) {
  const theme = isTheme(value) ? value : "default";
  current = theme;
  show();
  const follows = themeVariants(theme).light !== themeVariants(theme).dark;
  if (follows && !watching) {
    watching = true;
    window.matchMedia(query).addEventListener("change", show);
  } else if (!follows && watching) {
    watching = false;
    window.matchMedia(query).removeEventListener("change", show);
  }
}
