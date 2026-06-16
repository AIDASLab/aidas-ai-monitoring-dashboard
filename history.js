// 기록 탭 — 고른 기간의 AI 사용을 사람·계정·모델·도구별로 합산한다.
//
// 데이터(history.json)는 하루 × 사람 × 도구 × 계정 × 모델 × 속도 × effort 로만
// 묶여 온다. 기간 합산·묶음·차트는 전부 여기서 하므로 기간을 바꿔도 서버에 다시
// 묻지 않는다. 날짜는 한국 시각 기준이다.
//
// 같은 파일을 세 곳에서 쓴다 — 공개 대시보드(gpu-grants-dashboard/docs/ai),
// 중앙 서버(aidas-ai-monitoring/frontend), 중앙 정적 사본(aidas-ai-monitoring-dashboard).
// 고칠 때는 셋을 같이 바꾼다. 화면마다 다른 것은 데이터를 읽는 방법뿐이라
// AIHistory.render(요소, 읽기함수) 로 받는다.
(function () {
  "use strict";

  const RELOAD_MS = 5 * 60 * 1000;
  const MAX_SERIES = 8;
  const COLORS = ["#4493f8", "#3fb950", "#d29922", "#bc8cff", "#f85149",
                  "#39c5cf", "#db6d28", "#e3b341", "#8b949e"];
  const GROUPS = [
    { key: "owner", label: "사람" },
    { key: "account", label: "계정·도구" },
    { key: "model", label: "모델" },
    { key: "provider", label: "도구" },
  ];
  const UNITS = [
    { key: "day", label: "일" },
    { key: "week", label: "주" },
    { key: "month", label: "월" },
  ];
  const METRICS = [
    { key: "credits", label: "크레딧" },
    { key: "tokens", label: "토큰" },
  ];
  const SPEED_LABEL = { standard: "표준", fast: "fast ×2", flex: "flex ×0.5" };

  const H = {
    el: null, loader: null, data: null, loadedAt: 0, loading: null, error: null,
    chart: null, open: null,
    st: null,          // { from, to, by, unit, metric }
  };

  // ---- 작은 도구들 --------------------------------------------------------
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  function fmtCredit(c) {
    c = c || 0;
    if (c >= 100) return Math.round(c).toLocaleString();
    if (c >= 10) return c.toFixed(1);
    if (c >= 0.01) return c.toFixed(2);
    return c > 0 ? "<0.01" : "0";
  }
  function fmtTok(n) {
    n = n || 0;
    if (n >= 1e9) return (n / 1e9).toFixed(2) + "B";
    if (n >= 1e6) return (n / 1e6).toFixed(1) + "M";
    if (n >= 1e3) return (n / 1e3).toFixed(1) + "K";
    return String(n);
  }
  const fmtPct = (p) => (p > 0 && p < 0.1 ? "<0.1" : (p || 0).toFixed(1)) + "%";
  const bar = (p) => `<span class="hx-bar"><i style="width:${Math.min(100, Math.max(0, p || 0))}%"></i></span>`;

  // 날짜는 문자열 'YYYY-MM-DD' 로만 다룬다. Date 로 바꿀 때는 UTC 정오에 두어
  // 브라우저 시간대와 서머타임에 흔들리지 않게 한다.
  const toDate = (s) => new Date(s + "T12:00:00Z");
  const toStr = (d) => d.toISOString().slice(0, 10);
  function addDays(s, n) { const d = toDate(s); d.setUTCDate(d.getUTCDate() + n); return toStr(d); }
  function todayKST() { return toStr(new Date(Date.now() + 9 * 3600 * 1000)); }
  const monthOf = (s) => s.slice(0, 7);
  function monthEnd(m) {
    const d = toDate(m + "-01"); d.setUTCMonth(d.getUTCMonth() + 1); d.setUTCDate(0); return toStr(d);
  }
  function weekStart(s) {                   // 월요일 시작
    const d = toDate(s); const wd = (d.getUTCDay() + 6) % 7; d.setUTCDate(d.getUTCDate() - wd); return toStr(d);
  }
  function daysBetween(a, b) { return Math.round((toDate(b) - toDate(a)) / 86400000) + 1; }
  function bucketOf(day, unit) {
    if (unit === "month") return monthOf(day);
    if (unit === "week") return weekStart(day);
    return day;
  }
  function bucketLabel(b, unit) {
    if (unit === "month") return b.replace("-", ".") ;
    if (unit === "week") return b.slice(5).replace("-", "/") + " 주";
    return b.slice(5).replace("-", "/");
  }
  function bucketsBetween(from, to, unit) {
    const out = [];
    let cur = bucketOf(from, unit);
    while (cur <= bucketOf(to, unit)) {
      out.push(cur);
      if (unit === "month") cur = monthOf(addDays(monthEnd(cur), 1));
      else cur = addDays(cur, unit === "week" ? 7 : 1);
    }
    return out;
  }

  // ---- 상태: 주소창(#history?...)에 남겨 그대로 공유·새로고침할 수 있게 -----
  function readHash() {
    const m = /^#history\??(.*)$/.exec(location.hash || "");
    if (!m) return {};
    const q = new URLSearchParams(m[1]);
    const o = {};
    for (const k of ["from", "to", "by", "unit", "metric"]) if (q.get(k)) o[k] = q.get(k);
    return o;
  }
  function writeHash() {
    const s = H.st;
    const q = new URLSearchParams({ from: s.from, to: s.to, by: s.by, unit: s.unit, metric: s.metric });
    const h = "#history?" + q.toString();
    if (location.hash !== h) history.replaceState(null, "", h);
  }
  function initState(d) {
    const last = d.last_day || todayKST();
    const first = d.first_day || last;
    const h = readHash();
    const ok = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s || "");
    H.st = {
      // 기본은 이번 달 — 월 단위로 보는 경우가 가장 많다(Codex 크레딧 월 한도 등).
      from: ok(h.from) ? h.from : (monthOf(last) + "-01" < first ? first : monthOf(last) + "-01"),
      to: ok(h.to) ? h.to : last,
      by: GROUPS.some((g) => g.key === h.by) ? h.by : "owner",
      unit: UNITS.some((u) => u.key === h.unit) ? h.unit : "day",
      metric: METRICS.some((m) => m.key === h.metric) ? h.metric : "credits",
    };
    if (H.st.from > H.st.to) [H.st.from, H.st.to] = [H.st.to, H.st.from];
  }

  function presets(d) {
    const last = d.last_day || todayKST();
    const first = d.first_day || last;
    const clip = (s) => (s < first ? first : s);
    const thisM = monthOf(last);
    const prevM = monthOf(addDays(thisM + "-01", -1));
    const out = [
      { label: "최근 7일", from: clip(addDays(last, -6)), to: last },
      { label: "최근 30일", from: clip(addDays(last, -29)), to: last },
      { label: "이번 달", from: clip(thisM + "-01"), to: last },
    ];
    if (prevM + "-01" >= monthOf(first) + "-01") {
      out.push({ label: "지난 달", from: clip(prevM + "-01"), to: monthEnd(prevM) });
    }
    out.push({ label: "전체", from: first, to: last });
    return out;
  }

  // ---- 데이터 ------------------------------------------------------------
  async function ensureData(force) {
    if (H.loading) return H.loading;
    if (H.data && !force && Date.now() - H.loadedAt < RELOAD_MS) return H.data;
    H.loading = (async () => {
      try {
        const d = await H.loader();
        if (!d || !Array.isArray(d.rows) || !d.dims) throw new Error("기록 데이터 형식이 아닙니다");
        H.data = d; H.loadedAt = Date.now(); H.error = null;
        if (!H.st) initState(d);
      } catch (e) {
        H.error = e;
      } finally {
        H.loading = null;
      }
      return H.data;
    })();
    return H.loading;
  }

  function groupKey(d, r, by) {
    const D = d.dims;
    if (by === "owner") return D.owner[r[1]];
    if (by === "provider") return D.provider[r[2]];
    if (by === "model") return D.model[r[4]] || "(모델 미상)";
    const acct = (D.account[r[3]] || "").split("@")[0] || "계정 없음";
    return `${D.provider[r[2]]} · ${acct}`;
  }

  function aggregate() {
    const d = H.data, s = H.st, D = d.dims;
    const ix = Object.fromEntries(d.cols.map((c, i) => [c, i]));
    const groups = new Map();
    const tot = { credits: 0, tokens: 0, turns: 0, unpriced: 0, unassigned: 0 };
    const days = new Set();
    for (const r of d.rows) {
      const day = D.day[r[ix.day]];
      if (day < s.from || day > s.to) continue;
      const tokens = r[ix.input] + r[ix.output] + r[ix.cache_write] + r[ix.cache_read];
      const credits = r[ix.credits];
      const key = groupKey(d, r, s.by);
      let g = groups.get(key);
      if (!g) {
        g = { key, credits: 0, tokens: 0, turns: 0, unpriced: 0, days: new Set(),
              buckets: new Map(), detail: new Map(),
              comp: { input: 0, output: 0, cache_write: 0, cache_read: 0 } };
        groups.set(key, g);
      }
      g.credits += credits; g.tokens += tokens; g.turns += r[ix.turns]; g.unpriced += r[ix.unpriced];
      g.comp.input += r[ix.input]; g.comp.output += r[ix.output];
      g.comp.cache_write += r[ix.cache_write]; g.comp.cache_read += r[ix.cache_read];
      g.days.add(day);
      const b = bucketOf(day, s.unit);
      const bv = g.buckets.get(b) || { credits: 0, tokens: 0 };
      bv.credits += credits; bv.tokens += tokens; g.buckets.set(b, bv);
      // 상세: 이 묶음이 무엇으로 이뤄졌나 (사람 / 도구·계정 / 모델 / 속도 / effort)
      const dk = [D.owner[r[1]], D.provider[r[2]], D.account[r[3]], D.model[r[4]],
                  D.speed[r[5]], D.effort[r[6]]].join("\u0001");
      const dv = g.detail.get(dk) || { credits: 0, tokens: 0, turns: 0, unpriced: 0 };
      dv.credits += credits; dv.tokens += tokens; dv.turns += r[ix.turns]; dv.unpriced += r[ix.unpriced];
      g.detail.set(dk, dv);
      tot.credits += credits; tot.tokens += tokens; tot.turns += r[ix.turns]; tot.unpriced += r[ix.unpriced];
      if (D.owner[r[1]] === "미분류") tot.unassigned += credits;
      days.add(day);
    }
    const list = [...groups.values()].sort((a, b) =>
      (s.metric === "tokens" ? b.tokens - a.tokens : b.credits - a.credits) || a.key.localeCompare(b.key));
    return { list, tot, activeDays: days.size };
  }

  // ---- 그리기 --------------------------------------------------------------
  function controlsHTML(d) {
    const s = H.st;
    const seg = (items, cur, attr) => `<div class="hx-seg">${items.map((x) =>
      `<button type="button" data-${attr}="${x.key}" class="${x.key === cur ? "on" : ""}">${x.label}</button>`).join("")}</div>`;
    const pre = presets(d).map((p) => {
      const on = p.from === s.from && p.to === s.to;
      return `<button type="button" class="hx-pre ${on ? "on" : ""}" data-from="${p.from}" data-to="${p.to}">${p.label}</button>`;
    }).join("");
    const months = [];
    for (let m = monthOf(d.first_day); m <= monthOf(d.last_day); m = monthOf(addDays(monthEnd(m), 1))) months.push(m);
    const monthSel = `<select class="hx-month" aria-label="월 선택"><option value="">월 선택…</option>${
      months.reverse().map((m) => `<option value="${m}">${m.replace("-", "년 ")}월</option>`).join("")}</select>`;
    return `<div class="hx-ctl">
      <div class="hx-range">
        <label>시작 <input type="date" class="hx-from" value="${s.from}" min="${d.first_day}" max="${d.last_day}"></label>
        <span class="hx-tilde">~</span>
        <label>끝 <input type="date" class="hx-to" value="${s.to}" min="${d.first_day}" max="${d.last_day}"></label>
        ${monthSel}
      </div>
      <div class="hx-pres">${pre}</div>
      <div class="hx-opts">
        <span class="hx-lab">기준</span>${seg(GROUPS, s.by, "by")}
        <span class="hx-lab">묶음</span>${seg(UNITS, s.unit, "unit")}
        <span class="hx-lab">지표</span>${seg(METRICS, s.metric, "metric")}
        <button type="button" class="btn hx-csv">CSV 내려받기</button>
      </div>
    </div>`;
  }

  function summaryHTML(d, agg) {
    const s = H.st;
    const n = daysBetween(s.from, s.to);
    const usd = agg.tot.credits * (d.usd_per_credit || 10);
    const ua = agg.tot.credits ? agg.tot.unassigned / agg.tot.credits * 100 : 0;
    const today = todayKST();
    const partial = s.to >= today ? `<span class="hx-note">오늘(${today})은 아직 집계 중입니다.</span>` : "";
    return `<div class="hx-sum">
      <div class="hx-kpi"><span class="hx-big">${fmtCredit(agg.tot.credits)}</span><span>크레딧</span>
        <em>≈ $${Math.round(usd).toLocaleString()}</em></div>
      <div class="hx-kpi"><span class="hx-big">${fmtTok(agg.tot.tokens)}</span><span>토큰</span>
        <em>${agg.tot.turns.toLocaleString()}턴</em></div>
      <div class="hx-kpi"><span class="hx-big">${n}</span><span>일</span>
        <em>사용한 날 ${agg.activeDays}일 · 하루 평균 ${fmtCredit(agg.tot.credits / n)} 크레딧</em></div>
      <div class="hx-kpi"><span class="hx-big">${fmtPct(ua)}</span><span>미분류</span>
        <em>${fmtCredit(agg.tot.unassigned)} 크레딧</em></div>
    </div>
    <div class="hint">${s.from} ~ ${s.to} (한국 시각) · 단가 기준 ${esc(d.pricing_as_of || "")} ·
      1 크레딧 = $${d.usd_per_credit || 10} (API 단가 환산, 구독제라 실제 청구액은 아님)
      ${agg.tot.unpriced ? ` · 단가 미등록 ${fmtTok(agg.tot.unpriced)} 토큰은 크레딧에서 제외` : ""} ${partial}</div>`;
  }

  function tableHTML(d, agg) {
    const s = H.st;
    const label = (GROUPS.find((g) => g.key === s.by) || {}).label;
    const tc = agg.tot.credits || 0, tt = agg.tot.tokens || 0;
    const n = daysBetween(s.from, s.to);
    const rows = agg.list.map((g, i) => {
      const share = s.metric === "tokens" ? (tt ? g.tokens / tt * 100 : 0) : (tc ? g.credits / tc * 100 : 0);
      const open = H.open === g.key;
      return `<tr class="hx-row ${open ? "open" : ""}" data-key="${esc(g.key)}" tabindex="0">
          <td><span class="hx-dot" style="background:${colorOf(i)}"></span>${esc(g.key)}</td>
          <td class="num">${fmtCredit(g.credits)}</td>
          <td class="num">${fmtPct(share)} ${bar(share)}</td>
          <td class="num">${fmtTok(g.tokens)}</td>
          <td class="num">${g.turns.toLocaleString()}</td>
          <td class="num">${g.days.size}</td>
          <td class="num">${fmtCredit(g.credits / n)}</td>
        </tr>${open ? `<tr class="hx-detail"><td colspan="7">${detailHTML(d, g)}</td></tr>` : ""}`;
    }).join("");
    return `<div class="tablewrap"><table class="hx-table"><thead><tr>
        <th>${esc(label)}</th><th class="num">크레딧</th><th class="num">비중 (${s.metric === "tokens" ? "토큰" : "크레딧"})</th>
        <th class="num">토큰</th><th class="num">턴</th><th class="num">사용한 날</th><th class="num">하루 평균</th>
      </tr></thead><tbody>${rows || `<tr><td colspan="7" class="empty">이 기간에는 사용 기록이 없습니다.</td></tr>`}</tbody>
      <tfoot><tr><td>합계</td><td class="num">${fmtCredit(tc)}</td><td class="num">100%</td>
        <td class="num">${fmtTok(tt)}</td><td class="num">${agg.tot.turns.toLocaleString()}</td>
        <td class="num">${agg.activeDays}</td><td class="num">${fmtCredit(tc / n)}</td></tr></tfoot>
    </table></div>`;
  }

  function detailHTML(d, g) {
    const s = H.st;
    const notes = d.model_notes || {};
    const parts = [...g.detail.entries()].map(([k, v]) => {
      const [owner, prov, acct, model, speed, effort] = k.split("\u0001");
      return { owner, prov, acct, model, speed, effort, ...v };
    }).filter((p) => p.tokens || p.credits)   // 토큰 없는 턴(Claude 의 <synthetic> 등)은 내역에서 뺀다
      .sort((a, b) => b.credits - a.credits || b.tokens - a.tokens);
    const showOwner = s.by !== "owner";
    const comp = g.comp;
    const ct = comp.input + comp.output + comp.cache_write + comp.cache_read || 1;
    const compLine = [["입력", comp.input], ["출력", comp.output], ["캐시 쓰기", comp.cache_write],
                      ["캐시 읽기", comp.cache_read]]
      .map(([l, v]) => `<span class="chip">${l} ${fmtTok(v)} (${fmtPct(v / ct * 100)})</span>`).join(" ");
    const rows = parts.map((p) => `<tr>
        ${showOwner ? `<td>${esc(p.owner)}</td>` : ""}
        <td><span class="chip">${esc(p.prov)}</span> ${esc((p.acct || "").split("@")[0] || "계정 없음")}</td>
        <td>${esc(p.model || "(모델 미상)")}${notes[p.model] ? ` <span class="hint">${esc(notes[p.model])}</span>` : ""}</td>
        <td>${esc(SPEED_LABEL[p.speed] || p.speed)}</td>
        <td>${esc(p.effort || "—")}</td>
        <td class="num">${fmtCredit(p.credits)}</td>
        <td class="num">${g.credits ? fmtPct(p.credits / g.credits * 100) : "—"}</td>
        <td class="num">${fmtTok(p.tokens)}${p.unpriced ? ` <span class="hint" title="단가 미등록">(미등록 ${fmtTok(p.unpriced)})</span>` : ""}</td>
        <td class="num">${p.turns.toLocaleString()}</td></tr>`).join("");
    return `<div class="hx-dbox">
      <div class="hint">토큰 구성 ${compLine}</div>
      <table class="hx-dtable"><thead><tr>${showOwner ? "<th>사람</th>" : ""}<th>도구 · 계정</th><th>모델</th><th>속도</th>
        <th>effort</th><th class="num">크레딧</th><th class="num">비중</th><th class="num">토큰</th><th class="num">턴</th></tr></thead>
        <tbody>${rows}</tbody></table></div>`;
  }

  const colorOf = (i) => (i < MAX_SERIES ? COLORS[i] : COLORS[COLORS.length - 1]);

  function drawChart(agg) {
    const s = H.st;
    const canvas = H.el.querySelector(".hx-canvas");
    if (H.chart) { H.chart.destroy(); H.chart = null; }
    if (!canvas || typeof Chart === "undefined") return;
    const buckets = bucketsBetween(s.from, s.to, s.unit);
    const pick = (v) => (v ? (s.metric === "tokens" ? v.tokens : v.credits) : 0);
    const top = agg.list.slice(0, MAX_SERIES);
    const rest = agg.list.slice(MAX_SERIES);
    const sets = top.map((g, i) => ({
      label: g.key, backgroundColor: colorOf(i), stack: "s",
      data: buckets.map((b) => pick(g.buckets.get(b))),
    }));
    if (rest.length) {
      sets.push({ label: `기타 ${rest.length}`, backgroundColor: COLORS[COLORS.length - 1], stack: "s",
        data: buckets.map((b) => rest.reduce((a, g) => a + pick(g.buckets.get(b)), 0)) });
    }
    const fmtV = s.metric === "tokens" ? fmtTok : fmtCredit;
    H.chart = new Chart(canvas.getContext("2d"), {
      type: "bar",
      data: { labels: buckets.map((b) => bucketLabel(b, s.unit)), datasets: sets },
      options: {
        responsive: true, maintainAspectRatio: false, animation: false,
        interaction: { mode: "index", intersect: false },
        plugins: {
          legend: { labels: { color: "#8b949e", boxWidth: 12 } },
          tooltip: {
            filter: (it) => it.raw > 0,
            itemSort: (a, b) => b.raw - a.raw,
            callbacks: {
              label: (it) => ` ${it.dataset.label}: ${fmtV(it.raw)}`,
              footer: (items) => "합계 " + fmtV(items.reduce((a, it) => a + it.raw, 0)),
            },
          },
        },
        scales: {
          x: { stacked: true, ticks: { color: "#8b949e", maxRotation: 0, autoSkip: true }, grid: { display: false } },
          y: { stacked: true, ticks: { color: "#8b949e", callback: (v) => fmtV(v) }, grid: { color: "#2a3140" } },
        },
      },
    });
  }

  function footHTML(d) {
    const src = (d.sources || []).map((x) => `<li>${x.from ? esc(x.from) : "처음"} ~ ${x.to ? esc(addDays(x.to, -1)) : "지금"}:
      ${esc(x.label)}${x.detail ? ` — ${esc(x.detail)}` : ""}</li>`).join("");
    const notes = (d.notes || []).map((n) => `<li>${esc(n)}</li>`).join("");
    return `<ul class="hx-foot hint">
      <li>기록은 ${esc(d.first_day || "—")} 부터 있습니다. 하루 경계는 한국 시각 자정입니다.</li>
      <li>사람은 지금의 담당자 규칙으로 다시 판정합니다 — 규칙을 고치면 과거 기간도 바뀝니다.</li>
      <li>크레딧은 토큰을 모델·종류·속도별 공식 API 단가로 환산한 값입니다(effort 는 단가에 영향 없음).
        행을 누르면 모델·속도·effort 별 내역이 열립니다.</li>
      ${src}${notes}</ul>`;
  }

  function paint() {
    const d = H.data;
    if (H.error && !d) {
      H.el.innerHTML = `<div class="empty">기록 데이터를 읽지 못했습니다 — ${esc(H.error.message || H.error)}</div>`;
      return;
    }
    if (!d) { H.el.innerHTML = `<div class="empty">기록을 불러오는 중…</div>`; return; }
    if (!d.rows.length) { H.el.innerHTML = `<div class="empty">아직 기록이 없습니다.</div>`; return; }
    const agg = aggregate();
    H.agg = agg;
    H.el.innerHTML = controlsHTML(d) + summaryHTML(d, agg)
      + `<div class="hx-chart"><canvas class="hx-canvas"></canvas></div>`
      + tableHTML(d, agg) + footHTML(d);
    drawChart(agg);
    writeHash();
  }

  // ---- CSV -----------------------------------------------------------------
  function csv() {
    const s = H.st, agg = H.agg;
    if (!agg) return;
    const label = (GROUPS.find((g) => g.key === s.by) || {}).label;
    const q = (v) => `"${String(v).replace(/"/g, '""')}"`;
    const lines = [[label, "크레딧", "토큰", "입력", "출력", "캐시 쓰기", "캐시 읽기", "턴", "사용한 날", "단가 미등록 토큰"].map(q).join(",")];
    for (const g of agg.list) {
      lines.push([q(g.key), g.credits.toFixed(4), g.tokens, g.comp.input, g.comp.output,
                  g.comp.cache_write, g.comp.cache_read, g.turns, g.days.size, g.unpriced].join(","));
    }
    const blob = new Blob(["﻿" + lines.join("\n")], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `ai-usage_${s.by}_${s.from}_${s.to}.csv`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  // ---- 이벤트: 요소에 한 번만 건다(다시 그려도 그대로) ----------------------
  function wire(el) {
    if (el.dataset.hxWired) return;
    el.dataset.hxWired = "1";
    const set = (patch) => {
      Object.assign(H.st, patch);
      if (H.st.from > H.st.to) [H.st.from, H.st.to] = [H.st.to, H.st.from];
      paint();
    };
    el.addEventListener("click", (e) => {
      const t = e.target;
      const b = t.closest("button");
      if (b) {
        if (b.dataset.by) { H.open = null; return set({ by: b.dataset.by }); }
        if (b.dataset.unit) return set({ unit: b.dataset.unit });
        if (b.dataset.metric) return set({ metric: b.dataset.metric });
        if (b.dataset.from) return set({ from: b.dataset.from, to: b.dataset.to });
        if (b.classList.contains("hx-csv")) return csv();
      }
      const row = t.closest("tr.hx-row");
      if (row) { H.open = H.open === row.dataset.key ? null : row.dataset.key; paint(); }
    });
    el.addEventListener("keydown", (e) => {
      const row = e.target.closest && e.target.closest("tr.hx-row");
      if (row && (e.key === "Enter" || e.key === " ")) {
        e.preventDefault(); H.open = H.open === row.dataset.key ? null : row.dataset.key; paint();
      }
    });
    el.addEventListener("change", (e) => {
      const t = e.target;
      if (t.classList.contains("hx-from") && t.value) set({ from: t.value });
      if (t.classList.contains("hx-to") && t.value) set({ to: t.value });
      if (t.classList.contains("hx-month") && t.value) {
        const d = H.data;
        const from = t.value + "-01", to = monthEnd(t.value);
        set({ from: from < d.first_day ? d.first_day : from, to: to > d.last_day ? d.last_day : to });
      }
    });
  }

  window.AIHistory = {
    // el: 그릴 곳, loader: () => Promise<history.json 객체>
    // 화면의 자동 새로고침(30초)마다 불린다. 데이터가 그대로면 다시 그리지 않는다 —
    // 날짜를 고르는 도중에 입력칸이 새로 그려지면 고르던 것이 날아간다.
    async render(el, loader) {
      const fresh = H.el !== el || !el.querySelector(".hx-ctl, .empty");
      H.el = el; H.loader = loader;
      wire(el);
      if (!H.data) paint();
      const before = H.loadedAt;
      await ensureData(false);
      if (fresh || H.loadedAt !== before || !el.querySelector(".hx-ctl")) paint();
    },
    wantsTab() { return /^#history/.test(location.hash || ""); },
  };
})();
