"use strict";

const PREFIXES = ["IH", "IF", "IC", "IM"];
const TERMS = ["当月", "下月", "当季", "下季"];
const INDEX_NAMES = { IH: "上证50", IF: "沪深300", IC: "中证500", IM: "中证1000" };
const DETAIL_PREFIXES = new Set(PREFIXES);
const DETAIL_TERMS = new Set(TERMS);
const TERM_PALETTES = {
  blue: { 当月: "#93c5fd", 下月: "#60a5fa", 当季: "#2563eb", 下季: "#1e40af" },
  red: { 当月: "#fda4af", 下月: "#fb7185", 当季: "#ef4444", 下季: "#991b1b" },
};
const METRIC_LABELS = {
  annualizedRate: "年化升贴水率",
  adjustedAnnualizedRate: "年化升贴水率（剔除期内分红）",
  spotCumulativeValue: "指数累计值",
  termPremiumDiscountChangeCumulativeValue: "升贴水率变动累计值",
};
const DETAIL_METRICS = {
  termPremiumDiscountChangeCumulativeValue: { label: "升贴水率变动累计值", digits: 6, suffix: "", baseline: 1 },
  futuresPrice: { label: "合约价格", digits: 2, suffix: "", baseline: null },
  priceChangePct: { label: "合约涨跌幅", digits: 2, suffix: "%", baseline: 0 },
  basis: { label: "基差", digits: 2, suffix: "", baseline: 0 },
  premiumDiscountRatePct: { label: "升贴水率", digits: 4, suffix: "%", baseline: 0 },
  premiumDiscountChangePct: { label: "升贴水率变动", digits: 2, suffix: "%", baseline: 0 },
  adjustedPremiumDiscountChangePct: { label: "升贴水率变动（剔除期内分红）", digits: 2, suffix: "%", baseline: 0 },
  annualizedRate: { label: "年化升贴水率", digits: 2, suffix: "%", baseline: 0 },
  adjustedAnnualizedRate: { label: "年化升贴水率（剔除期内分红）", digits: 2, suffix: "%", baseline: 0 },
  periodDividend: { label: "期内分红", digits: 4, suffix: "", baseline: 0 },
};
const state = {
  payload: { schemaVersion: 2, updatedAt: "", sourceDate: "", status: "awaiting-first-upload", rows: [] },
  prefixes: new Set(PREFIXES),
  terms: new Set(TERMS),
  chartTerms: Object.fromEntries(PREFIXES.map((prefix) => [prefix, new Set(TERMS)])),
  metric: "annualizedRate",
  startDate: "",
  endDate: "",
  detailScope: null,
  detailMetric: "termPremiumDiscountChangeCumulativeValue",
};

const byId = (id) => document.getElementById(id);
const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;",
})[char]);
const fmt = (value, digits = 2, sign = false) => {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return "—";
  const number = Number(value);
  const text = number.toFixed(digits);
  return sign && number > 0 ? `+${text}` : text;
};
const fmtPercent = (value, digits = 2, sign = false) =>
  value === null || value === undefined ? "—" : `${fmt(value, digits, sign)}%`;
const valueClass = (value) => Number(value) >= 0 ? "positive" : "negative";
const currentTheme = () => document.documentElement.dataset.theme === "red" ? "red" : "blue";
const termColor = (term) => TERM_PALETTES[currentTheme()][term];
const primaryChartColor = () => currentTheme() === "red" ? "#ef4444" : "#2563eb";

function setNotice(message, isError = false) {
  const notice = byId("notice");
  notice.hidden = !message;
  notice.textContent = message;
  notice.classList.toggle("error", isError);
}

function validatePayload(payload) {
  if (!payload || payload.schemaVersion !== 2 || !Array.isArray(payload.rows)) {
    throw new Error("data.json 格式不正确");
  }
  for (const row of payload.rows) {
    if (!PREFIXES.includes(row.prefix) || !TERMS.includes(row.term)) {
      throw new Error(`发现未知指数或期限：${row.prefix}/${row.term}`);
    }
    if (row.dataSource !== "Wind 日频") {
      throw new Error(`发现未知数据来源：${row.dataSource || "空值"}`);
    }
    const expectedDividendSource = ["IH", "IF"].includes(row.prefix) ? "RQ_FORECAST" : "WIND_ACTUAL";
    if (row.periodDividend !== null && row.periodDividendSource !== expectedDividendSource) {
      throw new Error(`期内分红来源与指数不匹配：${row.contract}`);
    }
    if (row.spotPrice !== null && row.futuresPrice !== null && row.basis !== null) {
      const expected = Number(row.futuresPrice) - Number(row.spotPrice);
      if (Math.abs(Number(row.basis) - expected) > 0.051) {
        throw new Error(`基差校验失败：${row.contract}`);
      }
    }
  }
}

function applyTheme(theme) {
  const safeTheme = theme === "red" ? "red" : "blue";
  document.documentElement.dataset.theme = safeTheme;
  localStorage.setItem("indexBasisTheme", safeTheme);
  byId("theme-blue").classList.toggle("active", safeTheme === "blue");
  byId("theme-red").classList.toggle("active", safeTheme === "red");
  if (state.payload.rows.length) renderAll();
}

