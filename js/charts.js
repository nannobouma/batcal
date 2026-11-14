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

  // ── 6. Piekverlaging ─────────────────────────────────────────────────────

  const pctScale = {
    min: 0,
    ticks: { callback: v => `${v}%` },
    grid: { color: 'rgba(0,0,0,0.05)' },
  };
  const pctTooltip = {
    callbacks: { label: ctx => ` ${ctx.dataset.label}: ${(+ctx.raw).toFixed(1)}%` },
  };

  function targetDataset(n, targetPct) {
    return {
      type: 'line',
      label: `Streefwaarde ${targetPct}%`,
      data: Array(n).fill(targetPct),
      borderColor: COLORS.red,
      borderDash: [6, 4],
      borderWidth: 1.5,
      pointRadius: 0,
      fill: false,
    };
  }

  function renderPeakMonthly(canvasId, monthly, targetPct) {
    destroy(canvasId);
    const ctx = document.getElementById(canvasId).getContext('2d');
    _charts[canvasId] = new Chart(ctx, {
      type: 'bar',
      data: {
        labels: monthly.map(m => m.label),
        datasets: [
          {
            label: 'Zonder batterij',
            data: monthly.map(m => +m.shareRef.toFixed(1)),
            backgroundColor: COLORS.grayDim, borderColor: COLORS.gray,
            borderWidth: 1.5, borderRadius: 4,
          },
          {
            label: 'Met batterij',
            data: monthly.map(m => +m.shareBat.toFixed(1)),
            backgroundColor: COLORS.blueDim, borderColor: COLORS.blue,
            borderWidth: 1.5, borderRadius: 4,
          },
          targetDataset(monthly.length, targetPct),
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        plugins: { tooltip: pctTooltip },
        scales: { x: { grid: { display: false } }, y: pctScale },
      },
    });
  }

  function renderPeakDaily(canvasId, days, targetPct) {
    destroy(canvasId);
    const ctx = document.getElementById(canvasId).getContext('2d');
    const fmt = d => d.toLocaleDateString('nl-NL', { day: 'numeric', month: 'short', year: '2-digit' });
    _charts[canvasId] = new Chart(ctx, {
      type: 'line',
      data: {
        labels: days.map(d => fmt(d.date)),
        datasets: [
          {
            label: 'Zonder batterij',
            data: days.map(d => +d.shareRef.toFixed(1)),
            borderColor: COLORS.gray, borderWidth: 1.5, pointRadius: 0, tension: 0.2,
          },
          {
            label: 'Met batterij',
            data: days.map(d => +d.shareBat.toFixed(1)),
            borderColor: COLORS.blue, backgroundColor: COLORS.blueDim,
            borderWidth: 1.5, pointRadius: 0, tension: 0.2, fill: true,
          },
          targetDataset(days.length, targetPct),
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: false,
        interaction: { mode: 'index', intersect: false },
        plugins: { tooltip: pctTooltip },
        scales: {
          x: { ticks: { maxTicksLimit: 12, maxRotation: 0 }, grid: { display: false } },
          y: pctScale,
        },
      },
    });
  }

  function renderPeakProfile(canvasId, profile, peakStartHour, peakEndHour) {
    destroy(canvasId);
    const ctx = document.getElementById(canvasId).getContext('2d');
    const labels = Array.from({ length: 24 }, (_, h) => `${String(h).padStart(2, '0')}:00`);
    const inPeak = h => h >= peakStartHour && h < peakEndHour;
    _charts[canvasId] = new Chart(ctx, {
      type: 'bar',
      data: {
        labels,
        datasets: [
          {
            label: 'Zonder batterij',
            data: profile.ref.map(v => +v.toFixed(3)),
            backgroundColor: labels.map((_, h) => inPeak(h) ? COLORS.orangeDim : COLORS.grayDim),
            borderColor:     labels.map((_, h) => inPeak(h) ? COLORS.orange    : COLORS.gray),
            borderWidth: 1, borderRadius: 3,
          },
          {
            label: 'Met batterij',
            data: profile.bat.map(v => +v.toFixed(3)),
            backgroundColor: COLORS.blueDim, borderColor: COLORS.blue,
            borderWidth: 1, borderRadius: 3,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        plugins: {
          tooltip: {
            callbacks: { label: ctx => ` ${ctx.dataset.label}: ${(+ctx.raw).toFixed(2)} kW gem.` },
          },
        },
        scales: {
          x: { grid: { display: false } },
          y: { min: 0, ticks: { callback: v => `${v} kW` }, grid: { color: 'rgba(0,0,0,0.05)' } },
        },
      },
    });
  }

  function renderPeakCapacity(canvasId, sweep, targetPct, currentCapacity) {
    destroy(canvasId);
    const ctx = document.getElementById(canvasId).getContext('2d');
    _charts[canvasId] = new Chart(ctx, {
      type: 'line',
      data: {
        labels: sweep.map(s => `${s.capacity} kWh`),
        datasets: [
          {
            label: 'Piekaandeel',
            data: sweep.map(s => +s.shareBat.toFixed(1)),
            borderColor: COLORS.blue, backgroundColor: COLORS.blueDim,
            fill: true, tension: 0.2, borderWidth: 2,
            pointRadius: sweep.map(s => s.capacity === currentCapacity ? 6 : 3),
            pointBackgroundColor: sweep.map(s => s.capacity === currentCapacity ? COLORS.orange : COLORS.blue),
          },
          targetDataset(sweep.length, targetPct),
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        plugins: {
          tooltip: {
            callbacks: {
              label: ctx => ` ${ctx.dataset.label}: ${(+ctx.raw).toFixed(1)}%`,
              afterBody: items => {
                const s = sweep[items[0].dataIndex];
                return s ? [`Piekafname: ${s.peakPerDay.toFixed(2)} kWh/dag`,
                            `Onder streefwaarde: ${s.daysUnderTargetBat} van ${s.days} dagen`] : [];
              },
            },
          },
        },
        scales: { x: { grid: { display: false } }, y: pctScale },
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
    renderPeakMonthly,
    renderPeakDaily,
    renderPeakProfile,
    renderPeakCapacity,
    getWeekIntervals,
  };

})();
