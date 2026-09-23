# Client UI Foundation

## Component Ownership

Use the shadcn source-owned component pattern, Radix primitives for complex
interaction, Tailwind CSS 4 for utilities, and Lucide React for icons.
Our `Button` and `Dialog` are deliberately styled local implementations, not
unmodified shadcn registry output. They live in `src/components/ui/`.

Do not mix a second styled component system into the product. Add primitives only
when a real screen needs them. Native HTML remains preferable for simple controls:
appearance choices use labelled radio inputs, including native arrow-key behavior.
Internationalization is not installed; current UI copy is Chinese.

## Visual Contract

The product uses restrained neutral colors. Authentication and appearance surfaces
can use generous rounded geometry; the knowledge workspace uses a denser desktop
vocabulary with small radii and quiet separators. The mobile workspace follows
the content-first navigation and sheet patterns observed across the June 2026
Obsidian iOS reference captures, adapted to our own identity and capabilities.
Do not copy Obsidian artwork, brand text, status bar, or the capture watermark.
Use color for actions and state, not decoration. Both layouts share semantic
tokens and data, not identical chrome.

| Concern | Source of truth / rule |
| --- | --- |
| Colors | Semantic CSS variables in `src/product.css`; light and dark values use OKLCH |
| Theme | `data-theme="light|dark"` on the document root |
| Accent | `data-accent="mono|blue"` on the document root |
| Text | Foreground and muted-foreground tokens; readable contrast in both themes |
| Typography | Native-first sans stack; desktop compact, mobile editor text at least 16px |
| Geometry | Desktop workspace rows and controls use 4-6px radii; mobile icon buttons are circular, sheets round only at their exposed edge |
| Touch | Interactive buttons at least 44x44px; radio tiles exceed this |
| Icons | Official TJUClaw artwork through `src/components/brand-icon.tsx` for branding; Lucide for action and status icons |
| Layering | Named `--z-overlay` and `--z-dialog` tokens, portal-based dialogs |
| Motion | 160-200ms state transitions; respect reduced motion |

Brand artwork uses the transparent whale-girl image through `src/assets/brand-icon.webp`
for in-product surfaces. The black-background `app-icon.png` is reserved for native
application icons; `favicon.png` is its lightweight browser-tab derivative. Use
the shared `BrandIcon` component rather than
substituting a generic sparkle or letter. Decorative marks beside the wordmark use
empty alt text; standalone meaningful images need a label. Native icon sources
remain independent of this web display asset.

Use `Button` variants `solid`, `ghost`, `floating`, and sizes `default`, `icon`.
Icon-only buttons need an accessible name. Dialogs need a title, description,
keyboard escape, focus containment and focus restoration to their actual opener.
Never remove focus indicators from interactive elements to improve screenshots.
Compound search controls put their focus ring on the rounded container using
`:focus-within`, replacing the input outline without hiding keyboard focus.

Shared native scrollbar styling lives in `src/scrollbars.css`: transparent tracks,
thin rounded thumbs, theme-aware contrast, and no arrow buttons. Keep native
wheel, touch, keyboard and drag behavior; do not add a JavaScript scroll engine or
hide scrollbars. Forced-colors mode restores browser styling. Rounded dialogs
inset their scrollbar track to keep it away from the corners.

## Appearance State

`src/lib/appearance.ts` owns preferences. Components use `useAppearance()` and
`setAppearance()` rather than writing attributes or storage themselves.

- Modes: `system`, `light`, `dark`; default `system`.
- Accents: `mono`, `blue`; default `mono`.
- Store only these preferences at `tjuclaw.appearance.v1`, never credentials.
- In system mode, subscribe to OS color-scheme changes.
- Explicit mode overrides the OS setting. Storage events synchronize other tabs.
- Validate stored values. Malformed values fall back to defaults.
- Blocked storage keeps in-memory controls usable and shows an honest notice.
- Apply theme attributes before rendering product content. Do not require inline
  script permissions in the native shell or weaken its CSP for theming.
- Set CSS `color-scheme` and the browser theme-color alongside the resolved theme.
- Preference persistence is per browser/WebView profile, not account/cloud sync.

Tailwind's `dark:` variant follows the same data attribute. Do not add a second
theme provider, per-component dark-mode booleans, or a next-themes dependency.

## Preview and Verification

`src/auth.tsx` owns the email authentication pages. `src/product.tsx` remains at
`/preview/appearance` and opens the appearance panel so its foundation can be
reviewed independently. The conversation and file preview are labelled demo
content, not an Agent integration. Closing the panel exposes the sample list.

Auth inputs reuse the compound rounded focus treatment. OTP entry is a single
labelled native input with six visual cells, numeric input mode and one-time-code
autocomplete, not six independently focused boxes. Pending, expired, error and
success states are explicit; a resend countdown is not a server-side security boundary.

Run `task ui:install` once, then `task ui:test`. Tests build the production client
and start an isolated preview on port 1422, without reusing a developer server.
They exercise themes, persistence, cross-tab updates, storage denial, keyboard
navigation, focus restoration, sample interactions, rounded search focus,
forced-colors focus, native scrolling and twelve appearance captures:
360x800, 390x844, 768x1024, 1440x900, 1920x1080 and 2560x1440, each in light and dark.

Artifacts remain in ignored `test-results/ui/`. Screenshots are current-render
evidence, not an automatic pixel-match score or a substitute for visual review.
Native Windows/Android/Linux behavior still requires testing on those clients.