function validMetricDates() {
  // The selectable interval is the stable Wind history window, not the first
  // non-null observation of the currently selected metric. Dividend-adjusted
  // fields can therefore remain blank before their source began without moving
  // the date picker or hiding earlier Wind history.
  return [...new Set(state.payload.rows
    .filter((row) => row.dataSource === "Wind 日频" && row.date)
    .map((row) => row.date))]
    .sort();
}

function resetDateRangeForMetric() {
  const dates = validMetricDates();
  state.startDate = dates[0] || "";
  state.endDate = dates[dates.length - 1] || "";
  byId("start-date").value = state.startDate;
  byId("end-date").value = state.endDate;
  byId("start-date").min = dates[0] || "";
  byId("start-date").max = dates[dates.length - 1] || "";
  byId("end-date").min = dates[0] || "";
  byId("end-date").max = dates[dates.length - 1] || "";
}

function renderChips() {
  byId("prefix-chips").innerHTML = PREFIXES.map((prefix) =>
    `<button type="button" class="chip ${state.prefixes.has(prefix) ? "active" : ""}" data-prefix="${prefix}">${prefix} · ${INDEX_NAMES[prefix]}</button>`
  ).join("");
  byId("term-chips").innerHTML = TERMS.map((term) =>
    `<button type="button" class="chip ${state.terms.has(term) ? "active" : ""}" data-term="${term}">${term}</button>`
  ).join("");

  document.querySelectorAll("#prefix-chips [data-prefix]").forEach((button) => {
    button.addEventListener("click", () => {
      const value = button.dataset.prefix;
      state.prefixes.has(value) ? state.prefixes.delete(value) : state.prefixes.add(value);
      renderAll();
    });
  });
  document.querySelectorAll("#term-chips [data-term]").forEach((button) => {
    button.addEventListener("click", () => {
      const value = button.dataset.term;
      state.terms.has(value) ? state.terms.delete(value) : state.terms.add(value);
      renderAll();
    });
  });
}

function latestRows() {
  const eligible = filteredRows().filter((row) => row.dataSource === "Wind 日频");
  const dates = eligible.map((row) => row.date).sort();
  const latestDate = dates[dates.length - 1] || "";
  return eligible
    .filter((row) => row.date === latestDate)
    .sort((a, b) => PREFIXES.indexOf(a.prefix) - PREFIXES.indexOf(b.prefix)
      || Number(a.remainingDays) - Number(b.remainingDays));
}

function renderCards(rows) {
  const visiblePrefixes = PREFIXES.filter((prefix) => state.prefixes.has(prefix));
  byId("card-grid").innerHTML = visiblePrefixes.map((prefix) => {
    const nearest = rows.filter((row) => row.prefix === prefix)
      .sort((a, b) => Number(a.remainingDays) - Number(b.remainingDays))[0];
    const spotMoveAvailable = nearest
      && nearest.spotChange !== null && nearest.spotChange !== undefined
      && nearest.spotChangePct !== null && nearest.spotChangePct !== undefined;
    const spotMove = spotMoveAvailable
      ? `指数 ${fmt(nearest.spotChange, 2, true)} · ${fmtPercent(nearest.spotChangePct, 2, true)}`
      : "指数日涨跌等待 Wind";
    return `<article class="index-card">
      <div class="card-top"><h3>${INDEX_NAMES[prefix]}</h3><span class="prefix-badge">${prefix}</span></div>
      <span class="eyebrow">现货指数</span>
      <strong class="spot">${nearest ? fmt(nearest.spotPrice) : "—"}</strong>
      <div class="card-foot">
        <span class="${spotMoveAvailable ? valueClass(nearest.spotChange) : "unavailable"}"
          title="对应现货指数日涨跌">
          ${nearest ? spotMove : "等待数据"}
        </span>
      </div>
    </article>`;
  }).join("");
}

