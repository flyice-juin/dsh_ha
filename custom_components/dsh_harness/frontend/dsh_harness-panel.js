/**
 * DeepSeek Harness sidebar panel.
 *
 * The panel is a frame, not a second frontend: the DeepSeek Harness Web GUI is
 * served by the `dsh_ha_workbench` plugin and proxied through Home Assistant
 * (`/api/dsh_harness/workbench/`), so the browser talks to a path on Home
 * Assistant's own origin. That is what makes the real workbench usable inside
 * the sidebar — chat, tool cards, approvals, diffs and files all come from
 * Harness itself.
 *
 * All this element adds is what a frame cannot: a status line for when the host
 * is unreachable, a reload button for after a Harness restart, a real tab, and
 * full screen.
 *
 * On phones the frame is only half the story. Harness is a desktop shell: a
 * three-column grid whose left column is a 56px icon rail of global panels and
 * workspaces, which on a 390px screen is 14% of the conversation spent on a
 * menu a phone user never opens. The panel therefore injects a phone layout
 * (see `MOBILE_CSS`): the rail is dropped, and the two controls a phone does
 * need — open the session list, start a session — come from the shell's own
 * window-chrome seat, which the workbench proxy mounts for every platform.
 *
 * The sheet that seat opens is then cut down to what a phone does with it: pick
 * a workspace, then a session. The rail's other sections (workbench switcher,
 * plugin panels, automation tasks, settings) stay in the DOM but lose their
 * space, which is what turns an 18-row sheet that showed four workspaces into
 * one that shows the list.
 *
 * The element only does this when the frame is same-origin (`proxy` mode);
 * `direct` mode is cross-origin, so the block is skipped and the frame stays as
 * it was.
 */

const ELEMENT = "dsh_harness-panel";
const INJECTED_STYLE_ID = "dsh-ha-mobile";
const SCRIM_ID = "dsh-ha-scrim";
/** Class the sheet carries while it slides out; the CSS owns the animation. */
const SHEET_OUT_CLASS = "dsh-ha-sheet-out";
/** Matches the injected `dsh-ha-sheet-out` keyframes; keep the two in step. */
const SHEET_OUT_MS = 190;
/** The sidebar's collapse/expand control, by label first and hashed class last. */
const COLLAPSE_CONTROL =
  'button[aria-label*="侧边栏"], button[aria-label*="sidebar" i], button[class*="_toggle"]';

