/**
 * csv-parser.js
 * Auto-detecteert en parseert kwartierdata van Nederlandse slimme meters.
 * Ondersteunde formaten:
 *   - Netbeheerder export (datum_tijd + normaal/laag kolommen)
 *   - Liander / Enexis (datum + van/tot + verbruik/teruglevering)
 *   - DSMR-reader (timestamp + electricity_delivered_1/2 + electricity_returned_1/2)
 *   - Generiek (kolommen met levering/verbruik termen)
 * Output: { data: [{timestamp: Date, delivered: kWh, returned: kWh}], meta: {...} }
 */

/**
 * Hoofdfunctie: parseert CSV-tekst naar genormaliseerde kwartierdata.
 * @param {string} text - Ruwe CSV-tekst
 * @returns {{ data: Array, meta: Object, error: string|null }}
 */
function parseSmartMeterCSV(text) {
  const delimiter = detectDelimiter(text);

  const result = Papa.parse(text, {
    delimiter,
    skipEmptyLines: true,
    header: false,
  });

  const rows = result.data;
  if (!rows || rows.length < 3) {
    return { data: [], meta: {}, error: 'Bestand bevat te weinig rijen.' };
  }

  const { headerIdx, headers } = findHeaderRow(rows);
  if (headerIdx === -1) {
    return { data: [], meta: {}, error: 'Geen herkenbare kolomnamen gevonden. Controleer het bestandsformaat.' };
  }

  const dataRows = rows.slice(headerIdx + 1).filter(r => r.some(c => c.trim() !== ''));
  if (dataRows.length === 0) {
    return { data: [], meta: {}, error: 'Geen datarijen gevonden na de header.' };
  }

  const mapping = detectColumnMapping(headers);
  if (!mapping) {
    return { data: [], meta: {}, error: `Kolommen niet herkend. Headers gevonden: ${headers.join(', ')}` };
  }

  // Parseer rijen
  const parsed = [];
  let parseErrors = 0;

  if (mapping.cumulative) {
    // ── Cumulatief formaat (P1-monitor): bereken delta's ──────────────────
    let prevDelivered = null;
    let prevReturned  = null;

    for (const row of dataRows) {
      try {
        const ts = parseTimestamp(row, mapping);
        if (!ts || isNaN(ts.getTime())) { parseErrors++; continue; }

        // Som cumulatieve meterstanden
        let curDelivered = 0;
        for (const idx of mapping.deliveredCols) {
          curDelivered += parseNumber(row[idx]);
        }
        let curReturned = 0;
        for (const idx of mapping.returnedCols) {
          curReturned += parseNumber(row[idx]);
        }

        // Sla rijen over zonder data (lege velden → 0, maar alle kolommen leeg)
        const hasData = mapping.deliveredCols.some(idx => row[idx] && row[idx].trim() !== '');
        if (!hasData) { continue; }

        if (prevDelivered !== null) {
          const deltaDelivered = Math.max(0, curDelivered - prevDelivered);
          const deltaReturned  = Math.max(0, curReturned  - prevReturned);
          // Filter onrealistische sprongen (meterreset o.i.d.)
          if (deltaDelivered < 10 && deltaReturned < 10) {
            parsed.push({ timestamp: ts, delivered: deltaDelivered, returned: deltaReturned });
          }
        }
        prevDelivered = curDelivered;
        prevReturned  = curReturned;
      } catch (e) {
        parseErrors++;
      }
    }
  } else {
    // ── Regulier formaat: waarden per kwartier ────────────────────────────
    for (const row of dataRows) {
      try {
        const ts = parseTimestamp(row, mapping);
        if (!ts || isNaN(ts.getTime())) { parseErrors++; continue; }

        let delivered = 0;
        for (const idx of mapping.deliveredCols) {
          delivered += parseNumber(row[idx]);
        }
        let returned = 0;
        for (const idx of mapping.returnedCols) {
          returned += parseNumber(row[idx]);
        }

        parsed.push({ timestamp: ts, delivered, returned });
      } catch (e) {
        parseErrors++;
      }
    }
  }

  if (parsed.length === 0) {
    return { data: [], meta: {}, error: 'Geen geldige datarijen geparseerd. Controleer het formaat.' };
  }

  parsed.sort((a, b) => a.timestamp - b.timestamp);
  const deduped = deduplicateData(parsed);

  const firstDate = deduped[0].timestamp;
  const lastDate  = deduped[deduped.length - 1].timestamp;
  const daysCovered = (lastDate - firstDate) / (1000 * 60 * 60 * 24);
  const quarterHoursExpected = Math.round(daysCovered * 96);
  const completeness = deduped.length / Math.max(quarterHoursExpected, 1);

  return {
    data: deduped,
    meta: {
      format: mapping.format,
      firstDate,
      lastDate,
      daysCovered: Math.round(daysCovered),
      intervals: deduped.length,
      completeness: Math.min(completeness, 1),
      parseErrors,
    },
    error: null,
  };
}

