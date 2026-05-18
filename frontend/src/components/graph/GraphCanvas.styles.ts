import cytoscape, { type Core, type Layouts } from 'cytoscape'
import type { GraphNodeType } from '../../api/graph'
import { legacyHsl } from '../../utils/hsl'

// Per-edge-type spring rest length. With charge repulsion doing most of the
// spacing work, these can be shorter than cola required: the charge pushes
// non-adjacent nodes away, while the springs only need to keep direct
// neighbours together.
const EDGE_LENGTH: Record<string, number> = {
  authored_by: 80,
  category_of: 90,
  concept_of: 90,
  co_authored: 120,
  semantic: 200,
}

// Per-type label budgets — papers carry titles that can easily exceed 100
// characters, the others are tighter (slugs/short names). Truncating the
// data fed to cytoscape keeps dense areas readable; the full label is still
// shown in the popover (which receives the un-truncated `node.label`).
const LABEL_MAX_CHARS: Record<GraphNodeType, number> = {
  paper: 60,
  author: 30,
  category: 30,
  concept: 30,
}

const NODE_COLOR_VAR: Record<GraphNodeType, string> = {
  paper: '--color-accent',
  author: '--color-emphasis-2',
  category: '--color-success',
  concept: '--color-error',
}

/** Theme tokens consumed by the cytoscape stylesheet. Resolved from CSS vars
 * at mount because cytoscape paints to a `<canvas>` and can't read `var(...)`
 * from the DOM. */
export interface GraphTheme {
  background: string
  surface: string
  text: string
  textMuted: string
  border: string
  emphasis2: string
  success: string
  error: string
  nodeFill: Record<GraphNodeType, string>
}

function _readVar(name: string, fallback: string): string {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  return v || fallback
}

export function resolveTheme(): GraphTheme {
  return {
    background: _readVar('--color-background', '#fefae0'),
    surface: _readVar('--color-surface', '#faedcd'),
    text: _readVar('--color-text', '#2c2416'),
    textMuted: _readVar('--color-text-muted', '#7a6e5f'),
    border: _readVar('--color-border', '#2c2416'),
    emphasis2: _readVar('--color-emphasis-2', '#d4a373'),
    success: _readVar('--color-success', '#628f4b'),
    error: _readVar('--color-error', '#b85c38'),
    nodeFill: {
      paper: _readVar(NODE_COLOR_VAR.paper, '#ccd5ae'),
      author: _readVar(NODE_COLOR_VAR.author, '#d4a373'),
      category: _readVar(NODE_COLOR_VAR.category, '#628f4b'),
      concept: _readVar(NODE_COLOR_VAR.concept, '#b85c38'),
    },
  }
}

export function nodeColor(type: GraphNodeType, theme: GraphTheme): string {
  return theme.nodeFill[type]
}

/** Stable fill colour for a Louvain community index. Hues rotate by the
 * golden angle so consecutive indices land far apart on the wheel.
 *
 * Hue alone is not enough: golden-angle steps still leave many index pairs
 * only ~12-20° apart (e.g. communities 0 and 13), and at a fixed
 * saturation/lightness the eye cannot separate two reds — so a lone cluster
 * ends up the same colour as an unrelated connected one. Rotating saturation
 * and lightness across three tiers gives every near-hue pair a second
 * distinguishing channel; all tiers stay dark/saturated enough to read on
 * the cream canvas. */
export function communityColor(index: number): string {
  const i = Math.max(0, Math.floor(index))
  const hue = (i * 137.508) % 360
  const tier = i % 3
  const sat = [68, 52, 62][tier]
  const light = [44, 62, 53][tier]
  // `legacyHsl` emits the comma-separated form cytoscape's colour parser
  // requires; the modern space-separated syntax renders grey.
  return legacyHsl(hue.toFixed(1), sat, light)
}

/** Render a CSL-shaped author record as "Nom, Prénom" (bibliographic
 * convention). Returns `null` when the value doesn't look like a CSL name,
 * so callers can fall back to their default formatting. */
