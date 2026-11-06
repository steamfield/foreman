# DESIGN.md: forman.steamfield.io

The visual contract for the site. Every value here is a token in `src/styles/global.css`; components use the tokens through Tailwind utilities, never raw hex. A new value goes here first.

## Direction

A site office. forman's job is supervision: Claude writes a work order, a delegate does the work, and Claude signs it off. The page looks like the paperwork and the monitors of that office: pale drafting-paper surfaces, black ink, dark console screens showing what the delegate is doing, and one hi-vis orange that only appears where something needs a person (Claude or you).

Precision and density over decoration. The page assumes a reader who lives in a terminal.

One theme, light, with dark consoles inside it. No theme toggle.

## The one rule about orange

`signal` (hi-vis orange) means "needs attention": a pending question, the run state `waiting`, the primary install action, and the focus ring. It never decorates. If you are reaching for orange to make something look nicer, use ink weight or placement instead.

## Color

| Token                  | Value                 | Use                                                           |
| ---------------------- | --------------------- | ------------------------------------------------------------- |
| `page`                 | `#F1F2EE`             | Page background, a cool drafting-paper gray                   |
| `band`                 | `#E8EAE4`             | Alternate section bands                                       |
| `card`                 | `#FAFAF8`             | Raised paper: tables, the work order, code frames on the page |
| `ink`                  | `#111311`             | Headings, body text                                           |
| `ink-2`                | `#3B4039`             | Ledes, supporting copy                                        |
| `ink-3`                | `#5B6258`             | Captions, meta, table headers (5.6:1 on `page`)               |
| `line` / `line-strong` | `#D2D6CC` / `#A7AEA1` | Hairlines, frame borders                                      |
| `signal`               | `#FF5B14`             | Attention fills (see the rule above)                          |
| `signal-ink`           | `#111311`             | Text on `signal` (6.0:1)                                      |
| `signal-text`          | `#A93A06`             | Orange as text or links on paper (5.7:1 on `page`)            |
| `console`              | `#121412`             | Console and terminal background                               |
| `console-2`            | `#1B1E1A`             | Console bars, raised rows                                     |
| `console-line`         | `#2D322B`             | Console dividers                                              |
| `console-fg`           | `#E4E8E0`             | Console text                                                  |
| `console-muted`        | `#9AA294`             | Console meta, timestamps (7.0:1 on `console`)                 |

### Run states

These colors carry the run states everywhere they appear (console header, lifecycle diagram, timelines). On paper use the `-ink` variant for text.

| State                        | Console token                 | On paper token                    |
| ---------------------------- | ----------------------------- | --------------------------------- |
| `running`                    | `state-running` (#6FA8FF)     | `state-running-ink` (#1F57B8)     |
| `waiting` (question pending) | `signal`                      | `signal-text`                     |
| `done` / idle after success  | `state-done` (#5CC98A)        | `state-done-ink` (#1F7A46)        |
| `failed`                     | `state-failed` (#FF7A70)      | `state-failed-ink` (#B42D24)      |
| `interrupted`                | `state-interrupted` (#E2C04F) | `state-interrupted-ink` (#7D6206) |
| `lost`                       | `console-muted`               | `ink-3`                           |

Exit codes and command results in consoles use `done` for exit 0 and `failed` otherwise.

## Type

| Role                           | Face             | Settings                                                             |
| ------------------------------ | ---------------- | -------------------------------------------------------------------- |
| Display (H1, section titles)   | Archivo Variable | weight 700, width 112, tracking -0.02em, line-height 1.02 (H1) / 1.1 |
| Body and UI                    | Archivo Variable | weight 400 / 500, width 100, 17px, line-height 1.6, 40rem measure    |
| Code, consoles, commands, data | IBM Plex Mono    | 400 / 500 / 600, 13px in consoles, 14px inline                       |

H1 is 64px at desktop (`clamp(2.5rem, 5.4vw, 4rem)`), section titles 36px, H3 18px weight 600. Never italic accents inside a headline; no eyebrow labels above headings.

## Space and layout

`max-w-[1200px]`, gutters `px-4 sm:px-8`, sections `py-20 sm:py-28`. Sections alternate `page` and `band` backgrounds with a `line` hairline between them. Section headers are left-aligned: title, then a lede of at most two sentences at 40rem. Layouts vary by content: the hero is a 12-column grid where the console breaks wider than the text column; tables span; the work order sits beside the digest at 5/7.

## Shape and depth

Radius 2px for chips and state badges, 4px for buttons and command boxes, 6px for frames, consoles and tables. Borders over shadows. The only shadow is on consoles: `0 1px 0 #fff inset` on the bar and `0 12px 32px -16px rgb(17 19 17 / 0.35)` under the frame, so a screen reads as an object on paper.

## Motifs

- The work order: the contract in the hand-off section is set on `card` with a perforated top edge (a dashed `line-strong` rule with two punched notches) and a stamped `May change` line. This motif appears once.
- State badges: a 2px-radius chip, mono 12px uppercase-free, with a 6px square (not a dot) in the state color. `waiting` badges pulse their square once per 1.6s unless motion is off.
- The mark: an ink tile with an orange bar across the top (the lead) over a paper square offset to the lower left (the delegate). Wordmark "forman" in Archivo 700, width 112, lowercase.

## Motion

Motion explains sequence, nothing else. Replays type and stream on a clock from `@steamfield/ui/playback`, run only on screen, and stop under reduced motion or `[data-sf-motion="reduce"]`, showing their final state. Section reveals use `@steamfield/ui/reveal` with a 12px lift and 220ms ease-out. No springs, no parallax.

## Accessibility

Body text 7:1 or better; meta 4.5:1 or better; checked in `src/styles/tokens.test.ts`. Every island server-renders its final state. Focus ring: 2px `signal` outline with 2px offset.
