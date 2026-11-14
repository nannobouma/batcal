/**
 * peak-sim.js
 * Piekverlaging ("Vermijd de piek"): hoe ver kan een batterij de eigen netafname
 * in het piekvenster (standaard nov–feb, 16:00–21:00) terugbrengen?
 *
 * Model per dag:
 *   1. Vóór de piek wordt de batterij bijgeladen: eerst met zon-overschot,
 *      de rest uit het net in het laadvenster (standaard 00–06 u), verdeeld over
 *      de kwartieren met de laagste afname ("valley-filling").
 *   2. In de piek ontlaadt de batterij zo dat de resterende afname zo vlak en
 *      laag mogelijk is ("water-filling"). Er wordt nooit teruggeleverd.
 *
 * Het model kent het verbruik van de dag vooraf: de uitkomst is dus het
 * theoretisch haalbare maximum voor de opgegeven batterij.
 *
 * Maatstaf: piekaandeel = afname in het piekvenster / afname over 24 uur.
 */

const PEAK_DEFAULTS = {
  capacity:        5,
  efficiency:      0.85,
  maxPowerKw:      3,
  peakStartHour:   16,
  peakEndHour:     21,
  chargeStartHour: 0,
  chargeEndHour:   6,
  months:          [11, 12, 1, 2],
  targetPct:       36,
  intervalEnd:     true,   // tijdstempel = einde van het kwartier
  minIntervals:    90,     // minimum aantal kwartieren voor een bruikbare dag
  priceMap:        null,   // Map<kwartier-start ms, EPEX €/kWh> voor de financiële berekening
  surcharge:       0.12,   // opslag op de EPEX-prijs bij afname (€/kWh)
};

/**
 * @param {Array}  data   - [{timestamp: Date, delivered: kWh, returned: kWh}]
 * @param {Object} params - zie PEAK_DEFAULTS
 */