function renderTable(rows) {
  const body = byId("latest-table-body");
  if (!rows.length) {
    body.innerHTML = '<tr><td colspan="12" class="empty-cell">等待 Windows 采集机发布首批数据</td></tr>';
    return;
  }
  body.innerHTML = rows.map((row) => `<tr>
    <td>${DETAIL_PREFIXES.has(row.prefix) && DETAIL_TERMS.has(row.term)
      ? `<button type="button" class="contract-link" data-detail-prefix="${row.prefix}"
          data-detail-term="${row.term}" title="查看 ${row.prefix} ${row.term}合约详情">${escapeHtml(row.contract)}</button>`
      : `<strong>${escapeHtml(row.contract)}</strong>`}<small>${escapeHtml(row.term)}</small></td>
    <td>${fmt(row.futuresPrice)}</td>
    <td class="${valueClass(row.priceChange)}">${fmt(row.priceChange, 2, true)}</td>
    <td class="${valueClass(row.priceChangePct)}">${fmtPercent(row.priceChangePct, 2, true)}</td>
    <td class="${valueClass(row.basis)}">${fmt(row.basis, 2, true)}</td>
    <td class="${valueClass(row.premiumDiscountChangePct)}">${fmtPercent(row.premiumDiscountChangePct, 2, true)}</td>
    <td class="adjusted ${valueClass(row.adjustedPremiumDiscountChangePct)}">${fmtPercent(row.adjustedPremiumDiscountChangePct, 2, true)}</td>
    <td>${fmtPercent(row.annualizedRate, 2, true)}</td>
    <td class="adjusted">${fmtPercent(row.adjustedAnnualizedRate, 2, true)}</td>
    <td class="${row.periodDividendSource === "RQ_FORECAST" ? "dividend-rq" : "dividend-wind"}">
      ${fmt(row.periodDividend, 4)}<small class="source-mini">${escapeHtml(row.periodDividendSourceLabel || "")}</small></td>
    <td>${escapeHtml(row.remainingDays)}</td>
    <td>${escapeHtml(row.expiryDate)}</td>
  </tr>`).join("");
  document.querySelectorAll("[data-detail-prefix][data-detail-term]").forEach((button) => {
    button.addEventListener("click", () => {
      state.detailScope = { prefix: button.dataset.detailPrefix, term: button.dataset.detailTerm };
      renderContractDetail();
    });
  });
}

function detailValue(row, key) {
  const config = DETAIL_METRICS[key];
  if (!config || row[key] === null || row[key] === undefined) return "—";
  return `${fmt(row[key], config.digits, !["futuresPrice", "periodDividend", "termPremiumDiscountChangeCumulativeValue"].includes(key))}${config.suffix}`;
}

function contractDetailTable(rows) {
  const body = [...rows].sort((a, b) => b.date.localeCompare(a.date)).map((row) => `<tr>
    <td>${escapeHtml(row.date)}</td>
    <td>${escapeHtml(row.contract)}</td>
    <td>${fmt(row.futuresPrice, 2)}</td>
    <td class="${valueClass(row.priceChangePct)}">${fmtPercent(row.priceChangePct, 2, true)}</td>
    <td class="${valueClass(row.basis)}">${fmt(row.basis, 2, true)}</td>
    <td>${fmtPercent(row.premiumDiscountRatePct, 4, true)}</td>
    <td class="${valueClass(row.premiumDiscountChangePct)}">${fmtPercent(row.premiumDiscountChangePct, 2, true)}</td>
    <td>${fmt(row.termPremiumDiscountChangeCumulativeValue, 6)}</td>
    <td class="adjusted ${valueClass(row.adjustedPremiumDiscountChangePct)}">${fmtPercent(row.adjustedPremiumDiscountChangePct, 2, true)}</td>
    <td>${fmtPercent(row.annualizedRate, 2, true)}</td>
    <td class="adjusted">${fmtPercent(row.adjustedAnnualizedRate, 2, true)}</td>
    <td class="${row.periodDividendSource === "RQ_FORECAST" ? "dividend-rq" : "dividend-wind"}">
      ${fmt(row.periodDividend, 4)}<small class="source-mini">${escapeHtml(row.periodDividendSourceLabel || "")}</small></td>
    <td>${escapeHtml(row.remainingDays)}</td>
  </tr>`).join("");
  return `<details class="detail-data"><summary>查看日频明细数据（${rows.length} 行）</summary>
    <div class="table-scroll"><table class="detail-table"><colgroup>
      <col style="width:6.5%"><col style="width:5%"><col style="width:6.5%"><col style="width:7%">
      <col style="width:5.5%"><col style="width:10%"><col style="width:8%"><col style="width:9.5%">
      <col style="width:10.5%"><col style="width:8%"><col style="width:10%"><col style="width:7.5%">
      <col style="width:6%"></colgroup><thead><tr>
      <th>日期</th><th>实际合约</th><th>合约价格</th><th>合约涨跌幅</th><th>基差</th>
      <th>升贴水率</th><th>升贴水率变动</th>
      <th>升贴水率变动<br>累计值</th>
      <th class="adjusted">升贴水率变动<br>（剔除期内分红）</th><th>年化升贴水率</th>
      <th class="adjusted">剔除分红年化率</th><th>期内分红</th><th>剩余天数</th>
    </tr></thead><tbody>${body}</tbody></table></div></details>`;
}