const STYLE = `
  :host {
    display: block;
    /* Home Assistant gives a custom panel no definite height, so 100% collapses
       to the content and the frame ends up 150px tall. The host only reserves
       the slot: what the user sees is the fixed .root layer, which is sized to
       the visual viewport by _syncRect(). dvh tracks the mobile browser chrome
       that vh ignores. */
    height: 100vh;
    height: 100dvh;
    min-height: 240px;
    background: var(--card-background-color, #fff);
  }
  .root {
    /* Fixed, so iOS moves this layer instead of the page when the keyboard
       opens; _syncRect() keeps it on the host's slot and ends it at the bottom
       of the visual viewport. */
    position: fixed;
    display: flex;
    flex-direction: column;
    min-height: 0;
    overflow: hidden;
    background: var(--card-background-color, #fff);
  }
  .bar {
    display: flex;
    align-items: center;
    gap: 8px;
    flex: 0 0 auto;
    box-sizing: border-box;
    height: 44px;
    padding: 0 6px 0 14px;
    border-bottom: 1px solid var(--divider-color, rgba(0, 0, 0, 0.12));
    background: var(--card-background-color, #fff);
    color: var(--primary-text-color, #212121);
    font-family: var(--ha-font-family-body, Roboto, "Noto Sans SC", sans-serif);
    font-size: 14px;
    user-select: none;
  }
  .dot {
    flex: 0 0 auto;
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--disabled-text-color, #9e9e9e);
    transition: background 200ms ease;
  }
  .dot[data-state="ready"] { background: var(--success-color, #43a047); }
  .dot[data-state="loading"] { background: var(--warning-color, #ffa600); animation: pulse 1.4s ease-in-out infinite; }
  .dot[data-state="error"] { background: var(--error-color, #db4437); }
  @keyframes pulse { 50% { opacity: 0.35; } }
  .title {
    flex: 0 1 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    font-weight: 500;
    letter-spacing: 0.1px;
    white-space: nowrap;
  }
  .host {
    flex: 1 1 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--secondary-text-color, #727272);
    font-size: 12px;
    font-variant-numeric: tabular-nums;
  }
  button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 32px;
    height: 32px;
    padding: 0;
    border: 0;
    border-radius: 50%;
    background: transparent;
    color: var(--secondary-text-color, #727272);
    cursor: pointer;
    transition: background 150ms ease, color 150ms ease;
  }
  button:hover {
    background: var(--secondary-background-color, rgba(0, 0, 0, 0.06));
    color: var(--primary-text-color, #212121);
  }
  button:focus-visible {
    outline: 2px solid var(--primary-color, #03a9f4);
    outline-offset: 1px;
  }
  button svg { width: 18px; height: 18px; display: block; }
  /* Fullscreen is the one state the bar cannot show on its own. The inward
     arrows differ from the outward ones by a few pixels of arrowhead, and the
     title tooltip needs a hover — so while the panel *is* the fullscreen
     element the control turns into a labelled pill that says what it does. */
  .fs-label { display: none; }
  button[data-active="true"] {
    width: auto;
    gap: 6px;
    padding: 0 12px 0 9px;
    border-radius: 16px;
    background: var(--primary-color, #03a9f4);
    color: var(--text-primary-color, #fff);
    font-size: 13px;
    font-weight: 500;
    white-space: nowrap;
  }
  button[data-active="true"]:hover {
    background: var(--primary-color, #03a9f4);
    color: var(--text-primary-color, #fff);
    filter: brightness(0.94);
  }
  button[data-active="true"] svg { width: 16px; height: 16px; }
  button[data-active="true"] .fs-label { display: inline; }
  .stage {
    position: relative;
    flex: 1 1 auto;
    min-height: 0;
    overflow: hidden;
    box-sizing: border-box;
    /* The element is sized down to the viewport bottom, so on a phone the frame
       would otherwise end underneath the gesture bar / home indicator. */
    padding-bottom: env(safe-area-inset-bottom, 0px);
  }
  iframe {
    display: block;
    width: 100%;
    height: 100%;
    border: 0;
    background: var(--card-background-color, #fff);
  }
  .veil {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    flex-direction: column;
    gap: 14px;
    padding: 24px;
    box-sizing: border-box;
    background: var(--card-background-color, #fff);
    color: var(--secondary-text-color, #727272);
    font-family: var(--ha-font-family-body, Roboto, "Noto Sans SC", sans-serif);
    text-align: center;
    transition: opacity 240ms ease;
  }
  .veil[hidden] { display: none; }
  .veil[data-fading="true"] { opacity: 0; pointer-events: none; }
  .spinner {
    width: 26px;
    height: 26px;
    border: 2px solid var(--divider-color, rgba(0, 0, 0, 0.12));
    border-top-color: var(--primary-color, #03a9f4);
    border-radius: 50%;
    animation: spin 800ms linear infinite;
  }
  @keyframes spin { to { transform: rotate(360deg); } }
  .error-title {
    color: var(--primary-text-color, #212121);
    font-size: 15px;
    font-weight: 500;
  }
  .error-text { max-width: 420px; line-height: 1.55; font-size: 13px; }
  .error-actions { display: flex; gap: 10px; flex-wrap: wrap; justify-content: center; }
  .error-actions button.flat {
    width: auto;
    height: 34px;
    padding: 0 16px;
    border-radius: 17px;
    border: 1px solid var(--divider-color, rgba(0, 0, 0, 0.2));
    font-size: 13px;
    color: var(--primary-text-color, #212121);
  }
  .error-actions button.primary {
    border-color: transparent;
    background: var(--primary-color, #03a9f4);
    color: var(--text-primary-color, #fff);
  }
  code {
    padding: 1px 5px;
    border-radius: 4px;
    background: var(--secondary-background-color, rgba(0, 0, 0, 0.06));
    font-family: var(--ha-font-family-code, monospace);
    font-size: 12px;
  }
  @media (max-width: 500px) {
    .host { display: none; }
  }
  /* Touch input: the shell's bar is the only chrome above the workbench on a
     phone, so its controls get a 44px target instead of the 32px mouse-sized
     one. Element-level fullscreen is unavailable in the iOS and Android WebView,
     so the control is not offered there rather than failing silently. */
  @media (pointer: coarse) {
    .bar { height: 48px; padding-left: 12px; gap: 6px; }
    button { width: 44px; height: 44px; }
    button svg { width: 20px; height: 20px; }
    [data-action="fullscreen"] { display: none; }
  }
`;

/**
 * Narrow-width rules injected into the framed workbench: the phone layout.
 *
 * A phone wants the conversation and nothing else. Harness is built as a desktop
 * shell — a three-column grid whose first track is a 56px rail carrying global
 * panels, workspaces and settings, widening to 280px when opened — so on a 390px
 * viewport the chat is squeezed to 334px before the sidebar is even touched.
 *
 * What a phone keeps from that shell: the session list (as a sheet over the
 * conversation) and a way to start a session. Both live in one control pair the
 * shell already ships for the macOS desktop — its window-chrome seat, mounted by
 * the workbench proxy on every platform — so the rail can go entirely.
 *
 * Nothing here is unconditional:
 *
 * - The rail is only removed when that seat is actually in the document
 *   (`:has([data-shell-leading])`). If a Harness upgrade makes the proxy's patch
 *   stop applying, the seat is absent, the rail stays, and the phone still has a
 *   working menu — the fallback is the status quo, not a dead end.
 * - Everything sits in a width or pointer query, so a desktop-sized panel
 *   renders exactly as before.
 */
