(() => {
  const DAY = ['', 'Po', 'Út', 'St', 'Čt', 'Pá', 'So', 'Ne'];
  const DAY_LONG = ['', 'Pondělí', 'Úterý', 'Středa', 'Čtvrtek', 'Pátek', 'Sobota', 'Neděle'];
  const MONTHS = ['Leden', 'Únor', 'Březen', 'Duben', 'Květen', 'Červen', 'Červenec', 'Srpen', 'Září', 'Říjen', 'Listopad', 'Prosinec'];
  const SLOTS = ['a', 'b', 'c', 'd', 'e', 'f'];
  const MAX_TRAININGS = SLOTS.length;
  const MAX_GROUPS = 5;
  const DAYS_HINT = 'Změna platí pro týdny, které ještě nemají zápis.';
  const HOME_TITLE = 'Týdenní docházka';
  const $ = id => document.getElementById(id);
  const el = (tag, cls) => { const n = document.createElement(tag); if (cls) n.className = cls; return n; };

  /* dates */
  const pad = n => String(n).padStart(2, '0');
  const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
  const mondayOf = d => addDays(d, 1 - (d.getDay() || 7));
  function isoWeek(d) {
    const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
    t.setUTCDate(t.getUTCDate() + 4 - (t.getUTCDay() || 7));
    const year = t.getUTCFullYear();
    const week = Math.ceil(((t - Date.UTC(year, 0, 1)) / 864e5 + 1) / 7);
    return { year, week };
  }
  function weekId(d) {
    const { year, week } = isoWeek(d);
    return `${year}-W${pad(week)}`;
  }
  function mondayFromId(id) {
    const [y, w] = id.split('-W').map(Number);
    const jan4 = new Date(y, 0, 4);
    return addDays(mondayOf(jan4), (w - 1) * 7);
  }
  /* /dates */

  const shortDate = d => `${d.getDate()}. ${d.getMonth() + 1}.`;
  const tightDate = d => `${d.getDate()}.${d.getMonth() + 1}.`;
  const byName = (a, b) => String(a.name).localeCompare(String(b.name), 'cs');
  const monthOf = d => new Date(d.getFullYear(), d.getMonth(), 1);

  let db = null;
  let downloads = null;
  let offline = false;

  let groups = [];
  let groupsLoaded = false;
  let gid = null;
  let editing = null;
  let confirmGroup = null;
  let newOpen = false;
  let unsubs = [];

  let people = [];
  let weeks = {};
  let peopleLoaded = false;
  let monday = mondayOf(new Date());
  let slot = 'a';
  let slotPicked = false;
  let mode = 'one';
  let tab = 'zapis';
  let gridKey = '';
  let calMonth = monthOf(new Date());
  let confirmDelete = null;
  let confirmCancel = null;
  let openDay = null;
  let swipeStart = null;
  let swiped = false;
  const picked = new Set();

  let overlay = new Map();
  let sending = new Map();
  let flushTimer = null;
  let flushing = false;
  const created = new Set();
  const rowMap = new Map();
  const heads = new Map();

  const validDays = v => Array.isArray(v) && v.length >= 1 && v.length <= MAX_TRAININGS
    && v.every(n => Number.isInteger(n) && n >= 1 && n <= 7) && new Set(v).size === v.length;
  const group = () => groups.find(g => g.id === gid);
  const groupDays = g => (g && validDays(g.days) ? g.days : [2, 4]);
  const daysFor = w => (validDays(weeks[w]?.days) ? weeks[w].days : groupDays(group()));
  const slotsOf = w => SLOTS.slice(0, daysFor(w).length);
  const isCancelled = (w, s) => weeks[w]?.cancelled?.[s] === true;
  const bySession = (a, b) => a.date - b.date || String(a.time).localeCompare(String(b.time));
  const currentKey = () => `${weekId(monday)}|${slot}`;
  const groupRef = () => db.doc(`groups/${gid}`);
  const peopleCol = () => groupRef().collection('people');
  const weekRef = w => groupRef().collection('weeks').doc(w);

  function makeSession(w, s) {
    const k = `${w}|${s}`;
    const mon = mondayFromId(w);
    const ev = weeks[w]?.events?.[s];
    if (ev) return { w, s, k, day: ev.day, date: addDays(mon, ev.day - 1), time: ev.time || '', event: ev };
    const day = daysFor(w)[SLOTS.indexOf(s)];
    return { w, s, k, day, date: addDays(mon, day - 1), time: group()?.times?.[day] || '' };
  }

  function weekSessions(w) {
    const out = slotsOf(w).filter(s => !isCancelled(w, s)).map(s => makeSession(w, s));
    for (const [id, ev] of Object.entries(weeks[w]?.events || {})) {
      if (ev.attendance && !isCancelled(w, id)) out.push(makeSession(w, id));
    }
    return out.sort(bySession);
  }

  const isAlive = (w, s) => weekSessions(w).some(x => x.s === s);
  const sessionsOnDate = date => weekSessions(weekId(date)).filter(s => s.date.getTime() === date.getTime());

  function present(w, s, pid) {
    const k = `${w}|${s}|${pid}`;
    if (overlay.has(k)) return overlay.get(k);
    if (sending.has(k)) return sending.get(k);
    return weeks[w]?.[s]?.[pid] === true;
  }

  function walk(mon, s, dir) {
    const list = weekSessions(weekId(mon));
    const next = list[list.findIndex(x => x.s === s) + dir];
    if (next) return { mon, slot: next.s };
    let m = mon;
    for (let n = 0; n < 200; n += 1) {
      m = addDays(m, 7 * dir);
      const week = weekSessions(weekId(m));
      if (week.length) return { mon: m, slot: (dir > 0 ? week[0] : week[week.length - 1]).s };
    }
    return null;
  }

  function goCurrent() {
    const today = addDays(new Date(), 0);
    let m = mondayOf(today);
    for (let n = 0; n < 200; n += 1) {
      const past = weekSessions(weekId(m)).filter(s => s.date <= today);
      if (past.length) {
        monday = m;
        slot = past[past.length - 1].s;
        return;
      }
      m = addDays(m, -7);
    }
  }

  function setStatus(kind, text) {
    $('status').classList.toggle('error', kind === 'error' || kind === 'retry');
    $('status-text').textContent = text;
    $('retry').hidden = kind !== 'retry';
  }

  function messageFor(e) {
    if (e?.code === 'invalid_argument') return 'Tady můžeš jen číst, změna se neuložila.';
    if (e?.code === 'quota_exceeded') return 'Úložiště je plné. Smaž část jmen.';
    return 'Neuloženo. Zkus to znovu.';
  }

  const sleep = ms => new Promise(r => setTimeout(r, ms));
  async function once(fn) {
    try {
      return await fn();
    } catch (e) {
      if (e?.code !== 'unavailable') throw e;
      await sleep(400 + Math.random() * 600);
      return fn();
    }
  }

  async function guard(fn) {
    if (!db) return false;
    setStatus('saving', 'Ukládám…');
    try {
      await once(fn);
      setStatus('saved', 'Uloženo');
      return true;
    } catch (e) {
      setStatus('error', messageFor(e));
      return false;
    }
  }

  async function writeWeek(w, patch) {
    const ref = weekRef(w);
    const key = `${gid}|${w}`;
    let exists = Boolean(weeks[w]) || created.has(key);
    if (!exists) exists = (await ref.get()).exists;
    if (exists) {
      await ref.update(patch);
      return;
    }
    await ref.set({ days: daysFor(w).slice(), ...patch });
    created.add(key);
  }

  async function flush() {
    clearTimeout(flushTimer);
    if (flushing || !overlay.size || !db) return;
    flushing = true;
    setStatus('saving', 'Ukládám…');
    sending = overlay;
    overlay = new Map();
    const byWeek = new Map();
    for (const [k, v] of sending) {
      const [w, s, pid] = k.split('|');
      if (!byWeek.has(w)) byWeek.set(w, {});
      const patch = byWeek.get(w);
      (patch[s] ||= {})[pid] = v;
    }
    let failed = false;
    try {
      for (const [w, patch] of byWeek) await once(() => writeWeek(w, patch));
      setStatus('saved', 'Uloženo');
    } catch (e) {
      failed = true;
      for (const [k, v] of sending) if (!overlay.has(k)) overlay.set(k, v);
      setStatus('retry', messageFor(e));
    }
    sending = new Map();
    flushing = false;
    if (gid) paint();
    if (!failed && overlay.size) await flush();
  }

  function toggleMark(w, s, pid) {
    overlay.set(`${w}|${s}|${pid}`, !present(w, s, pid));
    paint();
    setStatus('saving', 'Ukládám…');
    clearTimeout(flushTimer);
    flushTimer = setTimeout(flush, 350);
  }

  const sessionHasMarks = s => people.some(p => present(s.w, s.s, p.id));
  const weekHasMarks = w => weekSessions(w).some(sessionHasMarks);

  function allSessions() {
    const thisWeek = mondayOf(new Date());
    let from = thisWeek < monday ? thisWeek : monday;
    let to = thisWeek > monday ? thisWeek : monday;
    for (const id of Object.keys(weeks)) {
      if (!weekHasMarks(id)) continue;
      const mon = mondayFromId(id);
      if (mon < from) from = mon;
      if (mon > to) to = mon;
    }
    const out = [];
    for (let mon = from; mon <= to; mon = addDays(mon, 7)) out.push(...weekSessions(weekId(mon)));
    return out;
  }

  function pickedSessions() {
    return [...picked]
      .map(k => k.split('|'))
      .filter(([w, s]) => isAlive(w, s))
      .map(([w, s]) => makeSession(w, s))
      .sort(bySession);
  }

  function visibleSessions() {
    if (mode === 'one') return [makeSession(weekId(monday), slot)];
    if (mode === 'pick') return pickedSessions();
    return allSessions();
  }

  function ensureActive() {
    for (const k of [...picked]) {
      const [w, s] = k.split('|');
      if (!isAlive(w, s)) picked.delete(k);
    }
    if (isAlive(weekId(monday), slot)) return;
    const last = mode === 'pick' ? pickedSessions().pop() : null;
    if (last) {
      monday = mondayFromId(last.w);
      slot = last.s;
    } else {
      goCurrent();
    }
  }

  function renderGrid() {
    const sessions = visibleSessions();
    const key = JSON.stringify([
      sessions.map(s => [s.k, s.date.getTime(), s.event?.name || '']),
      people.map(p => [p.id, p.name, Boolean(p.example)]),
    ]);
    if (key === gridKey) return false;
    gridKey = key;
    rowMap.clear();
    heads.clear();
    const table = $('grid');
    table.textContent = '';
    table.classList.toggle('single', sessions.length === 1);
    $('grid-wrap').classList.toggle('sticky-head', sessions.length > 1);

    const thead = el('thead');
    const hr = el('tr');
    const corner = el('th', 'who');
    corner.scope = 'col';
    corner.textContent = 'Klepni na jméno';
    hr.append(corner);
    const firstInWeek = new Set(sessions.filter((s, i) => i === 0 || sessions[i - 1].w !== s.w).map(s => s.k));
    for (const s of sessions) {
      const th = el('th', firstInWeek.has(s.k) ? 'col wk' : 'col');
      th.scope = 'col';
      const btn = el('button', s.event ? 'head ev' : 'head');
      btn.type = 'button';
      btn.setAttribute('aria-label', `Zapisovat ${s.event ? s.event.name : DAY_LONG[s.day]} ${shortDate(s.date)}`);
      const day = el('b');
      day.textContent = DAY[s.day];
      const date = el('span');
      date.textContent = tightDate(s.date);
      btn.append(day, date);
      btn.addEventListener('click', () => setActive(mondayFromId(s.w), s.s));
      th.append(btn);
      hr.append(th);
      heads.set(s.k, th);
    }
    thead.append(hr);

    const tbody = el('tbody');
    for (const p of people) {
      const tr = el('tr');
      const who = el('th', 'who');
      who.scope = 'row';
      const btn = el('button', 'who-btn');
      btn.type = 'button';
      btn.id = `tap-${p.id}`;
      btn.append(p.name);
      if (p.example) {
        const tag = el('span', 'tag');
        tag.textContent = 'ukázka';
        btn.append(' ', tag);
      }
      btn.addEventListener('click', () => toggleMark(weekId(monday), slot, p.id));
      who.append(btn);
      tr.append(who);
      const cells = new Map();
      for (const s of sessions) {
        const td = el('td', firstInWeek.has(s.k) ? 'wk' : '');
        const cell = el('button', 'cell');
        cell.type = 'button';
        cell.addEventListener('click', () => toggleMark(s.w, s.s, p.id));
        td.append(cell);
        tr.append(td);
        cells.set(s.k, { td, cell, w: s.w, s: s.s, label: shortDate(s.date) });
      }
      tbody.append(tr);
      rowMap.set(p.id, { cells, btn, name: p.name });
    }
    table.append(thead, tbody);
    return true;
  }

  function alignActive() {
    const wrap = $('grid-wrap');
    const th = heads.get(currentKey());
    const who = wrap.querySelector('th.who');
    if (!th || !who) return;
    const left = th.offsetLeft - who.offsetWidth;
    const right = th.offsetLeft + th.offsetWidth - wrap.clientWidth;
    if (wrap.scrollLeft > left) wrap.scrollLeft = left;
    else if (wrap.scrollLeft < right) wrap.scrollLeft = right;
  }

  function alignGrid() {
    const wrap = $('grid-wrap');
    wrap.scrollLeft = wrap.scrollWidth;
    alignActive();
  }

  function setActive(mon, s, { scroll = false, followCal = false } = {}) {
    monday = mon;
    slot = s;
    slotPicked = true;
    confirmCancel = null;
    if (followCal) calMonth = monthOf(makeSession(weekId(mon), s).date);
    renderCal();
    updateEmpty();
    const rebuilt = renderGrid();
    paint();
    if (rebuilt) alignGrid();
    else if (scroll) alignActive();
  }

  function step(dir) {
    const c = walk(monday, slot, dir);
    if (c) setActive(c.mon, c.slot, { scroll: true, followCal: true });
  }

  function plainEventOpen() {
    if (mode !== 'pick' || openDay === null) return false;
    return sessionsOnDate(new Date(openDay)).length === 0
      && eventsInMonth().some(s => s.date.getTime() === openDay);
  }

  function setMode(next) {
    mode = next;
    confirmCancel = null;
    openDay = null;
    if (next === 'one') {
      slotPicked = false;
      goCurrent();
    }
    if (next === 'pick') {
      if (!picked.size) picked.add(currentKey());
      const last = picked.has(currentKey()) ? makeSession(weekId(monday), slot) : pickedSessions().pop();
      if (last) {
        setActive(mondayFromId(last.w), last.s, { scroll: true, followCal: true });
        return;
      }
    }
    refresh(false);
    alignGrid();
  }

  function togglePick(list) {
    if (!list.every(s => picked.has(s.k))) {
      list.forEach(s => picked.add(s.k));
      setActive(mondayFromId(list[0].w), list[0].s, { scroll: true });
      return;
    }
    list.forEach(s => picked.delete(s.k));
    const last = pickedSessions().pop();
    if (last && list.some(s => s.k === currentKey())) setActive(mondayFromId(last.w), last.s, { scroll: true });
    else refresh(false);
  }

  function moveMonth(dir) {
    calMonth = new Date(calMonth.getFullYear(), calMonth.getMonth() + dir, 1);
    confirmCancel = null;
    const wasOpen = openDay !== null;
    openDay = null;
    renderCal();
    if (wasOpen) {
      updateEmpty();
      alignGrid();
    }
    const grid = $('cal-grid');
    grid.classList.remove('from-next', 'from-prev');
    void grid.offsetWidth;
    grid.classList.add(dir > 0 ? 'from-next' : 'from-prev');
  }

  function cancelledInMonth() {
    const out = [];
    for (const w of Object.keys(weeks).sort()) {
      for (const s of [...slotsOf(w), ...Object.keys(weeks[w].events || {})]) {
        if (!isCancelled(w, s)) continue;
        const session = makeSession(w, s);
        if (monthOf(session.date).getTime() === calMonth.getTime()) out.push(session);
      }
    }
    return out;
  }

  function eventsInMonth() {
    const out = [];
    for (const w of Object.keys(weeks).sort()) {
      for (const id of Object.keys(weeks[w].events || {})) {
        if (isCancelled(w, id)) continue;
        const session = makeSession(w, id);
        if (monthOf(session.date).getTime() === calMonth.getTime()) out.push(session);
      }
    }
    return out.sort(bySession);
  }

  async function cancelTraining(s) {
    await flush();
    for (const k of [...overlay.keys()]) if (k.startsWith(`${s.k}|`)) overlay.delete(k);
    const clear = {};
    for (const [pid, v] of Object.entries(weeks[s.w]?.[s.s] || {})) if (v === true) clear[pid] = false;
    confirmCancel = null;
    openDay = null;
    picked.delete(s.k);
    await guard(() => writeWeek(s.w, { [s.s]: clear, cancelled: { [s.s]: true } }));
    refresh(false);
  }

  function eventDelete(s) {
    if (confirmCancel === s.k) {
      const actions = el('div', 'actions');
      const yes = el('button', 'danger');
      yes.type = 'button';
      yes.textContent = 'Smazat';
      yes.addEventListener('click', () => cancelTraining(s));
      const no = el('button', 'ghost');
      no.type = 'button';
      no.textContent = 'Zpět';
      no.addEventListener('click', () => { confirmCancel = null; renderCalFoot(); });
      actions.append(yes, no);
      return actions;
    }
    const del = el('button', 'link');
    del.type = 'button';
    del.textContent = 'Smazat';
    del.setAttribute('aria-label', `Smazat ${s.event.name}`);
    del.addEventListener('click', () => { confirmCancel = s.k; renderCalFoot(); });
    return del;
  }

  function renderCalFoot() {
    const foot = $('cal-foot');
    foot.textContent = '';
    const count = el('p', 'fine');
    count.textContent = `Vybráno: ${pickedSessions().length}`;
    foot.append(count);

    if (picked.has(currentKey()) && !makeSession(weekId(monday), slot).event && !plainEventOpen()) {
      const s = makeSession(weekId(monday), slot);
      const label = `${DAY[s.day]} ${shortDate(s.date)}`;
      const row = el('div', 'actions');
      if (confirmCancel === s.k) {
        const warn = el('span', 'warn');
        warn.textContent = `Smazat trénink ${label} i se zápisem?`;
        const yes = el('button', 'danger');
        yes.type = 'button';
        yes.id = 'cancel-yes';
        yes.textContent = 'Smazat';
        yes.addEventListener('click', () => cancelTraining(s));
        const no = el('button', 'ghost');
        no.type = 'button';
        no.textContent = 'Zpět';
        no.addEventListener('click', () => { confirmCancel = null; renderCalFoot(); });
        row.append(warn, yes, no);
      } else {
        const del = el('button', 'ghost');
        del.type = 'button';
        del.id = 'cancel-ask';
        del.textContent = `Smazat trénink ${label}`;
        del.addEventListener('click', () => { confirmCancel = s.k; renderCalFoot(); });
        row.append(del);
      }
      foot.append(row);
    }

    const monthEvents = eventsInMonth();
    for (const s of monthEvents.filter(x => x.date.getTime() === openDay)) {
      const card = el('div', 'ev-card');
      const name = el('strong');
      name.textContent = s.event.name;
      const when = el('span');
      when.textContent = `${DAY_LONG[s.day]} ${shortDate(s.date)}${s.time ? ` · ${s.time}` : ''}`;
      const kind = el('span');
      kind.textContent = s.event.attendance ? 'Se zápisem docházky' : 'Bez docházky';
      card.append(name, when, kind, eventDelete(s));
      foot.append(card);
    }

    for (const s of monthEvents.filter(x => x.date.getTime() !== openDay)) {
      const row = el('div', 'restore');
      const text = el('span');
      const when = `${DAY[s.day]} ${shortDate(s.date)}${s.time ? ` ${s.time}` : ''}`;
      text.textContent = `${when} · ${s.event.name}${s.event.attendance ? '' : ' · bez docházky'}`;
      row.append(text, eventDelete(s));
      foot.append(row);
    }

    for (const s of cancelledInMonth()) {
      const row = el('div', 'restore');
      const text = el('span');
      text.textContent = `Smazáno: ${DAY[s.day]} ${shortDate(s.date)}${s.event ? ` ${s.event.name}` : ''}`;
      const back = el('button', 'link');
      back.type = 'button';
      back.textContent = 'Vrátit';
      back.addEventListener('click', () => guard(() => weekRef(s.w).update({ cancelled: { [s.s]: false } })));
      row.append(text, back);
      foot.append(row);
    }
  }

  function renderCal() {
    if (mode !== 'pick' || !gid) return;
    const grid = $('cal-grid');
    const focused = document.activeElement?.id || '';
    const y = calMonth.getFullYear();
    const m = calMonth.getMonth();
    const todayTime = addDays(new Date(), 0).getTime();
    $('cal-title').textContent = `${MONTHS[m]} ${y}`;
    grid.textContent = '';
    for (const label of DAY.slice(1)) {
      const h = el('span', 'dow');
      h.textContent = label;
      grid.append(h);
    }
    for (let i = 0; i < (calMonth.getDay() || 7) - 1; i += 1) grid.append(el('span'));
    const count = new Date(y, m + 1, 0).getDate();
    const eventDays = new Set(eventsInMonth().map(s => s.date.getTime()));
    for (let n = 1; n <= count; n += 1) {
      const date = new Date(y, m, n);
      const w = weekId(date);
      const sessions = sessionsOnDate(date);
      const live = sessions.length > 0;
      const slotIndex = daysFor(w).indexOf(date.getDay() || 7);
      const gone = !live && slotIndex >= 0 && isCancelled(w, SLOTS[slotIndex]);
      const b = el('button', 'day');
      b.type = 'button';
      b.id = `day-${y}-${m + 1}-${n}`;
      b.textContent = String(n);
      const time = date.getTime();
      const hasEvent = eventDays.has(time);
      b.disabled = !live && !hasEvent;
      b.classList.toggle('today', time === todayTime);
      b.classList.toggle('gone', gone && !hasEvent);
      b.classList.toggle('has-event', hasEvent);
      if (live) {
        const on = sessions.every(s => picked.has(s.k));
        b.classList.add('training');
        b.classList.toggle('marked', sessions.some(sessionHasMarks));
        b.setAttribute('aria-pressed', String(on));
        b.setAttribute('aria-label', `${DAY_LONG[date.getDay() || 7]} ${shortDate(date)}`);
        b.addEventListener('click', () => {
          if (swiped) return;
          openDay = hasEvent && !on ? time : null;
          togglePick(sessions);
        });
      } else if (hasEvent) {
        b.classList.add('training');
        b.setAttribute('aria-pressed', String(openDay === time));
        b.setAttribute('aria-label', `${DAY_LONG[date.getDay() || 7]} ${shortDate(date)}, událost`);
        b.addEventListener('click', () => {
          if (swiped) return;
          openDay = openDay === time ? null : time;
          confirmCancel = null;
          renderCal();
          updateEmpty();
          alignGrid();
        });
      }
      grid.append(b);
    }
    if (focused.startsWith('day-')) $(focused)?.focus();
    renderCalFoot();
  }

  function paint() {
    const w = weekId(monday);
    const active = makeSession(w, slot);
    const activeKey = currentKey();
    const isToday = active.date.getTime() === addDays(new Date(), 0).getTime();
    $('active-day').textContent = `${active.event ? active.event.name : DAY_LONG[active.day]} ${shortDate(active.date)}`;
    $('prev').hidden = mode === 'pick';
    $('next').hidden = mode === 'pick';
    for (const m of ['one', 'all', 'pick']) $(`mode-${m}`).setAttribute('aria-pressed', String(mode === m));

    for (const [k, th] of heads) {
      const on = k === activeKey;
      th.classList.toggle('active', on);
      th.firstChild.setAttribute('aria-pressed', String(on));
    }

    let here = 0;
    for (const p of people) {
      const row = rowMap.get(p.id);
      if (!row) continue;
      for (const [k, c] of row.cells) {
        const on = present(c.w, c.s, p.id);
        const act = k === activeKey;
        c.cell.classList.toggle('on', on);
        c.cell.classList.toggle('active', act);
        c.td.classList.toggle('active', act);
        c.cell.setAttribute('aria-pressed', String(on));
        c.cell.setAttribute('aria-label', `${row.name}, ${c.label}: ${on ? 'byl tu' : 'nebyl tu'}`);
      }
      const on = present(w, slot, p.id);
      if (on) here += 1;
      row.btn.setAttribute('aria-pressed', String(on));
      row.btn.setAttribute('aria-label', `${row.name}: ${on ? 'zrušit zápis' : 'je tu'}`);
    }
    $('count').textContent = [isToday ? 'Dnes' : '', active.time, `Přítomno ${here} z ${people.length}`].filter(Boolean).join(' · ');
  }

  function updateEmpty() {
    const has = people.length > 0;
    const pickNone = mode === 'pick' && !picked.size;
    $('sheet').hidden = !has || pickNone || plainEventOpen();
    $('modes').hidden = !has;
    $('cal').hidden = !has || mode !== 'pick';
    $('pick-hint').hidden = !has || !pickNone || plainEventOpen();
    $('empty').hidden = has;
    $('notice').hidden = !people.some(p => p.example);
    $('clear-examples').hidden = !people.some(p => p.example);
    if (!has && peopleLoaded) {
      $('empty-title').textContent = 'Zatím tu nejsou žádná jména';
      $('empty-text').textContent = 'Přidej je jednou a pak už jen klepáš na ty, co přišli.';
      $('empty-action').hidden = false;
    } else if (!has) {
      $('empty-title').textContent = 'Načítám jména…';
      $('empty-text').textContent = 'Za chvíli tu bude seznam.';
      $('empty-action').hidden = true;
    }
  }

  const ZOOM_MIN = 0.4;
  const ZOOM_MAX = 1.6;
  let zoom = 1;
  try {
    const saved = Number(localStorage.getItem('dochazka-zoom'));
    if (saved >= ZOOM_MIN && saved <= ZOOM_MAX) zoom = saved;
  } catch { /* default size */ }

  function applyZoom() {
    $('table-wrap').style.setProperty('--z', String(zoom));
  }

  (() => {
    const wrap = $('table-wrap');
    let pinch = null;
    let saveTimer = null;
    const save = () => {
      try { localStorage.setItem('dochazka-zoom', String(zoom)); } catch { /* not remembered */ }
    };
    const distance = t => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
    const setZoom = (next, cx, cy) => {
      const z = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, next));
      if (z === zoom) return;
      const rect = wrap.getBoundingClientRect();
      const x = cx - rect.left;
      const y = cy - rect.top;
      const ratio = z / zoom;
      const left = (wrap.scrollLeft + x) * ratio - x;
      const top = (wrap.scrollTop + y) * ratio - y;
      zoom = z;
      applyZoom();
      wrap.scrollLeft = left;
      wrap.scrollTop = top;
    };
    wrap.addEventListener('touchstart', e => {
      if (e.touches.length === 2) pinch = { d: distance(e.touches), z: zoom };
    }, { passive: true });
    wrap.addEventListener('touchmove', e => {
      if (!pinch || e.touches.length !== 2) return;
      e.preventDefault();
      const t = e.touches;
      setZoom(pinch.z * (distance(t) / pinch.d), (t[0].clientX + t[1].clientX) / 2, (t[0].clientY + t[1].clientY) / 2);
    }, { passive: false });
    const end = e => {
      if (!pinch || e.touches.length >= 2) return;
      pinch = null;
      save();
    };
    wrap.addEventListener('touchend', end);
    wrap.addEventListener('touchcancel', end);
    for (const type of ['gesturestart', 'gesturechange', 'gestureend']) {
      wrap.addEventListener(type, e => e.preventDefault(), { passive: false });
    }
    wrap.addEventListener('wheel', e => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      setZoom(zoom * Math.exp(-e.deltaY / 200), e.clientX, e.clientY);
      clearTimeout(saveTimer);
      saveTimer = setTimeout(save, 300);
    }, { passive: false });
  })();

  function heldSessions() {
    const out = [];
    for (const w of Object.keys(weeks).sort()) out.push(...weekSessions(w).filter(sessionHasMarks));
    return out;
  }

  function renderTable(scrollEnd) {
    const held = heldSessions();
    const total = held.length;
    const table = $('table');
    table.textContent = '';
    const summary = $('summary');
    summary.textContent = '';
    $('table-wrap').hidden = !total || !people.length;
    $('zoom').hidden = !total || !people.length;
    applyZoom();
    $('export').disabled = !total;
    if (!total || !people.length) {
      summary.textContent = 'Zatím tu není žádný zapsaný trénink.';
      return;
    }
    let marks = 0;
    const thead = el('thead');
    const hr = el('tr');
    const hName = el('th', 'who');
    hName.scope = 'col';
    hName.textContent = 'Jméno';
    const hSum = el('th');
    hSum.scope = 'col';
    hSum.textContent = 'Účast';
    hr.append(hName, hSum);
    for (const h of held) {
      const th = el('th');
      th.scope = 'col';
      if (h.event) th.title = h.event.name;
      th.append(DAY[h.day], el('br'), tightDate(h.date));
      hr.append(th);
    }
    thead.append(hr);
    const tbody = el('tbody');
    for (const p of people) {
      const tr = el('tr');
      const who = el('th', 'who');
      who.scope = 'row';
      who.textContent = p.name;
      const sum = el('td');
      tr.append(who, sum);
      let count = 0;
      for (const h of held) {
        const on = present(h.w, h.s, p.id);
        if (on) count += 1;
        const td = el('td');
        const dot = el('span', on ? 'dot on' : 'dot');
        dot.textContent = on ? '✓' : '';
        dot.setAttribute('role', 'img');
        dot.setAttribute('aria-label', on ? 'byl tu' : 'nebyl tu');
        td.append(dot);
        tr.append(td);
      }
      sum.textContent = `${count}/${total}`;
      marks += count;
      tbody.append(tr);
    }
    table.append(thead, tbody);
    const avg = Math.round((marks / (total * people.length)) * 100);
    const b1 = el('b');
    b1.textContent = String(total);
    const b2 = el('b');
    b2.textContent = `${avg} %`;
    summary.append('Tréninků: ', b1, ', průměrná účast ', b2);
    if (scrollEnd) $('table-wrap').scrollLeft = $('table-wrap').scrollWidth;
  }

  function csvCell(v) {
    let s = String(v);
    if (/^[=+\-@]/.test(s)) s = `'${s}`;
    return /[;"\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }

  async function exportCsv() {
    if (!downloads) return;
    const held = heldSessions();
    const head = ['Jméno', 'Přítomen', 'Tréninků', ...held.map(h => `${tightDate(h.date)}${h.date.getFullYear()}${h.event ? ` ${h.event.name}` : ''}`)];
    const lines = [head.map(csvCell).join(';')];
    for (const p of people) {
      const marks = held.map(h => (present(h.w, h.s, p.id) ? '1' : ''));
      lines.push([p.name, marks.filter(Boolean).length, held.length, ...marks].map(csvCell).join(';'));
    }
    const now = new Date();
    const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
    const label = String(group()?.name || '').replace(/[^\p{L}\p{N} _-]/gu, '').trim();
    const filename = `dochazka ${label} ${stamp}.csv`.replace(/\s+/g, ' ');
    try {
      await downloads.save({ filename, data: `﻿${lines.join('\r\n')}\r\n` });
    } catch (e) {
      if (e?.code !== 'declined') setStatus('error', 'Soubor se nepodařilo stáhnout.');
    }
  }

  /* import */
  const YES = new Set(['1', 'x', 'ano', 'a', 'yes', 'y', 'true', 'pravda', '✓', '✔', '+']);
  const COLORED = Object.freeze({ colored: true });
  const cellText = v => (v === COLORED ? '' : String(v ?? '').trim());

  function isYes(v) {
    if (v === COLORED) return true;
    const s = cellText(v).toLocaleLowerCase('cs');
    if (YES.has(s)) return true;
    const n = Number(s.replace(',', '.'));
    return s !== '' && Number.isFinite(n) && n > 0;
  }

  function decodeText(buf) {
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(buf);
    } catch {
      return new TextDecoder('windows-1250').decode(buf);
    }
  }

  function parseCsv(input) {
    const text = input.replace(/^﻿/, '');
    const first = text.split(/\r?\n/, 1)[0] || '';
    const count = ch => first.split(ch).length - 1;
    const sep = [';', ',', '\t'].sort((a, b) => count(b) - count(a))[0];
    const rows = [];
    let row = [];
    let cell = '';
    let quoted = false;
    for (let i = 0; i < text.length; i += 1) {
      const ch = text[i];
      if (quoted) {
        if (ch !== '"') cell += ch;
        else if (text[i + 1] === '"') { cell += '"'; i += 1; }
        else quoted = false;
      } else if (ch === '"' && cell === '') {
        quoted = true;
      } else if (ch === sep) {
        row.push(cell);
        cell = '';
      } else if (ch === '\n' || ch === '\r') {
        if (ch === '\r' && text[i + 1] === '\n') i += 1;
        row.push(cell);
        rows.push(row);
        row = [];
        cell = '';
      } else {
        cell += ch;
      }
    }
    if (cell !== '' || row.length) {
      row.push(cell);
      rows.push(row);
    }
    return rows;
  }

  async function parseXlsx(buf) {
    const bytes = new Uint8Array(buf);
    const view = new DataView(buf);
    let end = -1;
    for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i -= 1) {
      if (view.getUint32(i, true) === 0x06054b50) { end = i; break; }
    }
    if (end < 0) throw new Error('zip');
    const entries = new Map();
    let p = view.getUint32(end + 16, true);
    for (let n = view.getUint16(end + 10, true); n > 0; n -= 1) {
      if (view.getUint32(p, true) !== 0x02014b50) throw new Error('zip');
      const nameLen = view.getUint16(p + 28, true);
      const name = new TextDecoder().decode(bytes.subarray(p + 46, p + 46 + nameLen));
      entries.set(name, { method: view.getUint16(p + 10, true), size: view.getUint32(p + 20, true), local: view.getUint32(p + 42, true) });
      p += 46 + nameLen + view.getUint16(p + 30, true) + view.getUint16(p + 32, true);
    }
    const read = async name => {
      const e = entries.get(name.replace(/^\//, ''));
      if (!e) return null;
      const start = e.local + 30 + view.getUint16(e.local + 26, true) + view.getUint16(e.local + 28, true);
      const data = bytes.subarray(start, start + e.size);
      if (e.method === 0) return new TextDecoder().decode(data);
      if (e.method !== 8) throw new Error('zip');
      return new Response(new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).text();
    };
    const xml = s => new DOMParser().parseFromString(s, 'application/xml');
    const all = (node, tag) => [...node.getElementsByTagNameNS('*', tag)];

    let sheetPath = 'xl/worksheets/sheet1.xml';
    const book = await read('xl/workbook.xml');
    const rels = await read('xl/_rels/workbook.xml.rels');
    if (book && rels) {
      const first = all(xml(book), 'sheet')[0];
      const rid = first?.getAttribute('r:id')
        || first?.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'id');
      const target = all(xml(rels), 'Relationship').find(r => r.getAttribute('Id') === rid)?.getAttribute('Target');
      if (target) sheetPath = target.startsWith('/') ? target.slice(1) : `xl/${target}`;
    }
    const sheet = await read(sheetPath);
    if (!sheet) throw new Error('sheet');
    const sharedXml = await read('xl/sharedStrings.xml');
    const shared = sharedXml ? all(xml(sharedXml), 'si').map(si => all(si, 't').map(t => t.textContent).join('')) : [];

    const coloredStyle = [];
    const stylesXml = await read('xl/styles.xml');
    if (stylesXml) {
      const styles = xml(stylesXml);
      const isColor = color => {
        if (!color || color.getAttribute('auto') === '1') return false;
        const rgb = color.getAttribute('rgb');
        if (rgb) {
          const hex = rgb.slice(-6);
          return [0, 2, 4].some(i => parseInt(hex.slice(i, i + 2), 16) < 0xf0);
        }
        const theme = color.getAttribute('theme');
        if (theme !== null) return theme !== '0';
        const indexed = color.getAttribute('indexed');
        return indexed !== null && !['1', '9', '64', '65'].includes(indexed);
      };
      const fills = all(all(styles, 'fills')[0] || styles, 'fill').map(fill => {
        const pattern = all(fill, 'patternFill')[0];
        return pattern?.getAttribute('patternType') === 'solid' && isColor(all(pattern, 'fgColor')[0]);
      });
      const xfs = all(styles, 'cellXfs')[0];
      if (xfs) [...xfs.children].forEach((xf, i) => { coloredStyle[i] = fills[Number(xf.getAttribute('fillId'))] === true; });
    }

    const rows = [];
    for (const r of all(xml(sheet), 'row')) {
      const row = [];
      all(r, 'c').forEach((c, k) => {
        const letters = (c.getAttribute('r') || '').replace(/\d+/g, '');
        let col = k;
        if (letters) {
          col = 0;
          for (const ch of letters) col = col * 26 + ch.charCodeAt(0) - 64;
          col -= 1;
        }
        const type = c.getAttribute('t');
        const v = all(c, 'v')[0]?.textContent ?? '';
        if (type === 's') row[col] = shared[Number(v)] ?? '';
        else if (type === 'inlineStr') row[col] = all(c, 't').map(t => t.textContent).join('');
        else if (type === 'str' || type === 'b' || type === 'e') row[col] = v;
        else row[col] = v === '' ? '' : Number(v);
        if (row[col] === '' && coloredStyle[Number(c.getAttribute('s'))]) row[col] = COLORED;
      });
      const at = Number(r.getAttribute('r')) - 1;
      rows[Number.isInteger(at) && at >= rows.length ? at : rows.length] = row;
    }
    return Array.from(rows, r => Array.from(r || [], v => v ?? ''));
  }

  function headerDate(v) {
    const check = (y, m, d, label) => {
      const date = new Date(y, m - 1, d);
      if (date.getFullYear() !== y || date.getMonth() !== m - 1 || date.getDate() !== d) return null;
      const text = String(label || '').trim();
      return { date, label: /^\d{1,2}:\d{2}(:\d{2})?$/.test(text) ? '' : text.slice(0, 40) };
    };
    if (typeof v === 'number') {
      if (v < 20000 || v > 80000) return null;
      const date = new Date(1899, 11, 30 + Math.floor(v));
      return check(date.getFullYear(), date.getMonth() + 1, date.getDate(), '');
    }
    const s = cellText(v);
    let m = s.match(/^(?:\p{L}{1,7}\.?\s+)?(\d{1,2})\.\s*(\d{1,2})\.?(?:\s*(\d{4}))?\.?(?:\s+(.+))?$/u);
    if (m && m[3]) return check(+m[3], +m[2], +m[1], m[4]);
    if (m) {
      const today = addDays(new Date(), 0);
      const year = [-1, 0, 1]
        .map(n => today.getFullYear() + n)
        .sort((a, b) => Math.abs(new Date(a, m[2] - 1, +m[1]) - today) - Math.abs(new Date(b, m[2] - 1, +m[1]) - today))[0];
      return check(year, +m[2], +m[1], m[4]);
    }
    m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:T[\d:.]+Z?)?(?:\s+(.+))?$/);
    if (m) return check(+m[1], +m[2], +m[3], m[4]);
    return null;
  }

  function planImport(rows) {
    const headIndex = rows.findIndex(r => r.some(v => headerDate(v)));
    if (headIndex < 0) return { error: 'V souboru chybí sloupce s datem tréninku, třeba 3.11.2026.' };
    const head = rows[headIndex];
    let nameCol = head.findIndex(v => /^jm[eé]no$/i.test(cellText(v)));
    if (nameCol < 0) nameCol = head.findIndex(v => !headerDate(v));
    if (nameCol < 0) return { error: 'V souboru chybí sloupec se jmény.' };
    const columns = [];
    head.forEach((v, i) => {
      const d = i === nameCol ? null : headerDate(v);
      if (d) columns.push({ i, ...d });
    });

    const known = new Map(people.map(p => [String(p.name).toLocaleLowerCase('cs'), p.id]));
    const seen = new Set();
    const entries = [];
    for (const row of rows.slice(headIndex + 1)) {
      let name = cellText(row[nameCol]);
      if (/^'[=+\-@]/.test(name)) name = name.slice(1);
      name = name.slice(0, 80);
      const key = name.toLocaleLowerCase('cs');
      if (!name || seen.has(key)) continue;
      seen.add(key);
      entries.push({ name, pid: known.get(key) || null, marks: columns.map(c => isYes(row[c.i])) });
    }
    if (!entries.length) return { error: 'V souboru nejsou žádná jména.' };

    const fresh = new Map();
    const stamp = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const targets = columns.map(c => {
      const w = weekId(c.date);
      const same = weekSessions(w).filter(s => s.date.getTime() === c.date.getTime());
      const label = c.label.toLocaleLowerCase('cs');
      if (label) {
        const ev = same.find(s => s.event && String(s.event.name).toLocaleLowerCase('cs') === label);
        if (ev) return { w, s: ev.s };
      } else {
        const found = same.find(s => !s.event) || same[0];
        if (found) return { w, s: found.s };
        const idx = daysFor(w).indexOf(c.date.getDay() || 7);
        if (idx >= 0) return { w, s: SLOTS[idx], restore: true };
      }
      const key = `${c.date.getTime()}|${label}`;
      if (!fresh.has(key)) {
        fresh.set(key, {
          w,
          s: `e${stamp}${fresh.size + 1}`,
          event: { day: c.date.getDay() || 7, name: c.label || 'Trénink', time: '', attendance: true },
        });
      }
      return fresh.get(key);
    });
    return {
      entries,
      targets,
      sessions: new Set(targets.map(t => `${t.w}|${t.s}`)).size,
      newPeople: entries.filter(e => !e.pid).length,
      newEvents: fresh.size,
    };
  }

  async function applyImport(plan) {
    await flush();
    return guard(async () => {
      for (const e of plan.entries) {
        if (e.pid) continue;
        const ref = peopleCol().doc();
        await ref.set({ name: e.name });
        e.pid = ref.id;
      }
      const byWeek = new Map();
      plan.targets.forEach((t, k) => {
        if (!byWeek.has(t.w)) byWeek.set(t.w, {});
        const patch = byWeek.get(t.w);
        const marks = (patch[t.s] ||= {});
        for (const e of plan.entries) marks[e.pid] = e.marks[k];
        if (t.event) (patch.events ||= {})[t.s] = t.event;
        if (t.restore) (patch.cancelled ||= {})[t.s] = false;
      });
      for (const [w, patch] of byWeek) await writeWeek(w, patch);
    });
  }

  let importPlan = null;

  function importMessage(text, warn) {
    const box = $('import-message');
    box.textContent = text;
    box.className = warn ? 'warn' : 'fine';
    box.hidden = !text;
  }

  function resetImport() {
    importPlan = null;
    $('import-confirm').hidden = true;
    importMessage('');
  }

  async function readImportFile(file) {
    resetImport();
    if (!file || !gid) return;
    let rows;
    try {
      const buf = await file.arrayBuffer();
      const head = new Uint8Array(buf, 0, Math.min(2, buf.byteLength));
      rows = head[0] === 0x50 && head[1] === 0x4b ? await parseXlsx(buf) : parseCsv(decodeText(buf));
    } catch {
      importMessage('Soubor se nepodařilo přečíst. Použij soubor .xlsx nebo .csv.', true);
      return;
    }
    const plan = planImport(rows);
    if (plan.error) {
      importMessage(plan.error, true);
      return;
    }
    importPlan = plan;
    const people = plan.newPeople ? ` (nová: ${plan.newPeople})` : '';
    const events = plan.newEvents ? ` (nové události: ${plan.newEvents})` : '';
    $('import-text').textContent = `Nahrát ze souboru? Jména: ${plan.entries.length}${people}, tréninky: ${plan.sessions}${events}. Zápis v těchto dnech se přepíše podle souboru.`;
    $('import-confirm').hidden = false;
  }
  /* /import */

  function renderRoster() {
    if (document.activeElement?.matches?.('#roster input')) return;
    const list = $('roster');
    list.textContent = '';
    if (!people.length) {
      const li = el('li', 'fine');
      li.textContent = 'Zatím prázdné.';
      list.append(li);
      return;
    }
    for (const p of people) {
      const li = el('li', 'roster-row');
      const input = el('input', 'name-input');
      input.id = `name-${p.id}`;
      input.value = p.name;
      input.maxLength = 80;
      input.setAttribute('aria-label', `Jméno: ${p.name}`);
      input.addEventListener('change', () => {
        const name = input.value.trim();
        if (!name) { input.value = p.name; return; }
        if (name !== p.name) guard(() => peopleCol().doc(p.id).update({ name }));
      });
      li.append(input);
      if (confirmDelete === p.id) {
        const warn = el('span', 'warn');
        warn.textContent = 'Zmizí i z přehledu.';
        const yes = el('button', 'danger');
        yes.type = 'button';
        yes.textContent = 'Smazat';
        yes.addEventListener('click', async () => {
          confirmDelete = null;
          await guard(() => peopleCol().doc(p.id).delete());
          renderRoster();
        });
        const no = el('button', 'ghost');
        no.type = 'button';
        no.textContent = 'Zpět';
        no.addEventListener('click', () => { confirmDelete = null; renderRoster(); });
        li.append(warn, yes, no);
      } else {
        const del = el('button', 'ghost');
        del.type = 'button';
        del.textContent = 'Smazat';
        del.setAttribute('aria-label', `Smazat ${p.name}`);
        del.addEventListener('click', () => { confirmDelete = p.id; renderRoster(); });
        li.append(del);
      }
      list.append(li);
    }
  }

  function trainingEditor(box, addBtn, onChange) {
    const sync = () => {
      const n = box.children.length;
      for (const row of box.children) row.lastChild.hidden = n <= 1;
      addBtn.hidden = n >= MAX_TRAININGS;
    };
    const read = () => [...box.children].map(r => ({ day: Number(r.children[0].value), time: r.children[1].value }));
    const addRow = (day, time) => {
      const row = el('div', 'train-row');
      const select = el('select');
      select.setAttribute('aria-label', 'Den tréninku');
      for (let i = 1; i <= 7; i += 1) {
        const opt = el('option');
        opt.value = String(i);
        opt.textContent = DAY_LONG[i];
        select.append(opt);
      }
      select.value = String(day);
      const clock = el('input', 'name-input');
      clock.type = 'time';
      clock.value = time || '';
      clock.setAttribute('aria-label', 'Čas tréninku');
      const remove = el('button', 'ghost');
      remove.type = 'button';
      remove.textContent = '×';
      remove.setAttribute('aria-label', 'Odebrat trénink');
      remove.addEventListener('click', () => {
        row.remove();
        sync();
        onChange();
      });
      select.addEventListener('change', onChange);
      clock.addEventListener('change', onChange);
      row.append(select, clock, remove);
      box.append(row);
      sync();
    };
    addBtn.addEventListener('click', () => {
      const rows = read();
      const used = new Set(rows.map(r => r.day));
      addRow([1, 2, 3, 4, 5, 6, 7].find(d => !used.has(d)) || 1, rows[rows.length - 1]?.time || '');
      onChange();
    });
    const set = rows => {
      box.textContent = '';
      rows.forEach(r => addRow(r.day, r.time));
    };
    return { read, set };
  }

  function toSchedule(rows) {
    const sorted = [...rows].sort((a, b) => a.day - b.day);
    const times = {};
    for (let d = 1; d <= 7; d += 1) times[d] = '';
    for (const r of sorted) times[r.day] = r.time;
    return { days: sorted.map(r => r.day), times };
  }

  let dayTimer = null;
  const dayEditor = trainingEditor($('day-rows'), $('day-add'), () => {
    const schedule = toSchedule(dayEditor.read());
    clearTimeout(dayTimer);
    if (!validDays(schedule.days)) {
      $('days-hint').textContent = 'Každý trénink musí být v jiný den.';
      return;
    }
    $('days-hint').textContent = DAYS_HINT;
    const id = gid;
    dayTimer = setTimeout(() => guard(() => db.doc(`groups/${id}`).update(schedule)), 400);
  });
  const newEditor = trainingEditor($('new-rows'), $('new-add'), () => { $('new-hint').hidden = true; });

  function syncDays() {
    if ($('day-rows').contains(document.activeElement)) return;
    const g = group();
    dayEditor.set(groupDays(g).map(day => ({ day, time: g?.times?.[day] || '' })));
  }

  function refresh(peopleChanged) {
    if (!gid) return;
    if (peopleChanged) renderRoster();
    ensureActive();
    renderCal();
    updateEmpty();
    const rebuilt = renderGrid();
    paint();
    if (rebuilt) alignGrid();
    if (tab === 'prehled') renderTable(false);
  }

  function showTab(name) {
    tab = name;
    for (const t of ['zapis', 'prehled', 'jmena']) {
      $(`view-${t}`).hidden = t !== name;
      $(`tab-${t}`).setAttribute('aria-selected', String(t === name));
    }
    if (name === 'zapis') alignGrid();
    if (name === 'prehled') renderTable(true);
    if (name === 'jmena') renderRoster();
  }

  function updateTitle() {
    $('title').textContent = gid ? (group()?.name || HOME_TITLE) : HOME_TITLE;
  }

  function resetGroupState() {
    people = [];
    weeks = {};
    peopleLoaded = false;
    slotPicked = false;
    mode = 'one';
    gridKey = '';
    confirmDelete = null;
    confirmCancel = null;
    openDay = null;
    picked.clear();
    created.clear();
    rowMap.clear();
    heads.clear();
    $('grid').textContent = '';
    $('add-hint').hidden = true;
    showEventForm(false);
    resetImport();
  }

  function showEventForm(show) {
    $('event-form').hidden = !show;
    $('event-toggle').hidden = show;
    $('event-hint').hidden = true;
    if (!show) return;
    const now = new Date();
    const base = monthOf(now).getTime() === calMonth.getTime() ? now : calMonth;
    $('event-date').value = `${base.getFullYear()}-${pad(base.getMonth() + 1)}-${pad(base.getDate())}`;
  }

  function openGroup(id) {
    gid = id;
    resetGroupState();
    goCurrent();
    calMonth = monthOf(new Date());
    $('home').hidden = true;
    $('group').hidden = false;
    $('back').hidden = false;
    updateTitle();
    syncDays();
    showTab('zapis');
    refresh(true);

    const dead = e => setStatus('error', e?.code === 'revoked' ? 'Přístup k datům skončil.' : 'Spojení se ztratilo. Načti stránku znovu.');
    unsubs = [
      peopleCol().onSnapshot(snap => {
        people = snap.docs.map(doc => ({ id: doc.id, name: '', ...doc.data() })).sort(byName);
        peopleLoaded = true;
        refresh(true);
      }, dead),
      groupRef().collection('weeks').onSnapshot(snap => {
        weeks = Object.fromEntries(snap.docs.map(doc => [doc.id, doc.data()]));
        if (!slotPicked) goCurrent();
        refresh(false);
      }, dead),
    ];
  }

  function leaveGroup() {
    unsubs.forEach(u => u());
    unsubs = [];
    gid = null;
    resetGroupState();
    $('group').hidden = true;
    $('home').hidden = false;
    $('back').hidden = true;
    updateTitle();
    renderHome();
  }

  async function closeGroup() {
    await flush();
    if (!overlay.size) leaveGroup();
  }

  async function deleteGroup(g) {
    const ref = db.doc(`groups/${g.id}`);
    await guard(async () => {
      for (const name of ['people', 'weeks']) {
        const col = ref.collection(name);
        const snap = await col.get();
        for (const doc of snap.docs) await col.doc(doc.id).delete();
      }
      await ref.delete();
    });
    confirmGroup = null;
    editing = null;
    renderHome();
  }

  function editPanel(g) {
    const box = el('form', 'group-edit');
    const field = el('div', 'field');
    const label = el('label');
    label.htmlFor = `group-name-${g.id}`;
    label.textContent = 'Název skupiny';
    const input = el('input', 'name-input');
    input.id = `group-name-${g.id}`;
    input.value = g.name;
    input.maxLength = 40;
    input.autocomplete = 'off';
    field.append(label, input);

    const actions = el('div', 'actions');
    const save = el('button', 'primary');
    save.type = 'submit';
    save.textContent = 'Uložit';
    actions.append(save);
    if (confirmGroup === g.id) {
      const warn = el('span', 'warn');
      warn.textContent = 'Smaže se skupina, jména i docházka.';
      const yes = el('button', 'danger');
      yes.type = 'button';
      yes.textContent = 'Smazat skupinu';
      yes.addEventListener('click', () => deleteGroup(g));
      const no = el('button', 'ghost');
      no.type = 'button';
      no.textContent = 'Zpět';
      no.addEventListener('click', () => { confirmGroup = null; renderHome(); });
      actions.append(warn, yes, no);
    } else {
      const del = el('button', 'ghost');
      del.type = 'button';
      del.textContent = 'Smazat skupinu';
      del.addEventListener('click', () => { confirmGroup = g.id; renderHome(); });
      actions.append(del);
    }

    box.addEventListener('submit', async e => {
      e.preventDefault();
      const name = input.value.trim().slice(0, 40);
      if (!name) return;
      input.blur();
      if (name !== g.name) await guard(() => db.doc(`groups/${g.id}`).update({ name }));
      editing = null;
      confirmGroup = null;
      renderHome();
    });
    box.append(field, actions);
    return box;
  }

  function scheduleLabel(g) {
    const days = groupDays(g);
    const at = d => (g.times?.[d] ? ` ${g.times[d]}` : '');
    if (days.length === 1) return `${DAY_LONG[days[0]]}${at(days[0])}`;
    if (days.length === 2) return `${DAY_LONG[days[0]]}${at(days[0])} a ${DAY_LONG[days[1]].toLowerCase()}${at(days[1])}`;
    return days.map(d => `${DAY[d]}${at(d)}`).join(', ');
  }

  function renderHome() {
    const full = groups.length >= MAX_GROUPS;
    $('home-empty').hidden = groups.length > 0;
    if (offline) {
      $('home-empty-title').textContent = 'Docházka se tady nedá uložit';
      $('home-empty-text').textContent = 'Tento prohlížeč nedovoluje ukládat data. Otevři aplikaci z ikony na ploše.';
    } else if (groupsLoaded) {
      $('home-empty-title').textContent = 'Zatím tu není žádná skupina';
      $('home-empty-text').textContent = 'Klepni na plus a přidej první skupinu.';
    }
    $('new-group').hidden = full || offline || !groupsLoaded || !newOpen;
    $('new-open').hidden = full || offline || !groupsLoaded || newOpen;
    $('group-limit').hidden = !groups.length;
    $('group-limit').textContent = full ? `Máš všech ${MAX_GROUPS} skupin.` : `Skupiny: ${groups.length} z ${MAX_GROUPS}`;
    if (document.activeElement?.matches?.('#groups input')) return;

    const list = $('groups');
    list.textContent = '';
    for (const g of groups) {
      const li = el('li', 'group-row');
      const open = el('button', 'group-open');
      open.type = 'button';
      open.id = `open-${g.id}`;
      const name = el('strong');
      name.textContent = g.name;
      const sub = el('span');
      sub.textContent = scheduleLabel(g);
      open.append(name, sub);
      open.addEventListener('click', () => openGroup(g.id));
      const edit = el('button', 'ghost');
      edit.type = 'button';
      edit.id = `edit-${g.id}`;
      edit.textContent = 'Upravit';
      edit.setAttribute('aria-expanded', String(editing === g.id));
      edit.setAttribute('aria-label', `Upravit ${g.name}`);
      edit.addEventListener('click', () => {
        editing = editing === g.id ? null : g.id;
        confirmGroup = null;
        renderHome();
      });
      li.append(open, edit);
      if (editing === g.id) li.append(editPanel(g));
      list.append(li);
    }
  }

  async function connect() {
    const fail = () => {
      offline = true;
      setStatus('error', 'Neuloženo');
      renderHome();
    };
    if (!window.claude?.use) {
      fail();
      return;
    }
    const [d, dl] = await Promise.all([window.claude.use('db'), window.claude.use('downloads')]);
    if (!d) {
      fail();
      return;
    }
    db = d;
    downloads = dl;
    $('export').hidden = !dl;
    $('import-label').hidden = false;

    let confirmed = false;
    const loadTimer = setTimeout(() => {
      if (!confirmed) setStatus('error', 'Data se zatím nedaří načíst.');
    }, 10000);
    const settle = () => {
      if (confirmed) return;
      confirmed = true;
      clearTimeout(loadTimer);
      setStatus('saved', 'Vše uloženo');
    };

    db.collection('groups').onSnapshot(snap => {
      groups = snap.docs
        .map(doc => ({ id: doc.id, name: '', ...doc.data() }))
        .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
      groupsLoaded = true;
      if (!snap.metadata.fromCache) settle();
      if (gid && !group() && !snap.metadata.fromCache) {
        leaveGroup();
        return;
      }
      if (gid) {
        updateTitle();
        syncDays();
        if (!slotPicked) goCurrent();
        refresh(false);
      } else {
        renderHome();
      }
    }, e => {
      clearTimeout(loadTimer);
      setStatus('error', e?.code === 'revoked' ? 'Přístup k datům skončil.' : 'Spojení se ztratilo. Načti stránku znovu.');
    });
  }

  $('back').addEventListener('click', closeGroup);
  $('prev').addEventListener('click', () => step(-1));
  $('next').addEventListener('click', () => step(1));
  $('cal-prev').addEventListener('click', () => moveMonth(-1));
  $('cal-next').addEventListener('click', () => moveMonth(1));
  for (const m of ['one', 'all', 'pick']) {
    $(`mode-${m}`).addEventListener('click', () => setMode(m));
  }
  $('retry').addEventListener('click', flush);
  $('export').addEventListener('click', exportCsv);
  $('import-file').addEventListener('change', e => {
    const file = e.target.files[0];
    e.target.value = '';
    readImportFile(file);
  });
  $('import-no').addEventListener('click', resetImport);
  $('import-yes').addEventListener('click', async () => {
    const plan = importPlan;
    if (!plan) return;
    resetImport();
    if (await applyImport(plan)) {
      importMessage(`Nahráno. Jména: ${plan.entries.length}, tréninky: ${plan.sessions}.`);
      refresh(false);
    }
  });
  $('notice-link').addEventListener('click', () => showTab('jmena'));
  $('empty-action').addEventListener('click', () => showTab('jmena'));
  for (const t of ['zapis', 'prehled', 'jmena']) {
    $(`tab-${t}`).addEventListener('click', () => showTab(t));
  }

  $('event-toggle').addEventListener('click', () => showEventForm(true));
  $('event-close').addEventListener('click', () => showEventForm(false));
  $('event-form').addEventListener('submit', async e => {
    e.preventDefault();
    const name = $('event-name').value.trim().slice(0, 40);
    const value = $('event-date').value;
    if (!name || !value) {
      $('event-hint').textContent = name ? 'Vyber datum.' : 'Napiš název události.';
      $('event-hint').hidden = false;
      return;
    }
    const [y, m, d] = value.split('-').map(Number);
    const date = new Date(y, m - 1, d);
    const id = `e${Date.now().toString(36)}`;
    const event = { day: date.getDay() || 7, name, time: $('event-time').value, attendance: $('event-att').checked };
    const ok = await guard(() => writeWeek(weekId(date), { events: { [id]: event } }));
    if (!ok) return;
    $('event-name').value = '';
    $('event-time').value = '';
    $('event-att').checked = true;
    calMonth = monthOf(date);
    showEventForm(false);
    refresh(false);
  });

  $('cal').addEventListener('pointerdown', e => {
    swiped = false;
    swipeStart = e.target.closest('form') ? null : { x: e.clientX, y: e.clientY };
  });
  $('cal').addEventListener('pointerup', e => {
    if (!swipeStart) return;
    const dx = e.clientX - swipeStart.x;
    const dy = e.clientY - swipeStart.y;
    swipeStart = null;
    if (Math.abs(dx) >= 40 && Math.abs(dx) > Math.abs(dy) * 1.5) {
      swiped = true;
      moveMonth(dx < 0 ? 1 : -1);
    }
  });
  $('cal').addEventListener('pointercancel', () => { swipeStart = null; });

  newEditor.set([{ day: 1, time: '' }]);

  $('new-open').addEventListener('click', () => {
    newOpen = true;
    renderHome();
  });
  $('new-close').addEventListener('click', () => {
    newOpen = false;
    $('new-hint').hidden = true;
    renderHome();
  });

  $('new-group').addEventListener('submit', async e => {
    e.preventDefault();
    if (!db || groups.length >= MAX_GROUPS) return;
    const hint = $('new-hint');
    const name = $('new-name').value.trim().slice(0, 40);
    const schedule = toSchedule(newEditor.read());
    if (!name || !validDays(schedule.days)) {
      hint.textContent = name ? 'Každý trénink musí být v jiný den.' : 'Napiš název skupiny.';
      hint.hidden = false;
      return;
    }
    hint.hidden = true;
    const ok = await guard(() => db.collection('groups').doc().set({ name, ...schedule, createdAt: Date.now() }));
    if (ok) {
      $('new-name').value = '';
      newEditor.set([{ day: 1, time: '' }]);
      newOpen = false;
      renderHome();
    }
  });

  $('add-form').addEventListener('submit', async e => {
    e.preventDefault();
    if (!db || !gid) return;
    const seen = new Set(people.map(p => String(p.name).toLocaleLowerCase('cs')));
    const names = [];
    for (const raw of $('add-names').value.split(/[\r\n,;]+/)) {
      const name = raw.trim().slice(0, 80);
      const key = name.toLocaleLowerCase('cs');
      if (name && !seen.has(key)) {
        seen.add(key);
        names.push(name);
      }
    }
    if (!names.length) return;
    const ok = await guard(async () => {
      for (const name of names) await peopleCol().doc().set({ name });
    });
    if (ok) {
      $('add-names').value = '';
      $('add-hint').textContent = `Přidáno: ${names.length}`;
      $('add-hint').hidden = false;
    }
  });

  $('clear-examples').addEventListener('click', () => {
    const ids = people.filter(p => p.example).map(p => p.id);
    guard(async () => {
      for (const id of ids) await peopleCol().doc(id).delete();
    });
  });

  renderHome();
  connect();
})();