function contractDetailChart(rows, metricKey, prefix, term) {
  const config = DETAIL_METRICS[metricKey];
  const usable = rows.filter((row) => row[metricKey] !== null
    && row[metricKey] !== undefined && Number.isFinite(Number(row[metricKey])));
  if (!usable.length) return `<div class="empty-chart">当前区间暂无可绘制的“${escapeHtml(config.label)}”数据</div>`;
  const width = 720;
  const height = 300;
  const pad = { left: 54, right: 20, top: 20, bottom: 38 };
  const dates = usable.map((row) => row.date);
  const dateIndex = new Map(dates.map((date, index) => [date, index]));
  const values = usable.map((row) => Number(row[metricKey]));
  const reference = config.baseline;
  let min = reference === null ? Math.min(...values) : Math.min(...values, reference);
  let max = reference === null ? Math.max(...values) : Math.max(...values, reference);
  const spread = Math.max(max - min, .01);
  min -= spread * .12;
  max += spread * .12;
  const x = (date) => pad.left + ((dateIndex.get(date) || 0) / Math.max(dates.length - 1, 1))
    * (width - pad.left - pad.right);
  const y = (value) => pad.top + ((max - value) / (max - min)) * (height - pad.top - pad.bottom);
  const ticks = Array.from({ length: 5 }, (_, index) => max - ((max - min) * index) / 4);
  const grid = ticks.map((tick) => `<g>
    <line x1="${pad.left}" x2="${width - pad.right}" y1="${y(tick)}" y2="${y(tick)}" class="grid-line"></line>
    <text x="${pad.left - 10}" y="${y(tick) + 4}" text-anchor="end" class="axis-label">${fmt(tick, config.digits)}${config.suffix}</text>
  </g>`).join("");
  const coordinates = usable.map((row) => `${x(row.date)},${y(Number(row[metricKey]))}`).join(" ");
  const dots = sampleChartPoints(usable).map((row) => {
    const pointValue = detailValue(row, metricKey);
    const pointLabel = `${row.date} ${row.contract}（${prefix}${term}）${config.label} ${pointValue}`;
    const details = [
      `实际合约 ${row.contract}`,
      `合约价格 ${fmt(row.futuresPrice, 2)}`,
      `合约涨跌幅 ${fmtPercent(row.priceChangePct, 2, true)}`,
      `基差 ${fmt(row.basis, 2, true)}`,
      `升贴水率 ${fmtPercent(row.premiumDiscountRatePct, 4, true)}`,
      `升贴水率变动 ${fmtPercent(row.premiumDiscountChangePct, 2, true)}`,
      `升贴水率变动（剔除期内分红） ${fmtPercent(row.adjustedPremiumDiscountChangePct, 2, true)}`,
      `年化升贴水率 ${fmtPercent(row.annualizedRate, 2, true)}`,
      `剔除分红年化率 ${fmtPercent(row.adjustedAnnualizedRate, 2, true)}`,
      `期内分红 ${fmt(row.periodDividend, 4)}`,
      `剩余天数 ${row.remainingDays ?? "—"}`,
    ].join(" · ");
    return `<circle class="chart-point-hit interactive-dot" cx="${x(row.date)}" cy="${y(Number(row[metricKey]))}"
        r="${dates.length === 1 ? 7 : 6}" tabindex="0" role="button" aria-label="${escapeHtml(pointLabel)}"
        data-date="${escapeHtml(row.date)}" data-term="${escapeHtml(term)}"
        data-contract="${escapeHtml(row.contract)}" data-label="${escapeHtml(config.label)}"
        data-value="${escapeHtml(pointValue)}" data-details="${escapeHtml(details)}"></circle>`;
  }).join("");
  const baseline = reference === null ? "" : `<line x1="${pad.left}" x2="${width - pad.right}" y1="${y(reference)}" y2="${y(reference)}" class="zero-line"></line>`;
  const labels = [0, Math.floor((dates.length - 1) / 2), dates.length - 1]
    .filter((value, index, array) => array.indexOf(value) === index)
    .map((index) => `<text x="${x(dates[index])}" y="${height - 10}" text-anchor="middle" class="axis-label">${escapeHtml(dates[index])}</text>`).join("");
  const lastPoint = usable[usable.length - 1];
  const normalizationNote = metricKey === "termPremiumDiscountChangeCumulativeValue"
    ? " · 当前区间首点=1"
    : "";
  const endpoint = `<circle class="chart-end-dot" cx="${x(lastPoint.date)}"
    cy="${y(Number(lastPoint[metricKey]))}" r="3.8" fill="${primaryChartColor()}"
    stroke="white" stroke-width="1.8"></circle>`;
  return `<article class="chart-card detail-chart-card">
    <div class="chart-title"><div><strong>${prefix} · ${INDEX_NAMES[prefix]} · ${term}</strong>
      <small>${usable.length} 个有效交易日 · ${escapeHtml(config.label)}${normalizationNote}</small></div></div>
    <div class="chart-wrap detail-chart"><svg viewBox="0 0 ${width} ${height}" role="img"
    aria-label="${prefix}${term} ${escapeHtml(config.label)}">${grid}${baseline}<polyline points="${coordinates}" fill="none"
    class="term-line" stroke="${primaryChartColor()}" stroke-width="2.7" stroke-linejoin="round"
    stroke-linecap="round" vector-effect="non-scaling-stroke"></polyline>${dots}${endpoint}${labels}</svg>
    <div class="chart-tooltip" role="status" hidden></div></div></article>`;
}

