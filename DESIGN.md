---
version: alpha
name: Papers Helper
description: Design system for a local academic research tool. Light theme, pastel palette, clean editorial aesthetic.
colors:
  background: "#fefae0"
  surface: "#faedcd"
  border: "#2c2416"
  accent: "#ccd5ae"
  emphasis: "#2c2416"
  emphasis-2: "#d4a373"
  text: "#2c2416"
  text-muted: "#7a6e5f"
typography:
  heading-xl:
    fontFamily: Stack Sans Text
    fontSize: 2rem
    fontWeight: 700
    lineHeight: 1.2
    letterSpacing: -0.02em
  heading-lg:
    fontFamily: Stack Sans Text
    fontSize: 1.5rem
    fontWeight: 700
    lineHeight: 1.3
  heading-md:
    fontFamily: Stack Sans Text
    fontSize: 1.125rem
    fontWeight: 700
    lineHeight: 1.4
  body:
    fontFamily: Stack Sans Text
    fontSize: 1rem
    fontWeight: 400
    lineHeight: 1.65
  body-sm:
    fontFamily: Stack Sans Text
    fontSize: 0.875rem
    fontWeight: 400
    lineHeight: 1.5
  label:
    fontFamily: Stack Sans Text
    fontSize: 0.75rem
    fontWeight: 400
    lineHeight: 1.4
    letterSpacing: 0.04em
rounded:
  sm: 3px
  md: 6px
  lg: 10px
spacing:
  xs: 4px
  sm: 8px
  md: 16px
  lg: 24px
  xl: 40px
  2xl: 64px
components:
  button-primary:
    backgroundColor: "{colors.emphasis}"
    textColor: "{colors.background}"
    typography: "{typography.label}"
    rounded: "{rounded.sm}"
    padding: "10px 20px"
  button-ghost:
    backgroundColor: "transparent"
    textColor: "{colors.text}"
    typography: "{typography.label}"
    rounded: "{rounded.sm}"
    padding: "10px 20px"
  card:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
    rounded: "{rounded.md}"
    padding: "{spacing.md}"
  input:
    backgroundColor: "{colors.background}"
    textColor: "{colors.text}"
    rounded: "{rounded.sm}"
    padding: "10px 14px"
  tag:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.text}"
    typography: "{typography.label}"
    rounded: "{rounded.sm}"
    padding: "3px 10px"
  sidebar:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
  nav-item-active:
    backgroundColor: "{colors.emphasis}"
    textColor: "{colors.background}"
    rounded: "{rounded.sm}"
---

## Overview

Papers Helper is a local tool for academic writing — managing PDFs, citations, authors, and themes across research projects. The interface is built for long reading sessions and sustained focus: nothing competes with the content.

The aesthetic is editorial and unobtrusive. Warm parchment tones reference paper and print without being nostalgic. Structure comes from whitespace and borders, not shadows or depth effects.

## Colors

The palette draws from dried botanicals and aged paper — five tones that shift from neutral cream to warm bronze.