// ── Delimiter detectie ────────────────────────────────────────────────────────

function detectDelimiter(text) {
  const firstLines = text.split('\n').slice(0, 5).join('\n');
  const semicolons = (firstLines.match(/;/g) || []).length;
  const commas     = (firstLines.match(/,/g) || []).length;
  return semicolons >= commas ? ';' : ',';
}

// ── Header-rij zoeken ─────────────────────────────────────────────────────────

function findHeaderRow(rows) {
  for (let i = 0; i < Math.min(rows.length, 15); i++) {
    const row = rows[i];
    const joined = row.join(' ').toLowerCase();
    const hasDate = /datum|date|timestamp|datetime|time/.test(joined);
    const hasDel  = /levering|verbruik|afname|consumptie|delivered|consumption|electricity_delivered|import/.test(joined);
    if (hasDate && hasDel) {
      return { headerIdx: i, headers: row.map(c => c.trim()) };
    }
  }
  return { headerIdx: -1, headers: [] };
}

// ── Kolom-mapping detectie ────────────────────────────────────────────────────

function detectColumnMapping(headers) {
  const lower = headers.map(h => h.toLowerCase().trim());

  // ── Formaat 0: P1-monitor (cumulatieve meterstanden) ─────────────────────
  // Headers: time, Import T1 kWh, Import T2 kWh, Export T1 kWh, Export T2 kWh, ...
  const hasImport = lower.some(h => /^import/.test(h));
  const hasExport = lower.some(h => /^export/.test(h));
  if (hasImport && hasExport) {
    const tsCol = lower.findIndex(h => h === 'time' || h === 'timestamp' || h === 'datetime');
    const importCols = [];
    const exportCols = [];
    lower.forEach((h, i) => {
      if (/^import.*kwh/.test(h)) importCols.push(i);
      if (/^export.*kwh/.test(h)) exportCols.push(i);
    });
    if (tsCol !== -1 && importCols.length > 0) {
      return {
        format: 'P1-monitor (cumulatief)',
        cumulative: true,
        timestampCol: tsCol,
        dateCol: -1,
        timeCol: -1,
        deliveredCols: importCols,
        returnedCols:  exportCols,
      };
    }
  }

  // ── Formaat 1: Netbeheerder met datum_tijd + normaal/laag kolommen ──────
  // Headers: datum_tijd; levering_normaal; levering_laag; teruglevering_normaal; teruglevering_laag; ...
  const datumTijdCol = lower.findIndex(h => h === 'datum_tijd');
  if (datumTijdCol !== -1) {
    const delCols = [];
    const retCols = [];
    lower.forEach((h, i) => {
      if (i === datumTijdCol) return;
      if (/^levering/.test(h) && !/teruglevering/.test(h)) delCols.push(i);
      if (/teruglevering/.test(h)) retCols.push(i);
    });
    return {
      format: 'Netbeheerder (datum_tijd)',
      timestampCol: datumTijdCol,
      dateCol: -1,
      timeCol: -1,
      deliveredCols: delCols,
      returnedCols:  retCols,
    };
  }

  // ── Formaat 2: DSMR-reader ─────────────────────────────────────────────
  const dDel1 = lower.findIndex(h => h.includes('electricity_delivered_1'));
  if (dDel1 !== -1) {
    const dDel2 = lower.findIndex(h => h.includes('electricity_delivered_2'));
    const dRet1 = lower.findIndex(h => h.includes('electricity_returned_1'));
    const dRet2 = lower.findIndex(h => h.includes('electricity_returned_2'));
    const dTs   = lower.findIndex(h => /timestamp|datetime|datum/.test(h));
    const delCols = [dDel1];
    if (dDel2 !== -1) delCols.push(dDel2);
    const retCols = [];
    if (dRet1 !== -1) retCols.push(dRet1);
    if (dRet2 !== -1) retCols.push(dRet2);
    return {
      format: 'DSMR-reader',
      timestampCol: dTs,
      dateCol: -1,
      timeCol: -1,
      deliveredCols: delCols,
      returnedCols:  retCols,
    };
  }

  // ── Formaat 3: Liander/Enexis met apart datum + tijd ───────────────────
  // Gecombineerde timestamp kolom
  const tsCol = lower.findIndex(h =>
    h === 'timestamp' || h === 'datetime' || h === 'datum en tijd' ||
    (h.includes('tijd') && h.includes('datum'))
  );
  // Datum kolom (alleen "datum", niet "datum_tijd" die hierboven al gematcht is)
  const dateCol = lower.findIndex(h => /^datum$|^date$|^dag$/.test(h));
  // Tijd/van kolom
  const timeCol = lower.findIndex(h =>
    /^van$|^from$|^tijdstip$/.test(h) || (h.includes('tijdstip') && h.includes('van'))
  );

  // Levering-kolommen (alle die matchen)
  const delCols = [];
  const retCols = [];
  lower.forEach((h, i) => {
    const isRet = /teruglevering|teruggave|teruggeleverd|returned|feedin|feed-in|return|opwek/.test(h);
    const isDel = /levering|verbruik|afname|consumptie|delivered|consumption/.test(h);
    if (isRet) retCols.push(i);
    else if (isDel) delCols.push(i);
  });

  const hasTimestamp = tsCol !== -1 || dateCol !== -1;
  if (hasTimestamp && delCols.length > 0) {
    const format = dateCol !== -1 ? 'Liander/Enexis' : 'Generiek (timestamp)';
    return {
      format,
      timestampCol: tsCol,
      dateCol,
      timeCol,
      deliveredCols: delCols,
      returnedCols:  retCols,
    };
  }

  return null;
}

