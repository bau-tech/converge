// Rolldown's CJS interop for react-plotly.js can resolve the default export
// to the module's exports object ({ __esModule, default: Component }) instead
// of the component itself, depending on how it picks isNodeMode for the
// shared CJS module instance. Unwrap defensively so it works either way.
import * as ReactPlotly from 'react-plotly.js'

const Plot = ReactPlotly.default?.default ?? ReactPlotly.default

export default Plot