const MOBILE_CSS = `
  /* This block is one template literal: a backtick anywhere in it — comments
     included — ends the string and takes the whole module with it. Name DOM
     classes in prose, not in code formatting. */
  html { -webkit-text-size-adjust: 100%; }
  body { overscroll-behavior: none; }
  button, [role="button"] { -webkit-tap-highlight-color: transparent; touch-action: manipulation; }

  /* The scrim the panel installs behind the session sheet (see
     _installSheetDismiss). It dims the conversation and swallows the tap that
     dismisses the sheet; the sheet itself sits above it at z-index 40. */
  #dsh-ha-scrim {
    position: fixed;
    inset: 0;
    z-index: 39;
    background: rgba(0, 0, 0, 0.18);
    -webkit-tap-highlight-color: transparent;
    animation: dsh-ha-scrim-in 200ms ease-out;
  }
  /* Set for the length of the dismissal so the dimming leaves with the sheet
     instead of blinking out when React unmounts it. */
  #dsh-ha-scrim[data-closing="true"] {
    animation: none;
    opacity: 0;
    transition: opacity 170ms ease;
  }
  @keyframes dsh-ha-scrim-in {
    from { opacity: 0; }
    to { opacity: 1; }
  }
  @keyframes dsh-ha-sheet-in {
    from { transform: translateX(-100%); }
    to { transform: translateX(0); }
  }
  @keyframes dsh-ha-sheet-out {
    from { transform: translateX(0); }
    to { transform: translateX(-100%); }
  }

  /* The chrome seat is a macOS arrangement: it lands where the traffic lights
     are, beside a header that reserves 160px for them. Outside the phone width
     it is not wanted — the rail carries the same two controls already. */
  @media (min-width: 721px) {
    [data-shell-leading] { display: none !important; }
  }

  @media (max-width: 720px) {
    /* 1. The rail gives its track to the conversation. The frame's column
       template is React state rendered inline, so this needs !important. The
       column stays in flow — display: none would let the conversation claim the
       zero-width first track — and is clipped instead. */
    [class*="_frame"]:has([data-shell-leading])[data-sidebar-collapsed] {
      grid-template-columns: 0 minmax(0px, 1fr) 0 !important;
      /* What the header reserves for the seat: 116px minus its own 20px inset
         puts the session title just right of the two 38px buttons. */
      --dsh-frame-leading-clearance: 116px;
    }
    [class*="_frame"]:has([data-shell-leading])[data-sidebar-collapsed] > [class*="sidebarCol"] {
      overflow: hidden !important;
    }

    /* 2. The two controls, at a thumb-sized 38px instead of the mouse-sized 28.
       The seat is positioned for macOS traffic lights (left: 88px, top: 11px). */
    [data-shell-leading] { left: 6px !important; top: 5px !important; }
    [data-shell-leading] [data-slot] > * { gap: 4px !important; }
    [data-shell-leading] button {
      width: 38px !important;
      height: 38px !important;
      border-radius: 9px !important;
    }
    [data-shell-leading] button svg { width: 20px !important; height: 20px !important; }

    /* 3. Desktop-only header affordances. The model picker repeats a choice the
       composer already shows; the jobs chip steals the width the session title
       needs (progress is still reported inline in the conversation); the right
       sidebar (files, terminal, previews) is not a phone surface. Scoped to the
       conversation column on purpose: the session sheet has a headerActions of
       its own (add a workspace, pick a list view) and on a phone that is the
       only place to reach them. */
    [class*="centerCol"] [class*="_headerUtilities"],
    [class*="centerCol"] [class*="_headerCorner"],
    [class*="centerCol"] [class*="_headerActions"] { display: none !important; }

    /* 4. The session list opens as a sheet over the conversation instead of
       pushing it aside. The shell only carries data-sidebar-collapsed while the
       sidebar is closed, so the open state is recognised from the sidebar root
       it then contains. */
    [class*="_frame"]:has([data-dsh-sidebar-wide="true"]) {
      grid-template-columns: 0 minmax(0px, 1fr) 0 !important;
    }
    [class*="_frame"]:has([data-dsh-sidebar-wide="true"]) > [class*="sidebarCol"] {
      grid-column: 1;
      position: fixed;
      top: 0;
      bottom: 0;
      left: 0;
      /* The sidebar carries its own (draggable) width; let the sheet fit it
         instead of leaving a strip of empty drawer beside it. */
      width: fit-content;
      max-width: min(86vw, 340px);
      z-index: 40;
      box-shadow: 8px 0 24px rgba(0, 0, 0, 0.22);
      /* Slides in with the scrim instead of appearing. */
      animation: dsh-ha-sheet-in 220ms cubic-bezier(0.2, 0, 0, 1);
      will-change: transform;
    }
    /* Dismissal: the panel adds this class first, then presses the collapse
       control once the sheet is off screen (see _installSheetDismiss). Doubling
       the class outranks the rule above, which keeps animating the entry. */
    [class*="_frame"] > [class*="sidebarCol"].dsh-ha-sheet-out.dsh-ha-sheet-out {
      animation: dsh-ha-sheet-out 190ms cubic-bezier(0.4, 0, 1, 1) forwards;
    }
    /* A fixed grid item leaves auto-placement, so the conversation would claim
       the first track; keep every column in its own slot explicitly. */
    [class*="_frame"]:has([data-dsh-sidebar-wide="true"]) > [class*="centerCol"] {
      grid-column: 2;
    }
    [class*="_frame"]:has([data-dsh-sidebar-wide="true"]) > [class*="rightbarCol"] {
      grid-column: 3;
    }
    /* The drag handle belongs to the docked layout only. */
    [class*="_frame"] > [class*="handle"] { display: none !important; }

    /* 5. The sheet is a workspace picker, not the desktop rail. What the rail
       stacks above the tree is either a desktop surface (settings, plugin
       panels, automation tasks) or a duplicate of a control the header seat
       already carries — and each hidden section hands its height to the list.
       The workbench switcher's wrapper goes with it, because the wrapper is
       what would otherwise leave a plugin-shaped hole. */
    [data-dsh-sidebar-root] > div:has(> .dshWbSidebarSwitcher),
    [data-dsh-sidebar-root] [class*="_panelList"],
    [data-dsh-sidebar-root] [class*="_footArea"] {
      display: none !important;
    }
    /* ⌥⌘N is a caption for a keyboard that is not on this screen. */
    [data-dsh-sidebar-root] [class*="_newSessionShortcut"] { display: none !important; }

    /* 6. The home screen's mode chips (PPT / Word / Excel) share one desktop row
       with the workspace name and the agent preset. At 390px that row measures
       412px: the workspace takes 98, the preset 106, and the three chips need
       208 — they end at 497, off the screen. So the chips wrap onto a line of
       their own, one third of the width each.

       Their own line, not the space under the composer: an active mode (Word's
       preset gallery and friends) docks a panel over everything below the
       composer — measured, section.dso-dock covers the chip row at y=533 —
       so chips down there would be hidden exactly when switching modes matters.
       Above the composer they stay reachable in every state. */
    [class*="heroWorkspaceRow"] {
      flex-wrap: wrap;
      row-gap: 8px;
    }
    [class*="heroModeCluster"] {
      flex: 1 1 100%;
      width: 100%;
      gap: 8px;
      align-items: stretch;
    }
    /* One third each: three thumbs, not a squeeze. */
    [class*="heroModeCluster"] button {
      flex: 1 1 0;
      min-width: 0;
      min-height: 36px;
      justify-content: center;
    }
  }

  @media (pointer: coarse) {
    /* The sheet's own rows are 24px mouse targets. */
    [data-dsh-sidebar-root] button,
    [data-dsh-sidebar-root] [aria-label*="收起侧边栏"] {
      min-height: 44px;
    }
  }
`;

