/**
 * app.js
 * Hoofdorchestrator voor de Thuisbatterij ROI Calculator.
 */

// ── State ────────────────────────────────────────────────────────────────────
var _parsedData   = null;  // Genormaliseerde kwartierdata
var _parsedFormat = '';    // Gedetecteerd CSV-formaat
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
  $('btn-peak').addEventListener('click', runPeakCalculation);
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

    _parsedData   = result.data;
    _parsedFormat = result.meta.format;
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
    renderEnergyBalance(fixedResult);
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

// ── Energiebalans zonnestroom (kWh) ───────────────────────────────────────────
// Altijd op basis van de strategie "zon-overschot opslaan" (vast tarief), zodat
// netladen bij dynamisch tarief de zelfverbruikscijfers niet vertekent.
function renderEnergyBalance(fixedResult) {
  const t = fixedResult.totals;
  const solarRaw = parseFloat($('p-solar').value);
  const hasSolar = Number.isFinite(solarRaw) && solarRaw > 0;
  const solar    = hasSolar ? solarRaw : null;

  const viaBattery = t.totalDischarged;
  // Wat de batterij in ging (minder teruglevering) min wat er uit kwam en wat er nog in zit
  const losses = Math.max(0, (t.returnedRef - t.returnedBat) - t.totalDischarged - t.finalSoc);

  const kwh  = v => `${Math.round(v).toLocaleString('nl-NL')} kWh`;
  const pctOf = v => hasSolar ? ` <span class="pct">(${(v / solar * 100).toFixed(0)}%)</span>` : '';
  const cell = v => v === null ? '—' : kwh(v) + pctOf(v);
  const diff = (a, b) => {
    if (a === null || b === null) return '—';
    const d = b - a;
    return `${d > 0 ? '+' : d < 0 ? '−' : ''}${Math.abs(Math.round(d)).toLocaleString('nl-NL')} kWh`;
  };
  const row = (label, a, b, cls = '') =>
    `<tr class="${cls}"><td>${label}</td><td>${cell(a)}</td><td>${cell(b)}</td><td>${diff(a, b)}</td></tr>`;

  const direct = hasSolar ? solar - t.returnedRef : null;
  const rows = [
    row('Opwek zonnepanelen', solar, solar),
    row('Direct zelf verbruikt', direct, direct),
    row('Zelf verbruikt via batterij', 0, viaBattery),
    row('Totaal zelfverbruik', direct, hasSolar ? direct + viaBattery : null, 'total-row'),
    row('Teruglevering aan het net', t.returnedRef, t.returnedBat),
    row('Omzetverlies in de batterij', 0, losses),
  ];
  // Netafname is geen deel van de opwek: zonder percentage
  const plain = v => kwh(v);
  rows.push(`<tr><td>Afname uit het net</td><td>${plain(t.deliveredRef)}</td><td>${plain(t.deliveredBat)}</td><td>${diff(t.deliveredRef, t.deliveredBat)}</td></tr>`);
  $('eb-table-body').innerHTML = rows.join('');

  let note = `Over de periode van de data (${Math.round(t.daysCovered)} dagen), niet geëxtrapoleerd. ` +
    `Berekend met de strategie "zon-overschot opslaan" (zonder laden uit het net).`;
  if (t.finalSoc > 0.05) note += ` Aan het eind zit nog ${t.finalSoc.toFixed(1)} kWh in de batterij.`;
  if (!hasSolar) {
    note += ` Vul bij stap 2 de opbrengst van de zonnepanelen in om het zelfverbruik ook in kWh en als percentage van de opwek te zien.`;
  } else if (solar < t.returnedRef) {
    note += ` <strong>Let op:</strong> de opgegeven opwek (${kwh(solar)}) is lager dan de gemeten teruglevering (${kwh(t.returnedRef)}); controleer de waarde.`;
  } else {
    note += ` Percentages zijn ten opzichte van de opgegeven opwek.`;
  }
  $('eb-note').innerHTML = note;
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
      const group  = btn.closest('.card') || document;   // alleen de eigen tab-groep
      group.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      group.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
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
  $('btn-peak').disabled = !_parsedData;
}

// ── Piekverlaging (Vermijd de piek) ───────────────────────────────────────────
function numOr(id, fallback) {
  const v = parseFloat($(id).value);
  return Number.isFinite(v) ? v : fallback;   // 0 is een geldige waarde
}

