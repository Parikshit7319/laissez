# Laissez design system, light theme

The site, the sandbox app, the guided demo and the investor portal share one visual language: paper, ink, one deep green, a thin brass rule. Calm, high contrast, composed. Nothing on the page should read as decoration.

## Palette tokens

Defined once on `:root` in `src/styles/global.css`. Every other stylesheet reads them.

| Token | Value | Use |
| --- | --- | --- |
| `--paper` | `#F7F5F0` | Page background |
| `--paper-2` | `#EFECE5` | Sunk surfaces, alternating bands, table hover |
| `--white` | `#FFFFFF` | Raised surfaces: cards, inputs, console |
| `--ink` | `#14161A` | Body and heading text (16.5:1 on paper) |
| `--ink-2` | `#4A4F57` | Secondary text (7.6:1 on paper) |
| `--ink-3` | `#5F646C` | Tertiary text, captions (5.3:1 on paper, 4.9:1 on paper-2) |
| `--line` | `#DDD9D0` | Hairlines, borders |
| `--line-2` | `#C6C1B6` | Stronger borders, input borders |
| `--green` | `#0F5C4A` | The accent. Primary buttons, links, admitted and settled states, focus rings |
| `--green-2` | `#0B4A3B` | Hover on green |
| `--green-wash` | `rgba(15, 92, 74, 0.08)` | Tint behind admitted states |
| `--brass` | `#B8975A` | Thin detail only: rules, small marks, the credential band. Never text, never a fill behind text |
| `--coral` | `#B3261E` | Refused and failed states only (6.6:1 on paper) |
| `--coral-wash` | `rgba(179, 38, 30, 0.08)` | Tint behind refused states |
| `--amber` | `#8A5A00` | Pending, partial, lapsed |
| `--violet` | `#4F3D8C` | Informational chips in the app (guided tour, binding tags) |

The app, demo and portal keep their own aliases (`--paper-raised`, `--rule`, `--red`, `--brand`) pointing at the same values so no component needs to change.

Dark mode is not offered. `color-scheme: light` everywhere.

## Type scale

Fraunces for display (weight 400, optical size auto, `SOFT 0, WONK 0`), Geist for UI and body, Geist Mono for code. Sizes are tighter than before so pages feel composed rather than loud.

| Role | Size | Line height | Tracking |
| --- | --- | --- | --- |
| Display (home hero only) | `clamp(2.4rem, 1.5rem + 3.2vw, 4.1rem)` | 1.02 | -0.022em |
| h1 | `clamp(2rem, 1.4rem + 2.2vw, 3.2rem)` | 1.06 | -0.02em |
| h2 | `clamp(1.6rem, 1.25rem + 1.3vw, 2.3rem)` | 1.12 | -0.015em |
| h3 | `clamp(1.2rem, 1.1rem + 0.4vw, 1.45rem)` | 1.25 | -0.01em |
| h4 (UI) | 1rem, Geist 560 | 1.3 | 0 |
| Lede | `clamp(1.05rem, 1rem + 0.25vw, 1.2rem)` | 1.6 | 0 |
| Body | 1rem (16px) | 1.6 | 0 |
| Small | 0.875rem | 1.55 | 0 |
| Fine | 0.8125rem | 1.5 | 0 |

Body line length is capped at 64ch (`.measure`) and the lede at 42rem. No all-caps labels. No eyebrows. A section opens with its heading.

## Layout rules

- Content width `76rem`, gutter `clamp(1rem, 4vw, 2.5rem)`. At 390px the gutter is exactly 16px. Nothing may scroll horizontally; wide tables scroll inside `.table-wrap`.
- Vertical rhythm: bands of `clamp(3.5rem, 7vw, 6.5rem)`. Alternation is paper and `--paper-2`, separated by a hairline, never a gradient wash.
- One primary call to action per marketing page: a green button, "Try the sandbox", linking to `/laissez/app/`. Everything else is a text link or a quiet outline button.
- Header: brand, six links (Product, Solutions, Developers, Trust, Pricing, Company), one green button. Collapses to a full-screen sheet under 960px.
- Footer: four link columns, a status line with live Status and Live metrics links, legal links (Privacy, Terms), the pre-launch disclaimer.
- Cards are the exception, not the grid. Use them for things that are literally cards (the credential, a decision receipt, a pricing tier). Lists of features use a hairline above each item instead.
- Numbered markers appear only where there is a real sequence (settlement steps, quickstart).
- Focus ring: `2px solid var(--green)` with `3px` offset, on every interactive element. Visible on paper and on white.
- Motion: one short entrance on the home hero, the map corridors, the credential stamp. Everything is wrapped in `prefers-reduced-motion: reduce`, which turns animation off rather than slowing it.

## App shell

- Sidebar on paper, 15.5rem wide, with a search box at the top (`/` focuses it; typing filters pages), collapsible groups (state kept in `localStorage`), the workspace footer, and a persistent Help link to the guided demo.
- Shortcuts: `/` search, `g` then `o` overview, `g` then `n` new order, `?` shows the list.
- Overview shows a first-run checklist card (open a sandbox, place an order, settle, propose a policy change, invite or switch teammate). Progress is read from the API where it can be, and from local events otherwise; the card dismisses itself when every step is done and can be hidden.
- Primary button in the app is green. Danger is coral. Ghost is green text.

## Portal and consent

Same palette. The distributor's brand color is used for the header rule and buttons only; text stays ink.