function simulatePeakShaving(data, params) {
  const p = { ...PEAK_DEFAULTS, ...params };
  const capacity     = Math.max(0, p.capacity);
  const chargeEff    = Math.sqrt(p.efficiency);
  const dischargeEff = Math.sqrt(p.efficiency);
  const maxQ         = Math.max(0, p.maxPowerKw) / 4;   // kWh per kwartier

  const peakStart = Math.round(p.peakStartHour * 4);
  const peakEnd   = Math.round(p.peakEndHour * 4);
  const chStart   = Math.round(Math.max(0, p.chargeStartHour) * 4);
  const chEnd     = Math.round(Math.min(p.chargeEndHour, p.peakStartHour) * 4);

  // ── Groepeer per kalenderdag, ingedeeld op kwartier-start ─────────────────
  const dayMap = new Map();
  const shift  = p.intervalEnd ? 900000 : 0;
  for (const iv of data) {
    const start = new Date(iv.timestamp.getTime() - shift);
    if (!p.months.includes(start.getMonth() + 1)) continue;
    const key = formatDayKey(start);
    let day = dayMap.get(key);
    if (!day) {
      day = {
        key,
        date: new Date(start.getFullYear(), start.getMonth(), start.getDate()),
        del: new Array(96).fill(0),
        ret: new Array(96).fill(0),
        has: new Array(96).fill(false),
        t0: start.getTime() - (start.getHours() * 4 + Math.floor(start.getMinutes() / 15)) * 900000,
        count: 0,
      };
      dayMap.set(key, day);
    }
    const slot = start.getHours() * 4 + Math.floor(start.getMinutes() / 15);
    if (!day.has[slot]) { day.has[slot] = true; day.count++; }
    day.del[slot] += iv.delivered;
    day.ret[slot] += iv.returned;
  }

  const allDays = [...dayMap.values()].sort((a, b) => a.date - b.date);
  const days = [];
  let skippedDays = 0;
  for (const d of allDays) {
    let peakComplete = true;
    for (let s = peakStart; s < peakEnd; s++) if (!d.has[s]) { peakComplete = false; break; }
    if (d.count >= p.minIntervals && peakComplete) days.push(d);
    else skippedDays++;
  }

  // ── Simulatie ─────────────────────────────────────────────────────────────
  const profRef = new Array(24).fill(0);
  const profBat = new Array(24).fill(0);
  const dayResults = [];
  let soc = capacity;
  let prevDate = null;

  for (const d of days) {
    const charge    = new Array(96).fill(0);   // extra netafname voor laden
    const discharge = new Array(96).fill(0);   // door batterij gedekte afname
    const solarIn   = new Array(96).fill(0);   // zon-overschot dat de batterij in gaat
    let solarCharged = 0;
    let gridCharged  = 0;

    const contiguous = prevDate && Math.round((d.date - prevDate) / 86400000) === 1;
    if (!contiguous) {
      soc = capacity;                          // start van een blok: batterij vol
    } else if (capacity - soc > 1e-9) {
      // ── Bijladen vóór de piek: zon eerst, rest uit het net ───────────────
      const deficit = capacity - soc;
      let solarStored = 0;
      for (let s = 0; s < peakStart && solarStored < deficit; s++) {
        if (d.ret[s] <= 0) continue;
        const stored = Math.min(d.ret[s], maxQ) * chargeEff;
        const take   = Math.min(stored, deficit - solarStored);
        solarStored += take;
        solarIn[s]   = take / chargeEff;
      }
      solarCharged = solarStored;

      const gridNeed = (deficit - solarStored) / chargeEff;   // kWh uit het net
      if (gridNeed > 1e-9 && chEnd > chStart && maxQ > 0) {
        const loads = d.del.slice(chStart, chEnd);
        const fill  = valleyFill(loads, gridNeed, maxQ);
        for (let i = 0; i < fill.length; i++) {
          charge[chStart + i] = fill[i];
          gridCharged += fill[i];
        }
      }
      soc = Math.min(capacity, soc + solarStored + gridCharged * chargeEff);
    }

    // ── Ontladen in de piek ────────────────────────────────────────────────
    const peakLoads = d.del.slice(peakStart, peakEnd);
    const shave     = peakShave(peakLoads, soc * dischargeEff, maxQ);
    let discharged  = 0;
    for (let i = 0; i < shave.length; i++) {
      discharge[peakStart + i] = shave[i];
      discharged += shave[i];
    }
    soc = Math.max(0, soc - discharged / dischargeEff);

    // ── Dagresultaat ───────────────────────────────────────────────────────
    let totalRef = 0, peakRef = 0, peakBat = 0, maxRef = 0, maxBat = 0;
    for (let s = 0; s < 96; s++) {
      const ref = d.del[s];
      const bat = ref - discharge[s] + charge[s];
      totalRef += ref;
      const h = Math.floor(s / 4);
      profRef[h] += ref;
      profBat[h] += bat;
      if (s >= peakStart && s < peakEnd) {
        peakRef += ref;
        peakBat += bat;
        if (ref > maxRef) maxRef = ref;
        if (bat > maxBat) maxBat = bat;
      }
    }
    const totalBat = totalRef - discharged + gridCharged;

    // ── Financieel (dynamisch tarief) ──────────────────────────────────────
    // Afname kost EPEX + opslag; teruglevering levert de kale EPEX-prijs op.
    let avoidedEur = 0, chargeEur = 0, lostFeedInEur = 0, solarInKwh = 0, unpriced = 0;
    if (p.priceMap) {
      for (let s = 0; s < 96; s++) {
        if (!discharge[s] && !charge[s] && !solarIn[s]) continue;
        const price = peakPriceLookup(p.priceMap, d.t0 + s * 900000);
        if (price === null) { unpriced += discharge[s] + charge[s] + solarIn[s]; continue; }
        avoidedEur    += discharge[s] * (price + p.surcharge);
        chargeEur     += charge[s]    * (price + p.surcharge);
        lostFeedInEur += solarIn[s]   * price;
      }
    }
    for (let s = 0; s < 96; s++) solarInKwh += solarIn[s];

    dayResults.push({
      key: d.key,
      date: d.date,
      monthKey: formatMonthKey(d.date),
      monthLabel: formatMonthLabel(d.date),
      peakRef, peakBat: Math.max(0, peakBat),
      totalRef, totalBat,
      shareRef: totalRef > 0 ? peakRef / totalRef * 100 : 0,
      shareBat: totalBat > 0 ? Math.max(0, peakBat) / totalBat * 100 : 0,
      maxKwRef: maxRef * 4,
      maxKwBat: maxBat * 4,
      discharged, gridCharged, solarCharged,
      solarInKwh, avoidedEur, chargeEur, lostFeedInEur, unpriced,
      netEur: avoidedEur - chargeEur - lostFeedInEur,
      socEnd: soc,
    });
    prevDate = d.date;
  }

  // ── Aggregatie ────────────────────────────────────────────────────────────
  const monthMap = new Map();
  const tot = newPeakAgg('Totaal');
  for (const r of dayResults) {
    let m = monthMap.get(r.monthKey);
    if (!m) { m = newPeakAgg(r.monthLabel); m.key = r.monthKey; monthMap.set(r.monthKey, m); }
    for (const a of [m, tot]) {
      a.days++;
      a.peakRef  += r.peakRef;   a.peakBat  += r.peakBat;
      a.totalRef += r.totalRef;  a.totalBat += r.totalBat;
      a.discharged += r.discharged;
      a.gridCharged += r.gridCharged;
      a.solarCharged += r.solarCharged;
      a.solarInKwh   += r.solarInKwh;
      a.avoidedEur   += r.avoidedEur;
      a.chargeEur    += r.chargeEur;
      a.lostFeedInEur += r.lostFeedInEur;
      a.netEur       += r.netEur;
      a.unpriced     += r.unpriced;
      a.maxKwRef = Math.max(a.maxKwRef, r.maxKwRef);
      a.maxKwBat = Math.max(a.maxKwBat, r.maxKwBat);
      if (r.totalRef > 0 && r.shareRef <= p.targetPct) a.daysUnderTargetRef++;
      if (r.totalBat > 0 && r.shareBat <= p.targetPct) a.daysUnderTargetBat++;
      if (r.peakRef > 0.001 && r.peakBat < 0.001) a.daysZero++;
    }
  }
  const finish = a => {
    a.shareRef = a.totalRef > 0 ? a.peakRef / a.totalRef * 100 : 0;
    a.shareBat = a.totalBat > 0 ? a.peakBat / a.totalBat * 100 : 0;
    return a;
  };
  const monthly = [...monthMap.values()].sort((a, b) => a.key.localeCompare(b.key)).map(finish);
  finish(tot);

  const n = Math.max(1, dayResults.length);
  return {
    params: p,
    days: dayResults,
    monthly,
    totals: tot,
    skippedDays,
    profile: {
      ref: profRef.map(v => v / n),   // gem. kWh per uur = gem. kW
      bat: profBat.map(v => v / n),
    },
  };
}