const ICONS = {
  reload:
    '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M17.65 6.35A7.96 7.96 0 0 0 12 4a8 8 0 1 0 7.73 10h-2.08A6 6 0 1 1 12 6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z"/></svg>',
  external:
    '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M14 3v2h3.59l-9.83 9.83 1.41 1.41L19 6.41V10h2V3h-7zM5 5h6V3H3v18h18v-8h-2v6H5V5z"/></svg>',
  expand:
    '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M4 4h6v2H6v4H4V4zm10 0h6v6h-2V6h-4V4zM4 14h2v4h4v2H4v-6zm14 0h2v6h-6v-2h4v-4z"/></svg>',
  collapse:
    '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 4h2v6H4V8h4V4zm6 0h2v4h4v2h-6V4zM4 16h6v6H8v-4H4v-2zm10 0h6v2h-4v4h-2v-6z"/></svg>',
};

class DshHarnessPanel extends HTMLElement {
  constructor() {
    super();
    this._hass = undefined;
    this._root = undefined;
    this._started = false;
    this._iframe = undefined;
    this._veil = undefined;
    this._dot = undefined;
    this._hostLabel = undefined;
    this._fullscreenButton = undefined;
    this._onFullscreen = undefined;
    this._config = undefined;
    this._failures = 0;
  }

  set hass(hass) {
    this._hass = hass;
    if (!this._started) {
      this._started = true;
      this._boot();
    }
  }

  get hass() {
    return this._hass;
  }

  connectedCallback() {
    const rebuilt = this._root === undefined && this._started;
    this._ensureDom();
    // A panel that was navigated away from and back needs its frame again; the
    // element instance survives, the DOM it owned does not.
    if (rebuilt && this._config?.url !== undefined) this._mount(this._config.url);
    this._lockPageScroll();
    this._syncRect();
    // Home Assistant may finish laying out its chrome after this element connects.
    requestAnimationFrame(() => this._syncRect());
    window.setTimeout(() => this._syncRect(), 250);
    this._watchViewport();
  }

  disconnectedCallback() {
    // The frame is torn down with the element; the next connection rebuilds it.
    this._root = undefined;
    this._fullscreenButton = undefined;
    if (this._onFullscreen !== undefined) {
      for (const event of ["fullscreenchange", "webkitfullscreenchange"]) {
        this.ownerDocument.removeEventListener(event, this._onFullscreen);
      }
      this._onFullscreen = undefined;
    }
    this._disposeSheet?.();
    this._disposeSheet = undefined;
    this._disposeComposer?.();
    this._disposeComposer = undefined;
    this._unwatchViewport();
    this._unlockPageScroll();
  }

  /**
   * Warn iOS off the page and keep the frame on the visual viewport.
   *
   * Focusing an input inside an iframe makes Safari scroll the *outermost*
   * document to reveal it, and it does not scroll back when the keyboard
   * closes — the panel ends up shifted up with its top cut off, which is the
   * "页面跑上面去" symptom. Home Assistant's page is taller than the viewport
   * (header + this panel), so there is something for it to scroll. Taking that
   * scroll away leaves the visual viewport as the only thing that moves, which
   * `_syncRect` follows.
   */
  _lockPageScroll() {
    if (this._pageScroll !== undefined) return;
    const doc = this.ownerDocument;
    const element = doc.scrollingElement ?? doc.documentElement;
    this._pageScroll = {
      element,
      overflow: element.style.overflow,
      overscroll: element.style.overscrollBehavior,
    };
    element.style.overflow = "hidden";
    element.style.overscrollBehavior = "none";
  }

  _unlockPageScroll() {
    const lock = this._pageScroll;
    if (lock === undefined) return;
    lock.element.style.overflow = lock.overflow;
    lock.element.style.overscrollBehavior = lock.overscroll;
    this._pageScroll = undefined;
  }

