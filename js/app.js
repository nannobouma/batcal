/**
 * app.js
 * Hoofdorchestrator voor de Thuisbatterij ROI Calculator.
 */

// ── State ────────────────────────────────────────────────────────────────────
var _parsedData   = null;  // Genormaliseerde kwartierdata
var _simResult    = null;  // Laatste simulatieresultaat
var _weekOffset   = 0;     // Geselecteerde week voor SOC-grafiek
var _mode         = 'fixed'; // 'fixed' | 'dynamic'

// ── DOM referenties ───────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);

// ── Init ─────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  initDropZone();
  initModeToggle();
  initTabSwitcher();
  initWeekNav();
  $('btn-calc').addEventListener('click', runCalculation);
  updateCalcButton();
});

// ── Bestand uploaden ─────────────────────────────────────────────────────────
function initDropZone() {
  const zone   = $('drop-zone');
  const input  = $('file-input');

  zone.addEventListener('click', () => input.click());
  zone.addEventListener('dragover',  e => { e.preventDefault(); zone.classList.add('drag-over'); });
  zone.addEventListener('dragleave', () => zone.classList.remove('drag-over'));
  zone.addEventListener('drop', e => {
    e.preventDefault();
    zone.classList.remove('drag-over');
    handleFile(e.dataTransfer.files[0]);
  });
  input.addEventListener('change', () => handleFile(input.files[0]));
}

function handleFile(file) {
  if (!file) return;
  if (!file.name.match(/\.(csv|txt)$/i)) {
    showAlert('alert-parse', 'Selecteer een .csv of .txt bestand.', 'error');
    return;
  }

  const reader = new FileReader();
  reader.onload = e => {
    const text   = e.target.result;
    const result = parseSmartMeterCSV(text);

    if (result.error) {
      showAlert('alert-parse', result.error, 'error');
      return;
    }

    _parsedData = result.data;
    showFileInfo(file.name, result.meta);
    hideAlert('alert-parse');
    updateCalcButton();
  };
  reader.readAsText(file, 'UTF-8');
}

function showFileInfo(filename, meta) {
  const info = $('file-info');
  info.className = 'file-info visible';

  const start = meta.firstDate.toLocaleDateString('nl-NL', { day: 'numeric', month: 'short', year: 'numeric' });
  const end   = meta.lastDate.toLocaleDateString('nl-NL',  { day: 'numeric', month: 'short', year: 'numeric' });
  const comp  = Math.round(meta.completeness * 100);

  info.innerHTML = `
    <svg width="16" height="16" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
      <path d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"/>
    </svg>
    <div>
      <strong>${filename}</strong>
      &nbsp;·&nbsp;<span class="format-badge">${_parsedData ? 'Geladen' : ''}</span>
    </div>
    <div class="meta">${start} – ${end} &nbsp;|&nbsp; ${meta.intervals.toLocaleString()} kwartieren &nbsp;|&nbsp; ${meta.daysCovered} dagen &nbsp;|&nbsp; ${comp}% volledigheid</div>
  `;

  // Toon format-badge apart
  const badge = info.querySelector('.format-badge');
  // We bewaren meta voor later, maar halen format ook op
  info.dataset.format = 'ok';
}

// ── Mode toggle (vast / dynamisch) ───────────────────────────────────────────
function initModeToggle() {
  $('btn-fixed').addEventListener('click',   () => setMode('fixed'));
  $('btn-dynamic').addEventListener('click', () => setMode('dynamic'));
}

function setMode(mode) {
  _mode = mode;
  $('btn-fixed').classList.toggle('active',   mode === 'fixed');
  $('btn-dynamic').classList.toggle('active', mode === 'dynamic');

  const dynNote = $('dynamic-note');
  if (mode === 'dynamic') {
    dynNote.style.display = 'block';
  } else {
    dynNote.style.display = 'none';
  }
}

