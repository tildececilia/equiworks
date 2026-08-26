"use strict";
/* ============ Uppkoppling ============ */
const cfg = window.STALLJOUR_CONFIG;
const db = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_KEY);

/* Vilken version kör vi? Läses ur ?v= på script-taggen och jämförs med den
   som ligger på servern — hemskärms-appar (iOS) cachar annars gammal kod för evigt. */
const APP_V = +(((/[?&]v=(\d+)/.exec((document.currentScript && document.currentScript.src) || "")) || [])[1] || 0);
async function checkForUpdate(atStart){
  if(!APP_V) return;
  try{
    const r = await fetch("index.html?ts=" + Date.now(), { cache: "no-store" });
    const m = /app\.js\?v=(\d+)/.exec(await r.text());
    if(!m || +m[1] <= APP_V) return;
    // vid start: hämta nya versionen direkt (en gång per flik, så det aldrig kan snurra).
    // Sitter man redan och jobbar rycker vi inte undan sidan — då kommer rutan i stället.
    let done = false;
    try{ done = !!sessionStorage.getItem("stalljour.updated"); }catch(e){}
    if(atStart && !done){
      try{ sessionStorage.setItem("stalljour.updated", String(m[1])); }catch(e){}
      // behåll övriga parametrar (t.ex. ?konto=jour som skiljer två hemskärms-appar åt)
      const q = new URLSearchParams(location.search);
      q.set("u", m[1]);
      location.replace(location.pathname + "?" + q.toString());
      return;
    }
    showUpdateBar(+m[1]);
  }catch(e){}
}
function showUpdateBar(v){
  if(el("updateBar")) return;
  const bar = document.createElement("div");
  bar.id = "updateBar";
  bar.style.cssText = "position:sticky;top:0;z-index:21;background:var(--accent);color:var(--accent-ink);text-align:center;padding:8px 12px;font-size:.85rem;font-weight:600;cursor:pointer";
  bar.textContent = "↻ Ny version av EquiWorks finns — tryck här för att uppdatera";
  bar.onclick = ()=>{
    const q = new URLSearchParams(location.search);
    q.set("u", v);
    location.replace(location.pathname + "?" + q.toString());
  };
  document.querySelector("header.app").after(bar);
}
setInterval(checkForUpdate, 15 * 60 * 1000);
document.addEventListener("visibilitychange", ()=>{ if(!document.hidden) checkForUpdate(); });
checkForUpdate(true);

let session = null;            // {id, email} från Supabase Auth
let view = { name: "home", stableId: null };
let didAutoRoute = false;       // hoppa direkt till schemat om man bara har ett stall
let loginStage = "email";      // "email" | "code"
let loginEmail = "";

const GROUP_GREENS = ["#7bc088","#4e9e6e","#2b6242","#93d3a0","#3f8f5f","#1f4d36"];
let curAdmin = false;   // är jag admin i stallet som visas
let curCats = [];       // kategorier i stallet som visas (för pass-formuläret)
let curGroups = [];     // grupper i stallet (för häst-grupp-valet)
let editingPassId = null, editingHorseId = null, editingGroupId = null, editingCatId = null, editingProfileId = null;

/* ---- Datum & rotation ---- */
const MONTHS = ["jan","feb","mar","apr","maj","jun","jul","aug","sep","okt","nov","dec"];
const DAY_NAMES = ["Söndag","Måndag","Tisdag","Onsdag","Torsdag","Fredag","Lördag"];
const SHORT_DAYS = ["Sön","Mån","Tis","Ons","Tor","Fre","Lör"];
const ROT_ANCHOR = new Date(2024,0,1); // en måndag – referens för rotationen
function isoDate(d){ const p=n=>String(n).padStart(2,"0"); return d.getFullYear()+"-"+p(d.getMonth()+1)+"-"+p(d.getDate()); }
function startOfWeek(d){ const x=new Date(d); const day=(x.getDay()+6)%7; x.setDate(x.getDate()-day); x.setHours(0,0,0,0); return x; }
function isoWeekNumber(d){
  const t=new Date(Date.UTC(d.getFullYear(),d.getMonth(),d.getDate()));
  const day=(t.getUTCDay()+6)%7; t.setUTCDate(t.getUTCDate()-day+3);
  const f=new Date(Date.UTC(t.getUTCFullYear(),0,4)); const fd=(f.getUTCDay()+6)%7; f.setUTCDate(f.getUTCDate()-fd+3);
  return 1+Math.round((t-f)/(7*24*3600*1000));
}
function weekIndexOf(monday){ const a=new Date(ROT_ANCHOR); a.setHours(0,0,0,0); const m=new Date(monday); m.setHours(0,0,0,0); return Math.round((m-a)/(7*24*3600*1000)); }
function dutyGroupForWeek(monday, groups, offset){ const n=groups.length; if(!n) return null; const idx=((weekIndexOf(monday)+(offset||0))%n+n)%n; return groups[idx]; }
function passApplies(p, d){ const g=d.getDay(); const wknd=(g===0||g===6);
  if(p.day_rule==="weekend") return wknd;
  if(p.day_rule==="weekday") return !wknd;
  if(p.day_rule==="weekdays") return Array.isArray(p.weekdays) && p.weekdays.includes(((g+6)%7)+1);
  return true;
}
function timeKey(p){ const m=(p.start_time||"").trim().match(/^(\d{1,2}):(\d{2})/); return m ? (+m[1])*60 + (+m[2]) : 9999; }
function sortPassesByTime(arr){ return arr.slice().sort((a,b)=>{ const d=timeKey(a)-timeKey(b); return d!==0 ? d : ((a.sort_order||0)-(b.sort_order||0)); }); }
const TIME_OPTIONS = (()=>{ const a=[]; for(let h=0;h<24;h++) for(const m of [0,30]) a.push(String(h).padStart(2,"0")+":"+String(m).padStart(2,"0")); return a; })();
function capOpts(sel){ let o=""; for(let i=1;i<=10;i++) o += `<option value="${i}"${i===sel?" selected":""}>${i}</option>`; return o; }
let weekStart2 = null;   // schemats vecka (måndag)
let schedCtx = null;     // {stable, groups, passes, myProfiles, actingProfileId}
let schedLogOpen = false; // händelseloggen utfälld?

/* ---- Färgkodning: personfärg på namn + kategorinyans på rutor ---- */
function hashHue(s){
  let h = 2166136261;
  for(let i=0;i<s.length;i++){ h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  h ^= h >>> 13; h = Math.imul(h, 0x5bd1e995); h ^= h >>> 15;
  return ((h % 360) + 360) % 360;
}
function profChipStyle(pid){ const h = hashHue(String(pid)); return `background:hsla(${h},55%,45%,.20)`; }
const CAT_HUES = [150, 95, 172, 128, 60];   // olika gröna nyanser (och gulgrönt) per kategori
function buildCatTints(passes){
  const m = {}; let i = 0;
  sortPassesByTime(passes).forEach(p=>{
    const k = p.category_id || "none";
    if(k !== "none" && !(k in m)){ m[k] = CAT_HUES[i % CAT_HUES.length]; i++; }
  });
  return m;
}

const appEl = document.getElementById("app");

/* ============ Hjälpare ============ */
function normEmail(e){ return (e||"").trim().toLowerCase(); }
function esc(s){ return String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c])); }
function el(id){ return document.getElementById(id); }
function msg(text, kind){ return `<div class="msg ${kind||""}">${esc(text)}</div>`; }
/* Konturikoner (Lucide-stil: streckade, ej ifyllda) */
const ICONS = {
  calendar: '<rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/>',
  settings: '<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/>',
  user: '<path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
  users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
  moon: '<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/>',
  home: '<path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/>',
  plus: '<path d="M5 12h14"/><path d="M12 5v14"/>',
  logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/>',
  clock: '<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>',
  printer: '<polyline points="6 9 6 2 18 2 18 9"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="8"/>',
  tag: '<path d="M12.586 2.586A2 2 0 0 0 11.172 2H4a2 2 0 0 0-2 2v7.172a2 2 0 0 0 .586 1.414l8.704 8.704a2.426 2.426 0 0 0 3.42 0l6.58-6.58a2.426 2.426 0 0 0 0-3.42z"/><circle cx="7.5" cy="7.5" r="1"/>',
  mail: '<rect x="2" y="4" width="20" height="16" rx="2"/><path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7"/>',
  bell: '<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/>',
  message: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
  swap: '<path d="M8 3 4 7l4 4"/><path d="M4 7h16"/><path d="m16 21 4-4-4-4"/><path d="M20 17H4"/>',
  list: '<line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/>',
  chart: '<line x1="12" y1="20" x2="12" y2="10"/><line x1="18" y1="20" x2="18" y2="4"/><line x1="6" y1="20" x2="6" y2="16"/>',
  menu: '<line x1="4" y1="6" x2="20" y2="6"/><line x1="4" y1="12" x2="20" y2="12"/><line x1="4" y1="18" x2="20" y2="18"/>',
  pencil: '<path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/>',
  x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>'
};
function ic(name){
  return `<svg class="icn" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name]||""}</svg>`;
}

/* ============ Router ============ */
function render(){
  if(chatPollTimer){ clearInterval(chatPollTimer); chatPollTimer = null; }
  updateHeader();
  if(!session){ didAutoRoute = false; renderLogin(); return; }
  if(view.name === "schedule" && view.stableId){ renderSchedule(view.stableId); return; }
  if(view.name === "chat" && view.stableId){ renderChat(view.stableId); return; }
  if(view.name === "mine" && view.stableId){ renderMyPasses(view.stableId); return; }
  if(view.name === "requests" && view.stableId){ renderRequests(view.stableId); return; }
  if(view.name === "stable" && view.stableId){ renderStable(view.stableId); return; }
  renderHome();
}

/* ============ Inloggning (mejl-länk) + skapa stall ============ */
let loginMode = "login";   // "login" | "create"
function renderLogin(){
  const form = loginMode === "login" ? `
        <p class="sub">Logga in med din mejl. Vi skickar en länk — inget lösenord behövs.</p>
        <div id="loginMsg"></div>
        <div class="field">
          <label class="fld" for="email">Mejladress</label>
          <input type="email" id="email" placeholder="du@exempel.se" autocomplete="email">
        </div>
        <button class="btn primary block" id="loginBtn">Skicka inloggningslänk</button>
        <div class="hint">Klicka på länken i mejlet så loggas du in. Du förblir inloggad på den här enheten.</div>
        ${codeBox()}`
    : `
        <p class="sub">Starta ett nytt stall eller en ridskola — du blir admin.</p>
        <div id="loginMsg"></div>
        <div class="field">
          <label class="fld" for="cName2">Namn på stallet/ridskolan</label>
          <input type="text" id="cName2" placeholder="t.ex. RHC" maxlength="40">
        </div>
        <div class="field">
          <label class="fld" for="cKind2">Typ</label>
          <select id="cKind2"><option value="stall">Stall (jour-schema)</option><option value="ridskola">Ridskola (lektioner)</option></select>
        </div>
        <div class="field">
          <label class="fld" for="email">Din mejladress</label>
          <input type="email" id="email" placeholder="du@exempel.se" autocomplete="email">
        </div>
        <button class="btn primary block" id="loginBtn">Skapa & skicka inloggningslänk</button>
        <div class="hint">När du klickar på länken i mejlet loggas du in och stallet skapas — det dyker upp under "Mina stall".</div>`;
  appEl.innerHTML = `
    <div class="center">
      <div class="card">
        <h1 class="title">Välkommen!</h1>
        <div style="display:flex;gap:8px;margin:4px 0 16px">
          <button class="btn sm ${loginMode==="login"?"primary":""}" id="segLogin">Logga in</button>
          <button class="btn sm ${loginMode==="create"?"primary":""}" id="segCreate">Skapa stall</button>
        </div>
        ${form}
      </div>
    </div>`;
  el("segLogin").onclick = ()=>{ loginMode = "login"; renderLogin(); };
  el("segCreate").onclick = ()=>{ loginMode = "create"; renderLogin(); };
  el("loginBtn").onclick = doLogin;
  el("email").addEventListener("keydown", e=>{ if(e.key==="Enter") doLogin(); });
  bindCodeBox();
  (loginMode === "create" ? el("cName2") : el("email")).focus();
}

/* Koda in dig i det här fönstret: mejlets länk loggar in webbläsaren den öppnas i,
   vilket inte hjälper t.ex. en app sparad på iPhones hemskärm (egen lagring).
   Här kan man i stället klistra in koden — eller hela länken — och logga in just här. */
function codeBox(){
  return `<div class="codebox">
    <button class="codetoggle" id="codeToggle" type="button">Har du en kod eller länk i mejlet? <span class="caret" id="codeCaret">▸</span></button>
    <div id="codeWrap" style="display:${loginStage === "code" ? "block" : "none"}">
      <p class="hint" style="margin:8px 0">Öppnade du appen från hemskärmen loggar länken in fel fönster. Skriv in koden ur mejlet — eller kopiera hela länken (håll in den i mejlet → Kopiera) och klistra in här.</p>
      <div class="field"><input type="text" id="loginCode" autocomplete="one-time-code" autocapitalize="off" autocorrect="off" spellcheck="false" placeholder="123456 – eller klistra in länken"></div>
      <button class="btn block" id="codeBtn">Logga in här</button>
    </div>
  </div>`;
}
function bindCodeBox(){
  const t = el("codeToggle"); if(!t) return;
  t.onclick = ()=>{
    const w = el("codeWrap");
    const open = w.style.display !== "none";
    w.style.display = open ? "none" : "block";
    loginStage = open ? "email" : "code";
    el("codeCaret").textContent = open ? "▸" : "▾";
    if(!open) el("loginCode").focus();
  };
  if(loginStage === "code") el("codeCaret").textContent = "▾";
  el("codeBtn").onclick = doCodeLogin;
  el("loginCode").addEventListener("keydown", e=>{ if(e.key==="Enter") doCodeLogin(); });
}
async function doCodeLogin(){
  const mEl = el("loginMsg"), btn = el("codeBtn");
  const raw = (el("loginCode").value||"").trim();
  const email = normEmail(el("email") ? el("email").value : "");
  if(!raw){ mEl.innerHTML = msg("Fältet är tomt — skriv in koden från mejlet här.", "err"); el("loginCode").focus(); return; }
  if(raw.includes("{{")){ mEl.innerHTML = msg("Mejlet visar {{ .Token }} som text i stället för en kod — mallen i Supabase har inte sparats rätt. Använd länken i mejlet så länge.", "err"); return; }
  mEl.innerHTML = "";
  const label = btn.textContent; btn.classList.add("spin"); btn.textContent = "…";
  let r;
  const link = raw.match(/[?&](token_hash|token)=([^&\s]+)/);
  if(link){
    // hela länken inklistrad — engångstoken plockas ur adressen
    const kind = /[?&]type=([a-z_]+)/i.exec(raw);
    r = await db.auth.verifyOtp({ token_hash: decodeURIComponent(link[2]), type: (kind && kind[1]) || "email" });
  } else {
    const code = raw.replace(/\D/g, "");
    if(code.length < 6 || code.length > 10){
      btn.classList.remove("spin"); btn.textContent = label;
      mEl.innerHTML = /^https?:\/\//i.test(raw)
        ? msg("Den där länken innehåller ingen inloggningsnyckel — den går via en mellanhand (klickspårning). Använd koden i mejlet i stället.", "err")
        : msg("Det där ser inte ut som koden: jag hittade " + code.length + " siffror i \"" + raw.slice(0,24) + "\". Koden i mejlet är sex siffror i rad.", "err");
      return;
    }
    if(!email.includes("@")){
      btn.classList.remove("spin"); btn.textContent = label;
      mEl.innerHTML = msg("Fyll i din mejladress ovanför också — koden hör ihop med adressen.", "err");
      return;
    }
    // ny användare får "signup"-kod, befintlig "magiclink" — pröva tills en tar
    for(const t of ["email", "signup", "magiclink"]){
      r = await db.auth.verifyOtp({ email, token: code, type: t });
      if(!r.error) break;
    }
  }
  btn.classList.remove("spin"); btn.textContent = label;
  if(r.error){
    mEl.innerHTML = msg("Kunde inte logga in: " + r.error.message + " — koden gäller en timme och bara en gång. Skicka en ny länk om den hunnit gå ut.", "err");
    return;
  }
  mEl.innerHTML = msg("Loggar in…", "ok");
  el("loginCode").value = "";
  // resten sköter onAuthStateChange, som renderar appen
}

async function doLogin(){
  const mEl = el("loginMsg"), btn = el("loginBtn");
  const email = normEmail(el("email").value);
  if(!email.includes("@") || email.length < 5){ mEl.innerHTML = msg("Skriv en giltig mejladress.", "err"); return; }
  if(loginMode === "create"){
    const name = (el("cName2").value||"").trim();
    if(!name){ mEl.innerHTML = msg("Ge stallet ett namn.", "err"); return; }
    try{ localStorage.setItem("stalljour.pendingCreate", JSON.stringify({ name, kind: el("cKind2").value })); }catch(e){}
  }
  const btnLabel = btn.textContent;
  btn.classList.add("spin"); btn.textContent = "…";
  const redirect = window.location.origin + window.location.pathname;
  const { error } = await db.auth.signInWithOtp({ email, options: { shouldCreateUser: true, emailRedirectTo: redirect } });
  btn.classList.remove("spin"); btn.textContent = btnLabel;
  if(error){ mEl.innerHTML = msg("Kunde inte skicka: " + error.message, "err"); return; }
  mEl.innerHTML = msg(loginMode === "create"
    ? "Vi skickade en länk till " + email + ". Klicka på den så loggas du in och stallet skapas."
    : "Vi skickade en inloggningslänk till " + email + ". Öppna mejlet och klicka på länken.", "ok");
}

async function handlePendingCreate(){
  if(!session) return;
  let raw = null; try{ raw = localStorage.getItem("stalljour.pendingCreate"); }catch(e){}
  if(!raw) return;
  try{ localStorage.removeItem("stalljour.pendingCreate"); }catch(e){}
  let p; try{ p = JSON.parse(raw); }catch(e){ return; }
  if(!p || !p.name) return;
  const { data, error } = await db.rpc("create_stable", { p_name: p.name, p_kind: p.kind || "stall" });
  if(error){ alert("Kunde inte skapa " + p.name + ": " + error.message); return; }
  didAutoRoute = true;
  view = { name: "stable", stableId: data };
  render();
}


/* ============ Hem – dina stall ============ */
async function renderHome(){
  appEl.innerHTML = `
    <div class="card">
      <h1 class="title">Hej!</h1>
      <p class="sub" style="margin:0 0 14px">Inloggad som ${esc(session.email)}</p>
      <div id="homeInvites"></div>
      <p class="sub">Dina stall</p>
      <div id="stableList" class="list"><div class="empty">Laddar…</div></div>
    </div>`;

  try{
    const [all, ivq] = await Promise.all([
      loadMyStables(),
      db.from("invite").select("id,invited_by,kind,staff_perm,invite_name,stable(name),profile(name)").eq("email", session.email).eq("status","pending")
    ]);
    const invs = ivq.error ? [] : (ivq.data||[]);
    if(invs.length){
      el("homeInvites").innerHTML = `<p class="sub">Inbjudningar</p>` + invs.map(v=>`
        <div class="notif" style="margin-bottom:10px"><div>📩 <b>${esc(v.invited_by)}</b> har bjudit in dig till stallet <b>${esc((v.stable&&v.stable.name)||"?")}</b></div>
          <div class="meta2">Som ${esc(inviteRoleLabel(v))}</div>
          <div class="notifbtns"><button class="btn primary sm" data-hiacc="${v.id}">Acceptera</button><button class="btn sm" data-hidec="${v.id}">Avböj</button></div>
        </div>`).join("") + `<div style="height:8px"></div>`;
      el("homeInvites").querySelectorAll("[data-hiacc]").forEach(b=> b.onclick = ()=>{ const id=b.getAttribute("data-hiacc"); resolveInvite(id, true, invs.find(v=> v.id===id)); });
      el("homeInvites").querySelectorAll("[data-hidec]").forEach(b=> b.onclick = ()=> resolveInvite(b.getAttribute("data-hidec"), false));
    }
    const units = all.filter(u=> u.id);
    // Har man bara en del – gå direkt till schemat (en gång per inloggning, men inte förbi väntande inbjudningar)
    if(units.length === 1 && !didAutoRoute && !all.some(u=> u.emptyOrg) && !invs.length){
      didAutoRoute = true;
      weekStart2 = startOfWeek(new Date());
      view = { name: "schedule", stableId: units[0].id };
      render();
      return;
    }
    const list = el("stableList");
    if(!all.length){
      list.innerHTML = invs.length
        ? `<div class="empty" style="margin-bottom:12px">Acceptera en inbjudan ovan för att komma igång — eller skapa ett eget stall.</div>
           <button class="btn block" id="firstStableBtn">${ic("plus")} Skapa eget stall</button>`
        : `<div class="empty" style="margin-bottom:12px">Du är inte med i något stall än — skapa ett, eller be en admin lägga in din mejl.</div>
           <button class="btn primary block" id="firstStableBtn">${ic("plus")} Skapa ditt första stall</button>`;
      el("firstStableBtn").onclick = createOrgDialog;
      return;
    }
    // gruppera per stall (org)
    const orgs = new Map();
    all.forEach(u=>{
      if(!orgs.has(u.orgId)) orgs.set(u.orgId, { id:u.orgId, name:u.orgName, isAdmin:false, units:[] });
      const o = orgs.get(u.orgId);
      if(u.isAdmin) o.isAdmin = true;
      if(u.id) o.units.push(u);
    });
    list.innerHTML = [...orgs.values()].map(o=>`
      <div class="orgblock">
        <div class="orghead">${ic("home")} ${esc(o.name)} ${o.isAdmin?`<span class="pill">Admin</span>`:""}</div>
        ${o.units.map(u=>`
          <button class="row lvl1" data-open="${u.id}">
            <div class="grow"><div class="nm">${esc(u.name)}</div><div class="meta">${kindLabel(u.kind)}</div></div>
            <span class="chev">›</span>
          </button>`).join("")}
        ${!o.units.length ? `<div class="empty" style="margin-left:16px">Inga delar än.</div>` : ""}
        ${o.isAdmin ? `
          <button class="row lvl1" data-newunit="${o.id}">
            <div class="grow"><div class="nm" style="color:var(--accent)">${ic("plus")} Skapa ny</div><div class="meta">schema eller ridskola</div></div>
          </button>
          <div class="addunit" id="nu_${o.id}" style="display:none">
            <select id="nuk_${o.id}"><option value="stall">Jourschema</option><option value="ridskola">Ridskola</option></select>
            <input type="text" id="nun_${o.id}" placeholder="Namn, t.ex. Ridskolan">
            <button class="btn primary sm" data-mkunit="${o.id}">Skapa</button>
          </div>
          <button class="row lvl1" data-admins="${o.id}">
            <div class="grow"><div class="nm">${ic("users")} Administratörer</div><div class="meta">visa och hantera</div></div>
            <span class="chev">›</span>
          </button>
          <div id="adm_${o.id}" style="display:none;margin-left:16px"></div>
          <button class="row lvl1" data-invlog="${o.id}">
            <div class="grow"><div class="nm">${ic("mail")} Skickade inbjudningar</div><div class="meta">logg med status</div></div>
            <span class="chev">›</span>
          </button>
          <div id="ivl_${o.id}" style="display:none;margin-left:16px"></div>` : ""}
      </div>`).join("");
    list.querySelectorAll("[data-open]").forEach(b=> b.onclick = ()=>{ weekStart2 = startOfWeek(new Date()); view={name:"schedule",stableId:b.getAttribute("data-open")}; render(); });
    list.querySelectorAll("[data-newunit]").forEach(b=> b.onclick = ()=>{
      const f = el("nu_" + b.getAttribute("data-newunit"));
      f.style.display = f.style.display === "none" ? "" : "none";
    });
    list.querySelectorAll("[data-admins]").forEach(b=> b.onclick = async ()=>{
      const oid = b.getAttribute("data-admins");
      const box = el("adm_"+oid);
      if(box.style.display !== "none"){ box.style.display = "none"; return; }
      box.style.display = ""; box.innerHTML = `<div class="empty">Laddar…</div>`;
      const [oq, aq] = await Promise.all([
        db.from("org").select("owner_email").eq("id", oid).single(),
        db.from("org_admin").select("email").eq("org_id", oid).order("email")
      ]);
      const owner = (oq.data && oq.data.owner_email) || null;
      const admins = aq.error ? [] : (aq.data||[]);
      const meOwner = owner === session.email;
      box.innerHTML = admins.map(a=>{
        const isOwner = a.email === owner;
        const canRemove = !isOwner && (meOwner || a.email === session.email);
        const lbl = a.email === session.email ? "Lämna" : "Ta bort";
        return `<div class="scsrow"><span class="scsname" style="font-weight:500">${esc(a.email)}${isOwner?` <span class="tagpill">skapare</span>`:""}${a.email===session.email?` <span class="tagpill">du</span>`:""}</span>${canRemove?`<button class="btn sm" data-rmadm="${oid}|${encodeURIComponent(a.email)}">${lbl}</button>`:""}</div>`;
      }).join("") + (owner ? "" : `<div class="meta2" style="margin-top:6px">Ingen ägare är satt för stallet än (kör db/agare-mejlbyte.sql).</div>`);
      box.querySelectorAll("[data-rmadm]").forEach(x=> x.onclick = async ()=>{
        const j = x.getAttribute("data-rmadm").indexOf("|");
        const o2 = x.getAttribute("data-rmadm").slice(0, j), email = decodeURIComponent(x.getAttribute("data-rmadm").slice(j+1));
        const self = email === session.email;
        if(!(await confirmDialog(self ? "Vill du lämna som admin? Eventuella andra roller och profiler behåller du." : `Ta bort ${email} som admin? Eventuella andra roller och profiler påverkas inte.`, { title:"Admin", okText: self ? "Ja, lämna" : "Ja, ta bort" }))) return;
        const r = await db.from("org_admin").delete().eq("org_id", o2).eq("email", email);
        if(r.error){ alert("Kunde inte ta bort: " + r.error.message); return; }
        renderHome();
      });
    });
    list.querySelectorAll("[data-invlog]").forEach(b=> b.onclick = async ()=>{
      const oid = b.getAttribute("data-invlog");
      const box = el("ivl_"+oid);
      if(box.style.display !== "none"){ box.style.display = "none"; return; }
      box.style.display = ""; box.innerHTML = `<div class="empty">Laddar…</div>`;
      const r = await db.from("invite").select("email,invite_name,kind,staff_perm,status,created_at,responded_at,invited_by,stable(name,org_id),profile(name)").order("created_at",{ascending:false});
      const rows = (r.error?[]:(r.data||[])).filter(v=> v.stable && v.stable.org_id === oid);
      if(!rows.length){ box.innerHTML = `<div class="empty">Inga inbjudningar skickade än.</div>`; return; }
      box.innerHTML = rows.map(v=>{
        const stTag = v.status === "pending" ? `<span class="tagpill st-pend">väntar</span>`
                    : v.status === "accepted" ? `<span class="tagpill">accepterad</span>`
                    : `<span class="tagpill st-no">avböjd</span>`;
        const cd = v.created_at ? new Date(v.created_at) : null;
        const rd = v.responded_at ? new Date(v.responded_at) : null;
        return `<div class="scsrow" style="align-items:flex-start"><span class="scsname" style="font-weight:500">${esc(v.invite_name || v.email)}
            <div class="meta2">${esc(v.email)} · ${esc(inviteRoleLabel(v))} · ${esc((v.stable&&v.stable.name)||"")}</div>
            <div class="meta2">${cd?`Skickad ${cd.getDate()}/${cd.getMonth()+1}`:""}${rd?` · svarade ${rd.getDate()}/${rd.getMonth()+1}`:""}</div>
          </span>${stTag}</div>`;
      }).join("");
    });
    list.querySelectorAll("[data-mkunit]").forEach(b=> b.onclick = async ()=>{
      const oid = b.getAttribute("data-mkunit");
      const kind = el("nuk_"+oid).value, name = (el("nun_"+oid).value||"").trim();
      const { data, error } = await db.rpc("create_unit", { p_org: oid, p_name: name, p_kind: kind });
      if(error){ alert("Kunde inte skapa: " + error.message); return; }
      view = { name:"stable", stableId: data };
      render();
    });
  }catch(e){
    el("stableList").innerHTML = msg("Kunde inte hämta stall: " + (e.message||e), "err");
  }
}

async function loadMyStables(){
  // Returnerar en platt lista av DELAR (units): {id,name,kind,orgId,orgName,isAdmin}
  const map = new Map();
  const adm = await db.from("org_admin").select("org(id,name,stable(id,name,kind))").eq("email", session.email);
  if(!adm.error){
    (adm.data||[]).forEach(r=>{
      const o = r.org; if(!o) return;
      const units = o.stable || [];
      units.forEach(u=> map.set(u.id, { id:u.id, name:u.name, kind:u.kind||"stall", orgId:o.id, orgName:o.name, isAdmin:true }));
      if(!units.length) map.set("org-"+o.id, { id:null, emptyOrg:true, name:o.name, kind:"stall", orgId:o.id, orgName:o.name, isAdmin:true });
    });
    // profilmedlemskap där jag avböjt inbjudan visas inte (kan ångras i Mina förfrågningar)
    let declined = new Set();
    const dv = await db.from("invite").select("profile_id").eq("email", session.email).eq("status","declined");
    if(!dv.error) declined = new Set((dv.data||[]).map(x=> x.profile_id));
    const mem = await db.from("profile_member").select("profile(id,stable(id,name,kind,org_id,org(name)))").eq("email", session.email);
    if(!mem.error) (mem.data||[]).forEach(r=>{
      const s = r.profile && r.profile.stable; if(!s || map.has(s.id)) return;
      if(r.profile && declined.has(r.profile.id)) return;
      map.set(s.id, { id:s.id, name:s.name, kind:s.kind||"stall", orgId:s.org_id, orgName:(s.org&&s.org.name)||s.name, isAdmin:false });
    });
    const sm = await db.from("rs_student_member").select("rs_student(stable(id,name,kind,org_id,org(name)))").eq("email", session.email);
    if(!sm.error) (sm.data||[]).forEach(r=>{
      const s = r.rs_student && r.rs_student.stable; if(!s || map.has(s.id)) return;
      map.set(s.id, { id:s.id, name:s.name, kind:s.kind||"stall", orgId:s.org_id, orgName:(s.org&&s.org.name)||s.name, isAdmin:false });
    });
    const fm = await db.from("rs_staff_member").select("rs_staff(stable(id,name,kind,org_id,org(name)))").eq("email", session.email);
    if(!fm.error) (fm.data||[]).forEach(r=>{
      const s = r.rs_staff && r.rs_staff.stable; if(!s || map.has(s.id)) return;
      map.set(s.id, { id:s.id, name:s.name, kind:s.kind||"stall", orgId:s.org_id, orgName:(s.org&&s.org.name)||s.name, isAdmin:false });
    });
    const im = await db.from("rs_instructor_member").select("rs_instructor(stable(id,name,kind,org_id,org(name)))").eq("email", session.email);
    if(!im.error) (im.data||[]).forEach(r=>{
      const s = r.rs_instructor && r.rs_instructor.stable; if(!s || map.has(s.id)) return;
      map.set(s.id, { id:s.id, name:s.name, kind:s.kind||"stall", orgId:s.org_id, orgName:(s.org&&s.org.name)||s.name, isAdmin:false });
    });
    const units = [...map.values()];
    iAmAdminSomewhere = units.some(u=> u.isAdmin);   // håll "Visa som"-behörigheten aktuell (räknas på de riktiga rollerna)
    return applyPermView(units);
  }
  // Fallback (om db/org.sql inte körts än): gamla platta modellen
  const admin = await db.from("stable_admin").select("stable(*)").eq("email", session.email);
  if(admin.error) throw admin.error;
  admin.data.forEach(r=>{ if(r.stable) map.set(r.stable.id, { ...r.stable, orgId:r.stable.id, orgName:r.stable.name, isAdmin:true }); });
  const mem = await db.from("profile_member").select("profile(stable(*))").eq("email", session.email);
  if(!mem.error) mem.data.forEach(r=>{ const s=r.profile && r.profile.stable; if(s && !map.has(s.id)) map.set(s.id, { ...s, orgId:s.id, orgName:s.name, isAdmin:false }); });
  const sm = await db.from("rs_student_member").select("rs_student(stable(*))").eq("email", session.email);
  if(!sm.error) (sm.data||[]).forEach(r=>{ const s=r.rs_student && r.rs_student.stable; if(s && !map.has(s.id)) map.set(s.id, { ...s, orgId:s.id, orgName:s.name, isAdmin:false }); });
  return applyPermView([...map.values()]);
}
/* "Visa som" styr även vilka stall som syns: i förhandsgranskning är man aldrig admin,
   och som jourmedlem finns ridskolans delar inte med alls. */
function applyPermView(units){
  if(!permView) return units;
  const out = units.map(u=> ({ ...u, isAdmin:false }));
  return permView === "jour" ? out.filter(u=> u.kind !== "ridskola") : out;
}
function unitLabel(u){ return u.orgName && u.orgName !== u.name ? `${u.orgName} · ${u.name}` : u.name; }
function kindLabel(k){ return k === "ridskola" ? "Ridskola" : "Jourschema"; }

function createOrgDialog(){
  const ov = document.createElement("div"); ov.className = "modal-ov";
  ov.innerHTML = `<div class="modal"><h3>Skapa nytt stall</h3>
    <div class="field"><label class="fld">Stallets namn</label><input type="text" id="co_name" placeholder="t.ex. RHC" maxlength="40"></div>
    <div class="field"><label class="fld">Första delen</label><select id="co_kind"><option value="stall">Jourschema</option><option value="ridskola">Ridskola</option></select></div>
    <div id="co_msg"></div>
    <div class="modal-btns"><button class="btn" id="co_cancel">Avbryt</button><button class="btn primary" id="co_go">Skapa</button></div></div>`;
  document.body.appendChild(ov);
  const done = ()=> ov.remove();
  ov.querySelector("#co_cancel").onclick = done;
  ov.onclick = (e)=>{ if(e.target===ov) done(); };
  ov.querySelector("#co_go").onclick = async ()=>{
    const name = (ov.querySelector("#co_name").value||"").trim();
    if(!name){ ov.querySelector("#co_msg").innerHTML = msg("Ge stallet ett namn.", "err"); return; }
    const { data, error } = await db.rpc("create_stable", { p_name: name, p_kind: ov.querySelector("#co_kind").value });
    if(error){ ov.querySelector("#co_msg").innerHTML = msg("Kunde inte skapa: " + error.message, "err"); return; }
    done();
    view = { name:"stable", stableId: data };
    render();
  };
  ov.querySelector("#co_name").focus();
}

/* ============ Stall-vy – profiler ============ */
async function renderStable(stableId){
  const kindQ = await db.from("stable").select("kind").eq("id", stableId).single();
  if(!kindQ.error && kindQ.data && kindQ.data.kind === "ridskola"){ renderSchool(stableId); return; }
  editingPassId = editingHorseId = editingGroupId = editingCatId = editingProfileId = null;
  stOpen = {};
  stStableId = stableId;
  appEl.innerHTML = `
    <button class="backlink" id="back">‹ Mina stall</button>
    <div class="card schedtop"><div id="stableHead"><h1 class="title">Laddar…</h1></div></div>
    <div class="card" id="stTreeCard"><div class="empty">Laddar…</div></div>`;
  el("back").onclick = ()=>{ view={name:"home",stableId:null}; render(); };

  try{
    const st = await db.from("stable").select("*").eq("id", stableId).single();
    if(st.error) throw st.error;
    curOrgId = st.data.org_id || null;
    curAdmin = await amIAdmin(stableId);
    el("stableHead").innerHTML = `
      <div class="schedeyebrow">Inställningar</div>
      <h1 class="schedname" style="margin-bottom:6px">${esc(st.data.name)}</h1>
      <p class="sub" style="margin:0">${curAdmin ? '<span class="pill">Admin</span>' : '<span class="muted">Medlem</span>'}</p>`;
    await reloadStableData();
    renderUnitDanger("stTreeCard", stableId, st.data.name);
  }catch(e){
    el("stableHead").innerHTML = msg("Kunde inte öppna stallet: " + (e.message||e), "err");
  }
}

let curPerm = "member";   // roll i ridskolan som visas: admin | teacher | chef | member
let permView = null;      // admins "Visa som"-förhandsgranskning: teacher | chef | member | null
let iAmAdminSomewhere = false;   // bara admins ser "Visa som" — inbjuden personal ska inte kunna byta vy
async function refreshAdminFlag(){
  if(!session){ iAmAdminSomewhere = false; permView = null; return false; }
  const r = await db.from("org_admin").select("org_id").eq("email", session.email).limit(1);
  iAmAdminSomewhere = !r.error && (r.data||[]).length > 0;
  if(!iAmAdminSomewhere && permView){ permView = null; renderViewAsBar(); }
  return iAmAdminSomewhere;
}
async function mySchoolPerm(stableId){
  const r = await db.rpc("my_school_perm", { sid: stableId });
  const real = (!r.error && r.data) ? r.data : ((await amIAdmin(stableId)) ? "admin" : "member");
  if(permView && real === "admin") return permView === "jour" ? "member" : permView;   // förhandsgranska en annan roll
  return real;
}
function renderViewAsBar(){
  let bar = el("viewAsBar");
  if(!permView){ if(bar) bar.remove(); return; }
  const lbl = { teacher:"ridlärare", chef:"chef", member:"stallpersonal/medlem", jour:"jourmedlem" }[permView] || permView;
  if(!bar){
    bar = document.createElement("div"); bar.id = "viewAsBar";
    bar.style.cssText = "position:sticky;top:0;z-index:20;background:var(--danger);color:#fff;text-align:center;padding:7px 12px;font-size:.85rem;font-weight:600;cursor:pointer";
    document.querySelector("header.app").after(bar);
  }
  bar.textContent = "👁 Visar appen som " + lbl + " — klicka här för att återgå till admin";
  bar.onclick = ()=>{ permView = null; renderViewAsBar(); render(); };
}
async function viewAsDialog(){
  closeProfileMenu();
  const ov = document.createElement("div"); ov.className = "modal-ov";
  const opt = (v,l)=> `<button class="btn block${(permView||"admin")===v?" primary":""}" data-va="${v}" style="margin-top:8px">${l}</button>`;
  ov.innerHTML = `<div class="modal"><h3>Visa som</h3>
    <p>Förhandsgranska hur appen ser ut för en annan roll. Du är fortfarande inloggad som dig själv.</p>
    ${opt("admin","Admin (min vanliga vy)")}${opt("teacher","Ridlärare")}${opt("chef","Chef")}${opt("member","Stallpersonal / medlem")}${opt("jour","Jourmedlem — ser bara jouren")}
    <p class="meta2" style="margin-top:10px">Jourmedlem är någon som bara är med i jourstallet: ridskolans schema och inställningar syns inte alls.</p>
    <div class="modal-btns" style="margin-top:14px"><button class="btn" id="vaClose">Stäng</button></div></div>`;
  document.body.appendChild(ov);
  ov.querySelector("#vaClose").onclick = ()=> ov.remove();
  ov.querySelectorAll("[data-va]").forEach(b=> b.onclick = ()=>{
    const v = b.getAttribute("data-va");
    permView = v === "admin" ? null : v;
    // en jourmedlem har inte ridskolan alls — lämna den vy man står i
    if(permView === "jour") view = { name:"home", stableId:null };
    ov.remove(); renderViewAsBar(); render();
  });
}
/* Är jag den som skapade stallet? (org.owner_email — högsta nivån, över admin) */
async function iAmOwnerOf(orgId){
  if(!orgId || !session || permView) return false;
  const r = await db.from("org").select("owner_email").eq("id", orgId).single();
  return !r.error && !!r.data && (r.data.owner_email||"").toLowerCase() === session.email;
}

/* Farlig zon i delens inställningar: ägaren kan ta bort hela delen */
async function renderUnitDanger(afterId, stableId, unitName){
  const old = el("unitDanger"); if(old) old.remove();
  const anchor = el(afterId); if(!anchor) return;
  if(!(await iAmOwnerOf(curOrgId))) return;
  const card = document.createElement("div");
  card.className = "card"; card.id = "unitDanger";
  card.innerHTML = `<div class="sublabel" style="margin-bottom:6px">Ta bort</div>
    <p class="meta2" style="margin:0 0 12px">Tar bort hela den här delen och allt som ligger i den. Det går inte att ångra.</p>
    <button class="btn danger-solid" id="delUnitBtn">Ta bort ${esc(unitName)}</button>`;
  anchor.after(card);
  el("delUnitBtn").onclick = ()=> deleteUnitDialog(stableId, unitName);
}

/* Bekräftelse med innehållsförteckning — namnet måste skrivas för att knappen ska gå att trycka på */
async function deleteUnitDialog(stableId, unitName){
  const stq = await db.from("stable").select("kind,org_id").eq("id", stableId).single();
  if(stq.error){ alert("Kunde inte läsa delen: " + stq.error.message); return; }
  const kind = stq.data.kind || "stall", orgId = stq.data.org_id || null;
  const n = async (table)=>{ const r = await db.from(table).select("id").eq("stable_id", stableId); return r.error ? 0 : (r.data||[]).length; };
  const rows = kind === "ridskola"
    ? [["lektion","lektioner", await n("rs_group")], ["elev","elever", await n("rs_student")], ["häst","hästar", await n("rs_horse")], ["anställd","personal", await n("rs_staff")], ["arbetspass","arbetspass", await n("rs_task")]]
    : [["profil","profiler", await n("profile")], ["häst","hästar", await n("horse")], ["jourgrupp","jourgrupper", await n("duty_group")], ["passtyp","passtyper", await n("pass_def")], ["bokning","bokningar", await n("booking")]];
  const has = rows.filter(x=> x[2] > 0);
  let isLast = false, orgName = "";
  if(orgId){
    const sib = await db.from("stable").select("id").eq("org_id", orgId);
    isLast = !sib.error && (sib.data||[]).length <= 1;
    const oq = await db.from("org").select("name").eq("id", orgId).single();
    orgName = (!oq.error && oq.data && oq.data.name) || "";
  }
  const ov = document.createElement("div"); ov.className = "modal-ov";
  ov.innerHTML = `<div class="modal"><h3>Ta bort ${esc(unitName)}</h3>
    <p>Det här försvinner för alla i stallet och går inte att ångra:</p>
    <div class="msg warn" style="margin-bottom:12px">${has.length
      ? has.map(x=> `${x[2]} ${x[2] === 1 ? x[0] : x[1]}`).join(" · ") + " — och allt som hänger ihop med dem (scheman, sjukanmälningar, förfrågningar, chatt och inbjudningar)."
      : "Delen är tom — inget innehåll att förlora."}</div>
    ${isLast && orgName ? `<label class="chk"><input type="checkbox" id="du_org"> Ta bort hela stallet <b>${esc(orgName)}</b> också (det här är den sista delen)</label>` : ""}
    <div class="field"><label class="fld">Skriv <b>${esc(unitName)}</b> för att bekräfta</label>
      <input type="text" id="du_name" autocomplete="off" placeholder="${esc(unitName)}"></div>
    <div id="du_msg"></div>
    <div class="modal-btns"><button class="btn" id="du_cancel">Avbryt</button>
      <button class="btn danger-solid" id="du_go" disabled style="opacity:.5">Ta bort för alltid</button></div></div>`;
  document.body.appendChild(ov);
  const go = ov.querySelector("#du_go"), inp = ov.querySelector("#du_name");
  inp.oninput = ()=>{
    const ok = inp.value.trim().toLowerCase() === unitName.trim().toLowerCase();
    go.disabled = !ok; go.style.opacity = ok ? "" : ".5";
  };
  ov.querySelector("#du_cancel").onclick = ()=> ov.remove();
  go.onclick = async ()=>{
    const dropOrg = !!(ov.querySelector("#du_org") && ov.querySelector("#du_org").checked);
    go.disabled = true; go.textContent = "Tar bort…";
    // hela stallet tas bort via org (delarna följer med), annars bara den här delen
    const r = dropOrg
      ? await db.from("org").delete().eq("id", orgId).select("id")
      : await db.from("stable").delete().eq("id", stableId).select("id");
    if(r.error || !(r.data||[]).length){
      go.disabled = false; go.textContent = "Ta bort för alltid";
      el("du_msg").innerHTML = msg(r.error ? "Kunde inte ta bort: " + r.error.message
        : "Databasen nekade borttagningen — bara den som skapade stallet får ta bort en del (har db/ta-bort-del.sql körts?)", "err");
      return;
    }
    ov.remove();
    curOrgId = null; stStableId = null; scStableId = null;
    view = { name:"home", stableId:null };
    await refreshAdminFlag();
    render();
    infoDialog(dropOrg ? `Stallet ${orgName} är borttaget.` : `${unitName} är borttagen.`, "Borttaget");
  };
  setTimeout(()=> inp.focus(), 50);
}

async function amIAdmin(stableId){
  if(permView) return false;   // i "Visa som" är man aldrig admin
  const r = await db.rpc("am_i_admin", { sid: stableId });
  if(!r.error) return !!r.data;
  // fallback om db/org.sql inte körts än
  const q = await db.from("stable_admin").select("email").eq("stable_id", stableId).eq("email", session.email).maybeSingle();
  return !q.error && !!q.data;
}

/* ============ Stall-inställningar: trädvy ============ */
let stOpen = {};        // vilka noder i trädet som är öppna
let stStableId = null;
let curOrgId = null;    // stallets (organisationens) id för aktuell del
let stData = null;      // {groups, cats, passes, profiles}
let focusProfileId = null;  // profil att öppna direkt (från Profil-menyn)

async function reloadStableData(){
  const sid = stStableId;
  const [g,c,p,pr,ad] = await Promise.all([
    db.from("duty_group").select("*").eq("stable_id", sid).order("sort_order"),
    db.from("category").select("*").eq("stable_id", sid).order("sort_order"),
    db.from("pass_def").select("*, category(name)").eq("stable_id", sid).order("sort_order"),
    db.from("profile").select("id,name,remind1_min,remind2_min,profile_member(email),horse(id,name,group_id)").eq("stable_id", sid).order("created_at"),
    curOrgId ? db.from("org_admin").select("email").eq("org_id", curOrgId)
             : db.from("stable_admin").select("email").eq("stable_id", sid)
  ]);
  const err = g.error || c.error || p.error || pr.error;
  if(err){ el("stTreeCard").innerHTML = msg("Kunde inte hämta stallets data: " + err.message, "err"); return; }
  curGroups = g.data; curCats = c.data;
  stData = { groups: g.data, cats: c.data, passes: sortPassesByTime(p.data), profiles: pr.data,
             admins: ad.error ? [] : (ad.data||[]).map(x=> (x.email||"").toLowerCase()) };
  if(focusProfileId){
    const fp = stData.profiles.find(x=> x.id === focusProfileId);
    if(fp){
      stOpen.grupper = true;
      (fp.horse||[]).forEach(h=>{ if(h.group_id){ stOpen["g_"+h.group_id] = true; stOpen[`p_${h.group_id}_${fp.id}`] = true; } });
      if(!(fp.horse||[]).length || (fp.horse||[]).some(h=> !h.group_id)){ stOpen.g_none = true; stOpen[`p_none_${fp.id}`] = true; }
    }
    focusProfileId = null;
  }
  renderStableTree();
}

function caret(k){ return `<span class="caret">${stOpen[k]?"▾":"▸"}</span>`; }
/* Lägg till-kontroller ligger dolda bakom en accentfärgad rad tills man klickar på den */
function stAddCtl(showKey, label, controlHtml, lvl, plain){
  if(!stOpen[showKey])
    return `<div class="tleaf lvl${lvl}" data-stshow="${showKey}" style="color:var(--accent);cursor:pointer;font-weight:600">${ic("plus")} ${label}</div>`;
  return `<div class="addbox lvl${lvl}">
    <div class="addhead"><span>${esc(label)}</span><button class="x" data-sthide="${showKey}" title="Stäng">✕</button></div>
    <div class="${plain ? "addfields" : "addhorse"}">${controlHtml}</div>
  </div>`;
}
function isMyProfile(p){ return (p.profile_member||[]).some(m=> m.email && m.email.toLowerCase() === session.email); }
function tbtns(kind, id, canEdit, canDel){
  if(canEdit === undefined) canEdit = curAdmin;
  if(canDel === undefined) canDel = canEdit;
  if(!canEdit && !canDel) return "";
  return `<span class="tbtns">${canEdit?`<button class="x" data-e="${kind}:${id}" title="Ändra">${ic("pencil")}</button>`:""}${canDel?`<button class="x" data-d="${kind}:${id}" title="Ta bort">${ic("x")}</button>`:""}</span>`;
}

function horseRow(h, mine, lvl){
  const may = curAdmin || mine;
  lvl = lvl || 3;
  if(may && h.id === editingHorseId){
    const gsel = `<option value="">Ingen grupp</option>` + stData.groups.map(g=>`<option value="${g.id}"${g.id===h.group_id?" selected":""}>${esc(g.name)}</option>`).join("");
    return `<div class="editrow lvl${lvl}">
      <div class="field"><label class="fld">Hästens namn</label><input type="text" id="eh_name_${h.id}" value="${esc(h.name||'')}"></div>
      <div class="field"><label class="fld">Grupp</label><select id="eh_group_${h.id}">${gsel}</select></div>
      <div class="editbtns"><button class="btn primary sm" data-s="horse:${h.id}">Spara</button><button class="btn sm" data-c="1">Avbryt</button></div>
    </div>`;
  }
  const g = stData.groups.find(x=>x.id===h.group_id);
  return `<div class="tleaf lvl${lvl}"><span class="cdot" style="background:${(g&&g.color)||'#c9d6cd'}"></span><span>${esc(h.name||'Häst')}</span>${tbtns("horse",h.id,may,may)}</div>`;
}

function profileNode(p, groupId, keyPrefix, lvl){
  lvl = lvl || 2;            // under en grupp ligger profilen på nivå 2, i Profiler-fliken på nivå 1
  const sub = lvl + 1;
  const key = `p_${keyPrefix}_${p.id}`;
  const mine = isMyProfile(p);
  const may = curAdmin || mine;   // får redigera profilen (namn, mejl, hästar)
  const horses = groupId === "*" ? (p.horse||[])
    : (p.horse||[]).filter(h=> groupId===null ? !h.group_id : h.group_id===groupId);
  const out = [];
  const isAdm = profileIsAdmin(p);
  if(may && p.id === editingProfileId){
    out.push(`<div class="editrow lvl${lvl}"><div class="editname"><input type="text" id="epr_name_${p.id}" value="${esc(p.name)}">
      <button class="btn primary sm" data-s="profile:${p.id}">Spara</button><button class="btn sm" data-c="1">Avbryt</button></div>
      ${curAdmin?`<div class="editbtns" style="margin-top:10px"><button class="btn sm" data-mkadm="${p.id}">${isAdm?"Ta bort admin-behörighet":"Gör till admin"}</button></div>`:""}</div>`);
  } else {
    const pbtns = `<span class="tbtns">${curAdmin?`<button class="x" data-mv="${p.id}" title="Byt grupp">${ic("swap")}</button>`:""}${may?`<button class="x" data-e="profile:${p.id}" title="Ändra">${ic("pencil")}</button>`:""}${curAdmin?`<button class="x" data-d="profile:${p.id}" title="Ta bort">${ic("x")}</button>`:""}</span>`;
    out.push(`<div class="trow lvl${lvl} titem" data-t="${key}">${ic("user")} ${esc(p.name)}${mine?` <span class="tagpill">du</span>`:""}${isAdm?` <span class="tagpill">admin</span>`:""} <span class="meta2">${horses.length} häst${horses.length===1?"":"ar"}</span> ${caret(key)}${pbtns}</div>`);
  }
  if(stOpen[key]){
    const mails = (p.profile_member||[]).map(m=>m.email).filter(Boolean);
    mails.forEach(em=> out.push(`<div class="tleaf lvl${sub}">${ic("mail")} ${esc(em)}${may?`<span class="tbtns"><button class="x" data-d="mail:${p.id}|${encodeURIComponent(em)}" title="Ta bort">${ic("x")}</button></span>`:""}</div>`));
    if(!mails.length) out.push(`<div class="tleaf lvl${sub} tmuted">Ingen mejl kopplad än</div>`);
    if(may) out.push(stAddCtl(`add_mail_${keyPrefix}_${p.id}`, "Lägg till mejladress",
      `<input type="email" id="in_mail_${keyPrefix}_${p.id}" placeholder="namn@exempel.se"><button class="btn sm" data-add="mail:${keyPrefix}:${p.id}">+ Mejl</button>`, sub));
    if(may){
      const remSel = (slot)=>{ const cur = String(p["remind"+slot+"_min"] || "");
        return `<select data-rem="${slot}:${p.id}">${REMIND_OPTS.map(([v,l])=>`<option value="${v}"${cur===v?" selected":""}>${l}</option>`).join("")}</select>`; };
      // påminnelserna ligger hopfällda bakom en egen rad, med nuvarande val som sammanfattning
      const remKey = `rem_${keyPrefix}_${p.id}`;
      const remLbl = v=> (REMIND_OPTS.find(o=> o[0] === String(v||""))||["",""])[1];
      const set = [p.remind1_min, p.remind2_min].filter(Boolean).map(remLbl);
      out.push(`<div class="trow lvl${sub} titem" data-t="${remKey}">⏰ Påminnelser om pass <span class="meta2">${set.length ? esc(set.join(" · ")) : "av"}</span> ${caret(remKey)}</div>`);
      if(stOpen[remKey]){
        out.push(`<div class="addbox lvl${sub}">
          <div class="addhead"><span>Påminnelser om pass</span></div>
          <div class="meta2" style="margin-bottom:8px">Visas i notisklockan innan passet börjar.</div>
          <div class="addhorse"><span class="meta2" style="min-width:96px">Påminnelse 1</span>${remSel(1)}</div>
          <div class="addhorse"><span class="meta2" style="min-width:96px">Påminnelse 2</span>${remSel(2)}</div>
        </div>`);
      }
    }
    horses.forEach(h=> out.push(horseRow(h, mine, sub)));
    if(may){
      const gsel = `<option value="">Ingen grupp</option>` + stData.groups.map(g=>`<option value="${g.id}"${g.id===groupId?" selected":""}>${esc(g.name)}</option>`).join("");
      out.push(stAddCtl(`add_horse_${keyPrefix}_${p.id}`, "Lägg till häst",
        `<input type="text" id="in_horse_${keyPrefix}_${p.id}" placeholder="Hästens namn"><select id="in_horsegrp_${keyPrefix}_${p.id}">${gsel}</select><button class="btn sm" data-add="horse:${keyPrefix}:${p.id}">+ Lägg till häst</button>`, sub));
    }
  }
  return out.join("");
}

function groupNode(g){
  const key = "g_"+g.id;
  const out = [];
  if(curAdmin && g.id === editingGroupId){
    out.push(`<div class="editrow lvl1"><div class="editname"><input type="text" id="eg_name_${g.id}" value="${esc(g.name)}">
      <button class="btn primary sm" data-s="group:${g.id}">Spara</button><button class="btn sm" data-c="1">Avbryt</button></div></div>`);
  } else {
    const gbtns = `<span class="tbtns"><button class="x" data-gs="${g.id}" title="Statistik">${ic("chart")}</button>${curAdmin?`<button class="x" data-e="group:${g.id}" title="Ändra">${ic("pencil")}</button><button class="x" data-d="group:${g.id}" title="Ta bort">${ic("x")}</button>`:""}</span>`;
    out.push(`<div class="trow lvl1 titem" data-t="${key}"><span class="cdot" style="background:${g.color||'#4e9e6e'}"></span>${esc(g.name)} ${caret(key)}${gbtns}</div>`);
  }
  if(stOpen[key]){
    const profs = stData.profiles.filter(p=> (p.horse||[]).some(h=> h.group_id===g.id));
    if(!profs.length) out.push(`<div class="tleaf lvl2 tmuted">Inga hästar i gruppen än</div>`);
    profs.forEach(p=> out.push(profileNode(p, g.id, g.id)));
  }
  return out.join("");
}

function passRow(p){
  if(curAdmin && p.id === editingPassId){
    const catO = `<option value="">Ingen kategori</option>` + stData.cats.map(c=>`<option value="${c.id}"${c.id===p.category_id?" selected":""}>${esc(c.name)}</option>`).join("");
    const dayO = [["all","Alla dagar"],["weekday","Vardagar"],["weekend","Helg"]].map(([v,l])=>`<option value="${v}"${v===p.day_rule?" selected":""}>${l}</option>`).join("");
    const timO = TIME_OPTIONS.map(x=>`<option value="${x}"${x===p.start_time?" selected":""}>${x}</option>`).join("");
    return `<div class="editrow lvl2">
      <div class="field"><label class="fld">Namn</label><input type="text" id="ep_name_${p.id}" value="${esc(p.name)}"></div>
      <div class="field"><label class="fld">Tid</label><select id="ep_time_${p.id}">${timO}</select></div>
      <div class="field"><label class="fld">Kategori</label><select id="ep_cat_${p.id}">${catO}</select></div>
      <div class="field"><label class="fld">Dagar</label><select id="ep_days_${p.id}">${dayO}</select></div>
      <div class="field"><label class="fld">Antal personer</label><select id="ep_cap_${p.id}">${capOpts(p.capacity||1)}</select></div>
      <div class="editbtns"><button class="btn primary sm" data-s="pass:${p.id}">Spara</button><button class="btn sm" data-c="1">Avbryt</button></div>
    </div>`;
  }
  const bits = [p.start_time, DAYLBL[p.day_rule]||"", (p.capacity>1?p.capacity+" pers":"")].filter(Boolean).join(" · ");
  const cat = p.category && p.category.name;
  return `<div class="tleaf lvl2"><span><b>${esc(p.name)}</b> <span class="meta2">${esc(bits)}</span></span>${cat?`<span class="tagpill">${esc(cat)}</span>`:""}${tbtns("pass",p.id)}</div>`;
}

function addPassForm(){
  const catO = `<option value="">Ingen kategori</option>` + stData.cats.map(c=>`<option value="${c.id}">${esc(c.name)}</option>`).join("");
  return `<div class="field"><label class="fld">Namn</label><input type="text" id="in_pass_name" placeholder="t.ex. Morgonfodring"></div>
    <div class="field"><label class="fld">Tid</label><select id="in_pass_time">${TIME_OPTIONS.map(t=>`<option value="${t}"${t==="07:00"?" selected":""}>${t}</option>`).join("")}</select></div>
    <div class="field"><label class="fld">Kategori</label><select id="in_pass_cat">${catO}</select></div>
    <div class="field"><label class="fld">Dagar</label><select id="in_pass_days"><option value="all">Alla dagar</option><option value="weekday">Vardagar</option><option value="weekend">Helg</option></select></div>
    <div class="field"><label class="fld">Antal personer</label><select id="in_pass_cap">${capOpts(1)}</select></div>
    <button class="btn primary sm" data-add="pass">+ Lägg till pass</button>`;
}

function catRow(c){
  if(curAdmin && c.id === editingCatId){
    return `<div class="editrow lvl2"><div class="editname"><input type="text" id="ec_name_${c.id}" value="${esc(c.name)}">
      <button class="btn primary sm" data-s="cat:${c.id}">Spara</button><button class="btn sm" data-c="1">Avbryt</button></div></div>`;
  }
  return `<div class="tleaf lvl2">${ic("tag")} ${esc(c.name)}${tbtns("cat",c.id)}</div>`;
}

function renderStableTree(){
  const host = el("stTreeCard"); if(!host || !stData) return;
  const t = [];
  t.push(tSect(150));
  t.push(`<div class="trow lvl0" data-t="grupper">${ic("users")} Grupper ${caret("grupper")}</div>`);
  if(stOpen.grupper){
    stData.groups.forEach(g=> t.push(groupNode(g)));
    const loose = stData.profiles.filter(p=> !(p.horse||[]).length || (p.horse||[]).some(h=>!h.group_id));
    if(loose.length){
      t.push(`<div class="trow lvl1" data-t="g_none">◌ Utan grupp ${caret("g_none")}</div>`);
      if(stOpen.g_none) loose.forEach(p=> t.push(profileNode(p, null, "none")));
    }
    if(curAdmin){
      t.push(stAddCtl("add_group", "Lägg till grupp",
        `<input type="text" id="in_group" placeholder="Gruppens namn"><button class="btn sm" data-add="group">+ Grupp</button>`, 1));
      t.push(stAddCtl("add_profile", "Lägg till profil",
        `<input type="text" id="in_profile" placeholder="t.ex. Familjen Ek"><button class="btn sm" data-add="profile">+ Profil</button>`, 1));
    }
  }
  t.push(`</div>`);

  // Profiler som egen flik: alla profiler samlade, med hästar oavsett grupp
  t.push(tSect(196));
  t.push(`<div class="trow lvl0" data-t="profiler">${ic("user")} Profiler ${caret("profiler")}</div>`);
  if(stOpen.profiler){
    const all = stData.profiles.slice().sort((a,b)=> (a.name||"").localeCompare(b.name||"", "sv"));
    all.forEach(pr=> t.push(profileNode(pr, "*", "all", 1)));
    if(!all.length) t.push(`<div class="tleaf lvl1 tmuted">Inga profiler än</div>`);
    if(curAdmin) t.push(stAddCtl("add_profile2", "Lägg till profil",
      `<input type="text" id="in_profile2" placeholder="t.ex. Familjen Ek"><button class="btn sm" data-add="profile2">+ Profil</button>`, 1));
  }
  t.push(`</div>`);

  t.push(tSect(172));
  t.push(`<div class="trow lvl0" data-t="schema">${ic("calendar")} Schema ${caret("schema")}</div>`);
  if(stOpen.schema){
    t.push(`<div class="trow lvl1" data-t="pass">${ic("clock")} Pass ${caret("pass")}</div>`);
    if(stOpen.pass){
      stData.passes.forEach(p=> t.push(passRow(p)));
      if(!stData.passes.length) t.push(`<div class="tleaf lvl2 tmuted">Inga pass än</div>`);
      if(curAdmin) t.push(stAddCtl("add_pass", "Lägg till pass", addPassForm(), 2, true));
    }
    t.push(`<div class="trow lvl1" data-t="kategorier">${ic("tag")} Kategorier ${caret("kategorier")}</div>`);
    if(stOpen.kategorier){
      stData.cats.forEach(c=> t.push(catRow(c)));
      if(!stData.cats.length) t.push(`<div class="tleaf lvl2 tmuted">Inga kategorier än</div>`);
      if(curAdmin) t.push(stAddCtl("add_cat", "Lägg till kategori",
        `<input type="text" id="in_cat" placeholder="Kategorins namn"><button class="btn sm" data-add="cat">+ Kategori</button>`, 2));
    }
  }
  t.push(`</div>`);
  host.innerHTML = t.join("");
  host.querySelectorAll("[data-t]").forEach(n=> n.onclick = ()=>{ const k=n.getAttribute("data-t"); stOpen[k]=!stOpen[k]; renderStableTree(); });
  host.querySelectorAll("[data-e]").forEach(b=> b.onclick=(e)=>{ e.stopPropagation(); startEdit(b.getAttribute("data-e")); });
  host.querySelectorAll("[data-d]").forEach(b=> b.onclick=(e)=>{ e.stopPropagation(); doDelete(b.getAttribute("data-d")); });
  host.querySelectorAll("[data-s]").forEach(b=> b.onclick=(e)=>{ e.stopPropagation(); doSave(b.getAttribute("data-s")); });
  host.querySelectorAll("[data-c]").forEach(b=> b.onclick=(e)=>{ e.stopPropagation(); cancelEdit(); });
  host.querySelectorAll("[data-add]").forEach(b=> b.onclick=(e)=>{ e.stopPropagation(); doAdd(b.getAttribute("data-add")); });
  host.querySelectorAll("[data-stshow]").forEach(b=> b.onclick=(e)=>{ e.stopPropagation(); stOpen[b.getAttribute("data-stshow")] = true; renderStableTree(); });
  host.querySelectorAll("[data-sthide]").forEach(b=> b.onclick=(e)=>{ e.stopPropagation(); delete stOpen[b.getAttribute("data-sthide")]; renderStableTree(); });
  host.querySelectorAll("[data-mv]").forEach(b=> b.onclick=(e)=>{ e.stopPropagation(); moveProfileDialog(b.getAttribute("data-mv")); });
  host.querySelectorAll("[data-gs]").forEach(b=> b.onclick=(e)=>{ e.stopPropagation(); groupStatsDialog(b.getAttribute("data-gs")); });
  host.querySelectorAll("[data-mkadm]").forEach(b=> b.onclick=(e)=>{ e.stopPropagation(); toggleAdminForProfile(b.getAttribute("data-mkadm")); });
  host.querySelectorAll("[data-rem]").forEach(sel=> sel.onchange = async ()=>{
    const [slot, pid] = sel.getAttribute("data-rem").split(":");
    const upd = {}; upd["remind"+slot+"_min"] = sel.value ? parseInt(sel.value,10) : null;
    const r = await db.from("profile").update(upd).eq("id", pid);
    if(r.error) alert("Kunde inte spara påminnelsen: " + r.error.message);
    else refreshBellCount();
  });
  host.querySelectorAll(".addhorse, .editrow").forEach(n=> n.onclick=(e)=> e.stopPropagation());
}

/* Admin-behörighet per profil (via profilens mejladresser) */
function profileIsAdmin(p){
  const admins = (stData && stData.admins) || [];
  return (p.profile_member||[]).some(m=> m.email && admins.includes(m.email.toLowerCase()));
}
async function toggleAdminForProfile(pid){
  const p = stData.profiles.find(x=> x.id === pid); if(!p) return;
  const mails = (p.profile_member||[]).map(m=> (m.email||"").toLowerCase()).filter(Boolean);
  if(!mails.length){ infoDialog("Profilen har ingen mejladress kopplad än — lägg till en mejl först, det är mejlen som får admin-behörigheten.", "Ingen mejl"); return; }
  const admins = stData.admins || [];
  if(!profileIsAdmin(p)){
    const ok = await confirmDialog(
      `Vill du göra ${p.name} till admin? ${mails.length>1?"Profilens mejladresser":"Mejladressen"} (${mails.join(", ")}) får då full behörighet att ändra allt i stallet.`,
      { title:"Gör till admin", okText:"Ja, gör till admin", primary:true });
    if(!ok) return;
    const newRows = curOrgId
      ? mails.filter(m=> !admins.includes(m)).map(email=> ({ org_id: curOrgId, email }))
      : mails.filter(m=> !admins.includes(m)).map(email=> ({ stable_id: stStableId, email }));
    const r = await db.from(curOrgId ? "org_admin" : "stable_admin").insert(newRows);
    if(r.error){ alert("Kunde inte göra till admin: " + r.error.message); return; }
  } else {
    const remaining = admins.filter(a=> !mails.includes(a));
    if(!remaining.length){ infoDialog("Det går inte — stallet måste ha minst en admin kvar.", "Stopp"); return; }
    const includesMe = mails.includes(session.email);
    const ok = await confirmDialog(
      `Vill du ta bort admin-behörigheten för ${p.name} (${mails.join(", ")})?${includesMe ? " OBS: det inkluderar dig själv — du förlorar admin-åtkomsten direkt." : ""}`,
      { title:"Ta bort admin" });
    if(!ok) return;
    const r = curOrgId
      ? await db.from("org_admin").delete().eq("org_id", curOrgId).in("email", mails)
      : await db.from("stable_admin").delete().eq("stable_id", stStableId).in("email", mails);
    if(r.error){ alert("Kunde inte ta bort: " + r.error.message); return; }
    if(includesMe){ view = { name:"stable", stableId: stStableId }; render(); return; }
  }
  editingProfileId = null;
  await reloadStableData();
}

/* Gruppstatistik: bokade pass per profil och kategori, rättvist per häst */
async function groupStatsDialog(gid){
  const g = stData.groups.find(x=> x.id === gid); if(!g) return;
  const profs = stData.profiles
    .map(p=> ({ p, n: (p.horse||[]).filter(h=> h.group_id === gid).length }))
    .filter(x=> x.n > 0);
  if(!profs.length){ infoDialog("Inga hästar i gruppen än.", "Statistik"); return; }
  const b = await db.from("booking").select("profile_id,pass_def(category_id)").eq("stable_id", stStableId);
  if(b.error){ alert("Kunde inte hämta statistik: " + b.error.message); return; }
  const counts = {}; profs.forEach(x=> counts[x.p.id] = {});
  const catKeys = new Set();
  (b.data||[]).forEach(bk=>{
    if(!(bk.profile_id in counts)) return;
    const k = (bk.pass_def && bk.pass_def.category_id) || "none";
    catKeys.add(k);
    counts[bk.profile_id][k] = (counts[bk.profile_id][k]||0) + 1;
  });
  const fmt1 = v => (Math.round(v*10)/10).toString().replace(".", ",");
  let html = "";
  if(!catKeys.size){
    html = `<div class="empty">Inga bokade pass än i den här gruppen.</div>`;
  } else {
    // sortera kategorierna i stallets ordning, "Övrigt" sist
    const order = [...stData.cats.map(c=> c.id), "none"].filter(k=> catKeys.has(k));
    order.forEach(k=>{
      const name = k === "none" ? "Utan kategori" : ((stData.cats.find(c=> c.id === k)||{}).name || "Övrigt");
      const rows = profs.map(x=>{ const n = counts[x.p.id][k] || 0; return { name: x.p.name, horses: x.n, n, ph: n / x.n }; })
        .sort((a,c)=> c.ph - a.ph);
      const sum = rows.reduce((a,r)=> a + r.ph, 0);
      html += `<div class="sublabel">${esc(name)}</div>` + rows.map(r=>{
        const pct = sum > 0 ? Math.round(100 * r.ph / sum) : 0;
        return `<div class="statline">
          <div class="statmeta"><b>${esc(r.name)}</b><span class="meta2">${r.horses>1?`${r.horses} hästar · `:""}${r.n} st · ${fmt1(r.ph)}/häst · ${pct}%</span></div>
          <div class="statbar"><div style="width:${pct}%"></div></div>
        </div>`;
      }).join("");
    });
  }
  const ov = document.createElement("div"); ov.className = "modal-ov";
  ov.innerHTML = `<div class="modal statsmodal"><h3>${ic("chart")} ${esc(g.name)} – statistik</h3>
    <p>Alla bokade pass (även kommande). Har en profil flera hästar i gruppen jämförs snittet per häst.</p>
    ${html}
    <div class="modal-btns" style="margin-top:16px"><button class="btn" id="stClose">Stäng</button></div></div>`;
  document.body.appendChild(ov);
  const done = ()=> ov.remove();
  ov.querySelector("#stClose").onclick = done;
  ov.onclick = (e)=>{ if(e.target === ov) done(); };
}

/* Byt grupp: flytta en profils hästar till en annan grupp (admin) */
function moveProfileDialog(pid){
  const p = stData.profiles.find(x=> x.id === pid); if(!p) return;
  const horses = p.horse || [];
  if(!horses.length){ infoDialog("Profilen har inga hästar än — det är hästarna som styr vilken grupp profilen tillhör. Lägg till en häst och välj grupp där.", "Inga hästar"); return; }
  const ov = document.createElement("div"); ov.className = "modal-ov";
  const box = document.createElement("div"); box.className = "modal"; ov.appendChild(box);
  document.body.appendChild(ov);
  const done = ()=> ov.remove();
  ov.onclick = (e)=>{ if(e.target===ov) done(); };
  let targetGid = null;
  function stepGroup(){
    box.innerHTML = `<h3>Byt grupp</h3><p>Flytta ${esc(p.name)} till:</p>
      <div class="stack">${stData.groups.map(g=>`<button class="btn block" data-g="${g.id}"><span class="cdot" style="background:${g.color||'#4e9e6e'};margin-right:6px"></span>${esc(g.name)}</button>`).join("")}</div>
      <div class="modal-btns" style="margin-top:14px"><button class="btn" id="mvAbort">Avbryt</button></div>`;
    box.querySelector("#mvAbort").onclick = done;
    box.querySelectorAll("[data-g]").forEach(b=> b.onclick = ()=>{
      targetGid = b.getAttribute("data-g");
      if(horses.length > 1) stepHorses(); else doMove(horses.map(h=> h.id));
    });
  }
  function stepHorses(){
    const gname = (stData.groups.find(g=> g.id === targetGid)||{}).name || "";
    box.innerHTML = `<h3>Vilka hästar?</h3><p>Välj vilka av ${esc(p.name)}s hästar som ska flyttas till ${esc(gname)}:</p>
      <div class="stack">${horses.map(h=>{
        const cur = (stData.groups.find(g=> g.id === h.group_id)||{}).name || "ingen grupp";
        return `<label class="chk"><input type="checkbox" data-h="${h.id}" checked> ${esc(h.name||"Häst")} <span class="meta2">(${esc(cur)})</span></label>`;
      }).join("")}</div>
      <div class="modal-btns" style="margin-top:14px"><button class="btn" id="mvBack">‹ Tillbaka</button><button class="btn primary" id="mvGo">Flytta</button></div>`;
    box.querySelector("#mvBack").onclick = stepGroup;
    box.querySelector("#mvGo").onclick = ()=>{
      const ids = [...box.querySelectorAll("[data-h]")].filter(c=> c.checked).map(c=> c.getAttribute("data-h"));
      if(!ids.length){ infoDialog("Bocka i minst en häst att flytta.", "Ingen häst vald"); return; }
      doMove(ids);
    };
  }
  async function doMove(ids){
    const r = await db.from("horse").update({ group_id: targetGid }).in("id", ids);
    done();
    if(r.error){ alert("Kunde inte flytta: " + r.error.message); return; }
    await reloadStableData();
  }
  stepGroup();
}

function startEdit(spec){
  const [kind,id] = spec.split(":");
  editingPassId = editingHorseId = editingGroupId = editingCatId = editingProfileId = null;
  if(kind==="pass") editingPassId = id;
  if(kind==="horse") editingHorseId = id;
  if(kind==="group") editingGroupId = id;
  if(kind==="cat") editingCatId = id;
  if(kind==="profile") editingProfileId = id;
  renderStableTree();
}
function cancelEdit(){ editingPassId = editingHorseId = editingGroupId = editingCatId = editingProfileId = null; renderStableTree(); }

function confirmDialog(text, opts){
  opts = opts || {};
  const title = opts.title || "Är du säker?";
  const okText = opts.okText || "Ja, ta bort";
  const okClass = opts.primary ? "btn primary" : "btn danger-solid";
  return new Promise(res=>{
    const ov = document.createElement("div"); ov.className = "modal-ov";
    ov.innerHTML = `<div class="modal"><h3>${esc(title)}</h3><p>${esc(text)}</p>
      <div class="modal-btns"><button class="btn" id="mCancel">Avbryt</button><button class="${okClass}" id="mOk">${esc(okText)}</button></div></div>`;
    document.body.appendChild(ov);
    const done = v => { ov.remove(); res(v); };
    ov.querySelector("#mCancel").onclick = ()=> done(false);
    ov.querySelector("#mOk").onclick = ()=> done(true);
    ov.onclick = (e)=>{ if(e.target===ov) done(false); };
  });
}

async function doDelete(spec){
  const i = spec.indexOf(":"); const kind = spec.slice(0,i); const id = spec.slice(i+1);
  let q = null, text = "";
  if(kind==="group"){ const g=stData.groups.find(x=>x.id===id); text=`Du håller på att ta bort gruppen "${g?g.name:""}". Hästar i gruppen blir utan grupp.`; q=()=>db.from("duty_group").delete().eq("id",id); }
  if(kind==="profile"){ const p=stData.profiles.find(x=>x.id===id); text=`Du håller på att ta bort profilen "${p?p.name:""}" med alla dess hästar och bokningar.`; q=()=>db.from("profile").delete().eq("id",id); }
  if(kind==="horse"){ let hn="Häst"; stData.profiles.forEach(p=>(p.horse||[]).forEach(h=>{ if(h.id===id) hn=h.name||"Häst"; })); text=`Du håller på att ta bort hästen "${hn}".`; q=()=>db.from("horse").delete().eq("id",id); }
  if(kind==="mail"){ const j=id.indexOf("|"); const pid=id.slice(0,j); const email=decodeURIComponent(id.slice(j+1)); text=`Du håller på att ta bort mejladressen ${email} från profilen.`; q=()=>db.from("profile_member").delete().eq("profile_id",pid).eq("email",email); }
  if(kind==="pass"){ const p=stData.passes.find(x=>x.id===id); text=`Du håller på att ta bort passet "${p?p.name:""}". Alla bokningar på passet försvinner.`; q=()=>db.from("pass_def").delete().eq("id",id); }
  if(kind==="cat"){ const c=stData.cats.find(x=>x.id===id); text=`Du håller på att ta bort kategorin "${c?c.name:""}". Pass i kategorin blir utan kategori.`; q=()=>db.from("category").delete().eq("id",id); }
  if(!q) return;
  if(!(await confirmDialog(text))) return;
  const r = await q();
  if(r.error){ alert("Kunde inte ta bort: " + r.error.message); return; }
  await reloadStableData();
}

async function doSave(spec){
  const [kind,id] = spec.split(":");
  let r = null;
  if(kind==="group"){ const name=(el("eg_name_"+id).value||"").trim(); if(!name) return; r=await db.from("duty_group").update({name}).eq("id",id); }
  if(kind==="profile"){ const name=(el("epr_name_"+id).value||"").trim(); if(!name) return; r=await db.from("profile").update({name}).eq("id",id); }
  if(kind==="cat"){ const name=(el("ec_name_"+id).value||"").trim(); if(!name) return; r=await db.from("category").update({name}).eq("id",id); }
  if(kind==="horse"){ r=await db.from("horse").update({ name:(el("eh_name_"+id).value||"").trim()||null, group_id: el("eh_group_"+id).value||null }).eq("id",id); }
  if(kind==="pass"){
    let cap=parseInt(el("ep_cap_"+id).value,10); if(isNaN(cap)||cap<1) cap=1;
    r=await db.from("pass_def").update({ name:el("ep_name_"+id).value.trim()||"Pass", start_time:el("ep_time_"+id).value, category_id:el("ep_cat_"+id).value||null, day_rule:el("ep_days_"+id).value, capacity:cap }).eq("id",id);
  }
  if(!r) return;
  if(r.error){ alert("Kunde inte spara: " + r.error.message); return; }
  editingPassId = editingHorseId = editingGroupId = editingCatId = editingProfileId = null;
  await reloadStableData();
}

async function doAdd(spec){
  const parts = spec.split(":"); const kind = parts[0], a = parts[1], b = parts[2];
  let r = null;
  if(kind==="group"){ const name=(el("in_group").value||"").trim(); if(!name) return;
    r = await db.from("duty_group").insert({ stable_id:stStableId, name, color:GROUP_GREENS[stData.groups.length % GROUP_GREENS.length], sort_order:stData.groups.length }); }
  if(kind==="profile" || kind==="profile2"){   // samma sak från Grupper-fliken och Profiler-fliken
    const fld = el(kind === "profile2" ? "in_profile2" : "in_profile");
    const name=((fld && fld.value)||"").trim(); if(!name) return;
    r = await db.from("profile").insert({ stable_id:stStableId, name }); }
  if(kind==="cat"){ const name=(el("in_cat").value||"").trim(); if(!name) return;
    r = await db.from("category").insert({ stable_id:stStableId, name, sort_order:stData.cats.length }); }
  if(kind==="mail"){ const email=normEmail(el("in_mail_"+a+"_"+b).value); if(!email.includes("@")){ await infoDialog("Skriv en giltig mejladress i fältet först.", "Mejl saknas"); return; }
    r = await db.from("profile_member").insert({ profile_id:b, email });
    if(!r.error && email !== session.email){
      // skapa inbjudan — syns i personens notisklocka när hen loggar in (fel ignoreras, t.ex. dubblett)
      await db.from("invite").insert({ stable_id: stStableId, profile_id: b, email, invited_by: session.email });
      sendWelcomeMail(email);
    } }
  if(kind==="horse"){ const name=(el("in_horse_"+a+"_"+b).value||"").trim(); const gid=el("in_horsegrp_"+a+"_"+b).value||null;
    if(!name){ await infoDialog("Skriv hästens namn i fältet först, välj grupp och tryck sedan på + Lägg till häst.", "Namn saknas"); return; }
    r = await db.from("horse").insert({ profile_id:b, name, group_id:gid }); }
  if(kind==="pass"){ const name=(el("in_pass_name").value||"").trim(); if(!name) return;
    let cap=parseInt(el("in_pass_cap").value,10); if(isNaN(cap)||cap<1) cap=1;
    r = await db.from("pass_def").insert({ stable_id:stStableId, name, start_time:el("in_pass_time").value, category_id:el("in_pass_cat").value||null, day_rule:el("in_pass_days").value, capacity:cap, sort_order:stData.passes.length }); }
  if(!r) return;
  if(r.error){ alert("Kunde inte lägga till: " + r.error.message); return; }
  // fäll ihop kontrollen igen — nästa tillägg börjar med "Lägg till …"-raden
  const shut = { group:"add_group", profile:"add_profile", profile2:"add_profile2", cat:"add_cat", pass:"add_pass",
                 mail:`add_mail_${a}_${b}`, horse:`add_horse_${a}_${b}` }[kind];
  if(shut) delete stOpen[shut];
  await reloadStableData();
}

/* ============ Pass-hjälpare ============ */
const DAYLBL = { all:"Alla dagar", weekday:"Vardagar", weekend:"Helg", weekdays:"Valda dagar" };
/* ============ Schema-vy ============ */
async function renderSchedule(stableId){
  const kindQ = await db.from("stable").select("kind").eq("id", stableId).single();
  if(!kindQ.error && kindQ.data && kindQ.data.kind === "ridskola"){ renderSchoolSchedule(stableId); return; }
  appEl.innerHTML = `<button class="backlink" id="backSch">‹ Tillbaka till stallet</button><div id="schShell"><div class="card"><div class="empty">Laddar schema…</div></div></div>`;
  el("backSch").onclick = ()=>{ view={name:"stable",stableId}; render(); };
  try{
    const st = await db.from("stable").select("*").eq("id", stableId).single(); if(st.error) throw st.error;
    const g  = await db.from("duty_group").select("*").eq("stable_id", stableId).order("sort_order"); if(g.error) throw g.error;
    const p  = await db.from("pass_def").select("*, category(name)").eq("stable_id", stableId).order("sort_order"); if(p.error) throw p.error;
    const pr = await db.from("profile").select("id,name,horse(id,group_id)").eq("stable_id", stableId).order("created_at"); if(pr.error) throw pr.error;
    const mp = await db.from("profile_member").select("profile(id,name,stable_id)").eq("email", session.email); if(mp.error) throw mp.error;
    const myProfiles = (mp.data||[]).map(r=>r.profile).filter(x=> x && x.stable_id===stableId);
    schedCtx = { stable: st.data, groups: g.data, passes: sortPassesByTime(p.data), profiles: pr.data, myProfiles, actingProfileId: myProfiles[0] ? myProfiles[0].id : null };
    curAdmin = await amIAdmin(stableId);   // admin kan ta bort vem som helst från ett pass
    schedLogOpen = false;
    if(!weekStart2) weekStart2 = startOfWeek(new Date());
    drawScheduleShell();
    await drawGrid();
  }catch(e){ el("schShell").innerHTML = msg("Kunde inte öppna schemat: " + (e.message||e), "err"); }
}

function drawScheduleShell(){
  const mp = schedCtx.myProfiles;
  const hint = mp.length ? "" :
    `<div class="hint">Du har ingen egen profil i det här stallet, så du kan se schemat men inte boka. Be admin lägga in din mejl på en profil.</div>`;
  el("schShell").innerHTML = `
    <div class="card schedtop">
      <div class="schedeyebrow">Schema</div>
      <h1 class="schedname">${esc(schedCtx.stable.name)}</h1>
      <div id="weeknav"></div>
      ${hint}
    </div>
    <div id="gridHost"></div>`;
  drawWeekNav();
}

function drawWeekNav(){
  const end = new Date(weekStart2); end.setDate(end.getDate()+6);
  const duty = dutyGroupForWeek(weekStart2, schedCtx.groups, schedCtx.stable.rotation_offset);
  el("weeknav").innerHTML = `
    <div style="display:flex;align-items:center;justify-content:center;gap:8px;flex-wrap:wrap">
      <button class="btn sm" id="wPrev">‹ Förra</button>
      <button class="btn sm" id="wWeek" title="Till nuvarande vecka">Vecka ${isoWeekNumber(weekStart2)}</button>
      <button class="btn sm" id="wNext">Nästa ›</button>
    </div>
    <div class="muted" style="font-size:.82rem;margin-top:6px">${weekStart2.getDate()} ${MONTHS[weekStart2.getMonth()]} – ${end.getDate()} ${MONTHS[end.getMonth()]} · ${weekStart2.getFullYear()}</div>
    ${duty?`<div style="margin-top:8px"><span class="dutychip" style="background:${duty.color||'#4e9e6e'}">${esc(duty.name)}</span></div>`:""}`;
  el("wPrev").onclick = ()=> shiftWeek2(-1);
  el("wNext").onclick = ()=> shiftWeek2(1);
  el("wWeek").onclick = ()=>{ weekStart2 = startOfWeek(new Date()); drawWeekNav(); drawGrid(); };
}
function shiftWeek2(n){ weekStart2 = new Date(weekStart2); weekStart2.setDate(weekStart2.getDate()+n*7); drawWeekNav(); drawGrid(); }

async function drawGrid(keepScroll){
  const host = el("gridHost");
  const scrollY = window.scrollY;
  if(!keepScroll) host.innerHTML = `<div class="card"><div class="empty">Laddar…</div></div>`;
  const days = []; for(let i=0;i<7;i++){ const d=new Date(weekStart2); d.setDate(d.getDate()+i); days.push(d); }
  const startISO = isoDate(days[0]), endISO = isoDate(days[6]);
  const b = await db.from("booking").select("id,pass_id,pass_date,profile_id,booked_by,profile(name)")
    .eq("stable_id", schedCtx.stable.id).gte("pass_date", startISO).lte("pass_date", endISO);
  if(b.error){ host.innerHTML = msg("Kunde inte hämta bokningar: " + b.error.message, "err"); return; }
  const map = {};
  (b.data||[]).forEach(bk=>{ const k = bk.pass_id+"|"+bk.pass_date; (map[k]=map[k]||[]).push(bk); });

  const duty = dutyGroupForWeek(weekStart2, schedCtx.groups, schedCtx.stable.rotation_offset);
  const myIds = new Set(schedCtx.myProfiles.map(p=>p.id));
  const passes = schedCtx.passes;
  const tISO = isoDate(new Date());

  // Måltal per profil (viktat efter hästar) + faktiskt bokade denna vecka
  const tgt = computeTargets(weekStart2);
  if(tgt){
    const passCat = {}; passes.forEach(p=> passCat[p.id] = p.category_id || "none");
    (b.data||[]).forEach(bk=>{
      const prof = tgt.perProfile[bk.profile_id]; if(!prof) return;
      const key = passCat[bk.pass_id] || "none";
      if(!prof.byCat[key]) prof.byCat[key] = { name:(tgt.cats[key]?tgt.cats[key].name:"Övrigt"), target:0, actual:0 };
      prof.byCat[key].actual++;
    });
  }

  schedCtx.catTint = buildCatTints(passes);
  let html = `<div class="card schedcard" style="overflow-x:auto"><div class="sgrid" style="--cols:${passes.length}">`;
  // rubrikrad: hörn + pass (vågrätt)
  html += `<div class="scorner"></div>`;
  passes.forEach(p=>{
    const hu = schedCtx.catTint[p.category_id];
    const hstyle = hu != null ? ` style="background:hsla(${hu},45%,45%,.13);border-radius:8px"` : "";
    html += `<div class="sph"${hstyle}><span class="pn">${esc(p.name)}</span><span class="pt">${esc(p.start_time||"")}${p.capacity>1?" · "+p.capacity+"p":""}</span></div>`;
  });
  // en rad per veckodag (lodrätt)
  days.forEach(d=>{
    const dISO = isoDate(d);
    const wknd = (d.getDay()===0 || d.getDay()===6);
    const applicable = passes.filter(p=> passApplies(p, d));
    const dayDone = applicable.length > 0 && applicable.every(p=> (map[p.id+"|"+dISO]||[]).length >= (p.capacity||1));
    html += `<div class="sdl${dISO===tISO?" today":""}${wknd?" weekend":""}${dayDone?" done":""}"><span class="dn">${SHORT_DAYS[d.getDay()]}</span><span class="dd">${d.getDate()}/${d.getMonth()+1}</span></div>`;
    passes.forEach(p=>{ html += scheduleCell(p, d, dISO, map, myIds, tISO); });
  });
  html += `</div></div>`;
  html += renderStats(tgt, myIds);   // statistiken under schemat
  html += `<div class="card">
    <div class="trow" data-logtoggle style="padding:6px 4px">${ic("list")} Händelselogg <span class="meta2">vecka ${isoWeekNumber(weekStart2)}</span> <span class="caret" style="margin-left:auto">${schedLogOpen?"▾":"▸"}</span></div>
    <div id="logBody" style="display:${schedLogOpen?"":"none"};margin-top:6px"></div>
  </div>`;
  host.innerHTML = html;
  if(keepScroll) window.scrollTo(0, scrollY);

  host.querySelectorAll("[data-book]").forEach(btn=> btn.onclick = ()=> bookCell(btn.getAttribute("data-book"), btn.getAttribute("data-date")));
  host.querySelectorAll("[data-cancel]").forEach(btn=> btn.onclick = (e)=>{ e.stopPropagation(); cancelBooking(btn.getAttribute("data-cancel"), btn.getAttribute("data-cinfo"), btn.getAttribute("data-cprof"), btn.getAttribute("data-cmine") !== "0"); });
  host.querySelectorAll("[data-req]").forEach(chip=> chip.onclick = ()=> onChipClick(chip.getAttribute("data-req"), chip.getAttribute("data-pinfo")));
  const lt = host.querySelector("[data-logtoggle]");
  if(lt) lt.onclick = ()=>{
    schedLogOpen = !schedLogOpen;
    const lb = el("logBody");
    lb.style.display = schedLogOpen ? "" : "none";
    lt.querySelector(".caret").textContent = schedLogOpen ? "▾" : "▸";
    if(schedLogOpen) loadWeekLog();
  };
  if(schedLogOpen) loadWeekLog();
}

async function loadWeekLog(){
  const lb = el("logBody"); if(!lb) return;
  lb.innerHTML = `<div class="empty">Laddar…</div>`;
  const startISO = isoDate(weekStart2);
  const endD = new Date(weekStart2); endD.setDate(endD.getDate()+6);
  const endISO = isoDate(endD);
  const fmt = t=>{ const d = new Date(t); return `${d.getDate()}/${d.getMonth()+1} ${String(d.getHours()).padStart(2,"0")}:${String(d.getMinutes()).padStart(2,"0")}`; };
  const passDay = pd=>{ const d = new Date(pd + "T00:00:00"); return `${DAY_NAMES[d.getDay()].toLowerCase()} ${d.getDate()}/${d.getMonth()+1}`; };
  const [cq, rq] = await Promise.all([
    db.from("booking_log").select("created_at,pass_date,pass_name,profile_name").eq("stable_id", schedCtx.stable.id).gte("pass_date", startISO).lte("pass_date", endISO),
    db.from("pass_request").select("type,status,created_at,resolved_at,booking(pass_date,pass_def(name)),fromP:profile!pass_request_from_profile_fkey(name),toP:profile!pass_request_to_profile_fkey(name)").eq("stable_id", schedCtx.stable.id)
  ]);
  if(rq.error){ lb.innerHTML = msg("Kunde inte hämta loggen.", "err"); return; }
  const ev = [];
  if(!cq.error) (cq.data||[]).forEach(c=>{
    ev.push({ t: c.created_at, txt: `<b>${esc(c.profile_name||"?")}</b> tog bort sitt pass ${esc(c.pass_name||"")} ${passDay(c.pass_date)}` });
  });
  (rq.data||[]).forEach(q=>{
    const bk = q.booking || {};
    if(!bk.pass_date || bk.pass_date < startISO || bk.pass_date > endISO) return;
    const pn = esc((bk.pass_def && bk.pass_def.name) || "pass");
    const day = passDay(bk.pass_date);
    const A = esc((q.fromP && q.fromP.name) || "?"), B = esc((q.toP && q.toP.name) || "?");
    ev.push({ t: q.created_at, txt: q.type === "take"
      ? `<b>${A}</b> frågade <b>${B}</b> om att ta över ${pn} ${day}`
      : `<b>${A}</b> erbjöd <b>${B}</b> sitt pass ${pn} ${day}` });
    if(q.status !== "pending" && q.resolved_at){
      const okd = q.status === "accepted";
      ev.push({ t: q.resolved_at, txt: q.type === "take"
        ? (okd ? `<b>${B}</b> godkände — <b>${A}</b> tog över ${pn} ${day}` : `<b>${B}</b> avböjde förfrågan om ${pn} ${day}`)
        : (okd ? `<b>${B}</b> tog emot ${pn} ${day} av <b>${A}</b>` : `<b>${B}</b> avböjde att ta ${pn} ${day}`) });
    }
  });
  ev.sort((a,c)=> new Date(c.t) - new Date(a.t));
  lb.innerHTML = ev.length
    ? ev.map(e=> `<div class="logrow"><span class="logtime">${fmt(e.t)}</span><span>${e.txt}</span></div>`).join("")
    : `<div class="empty">Inga byten eller borttagna pass den här veckan än.</div>`;
}

function scheduleCell(p, d, dISO, map, myIds, tISO){
  if(!passApplies(p, d)) return `<div class="scell na">·</div>`;
  const list = map[p.id+"|"+dISO] || [];
  const cap = p.capacity || 1;
  const full = list.length >= cap;
  const isPast = dISO < tISO;
  const mineHere = list.some(bk=> myIds.has(bk.profile_id));
  const canBook = schedCtx.actingProfileId && !full && !isPast;
  const chips = list.map(bk=>{
    const mine = myIds.has(bk.profile_id);
    const canReq = !isPast && schedCtx.actingProfileId;
    const reqAttrs = canReq ? ` data-req="${bk.id}|${bk.profile_id}|${mine?1:0}" data-pinfo="${esc(p.name)}|${dISO}"` : "";
    const canRemove = (mine || curAdmin) && !isPast;
    const who = (bk.profile && bk.profile.name) || "?";
    return `<span class="schip${canReq?" clickable":""}"${reqAttrs} style="${profChipStyle(bk.profile_id)}" title="${canReq?(mine?"Ge bort passet":"Fråga om att ta över"):""}"><span class="cn">${esc(who)}</span>${canRemove?`<button class="x2" data-cancel="${bk.id}" data-cinfo="${esc(p.name)}|${dISO}" data-cprof="${esc(who)}" data-cmine="${mine?1:0}" title="${mine?"Avboka":"Ta bort "+esc(who)+" från passet"}">✕</button>`:""}</span>`;
  }).join("");
  const empty = (!list.length && !canBook) ? `<span class="sempty">–</span>` : "";
  const badge = cap>1 ? `<span class="scap ${full?"ok":"need"}">${list.length}/${cap}</span>` : "";
  const btn = canBook ? `<button class="sbook" data-book="${p.id}" data-date="${dISO}" title="Ta pass">+</button>` : "";
  const hu = (schedCtx.catTint || {})[p.category_id];
  let cellStyle = "";
  if(hu != null){
    cellStyle = `background:hsla(${hu},45%,45%,.08)`;
    if(!mineHere) cellStyle += `;border-color:hsla(${hu},35%,42%,.45)`;
    cellStyle = ` style="${cellStyle}"`;
  }
  return `<div class="scell${mineHere?" mine":""}${isPast?" past":""}"${cellStyle}>
      ${badge?`<div class="scaprow">${badge}</div>`:""}
      <div class="schips">${chips}${empty}</div>
      ${btn}
    </div>`;
}

async function bookCell(passId, dISO){
  const pid = schedCtx.actingProfileId; if(!pid) return;
  const pass = schedCtx.passes.find(x=>x.id===passId);
  const d = new Date(dISO + "T00:00:00");
  const label = `${(pass && pass.name) || "passet"}, ${DAY_NAMES[d.getDay()].toLowerCase()} ${d.getDate()}/${d.getMonth()+1}`;
  let asked = false;
  // Är det min grupps jourvecka? Annars: fråga innan bokning.
  const duty = dutyGroupForWeek(weekStart2, schedCtx.groups, schedCtx.stable.rotation_offset);
  if(duty){
    const prof = (schedCtx.profiles||[]).find(x=> x.id === pid);
    const myGroups = new Set(((prof && prof.horse) || []).map(h=> h.group_id).filter(Boolean));
    if(!myGroups.has(duty.id)){
      const ok = await confirmDialog(
        `Det är inte din grupp som har jouren den här veckan — vecka ${isoWeekNumber(weekStart2)} är det ${duty.name}. Vill du ta passet ${label} ändå?`,
        { title: "Inte din jourvecka", okText: "Ja, ta passet", primary: true });
      if(!ok) return;
      asked = true;   // en fråga räcker
    }
  }
  if(!asked){
    const who = (schedCtx.myProfiles||[]).length > 1
      ? ` som ${((schedCtx.profiles||[]).find(x=> x.id === pid)||{}).name || ""}` : "";
    const ok = await confirmDialog(`Vill du ta passet ${label}${who}?`, { title: "Ta pass", okText: "Ja, ta passet", primary: true });
    if(!ok) return;
  }
  const cap = pass ? (pass.capacity||1) : 1;
  const cur = await db.from("booking").select("id").eq("pass_id", passId).eq("pass_date", dISO);
  if(!cur.error && cur.data.length >= cap){ await drawGrid(); return; }
  const r = await db.from("booking").insert({ stable_id: schedCtx.stable.id, pass_id: passId, pass_date: dISO, profile_id: pid, booked_by: session.id });
  if(r.error){ alert("Kunde inte boka: " + r.error.message); return; }
  await drawGrid(true);
}
async function cancelBooking(id, info, profName, mine){
  if(mine === undefined) mine = true;
  let txt = mine ? "Är du säker på att du vill ta bort ditt pass?"
                 : `Vill du ta bort ${profName || "personen"} från passet?`;
  let pn = "", pd = "";
  if(info){
    const j = info.lastIndexOf("|");
    pn = info.slice(0, j); pd = info.slice(j+1);
    const d = new Date(pd + "T00:00:00");
    const when = `${pn}, ${DAY_NAMES[d.getDay()].toLowerCase()} ${d.getDate()}/${d.getMonth()+1}`;
    txt = mine
      ? `Är du säker på att du vill ta bort ditt pass ${when}?`
      : `Vill du ta bort ${profName || "personen"} från passet ${when}? Personen får inget meddelande — säg gärna till själv.`;
  }
  if(!(await confirmDialog(txt, { title: mine ? "Ta bort pass" : "Ta bort från pass", okText: "Ja, ta bort" }))) return;
  const r = await db.from("booking").delete().eq("id", id);
  if(r.error){ alert("Kunde inte avboka: " + r.error.message); return; }
  logCancel(pn, pd, profName);
  await drawGrid(true);
}
function logCancel(passName, passDate, profileName){
  if(!passName || !passDate || !schedCtx) return;
  db.from("booking_log").insert({ stable_id: schedCtx.stable.id, pass_date: passDate, pass_name: passName, profile_name: profileName || "?" })
    .then(()=>{}, ()=>{});   // loggen är "best effort" – stör aldrig avbokningen
}

/* ---- Rättvis fördelning: måltal per profil, viktat efter hästar ---- */
// Totalt antal platser per kategori under veckan som börjar på "monday".
function categoryTotals(monday){
  const days = []; for(let i=0;i<7;i++){ const d=new Date(monday); d.setDate(d.getDate()+i); days.push(d); }
  const totals = {};
  schedCtx.passes.forEach(p=>{
    let applicableDays = 0;
    days.forEach(d=>{ if(passApplies(p, d)) applicableDays++; });
    const platser = applicableDays * (p.capacity || 1);
    if(platser === 0) return;
    const key = p.category_id || "none";
    const name = (p.category && p.category.name) || "Övrigt";
    if(!totals[key]) totals[key] = { name, total:0 };
    totals[key].total += platser;
  });
  return totals;
}

// Vilken gång i ordningen har gruppen jobbat (0, 1, 2 …) – styr rotationen av extrapass.
function groupTurnNumber(monday){
  const n = schedCtx.groups.length; if(!n) return 0;
  return Math.floor((weekIndexOf(monday) + (schedCtx.stable.rotation_offset||0)) / n);
}

function computeTargets(monday){
  const duty = dutyGroupForWeek(monday, schedCtx.groups, schedCtx.stable.rotation_offset);
  if(!duty) return null;
  // Hästar i den ansvariga gruppen (en häst = en enhet), stabil ordning.
  const horses = [];
  (schedCtx.profiles||[]).forEach(pr=>{
    (pr.horse||[]).forEach(h=>{ if(h.group_id === duty.id) horses.push({ id:h.id, profileId:pr.id, profileName:pr.name }); });
  });
  horses.sort((a,b)=> a.id < b.id ? -1 : (a.id > b.id ? 1 : 0));
  const nH = horses.length;
  const turn = groupTurnNumber(monday);
  const cats = categoryTotals(monday);

  const perProfile = {};
  horses.forEach(h=>{ if(!perProfile[h.profileId]) perProfile[h.profileId] = { name:h.profileName, byCat:{} }; });

  if(nH > 0){
    Object.keys(cats).forEach(catKey=>{
      const total = cats[catKey].total;
      const base = Math.floor(total / nH);
      const rem  = total % nH;
      // extrapassen går till "rem" hästar, med startpunkt som roterar per gruppens tur
      const start = rem > 0 ? (((turn * rem) % nH) + nH) % nH : 0;
      const extra = new Set();
      for(let k=0;k<rem;k++) extra.add((start + k) % nH);
      horses.forEach((h, idx)=>{
        const t = base + (extra.has(idx) ? 1 : 0);
        const pc = perProfile[h.profileId].byCat;
        if(!pc[catKey]) pc[catKey] = { name:cats[catKey].name, target:0, actual:0 };
        pc[catKey].target += t;
      });
    });
  }
  return { duty, perProfile, cats };
}

function renderStats(tgt, myIds){
  if(!tgt) return "";
  const pids = Object.keys(tgt.perProfile);
  if(!pids.length) return `<div class="card"><p class="sub" style="margin:0">Inga hästar i ${esc(tgt.duty.name)} den här veckan.</p></div>`;
  const catKeys = Object.keys(tgt.cats).filter(k=> tgt.cats[k].total > 0);
  const rows = pids.map(pid=>{
    const pr = tgt.perProfile[pid];
    const mine = myIds.has(pid);
    const chips = catKeys.map(k=>{
      const c = pr.byCat[k] || { name:tgt.cats[k].name, target:0, actual:0 };
      const done = c.target > 0 && c.actual >= c.target;
      const hu = (schedCtx.catTint || {})[k];
      const ts = (!done && hu != null) ? ` style="background:hsla(${hu},45%,45%,.12)"` : "";
      return `<span class="statcat ${done?"done":""}"${ts}>${esc(c.name)} ${c.actual}/${c.target}</span>`;
    }).join("");
    return `<div class="statrow${mine?" me":""}"><span class="sn">${esc(pr.name)}</span>${chips}</div>`;
  }).join("");
  return `<div class="card">
    <p class="sub" style="margin:0 0 8px">Måltal denna vecka <span class="sectionhint">— ${esc(tgt.duty.name)}, viktat efter hästar</span></p>
    <div class="statwrap">${rows}</div></div>`;
}

/* ============ Toppknappar: Profil, Inställningar, Tema ============ */
let theme = (()=>{ try{ return localStorage.getItem("stalljour.theme")||"light"; }catch(e){ return "light"; } })();
function applyTheme(t){
  document.documentElement.setAttribute("data-theme", t==="dark" ? "dark" : "light");
  const b = el("btnTheme"); if(b) b.innerHTML = ic(t==="dark" ? "sun" : "moon");
}
applyTheme(theme);
el("btnTheme").onclick = ()=>{ theme = theme==="dark"?"light":"dark"; try{ localStorage.setItem("stalljour.theme", theme); }catch(e){} applyTheme(theme); };

function updateHeader(){
  ["btnProfile","btnSchedule","btnSettings","btnBell","btnChat","btnMine","btnBurger"].forEach(id=>{
    const b = el(id); if(b) b.style.display = session ? "" : "none";
  });
}

function closeMenus(){ ["profileMenu","scheduleMenu","settingsMenu","chatMenu","mineMenu","bellMenu","burgerMenu"].forEach(id=>{ const m=el(id); if(m) m.classList.remove("open"); }); }
function closeProfileMenu(){ closeMenus(); }

let pmState = null;   // utfällnings-läge för profil-menyn
function resetPmState(){ pmState = { stablesOpen:false, stables:null, openStableId:null, profilesOpen:false, myProfiles:null }; }

let pmTargetId = "profileMenu";   // var profil-menyn ritas (egen dropdown eller inuti hamburgaren)
function buildProfileMenu(){
  const m = el(pmTargetId);
  if(!m) return;
  let bookAs = "";
  if(view.name === "schedule" && schedCtx && schedCtx.myProfiles.length){
    bookAs = `<div class="menuhead sub">Bokar som</div>` + schedCtx.myProfiles.map(p=>
      `<button class="menuitem" data-bookas="${p.id}">${p.id===schedCtx.actingProfileId?"✓ ":""}${esc(p.name)}</button>`).join("");
  }
  // Mina stall (nivå 1) -> stall (nivå 2) -> Mina profiler (nivå 3) -> profilnamn
  let tree = `<button class="menuitem" data-pm="stables">${ic("home")} Mina stall <span class="caret">${pmState.stablesOpen?"▾":"▸"}</span></button>`;
  if(pmState.stablesOpen){
    if(!pmState.stables) tree += `<div class="menuhead sub">Laddar…</div>`;
    else if(!pmState.stables.length) tree += `<div class="menuhead sub">Inga stall än</div>`;
    else pmState.stables.forEach(s=>{
      const open = pmState.openStableId === s.id;
      tree += `<button class="menuitem sub1" data-pmstable="${s.id}">${esc(unitLabel(s))} <span class="caret">${open?"▾":"▸"}</span></button>`;
      if(open){
        tree += `<button class="menuitem sub2" data-pm="profiles">${ic("users")} Mina profiler <span class="caret">${pmState.profilesOpen?"▾":"▸"}</span></button>`;
        if(pmState.profilesOpen){
          if(!pmState.myProfiles) tree += `<div class="menuhead sub">Laddar…</div>`;
          else if(!pmState.myProfiles.length) tree += `<div class="pmleaf muted">Inga profiler kopplade till din mejl</div>`;
          else pmState.myProfiles.forEach(p=> tree += `<button class="menuitem" style="padding-left:48px" data-pmgoto="${p.id}">${esc(p.name)} <span class="caret">›</span></button>`);
        }
      }
    });
  }
  m.innerHTML = `
    <div class="menuhead">${esc(session.email)}</div>
    ${bookAs}
    <button class="menuitem" data-act="requests">${ic("swap")} Mina förfrågningar</button>
    ${tree}
    <button class="menuitem" data-act="newstable">${ic("plus")} Nytt stall</button>
    <button class="menuitem" data-act="invite">${ic("mail")} Bjud in till stallet</button>
    <button class="menuitem" data-act="chmail">${ic("pencil")} Byt mejladress</button>
    ${iAmAdminSomewhere ? `<button class="menuitem" data-act="viewas">${ic("user")} Visa som …</button>` : ""}
    <button class="menuitem" data-act="logout">${ic("logout")} Logga ut</button>`;
  m.querySelectorAll("[data-act]").forEach(b=> b.onclick = ()=> profileAction(b.getAttribute("data-act")));
  m.querySelectorAll("[data-bookas]").forEach(b=> b.onclick = ()=>{
    schedCtx.actingProfileId = b.getAttribute("data-bookas");
    closeProfileMenu();
    drawGrid(true);
  });
  m.querySelectorAll("[data-pm]").forEach(b=> b.onclick = (e)=>{
    e.stopPropagation();
    const k = b.getAttribute("data-pm");
    if(k === "stables"){
      pmState.stablesOpen = !pmState.stablesOpen;
      if(pmState.stablesOpen && !pmState.stables){
        loadMyStables().then(s=>{ pmState.stables = s.filter(u=> u.id); buildProfileMenu(); }).catch(()=>{ pmState.stables = []; buildProfileMenu(); });
      }
    }
    if(k === "profiles"){
      pmState.profilesOpen = !pmState.profilesOpen;
      if(pmState.profilesOpen && !pmState.myProfiles){
        db.from("profile_member").select("profile(id,name,stable_id)").eq("email", session.email).then(r=>{
          pmState.myProfiles = (r.data||[]).map(x=>x.profile).filter(p=> p && p.stable_id === pmState.openStableId);
          buildProfileMenu();
        });
      }
    }
    buildProfileMenu();
  });
  m.querySelectorAll("[data-pmstable]").forEach(b=> b.onclick = (e)=>{
    e.stopPropagation();
    const id = b.getAttribute("data-pmstable");
    pmState.openStableId = pmState.openStableId === id ? null : id;
    pmState.profilesOpen = false; pmState.myProfiles = null;
    buildProfileMenu();
  });
  m.querySelectorAll("[data-pmgoto]").forEach(b=> b.onclick = (e)=>{
    e.stopPropagation();
    focusProfileId = b.getAttribute("data-pmgoto");
    const sid = pmState.openStableId;
    closeMenus();
    view = { name:"stable", stableId: sid };
    render();
  });
}
async function profileAction(act){
  closeProfileMenu();
  if(act==="requests"){ gotoView("requests"); return; }
  if(act==="newstable"){ createOrgDialog(); return; }
  if(act==="invite"){ inviteDialog(); return; }
  if(act==="chmail"){ changeEmailDialog(); return; }
  if(act==="viewas"){ if(await refreshAdminFlag()) viewAsDialog(); return; }
  if(act==="logout"){
    if(!(await confirmDialog("Vill du logga ut? Du behöver en ny inloggningslänk via mejl för att logga in igen.", { title:"Logga ut", okText:"Ja, logga ut", primary:true }))) return;
    await db.auth.signOut(); view = { name:"home", stableId:null }; return;
  }
}
el("btnProfile").onclick = (e)=>{
  e.stopPropagation();
  const m = el("profileMenu");
  const wasOpen = m.classList.contains("open");
  closeMenus();
  if(!wasOpen){ resetPmState(); pmTargetId = "profileMenu"; buildProfileMenu(); m.classList.add("open"); }
};

/* ---- Hamburgermeny (mobil): nav + profil i ett ---- */
function openBurgerMenu(){
  const m = el("burgerMenu");
  m.innerHTML = `
    <button class="menuitem" data-bg="schedule">${ic("calendar")} Schema</button>
    <button class="menuitem" data-bg="mine">${ic("list")} Mina pass</button>
    <button class="menuitem" data-bg="chat">${ic("message")} Chatt</button>
    <button class="menuitem" data-bg="stable">${ic("settings")} Inställningar</button>
    <button class="menuitem" data-bg="theme">${ic(theme==="dark"?"sun":"moon")} ${theme==="dark"?"Ljust läge":"Mörkt läge"}</button>
    <div id="burgerProfile" style="border-top:1px solid var(--line);margin-top:4px;padding-top:2px"></div>`;
  m.querySelectorAll("[data-bg]").forEach(b=> b.onclick = (e)=>{
    e.stopPropagation();
    const k = b.getAttribute("data-bg");
    if(k === "theme"){ theme = theme==="dark"?"light":"dark"; try{ localStorage.setItem("stalljour.theme", theme); }catch(err){} applyTheme(theme); openBurgerMenu(); return; }
    closeMenus(); openStablePick("burgerMenu", k);
  });
  resetPmState(); pmTargetId = "burgerProfile"; buildProfileMenu();
  m.classList.add("open");
}
el("btnBurger").onclick = (e)=>{
  e.stopPropagation();
  const m = el("burgerMenu");
  const wasOpen = m.classList.contains("open");
  closeMenus();
  if(!wasOpen) openBurgerMenu();
};
document.querySelector("header.app .logo").onclick = ()=>{
  if(!session) return;
  didAutoRoute = true;   // stanna på Mina stall, hoppa inte vidare
  view = { name:"home", stableId:null };
  render();
};
document.addEventListener("click", (e)=>{ if(!e.target.closest(".menuwrap")) closeMenus(); });

// Stallväljare i dropdown: ett stall → gå direkt; flera → "Välj stall" och sedan vald vy
async function openStablePick(menuId, name){
  const m = el(menuId);
  m.innerHTML = `<div class="menuhead sub">Laddar…</div>`;
  m.classList.add("open");
  try{
    const stables = (await loadMyStables()).filter(u=> u.id);
    if(stables.length <= 1){
      closeMenus();
      if(stables.length === 1){
        if(name==="schedule") weekStart2 = startOfWeek(new Date());
        view = { name, stableId: stables[0].id }; render();
      } else { view = { name:"home", stableId:null }; render(); }
      return;
    }
    m.innerHTML = `<div class="menuhead">Välj stall</div>` + stables.map(s=>
      `<button class="menuitem" data-pick="${s.id}">${view.stableId===s.id?"✓ ":""}${esc(unitLabel(s))}</button>`).join("");
    m.querySelectorAll("[data-pick]").forEach(b=> b.onclick = (e)=>{
      e.stopPropagation();
      closeMenus();
      if(name==="schedule") weekStart2 = startOfWeek(new Date());
      view = { name, stableId: b.getAttribute("data-pick") };
      render();
    });
  }catch(e){ m.innerHTML = `<div class="menuhead sub">Kunde inte hämta stall</div>`; }
}

async function gotoView(name, menuId){
  closeProfileMenu();
  if(!session) return;
  if(name==="schedule") weekStart2 = startOfWeek(new Date());
  if(view.stableId){ view = { name, stableId: view.stableId }; render(); return; }
  if(menuId){ openStablePick(menuId, name); return; }
  try{
    const stables = (await loadMyStables()).filter(u=> u.id);
    if(stables.length === 1){ view = { name, stableId: stables[0].id }; }
    else { view = { name:"home", stableId:null }; }
    render();
  }catch(e){ view = { name:"home", stableId:null }; render(); }
}
function navBtn(btnId, menuId, name){
  el(btnId).onclick = (e)=>{
    e.stopPropagation();
    const m = el(menuId);
    const wasOpen = m.classList.contains("open");
    closeMenus();
    if(!wasOpen) openStablePick(menuId, name);   // alltid väljare vid flera stall, precis som Schema
  };
}
navBtn("btnSettings", "settingsMenu", "stable");
navBtn("btnChat", "chatMenu", "chat");
navBtn("btnMine", "mineMenu", "mine");

el("btnSchedule").onclick = (e)=>{
  e.stopPropagation();
  const m = el("scheduleMenu");
  const wasOpen = m.classList.contains("open");
  closeMenus();
  if(!wasOpen) openStablePick("scheduleMenu", "schedule");
};

/* ============ Notiser & byt pass ============ */
let myProfileIds = new Set();   // alla profil-id kopplade till min mejl

async function refreshMyProfiles(){
  if(!session){ myProfileIds = new Set(); return; }
  const r = await db.from("profile_member").select("profile_id").eq("email", session.email);
  if(!r.error) myProfileIds = new Set((r.data||[]).map(x=> x.profile_id));
}

/* Passbyten i klockan: förfrågningar till mig, och byten som väntar på mitt
   godkännande (RLS gör att jag bara ser andras byten om jag är chef/admin) */
const SWAP_SEL = "id,asked_by,status,chef_status,work_date,note,rs_task(name),stable(name)"
  + ",giver:rs_staff!rs_task_swap_giver_staff_fkey(name,rs_staff_member(email))"
  + ",taker:rs_staff!rs_task_swap_taker_staff_fkey(name,rs_staff_member(email))";
function swEmails(o){ return (((o||{}).rs_staff_member)||[]).map(m=> (m.email||"").toLowerCase()); }
function swapBellRelevant(s){
  const recip = s.asked_by === "giver" ? s.taker : s.giver;
  if(s.status === "pending") return swEmails(recip).includes(session.email);
  if(s.status === "accepted" && s.chef_status === "pending")
    return !swEmails(s.giver).concat(swEmails(s.taker)).includes(session.email);
  return false;
}
function bellRelevant(x){
  const incoming = x.status === "pending" && myProfileIds.has(x.to_profile);
  const outcome  = (x.status === "accepted" || x.status === "declined")
                   && myProfileIds.has(x.from_profile) && !x.seen_by_requester;
  return incoming || outcome;
}
async function refreshBellCount(){
  const b = el("bellBadge"); if(!b) return;
  if(!session){ b.style.display = "none"; return; }
  if(!myProfileIds.size) await refreshMyProfiles();
  const r = await db.from("pass_request").select("id,to_profile,from_profile,status,seen_by_requester");
  let n = r.error ? 0 : (r.data||[]).filter(bellRelevant).length;
  const iv = await db.from("invite").select("id").eq("email", session.email).eq("status","pending");
  if(!iv.error) n += (iv.data||[]).length;
  const tn = await db.from("task_notice").select("id").eq("email", session.email).eq("seen", false);
  if(!tn.error) n += (tn.data||[]).length;
  const lv = await db.from("rs_leave").select("id,rs_staff(rs_staff_member(email))").eq("status","pending");
  if(!lv.error) n += (lv.data||[]).filter(x=> !(((x.rs_staff||{}).rs_staff_member)||[]).some(m=> (m.email||"").toLowerCase() === session.email)).length;
  const sw = await db.from("rs_task_swap").select(SWAP_SEL).neq("status","declined");
  if(!sw.error) n += (sw.data||[]).filter(swapBellRelevant).length;
  try{ dueReminders = await getDueReminders(); n += dueReminders.length; }catch(e){}
  if(n > 0){ b.textContent = n; b.style.display = ""; } else b.style.display = "none";
}
setInterval(()=>{ if(session) refreshBellCount(); }, 60000);

async function openBellMenu(){
  const m = el("bellMenu");
  m.innerHTML = `<div class="menuhead sub">Laddar…</div>`;
  m.classList.add("open");
  await refreshMyProfiles();
  const r = await db.from("pass_request")
    .select("id,type,status,seen_by_requester,to_profile,from_profile,booking(pass_date,pass_def(name)),fromP:profile!pass_request_from_profile_fkey(name),toP:profile!pass_request_to_profile_fkey(name)")
    .order("created_at",{ascending:false});
  if(r.error){ m.innerHTML = `<div class="menuhead sub">Kunde inte hämta notiser</div>`; return; }
  const mine = (r.data||[]).filter(bellRelevant);
  let rems = [];
  try{ rems = await getDueReminders(); }catch(e){}
  const iq = await db.from("invite").select("id,invited_by,kind,staff_perm,invite_name,stable(name),profile(name)").eq("email", session.email).eq("status","pending");
  const invs = iq.error ? [] : (iq.data||[]);
  const tq = await db.from("task_notice").select("id,kind,task_name,stable(name)").eq("email", session.email).eq("seen", false).order("created_at",{ascending:false});
  const tns = tq.error ? [] : (tq.data||[]);
  const lq = await db.from("rs_leave").select("id,kind,start_date,end_date,note,rs_staff(name,rs_staff_member(email)),stable(name)").eq("status","pending").order("created_at",{ascending:false});
  const leaves = (lq.error ? [] : (lq.data||[])).filter(x=> !(((x.rs_staff||{}).rs_staff_member)||[]).some(mm=> (mm.email||"").toLowerCase() === session.email));
  const swq = await db.from("rs_task_swap").select(SWAP_SEL).neq("status","declined").order("created_at",{ascending:false});
  const swaps = (swq.error ? [] : (swq.data||[])).filter(swapBellRelevant);
  if(!mine.length && !rems.length && !invs.length && !tns.length && !leaves.length && !swaps.length){ m.innerHTML = `<div class="menuhead sub">Inga nya notiser</div>`; return; }
  const swHtml = swaps.map(s=>{
    const g = (s.giver && s.giver.name) || "?", t = (s.taker && s.taker.name) || "?";
    const d = new Date(s.work_date + "T00:00:00");
    const when = `${((s.rs_task && s.rs_task.name) || "arbetspass")} ${d.getDate()}/${d.getMonth()+1}`;
    const meta = `<div class="meta2">${esc(when)}${s.note?` · ${esc(s.note)}`:""}</div>
      <div class="meta2">${esc((s.stable && s.stable.name) || "")}</div>`;
    if(s.status === "pending"){
      const txt = s.asked_by === "giver"
        ? `🔁 <b>${esc(g)}</b> erbjuder dig sitt arbetspass`
        : `🔁 <b>${esc(t)}</b> vill ta över ditt arbetspass`;
      return `<div class="notif"><div>${txt}</div>${meta}
        <div class="notifbtns"><button class="btn primary sm" data-swacc="${s.id}">${s.asked_by === "giver" ? "Ta över" : "Ja, byt"}</button><button class="btn sm" data-swdec="${s.id}">Avböj</button></div></div>`;
    }
    return `<div class="notif"><div>🔁 Passbyte att godkänna: <b>${esc(g)}</b> → <b>${esc(t)}</b></div>${meta}
      <div class="notifbtns"><button class="btn primary sm" data-swok="${s.id}">Godkänn</button><button class="btn sm" data-swno="${s.id}">Neka</button></div></div>`;
  }).join("");
  const lvHtml = leaves.map(x=>{
    const sd = new Date(x.start_date+"T00:00:00"), ed = new Date(x.end_date+"T00:00:00");
    return `<div class="notif"><div>📅 <b>${esc((x.rs_staff&&x.rs_staff.name)||"Personal")}</b> ansöker om ${esc(x.kind)} ${sd.getDate()}/${sd.getMonth()+1}–${ed.getDate()}/${ed.getMonth()+1}</div>
      ${x.note?`<div class="meta2">${esc(x.note)}</div>`:""}
      <div class="meta2">${esc((x.stable&&x.stable.name)||"")}</div>
      <div class="notifbtns"><button class="btn primary sm" data-lvacc="${x.id}">Bevilja</button><button class="btn sm" data-lvdec="${x.id}">Avslå</button></div></div>`;
  }).join("");
  const tnHtml = tns.map(v=>{
    const pfx = v.kind === "added" ? "🕐 Du har satts på arbetspasset"
      : v.kind === "removed" ? "🕐 Du har tagits bort från arbetspasset"
      : v.kind === "sick" ? "🤒 Sjukanmälan:"
      : v.kind === "sick_removed" ? "🙂 Sjukanmälan borttagen:"
      : v.kind === "inv_accepted" ? "✅ Inbjudan accepterad:"
      : v.kind === "inv_declined" ? "❌ Inbjudan avböjd:"
      : v.kind === "leave_approved" ? "✅ Ledighet beviljad:"
      : v.kind === "leave_denied" ? "❌ Ledighet avslagen:"
      : v.kind === "swap_declined" ? "❌ Passbytet avböjdes:"
      : v.kind === "swap_wait" ? "🔁 Kollegan tackade ja — väntar på godkännande:"
      : v.kind === "swap_approved" ? "✅ Passbytet är godkänt:"
      : v.kind === "swap_denied" ? "❌ Passbytet nekades:" : "🕐";
    return `<div class="notif"><div>${pfx} <b>${esc(v.task_name)}</b></div>
      <div class="meta2">${esc((v.stable&&v.stable.name)||"")}</div>
      <div class="notifbtns"><button class="btn sm" data-tnok="${v.id}">Ok</button></div></div>`;
  }).join("");
  const invHtml = lvHtml + swHtml + tnHtml + invs.map(v=>
    `<div class="notif"><div>📩 <b>${esc(v.invited_by)}</b> har bjudit in dig till stallet <b>${esc((v.stable&&v.stable.name)||"?")}</b></div>
      <div class="meta2">Som ${esc(inviteRoleLabel(v))}</div>
      <div class="notifbtns"><button class="btn primary sm" data-invacc="${v.id}">Acceptera</button><button class="btn sm" data-invdec="${v.id}">Avböj</button></div></div>`).join("");
  const remHtml = invHtml + rems.map(rm=>
    `<div class="notif"><div>⏰ Påminnelse: du har pass <b>${esc(rm.passName)}</b></div><div class="meta2">${esc(remWhen(rm.start))}</div>
      <div class="notifbtns"><button class="btn sm" data-remok="${esc(rm.key)}">Ok</button></div></div>`).join("");
  m.innerHTML = remHtml + mine.map(q=>{
    const bk = q.booking || {};
    const pn = (bk.pass_def && bk.pass_def.name) || "pass";
    const d = bk.pass_date ? new Date(bk.pass_date + "T00:00:00") : null;
    const when = d ? `v.${isoWeekNumber(d)} · ${DAY_NAMES[d.getDay()]} ${d.getDate()}/${d.getMonth()+1}` : "";
    if(q.status === "pending"){
      const who = (q.fromP && q.fromP.name) || "Någon";
      const txt = q.type === "take"
        ? `<b>${esc(who)}</b> vill ta över ditt pass`
        : `<b>${esc(who)}</b> vill ge dig sitt pass`;
      return `<div class="notif"><div>${txt}</div><div class="meta2">${esc(pn)} · ${esc(when)}</div>
        <div class="notifbtns"><button class="btn primary sm" data-acc="${q.id}">Bekräfta</button><button class="btn sm" data-dec="${q.id}">Avböj</button></div></div>`;
    }
    // svar på min egen förfrågan
    const who = (q.toP && q.toP.name) || "Profilen";
    const yes = q.status === "accepted";
    const txt = q.type === "take"
      ? (yes ? `<b>${esc(who)}</b> godkände din förfrågan — passet är nu ditt ✓` : `<b>${esc(who)}</b> avböjde din förfrågan om att ta över passet`)
      : (yes ? `<b>${esc(who)}</b> tog emot ditt pass ✓` : `<b>${esc(who)}</b> avböjde att ta ditt pass`);
    return `<div class="notif"><div>${txt}</div><div class="meta2">${esc(pn)} · ${esc(when)}</div>
      <div class="notifbtns"><button class="btn sm" data-seen="${q.id}">Ok</button></div></div>`;
  }).join("");
  m.querySelectorAll("[data-acc]").forEach(b=> b.onclick = (e)=>{ e.stopPropagation(); resolveRequest(b.getAttribute("data-acc"), true); });
  m.querySelectorAll("[data-dec]").forEach(b=> b.onclick = (e)=>{ e.stopPropagation(); resolveRequest(b.getAttribute("data-dec"), false); });
  m.querySelectorAll("[data-seen]").forEach(b=> b.onclick = async (e)=>{
    e.stopPropagation();
    await db.rpc("mark_request_seen", { p_request: b.getAttribute("data-seen") });
    await refreshBellCount();
    openBellMenu();
  });
  m.querySelectorAll("[data-remok]").forEach(b=> b.onclick = async (e)=>{
    e.stopPropagation();
    try{ localStorage.setItem(b.getAttribute("data-remok"), "1"); }catch(err){}
    await refreshBellCount();
    openBellMenu();
  });
  m.querySelectorAll("[data-invacc]").forEach(b=> b.onclick = (e)=>{ e.stopPropagation(); const id=b.getAttribute("data-invacc"); resolveInvite(id, true, invs.find(v=> v.id===id)); });
  m.querySelectorAll("[data-invdec]").forEach(b=> b.onclick = (e)=>{ e.stopPropagation(); resolveInvite(b.getAttribute("data-invdec"), false); });
  m.querySelectorAll("[data-tnok]").forEach(b=> b.onclick = async (e)=>{
    e.stopPropagation();
    await db.from("task_notice").update({ seen: true }).eq("id", b.getAttribute("data-tnok"));
    await refreshBellCount();
    openBellMenu();
  });
  m.querySelectorAll("[data-lvacc]").forEach(b=> b.onclick = (e)=>{ e.stopPropagation(); resolveLeave(b.getAttribute("data-lvacc"), true); });
  m.querySelectorAll("[data-lvdec]").forEach(b=> b.onclick = (e)=>{ e.stopPropagation(); resolveLeave(b.getAttribute("data-lvdec"), false); });
  bindSwapButtons(m, ()=>{
    openBellMenu();
    if(view.name === "schedule" || view.name === "mine" || view.name === "requests") render();
  });
}
function namePromptDialog(){
  return new Promise(res=>{
    const ov = document.createElement("div"); ov.className = "modal-ov";
    ov.innerHTML = `<div class="modal"><h3>Vad heter du?</h3>
      <p>Ditt namn visas i stallets listor och scheman.</p>
      <div class="field"><input type="text" id="npName" placeholder="För- och efternamn" maxlength="60"></div>
      <div class="modal-btns"><button class="btn" id="npCancel">Avbryt</button><button class="btn primary" id="npOk">Klar</button></div></div>`;
    document.body.appendChild(ov);
    const done = v=>{ ov.remove(); res(v); };
    ov.querySelector("#npCancel").onclick = ()=> done(null);
    ov.querySelector("#npOk").onclick = ()=>{ const v=(el("npName").value||"").trim(); if(!v){ el("npName").focus(); return; } done(v); };
    setTimeout(()=> el("npName").focus(), 50);
  });
}
async function resolveInvite(id, accept, inv){
  let name = null;
  if(accept && inv && inv.kind === "staff" && !((inv.invite_name||"").trim())){
    name = await namePromptDialog();
    if(name === null) return;   // avbröt — inbjudan lämnas obesvarad
  }
  const r = await db.rpc("respond_invite", { p_invite: id, p_accept: accept, p_name: name });
  if(r.error){ alert("Kunde inte svara på inbjudan: " + r.error.message); return; }
  await refreshBellCount();
  if(el("bellMenu").classList.contains("open")) await openBellMenu();
  if(view.name === "home") render();   // stallistan kan ha ändrats
}
/* Byt mejladress: bekräftas via mejl till båda adresserna; vid första inloggningen
   med nya adressen flyttar apply_email_change alla roller/profiler/medlemskap. */
async function changeEmailDialog(){
  closeProfileMenu();
  if(!session) return;
  const ov = document.createElement("div"); ov.className = "modal-ov";
  ov.innerHTML = `<div class="modal"><h3>Byt mejladress</h3>
    <p>Nuvarande adress: <b>${esc(session.email)}</b></p>
    <div class="field"><label class="fld">Ny mejladress</label><input type="email" id="ce_mail" placeholder="ny@adress.se"></div>
    <div id="ce_msg"></div>
    <div class="modal-btns"><button class="btn" id="ce_cancel">Avbryt</button><button class="btn primary" id="ce_send">Byt adress</button></div></div>`;
  document.body.appendChild(ov);
  ov.querySelector("#ce_cancel").onclick = ()=> ov.remove();
  ov.querySelector("#ce_send").onclick = async ()=>{
    const email = normEmail(el("ce_mail").value);
    if(!email.includes("@")){ el("ce_msg").innerHTML = msg("Skriv en giltig mejladress.", "err"); return; }
    if(email === session.email){ el("ce_msg").innerHTML = msg("Det är redan din adress.", "err"); return; }
    const r1 = await db.rpc("request_email_change", { p_new: email });
    if(r1.error){ el("ce_msg").innerHTML = msg("Kunde inte förbereda bytet: " + r1.error.message + " (har db/agare-mejlbyte.sql körts?)", "err"); return; }
    const r2 = await db.auth.updateUser({ email });
    if(r2.error){ el("ce_msg").innerHTML = msg("Kunde inte starta bytet: " + r2.error.message, "err"); return; }
    ov.remove();
    infoDialog("Bekräftelsemejl har skickats till både din nuvarande och din nya adress — klicka på länken i båda. När du sedan loggar in med nya adressen flyttas alla dina roller, profiler och stall över automatiskt.", "Nästan klart");
  };
}
async function applyEmailChange(){
  try{
    const r = await db.rpc("apply_email_change");
    if(!r.error && r.data === true){ await refreshMyProfiles(); await refreshBellCount(); render(); }
  }catch(e){}
}
async function resolveLeave(id, approve){
  const r = await db.from("rs_leave").update({ status: approve ? "approved" : "denied", responded_at: new Date().toISOString(), responded_by: session.email }).eq("id", id);
  if(r.error){ alert("Kunde inte svara på ansökan: " + r.error.message); return; }
  await refreshBellCount();
  if(el("bellMenu").classList.contains("open")) await openBellMenu();
}
function inviteRoleLabel(v){
  if(v.kind === "admin") return "admin";
  if(v.kind === "staff") return v.staff_perm === "teacher" ? "ridlärare" : "stallpersonal";
  return "profilen " + ((v.profile && v.profile.name) || "?");
}
/* Bjud in via mejl: stallpersonal, ridlärare eller admin. Rollen delas ut när personen accepterar. */
async function inviteDialog(){
  closeProfileMenu();
  if(!session) return;
  const stables = (await loadMyStables()).filter(u=> u.id && u.isAdmin)
    .sort((a,b)=> (a.kind==="ridskola"?0:1) - (b.kind==="ridskola"?0:1));   // ridskolor först — de har flest roller
  if(!stables.length){ infoDialog("Bara admins kan bjuda in. Be en admin i stallet skicka inbjudan.", "Bjud in"); return; }
  const ov = document.createElement("div"); ov.className = "modal-ov";
  const stO = stables.map(s=>`<option value="${s.id}" data-kind="${s.kind}">${esc(unitLabel(s))}</option>`).join("");
  ov.innerHTML = `<div class="modal"><h3>Bjud in till stallet</h3>
    <div class="field"><label class="fld">Stall</label><select id="iv_stable">${stO}</select></div>
    <div class="field"><label class="fld">Namn</label><input type="text" id="iv_name" placeholder="Personens namn" maxlength="60"></div>
    <div class="field"><label class="fld">Mejladress</label><input type="email" id="iv_mail" placeholder="namn@exempel.se"></div>
    <div class="field"><label class="fld">Roll</label><select id="iv_role"></select>
      <div id="iv_roledesc" class="roledesc"></div></div>
    <div id="iv_hint"></div>
    <div id="iv_msg"></div>
    <div class="modal-btns"><button class="btn" id="iv_cancel">Avbryt</button><button class="btn primary" id="iv_send">Skicka inbjudan</button></div></div>`;
  document.body.appendChild(ov);
  const ROLE_DESC = {
    "staff:none": "Ser scheman och inställningar, ändrar inget",
    "staff:teacher": "Ändrar lektioner, elever och hästar",
    "admin": "Full behörighet i stallet"
  };
  const showRoleDesc = ()=>{ const rd = ov.querySelector("#iv_roledesc"); if(rd) rd.textContent = ROLE_DESC[ov.querySelector("#iv_role").value] || ""; };
  const fillRoles = ()=>{
    const opt = ov.querySelector("#iv_stable option:checked");
    const kind = opt ? opt.getAttribute("data-kind") : "stall";
    ov.querySelector("#iv_role").innerHTML = kind === "ridskola"
      ? `<option value="staff:none">Stallpersonal</option>
         <option value="staff:teacher">Ridlärare</option>
         <option value="admin">Admin</option>`
      : `<option value="admin">Admin</option>`;
    showRoleDesc();
    ov.querySelector("#iv_role").onchange = showRoleDesc;
    ov.querySelector("#iv_hint").innerHTML = kind === "ridskola"
      ? `<div class="meta2" style="margin:2px 0 10px">Letar du efter att lägga till <b>elever</b>? Det görs i inställningarna. <button class="btn sm" id="iv_open" style="margin-left:6px">Öppna inställningar</button></div>`
      : `<div class="meta2" style="margin:2px 0 10px">Medlemmar i jourstallet läggs till via en profil (Inställningar → profilen → + Mejl) — de får då en inbjudan automatiskt. <button class="btn sm" id="iv_open" style="margin-left:6px">Öppna inställningar</button></div>`;
    ov.querySelector("#iv_open").onclick = ()=>{
      const sid = el("iv_stable").value;
      ov.remove();
      view = { name:"stable", stableId: sid };
      render();
    };
  };
  fillRoles();
  ov.querySelector("#iv_stable").onchange = fillRoles;
  ov.querySelector("#iv_cancel").onclick = ()=> ov.remove();
  ov.querySelector("#iv_send").onclick = async ()=>{
    const sid = el("iv_stable").value;
    const name = (el("iv_name").value||"").trim();
    const email = normEmail(el("iv_mail").value);
    const roleV = el("iv_role").value;
    if(!email.includes("@")){ el("iv_msg").innerHTML = msg("Skriv en giltig mejladress.", "err"); return; }
    const kind = roleV === "admin" ? "admin" : "staff";
    const staff_perm = kind === "staff" ? roleV.split(":")[1] : null;
    const r = await db.from("invite").insert({ stable_id: sid, email, invited_by: session.email, kind, staff_perm, invite_name: name || null });
    let resent = false;
    if(r.error){
      const dup = (r.error.code === "23505") || /duplicate/i.test(r.error.message||"");
      if(!dup){ el("iv_msg").innerHTML = msg("Kunde inte skapa inbjudan: " + r.error.message, "err"); return; }
      // fanns redan en inbjudan → gör om den till väntande och skicka om mejlet
      const u = await db.from("invite")
        .update({ status:"pending", invited_by: session.email, staff_perm, invite_name: name || null, responded_at: null })
        .eq("stable_id", sid).eq("email", email).eq("kind", kind).is("profile_id", null);
      if(u.error){ el("iv_msg").innerHTML = msg("Kunde inte skicka om inbjudan: " + u.error.message, "err"); return; }
      resent = true;
    }
    // skicka inloggningsmejl — länken loggar in personen, inbjudan väntar sedan i notisklockan
    let mailNote = "";
    try{
      const redirect = window.location.origin + window.location.pathname;
      const m = await db.auth.signInWithOtp({ email, options: { shouldCreateUser: true, emailRedirectTo: redirect } });
      if(m.error) mailNote = " Obs: mejlet kunde inte skickas (" + m.error.message + ") — be personen logga in själv på appen.";
    }catch(e){ mailNote = " Obs: mejlet kunde inte skickas — be personen logga in själv på appen."; }
    ov.remove();
    infoDialog((resent ? "Inbjudan till " + email + " är skickad om! " : "Inbjudan till " + email + " är skickad! ")
      + "Personen får ett mejl med inloggningslänk och svarar sedan på inbjudan i notisklockan." + mailNote, resent ? "Inbjudan omskickad" : "Inbjudan skickad");
  };
}
async function resolveRequest(id, accept){
  const r = await db.rpc("resolve_pass_request", { p_request: id, p_accept: accept });
  if(r.error){ alert(r.error.message); return; }
  await refreshBellCount();
  if(el("bellMenu").classList.contains("open")) await openBellMenu();
  if(view.name === "schedule" && schedCtx) drawGrid(true);
}
el("btnBell").onclick = (e)=>{
  e.stopPropagation();
  const m = el("bellMenu");
  const wasOpen = m.classList.contains("open");
  closeMenus();
  if(!wasOpen) openBellMenu();
};

function infoDialog(text, title){
  return new Promise(res=>{
    const ov = document.createElement("div"); ov.className = "modal-ov";
    ov.innerHTML = `<div class="modal"><h3>${esc(title||"Klart")}</h3><p>${esc(text)}</p>
      <div class="modal-btns"><button class="btn primary" id="mOk2">Ok</button></div></div>`;
    document.body.appendChild(ov);
    const done = ()=>{ ov.remove(); res(); };
    ov.querySelector("#mOk2").onclick = done;
    ov.onclick = (e)=>{ if(e.target===ov) done(); };
  });
}

// Välj mottagare: först grupp, sen profil i gruppen
function chooseProfileDialog(excludeId){
  return new Promise(res=>{
    const groups = schedCtx.groups, profs = schedCtx.profiles || [];
    const meP = profs.find(p=> p.id === schedCtx.actingProfileId);
    const myGroupIds = new Set(((meP && meP.horse) || []).map(h=> h.group_id).filter(Boolean));
    const ov = document.createElement("div"); ov.className = "modal-ov";
    const box = document.createElement("div"); box.className = "modal"; ov.appendChild(box);
    document.body.appendChild(ov);
    const done = v =>{ ov.remove(); res(v); };
    ov.onclick = (e)=>{ if(e.target===ov) done(null); };
    function stepGroups(){
      box.innerHTML = `<h3>Ge bort till vem?</h3><p>Välj grupp:</p>
        <div class="stack">${groups.map(g=>`<button class="btn block" data-g="${g.id}">${esc(g.name)}${myGroupIds.has(g.id)?" · din grupp":""}</button>`).join("")}</div>
        <div class="modal-btns" style="margin-top:14px"><button class="btn" id="cAbort">Avbryt</button></div>`;
      box.querySelector("#cAbort").onclick = ()=> done(null);
      box.querySelectorAll("[data-g]").forEach(b=> b.onclick = ()=> stepProfiles(b.getAttribute("data-g")));
    }
    function stepProfiles(gid){
      const g = groups.find(x=> x.id === gid);
      const list = profs.filter(p=> p.id !== excludeId && (p.horse||[]).some(h=> h.group_id === gid));
      box.innerHTML = `<h3>${esc(g ? g.name : "")}</h3><p>Välj profil att skicka förfrågan till:</p>
        <div class="stack">${list.length ? list.map(p=>`<button class="btn block" data-p="${p.id}">${esc(p.name)}</button>`).join("") : `<div class="meta2">Inga profiler i den här gruppen.</div>`}</div>
        <div class="modal-btns" style="margin-top:14px"><button class="btn" id="cBack">‹ Tillbaka</button><button class="btn" id="cAbort2">Avbryt</button></div>`;
      box.querySelector("#cBack").onclick = stepGroups;
      box.querySelector("#cAbort2").onclick = ()=> done(null);
      box.querySelectorAll("[data-p]").forEach(b=> b.onclick = ()=> done(b.getAttribute("data-p")));
    }
    stepGroups();
  });
}

async function onChipClick(req, pinfo){
  if(!schedCtx.actingProfileId) return;
  const parts = req.split("|"); const bid = parts[0], ownerId = parts[1], mineFlag = parts[2];
  const j = pinfo.lastIndexOf("|"); const pn = pinfo.slice(0, j), pd = pinfo.slice(j+1);
  if(pd < isoDate(new Date())) return;   // inga byten bakåt i tiden
  const d = new Date(pd + "T00:00:00");
  const label = `${pn}, ${DAY_NAMES[d.getDay()].toLowerCase()} ${d.getDate()}/${d.getMonth()+1}`;
  if(mineFlag === "1"){
    const ok = await confirmDialog(`Vill du ge bort ditt pass ${label}?`, { title:"Ge bort pass", okText:"Ja", primary:true });
    if(!ok) return;
    const target = await chooseProfileDialog(ownerId);
    if(!target) return;
    await sendPassRequest("give", bid, ownerId, target, label);
  } else {
    const owner = (schedCtx.profiles||[]).find(p=> p.id === ownerId);
    const ok = await confirmDialog(`Vill du skicka en förfrågan till ${owner ? owner.name : "ägaren"} om att ta över passet ${label}?`, { title:"Ta över pass", okText:"Ja, skicka", primary:true });
    if(!ok) return;
    await sendPassRequest("take", bid, schedCtx.actingProfileId, ownerId, label);
  }
}

async function sendPassRequest(type, bookingId, fromP, toP, label){
  if(fromP === toP) return;
  const dup = await db.from("pass_request").select("id").eq("booking_id", bookingId).eq("status","pending");
  if(!dup.error && (dup.data||[]).length){ await infoDialog("Det finns redan en väntande förfrågan på det här passet.", "Redan skickad"); return; }
  const r = await db.from("pass_request").insert({ stable_id: schedCtx.stable.id, booking_id: bookingId, type, from_profile: fromP, to_profile: toP });
  if(r.error){ alert("Kunde inte skicka förfrågan: " + r.error.message); return; }
  const toName = ((schedCtx.profiles||[]).find(p=> p.id === toP) || {}).name || "profilen";
  await infoDialog(`Din förfrågan om passet ${label} har skickats till ${toName}. De får en notis och kan bekräfta eller avböja.`, "Förfrågan skickad");
}

/* ============ Ikoner i headern ============ */
document.querySelectorAll(".islot").forEach(s=>{ s.outerHTML = ic(s.getAttribute("data-icon")); });

/* ============ Mina pass ============ */
/* Ledighetsansökan: typ + datumintervall + valfri kommentar → chef/admin beviljar i klockan */
function leaveDialog(stableId, staffId, done){
  if(!staffId) return;
  const ov = document.createElement("div"); ov.className = "modal-ov";
  ov.innerHTML = `<div class="modal"><h3>Ansök om ledighet</h3>
    <div class="field"><label class="fld">Typ</label><select id="lv_kind">
      <option value="semester">Semester</option><option value="ledighet">Ledighet</option><option value="vab">VAB</option></select></div>
    <div class="field"><label class="fld">Från</label><input type="date" id="lv_start"></div>
    <div class="field"><label class="fld">Till</label><input type="date" id="lv_end"></div>
    <div class="field"><label class="fld">Kommentar (valfritt)</label><input type="text" id="lv_note" maxlength="120"></div>
    <div id="lv_msg"></div>
    <div class="modal-btns"><button class="btn" id="lv_cancel">Avbryt</button><button class="btn primary" id="lv_send">Skicka ansökan</button></div></div>`;
  document.body.appendChild(ov);
  ov.querySelector("#lv_cancel").onclick = ()=> ov.remove();
  ov.querySelector("#lv_send").onclick = async ()=>{
    const start = el("lv_start").value, end = el("lv_end").value;
    if(!start || !end){ el("lv_msg").innerHTML = msg("Välj både från- och till-datum.", "err"); return; }
    if(end < start){ el("lv_msg").innerHTML = msg("Till-datumet är före från-datumet.", "err"); return; }
    const r = await db.from("rs_leave").insert({ stable_id: stableId, staff_id: staffId, kind: el("lv_kind").value,
      start_date: start, end_date: end, note: (el("lv_note").value||"").trim() || null });
    if(r.error){ el("lv_msg").innerHTML = msg("Kunde inte skicka: " + r.error.message + " (har db/ledighet.sql körts?)", "err"); return; }
    ov.remove();
    infoDialog("Ansökan är skickad! Chef och admin ser den i sin notisklocka och du får en notis när den besvarats.", "Ansökan skickad");
    if(done) done();
  };
}

/* Mina lektioner / Mina arbetspass (ridskola): kommande fyra veckor */
let mlTab = null;   // "lek" | "pass" — väljs automatiskt första gången
async function renderMyLessons(stableId){
  try{
    const st = await db.from("stable").select("*").eq("id", stableId).single(); if(st.error) throw st.error;
    const [g,s,h,gs,sf,gf,ins,gi,tk,tf] = await Promise.all([
      db.from("rs_group").select("*, category(name)").eq("stable_id", stableId).order("weekday").order("start_time"),
      db.from("rs_student").select("id,name,rs_student_member(email)").eq("stable_id", stableId).order("name"),
      db.from("rs_horse").select("id,name").eq("stable_id", stableId),
      db.from("rs_group_student").select("*"),
      db.from("rs_staff").select("id,name,rs_staff_member(email)").eq("stable_id", stableId),
      db.from("rs_group_staff").select("*"),
      db.from("rs_instructor").select("id,name,rs_instructor_member(email)").eq("stable_id", stableId),
      db.from("rs_group_instructor").select("*"),
      db.from("rs_task").select("*").eq("stable_id", stableId).order("start_time"),
      db.from("rs_task_staff").select("*")
    ]);
    if(g.error) throw g.error;
    const groups = g.data||[], students = s.error?[]:s.data, horses = h.error?[]:h.data;
    const gstud = gs.error?[]:gs.data, staff = sf.error?[]:sf.data, gstaff = gf.error?[]:gf.data;
    const instrs = ins.error?[]:ins.data, ginstr = gi.error?[]:gi.data;
    const tasks = tk.error?[]:tk.data, taskStaff = tf.error?[]:tf.data;
    const myStud = new Set(students.filter(x=> (x.rs_student_member||[]).some(m=> (m.email||"").toLowerCase() === session.email)).map(x=> x.id));
    const myStaff = new Set(staff.filter(x=> (x.rs_staff_member||[]).some(m=> (m.email||"").toLowerCase() === session.email)).map(x=> x.id));
    const myInstr = new Set(instrs.filter(x=> (x.rs_instructor_member||[]).some(m=> (m.email||"").toLowerCase() === session.email)).map(x=> x.id));
    const rel = groups.filter(gr=>
      gstud.some(x=> x.group_id===gr.id && myStud.has(x.student_id)) ||
      gstaff.some(x=> x.group_id===gr.id && myStaff.has(x.staff_id)) ||
      ginstr.some(x=> x.group_id===gr.id && myInstr.has(x.instructor_id)));
    const relTasks = tasks.filter(t2=> taskStaff.some(x=> x.task_id===t2.id && myStaff.has(x.staff_id)));
    const today = new Date(); today.setHours(0,0,0,0);
    const tISO = isoDate(today);
    const endD = new Date(today); endD.setDate(endD.getDate()+27);
    const endISO = isoDate(endD);
    // passbyten: mina egna (alla statusar, för listan) + veckornas gällande byten (påverkar vad jag jobbar)
    const sq = await db.from("rs_task_swap").select("*").eq("stable_id", stableId).order("created_at",{ascending:false}).limit(200);
    const swAllRows = sq.error?[]:sq.data;
    // listan visar kommande byten och allt som fortfarande väntar på svar (hela historiken finns i Mina förfrågningar)
    const swMine = swAllRows.filter(s=> (myStaff.has(s.giver_staff) || myStaff.has(s.taker_staff))
      && (s.work_date >= tISO || s.status === "pending"));
    const swWin = swAllRows.filter(s=> s.work_date >= tISO && s.work_date <= endISO && s.status !== "declined");
    const passTasks = relTasks.concat(tasks.filter(t2=> !relTasks.some(x=> x.id === t2.id)
      && swWin.some(s=> s.task_id === t2.id && swapActive(s) && myStaff.has(s.taker_staff))));
    const alq = await db.from("rs_leave").select("*").eq("status","approved").lte("start_date", endISO).gte("end_date", tISO);
    const allLeave = alq.error?[]:alq.data;
    let asg = [], abs = [], notes = [], tAbs = [];
    if(rel.length){
      const ids = rel.map(x=> x.id);
      const [aq,bq,nq] = await Promise.all([
        db.from("rs_assignment").select("*").in("group_id", ids).gte("lesson_date", tISO).lte("lesson_date", endISO),
        db.from("rs_absence").select("*").in("group_id", ids).gte("lesson_date", tISO).lte("lesson_date", endISO),
        db.from("rs_lesson_note").select("*").in("group_id", ids).gte("lesson_date", tISO).lte("lesson_date", endISO)
      ]);
      asg = aq.error?[]:aq.data; abs = bq.error?[]:bq.data; notes = nq.error?[]:nq.data;
    }
    if(passTasks.length){
      const tq = await db.from("rs_task_absence").select("*").in("task_id", passTasks.map(x=> x.id)).gte("work_date", tISO).lte("work_date", endISO);
      tAbs = tq.error?[]:tq.data;
    }
    let myLeaves = [];
    if(myStaff.size){
      const lq2 = await db.from("rs_leave").select("*").in("staff_id", [...myStaff]).order("created_at",{ascending:false});
      myLeaves = lq2.error?[]:lq2.data;
    }
    if(mlTab === null) mlTab = (!rel.length && passTasks.length) ? "pass" : "lek";
    let html = "";
    for(let i=0;i<28;i++){
      const d = new Date(today); d.setDate(d.getDate()+i);
      const wd = ((d.getDay()+6)%7)+1;
      const dayRel = mlTab === "lek" ? rel.filter(gr=> gr.weekday === wd).sort((a,b)=> timeKey(a)-timeKey(b)) : [];
      const dayTasks = mlTab === "pass" ? passTasks.filter(t2=> t2.weekday === wd).sort((a,b)=> timeKey(a)-timeKey(b)) : [];
      if(!dayRel.length && !dayTasks.length) continue;
      const dISO = isoDate(d);
      html += `<div class="sublabel" style="margin-top:16px">${RS_WD[wd]} ${d.getDate()}/${d.getMonth()+1}${dISO===tISO?' · <span style="color:var(--accent)">idag</span>':""}</div>`;
      dayTasks.forEach(t2=>{
        const sw = swWin.filter(s=> s.task_id===t2.id && s.work_date===dISO);
        const swA = sw.filter(swapActive);
        const baseIds = taskStaff.filter(x=> x.task_id===t2.id).map(x=> x.staff_id);
        const eff = taskEffectiveStaff(baseIds, swA);
        // mina rader: de av mina personal-id som jobbar passet den dagen, plus dem jag bytt bort (så bytet syns)
        const myRowIds = [...new Set([...baseIds, ...eff])].filter(id=> myStaff.has(id));
        if(!myRowIds.length) return;
        const trows = myRowIds.map(id=>{
          const f = staff.find(y=> y.id===id); if(!f) return "";
          const gaveAway = swA.find(s=> s.giver_staff===id);
          if(gaveAway && !eff.has(id)){
            const to = (staff.find(y=> y.id===gaveAway.taker_staff)||{}).name || "en kollega";
            return `<div class="scsrow scssick"><span class="scsname">${esc(f.name)}</span><span class="tagpill st-no" title="Bytt bort till ${esc(to)}">bytt bort</span></div>`;
          }
          const swappedIn = !baseIds.includes(id) ? ` <span class="tagpill">inbytt</span>` : "";
          const sick = tAbs.some(y=> y.task_id===t2.id && y.work_date===dISO && y.staff_id===f.id);
          const sickBit = sick
            ? `<span class="tagpill st-no" data-mltunsick="${t2.id}|${dISO}|${f.id}" style="cursor:pointer" title="Ta bort sjukanmälan">sjuk</span>`
            : `<button class="btn sm" data-mltsick="${t2.id}|${dISO}|${f.id}">Sjukanmäl</button>`;
          const waiting = sw.some(s=> swapWaiting(s) && (s.giver_staff===id || s.taker_staff===id));
          const giveBit = (!sick && !waiting) ? `<button class="btn sm" data-mlswap="${t2.id}|${dISO}|${f.id}">Erbjud bort</button>` : "";
          return `<div class="scsrow${sick?" scssick":""}"><span class="scsname">${esc(f.name)}${swappedIn}</span>${giveBit}${sickBit}</div>`;
        }).join("");
        const swNotes = sw.map(s=> swapNote(s, { name: id=> ((staff.find(y=> y.id===id)||{}).name || "?"),
          mineIds: myStaff, isChef: false, canCancel: true })).join("");
        html += `<div class="card taskcard">
          <div style="display:flex;align-items:baseline;gap:8px;flex-wrap:wrap">
            <b>${esc(t2.name)}</b>
            <span class="meta2">${t2.start_time}–${rsEndTime(t2.start_time, t2.duration_min)}</span>
            <span class="tagpill">arbetspass</span>
          </div>
          ${t2.description?`<div class="meta2" style="margin-top:4px">${esc(t2.description)}</div>`:""}
          <div style="margin-top:8px">${trows}</div>
          ${swNotes ? `<div style="margin-top:8px">${swNotes}</div>` : ""}
        </div>`;
      });
      dayRel.forEach(gr=>{
        const note = notes.find(x=> x.group_id===gr.id && x.lesson_date===dISO);
        const roles = [];
        if(gstaff.some(x=> x.group_id===gr.id && myStaff.has(x.staff_id))) roles.push(`<div class="meta2">Du är personal på lektionen</div>`);
        if(ginstr.some(x=> x.group_id===gr.id && myInstr.has(x.instructor_id))) roles.push(`<div class="meta2">Du är ledare på lektionen</div>`);
        const rows = gstud.filter(x=> x.group_id===gr.id && myStud.has(x.student_id)).map(x=>{
          const stu = students.find(y=> y.id===x.student_id); if(!stu) return "";
          const a = asg.find(y=> y.group_id===gr.id && y.lesson_date===dISO && y.student_id===stu.id);
          const hn = a && a.horse_id ? (((horses.find(z=> z.id===a.horse_id))||{}).name || "?") : "ej tilldelad än";
          const sick = abs.some(y=> y.group_id===gr.id && y.lesson_date===dISO && y.student_id===stu.id);
          const sickBit = sick
            ? `<span class="tagpill st-no" data-mlunsick="${gr.id}|${dISO}|${stu.id}" style="cursor:pointer" title="Ta bort sjukanmälan">sjuk</span>`
            : `<button class="btn sm" data-mlsick="${gr.id}|${dISO}|${stu.id}">Sjukanmäl</button>`;
          return `<div class="scsrow${sick?" scssick":""}"><span class="scsname">${esc(stu.name)}</span><span class="meta2">Häst: ${esc(hn)}</span>${sickBit}</div>`;
        }).join("");
        html += `<div class="card">
          <div style="display:flex;align-items:baseline;gap:8px;flex-wrap:wrap">
            <b>${esc(gr.name)}</b>
            <span class="meta2">${gr.start_time}–${rsEndTime(gr.start_time, gr.duration_min)}</span>
            ${gr.category&&gr.category.name?`<span class="tagpill">${esc(gr.category.name)}</span>`:""}
          </div>
          ${note && (note.note||"").trim() ? `<div class="meta2" style="margin-top:4px">Planering: ${esc(note.note)}</div>` : ""}
          ${roles.join("")}
          ${rows ? `<div style="margin-top:8px">${rows}</div>` : ""}
        </div>`;
      });
    }
    const fmtD = s=>{ const d = new Date(s+"T00:00:00"); return d.getDate()+"/"+(d.getMonth()+1); };
    const leaveSec = (mlTab === "pass" && myStaff.size) ? `<div class="card">
      <div class="sublabel" style="margin-bottom:6px">Ledighet</div>
      ${myLeaves.map(x=>{
        const stTag = x.status === "pending" ? `<span class="tagpill st-pend">väntar</span>`
                    : x.status === "approved" ? `<span class="tagpill">beviljad</span>`
                    : `<span class="tagpill st-no">avslagen</span>`;
        const undo = x.status === "pending" ? `<button class="btn sm" data-lvdel="${x.id}">Ångra</button>` : "";
        return `<div class="scsrow"><span class="scsname" style="font-weight:500">${esc(x.kind)} ${fmtD(x.start_date)}–${fmtD(x.end_date)}${x.note?` <span class="meta2">· ${esc(x.note)}</span>`:""}</span>${stTag}${undo}</div>`;
      }).join("") || `<div class="meta2">Inga ansökningar än.</div>`}
      <div style="margin-top:10px"><button class="btn sm" id="mlLeaveBtn">+ Ansök om ledighet</button></div>
    </div>` : "";
    const swapSec = (mlTab === "pass" && myStaff.size) ? `<div class="card">
      <div class="sublabel" style="margin-bottom:6px">Passbyten</div>
      ${swMine.map(s=>{
        const tn = ((tasks.find(x=> x.id===s.task_id))||{}).name || "arbetspass";
        const gn = ((staff.find(x=> x.id===s.giver_staff))||{}).name || "?";
        const tkn = ((staff.find(x=> x.id===s.taker_staff))||{}).name || "?";
        const stTag = s.status === "declined" ? `<span class="tagpill st-no">avböjd</span>`
          : s.chef_status === "denied" ? `<span class="tagpill st-no">nekad</span>`
          : swapActive(s) ? `<span class="tagpill">godkänd</span>`
          : s.status === "pending" ? `<span class="tagpill st-pend">väntar på svar</span>`
          : `<span class="tagpill st-pend">väntar på godkännande</span>`;
        const iAmRecip = myStaff.has(swapRecipient(s));
        const btns = s.status !== "pending" ? ""
          : iAmRecip
            ? `<button class="btn primary sm" data-swacc="${s.id}">${s.asked_by === "giver" ? "Ta över" : "Ja, byt"}</button><button class="btn sm" data-swdec="${s.id}">Avböj</button>`
            : `<button class="btn sm" data-swdel="${s.id}">Ångra</button>`;
        return `<div class="scsrow"><span class="scsname" style="font-weight:500">${esc(tn)} ${fmtD(s.work_date)} <span class="meta2">· ${esc(gn)} → ${esc(tkn)}</span></span>${stTag}${btns}</div>`;
      }).join("") || `<div class="meta2">Inga passbyten än. Erbjud bort ett pass med knappen i passet nedan.</div>`}
    </div>` : "";
    el("mineShell").innerHTML = `
      <div class="card schedtop"><div class="schedeyebrow">${mlTab==="pass"?"Mina arbetspass":"Mina lektioner"}</div><h1 class="schedname">${esc(st.data.name)}</h1>
        <div style="display:flex;justify-content:center;gap:8px;flex-wrap:wrap">
          <button class="btn sm${mlTab==="lek"?" primary":""}" id="mlTabLek">Mina lektioner</button>
          <button class="btn sm${mlTab==="pass"?" primary":""}" id="mlTabPass">Mina arbetspass</button>
        </div></div>
      ${leaveSec}
      ${swapSec}
      ${html || `<div class="card"><div class="empty">${mlTab==="pass"?"Inga kommande arbetspass för dig de närmaste fyra veckorna.":"Inga kommande lektioner för dig de närmaste fyra veckorna."}</div></div>`}`;
    el("mlTabLek").onclick = ()=>{ if(mlTab!=="lek"){ mlTab = "lek"; renderMyLessons(stableId); } };
    el("mlTabPass").onclick = ()=>{ if(mlTab!=="pass"){ mlTab = "pass"; renderMyLessons(stableId); } };
    const lb = el("mlLeaveBtn");
    if(lb) lb.onclick = ()=> leaveDialog(stableId, [...myStaff][0], ()=> renderMyLessons(stableId));
    document.querySelectorAll("[data-mlswap]").forEach(b=> b.onclick = ()=>{
      const [tid, dI, fid] = b.getAttribute("data-mlswap").split("|");
      const t2 = tasks.find(x=> x.id === tid);
      const baseIds = taskStaff.filter(x=> x.task_id === tid).map(x=> x.staff_id);
      const eff = taskEffectiveStaff(baseIds, swWin.filter(s=> s.task_id===tid && s.work_date===dI && swapActive(s)));
      const cands = staff.filter(f=> !eff.has(f.id)).map(f=>{
        const lv = allLeave.find(x=> x.staff_id===f.id && x.start_date <= dI && x.end_date >= dI);
        return { id: f.id, name: f.name, busy: lv ? lv.kind : "" };
      });
      swapDialog("give", { stableId, taskId: tid, taskName: t2 ? t2.name : "arbetspass", dISO: dI, giverId: fid,
        candidates: cands, done: ()=> renderMyLessons(stableId) });
    });
    bindSwapButtons(document, ()=> renderMyLessons(stableId));
    document.querySelectorAll("[data-lvdel]").forEach(b=> b.onclick = async ()=>{
      if(!(await confirmDialog("Ångra ansökan?", { okText:"Ja, ångra" }))) return;
      await db.from("rs_leave").delete().eq("id", b.getAttribute("data-lvdel"));
      renderMyLessons(stableId);
    });
    document.querySelectorAll("[data-mlsick]").forEach(b=> b.onclick = async ()=>{
      const [gid, dI, sid] = b.getAttribute("data-mlsick").split("|");
      const stu = students.find(x=> x.id === sid);
      const dd = new Date(dI+"T00:00:00");
      if(!(await confirmDialog(`Sjukanmäla ${stu?stu.name:"eleven"} till lektionen ${RS_WD[((dd.getDay()+6)%7)+1].toLowerCase()} ${dd.getDate()}/${dd.getMonth()+1}?`, { title:"Sjukanmälan", okText:"Ja, sjukanmäl", primary:true }))) return;
      const r = await db.from("rs_absence").insert({ group_id: gid, lesson_date: dI, student_id: sid });
      if(r.error){ alert("Kunde inte sjukanmäla: " + r.error.message); return; }
      renderMyLessons(stableId);
    });
    document.querySelectorAll("[data-mlunsick]").forEach(b=> b.onclick = async ()=>{
      const [gid, dI, sid] = b.getAttribute("data-mlunsick").split("|");
      if(!(await confirmDialog("Ta bort sjukanmälan?", { okText:"Ja, ta bort" }))) return;
      await db.from("rs_absence").delete().eq("group_id",gid).eq("lesson_date",dI).eq("student_id",sid);
      renderMyLessons(stableId);
    });
    document.querySelectorAll("[data-mltsick]").forEach(b=> b.onclick = async ()=>{
      const [tid, dI, fid] = b.getAttribute("data-mltsick").split("|");
      const dd = new Date(dI+"T00:00:00");
      if(!(await confirmDialog(`Sjukanmäla dig från passet ${RS_WD[((dd.getDay()+6)%7)+1].toLowerCase()} ${dd.getDate()}/${dd.getMonth()+1}?`, { title:"Sjukanmälan", okText:"Ja, sjukanmäl", primary:true }))) return;
      const r = await db.from("rs_task_absence").insert({ task_id: tid, work_date: dI, staff_id: fid });
      if(r.error){ alert("Kunde inte sjukanmäla: " + r.error.message); return; }
      renderMyLessons(stableId);
    });
    document.querySelectorAll("[data-mltunsick]").forEach(b=> b.onclick = async ()=>{
      const [tid, dI, fid] = b.getAttribute("data-mltunsick").split("|");
      if(!(await confirmDialog("Ta bort sjukanmälan?", { okText:"Ja, ta bort" }))) return;
      await db.from("rs_task_absence").delete().eq("task_id",tid).eq("work_date",dI).eq("staff_id",fid);
      renderMyLessons(stableId);
    });
  }catch(e){ el("mineShell").innerHTML = msg("Kunde inte hämta lektioner: " + (e.message||e), "err"); }
}

async function renderMyPasses(stableId){
  appEl.innerHTML = `<div id="mineShell"><div class="card"><div class="empty">Laddar…</div></div></div>`;
  try{
    const kq = await db.from("stable").select("kind").eq("id", stableId).single();
    if(!kq.error && kq.data && kq.data.kind === "ridskola"){ renderMyLessons(stableId); return; }
    const st = await db.from("stable").select("*").eq("id", stableId).single(); if(st.error) throw st.error;
    const g  = await db.from("duty_group").select("*").eq("stable_id", stableId).order("sort_order"); if(g.error) throw g.error;
    const pr = await db.from("profile").select("id,name,profile_member(email),horse(group_id)").eq("stable_id", stableId); if(pr.error) throw pr.error;
    const myIds = pr.data.filter(p=> (p.profile_member||[]).some(m=> (m.email||"").toLowerCase() === session.email)).map(p=> p.id);
    // gör ge bort-flödet (gruppväljaren) användbart härifrån också
    schedCtx = { stable: st.data, groups: g.data, profiles: pr.data, passes: [], myProfiles: pr.data.filter(p=> myIds.includes(p.id)), actingProfileId: myIds[0] || null };
    const b = await db.from("booking").select("id,pass_date,profile_id,profile(name),pass_def(name,start_time)")
      .eq("stable_id", stableId).gte("pass_date", isoDate(new Date())).order("pass_date");
    if(b.error) throw b.error;
    const rows = (b.data||[]).filter(x=> myIds.includes(x.profile_id))
      .map(x=> ({ ...x, t: (x.pass_def && x.pass_def.start_time) || "" }))
      .sort((a,c)=> a.pass_date === c.pass_date ? (a.t < c.t ? -1 : 1) : (a.pass_date < c.pass_date ? -1 : 1));
    const multi = myIds.length > 1;
    const tISO = isoDate(new Date());
    const list = rows.length ? rows.map(x=>{
      const d = new Date(x.pass_date + "T00:00:00");
      const today = x.pass_date === tISO;
      const pn = (x.pass_def && x.pass_def.name) || "Pass";
      return `<button class="row" data-mp="${x.id}|${x.profile_id}" data-mpinfo="${esc(pn)}|${x.pass_date}">
        <div class="grow"><div class="nm">${esc(pn)} <span class="meta2">${esc(x.t)}</span></div>
        <div class="meta">${today ? "Idag" : DAY_NAMES[d.getDay()]} ${d.getDate()}/${d.getMonth()+1} · v.${isoWeekNumber(d)}${multi ? ` · ${esc((x.profile && x.profile.name) || "")}` : ""}</div></div>
        ${today ? `<span class="tagpill">idag</span>` : ""}
        <span class="chev">›</span>
      </button>`;
    }).join("") : `<div class="empty">Du har inga kommande pass bokade.</div>`;
    el("mineShell").innerHTML = `
      <div class="card schedtop"><div class="schedeyebrow">Mina pass</div><h1 class="schedname">${esc(st.data.name)}</h1></div>
      <div class="card"><div class="list">${list}</div></div>`;
    document.querySelectorAll("[data-mp]").forEach(btn=> btn.onclick = ()=>{
      const [bid, owner] = btn.getAttribute("data-mp").split("|");
      const info = btn.getAttribute("data-mpinfo");
      const j = info.lastIndexOf("|");
      myPassAction(bid, owner, info.slice(0, j), info.slice(j+1));
    });
  }catch(e){ el("mineShell").innerHTML = msg("Kunde inte hämta dina pass: " + (e.message||e), "err"); }
}

function actionDialog(title, text, actions){
  return new Promise(res=>{
    const ov = document.createElement("div"); ov.className = "modal-ov";
    ov.innerHTML = `<div class="modal"><h3>${esc(title)}</h3><p>${esc(text)}</p>
      <div class="stack">${actions.map((a,i)=>`<button class="${a.cls||'btn'} block" data-a="${i}">${esc(a.label)}</button>`).join("")}</div>
      <div class="modal-btns" style="margin-top:14px"><button class="btn" id="aCancel">Avbryt</button></div></div>`;
    document.body.appendChild(ov);
    const done = v =>{ ov.remove(); res(v); };
    ov.querySelector("#aCancel").onclick = ()=> done(null);
    ov.onclick = (e)=>{ if(e.target===ov) done(null); };
    ov.querySelectorAll("[data-a]").forEach(b=> b.onclick = ()=> done(actions[+b.getAttribute("data-a")].v));
  });
}

async function myPassAction(bid, ownerId, pn, pd){
  const d = new Date(pd + "T00:00:00");
  const label = `${pn}, ${DAY_NAMES[d.getDay()].toLowerCase()} ${d.getDate()}/${d.getMonth()+1}`;
  const choice = await actionDialog("Ditt pass", label, [
    { v:"give", label:"Ge bort passet (skicka förfrågan)", cls:"btn primary" },
    { v:"del",  label:"Ta bort passet (avboka)", cls:"btn danger-solid" }
  ]);
  if(!choice) return;
  if(choice === "del"){
    if(!(await confirmDialog(`Är du säker på att du vill ta bort ditt pass ${label}?`, { title:"Ta bort pass", okText:"Ja, ta bort" }))) return;
    const r = await db.from("booking").delete().eq("id", bid);
    if(r.error){ alert("Kunde inte ta bort: " + r.error.message); return; }
    const owner = (schedCtx.profiles||[]).find(p=> p.id === ownerId);
    logCancel(pn, pd, owner ? owner.name : "?");
    renderMyPasses(view.stableId);
  } else {
    schedCtx.actingProfileId = ownerId;   // "din grupp"-markeringen i väljaren utgår från passets profil
    const target = await chooseProfileDialog(ownerId);
    if(!target) return;
    await sendPassRequest("give", bid, ownerId, target, label);
  }
}

/* ============ Påminnelser (visas i klockan) ============ */
const REMIND_OPTS = [["","Av"],["60","1 timme innan"],["1440","1 dag innan"],["2880","2 dagar innan"]];
let dueReminders = [];

async function getDueReminders(){
  if(!session) return [];
  if(!myProfileIds.size) await refreshMyProfiles();
  if(!myProfileIds.size) return [];
  const pr = await db.from("profile").select("id,remind1_min,remind2_min").in("id", [...myProfileIds]);
  const withRem = (pr.data||[]).filter(p=> p.remind1_min || p.remind2_min);
  if(!withRem.length) return [];
  const b = await db.from("booking").select("id,pass_date,profile_id,pass_def(name,start_time)")
    .in("profile_id", withRem.map(p=> p.id)).gte("pass_date", isoDate(new Date()));
  if(b.error) return [];
  const now = Date.now(); const out = []; const seenBk = new Set();
  (b.data||[]).forEach(bk=>{
    const pd = bk.pass_def || {};
    const t = /^\d{2}:\d{2}/.test(pd.start_time||"") ? pd.start_time.slice(0,5) : "08:00";
    const start = new Date(bk.pass_date + "T" + t + ":00").getTime();
    if(start < now) return;
    const prof = withRem.find(p=> p.id === bk.profile_id); if(!prof) return;
    [prof.remind1_min, prof.remind2_min].forEach((m, i)=>{
      if(!m || seenBk.has(bk.id)) return;
      if(now >= start - m*60000){
        const key = "stalljour.rem_" + bk.id + "_" + i;
        let dismissed = false; try{ dismissed = !!localStorage.getItem(key); }catch(e){}
        if(dismissed) return;
        seenBk.add(bk.id);
        out.push({ key, passName: pd.name || "Pass", start });
      }
    });
  });
  return out.sort((a,c)=> a.start - c.start);
}
function remWhen(ts){
  const d = new Date(ts);
  const dISO = isoDate(d), tISO = isoDate(new Date());
  const tomorrow = isoDate(new Date(Date.now() + 86400000));
  const day = dISO === tISO ? "idag" : (dISO === tomorrow ? "imorgon" : DAY_NAMES[d.getDay()].toLowerCase() + " " + d.getDate() + "/" + (d.getMonth()+1));
  return `${day} ${String(d.getHours()).padStart(2,"0")}:${String(d.getMinutes()).padStart(2,"0")}`;
}

/* ============ Mina förfrågningar ============ */
async function renderRequests(stableId){
  appEl.innerHTML = `<div id="reqShell"><div class="card"><div class="empty">Laddar…</div></div></div>`;
  try{
    const st = await db.from("stable").select("*").eq("id", stableId).single(); if(st.error) throw st.error;
    await refreshMyProfiles();
    const r = await db.from("pass_request")
      .select("id,type,status,created_at,from_profile,to_profile,booking(pass_date,pass_def(name,start_time)),fromP:profile!pass_request_from_profile_fkey(name),toP:profile!pass_request_to_profile_fkey(name)")
      .eq("stable_id", stableId).order("created_at",{ascending:false});
    if(r.error) throw r.error;
    const mine = (r.data||[]).filter(q=> myProfileIds.has(q.from_profile) || myProfileIds.has(q.to_profile));
    const list = mine.length ? mine.map(q=>{
      const sent = myProfileIds.has(q.from_profile);
      const other = sent ? ((q.toP && q.toP.name) || "?") : ((q.fromP && q.fromP.name) || "?");
      const bk = q.booking || {};
      const pn = (bk.pass_def && bk.pass_def.name) || "pass";
      const d = bk.pass_date ? new Date(bk.pass_date + "T00:00:00") : null;
      const when = d ? `${DAY_NAMES[d.getDay()]} ${d.getDate()}/${d.getMonth()+1} · v.${isoWeekNumber(d)}` : "";
      const txt = q.type === "take"
        ? (sent ? `Du frågade <b>${esc(other)}</b> om att ta över deras pass` : `<b>${esc(other)}</b> vill ta över ditt pass`)
        : (sent ? `Du erbjöd <b>${esc(other)}</b> ditt pass` : `<b>${esc(other)}</b> vill ge dig sitt pass`);
      const stTag = q.status === "pending" ? `<span class="tagpill st-pend">väntar</span>`
                  : q.status === "accepted" ? `<span class="tagpill">godkänd</span>`
                  : `<span class="tagpill st-no">avböjd</span>`;
      const cd = q.created_at ? new Date(q.created_at) : null;
      const meta = `${esc(pn)}${when?` · ${esc(when)}`:""}${cd?` · skickad ${cd.getDate()}/${cd.getMonth()+1}`:""}`;
      const btns = (!sent && q.status === "pending")
        ? `<div class="notifbtns"><button class="btn primary sm" data-racc="${q.id}">Bekräfta</button><button class="btn sm" data-rdec="${q.id}">Avböj</button></div>` : "";
      return `<div class="notif"><div style="display:flex;align-items:center;gap:8px"><div class="grow">${txt}</div>${stTag}</div><div class="meta2">${meta}</div>${btns}</div>`;
    }).join("") : `<div class="empty">Inga förfrågningar än. Klicka på ett pass i schemat för att skicka en.</div>`;
    // Inbjudningar (alla mina, oavsett stall) — avböjda kan accepteras i efterhand
    const ivq = await db.from("invite").select("id,status,invited_by,created_at,kind,staff_perm,invite_name,stable(name),profile(name)").eq("email", session.email).order("created_at",{ascending:false});
    const myInv = ivq.error ? [] : (ivq.data||[]);
    const invList = myInv.length ? myInv.map(v=>{
      const stTag = v.status === "pending" ? `<span class="tagpill st-pend">väntar</span>`
                  : v.status === "accepted" ? `<span class="tagpill">accepterad</span>`
                  : `<span class="tagpill st-no">avböjd</span>`;
      const cd = v.created_at ? new Date(v.created_at) : null;
      const btns = v.status === "pending"
        ? `<div class="notifbtns"><button class="btn primary sm" data-ivacc="${v.id}">Acceptera</button><button class="btn sm" data-ivdec="${v.id}">Avböj</button></div>`
        : v.status === "declined"
        ? `<div class="notifbtns"><button class="btn primary sm" data-ivacc="${v.id}">Acceptera ändå</button></div>` : "";
      return `<div class="notif"><div style="display:flex;align-items:center;gap:8px"><div class="grow"><b>${esc(v.invited_by)}</b> bjöd in dig till <b>${esc((v.stable&&v.stable.name)||"?")}</b> som ${esc(inviteRoleLabel(v))}</div>${stTag}</div>
        <div class="meta2">${cd?`Skickad ${cd.getDate()}/${cd.getMonth()+1}`:""}</div>${btns}</div>`;
    }).join("") : "";
    // Passbyten på arbetspass (ridskolan) — både mina skickade och de jag fått
    const swq2 = await db.from("rs_task_swap").select(SWAP_SEL).eq("stable_id", stableId).order("created_at",{ascending:false}).limit(100);
    const swRows = (swq2.error ? [] : (swq2.data||[]))
      .filter(s=> swEmails(s.giver).concat(swEmails(s.taker)).includes(session.email));
    const swList = swRows.map(s=>{
      const g = (s.giver && s.giver.name) || "?", t = (s.taker && s.taker.name) || "?";
      const tn = (s.rs_task && s.rs_task.name) || "arbetspass";
      const d = new Date(s.work_date + "T00:00:00");
      const iAmRecip = swEmails(s.asked_by === "giver" ? s.taker : s.giver).includes(session.email);
      const txt = s.asked_by === "giver"
        ? (iAmRecip ? `<b>${esc(g)}</b> erbjuder dig sitt arbetspass` : `Du erbjöd <b>${esc(t)}</b> ditt arbetspass`)
        : (iAmRecip ? `<b>${esc(t)}</b> vill ta över ditt arbetspass` : `Du frågade <b>${esc(g)}</b> om att ta över deras arbetspass`);
      const stTag = s.status === "declined" ? `<span class="tagpill st-no">avböjd</span>`
        : s.chef_status === "denied" ? `<span class="tagpill st-no">nekad</span>`
        : swapActive(s) ? `<span class="tagpill">godkänd</span>`
        : s.status === "pending" ? `<span class="tagpill st-pend">väntar på svar</span>`
        : `<span class="tagpill st-pend">väntar på godkännande</span>`;
      const btns = s.status !== "pending" ? ""
        : iAmRecip
          ? `<div class="notifbtns"><button class="btn primary sm" data-swacc="${s.id}">${s.asked_by === "giver" ? "Ta över" : "Ja, byt"}</button><button class="btn sm" data-swdec="${s.id}">Avböj</button></div>`
          : `<div class="notifbtns"><button class="btn sm" data-swdel="${s.id}">Ångra</button></div>`;
      return `<div class="notif"><div style="display:flex;align-items:center;gap:8px"><div class="grow">${txt}</div>${stTag}</div>
        <div class="meta2">${esc(tn)} · ${RS_WD[((d.getDay()+6)%7)+1]} ${d.getDate()}/${d.getMonth()+1}${s.note?` · ${esc(s.note)}`:""}</div>${btns}</div>`;
    }).join("");
    el("reqShell").innerHTML = `
      <div class="card schedtop"><div class="schedeyebrow">Mina förfrågningar</div><h1 class="schedname">${esc(st.data.name)}</h1></div>
      ${invList?`<div class="card"><div class="sublabel" style="margin-bottom:8px">Inbjudningar</div>${invList}</div>`:""}
      ${swList?`<div class="card"><div class="sublabel" style="margin-bottom:8px">Passbyten (arbetspass)</div>${swList}</div>`:""}
      ${st.data.kind === "ridskola" && !mine.length ? "" : `<div class="card">${list}</div>`}`;
    bindSwapButtons(document, ()=> renderRequests(stableId));
    document.querySelectorAll("[data-racc]").forEach(b=> b.onclick = async ()=>{ await resolveRequest(b.getAttribute("data-racc"), true); renderRequests(stableId); });
    document.querySelectorAll("[data-rdec]").forEach(b=> b.onclick = async ()=>{ await resolveRequest(b.getAttribute("data-rdec"), false); renderRequests(stableId); });
    document.querySelectorAll("[data-ivacc]").forEach(b=> b.onclick = async ()=>{ const id=b.getAttribute("data-ivacc"); await resolveInvite(id, true, myInv.find(v=> v.id===id)); renderRequests(stableId); });
    document.querySelectorAll("[data-ivdec]").forEach(b=> b.onclick = async ()=>{ await resolveInvite(b.getAttribute("data-ivdec"), false); renderRequests(stableId); });
  }catch(e){ el("reqShell").innerHTML = msg("Kunde inte hämta förfrågningar: " + (e.message||e), "err"); }
}

/* ============ Gruppchatt ============ */
let chatPollTimer = null;
let chatCtx = null;   // {stable, groups, profiles, myIds, memberRows}

async function renderChat(stableId){
  appEl.innerHTML = `<div id="chatShell"><div class="card"><div class="empty">Laddar chatt…</div></div></div>`;
  try{
    const st = await db.from("stable").select("*").eq("id", stableId).single(); if(st.error) throw st.error;
    if(st.data.kind === "ridskola"){
      el("chatShell").innerHTML = `<div class="card"><div class="empty">Chatt för ridskolor kommer i nästa steg.</div></div>`;
      return;
    }
    const g  = await db.from("duty_group").select("*").eq("stable_id", stableId).order("sort_order"); if(g.error) throw g.error;
    const pr = await db.from("profile").select("id,name,profile_member(email),horse(group_id)").eq("stable_id", stableId).order("created_at"); if(pr.error) throw pr.error;
    const myIds = pr.data.filter(p=> (p.profile_member||[]).some(m=> (m.email||"").toLowerCase() === session.email)).map(p=> p.id);
    const cm = await db.from("chat_member").select("group_id,profile_id");
    chatCtx = { stable: st.data, groups: g.data, profiles: pr.data, myIds, memberRows: cm.error ? [] : (cm.data||[]) };
    if(view.groupId) renderChatRoom(view.groupId);
    else renderChatList();
  }catch(e){
    el("chatShell").innerHTML = msg("Kunde inte öppna chatten: " + (e.message||e), "err");
  }
}

function amRegularIn(gid){
  return chatCtx.profiles.some(p=> chatCtx.myIds.includes(p.id) && (p.horse||[]).some(h=> h.group_id === gid));
}
function amInvitedIn(gid){
  return chatCtx.memberRows.some(r=> r.group_id === gid && chatCtx.myIds.includes(r.profile_id));
}
function mySenderProfile(gid){
  const reg = chatCtx.profiles.find(p=> chatCtx.myIds.includes(p.id) && (p.horse||[]).some(h=> h.group_id === gid));
  if(reg) return reg.id;
  const inv = chatCtx.memberRows.find(r=> r.group_id === gid && chatCtx.myIds.includes(r.profile_id));
  return inv ? inv.profile_id : null;
}

function renderChatList(){
  const mine = chatCtx.groups.filter(g=> amRegularIn(g.id) || amInvitedIn(g.id));
  const rows = mine.length ? mine.map(g=>`
    <button class="row" data-chat="${g.id}">
      <span class="cdot" style="background:${g.color||'#4e9e6e'}"></span>
      <div class="grow"><div class="nm">${esc(g.name)}</div></div>
      <span class="tagpill">${amRegularIn(g.id) ? "din grupp" : "inbjuden"}</span>
      <span class="chev">›</span>
    </button>`).join("")
    : `<div class="empty">Du är inte med i någon chatt än. Chatten följer din grupp — be admin koppla din profil till en grupp via en häst, eller bli inbjuden.</div>`;
  el("chatShell").innerHTML = `
    <div class="card schedtop">
      <div class="schedeyebrow">Chatt</div>
      <h1 class="schedname">${esc(chatCtx.stable.name)}</h1>
    </div>
    <div class="card"><div class="list">${rows}</div></div>`;
  document.querySelectorAll("[data-chat]").forEach(b=> b.onclick = ()=>{ view = { name:"chat", stableId: chatCtx.stable.id, groupId: b.getAttribute("data-chat") }; renderChatRoom(view.groupId); });
}

function renderChatRoom(gid){
  const g = chatCtx.groups.find(x=> x.id === gid);
  if(!g){ renderChatList(); return; }
  const canManage = amRegularIn(gid);
  el("chatShell").innerHTML = `
    <button class="backlink" id="chatBack">‹ Alla chattar</button>
    <div class="card" style="display:flex;align-items:center;gap:10px">
      <span class="cdot" style="background:${g.color||'#4e9e6e'}"></span>
      <div class="grow"><b>${esc(g.name)}</b></div>
      <button class="btn sm" id="chatMembersBtn">${ic("users")} Medlemmar</button>
    </div>
    <div class="card" id="chatMembersCard" style="display:none"></div>
    <div class="card">
      <div class="chatmsgs" id="msgList"><div class="empty">Laddar…</div></div>
      <div class="chatinput">
        <input type="text" id="msgInput" placeholder="Skriv ett meddelande…" maxlength="500">
        <button class="btn primary" id="msgSend">Skicka</button>
      </div>
    </div>`;
  el("chatBack").onclick = ()=>{ view = { name:"chat", stableId: chatCtx.stable.id }; render(); };
  el("chatMembersBtn").onclick = ()=>{ const c = el("chatMembersCard"); const show = c.style.display === "none"; c.style.display = show ? "" : "none"; if(show) renderChatMembers(gid); };
  el("msgSend").onclick = ()=> sendChatMsg(gid);
  el("msgInput").addEventListener("keydown", e=>{ if(e.key === "Enter") sendChatMsg(gid); });
  loadChatMsgs(gid, true);
  chatPollTimer = setInterval(()=> loadChatMsgs(gid, false), 5000);
}

async function loadChatMsgs(gid, first){
  const listEl = el("msgList"); if(!listEl) return;
  const r = await db.from("chat_message").select("id,body,created_at,profile_id,profile(name)")
    .eq("group_id", gid).order("created_at",{ascending:true}).limit(300);
  if(r.error){ if(first) listEl.innerHTML = msg("Kunde inte hämta meddelanden: " + r.error.message, "err"); return; }
  const nearBottom = listEl.scrollHeight - listEl.scrollTop - listEl.clientHeight < 80;
  if(!r.data.length){ listEl.innerHTML = `<div class="empty">Inga meddelanden än — säg hej! 👋</div>`; return; }
  listEl.innerHTML = r.data.map(mrow=>{
    const mine = chatCtx.myIds.includes(mrow.profile_id);
    const d = new Date(mrow.created_at);
    const time = `${String(d.getHours()).padStart(2,"0")}:${String(d.getMinutes()).padStart(2,"0")} ${d.getDate()}/${d.getMonth()+1}`;
    return `<div class="cmsg${mine?" me":""}">
      ${mine ? "" : `<div class="who">${esc((mrow.profile&&mrow.profile.name)||"?")}</div>`}
      <div>${esc(mrow.body)}</div>
      <div class="when">${time}</div>
    </div>`;
  }).join("");
  if(first || nearBottom) listEl.scrollTop = listEl.scrollHeight;
}

async function sendChatMsg(gid){
  const inp = el("msgInput"); const body = (inp.value||"").trim();
  if(!body) return;
  const sender = mySenderProfile(gid);
  if(!sender){ alert("Du är inte medlem i den här chatten."); return; }
  inp.value = "";
  const r = await db.from("chat_message").insert({ stable_id: chatCtx.stable.id, group_id: gid, profile_id: sender, body });
  if(r.error){ alert("Kunde inte skicka: " + r.error.message); inp.value = body; return; }
  await loadChatMsgs(gid, true);
}

async function renderChatMembers(gid){
  const card = el("chatMembersCard"); if(!card) return;
  const cm = await db.from("chat_member").select("group_id,profile_id");
  chatCtx.memberRows = cm.error ? chatCtx.memberRows : (cm.data||[]);
  const canManage = amRegularIn(gid);
  const regulars = chatCtx.profiles.filter(p=> (p.horse||[]).some(h=> h.group_id === gid));
  const invitedIds = chatCtx.memberRows.filter(r=> r.group_id === gid).map(r=> r.profile_id);
  const invited = chatCtx.profiles.filter(p=> invitedIds.includes(p.id));
  const inChat = new Set([...regulars.map(p=>p.id), ...invited.map(p=>p.id)]);
  const invitable = chatCtx.profiles.filter(p=> !inChat.has(p.id));
  card.innerHTML = `
    <div class="sublabel" style="margin-top:0">Ordinarie (${esc((chatCtx.groups.find(x=>x.id===gid)||{}).name||"")})</div>
    ${regulars.map(p=>`<div class="tleaf">${ic("user")} ${esc(p.name)}</div>`).join("") || `<div class="tleaf tmuted">Inga än</div>`}
    <div class="sublabel">Inbjudna</div>
    ${invited.map(p=>`<div class="tleaf">${ic("user")} ${esc(p.name)}${(canManage || chatCtx.myIds.includes(p.id))?`<span class="tbtns"><button class="x" data-kick="${p.id}" title="Ta bort ur chatten">${ic("x")}</button></span>`:""}</div>`).join("") || `<div class="tleaf tmuted">Inga inbjudna</div>`}
    ${canManage && invitable.length ? `
      <div class="sublabel">Bjud in</div>
      <div class="addhorse"><select id="invSel">${invitable.map(p=>`<option value="${p.id}">${esc(p.name)}</option>`).join("")}</select>
      <button class="btn sm" id="invBtn">+ Bjud in</button></div>` : ""}`;
  card.querySelectorAll("[data-kick]").forEach(b=> b.onclick = async ()=>{
    const pid = b.getAttribute("data-kick");
    const p = chatCtx.profiles.find(x=> x.id === pid);
    if(!(await confirmDialog(`Ta bort ${p ? p.name : "profilen"} ur chatten?`))) return;
    await db.from("chat_member").delete().eq("group_id", gid).eq("profile_id", pid);
    renderChatMembers(gid);
  });
  const invBtn = el("invBtn");
  if(invBtn) invBtn.onclick = async ()=>{
    const pid = el("invSel").value;
    const r = await db.from("chat_member").insert({ group_id: gid, profile_id: pid, added_by: mySenderProfile(gid) });
    if(r.error){ alert("Kunde inte bjuda in: " + r.error.message); return; }
    renderChatMembers(gid);
  };
}

/* ============ RIDSKOLA ============ */
let scOpen = {};
let scData = null;
let scStableId = null;
const RS_WD = [null,"Måndag","Tisdag","Onsdag","Torsdag","Fredag","Lördag","Söndag"];
const PERM_DESC = { none:"Ser scheman och inställningar, ändrar inget", teacher:"Ändrar lektioner, elever och hästar", chef:"Ändrar arbetspass och bemanning" };
const RS_DUR = [30,45,60,75,90,120];
const TASK_DUR = [15,30,45,60,90,120,180,240];

function rsMyStudentIds(){
  return new Set((scData.students||[]).filter(s=> (s.rs_student_member||[]).some(m=> (m.email||"").toLowerCase() === session.email)).map(s=> s.id));
}
function rsMyStaffIds(){
  return new Set((scData.staff||[]).filter(f=> (f.rs_staff_member||[]).some(m=> (m.email||"").toLowerCase() === session.email)).map(f=> f.id));
}
function rsMyInstrIds(){
  return new Set((scData.instructors||[]).filter(i=> (i.rs_instructor_member||[]).some(m=> (m.email||"").toLowerCase() === session.email)).map(i=> i.id));
}
function scMineLesson(g){
  const ms = rsMyStudentIds(), mf = rsMyStaffIds(), mi = rsMyInstrIds();
  return (scData.gstud||[]).some(x=> x.group_id===g.id && ms.has(x.student_id))
      || (scData.gstaff||[]).some(x=> x.group_id===g.id && mf.has(x.staff_id))
      || (scData.ginstr||[]).some(x=> x.group_id===g.id && mi.has(x.instructor_id));
}
function scMineTask(t){
  const mf = rsMyStaffIds();
  return (scData.taskStaff||[]).some(x=> x.task_id===t.id && mf.has(x.staff_id))
      || (scWeekSwap||[]).some(s=> s.task_id===t.id && swapActive(s) && mf.has(s.taker_staff));
}
/* Liten förklaring i schemarutans fot till färgen på egna block (onödig när man filtrerat bort allt annat) */
function scLegend(anyMine){
  const host = el("scsLegend"); if(!host) return;
  host.innerHTML = (!anyMine || scOnlyMine) ? ""
    : `<div class="scleg"><span class="legdot"></span>Grönt = ${scSchedMode==="lessons"?"lektioner du är med på":"pass du är schemalagd på"}</div>`;
}
/* Jobbar jag arbetspasset just det datumet? (godkända passbyten räknas) */
function scMineTaskOn(t, dISO){
  const mf = rsMyStaffIds();
  const base = (scData.taskStaff||[]).filter(x=> x.task_id===t.id).map(x=> x.staff_id);
  const eff = taskEffectiveStaff(base, (scWeekSwap||[]).filter(s=> s.task_id===t.id && s.work_date===dISO && swapActive(s)));
  return [...eff].some(id=> mf.has(id));
}

/* ---- Passbyten på arbetspass ----
   Ett godkänt byte flyttar passet bara det datumet — arbetspasset
   (rs_task_staff) står kvar orört. Flödet: någon erbjuder bort sitt pass
   (eller ber om att ta över någons), kollegan svarar i klockan och
   chef/admin godkänner — om inte frågan redan kom från en chef. */
function swapActive(s){ return s.status === "accepted" && s.chef_status === "approved"; }
function swapWaiting(s){ return s.status === "pending" || (s.status === "accepted" && s.chef_status === "pending"); }
function swapRecipient(s){ return s.asked_by === "giver" ? s.taker_staff : s.giver_staff; }
/* Vilka jobbar passet ett visst datum: personalen, minus bortbytta plus inbytta (i tidsordning) */
function taskEffectiveStaff(baseIds, activeSwaps){
  const out = new Set(baseIds);
  [...activeSwaps].sort((a,b)=> (a.created_at||"") < (b.created_at||"") ? -1 : 1)
    .forEach(s=>{ out.delete(s.giver_staff); out.add(s.taker_staff); });
  return out;
}
function swapAsker(s){ return s.asked_by === "giver" ? s.giver_staff : s.taker_staff; }

/* Text + knappar för ett passbyte. ctx: {name(id), mineIds:Set, isChef, canCancel} */
function swapNote(s, ctx){
  const g = ctx.name(s.giver_staff), t = ctx.name(s.taker_staff);
  const iAmRecipient = ctx.mineIds.has(swapRecipient(s));
  const iAmAsker = ctx.mineIds.has(swapAsker(s));
  let txt, btns = "";
  if(s.status === "pending"){
    txt = s.asked_by === "giver"
      ? `<b>${esc(g)}</b> vill ge bort passet till <b>${esc(t)}</b> — väntar på svar`
      : `<b>${esc(t)}</b> vill ta över <b>${esc(g)}</b>s pass — väntar på svar`;
    if(iAmRecipient) btns = `<button class="btn primary sm" data-swacc="${s.id}">${s.asked_by === "giver" ? "Ta över passet" : "Ja, byt"}</button><button class="btn sm" data-swdec="${s.id}">Avböj</button>`;
    else if(iAmAsker && ctx.canCancel) btns = `<button class="btn sm" data-swdel="${s.id}">Ångra</button>`;
  } else if(s.status === "accepted" && s.chef_status === "pending"){
    txt = `Passbyte <b>${esc(g)}</b> → <b>${esc(t)}</b> — väntar på godkännande`;
    if(ctx.isChef && !iAmRecipient && !iAmAsker) btns = `<button class="btn primary sm" data-swok="${s.id}">Godkänn</button><button class="btn sm" data-swno="${s.id}">Neka</button>`;
  } else if(swapActive(s)){
    txt = `Passbyte <b>${esc(g)}</b> → <b>${esc(t)}</b> · godkänt`;
  } else return "";
  return `<div class="swapnote">🔁 ${txt}${s.note?`<div class="meta2">${esc(s.note)}</div>`:""}${btns?`<div class="notifbtns">${btns}</div>`:""}</div>`;
}

async function respondSwap(id, accept){
  const r = await db.rpc("respond_task_swap", { p_swap: id, p_accept: accept });
  if(r.error){ alert(r.error.message + " (har db/passbyte.sql körts?)"); return false; }
  await refreshBellCount();
  return true;
}
async function approveSwap(id, ok){
  const r = await db.rpc("approve_task_swap", { p_swap: id, p_approve: ok });
  if(r.error){ alert(r.error.message); return false; }
  await refreshBellCount();
  return true;
}
async function cancelSwap(id){
  if(!(await confirmDialog("Ångra förfrågan om passbyte?", { okText:"Ja, ångra" }))) return false;
  const r = await db.from("rs_task_swap").delete().eq("id", id);
  if(r.error){ alert("Kunde inte ångra: " + r.error.message); return false; }
  await refreshBellCount();
  return true;
}
/* Kopplar knapparna i swapNote var de än renderas (schemapanel, Mina arbetspass, klockan, förfrågningar) */
function bindSwapButtons(host, after){
  const go = async fn=>{ if(await fn()) { if(after) after(); } };
  const wire = (attr, fn)=> host.querySelectorAll("["+attr+"]").forEach(b=> b.onclick = (e)=>{
    e.stopPropagation(); go(()=> fn(b.getAttribute(attr)));
  });
  wire("data-swacc", id=> respondSwap(id, true));
  wire("data-swdec", id=> respondSwap(id, false));
  wire("data-swok",  id=> approveSwap(id, true));
  wire("data-swno",  id=> approveSwap(id, false));
  wire("data-swdel", id=> cancelSwap(id));
}

/* Erbjud bort passet (mode "give") eller be om att ta över det (mode "take") */
function swapDialog(mode, o){
  const ov = document.createElement("div"); ov.className = "modal-ov";
  const d = new Date(o.dISO + "T00:00:00");
  const when = `${RS_WD[((d.getDay()+6)%7)+1].toLowerCase()} ${d.getDate()}/${d.getMonth()+1}`;
  const pick = mode === "give"
    ? `<div class="field"><label class="fld">Vem erbjuder du passet till?</label>
         <select id="sw_to">${o.candidates.map(c=> `<option value="${c.id}">${esc(c.name)}${c.busy?" · "+esc(c.busy):""}</option>`).join("")}</select></div>`
    : "";
  ov.innerHTML = `<div class="modal"><h3>${mode === "give" ? "Erbjud bort passet" : "Ta över passet"}</h3>
    <p>${esc(o.taskName)} · ${esc(when)}${mode === "take" ? ` — passet är <b>${esc(o.giverName)}</b>s` : ""}</p>
    ${mode === "give" && !o.candidates.length ? `<div class="msg warn">Ingen annan personal att erbjuda passet till.</div>` : pick}
    <div class="field"><label class="fld">Meddelande (valfritt)</label><input type="text" id="sw_note" maxlength="120"></div>
    <div id="sw_msg"></div>
    <div class="modal-btns"><button class="btn" id="sw_cancel">Avbryt</button>
      ${mode === "give" && !o.candidates.length ? "" : `<button class="btn primary" id="sw_send">Skicka förfrågan</button>`}</div></div>`;
  document.body.appendChild(ov);
  ov.querySelector("#sw_cancel").onclick = ()=> ov.remove();
  const send = ov.querySelector("#sw_send");
  if(send) send.onclick = async ()=>{
    const takerId = mode === "give" ? el("sw_to").value : o.takerId;
    const giverId = o.giverId;
    if(!takerId || !giverId || takerId === giverId){ el("sw_msg").innerHTML = msg("Välj en annan person.", "err"); return; }
    const r = await db.from("rs_task_swap").insert({ stable_id: o.stableId, task_id: o.taskId, work_date: o.dISO,
      giver_staff: giverId, taker_staff: takerId, asked_by: mode === "give" ? "giver" : "taker",
      note: (el("sw_note").value||"").trim() || null });
    if(r.error){
      const dup = (r.error.code === "23505") || /duplicate/i.test(r.error.message||"");
      el("sw_msg").innerHTML = msg(dup ? "Det finns redan en väntande förfrågan om det här passet."
        : "Kunde inte skicka: " + r.error.message + " (har db/passbyte.sql körts?)", "err");
      return;
    }
    ov.remove();
    await refreshBellCount();
    const toName = mode === "give"
      ? ((o.candidates.find(c=> c.id === takerId)||{}).name || "kollegan")
      : o.giverName;
    infoDialog(`Förfrågan är skickad till ${toName}. De svarar i sin notisklocka, och sedan godkänner chef eller admin bytet.`, "Förfrågan skickad");
    if(o.done) o.done();
  };
}
/* Arbetstidsvarningar för ett arbetspass: för långt pass, dubbelbokning och dygnsvila under 11 h */
function taskWorkWarnings(tk){
  const warns = [];
  if((tk.duration_min||0) > 600) warns.push(`Passet är ${(tk.duration_min/60).toFixed(1).replace(".0","")} timmar långt — över 10 timmar`);
  const staffIds = (scData.taskStaff||[]).filter(x=> x.task_id === tk.id).map(x=> x.staff_id);
  staffIds.forEach(fid=>{
    const f = (scData.staff||[]).find(x=> x.id === fid); if(!f) return;
    const mine = (scData.taskStaff||[]).filter(x=> x.staff_id === fid)
      .map(x=> (scData.tasks||[]).find(t2=> t2.id === x.task_id)).filter(Boolean);
    mine.forEach(o=>{
      if(o.id === tk.id) return;
      const s1 = timeKey(tk), e1 = s1 + (tk.duration_min||60);
      const s2 = timeKey(o), e2 = s2 + (o.duration_min||60);
      if(o.weekday === tk.weekday){
        if(s1 < e2 && s2 < e1) warns.push(`${f.name} är dubbelbokad: ${o.name} (${o.start_time}–${rsEndTime(o.start_time,o.duration_min)}) samma dag`);
        return;
      }
      // dygnsvila: passet dagen innan → detta pass (och tvärtom)
      const dayDiff = (tk.weekday - o.weekday + 7) % 7;
      if(dayDiff === 1){
        const rest = 1440 - e2 + s1;
        if(rest < 660) warns.push(`${f.name} får bara ${Math.floor(rest/60)} h ${rest%60 ? (rest%60)+" min " : ""}vila mellan ${o.name} (slut ${rsEndTime(o.start_time,o.duration_min)}) och det här passet — under 11 h dygnsvila`);
      } else if(dayDiff === 6){
        const rest = 1440 - e1 + s2;
        if(rest < 660) warns.push(`${f.name} får bara ${Math.floor(rest/60)} h ${rest%60 ? (rest%60)+" min " : ""}vila mellan det här passet (slut ${rsEndTime(tk.start_time,tk.duration_min)}) och ${o.name} dagen efter — under 11 h dygnsvila`);
      }
    });
  });
  return [...new Set(warns)];
}
function rsEndTime(start, dur){
  const m = /^(\d{1,2}):(\d{2})/.exec(start||""); if(!m) return "";
  const t = (+m[1])*60 + (+m[2]) + (dur||0);
  return String(Math.floor(t/60)%24).padStart(2,"0") + ":" + String(t%60).padStart(2,"0");
}

async function renderSchool(stableId){
  scStableId = stableId; scOpen = {};
  appEl.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center">
      <button class="backlink" id="scBack">‹ Mina stall</button>
      <button class="backlink" id="scSched" style="color:var(--accent)">Öppna schemat ›</button>
    </div>
    <div class="card schedtop"><div id="scHead"><h1 class="title">Laddar…</h1></div></div>
    <div class="card" id="scTreeCard"><div class="empty">Laddar…</div></div>`;
  el("scBack").onclick = ()=>{ view={name:"home",stableId:null}; render(); };
  el("scSched").onclick = ()=>{ weekStart2 = startOfWeek(new Date()); view={name:"schedule",stableId}; render(); };
  try{
    const st = await db.from("stable").select("*").eq("id", stableId).single(); if(st.error) throw st.error;
    curOrgId = st.data.org_id || null;
    curPerm = await mySchoolPerm(stableId);
    curAdmin = curPerm === "admin";
    const permLbl = { admin:'<span class="pill">Admin</span>', teacher:'<span class="pill">Ridlärare</span>', chef:'<span class="pill">Chef</span>', member:'<span class="muted">Medlem</span>' };
    el("scHead").innerHTML = `<div class="schedeyebrow">Inställningar · Ridskola</div><h1 class="schedname">${esc(st.data.name)}</h1>
      <p class="sub" style="margin:0">${permLbl[curPerm]||permLbl.member}</p>`;
    scData = { stable: st.data };
    await reloadSchool();
    renderUnitDanger("scTreeCard", stableId, st.data.name);
  }catch(e){ el("scHead").innerHTML = msg("Kunde inte öppna ridskolan: " + (e.message||e), "err"); }
}

async function reloadSchool(){
  const sid = scStableId;
  const [g,c,s,h,l,gs,sf,sfc,gh,gf,tk,tf,hc,ec,ins,gi,sn,pl] = await Promise.all([
    db.from("rs_group").select("*, category(name)").eq("stable_id", sid).order("weekday").order("start_time"),
    db.from("category").select("*").eq("stable_id", sid).order("sort_order"),
    db.from("rs_student").select("id,name,description,category_id,rs_student_member(email)").eq("stable_id", sid).order("name"),
    db.from("rs_horse").select("*").eq("stable_id", sid).order("name"),
    db.from("rs_leader").select("*"),
    db.from("rs_group_student").select("*"),
    db.from("rs_staff").select("id,name,description,perm,category_id,rs_staff_category(name),rs_staff_member(email)").eq("stable_id", sid).order("name"),
    db.from("rs_staff_category").select("*").eq("stable_id", sid).order("sort_order"),
    db.from("rs_group_horse").select("*"),
    db.from("rs_group_staff").select("*"),
    db.from("rs_task").select("*").eq("stable_id", sid).order("weekday").order("start_time"),
    db.from("rs_task_staff").select("*"),
    db.from("rs_horse_category").select("*").eq("stable_id", sid).order("sort_order"),
    db.from("rs_student_category").select("*").eq("stable_id", sid).order("sort_order"),
    db.from("rs_instructor").select("id,name,description,rs_instructor_member(email)").eq("stable_id", sid).order("name"),
    db.from("rs_group_instructor").select("*"),
    db.from("rs_student_note").select("*"),
    db.from("rs_place").select("*").eq("stable_id", sid).order("sort_order")
  ]);
  const err = g.error || c.error || s.error || h.error;
  if(err){ el("scTreeCard").innerHTML = msg("Kunde inte hämta data: " + err.message + " (har du kört db/ridskola.sql?)", "err"); return; }
  scData = { stable: scData.stable, groups: g.data, cats: c.data, students: s.data, horses: h.data,
             leaders: l.error?[]:l.data, gstud: gs.error?[]:gs.data,
             staff: sf.error?[]:sf.data, staffCats: sfc.error?[]:sfc.data,
             ghorse: gh.error?[]:gh.data, gstaff: gf.error?[]:gf.data,
             tasks: tk.error?[]:tk.data, taskStaff: tf.error?[]:tf.data,
             horseCats: hc.error?[]:hc.data, studentCats: ec.error?[]:ec.data,
             instructors: ins.error?[]:ins.data, ginstr: gi.error?[]:gi.data,
             studentNotes: sn.error?[]:sn.data, places: pl.error?[]:pl.data };
  renderSchoolTree();
}

function scCaret(k){ return `<span class="caret">${scOpen[k]?"▾":"▸"}</span>`; }
/* Sektionsram med egen färgnyans per förstanivå-sektion i trädet */
function tSect(hue){ return `<div class="tsect" style="background:hsla(${hue},30%,45%,.06);border-color:hsla(${hue},30%,40%,.22)">`; }
/* Beskrivning: visas som textarea vid redigering först när man valt "Lägg till beskrivning" (eller om en redan finns) */
function scDescField(key, val){
  if((val||"").trim() || scOpen["desc_"+key])
    return `<div class="field"><label class="fld">Beskrivning</label><textarea id="scdesc_${key}" rows="2" placeholder="t.ex. rädd för stora hästar">${esc(val||"")}</textarea></div>`;
  return `<div class="field"><button class="btn sm" type="button" data-scdesc="${key}">+ Lägg till beskrivning</button></div>`;
}
function scDescVal(key){ const n = el("scdesc_"+key); if(!n) return undefined; const v = n.value.trim(); return v || null; }
/* Lägg till-kontroller (select/input) visas först när man klickat på lägg till-raden */
function scAddCtl(showKey, label, controlHtml, lvl){
  if(!scOpen[showKey])
    return `<div class="tleaf lvl${lvl}" data-scshow="${showKey}" style="color:var(--accent);cursor:pointer;font-weight:600">${ic("plus")} ${label}</div>`;
  return `<div class="addbox lvl${lvl}">
    <div class="addhead"><span>${esc(label)}</span><button class="x" data-schide="${showKey}" title="Stäng">✕</button></div>
    <div class="addhorse">${controlHtml}</div>
  </div>`;
}
/* Tvåstegsval: kategori först (+ "Övriga" för okategoriserade), sedan person/häst/elev.
   Utan kategorier → platt lista som vanligt. */
let scPickMap = {};
function scCatPick(selId, items, cats, btnHtml){
  const usedCats = (cats||[]).filter(c=> items.some(i=> i.category_id === c.id));
  const loose = items.filter(i=> !usedCats.some(c=> c.id === i.category_id));
  const opts = list=> list.map(i=>`<option value="${i.id}">${esc(i.name)}</option>`).join("");
  if(!usedCats.length) return `<select id="${selId}">${opts(items)}</select>${btnHtml}`;
  const byCat = {};
  usedCats.forEach(c=> byCat[c.id] = items.filter(i=> i.category_id === c.id));
  if(loose.length) byCat["none"] = loose;
  scPickMap[selId] = byCat;
  const catO = usedCats.map(c=>`<option value="${c.id}">${esc(c.name)}</option>`).join("") + (loose.length?`<option value="none">Övriga</option>`:"");
  return `<select class="catpick" data-catfor="${selId}">${catO}</select><select id="${selId}">${opts(byCat[usedCats[0].id])}</select>${btnHtml}`;
}
function scDescLeaf(val, lvl){ return (val||"").trim() ? `<div class="tleaf lvl${lvl} tmuted tdesc">${esc(val)}</div>` : ""; }
/* Elevanteckningar bor i skyddade rs_student_note — syns bara för admin, ridlärare och elevens målsmän */
function scStudentNote(id){ const n = (scData.studentNotes||[]).find(x=> x.student_id === id); return n ? n.note : null; }
/* Litet redigeringsformulär för saker som bara har namn + beskrivning */
function scNameEditRow(kind, key, id, name, desc, lvl, withDesc){
  return `<div class="editrow lvl${lvl}">
    <div class="field"><label class="fld">Namn</label><input type="text" id="scn_${key}" value="${esc(name)}"></div>
    ${withDesc === false ? "" : scDescField(key, desc)}
    <div class="editbtns"><button class="btn primary sm" data-scs="${kind}:${id}">Spara</button><button class="btn sm" data-scc="${key}">Avbryt</button></div>
  </div>`;
}
function scGroupMeta(g){
  const cat = g.category && g.category.name;
  const n = scData.gstud.filter(x=> x.group_id === g.id).length;
  const pl = g.place_id ? (((scData.places||[]).find(p=> p.id === g.place_id)||{}).name) : null;
  return `${RS_WD[g.weekday]||"?"} ${g.start_time}–${rsEndTime(g.start_time, g.duration_min)} · ${n}/${g.capacity} elever · häst byts efter ${g.horse_rotation} ggr${cat?` · ${cat}`:""}${pl?` · ${pl}`:""}`;
}
/* Krockregel: lektioner som överlappar i tid samma dag varnas — om de har samma plats eller om plats saknas */
function lessonConflicts(g){
  const s1 = timeKey(g), e1 = s1 + (g.duration_min||60);
  return (scData.groups||[]).filter(o=> o.id !== g.id && o.weekday === g.weekday).filter(o=>{
    const s2 = timeKey(o), e2 = s2 + (o.duration_min||60);
    if(!(s1 < e2 && s2 < e1)) return false;
    if(g.place_id && o.place_id && g.place_id !== o.place_id) return false;
    return true;
  });
}

function renderSchoolTree(){
  const host = el("scTreeCard"); if(!host || !scData.groups) return;
  const myStud = rsMyStudentIds();
  const t = [];
  scPickMap = {};
  const canL = curPerm==="admin" || curPerm==="teacher";   // lektioner, elever, hastar
  const canT = curPerm==="admin" || curPerm==="chef";      // arbetspass
  const canP = curPerm==="admin";                          // personal, ledare
  let can = canL;
  // GRUPPER
  t.push(tSect(150));
  t.push(`<div class="trow lvl0" data-t="grupper">${ic("calendar")} Lektioner ${scCaret("grupper")}</div>`);
  if(scOpen.grupper){
    scData.groups.forEach(g=>{
      const key = "g_"+g.id;
      const hu = null;
      if(can && scOpen["edit_"+g.id]){
        const catO = `<option value="">Ingen kategori</option>` + scData.cats.map(c=>`<option value="${c.id}"${c.id===g.category_id?" selected":""}>${esc(c.name)}</option>`).join("");
        const wdO = [1,2,3,4,5,6,7].map(w=>`<option value="${w}"${w===g.weekday?" selected":""}>${RS_WD[w]}</option>`).join("");
        const tO = TIME_OPTIONS.map(x=>`<option value="${x}"${x===g.start_time?" selected":""}>${x}</option>`).join("");
        const dO = RS_DUR.map(d=>`<option value="${d}"${d===g.duration_min?" selected":""}>${d} min</option>`).join("");
        const capO = (()=>{let o="";for(let i=1;i<=20;i++)o+=`<option value="${i}"${i===g.capacity?" selected":""}>${i}</option>`;return o;})();
        const rotO = (()=>{let o="";for(let i=1;i<=10;i++)o+=`<option value="${i}"${i===g.horse_rotation?" selected":""}>${i} gång${i>1?"er":""}</option>`;return o;})();
        t.push(`<div class="editrow lvl1">
          <div class="field"><label class="fld">Namn</label><input type="text" id="scg_name_${g.id}" value="${esc(g.name)}"></div>
          <div class="field"><label class="fld">Kategori</label><select id="scg_cat_${g.id}">${catO}</select></div>
          <div class="field"><label class="fld">Veckodag</label><select id="scg_wd_${g.id}">${wdO}</select></div>
          <div class="field"><label class="fld">Starttid</label><select id="scg_time_${g.id}">${tO}</select></div>
          <div class="field"><label class="fld">Längd</label><select id="scg_dur_${g.id}">${dO}</select></div>
          <div class="field"><label class="fld">Antal platser</label><select id="scg_cap_${g.id}">${capO}</select></div>
          <div class="field"><label class="fld">Hästbyte efter</label><select id="scg_rot_${g.id}">${rotO}</select></div>
          <div class="field"><label class="fld">Plats</label><select id="scg_place_${g.id}"><option value="">Ingen plats</option>${(scData.places||[]).map(p=>`<option value="${p.id}"${p.id===g.place_id?" selected":""}>${esc(p.name)}</option>`).join("")}</select></div>
          <div class="field"><label class="fld">Ledare</label><select id="scg_led_${g.id}"><option value="nej"${!g.has_leaders?" selected":""}>Nej</option><option value="ja"${g.has_leaders?" selected":""}>Ja</option></select></div>
          ${scDescField(g.id, g.description)}
          <div class="editbtns"><button class="btn primary sm" data-scs="group:${g.id}">Spara</button><button class="btn sm" data-scc="${g.id}">Avbryt</button></div>
        </div>`);
      } else {
        const btns = can ? `<span class="tbtns"><button class="x" data-sce="${g.id}" title="Ändra">${ic("pencil")}</button><button class="x" data-scd="group:${g.id}" title="Ta bort">${ic("x")}</button></span>` : "";
        t.push(`<div class="trow lvl1 titem" data-t="${key}">${esc(g.name)} ${scCaret(key)}${btns}</div>`);
        t.push(`<div class="tleaf lvl2 tmuted">${esc(scGroupMeta(g))}</div>`);
        t.push(scDescLeaf(g.description, 2));
      }
      if(scOpen[key]){
        // Personal kopplad till lektionen
        const gstf = (scData.gstaff||[]).filter(x=> x.group_id === g.id).map(x=> (scData.staff||[]).find(f=> f.id === x.staff_id)).filter(Boolean);
        t.push(`<div class="tleaf lvl2 tmuted" style="font-weight:700">Personal</div>`);
        gstf.forEach(f=> t.push(`<div class="tleaf lvl2">${ic("user")} ${esc(f.name)}${can?`<span class="tbtns"><button class="x" data-scd="gstaff:${g.id}|${f.id}" title="Ta bort från lektionen">${ic("x")}</button></span>`:""}</div>`));
        if(!gstf.length) t.push(`<div class="tleaf lvl2 tmuted">Ingen personal kopplad än</div>`);
        if(can){
          // bara ridlärare kan läggas på lektioner — stallpersonal hör till arbetspassen
          const freeF = (scData.staff||[]).filter(f=> f.perm === "teacher" && !gstf.some(x=> x.id === f.id));
          if(freeF.length) t.push(scAddCtl("addsel_gstaff_"+g.id, "Lägg till ridlärare",
            scCatPick("scin_gstaff_"+g.id, freeF, scData.staffCats, `<button class="btn sm" data-sca="gstaff:${g.id}">Lägg till</button>`), 2));
        }
        // Elever
        const inGroup = scData.gstud.filter(x=> x.group_id === g.id).map(x=> x.student_id);
        t.push(`<div class="tleaf lvl2 tmuted" style="font-weight:700">Elever (${inGroup.length}/${g.capacity})</div>`);
        inGroup.forEach(sid=>{
          const s = scData.students.find(x=> x.id === sid); if(!s) return;
          t.push(`<div class="tleaf lvl2">${ic("user")} ${esc(s.name)}${myStud.has(s.id)?` <span class="tagpill">din</span>`:""}${can?`<span class="tbtns"><button class="x" data-scd="gstud:${g.id}|${s.id}" title="Ta bort från lektionen">${ic("x")}</button></span>`:""}</div>`);
        });
        if(can){
          const free = scData.students.filter(s=> !inGroup.includes(s.id));
          if(free.length) t.push(scAddCtl("addsel_gstud_"+g.id, "Lägg till elev",
            scCatPick("scin_gstud_"+g.id, free, scData.studentCats, `<button class="btn sm" data-sca="gstud:${g.id}">Lägg till</button>`), 2));
        }
        // Hästar kopplade till lektionen (styr hästvalet i schemat)
        const ghs = (scData.ghorse||[]).filter(x=> x.group_id === g.id).map(x=> scData.horses.find(h=> h.id === x.horse_id)).filter(Boolean);
        t.push(`<div class="tleaf lvl2 tmuted" style="font-weight:700">Hästar</div>`);
        ghs.forEach(h=> t.push(`<div class="tleaf lvl2">${esc(h.name)}${can?`<span class="tbtns"><button class="x" data-scd="ghorse:${g.id}|${h.id}" title="Ta bort från lektionen">${ic("x")}</button></span>`:""}</div>`));
        if(!ghs.length) t.push(`<div class="tleaf lvl2 tmuted">Inga kopplade — alla hästar kan väljas i schemat</div>`);
        if(can){
          const freeH = scData.horses.filter(h=> !ghs.some(x=> x.id === h.id));
          if(freeH.length) t.push(scAddCtl("addsel_ghorse_"+g.id, "Lägg till häst",
            scCatPick("scin_ghorse_"+g.id, freeH, scData.horseCats, `<button class="btn sm" data-sca="ghorse:${g.id}">Lägg till</button>`), 2));
        }
        // Ledare (från ledarlistan) — visas bara om lektionen har ledare = ja
        if(g.has_leaders){
          const gld = (scData.ginstr||[]).filter(x=> x.group_id === g.id).map(x=> (scData.instructors||[]).find(i=> i.id === x.instructor_id)).filter(Boolean);
          t.push(`<div class="tleaf lvl2 tmuted" style="font-weight:700">Ledare</div>`);
          gld.forEach(i=> t.push(`<div class="tleaf lvl2">${ic("user")} ${esc(i.name)}${can?`<span class="tbtns"><button class="x" data-scd="ginstr:${g.id}|${i.id}" title="Ta bort från lektionen">${ic("x")}</button></span>`:""}</div>`));
          if(!gld.length) t.push(`<div class="tleaf lvl2 tmuted">Ingen ledare vald än${(scData.instructors||[]).length?"":" — skapa ledare längst ner under Ledare"}</div>`);
          if(can){
            const freeI = (scData.instructors||[]).filter(i=> !gld.some(x=> x.id === i.id));
            if(freeI.length) t.push(scAddCtl("addsel_ginstr_"+g.id, "Lägg till ledare",
              `<select id="scin_ginstr_${g.id}">${freeI.map(i=>`<option value="${i.id}">${esc(i.name)}</option>`).join("")}</select><button class="btn sm" data-sca="ginstr:${g.id}">Lägg till</button>`, 2));
          }
        } else if(can){
          t.push(`<div class="tleaf lvl2 tmuted">Ledare: nej — slå på via pennan om lektionen ska ha ledare</div>`);
        }
      }
    });
    if(can){
      if(scOpen.add_group){
        const catO = `<option value="">Ingen kategori</option>` + scData.cats.map(c=>`<option value="${c.id}">${esc(c.name)}</option>`).join("");
        const wdO = [1,2,3,4,5,6,7].map(w=>`<option value="${w}">${RS_WD[w]}</option>`).join("");
        const tO = TIME_OPTIONS.map(x=>`<option value="${x}"${x==="17:00"?" selected":""}>${x}</option>`).join("");
        const dO = RS_DUR.map(d=>`<option value="${d}"${d===60?" selected":""}>${d} min</option>`).join("");
        const capO = (()=>{let o="";for(let i=1;i<=20;i++)o+=`<option value="${i}"${i===8?" selected":""}>${i}</option>`;return o;})();
        const rotO = (()=>{let o="";for(let i=1;i<=10;i++)o+=`<option value="${i}">${i} gång${i>1?"er":""}</option>`;return o;})();
        t.push(`<div class="editrow lvl1">
          <div class="field"><label class="fld">Ny lektion — namn</label><input type="text" id="scin_group" placeholder="t.ex. Nybörjare måndag"></div>
          <div class="field"><label class="fld">Kategori</label><select id="scin_gcat">${catO}</select></div>
          <div class="field"><label class="fld">Veckodag</label><select id="scin_gwd">${wdO}</select></div>
          <div class="field"><label class="fld">Starttid</label><select id="scin_gtime">${tO}</select></div>
          <div class="field"><label class="fld">Lektionslängd</label><select id="scin_gdur">${dO}</select></div>
          <div class="field"><label class="fld">Antal platser</label><select id="scin_gcap">${capO}</select></div>
          <div class="field"><label class="fld">Hästbyte efter</label><select id="scin_grot">${rotO}</select></div>
          <div class="field"><label class="fld">Plats</label><select id="scin_gplace"><option value="">Ingen plats</option>${(scData.places||[]).map(p=>`<option value="${p.id}">${esc(p.name)}</option>`).join("")}</select></div>
          <div class="editbtns"><button class="btn primary sm" data-sca="group">+ Skapa lektion</button><button class="btn sm" data-scca="group">Avbryt</button></div>
        </div>`);
      } else {
        t.push(`<div class="trow lvl1 titem" data-scadd="group" style="color:var(--accent)">${ic("plus")} Lägg till lektion</div>`);
      }
    }
    // Kategorier för grupper ligger under Grupper
    t.push(`<div class="trow lvl1" data-t="kats">${ic("tag")} Kategorier ${scCaret("kats")}</div>`);
    if(scOpen.kats){
      scData.cats.forEach(c=>{
        if(can && scOpen["edit_c_"+c.id]){ t.push(scNameEditRow("cat", "c_"+c.id, c.id, c.name, c.description, 2)); return; }
        t.push(`<div class="tleaf lvl2">${ic("tag")} ${esc(c.name)}${can?`<span class="tbtns"><button class="x" data-sce="c_${c.id}" title="Ändra">${ic("pencil")}</button><button class="x" data-scd="cat:${c.id}" title="Ta bort">${ic("x")}</button></span>`:""}</div>`);
        t.push(scDescLeaf(c.description, 3));
      });
      if(!scData.cats.length) t.push(`<div class="tleaf lvl2 tmuted">Inga kategorier än — t.ex. Nybörjare, Hopp, Dressyr</div>`);
      if(can) t.push(`<div class="addhorse lvl2"><input type="text" id="scin_cat" placeholder="Ny kategori"><button class="btn sm" data-sca="cat">+ Kategori</button></div>`);
    }
    // Platser för lektioner ligger också under Lektioner
    t.push(`<div class="trow lvl1" data-t="platser">${ic("home")} Platser ${scCaret("platser")}</div>`);
    if(scOpen.platser){
      (scData.places||[]).forEach(p=>{
        if(can && scOpen["edit_pl_"+p.id]){ t.push(scNameEditRow("place", "pl_"+p.id, p.id, p.name, p.description, 2)); return; }
        t.push(`<div class="tleaf lvl2">${ic("home")} ${esc(p.name)}${can?`<span class="tbtns"><button class="x" data-sce="pl_${p.id}" title="Ändra">${ic("pencil")}</button><button class="x" data-scd="place:${p.id}" title="Ta bort">${ic("x")}</button></span>`:""}</div>`);
        t.push(scDescLeaf(p.description, 3));
      });
      if(!(scData.places||[]).length) t.push(`<div class="tleaf lvl2 tmuted">Inga platser än — t.ex. Stora ridhuset, Utebanan</div>`);
      if(can) t.push(`<div class="addhorse lvl2"><input type="text" id="scin_place" placeholder="Ny plats"><button class="btn sm" data-sca="place">+ Plats</button></div>`);
    }
  }
  can = canL;
  // HÄSTAR
  t.push(`</div>`); t.push(tSect(95));
  t.push(`<div class="trow lvl0" data-t="hastar">${ic("home")} Hästar ${scCaret("hastar")}</div>`);
  if(scOpen.hastar){
    scData.horses.forEach(h=>{
      if(can && scOpen["edit_h_"+h.id]){
        const hcO = `<option value="">Ingen kategori</option>` + (scData.horseCats||[]).map(c=>`<option value="${c.id}"${c.id===h.category_id?" selected":""}>${esc(c.name)}</option>`).join("");
        t.push(`<div class="editrow lvl1">
          <div class="field"><label class="fld">Namn</label><input type="text" id="scn_h_${h.id}" value="${esc(h.name)}"></div>
          <div class="field"><label class="fld">Kategori</label><select id="scc_h_${h.id}">${hcO}</select></div>
          ${scDescField("h_"+h.id, h.description)}
          <div class="editbtns"><button class="btn primary sm" data-scs="horse:${h.id}">Spara</button><button class="btn sm" data-scc="h_${h.id}">Avbryt</button></div>
        </div>`);
        return;
      }
      const key = "hx_"+h.id;
      const hcat = ((scData.horseCats||[]).find(c=> c.id === h.category_id)||{}).name;
      t.push(`<div class="trow lvl1 titem" data-t="${key}">${esc(h.name)}${hcat?` <span class="tagpill">${esc(hcat)}</span>`:""} ${scCaret(key)}${can?`<span class="tbtns"><button class="x" data-sce="h_${h.id}" title="Ändra">${ic("pencil")}</button><button class="x" data-scd="horse:${h.id}" title="Ta bort">${ic("x")}</button></span>`:""}</div>`);
      t.push(scDescLeaf(h.description, 2));
      if(scOpen[key]){
        t.push(`<div class="tleaf lvl2 tmuted" style="font-weight:700">Lektioner</div>`);
        const hg = (scData.ghorse||[]).filter(x=> x.horse_id === h.id);
        hg.forEach(x=>{
          const g = scData.groups.find(g=> g.id === x.group_id); if(!g) return;
          t.push(`<div class="tleaf lvl2">${ic("calendar")} ${esc(g.name)}${can?`<span class="tbtns"><button class="x" data-scd="ghorse:${g.id}|${h.id}" title="Ta bort från lektionen">${ic("x")}</button></span>`:""}</div>`);
        });
        if(!hg.length) t.push(`<div class="tleaf lvl2 tmuted">Inga lektioner än</div>`);
        if(can){
          const freeG = scData.groups.filter(g=> !hg.some(x=> x.group_id === g.id));
          if(freeG.length) t.push(scAddCtl("addsel_hgrp_"+h.id, "Lägg till på lektion",
            `<select id="scin_hgrp_${h.id}">${freeG.map(g=>`<option value="${g.id}">${esc(g.name)}</option>`).join("")}</select><button class="btn sm" data-sca="hgrp:${h.id}">Lägg till</button>`, 2));
        }
      }
    });
    if(!scData.horses.length) t.push(`<div class="tleaf lvl1 tmuted">Inga hästar än</div>`);
    if(can) t.push(`<div class="addhorse lvl1"><input type="text" id="scin_horse" placeholder="Hästens namn"><button class="btn sm" data-sca="horse">+ Häst</button></div>`);
    t.push(`<div class="trow lvl1" data-t="hcats">${ic("tag")} Kategorier ${scCaret("hcats")}</div>`);
    if(scOpen.hcats){
      (scData.horseCats||[]).forEach(c=>{
        if(can && scOpen["edit_hc_"+c.id]){ t.push(scNameEditRow("hcat", "hc_"+c.id, c.id, c.name, c.description, 2)); return; }
        t.push(`<div class="tleaf lvl2">${ic("tag")} ${esc(c.name)}${can?`<span class="tbtns"><button class="x" data-sce="hc_${c.id}" title="Ändra">${ic("pencil")}</button><button class="x" data-scd="hcat:${c.id}" title="Ta bort">${ic("x")}</button></span>`:""}</div>`);
        t.push(scDescLeaf(c.description, 3));
      });
      if(!(scData.horseCats||[]).length) t.push(`<div class="tleaf lvl2 tmuted">Inga än — t.ex. Hopphäst, Nybörjarvänlig</div>`);
      if(can) t.push(`<div class="addhorse lvl2"><input type="text" id="scin_hcat" placeholder="Ny hästkategori"><button class="btn sm" data-sca="hcat">+ Kategori</button></div>`);
    }
  }
  can = canP;
  // PERSONAL
  t.push(`</div>`); t.push(tSect(172));
  t.push(`<div class="trow lvl0" data-t="personal">${ic("users")} Personal ${scCaret("personal")}</div>`);
  if(scOpen.personal){
    (scData.staff||[]).forEach(f=>{
      const key = "f_"+f.id;
      const cat = f.rs_staff_category && f.rs_staff_category.name;
      if(can && scOpen["edit_f_"+f.id]){
        const scO = `<option value="">Ingen kategori</option>` + (scData.staffCats||[]).map(c=>`<option value="${c.id}"${c.id===f.category_id?" selected":""}>${esc(c.name)}</option>`).join("");
        const pO = [["none","Stallpersonal"],["teacher","Ridlärare"],["chef","Chef"]]
          .map(([v,l])=>`<option value="${v}"${(f.perm||"none")===v?" selected":""}>${l}</option>`).join("");
        t.push(`<div class="editrow lvl1">
          <div class="field"><label class="fld">Namn</label><input type="text" id="scf_name_${f.id}" value="${esc(f.name)}"></div>
          <div class="field"><label class="fld">Kategori</label><select id="scf_cat_${f.id}">${scO}</select></div>
          <div class="field"><label class="fld">Behörighet</label><select id="scf_perm_${f.id}" data-permdesc="scf_permdesc_${f.id}">${pO}</select>
            <div id="scf_permdesc_${f.id}" class="roledesc">${PERM_DESC[f.perm||"none"]}</div></div>
          ${scDescField("f_"+f.id, f.description)}
          <div class="editbtns"><button class="btn primary sm" data-scs="staff:${f.id}">Spara</button><button class="btn sm" data-scc="f_${f.id}">Avbryt</button></div>
        </div>`);
      } else {
        const btns = can ? `<span class="tbtns"><button class="x" data-sce="f_${f.id}" title="Ändra">${ic("pencil")}</button><button class="x" data-scd="staff:${f.id}" title="Ta bort">${ic("x")}</button></span>` : "";
        const permPill = f.perm==="teacher" ? ` <span class="tagpill">ridlärare</span>` : f.perm==="chef" ? ` <span class="tagpill">chef</span>` : "";
        t.push(`<div class="trow lvl1 titem" data-t="${key}">${ic("user")} ${esc(f.name)}${cat?` <span class="tagpill">${esc(cat)}</span>`:""}${permPill} ${scCaret(key)}${btns}</div>`);
        t.push(scDescLeaf(f.description, 2));
      }
      if(scOpen[key]){
        (f.rs_staff_member||[]).forEach(m=> t.push(`<div class="tleaf lvl2">${ic("mail")} ${esc(m.email)}${can?`<span class="tbtns"><button class="x" data-scd="fmail:${f.id}|${encodeURIComponent(m.email)}" title="Ta bort">${ic("x")}</button></span>`:""}</div>`));
        if(!(f.rs_staff_member||[]).length) t.push(`<div class="tleaf lvl2 tmuted">Ingen mejl kopplad än</div>`);
        if(can) t.push(`<div class="addhorse lvl2"><input type="email" id="scin_fmail_${f.id}" placeholder="Lägg till mejladress"><button class="btn sm" data-sca="fmail:${f.id}">+ Mejl</button></div>`);
        t.push(`<div class="tleaf lvl2 tmuted" style="font-weight:700">Lektioner</div>`);
        const fg = (scData.gstaff||[]).filter(x=> x.staff_id === f.id);
        fg.forEach(x=>{
          const g = scData.groups.find(g=> g.id === x.group_id); if(!g) return;
          t.push(`<div class="tleaf lvl2">${ic("calendar")} ${esc(g.name)}${can?`<span class="tbtns"><button class="x" data-scd="gstaff:${g.id}|${f.id}" title="Ta bort från lektionen">${ic("x")}</button></span>`:""}</div>`);
        });
        if(!fg.length) t.push(`<div class="tleaf lvl2 tmuted">Inga lektioner än</div>`);
        if(can && f.perm === "teacher"){
          const freeG = scData.groups.filter(g=> !fg.some(x=> x.group_id === g.id));
          if(freeG.length) t.push(scAddCtl("addsel_fgrp_"+f.id, "Lägg till på lektion",
            `<select id="scin_fgrp_${f.id}">${freeG.map(g=>`<option value="${g.id}">${esc(g.name)}</option>`).join("")}</select><button class="btn sm" data-sca="fgrp:${f.id}">Lägg till</button>`, 2));
        }
        const ft = (scData.taskStaff||[]).filter(x=> x.staff_id === f.id);
        t.push(`<div class="tleaf lvl2 tmuted" style="font-weight:700">Arbetspass</div>`);
        ft.forEach(x=>{
          const tk = (scData.tasks||[]).find(t2=> t2.id === x.task_id); if(!tk) return;
          t.push(`<div class="tleaf lvl2">${ic("clock")} ${esc(tk.name)}${can?`<span class="tbtns"><button class="x" data-scd="tstaff:${tk.id}|${f.id}" title="Ta bort från arbetspasset">${ic("x")}</button></span>`:""}</div>`);
        });
        if(!ft.length) t.push(`<div class="tleaf lvl2 tmuted">Inga arbetspass än</div>`);
        if(can){
          const freeT = (scData.tasks||[]).filter(tk=> !ft.some(x=> x.task_id === tk.id));
          if(freeT.length) t.push(scAddCtl("addsel_ftask_"+f.id, "Lägg till på arbetspass",
            `<select id="scin_ftask_${f.id}">${freeT.map(tk=>`<option value="${tk.id}">${esc(tk.name)}</option>`).join("")}</select><button class="btn sm" data-sca="ftask:${f.id}">Lägg till</button>`, 2));
        }
      }
    });
    if(!(scData.staff||[]).length) t.push(`<div class="tleaf lvl1 tmuted">Ingen personal än</div>`);
    if(can){
      if(scOpen.add_staff){
        const scO = `<option value="">Ingen kategori</option>` + (scData.staffCats||[]).map(c=>`<option value="${c.id}">${esc(c.name)}</option>`).join("");
        t.push(`<div class="editrow lvl1">
          <div class="field"><label class="fld">Ny personal — namn</label><input type="text" id="scin_staff" placeholder="Namn"></div>
          <div class="field"><label class="fld">Mejladress</label><input type="email" id="scin_sfmail" placeholder="Valfritt — kan läggas till senare"></div>
          <div class="field"><label class="fld">Kategori</label><select id="scin_sfcat">${scO}</select></div>
          <div class="editbtns"><button class="btn primary sm" data-sca="staff">+ Lägg till personal</button><button class="btn sm" data-scca="staff">Avbryt</button></div>
        </div>`);
      } else {
        t.push(`<div class="trow lvl1 titem" data-scadd="staff" style="color:var(--accent)">${ic("plus")} Lägg till personal</div>`);
      }
    }
    t.push(`<div class="trow lvl1" data-t="stcats">${ic("tag")} Kategorier ${scCaret("stcats")}</div>`);
    if(scOpen.stcats){
      (scData.staffCats||[]).forEach(c=>{
        if(can && scOpen["edit_sc_"+c.id]){ t.push(scNameEditRow("stcat", "sc_"+c.id, c.id, c.name, c.description, 2)); return; }
        t.push(`<div class="tleaf lvl2">${ic("tag")} ${esc(c.name)}${can?`<span class="tbtns"><button class="x" data-sce="sc_${c.id}" title="Ändra">${ic("pencil")}</button><button class="x" data-scd="stcat:${c.id}" title="Ta bort">${ic("x")}</button></span>`:""}</div>`);
        t.push(scDescLeaf(c.description, 3));
      });
      if(!(scData.staffCats||[]).length) t.push(`<div class="tleaf lvl2 tmuted">Inga än — t.ex. Ridlärare, Stallpersonal</div>`);
      if(can) t.push(`<div class="addhorse lvl2"><input type="text" id="scin_stcat" placeholder="Ny personalkategori"><button class="btn sm" data-sca="stcat">+ Kategori</button></div>`);
    }
  }
  can = canT;
  // ARBETSPASS
  t.push(`</div>`); t.push(tSect(60));
  t.push(`<div class="trow lvl0" data-t="tasks">${ic("clock")} Arbetspass ${scCaret("tasks")}</div>`);
  if(scOpen.tasks){
    (scData.tasks||[]).forEach(tk=>{
      const key = "tx_"+tk.id;
      if(can && scOpen["edit_t_"+tk.id]){
        const wdO = [1,2,3,4,5,6,7].map(w=>`<option value="${w}"${w===tk.weekday?" selected":""}>${RS_WD[w]}</option>`).join("");
        const tO = TIME_OPTIONS.map(x=>`<option value="${x}"${x===tk.start_time?" selected":""}>${x}</option>`).join("");
        const dO = TASK_DUR.map(d=>`<option value="${d}"${d===tk.duration_min?" selected":""}>${d} min</option>`).join("");
        t.push(`<div class="editrow lvl1">
          <div class="field"><label class="fld">Namn</label><input type="text" id="sct_name_${tk.id}" value="${esc(tk.name)}"></div>
          <div class="field"><label class="fld">Veckodag</label><select id="sct_wd_${tk.id}">${wdO}</select></div>
          <div class="field"><label class="fld">Starttid</label><select id="sct_time_${tk.id}">${tO}</select></div>
          <div class="field"><label class="fld">Längd</label><select id="sct_dur_${tk.id}">${dO}</select></div>
          ${scDescField("t_"+tk.id, tk.description)}
          <div class="editbtns"><button class="btn primary sm" data-scs="task:${tk.id}">Spara</button><button class="btn sm" data-scc="t_${tk.id}">Avbryt</button></div>
        </div>`);
      } else {
        const btns = can ? `<span class="tbtns"><button class="x" data-sce="t_${tk.id}" title="Ändra">${ic("pencil")}</button><button class="x" data-scd="task:${tk.id}" title="Ta bort">${ic("x")}</button></span>` : "";
        t.push(`<div class="trow lvl1 titem" data-t="${key}">${esc(tk.name)} ${scCaret(key)}${btns}</div>`);
        t.push(`<div class="tleaf lvl2 tmuted">${RS_WD[tk.weekday]||"?"} ${tk.start_time}–${rsEndTime(tk.start_time, tk.duration_min)}</div>`);
        t.push(scDescLeaf(tk.description, 2));
      }
      if(scOpen[key]){
        t.push(`<div class="tleaf lvl2 tmuted" style="font-weight:700">Personal</div>`);
        const tf2 = (scData.taskStaff||[]).filter(x=> x.task_id === tk.id).map(x=> (scData.staff||[]).find(f=> f.id === x.staff_id)).filter(Boolean);
        tf2.forEach(f=> t.push(`<div class="tleaf lvl2">${ic("user")} ${esc(f.name)}${can?`<span class="tbtns"><button class="x" data-scd="tstaff:${tk.id}|${f.id}" title="Ta bort från arbetspasset">${ic("x")}</button></span>`:""}</div>`));
        if(!tf2.length) t.push(`<div class="tleaf lvl2 tmuted">Ingen tilldelad än</div>`);
        if(can){
          const freeF = (scData.staff||[]).filter(f=> !tf2.some(x=> x.id === f.id));
          if(freeF.length) t.push(scAddCtl("addsel_tstaff_"+tk.id, "Lägg till personal",
            scCatPick("scin_tstaff_"+tk.id, freeF, scData.staffCats, `<button class="btn sm" data-sca="tstaff:${tk.id}">Lägg till</button>`), 2));
        }
      }
    });
    if(!(scData.tasks||[]).length) t.push(`<div class="tleaf lvl1 tmuted">Inga arbetspass än — t.ex. Mocka boxar, Fodra</div>`);
    if(can){
      if(scOpen.add_task){
        const wdO = [1,2,3,4,5,6,7].map(w=>`<option value="${w}">${RS_WD[w]}</option>`).join("");
        const tO = TIME_OPTIONS.map(x=>`<option value="${x}"${x==="08:00"?" selected":""}>${x}</option>`).join("");
        const dO = TASK_DUR.map(d=>`<option value="${d}"${d===60?" selected":""}>${d} min</option>`).join("");
        t.push(`<div class="editrow lvl1">
          <div class="field"><label class="fld">Nytt arbetspass — namn</label><input type="text" id="scin_task" placeholder="t.ex. Mocka boxar"></div>
          <div class="field"><label class="fld">Veckodag</label><select id="scin_twd">${wdO}</select></div>
          <div class="field"><label class="fld">Starttid</label><select id="scin_ttime">${tO}</select></div>
          <div class="field"><label class="fld">Längd</label><select id="scin_tdur">${dO}</select></div>
          <div class="editbtns"><button class="btn primary sm" data-sca="task">+ Skapa arbetspass</button><button class="btn sm" data-scca="task">Avbryt</button></div>
        </div>`);
      } else {
        t.push(`<div class="trow lvl1 titem" data-scadd="task" style="color:var(--accent)">${ic("plus")} Lägg till arbetspass</div>`);
      }
    }
  }
  can = canL;
  // ELEVER
  t.push(`</div>`); t.push(tSect(128));
  t.push(`<div class="trow lvl0" data-t="elever">${ic("user")} Elever ${scCaret("elever")}</div>`);
  if(scOpen.elever){
    scData.students.forEach(s=>{
      const key = "s_"+s.id;
      const mine = myStud.has(s.id);
      const may = can || mine;
      if(can && scOpen["edit_s_"+s.id]){
        const ecO = `<option value="">Ingen kategori</option>` + (scData.studentCats||[]).map(c=>`<option value="${c.id}"${c.id===s.category_id?" selected":""}>${esc(c.name)}</option>`).join("");
        t.push(`<div class="editrow lvl1">
          <div class="field"><label class="fld">Namn</label><input type="text" id="scn_s_${s.id}" value="${esc(s.name)}"></div>
          <div class="field"><label class="fld">Kategori</label><select id="scc_s_${s.id}">${ecO}</select></div>
          ${scDescField("s_"+s.id, scStudentNote(s.id))}
          <div class="editbtns"><button class="btn primary sm" data-scs="student:${s.id}">Spara</button><button class="btn sm" data-scc="s_${s.id}">Avbryt</button></div>
        </div>`);
      } else {
        const ecat = ((scData.studentCats||[]).find(c=> c.id === s.category_id)||{}).name;
        t.push(`<div class="trow lvl1 titem" data-t="${key}">${ic("user")} ${esc(s.name)}${mine?` <span class="tagpill">din</span>`:""}${ecat?` <span class="tagpill">${esc(ecat)}</span>`:""} ${scCaret(key)}${can?`<span class="tbtns"><button class="x" data-sce="s_${s.id}" title="Ändra">${ic("pencil")}</button><button class="x" data-scd="student:${s.id}" title="Ta bort">${ic("x")}</button></span>`:""}</div>`);
        t.push(scDescLeaf(scStudentNote(s.id), 2));
      }
      if(scOpen[key]){
        (s.rs_student_member||[]).forEach(m=> t.push(`<div class="tleaf lvl2">${ic("mail")} ${esc(m.email)}${may?`<span class="tbtns"><button class="x" data-scd="smail:${s.id}|${encodeURIComponent(m.email)}" title="Ta bort">${ic("x")}</button></span>`:""}</div>`));
        if(!(s.rs_student_member||[]).length) t.push(`<div class="tleaf lvl2 tmuted">Ingen mejl kopplad än</div>`);
        if(may) t.push(`<div class="addhorse lvl2"><input type="email" id="scin_smail_${s.id}" placeholder="Lägg till mejladress"><button class="btn sm" data-sca="smail:${s.id}">+ Mejl</button></div>`);
        t.push(`<div class="tleaf lvl2 tmuted" style="font-weight:700">Lektioner</div>`);
        const myGr = scData.gstud.filter(x=> x.student_id === s.id);
        myGr.forEach(x=>{
          const g = scData.groups.find(g=> g.id === x.group_id); if(!g) return;
          t.push(`<div class="tleaf lvl2">${ic("calendar")} ${esc(g.name)}${can?`<span class="tbtns"><button class="x" data-scd="gstud:${g.id}|${s.id}" title="Ta bort från lektionen">${ic("x")}</button></span>`:""}</div>`);
        });
        if(!myGr.length) t.push(`<div class="tleaf lvl2 tmuted">Inga lektioner än</div>`);
        if(can){
          const freeG = scData.groups.filter(g=> !myGr.some(x=> x.group_id === g.id));
          if(freeG.length) t.push(scAddCtl("addsel_sgrp_"+s.id, "Lägg till på lektion",
            `<select id="scin_sgrp_${s.id}">${freeG.map(g=>`<option value="${g.id}">${esc(g.name)}</option>`).join("")}</select><button class="btn sm" data-sca="sgrp:${s.id}">Lägg till</button>`, 2));
        }
      }
    });
    if(can){
      if(scOpen.add_student){
        const gO = `<option value="">Ingen lektion än</option>` + scData.groups.map(g=>`<option value="${g.id}">${esc(g.name)}</option>`).join("");
        t.push(`<div class="editrow lvl1">
          <div class="field"><label class="fld">Ny elev — namn</label><input type="text" id="scin_student" placeholder="Elevens namn"></div>
          <div class="field"><label class="fld">Mejladress (förälder/elev)</label><input type="email" id="scin_stmail" placeholder="Valfritt — kan läggas till senare"></div>
          <div class="field"><label class="fld">Lektion</label><select id="scin_stgrp">${gO}</select></div>
          <div class="editbtns"><button class="btn primary sm" data-sca="student">+ Skapa elev</button><button class="btn sm" data-scca="student">Avbryt</button></div>
        </div>`);
      } else {
        t.push(`<div class="trow lvl1 titem" data-scadd="student" style="color:var(--accent)">${ic("plus")} Lägg till elev</div>`);
      }
    }
    t.push(`<div class="trow lvl1" data-t="ecats">${ic("tag")} Kategorier ${scCaret("ecats")}</div>`);
    if(scOpen.ecats){
      (scData.studentCats||[]).forEach(c=>{
        if(can && scOpen["edit_ec_"+c.id]){ t.push(scNameEditRow("ecat", "ec_"+c.id, c.id, c.name, c.description, 2)); return; }
        t.push(`<div class="tleaf lvl2">${ic("tag")} ${esc(c.name)}${can?`<span class="tbtns"><button class="x" data-sce="ec_${c.id}" title="Ändra">${ic("pencil")}</button><button class="x" data-scd="ecat:${c.id}" title="Ta bort">${ic("x")}</button></span>`:""}</div>`);
        t.push(scDescLeaf(c.description, 3));
      });
      if(!(scData.studentCats||[]).length) t.push(`<div class="tleaf lvl2 tmuted">Inga än — t.ex. Nybörjare, Tävlingsgrupp</div>`);
      if(can) t.push(`<div class="addhorse lvl2"><input type="text" id="scin_ecat" placeholder="Ny elevkategori"><button class="btn sm" data-sca="ecat">+ Kategori</button></div>`);
    }
  }
  can = canP;
  // LEDARE
  t.push(`</div>`); t.push(tSect(200));
  t.push(`<div class="trow lvl0" data-t="ledare">${ic("user")} Ledare ${scCaret("ledare")}</div>`);
  if(scOpen.ledare){
    (scData.instructors||[]).forEach(i=>{
      const key = "ix_"+i.id;
      if(can && scOpen["edit_i_"+i.id]){ t.push(scNameEditRow("instr", "i_"+i.id, i.id, i.name, i.description, 1)); return; }
      t.push(`<div class="trow lvl1 titem" data-t="${key}">${ic("user")} ${esc(i.name)} ${scCaret(key)}${can?`<span class="tbtns"><button class="x" data-sce="i_${i.id}" title="Ändra">${ic("pencil")}</button><button class="x" data-scd="instr:${i.id}" title="Ta bort">${ic("x")}</button></span>`:""}</div>`);
      t.push(scDescLeaf(i.description, 2));
      if(scOpen[key]){
        (i.rs_instructor_member||[]).forEach(m=> t.push(`<div class="tleaf lvl2">${ic("mail")} ${esc(m.email)}${can?`<span class="tbtns"><button class="x" data-scd="imail:${i.id}|${encodeURIComponent(m.email)}" title="Ta bort">${ic("x")}</button></span>`:""}</div>`));
        if(!(i.rs_instructor_member||[]).length) t.push(`<div class="tleaf lvl2 tmuted">Ingen mejl kopplad än</div>`);
        if(can) t.push(`<div class="addhorse lvl2"><input type="email" id="scin_imail_${i.id}" placeholder="Lägg till mejladress"><button class="btn sm" data-sca="imail:${i.id}">+ Mejl</button></div>`);
        t.push(`<div class="tleaf lvl2 tmuted" style="font-weight:700">Lektioner</div>`);
        const ig = (scData.ginstr||[]).filter(x=> x.instructor_id === i.id);
        ig.forEach(x=>{
          const g = scData.groups.find(g=> g.id === x.group_id); if(!g) return;
          t.push(`<div class="tleaf lvl2">${ic("calendar")} ${esc(g.name)}${can?`<span class="tbtns"><button class="x" data-scd="ginstr:${g.id}|${i.id}" title="Ta bort från lektionen">${ic("x")}</button></span>`:""}</div>`);
        });
        if(!ig.length) t.push(`<div class="tleaf lvl2 tmuted">Inga lektioner än</div>`);
        if(can){
          const freeG = scData.groups.filter(g=> g.has_leaders && !ig.some(x=> x.group_id === g.id));
          if(freeG.length) t.push(scAddCtl("addsel_igrp_"+i.id, "Lägg till på lektion",
            `<select id="scin_igrp_${i.id}">${freeG.map(g=>`<option value="${g.id}">${esc(g.name)}</option>`).join("")}</select><button class="btn sm" data-sca="igrp:${i.id}">Lägg till</button>`, 2));
          else if(!scData.groups.some(g=> g.has_leaders)) t.push(`<div class="tleaf lvl2 tmuted">Ingen lektion har ledare = ja än</div>`);
        }
      }
    });
    if(!(scData.instructors||[]).length) t.push(`<div class="tleaf lvl1 tmuted">Inga ledare än</div>`);
    if(can){
      if(scOpen.add_instr){
        t.push(`<div class="editrow lvl1">
          <div class="field"><label class="fld">Ny ledare — namn</label><input type="text" id="scin_instr" placeholder="Namn"></div>
          <div class="field"><label class="fld">Mejladress</label><input type="email" id="scin_instrmail" placeholder="Valfritt — kan läggas till senare"></div>
          <div class="editbtns"><button class="btn primary sm" data-sca="instr">+ Lägg till ledare</button><button class="btn sm" data-scca="instr">Avbryt</button></div>
        </div>`);
      } else {
        t.push(`<div class="trow lvl1 titem" data-scadd="instr" style="color:var(--accent)">${ic("plus")} Lägg till ledare</div>`);
      }
    }
  }
  t.push(`</div>`);
  host.innerHTML = t.join("");
  host.querySelectorAll("[data-t]").forEach(n=> n.onclick = ()=>{ const k=n.getAttribute("data-t"); scOpen[k]=!scOpen[k]; renderSchoolTree(); });
  host.querySelectorAll("[data-sce]").forEach(b=> b.onclick=(e)=>{ e.stopPropagation(); scOpen["edit_"+b.getAttribute("data-sce")] = true; renderSchoolTree(); });
  host.querySelectorAll("[data-scc]").forEach(b=> b.onclick=(e)=>{ e.stopPropagation(); const k=b.getAttribute("data-scc"); delete scOpen["edit_"+k]; delete scOpen["desc_"+k]; renderSchoolTree(); });
  host.querySelectorAll("[data-scadd]").forEach(b=> b.onclick=(e)=>{ e.stopPropagation(); scOpen["add_"+b.getAttribute("data-scadd")] = true; renderSchoolTree(); });
  host.querySelectorAll("[data-scshow]").forEach(b=> b.onclick=(e)=>{ e.stopPropagation(); scOpen[b.getAttribute("data-scshow")] = true; renderSchoolTree(); });
  host.querySelectorAll("[data-schide]").forEach(b=> b.onclick=(e)=>{ e.stopPropagation(); delete scOpen[b.getAttribute("data-schide")]; renderSchoolTree(); });
  host.querySelectorAll("[data-permdesc]").forEach(sel=> sel.onchange = ()=>{
    const d = el(sel.getAttribute("data-permdesc")); if(d) d.textContent = PERM_DESC[sel.value] || "";
  });
  host.querySelectorAll(".catpick").forEach(sel=> sel.onchange = ()=>{
    const tid = sel.getAttribute("data-catfor");
    const list = (scPickMap[tid]||{})[sel.value] || [];
    el(tid).innerHTML = list.map(i=>`<option value="${i.id}">${esc(i.name)}</option>`).join("");
  });
  host.querySelectorAll("[data-scca]").forEach(b=> b.onclick=(e)=>{ e.stopPropagation(); delete scOpen["add_"+b.getAttribute("data-scca")]; renderSchoolTree(); });
  // "Lägg till beskrivning": byt ut knappen mot en textarea på plats, utan omritning (annars tappas det man skrivit i övriga fält)
  host.querySelectorAll("[data-scdesc]").forEach(b=> b.onclick=(e)=>{ e.stopPropagation(); const k=b.getAttribute("data-scdesc"); scOpen["desc_"+k]=true;
    const w=document.createElement("div"); w.className="field";
    w.innerHTML=`<label class="fld">Beskrivning</label><textarea id="scdesc_${k}" rows="2" placeholder="t.ex. rädd för stora hästar"></textarea>`;
    b.closest(".field").replaceWith(w); w.querySelector("textarea").focus(); });
  host.querySelectorAll("[data-scs]").forEach(b=> b.onclick=(e)=>{ e.stopPropagation(); scSave(b.getAttribute("data-scs")); });
  host.querySelectorAll("[data-sca]").forEach(b=> b.onclick=(e)=>{ e.stopPropagation(); scAdd(b.getAttribute("data-sca")); });
  host.querySelectorAll("[data-scd]").forEach(b=> b.onclick=(e)=>{ e.stopPropagation(); scDelete(b.getAttribute("data-scd")); });
  host.querySelectorAll(".addhorse, .editrow").forEach(n=> n.onclick=(e)=> e.stopPropagation());
}

async function scSave(spec){
  const [kind, id] = spec.split(":");
  if(kind === "staff"){
    const upd = { name: (el("scf_name_"+id).value||"").trim() || "Personal", category_id: el("scf_cat_"+id).value || null };
    const pEl = el("scf_perm_"+id); if(pEl) upd.perm = pEl.value;
    const d = scDescVal("f_"+id); if(d !== undefined) upd.description = d;
    const r = await db.from("rs_staff").update(upd).eq("id", id);
    if(r.error){ alert("Kunde inte spara: " + r.error.message); return; }
    delete scOpen["edit_f_"+id]; delete scOpen["desc_f_"+id];
    await reloadSchool();
    return;
  }
  if(kind === "task"){
    const upd = {
      name: (el("sct_name_"+id).value||"").trim() || "Arbetspass",
      weekday: parseInt(el("sct_wd_"+id).value, 10),
      start_time: el("sct_time_"+id).value,
      duration_min: parseInt(el("sct_dur_"+id).value, 10)
    };
    const d = scDescVal("t_"+id); if(d !== undefined) upd.description = d;
    const r = await db.from("rs_task").update(upd).eq("id", id);
    if(r.error){ alert("Kunde inte spara: " + r.error.message); return; }
    delete scOpen["edit_t_"+id]; delete scOpen["desc_t_"+id];
    await reloadSchool();
    return;
  }
  // Namn + beskrivning-redigeringar (kategori, häst, elev, personalkategori, ledare)
  const simple = { cat:["c_","category"], horse:["h_","rs_horse"], student:["s_","rs_student"], stcat:["sc_","rs_staff_category"], leader:["l_","rs_leader"],
                   hcat:["hc_","rs_horse_category"], ecat:["ec_","rs_student_category"], instr:["i_","rs_instructor"], place:["pl_","rs_place"] };
  if(simple[kind]){
    const [pfx, tbl] = simple[kind];
    const key = pfx + id;
    const upd = { name: (el("scn_"+key).value||"").trim() || "Namnlös" };
    const d = scDescVal(key);
    if(kind === "student"){
      // elevens anteckning sparas i skyddade rs_student_note, inte i den öppna tabellen
      if(d !== undefined){
        const nr = d ? await db.from("rs_student_note").upsert({ student_id: id, note: d })
                     : await db.from("rs_student_note").delete().eq("student_id", id);
        if(nr && nr.error) alert("Anteckningen kunde inte sparas: " + nr.error.message + " (har du kört db/behorigheter.sql?)");
      }
    } else if(d !== undefined) upd.description = d;
    const cEl = el("scc_"+key); if(cEl) upd.category_id = cEl.value || null;
    const r = await db.from(tbl).update(upd).eq("id", id);
    if(r.error){ alert("Kunde inte spara: " + r.error.message); return; }
    delete scOpen["edit_"+key]; delete scOpen["desc_"+key];
    await reloadSchool();
    return;
  }
  if(kind !== "group") return;
  const upd = {
    name: (el("scg_name_"+id).value||"").trim() || "Grupp",
    category_id: el("scg_cat_"+id).value || null,
    weekday: parseInt(el("scg_wd_"+id).value, 10),
    start_time: el("scg_time_"+id).value,
    duration_min: parseInt(el("scg_dur_"+id).value, 10),
    capacity: parseInt(el("scg_cap_"+id).value, 10),
    horse_rotation: parseInt(el("scg_rot_"+id).value, 10),
    place_id: el("scg_place_"+id) ? (el("scg_place_"+id).value || null) : undefined,
    has_leaders: el("scg_led_"+id).value === "ja"
  };
  if(upd.place_id === undefined) delete upd.place_id;
  const d = scDescVal(id); if(d !== undefined) upd.description = d;
  const r = await db.from("rs_group").update(upd).eq("id", id);
  if(r.error){ alert("Kunde inte spara: " + r.error.message); return; }
  delete scOpen["edit_"+id]; delete scOpen["desc_"+id];
  await reloadSchool();
}

async function scAdd(spec){
  const parts = spec.split(":"); const kind = parts[0], a = parts[1];
  let r = null;
  if(kind==="group"){ const name=(el("scin_group").value||"").trim();
    if(!name){ await infoDialog("Ge lektionen ett namn.", "Namn saknas"); return; }
    r = await db.from("rs_group").insert({
      stable_id: scStableId, name,
      category_id: el("scin_gcat").value || null,
      weekday: parseInt(el("scin_gwd").value, 10),
      start_time: el("scin_gtime").value,
      duration_min: parseInt(el("scin_gdur").value, 10),
      capacity: parseInt(el("scin_gcap").value, 10),
      horse_rotation: parseInt(el("scin_grot").value, 10),
      place_id: el("scin_gplace") ? (el("scin_gplace").value || null) : null,
      sort_order: scData.groups.length });
    if(!r.error) delete scOpen.add_group; }
  if(kind==="cat"){ const name=(el("scin_cat").value||"").trim(); if(!name) return;
    r = await db.from("category").insert({ stable_id: scStableId, name, sort_order: scData.cats.length }); }
  if(kind==="horse"){ const name=(el("scin_horse").value||"").trim(); if(!name) return;
    r = await db.from("rs_horse").insert({ stable_id: scStableId, name }); }
  if(kind==="student"){ const name=(el("scin_student").value||"").trim();
    if(!name){ await infoDialog("Ge eleven ett namn.", "Namn saknas"); return; }
    const email = normEmail(el("scin_stmail").value);
    const gid = el("scin_stgrp").value || null;
    const ins = await db.from("rs_student").insert({ stable_id: scStableId, name }).select("id").single();
    if(ins.error){ alert("Kunde inte skapa elev: " + ins.error.message); return; }
    if(email.includes("@")){
      const mr = await db.from("rs_student_member").insert({ student_id: ins.data.id, email });
      if(mr.error) alert("Eleven skapades, men mejlen kunde inte läggas till: " + mr.error.message);
      else sendWelcomeMail(email);
    }
    if(gid){
      const gr = await db.from("rs_group_student").insert({ group_id: gid, student_id: ins.data.id });
      if(gr.error) alert("Eleven skapades, men kunde inte läggas i gruppen: " + gr.error.message);
    }
    delete scOpen.add_student;
    await reloadSchool(); return; }
  if(kind==="leader"){ const name=(el("scin_leader_"+a).value||"").trim(); if(!name) return;
    r = await db.from("rs_leader").insert({ group_id: a, name }); }
  if(kind==="gstud"){ const sid = el("scin_gstud_"+a).value; if(!sid) return;
    const g = scData.groups.find(x=> x.id === a);
    const n = scData.gstud.filter(x=> x.group_id === a).length;
    if(g && n >= g.capacity){ await infoDialog(`Lektionen är full (${g.capacity} platser). Höj antalet platser eller ta bort någon först.`, "Fullt"); return; }
    r = await db.from("rs_group_student").insert({ group_id: a, student_id: sid }); }
  if(kind==="sgrp"){ const gid = el("scin_sgrp_"+a).value; if(!gid) return;
    const g = scData.groups.find(x=> x.id === gid);
    const n = scData.gstud.filter(x=> x.group_id === gid).length;
    if(g && n >= g.capacity){ await infoDialog(`Lektionen är full (${g.capacity} platser). Höj antalet platser eller ta bort någon först.`, "Fullt"); return; }
    r = await db.from("rs_group_student").insert({ group_id: gid, student_id: a }); }
  if(kind==="smail"){ const email = normEmail(el("scin_smail_"+a).value);
    if(!email.includes("@")){ await infoDialog("Skriv en giltig mejladress.", "Mejl saknas"); return; }
    r = await db.from("rs_student_member").insert({ student_id: a, email });
    if(!r.error) sendWelcomeMail(email); }
  if(kind==="staff"){ const name=(el("scin_staff").value||"").trim();
    if(!name){ await infoDialog("Ge personen ett namn.", "Namn saknas"); return; }
    const email = normEmail(el("scin_sfmail").value);
    const cat = el("scin_sfcat").value || null;
    const ins = await db.from("rs_staff").insert({ stable_id: scStableId, name, category_id: cat }).select("id").single();
    if(ins.error){ alert("Kunde inte lägga till personal: " + ins.error.message); return; }
    if(email.includes("@")){
      const mr = await db.from("rs_staff_member").insert({ staff_id: ins.data.id, email });
      if(mr.error) alert("Personen skapades, men mejlen kunde inte läggas till: " + mr.error.message);
      else sendWelcomeMail(email);
    }
    delete scOpen.add_staff;
    await reloadSchool(); return; }
  if(kind==="stcat"){ const name=(el("scin_stcat").value||"").trim(); if(!name) return;
    r = await db.from("rs_staff_category").insert({ stable_id: scStableId, name, sort_order: (scData.staffCats||[]).length }); }
  if(kind==="hcat"){ const name=(el("scin_hcat").value||"").trim(); if(!name) return;
    r = await db.from("rs_horse_category").insert({ stable_id: scStableId, name, sort_order: (scData.horseCats||[]).length }); }
  if(kind==="ecat"){ const name=(el("scin_ecat").value||"").trim(); if(!name) return;
    r = await db.from("rs_student_category").insert({ stable_id: scStableId, name, sort_order: (scData.studentCats||[]).length }); }
  if(kind==="place"){ const name=(el("scin_place").value||"").trim(); if(!name) return;
    r = await db.from("rs_place").insert({ stable_id: scStableId, name, sort_order: (scData.places||[]).length }); }
  if(kind==="ghorse"){ const hid = el("scin_ghorse_"+a).value; if(!hid) return;
    r = await db.from("rs_group_horse").insert({ group_id: a, horse_id: hid }); }
  if(kind==="hgrp"){ const gid = el("scin_hgrp_"+a).value; if(!gid) return;
    r = await db.from("rs_group_horse").insert({ group_id: gid, horse_id: a }); }
  if(kind==="gstaff"){ const fid = el("scin_gstaff_"+a).value; if(!fid) return;
    r = await db.from("rs_group_staff").insert({ group_id: a, staff_id: fid }); }
  if(kind==="fgrp"){ const gid = el("scin_fgrp_"+a).value; if(!gid) return;
    r = await db.from("rs_group_staff").insert({ group_id: gid, staff_id: a }); }
  if(kind==="task"){ const name=(el("scin_task").value||"").trim();
    if(!name){ await infoDialog("Ge arbetspasset ett namn.", "Namn saknas"); return; }
    r = await db.from("rs_task").insert({
      stable_id: scStableId, name,
      weekday: parseInt(el("scin_twd").value, 10),
      start_time: el("scin_ttime").value,
      duration_min: parseInt(el("scin_tdur").value, 10),
      sort_order: (scData.tasks||[]).length });
    if(!r.error) delete scOpen.add_task; }
  if(kind==="tstaff"){ const fid = el("scin_tstaff_"+a).value; if(!fid) return;
    r = await db.from("rs_task_staff").insert({ task_id: a, staff_id: fid });
    if(!r.error) sendTaskNotice(fid, (((scData.tasks||[]).find(t2=> t2.id===a))||{}).name || "arbetspass", "added"); }
  if(kind==="ftask"){ const tid = el("scin_ftask_"+a).value; if(!tid) return;
    r = await db.from("rs_task_staff").insert({ task_id: tid, staff_id: a });
    if(!r.error) sendTaskNotice(a, (((scData.tasks||[]).find(t2=> t2.id===tid))||{}).name || "arbetspass", "added"); }
  if(kind==="ginstr"){ const iid = el("scin_ginstr_"+a).value; if(!iid) return;
    r = await db.from("rs_group_instructor").insert({ group_id: a, instructor_id: iid }); }
  if(kind==="igrp"){ const gid = el("scin_igrp_"+a).value; if(!gid) return;
    r = await db.from("rs_group_instructor").insert({ group_id: gid, instructor_id: a }); }
  if(kind==="imail"){ const email = normEmail(el("scin_imail_"+a).value);
    if(!email.includes("@")){ await infoDialog("Skriv en giltig mejladress.", "Mejl saknas"); return; }
    r = await db.from("rs_instructor_member").insert({ instructor_id: a, email });
    if(!r.error) sendWelcomeMail(email); }
  if(kind==="instr"){ const name=(el("scin_instr").value||"").trim();
    if(!name){ await infoDialog("Ge ledaren ett namn.", "Namn saknas"); return; }
    const email = normEmail(el("scin_instrmail").value);
    const ins = await db.from("rs_instructor").insert({ stable_id: scStableId, name }).select("id").single();
    if(ins.error){ alert("Kunde inte lägga till ledare: " + ins.error.message); return; }
    if(email.includes("@")){
      const mr = await db.from("rs_instructor_member").insert({ instructor_id: ins.data.id, email });
      if(mr.error) alert("Ledaren skapades, men mejlen kunde inte läggas till: " + mr.error.message);
      else sendWelcomeMail(email);
    }
    delete scOpen.add_instr;
    await reloadSchool(); return; }
  if(kind==="fmail"){ const email = normEmail(el("scin_fmail_"+a).value);
    if(!email.includes("@")){ await infoDialog("Skriv en giltig mejladress.", "Mejl saknas"); return; }
    r = await db.from("rs_staff_member").insert({ staff_id: a, email });
    if(!r.error) sendWelcomeMail(email); }
  if(!r) return;
  if(r.error){ alert("Kunde inte lägga till: " + r.error.message); return; }
  delete scOpen["addsel_"+kind+"_"+(a||"")];   // fäll ihop lägg till-kontrollen igen
  await reloadSchool();
}

/* Välkomstmejl med inloggningslänk när någons mejladress läggs till (alla roller) */
async function sendWelcomeMail(email){
  try{
    email = normEmail(email);
    if(!email || !email.includes("@") || email === session.email) return;
    const redirect = window.location.origin + window.location.pathname;
    await db.auth.signInWithOtp({ email, options: { shouldCreateUser: true, emailRedirectTo: redirect } });
  }catch(e){}
}
/* Notis i klockan till personens mejl när hen sätts på eller tas bort från ett arbetspass */
async function sendTaskNotice(staffId, taskName, kind){
  try{
    const f = (scData.staff||[]).find(x=> x.id === staffId);
    const emails = ((f && f.rs_staff_member) || []).map(m=> (m.email||"").toLowerCase()).filter(e=> e && e !== session.email);
    if(!emails.length) return;
    await db.from("task_notice").insert(emails.map(e=> ({ stable_id: scStableId, email: e, kind, task_name: taskName })));
  }catch(e){}
}
async function scDelete(spec){
  const i = spec.indexOf(":"); const kind = spec.slice(0,i); const id = spec.slice(i+1);
  let q = null, text = "";
  if(kind==="group"){ const g=scData.groups.find(x=>x.id===id); text=`Du håller på att ta bort lektionen "${g?g.name:""}" med dess tillfällen och tilldelningar.`; q=()=>db.from("rs_group").delete().eq("id",id); }
  if(kind==="cat"){ const c=scData.cats.find(x=>x.id===id); text=`Ta bort kategorin "${c?c.name:""}"?`; q=()=>db.from("category").delete().eq("id",id); }
  if(kind==="horse"){ const h=scData.horses.find(x=>x.id===id); text=`Ta bort hästen "${h?h.name:""}"?`; q=()=>db.from("rs_horse").delete().eq("id",id); }
  if(kind==="student"){ const s=scData.students.find(x=>x.id===id); text=`Du håller på att ta bort eleven "${s?s.name:""}" ur ridskolan.`; q=()=>db.from("rs_student").delete().eq("id",id); }
  if(kind==="leader"){ const ld=scData.leaders.find(x=>x.id===id); text=`Ta bort ledaren "${ld?ld.name:""}"?`; q=()=>db.from("rs_leader").delete().eq("id",id); }
  if(kind==="gstud"){ const j=id.indexOf("|"); const gid=id.slice(0,j), sid=id.slice(j+1);
    const s=scData.students.find(x=>x.id===sid); text=`Ta bort ${s?s.name:"eleven"} från lektionen?`;
    q=()=>db.from("rs_group_student").delete().eq("group_id",gid).eq("student_id",sid); }
  if(kind==="smail"){ const j=id.indexOf("|"); const sid=id.slice(0,j), em=decodeURIComponent(id.slice(j+1));
    text=`Ta bort mejladressen ${em}?`;
    q=()=>db.from("rs_student_member").delete().eq("student_id",sid).eq("email",em); }
  if(kind==="staff"){ const f=(scData.staff||[]).find(x=>x.id===id); text=`Du håller på att ta bort ${f?f.name:"personen"} ur personalen.`; q=()=>db.from("rs_staff").delete().eq("id",id); }
  if(kind==="stcat"){ const c=(scData.staffCats||[]).find(x=>x.id===id); text=`Ta bort personalkategorin "${c?c.name:""}"?`; q=()=>db.from("rs_staff_category").delete().eq("id",id); }
  if(kind==="hcat"){ const c=(scData.horseCats||[]).find(x=>x.id===id); text=`Ta bort hästkategorin "${c?c.name:""}"?`; q=()=>db.from("rs_horse_category").delete().eq("id",id); }
  if(kind==="ecat"){ const c=(scData.studentCats||[]).find(x=>x.id===id); text=`Ta bort elevkategorin "${c?c.name:""}"?`; q=()=>db.from("rs_student_category").delete().eq("id",id); }
  if(kind==="place"){ const p=(scData.places||[]).find(x=>x.id===id); text=`Ta bort platsen "${p?p.name:""}"? Lektioner som använder den blir utan plats.`; q=()=>db.from("rs_place").delete().eq("id",id); }
  if(kind==="fmail"){ const j=id.indexOf("|"); const fid=id.slice(0,j), em=decodeURIComponent(id.slice(j+1));
    text=`Ta bort mejladressen ${em}?`;
    q=()=>db.from("rs_staff_member").delete().eq("staff_id",fid).eq("email",em); }
  if(kind==="ghorse"){ const j=id.indexOf("|"); const gid=id.slice(0,j), hid=id.slice(j+1);
    const h=scData.horses.find(x=>x.id===hid); const g=scData.groups.find(x=>x.id===gid);
    text=`Ta bort ${h?h.name:"hästen"} från lektionen "${g?g.name:""}"?`;
    q=()=>db.from("rs_group_horse").delete().eq("group_id",gid).eq("horse_id",hid); }
  if(kind==="gstaff"){ const j=id.indexOf("|"); const gid=id.slice(0,j), fid=id.slice(j+1);
    const f=(scData.staff||[]).find(x=>x.id===fid); const g=scData.groups.find(x=>x.id===gid);
    text=`Ta bort ${f?f.name:"personen"} från lektionen "${g?g.name:""}"?`;
    q=()=>db.from("rs_group_staff").delete().eq("group_id",gid).eq("staff_id",fid); }
  if(kind==="task"){ const tk=(scData.tasks||[]).find(x=>x.id===id); text=`Du håller på att ta bort arbetspasset "${tk?tk.name:""}".`; q=()=>db.from("rs_task").delete().eq("id",id); }
  if(kind==="tstaff"){ const j=id.indexOf("|"); const tid=id.slice(0,j), fid=id.slice(j+1);
    const f=(scData.staff||[]).find(x=>x.id===fid); const tk=(scData.tasks||[]).find(x=>x.id===tid);
    text=`Ta bort ${f?f.name:"personen"} från arbetspasset "${tk?tk.name:""}"?`;
    q=async ()=>{ const rr = await db.from("rs_task_staff").delete().eq("task_id",tid).eq("staff_id",fid);
      if(!rr.error) sendTaskNotice(fid, tk?tk.name:"arbetspass", "removed");
      return rr; }; }
  if(kind==="instr"){ const i=(scData.instructors||[]).find(x=>x.id===id); text=`Du håller på att ta bort ledaren "${i?i.name:""}".`; q=()=>db.from("rs_instructor").delete().eq("id",id); }
  if(kind==="imail"){ const j=id.indexOf("|"); const iid=id.slice(0,j), em=decodeURIComponent(id.slice(j+1));
    text=`Ta bort mejladressen ${em}?`;
    q=()=>db.from("rs_instructor_member").delete().eq("instructor_id",iid).eq("email",em); }
  if(kind==="ginstr"){ const j=id.indexOf("|"); const gid=id.slice(0,j), iid=id.slice(j+1);
    const i=(scData.instructors||[]).find(x=>x.id===iid); const g=scData.groups.find(x=>x.id===gid);
    text=`Ta bort ${i?i.name:"ledaren"} från lektionen "${g?g.name:""}"?`;
    q=()=>db.from("rs_group_instructor").delete().eq("group_id",gid).eq("instructor_id",iid); }
  if(!q) return;
  if(!(await confirmDialog(text))) return;
  const r = await q();
  if(r.error){ alert("Kunde inte ta bort: " + r.error.message); return; }
  await reloadSchool();
}

/* ---- Ridskolans schema: veckorutnät (dagar i x-led, tid i y-led) + detaljpanel ---- */
let scSchedMode = "lessons";     // "lessons" | "tasks" — separata scheman för lektioner och arbetspass
let scCalMode = "week";          // "day" | "week" | "month"
let scDayOff = 0;                // vald dag i dagvyn (0=måndag)
let scMonthDate = null;          // första dagen i månadsvyns månad
let scOnlyMine = false;          // visa bara det som rör mig
let scSel = null;                // valt block: {type:"les"|"task", id, wd}
let scWeekAsg = [], scWeekAbs = [], scWeekNotes = [], scWeekTAbs = [], scWeekLeave = [], scWeekSwap = [];   // veckans tilldelningar, sjukanmälningar, planeringar, beviljad ledighet, passbyten
let scNoteOpen = false;               // planerings-textrutan utfälld i panelen?

async function renderSchoolSchedule(stableId){
  scStableId = stableId;
  appEl.innerHTML = `<div id="scsShell"><div class="card"><div class="empty">Laddar schema…</div></div></div>`;
  try{
    const st = await db.from("stable").select("*").eq("id", stableId).single(); if(st.error) throw st.error;
    curPerm = await mySchoolPerm(stableId);
    curAdmin = curPerm === "admin";
    const [g,s,h,ins,gi,gs,sf,gh,gf,tk,tf,pl] = await Promise.all([
      db.from("rs_group").select("*, category(name)").eq("stable_id", stableId).order("weekday").order("start_time"),
      db.from("rs_student").select("id,name,rs_student_member(email)").eq("stable_id", stableId).order("name"),
      db.from("rs_horse").select("*").eq("stable_id", stableId).order("name"),
      db.from("rs_instructor").select("id,name,rs_instructor_member(email)").eq("stable_id", stableId).order("name"),
      db.from("rs_group_instructor").select("*"),
      db.from("rs_group_student").select("*"),
      db.from("rs_staff").select("id,name,perm,rs_staff_member(email)").eq("stable_id", stableId).order("name"),
      db.from("rs_group_horse").select("*"),
      db.from("rs_group_staff").select("*"),
      db.from("rs_task").select("*").eq("stable_id", stableId).order("start_time"),
      db.from("rs_task_staff").select("*"),
      db.from("rs_place").select("*").eq("stable_id", stableId).order("sort_order")
    ]);
    if(g.error) throw g.error;
    scData = { stable: st.data, groups: g.data, cats: [], students: s.error?[]:s.data, horses: h.error?[]:h.data,
               instructors: ins.error?[]:ins.data, ginstr: gi.error?[]:gi.data,
               gstud: gs.error?[]:gs.data, staff: sf.error?[]:sf.data,
               ghorse: gh.error?[]:gh.data, gstaff: gf.error?[]:gf.data,
               tasks: tk.error?[]:tk.data, taskStaff: tf.error?[]:tf.data,
               places: pl.error?[]:pl.data };
    if(!weekStart2) weekStart2 = startOfWeek(new Date());
    if(!scMonthDate){ const a = new Date(weekStart2); scMonthDate = new Date(a.getFullYear(), a.getMonth(), 1); }
    const MFULL = ["januari","februari","mars","april","maj","juni","juli","augusti","september","oktober","november","december"];
    let navLbl;
    if(scCalMode === "day"){ const d = new Date(weekStart2); d.setDate(d.getDate()+scDayOff); navLbl = `${RS_WD[scDayOff+1]} ${d.getDate()}/${d.getMonth()+1}`; }
    else if(scCalMode === "month"){ navLbl = MFULL[scMonthDate.getMonth()] + " " + scMonthDate.getFullYear(); }
    else navLbl = "Vecka " + isoWeekNumber(weekStart2);
    el("scsShell").innerHTML = `
      <div class="card schedtop">
        <div class="schedeyebrow">Schema · Ridskola</div>
        <h1 class="schedname">${esc(st.data.name)}</h1>
        <div class="schedctrl">
          <div class="seg" id="segMode">
            <button data-m="lessons" class="${scSchedMode==="lessons"?"on":""}">Ridlektioner</button>
            <button data-m="tasks" class="${scSchedMode==="tasks"?"on":""}">Arbetspass</button>
          </div>
          <div class="seg small" id="segCal">
            <button data-c="day" class="${scCalMode==="day"?"on":""}">Dag</button>
            <button data-c="week" class="${scCalMode==="week"?"on":""}">Vecka</button>
            <button data-c="month" class="${scCalMode==="month"?"on":""}">Månad</button>
          </div>
        </div>
      </div>
      <div class="card">
        <div class="navrow">
          <div class="navmid">
            <button class="btn sm" id="scwPrev">‹ Förra</button>
            <button class="btn sm" id="scwWeek" title="Hoppa till idag">${esc(navLbl)}</button>
            <button class="btn sm" id="scwNext">Nästa ›</button>
          </div>
        </div>
        <div class="scgw" id="scsGrid"></div>
        <div class="scfoot">
          <label class="chk sm"><input type="checkbox" id="scmMine"${scOnlyMine?" checked":""}> Visa endast mina ${scSchedMode==="lessons"?"lektioner":"pass"}</label>
          <div id="scsLegend"></div>
        </div>
      </div>
      <div id="scsDetail"></div>`;
    const shift = dir=>{
      if(scCalMode === "day"){
        let off = scDayOff + dir;
        weekStart2 = new Date(weekStart2);
        if(off < 0){ weekStart2.setDate(weekStart2.getDate()-7); off = 6; }
        if(off > 6){ weekStart2.setDate(weekStart2.getDate()+7); off = 0; }
        scDayOff = off;
      } else if(scCalMode === "month"){
        scMonthDate = new Date(scMonthDate.getFullYear(), scMonthDate.getMonth()+dir, 1);
        weekStart2 = startOfWeek(scMonthDate);
      } else {
        weekStart2 = new Date(weekStart2); weekStart2.setDate(weekStart2.getDate()+dir*7);
      }
      const a = new Date(weekStart2); if(scCalMode!=="month") scMonthDate = new Date(a.getFullYear(), a.getMonth(), 1);
      renderSchoolSchedule(stableId);
    };
    el("scwPrev").onclick = ()=> shift(-1);
    el("scwNext").onclick = ()=> shift(1);
    el("scwWeek").onclick = ()=>{
      const now = new Date();
      weekStart2 = startOfWeek(now); scDayOff = (now.getDay()+6)%7;
      scMonthDate = new Date(now.getFullYear(), now.getMonth(), 1);
      renderSchoolSchedule(stableId);
    };
    el("segMode").querySelectorAll("[data-m]").forEach(b=> b.onclick = ()=>{
      const m = b.getAttribute("data-m");
      if(scSchedMode !== m){ scSchedMode = m; scSel = null; renderSchoolSchedule(stableId); }
    });
    el("scmMine").onchange = (e)=>{ scOnlyMine = e.target.checked; scSel = null; renderSchoolSchedule(stableId); };
    el("segCal").querySelectorAll("[data-c]").forEach(b=> b.onclick = ()=>{
      const c = b.getAttribute("data-c");
      if(scCalMode !== c){
        scCalMode = c;
        if(c === "month"){ const a = new Date(weekStart2); scMonthDate = new Date(a.getFullYear(), a.getMonth(), 1); }
        renderSchoolSchedule(stableId);
      }
    });
    await drawSchoolWeek();
  }catch(e){ el("scsShell").innerHTML = msg("Kunde inte öppna schemat: " + (e.message||e) + " (har du kört db/ridskola.sql?)", "err"); }
}

async function drawSchoolWeek(){
  const host = el("scsGrid"); if(!host) return;
  if(scCalMode === "month"){ drawSchoolMonth(); return; }
  const gids = scData.groups.map(g=> g.id);
  const startISO = isoDate(weekStart2);
  const endD = new Date(weekStart2); endD.setDate(endD.getDate()+6);
  const endISO = isoDate(endD);
  scWeekAsg = []; scWeekAbs = []; scWeekNotes = []; scWeekTAbs = [];
  if(gids.length && scSchedMode === "lessons"){
    const [aq, bq, nq] = await Promise.all([
      db.from("rs_assignment").select("*").in("group_id", gids).gte("lesson_date", startISO).lte("lesson_date", endISO),
      db.from("rs_absence").select("*").in("group_id", gids).gte("lesson_date", startISO).lte("lesson_date", endISO),
      db.from("rs_lesson_note").select("*").in("group_id", gids).gte("lesson_date", startISO).lte("lesson_date", endISO)
    ]);
    scWeekAsg = aq.error?[]:aq.data; scWeekAbs = bq.error?[]:bq.data; scWeekNotes = nq.error?[]:nq.data;
  }
  if(scSchedMode === "tasks" && (scData.tasks||[]).length){
    const [tq, lq, sq] = await Promise.all([
      db.from("rs_task_absence").select("*").in("task_id", scData.tasks.map(t=> t.id)).gte("work_date", startISO).lte("work_date", endISO),
      db.from("rs_leave").select("*").eq("status","approved").lte("start_date", endISO).gte("end_date", startISO),
      db.from("rs_task_swap").select("*").in("task_id", scData.tasks.map(t=> t.id)).gte("work_date", startISO).lte("work_date", endISO).neq("status","declined")
    ]);
    scWeekTAbs = tq.error?[]:tq.data;
    scWeekLeave = lq.error?[]:lq.data;
    scWeekSwap = sq.error?[]:sq.data;
  } else { scWeekLeave = []; scWeekSwap = []; }
  let items = scSchedMode === "lessons"
    ? scData.groups.map(g=> ({ type:"les", o:g, wd:g.weekday, start:timeKey(g), dur:g.duration_min||60 }))
    : (scData.tasks||[]).map(t=> ({ type:"task", o:t, wd:t.weekday, start:timeKey(t), dur:t.duration_min||60 }));
  if(scOnlyMine) items = items.filter(i=> i.type === "les" ? scMineLesson(i.o) : scMineTask(i.o));
  if(!items.length){
    host.innerHTML = `<div class="empty">${scOnlyMine ? `Inget som rör dig här — välj "Alla ${scSchedMode==="lessons"?"lektioner":"pass"}" för att se allt.` : scSchedMode==="lessons" ? "Inga lektioner än — skapa lektioner under Inställningar." : "Inga arbetspass än — skapa dem under Inställningar."}</div>`;
    el("scsDetail").innerHTML = ""; scLegend(false); return;
  }
  const days = scCalMode === "day" ? [scDayOff+1] : [1,2,3,4,5,6,7].filter(wd=> items.some(i=> i.wd === wd));
  const tmin = Math.floor(Math.min(...items.map(i=> i.start))/60)*60;
  const tmax = Math.ceil(Math.max(...items.map(i=> i.start+i.dur))/60)*60;
  const PX = 1.1;   // pixlar per minut
  const bodyH = Math.max(60, (tmax-tmin)*PX);
  const tISO = isoDate(new Date());
  const catTint = {}; let ci = 0;
  scData.groups.forEach(g=>{ const k=g.category_id||"none"; if(k!=="none" && !(k in catTint)){ catTint[k]=CAT_HUES[ci%CAT_HUES.length]; ci++; } });
  let hourLbls = "";
  for(let m=tmin; m<=tmax; m+=60) hourLbls += `<div class="hlbl" style="top:${(m-tmin)*PX}px">${String(Math.floor(m/60)).padStart(2,"0")}:00</div>`;
  let anyMine = false;
  let cols = `<div class="gut"><div class="dhead">&nbsp;</div><div class="gbody" style="height:${bodyH}px">${hourLbls}</div></div>`;
  days.forEach(wd=>{
    const d = new Date(weekStart2); d.setDate(d.getDate()+wd-1);
    const dISO = isoDate(d);
    const blocks = items.filter(i=> i.wd === wd).sort((a,b)=> a.start-b.start || a.dur-b.dur);
    const lanes = [];   // parallella lektioner läggs sida vid sida
    blocks.forEach(b=>{ let li = lanes.findIndex(e=> e <= b.start); if(li<0){ lanes.push(0); li = lanes.length-1; } lanes[li] = b.start + b.dur; b.lane = li; });
    const nl = Math.max(1, lanes.length);
    let hl = "";
    for(let m=tmin+60; m<tmax; m+=60) hl += `<div class="hline" style="top:${(m-tmin)*PX}px"></div>`;
    const bl = blocks.map(b=>{
      const isSel = scSel && scSel.type===b.type && scSel.id===b.o.id && scSel.wd===wd;
      // det jag själv står på färgas i stallets gröna — övrigt behåller sin vanliga färg
      const isMine = b.type==="les" ? scMineLesson(b.o) : scMineTaskOn(b.o, dISO);
      if(isMine) anyMine = true;
      let tint;
      if(isMine){
        tint = `background:var(--mine-blk);border-color:var(--mine-brd)`;
      } else if(b.type==="les"){
        const hu = hashHue(String(b.o.id));   // egen färg per lektion, som profilfärgerna i jouren
        tint = `background:hsla(${hu},45%,45%,.18);border-color:hsla(${hu},40%,42%,.6)`;
      } else tint = `background:var(--card-2);border-color:var(--muted)`;
      const hasNote = b.type==="les" && scWeekNotes.some(x=> x.group_id===b.o.id && x.lesson_date===dISO && (x.note||"").trim());
      const clash = b.type==="les" && lessonConflicts(b.o).length > 0;
      const w = 100/nl;
      return `<div class="scblk${b.type==="task"?" task":""}${isMine?" mine":""}${isSel?" sel":""}${clash?" clash":""}" data-selblk="${b.type}|${b.o.id}|${wd}"
        style="top:${(b.start-tmin)*PX}px;height:${Math.max(26, b.dur*PX-2)}px;left:calc(${b.lane*w}% + 3px);width:calc(${w}% - 6px);${tint}">
        <b>${clash?"⚠ ":""}${esc(b.o.name)}</b>${b.o.start_time}–${rsEndTime(b.o.start_time, b.o.duration_min)}${hasNote?" ✎":""}</div>`;
    }).join("");
    const printBtn = scSchedMode==="lessons" && blocks.length
      ? `<button class="x dayprint" data-printday="${dISO}|${wd}" title="Skriv ut dagens schema">${ic("printer")}</button>` : "";
    cols += `<div class="day"><div class="dhead${dISO===tISO?" today":""}">${RS_WD[wd].slice(0,3)} ${d.getDate()}/${d.getMonth()+1}${printBtn}</div>
      <div class="dbody" style="height:${bodyH}px">${hl}${bl}</div></div>`;
  });
  host.innerHTML = `<div class="scg${scCalMode==="day"?" dayview":""}">${cols}</div>`;
  scLegend(anyMine);
  host.querySelectorAll("[data-selblk]").forEach(n=> n.onclick = ()=>{
    const [tp, id, wd] = n.getAttribute("data-selblk").split("|");
    scSel = { type: tp, id, wd: parseInt(wd,10) };
    scNoteOpen = false;
    host.querySelectorAll(".scblk").forEach(x=> x.classList.remove("sel"));
    n.classList.add("sel");
    drawScsDetail();
  });
  host.querySelectorAll("[data-printday]").forEach(b=> b.onclick = (e)=>{
    e.stopPropagation();
    const [dISO, wd] = b.getAttribute("data-printday").split("|");
    printSchoolDay(dISO, parseInt(wd,10));
  });
  drawScsDetail();
}

/* Månadsvy: kalenderöversikt med små chips per dag — klick öppnar dagvyn */
function drawSchoolMonth(){
  const host = el("scsGrid"); if(!host) return;
  let items = scSchedMode === "lessons"
    ? scData.groups.map(g=> ({ type:"les", o:g, wd:g.weekday, start:timeKey(g) }))
    : (scData.tasks||[]).map(t=> ({ type:"task", o:t, wd:t.weekday, start:timeKey(t) }));
  if(scOnlyMine) items = items.filter(i=> i.type === "les" ? scMineLesson(i.o) : scMineTask(i.o));
  const first = new Date(scMonthDate.getFullYear(), scMonthDate.getMonth(), 1);
  const startO = (first.getDay()+6)%7;
  const daysInMonth = new Date(first.getFullYear(), first.getMonth()+1, 0).getDate();
  const weeks = Math.ceil((startO + daysInMonth) / 7);
  const tISO = isoDate(new Date());
  let anyMine = false;
  let cells = [1,2,3,4,5,6,7].map(wd=> `<div class="mhead">${RS_WD[wd].slice(0,3)}</div>`).join("");
  for(let i=0; i<weeks*7; i++){
    const d = new Date(first); d.setDate(1 - startO + i);
    const inMonth = d.getMonth() === first.getMonth();
    const wd = ((d.getDay()+6)%7)+1;
    const dISO = isoDate(d);
    const chips = inMonth ? items.filter(x=> x.wd === wd).sort((a,b)=> a.start-b.start).map(x=>{
      const isMine = x.type==="les" ? scMineLesson(x.o) : scMineTaskOn(x.o, dISO);
      if(isMine) anyMine = true;
      const hu = x.type==="les" ? hashHue(String(x.o.id)) : null;
      const st = isMine ? `background:var(--mine-blk);border:1px solid var(--mine-brd);border-left-width:3px`
        : x.type==="les" ? `background:hsla(${hu},45%,45%,.22)` : `background:var(--card-2);border:1px dashed var(--muted)`;
      return `<div class="mchip" style="${st}">${x.o.start_time} ${esc(x.o.name)}</div>`;
    }).join("") : "";
    cells += `<div class="mcell${inMonth?"":" mout"}${dISO===tISO?" mtoday":""}" ${inMonth?`data-mday="${dISO}"`:""}>
      <div class="mnum">${d.getDate()}</div>${chips}</div>`;
  }
  host.innerHTML = `<div class="mgrid">${cells}</div>`;
  scLegend(anyMine);
  el("scsDetail").innerHTML = `<div class="card"><div class="empty">Klicka på en dag för att öppna dagvyn.</div></div>`;
  host.querySelectorAll("[data-mday]").forEach(c=> c.onclick = ()=>{
    const d = new Date(c.getAttribute("data-mday") + "T00:00:00");
    weekStart2 = startOfWeek(d);
    scDayOff = (d.getDay()+6)%7;
    scCalMode = "day"; scSel = null;
    renderSchoolSchedule(scStableId);
  });
}

/* Skriv ut en dags lektioner (öppnar utskriftsdialogen — välj "Spara som PDF") */
function printSchoolDay(dISO, wd){
  const d = new Date(dISO+"T00:00:00");
  const lessons = scData.groups.filter(g=> g.weekday === wd).slice().sort((a,b)=> timeKey(a)-timeKey(b));
  let html = `<div class="phead">
    <div><div class="ptitle">${esc(scData.stable.name)}</div><div class="pdate">${RS_WD[wd]} ${d.getDate()}/${d.getMonth()+1} ${d.getFullYear()} · Dagens schema</div></div>
    <div class="pbrand"><img src="logo-print.png" alt=""><span>EquiWorks</span></div>
  </div>`;
  lessons.forEach(g=>{
    const staffN = (scData.gstaff||[]).filter(x=> x.group_id===g.id).map(x=> ((scData.staff||[]).find(f=> f.id===x.staff_id)||{}).name).filter(Boolean);
    const instrN = g.has_leaders ? (scData.ginstr||[]).filter(x=> x.group_id===g.id).map(x=> ((scData.instructors||[]).find(i=> i.id===x.instructor_id)||{}).name).filter(Boolean) : [];
    const note = scWeekNotes.find(x=> x.group_id===g.id && x.lesson_date===dISO);
    const studs = scData.gstud.filter(x=> x.group_id===g.id).map(x=> scData.students.find(s=> s.id===x.student_id)).filter(Boolean);
    const rows = studs.map(s=>{
      const a = scWeekAsg.find(x=> x.group_id===g.id && x.lesson_date===dISO && x.student_id===s.id);
      const sick = scWeekAbs.some(x=> x.group_id===g.id && x.lesson_date===dISO && x.student_id===s.id);
      const hn = a && a.horse_id ? (((scData.horses||[]).find(h=> h.id===a.horse_id)||{}).name || "?") : "–";
      return `<tr><td>${esc(s.name)}${sick?" (sjukanmäld)":""}</td><td>${sick?"–":esc(hn)}</td></tr>`;
    }).join("");
    const linked = (scData.ghorse||[]).filter(x=> x.group_id===g.id).map(x=> (scData.horses||[]).find(h=> h.id===x.horse_id)).filter(Boolean);
    const taken = new Set(studs.map(s=> (scWeekAsg.find(x=> x.group_id===g.id && x.lesson_date===dISO && x.student_id===s.id)||{}).horse_id).filter(Boolean));
    const freeH = linked.filter(h=> !taken.has(h.id));
    const leaderBits = [...staffN, ...instrN];
    html += `<div class="psec">
      <h2>${g.start_time}–${rsEndTime(g.start_time, g.duration_min)} · ${esc(g.name)}${g.category&&g.category.name?` (${esc(g.category.name)})`:""}${g.place_id?` · ${esc((((scData.places||[]).find(p=> p.id === g.place_id))||{}).name||"")}`:""}</h2>
      ${note && (note.note||"").trim() ? `<p class="pnote">Planering: ${esc(note.note)}</p>` : ""}
      <p class="pmeta">Ridlärare/ledare: ${leaderBits.length? leaderBits.map(esc).join(", ") : "–"}</p>
      ${rows ? `<table><tr><th>Elev</th><th>Häst</th></tr>${rows}</table>` : `<p class="pmeta">Inga elever på lektionen.</p>`}
      ${freeH.length ? `<p class="pmeta">Ej tilldelade hästar: ${freeH.map(h=> esc(h.name)).join(", ")}</p>` : ""}
    </div>`;
  });
  let ps = el("printSheet");
  if(!ps){ ps = document.createElement("div"); ps.id = "printSheet"; ps.className = "printsheet"; document.body.appendChild(ps); }
  ps.innerHTML = html;
  window.print();
}

/* Detaljpanel under schemat: info om vald lektion / valt arbetspass */
function drawScsDetail(){
  const host = el("scsDetail"); if(!host) return;
  const canL = curPerm==="admin" || curPerm==="teacher";
  if(!scSel){ host.innerHTML = `<div class="card"><div class="empty">Klicka på ${scSchedMode==="lessons"?"en lektion":"ett arbetspass"} i schemat för att se detaljer.</div></div>`; return; }
  const d = new Date(weekStart2); d.setDate(d.getDate()+scSel.wd-1);
  const dISO = isoDate(d);
  const tISO = isoDate(new Date());
  const dateLbl = `${RS_WD[scSel.wd]} ${d.getDate()}/${d.getMonth()+1}`;
  if(scSel.type === "task"){
    const tk = (scData.tasks||[]).find(x=> x.id === scSel.id); if(!tk){ scSel=null; host.innerHTML=""; return; }
    const canT = curPerm === "admin" || curPerm === "chef";
    const myStaff = rsMyStaffIds();
    const tStaff = (scData.taskStaff||[]).filter(x=> x.task_id === tk.id)
      .map(x=> (scData.staff||[]).find(f=> f.id === x.staff_id)).filter(Boolean);
    const wWarns = taskWorkWarnings(tk);
    const staffById = id=> (scData.staff||[]).find(f=> f.id === id);
    const staffName = id=> (staffById(id)||{}).name || "?";
    const swAll = (scWeekSwap||[]).filter(s=> s.task_id === tk.id && s.work_date === dISO);
    const swAct = swAll.filter(swapActive);
    const baseIds = tStaff.map(f=> f.id);
    const eff = taskEffectiveStaff(baseIds, swAct);
    const extra = [...eff].filter(id=> !baseIds.includes(id)).map(staffById).filter(Boolean);
    const clashes = (fid, other)=>{
      const s1 = timeKey(tk), e1 = s1 + (tk.duration_min||60);
      const s2 = timeKey(other), e2 = s2 + (other.duration_min||60);
      return other.id !== tk.id && other.weekday === tk.weekday && s1 < e2 && s2 < e1;
    };
    const otherTasksFor = fid=> (scData.taskStaff||[]).filter(x=> x.staff_id === fid)
      .map(x=> (scData.tasks||[]).find(t2=> t2.id === x.task_id)).filter(Boolean);
    extra.forEach(f=> otherTasksFor(f.id).forEach(o=>{
      if(clashes(f.id, o)) wWarns.push(`${f.name} är inbytt här men har redan ${o.name} (${o.start_time}–${rsEndTime(o.start_time, o.duration_min)}) samma dag`);
    }));
    const waitingFor = fid=> swAll.some(s=> swapWaiting(s) && (s.giver_staff === fid || s.taker_staff === fid));
    const canSwapNow = myStaff.size > 0 && dISO >= tISO;
    const rows = [...tStaff, ...extra].map(f=>{
      const mine = myStaff.has(f.id);
      const mineBit = mine ? ` <span class="tagpill">du</span>` : "";
      const gaveAway = swAct.find(s=> s.giver_staff === f.id);
      if(gaveAway && !eff.has(f.id)){
        return `<div class="scsrow scssick"><span class="scsname">${esc(f.name)}${mineBit}</span><span class="tagpill st-no" title="Bytt bort till ${esc(staffName(gaveAway.taker_staff))}">bytt bort</span></div>`;
      }
      const swappedIn = !baseIds.includes(f.id) ? ` <span class="tagpill">inbytt</span>` : "";
      const onLeave = scWeekLeave.find(x=> x.staff_id===f.id && x.start_date <= dISO && x.end_date >= dISO);
      if(onLeave){
        wWarns.push(`${f.name} har beviljad ${onLeave.kind} det här datumet — passet kan behöva täckas`);
        return `<div class="scsrow scssick"><span class="scsname">${esc(f.name)}${mineBit}${swappedIn}</span><span class="tagpill st-no" title="Beviljad ${esc(onLeave.kind)}">ledig</span></div>`;
      }
      const sick = scWeekTAbs.some(x=> x.task_id===tk.id && x.work_date===dISO && x.staff_id===f.id);
      const sickBit = sick
        ? `<span class="tagpill st-no" ${mine||canT?`data-tunsick="${tk.id}|${dISO}|${f.id}" style="cursor:pointer" title="Ta bort sjukanmälan"`:""}>sjuk</span>`
        : ((mine || canT) && dISO >= tISO ? `<button class="btn sm" data-tsick="${tk.id}|${dISO}|${f.id}">Sjukanmäl</button>` : "");
      let swapBit = "";
      if(canSwapNow && !sick && !waitingFor(f.id)){
        if(mine) swapBit = `<button class="btn sm" data-swgive="${tk.id}|${dISO}|${f.id}">Erbjud bort</button>`;
        else swapBit = `<button class="btn sm" data-swtake="${tk.id}|${dISO}|${f.id}">Ta över</button>`;
      }
      return `<div class="scsrow${sick?" scssick":""}"><span class="scsname">${esc(f.name)}${mineBit}${swappedIn}</span>${swapBit}${sickBit}</div>`;
    }).join("");
    const swCtx = { name: staffName, mineIds: myStaff, isChef: canT, canCancel: true };
    const swHtml = swAll.map(s=> swapNote(s, swCtx)).join("");
    const swapCandidates = ()=> (scData.staff||[]).filter(f=> !eff.has(f.id)).map(f=>{
      const lv = scWeekLeave.find(x=> x.staff_id===f.id && x.start_date <= dISO && x.end_date >= dISO);
      let busy = lv ? lv.kind : "";
      if(!busy && otherTasksFor(f.id).some(o=> clashes(f.id, o))) busy = "har annat pass";
      return { id: f.id, name: f.name, busy };
    });
    host.innerHTML = `<div class="card">
      <div style="display:flex;align-items:baseline;gap:8px;flex-wrap:wrap">
        <b>${esc(tk.name)}</b>
        <span class="meta2">${dateLbl} · ${tk.start_time}–${rsEndTime(tk.start_time, tk.duration_min)}</span>
        <span class="tagpill">arbetspass</span>
      </div>
      ${tk.description?`<div class="meta2" style="margin-top:4px">${esc(tk.description)}</div>`:""}
      ${wWarns.map(w=> `<div class="msg warn" style="margin-top:8px;margin-bottom:0">⚠ ${esc(w)}</div>`).join("")}
      <div style="margin-top:10px"><b style="font-size:.85rem">Personal</b>
        ${rows || `<div class="msg warn" style="margin-top:6px">⚠ Ingen personal tilldelad än — lägg till under Inställningar → Arbetspass.</div>`}
      </div>
      ${swHtml ? `<div style="margin-top:10px">${swHtml}</div>` : ""}
    </div>`;
    host.querySelectorAll("[data-swgive]").forEach(b=> b.onclick = ()=>{
      const [tid, dI, fid] = b.getAttribute("data-swgive").split("|");
      swapDialog("give", { stableId: scStableId, taskId: tid, taskName: tk.name, dISO: dI, giverId: fid,
        candidates: swapCandidates(), done: ()=> renderSchoolSchedule(scStableId) });
    });
    host.querySelectorAll("[data-swtake]").forEach(b=> b.onclick = ()=>{
      const [tid, dI, fid] = b.getAttribute("data-swtake").split("|");
      swapDialog("take", { stableId: scStableId, taskId: tid, taskName: tk.name, dISO: dI, giverId: fid,
        giverName: staffName(fid), takerId: [...myStaff][0], done: ()=> renderSchoolSchedule(scStableId) });
    });
    bindSwapButtons(host, ()=> renderSchoolSchedule(scStableId));
    host.querySelectorAll("[data-tsick]").forEach(b=> b.onclick = async ()=>{
      const [tid, dI, fid] = b.getAttribute("data-tsick").split("|");
      const f = (scData.staff||[]).find(x=> x.id === fid);
      const dd = new Date(dI+"T00:00:00");
      if(!(await confirmDialog(`Sjukanmäla ${f?f.name:"personen"} från passet ${RS_WD[((dd.getDay()+6)%7)+1].toLowerCase()} ${dd.getDate()}/${dd.getMonth()+1}?`, { title:"Sjukanmälan", okText:"Ja, sjukanmäl", primary:true }))) return;
      const r = await db.from("rs_task_absence").insert({ task_id: tid, work_date: dI, staff_id: fid });
      if(r.error){ alert("Kunde inte sjukanmäla: " + r.error.message + " (har db/arbetspass2.sql körts?)"); return; }
      scWeekTAbs.push({ task_id: tid, work_date: dI, staff_id: fid });
      drawScsDetail();
    });
    host.querySelectorAll("[data-tunsick]").forEach(b=> b.onclick = async ()=>{
      const [tid, dI, fid] = b.getAttribute("data-tunsick").split("|");
      if(!(await confirmDialog("Ta bort sjukanmälan?", { okText:"Ja, ta bort" }))) return;
      await db.from("rs_task_absence").delete().eq("task_id",tid).eq("work_date",dI).eq("staff_id",fid);
      scWeekTAbs = scWeekTAbs.filter(x=> !(x.task_id===tid && x.work_date===dI && x.staff_id===fid));
      drawScsDetail();
    });
    return;
  }
  const g = scData.groups.find(x=> x.id === scSel.id); if(!g){ scSel=null; host.innerHTML=""; return; }
  const myStud = rsMyStudentIds();
  const gstaffNames = (scData.gstaff||[]).filter(x=> x.group_id===g.id)
    .map(x=> ((scData.staff||[]).find(f=> f.id===x.staff_id)||{}).name).filter(Boolean);
  const instrNames = g.has_leaders ? (scData.ginstr||[]).filter(x=> x.group_id===g.id)
    .map(x=> ((scData.instructors||[]).find(i=> i.id===x.instructor_id)||{}).name).filter(Boolean) : [];
  const leaders = gstaffNames;
  const linkedHorses = (scData.ghorse||[]).filter(x=> x.group_id===g.id)
    .map(x=> scData.horses.find(h=> h.id===x.horse_id)).filter(Boolean);
  const horsePool = linkedHorses.length ? linkedHorses : scData.horses;
  const studs = scData.gstud.filter(x=> x.group_id===g.id).map(x=> scData.students.find(s=> s.id===x.student_id)).filter(Boolean);
  const asgFor = sid=> scWeekAsg.find(x=> x.group_id===g.id && x.lesson_date===dISO && x.student_id===sid);
  const sickFor = sid=> scWeekAbs.some(x=> x.group_id===g.id && x.lesson_date===dISO && x.student_id===sid);
  const rows = studs.map(s=>{
    const a = asgFor(s.id);
    const sick = sickFor(s.id);
    const mine = myStud.has(s.id);
    let horseCell;
    if(canL){
      const poolPlus = (a && a.horse_id && !horsePool.some(h=> h.id===a.horse_id))
        ? [...horsePool, scData.horses.find(h=> h.id===a.horse_id)].filter(Boolean) : horsePool;
      const hO = `<option value="">– välj häst –</option>` + poolPlus.map(h=>{
        const other = studs.find(s2=> s2.id !== s.id && (asgFor(s2.id)||{}).horse_id === h.id);
        return `<option value="${h.id}"${a&&a.horse_id===h.id?" selected":""}>${esc(h.name)}${other?` (${esc(other.name)})`:""}</option>`;
      }).join("");
      horseCell = `<select class="schorse" data-asg="${g.id}|${dISO}|${s.id}">${hO}</select>`;
    } else {
      const hn = a && a.horse_id ? ((scData.horses.find(h=> h.id===a.horse_id)||{}).name || "?") : "–";
      horseCell = `<span class="meta2">${esc(hn)}</span>`;
    }
    const sickBit = sick ? `<span class="tagpill st-no" ${mine||canL?`data-unsick="${g.id}|${dISO}|${s.id}" style="cursor:pointer" title="Ta bort sjukanmälan"`:""}>sjuk</span>`
      : (((mine || canL) && dISO >= tISO) ? `<button class="btn sm" data-sick="${g.id}|${dISO}|${s.id}">Sjukanmäl</button>` : "");
    return `<div class="scsrow${sick?" scssick":""}"><span class="scsname">${esc(s.name)}${mine?` <span class="tagpill">din</span>`:""}</span>${horseCell}${sickBit}</div>`;
  }).join("");
  // Varningar: krockar, dubbeltilldelad häst (tillåtet men flaggas) + elever utan häst
  const warns = [];
  lessonConflicts(g).forEach(c=>{
    const both = g.place_id && c.place_id;
    const pn = both ? (((scData.places||[]).find(p=> p.id === g.place_id)||{}).name || "?") : null;
    warns.push(`Krockar med ${c.name} (${c.start_time}–${rsEndTime(c.start_time, c.duration_min)})${both ? ` — samma plats (${pn})` : " — ange olika platser om de ska gå samtidigt"}`);
  });
  const byHorse = {};
  studs.forEach(s=>{ if(sickFor(s.id)) return; const a=asgFor(s.id); if(a && a.horse_id){ (byHorse[a.horse_id]=byHorse[a.horse_id]||[]).push(s.name); } });
  Object.entries(byHorse).filter(([,names])=> names.length>1).forEach(([hid,names])=>{
    const hn = ((scData.horses.find(h=> h.id===hid)||{}).name)||"?";
    warns.push(`${hn} är tilldelad flera elever samtidigt: ${names.join(", ")}`);
  });
  const noHorse = studs.filter(s=> !sickFor(s.id) && !((asgFor(s.id)||{}).horse_id));
  if(noHorse.length && studs.length) warns.push(noHorse.length===1
    ? `${noHorse[0].name} har ingen häst tilldelad än`
    : `${noHorse.length} elever har ingen häst tilldelad än: ${noHorse.map(s=>s.name).join(", ")}`);
  const takenIds = new Set(studs.map(s=> (asgFor(s.id)||{}).horse_id).filter(Boolean));
  const freeHorses = linkedHorses.filter(h=> !takenIds.has(h.id));
  const adminBtns = canL ? `<div class="notifbtns" style="margin-top:10px">
      <button class="btn sm" data-copyw="${g.id}|${dISO}">Kopiera förra veckan</button>
      <button class="btn sm" data-rot="${g.id}|${dISO}">Rotera hästar</button>
    </div>` : "";
  host.innerHTML = `<div class="card">
    <div style="display:flex;align-items:baseline;gap:8px;flex-wrap:wrap">
      <b>${esc(g.name)}</b>
      <span class="meta2">${dateLbl} · ${g.start_time}–${rsEndTime(g.start_time, g.duration_min)}</span>
      ${g.category&&g.category.name?`<span class="tagpill">${esc(g.category.name)}</span>`:""}
      ${g.place_id?`<span class="tagpill">${esc((((scData.places||[]).find(p=> p.id === g.place_id))||{}).name||"?")}</span>`:""}
      <span class="meta2" style="margin-left:auto">byte efter ${g.horse_rotation} ggr</span>
    </div>
    ${g.description?`<div class="meta2" style="margin-top:4px">${esc(g.description)}</div>`:""}
    <div class="meta2" style="margin-top:4px">Ridlärare: ${leaders.length? leaders.map(esc).join(", ") : "ingen kopplad än"}</div>
    ${g.has_leaders?`<div class="meta2" style="margin-top:2px">Ledare: ${instrNames.length? instrNames.map(esc).join(", ") : "ingen vald än"}</div>`:""}
    ${(function(){
      const note = scWeekNotes.find(x=> x.group_id===g.id && x.lesson_date===dISO);
      const txt = note && (note.note||"").trim();
      let h = `<div style="margin-top:10px"><b style="font-size:.85rem">Planering · ${esc(dateLbl)}</b>`;
      if(scNoteOpen && canL){
        h += `<textarea id="scsNote" rows="3" placeholder="Vad ska ni göra just den här lektionen?" style="margin-top:6px">${esc(txt||"")}</textarea>
          <div class="editbtns" style="margin-top:6px"><button class="btn primary sm" id="scsNoteSave">Spara</button><button class="btn sm" id="scsNoteCancel">Avbryt</button></div>`;
      } else {
        h += txt ? `<div class="meta2" style="margin-top:4px;white-space:pre-wrap">${esc(txt)}</div>` : `<div class="meta2" style="margin-top:4px">Ingen planering för dagen än</div>`;
        if(canL) h += `<div style="margin-top:6px"><button class="btn sm" id="scsNoteEdit">${txt?"Ändra planering":"+ Lägg till planering"}</button></div>`;
      }
      return h + `</div>`;
    })()}
    ${warns.map(w=> `<div class="msg warn" style="margin-top:8px;margin-bottom:0">⚠ ${esc(w)}</div>`).join("")}
    <div id="scsRotWarn"></div>
    <div style="margin-top:10px"><b style="font-size:.85rem">Elever & hästar</b>
      ${rows || `<div class="empty">Inga elever på lektionen än — lägg till i Inställningar.</div>`}
    </div>
    ${linkedHorses.length ? `<div style="margin-top:10px"><b style="font-size:.85rem">Ej tilldelade hästar</b>
      <div class="meta2" style="margin-top:2px">${freeHorses.length ? freeHorses.map(h=> esc(h.name)).join(", ") : "– alla lektionens hästar är tilldelade"}</div></div>` : ""}
    ${adminBtns}
  </div>`;
  const neBtn = el("scsNoteEdit"); if(neBtn) neBtn.onclick = ()=>{ scNoteOpen = true; drawScsDetail(); };
  const ncBtn = el("scsNoteCancel"); if(ncBtn) ncBtn.onclick = ()=>{ scNoteOpen = false; drawScsDetail(); };
  const nsBtn = el("scsNoteSave"); if(nsBtn) nsBtn.onclick = async ()=>{
    const val = (el("scsNote").value||"").trim();
    let r;
    if(val) r = await db.from("rs_lesson_note").upsert({ group_id: g.id, lesson_date: dISO, note: val });
    else r = await db.from("rs_lesson_note").delete().eq("group_id", g.id).eq("lesson_date", dISO);
    if(r.error){ alert("Kunde inte spara planeringen: " + r.error.message + " (har du kört db/planering.sql?)"); return; }
    scWeekNotes = scWeekNotes.filter(x=> !(x.group_id===g.id && x.lesson_date===dISO));
    if(val) scWeekNotes.push({ group_id: g.id, lesson_date: dISO, note: val });
    scNoteOpen = false;
    drawSchoolWeek();
  };
  host.querySelectorAll("[data-asg]").forEach(sel=> sel.onchange = async ()=>{
    const [gid, dI, sid] = sel.getAttribute("data-asg").split("|");
    const hid = sel.value || null;
    const r = await db.from("rs_assignment").upsert({ group_id: gid, lesson_date: dI, student_id: sid, horse_id: hid });
    if(r.error){ alert("Kunde inte spara: " + r.error.message); return; }
    const ex = scWeekAsg.find(x=> x.group_id===gid && x.lesson_date===dI && x.student_id===sid);
    if(ex) ex.horse_id = hid; else scWeekAsg.push({ group_id: gid, lesson_date: dI, student_id: sid, horse_id: hid });
    drawScsDetail();
  });
  host.querySelectorAll("[data-sick]").forEach(b=> b.onclick = async ()=>{
    const [gid, dI, sid] = b.getAttribute("data-sick").split("|");
    const s = scData.students.find(x=> x.id === sid);
    const dd = new Date(dI+"T00:00:00");
    if(!(await confirmDialog(`Sjukanmäla ${s?s.name:"eleven"} till lektionen ${RS_WD[((dd.getDay()+6)%7)+1].toLowerCase()} ${dd.getDate()}/${dd.getMonth()+1}?`, { title:"Sjukanmälan", okText:"Ja, sjukanmäl", primary:true }))) return;
    const r = await db.from("rs_absence").insert({ group_id: gid, lesson_date: dI, student_id: sid });
    if(r.error){ alert("Kunde inte sjukanmäla: " + r.error.message); return; }
    scWeekAbs.push({ group_id: gid, lesson_date: dI, student_id: sid });
    drawScsDetail();
  });
  host.querySelectorAll("[data-unsick]").forEach(b=> b.onclick = async ()=>{
    const [gid, dI, sid] = b.getAttribute("data-unsick").split("|");
    if(!(await confirmDialog("Ta bort sjukanmälan?", { okText:"Ja, ta bort" }))) return;
    await db.from("rs_absence").delete().eq("group_id",gid).eq("lesson_date",dI).eq("student_id",sid);
    scWeekAbs = scWeekAbs.filter(x=> !(x.group_id===gid && x.lesson_date===dI && x.student_id===sid));
    drawScsDetail();
  });
  host.querySelectorAll("[data-copyw]").forEach(b=> b.onclick = async ()=>{
    const [gid, dI] = b.getAttribute("data-copyw").split("|");
    const prev = new Date(dI+"T00:00:00"); prev.setDate(prev.getDate()-7);
    const pq = await db.from("rs_assignment").select("*").eq("group_id", gid).eq("lesson_date", isoDate(prev));
    if(pq.error || !(pq.data||[]).length){ infoDialog("Hittade ingen tilldelning förra veckan att kopiera.", "Inget att kopiera"); return; }
    const rows2 = pq.data.map(x=> ({ group_id: gid, lesson_date: dI, student_id: x.student_id, horse_id: x.horse_id }));
    const r = await db.from("rs_assignment").upsert(rows2);
    if(r.error){ alert("Kunde inte kopiera: " + r.error.message); return; }
    drawSchoolWeek();
  });
  host.querySelectorAll("[data-rot]").forEach(b=> b.onclick = async ()=>{
    const [gid, dI] = b.getAttribute("data-rot").split("|");
    const studIds = scData.gstud.filter(x=> x.group_id===gid).map(x=> x.student_id);
    const aq = await db.from("rs_assignment").select("*").eq("group_id", gid).eq("lesson_date", dI);
    const cur = aq.error?[]:aq.data;
    const horses = studIds.map(sid=>{ const a=cur.find(x=> x.student_id===sid); return a? a.horse_id : null; });
    if(!horses.some(Boolean)){ infoDialog("Tilldela hästar först — sedan kan du rotera dem.", "Inget att rotera"); return; }
    const rotated = studIds.map((sid,i)=> ({ group_id: gid, lesson_date: dI, student_id: sid, horse_id: horses[(i-1+horses.length)%horses.length] }));
    const r = await db.from("rs_assignment").upsert(rotated);
    if(r.error){ alert("Kunde inte rotera: " + r.error.message); return; }
    drawSchoolWeek();
  });
  loadRotationHints(g, dISO);
}

/* Rotationshint: räkna hur många gånger i rad varje elev ridit sin nuvarande häst.
   Når streaken lektionens "byt häst efter X ggr" flaggas det i panelen. */
let scRotToken = 0;
async function loadRotationHints(g, dISO){
  const host = el("scsRotWarn"); if(!host) return;
  const token = ++scRotToken;
  const studs = scData.gstud.filter(x=> x.group_id===g.id).map(x=> scData.students.find(s=> s.id===x.student_id)).filter(Boolean);
  if(!studs.length) return;
  const hq = await db.from("rs_assignment").select("*").eq("group_id", g.id).lt("lesson_date", dISO).order("lesson_date",{ascending:false}).limit(300);
  if(hq.error || token !== scRotToken) return;
  const hist = hq.data||[];
  const dates = [...new Set(hist.map(x=> x.lesson_date))];
  const warns = [];
  studs.forEach(s=>{
    const cur = scWeekAsg.find(x=> x.group_id===g.id && x.lesson_date===dISO && x.student_id===s.id);
    if(!cur || !cur.horse_id) return;
    let count = 1;
    for(const d of dates){
      const a = hist.find(x=> x.lesson_date===d && x.student_id===s.id);
      if(a && a.horse_id === cur.horse_id) count++;
      else break;
    }
    if(count >= (g.horse_rotation||1)){
      const hn = ((scData.horses.find(h=> h.id===cur.horse_id)||{}).name)||"?";
      warns.push(`${s.name} har nu ridit ${hn} ${count} gånger i rad — dags att byta häst`);
    }
  });
  if(token !== scRotToken) return;
  const hostNow = el("scsRotWarn"); if(!hostNow) return;
  hostNow.innerHTML = warns.map(w=> `<div class="msg warn" style="margin-top:8px;margin-bottom:0">🔄 ${esc(w)}</div>`).join("");
}

/* ============ Start ============ */
function setSessionFrom(s){ session = s ? { id: s.user.id, email: normEmail(s.user.email) } : null; }
db.auth.onAuthStateChange((_event, s)=>{ setSessionFrom(s); render(); if(session){ applyEmailChange(); refreshAdminFlag(); refreshMyProfiles().then(refreshBellCount); handlePendingCreate(); } });
db.auth.getSession().then(({ data })=>{ setSessionFrom(data.session); render(); if(session){ applyEmailChange(); refreshAdminFlag(); refreshMyProfiles().then(refreshBellCount); handlePendingCreate(); } });
