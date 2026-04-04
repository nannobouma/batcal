/**
 * charts.js
 * Beheert alle Chart.js grafieken voor de batterij ROI calculator.
 */

const Charts = (() => {

  // Chart instanties (voor destroy bij herrendering)
  let _charts = {};

  const COLORS = {
    blue:       '#3b82f6',
    blueDim:    'rgba(59,130,246,0.15)',
    green:      '#16a34a',
    greenDim:   'rgba(22,163,74,0.15)',
    orange:     '#f97316',
    orangeDim:  'rgba(249,115,22,0.15)',
    red:        '#dc2626',
    redDim:     'rgba(220,38,38,0.12)',
    gray:       '#94a3b8',
    grayDim:    'rgba(148,163,184,0.2)',
    amber:      '#f59e0b',
  };

  // Gedeelde Chart.js defaults
  Chart.defaults.font.family = "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";
  Chart.defaults.font.size   = 12;
  Chart.defaults.color       = '#64748b';

  function destroy(id) {
    if (_charts[id]) {
      _charts[id].destroy();
      delete _charts[id];
    }
  }

  // ── 1. Maandelijkse besparing ────────────────────────────────────────────

  function renderMonthlySavings(canvasId, monthly) {
    destroy(canvasId);
    const ctx = document.getElementById(canvasId).getContext('2d');

    const labels   = monthly.map(m => m.label);
    const savings  = monthly.map(m => +m.savings.toFixed(2));
    const bgColors = savings.map(v => v >= 0 ? COLORS.greenDim : COLORS.redDim);
    const bdColors = savings.map(v => v >= 0 ? COLORS.green    : COLORS.red);

    _charts[canvasId] = new Chart(ctx, {
      type: 'bar',
      data: {
        labels,
        datasets: [{
          label: 'Besparing (€)',
          data: savings,
          backgroundColor: bgColors,
          borderColor: bdColors,
          borderWidth: 1.5,
          borderRadius: 4,
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              label: ctx => ` €${ctx.raw.toFixed(2)}`,
            },
          },
        },
        scales: {
          x: { grid: { display: false } },
          y: {
            ticks: { callback: v => `€${v}` },
            grid: { color: 'rgba(0,0,0,0.05)' },
          },
        },
      },
    });
  }

  // ── 2. Terugverdientijd / cumulatieve ROI ────────────────────────────────

  function renderPayback(canvasId, totals) {
    destroy(canvasId);
    const ctx = document.getElementById(canvasId).getContext('2d');

    const { investment, annualSavings, lifetimeYears } = totals._params;
    const payback = totals.paybackYears;
    const years = Array.from({ length: lifetimeYears + 1 }, (_, i) => i);
    const cumSavings  = years.map(y => +(annualSavings * y).toFixed(2));
    const investLine  = years.map(() => investment);

    _charts[canvasId] = new Chart(ctx, {
      type: 'line',
      data: {
        labels: years.map(y => `Jaar ${y}`),
        datasets: [
          {
            label: 'Cumulatieve besparing',
            data: cumSavings,
            borderColor: COLORS.green,
            backgroundColor: COLORS.greenDim,
            fill: true,
            tension: 0.3,
            pointRadius: 3,
          },
          {
            label: 'Investering',
            data: investLine,
            borderColor: COLORS.red,
            borderDash: [6, 4],
            borderWidth: 2,
            pointRadius: 0,
            fill: false,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        plugins: {
          tooltip: {
            callbacks: {
              label: ctx => ` ${ctx.dataset.label}: €${ctx.raw.toFixed(0)}`,
            },
          },
        },
        scales: {
          x: { grid: { display: false } },
          y: {
            ticks: { callback: v => `€${v}` },
            grid: { color: 'rgba(0,0,0,0.05)' },
          },
        },
      },
    });
  }

  // ── 3. Batterij SOC verloop (geselecteerde week) ─────────────────────────

  function renderSOC(canvasId, intervals, weekOffset) {
    destroy(canvasId);
    const ctx = document.getElementById(canvasId).getContext('2d');

    const week = getWeekIntervals(intervals, weekOffset);
    if (!week.length) return;

    const labels     = week.map(iv => formatShortTime(iv.ts));
    const socData    = week.map(iv => +(iv.soc).toFixed(3));
    const maxCap     = Math.max(...socData) * 1.05 || 1;

    _charts[canvasId] = new Chart(ctx, {
      type: 'line',
      data: {
        labels,
        datasets: [{
          label: 'SOC (kWh)',
          data: socData,
          borderColor: COLORS.blue,
          backgroundColor: COLORS.blueDim,
          fill: true,
          tension: 0.2,
          pointRadius: 0,
          borderWidth: 1.5,
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: false,
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              title: items => formatFullTime(week[items[0].dataIndex]?.ts),
              label: ctx => ` ${ctx.raw.toFixed(2)} kWh`,
            },
          },
        },
        scales: {
          x: {
            ticks: {
              maxTicksLimit: 14,
              callback: (_, i) => {
                const d = week[i]?.ts;
                if (!d) return '';
                // Toon alleen dag-labels (middernacht)
                return d.getHours() === 0 && d.getMinutes() === 0
                  ? d.toLocaleDateString('nl-NL', { weekday: 'short', day: 'numeric' })
                  : '';
              },
              maxRotation: 0,
            },
            grid: { display: false },
          },
          y: {
            min: 0,
            ticks: { callback: v => `${v} kWh` },
            grid: { color: 'rgba(0,0,0,0.05)' },
          },
        },
      },
    });
  }

  // ── 4. Gemiddeld dagprofiel ──────────────────────────────────────────────

  function renderDailyProfile(canvasId, intervals) {
    destroy(canvasId);
    const ctx = document.getElementById(canvasId).getContext('2d');

    // Bereken gemiddeld verbruik per uur van de dag (met en zonder batterij)
    const hourSums = Array.from({ length: 24 }, () => ({ del: 0, delRef: 0, n: 0 }));
    for (const iv of intervals) {
      const h = iv.ts.getHours();
      hourSums[h].del    += iv.delivered;
      hourSums[h].delRef += iv.delivered + (iv.delivered - iv.delivered); // proxy: ref is in simulation
      hourSums[h].n++;
    }

    // Bereken gemiddeld verbruik per uur (referentie + bespaard)
    // We tonen: gemiddeld netverbruik met batterij per uur
    const labels = Array.from({ length: 24 }, (_, h) => `${String(h).padStart(2,'0')}:00`);
    const avgDel = hourSums.map(h => h.n > 0 ? +(h.del / h.n * 4).toFixed(3) : 0); // × 4 → per uur

    _charts[canvasId] = new Chart(ctx, {
      type: 'bar',
      data: {
        labels,
        datasets: [{
          label: 'Gem. netverbruik met batterij (kWh/u)',
          data: avgDel,
          backgroundColor: COLORS.blueDim,
          borderColor: COLORS.blue,
          borderWidth: 1,
          borderRadius: 3,
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              label: ctx => ` ${ctx.raw.toFixed(3)} kWh/u gem.`,
            },
          },
        },
        scales: {
          x: { grid: { display: false } },
          y: {
            ticks: { callback: v => `${v} kWh` },
            grid: { color: 'rgba(0,0,0,0.05)' },
          },
        },
      },
    });
  }

  // ── 5. Energiestroom donut ───────────────────────────────────────────────

  function renderEnergyFlow(canvasId, totals) {
    destroy(canvasId);
    const ctx = document.getElementById(canvasId).getContext('2d');

    const { totalDischarged, costWithout } = totals;
    const monthly = totals._monthly;
    const totalRef = monthly.reduce((s, m) => s + m.deliveredRef, 0);
    const totalBat = monthly.reduce((s, m) => s + m.deliveredBat, 0);
    const fromBattery = totalDischarged;
    const fromGrid    = Math.max(0, totalBat);
    const total       = fromGrid + fromBattery;

    _charts[canvasId] = new Chart(ctx, {
      type: 'doughnut',
      data: {
        labels: ['Uit net', 'Uit batterij'],
        datasets: [{
          data: [
            +(fromGrid / total * 100).toFixed(1),
            +(fromBattery / total * 100).toFixed(1),
          ],
          backgroundColor: [COLORS.grayDim, COLORS.greenDim],
          borderColor:     [COLORS.gray,    COLORS.green],
          borderWidth: 2,
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        cutout: '65%',
        plugins: {
          legend: { position: 'bottom' },
          tooltip: {
            callbacks: {
              label: ctx => ` ${ctx.raw}%`,
            },
          },
        },
      },
    });
  }

  // ── Utils ────────────────────────────────────────────────────────────────

  function getWeekIntervals(intervals, weekOffset = 0) {
    if (!intervals.length) return [];
    const start = new Date(intervals[0].ts);
    // Begin op middernacht van de eerste dag
    start.setHours(0, 0, 0, 0);
    const weekStart = new Date(start.getTime() + weekOffset * 7 * 24 * 3600 * 1000);
    const weekEnd   = new Date(weekStart.getTime() + 7 * 24 * 3600 * 1000);
    return intervals.filter(iv => iv.ts >= weekStart && iv.ts < weekEnd);
  }

  function formatShortTime(date) {
    if (!date) return '';
    return date.toLocaleTimeString('nl-NL', { hour: '2-digit', minute: '2-digit' });
  }

  function formatFullTime(date) {
    if (!date) return '';
    return date.toLocaleString('nl-NL', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  }

  return {
    renderMonthlySavings,
    renderPayback,
    renderSOC,
    renderDailyProfile,
    renderEnergyFlow,
    getWeekIntervals,
  };

})();
