/**
 * battery-sim.js
 * Simuleert een thuisbatterij op basis van kwartierdata.
 *
 * Strategie VAST TARIEF:
 *   - Zonne-surplus → opslaan in batterij
 *   - Tekort → batterij ontladen
 *
 * Strategie DYNAMISCH TARIEF:
 *   1. Zonne-surplus altijd opslaan (gratis, geen netkosten)
 *   2. Grid-laden ALLEEN als: goedkoopste_prijs + opslagkosten < piekprijs × roundtrip_eff
 *      (anders is arbitrage verliesgevend)
 *   3. Ontladen bij VOORKEUR tijdens de duurste kwartieren van de dag (avondpiek etc.)
 *      Buiten piekuren: alleen ontladen als SOC > 50% (reserve voor piek)
 */

/**
 * @param {Array}  data      - [{timestamp: Date, delivered: kWh, returned: kWh}]
 * @param {Object} params    - Configuratieparameters
 * @param {Map}    priceMap  - Map<timestamp_ms, EUR/kWh> of null voor vast tarief
 */
function simulateBattery(data, params, priceMap = null) {
  const {
    capacity,
    investment,
    efficiency,
    fixedPrice,
    feedInPrice,
    lifetimeYears,
    dynamicMode,
    storageCost = 0.12,
  } = params;

  const chargeEff    = Math.sqrt(efficiency);
  const dischargeEff = Math.sqrt(efficiency);
  // Max laad/ontlaadsnelheid: 1C per uur = capacity/4 per kwartier
  const maxRatePerInterval = capacity / 4;

  let soc = 0;

  // Dag-vooruitplanning voor dynamisch tarief
  let gridChargeSet    = null; // Set<ts_ms> — kwartieren om uit net te laden
  let peakDischargeSet = null; // Set<ts_ms> — kwartieren om bij voorkeur te ontladen
  if (dynamicMode && priceMap) {
    const plan = buildDynamicPlan(data, priceMap, params);
    gridChargeSet    = plan.gridChargeSet;
    peakDischargeSet = plan.peakDischargeSet;
  }

  const MAX_STORED = 366 * 96;
  const storedIntervals = [];

  const monthly = {};
  let totalCostRef     = 0;
  let totalCostBat     = 0;
  let totalCharged     = 0;
  let totalDischarged  = 0;
  let totalGridCharged = 0;

  for (let i = 0; i < data.length; i++) {
    const interval = data[i];
    const tsMs     = interval.timestamp.getTime();
    const price    = getPrice(tsMs, priceMap, fixedPrice);

    let delivered = interval.delivered;
    let returned  = interval.returned;

    // ── Stap 1: Zonne-surplus opslaan ──────────────────────────────────────
    // Altijd doen — er zijn geen netkosten bij surplus van eigen panelen
    if (returned > 0 && soc < capacity) {
      const maxChargeIn = Math.min(returned, maxRatePerInterval, (capacity - soc) / chargeEff);
      soc      = Math.min(capacity, soc + maxChargeIn * chargeEff);
      returned -= maxChargeIn;
      totalCharged += maxChargeIn * chargeEff;
    }

    // ── Stap 2: Grid-laden (alleen dynamisch, alleen als winstgevend) ───────
    let gridChargedThisInterval = 0;
    if (dynamicMode && gridChargeSet && gridChargeSet.has(tsMs) && soc < capacity * 0.95) {
      const spaceLeft   = capacity - soc;
      const maxChargeIn = Math.min(spaceLeft / chargeEff, maxRatePerInterval);
      soc       = Math.min(capacity, soc + maxChargeIn * chargeEff);
      delivered += maxChargeIn; // extra netafname
      totalCharged            += maxChargeIn * chargeEff;
      totalGridCharged        += maxChargeIn;
      gridChargedThisInterval  = maxChargeIn;
    }

    // ── Stap 3: Ontladen ────────────────────────────────────────────────────
    if (delivered > 0 && soc > 0) {
      const shouldDischarge = decideDischargeDynamic(
        dynamicMode, tsMs, peakDischargeSet, soc, capacity
      );

      if (shouldDischarge) {
        const maxDischarge = Math.min(delivered, soc * dischargeEff, maxRatePerInterval);
        soc       = Math.max(0, soc - maxDischarge / dischargeEff);
        delivered -= maxDischarge;
        totalDischarged += maxDischarge;
      }
    }

    // ── Kosten ──────────────────────────────────────────────────────────────
    // Bij dynamisch tarief betaalt de consument EPEX + opslagkosten per kWh uit het net.
    // Elke kWh die de batterij bespaart vermijdt dus de volle consumentenprijs.
    const consumerPrice = dynamicMode ? price + storageCost : price;
    const costRef = interval.delivered * consumerPrice - interval.returned * feedInPrice;
    const costBat = delivered          * consumerPrice - returned          * feedInPrice;

    totalCostRef += costRef;
    totalCostBat += costBat;

    const monthKey = formatMonthKey(interval.timestamp);
    if (!monthly[monthKey]) {
      monthly[monthKey] = {
        savings: 0, deliveredRef: 0, returnedRef: 0,
        deliveredBat: 0, returnedBat: 0, label: formatMonthLabel(interval.timestamp),
      };
    }
    const m = monthly[monthKey];
    m.savings      += costRef - costBat;
    m.deliveredRef += interval.delivered;
    m.returnedRef  += interval.returned;
    m.deliveredBat += delivered;
    m.returnedBat  += returned;

    if (storedIntervals.length < MAX_STORED) {
      storedIntervals.push({
        ts:        interval.timestamp,
        soc:       +soc.toFixed(4),
        delivered: +delivered.toFixed(4),
        returned:  +returned.toFixed(4),
        savings:   +(costRef - costBat).toFixed(4),
        price:     +price.toFixed(4),
      });
    }
  }

  // ── Resultaten ────────────────────────────────────────────────────────────
  const daysCovered = Math.max(1,
    (data[data.length - 1].timestamp - data[0].timestamp) / 86400000);
  const annualizeFactor = 365 / daysCovered;

  const totalSavings  = totalCostRef - totalCostBat;
  const annualSavings = totalSavings * annualizeFactor;
  const paybackYears  = annualSavings > 0 ? investment / annualSavings : Infinity;
  const roiPercent    = annualSavings > 0
    ? ((annualSavings * lifetimeYears - investment) / investment * 100) : -100;

  const totalDeliveredRef = Object.values(monthly).reduce((s, m) => s + m.deliveredRef, 0);
  const selfSufficiency   = totalDeliveredRef > 0 ? (totalDischarged / totalDeliveredRef * 100) : 0;
  const dailyThroughput   = totalDischarged / daysCovered;
  const utilizationPct    = capacity > 0 ? (dailyThroughput / capacity * 100) : 0;

  const monthlyArr = Object.entries(monthly)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, val]) => ({ ...val, key }));

  return {
    monthly: monthlyArr,
    intervals: storedIntervals,
    totals: {
      savings: totalSavings,
      annualSavings,
      paybackYears,
      roiPercent,
      selfSufficiency,
      utilizationPct,
      daysCovered,
      totalCharged,
      totalDischarged,
      totalGridCharged,
      costWithout: totalCostRef,
      costWith: totalCostBat,
      annualizeFactor,
      finalSoc: soc,
      deliveredRef: totalDeliveredRef,
      deliveredBat: monthlyArr.reduce((s, m) => s + m.deliveredBat, 0),
      returnedRef:  monthlyArr.reduce((s, m) => s + m.returnedRef, 0),
      returnedBat:  monthlyArr.reduce((s, m) => s + m.returnedBat, 0),
    },
    params,
  };
}