/** Draait de simulatie voor een reeks capaciteiten (kWh). */
function sweepPeakCapacity(data, params, capacities) {
  return capacities.map(capacity => {
    const t = simulatePeakShaving(data, { ...params, capacity }).totals;
    return {
      capacity,
      shareBat: t.shareBat,
      peakPerDay: t.days > 0 ? t.peakBat / t.days : 0,
      maxKwBat: t.maxKwBat,
      daysUnderTargetBat: t.daysUnderTargetBat,
      days: t.days,
      netEur: t.netEur,
    };
  });
}

function newPeakAgg(label) {
  return {
    label, days: 0,
    peakRef: 0, peakBat: 0, totalRef: 0, totalBat: 0,
    discharged: 0, gridCharged: 0, solarCharged: 0,
    solarInKwh: 0, avoidedEur: 0, chargeEur: 0, lostFeedInEur: 0, netEur: 0, unpriced: 0,
    maxKwRef: 0, maxKwBat: 0,
    daysUnderTargetRef: 0, daysUnderTargetBat: 0, daysZero: 0,
    shareRef: 0, shareBat: 0,
  };
}

/** EPEX-prijs voor een kwartier-start; valt terug op de uurprijs. null = onbekend. */
function peakPriceLookup(priceMap, tsMs) {
  if (priceMap.has(tsMs)) return priceMap.get(tsMs);
  const hour = Math.floor(tsMs / 3600000) * 3600000;
  if (priceMap.has(hour)) return priceMap.get(hour);
  return null;
}

/**
 * Water-filling: verdeel `available` kWh over de kwartieren zodat de resterende
 * afname zo vlak mogelijk wordt (hoogste kwartieren eerst), max `maxQ` per kwartier.
 * @returns {number[]} ontlading per kwartier
 */
function peakShave(loads, available, maxQ) {
  const cut = T => loads.map(l => Math.min(Math.max(0, l - T), maxQ));
  const sum = arr => arr.reduce((s, v) => s + v, 0);
  if (available <= 0 || maxQ <= 0) return loads.map(() => 0);

  const atZero = cut(0);
  if (sum(atZero) <= available) return atZero;   // genoeg voor alles (binnen vermogen)

  let lo = 0, hi = Math.max(...loads);
  for (let i = 0; i < 50; i++) {
    const mid = (lo + hi) / 2;
    if (sum(cut(mid)) > available) lo = mid; else hi = mid;
  }
  return cut(hi);
}

/**
 * Valley-filling: verdeel `need` kWh laadenergie over de kwartieren met de
 * laagste afname, max `maxQ` per kwartier.
 * @returns {number[]} extra afname per kwartier
 */
function valleyFill(loads, need, maxQ) {
  const fill = V => loads.map(l => Math.min(Math.max(0, V - l), maxQ));
  const sum  = arr => arr.reduce((s, v) => s + v, 0);
  if (need <= 0 || maxQ <= 0 || loads.length === 0) return loads.map(() => 0);

  if (maxQ * loads.length <= need) return loads.map(() => maxQ);   // vermogen is de beperking

  let lo = Math.min(...loads), hi = Math.max(...loads) + maxQ;
  for (let i = 0; i < 50; i++) {
    const mid = (lo + hi) / 2;
    if (sum(fill(mid)) < need) lo = mid; else hi = mid;
  }
  return fill(lo);
}
