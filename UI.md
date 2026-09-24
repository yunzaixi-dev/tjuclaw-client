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
| Typography | Bundled Cascadia Code for Latin letters and symbols, LXGW WenKai for Chinese; desktop compact, mobile editor text at least 16px |
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

Shared native scrollbar styling lives in `src/scrollbars.css`: an 11px gutter with
a 7px faint rounded thumb, transparent tracks, theme-aware contrast, and no arrow
buttons. The same treatment covers the editor, file tree, panels, dialogs and
overflowing toolbars; avoid per-panel width/color overrides. The thumb stays
transparent while idle, fades in during scrolling and fades out after settling;
`src/lib/scroll-activity.ts` only tracks scroll activity and never moves content.
Keep native wheel, touch, keyboard and drag behavior. Forced-colors mode restores
browser styling. Rounded dialogs
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

- The activity rail labels are 资料夹, Agent, 记忆闪卡, 插件, and 小工具. The plugin
  section lists existing built-in capabilities with working entry points;
  third-party installation and runtime are not available. The current library
  name and live file/folder counts stay at the foot of the folder pane. Files
  include Markdown notes and attachments, not sessions. A chevron
  indicates the library details entry, not an unsupported multi-library picker.
  The graph occupies the activity rail foot; the gear sits beside the library
  entry. Account actions belong in settings.
- 小工具 has eight independent surfaces: a device-local repeating timetable,
  live campus entry code and encrypted account vault, campus map links, school
  calendar links, live timetable/GPA with a local estimator fallback, live vacant
  classroom status, read-only official forum feeds, and a resumable Pomodoro timer. Tools have their
  own tabs; selecting a different tool replaces the active tool tab, while +
  opens another. Side items follow the shared reorder/sort behavior. Campus
credentials use a user-supplied 6-64 character passphrase, PBKDF2-SHA256 and
  AES-256-GCM with a random salt and nonce; the key and passphrase are never
  stored. Encrypted data is scoped to the signed-in identity and this device,
  not synced. The BFF keeps only a short-lived WePeiYang token in memory and
  never persists office-network passwords. Live results are labelled separately
  from local fallback data; forum actions remain read-only until their write
  contract is explicitly implemented.
- Settings use a compact category list and independent content scrolling on
  desktop; mobile categories scroll horizontally above the content. Preferences
  shown there must be wired to real state, not decorative plugin/sync switches.
  Graph nodes derive from existing notes and `[[title]]` links, not a server
  index. Flashcards currently export tab-separated front/back/tag text for
  import into Anki; its template interpreter and review scheduler are not
  implemented. Empty flashcard collections offer four optional sample cards;
  loading them is explicit and persists only for the active identity. Upstream
  Anki (AGPL) and pi source are design research, not
  code to copy into this client.
- File/folder creation, inline rename, drag-to-move, search and context menus remain
  reachable from the tree. Notes use CodeMirror 6 live preview and save Markdown
  through `patchEntry()`. Notes, Agent sessions and flashcards keep separate
  tab strips. Plus adds an empty tab in the current section, while choosing
  a file or Agent from the sidebar replaces that section's active tab content.
  Every sidebar section offers manual and name sorting; notes and Agents also
  offer recently modified sorting. Drag between siblings to save a manual order,
  or use the item's up/down actions on touch devices. Dragging onto a folder's
  center still moves the item into it; edge drops reorder its siblings. Sorting
  never changes the server-side folder relationship. Sidebar order and sort mode
  are device-local, scoped to the signed-in identity; they do not sync across
  clients. Searching disables drag to avoid reordering a filtered subset.
  A note tab keeps its own back/forward history, shown as small controls in
  the content pane's upper-left corner. Closing a tab returns to a neighbor
  in the same section without deleting data. Pending note edits flush before switching.
  Agent entries open persisted sessions. The conversation
  reads as a narrow task thread with quiet role labels, Markdown-rendered Agent
  replies and a bottom-docked composer, inspired by Codex Desktop without
  implying unavailable tools or execution. Sending locks the composer, keeps
  the draft on failure and offers inline retry feedback.
- Live preview reads the Markdown syntax tree; it never rewrites source just to
  display formatted text. Show heading/list/quote syntax dimmed on the focused
  line, but show inline delimiters only when the caret or selection enters that
  construct. Outside it, render emphasis, links, bullets and task controls in
  place. Hidden delimiters are atomic for cursor movement; selection, undo and
  automatic save continue to operate on the original Markdown. Revealed syntax
  remains legible in both themes; heading text is not underlined by the default
  CodeMirror highlighter, while actual links retain their underline.
- UI, note titles, Markdown editing and rendered Markdown use Cascadia Code for
  Latin text and symbols, followed by LXGW WenKai for Chinese glyphs. Bundle both
  fonts locally so Web and native clients do not rely on installed system fonts.
  Revealed Markdown punctuation uses the same font size as the heading and a
  distinct, readable neutral color; syntax-only headings never gain an underline.
- Markdown commands live in a searchable contextual menu rather than a
  persistent toolbar. On desktop, right-click the CodeMirror document or press
  Shift+F10; on touch devices, long-press the document. Scrolling or releasing
  early cancels the long-press. Keep the desktop menu compact with a restrained
  neutral shadow; on phones it becomes a short bottom sheet with its own scrolling.
  Group real formatting, heading, paragraph, insertion and editing commands;
  keep file/folder context actions separate. Commands edit the original
  CodeMirror source and preserve its selection and undo history. Headings,
  lists and indentation act on whole selected lines. Clipboard failures must
  be visible instead of silently discarding edits. Block markers include their
  separator spaces when revealed and hide them together when inactive; keep
  the underlying Markdown and cursor positions intact.
- Context menu rows and note-tree rows use the same surface color for hover and
  selection, including portal-mounted menus outside the workspace token scope.
  Separate adjacent highlighted rows by a hairline gap without reducing touch
  target heights.
- The document is the only primary surface. Templates and recent notes are
  lightweight choices on an empty note tab, not promotional cards.
- The shell fits one viewport; scrolling happens inside the tree, editor, chat,
  flashcard list or outline. Desktop panes can be resized. On mobile the sidebar
  floats above content and dismisses by tapping outside or choosing an entry.
  After the 48px desktop activity rail, default file-tree and outline panes
  each take about 19% of the remaining width (clamped to 245–340px), leaving
  roughly 62% for the note. The left pane's total width includes its activity
  rail; drag resizing remains available.
  Panel scrollbars use the shared faint thumb without visible tracks or end buttons.
  The contextual Markdown menu renders above the editor without clipping and
  leaves the document chrome unchanged when it is closed.
  Desktop pane dividers keep a wide drag target but reveal only a 1px accent line
  on hover or while dragging; collapsed panes have no active resize target.
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
- Folder navigation is an overlay from the leading edge, never a second column
  that squeezes the note. The document remains visible behind a scrim. Tapping
  the scrim or choosing a note closes the drawer; switching between 资料夹,
  Agent, 记忆闪卡, and 插件 keeps the drawer open until an item is chosen.
  Choosing a built-in plugin closes the drawer to show its details.
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
  Android's edge-to-edge WebView receives system-bar and display-cutout insets
  on its native content root (`src-tauri/android/MainActivity.kt`); CSS
  `env(safe-area-inset-*)` remains for browsers and iOS. Do not assume older
  Android WebViews expose nonzero CSS safe-area values.
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
