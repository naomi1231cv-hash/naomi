const $ = (selector) => document.querySelector(selector);
const loginView = $("#login-view");
const adminView = $("#admin-view");
const rowsEl = $("#rows");
const editor = $("#editor");
let records = [];

async function api(url, options = {}) {
  const response = await fetch(url, {
    credentials: "same-origin",
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    ...options
  });
  if (response.status === 401) {
    showLogin();
    throw new Error("登入已逾時，請重新登入");
  }
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error || "操作失敗");
  }
  return response.status === 204 ? null : response.json();
}

function showLogin() {
  loginView.classList.remove("hidden");
  adminView.classList.add("hidden");
}
function showAdmin() {
  loginView.classList.add("hidden");
  adminView.classList.remove("hidden");
}
function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" })[c]);
}
function money(value) {
  return new Intl.NumberFormat("zh-TW", { style: "currency", currency: "TWD", maximumFractionDigits: 0 }).format(value || 0);
}

async function loadRecords() {
  const params = new URLSearchParams();
  if ($("#search").value.trim()) params.set("search", $("#search").value.trim());
  if ($("#year-filter").value) params.set("year", $("#year-filter").value);
  records = await api(`/api/records?${params}`);
  render();
}

function render() {
  const totalNights = records.reduce((sum, r) => sum + r.nights, 0);
  const totalSpend = records.reduce((sum, r) => sum + r.spend, 0);
  const hotels = new Set(records.map(r => r.hotel)).size;
  $("#summary").innerHTML = [
    ["目前筆數", records.length.toLocaleString()],
    ["飯店數", hotels.toLocaleString()],
    ["住宿晚數", totalNights.toLocaleString()],
    ["支出總額", money(totalSpend)]
  ].map(([label, value]) => `<div class="metric"><span>${label}</span><strong>${value}</strong></div>`).join("");
  rowsEl.innerHTML = records.map(r => `<tr>
    <td>${r.year}</td><td>${r.month ?? "—"}</td><td>${escapeHtml(r.hotel)}</td>
    <td>${escapeHtml(r.date)}</td><td class="num">${r.nights}</td>
    <td class="num">${money(r.spend)}</td><td>${escapeHtml(r.project || "—")}</td>
    <td class="row-actions"><button data-edit="${r._id}" class="secondary">編輯</button><button data-delete="${r._id}" class="danger">刪除</button></td>
  </tr>`).join("") || `<tr><td colspan="8">目前沒有符合的資料。</td></tr>`;
  $("#notice").textContent = `顯示 ${records.length} 筆資料`;

  const current = $("#year-filter").value;
  const years = [...new Set(records.map(r => r.year))].sort((a,b) => b-a);
  if (!current) $("#year-filter").innerHTML = `<option value="">全部年份</option>${years.map(y => `<option>${y}</option>`).join("")}`;
}

function openEditor(record = null) {
  $("#editor-title").textContent = record ? "編輯資料" : "新增資料";
  $("#record-id").value = record?._id || "";
  $("#year").value = record?.year || new Date().getFullYear();
  $("#month").value = record?.month || "";
  $("#hotel").value = record?.hotel || "";
  $("#date").value = record?.date || "";
  $("#nights").value = record?.nights ?? 1;
  $("#spend").value = record?.spend ?? 0;
  $("#project").value = record?.project || "";
  $("#form-error").textContent = "";
  editor.showModal();
}

$("#login-form").addEventListener("submit", async event => {
  event.preventDefault();
  $("#login-error").textContent = "";
  try {
    await api("/api/login", { method: "POST", body: JSON.stringify({ password: $("#password").value }) });
    $("#password").value = "";
    showAdmin();
    await loadRecords();
  } catch (error) { $("#login-error").textContent = error.message; }
});

$("#logout").addEventListener("click", async () => {
  await api("/api/logout", { method: "POST", body: "{}" });
  showLogin();
});
$("#new-record").addEventListener("click", () => openEditor());
$("#close-editor").addEventListener("click", () => editor.close());
$("#cancel").addEventListener("click", () => editor.close());
$("#search").addEventListener("input", debounce(loadRecords, 250));
$("#year-filter").addEventListener("change", loadRecords);

rowsEl.addEventListener("click", async event => {
  const editId = event.target.dataset.edit;
  const deleteId = event.target.dataset.delete;
  if (editId) openEditor(records.find(r => r._id === editId));
  if (deleteId && confirm("確定要刪除這筆資料嗎？此操作會同步回寫 MongoDB Atlas。")) {
    try {
      await api(`/api/records/${deleteId}`, { method: "DELETE" });
      await loadRecords();
    } catch (error) { $("#notice").textContent = error.message; }
  }
});

$("#record-form").addEventListener("submit", async event => {
  event.preventDefault();
  const id = $("#record-id").value;
  const data = {
    year: Number($("#year").value),
    month: $("#month").value ? Number($("#month").value) : null,
    hotel: $("#hotel").value,
    date: $("#date").value,
    nights: Number($("#nights").value),
    spend: Number($("#spend").value),
    project: $("#project").value
  };
  try {
    await api(id ? `/api/records/${id}` : "/api/records", {
      method: id ? "PUT" : "POST",
      body: JSON.stringify(data)
    });
    editor.close();
    await loadRecords();
  } catch (error) { $("#form-error").textContent = error.message; }
});

function debounce(fn, wait) {
  let timer;
  return (...args) => { clearTimeout(timer); timer = setTimeout(() => fn(...args), wait); };
}

(async () => {
  const session = await api("/api/session");
  if (session.authenticated) { showAdmin(); await loadRecords(); }
  else showLogin();
})().catch(showLogin);