function renderContractDetail() {
  const section = byId("contract-detail");
  const prefix = state.detailScope?.prefix;
  const term = state.detailScope?.term;
  if (!DETAIL_PREFIXES.has(prefix) || !DETAIL_TERMS.has(term)) {
    state.detailScope = null;
    section.hidden = true;
    return;
  }
  const detailTitle = `${prefix} ${term}合约详情`;
  let rows = state.payload.rows.filter((row) => row.prefix === prefix && row.term === term
      && row.dataSource === "Wind 日频"
      && (!state.startDate || row.date >= state.startDate)
      && (!state.endDate || row.date <= state.endDate))
    .sort((a, b) => a.date.localeCompare(b.date));
  rows = rebaseCumulativeRows(
    rows,
    "termPremiumDiscountChangeCumulativeValue",
  );
  if (!rows.length) {
    section.hidden = false;
    section.innerHTML = `<div class="detail-head"><div><span class="section-kicker">CONTRACT DRILL-DOWN</span>
      <h3>${detailTitle}</h3>
      <p>当前日期区间没有Wind日频数据，请扩大上方日期区间。</p></div>
      <button id="close-contract-detail" type="button" class="detail-close">收起 ×</button></div>`;
    byId("close-contract-detail").addEventListener("click", () => {
      state.detailScope = null;
      section.hidden = true;
    });
    return;
  }
  const options = Object.entries(DETAIL_METRICS).map(([key, config]) =>
    `<option value="${key}" ${key === state.detailMetric ? "selected" : ""}>${escapeHtml(config.label)}</option>`
  ).join("");
  const contracts = [...new Set(rows.map((row) => row.contract))].join("、");
  section.innerHTML = `<div class="detail-head"><div><span class="section-kicker">CONTRACT DRILL-DOWN</span>
    <h3>${detailTitle}</h3>
    <p>${rows.length} 个 Wind 日频观测；涉及合约：${escapeHtml(contracts)}。${term}合约换月时自动衔接；调整日期区间会同步刷新本图和明细表，并将新区间首个累计值重新归一化为1。IH/IF分红为米筐预测，IC/IM为Wind实际/已公告分红计算。</p></div>
    <div class="detail-actions"><select id="detail-metric-select" aria-label="${prefix}${term}详情图指标">${options}</select>
    <button id="close-contract-detail" type="button" class="detail-close">收起 ×</button></div></div>
    ${contractDetailChart(rows, state.detailMetric, prefix, term)}${contractDetailTable(rows)}`;
  section.hidden = false;
  bindChartPointInteractions(section);
  byId("detail-metric-select").addEventListener("change", (event) => {
    state.detailMetric = event.target.value;
    renderContractDetail();
  });
  byId("close-contract-detail").addEventListener("click", () => {
    state.detailScope = null;
    section.hidden = true;
  });
  section.scrollIntoView({ behavior: "smooth", block: "start" });
}

function filteredRows() {
  return state.payload.rows.filter((row) =>
    state.prefixes.has(row.prefix)
    && state.terms.has(row.term)
    && (!state.startDate || row.date >= state.startDate)
    && (!state.endDate || row.date <= state.endDate)
    && (state.metric === "adjustedAnnualizedRate" || row.dataSource === "Wind 日频")
  );
}

function sampleChartPoints(points, maxPoints = 480) {
  if (points.length <= maxPoints) return points;
  const required = new Set([0, points.length - 1]);
  points.forEach((row, index) => {
    if (index > 0 && row.contract !== points[index - 1].contract) {
      required.add(index - 1);
      required.add(index);
    }
  });
  const remaining = Math.max(maxPoints - required.size, 0);
  if (remaining > 0) {
    const step = (points.length - 1) / Math.max(remaining - 1, 1);
    for (let index = 0; index < remaining; index += 1) {
      required.add(Math.round(index * step));
    }
  }
  return [...required].sort((a, b) => a - b).map((index) => points[index]);
}

function rebaseCumulativeRows(rows, metricKey) {
  const first = rows.find((row) => row[metricKey] !== null
    && row[metricKey] !== undefined && Number.isFinite(Number(row[metricKey]))
    && Number(row[metricKey]) !== 0);
  if (!first) return rows.map((row) => ({ ...row, [metricKey]: null }));
  const anchor = Number(first[metricKey]);
  return rows.map((row) => {
    if (row[metricKey] === null || row[metricKey] === undefined) {
      return { ...row, [metricKey]: null };
    }
    const value = Number(row[metricKey]);
    return {
      ...row,
      [metricKey]: Number.isFinite(value) ? value / anchor : null,
    };
  });
}