export function formatCslName(value: unknown): string | null {
  if (!value || typeof value !== 'object') return null
  const rec = value as Record<string, unknown>
  const family = typeof rec.family === 'string' ? rec.family.trim() : ''
  const given = typeof rec.given === 'string' ? rec.given.trim() : ''
  if (family && given) return `${family}, ${given}`
  if (family) return family
  if (given) return given
  if (typeof rec.literal === 'string') return rec.literal.trim() || null
  if (typeof rec.name === 'string') return rec.name.trim() || null
  return null
}

// Author labels sometimes arrive as a serialized CSL record
// (`{"family":"Nom","given":"Prenom"}`) when the upstream `.bib` parser
// couldn't flatten the name. We unwrap them to "Nom, Prénom" instead of
// raw JSON.
function _cleanAuthorLabel(label: string): string {
  const trimmed = label.trim()
  if (!trimmed.startsWith('{')) return trimmed
  try {
    const formatted = formatCslName(JSON.parse(trimmed))
    if (formatted) return formatted
  } catch {
    // Not JSON — fall through to brace-stripping below.
  }
  return trimmed.replace(/[{}]/g, '')
}

/** Display-only cleanup applied everywhere graph labels surface (canvas,
 * popover, footer). Paper/category/concept titles often carry BibTeX braces
 * (`{Vergleich}` for protected casing) which we strip; author labels may
 * still be in their CSL JSON form, which we flatten to "Prenom Nom". */
export function cleanLabel(label: string, type: GraphNodeType): string {
  if (type === 'author') return _cleanAuthorLabel(label)
  return label.replace(/[{}]/g, '')
}

export function truncateLabel(label: string, type: GraphNodeType): string {
  const cleaned = cleanLabel(label, type)
  const cap = LABEL_MAX_CHARS[type] ?? 30
  if (cleaned.length <= cap) return cleaned
  return `${cleaned.slice(0, cap - 1).trimEnd()}…`
}

// Human-readable hover labels for edges. Weight gets formatted into the
// label so hover surfaces it without needing the side panel.
export function edgeLabel(type: string, weight: number): string {
  switch (type) {
    case 'authored_by':
      return 'écrit par'
    case 'co_authored':
      return weight > 1 ? `co-auteurs ×${weight.toFixed(0)}` : 'co-auteurs'
    case 'category_of':
      return 'catégorie'
    case 'concept_of':
      return 'concept'
    case 'semantic':
      return `similarité ${weight.toFixed(2)}`
    default:
      return type
  }
}

// Build (but don't run) a fresh d3-force layout configured for an
// Obsidian-style feel: every node carries a charge that pushes other nodes
// away in 1/r², edges are springs with per-type rest length, collision keeps
// disks from overlapping. Cluster separation emerges from the charge force
// without explicit tuning.
//
// IMPORTANT: cytoscape-d3-force does NOT pass cytoscape NodeSingular /
// EdgeSingular instances to accessor callbacks — it passes the raw d3-force
// node/link objects, which are plain objects with cytoscape `data()` fields
// merged in as top-level properties (see cytoscape-d3-force/src/d3-force.js
// where `_forcenodes` and `_forceedges` are built from `n.data()` /
// `e.data()`). Calling `.data('foo')` on these would throw
// `node.data is not a function`. We read top-level properties instead.
export function buildLayout(cy: Core, randomize: boolean = true): Layouts {
  return cy.layout({
    name: 'd3-force',
    animate: true,
    // Keep the simulation alive — nodes keep nudging each other and react
    // smoothly to drags. Alpha never fully decays.
    infinite: true,
    // Single deterministic fit happens on `layoutstop` from GraphCanvas.tsx;
    // per-tick fit would jitter the viewport.
    fit: false,
    // First mount uses randomize=true to spread the initial pile within the
    // library default bbox (full canvas); resumes after a selection pause
    // pass randomize=false so positions are kept.
    randomize,
    // ── Charge / repulsion (manyBody) ──
    // -600 spreads connected components visibly without detonating the
    // cluster the way -800 used to. Pair with distanceMax 500 so the
    // charge still reaches across mid-sized graphs (≲ 500 px diameter).
    manyBodyStrength: -900,
    manyBodyDistanceMax: 700,
    // ── Link springs ──
    linkId: (d: { id: string }) => d.id,
    linkDistance: (edge: { edgeType?: string }) => {
      const t = edge.edgeType ?? ''
      return EDGE_LENGTH[t] ?? 120
    },
    linkStrength: 0.6,
    linkIterations: 1,
    // ── Collide (radius-based overlap prevention) ──
    // Paper nodes are 34px diameter, others 22px. Buffer of 8-12px keeps
    // disks visibly apart.
    collideRadius: (node: { nodeType?: string }) => (node.nodeType === 'paper' ? 28 : 22),
    collideStrength: 0.8,
    collideIterations: 1,
    // ── Velocity / alpha tuning ──
    // d3 defaults: velocityDecay 0.4, alphaDecay 0.0228. We used to tweak
    // both to fight a too-strong charge, but with -300 they no longer need
    // damping — the defaults give a clean settle and the springs have time
    // to reach rest length before alpha drops below alphaMin.
    velocityDecay: 0.4,
    alpha: 1,
    alphaMin: 0.001,
    alphaDecay: 0.0228,
    alphaTarget: 0,
  } as cytoscape.LayoutOptions)
}

