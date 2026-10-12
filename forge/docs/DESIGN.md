# FORGE design language: "Field Ledger"

> This file implements and extends PROMPT.md §6.4, which states what the owner wants: clean, monotone, flat,
> with earth tones only for highlights. This file sets *how* FORGE meets that brief so it looks like FORGE
> and nothing else. When this file and an older style in the CSS disagree, this file wins.
> Reviewers cite it as `DESIGN §n`.

---

## 0. The idea in one paragraph

FORGE is an **athlete's training ledger built like a Braun instrument**. Each screen is a page in a
well-kept logbook. Hairline rules divide it, and sections carry numbers (`01 — READINESS`). Figures sit in
ruled columns, and units are stamped in small monospace. The pages are paper and graphite with no
decoration. One earth-tone "key" (oxide/rust, which plays the role of the yellow `=` key on Braun's
ET66) marks the single thing you should press or look at. The workout player is the instrument: a
60-tick bezel dial, an inverted rest plate and a set ledger you log with one tap. The look is
**ruled, numbered and stamped, not boxed, rounded or glowing**.

### Why this concept (research summary)

| Reference | What we take | What we leave |
|---|---|---|
| **Dieter Rams / Braun (ET66, AB clocks, T3)** | Colour only for function: the ET66's single yellow `=` key means one accent per region. Tick-mark dials. Square forms with small radii. "As little design as possible." | Skeuomorphic plastic |
| **Teenage Engineering / Nothing** | Small uppercase mono labels, hairline grids, square corners, spec-sheet density, no persistent colour. Nothing's 2024–25 OS move (dot-matrix used *sparingly*, a clean grotesk for UI) shows the rule: one distinctive voice used rarely. | Dot-matrix gimmicks, all-black brutalism, mono for body text |
| **Swiss / International style** | Typography does the hierarchy, not boxes. Asymmetric grid, ranged-left text, small grey uppercase section titles, no radius on structural elements | Red/black poster palette |
| **Tracksmith, Satisfy, Norda (running editorial)** | The kit room and the logbook: a quiet human voice ("Heavy day — own the clean."), warm paper neutrals, editorial restraint, heritage training-log feel (Tracksmith's ledger-style training journals) | Lifestyle photography (we have no photos) |
| **Oura (Instrument redesign) and its warm site palette** | Sandstone/cream canvas instead of pure white, near-black ink, one accent colour, a refined type grid and simpler components | Serif-italic flourish headings |
| **Gentler Streak (ADA 2024), Runna, Whoop, Bevel** | Data comes first with a readiness score up top. Calm, encouraging copy instead of nagging. Big numerals. Few tabs. | Rings (Apple's IP and every clone's crutch), gradients, glow charts |
| **Linear / Things** | Craft lives in alignment, spacing rhythm and type metrics. Every pixel sits on a grid. | Purple, blur, glass |

### What we are avoiding (the "AI-generated" look)

Generic rounded cards stacked down the page; 14–24 px radii on everything; emoji; a decorative icon tile in
every row; purple/orange gradients and glows; centred hero blocks; Inter at weight 700 everywhere; pill
overload; progress rings for every metric; "stat card" grids with identical tiles; shadows used to separate
things. FORGE separates content with **rules and type**, shows progress with **ticks**, and uses colour for
**meaning only**.

---

## 1. Type system

### Families (self-hosted, `forge/fonts/`, all SIL OFL 1.1)

| Role | Face | File | Size | Why |
|---|---|---|---|---|
| UI, text, headings, **and figures** | **Archivo** variable (Omnibus-Type), axes `wght 100–900`, `wdth 62–125` | `archivo-var.woff2` | 90 KB | One file gives a grotesk with a slight athletic, 19th-century-grotesque flavour at `wdth 100`. At `wdth 72` it becomes a **condensed numeral face** with tabular figures (`tnum`) for timers and data. At `wdth 125` it becomes an **expanded wordmark**. Not Inter, not system. |
| Labels, indices, units, metadata | **IBM Plex Mono** 400 / 500 | `plex-mono-400.woff2`, `plex-mono-500.woff2` | 14.7 KB + 14.9 KB | Plex Mono has the engineered, stamped quality of an instrument label, and it stays legible at 10–12 px. |

Licences are in `forge/fonts/OFL-Archivo.txt` and `forge/fonts/OFL-IBMPlexMono.txt`. All three files use
the Latin subset (Basic Latin + Latin-1), about 120 KB in total. Add them to the `sw.js` precache.

```css
@font-face { font-family: "Archivo"; src: url("../fonts/archivo-var.woff2") format("woff2");
  font-weight: 100 900; font-stretch: 62% 125%; font-display: swap; }
@font-face { font-family: "Plex Mono"; src: url("../fonts/plex-mono-400.woff2") format("woff2"); font-weight: 400; font-display: swap; }
@font-face { font-family: "Plex Mono"; src: url("../fonts/plex-mono-500.woff2") format("woff2"); font-weight: 500; font-display: swap; }
--font: "Archivo", ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
--font-mono: "Plex Mono", ui-monospace, "SF Mono", Menlo, monospace;
```
Preload `archivo-var.woff2` in `index.html` (`<link rel="preload" as="font" type="font/woff2" crossorigin>`).

### Scale (px). Weights stay at 400/500/600; 700 only for the wordmark.

| Token | Use | Spec |
|---|---|---|
| `--t-label` | section titles, column heads, eyebrows | Plex Mono 500 · 11 · `letter-spacing .06em` · UPPERCASE · `--muted` (section title in `--text`) |
| `--t-data` | metadata strings: "200 g · P20 C8 F0", "last · 2×16 kg · 6 6 6 6 5" | Plex Mono 400 · 12 · natural case · `--muted` |
| `--t-unit` | units after figures: `kg` `g` `L` `/180 g` | Plex Mono 400 · 11.5 · **lowercase**, no tracking · `--muted` · 3 px left gap |
| body | text | Archivo 400 · 15/1.45 |
| small | secondary text | Archivo 400 · 13 · `--text-2` |
| h3 | exercise / item titles | Archivo 600 · 17–20 · `-0.01em` |
| h2 | session / block titles | Archivo 600 · 22–25 · `-0.018em` |
| h1 | page titles, greeting | Archivo 600 · 32–34 · `-0.025em` · line-height 1.05 |
| `.fig` | **all numerals that matter** | Archivo `font-stretch: 72%` · 600 · `tabular-nums` · line-height .92 · sizes 22 / 26 / 30 / 56 / 72 / 84 / 118 |
| wordmark | `FORGE` | Archivo `font-stretch: 125%` · 700 · 13 · `letter-spacing .14em` |

Rules: hierarchy comes from size, weight and **width** (condensed figures against a normal-width text
face). Colour does not carry hierarchy. Mono is for labels, units and metadata, never for sentences or
titles. Sentence copy is sentence case. Uppercase belongs only to mono labels.

---

## 2. Grid and spacing

- 390 pt reference: **16 px side gutter**, content width 358. Desktop: max 640, gutter 24.
- 4 px base unit. Spacing tokens: `--s1 4 · --s2 8 · --s3 12 · --s4 16 · --s5 20 · --s6 28 · --s7 40`.
- Section rhythm: `28px` above a section rule, `12px` below. Ledger rows: `12px` vertical padding, so
  rows are at least 44 px with a 15 px line.
- Columns align to the ledger. Indices sit in a fixed 18–30 px column, figures are right-aligned or in
  fixed columns, and units hang after figures. Things line up vertically across sections.
- Asymmetry is allowed and encouraged. On Today the greeting fills a wide left column and the countdown
  sits in a narrow right column behind a vertical hairline.

---

## 3. Colour — "paper & graphite with one oxide key"

The token names stay the same (views depend on them). Only the values and a few additions change.
All text pairs listed below were checked with the WCAG formula: every one is at least 4.5:1 on `--bg`,
and every one except `--muted`/`--accent` on `--surface-2` is also at least 4.5:1 there.

| Token | Dark | Light | Role |
|---|---|---|---|
| `--bg` | `#13120F` | `#F1EDE4` | page (graphite / unbleached paper) |
| `--bg-2` | `#181713` | `#ECE7DD` | sheets |
| `--surface` | `#1A1915` | `#F7F4EE` | rare filled areas (inputs) |
| `--surface-2` | `#211F1A` | `#E8E3D8` | current row, pressed |
| `--surface-3` | `#2B2923` | `#DDD7CA` | done cells, track |
| `--line` | `#2C2A24` | `#D8D1C3` | hairline rule (1 px) |
| `--line-2` | `#4A463E` | `#ADA595` | control borders, strong rule |
| `--rule-ink` *(new)* | `#ECE6DA` | `#1C1A16` | heavy "ink" rule under masthead / above key tables |
| `--text` | `#ECE6DA` (15.1) | `#1C1A16` (14.9) | ink |
| `--text-2` | `#B8B0A2` (8.7) | `#48433B` (8.4) | secondary |
| `--muted` | `#8E877B` (5.3) | `#6B6458` (5.0) | labels, units |
| `--accent` | `#D27449` (5.7) | `#A54B26` (5.0) | **oxide**: the one key (primary action, "now") |
| `--accent-2` | `#DC8358` | `#B5582F` | pressed/hover primary |
| `--accent-ink` | `#14100C` (5.7 on accent) | `#FFFFFF` (5.8) | text on accent |
| `--go` | `#A2AC76` (7.8) | `#59672E` (5.3) | moss: done ✓ |
| `--warn` | `#D0A24E` (8.0) | `#82600F` (5.0) | ochre |
| `--danger` | `#D9654E` (5.3) | `#A23A27` (5.7) | brick |
| `--info` | `#8EA7A1` (7.3) | `#3F625B` (5.8) | lichen (rest phase) |
| `--protein` | `#C98A6E` | `#9A5238` | clay |
| `--carbs` | `#D0A24E` | `#82600F` | ochre |
| `--fat` | `#A2AC76` | `#59672E` | moss |
| `--water` | `#8AA3AB` | `#41626C` | stone-blue |
| `--base` | `#93A57D` | `#566B3E` | sage |
| `--build` | `#D0A24E` | `#82600F` | ochre |
| `--peak` | `#D27449` | `#A54B26` | oxide |
| `--taper` | `#AD967E` | `#73604B` | umber |
| `--recovery` | `#8EA7A1` | `#3F625B` | lichen |
| `--tick-off` *(new)* | `#34312A` | `#D3CCBD` | unfilled tick |
| `--plate` / `--plate-ink` / `--plate-accent` *(new)* | `#DCD5C7` / `#13120F` / `#8E3E1D` | `#1C1A16` / `#F1EDE4` / `#D27449` | inverted instrument plate (rest dock, toast) |
| `--accent-soft` | `color-mix(in srgb, var(--accent) 14%, transparent)` | same | the only translucent tint, for the current week cell and focus halo |

Delete the `--*-soft` tints for go/danger. Tinted backgrounds are a large part of the "AI card" look.
State is shown by **ink, a mark or a rule**, never by a wash of colour.

**Colour budget per screen:** one oxide element per region (the primary button, *or* the "now" tick,
*or* the current set). Macro and phase colours appear **only in small marks**: tick fills, 3 px
underlines and 8 px swatches. They never fill large areas or colour text.
`theme-color` meta: `#13120F` dark / `#F1EDE4` light.

---

## 4. Shape and surface

- **Radius:** `--radius: 3px` for controls (buttons, inputs, segmented controls, the rest plate);
  `0` for structure (sections, rows, ledgers, week cells). Sheets get `--radius-sheet: 10px` on their
  top corners only. Nothing larger anywhere. **No pills, and no `999px`.**
- **No floating cards.** A section is a *ruled region*: a section rule, then content on `--bg`. You may
  use `--surface` for an input or a sheet, but you may not use a bordered rounded box to wrap a section.
  (`.card` survives as a class but turns into a borderless block with a top rule; see §11.)
- Flat. No shadows, gradients, blur, glow or text-shadow (PROMPT §6.4 still applies).
- Two rule weights: hairline `1px var(--line)` between rows; ink `1px var(--rule-ink)` under the masthead
  and above a primary table or exercise.

---

## 5. Signature elements (these make FORGE recognisable)

1. **Masthead.** Every tab page opens with the expanded `FORGE` wordmark at left and a mono dateline at right
   (`FRI 16 OCT · WK 06/12`) over an ink rule. The page reads like a ledger entry header.
2. **Numbered section rule.** `01  READINESS ───────────── EDIT`: a mono index in `--muted`, the title in
   mono `--text`, a hairline that fills the row, and optional right meta (mono, or an oxide text action).
   This replaces `section-head` *and* card eyebrows.
3. **Tick meters instead of rings and rounded bars.** A row of 2 px ticks with `justify-content:
   space-between`. Filled ticks are `--text` (or the macro colour), empty ticks are `--tick-off`, and
   the "now" tick is oxide. Variant `.ruler`: every 5th tick is full height and the rest are 62 %, like
   a measuring scale with mono scale labels below (`0 · 1,240 · 2,480`). Use them for readiness, kcal,
   macros, daily stats, the rest countdown and the water plan.
4. **Condensed figures + mono units.** `16 kg`, `1,640`, `0:52`. The figure is condensed Archivo, the
   unit is lowercase Plex Mono. Units are never bold and never the same size as the figure.
5. **Phase ribbon.** The plan's weeks are a strip of numbered square cells `01…12`. Each cell carries a
   3 px phase-colour underline (full strength for past weeks, 55 % for future ones), deload weeks have a
   dashed border, and the current week has an oxide border with `--accent-soft` fill. Mono phase names
   sit below and line up with their weeks. It is used on Today, Train, Onboarding (plan reveal) and Progress.
6. **Week cells.** Seven square cells with mono type codes (`STR RUN HYB Z2 EMOM`):
   done = `--surface-3` fill with a moss `✓`; today = 2 px oxide border; planned = hairline border;
   rest = an em dash and no border; missed = a dashed brick border with a brick code.
7. **Set ledger.** Columns `SET · LOAD · REPS · RPE · ✓`. Done rows are dimmed to `--text-2` with a moss check.
   The current row runs full bleed on `--surface-2` with a 3 px oxide bar at the left edge, larger figures,
   −/+ on reps, an `RPE` stamp button and an oxide **log key**. Pending rows are muted and show a 22 px
   hairline box inside a 44 px hit area.
8. **Bell selector.** A segmented row of square cells (`12 16 20 24 28`) in condensed figures with mono
   `kg`. The selected cell is **inverted** (ink fill, paper text) and doubles show `kg×2`.
9. **Instrument timer face.** The ring arc is replaced by a **60-tick bezel**: every 5th tick is long,
   mono `60 15 30 45` sits inside, elapsed ticks are `--tick-off`, remaining ticks are `--text`, and the
   current tick is oxide and thicker. The centre holds the mono phase word (`WORK` oxide / `REST` lichen /
   `GET READY` muted), condensed digits at 96–118 px and a mono sub-line (`MINUTE 07 OF 10`). Below the
   dial a row of minute/round segments shows progress through the block.
10. **Inverted rest plate.** Rest is the one place we invert. The dock is a `--plate` slab at radius 3
    with mono `REST · OF 1:30`, 64 px condensed time, square `−15 +15 Skip` keys and a 45-tick
    countdown. It is impossible to mistake for content.
11. **Block index letters.** Workout blocks are lettered `A B C D E`. The player's progress bar is a row
    of top-ruled segments with the letter at left and `2/4` or `✓` at right.
12. **Voice.** Copy is short, coach-like and specific: "Heavy day — own the clean." Use it once per
    screen and never as filler.

---

## 6. Iconography

- Keep the inline-SVG system (`ui.js` ICONS) but set the stroke to **1.6** with **square caps and
  mitre joins** (`stroke-linecap: square; stroke-linejoin: miter`) so icons match the ruled,
  engineered look.
- Use icons **only where a word would be worse**: close, back/forward chevrons, play/pause/skip,
  search, barcode, sound, edit, delete. **No icon tiles** (`.qa-ico`, `.tr-qa-ic`, `.tip-ico`,
  `.badge` with an icon, `.done-badge`, `.streak-flame`). In list rows the leading element is a mono
  index or type code (`01`, `STR`), not a pictogram.
- The tab bar is text-only (mono, uppercase, 10.5 px). The active tab gets a 2 px oxide rule on its top
  edge and `--text`. This is distinctive and keeps a 78 px-wide target per tab.
- Trophy and flame icons are retired. A PR is shown as a mono `PR` stamp (`1px solid var(--go)`,
  radius 2, moss text), and the streak is a figure with a mono label.

---

## 7. Motion

Motion is functional and short, and it moves things the way a mechanical instrument would. It never springs.
- Easing `cubic-bezier(.2,.0,.0,1)`; durations 120 ms (press), 180 ms (state), 240 ms (sheet).
- A press shows as an instant `--surface-2` background or an inverted cell. **No `scale()` on press.**
- Ticks fill **step-wise** (one tick at a time, `steps()`), never as a smooth bar.
- The timer bezel advances one tick per second with no tween. The last 3 s turn the time oxide, with no pulse.
- Sheets slide up 240 ms with a scrim fade. Views do not slide or fade between tabs; they cut.
- Completion uses no bouncing checkmark. The finish screen stamps in: the `SESSION COMPLETE` mono label and
  the figures appear in a 2-frame cut (opacity 0 → 1, 120 ms).
- `prefers-reduced-motion` removes everything except the colour change.

---

## 8. Do / Don't

| Do | Don't |
|---|---|
| `01  SESSION ─────── ~48 MIN` ruled header | Rounded card with an eyebrow and a bold title inside |
| `62 g` with a tick meter in clay | A 66 px ring with an icon in the middle |
| `16 kg` (condensed figure + mono unit) | `16kg` bold sans at one size, or `16 KG` shouting |
| One oxide primary per region | Oxide text, oxide icons and an oxide button together |
| `✓` in moss on a stone cell for done | A green-tinted pill reading "Done" |
| Square controls, radius 3 | 14–22 px radii, pills, round FABs |
| Mono `STR` code in the row's lead column | An icon tile in every row |
| One line of coach voice | Motivational filler, emoji, exclamation marks |
| A tabular, right-aligned ledger | Stat-card grids of identical tiles |
| An inverted plate for rest | Glow, blur or a coloured gradient "active" state |
| Hairlines and whitespace to separate | Borders *and* fills *and* gaps all at once |

---

## 9. Per-screen notes

### Today
Masthead → greeting (h1, 34 px, two lines: "Morning,/Max.") with one coach line → right column with
the countdown figure (72 px) and mono `HYROX · CITY` / `DAYS OUT` → **phase ribbon** → `01 READINESS`
(unchecked: five 1–5 rows of square cells, selected = inverted; done: 56 px score figure, band title,
41-tick meter, mono data line) → `02 SESSION` (mono type line, h2 title, **lettered block ledger** with
kind in muted sans and minutes in mono, readiness-scaling note as a 3 px ochre left rule with text, an
oxide `Start session … 48 min →` key, mono text links `SESSION DETAILS` / `SWAP DAY`) → `03 DAILY`
(four-column ledger: TRAIN / KCAL / PROTEIN / WATER, each with a figure, unit and 13-tick meter, which
replace the rings) → a quick-action strip (one bordered row of four mono text keys `+ Food`
`+ 250 ml` `Weigh` `Timer`) → `04 THIS WEEK` (week cells; streak in the section meta) → `05 UP NEXT`
ledger → `06 NOTE` (coach tip as plain text under a rule, no icon).
Prototype: `scratchpad/design/today.html`.

### Train
Masthead → h1 "Train" with right meta `WK 06/12 · BUILD` → full **phase ribbon** (tap a week) →
week nav `‹  WEEK 06 · 12–18 OCT  ›` in mono between hairlines → week cells → day ledger: each day is a
ruled row with a mono date (`FRI 16`), type code, title, `~48′` and an oxide `Start` key on today only;
done days show the moss ✓ and duration. Quick actions become a 3-column ruled grid of text keys
(`Timers` `Log cardio` `Log workout` `Library` `HYROX` `History`) with a mono sub-line and no icon
tiles. **Session detail**: lettered blocks (`A — WARM-UP`) as ledgers. Each item is a row with the
name, dose in condensed figures and the suggested bell as a mono stamp `24 kg` (dashed border when it
is only a suggestion). **Library**: an alphabetical ledger with a mono category code. **HYROX**: the
split table is a native ledger (it already is: `.tr-table`), and the predicted time is a 72 px figure.

### Workout player
`body.immersive`. Header: square 44 px close/pause keys, centred mono title and condensed elapsed time.
Lettered block segments. Block head: mono `BLOCK B · STRENGTH · 5 ROUNDS`, h2, one-line note. Exercise
under an ink rule: h3, mono `last · …` ghost line, **bell selector**, **set ledger**. Rest uses the
**inverted plate** docked above the footer. The footer has a square back key and a hairline `Next block …
C · EMOM 10 →` key (it turns oxide only when the block is complete). Timed blocks (EMOM/AMRAP/intervals/
Tabata) use the **tick-bezel dial**, a minute/round segment row, a ledger of the current and next items
(reps figure · name · load) and a three-key transport (`⏮` hairline, `⏸` inverted ink key 120 px wide,
`⏭` hairline). AMRAP's round counter is one wide ruled key: `ROUNDS` label, 48 px figure, mono `TAP +1`.
Finish summary: mono `SESSION COMPLETE` and a ledger of time, volume, sets and PR stamps. RPE is a
10-cell square selector.
Prototypes: `set.html`, `timer.html`.

### Fuel
Masthead → h1 "Fuel" with mono `TRAINING DAY · CARBS +10%` → date switcher (a hairline-ruled row
`‹ Friday 16 Oct TODAY ›`) → **kcal left** as an 84 px figure with `eaten / target` at right → 61-tick
**ruler** with a mono scale → macro ledger under an ink rule (8 px swatch, mono `PROT/CARB/FAT`, a
41-tick meter in the macro colour, `62 /180 g`) → meals as numbered sections
(`01 BREAKFAST ───── 520 KCAL`). Items are ledger rows: name (15/500), mono data line
`200 g · P20 C8 F0`, condensed kcal on the right. `+ ADD FOOD` and `COPY YESTERDAY` are mono text actions.
Empty meals collapse to just their section rule with `+ ADD` in the meta slot → `05 WATER`: figure,
12 square glass cells (filled = `--water`), keys `−250 / +250 ml / +500 ml` → `06 WEEK` bar chart (square
bars, no radius, target as a dashed ink line) → `07 ADAPTIVE TARGET` as a ledger plus one oxide
`Apply 2,350 kcal` key when there is a suggestion. **Add-food sheet**: square search field, segmented
`Recent · Favourites · My foods` with an inverted active segment, results as ledger rows with a square
`+` key (hairline; it turns into a moss ✓ after adding). The amount editor uses a large condensed input
and a live macro panel laid out as a 5-column ledger (not tiles).
Prototype: `fuel.html`.

### Progress
Masthead → h1 + range segment (`7D 30D 90D`, square, inverted active) → numbered sections: `01 BODY`
(weight line chart: 1.5 px ink line, the EMA in oxide, the goal as a dashed `--line-2` rule, mono axis
labels, no area fill), `02 TRAINING` (weekly bars, square; a totals ledger), `03 LOAD` (ACWR shown
as a **horizontal zone ruler**: a tick scale 0–2.0 with zone bands as 3 px underlines and an oxide
needle tick, which replaces the semicircle gauge), `04 RECORDS` (a ledger: lift · figure · date, and PR
stamps), `05 HYROX` (predicted time 72 px figure, readiness score as a figure + 41-tick meter instead of
a ring, parts as a ledger), `06 FUEL ADHERENCE` (meters), `07 CALENDAR` (heatmap with square 2 px-gap
cells in `--tick-off` → `--text` steps; oxide marks today).

### Me
Masthead → identity block: name h1 and a mono line `M · 34 · 182 cm · 84.2 kg` (no avatar tile; if
kept, a square 48 px mono monogram) → numbered ledgers: `01 PROFILE`, `02 EQUIPMENT` (bell cells reuse
the bell selector, so owned = inverted and pairs = `×2`), `03 TARGETS` (5-column ledger of figures),
`04 PLAN`, `05 SETTINGS` (toggles: a square 44×26 switch with a square knob; on = ink track), `06 DATA`
(export/import/reset as ledger rows; reset in brick text), `07 ABOUT`.

### Onboarding
A full-bleed, page-per-step "form" in the same ledger language. Top: back key, a **step counter in mono
`03 / 09`** with a 9-segment top-ruled progress row (current oxide, done ink), and `SKIP`. Title h1 (32),
one coach line. Choices are full-width ruled rows (`ob-choice`): a mono index `A B C`, label, description,
and on the right a square 20 px radio that turns into an inverted ✓ when chosen. Bells use the 5-column
bell grid (tap cycles none → single → pair `×2`). Days per week is a row of large square figure cells
3–6. The plan reveal shows the expanded wordmark, the **phase ribbon** at large size, `12 WEEKS` as a
72 px figure and a targets ledger. The primary key is pinned to the footer over a hairline.

---

## 10. Components → new spec (for app.css)

| Component | New spec |
|---|---|
| `.card` | `background: transparent; border: 0; border-top: 1px solid var(--line); border-radius: 0; padding: 14px 0 0;` `.card.flush` → `padding: 0`. `.card.hero` → same as card (no tone step). `.card.clickable:active` → `background: var(--surface-2)` |
| `.section-head` | grid `auto auto 1fr auto`: `.ix` (mono muted), `h2` restyled as mono 11/500 uppercase `--text`, `::after` hairline, right slot. `sectionHead(title, right, index)` gains an optional index arg |
| `.eyebrow`, `h4` | `--t-label` (mono 11 uppercase, .06em) |
| `.btn` | radius 3, min-height 48 (xl 52), weight 600, `justify-content: space-between` when it has a `.k` meta child, else center; `.btn.subtle` = transparent + `--line-2` border; `.btn.ghost` = transparent + `--line` border; `.btn.go` = **removed** (use primary); `.btn.sm` min-height 40, mono 12 label; no `scale()` on `:active` → `background: var(--surface-2)`; primary `:hover/:active` → `--accent-2` |
| `.link-btn` | mono 11/500 uppercase .06em, `--accent` (or `--text-2` for secondary), min-height 44 |
| `.icon-btn` | 44×44, radius 3, `border: 1px solid var(--line)`; `.filled` → `--surface-2` |
| `.chip` | **square tag**: radius 2, min-height 36, mono 12 natural case, `--line-2` border; `[aria-pressed=true]`/`.on` → **inverted** (`--text` bg, `--bg` text) |
| `.pill` | **stamp**: radius 2, `1px solid currentColor`, transparent bg, mono 10.5/500 uppercase, padding 2px 6px, `--text-2`; colour variants set only `color` (and thus the border); delete all tinted backgrounds |
| `.stat .v` | `.fig` spec (condensed 72 %, 600); `.v small` → `--t-unit`; `.stat .k` → `--t-label` |
| `.stat-card`, `.grid2/3/4` of stats | becomes a ruled column ledger: `border-top: 1px solid var(--line)`, columns separated by `border-right: 1px solid var(--line)`, no fill |
| `.list > .li` | no card box around it; rows with `border-bottom: 1px solid var(--line)`, padding `12px 0` (flush lists inside sections keep the 16 px gutter alignment); `:hover/:active` → `--surface-2` |
| `.badge` | becomes a **mono code**: no fill, `min-width: 36px`, mono 11/500 uppercase `--text-2`, left-aligned; a badge containing an icon is not allowed (views pass text codes) |
| inputs / `.search` / `.stepper` | radius 3, `--surface` fill, `--line-2` border; focus: drop the current `box-shadow` halo (it reads as a glow) and use `outline: 2px solid var(--accent); outline-offset: 1px` |
| `.seg` | radius 3, `1px solid var(--line-2)`, no inner padding, cells divided by hairlines, `.on` = inverted; mono 12 labels |
| `.toggle` | 46×26, radius 2; knob 20×20 square radius 1; on → track `--text`, knob `--bg` |
| `.bar` | **removed in favour of `.ticks`**. Keep `.bar` as a 4 px square-ended track for legacy spots (radius 0) until each call site moves to `ticks()` |
| `.ticks` *(new)* | `display:flex; justify-content:space-between; align-items:flex-end; height:12px` · `i {flex:0 0 2px; height:100%; background:var(--tick-off)}` · `i.on {background: var(--c, var(--text))}` · `i.now {background: var(--accent)}` · `.sm` 10 px · `.lg` 24 px · `.ruler i {height:62%}` `.ruler i:nth-child(5n+1){height:100%}` |
| `.ring` | retired from views (charts.js keeps it for back-compat) |
| `.callout` | no fill: `border-left: 3px solid var(--c, var(--line-2)); padding: 2px 0 2px 12px; background: none; border-radius: 0` with `.go/.info/.danger/.scaled` setting `--c` |
| `.sheet` | `--bg-2`, top radius 10, hairline top border, grip 32×3 square; title in h3 with a mono close `ESC`/✕ key |
| `.toast` | `--plate` slab, radius 3, mono 12 text, action in `--plate-accent` (dark theme `#8E3E1D` on the light plate, light theme `#D27449` on the dark plate) |
| `.tabbar` | text-only mono labels; `a[aria-current=page]::before` 2 px oxide top rule (left/right 22 %); `.tab-live` = 6 px square moss marker |
| `.empty` | left-aligned under a section rule: a mono label `NOTHING LOGGED`, one sentence, and an action as a text link; no 32 px icon |
| `.dot` | square 8×8 (radius 0) |
| `:focus-visible` | `outline: 2px solid var(--accent); outline-offset: 2px; border-radius: 2px` |

---

## 11. Implementation plan (one pass, file by file)

> Order: fonts and tokens → shared components → charts/helpers → per-view CSS → view markup. Each step
> is safe to ship on its own because class names are kept and only their styling changes, except where
> a markup change is called out.

### 11.1 `forge/index.html`
- Add `<link rel="preload" href="fonts/archivo-var.woff2" as="font" type="font/woff2" crossorigin>`.
- `theme-color` → `#13120F`. The pre-paint script also sets `meta[name=theme-color]` to `#F1EDE4` for the light theme.
- Tab bar: remove the `<span data-icon>` children. Labels stay as text (`Today` … `Me`). `app.js` must
  stop injecting tab icons (search for `data-icon`).
- Title `FORGE`. Boot mark: replace the pulsing SVG with the expanded `FORGE` wordmark (`.boot-mark` text).

### 11.2 `forge/sw.js`
- Add `fonts/archivo-var.woff2`, `fonts/plex-mono-400.woff2`, `fonts/plex-mono-500.woff2` to the precache
  list and bump the cache version.

### 11.3 `forge/css/app.css` (most of the change happens here)
1. Add the three `@font-face` rules (§1) at the top.
2. Replace the `:root` and `[data-theme=light]` values with §3. Add `--rule-ink`, `--tick-off`, `--plate`,
   `--plate-ink`, `--font-mono`, `--radius: 3px`, `--radius-sm: 3px`, `--radius-xs: 2px`,
   `--radius-sheet: 10px`, spacing `--s1…--s7`, `--ease: cubic-bezier(.2,0,0,1)`. Delete `--go-soft` and
   `--danger-soft` (grep for them; there are ~10 uses across css files, and each is replaced per §10),
   and delete `--shadow`.
3. `body`: `font-family: var(--font); font-stretch: 100%`. Headings use the weights and sizes from §1
   (h1 32/600, h2 22/600, h3 17/600; `h4` = mono label).
4. Add utilities: `.fig`, `.unit`, `.lbl`, `.data`, `.ix`, `.ticks` (+ `.sm .lg .ruler .c`), `.ledger`,
   `.lrow`, `.masthead`, `.wordmark`, `.ribbon` (+ cells), `.weekcells`, `.stamp`, `.plate`.
5. Restyle every component in §10 in place. Keep the selectors.
6. Tab bar per §6/§10. `.toast` per §10.
7. Remove every `transform: scale(...)` on `:active` (app.css, dash.css, train.css, fuel.css, workout.css).
   Grep for `scale(` and replace each with a background change.

### 11.4 `forge/js/ui.js` (shared helpers, so the views stay small)
- `icon()`: `stroke-width` 1.6, `stroke-linecap` `square`, `stroke-linejoin` `miter`.
- `sectionHead(title, right, index)`: render
  `h('div',{class:'section-head'}, index!=null ? h('span',{class:'ix'},String(index).padStart(2,'0')) : null, h('h2',null,title), h('span',{class:'rule','aria-hidden':'true'}), right||null)`.
- New `fig(value, unit, cls)` → `<span class="fig">value<span class="unit">unit</span></span>`.
- New `masthead(right)` → `<header class="masthead"><span class="wordmark">FORGE</span><span class="lbl">…</span></header>`.
- `emptyState()`: drop the icon and render a mono label plus text plus action (§10).
- `stepper()`: buttons render `−`/`+` glyphs in mono, not icons (optional).

### 11.5 `forge/js/charts.js`
- New `ticks({ value, max, n = 40, color, ruler = false, size = 'sm', label })` → a `div.ticks` with `n`
  `<i>` children, the filled count `round(n*min(1,value/max))`, overflow ticks (`value>max`) marked
  `.over` (brick), and `role="meter"` + aria values.
- New `ribbon({ weeks, current, onPick })` → the phase ribbon (§5.5), used by Today, Train, Onboarding and Progress.
- `lineChart`: stroke 1.5, `stroke-linecap: square`, no area fill by default, mono axis text
  (`.chart text { font-family: var(--font-mono); font-size: 10px }` in CSS).
- `barChart`: `rx = 0`; target as a dashed `--line-2` line with a mono label.
- `heatmap`: `rx = 0`; levels are `--tick-off` → `--text-2` → `--text`; today gets an oxide 1 px stroke.
- `gauge`: replace with `zoneRuler({ value, max, zones })` (horizontal), or restyle `gauge` as ticks on
  an arc to match the timer bezel. Prefer the ruler.
- `ring`: keep the export for compatibility but stop using it in views.

### 11.6 `forge/js/views/_timerui.js`
- `timerFace()`: replace the `track`/`arc` circles with **60 `<line>` ticks** generated once (every 5th
  long; mono `60 15 30 45` text). `update()` sets a class on each tick (`off` elapsed, `on` remaining,
  `now` current), and only touches the ticks whose state changed (keep it cheap per tick). Keep the
  `.tf`, `.tf-phase`, `.tf-time` and `.tf-sub` class names and the `phase-*` classes.
- `timerControls()`: keep the API; CSS makes `.tc-main` a 120×64 inverted ink key and `.tc-side`
  64×64 hairline keys.

### 11.7 `forge/css/dash.css` (Onboarding, Today, Progress, Me)
- `.ob-dots` → a segmented top-ruled progress row plus a mono `03 / 09` counter. `.ob-choice` → a ruled
  row with a square radio. `.bell-tile`/`.equip-tile`/`.day-tile` → square cells, inverted when on, radius 0.
  `.ob-mark` → removed (the wordmark replaces it). `.phase-bar` → reuse `.ribbon`.
- Today: `.today-head` → a 2-column grid with a vertical hairline. `.countdown` → no box; `.countdown-n`
  = `.fig` 72. `.rq-pick` → square cells, `.on` inverted (this already is inverted; set radius 0).
  `.readiness.done` → drop the `border-left` colour; use the figure plus ticks. `.session-card` → ruled
  section. `.block-peek` → `.ledger` with a letter index (`counter(bk, upper-alpha)`). `.rings-card`/
  `.ring-*` → `.daily` 4-column ledger. `.qa-row`/`.qa` → one bordered strip of mono text keys (no
  `.qa-ico`). `.wk-strip`/`.wk-dot` → week cells (§5.6). `.streak-flame` → removed. `.tip-card` → plain
  text section. `.done-badge` → removed; `.pr-strip` → a row of `.stamp`s.
- Progress: `.pr-grid`/`.pr-tile` → a records ledger. `.gauge-wrap` → `.zone-ruler`. `.heat-scale i` square.
- Me: `.avatar` → removed (or a 48 px square mono monogram). `.target-strip` → a ruled 5-column ledger.

### 11.8 `forge/css/train.css`
- `.tr-tbadge/.tr-cbadge/.tr-qa-ic` → mono code tags (no icon). `.tr-tl*` → `.ribbon`. `.tr-day` → week
  cells (radius 0). `.tr-dcard` → ruled day rows. `.tr-qa` → a ruled 3-column grid of text keys.
  `.tr-block-num` → a letter index (A, B, C). `.tr-struct` → `.callout` style (left rule).
  `.tr-bell` → `.stamp` (dashed border when `.sug`). `.tr-rpe button` → square cells, inverted when on.
  `.tr-cd`/`.tr-pred` → `.fig` 72. `.tr-stnum` → a mono index. `.tr-live-dot` → a square moss marker
  with no blink (use a static marker).

### 11.9 `forge/css/workout.css`
- `.wo-head` → a 3-column grid with square keys; `.wo-elapsed` = `.fig` 30.
- `.wo-prog-bars i` → top-ruled lettered segments (markup change in 11.11).
- `.wo-ex` → no card; ink top rule. `.wo-set` → a ledger row grid
  `30px 1fr 1fr 40px 60px`; `.cur` full-bleed `--surface-2` + `::before` 3 px oxide bar; `.wo-check` as
  in §5.7 (pending = an inner 22 px hairline box via `::after`).
- `.wo-bell` → bell selector cells (in a `.wo-bells` segmented row with `border: 1px solid var(--line-2)`),
  selected inverted.
- `.wo-rest` → `--plate` with `--plate-ink` text, radius 3, `.wo-rest-bar` → `.ticks` (45). `.wo-rest-time`
  = `.fig` 64. `.wo-rest-btns .btn` → square keys with a plate-ink hairline border.
- `.tf` → bezel ticks: `.tf-tick { stroke: var(--text); } .tf-tick.off { stroke: var(--tick-off); }
  .tf-tick.now { stroke: var(--accent); stroke-width: 3 }`; `.tf-time` = `.fig` clamp(84px, 30vw, 118px);
  `.tf-phase` mono 12/500 .14em, oxide for work and lichen for rest.
- `.tc-main` → a 120×64 rectangle, radius 3, ink fill. `.tc-side` → 64×64 hairline square.
  `.rc-plus` → a ruled wide key.
- `.wo-li-box` → a square 22 px box, radius 0. `.wo-done-mark` → removed; the summary uses a mono label
  plus figures.
- `.wo-foot .btn` → min-height 48, radius 3; `.wo-nav` square.

### 11.10 `forge/css/fuel.css`
- `.fu-date` → a ruled row (no box). `.fu-summary` → a big figure plus `ticks({ruler:true, n:61})` and
  a mono scale. `.fu-macros/.fu-macro` → the macro ledger (`70px 1fr 84px`). `.fu-meal` → a numbered
  section with ledger rows, `.fu-meal-kcal` = `.fig` 20, `.fu-meal-actions` → mono text actions.
  `.fu-plus` → a square 44 hairline key. `.fu-mp` → a 5-column ledger. `.fu-glass` → square cells with no
  clip-path. `.fu-ico.water` → removed. `.fu-cam-frame` radius 0.

### 11.11 View markup (only where CSS cannot do it)
- **today.js**: add `masthead()` at the top of `render`. `header`: wrap the countdown as a right column with
  mono labels. Add `ribbon()` under the header. Readiness done: replace `ring(...)` with `fig(score)` +
  `ticks({value:score,max:100,n:41})` + a mono data line. Session card: the block list gets letters and
  minutes; the start button gets a `.k` meta child (`~48 min →`). Rings card → a 4-column `.daily` ledger
  using `fig()` + `ticks()`. Quick actions: drop `qa-ico`. Week cells: render type codes; done gets a `✓`.
  Pass indices to `sectionHead`. Coach tip: drop `tip-ico`.
- **train.js / session.js / hyrox.js / library.js / history.js**: use `ribbon()` instead of the bespoke
  timeline (`tr-tl`). Day badges render text codes (`TYPE_META[t].short`) instead of icons. Block numbers →
  letters (`String.fromCharCode(65+i)`). In hyrox.js, `ring(...)` → `fig` + `ticks`. Section heads get indices.
- **workout.js**: in the progress strip, the `<i>` items become `<span>` with the letter and state text.
  Set rows add the `RPE` stamp button (it opens the existing RPE picker) and a column header row
  (`SET LOAD REPS RPE`). Bell chips stay `chip wo-bell`; CSS turns them into cells (wrap them in
  `div.wo-bells.bellsel`). Rest dock markup gets a `ticks` meter instead of `.bar`.
- **fuel.js**: summary `ring(...)` → a figure plus a ruler `ticks` and a scale row. Macro rows use `ticks()`
  in the macro colour. Item sub-line strings → `200 g · P20 C8 F0` (mono `.data`). The water glasses
  markup stays; the CSS restyles it.
- **progress.js**: `ring(...)` → `fig` + `ticks`; `gauge(...)` → `zoneRuler(...)`; PR tiles → ledger rows.
- **me.js**: remove the avatar tile (or make it a monogram); targets strip → ledger.
- **onboarding.js**: the dots render as segments plus a mono counter; the plan reveal uses `ribbon()`;
  `ob-mark` → wordmark.
- **app.js**: stop injecting tab icons; theme switch also updates `meta[name=theme-color]`.

### 11.12 Acceptance checks for reviewers
- `grep -rn "border-radius: *\(1[0-9]\|2[0-9]\|99\)" forge/css` → none.
- `grep -rn "scale(" forge/css` → only inside `@keyframes` used by reduced-motion-safe sheets (ideally none).
- `grep -rn "ring(" forge/js/views` → none.
- No `--*-soft` except `--accent-soft`. No hex values in views.
- Lighthouse contrast passes in both themes. Screenshots at 390×844 match the prototype screens.

---

## 12. Prototype

Static mocks (dark + light, 390×844), built only from these tokens:
`/tmp/claude-0/-home-user-salt-labs/0d0d8a23-2e50-5021-a057-0e7bbf437659/scratchpad/design/`
`today.html · set.html · timer.html · fuel.html · proto.css` with screenshots in `shots/*-v3*.png`.
`proto.css` is the reference implementation of the tokens, `.ticks`, `.sec`, `.btn`, `.lbl`, `.unit`,
`.fig` and the tab bar. Port it rather than reinventing it.