  /**
   * Size and place the visible layer for the *visual* viewport.
   *
   * Home Assistant gives a custom panel no definite height, so the host element
   * stays in flow only to reserve the slot (`height: 100dvh`); the visible
   * `.root` is `position: fixed` and is placed here: on the slot's screen
   * position horizontally, and vertically from the slot's top down to the
   * bottom of the visual viewport.
   *
   * Two channels, smaller/larger wins, the way the `ai_chat` panel does it: iOS
   * reports the keyboard through `visualViewport`, some Android WebViews only
   * through `innerHeight`, and `visualViewport.height` can be the *larger* of the
   * two mid-animation. Taking the minimum keeps the composer above the keyboard
   * on both. `offsetTop` covers the iOS pan: when Safari moves the visual
   * viewport instead of resizing it, the panel follows the pan rather than
   * ending up behind the keyboard.
   */
  _syncRect() {
    if (!this.isConnected || this._root === undefined) return;
    // `overflow: hidden` on the scrolling element is the lock, but iOS still
    // scrolls the page itself when it reveals a focused field in some cases.
    // Taking it back is what keeps the slot measurement below honest.
    if ((window.scrollY ?? 0) > 1) window.scrollTo(0, 0);
    const rect = this.getBoundingClientRect();
    const viewport = window.visualViewport;
    const viewportTop = viewport?.offsetTop ?? 0;
    const viewportHeight = Math.min(viewport?.height ?? Number.POSITIVE_INFINITY, window.innerHeight);
    const viewportWidth = Math.max(viewport?.width ?? 0, window.innerWidth);
    if (rect.width < 80 || viewportHeight < 120) return;
    // Below Home Assistant's chrome while the page is at rest; at the visible top
    // once the keyboard has pulled that chrome out of the way.
    const top = Math.max(0, Math.round(rect.top - viewportTop));
    const height = Math.max(120, Math.round(viewportHeight - top));
    this._root.style.top = `${top}px`;
    this._root.style.left = `${Math.round(rect.left)}px`;
    this._root.style.width = `${Math.round(Math.max(0, Math.min(rect.width, viewportWidth - rect.left)))}px`;
    this._root.style.height = `${height}px`;
  }

  _watchViewport() {
    if (this._onViewport !== undefined) return;
    this._onViewport = () => this._syncRect();
    window.addEventListener("resize", this._onViewport);
    window.addEventListener("orientationchange", this._onViewport);
    // Scrolling is locked, but a stale offset still arrives on some devices
    // before the lock applies; a capture listener sees it before anything else.
    window.addEventListener("scroll", this._onViewport, true);
    window.visualViewport?.addEventListener("resize", this._onViewport);
    window.visualViewport?.addEventListener("scroll", this._onViewport);
    // Home Assistant finishes laying out its own chrome (and hides the tab bar
    // on scroll) without a window resize; the host's box is the signal.
    this._sizeObserver = new ResizeObserver(this._onViewport);
    this._sizeObserver.observe(this);
  }

  _unwatchViewport() {
    if (this._onViewport === undefined) return;
    window.removeEventListener("resize", this._onViewport);
    window.removeEventListener("orientationchange", this._onViewport);
    window.removeEventListener("scroll", this._onViewport, true);
    window.visualViewport?.removeEventListener("resize", this._onViewport);
    window.visualViewport?.removeEventListener("scroll", this._onViewport);
    this._sizeObserver?.disconnect();
    this._sizeObserver = undefined;
    this._onViewport = undefined;
  }

  // ------------------------------------------------------------------ shell

  _ensureDom() {
    if (this._root !== undefined || !this.isConnected) return;
    const shadow = this.shadowRoot ?? this.attachShadow({ mode: "open" });
    shadow.replaceChildren();

    const style = document.createElement("style");
    style.textContent = STYLE;

    const root = document.createElement("div");
    root.className = "root";
    root.innerHTML = `
      <div class="bar">
        <span class="dot" data-state="loading"></span>
        <span class="title">DeepSeek Harness</span>
        <span class="host"></span>
        <button data-action="reload" title="重新加载工作台" aria-label="重新加载工作台">${ICONS.reload}</button>
        <button data-action="tab" title="在新标签页打开" aria-label="在新标签页打开">${ICONS.external}</button>
        <button data-action="fullscreen" title="全屏" aria-label="全屏" data-active="false"
          ><span class="fs-icon">${ICONS.expand}</span><span class="fs-label">退出全屏</span></button
        >
      </div>
      <div class="stage">
        <div class="veil">
          <div class="spinner"></div>
          <div class="loading-text">正在连接工作台…</div>
        </div>
      </div>
    `;
    shadow.append(style, root);
    this._root = root;
    this._dot = root.querySelector(".dot");
    this._hostLabel = root.querySelector(".host");
    this._stage = root.querySelector(".stage");
    this._veil = root.querySelector(".veil");
    this._titleLabel = root.querySelector(".title");
    this._fullscreenButton = root.querySelector('[data-action="fullscreen"]');

    root.addEventListener("click", (event) => {
      const button = event.target.closest?.("button[data-action]");
      if (button === null || button === undefined) return;
      this._action(button.dataset.action);
    });
    // The element survives a navigation away and back, so the listener is
    // dropped before it is added again instead of piling up per rebuild.
    this._onFullscreen ??= () => this._syncFullscreenIcon();
    for (const event of ["fullscreenchange", "webkitfullscreenchange"]) {
      this.ownerDocument.removeEventListener(event, this._onFullscreen);
      this.ownerDocument.addEventListener(event, this._onFullscreen);
    }
    this._syncFullscreenIcon();
  }

  _setState(state) {
    if (this._dot !== undefined) this._dot.dataset.state = state;
  }