function chartSvg(rows, prefix) {
  const width = 720;
  const height = 300;
  const pad = { left: 54, right: 20, top: 20, bottom: 38 };
  const isIndexCumulative = state.metric === "spotCumulativeValue";
  const isPremiumCumulative = state.metric === "termPremiumDiscountChangeCumulativeValue";
  const isCumulative = isIndexCumulative || isPremiumCumulative;
  const localTerms = state.chartTerms[prefix];
  let series = isIndexCumulative
    ? [{
      term: INDEX_NAMES[prefix],
      color: primaryChartColor(),
      points: rows.filter((row) => row.prefix === prefix
        && row[state.metric] !== null && row[state.metric] !== undefined)
        .sort((a, b) => a.date.localeCompare(b.date))
        .filter((row, index, array) => index === 0 || row.date !== array[index - 1].date),
    }]
    : TERMS.filter((term) => state.terms.has(term) && localTerms.has(term)).map((term) => ({
      term,
      color: termColor(term),
      points: rows.filter((row) =>
        row.prefix === prefix && row.term === term
        && row[state.metric] !== null && row[state.metric] !== undefined
      ).sort((a, b) => a.date.localeCompare(b.date)),
    })).filter((item) => item.points.length);
  if (isCumulative) {
    series = series.map((item) => ({
      ...item,
      points: rebaseCumulativeRows(item.points, state.metric),
    }));
  }
  const all = series.flatMap((item) => item.points);
  if (!all.length) return '<div class="empty-chart">该区间暂无可绘制数据</div>';

  const dates = [...new Set(all.map((row) => row.date))].sort();
  const dateIndex = new Map(dates.map((date, index) => [date, index]));
  const values = all.map((row) => Number(row[state.metric]));
  let min = isCumulative ? Math.min(...values, 1) : Math.min(...values, 0);
  let max = isCumulative ? Math.max(...values, 1) : Math.max(...values, 0);
  const spread = Math.max(max - min, isCumulative ? .01 : 1);
  min -= spread * .12;
  max += spread * .12;
  const x = (date) => pad.left + ((dateIndex.get(date) || 0) / Math.max(dates.length - 1, 1))
    * (width - pad.left - pad.right);
  const y = (value) => pad.top + ((max - value) / (max - min))
    * (height - pad.top - pad.bottom);
  const ticks = Array.from({ length: 5 }, (_, index) => max - ((max - min) * index) / 4);
  const dateTicks = [dates[0], dates[Math.floor((dates.length - 1) / 2)], dates[dates.length - 1]]
    .filter((value, index, array) => value && array.indexOf(value) === index);

  const grid = ticks.map((tick) => `<g>
    <line x1="${pad.left}" x2="${width - pad.right}" y1="${y(tick)}" y2="${y(tick)}" class="grid-line"></line>
    <text x="${pad.left - 10}" y="${y(tick) + 4}" text-anchor="end" class="axis-label">${isCumulative ? fmt(tick, 4) : fmt(tick, 1) + "%"}</text>
  </g>`).join("");
  const referenceLine = isCumulative
    ? `<line x1="${pad.left}" x2="${width - pad.right}" y1="${y(1)}" y2="${y(1)}" class="zero-line"></line>`
    : min < 0 && max > 0
      ? `<line x1="${pad.left}" x2="${width - pad.right}" y1="${y(0)}" y2="${y(0)}" class="zero-line"></line>` : "";
  const lines = series.map(({ term, color, points }) => {
    // 每个期限桶是一条连续序列；数据层已在换合约日承接前值，
    // 因此这里不再按具体合约拆成许多折线段。
    const coordinates = points.map((row) =>
      `${x(row.date)},${y(Number(row[state.metric]))}`).join(" ");
    const path = `<polyline class="term-line" points="${coordinates}" fill="none"
      stroke="${color}" stroke-width="2.7" stroke-linejoin="round"
      stroke-linecap="round" vector-effect="non-scaling-stroke"></polyline>`;
    const dots = sampleChartPoints(points).map((row) => {
      const pointValue = isCumulative
        ? fmt(row[state.metric], isPremiumCumulative ? 6 : 4, false)
        : fmtPercent(row[state.metric], 2, true);
      const rateValue = isPremiumCumulative
        ? fmtPercent(row.premiumDiscountRatePct, 4, true) : "";
      const pointLabel = `${row.date} ${term} ${METRIC_LABELS[state.metric]} ${pointValue}`;
      return `<circle class="chart-point-hit interactive-dot" cx="${x(row.date)}" cy="${y(Number(row[state.metric]))}"
          r="${dates.length === 1 ? 7 : 6}" tabindex="0" role="button"
          aria-label="${escapeHtml(pointLabel)}"
          data-date="${escapeHtml(row.date)}" data-term="${escapeHtml(term)}"
          data-contract="${escapeHtml(row.contract || "")}" data-rate="${escapeHtml(rateValue)}"
          data-value="${escapeHtml(pointValue)}"></circle>`;
    }).join("");
    const lastPoint = points[points.length - 1];
    const endpoint = lastPoint
      ? `<circle class="chart-end-dot" cx="${x(lastPoint.date)}"
          cy="${y(Number(lastPoint[state.metric]))}" r="3.8"
          fill="${color}" stroke="white" stroke-width="1.8"></circle>` : "";
    return `${path}${dots}${endpoint}`;
  }).join("");
  const dateLabels = dateTicks.map((date) =>
    `<text x="${x(date)}" y="${height - 10}" text-anchor="middle" class="axis-label">${escapeHtml(date)}</text>`
  ).join("");
  return `<div class="chart-wrap"><svg viewBox="0 0 ${width} ${height}" role="img"
    aria-label="${INDEX_NAMES[prefix]}${METRIC_LABELS[state.metric]}走势">${grid}${referenceLine}${lines}${dateLabels}</svg>
    <div class="chart-tooltip" role="status" hidden></div></div>`;
}

