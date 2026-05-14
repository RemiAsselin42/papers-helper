// cytoscape-d3-force ships no types and `@types/cytoscape-d3-force` does not
// exist on npm. We only consume the default export as a cytoscape extension
// plugin passed to `cytoscape.use()`; the layout options go through the
// generic `cytoscape.LayoutOptions` cast at call sites.
declare module 'cytoscape-d3-force' {
  import type { Ext } from 'cytoscape'
  const d3Force: Ext
  export default d3Force
}