// ── Timestamp parsing ─────────────────────────────────────────────────────────

function parseTimestamp(row, mapping) {
  // Gecombineerde timestamp kolom
  if (mapping.timestampCol !== -1 && mapping.timestampCol !== undefined) {
    const raw = (row[mapping.timestampCol] || '').trim();
    if (!raw) return null;
    return parseDateTimeString(raw);
  }

  // Aparte datum + tijd kolommen
  if (mapping.dateCol !== -1) {
    const dateStr = (row[mapping.dateCol] || '').trim();
    const timeStr = mapping.timeCol !== -1 ? (row[mapping.timeCol] || '').trim() : '00:00';
    return parseDutchDateTime(dateStr, timeStr);
  }

  return null;
}

/**
 * Parseert een datumtijd-string in diverse formaten:
 *   "01-01-2025 00:15:00 +0100"  (netbeheerder)
 *   "2025-01-01T00:00:00+01:00"  (ISO / DSMR-reader)
 *   "01-01-2025 00:15"           (kort formaat)
 *   "2025-01-01 00:15:00"        (ISO zonder T)
 */
function parseDateTimeString(str) {
  // Formaat: DD-MM-YYYY HH:MM:SS +HHMM (of +HH:MM)
  let m = str.match(/^(\d{1,2})-(\d{1,2})-(\d{4})\s+(\d{2}):(\d{2})(?::(\d{2}))?\s*([+-]\d{2}:?\d{2})?$/);
  if (m) {
    const [, dd, mm, yyyy, hh, min, ss, tz] = m;
    // Bouw ISO string op voor correcte timezone-handling
    const isoStr = `${yyyy}-${mm.padStart(2,'0')}-${dd.padStart(2,'0')}T${hh}:${min}:${ss || '00'}${formatTZ(tz)}`;
    return new Date(isoStr);
  }

  // ISO formaat met T
  if (str.includes('T')) return new Date(str);

  // YYYY-MM-DD HH:MM:SS
  m = str.match(/^(\d{4})-(\d{1,2})-(\d{1,2})\s+(\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (m) {
    const [, yyyy, mm, dd, hh, min, ss] = m;
    return new Date(+yyyy, +mm - 1, +dd, +hh, +min, +(ss || 0));
  }

  // Fallback: DD-MM-YYYY of YYYY-MM-DD (alleen datum)
  return parseDutchDate(str);
}

/** Normaliseert timezone string: "+0100" → "+01:00", "+01:00" → "+01:00", undefined → "" */
function formatTZ(tz) {
  if (!tz) return '';
  tz = tz.trim();
  // Al in +HH:MM formaat
  if (/^[+-]\d{2}:\d{2}$/.test(tz)) return tz;
  // +HHMM → +HH:MM
  if (/^[+-]\d{4}$/.test(tz)) return tz.slice(0, 3) + ':' + tz.slice(3);
  return tz;
}

/** Parseert NL datum formaten: DD-MM-YYYY, DD/MM/YYYY, YYYY-MM-DD */
function parseDutchDate(str) {
  str = str.trim();
  let m = str.match(/^(\d{1,2})[-\/](\d{1,2})[-\/](\d{4})$/);
  if (m) return new Date(+m[3], +m[2] - 1, +m[1]);
  m = str.match(/^(\d{4})[-\/](\d{1,2})[-\/](\d{1,2})$/);
  if (m) return new Date(+m[1], +m[2] - 1, +m[3]);
  return new Date(str);
}

function parseDutchDateTime(dateStr, timeStr) {
  const d = parseDutchDate(dateStr);
  if (!d || isNaN(d)) return null;
  const [h, min] = (timeStr || '00:00').split(':').map(Number);
  d.setHours(h || 0, min || 0, 0, 0);
  return d;
}

/** Vervangt Nederlandse decimale komma door punt; lege string → 0 */
function parseNumber(str) {
  if (str === undefined || str === null || str === '') return 0;
  return parseFloat(String(str).trim().replace(',', '.')) || 0;
}

/** Verwijder dubbele timestamps (zomertijdovergang) */
function deduplicateData(data) {
  const seen = new Set();
  return data.filter(d => {
    const key = d.timestamp.getTime();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