function hideChartTooltips(except = null) {
  document.querySelectorAll(".chart-tooltip").forEach((tooltip) => {
    if (tooltip !== except) {
      tooltip.hidden = true;
      tooltip.closest(".chart-wrap")?.removeAttribute("data-tooltip-pinned");
    }
  });
  document.querySelectorAll(".chart-point-hit.is-pinned").forEach((point) => {
    if (!except || point.closest(".chart-wrap")?.querySelector(".chart-tooltip") !== except) {
      point.classList.remove("is-pinned");
    }
  });
}

function clearChartTooltip(wrap) {
  if (!wrap) return;
  wrap.removeAttribute("data-tooltip-pinned");
  wrap.querySelectorAll(".chart-point-hit.is-pinned").forEach((point) => {
    point.classList.remove("is-pinned");
  });
  const tooltip = wrap.querySelector(".chart-tooltip");
  if (tooltip) tooltip.hidden = true;
}

function pinnedChartWrap() {
  return document.querySelector('.chart-wrap[data-tooltip-pinned="1"]');
}

function showChartTooltip(point, event = null, pin = false) {
  const wrap = point.closest(".chart-wrap");
  const tooltip = wrap ? wrap.querySelector(".chart-tooltip") : null;
  if (!wrap || !tooltip) return;
  if (!pin && pinnedChartWrap()) return;
  hideChartTooltips(tooltip);
  if (pin) {
    clearChartTooltip(wrap);
    wrap.dataset.tooltipPinned = "1";
    point.classList.add("is-pinned");
  }
  const metricLabel = point.dataset.label || METRIC_LABELS[state.metric];
  tooltip.textContent = `${point.dataset.date} · ${point.dataset.term} · `
    + `${metricLabel} ${point.dataset.value}`
    + (point.dataset.contract ? ` · 合约 ${point.dataset.contract}` : "")
    + (point.dataset.rate ? ` · 升贴水率 ${point.dataset.rate}` : "")
    + (point.dataset.details ? ` · ${point.dataset.details}` : "");
  tooltip.hidden = false;

  const wrapRect = wrap.getBoundingClientRect();
  const pointRect = point.getBoundingClientRect();
  const clientX = event && Number.isFinite(event.clientX) && event.clientX
    ? event.clientX : pointRect.left + pointRect.width / 2;
  const clientY = event && Number.isFinite(event.clientY) && event.clientY
    ? event.clientY : pointRect.top + pointRect.height / 2;
  const preferredLeft = clientX - wrapRect.left + 12;
  const preferredTop = clientY - wrapRect.top - tooltip.offsetHeight - 12;
  tooltip.style.left = `${Math.max(8, Math.min(preferredLeft, wrapRect.width - tooltip.offsetWidth - 8))}px`;
  tooltip.style.top = `${Math.max(8, preferredTop)}px`;
}

function bindChartPointInteractions(container = document) {
  container.querySelectorAll(".chart-wrap").forEach((wrap) => {
    if (wrap.dataset.wrapInteractionBound === "1") return;
    wrap.dataset.wrapInteractionBound = "1";
    wrap.addEventListener("pointerleave", () => {
      if (wrap.dataset.tooltipPinned !== "1") clearChartTooltip(wrap);
    });
    wrap.addEventListener("click", (event) => {
      if (!event.target.closest(".chart-point-hit")) clearChartTooltip(wrap);
    });
  });
  container.querySelectorAll(".chart-point-hit").forEach((point) => {
    if (point.dataset.interactionBound === "1") return;
    point.dataset.interactionBound = "1";
    point.addEventListener("pointerenter", (event) => showChartTooltip(point, event));
    point.addEventListener("pointermove", (event) => showChartTooltip(point, event));
    point.addEventListener("pointerleave", () => {
      const wrap = point.closest(".chart-wrap");
      if (wrap?.dataset.tooltipPinned !== "1") clearChartTooltip(wrap);
    });
    point.addEventListener("focus", () => showChartTooltip(point));
    point.addEventListener("blur", () => {
      const wrap = point.closest(".chart-wrap");
      if (wrap?.dataset.tooltipPinned !== "1") clearChartTooltip(wrap);
    });
    point.addEventListener("click", (event) => {
      event.stopPropagation();
      showChartTooltip(point, event, true);
    });
  });
}

function bindChartInteractions() {
  document.querySelectorAll("[data-legend-term]").forEach((button) => {
    button.addEventListener("click", () => {
      const prefix = button.dataset.chartPrefix;
      const term = button.dataset.legendTerm;
      const localTerms = state.chartTerms[prefix];
      localTerms.has(term) ? localTerms.delete(term) : localTerms.add(term);
      renderCharts();
    });
  });
  bindChartPointInteractions(document);
}

