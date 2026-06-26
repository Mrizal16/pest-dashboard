let chart7d, chart6m, chartMode, chartZone, chartSensor, chartActuator;

async function fetchJSON(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

function setKPI(kpi) {
  document.getElementById("kpiTodayTotal").textContent = kpi.today_total;
  document.getElementById("kpiTodayBreak").textContent =
    `SIANG ${kpi.today_siang} • MALAM ${kpi.today_malam}`;

  document.getElementById("kpiMonthTotal").textContent = kpi.month_total;
  document.getElementById("kpiMonthBreak").textContent =
    `SIANG ${kpi.month_siang} • MALAM ${kpi.month_malam}`;

  document.getElementById("kpiTotal").textContent = kpi.total;
}

function fmtHour(h) {
  return String(h).padStart(2, "0") + ":00";
}

function renderRecommendation(rec) {

  const birdRec = document.getElementById("birdRec");
  const ratRec = document.getElementById("ratRec");

  if (rec.bird.total > 0) {
    birdRec.innerHTML = `
      <h3>🐦 Burung</h3>
      <p><b>🕒 ${fmtHour(rec.bird.start)} - ${fmtHour(rec.bird.end)}</b></p>
      <p>📊 ${rec.bird.total} deteksi</p>
      <small>Disarankan melakukan pengecekan sawah pada rentang waktu tersebut.</small>
    `;
  } else {
    birdRec.innerHTML = `
      <h3>🐦 Burung</h3>
      <p>Belum tersedia rekomendasi.</p>
      <small>Menunggu data deteksi hari sebelumnya.</small>
    `;
  }

  if (rec.rat.total > 0) {
    ratRec.innerHTML = `
      <h3>🐀 Tikus</h3>
      <p><b>🕒 ${fmtHour(rec.rat.start)} - ${fmtHour(rec.rat.end)}</b></p>
      <p>📊 ${rec.rat.total} deteksi</p>
      <small>Disarankan melakukan pengecekan sawah pada rentang waktu tersebut.</small>
    `;
  } else {
    ratRec.innerHTML = `
      <h3>🐀 Tikus</h3>
      <p>Belum tersedia rekomendasi.</p>
      <small>Menunggu data deteksi hari sebelumnya.</small>
    `;
  }

}

function renderTable(rows) {
  const tbody = document.getElementById("tbody");
  tbody.innerHTML = "";
  for (const r of rows) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${r.dt_wib || ""}</td>
      <td>${r.ts}</td>
      <td>${r.mode || ""}</td>
      <td>${r.sensor || ""}</td>
      <td>${r.zone ?? ""}</td>
      <td>${r.message || ""}</td>
      <td>${r.actuator || ""}</td>
      <td>${r.cooldown_ms ?? ""}</td>
      <td>${r.rssi ?? ""}</td>
    `;
    tbody.appendChild(tr);
  }
}

function upsertLine3(canvasId, ref, labels, totalData, siangData, malamData) {
  const ctx = document.getElementById(canvasId);
  if (!ref) {
    ref = new Chart(ctx, {
      type: "line",
      data: {
        labels,
        datasets: [
          { label: "TOTAL", data: totalData },
          { label: "SIANG", data: siangData },
          { label: "MALAM", data: malamData }
        ]
      },
      options: {
        responsive: true,
        animation: false,
        scales: { y: { beginAtZero: true } }
      }
    });
  } else {
    ref.data.labels = labels;
    ref.data.datasets[0].data = totalData;
    ref.data.datasets[1].data = siangData;
    ref.data.datasets[2].data = malamData;
    ref.update();
  }
  return ref;
}

function upsertStackedBarPlusLine(canvasId, ref, labels, siangData, malamData, totalData) {
  const ctx = document.getElementById(canvasId);
  if (!ref) {
    ref = new Chart(ctx, {
      data: {
        labels,
        datasets: [
          { type: "bar", label: "SIANG", data: siangData, stack: "stack1" },
          { type: "bar", label: "MALAM", data: malamData, stack: "stack1" },
          { type: "line", label: "TOTAL", data: totalData }
        ]
      },
      options: {
        responsive: true,
        animation: false,
        scales: {
          x: { stacked: true },
          y: { stacked: true, beginAtZero: true }
        }
      }
    });
  } else {
    ref.data.labels = labels;
    ref.data.datasets[0].data = siangData;
    ref.data.datasets[1].data = malamData;
    ref.data.datasets[2].data = totalData;
    ref.update();
  }
  return ref;
}

function upsertPie(canvasId, ref, labels, data, type = "doughnut") {
  const ctx = document.getElementById(canvasId);
  if (!ref) {
    ref = new Chart(ctx, {
      type,
      data: { labels, datasets: [{ data }] },
      options: { responsive: true, animation: false }
    });
  } else {
    ref.data.labels = labels;
    ref.data.datasets[0].data = data;
    ref.update();
  }
  return ref;
}

function renderCharts(d) {
  // 7 hari: TOTAL + SIANG + MALAM
  const labels7 = d.series7d.map(x => x.day);
  const total7 = d.series7d.map(x => x.total);
  const siang7 = d.series7d.map(x => x.siang);
  const malam7 = d.series7d.map(x => x.malam);
  chart7d = upsertStackedBarPlusLine("chart7d", chart7d, labels7, siang7, malam7, total7);

  // 6 bulan: stacked bar SIANG/MALAM + line TOTAL
  const labels6 = d.series6m.map(x => x.month);
  const siang6 = d.series6m.map(x => x.siang);
  const malam6 = d.series6m.map(x => x.malam);
  const total6 = d.series6m.map(x => x.total);
  chart6m = upsertStackedBarPlusLine("chart6m", chart6m, labels6, siang6, malam6, total6);

  // Komposisi: mode
  const modeLabels = (d.composition.mode || []).map(x => x.label || "UNKNOWN");
  const modeData = (d.composition.mode || []).map(x => x.count);
  chartMode = upsertPie("chartMode", chartMode, modeLabels, modeData, "doughnut");

  // Komposisi: zona
  const zoneLabels = (d.composition.zone || []).map(x => `Zone ${x.label}`);
  const zoneData = (d.composition.zone || []).map(x => x.count);
  chartZone = upsertPie("chartZone", chartZone, zoneLabels, zoneData, "pie");

  // Komposisi: sensor
  const sLabels = (d.composition.sensor || []).map(x => x.label || "UNKNOWN");
  const sData = (d.composition.sensor || []).map(x => x.count);
  chartSensor = upsertPie("chartSensor", chartSensor, sLabels, sData, "doughnut");

  // Komposisi: actuator
  const aLabels = (d.composition.actuator || []).map(x => x.label || "UNKNOWN");
  const aData = (d.composition.actuator || []).map(x => x.count);
  chartActuator = upsertPie("chartActuator", chartActuator, aLabels, aData, "doughnut");
}

async function refreshAll() {
  const days = document.getElementById("days").value;
  const months = document.getElementById("months").value;
  const latest = document.getElementById("latest").value;

  const d = await fetchJSON(`/api/dashboard?days=${days}&months=${months}&latest=${latest}`);
  setKPI(d.kpi);
  renderCharts(d);
  renderTable(d.latest);
}

function setupRealtime() {
  const connEl = document.getElementById("conn");
  const lastEl = document.getElementById("last");

  const es = new EventSource("/api/stream");

  es.addEventListener("open", () => {
    connEl.textContent = "Realtime: CONNECTED";
  });

  es.addEventListener("error", () => {
    connEl.textContent = "Realtime: DISCONNECTED";
  });

  es.addEventListener("new_event", async (e) => {
    const ev = JSON.parse(e.data);
    lastEl.textContent = `Last: ts=${ev.ts} | ${ev.mode} | ${ev.sensor} | zone ${ev.zone}`;
    try { await refreshAll(); } catch (_) {}
  });
}

document.getElementById("refresh").addEventListener("click", () => {
  refreshAll().catch(err => alert(err.message));
});
document.getElementById("days").addEventListener("change", () => refreshAll().catch(() => {}));
document.getElementById("months").addEventListener("change", () => refreshAll().catch(() => {}));
document.getElementById("latest").addEventListener("change", () => refreshAll().catch(() => {}));

refreshAll().catch(err => alert(err.message));
setupRealtime();