// ── Berekening ────────────────────────────────────────────────────────────────
async function runCalculation() {
  if (!_parsedData || _parsedData.length === 0) return;

  const params = getParams();
  setLoading(true);
  hideAlert('alert-calc');

  try {
    // ── Altijd dynamische prijzen ophalen (nodig voor vergelijkingstabel) ──
    showAlert('alert-calc', 'Dynamische prijzen ophalen...', 'info');
    const firstDate = _parsedData[0].timestamp;
    const lastDate  = _parsedData[_parsedData.length - 1].timestamp;
    let priceMap = null;

    try {
      priceMap = await Pricing.loadPrices(firstDate, lastDate, (done, total, label) => {
        showAlert('alert-calc', `${label} (${done}/${total} maanden)`, 'info');
      });
      const apiStatus = Pricing.getApiStatus();
      if (apiStatus === 'energycharts') {
        showAlert('alert-calc',
          'Prijzen geladen via energy-charts.info (uurdata). Energyzero.nl was niet beschikbaar.', 'warn');
      } else if (apiStatus === 'unavailable') {
        showAlert('alert-calc',
          'Dynamische prijzen niet beschikbaar. Vergelijkingstabel wordt niet getoond.', 'warn');
        priceMap = null;
      } else {
        hideAlert('alert-calc');
      }
    } catch (err) {
      showAlert('alert-calc', `Dynamische prijzen niet beschikbaar: ${err.message}. Vergelijking alleen op vast tarief.`, 'warn');
      priceMap = null;
    }

    await tick();

    // ── Berekening 1: Vast tarief (altijd) ──────────────────────────────────
    const fixedParams = { ...params, dynamicMode: false };
    const fixedResult = simulateBattery(_parsedData, fixedParams, null);

    // ── Berekening 2: Dynamisch tarief (als prijzen beschikbaar) ────────────
    let dynResult = null;
    if (priceMap) {
      const dynParams = { ...params, dynamicMode: true };
      dynResult = simulateBattery(_parsedData, dynParams, priceMap);
    }

    // ── Hoofdresultaat = wat de gebruiker geselecteerd heeft ────────────────
    _simResult = (_mode === 'dynamic' && dynResult) ? dynResult : fixedResult;

    _simResult.totals._params = {
      annualSavings: _simResult.totals.annualSavings,
      investment:    params.investment,
      lifetimeYears: params.lifetimeYears,
    };
    _simResult.totals._monthly = _simResult.monthly;

    _weekOffset = 0;
    renderResults(_simResult);
    renderComparison(fixedResult, dynResult, params);
    $('results-section').classList.remove('hidden');
    $('results-section').scrollIntoView({ behavior: 'smooth', block: 'start' });

  } catch (err) {
    showAlert('alert-calc', `Fout bij berekening: ${err.message}`, 'error');
    console.error(err);
  } finally {
    setLoading(false);
  }
}

function getParams() {
  return {
    capacity:      parseFloat($('p-capacity').value)      || 5,
    investment:    parseFloat($('p-investment').value)    || 2000,
    efficiency:    parseFloat($('p-efficiency').value)    / 100 || 0.85,
    fixedPrice:    parseFloat($('p-price').value)         || 0.25,
    feedInPrice:   parseFloat($('p-feedin').value)        || 0,
    lifetimeYears: parseFloat($('p-lifetime').value)      || 10,
    dynamicMode:   _mode === 'dynamic',
    storageCost:   parseFloat($('p-storage-cost')?.value) || 0.12,
  };
}

// ── Resultaten weergeven ──────────────────────────────────────────────────────
function renderResults(result) {
  const { totals, monthly, intervals } = result;

  // KPI-kaarten
  $('kpi-annual').textContent  = `€${totals.annualSavings.toFixed(0)}`;
  $('kpi-payback').textContent = totals.paybackYears < Infinity
    ? `${totals.paybackYears.toFixed(1)} jr`
    : '∞';
  $('kpi-roi').textContent     = `${totals.roiPercent.toFixed(0)}%`;
  $('kpi-self').textContent    = `${totals.selfSufficiency.toFixed(0)}%`;
  $('kpi-util').textContent    = `${totals.utilizationPct.toFixed(0)}%`;

  // Kleur KPI's op basis van waarde
  $('kpi-annual').className  = `kpi-value ${totals.annualSavings > 0 ? 'green' : ''}`;
  $('kpi-payback').className = `kpi-value ${totals.paybackYears < 15 ? 'blue' : ''}`;
  $('kpi-roi').className     = `kpi-value ${totals.roiPercent   > 0 ? 'green' : ''}`;

  // Data-period info
  const factor = totals.annualizeFactor;
  $('kpi-note').textContent = factor > 1.01
    ? `Gebaseerd op ${Math.round(totals.daysCovered)} dagen data, geëxtrapoleerd naar 1 jaar.`
    : `Gebaseerd op ${Math.round(totals.daysCovered)} dagen data.`;

  // Update week-label
  updateWeekLabel(intervals, _weekOffset);

  // Grafieken
  Charts.renderMonthlySavings('chart-monthly', monthly);
  Charts.renderPayback('chart-payback', totals);
  renderSOCChart();
  Charts.renderDailyProfile('chart-profile', intervals);
  Charts.renderEnergyFlow('chart-flow', totals);
}

