---
version: alpha
name: Bakery
description: A dense, quiet board for running coding agents across repos, used all day on desktop, web and iOS.
colors:
  primary: "#d4ccb4"
  dark-background: "#1a1d21"
  dark-sidebar: "#171a1e"
  dark-surface: "#22262b"
  dark-popover: "#282c34"
  dark-border: "#3d424a"
  dark-text: "#f0efeb"
  dark-text-muted: "#8b919a"
  dark-primary: "#d4ccb4"
  dark-on-primary: "#1a1d21"
  dark-ring: "#b4bcc4"
  dark-selection: "#676d77"
  dark-danger: "#cdacac"
  dark-status-triage: "#8b919a"
  dark-status-ready: "#d4ccb4"
  dark-status-running: "#b4bcc4"
  dark-status-review: "#b8c4b8"
  dark-status-failed: "#cdacac"
  dark-status-interrupted: "#c6ad89"
  dark-status-done: "#9aa59d"
  dark-status-archived: "#aba5bd"
  dark-diff-add: "#193529"
  dark-diff-add-text: "#b6e5c5"
  dark-diff-remove: "#3b2528"
  dark-diff-remove-text: "#f0b5b5"
  light-background: "#f5f3ee"
  light-sidebar: "#eeebe4"
  light-surface: "#ffffff"
  light-popover: "#ffffff"
  light-border: "#ccc8be"
  light-text: "#242a30"
  light-text-muted: "#555e66"
  light-primary: "#554b36"
  light-on-primary: "#ffffff"
  light-ring: "#4b6277"
  light-selection: "#c8d6e0"
  light-danger: "#9d3038"
  light-status-triage: "#626b72"
  light-status-ready: "#554b36"
  light-status-running: "#45627c"
  light-status-review: "#38684a"
  light-status-failed: "#9d3038"
  light-status-interrupted: "#926621"
  light-status-done: "#626b72"
  light-status-archived: "#5e5675"
  light-diff-add: "#e1f2e6"
  light-diff-add-text: "#184a30"
  light-diff-remove: "#fae6e7"
  light-diff-remove-text: "#882b34"
typography:
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
  sidebar-meta:
    fontFamily: Inter, ui-sans-serif, system-ui, sans-serif
    fontSize: 11px
    fontWeight: 400
    lineHeight: 1.3
  heading:
    fontFamily: Inter, ui-sans-serif, system-ui, sans-serif
    fontSize: 18px
    fontWeight: 600
    lineHeight: 1.3
  code:
    fontFamily: ui-monospace, SFMono-Regular, Menlo, monospace
    fontSize: 0.88em
    fontWeight: 400
    lineHeight: 1.45
rounded:
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
    backgroundColor: "{colors.dark-surface}"
    textColor: "{colors.dark-text}"
    rounded: "{rounded.lg}"
  sidebar-item:
    backgroundColor: "{colors.dark-sidebar}"
    textColor: "{colors.dark-text}"
    typography: "{typography.sidebar}"
  button-primary:
    backgroundColor: "{colors.dark-primary}"
    textColor: "{colors.dark-on-primary}"
    rounded: "{rounded.md}"
---

# Bakery design

Bakery follows the `house-style` skill. This file records Bakery's values and the places it goes beyond or departs from that skill. Source of truth for the values is `src/style.css`; update both together.

## Overview

A tool Tom keeps open all day to dispatch, watch and review agent work across repos. It reads like Linear's issue board crossed with a macOS sidebar app: compact rows, quiet neutrals, colour only for card status and diffs.

## Colors

The default dark palette is built from Compline (Joshua Blais); the light palette is a warm paper version with the same roles. Status colours mark the lane icon, the card's left stripe and drop targets; the label beside them stays in text colours. Syntax colours in code views follow GitHub's.

Users can switch palettes in Settings: Default, Compline, Hearth, Gruvbox and Nord, each with a light pair where one exists. Theme blocks live in `src/style.css` and `src/theme-palettes.css`, registered in `src/themes.ts`.

## Typography

Inter throughout, system monospace for code, IDs and paths. Sidebar sizes are fixed (13px items, 11px metadata and headings) and ignore the density setting; everything else scales with it.

## Layout

Spacing scales on a 4px unit. The density setting multiplies the unit (compact 0.8, cozy 1.12) and the text scale (compact 0.93, cozy 1.05) through `--density-space` and `--density-text`.

## Elevation & Depth

Depth comes from surface steps: sidebar below background, cards and popovers above it. Shadows belong to floating layers: dialogs, menus, tooltips and notices.

## Shapes

One radius, `--radius: 0.3rem`, with Tailwind's `rounded-sm` to `rounded-xl` derived from it at 0.55, 0.75, 1 and 1.35 times.

## Components

Built on Radix primitives and shadcn's new-york style with Lucide icons. Dialogs fade in over 160 ms and pop with a spring-like curve over 180 ms; view transitions are off.

## Do's and Don'ts

- Do keep live progress motion: the orbit on a card whose agent is working, the slow breathe on one waiting, the pulse on cards that move along during a drag. These are Bakery's spinner equivalents and stop under reduced motion.
- Don't add new looping motion beyond progress indicators.
- Do keep the sidebar at its fixed sizes when changing density.
- Don't use type below 11px. Existing 10px labels are being moved up.