function getPeakParams() {
  const peakStartHour = Math.min(23, Math.max(0, numOr('pk-start', 16)));
  const peakEndHour   = Math.min(24, Math.max(peakStartHour + 1, numOr('pk-end', 21)));
  return {
    capacity:        Math.max(0, numOr('pk-capacity', 5)),
    efficiency:      Math.min(1, Math.max(0.5, numOr('pk-efficiency', 85) / 100)),
    surcharge:       Math.max(0, numOr('pk-surcharge', 0.12)),
    maxPowerKw:      Math.max(0, numOr('pk-power', 3000)) / 1000,   // invoer in watt
    peakStartHour,
    peakEndHour,
    targetPct:       numOr('pk-target', 36),
    chargeStartHour: Math.max(0, numOr('pk-ch-start', 0)),
    chargeEndHour:   numOr('pk-ch-end', 6),
    // Liander/Enexis-export heeft een 'van'-tijd (kwartier-start); overige formaten kwartier-einde
    intervalEnd:     !/Liander/.test(_parsedFormat || ''),
  };
}

function setPeakLoading(loading) {
  const btn = $('btn-peak');
  btn.disabled = loading;
  $('peak-spinner').classList.toggle('visible', loading);
  btn.querySelector('.btn-text').textContent = loading ? 'Berekenen...' : 'Bereken piekverlaging';
}

/** Haalt EPEX-prijzen op voor alleen de maanden waarin piekdagen vallen. */
async function loadPeakPrices(days) {
  const monthKeys = [...new Set(days.map(d => d.monthKey))];
  const priceMap  = new Map();
  let done = 0;
  for (const key of monthKeys) {
    showAlert('alert-peak', `Dynamische prijzen ophalen (${done}/${monthKeys.length} maanden)...`, 'info');
    const [y, m] = key.split('-').map(Number);
    const first  = new Date(y, m - 1, 1);
    const part   = await Pricing.loadPrices(first, first);
    for (const [ts, price] of part) priceMap.set(ts, price);
    done++;
  }
  return priceMap.size > 0 ? priceMap : null;
}