// ── Dag-vooruitplanning voor dynamisch tarief ─────────────────────────────────

/**
 * Bepaalt per dag welke kwartieren geschikt zijn voor grid-laden en voor piek-ontladen.
 *
 * Prioriteit:
 *   1. Zonne-surplus opslaan (gratis) — altijd voorrang
 *   2. Grid-arbitrage alleen met restcapaciteit na verwacht surplus
 *   3. Grid-laden alleen als prijsverschil winstgevend is na opslagkosten + roundtrip-verlies
 *   4. Grid-laden alleen in kwartieren VÓÓR de zonperiode als er genoeg ruimte overblijft,
 *      of NA de zonperiode als de batterij dan leeg genoeg is
 */
function buildDynamicPlan(data, priceMap, params) {
  const { capacity, efficiency, fixedPrice, storageCost = 0.12 } = params;
  const chargeEff = Math.sqrt(efficiency);
  const roundtrip = efficiency;

  const gridChargeSet    = new Set();
  const peakDischargeSet = new Set();

  // Groepeer per dag
  const days = {};
  for (const iv of data) {
    const key = formatDayKey(iv.timestamp);
    if (!days[key]) days[key] = [];
    days[key].push(iv);
  }

  for (const intervals of Object.values(days)) {
    // Bereken verwacht zonne-surplus voor deze dag
    let expectedSurplus = 0;
    for (const iv of intervals) {
      expectedSurplus += iv.returned; // kWh teruglevering = zonne-surplus
    }
    // Hoeveel daarvan past in de batterij (rekening houdend met laadefficiëntie)
    const solarChargeable = Math.min(expectedSurplus * chargeEff, capacity);

    // Restcapaciteit beschikbaar voor grid-laden
    const gridChargeRoom = Math.max(0, capacity - solarChargeable);

    // Als zonnepanelen de batterij al (bijna) vullen, geen grid-laden nodig
    if (gridChargeRoom < capacity * 0.1) {
      // Alleen piek-ontladen markeren, geen grid-laden
      markPeakDischarge(intervals, priceMap, fixedPrice, peakDischargeSet);
      continue;
    }

    // Prijs per kwartier
    const priced = intervals.map(iv => ({
      tsMs:  iv.timestamp.getTime(),
      price: getPrice(iv.timestamp.getTime(), priceMap, fixedPrice),
      returned: iv.returned,
    }));

    const sorted = [...priced].sort((a, b) => a.price - b.price);
    const n = sorted.length;

    // Duurste 25% = piek-ontlaadkwartieren
    const peakCount = Math.max(1, Math.floor(n * 0.25));
    const peakSlice = sorted.slice(n - peakCount);

    const avgPeakConsumerPrice = peakSlice.reduce((s, p) => s + p.price, 0) / peakSlice.length + storageCost;
    const profitThreshold = avgPeakConsumerPrice * roundtrip;

    // Goedkoopste kwartieren die GEEN zon-uren zijn (surplus > 0 = zon)
    // Grid-laden tijdens zonuren is zinloos: de batterij vult zich al gratis
    const cheapNoSolar = sorted.filter(p => p.returned === 0);
    const cheapCount = Math.max(1, Math.floor(cheapNoSolar.length * 0.25));
    const cheapSlice = cheapNoSolar.slice(0, cheapCount);

    const maxChargePerInterval = capacity / 4;
    let dailyChargeCapLeft = gridChargeRoom;

    for (const { tsMs, price } of cheapSlice) {
      if (dailyChargeCapLeft <= 0) break;
      const loadCost = price + storageCost;
      if (loadCost < profitThreshold) {
        gridChargeSet.add(tsMs);
        dailyChargeCapLeft -= maxChargePerInterval;
      }
    }

    // Piek-ontladen markeren
    for (const { tsMs } of peakSlice) {
      peakDischargeSet.add(tsMs);
    }
  }

  return { gridChargeSet, peakDischargeSet };
}

