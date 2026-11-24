/* ==========================================================================
   Vistas: resumen del mes y ajustes.
   ========================================================================== */
(() => {
    'use strict';

    const { S, $, $$, h, icon, fmtNum, fmtPct, fmtHours, pad2, STATUS, KIND_LABEL } = G;

    function kpiCard(name, iconName, value, label, sub, tone = '') {
        return `<div class="kpi">
            <div class="kpi-icon ${tone}">${icon(iconName)}</div>
            <div class="kpi-body"><div class="kpi-value" data-kpi="${name}">${value}</div>
            <div class="kpi-label">${label}</div><div class="kpi-sub">${sub}</div></div>
        </div>`;
    }

    /* ======================================================================
       RESUMEN
       ====================================================================== */

    function lineHours(stats) {
        const map = new Map();
        for (const date of stats.days) {
            const kind = G.dayKind(date);
            const cov = stats.coverage.get(date);
            for (const [code, ids] of cov.codes) {
                const v = G.variantFor(code, kind);
                if (!v) continue;
                const line = v.line || 'REF';
                map.set(line, (map.get(line) || 0) + (Number(v.hours) || 0) * ids.length);
            }
        }
        return [...map.entries()].sort((a, b) => b[1] - a[1]);
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

    function alertsList(stats, limit = 8) {
        if (!stats.alerts.length) {
            return `<div class="empty">${icon('check')}<b>Sin incidencias</b><p>Todo cuadra en el mes seleccionado.</p></div>`;
        }
        return stats.alerts.slice(0, limit).map((a, i) => `<div class="alert ${a.sev === 'high' ? 'sev-high' : a.sev === 'low' ? 'sev-low' : ''}" data-alert-index="${i}">
            <div class="alert-icon">${icon(a.sev === 'high' ? 'warning' : a.sev === 'low' ? 'sparkles' : 'clock')}</div>
            <div class="alert-body"><div class="alert-title">${h(a.title)}</div><div class="alert-sub">${h(a.sub || '')}</div></div>
        </div>`).join('');
    }

    function renderResumen() {
        const stats = G.computeMonth();
        const t = stats.totals;
        const lines = lineHours(stats);
        const maxLine = Math.max(1, ...lines.map(([, v]) => v));
        const absences = (S.db.absences || [])
            .filter((a) => a.from.slice(0, 7) <= S.month && a.to.slice(0, 7) >= S.month)
            .sort((a, b) => a.from.localeCompare(b.from));
        const absenceDays = absences.reduce((sum, a) => {
            const from = a.from < S.month + '-01' ? S.month + '-01' : a.from;
            const last = G.monthDays(S.month).slice(-1)[0];
            const to = a.to > last ? last : a.to;
            return sum + G.rangeDays(from, to).length;
        }, 0);

        const ranked = G.rosterDrivers()
            .map((d) => ({ d, st: stats.driverStats.get(String(d.id)) || {} }))
            .sort((a, b) => (b.st.hours || 0) - (a.st.hours || 0))
            .slice(0, 10);

        const rows = ranked.map(({ d, st }, i) => `<tr class="row-click" data-open-driver="${h(d.id)}">
            <td class="num">${i + 1}</td>
            <td><div class="person"><span class="avatar ${i % 2 ? 'alt' : ''}">${h(G.initials(d.name))}</span>
                <div style="min-width:0"><div class="person-name">${h(G.prettyName(d.name))}</div><div class="person-meta">IDC ${h(d.id)}</div></div></div></td>
            <td class="num">${st.work || 0}</td>
            <td class="num">${fmtHours(st.hours || 0)}</td>
            <td class="num">${st.rest || 0}</td>
            <td class="num">${st.maxConsec || 0}</td>
        </tr>`).join('');

        const absRows = absences.map((a) => `<div class="absence-row">
            <span class="tag ${STATUS[a.type]?.tag || ''}">${h(STATUS[a.type]?.short || a.type)} · ${h(STATUS[a.type]?.label || a.type)}</span>
            <div class="absence-main"><b>${h(G.prettyName(G.driverById(a.driverId)?.name || a.driverId))}</b>
                <span>${a.from} → ${a.to}${a.note ? ' · ' + h(a.note) : ''}</span></div>
        </div>`).join('');

        return `
        <div class="page-head">
            <div><h2>Resumen de ${G.monthLabel(S.month)}</h2><p>Cobertura, horas por línea, carga del personal y avisos del cuadrante.</p></div>
            <div class="spacer"></div>
            <button type="button" class="btn btn-sm" data-act="export">${icon('download')} Exportar CSV</button>
            <button type="button" class="btn btn-sm" data-act="print">${icon('print')} Imprimir</button>
        </div>
        <div class="kpi-row">
            ${kpiCard('r-cov', 'grid', fmtPct(t.coverage * 100), 'Cobertura', `${fmtNum(t.assigned)} de ${fmtNum(t.need)} servicios`, t.coverage >= .995 ? '' : 'warn')}
            ${kpiCard('r-days', 'check', `${t.fullDays}/${stats.days.length}`, 'Días completos', 'Con la plantilla necesaria')}
            ${kpiCard('r-hours', 'clock', fmtNum(t.hours) + ' h', 'Horas planificadas', `${fmtHours(t.assigned ? t.hours / t.assigned : 0)} por turno`)}
            ${kpiCard('r-abs', 'calendar', fmtNum(absenceDays), 'Días de ausencia', `${absences.length} registros · ${G.absenceTotal(t.status)} días · ${t.status.PI + t.status.PC + t.status.PF} P · ${t.status.HS} HS · ${t.status.HR} R`)}
            ${kpiCard('r-alert', 'warning', fmtNum(t.high + t.medium), 'Incidencias', `${t.high} críticas · ${t.medium} avisos`, t.high ? 'bad' : t.medium ? 'warn' : '')}
        </div>
        <div class="two-col">
            <section class="panel">
                <div class="panel-head"><div><h3>Cobertura diaria</h3><p>Servicios asignados frente a los necesarios</p></div></div>
                <div class="chart"><div class="chart-bars">${coverageBars(stats)}</div></div>
            </section>
            <section class="panel">
                <div class="panel-head"><div><h3>Horas por línea</h3><p>Reparto de la carga del mes</p></div></div>
                <div class="hbars">${lines.slice(0, 10).map(([line, hours]) => `<div class="hbar">
                    <span class="hbar-label" title="${h(G.lineFor(line)?.name || line)}">${h(line)}</span>
                    <div class="hbar-track"><i style="width:${Math.round((hours / maxLine) * 100)}%;background:${G.lineColor(line)}"></i></div>
                    <span class="hbar-value">${fmtNum(hours)} h</span>
                </div>`).join('') || `<div class="empty">Sin servicios este mes</div>`}</div>
            </section>
        </div>
        <div class="two-col">
            <section class="panel">
                <div class="panel-head"><div><h3>Mayor carga</h3><p>Conductores con más horas planificadas</p></div>
                    <div class="panel-actions"><button type="button" class="btn btn-sm" data-goto="personal">Ver personal</button></div></div>
                <div class="table-wrap"><table class="data">
                    <thead><tr><th class="num">#</th><th>Conductor</th><th class="num">Turnos</th><th class="num">Horas</th><th class="num">Libres</th><th class="num">Seguidos</th></tr></thead>
                    <tbody>${rows || `<tr><td colspan="6"><div class="empty">Sin datos</div></td></tr>`}</tbody>
                </table></div>
            </section>
            <section class="panel">
                <div class="panel-head"><div><h3>Incidencias</h3><p>${t.high} críticas · ${t.medium} avisos · ${t.low} informativas</p></div>
                    ${stats.alerts.length ? '<div class="panel-actions"><button type="button" class="btn btn-sm" data-act="all-alerts">Ver todas</button></div>' : ''}</div>
                <div class="alerts" id="resumen-alerts">${alertsList(stats)}</div>
            </section>
        </div>
        <section class="panel" style="margin-top:12px">
            <div class="panel-head"><div><h3>Ausencias del mes</h3><p>Vacaciones, bajas y asuntos propios registrados</p></div>
                <div class="panel-actions"><button type="button" class="btn btn-sm" data-goto="personal">Gestionar</button></div></div>
            <div class="absence-list">${absRows || `<div class="empty">${icon('calendar')}<b>Sin ausencias</b><p>No hay ausencias registradas en este mes.</p></div>`}</div>
        </section>`;
    }

    function bindResumen() {
        const view = $('#view');
        view.onclick = (e) => {
            const act = e.target.closest('[data-act]');
            if (act) {
                if (act.dataset.act === 'export') G.exportCsv();
                else if (act.dataset.act === 'print') window.print();
                else if (act.dataset.act === 'all-alerts') openAlertsModal();
                return;
            }
            const go = e.target.closest('[data-goto]');
            if (go) { G.setView(go.dataset.goto); return; }
            const alert = e.target.closest('[data-alert-index]');
            if (alert) {
                const item = G.S.lastAlerts[Number(alert.dataset.alertIndex)];
                if (!item) return;
                if (item.driverId && item.date) G.openCellInspector(item.driverId, item.date);
                else if (item.date) G.openDayDrawer(item.date);
                return;
            }
            const row = e.target.closest('[data-open-driver]');
            if (row) G.setView('personal');
        };
    }

    function openAlertsModal() {
        const stats = G.computeMonth();
        const list = stats.alerts.map((a, i) => `<div class="alert ${a.sev === 'high' ? 'sev-high' : a.sev === 'low' ? 'sev-low' : ''}" data-alert-index="${i}">
            <div class="alert-icon">${icon(a.sev === 'high' ? 'warning' : a.sev === 'low' ? 'sparkles' : 'clock')}</div>
            <div class="alert-body"><div class="alert-title">${h(a.title)}</div><div class="alert-sub">${h(a.sub || '')}</div></div>
        </div>`).join('');
        G.openModal({
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
                    if (alert.driverId && alert.date) G.openCellInspector(alert.driverId, alert.date);
                    else if (alert.date) G.openDayDrawer(alert.date);
                });
            },
        });
    }

    /* ======================================================================
       AJUSTES
       ====================================================================== */

    function renderAjustes() {
        const settings = S.db.settings || {};
        const general = Number(settings.maxConsecutive) || 5;
        const extra = settings.exceptionDays === undefined ? 6 : Number(settings.exceptionDays);
        const excHours = settings.exceptionRest === undefined ? 48 : Number(settings.exceptionRest);
        const minHours = settings.minRest === undefined ? 12 : Number(settings.minRest);
        const reducedHours = settings.reducedRestMin === undefined ? 9 : Number(settings.reducedRestMin);
        const maxReduced = settings.maxReducedRests === undefined ? 3 : Number(settings.maxReducedRests);
        const exceptionOn = Number.isFinite(extra) && extra > general;
        const needs = S.db.needs || {};
        const holidays = (S.db.holidays || []).map((x) => (typeof x === 'string' ? { date: x, name: 'Festivo' } : x))
            .sort((a, b) => a.date.localeCompare(b.date));
        const monthAssignments = Object.keys(S.db.assignments?.[S.month] || {}).length;
        const holidaysMonth = holidays.filter((h) => h.date.slice(0, 7) === S.month);

        // Las necesidades llegan calculadas desde el servidor a partir de los turnos.
        const monthDates = G.monthDays(S.month);
        const dayCounts = { lv: 0, sab: 0, dom: 0 };
        monthDates.forEach((date) => { dayCounts[G.dayKind(date)]++; });
        const needTypes = [
            ['lv', 'Laborables'],
            ['sab', 'Sábados'],
            ['dom', 'Domingos y festivos'],
        ];
        const needRows = needTypes.map(([k, label]) => {
            const daily = Number(needs[k]) || 0;
            const count = dayCounts[k] || 0;
            return `<tr><td>${label}</td><td class="num">${count}</td><td class="num"><b>${daily}</b></td><td class="num">${fmtNum(count * daily)}</td></tr>`;
        }).join('');
        const needTotal = needTypes.reduce((sum, [k]) => sum + (dayCounts[k] || 0) * (Number(needs[k]) || 0), 0);
        const plan = G.turnPlan(S.month, needTotal);
        const freeDays = G.freeDaysFor(S.month);

        const holidayRows = holidaysMonth.map((hol) => `<div class="holiday-row">
            <b>${h(hol.date)}</b><span>${h(hol.name || 'Festivo')}</span>
            ${G.canEditSettings === false ? '' : `<button type="button" class="icon-btn" data-del-holiday="${h(hol.date)}" title="Eliminar">${icon('trash')}</button>`}
        </div>`).join('');

        return `
        <div class="page-head">
            <div><h2>Ajustes de la aplicación</h2><p>Necesidades del servicio, reglas del cuadrante, festivos y datos guardados.</p></div>
        </div>
        <div class="two-col">
            <section class="panel">
                <div class="panel-head"><div><h3>Necesidades diarias</h3><p>Calculadas desde los turnos que existen</p></div>
                    <div class="panel-actions"><span class="tag info">${G.canEditSettings === false ? 'Solo lectura' : 'Días libres editables'}</span></div></div>
                <div class="modal-body">
                    <div class="form-grid">
                        <div class="field"><label>Laborables</label><input type="number" id="need-lv" value="${Number(needs.lv) || 0}" readonly></div>
                        <div class="field"><label>Sábados</label><input type="number" id="need-sab" value="${Number(needs.sab) || 0}" readonly></div>
                        <div class="field"><label>Domingos y festivos</label><input type="number" id="need-dom" value="${Number(needs.dom) || 0}" readonly></div>
                        <div class="field"><label>Días libres en ${G.monthLabel(S.month)}</label><input type="number" id="set-free-days" min="0" max="${plan.days}" value="${freeDays}" ${G.canEditSettings === false ? 'readonly' : ''}></div>
                    </div>
                    <p class="field-hint" style="margin-top:8px">Se actualizan solas al crear, editar o eliminar turnos. Un turno cuenta para un tipo de día si tiene horario de ese tipo. Los días libres se fijan por mes: por defecto ${G.defaultFreeDays(S.month)} en ${G.monthLabel(S.month)} <code>(( ${plan.days} × 8 h ) − 166 h) / 8 h</code>, redondeado al más cercano.</p>
                    <div class="rule-note" style="margin-top:10px">
                        <b>Plan de ${G.monthLabel(S.month)}</b>
                        <p>${plan.days} días − ${plan.free} libres = <b>${plan.workDays} días de trabajo</b>. Con ${fmtNum(plan.shifts)} turnos por cubrir hacen falta <b>${fmtNum(plan.drivers)} conductores</b> (<code>ceil(${fmtNum(plan.shifts)} / ${plan.workDays || 1})</code>). La capacidad es ${fmtNum(plan.capacity)} jornadas, por lo que quedan <b>${fmtNum(plan.x)} jornadas X</b> (${plan.x ? 'se marcan como jornada sin turno' : 'sin jornadas virtuales'}).</p>
                    </div>
                    <table class="data" style="margin-top:10px">
                        <thead><tr><th>Tipo de día</th><th class="num">Días en ${G.monthLabel(S.month)}</th><th class="num">Turnos/día</th><th class="num">Servicios del mes</th></tr></thead>
                        <tbody>${needRows}</tbody>
                        <tfoot><tr><td colspan="3"><b>Total del mes</b></td><td class="num"><b>${fmtNum(needTotal)}</b></td></tr></tfoot>
                    </table>
                </div>
            </section>
            <section class="panel">
                <div class="panel-head"><div><h3>Reglas del cuadrante</h3><p>Límites que aplican la autoasignación y la asignación manual</p></div>
                    ${G.canEditSettings === false ? '<div class="panel-actions"><span class="tag info">Solo lectura</span></div>' : ''}</div>
                <div class="modal-body">
                    <div class="form-grid">
                        <div class="field"><label>Máximo de días seguidos</label><input type="number" id="set-max" min="1" max="14" value="${general}" ${G.canEditSettings === false ? 'readonly' : ''}></div>
                        <div class="field"><label>Días seguidos con excepción (0 = sin excepción)</label><input type="number" id="set-exc-days" min="0" max="14" value="${Number.isFinite(extra) ? extra : 6}" ${G.canEditSettings === false ? 'readonly' : ''}></div>
                        <div class="field"><label>Descanso continuo para la excepción (h)</label><input type="number" id="set-exc-hours" min="1" max="168" value="${Number.isFinite(excHours) ? excHours : 48}" ${G.canEditSettings === false ? 'readonly' : ''}></div>
                        <div class="field"><label>Descanso mínimo entre turnos (h)</label><input type="number" id="set-rest" min="0" max="24" value="${Number.isFinite(minHours) ? minHours : 12}" ${G.canEditSettings === false ? 'readonly' : ''}></div>
                        <div class="field"><label>Descanso diario reducido mínimo (h)</label><input type="number" id="set-reduced-rest" min="1" max="24" value="${Number.isFinite(reducedHours) ? reducedHours : 9}" ${G.canEditSettings === false ? 'readonly' : ''}></div>
                        <div class="field"><label>Máximo de descansos reducidos (0 = sin excepción)</label><input type="number" id="set-max-reduced" min="0" max="14" value="${Number.isFinite(maxReduced) ? maxReduced : 3}" ${G.canEditSettings === false ? 'readonly' : ''}></div>
                    </div>
                    <p class="field-hint" style="margin-top:8px">Los cambios afectan a los avisos del mes, a la asignación manual y a la próxima autoasignación. Al generar un mes se tienen en cuenta los últimos días del anterior para las rachas y el descanso entre turnos. Si cambia la ley, ajuste aquí ambos límites y el descanso exigido.</p>
                    <div class="rule-note rule-note-general" style="margin-top:12px">
                        <b>Regla general: hasta ${general} días consecutivos</b>
                        <p>El límite normal es de ${general} días de trabajo seguidos. Lo aplican la autoasignación y la asignación manual, y produce los avisos del cuadrante.</p>
                    </div>
                    <div class="rule-note rule-note-exception" style="margin-top:8px">
                        <b>${exceptionOn ? `Excepción: ${extra} días consecutivos solo con ${excHours} h de descanso propio` : 'Excepción desactivada'}</b>
                        <p>${exceptionOn
                            ? `Se pueden forzar ${extra} días seguidos únicamente si ese bloque tiene, antes o después, ${excHours} h de descanso continuo que no se reutilizan para otro bloque. El mismo descanso no vale para dos grupos: hace falta un descanso propio distinto para cada bloque. La autoasignación y la asignación manual aplican esta excepción automáticamente.`
                            : 'La excepción está desactivada: para volver a activarla, indique un número de días mayor que el máximo general.'}</p>
                        ${exceptionOn ? `<p>Las ${excHours} h pueden repartirse en medias jornadas: por ejemplo, si se trabaja el viernes por la mañana, al descansar desde la tarde del viernes, todo el sábado y la mañana del domingo se suman ${excHours} h y se puede volver al trabajo el domingo por la tarde.</p>` : ''}
                    </div>
                    <div class="rule-note rule-note-exception" style="margin-top:8px">
                        <b>${maxReduced > 0 ? `Descansos reducidos: hasta ${maxReduced} entre descansos semanales` : 'Descansos reducidos desactivados'}</b>
                        <p>El descanso diario normal es de ${minHours} h. Se admiten descansos de ${reducedHours} h a menos de ${minHours} h, hasta ${maxReduced} veces entre el final de un descanso semanal de ${excHours} h y el inicio del siguiente. No se mide por semana natural: pueden ser días seguidos o alternos y el descanso semanal reinicia el contador. Las horas que faltan hasta ${minHours} h no se recuperan más adelante.</p>
                        ${maxReduced > 0
                            ? `<p>También consumen cupo los descansos de 11 a menos de ${minHours} h: cualquier descanso por debajo del mínimo normal cuenta. Por debajo de ${reducedHours} h el descanso se rechaza.</p>`
                            : '<p>Con 0 no se permite ningún descanso por debajo del mínimo normal de ' + minHours + ' h.</p>'}
                    </div>
                    ${G.canEditSettings === false ? '' : '<div style="margin-top:12px"><button type="button" class="btn btn-primary btn-sm" data-save-settings>Guardar reglas</button></div>'}
                </div>
            </section>
        </div>
        <section class="panel" style="margin-top:12px">
            <div class="panel-head"><div><h3>Festivos de ${G.monthLabel(S.month)}</h3><p>Los festivos se tratan como domingo en el cuadrante.</p></div>
                <div class="panel-actions"><span class="tag info">${holidaysMonth.length} este mes</span></div></div>
            <div class="modal-body">
                <div class="toolbar" style="margin-bottom:10px">
                    ${G.canEditSettings === false ? '' : `<input type="date" class="input" id="holiday-date" value="${S.month}-01">
                    <input type="text" class="input" id="holiday-name" placeholder="Nombre del festivo" style="width:220px">
                    <button type="button" class="btn btn-sm" data-add-holiday>${icon('plus')} Añadir festivo</button>`}
                    <span class="spacer"></span>
                    <button type="button" class="btn btn-sm btn-ghost" data-holidays-year>Ver todos los festivos (${holidays.length})</button>
                </div>
                <div class="holiday-list">${holidayRows || `<div class="empty">${icon('calendar')}<b>Sin festivos este mes</b><p>${G.canEditSettings === false ? 'Los festivos los gestiona un administrador; aquí solo se consultan.' : 'Añade los festivos locales o autonómicos para ajustar la necesidad.'}</p></div>`}</div>
            </div>
        </section>
        <div class="two-col">
            <section class="panel">
                <div class="panel-head"><div><h3>Datos guardados</h3><p>Resumen del estado actual</p></div></div>
                <div class="modal-body">
                    <div class="drawer-stat">
                        <div><b>${fmtNum(G.rosterDrivers().length)}</b><span>conductores</span></div>
                        <div><b>${fmtNum(G.visibleVehicles().length)}</b><span>vehículos</span></div>
                        <div><b>${fmtNum(G.visibleShifts().length)}</b><span>turnos</span></div>
                        <div><b>${fmtNum(monthAssignments)}</b><span>asignaciones</span></div>
                        <div><b>${fmtNum((S.db.absences || []).length)}</b><span>ausencias</span></div>
                        <div><b>${fmtNum(holidays.length)}</b><span>festivos</span></div>
                    </div>
                    <p class="field-hint">Persistencia en <code>data/db.json</code>. La plantilla inicial vacía está en <code>data/seed.json</code>.</p>
                    <div class="toolbar" style="margin-top:12px">
                        <button type="button" class="btn btn-sm" data-act="export">${icon('download')} Exportar CSV</button>
                        <button type="button" class="btn btn-sm" data-act="print">${icon('print')} Imprimir</button>
                    </div>
                </div>
            </section>
            ${G.canEditSettings === false ? '' : `<section class="panel">
                <div class="panel-head"><div><h3>Restablecer</h3><p>Operaciones destructivas sobre los datos</p></div></div>
                <div class="modal-body">
                    <p class="field-hint" style="margin-bottom:10px">La limpieza del mes conserva la plantilla, la flota, los turnos, los festivos y las ausencias. La restauración completa vuelve a la plantilla vacía.</p>
                    <div class="toolbar">
                        <button type="button" class="btn btn-danger btn-sm" data-reset-month>${icon('trash')} Limpiar ${G.monthLabel(S.month)}</button>
                        <button type="button" class="btn btn-danger btn-sm" data-reset-all>${icon('undo')} Restaurar plantilla vacía</button>
                    </div>
                </div>
            </section>`}
        </div>`;
    }

    function bindAjustes() {
        const view = $('#view');
        view.onclick = async (e) => {
            const act = e.target.closest('[data-act]');
            if (act) {
                if (act.dataset.act === 'export') G.exportCsv();
                else if (act.dataset.act === 'print') window.print();
                return;
            }

            if (e.target.closest('[data-save-settings]')) {
                const readInt = (sel, fallback) => {
                    const n = Number($(sel).value);
                    return Number.isFinite(n) ? Math.trunc(n) : fallback;
                };
                const freeDaysByMonth = { ...(S.db.settings?.freeDaysByMonth || {}) };
                const maxFree = G.monthDays(S.month).length;
                freeDaysByMonth[S.month] = Math.max(0, Math.min(maxFree, readInt('#set-free-days', G.defaultFreeDays(S.month))));
                const settings = {
                    ...S.db.settings,
                    currentMonth: S.month,
                    freeDaysByMonth,
                    maxConsecutive: Math.max(1, Math.min(14, readInt('#set-max', 5))),
                    exceptionDays: Math.max(0, Math.min(14, readInt('#set-exc-days', 6))),
                    exceptionRest: Math.max(1, Math.min(168, readInt('#set-exc-hours', 48))),
                    minRest: Math.max(0, Math.min(24, readInt('#set-rest', 12))),
                    reducedRestMin: Math.max(1, Math.min(24, readInt('#set-reduced-rest', 9))),
                    maxReducedRests: Math.max(0, Math.min(14, readInt('#set-max-reduced', 3))),
                };
                try {
                    const res = await G.api('saveSettings', { settings });
                    S.db.settings = res.db.settings;
                    S.cache = null;
                    S.rev++;
                    G.render();
                    G.toast('Reglas actualizadas');
                } catch (err) { G.toast('No se pudo guardar: ' + err.message, 'bad'); }
                return;
            }

            if (e.target.closest('[data-add-holiday]')) {
                const date = $('#holiday-date').value;
                const name = $('#holiday-name').value.trim() || 'Festivo';
                if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) { G.toast('Fecha no válida', 'bad'); return; }
                const rows = (S.db.holidays || []).map((x) => (typeof x === 'string' ? { date: x, name: 'Festivo' } : x));
                if (rows.some((x) => x.date === date)) { G.toast('Ese festivo ya existe', 'bad'); return; }
                rows.push({ date, name });
                await saveHolidays(rows);
                return;
            }

            const del = e.target.closest('[data-del-holiday]');
            if (del) {
                const rows = (S.db.holidays || []).map((x) => (typeof x === 'string' ? { date: x, name: 'Festivo' } : x))
                    .filter((x) => x.date !== del.dataset.delHoliday);
                await saveHolidays(rows);
                return;
            }

            if (e.target.closest('[data-holidays-year]')) {
                const rows = (S.db.holidays || []).map((x) => (typeof x === 'string' ? { date: x, name: 'Festivo' } : x))
                    .sort((a, b) => a.date.localeCompare(b.date));
                G.openModal({
                    title: 'Festivos del año',
                    subtitle: `${rows.length} días festivos registrados`,
                    wide: true,
                    body: `<div class="holiday-list" style="max-height:60vh">${rows.map((hol) => `<div class="holiday-row">
                        <b>${h(hol.date)}</b><span>${h(hol.name || 'Festivo')}</span>
                    </div>`).join('') || '<div class="empty">Sin festivos</div>'}</div>`,
                    footer: `<span class="spacer"></span><button type="button" class="btn" data-close>Cerrar</button>`,
                });
                return;
            }

            if (e.target.closest('[data-reset-month]')) {
                const ok = await G.confirmDialog('Limpiar el mes',
                    `Se borrarán los turnos y descansos de <b>${G.monthLabel(S.month)}</b>. Las ausencias (VA, BA, AP, P, HS y R) se conservan.`,
                    { confirm: 'Limpiar mes', danger: true });
                if (!ok) return;
                try {
                    await G.flushPending();
                    const res = await G.api('reset', { month: S.month });
                    S.db = res.db;
                    G.buildIndexes();
                    S.pending.clear();
                    S.cache = null;
                    S.rev++;
                    G.render();
                    G.toast('Mes limpiado');
                } catch (err) { G.toast('No se pudo limpiar: ' + err.message, 'bad'); }
                return;
            }

            if (e.target.closest('[data-reset-all]')) {
                const ok = await G.confirmDialog('Restaurar la plantilla',
                    'Se descartarán todos los cambios y se volverá a la plantilla vacía: sin conductores, turnos, líneas ni vehículos.',
                    { confirm: 'Restaurar plantilla', danger: true });
                if (!ok) return;
                try {
                    await G.flushPending();
                    const res = await G.api('reset', {});
                    S.db = res.db;
                    G.buildIndexes();
                    S.pending.clear();
                    S.month = G.validMonth(res.db.settings?.currentMonth) ? res.db.settings.currentMonth : S.month;
                    S.cache = null;
                    S.rev++;
                    G.render();
                    G.toast('Plantilla vacía restaurada');
                } catch (err) { G.toast('No se pudo restaurar: ' + err.message, 'bad'); }
            }
        };
    }

    async function saveHolidays(rows) {
        try {
            const res = await G.api('saveHolidays', { holidays: rows });
            S.db = res.db;
            G.buildIndexes();
            S.cache = null;
            S.rev++;
            G.render();
            G.toast('Festivos actualizados');
        } catch (err) { G.toast('No se pudo guardar: ' + err.message, 'bad'); }
    }

    G.views.resumen = renderResumen;
    G.binders.resumen = bindResumen;
    G.views.ajustes = renderAjustes;
    G.binders.ajustes = bindAjustes;
})();
