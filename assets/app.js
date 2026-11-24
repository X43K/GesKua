/* ==========================================================================
   Shell: cálculo del mes, navegación, arranque y exportación.
   ========================================================================== */
(() => {
    'use strict';

    const { S, $, $$, h, icon, fmtNum, fmt1, fmtPct, fmtHours, pad2, MONTHS, DAY_SHORT, STATUS, KIND_LABEL } = G;

    const TITLES = {
        cuadrante: ['Cuadrante mensual', 'Planifica los servicios de todo el mes'],
        personal: ['Personal', 'Plantilla, disponibilidad y ausencias'],
        flota: ['Flota', 'Vehículos, estado y servicios del día'],
        turnos: ['Turnos y servicios', 'Catálogo de turnos por tipo de día'],
        usuarios: ['Usuarios', 'Cuentas, roles y permisos de la aplicación'],
        resumen: ['Resumen del mes', 'Cobertura, horas e incidencias'],
        ajustes: ['Ajustes', 'Parámetros, festivos y datos'],
    };

    const canView = (view) => !!TITLES[view] && (view !== 'usuarios' || !!G.canUnlockUsers);
    G.canView = canView;

    /* ======================================================================
       Cálculo del mes
       ====================================================================== */

    function computeMonth() {
        const cacheKey = `${S.month}|${S.rev}`;
        if (S.cache && S.cache.key === cacheKey) return S.cache.value;

        const db = S.db;
        const days = G.monthDays(S.month);
        const roster = G.rosterDrivers(db.drivers);
        const archived = G.archivedDriversForMonth(S.month).filter((d) => !roster.includes(d));
        const drivers = [...roster, ...archived];
        const maxCons = G.maxConsecutive();
        const excDays = G.exceptionDays();
        const excHours = Math.round(G.exceptionRestMin() / 60);
        const driverStats = new Map();
        const coverage = new Map();
        const alerts = [];
        const invalidGroups = new Map();
        const totals = {
            assigned: 0, need: 0, invalid: 0, hours: 0, virtualDays: 0,
            status: { D: 0, VA: 0, BA: 0, AP: 0, PI: 0, PC: 0, PF: 0, HS: 0, HR: 0, X: 0, '': 0 },
            activeDrivers: roster.length,
            fullDays: 0, high: 0, medium: 0, low: 0,
        };

        for (const date of days) {
            const kind = G.dayKind(date);
            coverage.set(date, {
                date, kind, need: G.needFor(kind), assigned: 0, invalid: 0,
                missing: 0, extra: 0, ratio: 1, codes: new Map(),
            });
        }

        for (const driver of drivers) {
            const id = String(driver.id);
            const st = {
                id, work: 0, hours: 0, virtual: 0, rest: 0, vac: 0, sick: 0, personal: 0, permission: 0, union: 0, record: 0, empty: 0,
                maxConsec: 0, restFlags: 0, consFlags: 0, invalid: 0, absences: 0,
            };
            let consec = 0;
            let prevWork = null;
            // La racha y el último turno vienen de los últimos días del mes anterior.
            let cursor = days.length ? G.addDays(days[0], -1) : '';
            let seedGuard = 0;
            while (cursor && seedGuard++ < 20 && G.isWorkCode(G.getValAt(id, cursor))) {
                consec++;
                if (!prevWork) {
                    const variant = G.variantFor(G.getValAt(id, cursor), G.dayKind(cursor));
                    if (variant) prevWork = { date: cursor, variant };
                }
                cursor = G.addDays(cursor, -1);
            }

            for (const date of days) {
                const value = G.getValAt(id, date);
                const kind = G.dayKind(date);
                const cov = coverage.get(date);
                if (!value) {
                    st.empty++;
                    totals.status['']++;
                    consec = 0;
                    prevWork = null;
                    continue;
                }
                // Jornada virtual X: cuenta para rachas, pero no cubre turno
                // ni tiene horario, por lo que no interviene en los descansos.
                if (value === 'X') {
                    st.work++;
                    st.virtual++;
                    consec++;
                    if (consec > st.maxConsec) st.maxConsec = consec;
                    totals.status.X++;
                    totals.virtualDays++;
                    prevWork = null;
                    continue;
                }

                if (!G.isCode(value)) {
                    const key = ['D', ...G.STATUS_ABSENCE].includes(value) ? value : 'D';
                    if (key === 'D') st.rest++;
                    else if (key === 'VA') st.vac++;
                    else if (key === 'BA') st.sick++;
                    else if (key === 'AP') st.personal++;
                    else if (key === 'HS') st.union++;
                    else if (key === 'HR') st.record++;
                    else st.permission++;
                    totals.status[key] = (totals.status[key] || 0) + 1;
                    consec = 0;
                    prevWork = null;
                    continue;
                }

                // Turno de trabajo
                st.work++;
                consec++;
                if (consec > st.maxConsec) st.maxConsec = consec;
                cov.assigned++;
                totals.assigned++;
                const variant = G.variantFor(value, kind);
                if (!variant) {
                    st.invalid++;
                    cov.invalid++;
                    totals.invalid++;
                    const gkey = `${date}|${value}`;
                    const group = invalidGroups.get(gkey) || { date, code: value, drivers: [], kind };
                    group.drivers.push(id);
                    invalidGroups.set(gkey, group);
                } else {
                    st.hours += Number(variant.hours) || 0;
                    totals.hours += Number(variant.hours) || 0;
                    const arr = cov.codes.get(String(value)) || [];
                    arr.push(id);
                    cov.codes.set(String(value), arr);
                }

                const absence = G.absenceFor(id, date);
                if (absence) {
                    st.absences++;
                    alerts.push({
                        type: 'absence', sev: 'high', date, driverId: id, code: value,
                        title: `${G.prettyName(driver.name)} tiene turno durante ${STATUS[absence.type]?.label?.toLowerCase() || 'una ausencia'}`,
                        sub: `${G.prettyDate(date)} · T${pad2(value)}`,
                    });
                }

                if (prevWork && G.addDays(prevWork.date, 1) === date && prevWork.variant && variant) {
                    const rest = (1440 - prevWork.variant.endMin) + variant.startMin;
                    const restState = G.restCheck(id, date, value);
                    if (!restState.ok) {
                        st.restFlags++;
                        alerts.push({
                            type: 'rest', sev: 'medium', date, driverId: id, code: value,
                            title: `${G.prettyName(driver.name)}: ${restState.reason}`,
                            sub: `${G.prettyDate(date)} · ${G.fmtHours(rest / 60)} entre turnos`,
                        });
                    } else if (restState.kind === 'reduced') {
                        alerts.push({
                            type: 'rest', sev: 'low', date, driverId: id, code: value,
                            title: `${G.prettyName(driver.name)} usa un descanso reducido permitido`,
                            sub: `${G.prettyDate(date)} · ${G.fmtHours(rest / 60)} entre turnos (mínimo ${G.fmtHours(G.reducedRestMinMin() / 60)})`,
                        });
                    }
                }
                if (consec > maxCons && !G.consecutiveCheck(id, date, value).ok) {
                    st.consFlags++;
                    alerts.push({
                        type: 'consecutive', sev: 'medium', date, driverId: id, code: value,
                        title: `${G.prettyName(driver.name)} lleva ${consec} días seguidos`,
                        sub: excDays <= maxCons
                            ? `Máximo ${maxCons} · ${G.prettyDate(date)}`
                            : consec >= excDays
                                ? `Sin descanso de ${excHours} h · ${G.prettyDate(date)}`
                                : `Máximo ${maxCons}, salvo ${excDays} con ${excHours} h propias · ${G.prettyDate(date)}`,
                    });
                }
                prevWork = { date, variant };
            }

            driverStats.set(id, st);
        }

        for (const [date, cov] of coverage) {
            cov.missing = Math.max(0, cov.need - cov.assigned);
            cov.extra = Math.max(0, cov.assigned - cov.need);
            cov.ratio = cov.need ? cov.assigned / cov.need : 1;
            totals.need += cov.need;
            if (cov.missing === 0) totals.fullDays++;
            if (cov.missing > 0) {
                alerts.push({
                    type: 'coverage', sev: 'high', date,
                    title: `Faltan ${G.plural(cov.missing, 'turno', 'turnos')} el ${G.prettyDate(date)}`,
                    sub: `Cobertura ${cov.assigned}/${cov.need} · ${KIND_LABEL[cov.kind]}`,
                });
            } else if (cov.extra > 0) {
                alerts.push({
                    type: 'extra', sev: 'low', date,
                    title: `${G.plural(cov.extra, 'turno', 'turnos')} por encima de la necesidad`,
                    sub: `${G.prettyDate(date)} · ${cov.assigned}/${cov.need} · ${KIND_LABEL[cov.kind]}`,
                });
            }
            for (const [code, list] of cov.codes) {
                if (list.length > 1) {
                    const shift = G.shiftFor(code);
                    const variant = G.variantFor(code, cov.kind);
                    alerts.push({
                        type: 'duplicate', sev: 'high', date, code,
                        title: `T${pad2(code)} asignado a ${list.length} conductores`,
                        sub: `${G.prettyDate(date)} · ${variant ? `${variant.start}–${variant.end}` : (shift?.lineLabel || '')}`,
                    });
                }
            }
        }

        for (const group of invalidGroups.values()) {
            const shift = G.shiftFor(group.code);
            alerts.push({
                type: 'invalid', sev: 'medium', date: group.date, code: group.code,
                driverId: group.drivers.length === 1 ? group.drivers[0] : undefined,
                title: `Turno T${pad2(group.code)} no válido en ${KIND_LABEL[group.kind]}`,
                sub: `${G.prettyDate(group.date)} · ${group.drivers.length === 1 ? G.prettyName(G.driverById(group.drivers[0])?.name) : G.plural(group.drivers.length, 'conductor afectado', 'conductores afectados')}${shift?.line ? ' · ' + shift.line : ''}`,
            });
        }

        for (const st of driverStats.values()) {
            if (st.consFlags > 0) {
                alerts.push({
                    type: 'consecutive', sev: 'medium', driverId: st.id,
                    title: `${G.prettyName(G.driverById(st.id)?.name)} supera ${maxCons} días seguidos`,
                    sub: `${G.plural(st.consFlags, 'vez', 'veces')} en el mes · máximo ${st.maxConsec} días`,
                });
            }
        }

        alerts.sort((a, b) => {
            const sa = { high: 0, medium: 1, low: 2 }[a.sev] ?? 3;
            const sb = { high: 0, medium: 1, low: 2 }[b.sev] ?? 3;
            if (sa !== sb) return sa - sb;
            if ((a.date || '') !== (b.date || '')) return String(a.date || '').localeCompare(String(b.date || ''));
            return a.title.localeCompare(b.title);
        });

        for (const a of alerts) totals[a.sev] = (totals[a.sev] || 0) + 1;
        totals.coverage = totals.need ? totals.assigned / totals.need : 0;
        totals.alerts = alerts.length;

        S.lastAlerts = alerts;
        const value = { days, driverStats, coverage, alerts, totals };
        S.cache = { key: cacheKey, value };
        return value;
    }
    G.computeMonth = computeMonth;

    /* ======================================================================
       Navegación y armazón
       ====================================================================== */

    function updateChrome() {
        $$('#nav .nav-item').forEach((b) => b.classList.toggle('active', b.dataset.view === S.view));
        $('#nav-drivers').textContent = G.visibleDrivers().length;
        $('#nav-vehicles').textContent = G.visibleVehicles().length;
        $('#nav-shifts').textContent = G.visibleShifts().length;

        const picker = $('#month-picker');
        if (picker && picker.value !== S.month) picker.value = S.month;

        const stats = computeMonth();
        const [title] = TITLES[S.view] || TITLES.cuadrante;
        $('#page-title').textContent = title;
        const absences = (G.S.db.absences || []).filter((a) => a.from.slice(0, 7) <= S.month && a.to.slice(0, 7) >= S.month);
        const disponibles = G.S.db.vehicles.filter((v) => v.status === 'disponible').length;
        const subtitles = {
            cuadrante: `${G.monthLabel(S.month)} · ${stats.totals.assigned}/${stats.totals.need} servicios · ${stats.totals.activeDrivers} conductores`,
            personal: `${G.visibleDrivers().length} conductores · ${absences.length} ausencias este mes`,
            flota: `${G.visibleVehicles().length} vehículos · ${disponibles} disponibles`,
            turnos: `${G.visibleShifts().length} turnos · ${G.S.db.lines.length} líneas`,
            usuarios: 'Cuentas con acceso y roles',
            resumen: `${G.monthLabel(S.month)} · ${fmtPct(stats.totals.coverage * 100)} de cobertura`,
            ajustes: 'Parámetros del cuadrante, festivos y datos',
        };
        $('#page-subtitle').textContent = subtitles[S.view] || '';
    }
    G.updateChrome = updateChrome;

    function render() {
        G.updatePermissions?.();
        updateChrome();
        const view = G.views[S.view] || G.views.cuadrante;
        const container = $('#view');
        container.innerHTML = view();
        const binder = G.binders[S.view];
        if (binder) binder();
        G.setSaveState(S.pending.size ? 'pending' : (S.retryTimer ? 'error' : 'saved'));
        syncHash();
        if (S.scrollToday) {
            S.scrollToday = false;
            setTimeout(() => {
                const head = document.querySelector('.day-head.today');
                if (head) head.scrollIntoView({ inline: 'center', block: 'nearest', behavior: 'smooth' });
            }, 80);
        }
    }
    G.render = render;

    function syncHash() {
        const hash = `#${S.view}/${S.month}`;
        if (location.hash !== hash) history.replaceState(null, '', hash);
    }

    function parseHash() {
        const m = /^#([a-z]+)\/(\d{4}-\d{2})$/.exec(location.hash || '');
        if (m && canView(m[1])) return { view: m[1], month: m[2] };
        return null;
    }
    G.parseHash = parseHash;

    function closeOverlays() {
        document.getElementById('modal-root').innerHTML = '';
        document.getElementById('drawer-root').innerHTML = '';
    }

    function setView(view) {
        if (!canView(view) || view === S.view) return;
        closeOverlays();
        S.view = view;
        S.paint = null;
        S.search = '';
        render();
        $('#view').scrollTop = 0;
    }
    G.setView = setView;

    function setMonth(month) {
        if (!G.validMonth(month) || month === S.month) return;
        G.flushPending();
        S.month = month;
        S.cache = null;
        S.paint = null;
        S.scrollToday = month === G.currentMonth();
        render();
        G.saveCurrentMonth();
    }
    G.setMonth = setMonth;

    async function sendPendingBeacon() {
        if (!S.pending.size) return;
        const groups = new Map();
        for (const [key, value] of S.pending) {
            const [month, driverId, date] = key.split('|');
            if (!groups.has(month)) groups.set(month, []);
            groups.get(month).push({ driverId, date, value });
        }
        for (const [month, changes] of groups) {
            const blob = new Blob([JSON.stringify({ action: 'saveAssignments', month, changes })], { type: 'application/json' });
            navigator.sendBeacon('api.php', blob);
        }
    }

    function undoLast() {
        const item = S.undo.pop();
        if (!item) return;
        const changedMonth = item.month !== S.month;
        if (changedMonth) {
            S.month = item.month;
            S.cache = null;
            $('#month-picker').value = item.month;
        }
        G.setValue(item.driverId, item.date, item.prev, { undo: false, validate: false });
        if (changedMonth) render();
        G.toast('Cambio deshecho');
    }
    G.undoLast = undoLast;

    /* ======================================================================
       Exportación
       ====================================================================== */

    function exportCsv() {
        const stats = computeMonth();
        const header = ['Conductor', 'IDC', ...stats.days.map((d) => `${d.slice(8)} ${G.weekdayShort(d)}`), 'Turnos', 'Horas'];
        const rows = [header];
        const drivers = G.rosterDrivers().sort((a, b) => G.prettyName(a.name).localeCompare(G.prettyName(b.name), 'es'));
        for (const d of drivers) {
            const st = stats.driverStats.get(String(d.id)) || {};
            const cells = stats.days.map((date) => {
                const value = G.getValAt(d.id, date) || '';
                return STATUS[value]?.short || value;
            });
            rows.push([d.name, d.id, ...cells, st.work || 0, Math.round((st.hours || 0) * 100) / 100]);
        }
        const summary = ['TOTAL', '', ...stats.days.map((date) => stats.coverage.get(date).assigned), stats.totals.assigned, Math.round(stats.totals.hours * 100) / 100];
        rows.push(summary);
        const csv = '\uFEFF' + rows.map((r) => r.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(';')).join('\r\n');
        const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `cuadrante-${S.month}.csv`;
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 2000);
        G.toast('Cuadrante exportado a CSV');
    }
    G.exportCsv = exportCsv;

    function exportCuadranteExcel() {
        const stats = computeMonth();
        // Primera fila: tipo de día; segunda: solo el número de día.
        const dayTypeCode = (date) => {
            if (G.holidayFor(date)) return 'FE';
            return ['DO', 'LU', 'MA', 'MI', 'JU', 'VI', 'SA'][G.weekdayIndex(date)] || '';
        };
        const types = ['', '', ...stats.days.map(dayTypeCode), '', '', ''];
        const header = ['Conductor', 'IDC', ...stats.days.map((d) => d.slice(8)), 'Horas', 'Libres', 'Turnos'];
        const rows = [types, header];
        const drivers = G.rosterDrivers().sort((a, b) => G.prettyName(a.name).localeCompare(G.prettyName(b.name), 'es'));
        let totalFree = 0;
        for (const d of drivers) {
            const st = stats.driverStats.get(String(d.id)) || {};
            const values = stats.days.map((date) => G.getValAt(d.id, date) || '');
            const free = values.filter((v) => v === 'D').length;
            totalFree += free;
            const cells = values.map((v) => STATUS[v]?.short || v);
            rows.push([d.name, d.id, ...cells, Math.round((st.hours || 0) * 100) / 100, free, st.work || 0]);
        }
        rows.push(['TOTAL', '', ...stats.days.map((date) => stats.coverage.get(date).assigned), Math.round(stats.totals.hours * 100) / 100, totalFree, stats.totals.assigned]);
        const ws = XLSX.utils.aoa_to_sheet(rows);
        Object.keys(ws).forEach((addr) => {
            if (addr.startsWith('!')) return;
            const cell = ws[addr];
            if (cell && 'v' in cell) { cell.t = 's'; cell.v = String(cell.v ?? ''); }
        });
        ws['!cols'] = [{ wch: 26 }, { wch: 10 }, ...stats.days.map(() => ({ wch: 7 })), { wch: 9 }, { wch: 9 }, { wch: 9 }];
        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, ws, 'Cuadrante');
        const out = XLSX.write(wb, { bookType: 'xls', type: 'array' });
        downloadBlob(new Blob([out], { type: 'application/vnd.ms-excel' }), `cuadrante-${S.month}.xls`);
        G.toast('Cuadrante exportado a Excel');
    }
    G.exportCuadranteExcel = exportCuadranteExcel;

    /* ======================================================================
       CSV de personal, flota y turnos
       ====================================================================== */

    const CSV_SCHEMAS = {
        drivers: [
            ['id', 'IDC'], ['name', 'Nombre'], ['firstName', 'Nombre propio'], ['lastName', 'Apellidos'],
            ['role', 'Rol'], ['active', 'Activo'], ['phone', 'Telefono'], ['license', 'Carnet'],
            ['since', 'Antiguedad'], ['notes', 'Notas'], ['authorizedFuels', 'Combustibles'],
            ['maxVehicleSize', 'Tope_metros'], ['allowsArticulated', 'Articulados'], ['group', 'Grupo'],
            ['partnerId', 'Companero'],
        ],
        vehicles: [
            ['id', 'Bus'], ['plate', 'Matricula'], ['model', 'Modelo'], ['kind', 'Tipo'],
            ['typeId', 'Id_variante'], ['status', 'Estado'], ['km', 'Km'], ['since', 'Antiguedad'],
            ['notes', 'Notas'],
        ],
        shifts: [
            ['code', 'Codigo'], ['label', 'Turno'], ['line', 'Linea'], ['lineLabel', 'Servicio'], ['vehicle', 'Bus'],
            ...['lv', 'sab', 'dom'].flatMap((k) => [
                [k + '_start', k.toUpperCase() + '_inicio'],
                [k + '_end', k.toUpperCase() + '_fin'],
                [k + '_line', k.toUpperCase() + '_linea'],
                [k + '_lineLabel', k.toUpperCase() + '_servicio'],
                [k + '_vehicle', k.toUpperCase() + '_bus'],
            ]),
        ],
    };

    const CSV_LABELS = { drivers: 'fichas de personal', vehicles: 'vehículos', shifts: 'turnos' };
    const CSV_FILES = { drivers: 'personal', vehicles: 'flota', shifts: 'turnos' };
    const normHeader = (s) => String(s || '').toLowerCase().normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');

    function parseCsvText(text) {
        const raw = String(text || '').replace(/^\uFEFF/, '');
        const first = raw.split(/\r?\n/, 1)[0] || '';
        const delimiter = (first.match(/;/g) || []).length >= (first.match(/,/g) || []).length ? ';' : ',';
        const rows = [];
        let row = [], field = '', quoted = false;
        for (let i = 0; i < raw.length; i++) {
            const c = raw[i];
            if (quoted) {
                if (c === '"') {
                    if (raw[i + 1] === '"') { field += '"'; i++; }
                    else quoted = false;
                } else {
                    field += c;
                }
                continue;
            }
            if (c === '"') quoted = true;
            else if (c === delimiter) { row.push(field); field = ''; }
            else if (c === '\n') { row.push(field.replace(/\r$/, '')); rows.push(row); row = []; field = ''; }
            else field += c;
        }
        if (field !== '' || row.length) { row.push(field.replace(/\r$/, '')); rows.push(row); }
        return rows.filter((r) => r.some((v) => String(v).trim() !== ''));
    }

    const XLS_MAGIC = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
    function isExcelBuffer(bytes) {
        if (bytes.length >= 8 && XLS_MAGIC.every((b, i) => bytes[i] === b)) return true;
        return bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
    }

    function matrixToRows(matrix, schema) {
        if (matrix.length < 2) return [];
        const headers = matrix[0].map(normHeader);
        const indexes = schema.map(([, header]) => headers.indexOf(normHeader(header)));
        return matrix.slice(1).map((cells) => {
            const obj = {};
            schema.forEach(([key], i) => {
                if (indexes[i] >= 0) obj[key] = String(cells[indexes[i]] ?? '').trim();
            });
            return obj;
        });
    }

    function csvToRows(text, schema) {
        return matrixToRows(parseCsvText(text), schema);
    }

    function excelMatrix(buffer) {
        const wb = XLSX.read(buffer, { type: 'array', cellDates: false });
        const sheet = wb.Sheets[wb.SheetNames[0]];
        return sheet ? XLSX.utils.sheet_to_json(sheet, { header: 1, raw: false, defval: '' }) : [];
    }

    function excelToRows(buffer, schema) {
        const matrix = excelMatrix(buffer);
        return matrix.length ? matrixToRows(matrix, schema) : [];
    }

    const csvValue = (v) => {
        const value = Array.isArray(v) ? v.join('|') : (typeof v === 'boolean' ? (v ? '1' : '0') : (v ?? ''));
        return '"' + String(value).replace(/"/g, '""') + '"';
    };

    function entityRows(kind) {
        if (kind === 'drivers') {
            return G.visibleDrivers().sort((a, b) => G.prettyName(a.name).localeCompare(G.prettyName(b.name), 'es')).map((d) => ({
                id: d.id, name: d.name, firstName: d.firstName || '', lastName: d.lastName || '',
                role: d.role || 'Conductor', active: d.active, phone: d.phone || '', license: d.license || '',
                since: d.since || '', notes: d.notes || '', authorizedFuels: d.authorizedFuels || [],
                maxVehicleSize: d.maxVehicleSize || 0, allowsArticulated: !!d.allowsArticulated,
                group: d.group || '', partnerId: d.partnerId || '',
            }));
        }
        if (kind === 'vehicles') {
            return G.visibleVehicles().sort((a, b) => String(a.id).localeCompare(String(b.id), 'es', { numeric: true })).map((v) => ({
                id: v.id, plate: v.plate || '', model: v.model || '', kind: v.kind || 'urbano',
                typeId: v.typeId || '', status: v.status || 'disponible', km: v.km || 0,
                since: v.since || '', notes: v.notes || '',
            }));
        }
        return G.visibleShifts().sort((a, b) => String(a.line).localeCompare(String(b.line), 'es', { numeric: true }) || a.code - b.code).map((s) => {
            const out = { code: s.code, label: s.label || '', line: s.line || '', lineLabel: s.lineLabel || '', vehicle: s.vehicle || '' };
            for (const k of ['lv', 'sab', 'dom']) {
                const v = s.variants?.[k] || {};
                out[k + '_start'] = v.start || '';
                out[k + '_end'] = v.end || '';
                out[k + '_line'] = v.line || s.line || '';
                out[k + '_lineLabel'] = v.lineLabel || s.lineLabel || '';
                out[k + '_vehicle'] = v.vehicle || s.vehicle || '';
            }
            return out;
        });
    }

    const SHEET_NAMES = { drivers: 'Personal', vehicles: 'Flota', shifts: 'Turnos' };

    function downloadBlob(blob, filename) {
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = filename;
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    }

    const excelValue = (v) => Array.isArray(v) ? v.join('|')
        : (typeof v === 'boolean' ? (v ? '1' : '0') : String(v ?? ''));

    function exportEntityExcel(kind) {
        const schema = CSV_SCHEMAS[kind];
        if (!schema) return;
        if (typeof XLSX === 'undefined') {
            G.toast('No se pudo preparar el Excel', 'bad');
            return;
        }
        const aoa = [schema.map(([, header]) => header)];
        for (const row of entityRows(kind)) aoa.push(schema.map(([key]) => excelValue(row[key])));
        const ws = XLSX.utils.aoa_to_sheet(aoa);
        Object.keys(ws).forEach((addr) => {
            if (addr.startsWith('!')) return;
            const cell = ws[addr];
            if (cell && 'v' in cell) { cell.t = 's'; cell.v = String(cell.v ?? ''); }
        });
        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, ws, SHEET_NAMES[kind] || CSV_FILES[kind]);
        const out = XLSX.write(wb, { bookType: 'xls', type: 'array' });
        downloadBlob(new Blob([out], { type: 'application/vnd.ms-excel' }), `${CSV_FILES[kind]}-${G.todayISO()}.xls`);
        G.toast(`Excel de ${CSV_LABELS[kind]} descargado`);
    }

    function exportEntityCsv(kind) {
        const schema = CSV_SCHEMAS[kind];
        if (!schema) return;
        const lines = [schema.map(([, header]) => csvValue(header)).join(';')];
        for (const row of entityRows(kind)) {
            lines.push(schema.map(([key]) => csvValue(row[key])).join(';'));
        }
        downloadBlob(new Blob(['\uFEFF' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' }), `${CSV_FILES[kind]}-${G.todayISO()}.csv`);
        G.toast(`CSV de ${CSV_LABELS[kind]} descargado`);
    }

    async function importEntity(kind, file) {
        if (G.canEdit === false) return;
        const schema = CSV_SCHEMAS[kind];
        if (!schema || !file) return;
        let rows, isExcel = false;
        try {
            const buf = await file.arrayBuffer();
            isExcel = isExcelBuffer(new Uint8Array(buf.slice(0, 8))) || /\.(xlsx?|xlsm)$/i.test(file.name || '');
            rows = isExcel ? excelToRows(buf, schema) : csvToRows(new TextDecoder('utf-8').decode(buf), schema);
        } catch (e) {
            G.toast('No se pudo leer el archivo. Sube un Excel real (.xls/.xlsx) o un CSV.', 'bad');
            return;
        }
        if (!rows.length) {
            G.toast('El archivo está vacío o no tiene filas de datos', 'bad');
            return;
        }
        const label = CSV_LABELS[kind];
        const ok = await G.confirmDialog(isExcel ? 'Importar Excel' : 'Importar CSV', `Se actualizarán <b>${rows.length}</b> ${label}. La columna <b>Activo</b> manda: <b>0</b> deja inactivo y <b>1</b> reactiva. Lo que no aparezca pasa a inactivo y se archiva solo tras 40 días fuera del Excel; si reaparece recupera el estado que tenía antes de desaparecer (o el que indique la columna Activo).`, { confirm: 'Importar', danger: true });
        if (!ok) return;
        try {
            const res = await G.api('importCsv', { kind, rows });
            S.db = res.db;
            G.buildIndexes();
            S.rev++;
            S.cache = null;
            G.render();
            const r = res.result || {};
            const unchanged = (r.updated || 0) > (r.changed || 0) ? ` · ${(r.updated || 0) - (r.changed || 0)} sin cambios` : '';
            G.toast(`${label}: ${r.changed || 0} cambiados · ${r.created || 0} nuevos · ${r.reactivated || 0} reactivados · ${r.deactivated || 0} inactivos · ${r.archived || 0} archivados${unchanged}`);
        } catch (err) {
            G.toast('No se pudo importar: ' + err.message, 'bad');
        }
    }
    const nameKey = (value) => String(value || '').toLocaleLowerCase('es').normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, ' ').trim();

    /** Importa el cuadrante exportado por esta app, o uno creado a mano en Excel. */
    async function importSchedule(file) {
        if (G.canImportSchedule === false) {
            G.toast('Solo los administradores pueden importar el cuadrante.', 'bad');
            return;
        }
        if (!file || typeof XLSX === 'undefined') {
            G.toast('Selecciona un Excel válido', 'bad');
            return;
        }
        let matrix;
        try {
            const buf = await file.arrayBuffer();
            const isExcel = isExcelBuffer(new Uint8Array(buf.slice(0, 8))) || /\.(xlsx?|xlsm)$/i.test(file.name || '');
            matrix = isExcel ? excelMatrix(buf) : parseCsvText(new TextDecoder('utf-8').decode(buf));
        } catch (e) {
            G.toast('No se pudo leer el archivo. Sube un Excel real (.xls/.xlsx) o un CSV.', 'bad');
            return;
        }
        const headerIdx = matrix.findIndex((row) => Array.isArray(row) && normHeader(row[1]) === 'idc');
        if (headerIdx < 0) {
            G.toast('No encontré la cabecera del cuadrante (columna IDC).', 'bad');
            return;
        }
        const headers = matrix[headerIdx] || [];
        const tailStart = headers.findIndex((v, i) => i >= 2
            && ['horas', 'libres', 'turnos'].includes(normHeader(v)));
        const lastDayIndex = tailStart >= 0 ? tailStart - 1 : headers.length - 4;
        const days = new Set(G.monthDays(S.month));
        const dayColumns = [];
        for (let i = 2; i <= lastDayIndex; i++) {
            const day = Number(String(headers[i] ?? '').trim());
            if (Number.isInteger(day) && day >= 1 && day <= 31) {
                const date = `${S.month}-${pad2(day)}`;
                if (days.has(date)) dayColumns.push({ index: i, date });
            }
        }
        if (!dayColumns.length) {
            G.toast('No encontré columnas de días válidas para este mes.', 'bad');
            return;
        }

        const drivers = G.S.db.drivers || [];
        const byId = new Map(drivers.map((d) => [String(d.id), String(d.id)]));
        const byName = new Map();
        for (const d of drivers) {
            const key = nameKey(G.prettyName(d.name));
            if (key && !byName.has(key)) byName.set(key, String(d.id));
        }
        const changes = [];
        let skippedRows = 0;
        let skippedValues = 0;
        for (let r = headerIdx + 1; r < matrix.length; r++) {
            const cells = matrix[r] || [];
            const name = String(cells[0] ?? '').trim();
            let driverId = String(cells[1] ?? '').trim();
            if (nameKey(name) === 'total' || driverId.toLowerCase() === 'total') continue;
            if (!driverId && name) driverId = byName.get(nameKey(name)) || '';
            if (!byId.has(driverId)) {
                if (name || driverId) skippedRows++;
                continue;
            }
            for (const { index, date } of dayColumns) {
                let value = String(cells[index] ?? '').trim().toUpperCase();
                if (/^0*\d+$/.test(value)) value = String(Number(value));
                else value = G.normaliseStatusValue(value);
                const valid = value === '' || /^\d+$/.test(value)
                    || !!G.STATUS[value] || (G.STATUS_ABSENCE || []).includes(value);
                if (!valid) {
                    skippedValues++;
                    continue;
                }
                changes.push({ driverId, date, value });
            }
        }
        if (!changes.length) {
            G.toast('El Excel no contiene celdas del cuadrante que se puedan importar.', 'bad');
            return;
        }
        const ok = await G.confirmDialog('Importar cuadrante',
            `Se aplicarán <b>${fmtNum(changes.length)}</b> celdas al cuadrante de <b>${h(G.monthLabel(S.month))}</b>. Las celdas vacías borrarán la asignación de ese día; las columnas <b>Horas</b>, <b>Libres</b> y <b>Turnos</b> se ignoran.`,
            { confirm: 'Importar cuadrante', danger: true });
        if (!ok) return;
        try {
            const res = await G.api('importSchedule', { month: S.month, changes });
            S.db = res.db;
            G.buildIndexes();
            S.rev++;
            S.cache = null;
            G.render();
            const saved = res.saved || 0;
            const rejected = (res.rejected || []).length;
            const extra = skippedRows || skippedValues
                ? ` · ${fmtNum(skippedRows)} filas y ${fmtNum(skippedValues)} celdas ignoradas` : '';
            G.toast(`Cuadrante importado: ${fmtNum(saved)} celdas guardadas · ${fmtNum(rejected)} rechazadas${extra}`, rejected ? 'warn' : 'ok');
        } catch (err) {
            G.toast('No se pudo importar el cuadrante: ' + err.message, 'bad');
        }
    }
    G.exportEntityExcel = exportEntityExcel;
    G.exportEntityCsv = exportEntityCsv;
    G.importEntity = importEntity;
    G.importEntityCsv = importEntity;
    G.importSchedule = importSchedule;

    /* ======================================================================
       Arranque
       ====================================================================== */

    /* Los controles de edición se ocultan por CSS; esta capa impide además
       que se abran modales o se escriba aunque quede algún control visible. */
    function bindReadOnly() {
        // Se comprueba en cada evento porque un colaborador puede pasar de mes
        // editable a mes bloqueado sin recargar la página.
        const blocked = [
            '[data-act="undo"]', '[data-act="auto"]', '[data-act="clear"]',
            '[data-paint-code]', '[data-paint-status]', '[data-paint-erase]', '[data-paint-exit]',
            '[data-new-driver]', '[data-edit-driver]', '[data-new-absence]', '[data-edit-absence]', '[data-del-absence]',
            '[data-pair-group]', '[data-pair-partner]',
            '[data-new-fleet]', '[data-edit-fleet]', '[data-del-fleet]', '[data-toggle-fleet]',
            '[data-new-type]', '[data-edit-type]', '[data-del-type]',
            '[data-new-subtype]', '[data-edit-subtype]', '[data-del-subtype]',
            '[data-new-shift]', '[data-edit-shift]', '[data-del-shift]', '[data-new-line]', '[data-edit-line]', '[data-del-line]',
            '[data-assign-code]', '[data-pick]',
            '[data-add-holiday]', '[data-del-holiday]', '[data-save-settings]',
            '[data-reset-month]', '[data-reset-all]', '[data-import-excel]', '[data-import-schedule]',
            'tr[data-person]', 'tr[data-shift]', '[data-fleet]',
        ].join(',');
        // Ajustes está prohibido al colaborador aunque el mes esté vacío.
        const settingsBlocked = [
            '[data-add-holiday]', '[data-del-holiday]', '[data-save-settings]',
            '[data-reset-month]', '[data-reset-all]',
        ].join(',');
        document.addEventListener('click', (e) => {
            const wantsScheduleImport = !!e.target.closest('[data-import-schedule]');
            if (wantsScheduleImport && G.canImportSchedule !== true) {
                e.preventDefault();
                e.stopImmediatePropagation();
                G.toast('Solo los administradores pueden importar el cuadrante.', 'bad');
                return;
            }
            const lockedSettings = G.canEditSettings === false && e.target.closest(settingsBlocked);
            const lockedEdit = G.canEdit === false && e.target.closest(blocked);
            if (!lockedSettings && !lockedEdit) return;
            e.preventDefault();
            e.stopImmediatePropagation();
            const message = lockedSettings && G.isColaborador
                ? 'Los ajustes son de solo lectura para tu cuenta.'
                : (G.isColaborador
                    ? 'Este mes ya está asignado; no puedes modificarlo.'
                    : 'Tu cuenta es de solo lectura');
            G.toast(message, 'bad');
        }, true);
        document.addEventListener('contextmenu', (e) => {
            if (G.canEdit !== false || !e.target.closest('.cell')) return;
            e.preventDefault();
            e.stopImmediatePropagation();
        }, true);
        document.addEventListener('change', (e) => {
            if (G.canEdit !== false || !e.target.closest('[data-pair-group], [data-pair-partner]')) return;
            e.preventDefault();
            e.stopImmediatePropagation();
        }, true);
    }

    function bindChrome() {
        bindReadOnly();
        $$('#nav .nav-item').forEach((btn) => btn.addEventListener('click', () => setView(btn.dataset.view)));

        $('#month-prev').addEventListener('click', () => {
            const [y, m] = S.month.split('-').map(Number);
            const d = new Date(y, m - 2, 1);
            setMonth(`${d.getFullYear()}-${pad2(d.getMonth() + 1)}`);
        });
        $('#month-next').addEventListener('click', () => {
            const [y, m] = S.month.split('-').map(Number);
            const d = new Date(y, m, 1);
            setMonth(`${d.getFullYear()}-${pad2(d.getMonth() + 1)}`);
        });
        $('#month-today').addEventListener('click', () => {
            const now = G.currentMonth();
            if (now === S.month) {
                S.scrollToday = true;
                const head = document.querySelector('.day-head.today');
                if (head) head.scrollIntoView({ inline: 'center', block: 'nearest', behavior: 'smooth' });
            } else {
                setMonth(now);
            }
        });
        $('#month-picker').addEventListener('change', (e) => setMonth(e.target.value));

        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                if (S.paint) {
                    S.paint = null;
                    if (G.refreshPaint) G.refreshPaint();
                }
            }
            if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z' && !e.shiftKey) {
                const tag = document.activeElement?.tagName;
                if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
                e.preventDefault();
                undoLast();
            }
        });

        window.addEventListener('pointerup', () => { S.drag = false; S.dragSeen.clear(); });
        window.addEventListener('beforeunload', (e) => {
            if (S.pending.size) {
                e.preventDefault();
                e.returnValue = '';
            }
        });
        window.addEventListener('pagehide', sendPendingBeacon);
        window.addEventListener('hashchange', () => {
            const parsed = parseHash();
            if (!parsed) {
                syncHash();
                return;
            }
            if (parsed.month !== S.month) {
                S.month = parsed.month;
                S.cache = null;
            }
            if (parsed.view !== S.view) {
                S.view = parsed.view;
                render();
            }
        });
    }

    async function boot() {
        bindChrome();
        try {
            const res = await fetch('api.php?action=bootstrap', { headers: { Accept: 'application/json' } });
            if (res.status === 401) {
                location.replace('login.php');
                return;
            }
            const data = await res.json();
            if (!res.ok || !data.ok) throw new Error(data.error || 'No se pudo cargar la aplicación');
            S.db = G.normaliseDb(data.db);
            if (data.user) {
                window.GESTION.user = data.user;
                G.user = data.user;
            }
            G.buildIndexes();
            const parsed = parseHash();
            const candidate = parsed?.month || S.db.settings?.currentMonth || G.currentMonth();
            S.month = G.validMonth(candidate) ? candidate : G.currentMonth();
            S.view = parsed?.view && canView(parsed.view) ? parsed.view : 'cuadrante';
            S.scrollToday = S.month === G.currentMonth();
            render();
            if (window.GESTION.user?.mustChange && G.openForcedSetup) G.openForcedSetup();
        } catch (err) {
            $('#view').innerHTML = `<div class="panel" style="max-width:520px;margin:60px auto;">
                <div class="empty">${icon('warning')}<b>No se pudo cargar la aplicación</b>
                <p>${h(err.message)}</p>
                <p style="margin-top:12px"><button class="btn btn-primary" id="retry-boot">Reintentar</button></p></div></div>`;
            document.getElementById('retry-boot')?.addEventListener('click', () => location.reload());
        }
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
    else boot();
})();
