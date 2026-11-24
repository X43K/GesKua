/* ==========================================================================
   Vista: cuadrante mensual, paleta, inspector de celda y panel del día.
   ========================================================================== */
(() => {
    'use strict';

    const { S, $, $$, h, icon, fmtNum, fmtPct, fmtHours, pad2, MONTHS, STATUS, KIND_LABEL } = G;
    const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');

    /* ---------- Paleta ----------------------------------------------------- */

    function paintLabel() {
        if (!S.paint) return '';
        if (S.paint.value === '') return 'Borrar asignación';
        if (!G.isCode(S.paint.value)) return `${STATUS[S.paint.value]?.short || S.paint.value} · ${STATUS[S.paint.value]?.label || S.paint.value}`;
        const sh = G.shiftFor(S.paint.value);
        const v = G.variantFor(S.paint.value, S.paletteKind);
        return `T${pad2(S.paint.value)}${v ? ` · ${v.start}–${v.end}` : ''}${sh?.line ? ' · ' + sh.line : ''}`;
    }

    function shiftChipsHtml() {
        const kind = S.paletteKind;
        let codes = G.codesFor(kind);
        if (S.paletteLine !== 'all') codes = codes.filter((c) => (G.shiftFor(c)?.line || 'REF') === S.paletteLine);
        if (!codes.length) return '<span class="field-hint">No hay turnos para este filtro.</span>';
        return codes.map((code) => {
            const shift = G.shiftFor(code);
            const v = G.variantFor(code, kind);
            if (!v) return '';
            const color = G.lineColor(v.line || shift.line);
            const active = S.paint && S.paint.value === String(code);
            return `<button type="button" class="chip ${active ? 'active' : ''}" data-paint-code="${code}"
                title="${h(`T${pad2(code)} · ${v.lineLabel || v.line} · ${v.start}–${v.end} · ${fmtHours(v.hours)}${v.vehicle ? ' · bus ' + v.vehicle : ''}`)}">
                <i style="width:5px;height:5px;border-radius:2px;background:${active ? '#5eead4' : color}"></i>${code}<small>${v.start}</small>
            </button>`;
        }).join('');
    }
    G.shiftChipsHtml = shiftChipsHtml;

    function paintNoteHtml() {
        if (!S.paint) return '';
        return `${icon('sparkles')}
            <span><b>Pintando ${h(paintLabel())}</b> · haz clic o arrastra por las celdas. <kbd>Esc</kbd> para salir.</span>
            <span class="spacer"></span>
            <button type="button" class="btn btn-sm btn-ghost" data-paint-exit>Salir</button>`;
    }

    function refreshPaint() {
        $$('.chip[data-paint-code]').forEach((chip) => chip.classList.toggle('active', !!S.paint && S.paint.value === chip.dataset.paintCode));
        $$('.chip[data-paint-status]').forEach((chip) => chip.classList.toggle('active', !!S.paint && S.paint.value === chip.dataset.paintStatus));
        $$('.chip[data-paint-erase]').forEach((chip) => chip.classList.toggle('active', !!S.paint && S.paint.value === ''));
        const note = $('#paint-note');
        if (note) {
            note.classList.toggle('on', !!S.paint);
            note.innerHTML = paintNoteHtml();
        }
        const grid = $('#grid-scroll');
        if (grid) grid.classList.toggle('painting', !!S.paint);
        $$('.cell.selected').forEach((c) => c.classList.remove('selected'));
    }
    G.refreshPaint = refreshPaint;

    function selectPaint(value, label, status = false) {
        if (S.paint && S.paint.value === String(value)) {
            S.paint = null;
        } else {
            S.paint = { value: String(value), label, status };
        }
        refreshPaint();
    }

    /* ---------- Render ----------------------------------------------------- */

    function kpiCard(name, iconName, value, label, sub, tone = '') {
        return `<div class="kpi">
            <div class="kpi-icon ${tone}">${icon(iconName)}</div>
            <div class="kpi-body">
                <div class="kpi-value" data-kpi="${name}">${value}</div>
                <div class="kpi-label">${label}</div>
                <div class="kpi-sub">${sub}</div>
            </div>
        </div>`;
    }

    function dayHead(date, cov) {
        const kind = G.dayKind(date);
        const holiday = G.holidayFor(date);
        const today = date === G.todayISO();
        /* Los festivos usan el horario de domingo (kind=dom), pero el color
           debe seguir el día real: domingo rojo, sábado amarillo, festivo verde. */
        const realKind = ['dom', 'lv', 'ma', 'mi', 'ju', 'vi', 'sab'][G.weekdayIndex(date)] || 'lv';
        const cls = ['day-head', `kind-${kind}`, `real-${realKind}`, holiday ? 'is-holiday' : '', today ? 'today' : ''].join(' ');
        return `<th class="${cls}" data-day="${date}" title="${h(`${G.prettyDate(date)}${holiday ? ' · ' + (holiday.name || 'Festivo') : ''} · ${cov.assigned}/${cov.need} turnos`)}">
            <span class="dw">${G.weekdayShort(date)}</span>
            <span class="dn">${Number(date.slice(8))}</span>
            ${holiday ? '<span class="hd"></span>' : ''}
        </th>`;
    }

    function covMarkup(cov) {
        const level = cov.missing ? (cov.ratio >= 0.9 ? 'warn' : 'bad') : '';
        return `<div class="cov">
            <b class="${level}">${cov.assigned}</b>
            <small>/${cov.need}</small>
            <span class="cov-bar"><i class="${level}" style="width:${Math.min(100, Math.round(cov.ratio * 100))}%"></i></span>
        </div>`;
    }

    function alertsHtml(stats) {
        const alerts = stats.alerts;
        if (!alerts.length) {
            return `<div class="empty">${icon('check')}<b>Sin incidencias</b><p>El cuadrante cumple cobertura, descansos y ausencias.</p></div>`;
        }
        const items = alerts.slice(0, 14).map((a, i) => {
            const tone = a.sev === 'high' ? 'sev-high' : a.sev === 'low' ? 'sev-low' : 'sev-medium';
            return `<div class="alert ${tone}" data-alert-index="${i}" title="Abrir detalle">
                <div class="alert-icon">${icon(a.sev === 'high' ? 'warning' : a.sev === 'low' ? 'sparkles' : 'clock')}</div>
                <div class="alert-body"><div class="alert-title">${h(a.title)}</div><div class="alert-sub">${h(a.sub || '')}</div></div>
            </div>`;
        }).join('');
        const more = alerts.length > 14
            ? `<div class="empty" style="padding:12px"><button type="button" class="btn btn-sm" data-act="all-alerts">Ver las ${alerts.length} incidencias</button></div>`
            : '';
        return items + more;
    }

    function coverageBars(stats) {
        return stats.days.map((date) => {
            const cov = stats.coverage.get(date);
            const pct = Math.min(100, Math.round(cov.ratio * 100));
            const level = cov.missing ? (cov.ratio >= 0.9 ? 'warn' : 'bad') : '';
            return `<div class="bar-col" data-day="${date}" title="${h(`${G.prettyDate(date)} · ${cov.assigned}/${cov.need}`)}">
                <div class="bar ${level}" style="height:${Math.max(4, pct)}%"></div><span>${Number(date.slice(8))}</span>
            </div>`;
        }).join('');
    }

    function renderCuadrante() {
        const stats = G.computeMonth();
        const totals = stats.totals;
        const days = stats.days;
        const active = totals.activeDrivers;
        const abs = G.absenceTotal(totals.status);
        const avgHours = totals.assigned ? totals.hours / totals.assigned : 0;
        const roster = G.rosterDrivers();
        const archived = G.archivedDriversForMonth(S.month).filter((d) => !roster.includes(d));

        let drivers = [...roster, ...archived];
        if (S.order === 'idc') drivers.sort((a, b) => String(a.id).localeCompare(String(b.id), 'es', { numeric: true }));
        else if (S.order === 'hours') drivers.sort((a, b) => (stats.driverStats.get(String(b.id))?.hours || 0) - (stats.driverStats.get(String(a.id))?.hours || 0));
        else drivers.sort((a, b) => G.prettyName(a.name).localeCompare(G.prettyName(b.name), 'es'));

        const rows = drivers.map((driver, idx) => {
            const st = stats.driverStats.get(String(driver.id)) || { work: 0 };
            const search = norm(`${driver.name} ${driver.id}`);
            const cells = days.map((date) => G.cellMarkup(G.getValAt(driver.id, date), date, driver.id)).join('');
            return `<tr data-driver="${h(driver.id)}" data-search="${h(search)}" class="${G.dayKind(days[0]) === 'sab' ? '' : ''}">
                <td class="driver-cell">
                    <div class="driver-line">
                        <span class="avatar ${idx % 2 ? 'alt' : ''}">${h(G.initials(driver.name))}</span>
                        <span class="driver-name" title="${h(driver.name)}">${h(G.prettyName(driver.name))}</span>
                        <span class="driver-meta" title="${st.work} turnos · ${fmtHours(st.hours)}">${driver.id}${driver.deepInactive ? ' · archivado' : ''}</span>
                    </div>
                </td>${cells}</tr>`;
        }).join('');

        const lineOptions = ['<option value="all">Todas las líneas</option>']
            .concat([...S.db.lines].sort(G.compareLines).map((l) => `<option value="${h(l.code)}" ${S.paletteLine === l.code ? 'selected' : ''}>${h(l.code)} · ${h(l.name)}</option>`))
            .join('');

        return `
        <div class="kpi-row">
            ${kpiCard('drivers', 'users', fmtNum(active), 'Conductores activos', `${roster.length} en cuadrante`)}
            ${kpiCard('coverage', 'grid', fmtPct(totals.coverage * 100), 'Cobertura del mes', `${fmtNum(totals.assigned)} / ${fmtNum(totals.need)} servicios · ${totals.fullDays}/${days.length} días completos`, totals.coverage >= .995 ? '' : 'warn')}
            ${kpiCard('hours', 'clock', fmtNum(totals.hours) + ' h', 'Horas planificadas', `Media ${fmtHours(avgHours)} por turno`)}
            ${kpiCard('absences', 'calendar', fmtNum(abs), 'Ausencias', `${totals.status.VA} VA · ${totals.status.BA} BA · ${totals.status.AP} AP · ${totals.status.PI + totals.status.PC + totals.status.PF} P · ${totals.status.HS} HS · ${totals.status.HR} R`)}
            ${kpiCard('alerts', 'warning', fmtNum(totals.high + totals.medium), 'Incidencias', `${totals.high} críticas · ${totals.medium} avisos`, totals.high ? 'bad' : totals.medium ? 'warn' : '')}
        </div>

        <section class="panel grid-panel">
            <div class="panel-head">
                <div>
                    <h3>Cuadrante de ${G.monthLabel(S.month)}</h3>
                    <p>${G.canEdit === false
                        ? 'Consulta el cuadrante: clic en una celda para ver su detalle, clic en el día para ver sus servicios.'
                        : 'Selecciona un turno en la paleta y pinta las celdas. Clic en una celda para editarla; clic en el día para ver sus servicios.'}</p>
                </div>
                <div class="panel-actions">
                    <div class="search-box">${icon('search')}<input type="search" id="roster-search" placeholder="Buscar conductor o IDC…" value="${h(S.search)}"></div>
                    <select class="select" id="roster-order" title="Ordenar">
                        <option value="name" ${S.order === 'name' ? 'selected' : ''}>Por nombre</option>
                        <option value="idc" ${S.order === 'idc' ? 'selected' : ''}>Por IDC</option>
                        <option value="hours" ${S.order === 'hours' ? 'selected' : ''}>Por horas</option>
                    </select>
                    <button type="button" class="icon-btn" data-act="undo" title="Deshacer (⌘Z)">${icon('undo')}</button>
                    <button type="button" class="btn btn-primary btn-sm" data-act="auto">${icon('sparkles')} Autoasignar</button>
                    <button type="button" class="btn btn-sm" data-act="clear">${icon('trash')} Limpiar</button>
                    <button type="button" class="icon-btn" data-act="export" title="Exportar Excel">${icon('download')}</button>
                    ${G.canImportSchedule === true ? `<label class="icon-btn" data-import-schedule title="Importar Excel del cuadrante">${icon('upload')}<input type="file" data-import-schedule-input accept=".xls,.xlsx,.xlsm,.csv,application/vnd.ms-excel,text/csv" hidden></label>` : ''}
                    <button type="button" class="icon-btn" data-act="print" title="Imprimir">${icon('print')}</button>
                </div>
            </div>
            <div class="palette" id="palette">
                <div class="palette-label"><b>Paleta</b><span>elige y pinta</span></div>
                <div class="palette-group">
                    <button type="button" class="chip status d ${S.paint?.value === 'D' ? 'active' : ''}" data-paint-status="D" title="Descanso">D</button>
                    <button type="button" class="chip status x ${S.paint?.value === 'X' ? 'active' : ''}" data-paint-status="X" title="Jornada sin turno (cuenta para rachas, sin horario)">X</button>
                    <button type="button" class="chip status v ${S.paint?.value === 'VA' ? 'active' : ''}" data-paint-status="VA" title="Vacaciones">VA</button>
                    <button type="button" class="chip status b ${S.paint?.value === 'BA' ? 'active' : ''}" data-paint-status="BA" title="Baja médica">BA</button>
                    <button type="button" class="chip status a ${S.paint?.value === 'AP' ? 'active' : ''}" data-paint-status="AP" title="Asuntos propios">AP</button>
                    <button type="button" class="chip status a ${S.paint?.value === 'PI' ? 'active' : ''}" data-paint-status="PI" title="Permiso por ingreso">P</button>
                    <button type="button" class="chip status a ${S.paint?.value === 'PC' ? 'active' : ''}" data-paint-status="PC" title="Permiso por cuidados">P</button>
                    <button type="button" class="chip status a ${S.paint?.value === 'PF' ? 'active' : ''}" data-paint-status="PF" title="Permiso por fallecimiento">P</button>
                    <button type="button" class="chip status a ${S.paint?.value === 'HS' ? 'active' : ''}" data-paint-status="HS" title="Horas sindicales">HS</button>
                    <button type="button" class="chip status a ${S.paint?.value === 'HR' ? 'active' : ''}" data-paint-status="HR" title="Horas registro">R</button>
                    <button type="button" class="chip erase ${S.paint?.value === '' ? 'active' : ''}" data-paint-erase title="Dejar libre">Borrar</button>
                </div>
                <div class="palette-sep"></div>
                <div class="palette-group">
                    <select class="select" id="palette-kind" title="Tipo de día">
                        <option value="lv" ${S.paletteKind === 'lv' ? 'selected' : ''}>Laborables</option>
                        <option value="sab" ${S.paletteKind === 'sab' ? 'selected' : ''}>Sábados</option>
                        <option value="dom" ${S.paletteKind === 'dom' ? 'selected' : ''}>Domingos / festivos</option>
                    </select>
                    <select class="select" id="palette-line" title="Filtrar por línea">${lineOptions}</select>
                </div>
                <div class="palette-group" id="shift-chips">${shiftChipsHtml()}</div>
            </div>
            <div class="paint-note ${S.paint ? 'on' : ''}" id="paint-note">${paintNoteHtml()}</div>

            <div class="grid-scroll ${S.paint ? 'painting' : ''}" id="grid-scroll">
                <table class="roster">
                    <thead><tr>
                        <th class="driver-head">Conductor · IDC</th>
                        ${days.map((d) => dayHead(d, stats.coverage.get(d))).join('')}
                    </tr></thead>
                    <tbody>${rows || `<tr><td colspan="${days.length + 1}"><div class="empty">${icon('users')}<b>Sin conductores</b><p>Añade personal en la sección Personal.</p></div></td></tr>`}</tbody>
                    <tfoot><tr>
                        <td class="driver-head">Cobertura por día</td>
                        ${days.map((date) => `<td class="cov-cell" data-cov="${date}">${covMarkup(stats.coverage.get(date))}</td>`).join('')}
                    </tr></tfoot>
                </table>
            </div>
            <div class="grid-foot">
                <div class="legend">
                    <span><i class="dot dot-work"></i>Turno</span>
                    <span><i class="dot dot-rest"></i>Descanso</span>
                    <span><i class="dot dot-vac"></i>Vacaciones</span>
                    <span><i class="dot dot-sick"></i>Baja</span>
                    <span><b style="color:var(--muted)">N/necesario</b> pie de día</span>
                </div>
                <div class="hint">Arrastra para pintar varios días · <kbd>Esc</kbd> sale de la paleta · clic derecho borra</div>
            </div>
        </section>

        <div class="two-col">
            <div class="panel">
                <div class="panel-head">
                    <div><h3>Incidencias</h3><p id="alerts-sub">${totals.high} críticas · ${totals.medium} avisos · ${totals.low} informativas</p></div>
                    <div class="panel-actions"><button type="button" class="btn btn-sm" data-act="all-alerts">Ver todas</button></div>
                </div>
                <div class="alerts" id="alerts-body">${alertsHtml(stats)}</div>
            </div>
            <div class="panel">
                <div class="panel-head">
                    <div><h3>Cobertura por día</h3><p>Servicios cubiertos frente a la necesidad (${G.needFor('lv')}/${G.needFor('sab')}/${G.needFor('dom')} L-V/Sáb/Dom)</p></div>
                </div>
                <div class="chart"><div class="chart-bars" id="coverage-bars">${coverageBars(stats)}</div></div>
            </div>
        </div>`;
    }

    /* ---------- Binder ----------------------------------------------------- */

    function bindCuadrante() {
        const view = $('#view');
        const grid = $('#grid-scroll');

        $('#roster-search')?.addEventListener('input', (e) => {
            S.search = e.target.value;
            const q = norm(S.search);
            $$('tr[data-search]', view).forEach((tr) => {
                tr.hidden = !!q && !tr.dataset.search.includes(q);
            });
        });
        $('#roster-order')?.addEventListener('change', (e) => {
            S.order = e.target.value;
            G.render();
        });
        $('#palette-kind')?.addEventListener('change', (e) => {
            S.paletteKind = e.target.value;
            if (S.paint) { S.paint = null; refreshPaint(); }
            const box = $('#shift-chips');
            if (box) box.innerHTML = shiftChipsHtml();
        });
        $('#palette-line')?.addEventListener('change', (e) => {
            S.paletteLine = e.target.value;
            if (S.paint) { S.paint = null; refreshPaint(); }
            const box = $('#shift-chips');
            if (box) box.innerHTML = shiftChipsHtml();
        });

        $('#palette')?.addEventListener('click', (e) => {
            const code = e.target.closest('[data-paint-code]');
            const status = e.target.closest('[data-paint-status]');
            const erase = e.target.closest('[data-paint-erase]');
            if (code) {
                const value = code.dataset.paintCode;
                const v = G.variantFor(value, S.paletteKind);
                selectPaint(value, `T${pad2(value)}`);
            } else if (status) {
                selectPaint(status.dataset.paintStatus, status.dataset.paintStatus);
            } else if (erase) {
                selectPaint('', 'Borrar');
            }
        });

        $('#paint-note')?.addEventListener('click', (e) => {
            if (e.target.closest('[data-paint-exit]')) {
                S.paint = null;
                refreshPaint();
            }
        });

        grid?.addEventListener('click', (e) => {
            const head = e.target.closest('[data-day]');
            if (head) openDayDrawer(head.dataset.day);
        });

        grid?.addEventListener('pointerdown', (e) => {
            const cell = e.target.closest('.cell');
            if (!cell || e.button !== 0) return;
            e.preventDefault();
            const [driverId, date] = cell.dataset.cell.split('|');
            if (S.paint) {
                S.drag = true;
                S.dragSeen = new Set();
                const key = cell.dataset.cell;
                S.dragSeen.add(key);
                paintCell(driverId, date, cell);
            } else {
                document.querySelectorAll('.cell.selected').forEach((c) => c.classList.remove('selected'));
                cell.classList.add('selected');
                openCellInspector(driverId, date);
            }
        });

        grid?.addEventListener('pointerover', (e) => {
            if (!S.drag || !S.paint) return;
            const cell = e.target.closest('.cell');
            if (!cell || S.dragSeen.has(cell.dataset.cell)) return;
            const [driverId, date] = cell.dataset.cell.split('|');
            S.dragSeen.add(cell.dataset.cell);
            paintCell(driverId, date, cell);
        });

        grid?.addEventListener('contextmenu', (e) => {
            const cell = e.target.closest('.cell');
            if (!cell) return;
            e.preventDefault();
            const [driverId, date] = cell.dataset.cell.split('|');
            G.setValue(driverId, date, '');
        });

        $("#coverage-bars")?.addEventListener('click', (e) => {
            const col = e.target.closest('[data-day]');
            if (col) openDayDrawer(col.dataset.day);
        });

        $("#alerts-body")?.addEventListener('click', (e) => {
            const item = e.target.closest('[data-alert-index]');
            if (!item) return;
            const alert = G.S.lastAlerts[Number(item.dataset.alertIndex)];
            if (!alert) return;
            if (alert.driverId && alert.date) openCellInspector(alert.driverId, alert.date);
            else if (alert.date) openDayDrawer(alert.date);
        });

        $$('[data-import-schedule]', view).forEach((label) => {
            const input = label.querySelector('input[data-import-schedule-input]');
            if (!input) return;
            input.addEventListener('change', async (e) => {
                const file = e.target.files?.[0];
                e.target.value = '';
                if (file) await G.importSchedule(file);
            });
        });

        view.onclick = (e) => {
            const btn = e.target.closest('[data-act]');
            if (!btn) return;
            const act = btn.dataset.act;
            if (act === 'auto') autoAssign();
            else if (act === 'clear') clearMonth();
            else if (act === 'export') G.exportCuadranteExcel();
            else if (act === 'print') window.print();
            else if (act === 'undo') G.undoLast();
            else if (act === 'all-alerts') openAlertsModal();
        };
    }

    /* ---------- Pintado ---------------------------------------------------- */

    function paintCell(driverId, date, cellEl) {
        if (!S.paint) return;
        const value = S.paint.value;
        if (G.isCode(value) && !G.variantFor(value, G.dayKind(date))) {
            const now = Date.now();
            if (!S.paintToast || now - S.paintToast > 1600) {
                S.paintToast = now;
                G.toast(`El turno T${pad2(value)} no existe para ${KIND_LABEL[G.dayKind(date)]}`, 'bad');
            }
            return;
        }
        G.setValue(driverId, date, value);
        if (cellEl) cellEl.classList.add('selected');
    }

    /* ---------- Actualización ligera -------------------------------------- */

    function patchCuadrante() {
        if (S.view !== 'cuadrante') return;
        const stats = G.computeMonth();
        const t = stats.totals;
        const set = (name, value) => {
            const el = document.querySelector(`[data-kpi="${name}"]`);
            if (el) el.innerHTML = value;
        };
        set('drivers', fmtNum(t.activeDrivers));
        set('coverage', fmtPct(t.coverage * 100));
        set('hours', fmtNum(t.hours) + ' h');
        set('absences', fmtNum(G.absenceTotal(t.status)));
        set('alerts', fmtNum(t.high + t.medium));
        const sub = document.querySelector('[data-kpi="alerts"]')?.parentElement.querySelector('.kpi-sub');
        if (sub) sub.textContent = `${t.high} críticas · ${t.medium} avisos`;

        for (const [date, cov] of stats.coverage) {
            const cell = document.querySelector(`[data-cov="${date}"]`);
            if (cell) cell.innerHTML = covMarkup(cov);
            const head = document.querySelector(`.day-head[data-day="${date}"]`);
            if (head) head.title = `${G.prettyDate(date)} · ${cov.assigned}/${cov.need} turnos`;
        }
        const alertsBody = document.getElementById('alerts-body');
        if (alertsBody) alertsBody.innerHTML = alertsHtml(stats);
        const alertsSub = document.getElementById('alerts-sub');
        if (alertsSub) alertsSub.textContent = `${t.high} críticas · ${t.medium} avisos · ${t.low} informativas`;
        const bars = document.getElementById('coverage-bars');
        if (bars) bars.innerHTML = coverageBars(stats);
    }
    G.patchCuadrante = patchCuadrante;

    /* ---------- Inspector de celda --------------------------------------- */

    function openCellInspector(driverId, date) {
        const driver = G.driverById(driverId);
        if (!driver) return;
        const kind = G.dayKind(date);
        const current = G.getValAt(driverId, date) || '';
        const stats = G.computeMonth();
        const st = stats.driverStats.get(String(driverId)) || {};
        const absence = G.absenceFor(driverId, date);
        const codes = G.codesFor(kind);
        const currentShift = G.isCode(current) ? G.shiftFor(current) : null;
        const extra = currentShift && !G.variantFor(current, kind)
            ? `<option value="${h(current)}" selected>T${pad2(current)} · no válido para ${KIND_LABEL[kind]}</option>` : '';

        const options = codes.map((code) => {
            const v = G.variantFor(code, kind);
            const sh = G.shiftFor(code);
            return `<option value="${code}" ${String(code) === String(current) ? 'selected' : ''}>T${pad2(code)} · ${h(v.lineLabel || v.line || sh?.line || '')} · ${v.start}–${v.end} (${fmtHours(v.hours)})</option>`;
        }).join('');

        const readOnly = G.canEdit === false;
        let staticDetail = '';
        if (readOnly) {
            if (!current) {
                staticDetail = '<span class="field-hint">Sin asignación: el conductor figura como libre.</span>';
            } else if (!G.isCode(current)) {
                staticDetail = `<span class="tag ${STATUS[current]?.tag || ''}">${h(STATUS[current]?.short || current)} · ${h(STATUS[current]?.label || current)}</span>`;
            } else {
                const v = G.variantFor(current, kind);
                staticDetail = v
                    ? `<div class="variant-row"><span class="tag line">T${pad2(current)} · ${h(v.lineLabel || v.line)}</span>
                        <span class="variant"><b>Horario</b> ${v.start}–${v.end}</span>
                        <span class="variant"><b>Horas</b> ${fmtHours(v.hours)}</span>
                        ${G.effectiveVehicleFor(driverId, date) ? `<span class="variant"><b>Bus</b> ${h(G.effectiveVehicleFor(driverId, date))}</span>` : ''}</div>`
                    : `<span class="tag bad">T${pad2(current)} · no válido para ${KIND_LABEL[kind]}</span>`;
            }
        }

        const body = `
            <div class="inspector-person">
                <span class="avatar ${Number(driverId) % 2 ? 'alt' : ''}">${h(G.initials(driver.name))}</span>
                <div><b>${h(G.prettyName(driver.name))}</b><span>IDC ${h(driver.id)} · ${h(G.prettyDate(date))}</span></div>
                <span class="tag ${G.holidayFor(date) ? 'bad' : kind === 'lv' ? '' : 'info'}">${G.holidayFor(date)?.name || KIND_LABEL[kind]}</span>
            </div>
            <div class="inspector-tags">
                <span class="tag ${driver.group === 'A' ? 'info' : driver.group === 'B' ? 'warn' : ''}">${h(G.driverGroupLabel(driver))}</span>
                ${driver.partnerId ? `<span class="tag">Compañero: ${h(G.driverPartnerLabel(driver))}</span>` : ''}
            </div>
            ${absence ? `<div class="inspector-absence">${icon('calendar')} Ausencia registrada: <b>${h(STATUS[absence.type]?.label || absence.type)}</b> del ${h(absence.from)} al ${h(absence.to)}${absence.note ? ' · ' + h(absence.note) : ''}</div>` : ''}
            ${readOnly ? `<div class="inspector-detail" style="margin-top:14px"><b>Asignación:</b> ${staticDetail}</div>` : `<div class="form-grid" style="margin-top:14px">
                <div class="field full">
                    <label for="insp-value">Asignación <em>turnos válidos para ${KIND_LABEL[kind]}</em></label>
                    <select id="insp-value">
                        <option value="" ${current === '' ? 'selected' : ''}>Libre / sin asignar</option>
                        ${extra}
                        <optgroup label="Turnos de ${KIND_LABEL[kind]}">${options}</optgroup>
                        <optgroup label="Estados">
                            <option value="D" ${current === 'D' ? 'selected' : ''}>D · Descanso</option>
                            <option value="VA" ${current === 'VA' ? 'selected' : ''}>VA · Vacaciones</option>
                            <option value="BA" ${current === 'BA' ? 'selected' : ''}>BA · Baja médica</option>
                            <option value="AP" ${current === 'AP' ? 'selected' : ''}>AP · Asuntos propios</option>
                        </optgroup>
                    </select>
                </div>
            </div>
            <div class="inspector-detail" id="insp-detail"></div>`}
            <div class="inspector-stats">
                <div><b>${st.work || 0}</b><span>turnos del mes</span></div>
                <div><b>${fmtHours(st.hours || 0)}</b><span>horas</span></div>
                <div><b>${st.maxConsec || 0}</b><span>días seguidos</span></div>
            </div>
            <div style="margin-top:12px"><button type="button" class="btn btn-sm" data-open-day>${icon('calendar')} Ver todos los servicios del día</button></div>`;

        const modal = G.openModal({
            title: readOnly ? 'Detalle de asignación' : 'Editar asignación',
            subtitle: readOnly ? 'Solo consulta · no se pueden modificar datos' : 'Los cambios se guardan automáticamente',
            body,
            footer: readOnly
                ? `<button type="button" class="btn btn-sm" data-open-day>${icon('calendar')} Ver todos los servicios del día</button>
                   <span class="spacer"></span>
                   <button type="button" class="btn" data-cancel>Cerrar</button>`
                : `<button type="button" class="btn btn-danger btn-sm" data-delete>${icon('trash')} Dejar libre</button>
                <span class="spacer"></span>
                <button type="button" class="btn" data-cancel>Cancelar</button>
                <button type="button" class="btn btn-primary" data-save>Guardar</button>`,
            onMount: (card, close) => {
                if (readOnly) {
                    card.querySelector('[data-cancel]').addEventListener('click', close);
                    card.querySelector('[data-open-day]').addEventListener('click', () => { close(); openDayDrawer(date); });
                    return;
                }
                const select = card.querySelector('#insp-value');
                const detail = card.querySelector('#insp-detail');
                const renderDetail = () => {
                    const value = select.value;
                    if (!G.isCode(value)) {
                        detail.innerHTML = value ? `<span class="tag ${STATUS[value]?.tag || ''}">${h(STATUS[value]?.short || value)} · ${h(STATUS[value]?.label || value)}</span>` : '<span class="field-hint">Sin asignación: el conductor figura como libre.</span>';
                        return;
                    }
                    const v = G.variantFor(value, kind);
                    const sh = G.shiftFor(value);
                    if (!v) {
                        detail.innerHTML = `<span class="tag bad">${icon('warning')} Este turno no está definido para ${KIND_LABEL[kind]}</span>`;
                        return;
                    }
                    detail.innerHTML = `<div class="variant-row">
                        <span class="tag line"><i class="swatch" style="background:${G.lineColor(v.line)}"></i>${h(v.lineLabel || v.line)}</span>
                        <span class="variant"><b>Horario</b> ${v.start}–${v.end}</span>
                        <span class="variant"><b>Horas</b> ${fmtHours(v.hours)}</span>
                        ${G.effectiveVehicleFor(driverId, date) ? `<span class="variant"><b>Bus</b> ${h(G.effectiveVehicleFor(driverId, date))}</span>` : ''}
                        ${sh?.lineLabel && sh.lineLabel !== v.lineLabel ? `<span class="variant" title="${h(sh.lineLabel)}">${h(sh.lineLabel)}</span>` : ''}
                    </div>`;
                };
                select.addEventListener('change', renderDetail);
                renderDetail();
                card.querySelector('[data-save]').addEventListener('click', () => {
                    G.setValue(driverId, date, select.value);
                    close();
                });
                card.querySelector('[data-delete]').addEventListener('click', () => {
                    G.setValue(driverId, date, '');
                    close();
                });
                card.querySelector('[data-cancel]').addEventListener('click', close);
                card.querySelector('[data-open-day]').addEventListener('click', () => { close(); openDayDrawer(date); });
            },
        });
        void modal;
    }
    G.openCellInspector = openCellInspector;

    /* ---------- Panel del día --------------------------------------------- */

    function openDayDrawer(date) {
        const stats = G.computeMonth();
        const cov = stats.coverage.get(date);
        if (!cov) return;
        const kind = cov.kind;
        const holiday = G.holidayFor(date);
        const codes = [...G.codesFor(kind)];
        // Los turnos archivados siguen viéndose en los meses en que se usaron.
        for (const code of cov.codes?.keys() || []) {
            if (!codes.includes(Number(code))) codes.push(Number(code));
        }
        codes.sort((a, b) => a - b);
        const assignedCount = cov.assigned;

        const rows = codes.map((code, idx) => {
            const v = G.variantFor(code, kind);
            if (!v) return '';
            const ids = cov.codes.get(String(code)) || [];
            const reserve = idx >= cov.need;
            const driver = ids.length ? G.driverById(ids[0]) : null;
            const dup = ids.length > 1;
            return `<div class="service-row ${ids.length ? '' : 'uncovered'}" ${ids.length === 1 ? `data-edit="${h(ids[0])}|${date}"` : ''}>
                <span class="service-code">T${pad2(code)}</span>
                <div class="service-main">
                    <b>${ids.length ? h(G.prettyName(driver?.name)) : 'Sin cubrir'}</b>
                    <span>${h(v.lineLabel || v.line)} · ${v.start}–${v.end}${ids.length && G.effectiveVehicleFor(ids[0], date) ? ' · bus ' + h(G.effectiveVehicleFor(ids[0], date)) : ''}${reserve ? ' · reserva' : ''}</span>
                </div>
                ${ids.length
                    ? `<span class="tag ${dup ? 'bad' : 'ok'}">${dup ? ids.length + ' asignados' : 'Asignado'}</span>`
                    : `<button type="button" class="btn btn-sm" data-assign-code="${code}">Asignar</button>`}
            </div>`;
        }).join('');

        const invalid = [];
        for (const id of G.rosterDrivers().map((d) => String(d.id))) {
            const val = G.getValAt(id, date);
            if (G.isCode(val) && !G.variantFor(val, kind)) {
                invalid.push(`<div class="service-row" data-edit="${h(id)}|${date}">
                    <span class="service-code">T${pad2(val)}</span>
                    <div class="service-main"><b>${h(G.prettyName(G.driverById(id)?.name))}</b><span>Turno no válido para ${KIND_LABEL[kind]}</span></div>
                    <span class="tag bad">Revisar</span>
                </div>`);
            }
        }

        const root = document.getElementById('drawer-root');
        root.innerHTML = `<div class="drawer-backdrop">
            <div class="drawer-card" role="dialog" aria-modal="true" aria-label="Servicios del día">
                <div class="drawer-head" style="position:relative">
                    <div class="kicker">${h(KIND_LABEL[kind])}${holiday ? ' · ' + h(holiday.name) : ''}</div>
                    <h3>${Number(date.slice(8))} de ${MONTHS[Number(date.slice(5, 7)) - 1]}</h3>
                    <p>${h(G.prettyDate(date))}</p>
                    <button type="button" class="icon-btn" data-drawer-close aria-label="Cerrar">${icon('close')}</button>
                </div>
                <div class="drawer-body">
                    <div class="drawer-stat">
                        <div><b>${cov.need}</b><span>necesarios</span></div>
                        <div><b style="color:${cov.missing ? 'var(--bad)' : 'var(--ok)'}">${cov.assigned}</b><span>asignados</span></div>
                        <div><b>${cov.missing}</b><span>sin cubrir</span></div>
                    </div>
                    ${cov.missing ? `<div class="inspector-absence" style="margin-bottom:12px">${icon('warning')} Faltan ${G.plural(cov.missing, 'servicio', 'servicios')} por cubrir.</div>` : ''}
                    <div class="section-title">Servicios (${codes.length})</div>
                    <div class="service-list">${rows}</div>
                    ${invalid.length ? `<div class="section-title" style="margin-top:16px">Asignaciones no válidas</div><div class="service-list">${invalid.join('')}</div>` : ''}
                </div>
            </div>
        </div>`;

        const backdrop = root.firstElementChild;
        const close = () => { root.innerHTML = ''; };
        backdrop.addEventListener('mousedown', (e) => { if (e.target === backdrop) close(); });
        root.querySelector('[data-drawer-close]').addEventListener('click', close);
        root.addEventListener('click', (e) => {
            const assign = e.target.closest('[data-assign-code]');
            if (assign) {
                openDriverPicker(date, assign.dataset.assignCode);
                return;
            }
            const edit = e.target.closest('[data-edit]');
            if (edit) {
                const [driverId, d] = edit.dataset.edit.split('|');
                openCellInspector(driverId, d);
            }
        });
    }
    G.openDayDrawer = openDayDrawer;

    function availability(driverId, date, code) {
        const absence = G.absenceFor(driverId, date);
        if (absence) return { ok: false, reason: STATUS[absence.type]?.label || 'Ausencia' };
        const current = G.getValAt(driverId, date);
        if (G.isCode(current)) return { ok: false, reason: 'Ya trabaja' };
        const prevDate = G.addDays(date, -1);
        const prev = G.getValAt(driverId, prevDate);
        const kind = G.dayKind(date);
        const variant = G.variantFor(code, kind);
        if (G.isCode(prev) && variant) {
            const prevVariant = G.variantFor(prev, G.dayKind(prevDate));
            if (prevVariant) {
                const prevEnd = G.serviceSlot(prevVariant)[1];
                const rest = (1440 - prevEnd) + G.serviceSlot(variant)[0];
                if (rest < G.minRestMin()) return { ok: false, reason: `Descanso ${fmtHours(rest / 60)}` };
            }
            const rule = G.consecutiveCheck(driverId, date, code);
            if (!rule.ok) return { ok: false, reason: rule.reason };
        }
        return { ok: true, reason: '' };
    }

    function openDriverPicker(date, code) {
        const kind = G.dayKind(date);
        const v = G.variantFor(code, kind);
        const drivers = G.rosterDrivers().sort((a, b) => G.prettyName(a.name).localeCompare(G.prettyName(b.name), 'es'));
        const modal = G.openModal({
            title: `Asignar T${pad2(code)}`,
            subtitle: `${G.prettyDate(date)} · ${v ? `${v.lineLabel || v.line} · ${v.start}–${v.end}` : KIND_LABEL[kind]}`,
            wide: true,
            body: `<div class="search-box" style="width:100%">${icon('search')}<input type="search" id="picker-search" placeholder="Buscar conductor…" style="width:100%"></div>
                <div class="picker-list" id="picker-list"></div>`,
            footer: `<span class="field-hint">Los conductores no disponibles aparecen atenuados con el motivo.</span><span class="spacer"></span><button type="button" class="btn" data-close>Cancelar</button>`,
            onMount: (card, close) => {
                const list = card.querySelector('#picker-list');
                const renderList = (query = '') => {
                    const q = norm(query);
                    list.innerHTML = drivers
                        .filter((d) => !q || norm(`${d.name} ${d.id}`).includes(q))
                        .map((d) => {
                            const av = availability(d.id, date, code);
                            return `<button type="button" class="picker-row" data-pick="${h(d.id)}" ${av.ok ? '' : 'disabled'}>
                                <span class="avatar ${Number(d.id) % 2 ? 'alt' : ''}">${h(G.initials(d.name))}</span>
                                <span class="person" style="display:block"><span class="person-name">${h(G.prettyName(d.name))}</span><span class="person-meta">IDC ${h(d.id)}</span></span>
                                <span class="tag ${av.ok ? 'ok' : 'bad'}">${av.ok ? 'Disponible' : h(av.reason)}</span>
                            </button>`;
                        }).join('') || `<div class="empty">Sin resultados</div>`;
                };
                renderList();
                card.querySelector('#picker-search').addEventListener('input', (e) => renderList(e.target.value));
                list.addEventListener('click', (e) => {
                    const row = e.target.closest('[data-pick]');
                    if (!row || row.disabled) return;
                    G.setValue(row.dataset.pick, date, String(code));
                    close();
                    openDayDrawer(date);
                    G.toast(`T${pad2(code)} asignado a ${G.prettyName(G.driverById(row.dataset.pick)?.name)}`);
                });
            },
        });
        void modal;
    }

    /* ---------- Acciones de mes ------------------------------------------- */

    async function autoAssign() {
        const ok = await G.confirmDialog('Autoasignar el mes',
            `Se generará el cuadrante completo de <b>${G.monthLabel(S.month)}</b> respetando ausencias, descansos, parejas fijas y grupos (A de mañana, B de tarde). Cada conductor recibirá los ${G.freeDaysFor(S.month)} días libres del mes; el sobrante se marca como X. Solo se saltará un grupo si no queda otra opción. Se reemplazará lo asignado.`,
            { confirm: 'Autoasignar', danger: false });
        if (!ok) return;
        await G.flushPending();
        try {
            const res = await G.api('autoAssign', { month: S.month });
            S.db = res.db;
            G.buildIndexes();
            for (const key of [...S.pending.keys()]) if (key.startsWith(S.month + '|')) S.pending.delete(key);
            S.cache = null;
            S.rev++;
            G.render();
            const st = res.stats || {};
            const parts = [`${st.generated ?? 0} servicios cuadrados`];
            if (st.reassigned) parts.push(`${st.reassigned} buses reasignados`);
            if (st.paired) parts.push(`${st.paired} parejas juntas`);
            if (st.crossGroup) parts.push(`${st.crossGroup} cambios de grupo de emergencia`);
            if (st.virtual) parts.push(`${st.virtual} jornadas virtuales (X)`);
            if (st.uncovered) parts.push(`${st.uncovered} sin cubrir por falta de bus o autorización`);
            G.toast(parts.join(' · '));
        } catch (err) {
            G.toast('No se pudo autoasignar: ' + err.message, 'bad');
        }
    }

    async function clearMonth() {
        const ok = await G.confirmDialog('Limpiar el mes',
            `Se borrarán los turnos y descansos de <b>${G.monthLabel(S.month)}</b>. Las ausencias (VA, BA, AP, P, HS y R) se conservan. Esta acción no se puede deshacer.`,
            { confirm: 'Limpiar mes', danger: true });
        if (!ok) return;
        try {
            const res = await G.api('reset', { month: S.month });
            S.db = res.db;
            G.buildIndexes();
            for (const key of [...S.pending.keys()]) if (key.startsWith(S.month + '|')) S.pending.delete(key);
            S.cache = null;
            S.rev++;
            G.render();
            G.toast('Mes limpiado');
        } catch (err) {
            G.toast('No se pudo limpiar: ' + err.message, 'bad');
        }
    }

    function openAlertsModal() {
        const stats = G.computeMonth();
        const list = stats.alerts.map((a, i) => `<div class="alert ${a.sev === 'high' ? 'sev-high' : a.sev === 'low' ? 'sev-low' : 'sev-medium'}" data-alert-index="${i}">
            <div class="alert-icon">${icon(a.sev === 'high' ? 'warning' : a.sev === 'low' ? 'sparkles' : 'clock')}</div>
            <div class="alert-body"><div class="alert-title">${h(a.title)}</div><div class="alert-sub">${h(a.sub || '')}</div></div>
        </div>`).join('');
        const modal = G.openModal({
            title: 'Todas las incidencias',
            subtitle: `${G.monthLabel(S.month)} · ${stats.alerts.length} incidencias`,
            wide: true,
            body: `<div class="alerts" style="max-height:60vh;padding:0">${list || '<div class="empty">Sin incidencias</div>'}</div>`,
            footer: `<span class="spacer"></span><button type="button" class="btn" data-close>Cerrar</button>`,
            onMount: (card, close) => {
                card.querySelector('.modal-body').addEventListener('click', (e) => {
                    const item = e.target.closest('[data-alert-index]');
                    if (!item) return;
                    const alert = stats.alerts[Number(item.dataset.alertIndex)];
                    close();
                    if (alert.driverId && alert.date) openCellInspector(alert.driverId, alert.date);
                    else if (alert.date) openDayDrawer(alert.date);
                });
            },
        });
        void modal;
    }

    G.views.cuadrante = renderCuadrante;
    G.binders.cuadrante = bindCuadrante;
})();