  /**
   * Which sidebar entry this panel is, as Home Assistant reports it.
   *
   * Several Harness hosts can be configured, one panel each, and the path is how
   * the backend knows which host this frame belongs to. `hass.panelUrl` is the
   * value Home Assistant sets; the URL segment covers the standalone test page,
   * where there is no `hass.panelUrl`, and `?panel=` overrides both.
   */
  _panelPath() {
    const override = new URLSearchParams(window.location.search).get("panel");
    if (override !== null && override !== "") return override;
    const panelUrl = this._hass?.panelUrl;
    if (typeof panelUrl === "string" && panelUrl !== "") return panelUrl;
    const segments = window.location.pathname.split("/").filter(Boolean);
    return segments.length === 0 ? "" : segments[segments.length - 1];
  }

  async _boot() {
    this._ensureDom();
    let payload;
    try {
      payload = await this._hass.callWS({
        type: "dsh_harness/panel",
        panel_path: this._panelPath(),
      });
    } catch (error) {
      this._showError("无法读取工作台地址", `Home Assistant 拒绝了面板请求：${describeError(error)}`);
      return;
    }
    this._config = payload;
    if (this._titleLabel !== undefined && typeof payload.title === "string" && payload.title !== "") {
      this._titleLabel.textContent = payload.title;
    }
    if (this._hostLabel !== undefined) {
      this._hostLabel.textContent = payload.host ?? "";
    }
    if (payload.available !== true) {
      this._showError(
        "工作台插件没有响应",
        `DeepSeek Harness 正在 ${payload.host ?? "?"} 上运行，但 <code>ha-workbench</code> 插件没有在` +
          ` <code>43132</code> 端口回答。请在 DSH 的 <code>web</code> profile 里安装并启用` +
          ` <code>@local/ha-workbench</code>，然后点“重试”。`,
      );
      return;
    }
    this._mount(payload.url);
  }

  _mount(url) {
    const previous = this._stage.querySelector("iframe");
    previous?.remove();
    const iframe = document.createElement("iframe");
    iframe.setAttribute("title", "DeepSeek Harness");
    iframe.setAttribute("allow", "clipboard-read; clipboard-write; fullscreen");
    iframe.addEventListener("load", () => {
      this._installFrameStyles(iframe);
      this._installSheetDismiss(iframe);
      this._installComposerGuard(iframe);
      this._reveal();
    });
    iframe.src = url;
    this._stage.prepend(iframe);
    this._iframe = iframe;
    this._setState("loading");
    this._showVeil(`<div class="spinner"></div><div class="loading-text">正在启动工作台…</div>`);
    // A failed cross-origin load fires no useful event; the veil is what tells
    // the user something is wrong when nothing paints.
    window.clearTimeout(this._revealTimer);
    this._revealTimer = window.setTimeout(() => {
      if (this._veil !== undefined && !this._veil.hidden && this._veil.dataset.fading !== "true") {
        this._setState("error");
      }
    }, 20000);
  }

  _reveal() {
    window.clearTimeout(this._revealTimer);
    this._setState("ready");
    if (this._veil === undefined) return;
    this._veil.dataset.fading = "true";
    window.setTimeout(() => {
      if (this._veil !== undefined) this._veil.hidden = true;
    }, 240);
  }

  /**
   * Hand the framed document the rules Harness does not ship.
   *
   * `proxy` mode serves the workbench from Home Assistant's own origin, so the
   * frame's document is reachable and a style tag can be appended; `direct`
   * mode frames another origin (the PC on port 43132) and the read throws —
   * that is a supported configuration, it just keeps the desktop layout.
   *
   * Injected once per load: the workbench is a single-page app, so internal
   * navigation never replaces the document the tag lives in.
   */
  _installFrameStyles(iframe) {
    let framed;
    try {
      framed = iframe.contentDocument;
    } catch {
      return;
    }
    if (framed === null || framed === undefined || framed.documentElement === null) return;
    if (framed.getElementById(INJECTED_STYLE_ID) !== null) return;
    const style = framed.createElement("style");
    style.id = INJECTED_STYLE_ID;
    style.textContent = MOBILE_CSS;
    framed.head.append(style);
  }

