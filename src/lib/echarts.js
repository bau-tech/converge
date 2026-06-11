// Central ECharts registration. Import chart/component types here as the
// migration covers more chart kinds (bar/pie now, box/sunburst/treemap later)
// so unused parts stay tree-shaken out of the bundle.
import * as echarts from 'echarts/core'
import { BarChart, PieChart, BoxplotChart, SunburstChart, TreemapChart } from 'echarts/charts'
import { TooltipComponent, GridComponent, LegendComponent } from 'echarts/components'
import { CanvasRenderer } from 'echarts/renderers'

echarts.use([
    BarChart,
    PieChart,
    BoxplotChart,
    SunburstChart,
    TreemapChart,
    TooltipComponent,
    GridComponent,
    LegendComponent,
    CanvasRenderer,
])

export default echarts
