// @ts-check
// Entry `trends`: room history, trend graph and table, debrief export. No work on import.
export { mountTrends } from './panel.js';
export { TREND_GROUPS, TREND_RANGES, groupsFor, numericsAt, sampleSeries } from './series.js';
export { trendSvg, trendTable } from './chart.js';
export { debriefData, debriefHtml, debriefJson } from './debrief.js';
export { makeLog, memoryLog, sqlLog } from '../room/log.js';