  /**
   * Let a tap on the conversation put the session sheet away.
   *
   * On a phone Harness opens its sidebar as a 280px sheet (see `MOBILE_CSS`).
   * Closing it meant reaching for the small collapse control at the top of a
   * full-height list; the phone idiom is to tap the dimmed area beside it. This
   * installs that scrim over the conversation and removes it when the sheet
   * closes, so the sheet is dismissed by whichever gesture the user reaches for
   * first.
   *
   * Both ways out — the scrim and the collapse control itself — run the same
   * exit: the sheet slides off (`dsh-ha-sheet-out`), then the control is pressed
   * for real, so Harness still owns the state and its own transition follows.
   * Pressing the control first would flip the attribute and the sheet would be
   * gone before any animation could run.
   *
   * The scrim is built here rather than injected as a script: `proxy` mode is
   * same-origin, so this element can own the framed document's DOM directly and
   * nothing has to execute inside the app's page. `direct` mode throws on the
   * read and simply keeps the collapse control.
   */
  _installSheetDismiss(iframe) {
    let framed;
    try {
      framed = iframe.contentDocument;
    } catch {
      return;
    }
    const view = framed?.defaultView;
    if (framed === null || framed === undefined || view === null || framed.body === null) return;

    this._disposeSheet?.();

    const scrim = framed.createElement("div");
    scrim.id = SCRIM_ID;
    scrim.setAttribute("aria-hidden", "true");

    const sheetOpen = () => framed.querySelector('[data-dsh-sidebar-wide="true"]') !== null;
    const phoneWidth = () => view.matchMedia("(max-width: 720px)").matches;
    const column = () => framed.querySelector('[class*="_frame"] > [class*="sidebarCol"]');
    let closing = false;
    let allowNextClick = false;

    /** Slide the sheet out, then press Harness's own control. */
    const close = () => {
      if (closing) return;
      const control = collapseControl(framed);
      if (control === null) return;
      const target = column();
      closing = true;
      target?.classList.add(SHEET_OUT_CLASS);
      framed.getElementById(SCRIM_ID)?.setAttribute("data-closing", "true");
      // A failsafe only: normally the observer clears the class when the sheet
      // really closes, one frame later, so the reset is never visible.
      view.setTimeout(() => target?.classList.remove(SHEET_OUT_CLASS), SHEET_OUT_MS + 260);
      view.setTimeout(() => {
        closing = false;
        allowNextClick = true;
        control.click();
        allowNextClick = false;
      }, SHEET_OUT_MS);
    };

    scrim.addEventListener(
      "pointerdown",
      (event) => {
        // The tap is the dismissal, not a tap on whatever the sheet was covering.
        event.preventDefault();
        event.stopPropagation();
        close();
      },
      true,
    );

    // The collapse control lives inside the sheet; intercept it so it animates
    // too. The replayed click is recognised by `allowNextClick` and passes.
    const onClick = (event) => {
      if (allowNextClick) {
        allowNextClick = false;
        return;
      }
      if (!phoneWidth() || !sheetOpen()) return;
      if (event.target?.closest?.(COLLAPSE_CONTROL) === null) return;
      if (event.target?.closest?.(COLLAPSE_CONTROL) === undefined) return;
      event.preventDefault();
      event.stopPropagation();
      close();
    };
    framed.addEventListener("click", onClick, true);

    const sync = () => {
      const open = sheetOpen();
      const wanted = phoneWidth() && open;
      if (wanted && scrim.parentNode === null) framed.body.append(scrim);
      else if (!wanted && scrim.parentNode !== null) scrim.remove();
      // The sheet is back in the grid; the exit transforms must not outlive it.
      if (!open) column()?.classList.remove(SHEET_OUT_CLASS);
    };

    // The sheet opens and closes by react state, so the scrim follows the two
    // attributes that state renders: the sidebar root's `wide` flag and the
    // frame's `collapsed` flag.
    const observer = new view.MutationObserver(sync);
    observer.observe(framed.documentElement, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["data-dsh-sidebar-wide", "data-sidebar-collapsed"],
    });
    view.addEventListener("resize", sync);
    sync();

