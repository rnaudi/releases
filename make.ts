#!/usr/bin/env -S deno run --allow-all
import $ from "jsr:@david/dax@0.44.2";
import { parseArgs } from "jsr:@std/cli@1.0.27/parse-args";
import { parse as parseYaml } from "jsr:@std/yaml@1.0.5";

// ── Configuration ──────────────────────────────────────────────────

interface ProjectConfig {
  id: string;
  name: string;
  repo: string;
  base: string;
}

const CONFIG_FILE = "config.yaml";
const HTML_FILE = "index.html";
const DATA_DIR = "data";
const FETCH_LIMIT = 500;

async function loadConfig(): Promise<ProjectConfig[]> {
  try {
    const raw = await Deno.readTextFile(CONFIG_FILE);
    const config = parseYaml(raw) as { projects: ProjectConfig[] };
    if (!config.projects?.length) {
      $.logError("No projects defined in config.yaml");
      Deno.exit(1);
    }
    return config.projects;
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) {
      $.logError(
        `${CONFIG_FILE} not found. Copy the example and edit it:\n\n  cp config.example.yaml config.yaml\n`,
      );
      Deno.exit(1);
    }
    throw e;
  }
}

function csvFile(id: string): string {
  return `${DATA_DIR}/${id}.csv`;
}

// ── Types ──────────────────────────────────────────────────────────

interface PrData {
  number: number;
  mergedAt: string;
  author: { login: string };
}

interface Release {
  number: number;
  date: string;
  author: string;
  dayOfWeek: number;
  isoWeek: string;
  month: string;
  year: string;
}

interface ProjectStats {
  total: number;
  dateRange: [string, string];
  monthKeys: string[];
  monthData: number[];
  movingAvg: (number | null)[];
  yearKeys: string[];
  yearData: number[];
  dayData: number[];
  heatmapGrid: { year: string; counts: number[]; total: number }[];
  weeklyPerYear: { year: string; data: number[] }[];
  monthTotals: number[];
}

// ── Helpers ────────────────────────────────────────────────────────

function isoWeek(d: Date): string {
  const date = new Date(d.getTime());
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCDate(date.getUTCDate() + 3 - ((date.getUTCDay() + 6) % 7));
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil(
    ((date.getTime() - yearStart.getTime()) / 86400000 + 1) / 7,
  );
  return `${date.getUTCFullYear()}-W${String(weekNo).padStart(2, "0")}`;
}

function parseRelease(pr: PrData): Release {
  const d = new Date(pr.mergedAt);
  const dateStr = pr.mergedAt.slice(0, 10);
  return {
    number: pr.number,
    date: dateStr,
    author: pr.author.login,
    dayOfWeek: d.getUTCDay(),
    isoWeek: isoWeek(d),
    month: dateStr.slice(0, 7),
    year: dateStr.slice(0, 4),
  };
}

function countBy<T>(items: T[], key: (item: T) => string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of items) {
    const k = key(item);
    counts[k] = (counts[k] || 0) + 1;
  }
  return counts;
}

// ── Data fetching & caching ────────────────────────────────────────

async function fetchReleases(project: ProjectConfig): Promise<Release[]> {
  $.logStep(`Fetching merged PRs to ${project.base} on ${project.repo}...`);

  const prs: PrData[] = await $`gh pr list
    --repo ${project.repo}
    --base ${project.base}
    --state merged
    --limit ${FETCH_LIMIT}
    --json number,mergedAt,author`.json();

  if (prs.length === FETCH_LIMIT) {
    $.logWarn(
      `Got exactly ${FETCH_LIMIT} results for ${project.name} — there may be more. Increase FETCH_LIMIT.`,
    );
  }

  $.logStep(`Fetched ${prs.length} releases for ${project.name}`);

  const releases = prs.map(parseRelease);
  releases.sort((a, b) => a.date.localeCompare(b.date));
  return releases;
}

function toCsv(releases: Release[]): string {
  const header = "number,date,author";
  const rows = releases.map((r) => `${r.number},${r.date},${r.author}`);
  return [header, ...rows].join("\n") + "\n";
}