/** Markeer de duurste 25% kwartieren van een dag als piek-ontlaadmomenten */
function markPeakDischarge(intervals, priceMap, fixedPrice, peakDischargeSet) {
  const priced = intervals.map(iv => ({
    tsMs: iv.timestamp.getTime(),
    price: getPrice(iv.timestamp.getTime(), priceMap, fixedPrice),
  }));
  const sorted = [...priced].sort((a, b) => a.price - b.price);
  const peakCount = Math.max(1, Math.floor(sorted.length * 0.25));
  for (const { tsMs } of sorted.slice(sorted.length - peakCount)) {
    peakDischargeSet.add(tsMs);
  }
}

/**
 * Beslissing of we nu ontladen:
 * - Vast tarief: altijd ontladen bij tekort
 * - Dynamisch: voorkeur voor piekuren; buiten piek alleen als SOC > 50% (reserve voor piek)
 */
function decideDischargeDynamic(dynamicMode, tsMs, peakDischargeSet, soc, capacity) {
  if (!dynamicMode || !peakDischargeSet) return true;
  if (peakDischargeSet.has(tsMs)) return true;          // piekuur: altijd ontladen
  return soc > capacity * 0.50;                          // buiten piek: alleen bij >50% SOC
}

// ── Prijs-lookup ──────────────────────────────────────────────────────────────

function getPrice(tsMs, priceMap, fixedPrice) {
  if (!priceMap) return fixedPrice;
  if (priceMap.has(tsMs)) return priceMap.get(tsMs);
  const rounded = Math.floor(tsMs / 900000) * 900000;
  if (priceMap.has(rounded)) return priceMap.get(rounded);
  const hour = Math.floor(tsMs / 3600000) * 3600000;
  if (priceMap.has(hour)) return priceMap.get(hour);
  return fixedPrice;
}

// ── Formatters ────────────────────────────────────────────────────────────────

function formatMonthKey(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}
function formatMonthLabel(date) {
  return date.toLocaleDateString('nl-NL', { month: 'short', year: 'numeric' });
}
function formatDayKey(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}