    this._disposeSheet = () => {
      observer.disconnect();
      framed.removeEventListener("click", onClick, true);
      view.removeEventListener("resize", sync);
      scrim.remove();
    };
  }

  /**
   * Keep the conversation anchored while the keyboard is up.
   *
   * Focusing the composer shrinks the frame (the panel ends at the visual
   * viewport bottom), but the message list keeps its scroll offset — so the last
   * reply slides out of view exactly when the user starts typing under it. The
   * `ai_chat` panel hit the same thing and answered it on the input itself
   * (`onFocus` → scroll the list to the bottom); this is the same move for a
   * document the panel does not own: react to `focusin`, find the scrolling
   * list and pin it to the bottom.
   *
   * Repeated after the keyboard animation settles, and again on every visual
   * viewport resize while an input is focused, because iOS finishes the resize
   * long after focus: the list would otherwise be "scrolled to bottom" of a
   * height that no longer exists.
   */
  _installComposerGuard(iframe) {
    let framed;
    try {
      framed = iframe.contentDocument;
    } catch {
      return;
    }
    const view = framed?.defaultView;
    if (framed === null || framed === undefined || view === null) return;

    this._disposeComposer?.();

    const editableOf = (node) => {
      const element = node?.closest?.('textarea, [contenteditable="true"], [contenteditable=""]');
      if (element === null || element === undefined) return null;
      // Only the composer: a search box in the sheet is none of this business.
      return element.closest('[class*="centerCol"]') === null ? null : element;
    };

    const anchor = () => {
      // iOS can scroll the frame's own document out from under everything when
      // it reveals a focused field; the app scrolls its list, not the document.
      const documentScroller = framed.scrollingElement;
      if (documentScroller !== null && documentScroller !== undefined && documentScroller.scrollTop !== 0) {
        documentScroller.scrollTop = 0;
      }
      const list = conversationScroller(framed);
      if (list !== null) list.scrollTop = list.scrollHeight;
    };

    const timers = [];
    const anchorSoon = () => {
      anchor();
      timers.push(view.setTimeout(anchor, 120), view.setTimeout(anchor, 360));
    };

    const onFocusIn = (event) => {
      if (editableOf(event.target) === null) return;
      anchorSoon();
    };

    const onViewportChange = () => {
      if (editableOf(framed.activeElement) === null) return;
      anchor();
      timers.push(view.setTimeout(anchor, 160));
    };

    framed.addEventListener("focusin", onFocusIn, true);
    view.visualViewport?.addEventListener("resize", onViewportChange);

    this._disposeComposer = () => {
      framed.removeEventListener("focusin", onFocusIn, true);
      view.visualViewport?.removeEventListener("resize", onViewportChange);
      for (const timer of timers.splice(0)) view.clearTimeout(timer);
    };
  }

  _showVeil(html) {
    if (this._veil === undefined) return;
    this._veil.hidden = false;
    this._veil.dataset.fading = "false";
    this._veil.innerHTML = html;
  }

  _showError(title, text) {
    this._setState("error");
    this._showVeil(`
      <div class="error-title">${title}</div>
      <div class="error-text">${text}</div>
      <div class="error-actions">
        <button class="flat primary" data-action="retry">重试</button>
        <button class="flat" data-action="tab">在新标签页打开</button>
      </div>
    `);
  }

  // ----------------------------------------------------------------- actions

  _action(action) {
    switch (action) {
      case "reload":
        this._reload();
        break;
      case "retry":
        this._retry();
        break;
      case "tab":
        this._openTab();
        break;
      case "fullscreen":
        this._toggleFullscreen();
        break;
      default:
        break;
    }
  }

  _reload() {
    if (this._iframe?.src) {
      // Bypassing the frame cache matters after a Harness restart: the page
      // holds a dead connection and no longer reconnects on its own.
      const url = new URL(this._iframe.src, window.location.href);
      url.searchParams.set("_r", String(Date.now()));
      this._iframe.src = url.toString();
      this._setState("loading");
      this._showVeil(`<div class="spinner"></div><div class="loading-text">正在重新加载…</div>`);
      return;
    }
    this._retry();
  }

  async _retry() {
    this._setState("loading");
    this._showVeil(`<div class="spinner"></div><div class="loading-text">正在连接工作台…</div>`);
    try {
      const payload = await this._hass.callWS({ type: "dsh_harness/panel" });
      this._config = payload;
      if (payload.available !== true) {
        this._failures += 1;
        this._showError(
          "工作台插件没有响应",
          `插件 <code>@local/ha-workbench</code> 没有在 ${payload.host ?? "?"} 的 <code>43132</code>` +
            ` 端口回答。（已重试 ${this._failures} 次）`,
        );
        return;
      }
      this._mount(payload.url);
    } catch (error) {
      this._showError("无法读取工作台地址", describeError(error));
    }
  }

  _openTab() {
    const url = this._config?.url;
    if (url === undefined) return;
    window.open(url, "_blank", "noopener,noreferrer");
  }

  /**
   * The document's fullscreen element, whichever vendor prefix provides it.
   *
   * In the real Home Assistant shell this is **not** the panel: asking for
   * fullscreen on an element that sits inside Home Assistant's shadow tree
   * promotes the request to the document root (`HOME-ASSISTANT`), so a check of
   * `fullscreenElement === this` never matches and the button could only ever
   * ask again. Any fullscreen element means "we are fullscreen, and this
   * document is the thing to exit".
   */
  _fullscreenElement() {
    const doc = this.ownerDocument;
    return doc.fullscreenElement ?? doc.webkitFullscreenElement ?? null;
  }

  _toggleFullscreen() {
    const doc = this.ownerDocument;
    if (this._fullscreenElement() !== null) {
      const exit = doc.exitFullscreen ?? doc.webkitExitFullscreen;
      try {
        void Promise.resolve(exit?.call(doc)).catch(() => {});
      } catch {
        /* the browser refused; the button stays as it is */
      }
      return;
    }
    const request = this.requestFullscreen ?? this.webkitRequestFullscreen;
    try {
      void Promise.resolve(request?.call(this)).catch(() => {});
    } catch {
      /* same: nothing to report, the icon simply does not change */
    }
  }

  _syncFullscreenIcon() {
    const button = this._fullscreenButton;
    if (button === undefined) return;
    const active = this._fullscreenElement() !== null;
    const label = active ? "退出全屏" : "全屏";
    button.dataset.active = String(active);
    button.title = label;
    button.setAttribute("aria-label", label);
    const icon = button.querySelector(".fs-icon");
    if (icon !== null) icon.innerHTML = active ? ICONS.collapse : ICONS.expand;
  }
}

/**
 * The control that collapses (or reopens) the sidebar.
 *
 * The label is localized ("收起侧边栏" / "Collapse sidebar") and the class name is
 * hashed per build, so the label is tried first and the class is the fallback.
 * `null` means Harness changed both — the sheet then stays open, which is
 * exactly the behaviour before the scrim existed.
 */
function collapseControl(doc) {
  const root = doc.querySelector("[data-dsh-sidebar-root]");
  if (root === null) return null;
  return root.querySelector(COLLAPSE_CONTROL);
}

/**
 * The scrolling element of the conversation, found by shape rather than by name.
 *
 * Harness renders the message list inside the centre column with its own
 * overflow, and the class names are hashed per build. The list is simply the
 * deepest element that actually overflows vertically and is not the sheet.
 */
function conversationScroller(doc) {
  const center = doc.querySelector('[class*="centerCol"]');
  if (center === null) return null;
  let best = null;
  let bestOverflow = 8;
  for (const element of center.querySelectorAll("*")) {
    const overflow = element.scrollHeight - element.clientHeight;
    if (overflow <= bestOverflow) continue;
    const style = doc.defaultView.getComputedStyle(element);
    if (!/(auto|scroll)/.test(style.overflowY)) continue;
    best = element;
    bestOverflow = overflow;
  }
  return best;
}

/** Home Assistant errors are `{code, message}` objects; never print `[object Object]`. */
function describeError(error) {
  if (error === null || error === undefined) return "未知错误";
  if (typeof error === "string") return error;
  if (typeof error.message === "string" && error.message !== "") return error.message;
  if (typeof error.error === "string") return error.error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

if (!customElements.get(ELEMENT)) {
  customElements.define(ELEMENT, DshHarnessPanel);
}
