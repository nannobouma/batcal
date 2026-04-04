/**
 * pricing.js
 * Haalt historische en actuele EPEX SPOT day-ahead kwartierdata op.
 * Primaire bron: energyzero.nl API (CORS-vriendelijk, gratis, NL-markt).
 * Fallback:      energy-charts.info API (uurdata, interpolatie naar kwartieren).
 * Cache:         localStorage per maand.
 */

const Pricing = (() => {

  const CACHE_PREFIX = 'batcal_prices_';
  const ENERGYZERO_URL = 'https://api.energyzero.nl/v1/energyprices';
  const ENERGYCHARTS_URL = 'https://api.energy-charts.info/price';

  /** Status: 'energyzero' | 'energycharts' | 'unavailable' | null */
  let _apiStatus = null;

  /** In-memory cache: maandkey → Map<ts_ms, price> */
  const _memCache = {};

  /**
   * Laad prijzen voor een datumbereik.
   * @param {Date} startDate
   * @param {Date} endDate
   * @param {function} onProgress  - callback(loaded, total, label)
   * @returns {Map<number, number>} timestamp_ms → EUR/kWh
   */
  async function loadPrices(startDate, endDate, onProgress) {
    // Bepaal welke maanden nodig zijn
    const months = getMonthRange(startDate, endDate);
    const priceMap = new Map();

    let done = 0;
    for (const { year, month } of months) {
      const key = `${year}-${String(month).padStart(2, '0')}`;
      onProgress && onProgress(done, months.length, `Laden ${key}...`);

      const monthData = await getMonthPrices(year, month);
      for (const [ts, price] of monthData) {
        priceMap.set(ts, price);
      }
      done++;
    }

    onProgress && onProgress(months.length, months.length, 'Klaar');
    return priceMap;
  }

  /** Geeft maandprijzen als Map<ts_ms, price>; haalt op en cached indien nodig. */
  async function getMonthPrices(year, month) {
    const key = `${year}-${String(month).padStart(2, '0')}`;

    // In-memory cache
    if (_memCache[key]) return _memCache[key];

    // localStorage cache
    const cached = loadFromStorage(key);
    if (cached) {
      _memCache[key] = cached;
      return cached;
    }

    // Ophalen van API
    const data = await fetchMonth(year, month);
    if (data && data.size > 0) {
      saveToStorage(key, data);
      _memCache[key] = data;
      return data;
    }

    return new Map();
  }

  /** Haalt één maand op van API (probeert energyzero, dan energycharts). */
  async function fetchMonth(year, month) {
    const from = new Date(year, month - 1, 1);
    const to   = new Date(year, month,     1); // eerste van volgende maand

    // Probeer energyzero als status niet 'unavailable' is
    if (_apiStatus !== 'energycharts' && _apiStatus !== 'unavailable') {
      try {
        const data = await fetchEnergyZero(from, to);
        if (data && data.size > 0) {
          _apiStatus = 'energyzero';
          return data;
        }
      } catch (e) {
        console.warn('EnergyZero API fout:', e.message);
        if (_apiStatus === 'energyzero') _apiStatus = null; // reset zodat we fallback proberen
      }
    }

    // Fallback: energy-charts.info
    if (_apiStatus !== 'unavailable') {
      try {
        const data = await fetchEnergyCharts(from, to);
        if (data && data.size > 0) {
          _apiStatus = 'energycharts';
          return data;
        }
      } catch (e) {
        console.warn('Energy-Charts API fout:', e.message);
        _apiStatus = 'unavailable';
      }
    }

    return new Map();
  }

  /** Haalt data op van energyzero.nl */
  async function fetchEnergyZero(from, to) {
    const fromStr = from.toISOString().replace('000Z', '000Z');
    // till = laatste milliseconde van de periode
    const tillDate = new Date(to.getTime() - 1);
    const tillStr  = tillDate.toISOString();

    const url = `${ENERGYZERO_URL}?fromDate=${encodeURIComponent(fromStr)}&tillDate=${encodeURIComponent(tillStr)}&interval=4&usageType=1&inclBtw=false`;

    const resp = await fetch(url, { signal: AbortSignal.timeout(15000) });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);

    const json = await resp.json();
    const prices = json.Prices || json.prices || [];
    if (!prices.length) throw new Error('Geen prijzen in response');

    const map = new Map();
    for (const entry of prices) {
      const ts = parseApiDate(entry.readingDate || entry.fromPeriod || entry.timestamp);
      const price = entry.price ?? entry.Price;
      if (ts && price !== undefined) {
        map.set(ts, price);
      }
    }
    return map;
  }

  /** Haalt data op van energy-charts.info (uurdata, interpoleer naar kwartieren) */
  async function fetchEnergyCharts(from, to) {
    const startStr = formatDateISO(from);
    const endStr   = formatDateISO(new Date(to.getTime() - 86400000)); // tot en met gisteren

    const url = `${ENERGYCHARTS_URL}?bzn=NL&start=${startStr}&end=${endStr}`;
    const resp = await fetch(url, { signal: AbortSignal.timeout(15000) });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);

    const json = await resp.json();
    // Energy-charts response: { unix_seconds: [...], price: [...] }
    const seconds = json.unix_seconds || [];
    const prices  = json.price        || [];

    if (!seconds.length) throw new Error('Geen data van energy-charts');

    const map = new Map();
    for (let i = 0; i < seconds.length; i++) {
      const price = prices[i];
      if (price === null || price === undefined) continue;
      // Prijs is in EUR/MWh → omrekenen naar EUR/kWh
      const priceKwh = price / 1000;
      const baseTs   = seconds[i] * 1000; // ms
      // Interpoleer uurdata naar 4 kwartieren
      for (let q = 0; q < 4; q++) {
        map.set(baseTs + q * 900000, priceKwh);
      }
    }
    return map;
  }

  /** Parseert API-datumstring naar timestamp_ms (UTC). */
  function parseApiDate(str) {
    if (!str) return null;
    return new Date(str).getTime();
  }

  // ── localStorage ────────────────────────────────────────────────────────────

  function saveToStorage(key, map) {
    try {
      const entries = [...map.entries()];
      localStorage.setItem(CACHE_PREFIX + key, JSON.stringify(entries));
    } catch (e) {
      console.warn('localStorage schrijffout:', e);
    }
  }

  function loadFromStorage(key) {
    try {
      const raw = localStorage.getItem(CACHE_PREFIX + key);
      if (!raw) return null;
      const entries = JSON.parse(raw);
      // Controleer of de data niet ouder is dan 7 dagen voor de huidige maand
      const now = new Date();
      const [y, m] = key.split('-').map(Number);
      const isCurrentMonth = now.getFullYear() === y && now.getMonth() + 1 === m;
      if (isCurrentMonth) {
        // Huidige maand: altijd opnieuw ophalen voor verse data
        return null;
      }
      return new Map(entries);
    } catch (e) {
      return null;
    }
  }

  /** Verwijder alle cached prijsdata */
  function clearCache() {
    const keys = Object.keys(localStorage).filter(k => k.startsWith(CACHE_PREFIX));
    keys.forEach(k => localStorage.removeItem(k));
    Object.keys(_memCache).forEach(k => delete _memCache[k]);
    _apiStatus = null;
  }

  /** Geeft status van API ('energyzero' | 'energycharts' | 'unavailable' | null) */
  function getApiStatus() { return _apiStatus; }

  /** Geeft het aantal gecachede maanden */
  function getCachedMonths() {
    return Object.keys(localStorage)
      .filter(k => k.startsWith(CACHE_PREFIX))
      .map(k => k.replace(CACHE_PREFIX, ''));
  }

  // ── Utils ────────────────────────────────────────────────────────────────────

  function getMonthRange(startDate, endDate) {
    const months = [];
    let d = new Date(startDate.getFullYear(), startDate.getMonth(), 1);
    const end = new Date(endDate.getFullYear(), endDate.getMonth(), 1);
    while (d <= end) {
      months.push({ year: d.getFullYear(), month: d.getMonth() + 1 });
      d = new Date(d.getFullYear(), d.getMonth() + 1, 1);
    }
    return months;
  }

  function formatDateISO(date) {
    return date.toISOString().split('T')[0];
  }

  return { loadPrices, clearCache, getApiStatus, getCachedMonths };

})();
