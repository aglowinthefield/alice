---
version: alpha
name: Alice
description: A dense, quiet board for running coding agents across repos, used all day on desktop, web and iOS.
colors:
  primary: "#151417"
  light-paper: "#F8F8F7"
  light-raised: "#FFFFFF"
  light-ink: "#151417"
  light-ink-muted: "#5D5966"
  light-ink-faint: "#8E8A96"
  light-hairline: "#C4C1C9"
  light-pen: "#3049B8"
  light-pen-wash: "#EBEDF6"
  light-status-neutral: "#626B72"
  light-status-attention: "#554B36"
  light-status-info: "#45627C"
  light-status-success: "#38684A"
  light-status-danger: "#9D3038"
  light-status-warning: "#926621"
  light-status-other: "#5E5675"
  light-code: "#efeef0"
  light-selection: "#c8d6e0"
  light-diff-add: "#e1f2e6"
  light-diff-add-text: "#184a30"
  light-diff-remove: "#fae6e7"
  light-diff-remove-text: "#882b34"
  dark-paper: "#121214"
  dark-raised: "#1B1B1F"
  dark-ink: "#EEEDF0"
  dark-ink-muted: "#A6A3B0"
  dark-ink-faint: "#77737F"
  dark-hairline: "#3E3D44"
  dark-pen: "#8C9BEA"
  dark-pen-wash: "#1E2030"
  dark-status-neutral: "#8B919A"
  dark-status-attention: "#D4CCB4"
  dark-status-info: "#B4BCC4"
  dark-status-success: "#B8C4B8"
  dark-status-danger: "#CDACAC"
  dark-status-warning: "#C6AD89"
  dark-status-other: "#ABA5BD"
  dark-code: "#1b1b1f"
  dark-selection: "#676d77"
  dark-diff-add: "#193529"
  dark-diff-add-text: "#b6e5c5"
  dark-diff-remove: "#3b2528"
  dark-diff-remove-text: "#f0b5b5"
typography:
  display:
    fontFamily: Rampart One, ui-sans-serif, system-ui, sans-serif
    fontSize: 76px
    fontWeight: 400
    lineHeight: 1
    letterSpacing: -0.02em
  body:
    fontFamily: Inter, ui-sans-serif, system-ui, sans-serif
    fontSize: 14px
    fontWeight: 400
    lineHeight: 1.45
  body-small:
    fontFamily: Inter, ui-sans-serif, system-ui, sans-serif
    fontSize: 12px
    fontWeight: 400
    lineHeight: 1.4
  sidebar:
    fontFamily: Inter, ui-sans-serif, system-ui, sans-serif
    fontSize: 13px
    fontWeight: 400
    lineHeight: 1.35
  small-print:
    fontFamily: ui-monospace, SFMono-Regular, Menlo, monospace
    fontSize: 11px
    fontWeight: 400
    lineHeight: 1.3
    letterSpacing: 0.1em
  pen:
    fontFamily: Hachi Maru Pop, cursive
    fontSize: 15px
    fontWeight: 400
    lineHeight: 1.5
  code:
    fontFamily: ui-monospace, SFMono-Regular, Menlo, monospace
    fontSize: 0.88em
    fontWeight: 400
    lineHeight: 1.45
rounded:
  house: 3px
  sm: 0.165rem
  md: 0.225rem
  lg: 0.3rem
  xl: 0.405rem
  full: 9999px
spacing:
  unit: 4px
  compact-unit: 3.2px
  cozy-unit: 4.48px
components:
  card:
    backgroundColor: "{colors.light-raised}"
    textColor: "{colors.light-ink}"
    rounded: "{rounded.house}"
  sidebar-item:
    backgroundColor: "{colors.light-paper}"
    textColor: "{colors.light-ink-muted}"
    typography: "{typography.sidebar}"
  button-main:
    backgroundColor: "{colors.light-ink}"
    textColor: "{colors.light-paper}"
    rounded: "{rounded.house}"
  bubble:
    backgroundColor: "{colors.light-paper}"
    textColor: "{colors.light-pen}"
    typography: "{typography.pen}"
---

# Alice design

