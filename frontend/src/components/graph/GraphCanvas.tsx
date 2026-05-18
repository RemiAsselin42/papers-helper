import { useEffect, useMemo, useRef } from 'react'
import cytoscape, { type Core, type ElementDefinition, type Layouts } from 'cytoscape'
import d3Force from 'cytoscape-d3-force'
import type { GraphData } from '../../api/graph'
import { categoryThemeColor } from '../../utils/categoryColor'
import type { FilterState } from './GraphFilters'
import styles from './GraphCanvas.module.scss'
import {
  buildLayout,
  buildStylesheet,
  edgeLabel,
  nodeColor,
  resolveTheme,
  truncateLabel,
} from './GraphCanvas.styles'

// Register the d3-force layout once. cytoscape.use is idempotent so HMR is
// safe. d3-force gives Obsidian-style physics: every node carries a charge
// and repels every other node with a force that falls off in 1/r². Edges
// are springs that pull connected nodes together. Cluster separation
// emerges naturally from the physics — no constraint tuning needed.
cytoscape.use(d3Force)

export interface CanvasPosition {
  x: number
  y: number
}

interface Props {
  graph: GraphData
  filters: FilterState
  selectedNodeId: string | null
  onNodeClick: (nodeId: string, position: CanvasPosition) => void
  onBackgroundClick: () => void
  /** Fires whenever the selected node's *rendered* position changes (pan,
   * zoom, layout move) so the parent's popover stays anchored to it. */
  onSelectedPositionChange?: (position: CanvasPosition | null) => void
}