export function buildStylesheet(theme: GraphTheme): cytoscape.StylesheetJson {
  return [
    {
      selector: 'node',
      style: {
        'background-color': 'data(color)',
        label: 'data(label)',
        color: theme.text,
        'font-size': '14px',
        'font-weight': 500,
        // Auto-hide labels when zoomed out far — below ~9px effective
        // pixel size, the text becomes noise rather than information.
        'min-zoomed-font-size': 9,
        'text-valign': 'bottom',
        'text-halign': 'center',
        'text-margin-y': 8,
        'text-wrap': 'wrap',
        'text-max-width': '180px',
        'text-background-color': theme.surface,
        'text-background-opacity': 0,
        'text-background-padding': '2px',
        'text-background-shape': 'roundrectangle',
        'border-width': 1.5,
        'border-color': theme.border,
        width: 22,
        height: 22,
      },
    },
    {
      selector: 'node[nodeType = "paper"]',
      style: { width: 34, height: 34 },
    },
    {
      // Secondary nodes — smaller label so papers stay the primary visual
      // focus when the user scans a dense area.
      selector: 'node[nodeType != "paper"]',
      style: { 'font-size': '12px' },
    },
    {
      selector: 'edge',
      style: {
        width: 1.5,
        'line-color': theme.textMuted,
        'curve-style': 'bezier',
        opacity: 0.6,
        // Wider invisible padding around the edge so the user doesn't
        // have to land the cursor exactly on the 1.5px line to hover.
        'overlay-padding': 8,
        'overlay-opacity': 0,
      },
    },
    {
      selector: 'edge[edgeType = "semantic"]',
      style: {
        'line-style': 'dashed',
        'line-color': theme.success,
      },
    },
    {
      selector: 'edge[edgeType = "co_authored"]',
      style: { 'line-color': theme.emphasis2, width: 2.5 },
    },
    {
      // Edge under the cursor — thicker, fully opaque, and label visible.
      selector: 'edge.edge-hovered',
      style: {
        width: 4,
        opacity: 1,
        'line-color': theme.error,
        label: 'data(edgeLabel)',
        'font-size': '11px',
        'font-weight': 500,
        color: theme.text,
        'text-rotation': 'autorotate',
        'text-background-color': theme.surface,
        'text-background-opacity': 0,
        'text-background-padding': '3px',
        'text-background-shape': 'roundrectangle',
        'text-border-color': theme.border,
        'text-border-opacity': 0.4,
        'text-border-width': 1,
        'z-index': 100,
      },
    },
    {
      selector: '.highlighted',
      style: { 'border-width': 4, 'border-color': theme.error },
    },
    {
      selector: '.dimmed',
      style: { opacity: 0.15 },
    },
  ] as cytoscape.StylesheetJson
}