The audit app and product app are separate lazy entry points. Private reference
images, descriptions and research never enter this directory or a normal build.

## Knowledge Workspace Surface

`src/workspace.tsx` owns the authenticated knowledge workspace at `/workspace`.
Its shell is a narrow activity rail, file tree, document tab, content pane, optional
outline, and status bar. Do not put a logo or product title in the upper left,
or turn the editor into a card-based dashboard. `src/obsidian-shell.css` owns
workspace-specific geometry; it still uses `src/product.css` semantic tokens
and the shared appearance state.

- Notes, sessions, and flashcards live in the activity rail; the current library
  name and live file/folder counts stay at the foot of the file pane. Files
  include Markdown notes and attachments, not sessions. A chevron
  indicates the library details entry, not an unsupported multi-library picker.
  The graph occupies the activity rail foot; the gear sits beside the library
  entry. Account actions belong in settings.
- Settings use a compact category list and independent content scrolling on
  desktop; mobile categories scroll horizontally above the content. Preferences
  shown there must be wired to real state, not decorative plugin/sync switches.
  Graph nodes derive from existing notes and `[[title]]` links, not a server
  index. Flashcards currently export tab-separated front/back/tag text for
  import into Anki; its template interpreter and review scheduler are not
  implemented. Upstream Anki (AGPL) and pi source are design research, not
  code to copy into this client.
- File/folder creation, inline rename, drag-to-move, search and context menus remain
  reachable from the tree. Notes use CodeMirror 6 live preview and save Markdown
  through `patchEntry()`; agent entries open persisted sessions.
- Live preview reads the Markdown syntax tree; it never rewrites source just to
  display formatted text. Show heading/list/quote syntax dimmed on the focused
  line, but show inline delimiters only when the caret or selection enters that
  construct. Outside it, render emphasis, links, bullets and task controls in
  place. Hidden delimiters are atomic for cursor movement; selection, undo and
  automatic save continue to operate on the original Markdown.
- A compact, horizontally scrollable Markdown command dock appears only while
  the note editor has focus. On mobile it replaces bottom navigation and sits
  above the virtual keyboard, with a separate dismiss-keyboard control. Commands
  edit CodeMirror's source and preserve the selection and keyboard focus;
  heading, list and indentation commands act on whole selected lines. Do not
  make the dock a permanent second header or replace it with decorative icons.
- The document is the only primary surface. Templates and recent notes are
  lightweight choices on an empty note tab, not promotional cards.
- The shell fits one viewport; scrolling happens inside the tree, editor, chat,
  flashcard list or outline. Desktop panes can be resized. On mobile the sidebar
  floats above content and dismisses by tapping outside or choosing an entry.
  Its activity rail stays on the left with the graph anchored at its foot, not
  as a bottom tab bar. Motion smooths drawer/outline entry, backdrop dismissal,
  and the active rail indicator; reduced-motion preferences disable these
  transitions without delaying navigation or changing the one-viewport layout.
- Icon buttons need accessible names; focus rings remain visible. Respect reduced
  motion and preserve the light/dark preference rather than forcing a theme.

### Mobile Workspace Contract

The reference sequence covers onboarding, editing, file navigation, search,
graph, settings, and contextual actions. It is a behavior and visual-density
reference, not a promise that every Obsidian plugin or subscription feature
exists here. Implement only real actions for this product.

- The note owns the canvas. No desktop rail, permanently visible file tree,
  status bar, logo, or marketing card competes with document text. The top
  strip identifies the current document and exposes sidebar, reading/editing
  mode, and context actions. A compact bottom bar holds frequent actions.
  The document outline is available from the note menu as a trailing overlay;
  choosing a heading returns to the editor.
- File navigation is an overlay from the leading edge, never a second column
  that squeezes the note. The document remains visible behind a scrim. Tapping
  the scrim or choosing a note closes the drawer; switching between Files,
  Sessions, and Flashcards keeps the drawer open until an item is chosen.
- In the drawer, creation tools precede the file list; the library and settings
  stay at the bottom. Folder disclosure, selection, and inline rename remain
  available. Desktop supports drag-to-move; touch uses the destination picker
  in the overflow menu, which exposes the same supported operations as
  desktop right-click.
- Mobile context actions and destination pickers rise from the bottom with
  grouped rows and a grabber. Do not use `window.prompt` for file management
  or show a nonfunctional command. Dismiss with Escape or the scrim; destructive
  actions retain confirmation.
- Settings are a full-height layer on phones: category navigation stays above
  independently scrolling preferences and account controls, with the underlying
  workspace preserved. No account avatar or product branding appears in the
  file drawer.
- Respect `100dvh` and top/bottom safe-area insets. The body never scrolls;
  editor, tree, settings, sheets and dialogs own their scrolling. When an
  on-screen keyboard opens, visible controls must remain usable. Use native
  wheel, touch and keyboard scrolling inside each region, not scroll hijacking.
- Mobile controls have a 44px minimum hit target; do not mistake the reference
  screenshots' 3x pixel density for CSS pixels. Desktop remains compact and
  resizable. Keep light/dark semantic surfaces legible and reduced-motion
  behavior intact.

### Review Checklist

Test at 390x844 and 360x800, with a long note and nested folders: open/close
drawer, switch sections, create and rename a folder, create/open a note, open
its action sheet, move it to another folder, toggle reading mode, open settings
and dismiss it. Repeat at desktop width to catch regressions in panel resizing,
context menus, outline and per-panel scrolling. Screenshots validate composition
but never replace interaction checks.