export function GraphCanvas({
  graph,
  filters,
  selectedNodeId,
  onNodeClick,
  onBackgroundClick,
  onSelectedPositionChange,
}: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const cyRef = useRef<Core | null>(null)
  // Currently running cola simulation. Held in a ref so we can stop it when
  // the element set changes (then start a fresh one) or when we unmount.
  const layoutRef = useRef<Layouts | null>(null)
  // Stash the latest callback in a ref so the long-lived cytoscape event
  // listener doesn't need to be re-registered on every parent render.
  const onPosChangeRef = useRef(onSelectedPositionChange)
  onPosChangeRef.current = onSelectedPositionChange
  const onNodeClickRef = useRef(onNodeClick)
  onNodeClickRef.current = onNodeClick
  const onBackgroundClickRef = useRef(onBackgroundClick)
  onBackgroundClickRef.current = onBackgroundClick

  // Convert backend graph → cytoscape elements, honouring filters.
  const elements: ElementDefinition[] = useMemo(() => {
    const theme = resolveTheme()
    const visibleNodeIds = new Set(
      graph.nodes.filter((n) => filters[n.type]).map((n) => n.id)
    )

    const nodeEls: ElementDefinition[] = graph.nodes
      .filter((n) => visibleNodeIds.has(n.id))
      .map((n) => ({
        data: {
          id: n.id,
          // Truncated label for the canvas — the popover shows the full one.
          label: truncateLabel(n.label, n.type),
          nodeType: n.type,
          // Theme nodes derive their colour from the category name so the
          // graph stays visually consistent with the modal pills and filter
          // swatch. Other types use the static per-type colour.
          color: n.type === 'theme' ? categoryThemeColor(n.label) : nodeColor(n.type, theme),
        },
      }))

    const edgeEls: ElementDefinition[] = graph.edges
      .filter((e) => {
        if (!visibleNodeIds.has(e.source) || !visibleNodeIds.has(e.target)) return false
        if (e.type === 'semantic' && e.weight < filters.semanticThreshold) return false
        return true
      })
      .map((e, i) => ({
        data: {
          id: `e_${i}`,
          source: e.source,
          target: e.target,
          edgeType: e.type,
          weight: e.weight,
          // Pre-computed so the `.edge-hovered` style can show it via
          // `label: data(edgeLabel)` without React touching cytoscape on hover.
          edgeLabel: edgeLabel(e.type, e.weight),
        },
      }))

    return [...nodeEls, ...edgeEls]
  }, [graph, filters])

  // Mount cytoscape once; subsequent renders update the elements.
  useEffect(() => {
    if (!containerRef.current) return
    const cy = cytoscape({
      container: containerRef.current,
      elements,
      style: buildStylesheet(resolveTheme()),
      // Skip cytoscape's default { name: 'grid', rows: 1 } that would scatter
      // nodes in a wide row across the canvas before d3-force overrides them
      // on the first tick. The 'null' preset is the documented no-op layout.
      layout: { name: 'null' },
      // Pan/zoom feel: bump wheel sensitivity so the zoom step is responsive,
      // and clamp the range so users can't accidentally zoom to micro/macro.
      wheelSensitivity: 0.5,
      minZoom: 0.2,
      maxZoom: 4,
    })

    cy.on('tap', 'node', (evt) => {
      const node = evt.target
      const id = node.id() as string
      const rendered = node.renderedPosition()
      // Viewport coords so the popover anchors correctly via position:fixed.
      const rect = containerRef.current?.getBoundingClientRect()
      const offsetX = rect?.left ?? 0
      const offsetY = rect?.top ?? 0
      onNodeClickRef.current(id, { x: rendered.x + offsetX, y: rendered.y + offsetY })
    })
    cy.on('tap', (evt) => {
      if (evt.target === cy) onBackgroundClickRef.current()
    })

    // Edge hover — toggle a class that cytoscape's stylesheet picks up to
    // emphasize the line and show its semantic label. No React re-render
    // involved; everything stays inside cytoscape for smooth feedback.
    cy.on('mouseover', 'edge', (evt) => {
      evt.target.addClass('edge-hovered')
    })
    cy.on('mouseout', 'edge', (evt) => {
      evt.target.removeClass('edge-hovered')
    })

    cyRef.current = cy
    // Kick off the continuous physics simulation. The first `layoutstop`
    // fires once the initial settle completes (`progress >= 1` inside
    // cytoscape-d3-force) — we fit the viewport exactly there so the user
    // sees the equilibrium framed, not a transient mid-explosion frame.
    // `.one()` ensures subsequent grab-driven restarts don't re-fit. Filter
    // toggles call `buildLayout(cy, false)` in a separate effect and never
    // subscribe here, so the user's pan/zoom survives toggles.
    const layout = buildLayout(cy)
    layout.one('layoutstop', () => {
      cyRef.current?.fit(undefined, 40)
    })
    layoutRef.current = layout
    layout.run()

    return () => {
      layoutRef.current?.stop()
      layoutRef.current = null
      cy.destroy()
      cyRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Element set changed (new graph data, filter toggled, threshold moved).
  // Restart the physics so the new graph finds its own equilibrium — but
  // preserve existing positions (`randomize: false`) so filter toggles don't
  // scramble the canvas; only newly added nodes get a fresh placement.
  useEffect(() => {
    const cy = cyRef.current
    if (!cy) return
    layoutRef.current?.stop()
    cy.batch(() => {
      cy.elements().remove()
      cy.add(elements)
    })
    layoutRef.current = buildLayout(cy, false)
    layoutRef.current.run()
  }, [elements])

  // Highlight selection + dim the rest, AND keep the popover anchored to the
  // selected node by emitting its rendered position on every viewport change.
  //
  // Side effect: when a node gets selected we *stop* the d3-force simulation
  // so the popover doesn't follow a still-moving node (the previous infinite
  // physics kept jiggling under the popover, which felt awful). On deselect
  // we resume the simulation with `randomize: false` so all current
  // positions are preserved — only the physics restarts.
  useEffect(() => {
    const cy = cyRef.current
    if (!cy) return
    cy.elements().removeClass('highlighted dimmed')

    if (!selectedNodeId) {
      onPosChangeRef.current?.(null)
      // Resume continuous physics if it was paused by a previous selection.
      // Idempotent: if the layout is already running, stop() + run() simply
      // restarts it from current positions, which is what we want anyway.
      if (!layoutRef.current) {
        layoutRef.current = buildLayout(cy, false)
        layoutRef.current.run()
      }
      return
    }
    const sel = cy.getElementById(selectedNodeId)
    if (!sel || sel.empty()) {
      onPosChangeRef.current?.(null)
      return
    }
    // Freeze the physics while a node is selected — every tick would move the
    // node out from under the popover otherwise.
    layoutRef.current?.stop()
    layoutRef.current = null

    const neighborhood = sel.closedNeighborhood()
    cy.elements().not(neighborhood).addClass('dimmed')
    sel.addClass('highlighted')

    const emitPos = () => {
      const node = cy.getElementById(selectedNodeId)
      if (!node || node.empty()) {
        onPosChangeRef.current?.(null)
        return
      }
      const rendered = node.renderedPosition()
      // Convert from cytoscape-container coords to *viewport* coords so the
      // popover (portaled into <body> with `position: fixed`) anchors
      // correctly outside `.canvas`'s overflow:hidden clip.
      const rect = containerRef.current?.getBoundingClientRect()
      const offsetX = rect?.left ?? 0
      const offsetY = rect?.top ?? 0
      onPosChangeRef.current?.({ x: rendered.x + offsetX, y: rendered.y + offsetY })
    }
    emitPos()
    cy.on('pan zoom render position', emitPos)
    // The cytoscape events catch internal moves; a browser-level resize
    // moves the canvas itself, so we listen to that too.
    window.addEventListener('resize', emitPos)
    return () => {
      cy.off('pan zoom render position', emitPos)
      window.removeEventListener('resize', emitPos)
    }
  }, [selectedNodeId])

  return (
    <div ref={containerRef} className={styles.canvas} role="img" aria-label="Knowledge graph" />
  )
}