async function runPeakCalculation() {
  if (!_parsedData || _parsedData.length === 0) return;
  hideAlert('alert-peak');

  let params = getPeakParams();
  let result = simulatePeakShaving(_parsedData, params);

  if (result.days.length === 0) {
    $('peak-results').classList.add('hidden');
    showAlert('alert-peak',
      'Geen volledige dagen in november t/m februari gevonden in deze data.', 'warn');
    return;
  }

  // ── Dynamische prijzen voor de kosten/opbrengsten ─────────────────────────
  setPeakLoading(true);
  let priceMap = null;
  try {
    priceMap = await loadPeakPrices(result.days);
  } catch (err) {
    console.warn('Prijzen ophalen mislukt:', err);
  } finally {
    setPeakLoading(false);
  }
  hideAlert('alert-peak');
  if (priceMap) {
    params = { ...params, priceMap };
    result = simulatePeakShaving(_parsedData, params);
  } else {
    showAlert('alert-peak',
      'Dynamische prijzen niet beschikbaar: de kosten en opbrengsten worden niet getoond.', 'warn');
  }

  if (params.chargeEndHour > params.peakStartHour || params.chargeEndHour <= params.chargeStartHour) {
    showAlert('alert-peak',
      'Let op: het laadvenster moet vóór het piekvenster op dezelfde dag liggen; het is daarop begrensd.', 'warn');
  }

  const caps = [...new Set([0, 1, 2, 3, 4, 5, 7.5, 10, 15, 20, params.capacity])].sort((a, b) => a - b);
  const sweep = sweepPeakCapacity(_parsedData, params, caps);

  renderPeakResults(result, sweep);
  $('peak-results').classList.remove('hidden');
  $('peak-results').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function renderPeakResults(result, sweep) {
  const { totals: t, monthly, days, params, skippedDays } = result;
  const pct = v => `${v.toFixed(1)}%`;
  const eur = v => `${v < 0 ? '−' : ''}€${Math.abs(v).toFixed(2)}`;
  const hasBat = params.capacity > 0;

  $('pk-kpi-share').textContent     = pct(t.shareBat);
  $('pk-kpi-share').className       = `kpi-value ${t.shareBat <= params.targetPct ? 'green' : ''}`;
  $('pk-kpi-share-sub').textContent = hasBat
    ? `zonder batterij ${pct(t.shareRef)}` : 'van het dagverbruik (zonder batterij)';

  $('pk-kpi-kwh').textContent     = `${(t.peakBat / t.days).toFixed(1)} kWh`;
  $('pk-kpi-kwh-sub').textContent = hasBat
    ? `per dag · zonder ${(t.peakRef / t.days).toFixed(1)} kWh` : 'gemiddeld per dag';

  $('pk-kpi-kw').textContent     = `${t.maxKwBat.toFixed(1)} kW`;
  $('pk-kpi-kw-sub').textContent = hasBat
    ? `kwartiergemiddelde · zonder ${t.maxKwRef.toFixed(1)} kW` : 'hoogste kwartiergemiddelde';

  $('pk-kpi-target').textContent     = `${t.daysUnderTargetBat} / ${t.days}`;
  $('pk-kpi-target-sub').textContent = hasBat
    ? `≤ ${params.targetPct}% · zonder ${t.daysUnderTargetRef}` : `dagen ≤ ${params.targetPct}%`;

  $('pk-kpi-zero').textContent     = `${t.daysZero} / ${t.days}`;
  $('pk-kpi-zero-sub').textContent = 'piek volledig uit de batterij';

  const fmtDate = d => d.toLocaleDateString('nl-NL', { day: 'numeric', month: 'short', year: 'numeric' });
  $('pk-note').textContent =
    `${t.days} dagen (${fmtDate(days[0].date)} – ${fmtDate(days[days.length - 1].date)}), ` +
    `piekvenster ${params.peakStartHour}:00–${params.peakEndHour}:00, ` +
    `batterij ${params.capacity} kWh / ${Math.round(params.maxPowerKw * 1000)} W` +
    (skippedDays ? ` · ${skippedDays} onvolledige dag(en) overgeslagen` : '') + '.';

  const cls = v => v <= params.targetPct ? 'under-target' : 'over-target';
  const row = (m, extra = '') => `
    <tr class="${extra}">
      <td>${m.label}</td>
      <td>${m.days}</td>
      <td>${m.peakRef.toFixed(0)}</td>
      <td>${m.peakBat.toFixed(0)}</td>
      <td>${m.totalRef.toFixed(0)}</td>
      <td>${m.totalBat.toFixed(0)}</td>
      <td class="${cls(m.shareRef)}">${pct(m.shareRef)}</td>
      <td class="${cls(m.shareBat)}">${pct(m.shareBat)}</td>
      <td>${params.priceMap ? eur(m.netEur) : '—'}</td>
    </tr>`;
  $('pk-table-body').innerHTML = monthly.map(m => row(m)).join('') + row(t, 'total-row');

  // ── Kosten en opbrengsten bij dynamisch tarief ────────────────────────────
  if (params.priceMap) {
    const avg = (amount, kwh) => kwh > 0.001 ? `€${(amount / kwh).toFixed(3)}/kWh` : '—';
    const fin = (label, kwh, amount, sign, cls = '') => `
      <tr class="${cls}">
        <td>${label}</td>
        <td>${kwh === null ? '' : kwh.toFixed(0)}</td>
        <td>${kwh === null ? '' : avg(amount, kwh)}</td>
        <td>${eur(sign * amount)}</td>
      </tr>`;
    $('pk-fin-body').innerHTML =
      fin('Vermeden afname in de piek', t.discharged, t.avoidedEur, 1) +
      fin('Bijladen uit het net (nacht)', t.gridCharged, t.chargeEur, -1) +
      fin('Gemiste teruglevering (zon in batterij)', t.solarInKwh, t.lostFeedInEur, -1) +
      fin('Netto resultaat', null, t.netEur, 1, 'total-row');


    let note = `Over ${t.days} dagen in de piekmaanden. Afname gerekend tegen de EPEX day-ahead prijs ` +
      `+ €${params.surcharge.toFixed(2)}/kWh opslag; teruglevering tegen de kale EPEX-prijs (excl. btw). ` +
      `Een positief netto resultaat is een opbrengst, een negatief resultaat zijn kosten. ` +
      `De batterij is hier op piekverlaging gestuurd, niet op de laagste prijs; ` +
      `investering en afschrijving van de batterij zijn niet meegerekend.`;
    if (t.unpriced > 0.5) note += ` Voor ${t.unpriced.toFixed(0)} kWh was geen prijs beschikbaar; die is niet meegeteld.`;
    $('pk-fin-note').innerHTML = note;
  } else {
    $('pk-fin-body').innerHTML = '<tr><td colspan="4">Dynamische prijzen niet beschikbaar.</td></tr>';
    $('pk-fin-note').textContent = '';
  }

  Charts.renderPeakMonthly('chart-pk-monthly', monthly, params.targetPct);
  Charts.renderPeakDaily('chart-pk-daily', days, params.targetPct);
  Charts.renderPeakProfile('chart-pk-profile', result.profile, params.peakStartHour, params.peakEndHour);
  Charts.renderPeakCapacity('chart-pk-capacity', sweep, params.targetPct, params.capacity, !!params.priceMap);
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