function parseCsv(csv: string): Release[] {
  const lines = csv.trim().split("\n").slice(1);
  return lines.map((line) => {
    const [numStr, date, author] = line.split(",");
    const d = new Date(date);
    return {
      number: parseInt(numStr),
      date,
      author,
      dayOfWeek: d.getUTCDay(),
      isoWeek: isoWeek(d),
      month: date.slice(0, 7),
      year: date.slice(0, 4),
    };
  });
}

async function loadProject(
  project: ProjectConfig,
  fresh: boolean,
): Promise<Release[]> {
  const file = csvFile(project.id);
  let hasCached = false;
  try {
    await Deno.stat(file);
    hasCached = true;
  } catch {
    // no cached file
  }

  if (hasCached && !fresh) {
    $.logStep(`[${project.name}] Using cached ${file}`);
    const csv = await Deno.readTextFile(file);
    return parseCsv(csv);
  }

  const releases = await fetchReleases(project);
  await Deno.writeTextFile(file, toCsv(releases));
  $.logStep(`[${project.name}] Wrote ${file} (${releases.length} releases)`);
  return releases;
}

// ── Aggregation ────────────────────────────────────────────────────

const MONTH_LABELS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

function aggregateProject(releases: Release[]): ProjectStats {
  const perMonth = countBy(releases, (r) => r.month);
  const perYear = countBy(releases, (r) => r.year);
  const perDay = countBy(releases, (r) => String(r.dayOfWeek));

  const dayData = [0, 1, 2, 3, 4, 5, 6].map((i) => perDay[String(i)] || 0);

  const monthKeys = Object.keys(perMonth).sort();
  const monthData = monthKeys.map((k) => perMonth[k]);

  const movingAvg: (number | null)[] = monthData.map((_, i) => {
    if (i < 2) return null;
    return Math.round(((monthData[i - 2] + monthData[i - 1] + monthData[i]) / 3) * 10) / 10;
  });

  const yearKeys = Object.keys(perYear).sort();
  const yearData = yearKeys.map((k) => perYear[k]);

  const heatmapGrid = yearKeys.map((year) => {
    const counts = MONTH_LABELS.map((_, mi) => {
      const key = `${year}-${String(mi + 1).padStart(2, "0")}`;
      return perMonth[key] || 0;
    });
    return { year, counts, total: counts.reduce((a, b) => a + b, 0) };
  });

  // Reverse chronological weekly data
  const weeklyPerYear = [...yearKeys]
    .reverse()
    .map((year) => {
      const yearReleases = releases.filter((r) => r.year === year);
      const perWeek = countBy(yearReleases, (r) => r.isoWeek);
      const data: number[] = [];
      for (let w = 1; w <= 53; w++) {
        const key = `${year}-W${String(w).padStart(2, "0")}`;
        data.push(perWeek[key] || 0);
      }
      return { year, data };
    });

  const monthTotals = MONTH_LABELS.map((_, mi) =>
    heatmapGrid.reduce((sum, row) => sum + row.counts[mi], 0),
  );

  return {
    total: releases.length,
    dateRange: [releases[0]?.date ?? "?", releases[releases.length - 1]?.date ?? "?"],
    monthKeys,
    monthData,
    movingAvg,
    yearKeys,
    yearData,
    dayData,
    heatmapGrid,
    weeklyPerYear,
    monthTotals,
  };
}

// ── HTML generation ────────────────────────────────────────────────

interface ProjectPayload {
  config: ProjectConfig;
  stats: ProjectStats;
}