function renderCharts() {
  const isIndexCumulative = state.metric === "spotCumulativeValue";
  const isPremiumCumulative = state.metric === "termPremiumDiscountChangeCumulativeValue";
  byId("trend-title").textContent = isIndexCumulative
    ? "指数累计值走势"
    : isPremiumCumulative ? "IC、IM 升贴水率变动累计值" : "年化升贴水率走势";
  byId("trend-subtitle").textContent = isIndexCumulative
    ? "当前日期区间的首个有效点动态归一化为1；调整起始日期后立即重新定基。"
    : isPremiumCumulative
      ? "仅展示 IC、IM；每个期限在当前区间首个有效点动态归一化为1。换合约日承接前值，不计入新旧合约水平差。"
      : "贴水显示在零轴下方；区间、指数与期限均可调整。";
  const rows = filteredRows();
  const selectedPrefixes = PREFIXES.filter((prefix) => state.prefixes.has(prefix)
    && (!isPremiumCumulative || ["IC", "IM"].includes(prefix)));
  if (!selectedPrefixes.length) {
    byId("chart-grid").innerHTML = '<div class="empty-chart">请至少选择一个指数</div>';
    return;
  }
  byId("chart-grid").innerHTML = selectedPrefixes.map((prefix) => {
    const localTerms = state.chartTerms[prefix];
    const isCumulative = isIndexCumulative || isPremiumCumulative;
    const count = rows.filter((row) => row.prefix === prefix
      && localTerms.has(row.term)
      && row[state.metric] !== null && row[state.metric] !== undefined).length;
    const legend = isIndexCumulative ? "" : TERMS.map((term) => {
      const globallyEnabled = state.terms.has(term);
      const active = globallyEnabled && localTerms.has(term);
      return `<button type="button" class="legend-item ${active ? "active" : ""}"
        data-chart-prefix="${prefix}" data-legend-term="${term}"
        aria-pressed="${active}" ${globallyEnabled ? "" : "disabled"}
        title="${globallyEnabled ? `仅在${prefix}图中显示或隐藏${term}` : `请先在上方期限筛选中启用${term}`}">
        <i style="background:${termColor(term)}"></i>${term}</button>`;
    }).join("");
    return `<article class="chart-card">
      <div class="chart-title"><div><strong>${prefix} · ${INDEX_NAMES[prefix]}</strong>
        <small>${isCumulative ? new Set(rows.filter((row) => row.prefix === prefix && row[state.metric] != null).map((row) => row.date)).size : count} 个有效交易日${count > 0 && count <= 4 ? "（数据较少时显示为点）" : ""}</small></div>
        <div class="legend">${legend}</div>
      </div>${chartSvg(rows, prefix)}
    </article>`;
  }).join("");
  bindChartInteractions();
}

function renderAll() {
  renderChips();
  const rows = latestRows();
  renderCards(rows);
  renderTable(rows);
  byId("updated-at").textContent = state.payload.updatedAt
    ? `更新时间：${new Date(state.payload.updatedAt).toLocaleString("zh-CN")}`
    : "尚未同步";
  byId("chart-grid").innerHTML = '<div class="empty-chart">正在绘制历史图表…</div>';
  requestAnimationFrame(() => renderCharts());
  if (state.detailScope) renderContractDetail();
}

async function loadData() {
  try {
    setNotice("正在读取历史数据…");
    const response = await fetch(`./data/data.json?t=${Date.now()}`, { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = await response.json();
    validatePayload(payload);
    state.payload = payload;
    resetDateRangeForMetric();
    byId("status-dot").className = payload.rows.length ? "status-dot live" : "status-dot";
    byId("status-text").textContent = payload.rows.length ? "数据已同步" : "等待首次发布";
    if (!payload.rows.length) {
      setNotice("公共 HTML 已就绪，请先在 Windows 运行 update_public_html_windows.bat。");
    } else {
      setNotice("");
    }
    renderAll();
  } catch (error) {
    byId("status-dot").className = "status-dot error";
    byId("status-text").textContent = "数据读取失败";
    setNotice(`无法读取 data/data.json：${error.message}`, true);
    renderAll();
  }
}

function bindEvents() {
  byId("theme-blue").addEventListener("click", () => applyTheme("blue"));
  byId("theme-red").addEventListener("click", () => applyTheme("red"));
  byId("start-date").addEventListener("change", (event) => {
    state.startDate = event.target.value;
    renderAll();
  });
  byId("end-date").addEventListener("change", (event) => {
    state.endDate = event.target.value;
    renderAll();
  });
  byId("metric-select").addEventListener("change", (event) => {
    state.metric = event.target.value;
    resetDateRangeForMetric();
    renderAll();
  });
}

document.addEventListener("DOMContentLoaded", () => {
  bindEvents();
  applyTheme(localStorage.getItem("indexBasisTheme") || "blue");
  renderChips();
  loadData();
});