- **Background (#fefae0 — Cornsilk):** The page ground. Used for the outermost surface and reading areas. Warm, never stark.
- **Surface (#faedcd — Papaya Whip):** Cards, panels, sidebars. Slightly denser than the background, creates quiet layering without shadows.
- **Border (#e9edc9 — Beige):** All borders and dividers. 1px solid only. Thin and unobtrusive.
- **Accent (#ccd5ae — Tea Green):** Tag backgrounds, progress indicators. The only cool-leaning tone — provides contrast without asserting itself.
- **Emphasis (#d4a373 — Light Bronze):** Active states, selected items, primary actions, links, and heading highlights. The warmest and most saturated tone; used sparingly.
- **Text (#2c2416):** Body text and headings. A deep warm brown derived from the palette spirit — avoids pure black.
- **Text Muted (#7a6e5f):** Secondary labels, metadata, captions. Recedes naturally on both background and surface tones.

Never use gradients. Never mix more than two colors in a single component.

## Typography

A single typeface throughout: **Stack Sans Text** (Google Fonts), loaded at weights 200–700. Only two weights are in use:

- **400** — All body copy, labels, metadata, UI text.
- **700** — All headings, section titles, project names.

```
@import url('https://fonts.googleapis.com/css2?family=Stack+Sans+Text:wght@200..700&display=swap');
```

Headings scale from `heading-md` (inline section titles) up to `heading-xl` (project titles and primary page headers). Tighten letter-spacing at `heading-xl` only. Body copy uses generous line-height (1.65) for extended reading.

No italic. No all-caps except `label` tokens where letter-spacing compensates.

## Layout & Spacing

Layout is a two-column shell: a narrow fixed sidebar (240px) and a flexible main content area. No horizontal scroll. No full-bleed sections.

The spacing scale is base-4. Use only defined steps — do not invent intermediate values.

| Token | Value | Use |
|-------|-------|-----|
| xs    | 4px   | Icon gap, inline badge padding |
| sm    | 8px   | List item gap, compact padding |
| md    | 16px  | Card padding, section gap |
| lg    | 24px  | Panel padding, between-card gap |
| xl    | 40px  | Section vertical rhythm |
| 2xl   | 64px  | Page-level top/bottom margins |

Content max-width: 760px for reading areas. No fluid type.

## Elevation & Depth

There are no shadows. Depth is communicated solely through:

1. **Background vs. surface color** — cards sit on the page ground.
2. **1px solid border** in `{colors.border}` — defines component edges.
3. **Whitespace** — separation between elements implies grouping.

Never use `box-shadow`. Never use backdrop blur or blur effects.

## Shapes

All corners use the defined radius scale. Components are slightly rounded, not pill-shaped.

| Token | Value | Applied to |
|-------|-------|------------|
| sm    | 3px   | Buttons, inputs, tags, badges |
| md    | 6px   | Cards, dropdowns, tooltips |
| lg    | 10px  | Modals, large panels |

No fully circular elements except avatar initials (48px circle).

## Components

### Button

Two variants only. No filled secondary, no icon-only variants at this stage.

**Primary** — `{colors.emphasis}` background, `{colors.background}` text. Used for one action per view: upload PDF, create project, save.

**Ghost** — Transparent background, `{colors.text}` text, `{colors.border}` border. Used for cancel, secondary actions, navigation triggers.

Both share identical padding and radius. State: hover darkens emphasis by 10% (multiply blend), no transition longer than 150ms.

### Card

Used for projects, papers, authors, and citation results. `{colors.surface}` background, `{colors.border}` border at `1px solid`, `{rounded.md}` radius. Padding `{spacing.md}` on all sides.

Cards never nest. Cards never have shadows. Active/selected card replaces border color with `{colors.emphasis}`.

### Input

Text input and search field. `{colors.background}` fill to recede against surface-colored panels. `{colors.border}` border. Focus state: border switches to `{colors.emphasis}`. No inner glow, no outline beyond the border.

Placeholder text uses `{colors.text-muted}`.

### Tag

Compact label for themes, keywords, and author affiliations. `{colors.accent}` fill, `{rounded.sm}`, `{typography.label}`. Horizontally scrollable tag row when overflowing — never wraps to a second line in compact views.

### Sidebar Navigation

`{colors.surface}` background, full viewport height. Items are `{typography.body}` weight 400, spaced at `{spacing.sm}`. Active item: `{colors.emphasis}` background fill at `{rounded.sm}`, `{colors.background}` text, weight remains 400 — no bold on active state.

Project switcher sits at the top. Settings link at the bottom.

## Do's and Don'ts

**Do:**
- Use whitespace to separate concerns. Prefer more space over more visual elements.
- Use `{colors.emphasis}` only for the single most important interactive element per view.
- Keep borders at 1px solid `{colors.border}`. Never thicker, never dashed.
- Let content typography (PDF text, quotes, citations) breathe — keep surrounding UI minimal.
- Use Fontawesome icons for common actions (delete, edit, download) but only when the meaning is universally clear. Otherwise, use a button with text.

**Don't:**
- Use gradients anywhere.
- Introduce a new color not in the palette without revisiting this document.
- Use font weights other than 400 and 700.
- Add shadows, glows, or blur effects.
- Use emojis in the interface.
- Put more than one primary button in the same view.
- Never put text links in the interface. Always use a button for interactive elements.
- When a button can be represented by an icon (e.g. delete, edit), use an icon centered and NO text. Icon color is `{colors.text}`. I.e. the delete button is a trash can icon in `{colors.text}` with no label, not a button with "Supprimer" text.