// ── Vergelijkingstabel vast vs dynamisch ──────────────────────────────────────
function renderComparison(fixedResult, dynResult, params) {
  const section = $('comparison-section');
  const f = fixedResult.totals;
  const fA = f.annualizeFactor;

  // Vast tarief kolom
  $('ct-fixed-without').textContent = `€${(f.costWithout * fA).toFixed(0)}/jaar`;
  $('ct-fixed-with').textContent    = `€${(f.costWith * fA).toFixed(0)}/jaar`;
  $('ct-fixed-saving').textContent  = `€${f.annualSavings.toFixed(0)}/jaar`;
  $('ct-fixed-payback').textContent = f.paybackYears < Infinity
    ? `${f.paybackYears.toFixed(1)} jaar` : '∞';
  $('ct-fixed-roi').textContent     = `${f.roiPercent.toFixed(0)}%`;

  // Dynamisch tarief kolom
  if (dynResult) {
    const d = dynResult.totals;
    const dA = d.annualizeFactor;
    $('ct-dyn-without').textContent = `€${(d.costWithout * dA).toFixed(0)}/jaar`;
    $('ct-dyn-with').textContent    = `€${(d.costWith * dA).toFixed(0)}/jaar`;
    $('ct-dyn-saving').textContent  = `€${d.annualSavings.toFixed(0)}/jaar`;
    $('ct-dyn-payback').textContent = d.paybackYears < Infinity
      ? `${d.paybackYears.toFixed(1)} jaar` : '∞';
    $('ct-dyn-roi').textContent     = `${d.roiPercent.toFixed(0)}%`;
  } else {
    ['ct-dyn-without','ct-dyn-with','ct-dyn-saving','ct-dyn-payback','ct-dyn-roi']
      .forEach(id => $(id).textContent = 'n.b.');
  }

  // Toelichting
  const note = $('ct-note');
  const storageCost = params.storageCost || 0.12;
  note.innerHTML = `<strong>Vast tarief:</strong> €${params.fixedPrice.toFixed(2)}/kWh afname, €${params.feedInPrice.toFixed(2)}/kWh teruglevering.<br>` +
    `<strong>Dynamisch tarief:</strong> EPEX SPOT day-ahead + €${storageCost.toFixed(2)}/kWh opslagkosten (netkosten + leveranciersmarge).`;

  section.classList.remove('hidden');
}

function renderSOCChart() {
  if (!_simResult) return;
  Charts.renderSOC('chart-soc', _simResult.intervals, _weekOffset);
}

// ── Week navigatie ────────────────────────────────────────────────────────────
function initWeekNav() {
  $('btn-prev-week').addEventListener('click', () => {
    if (!_simResult) return;
    _weekOffset = Math.max(0, _weekOffset - 1);
    updateWeekLabel(_simResult.intervals, _weekOffset);
    renderSOCChart();
  });
  $('btn-next-week').addEventListener('click', () => {
    if (!_simResult) return;
    const maxWeeks = Math.floor(_simResult.intervals.length / (7 * 96));
    _weekOffset = Math.min(maxWeeks - 1, _weekOffset + 1);
    updateWeekLabel(_simResult.intervals, _weekOffset);
    renderSOCChart();
  });
}

function updateWeekLabel(intervals, weekOffset) {
  if (!intervals.length) return;
  const start = new Date(intervals[0].ts);
  start.setHours(0, 0, 0, 0);
  const weekStart = new Date(start.getTime() + weekOffset * 7 * 24 * 3600 * 1000);
  const weekEnd   = new Date(weekStart.getTime() + 6 * 24 * 3600 * 1000);
  const fmt = d => d.toLocaleDateString('nl-NL', { day: 'numeric', month: 'short' });
  $('week-label').textContent = `${fmt(weekStart)} – ${fmt(weekEnd)}`;
}

// ── Tabs ─────────────────────────────────────────────────────────────────────
function initTabSwitcher() {
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const target = btn.dataset.tab;
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
      btn.classList.add('active');
      $(target).classList.add('active');
    });
  });
}

// ── UI helpers ────────────────────────────────────────────────────────────────
function setLoading(loading) {
  const btn     = $('btn-calc');
  const spinner = $('calc-spinner');
  btn.disabled  = loading;
  spinner.classList.toggle('visible', loading);
  btn.querySelector('.btn-text').textContent = loading ? 'Berekenen...' : 'Bereken rendement';
}

function updateCalcButton() {
  $('btn-calc').disabled = !_parsedData;
}

function showAlert(id, msg, type) {
  const el = $(id);
  el.textContent = msg;
  el.className   = `alert alert-${type} visible`;
}

function hideAlert(id) {
  $(id).className = 'alert';
}

function tick() {
  return new Promise(r => setTimeout(r, 0));
}
