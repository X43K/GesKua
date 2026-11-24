/* ==========================================================================
   Vistas: personal, flota y turnos.
   ========================================================================== */
(() => {
    'use strict';

    const { S, $, $$, h, icon, fmtNum, fmtPct, fmtHours, pad2, STATUS, KIND_LABEL } = G;
    const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');

    const groupOptions = (selected) => `
        <option value="" ${selected ? '' : 'selected'}>Sin grupo</option>
        <option value="A" ${selected === 'A' ? 'selected' : ''}>A · Mañana</option>
        <option value="B" ${selected === 'B' ? 'selected' : ''}>B · Tarde</option>`;

    const partnerOptions = (excludeId, selected) => {
        const list = G.visibleDrivers()
            .filter((d) => String(d.id) !== String(excludeId))
            .sort((a, b) => G.prettyName(a.name).localeCompare(G.prettyName(b.name), 'es'));
        return `<option value="" ${selected ? '' : 'selected'}>Sin compañero</option>` + list.map((d) => {
            const id = String(d.id);
            const group = String(d.group || '');
            const label = `${G.prettyName(d.name)} · ${id}${d.active ? '' : ' (inactivo)'}${group ? ' · ' + group : ''}`;
            return `<option value="${h(id)}" ${id === String(selected) ? 'selected' : ''}>${h(label)}</option>`;
        }).join('');
    };

    function kpiCard(name, iconName, value, label, sub, tone = '') {
        return `<div class="kpi">
            <div class="kpi-icon ${tone}">${icon(iconName)}</div>
            <div class="kpi-body"><div class="kpi-value" data-kpi="${name}">${value}</div>
            <div class="kpi-label">${label}</div><div class="kpi-sub">${sub}</div></div>
        </div>`;
    }

    const excelButtons = (kind, label, text = 'Excel') => `
        <button type="button" class="btn btn-sm" data-export-excel="${kind}" title="Descargar Excel de ${label.toLowerCase()}">${icon('download')} ${text}</button>
        ${G.canEdit === false ? '' : `<label class="btn btn-sm" title="Subir Excel actualizado de ${label.toLowerCase()}">${icon('upload')} Subir Excel<input type="file" data-import-excel="${kind}" accept=".xls,.xlsx,.csv,application/vnd.ms-excel,text/xml,text/csv" hidden></label>`}`;

    function bindExcelButtons(view, kind) {
        $$('[data-export-excel]', view).forEach((btn) => {
            btn.addEventListener('click', () => G.exportEntityExcel(btn.dataset.exportExcel || kind));
        });
        $$('[data-import-excel]', view).forEach((input) => {
            input.addEventListener('change', async (e) => {
                const file = e.target.files?.[0];
                e.target.value = '';
                await G.importEntity(input.dataset.importExcel || kind, file);
            });
        });
    }

    /* ======================================================================
       PERSONAL
       ====================================================================== */

    function renderPersonal() {
        const stats = G.computeMonth();
        const drivers = G.visibleDrivers().sort((a, b) => G.prettyName(a.name).localeCompare(G.prettyName(b.name), 'es'));
        const maxHours = Math.max(1, ...drivers.map((d) => stats.driverStats.get(String(d.id))?.hours || 0));
        const absences = (S.db.absences || [])
            .filter((a) => !G.driverById(a.driverId)?.deepInactive)
            .filter((a) => a.from.slice(0, 7) <= S.month && a.to.slice(0, 7) >= S.month)
            .sort((a, b) => a.from.localeCompare(b.from));
        const active = drivers.filter((d) => d.active).length;

        const rows = drivers.map((d) => {
            const st = stats.driverStats.get(String(d.id)) || { work: 0, hours: 0, rest: 0, vac: 0, sick: 0, personal: 0, maxConsec: 0, restFlags: 0, consFlags: 0, invalid: 0 };
            const incidents = st.restFlags + st.consFlags + st.invalid;
            const search = norm(`${d.name} ${d.id} ${d.role} ${G.driverVehicleAuthLabel(d)} ${G.driverGroupLabel(d)} ${G.driverPartnerLabel(d)}`);
            const absenceTags = [
                st.vac ? `<span class="tag info">${st.vac} VA</span>` : '',
                st.sick ? `<span class="tag bad">${st.sick} BA</span>` : '',
                st.personal ? `<span class="tag warn">${st.personal} AP</span>` : '',
                st.permission ? `<span class="tag warn">${st.permission} P</span>` : '',
                st.union ? `<span class="tag warn">${st.union} HS</span>` : '',
                st.record ? `<span class="tag warn">${st.record} R</span>` : '',
            ].filter(Boolean).join(' ') || '<span class="field-hint">—</span>';
            return `<tr class="row-click" data-person="${h(d.id)}" data-search="${h(search)}" data-active="${d.active ? '1' : '0'}">
                <td><div class="person"><span class="avatar">${h(G.initials(d.name))}</span><div style="min-width:0"><div class="person-name" title="${h(d.name)}">${h(G.prettyName(d.name))}</div><div class="person-meta">IDC ${h(d.id)} · ${h(d.role || 'Conductor')}</div></div></div></td>
                <td>${d.active ? '<span class="tag ok">Activo</span>' : '<span class="tag">Inactivo</span>'}</td>
                <td>${d.group ? `<span class="tag ${d.group === 'A' ? 'info' : 'warn'}">${h(G.driverGroupLabel(d))}</span>` : '<span class="field-hint">—</span>'}</td>
                <td>${d.partnerId ? h(G.driverPartnerLabel(d)) : '<span class="field-hint">—</span>'}</td>
                <td class="num">${st.work}</td>
                <td><div class="stat-bar"><div class="track"><i style="width:${Math.round((st.hours / maxHours) * 100)}%"></i></div><small>${fmtHours(st.hours)}</small></div></td>
                <td class="num">${st.rest}</td>
                <td>${absenceTags}</td>
                <td class="auth-cell">${h(G.driverVehicleAuthLabel(d))}</td>
                <td class="num">${st.maxConsec || 0}</td>
                <td class="num">${incidents ? `<span class="tag ${incidents > 1 ? 'bad' : 'warn'}">${incidents}</span>` : '<span class="field-hint">—</span>'}</td>
                <td class="actions"><button type="button" class="icon-btn" data-edit-driver="${h(d.id)}" title="Editar">${icon('edit')}</button></td>
            </tr>`;
        }).join('');

        const absRows = absences.map((a) => {
            const driver = G.driverById(a.driverId);
            const days = G.rangeDays(a.from < S.month + '-01' ? S.month + '-01' : a.from, a.to > S.month + '-31' ? S.month + '-31' : a.to).length;
            return `<div class="absence-row">
                <span class="tag ${STATUS[a.type]?.tag || ''}">${h(STATUS[a.type]?.short || a.type)} · ${h(STATUS[a.type]?.label || a.type)}</span>
                <div class="absence-main"><b>${h(G.prettyName(driver?.name || a.driverId))}</b><span>${a.from} → ${a.to} · ${G.plural(days, 'día', 'días')}${a.note ? ' · ' + h(a.note) : ''}</span></div>
                <button type="button" class="icon-btn" data-edit-absence="${h(a.id)}" title="Editar">${icon('edit')}</button>
                <button type="button" class="icon-btn" data-del-absence="${h(a.id)}" title="Eliminar">${icon('trash')}</button>
            </div>`;
        }).join('');

        const pairRows = drivers.map((d) => {
            const partner = d.partnerId ? G.driverById(d.partnerId) : null;
            const preferred = d.group === 'A' ? 'Mañana · turnos impares' : d.group === 'B' ? 'Tarde · turnos pares' : 'Según disponibilidad';
            const search = norm(`${d.name} ${d.id} ${G.driverGroupLabel(d)} ${partner ? partner.name : ''}`);
            const readOnly = G.canEdit === false;
            return `<tr data-pair-person="${h(d.id)}" data-pair-search="${h(search)}">
                <td><div class="person"><span class="avatar">${h(G.initials(d.name))}</span><div style="min-width:0">
                    <div class="person-name" title="${h(d.name)}">${h(G.prettyName(d.name))}</div>
                    <div class="person-meta">IDC ${h(d.id)} · ${d.active ? 'Activo' : 'Inactivo'}</div>
                </div></div></td>
                <td>${readOnly
                    ? (d.group ? `<span class="tag ${d.group === 'A' ? 'info' : 'warn'}">${h(G.driverGroupLabel(d))}</span>` : '<span class="field-hint">—</span>')
                    : `<select class="select select-sm" data-pair-group aria-label="Grupo de ${h(G.prettyName(d.name))}">${groupOptions(String(d.group || ''))}</select>`}</td>
                <td><span class="tag ${d.group === 'A' ? 'info' : d.group === 'B' ? 'warn' : ''}">${h(preferred)}</span></td>
                <td>${readOnly
                    ? (partner ? h(G.prettyName(partner.name)) : '<span class="field-hint">—</span>')
                    : `<select class="select select-sm" data-pair-partner aria-label="Compañero de ${h(G.prettyName(d.name))}">${partnerOptions(d.id, d.partnerId)}</select>`}</td>
                <td class="actions">${readOnly ? '' : `<button type="button" class="icon-btn" data-edit-driver="${h(d.id)}" title="Editar ficha">${icon('edit')}</button>`}</td>
            </tr>`;
        }).join('');

        const fichasTab = S.personalTab !== 'parejas';

        return `
        <div class="page-head">
            <div><h2>Plantilla</h2><p>Consulta la carga del mes, edita fichas, parejas y grupos, y registra ausencias.</p></div>
            <div class="spacer"></div>
            ${excelButtons('drivers', 'Personal')}
            <button type="button" class="btn" data-new-absence>${icon('calendar')} Registrar ausencia</button>
            <button type="button" class="btn btn-primary" data-new-driver>${icon('plus')} Añadir conductor</button>
        </div>
        <div class="seg-tabs" role="tablist" aria-label="Secciones de personal">
            <button type="button" role="tab" data-personal-tab="fichas" aria-selected="${fichasTab}" class="${fichasTab ? 'active' : ''}">${icon('users')} Fichas y carga</button>
            <button type="button" role="tab" data-personal-tab="parejas" aria-selected="${!fichasTab}" class="${!fichasTab ? 'active' : ''}">${icon('sparkles')} Parejas y grupos</button>
        </div>
        <div data-personal-panel="fichas" ${fichasTab ? '' : 'hidden'}>
            <div class="kpi-row">
                ${kpiCard('p-drivers', 'users', fmtNum(drivers.length), 'Conductores', `${active} activos`)}
                ${kpiCard('p-hours', 'clock', fmtNum(stats.totals.hours) + ' h', 'Horas del mes', `Media ${fmtHours(stats.totals.assigned ? stats.totals.hours / stats.totals.assigned : 0)} por turno`)}
                ${kpiCard('p-abs', 'calendar', String(absences.length), 'Ausencias', `${G.absenceTotal(stats.totals?.status)} días · ${stats.totals?.status?.VA || 0} VA · ${stats.totals?.status?.BA || 0} BA · ${stats.totals?.status?.AP || 0} AP · ${(stats.totals?.status?.PI || 0) + (stats.totals?.status?.PC || 0) + (stats.totals?.status?.PF || 0)} P · ${stats.totals?.status?.HS || 0} HS · ${stats.totals?.status?.HR || 0} R`)}
                ${kpiCard('p-alerts', 'warning', String(stats.totals.high + stats.totals.medium), 'Incidencias', 'Descansos, coberturas o turnos', stats.totals.high ? 'bad' : '')}
            </div>
            <section class="panel">
                <div class="panel-head">
                    <div><h3>Conductores</h3><p>${drivers.length} fichas · carga de ${G.monthLabel(S.month)}</p></div>
                    <div class="panel-actions">
                        <div class="search-box">${icon('search')}<input type="search" id="personal-search" placeholder="Buscar nombre, IDC, grupo o compañero…"></div>
                        <select class="select" id="personal-status">
                            <option value="all">Todos</option>
                            <option value="1">Solo activos</option>
                            <option value="0">Solo inactivos</option>
                        </select>
                    </div>
                </div>
                <div class="table-wrap"><table class="data">
                    <thead><tr>
                        <th>Conductor</th><th>Estado</th><th>Grupo</th><th>Compañero</th><th class="num">Turnos</th><th>Horas</th>
                        <th class="num">Libres</th><th>Ausencias</th><th>Autorización de vehículos</th><th class="num">Seguidos</th><th class="num">Incid.</th><th></th>
                    </tr></thead>
                    <tbody>${rows || `<tr><td colspan="12"><div class="empty">${icon('users')}<b>Sin personal</b><p>Añade el primer conductor.</p></div></td></tr>`}</tbody>
                </table></div>
            </section>
            <section class="panel" style="margin-top:13px">
                <div class="panel-head">
                    <div><h3>Ausencias de ${G.monthLabel(S.month)}</h3><p>Vacaciones, bajas y asuntos propios que afectan al cuadrante.</p></div>
                    <div class="panel-actions"><button type="button" class="btn btn-sm" data-new-absence>${icon('plus')} Nueva ausencia</button></div>
                </div>
                <div class="absence-list">${absRows || `<div class="empty">${icon('calendar')}<b>Sin ausencias este mes</b><p>Registra vacaciones o bajas para que el cuadrante las tenga en cuenta.</p></div>`}</div>
            </section>
        </div>
        <div data-personal-panel="parejas" ${fichasTab ? 'hidden' : ''}>
            <section class="panel">
                <div class="panel-head">
                    <div><h3>Parejas y grupos de turno</h3><p>El grupo A se asigna a mañana (turnos impares) y el B a tarde (pares). Autoasignar mantiene a cada pareja junta salvo baja o falta de bus; cambiar de grupo es la última opción.</p></div>
                    <div class="panel-actions"><div class="search-box">${icon('search')}<input type="search" id="pair-search" placeholder="Buscar conductor, grupo o compañero…" value="${h(S.pairSearch)}"></div></div>
                </div>
                <div class="table-wrap"><table class="data">
                    <thead><tr><th>Conductor</th><th>Grupo</th><th>Turno preferido</th><th>Compañero fijo</th><th></th></tr></thead>
                    <tbody>${pairRows || `<tr><td colspan="5"><div class="empty">${icon('users')}<b>Sin personal</b><p>Añade conductores para formar parejas.</p></div></td></tr>`}</tbody>
                </table></div>
                <div class="panel-foot"><span class="field-hint">Los cambios se guardan al elegir una opción. Al asignar un compañero, la pareja queda definida en ambas fichas y el compañero pasa automáticamente al grupo opuesto (A mañana / B tarde).</span></div>
            </section>
        </div>`;
    }

    function bindPersonal() {
        const view = $('#view');
        bindExcelButtons(view, 'drivers');
        const filter = () => {
            const q = norm(S.personalSearch);
            $$('tr[data-person]', view).forEach((tr) => {
                const matchesSearch = !q || tr.dataset.search.includes(q);
                const matchesStatus = S.personalStatus === 'all' || tr.dataset.active === S.personalStatus;
                tr.hidden = !(matchesSearch && matchesStatus);
            });
        };
        view.querySelector('#personal-search')?.addEventListener('input', (e) => { S.personalSearch = e.target.value; filter(); });
        view.querySelector('#personal-status')?.addEventListener('change', (e) => { S.personalStatus = e.target.value; filter(); });

        const filterPairs = () => {
            const q = norm(S.pairSearch);
            $$('tr[data-pair-person]', view).forEach((tr) => {
                tr.hidden = q ? !tr.dataset.pairSearch.includes(q) : false;
            });
        };
        filterPairs();
        view.querySelector('#pair-search')?.addEventListener('input', (e) => { S.pairSearch = e.target.value; filterPairs(); });

        const refreshPairs = () => {
            if (G.canEdit === false) return;
            $$('tr[data-pair-person]', view).forEach((tr) => {
                const d = G.driverById(tr.dataset.pairPerson);
                if (!d) return;
                tr.querySelector('[data-pair-group]').value = String(d.group || '');
                tr.querySelector('[data-pair-partner]').value = String(d.partnerId || '');
                const preferred = d.group === 'A' ? 'Mañana · turnos impares' : d.group === 'B' ? 'Tarde · turnos pares' : 'Según disponibilidad';
                const tag = tr.querySelector('td:nth-child(3) .tag');
                if (tag) {
                    tag.textContent = preferred;
                    tag.className = `tag ${d.group === 'A' ? 'info' : d.group === 'B' ? 'warn' : ''}`;
                }
                tr.dataset.pairSearch = norm(`${d.name} ${d.id} ${G.driverGroupLabel(d)} ${G.driverPartnerLabel(d)}`);
            });
            filterPairs();
        };

        const savePairing = async (row) => {
            if (G.canEdit === false) return;
            const selects = $$('select[data-pair-group], select[data-pair-partner]', row);
            selects.forEach((select) => { select.disabled = true; });
            try {
                const res = await G.api('saveDriverPairing', {
                    driverId: row.dataset.pairPerson,
                    group: row.querySelector('[data-pair-group]').value,
                    partnerId: row.querySelector('[data-pair-partner]').value,
                });
                S.db = res.db;
                G.buildIndexes();
                S.cache = null;
                S.rev++;
                refreshPairs();
                G.toast('Parejas y grupos actualizados');
            } catch (err) {
                G.toast('No se pudo guardar: ' + err.message, 'bad');
                refreshPairs();
            } finally {
                selects.forEach((select) => { select.disabled = false; });
            }
        };

        view.onchange = (e) => {
            const select = e.target.closest('[data-pair-group], [data-pair-partner]');
            if (select) savePairing(select.closest('tr[data-pair-person]'));
        };

        view.onclick = (e) => {
            const tab = e.target.closest('[data-personal-tab]');
            if (tab) { S.personalTab = tab.dataset.personalTab; G.render(); return; }
            const edit = e.target.closest('[data-edit-driver]');
            if (edit) { openDriverModal(G.driverById(edit.dataset.editDriver)); return; }
            const row = e.target.closest('tr[data-person]');
            if (row && !e.target.closest('button')) { openDriverModal(G.driverById(row.dataset.person)); return; }
            if (e.target.closest('[data-new-driver]')) { openDriverModal(null); return; }
            const editAbs = e.target.closest('[data-edit-absence]');
            if (editAbs) { openAbsenceModal(S.db.absences.find((a) => String(a.id) === editAbs.dataset.editAbsence)); return; }
            const delAbs = e.target.closest('[data-del-absence]');
            if (delAbs) { deleteAbsence(delAbs.dataset.delAbsence); return; }
            if (e.target.closest('[data-new-absence]')) { openAbsenceModal(null); return; }
        };
    }

    function openDriverModal(driver) {
        const isNew = !driver;
        const d = driver || { id: '', name: '', role: 'Conductor', active: true, phone: '', license: 'D', since: '', notes: '', authorizedFuels: [], maxVehicleSize: 0, group: '', partnerId: '' };
        const fuels = G.vehicleFuels();
        const sizes = G.vehicleSizes();
        const authorized = d.authorizedFuels || [];
        const maxSize = Number(d.maxVehicleSize) || 0;
        const allowsArticulated = !!d.allowsArticulated;
        const modal = G.openModal({
            title: isNew ? 'Nuevo conductor' : 'Editar conductor',
            subtitle: isNew ? 'Añade una ficha a la plantilla' : `IDC ${d.id}`,
            body: `<div class="form-grid">
                <div class="field"><label>IDC <em>obligatorio</em></label><input id="drv-id" value="${h(d.id)}" placeholder="6007" inputmode="numeric"></div>
                <div class="field"><label>Rol</label><input id="drv-role" value="${h(d.role || 'Conductor')}"></div>
                <div class="field full"><label>Nombre completo <em>obligatorio</em></label><input id="drv-name" value="${h(d.name)}" placeholder="APELLIDOS, NOMBRE"></div>
                <div class="field"><label>Teléfono</label><input id="drv-phone" value="${h(d.phone || '')}" placeholder="600 000 000"></div>
                <div class="field"><label>Carnet</label><input id="drv-license" value="${h(d.license || 'D')}"></div>
                <div class="field"><label>Fecha de alta</label><input type="date" id="drv-since" value="${h(d.since || '')}"></div>
                <div class="field"><label>Estado</label><label class="switch" style="height:34px"><input type="checkbox" id="drv-active" ${d.active ? 'checked' : ''}><i></i> Activo en el cuadrante</label></div>
                <div class="field"><label>Grupo de turno</label><select id="drv-group">${groupOptions(String(d.group || ''))}</select></div>
                <div class="field"><label>Compañero fijo</label><select id="drv-partner">${partnerOptions(d.id, d.partnerId)}</select></div>
                <div class="field full auth-block">
                    <label>Autorización de vehículos</label>
                    <p class="field-hint">Marca uno o varios combustibles y el tope de metros para vehículos rígidos. Autorizar 15 m permite también 9 o 12 m, pero solo con los combustibles marcados. Los articulados se autorizan aparte. La marca y el modelo no influyen.</p>
                    <div class="auth-fuels">
                        ${fuels.length ? fuels.map((f) => `<label class="auth-fuel"><input type="checkbox" data-auth-fuel value="${h(f)}" ${authorized.includes(f) ? 'checked' : ''}> ${h(f)}</label>`).join('') : '<span class="field-hint">No hay combustibles en el catálogo. Créalos en Flota.</span>'}
                    </div>
                    <div class="auth-size">
                        <label for="drv-max-size">Tope de tamaño</label>
                        <input id="drv-max-size" type="number" min="0" max="100" step="1" value="${maxSize}" list="drv-size-options" placeholder="0">
                        <span class="field-hint">0 = sin autorizar</span>
                        <datalist id="drv-size-options">${sizes.map((n) => `<option value="${n}"></option>`).join('')}</datalist>
                    </div>
                    <label class="auth-articulated"><input type="checkbox" id="drv-articulated" ${allowsArticulated ? 'checked' : ''}> Autorizar vehículos articulados</label>
                    <span class="field-hint">No se heredan del tope de metros. Requieren además el combustible marcado.</span>
                </div>
                <div class="field full"><label>Notas</label><textarea id="drv-notes" placeholder="Observaciones, restricciones, etc.">${h(d.notes || '')}</textarea></div>
            </div>`,
            footer: `${isNew ? '' : `<button type="button" class="btn btn-danger btn-sm" data-delete>${icon('trash')} Eliminar</button>`}
                <span class="spacer"></span><button type="button" class="btn" data-cancel>Cancelar</button>
                <button type="button" class="btn btn-primary" data-save>Guardar</button>`,
            onMount: (card, close) => {
                const save = async () => {
                    const id = card.querySelector('#drv-id').value.trim();
                    const name = card.querySelector('#drv-name').value.trim();
                    if (!id || !name) { G.toast('El IDC y el nombre son obligatorios', 'bad'); return; }
                    const payload = {
                        id, name, role: card.querySelector('#drv-role').value.trim() || 'Conductor',
                        active: card.querySelector('#drv-active').checked,
                        phone: card.querySelector('#drv-phone').value.trim(),
                        license: card.querySelector('#drv-license').value.trim(),
                        since: card.querySelector('#drv-since').value,
                        notes: card.querySelector('#drv-notes').value.trim(),
                        group: card.querySelector('#drv-group').value,
                        partnerId: card.querySelector('#drv-partner').value,
                        authorizedFuels: $$('[data-auth-fuel]:checked', card).map((el) => el.value),
                        maxVehicleSize: Number(card.querySelector('#drv-max-size').value) || 0,
                        allowsArticulated: card.querySelector('#drv-articulated').checked,
                    };
                    try {
                        const res = await G.api('saveDriver', { driver: payload, originalId: isNew ? '' : d.id });
                        S.db = res.db;
                        G.buildIndexes();
                        S.cache = null;
                        S.rev++;
                        close();
                        G.render();
                        G.toast(isNew ? 'Conductor añadido' : 'Ficha actualizada');
                    } catch (err) { G.toast('No se pudo guardar: ' + err.message, 'bad'); }
                };
                card.querySelector('[data-save]').addEventListener('click', save);
                card.querySelector('[data-cancel]').addEventListener('click', close);
                card.querySelector('[data-delete]')?.addEventListener('click', async () => {
                    const ok = await G.confirmDialog('Eliminar conductor',
                        `Se eliminará la ficha de <b>${h(G.prettyName(d.name))}</b>, sus ausencias y sus asignaciones. Esta acción no se puede deshacer.`,
                        { confirm: 'Eliminar', danger: true });
                    if (!ok) return;
                    try {
                        const res = await G.api('deleteDriver', { id: d.id });
                        S.db = res.db;
                        G.buildIndexes();
                        S.cache = null;
                        S.rev++;
                        close();
                        G.render();
                        G.toast('Conductor eliminado');
                    } catch (err) { G.toast('No se pudo eliminar: ' + err.message, 'bad'); }
                });
            },
        });
        void modal;
    }

    function openAbsenceModal(absence) {
        const isNew = !absence;
        const a = absence || { driverId: '', from: S.month + '-01', to: S.month + '-01', type: 'VA', note: '' };
        const drivers = G.visibleDrivers().filter((d) => d.active).sort((x, y) => G.prettyName(x.name).localeCompare(G.prettyName(y.name), 'es'));
        const modal = G.openModal({
            title: isNew ? 'Registrar ausencia' : 'Editar ausencia',
            subtitle: 'Los días quedarán marcados en el cuadrante del mes',
            body: `<div class="form-grid">
                <div class="field full"><label>Conductor</label><select id="abs-driver">${drivers.map((d) => `<option value="${h(d.id)}" ${String(d.id) === String(a.driverId) ? 'selected' : ''}>${h(G.prettyName(d.name))} · ${h(d.id)}</option>`).join('')}</select></div>
                <div class="field"><label>Tipo</label><select id="abs-type">
                    <option value="VA" ${a.type === 'VA' ? 'selected' : ''}>VA · Vacaciones</option>
                    <option value="BA" ${a.type === 'BA' ? 'selected' : ''}>BA · Baja médica</option>
                    <option value="AP" ${a.type === 'AP' ? 'selected' : ''}>AP · Asuntos propios</option>
                    <option value="PI" ${a.type === 'PI' ? 'selected' : ''}>P · Permiso por ingreso</option>
                    <option value="PC" ${a.type === 'PC' ? 'selected' : ''}>P · Permiso por cuidados</option>
                    <option value="PF" ${a.type === 'PF' ? 'selected' : ''}>P · Permiso por fallecimiento</option>
                    <option value="HS" ${a.type === 'HS' ? 'selected' : ''}>HS · Horas sindicales</option>
                    <option value="HR" ${a.type === 'HR' ? 'selected' : ''}>R · Horas registro</option>
                </select></div>
                <div class="field"><label>Notas</label><input id="abs-note" value="${h(a.note || '')}" placeholder="Opcional"></div>
                <div class="field"><label>Desde</label><input type="date" id="abs-from" value="${h(a.from)}"></div>
                <div class="field"><label>Hasta</label><input type="date" id="abs-to" value="${h(a.to)}"></div>
            </div>`,
            footer: `<span class="spacer"></span><button type="button" class="btn" data-cancel>Cancelar</button>
                <button type="button" class="btn btn-primary" data-save>Guardar</button>`,
            onMount: (card, close) => {
                card.querySelector('[data-save]').addEventListener('click', async () => {
                    const driverId = card.querySelector('#abs-driver').value;
                    const from = card.querySelector('#abs-from').value;
                    const to = card.querySelector('#abs-to').value;
                    const type = card.querySelector('#abs-type').value;
                    if (!driverId || !from || !to || to < from) { G.toast('Revisa las fechas de la ausencia', 'bad'); return; }
                    try {
                        const res = await G.api('saveAbsence', {
                            absence: { id: a.id || '', driverId, from, to, type, note: card.querySelector('#abs-note').value.trim() },
                        });
                        S.db = res.db;
                        G.buildIndexes();
                        // Limpia el rango anterior si se ha editado.
                        if (!isNew) {
                            for (const date of G.rangeDays(a.from, a.to)) {
                                if (date.slice(0, 7) === S.month && G.getValAt(a.driverId, date) === a.type) G.setValue(a.driverId, date, '');
                            }
                        }
                        for (const date of G.rangeDays(from, to)) {
                            if (date.slice(0, 7) === S.month) G.setValue(driverId, date, type);
                        }
                        S.cache = null;
                        S.rev++;
                        close();
                        G.render();
                        await G.flushPending();
                        G.toast(isNew ? 'Ausencia registrada' : 'Ausencia actualizada');
                    } catch (err) { G.toast('No se pudo guardar: ' + err.message, 'bad'); }
                });
                card.querySelector('[data-cancel]').addEventListener('click', close);
            },
        });
        void modal;
    }

    async function deleteAbsence(id) {
        const absence = S.db.absences.find((a) => String(a.id) === String(id));
        if (!absence) return;
        const ok = await G.confirmDialog('Eliminar ausencia',
            `Se eliminará la ausencia de <b>${h(G.prettyName(G.driverById(absence.driverId)?.name))}</b> (${absence.from} → ${absence.to}). Los días marcados como ${absence.type} quedarán libres.`,
            { confirm: 'Eliminar', danger: true });
        if (!ok) return;
        try {
            const res = await G.api('deleteAbsence', { id });
            S.db = res.db;
            G.buildIndexes();
            for (const date of G.rangeDays(absence.from, absence.to)) {
                if (date.slice(0, 7) === S.month && G.getValAt(absence.driverId, date) === absence.type) G.setValue(absence.driverId, date, '');
            }
            S.cache = null;
            S.rev++;
            G.render();
            await G.flushPending();
            G.toast('Ausencia eliminada');
        } catch (err) { G.toast('No se pudo eliminar: ' + err.message, 'bad'); }
    }

    /* ======================================================================
       FLOTA
       ====================================================================== */

    function fleetServices(date) {
        const kind = G.dayKind(date);
        const map = new Map();
        for (const driver of S.db.drivers) {
            const value = G.getValAt(driver.id, date);
            if (!G.isCode(value)) continue;
            const v = G.variantFor(value, kind);
            if (!v) continue;
            const key = String(G.vehicleAssignmentFor(driver.id, date) || v.vehicle || '');
            if (!key) continue;
            if (!map.has(key)) map.set(key, []);
            map.get(key).push({ code: value, driverId: driver.id, line: v.lineLabel || v.line, start: v.start, end: v.end });
        }
        return map;
    }

    function renderFlota() {
        const date = S.month === G.currentMonth() ? G.todayISO() : S.month + '-01';
        const services = fleetServices(date);
        const vehicles = G.visibleVehicles().sort((a, b) => String(a.id).localeCompare(String(b.id), 'es', { numeric: true }));
        const available = vehicles.filter((v) => v.status === 'disponible').length;
        const workshop = vehicles.filter((v) => v.status === 'taller').length;
        const used = [...services.keys()].filter((id) => G.activeVehicleMap.has(id)).length;
        const types = S.db.vehicleTypes || [];
        const variantCount = types.reduce((n, t) => n + (t.variants || []).length, 0);

        const cards = vehicles.map((v) => {
            const list = services.get(String(v.id)) || [];
            const statusTag = v.status === 'disponible' ? '<span class="tag ok">Disponible</span>' :
                v.status === 'taller' ? '<span class="tag bad">En taller</span>' : '<span class="tag warn">Reserva</span>';
            const typeLabel = G.vehicleTypeLabel(v.typeId);
            const photo = v.photo
                ? `<img class="fleet-photo" src="${h(v.photo)}" alt="Foto del bus ${h(v.id)}">`
                : `<span class="fleet-photo placeholder">${icon('bus')}</span>`;
            const search = norm(`${v.id} ${v.plate} ${v.model} ${v.kind} ${typeLabel}`);
            return `<article class="fleet-card" data-fleet="${h(v.id)}" data-search="${h(search)}" data-status="${h(v.status)}">
                ${photo}
                <div class="fleet-head">
                    <span class="bus-number">${h(v.id)}</span>
                    <div class="fleet-title"><b>${h(typeLabel || v.model || 'Autobús')}</b><span>${h(v.kind || 'urbano')}${v.plate ? ' · ' + h(v.plate) : ''}</span></div>
                    ${statusTag}
                </div>
                <div class="fleet-meta"><span>Hoy: <b>${list.length ? G.plural(list.length, 'servicio', 'servicios') : 'sin servicio'}</b></span><span>Km: <b>${fmtNum(v.km)}</b></span></div>
                <div class="fleet-services">
                    ${list.slice(0, 4).map((s) => `<div class="fleet-service"><span class="code">T${pad2(s.code)}</span><span>${h(s.start)}–${h(s.end)}</span><span class="muted">${h(G.prettyName(G.driverById(s.driverId)?.name))}</span></div>`).join('')}
                    ${list.length > 4 ? `<div class="fleet-service muted">+${list.length - 4} servicios más</div>` : ''}
                </div>
                <div style="display:flex;gap:6px;margin-top:10px">
                    <button type="button" class="btn btn-sm" data-toggle-fleet="${h(v.id)}">${v.status === 'taller' ? 'Marcar disponible' : 'Enviar a taller'}</button>
                    <button type="button" class="icon-btn" data-edit-fleet="${h(v.id)}" title="Editar">${icon('edit')}</button>
                    <button type="button" class="icon-btn" data-del-fleet="${h(v.id)}" title="Eliminar">${icon('trash')}</button>
                </div>
            </article>`;
        }).join('');

        const typeCards = types.map((t) => {
            const variants = (t.variants || []).map((v) => `<div class="subtype-row">
                <span class="subtype-name">${h(v.label || [v.size, v.fuel].filter(Boolean).join(' · ') || 'Variante')}</span>
                ${v.description ? `<span class="field-hint">${h(v.description)}</span>` : ''}
                ${v.active === false ? '<span class="tag">Inactiva</span>' : ''}
                <button type="button" class="icon-btn" data-edit-subtype="${h(t.id)}|${h(v.id)}" title="Editar variante">${icon('edit')}</button>
                <button type="button" class="icon-btn" data-del-subtype="${h(t.id)}|${h(v.id)}" title="Eliminar variante">${icon('trash')}</button>
            </div>`).join('');
            return `<article class="model-card">
                <div class="model-head">
                    <div><b>${h(t.name || [t.brand, t.model].filter(Boolean).join(' '))}</b>
                        <p>${[t.description, (t.variants || []).length + ' variantes'].filter(Boolean).map(h).join(' · ')}</p></div>
                    <div class="model-actions">
                        <button type="button" class="icon-btn" data-edit-type="${h(t.id)}" title="Editar modelo">${icon('edit')}</button>
                        <button type="button" class="icon-btn" data-del-type="${h(t.id)}" title="Eliminar modelo">${icon('trash')}</button>
                    </div>
                </div>
                <button type="button" class="btn btn-sm" data-new-subtype="${h(t.id)}">${icon('plus')} Añadir tamaño/combustible</button>
                <div class="subtype-list">${variants || '<span class="field-hint">Sin variantes todavía</span>'}</div>
            </article>`;
        }).join('');

        return `
        <div class="page-head">
            <div><h2>Flota</h2><p>Vehículos del servicio y su uso el ${h(G.prettyDate(date))}.</p></div>
            <div class="spacer"></div>
            ${excelButtons('vehicles', 'vehículos', 'Excel vehículos')}
            <button type="button" class="btn" data-new-type>${icon('plus')} Añadir modelo</button>
            <button type="button" class="btn btn-primary" data-new-fleet>${icon('plus')} Añadir vehículo</button>
        </div>
        <div class="kpi-row">
            ${kpiCard('f-total', 'bus', fmtNum(vehicles.length), 'Vehículos', 'En la flota')}
            ${kpiCard('f-available', 'check', fmtNum(available), 'Disponibles', `${workshop} en taller`)}
            ${kpiCard('f-used', 'grid', fmtNum(used), 'Con servicio hoy', `De ${vehicles.length} vehículos`)}
            ${kpiCard('f-types', 'grid', fmtNum(types.length), 'Modelos', `${variantCount} tamaños/combustibles`)}
        </div>
        <section class="panel">
            <div class="panel-head">
                <div><h3>Catálogo de modelos</h3><p>Marca, modelo y variantes de tamaño y combustible</p></div>
            </div>
            <div class="model-grid" id="model-grid">${typeCards || `<div class="empty">${icon('grid')}<b>Sin modelos</b><span>Crea el primer modelo de autobús.</span></div>`}</div>
        </section>
        <section class="panel">
            <div class="panel-head">
                <div><h3>Vehículos</h3><p>Estado actual y servicios asignados</p></div>
                <div class="panel-actions">
                    <div class="search-box">${icon('search')}<input type="search" id="fleet-search" placeholder="Buscar bus, matrícula o modelo…"></div>
                    <select class="select" id="fleet-filter">
                        <option value="all">Todos</option>
                        <option value="disponible">Disponibles</option>
                        <option value="taller">En taller</option>
                        <option value="reserva">Reserva</option>
                    </select>
                </div>
            </div>
            <div class="fleet-grid" id="fleet-grid">${cards || `<div class="empty">${icon('bus')}<b>Sin vehículos</b></div>`}</div>
        </section>`;
    }

    function bindFlota() {
        const view = $('#view');
        bindExcelButtons(view, 'vehicles');
        const filter = () => {
            const q = norm(S.fleetSearch);
            $$('.fleet-card', view).forEach((card) => {
                const okSearch = !q || card.dataset.search.includes(q);
                const okStatus = S.fleetStatus === 'all' || card.dataset.status === S.fleetStatus;
                card.hidden = !(okSearch && okStatus);
            });
        };
        view.querySelector('#fleet-search')?.addEventListener('input', (e) => { S.fleetSearch = e.target.value; filter(); });
        view.querySelector('#fleet-filter')?.addEventListener('change', (e) => { S.fleetStatus = e.target.value; filter(); });
        view.onclick = async (e) => {
            if (e.target.closest('[data-new-fleet]')) { openVehicleModal(null); return; }
            if (e.target.closest('[data-new-type]')) { openVehicleTypeModal(null); return; }
            const editType = e.target.closest('[data-edit-type]');
            if (editType) {
                openVehicleTypeModal((S.db.vehicleTypes || []).find((t) => t.id === editType.dataset.editType));
                return;
            }
            const delType = e.target.closest('[data-del-type]');
            if (delType) {
                const t = (S.db.vehicleTypes || []).find((x) => x.id === delType.dataset.delType);
                const ok = await G.confirmDialog('Eliminar modelo', `Se eliminará <b>${h(t?.name || t?.model || 'el modelo')}</b> y todas sus variantes. Los vehículos que lo usen quedarán sin tipo asignado.`, { confirm: 'Eliminar', danger: true });
                if (!ok) return;
                try {
                    const res = await G.api('deleteVehicleType', { id: t.id });
                    S.db = res.db;
                    G.buildIndexes();
                    G.render();
                    G.toast('Modelo eliminado');
                } catch (err) { G.toast('No se pudo eliminar: ' + err.message, 'bad'); }
                return;
            }
            const newSubtype = e.target.closest('[data-new-subtype]');
            if (newSubtype) { openSubtypeModal(newSubtype.dataset.newSubtype, null); return; }
            const editSubtype = e.target.closest('[data-edit-subtype]');
            if (editSubtype) {
                const [typeId, subId] = editSubtype.dataset.editSubtype.split('|');
                const t = (S.db.vehicleTypes || []).find((x) => x.id === typeId);
                openSubtypeModal(typeId, (t?.variants || []).find((v) => v.id === subId));
                return;
            }
            const delSubtype = e.target.closest('[data-del-subtype]');
            if (delSubtype) {
                const [typeId, subId] = delSubtype.dataset.delSubtype.split('|');
                const t = (S.db.vehicleTypes || []).find((x) => x.id === typeId);
                const v = (t?.variants || []).find((x) => x.id === subId);
                const ok = await G.confirmDialog('Eliminar variante', `Se eliminará <b>${h(v?.label || 'la variante')}</b>. Los vehículos que la usen quedarán sin tipo asignado.`, { confirm: 'Eliminar', danger: true });
                if (!ok) return;
                try {
                    const res = await G.api('deleteVehicleSubtype', { id: subId });
                    S.db = res.db;
                    G.buildIndexes();
                    G.render();
                    G.toast('Variante eliminada');
                } catch (err) { G.toast('No se pudo eliminar: ' + err.message, 'bad'); }
                return;
            }
            const edit = e.target.closest('[data-edit-fleet]');
            if (edit) { openVehicleModal(G.vehicleMap.get(edit.dataset.editFleet)); return; }
            const toggle = e.target.closest('[data-toggle-fleet]');
            if (toggle) {
                const vehicle = G.vehicleMap.get(toggle.dataset.toggleFleet);
                const next = { ...vehicle, status: vehicle.status === 'taller' ? 'disponible' : 'taller' };
                try {
                    const res = await G.api('saveVehicle', { vehicle: next, originalId: vehicle.id });
                    S.db = res.db;
                    G.buildIndexes();
                    G.render();
                    G.toast(`${vehicle.id} · ${next.status === 'taller' ? 'enviado a taller' : 'disponible'}`);
                } catch (err) { G.toast('No se pudo actualizar: ' + err.message, 'bad'); }
                return;
            }
            const del = e.target.closest('[data-del-fleet]');
            if (del) {
                const vehicle = G.vehicleMap.get(del.dataset.delFleet);
                const ok = await G.confirmDialog('Eliminar vehículo', `Se eliminará el bus <b>${h(vehicle.id)}</b> de la flota.`, { confirm: 'Eliminar', danger: true });
                if (!ok) return;
                try {
                    const res = await G.api('deleteVehicle', { id: vehicle.id });
                    S.db = res.db;
                    G.buildIndexes();
                    G.render();
                    G.toast('Vehículo eliminado');
                } catch (err) { G.toast('No se pudo eliminar: ' + err.message, 'bad'); }
            }
        };
    }

    function openVehicleTypeModal(type) {
        const isNew = !type;
        const t = type || { brand: '', model: '', description: '', active: true };
        const modal = G.openModal({
            title: isNew ? 'Nuevo modelo de autobús' : 'Editar modelo',
            subtitle: 'Marca, modelo y descripción',
            body: `<div class="form-grid">
                <div class="field"><label>Marca <em>obligatoria si no hay modelo</em></label><input id="vt-brand" value="${h(t.brand || '')}" placeholder="Mercedes-Benz"></div>
                <div class="field"><label>Modelo</label><input id="vt-model" value="${h(t.model || '')}" placeholder="Citaro"></div>
                <div class="field full"><label>Descripción</label><textarea id="vt-description">${h(t.description || '')}</textarea></div>
                <div class="field"><label>Estado</label><select id="vt-active">
                    <option value="1" ${t.active !== false ? 'selected' : ''}>Activo</option>
                    <option value="0" ${t.active === false ? 'selected' : ''}>Inactivo</option>
                </select></div>
            </div>`,
            footer: `<span class="spacer"></span><button type="button" class="btn" data-cancel>Cancelar</button>
                <button type="button" class="btn btn-primary" data-save>Guardar</button>`,
            onMount: (card, close) => {
                card.querySelector('[data-save]').addEventListener('click', async () => {
                    const brand = card.querySelector('#vt-brand').value.trim();
                    const model = card.querySelector('#vt-model').value.trim();
                    if (!brand && !model) { G.toast('Indica la marca o el modelo', 'bad'); return; }
                    try {
                        const res = await G.api('saveVehicleType', {
                            type: { id: isNew ? '' : t.id, brand, model, description: card.querySelector('#vt-description').value.trim(), active: card.querySelector('#vt-active').value === '1' },
                        });
                        S.db = res.db;
                        G.buildIndexes();
                        close();
                        G.render();
                        G.toast(isNew ? 'Modelo añadido' : 'Modelo actualizado');
                    } catch (err) { G.toast('No se pudo guardar: ' + err.message, 'bad'); }
                });
                card.querySelector('[data-cancel]').addEventListener('click', close);
            },
        });
        void modal;
    }

    function openSubtypeModal(typeId, subtype) {
        const isNew = !subtype;
        const v = subtype || { size: '', fuel: '', description: '', active: true };
        const type = (S.db.vehicleTypes || []).find((t) => t.id === typeId);
        const modal = G.openModal({
            title: isNew ? 'Nueva variante' : 'Editar variante',
            subtitle: type?.name || 'Tamaño y combustible',
            body: `<div class="form-grid">
                <div class="field"><label>Tamaño</label><input id="vs-size" value="${h(v.size || '')}" placeholder="12 m"></div>
                <div class="field"><label>Combustible</label><input id="vs-fuel" value="${h(v.fuel || '')}" placeholder="Gasoil"></div>
                <div class="field full"><label>Descripción</label><textarea id="vs-description">${h(v.description || '')}</textarea></div>
                <div class="field"><label>Estado</label><select id="vs-active">
                    <option value="1" ${v.active !== false ? 'selected' : ''}>Activa</option>
                    <option value="0" ${v.active === false ? 'selected' : ''}>Inactiva</option>
                </select></div>
            </div>`,
            footer: `<span class="spacer"></span><button type="button" class="btn" data-cancel>Cancelar</button>
                <button type="button" class="btn btn-primary" data-save>Guardar</button>`,
            onMount: (card, close) => {
                card.querySelector('[data-save]').addEventListener('click', async () => {
                    const size = card.querySelector('#vs-size').value.trim();
                    const fuel = card.querySelector('#vs-fuel').value.trim();
                    if (!size && !fuel) { G.toast('Indica el tamaño o el combustible', 'bad'); return; }
                    try {
                        const res = await G.api('saveVehicleSubtype', {
                            subtype: {
                                id: isNew ? '' : v.id, typeId, size, fuel,
                                description: card.querySelector('#vs-description').value.trim(),
                                active: card.querySelector('#vs-active').value === '1',
                            },
                        });
                        S.db = res.db;
                        G.buildIndexes();
                        close();
                        G.render();
                        G.toast(isNew ? 'Variante añadida' : 'Variante actualizada');
                    } catch (err) { G.toast('No se pudo guardar: ' + err.message, 'bad'); }
                });
                card.querySelector('[data-cancel]').addEventListener('click', close);
            },
        });
        void modal;
    }

    function openVehicleModal(vehicle) {
        const isNew = !vehicle;
        const v = vehicle || { id: '', plate: '', typeId: '', model: '', kind: 'urbano', status: 'disponible', km: 0, since: '', notes: '', photo: '' };
        const types = S.db.vehicleTypes || [];
        const initialEntry = G.vehicleSubtype(v.typeId);
        const brands = [...new Set(types.map((t) => String(t.brand || '').trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'es'));
        const initialBrand = initialEntry?.type?.brand || '';
        const modelsForBrand = types.filter((t) => String(t.brand || '') === initialBrand);
        const initialType = initialEntry?.type?.id || modelsForBrand[0]?.id || '';
        const variantsForType = (types.find((t) => t.id === initialType)?.variants || []);

        const modal = G.openModal({
            title: isNew ? 'Nuevo vehículo' : `Bus ${v.id}`,
            subtitle: 'Elige el tipo del catálogo y añade una foto',
            body: `<div class="form-grid">
                <div class="field"><label>Número de bus <em>obligatorio</em></label><input id="veh-id" value="${h(v.id)}" inputmode="numeric"></div>
                <div class="field"><label>Matrícula</label><input id="veh-plate" value="${h(v.plate || '')}" placeholder="1234 ABC"></div>
                <div class="field"><label>Marca</label><select id="veh-brand"><option value="">Sin tipo de catálogo</option>${brands.map((b) => `<option value="${h(b)}" ${b === initialBrand ? 'selected' : ''}>${h(b)}</option>`).join('')}</select></div>
                <div class="field"><label>Modelo</label><select id="veh-model"><option value="">—</option>${modelsForBrand.map((t) => `<option value="${h(t.id)}" ${t.id === initialType ? 'selected' : ''}>${h(t.model || t.name)}</option>`).join('')}</select></div>
                <div class="field"><label>Tamaño y combustible</label><select id="veh-type"><option value="">General</option>${variantsForType.map((s) => `<option value="${h(s.id)}" ${s.id === v.typeId ? 'selected' : ''}>${h(s.label || [s.size, s.fuel].filter(Boolean).join(' · '))}</option>`).join('')}</select></div>
                <div class="field"><label>Tipo de vehículo</label><select id="veh-kind" ${initialEntry ? 'disabled' : ''}>
                    <option value="urbano" ${v.kind === 'urbano' || !v.kind ? 'selected' : ''}>Urbano</option>
                    <option value="articulado" ${v.kind === 'articulado' ? 'selected' : ''}>Articulado</option>
                    <option value="microbús" ${v.kind === 'microbús' ? 'selected' : ''}>Microbús</option>
                </select></div>
                <div class="field"><label>Estado</label><select id="veh-status">
                    <option value="disponible" ${v.status === 'disponible' ? 'selected' : ''}>Disponible</option>
                    <option value="taller" ${v.status === 'taller' ? 'selected' : ''}>En taller</option>
                    <option value="reserva" ${v.status === 'reserva' ? 'selected' : ''}>Reserva</option>
                </select></div>
                <div class="field"><label>Kilómetros</label><input id="veh-km" type="number" min="0" step="1" value="${Number(v.km) || 0}"></div>
                <div class="field"><label>Fecha de alta</label><input id="veh-since" type="date" value="${h(v.since || '')}"></div>
                <div class="field full"><label>Notas</label><textarea id="veh-notes">${h(v.notes || '')}</textarea></div>
                <div class="field full"><label>Foto del vehículo</label>
                    <div class="photo-picker">
                        <img id="veh-photo-preview" class="photo-preview" src="${h(v.photo || '')}" alt="Vista previa">
                        <input type="file" id="veh-photo-file" accept="image/jpeg,image/png,image/webp">
                        <button type="button" class="btn btn-sm" id="veh-photo-clear">Quitar foto</button>
                    </div>
                    <span class="field-hint">JPG, PNG o WebP. Se redimensiona antes de guardar.</span>
                </div>
            </div>`,
            footer: `<span class="spacer"></span><button type="button" class="btn" data-cancel>Cancelar</button>
                <button type="button" class="btn btn-primary" data-save>Guardar</button>`,
            onMount: (card, close) => {
                const brandSel = card.querySelector('#veh-brand');
                const modelSel = card.querySelector('#veh-model');
                const typeSel = card.querySelector('#veh-type');
                const kindSel = card.querySelector('#veh-kind');
                const preview = card.querySelector('#veh-photo-preview');
                const fileInput = card.querySelector('#veh-photo-file');
                let photo = v.photo || '';

                const fillModels = (brand, selectedId) => {
                    const list = types.filter((t) => String(t.brand || '') === brand);
                    modelSel.innerHTML = '<option value="">—</option>' + list.map((t) => `<option value="${h(t.id)}">${h(t.model || t.name)}</option>`).join('');
                    if (selectedId) modelSel.value = selectedId;
                    fillVariants(modelSel.value, '');
                };
                const fillVariants = (typeId, selectedId) => {
                    const list = (types.find((t) => t.id === typeId)?.variants || []);
                    typeSel.innerHTML = '<option value="">General</option>' + list.map((s) => `<option value="${h(s.id)}">${h(s.label || [s.size, s.fuel].filter(Boolean).join(' · '))}</option>`).join('');
                    if (selectedId) typeSel.value = selectedId;
                    updateKind();
                };
                brandSel.addEventListener('change', () => fillModels(brandSel.value, ''));
                modelSel.addEventListener('change', () => fillVariants(modelSel.value, ''));

                const updateKind = () => {
                    const entry = G.vehicleSubtype(typeSel.value);
                    kindSel.disabled = !!entry;
                };
                typeSel.addEventListener('change', updateKind);
                updateKind();

                const readImage = (file) => new Promise((resolve, reject) => {
                    const reader = new FileReader();
                    reader.onerror = () => reject(new Error('No se pudo leer la imagen'));
                    reader.onload = () => {
                        const img = new Image();
                        img.onerror = () => reject(new Error('Imagen no válida'));
                        img.onload = () => {
                            const max = 900;
                            const scale = Math.min(1, max / Math.max(img.width, img.height));
                            const canvas = document.createElement('canvas');
                            canvas.width = Math.max(1, Math.round(img.width * scale));
                            canvas.height = Math.max(1, Math.round(img.height * scale));
                            canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
                            resolve(canvas.toDataURL('image/jpeg', 0.82));
                        };
                        img.src = reader.result;
                    };
                    reader.readAsDataURL(file);
                });
                fileInput.addEventListener('change', async () => {
                    const file = fileInput.files?.[0];
                    if (!file) return;
                    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) { G.toast('Formato de imagen no admitido', 'bad'); return; }
                    try {
                        photo = await readImage(file);
                        preview.src = photo;
                    } catch (err) { G.toast(err.message, 'bad'); }
                });
                card.querySelector('#veh-photo-clear').addEventListener('click', () => {
                    photo = '';
                    fileInput.value = '';
                    preview.removeAttribute('src');
                });

                card.querySelector('[data-save]').addEventListener('click', async () => {
                    const id = card.querySelector('#veh-id').value.trim();
                    if (!id) { G.toast('El número de bus es obligatorio', 'bad'); return; }
                    try {
                        const res = await G.api('saveVehicle', {
                            vehicle: {
                                id, plate: card.querySelector('#veh-plate').value.trim(),
                                typeId: typeSel.value,
                                model: card.querySelector('#veh-model').selectedOptions[0]?.textContent || '',
                                kind: kindSel.value,
                                status: card.querySelector('#veh-status').value,
                                km: Number(card.querySelector('#veh-km').value) || 0,
                                since: card.querySelector('#veh-since').value,
                                notes: card.querySelector('#veh-notes').value.trim(),
                                photo,
                            },
                            originalId: isNew ? '' : v.id,
                        });
                        S.db = res.db;
                        G.buildIndexes();
                        close();
                        G.render();
                        G.toast(isNew ? 'Vehículo añadido' : 'Vehículo actualizado');
                    } catch (err) { G.toast('No se pudo guardar: ' + err.message, 'bad'); }
                });
                card.querySelector('[data-cancel]').addEventListener('click', close);
            },
        });
        void modal;
    }

    /* ======================================================================
       TURNOS
       ====================================================================== */

    function variantPill(kind, v) {
        if (!v) return `<span class="variant dim"><b>${kind.toUpperCase()}</b> —</span>`;
        return `<span class="variant" title="${h(v.lineLabel || v.line)} · bus ${h(v.vehicle || '—')}"><b>${kind.toUpperCase()}</b> ${v.start}–${v.end} <span style="color:var(--muted)">${fmtHours(v.hours)}</span></span>`;
    }

    const SHIFT_GROUPS = ['Líneas normales (L)', 'Circulares (C)', 'Periféricas (P)', 'Otros'];

    function renderTurnos() {
        // Tres bloques (L, C, P) y, dentro de cada uno, por número de turno.
        const shifts = G.visibleShifts().slice().sort((a, b) =>
            (G.lineRank(a.line) - G.lineRank(b.line)) || (Number(a.code) - Number(b.code)) || String(a.line).localeCompare(String(b.line)));
        const lines = S.db.lines.length;
        const totalHours = shifts.reduce((sum, s) => sum + (s.variants?.lv?.hours || 0), 0);
        let lastGroup = -1;
        const rows = shifts.map((s) => {
            const group = G.lineRank(s.line);
            const heading = group === lastGroup ? '' : `<tr class="group-row" data-group="${group}"><td colspan="7">${SHIFT_GROUPS[group] || SHIFT_GROUPS[3]}</td></tr>`;
            lastGroup = group;
            const search = norm(`${s.code} ${s.label} ${s.line} ${s.lineLabel} ${s.vehicle || ''} ${s.variants?.lv?.lineLabel || ''}`);
            return heading + `<tr class="row-click" data-shift="${s.code}" data-group="${group}" data-search="${h(search)}" data-line="${h(s.line)}">
                <td><span class="bus-number" style="min-width:44px;height:28px;font-size:11px">T${pad2(s.code)}</span></td>
                <td><span class="tag line"><i class="swatch" style="background:${G.lineColor(s.line)}"></i>${h(s.line)}</span><div class="person-meta" style="max-width:230px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${h(s.lineLabel || '')}">${h(s.lineLabel || '')}</div></td>
                <td><div class="variant-row">${variantPill('lv', s.variants?.lv)}</div></td>
                <td><div class="variant-row">${variantPill('sab', s.variants?.sab)}</div></td>
                <td><div class="variant-row">${variantPill('dom', s.variants?.dom)}</div></td>
                <td class="num">${s.vehicle ? h(s.vehicle) : '—'}</td>
                <td class="actions">
                    <button type="button" class="icon-btn" data-edit-shift="${s.code}" title="Editar">${icon('edit')}</button>
                    ${G.canEdit === false ? '' : `<button type="button" class="icon-btn" data-del-shift="${s.code}" title="Eliminar turno">${icon('trash')}</button>`}
                </td>
            </tr>`;
        }).join('');
        const lineOptions = ['<option value="all">Todas las líneas</option>']
            .concat([...S.db.lines].sort(G.compareLines).map((l) => `<option value="${h(l.code)}" ${S.shiftLine === l.code ? 'selected' : ''}>${h(l.code)} · ${h(l.name)}</option>`)).join('');
        const lineCards = [...S.db.lines]
            .sort(G.compareLines)
            .map((l) => `<div class="line-rule-row">
                <span class="tag line"><i class="swatch" style="background:${h(l.color || '#64748b')}"></i>${h(l.code)}</span>
                <div class="line-rule-main"><b>${h(l.name)}</b><span>${h(G.lineRestrictionLabel(l))}</span></div>
                <button type="button" class="icon-btn" data-edit-line="${h(l.code)}" title="Editar restricciones">${icon('edit')}</button>
                ${G.canEdit === false ? '' : `<button type="button" class="icon-btn" data-del-line="${h(l.code)}" title="Eliminar línea">${icon('trash')}</button>`}
            </div>`).join('');

        return `
        <div class="page-head">
            <div><h2>Catálogo de turnos</h2><p>Cada turno puede tener horario propio para laborable, sábado y domingo/festivo.</p></div>
            <div class="spacer"></div>
            ${excelButtons('shifts', 'turnos', 'Excel turnos')}
            <button type="button" class="btn btn-primary" data-new-shift>${icon('plus')} Añadir turno</button>
        </div>
        <div class="kpi-row">
            ${kpiCard('t-count', 'clock', fmtNum(shifts.length), 'Turnos', 'En el catálogo')}
            ${kpiCard('t-lines', 'grid', fmtNum(lines), 'Líneas', 'Con servicios definidos')}
            ${kpiCard('t-avg', 'chart', fmtHours(shifts.length ? totalHours / shifts.length : 0), 'Duración media', 'Jornada laborable')}
            ${kpiCard('t-veh', 'bus', fmtNum(new Set(shifts.map((s) => s.vehicle).filter(Boolean)).size), 'Buses distintos', 'Asignados a turnos')}
        </div>
        <section class="panel">
            <div class="panel-head">
                <div><h3>Restricciones por línea</h3><p>Combustibles permitidos o prohibidos y tamaños de bus admitidos</p></div>
                ${G.canEdit === false ? '' : '<div class="panel-actions"><button type="button" class="btn btn-sm" data-new-line>' + icon('plus') + ' Añadir línea</button></div>'}
            </div>
            <div class="line-rule-grid">${lineCards}</div>
        </section>
        <section class="panel">
            <div class="panel-head">
                <div><h3>Turnos y variantes</h3><p>Horarios, líneas y vehículo habitual</p></div>
                <div class="panel-actions">
                    <div class="search-box">${icon('search')}<input type="search" id="shift-search" placeholder="Buscar turno, línea o bus…"></div>
                    <select class="select" id="shift-line">${lineOptions}</select>
                </div>
            </div>
            <div class="table-wrap"><table class="data">
                <thead><tr><th>Turno</th><th>Línea / servicio</th><th>Laborables</th><th>Sábados</th><th>Domingos y festivos</th><th class="num">Bus</th><th></th></tr></thead>
                <tbody>${rows || `<tr><td colspan="7"><div class="empty">${icon('clock')}<b>Sin turnos</b></div></td></tr>`}</tbody>
            </table></div>
        </section>`;
    }

    function bindTurnos() {
        const view = $('#view');
        bindExcelButtons(view, 'shifts');
        const filter = () => {
            const q = norm(S.shiftSearch);
            $$('tr[data-shift]', view).forEach((tr) => {
                const okSearch = !q || tr.dataset.search.includes(q);
                const okLine = S.shiftLine === 'all' || tr.dataset.line === S.shiftLine;
                tr.hidden = !(okSearch && okLine);
            });
            $$('tr.group-row[data-group]', view).forEach((head) => {
                head.hidden = !$$(`tr[data-shift][data-group="${head.dataset.group}"]:not([hidden])`, view).length;
            });
        };
        view.querySelector('#shift-search')?.addEventListener('input', (e) => { S.shiftSearch = e.target.value; filter(); });
        view.querySelector('#shift-line')?.addEventListener('change', (e) => { S.shiftLine = e.target.value; filter(); });
        filter();
        view.onclick = async (e) => {
            if (e.target.closest('[data-new-shift]')) { openShiftModal(null); return; }
            if (e.target.closest('[data-new-line]')) { openLineModal(null); return; }
            const delLine = e.target.closest('[data-del-line]');
            if (delLine) { await deleteLine(delLine.dataset.delLine); return; }
            const editLine = e.target.closest('[data-edit-line]');
            if (editLine) { openLineModal(G.lineFor(editLine.dataset.editLine)); return; }
            const delShift = e.target.closest('[data-del-shift]');
            if (delShift) { await deleteShift(delShift.dataset.delShift); return; }
            const edit = e.target.closest('[data-edit-shift]');
            if (edit) { openShiftModal(G.shiftFor(edit.dataset.editShift)); return; }
            const row = e.target.closest('tr[data-shift]');
            if (row && !e.target.closest('button')) openShiftModal(G.shiftFor(row.dataset.shift));
        };
    }

    function lineOptions(selected) {
        return S.db.lines
            .slice().sort(G.compareLines)
            .map((l) => `<option value="${h(l.code)}" ${selected === l.code ? 'selected' : ''}>${h(l.code)} · ${h(l.name)}</option>`)
            .concat(`<option value="REF" ${selected === 'REF' ? 'selected' : ''}>REF · Refuerzos</option>`)
            .join('');
    }

    function openLineModal(line) {
        const isNew = !line;
        const l = line || { code: '', name: '', color: '#64748b', fuelMode: 'all', fuelValues: [], sizeMode: 'all', sizeValues: [], maxSize: 0 };
        const fuels = G.vehicleFuels();
        const sizes = G.vehicleSizes();
        const modal = G.openModal({
            title: isNew ? 'Nueva línea' : `Línea ${l.code}`,
            subtitle: isNew
                ? 'Código, nombre y restricciones de la nueva línea'
                : 'Restricciones de combustible y tamaño para el material de esta línea',
            body: `<div class="form-grid">
                <div class="field"><label>Código <em>L, C o P seguido de número</em></label><input id="line-code" value="${h(l.code)}" ${isNew ? 'placeholder="L20"' : 'disabled'} autocomplete="off"></div>
                <div class="field"><label>Nombre</label><input id="line-name" value="${h(l.name || '')}" ${isNew ? 'placeholder="Línea 20"' : ''}></div>
                <div class="field"><label>Color</label><input id="line-color" type="color" value="${h(l.color || '#64748b')}"></div>
                <div class="field full rule-block">
                    <label>Combustibles</label>
                    <select id="line-fuel-mode">
                        <option value="all" ${l.fuelMode === 'all' ? 'selected' : ''}>Todos los combustibles</option>
                        <option value="only" ${l.fuelMode === 'only' ? 'selected' : ''}>Solo los marcados</option>
                        <option value="deny" ${l.fuelMode === 'deny' ? 'selected' : ''}>Prohibir los marcados</option>
                    </select>
                    <div id="line-fuels" class="auth-fuels">
                        ${fuels.length ? fuels.map((f) => `<label class="auth-fuel"><input type="checkbox" data-line-fuel value="${h(f)}" ${(l.fuelValues || []).includes(f) ? 'checked' : ''}> ${h(f)}</label>`).join('') : '<span class="field-hint">No hay combustibles en el catálogo. Créalos en Flota.</span>'}
                    </div>
                    <p class="field-hint">«Solo» admite únicamente los marcados. «Prohibir» excluye solo esos combustibles y permite el resto.</p>
                </div>
                <div class="field full rule-block">
                    <label>Tamaño de bus</label>
                    <select id="line-size-mode">
                        <option value="all" ${l.sizeMode === 'all' ? 'selected' : ''}>Cualquier tamaño</option>
                        <option value="only" ${l.sizeMode === 'only' ? 'selected' : ''}>Solo los marcados</option>
                        <option value="max" ${l.sizeMode === 'max' ? 'selected' : ''}>Hasta un máximo</option>
                    </select>
                    <div id="line-sizes" class="auth-fuels">
                        ${sizes.length ? sizes.map((n) => `<label class="auth-fuel"><input type="checkbox" data-line-size value="${n}" ${(l.sizeValues || []).includes(n) ? 'checked' : ''}> ${n} m</label>`).join('') : '<span class="field-hint">No hay tamaños en el catálogo. Créalos en Flota.</span>'}
                    </div>
                    <div id="line-max-wrap" class="auth-size">
                        <label for="line-max-size">Tope</label>
                        <input id="line-max-size" type="number" min="0" max="100" step="1" value="${Number(l.maxSize) || 0}" list="line-size-options" placeholder="0">
                        <span class="field-hint">0 = sin tope · metros</span>
                        <datalist id="line-size-options">${sizes.map((n) => `<option value="${n}"></option>`).join('')}</datalist>
                    </div>
                </div>
            </div>`,
            footer: `<span class="spacer"></span><button type="button" class="btn" data-cancel>Cancelar</button>
                <button type="button" class="btn btn-primary" data-save>Guardar</button>`,
            onMount: (card, close) => {
                const fuelMode = card.querySelector('#line-fuel-mode');
                const sizeMode = card.querySelector('#line-size-mode');
                const fuelWrap = card.querySelector('#line-fuels');
                const sizeWrap = card.querySelector('#line-sizes');
                const maxWrap = card.querySelector('#line-max-wrap');
                const sync = () => {
                    fuelWrap.hidden = fuelMode.value === 'all';
                    sizeWrap.hidden = sizeMode.value !== 'only';
                    maxWrap.hidden = sizeMode.value !== 'max';
                };
                fuelMode.addEventListener('change', sync);
                sizeMode.addEventListener('change', sync);
                sync();
                card.querySelector('[data-save]').addEventListener('click', async () => {
                    try {
                        const code = isNew
                            ? String(card.querySelector('#line-code').value || '').trim().toUpperCase().replace(/\s+/g, '')
                            : l.code;
                        if (!/^[A-Z][A-Z0-9]*$/.test(code)) {
                            throw new Error('El código debe empezar por una letra (L, C o P) y solo contener letras y números.');
                        }
                        if (isNew && S.db.lines.some((x) => String(x.code).toUpperCase() === code)) {
                            throw new Error(`Ya existe la línea ${code}.`);
                        }
                        const res = await G.api('saveLine', {
                            code,
                            line: {
                                name: card.querySelector('#line-name').value.trim(),
                                color: card.querySelector('#line-color').value,
                                fuelMode: fuelMode.value,
                                fuelValues: $$('[data-line-fuel]:checked', card).map((el) => el.value),
                                sizeMode: sizeMode.value,
                                sizeValues: $$('[data-line-size]:checked', card).map((el) => Number(el.value)),
                                maxSize: Number(card.querySelector('#line-max-size').value) || 0,
                            },
                        });
                        S.db = res.db;
                        G.buildIndexes();
                        close();
                        G.render();
                        G.toast(`Línea ${code} ${isNew ? 'creada' : 'actualizada'}`);
                    } catch (err) { G.toast('No se pudo guardar: ' + err.message, 'bad'); }
                });
                card.querySelector('[data-cancel]').addEventListener('click', close);
            },
        });
        void modal;
    }

    async function deleteLine(code) {
        const line = G.lineFor(code);
        const ok = await G.confirmDialog(
            'Eliminar línea',
            `Se eliminará la línea <b>${h(code)}</b>${line?.name ? ` · ${h(line.name)}` : ''}. Los turnos que la usan deben cambiarse antes.`,
            { confirm: 'Eliminar', danger: true }
        );
        if (!ok) return;
        try {
            const res = await G.api('deleteLine', { code });
            S.db = res.db;
            G.buildIndexes();
            G.render();
            G.toast(`Línea ${code} eliminada`);
        } catch (err) { G.toast('No se pudo eliminar: ' + err.message, 'bad'); }
    }

    async function deleteShift(code, close) {
        const ok = await G.confirmDialog('Eliminar turno',
            `Se eliminará el turno <b>T${pad2(code)}</b> y todas sus asignaciones del cuadrante.`,
            { confirm: 'Eliminar', danger: true });
        if (!ok) return;
        try {
            const res = await G.api('deleteShift', { code });
            S.db = res.db;
            G.buildIndexes();
            S.cache = null;
            S.rev++;
            close?.();
            G.render();
            G.toast('Turno eliminado');
        } catch (err) { G.toast('No se pudo eliminar: ' + err.message, 'bad'); }
    }

    function variantBlock(kind, label, v) {
        const on = !!v;
        return `<fieldset class="variant-edit" data-kind="${kind}">
            <div class="variant-edit-head">
                <label class="switch"><input type="checkbox" data-en="${kind}" ${on ? 'checked' : ''}><i></i> ${label}</label>
                <span class="field-hint">Horario propio e vehículo</span>
            </div>
            <div class="form-grid vgrid">
                <div class="field"><label>Inicio</label><input type="time" data-start="${kind}" value="${on ? h(v.start) : ''}" ${on ? '' : 'disabled'}></div>
                <div class="field"><label>Fin</label><input type="time" data-end="${kind}" value="${on ? h(v.end) : ''}" ${on ? '' : 'disabled'}></div>
                <div class="field"><label>Línea</label><select data-line="${kind}" ${on ? '' : 'disabled'}>${lineOptions(v?.line || 'REF')}</select></div>
                <div class="field"><label>Bus</label><input data-vehicle="${kind}" list="veh-options" value="${on ? h(v.vehicle || '') : ''}" placeholder="Opcional" ${on ? '' : 'disabled'}></div>
            </div>
        </fieldset>`;
    }

    function openShiftModal(shift) {
        const isNew = !shift;
        const code = shift?.code || (Math.max(0, ...G.visibleShifts().map((s) => Number(s.code))) + 1);
        const s = shift || { code, label: `T${pad2(code)}`, line: 'L1', variants: {} };
        const modal = G.openModal({
            title: isNew ? `Nuevo turno T${pad2(code)}` : `Turno T${pad2(s.code)}`,
            subtitle: 'Define las variantes horarias que se usarán en el cuadrante',
            wide: true,
            body: `<div class="form-grid">
                <div class="field"><label>Código <em>obligatorio</em></label><input id="shift-code" type="number" min="1" max="999" value="${s.code}"></div>
                <div class="field"><label>Etiqueta</label><input id="shift-label" value="${h(s.label || '')}" placeholder="T${pad2(code)}"></div>
            </div>
            <div style="margin-top:14px;display:flex;flex-direction:column;gap:9px">
                ${variantBlock('lv', 'Laborables', s.variants?.lv)}
                ${variantBlock('sab', 'Sábados', s.variants?.sab)}
                ${variantBlock('dom', 'Domingos y festivos', s.variants?.dom)}
            </div>
            <datalist id="veh-options">${S.db.vehicles.map((v) => `<option value="${h(v.id)}">${h(v.model || '')}</option>`).join('')}</datalist>`,
            footer: `${isNew ? '' : `<button type="button" class="btn btn-danger btn-sm" data-delete>${icon('trash')} Eliminar</button>`}
                <span class="spacer"></span><button type="button" class="btn" data-cancel>Cancelar</button>
                <button type="button" class="btn btn-primary" data-save>Guardar</button>`,
            onMount: (card, close) => {
                $$('[data-en]', card).forEach((en) => {
                    en.addEventListener('change', () => {
                        const kind = en.dataset.en;
                        const fieldset = en.closest('.variant-edit');
                        $$('input, select', fieldset).forEach((input) => {
                            if (input !== en) input.disabled = !en.checked;
                        });
                    });
                });
                card.querySelector('[data-save]').addEventListener('click', async () => {
                    const newCode = Number(card.querySelector('#shift-code').value);
                    if (!newCode || newCode < 1) { G.toast('Código de turno no válido', 'bad'); return; }
                    const variants = {};
                    for (const kind of ['lv', 'sab', 'dom']) {
                        const en = card.querySelector(`[data-en="${kind}"]`);
                        if (!en.checked) continue;
                        const start = card.querySelector(`[data-start="${kind}"]`).value;
                        const end = card.querySelector(`[data-end="${kind}"]`).value;
                        if (!start || !end) { G.toast(`Completa el horario de ${KIND_LABEL[kind]}`, 'bad'); return; }
                        variants[kind] = {
                            start, end,
                            line: card.querySelector(`[data-line="${kind}"]`).value,
                            lineLabel: card.querySelector(`[data-line="${kind}"]`).selectedOptions[0]?.textContent || '',
                            vehicle: card.querySelector(`[data-vehicle="${kind}"]`).value.trim() || null,
                        };
                    }
                    try {
                        const res = await G.api('saveShift', {
                            shift: { code: newCode, label: card.querySelector('#shift-label').value.trim() || `T${pad2(newCode)}`, variants },
                            originalCode: isNew ? 0 : s.code,
                        });
                        S.db = res.db;
                        G.buildIndexes();
                        S.cache = null;
                        S.rev++;
                        close();
                        G.render();
                        G.toast(isNew ? 'Turno añadido' : 'Turno actualizado');
                    } catch (err) { G.toast('No se pudo guardar: ' + err.message, 'bad'); }
                });
                card.querySelector('[data-cancel]').addEventListener('click', close);
                card.querySelector('[data-delete]')?.addEventListener('click', () => deleteShift(s.code, close));
            },
        });
        void modal;
    }

    G.views.personal = renderPersonal;
    G.binders.personal = bindPersonal;
    G.views.flota = renderFlota;
    G.binders.flota = bindFlota;
    G.views.turnos = renderTurnos;
    G.binders.turnos = bindTurnos;
})();