Alice follows the `house-style` skill and takes its parts from the [@house registry](https://aglowinthefield.github.io/house/). This file records Alice's values and the places it goes beyond or departs from that skill. The values live in `src/styles/house.css` (vendored), `src/theme-palettes.css` and `src/style.css`; update this file with them.

## Overview

A tool Tom keeps open all day to dispatch, watch and review agent work across repos. It reads like Linear's issue board crossed with a macOS sidebar app, printed in ink on paper: compact rows, quiet neutrals, colour only for card status and diffs, and a blue pen for Alice's own voice.

## The registry

`components.json` registers `@house`, and `npx shadcn add @house/<item> --overwrite` copies the parts into `src/components/ui` and `src/styles/house.css`. Never edit a copied file: change it in [aglowinthefield/house](https://github.com/aglowinthefield/house) and add it again, or wrap it in Alice. `src/dialog.tsx` is such a wrapper; it gives the house dialog Alice's form width, a scroll past 90vh and a close button. `chart.tsx` is the one shadcn part left.

## Colors

Default is the house palette: paper and ink in light, the same print inverted in dark. The primary colour is ink. Pen marks focus rings and Alice's own marks; status tones mark lane icons, card stripes and badges, with the label beside them in ink. Code, diff and syntax colours have no house role, so Alice keeps its own (syntax after GitHub's).

Card statuses map onto the house tones: Triage and Done neutral, Ready attention, Running info, Review success, Failed danger, Interrupted warning, Archived other. `statusTone` in `src/model.ts` and the `--status-*` variables in `src/style.css` hold the same map.

Users can switch palettes in Settings: Default, Compline, Hearth, Gruvbox and Nord, each with a light pair where one exists. Every other palette overrides the house colour roles in `src/theme-palettes.css`, registered in `src/themes.ts`. Its pen is its old focus-ring colour, or a stronger hue of its own where that read under 5.5:1, since pen also sets text. Dark palettes put `.dark` on `<html>`.

## Typography

Inter for the interface, system monospace for code, IDs and paths. Each page has at most one display title in Rampart One at 76px. Dates, tallies and section heads under it are small print: 11px tracked monospace capitals in the muted ink. Alice speaks in Hachi Maru Pop, in pen, and never sets labels, buttons or data in it. Sidebar sizes are fixed (13px items, 11px metadata) and ignore the density setting; everything else scales with it.

## Layout

Spacing scales on a 4px unit. The density setting multiplies the unit (compact 0.8, cozy 1.12) and the text scale (compact 0.93, cozy 1.05) through `--density-space` and `--density-text`.

## Elevation & Depth

Everything sits flat on the paper; the sidebar shares the page's paper, split by a rule. Floating layers (dialogs, menus, tooltips, notices) get a hard ink offset shadow instead of a blur.

## Shapes

House parts use `--radius-house`, 3px. Alice's older surfaces keep `--radius: 0.3rem`, with Tailwind's `rounded-sm` to `rounded-xl` derived from it at 0.55, 0.75, 1 and 1.35 times.

## Components

Built on the house parts (Radix underneath) with Lucide icons. Buttons come in four weights: main (solid ink, one per view), row (outlined with a 2px hard shadow, repeated on every row), secondary (outlined) and text (underlined). Dialogs fade in over 160 ms and pop over 180 ms, and close without an exit animation; view transitions are off.

Today follows the hub's reference build: the date in small print over the display title, the tallies, the capture field, then ruled small-print section heads over dense rows. Alice's line drawing stands at the right, cropped by the page edge, and says one thing in a pen bubble: which stale card has waited longest. The pen circles that card's age and stars cards twice past their board's stale threshold. Alice and her bubble only show once the page is wide enough that they cover nothing.

The sidebar opens with Alice's face, zoomed so her expression reads at 40px, beside "Alice" over the server's host name and version. There is no footer. Its entries are links; the current one carries the house pen circle instead of a fill. A repository's pages (Kanban, Pull requests, Visualizer, Chat) sit 16px in, on a 1px rail in the hairline colour, and the list slides open and shut over 180 ms.

The Cmd+K (Ctrl+K) command palette is a dialog with the same motion, placed high on the screen like Spotlight. Its rows are 32px, show the command's own shortcut at the right, and cards appear only once something is typed. A command that needs a card acts on the focused or open card, or asks which card.

The Windows desktop app has no native frame. A 32px title bar row in the sidebar colour holds the caption buttons, drawn with Segoe Fluent Icons glyphs at Windows' own 46 by 32px size. Close turns Windows' red, `#c42b1c`, on hover, the one colour outside the palette.

## Do's and Don'ts

- Do keep live progress motion: the orbit on a card whose agent is working, the slow breathe on one waiting, the pulse on cards that move along during a drag. These are Alice's spinner equivalents and stop under reduced motion.
- Don't add new looping motion beyond progress indicators.
- Do keep the sidebar at its fixed sizes when changing density.
- Don't use type below 11px. Small print and sidebar metadata sit at that floor.