function generateHtml(payloads: ProjectPayload[]): string {
  // Build the JS data object — keyed by project ID
  const projectsJs: Record<string, { name: string; repo: string; base: string } & ProjectStats> = {};
  for (const p of payloads) {
    projectsJs[p.config.id] = { name: p.config.name, repo: p.config.repo, base: p.config.base, ...p.stats };
  }

  // Tab buttons
  const tabButtons = payloads
    .map(
      (p) =>
        `<button class="tab" data-project="${p.config.id}" onclick="switchProject('${p.config.id}')">${p.config.name} <span class="tab-badge">${p.stats.total}</span></button>`,
    )
    .join("\n        ");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Release Frequency Dashboard</title>
  <script src="https://cdn.jsdelivr.net/npm/chart.js@4"></script>
  <script src="https://cdn.jsdelivr.net/npm/chartjs-plugin-datalabels@2"></script>
  <style>
    /* -- Theme system using light-dark() -- */
    :root {
      color-scheme: dark light;
      --color-canvas-default: light-dark(#ffffff, #0d1117);
      --color-canvas-subtle: light-dark(#f6f8fa, #161b22);
      --color-border-default: light-dark(#d0d7de, #30363d);
      --color-border-muted: light-dark(#d8dee4, #21262d);
      --color-fg-default: light-dark(#1f2328, #c9d1d9);
      --color-fg-muted: light-dark(#656d76, #8b949e);
      --color-fg-subtle: light-dark(#6e7781, #484f58);
      --color-accent-fg: light-dark(#0969da, #58a6ff);
      --color-success-emphasis: light-dark(#1a7f37, #238636);
      --color-danger-fg: light-dark(#cf222e, #f85149);
      --color-danger-muted: light-dark(rgba(207, 34, 46, 0.4), rgba(248, 81, 73, 0.45));
      --hm-0: light-dark(#ebedf0, #161b22);
      --hm-0-border: light-dark(#d0d7de, #30363d);
      --hm-0-fg: light-dark(#6e7781, #484f58);
      --hm-1: light-dark(#9be9a8, #0e4429);
      --hm-2: light-dark(#40c463, #006d32);
      --hm-3: light-dark(#30a14e, #26a641);
      --hm-4: light-dark(#216e39, #39d353);
      --hm-fg: light-dark(#1f2328, #c9d1d9);
    }

    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans", Helvetica, Arial, sans-serif;
      background: var(--color-canvas-default);
      color: var(--color-fg-default);
      padding: 2.5rem;
      line-height: 1.5;
      transition: background 0.2s, color 0.2s;
    }

    /* -- Header -- */
    .header {
      max-width: 1200px;
      margin: 0 auto 1rem auto;
      display: flex;
      align-items: center;
      justify-content: center;
      position: relative;
    }
    .header-text { text-align: center; }
    .header-text h1 {
      font-size: 1.5rem;
      font-weight: 600;
      color: var(--color-fg-default);
      margin-bottom: 0.15rem;
      text-wrap: balance;
    }
    .header-text .subtitle {
      color: var(--color-fg-muted);
      font-size: 0.85rem;
    }
    .header-text .subtitle a {
      color: var(--color-accent-fg);
      text-decoration: none;
    }
    .header-text .subtitle a:hover {
      text-decoration: underline;
    }

    /* -- Theme toggle -- */
    .theme-toggle {
      position: absolute;
      right: 0;
      top: 50%;
      transform: translateY(-50%);
      background: var(--color-canvas-subtle);
      border: 1px solid var(--color-border-default);
      border-radius: 6px;
      padding: 0.4rem 0.65rem;
      cursor: pointer;
      color: var(--color-fg-muted);
      font-size: 0.8rem;
      font-family: inherit;
      display: flex;
      align-items: center;
      gap: 0.4rem;
      transition: background 0.15s, border-color 0.15s;
    }
    .theme-toggle:hover {
      background: var(--color-border-muted);
      border-color: var(--color-fg-muted);
    }
    .theme-toggle svg {
      width: 16px;
      height: 16px;
      fill: currentColor;
    }
    [data-theme="dark"] .icon-light { display: none; }
    [data-theme="light"] .icon-dark { display: none; }

    /* -- Tabs -- */
    .tab-bar {
      max-width: 1200px;
      margin: 0 auto 1.5rem auto;
      display: flex;
      gap: 0;
      border-bottom: 1px solid var(--color-border-default);
    }
    .tab-bar .tab {
      background: none;
      border: none;
      padding: 0.6rem 1rem;
      font-family: inherit;
      font-size: 0.85rem;
      color: var(--color-fg-muted);
      cursor: pointer;
      border-bottom: 2px solid transparent;
      margin-bottom: -1px;
      transition: color 0.15s, border-color 0.15s;
    }
    .tab-bar .tab:hover { color: var(--color-fg-default); }
    .tab-bar .tab.active {
      color: var(--color-fg-default);
      font-weight: 600;
      border-bottom-color: var(--color-success-emphasis);
    }
    .tab-badge {
      font-size: 0.7rem;
      font-weight: 400;
      color: var(--color-fg-subtle);
      margin-left: 0.35rem;
    }
    .tab.active .tab-badge {
      color: var(--color-fg-muted);
    }

    /* -- Cards -- */
    .card {
      background: var(--color-canvas-subtle);
      border: 1px solid var(--color-border-default);
      border-radius: 6px;
      padding: 1.25rem;
      margin-bottom: 1rem;
      max-width: 1200px;
      margin-left: auto;
      margin-right: auto;
      transition: background 0.2s, border-color 0.2s;
    }
    .card h2 {
      margin-bottom: 0.75rem;
      font-size: 0.95rem;
      font-weight: 600;
      color: var(--color-fg-default);
      text-wrap: balance;
    }
    .card canvas { width: 100% !important; }
    .row {
      display: flex;
      gap: 1rem;
      max-width: 1200px;
      margin: 0 auto 1rem auto;
    }
    .row .card { flex: 1; margin-bottom: 0; }
    .chart-h-sm { height: 180px; }
    .chart-h-md { height: 260px; }
    .chart-h-lg { height: 320px; }
    .section-title {
      max-width: 1200px;
      margin: 2rem auto 0.75rem auto;
      font-size: 0.95rem;
      font-weight: 600;
      color: var(--color-fg-muted);
      border-bottom: 1px solid var(--color-border-default);
      padding-bottom: 0.5rem;
    }

    /* -- Heatmap table -- */
    .heatmap-table {
      border-collapse: separate;
      border-spacing: 3px;
      width: 100%;
    }
    .heatmap-table th {
      padding: 0.35rem 0.5rem;
      font-size: 0.75rem;
      color: var(--color-fg-muted);
      font-weight: 500;
      text-align: center;
    }
    .hm-cell {
      text-align: center;
      font-size: 0.8rem;
      border-radius: 3px;
      padding: 0.4rem 0.5rem;
      font-weight: 500;
      font-variant-numeric: tabular-nums;
      transition: background 0.2s;
    }
    .hm-level-0 { background: var(--hm-0); color: var(--hm-0-fg); border: 1px solid var(--hm-0-border); }
    .hm-level-1 { background: var(--hm-1); color: light-dark(#1f2328, var(--hm-fg)); }
    .hm-level-2 { background: var(--hm-2); color: light-dark(#fff, var(--hm-fg)); }
    .hm-level-3 { background: var(--hm-3); color: light-dark(#fff, var(--hm-fg)); }
    .hm-level-4 { background: var(--hm-4); color: light-dark(#fff, var(--hm-fg)); }

    .heatmap-table .year-label {
      font-weight: 600;
      font-size: 0.85rem;
      color: var(--color-fg-default);
      text-align: left;
      padding-right: 0.75rem;
    }
    .heatmap-table .year-total {
      font-weight: 600;
      font-size: 0.85rem;
      color: var(--color-fg-muted);
      padding-left: 0.75rem;
      text-align: center;
    }
    .heatmap-table tfoot td {
      font-weight: 600;
      font-size: 0.8rem;
      color: var(--color-fg-subtle);
      padding-top: 0.5rem;
    }

    /* -- Heatmap legend -- */
    .hm-legend {
      display: flex;
      align-items: center;
      gap: 0.35rem;
      margin-top: 0.75rem;
      font-size: 0.75rem;
      color: var(--color-fg-muted);
    }
    .hm-legend-cell {
      width: 12px;
      height: 12px;
      border-radius: 2px;
      display: inline-block;
    }
    .hm-legend .l0 { background: var(--hm-0); border: 1px solid var(--hm-0-border); }
    .hm-legend .l1 { background: var(--hm-1); }
    .hm-legend .l2 { background: var(--hm-2); }
    .hm-legend .l3 { background: var(--hm-3); }
    .hm-legend .l4 { background: var(--hm-4); }
  </style>
</head>
<body>
  <div class="header">
    <div class="header-text">
      <h1>Release Frequency Dashboard</h1>
      <p class="subtitle" id="subtitle"></p>
    </div>
    <button class="theme-toggle" onclick="toggleTheme()" title="Toggle theme">
      <svg class="icon-dark" viewBox="0 0 16 16"><path d="M9.598 1.591a.749.749 0 0 1 .785-.175 7.001 7.001 0 1 1-8.967 8.967.75.75 0 0 1 .961-.96 5.5 5.5 0 0 0 7.221-7.832.749.749 0 0 1 0-.001z"/></svg>
      <svg class="icon-light" viewBox="0 0 16 16"><path d="M8 12a4 4 0 1 1 0-8 4 4 0 0 1 0 8zm0-1.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5zm5.657-8.157a.75.75 0 0 1 0 1.061l-1.061 1.06a.749.749 0 1 1-1.06-1.06l1.06-1.061a.75.75 0 0 1 1.061 0zm-9.193 9.193a.75.75 0 0 1 0 1.06l-1.06 1.061a.75.75 0 1 1-1.061-1.06l1.06-1.061a.75.75 0 0 1 1.061 0zM8 0a.75.75 0 0 1 .75.75v1.5a.75.75 0 0 1-1.5 0V.75A.75.75 0 0 1 8 0zM3 8a.75.75 0 0 1-.75.75H.75a.75.75 0 0 1 0-1.5h1.5A.75.75 0 0 1 3 8zm13 0a.75.75 0 0 1-.75.75h-1.5a.75.75 0 0 1 0-1.5h1.5A.75.75 0 0 1 16 8zm-8 5a.75.75 0 0 1 .75.75v1.5a.75.75 0 0 1-1.5 0v-1.5A.75.75 0 0 1 8 13zm3.536.464a.75.75 0 0 1 0 1.06l-1.06 1.061a.75.75 0 0 1-1.061-1.06l1.06-1.061a.75.75 0 0 1 1.061 0z"/></svg>
    </button>
  </div>

  <nav class="tab-bar">
    ${tabButtons}
  </nav>

  <div id="heatmap-container"></div>

  <div class="row">
    <div class="card">
      <h2>Releases per Year</h2>
      <div class="chart-h-md"><canvas id="yearlyChart"></canvas></div>
    </div>
    <div class="card">
      <h2>Day-of-Week Distribution</h2>
      <div class="chart-h-md"><canvas id="dayChart"></canvas></div>
    </div>
  </div>

  <div class="card">
    <h2>Monthly Trend</h2>
    <div class="chart-h-lg"><canvas id="monthlyChart"></canvas></div>
  </div>

  <h3 class="section-title">Weekly Breakdown by Year</h3>
  <div id="weekly-container"></div>

  <script>
    // -- Project data --
    const projects = ${JSON.stringify(projectsJs)};
    const projectOrder = ${JSON.stringify(payloads.map((p) => p.config.id))};
    let activeProject = null;

    // -- Theme colors for Chart.js --
    const themes = {
      dark: {
        fg: '#8b949e',
        fgLabel: '#8b949e',
        grid: '#21262d',
        green: '#238636',
        blue: '#58a6ff',
        red: '#f85149',
        redMuted: 'rgba(248, 81, 73, 0.45)',
        tickColor: '#484f58',
      },
      light: {
        fg: '#656d76',
        fgLabel: '#656d76',
        grid: '#d8dee4',
        green: '#1a7f37',
        blue: '#0969da',
        red: '#cf222e',
        redMuted: 'rgba(207, 34, 46, 0.4)',
        tickColor: '#6e7781',
      }
    };

    function currentTheme() {
      return document.documentElement.style.colorScheme || 'dark';
    }
    function th() { return themes[currentTheme()]; }

    // -- Charts --
    const charts = [];
    const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const MONTH_LABELS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const WEEK_LABELS = Array.from({ length: 53 }, (_, i) => 'W' + String(i + 1).padStart(2, '0'));

    function buildDayColors() {
      const c = th();
      return DAY_LABELS.map((_, i) =>
        i === 5 ? c.red : (i === 0 || i === 6) ? c.redMuted : c.green
      );
    }

    function hmLevel(count) {
      if (count === 0) return 0;
      if (count <= 2) return 1;
      if (count <= 4) return 2;
      if (count <= 6) return 3;
      return 4;
    }

    // -- Render heatmap table --
    function renderHeatmap(p) {
      const el = document.getElementById('heatmap-container');
      const headCells = MONTH_LABELS.map(function(m) { return '<th>' + m + '</th>'; }).join('');
      const bodyRows = p.heatmapGrid.map(function(row) {
        const cells = row.counts.map(function(cnt) {
          return '<td class="hm-cell hm-level-' + hmLevel(cnt) + '">' + cnt + '</td>';
        }).join('');
        return '<tr><td class="year-label">' + row.year + '</td>' + cells + '<td class="year-total">' + row.total + '</td></tr>';
      }).join('');
      const footCells = p.monthTotals.map(function(mt) {
        return '<td class="hm-cell" style="color:var(--color-fg-subtle)">' + mt + '</td>';
      }).join('');

      el.innerHTML =
        '<div class="card"><h2>Releases by Year and Month</h2>' +
        '<table class="heatmap-table"><thead><tr><th></th>' + headCells + '<th></th></tr></thead>' +
        '<tbody>' + bodyRows + '</tbody>' +
        '<tfoot><tr><td class="year-label"></td>' + footCells +
        '<td class="year-total">' + p.total + '</td></tr></tfoot></table>' +
        '<div class="hm-legend">Less ' +
        '<span class="hm-legend-cell l0"></span>' +
        '<span class="hm-legend-cell l1"></span>' +
        '<span class="hm-legend-cell l2"></span>' +
        '<span class="hm-legend-cell l3"></span>' +
        '<span class="hm-legend-cell l4"></span>' +
        ' More</div></div>';
    }

    // -- Render weekly canvases --
    function renderWeeklyCanvases(p) {
      const el = document.getElementById('weekly-container');
      el.innerHTML = p.weeklyPerYear.map(function(yw) {
        return '<div class="card"><h2>' + yw.year + '</h2>' +
          '<div class="chart-h-sm"><canvas id="weekly-' + yw.year + '"></canvas></div></div>';
      }).join('');
    }

    // -- Create all charts for current project --
    function createCharts() {
      charts.forEach(function(ch) { ch.destroy(); });
      charts.length = 0;

      const p = projects[activeProject];
      const c = th();
      Chart.defaults.color = c.fg;
      Chart.defaults.borderColor = c.grid;

      const dlDefaults = {
        color: c.fgLabel,
        anchor: 'end',
        align: 'top',
        font: { size: 11, weight: '500' },
        display: function(ctx) { return ctx.dataset.data[ctx.dataIndex] > 0; },
      };

      // Monthly
      charts.push(new Chart(document.getElementById('monthlyChart'), {
        type: 'bar',
        data: {
          labels: p.monthKeys,
          datasets: [
            {
              label: 'Releases',
              data: p.monthData,
              backgroundColor: c.green,
              borderRadius: 2,
              barPercentage: 0.7,
              categoryPercentage: 0.85,
              order: 2,
            },
            {
              label: '3-month avg',
              data: p.movingAvg,
              type: 'line',
              borderColor: c.blue,
              borderWidth: 2,
              pointRadius: 0,
              fill: false,
              order: 1,
              datalabels: { display: false },
            }
          ]
        },
        options: {
           responsive: true,
          maintainAspectRatio: false,
          layout: { padding: { top: 20 } },
          plugins: {
            legend: {
              position: 'top',
              labels: { boxWidth: 12, font: { size: 11 }, padding: 16 }
            },
            datalabels: dlDefaults,
          },
          scales: {
            x: {
              grid: { display: false },
              ticks: { maxRotation: 90, autoSkip: true, maxTicksLimit: 40, font: { size: 9 } }
            },
            y: {
              beginAtZero: true,
              grid: { color: c.grid },
              ticks: { font: { size: 10 } }
            }
          }
        }
      }));

      // Yearly
      charts.push(new Chart(document.getElementById('yearlyChart'), {
        type: 'bar',
        data: {
          labels: p.yearKeys,
          datasets: [{
            label: 'Releases',
            data: p.yearData,
            backgroundColor: c.green,
            borderRadius: 3,
            barPercentage: 0.6,
          }]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          layout: { padding: { top: 20 } },
          plugins: {
            legend: { display: false },
            datalabels: Object.assign({}, dlDefaults, { font: { size: 13, weight: '600' } }),
          },
          scales: {
            x: { grid: { display: false } },
            y: { beginAtZero: true, grid: { color: c.grid } }
          }
        }
      }));

      // Day of week
      charts.push(new Chart(document.getElementById('dayChart'), {
        type: 'bar',
        data: {
          labels: DAY_LABELS,
          datasets: [{
            label: 'Releases',
            data: p.dayData,
            backgroundColor: buildDayColors(),
            borderRadius: 3,
            barPercentage: 0.6,
          }]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          layout: { padding: { top: 20 } },
          plugins: {
            legend: { display: false },
            datalabels: Object.assign({}, dlDefaults, { font: { size: 13, weight: '600' } }),
          },
          scales: {
            x: { grid: { display: false } },
            y: { beginAtZero: true, grid: { color: c.grid } }
          }
        }
      }));

      // Per-year weekly charts
      p.weeklyPerYear.forEach(function(yw) {
        var canvas = document.getElementById('weekly-' + yw.year);
        if (!canvas) return;
        charts.push(new Chart(canvas, {
          type: 'bar',
          data: {
            labels: WEEK_LABELS,
            datasets: [{
              label: 'Releases',
              data: yw.data,
              backgroundColor: c.green,
              borderRadius: 2,
              barPercentage: 0.8,
              categoryPercentage: 0.9,
            }]
          },
          options: {
            responsive: true,
            maintainAspectRatio: false,
            layout: { padding: { top: 20 } },
            plugins: {
              legend: { display: false },
              datalabels: {
                color: c.fgLabel,
                anchor: 'end',
                align: 'top',
                font: { size: 9, weight: '500' },
                display: function(ctx) { return ctx.dataset.data[ctx.dataIndex] > 0; },
              }
            },
            scales: {
              x: {
                grid: { display: false },
                ticks: { font: { size: 9 }, color: c.tickColor }
              },
              y: {
                beginAtZero: true,
                ticks: { stepSize: 1, color: c.tickColor, font: { size: 10 } },
                grid: { color: c.grid }
              }
            }
          }
        }));
      });
    }

    // -- Switch project --
    function switchProject(id) {
      activeProject = id;
      var p = projects[id];

      // Update subtitle
      var ghUrl = 'https://github.com/' + p.repo + '/pulls?q=is%3Apr+is%3Amerged+base%3A' + encodeURIComponent(p.base);
      document.getElementById('subtitle').innerHTML =
        p.name + ' \\u00B7 ' + p.total + ' releases \\u00B7 ' + p.dateRange[0] + ' to ' + p.dateRange[1] +
        ' \\u00B7 <a href="' + ghUrl + '" target="_blank" rel="noopener">View on GitHub \\u2192</a>';

      // Update tabs
      document.querySelectorAll('.tab-bar .tab').forEach(function(btn) {
        btn.classList.toggle('active', btn.dataset.project === id);
      });

      // Update URL hash
      history.replaceState(null, '', '#' + id);

      // Render dynamic sections
      renderHeatmap(p);
      renderWeeklyCanvases(p);
      createCharts();
    }

    // -- Theme toggle --
    function toggleTheme() {
      var html = document.documentElement;
      var next = currentTheme() === 'dark' ? 'light' : 'dark';
      html.style.colorScheme = next;
      html.setAttribute('data-theme', next);
      localStorage.setItem('theme', next);
      createCharts();
    }

    // -- Init --
    Chart.register(ChartDataLabels);
    var savedTheme = localStorage.getItem('theme') || 'dark';
    document.documentElement.style.colorScheme = savedTheme;
    document.documentElement.setAttribute('data-theme', savedTheme);

    // Pick initial project from URL hash or default to first
    var hashProject = location.hash.slice(1);
    var initialProject = projects[hashProject] ? hashProject : projectOrder[0];
    switchProject(initialProject);
  </script>
</body>
</html>`;
}

// ── Main ───────────────────────────────────────────────────────────

async function main() {
  const flags = parseArgs(Deno.args, {
    boolean: ["fresh", "no-open"],
    default: { fresh: false, "no-open": false },
  });

  const projects = await loadConfig();

  // Ensure data directory exists
  await Deno.mkdir(DATA_DIR, { recursive: true });

  const payloads: ProjectPayload[] = [];

  for (const project of projects) {
    const releases = await loadProject(project, flags.fresh);
    const stats = aggregateProject(releases);
    payloads.push({ config: project, stats });
  }

  const html = generateHtml(payloads);
  await Deno.writeTextFile(HTML_FILE, html);
  $.logStep(`Wrote ${HTML_FILE} (${payloads.length} projects)`);

  if (!flags["no-open"]) {
    await $`open ${HTML_FILE}`;
  }
}

if (import.meta.main) {
  await main();
}
