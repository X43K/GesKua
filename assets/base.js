/* ==========================================================================
   Base: estado, utilidades, API, guardado y diálogos.
   ========================================================================== */
(() => {
    'use strict';

    const $ = (sel, root = document) => root.querySelector(sel);
    const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

    const S = {
        db: null,
        view: 'cuadrante',
        month: '',
        paint: null,
        pending: new Map(),
        undo: [],
        saving: false,
        saveTimer: null,
        retryTimer: null,
        rev: 0,
        cache: null,
        lastAlerts: [],
        drag: false,
        dragSeen: new Set(),
        patchRaf: null,
        order: 'name',
        paletteKind: 'lv',
        paletteLine: 'all',
        search: '',
        shiftSearch: '',
        shiftLine: 'all',
        fleetStatus: 'all',
        fleetSearch: '',
        personalStatus: 'all',
        personalSearch: '',
        personalTab: 'fichas',
        pairSearch: '',
        scrollToday: false,
    };

    const G = {
        $, $$, S,
        views: {},
        binders: {},
        codeIndex: new Map(),
        codes: { lv: [], sab: [], dom: [] },
        lineMap: new Map(),
        vehicleMap: new Map(),
        driverMap: new Map(),
    };
    window.G = G;

    /* ---------- Formato y utilidades -------------------------------------- */

    const h = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));

    const pad2 = (n) => String(n).padStart(2, '0');
    const fmtNum = (n) => new Intl.NumberFormat('es-ES').format(Math.round(Number(n) || 0));
    const fmt1 = (n) => new Intl.NumberFormat('es-ES', { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(Number(n) || 0);
    const fmtPct = (n) => new Intl.NumberFormat('es-ES', { maximumFractionDigits: 1 }).format(Number(n) || 0) + ' %';
    const fmtHours = (n) => {
        const total = Math.round((Number(n) || 0) * 60);
        const hh = Math.floor(total / 60);
        const mm = total % 60;
        return `${hh} h${mm ? ' ' + mm + ' m' : ''}`;
    };
    const MONTHS = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
    const DAY_SHORT = ['DO', 'LU', 'MA', 'MI', 'JU', 'VI', 'SÁ'];
    const DAY_LONG = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
    const STATUS = {
        D: { label: 'Descanso', cls: 'rest', tag: '', short: 'D' },
        VA: { label: 'Vacaciones', cls: 'vac', tag: 'ok', short: 'VA' },
        BA: { label: 'Baja médica', cls: 'sick', tag: 'bad', short: 'BA' },
        AP: { label: 'Asuntos propios', cls: 'personal', tag: 'warn', short: 'AP' },
        // Los tres permisos comparten la marca P; el tooltip distingue el motivo.
        PI: { label: 'Permiso por ingreso', cls: 'personal', tag: 'warn', short: 'P' },
        PC: { label: 'Permiso por cuidados', cls: 'personal', tag: 'warn', short: 'P' },
        PF: { label: 'Permiso por fallecimiento', cls: 'personal', tag: 'warn', short: 'P' },
        HS: { label: 'Horas sindicales', cls: 'personal', tag: 'warn', short: 'HS' },
        HR: { label: 'Horas registro', cls: 'personal', tag: 'warn', short: 'R' },
        X: { label: 'Jornada sin turno', cls: 'virtual', tag: '', short: 'X' },
    };
    const STATUS_ALIASES = { V: 'VA', B: 'BA', A: 'AP', P: 'PI', R: 'HR' };
    const STATUS_ABSENCE = ['VA', 'BA', 'AP', 'PI', 'PC', 'PF', 'HS', 'HR'];
    const absenceTotal = (status) => STATUS_ABSENCE.reduce((sum, key) => sum + (Number(status?.[key]) || 0), 0);
    const normaliseStatusValue = (value) => {
        const text = String(value ?? '').toUpperCase();
        return STATUS_ALIASES[text] || text;
    };
    const normaliseLifecycle = (entity) => {
        if (!entity || typeof entity !== 'object') return;
        const dateOrEmpty = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? String(v) : '';
        entity.deepInactive = !!entity.deepInactive;
        entity.active = !!entity.active && !entity.deepInactive;
        entity.inactiveFrom = dateOrEmpty(entity.inactiveFrom);
        entity.lastSeen = dateOrEmpty(entity.lastSeen);
        entity.missingSince = dateOrEmpty(entity.missingSince);
        const rawActive = !!entity.active;
        entity.stateBeforeAbsence = entity.stateBeforeAbsence === undefined
            ? (entity.deepInactive ? true : rawActive)
            : !!entity.stateBeforeAbsence;
        if (!entity.active && !entity.inactiveFrom) entity.inactiveFrom = todayISO();
        if (entity.active) entity.inactiveFrom = '';
    };
    const normaliseDb = (db) => {
        if (!db || typeof db !== 'object') return db;
        for (const key of ['drivers', 'vehicles', 'shifts']) {
            for (const entity of db[key] || []) normaliseLifecycle(entity);
        }
        for (const a of db.absences || []) {
            a.type = normaliseStatusValue(a.type);
            if (!STATUS_ABSENCE.includes(a.type)) a.type = 'VA';
        }
        for (const rows of Object.values(db.assignments || {})) {
            if (!rows || typeof rows !== 'object') continue;
            for (const [key, value] of Object.entries(rows)) rows[key] = normaliseStatusValue(value);
        }
        return db;
    };
    const KIND_LABEL = { lv: 'laborable', sab: 'sábado', dom: 'domingo o festivo' };
    const ICONS = {
        grid: 'grid', users: 'users', bus: 'bus', clock: 'clock', chart: 'chart',
        plus: 'plus', search: 'search', download: 'download', upload: 'upload', print: 'print',
        close: 'close', check: 'check', warning: 'warning', trash: 'trash',
        edit: 'edit', calendar: 'calendar', sparkles: 'sparkles', filter: 'filter',
        undo: 'undo', arrowLeft: 'arrow-left', chevronLeft: 'chevron-left', chevronRight: 'chevron-right',
    };
    const icon = (name, cls = '') => `<svg${cls ? ` class="${cls}"` : ''} aria-hidden="true"><use href="#i-${ICONS[name] || name}"/></svg>`;

    const hhmmToMin = (v) => {
        const m = /^(\d{1,2}):(\d{2})$/.exec(String(v || ''));
        return m ? (Number(m[1]) * 60 + Number(m[2])) : null;
    };
    const minToHHMM = (m) => `${pad2(Math.floor(m / 60) % 24)}:${pad2(Math.round(m) % 60)}`;

    const hexRgb = (hex) => {
        const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || ''));
        if (!m) return [100, 116, 139];
        return [parseInt(m[1].slice(0, 2), 16), parseInt(m[1].slice(2, 4), 16), parseInt(m[1].slice(4, 6), 16)];
    };
    const tint = (hex, alpha) => {
        const [r, g, b] = hexRgb(hex);
        return `rgba(${r}, ${g}, ${b}, ${alpha})`;
    };
    const darken = (hex, amount = 0.25) => {
        const [r, g, b] = hexRgb(hex).map((v) => Math.max(0, Math.round(v * (1 - amount))));
        return `rgb(${r}, ${g}, ${b})`;
    };

    const todayISO = () => {
        const d = new Date();
        return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
    };
    const currentMonth = () => todayISO().slice(0, 7);
    const validMonth = (m) => /^\d{4}-(0[1-9]|1[0-2])$/.test(String(m || ''));

    const monthDays = (month) => {
        const [y, m] = month.split('-').map(Number);
        const total = new Date(y, m, 0).getDate();
        return Array.from({ length: total }, (_, i) => `${month}-${pad2(i + 1)}`);
    };
    const monthLabel = (month) => {
        const [y, m] = month.split('-').map(Number);
        return `${MONTHS[m - 1]} de ${y}`;
    };
    const weekdayIndex = (date) => new Date(date + 'T12:00:00').getDay();
    const weekdayShort = (date) => DAY_SHORT[weekdayIndex(date)];
    const prettyDate = (date) => {
        const d = new Date(date + 'T12:00:00');
        return `${DAY_LONG[d.getDay()]}, ${d.getDate()} de ${MONTHS[d.getMonth()]}`;
    };
    const addDays = (date, delta) => {
        const d = new Date(date + 'T12:00:00');
        d.setDate(d.getDate() + delta);
        return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
    };
    const rangeDays = (from, to) => {
        const out = [];
        let cur = from;
        let guard = 0;
        while (cur <= to && guard++ < 400) {
            out.push(cur);
            cur = addDays(cur, 1);
        }
        return out;
    };
    const prettyName = (name) => {
        let s = String(name || '').trim();
        if (s.includes(',')) {
            const [last, first] = s.split(',');
            s = `${first.trim()} ${last.trim()}`;
        }
        return s.toLowerCase().replace(/(^|[\s\-'’])([a-záéíóúñü])/g, (m, a, b) => a + b.toUpperCase())
            .replace(/\bDe\b/g, 'de').replace(/\bDel\b/g, 'del').replace(/\bLa\b/g, 'la').replace(/\bLos\b/g, 'los');
    };
    const initials = (name) => {
        const parts = prettyName(name).split(/\s+/).filter(Boolean);
        return ((parts[0] || '?')[0] + (parts[1] || '')[0] || '').toUpperCase().slice(0, 2);
    };
    const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

    /* ---------- Índices ---------------------------------------------------- */

    function buildIndexes() {
        G.codeIndex.clear();
        G.codes = { lv: [], sab: [], dom: [] };
        for (const shift of G.S.db.shifts) {
            const code = String(shift.code);
            G.codeIndex.set(code, shift); // Los archivados siguen visibles en meses históricos.
            const usable = !shift.deepInactive && shift.active !== false;
            for (const kind of ['lv', 'sab', 'dom']) {
                if (usable && shift.variants && shift.variants[kind]) G.codes[kind].push(Number(shift.code));
            }
        }
        for (const kind of ['lv', 'sab', 'dom']) G.codes[kind].sort((a, b) => a - b);
        G.lineMap = new Map((G.S.db.lines || []).map((l) => [l.code, l]));
        G.vehicleMap = new Map((G.S.db.vehicles || []).map((v) => [String(v.id), v]));
        G.activeVehicleMap = new Map((G.S.db.vehicles || []).filter((v) => !v.deepInactive && v.active !== false).map((v) => [String(v.id), v]));
        G.driverMap = new Map((G.S.db.drivers || []).map((d) => [String(d.id), d]));
        G.vehicleSubtypeMap = new Map();
        for (const type of G.S.db.vehicleTypes || []) {
            for (const variant of type.variants || []) {
                G.vehicleSubtypeMap.set(String(variant.id), { variant, type });
            }
        }
    }
    G.buildIndexes = buildIndexes;

    const driverById = (id) => G.driverMap.get(String(id));
    const shiftFor = (code) => G.codeIndex.get(String(code));
    const variantFor = (code, kind) => shiftFor(code)?.variants?.[kind] || null;
    const codesFor = (kind) => G.codes[kind] || [];
    const lineFor = (code) => G.lineMap.get(String(code || 'REF')) || null;
    const lineColor = (code) => lineFor(code)?.color || '#64748b';
    /* Orden de líneas: primero L, después C y por último P; dentro de cada
       grupo se ordena por número (L2 antes que L10). */
    const LINE_ORDER = { L: 0, C: 1, P: 2 };
    const lineRank = (code) => LINE_ORDER[String(code || '').toUpperCase().match(/^[A-Z]+/)?.[0]] ?? 3;
    const compareLines = (a, b) => {
        const ac = typeof a === 'string' ? a : String(a?.code ?? '');
        const bc = typeof b === 'string' ? b : String(b?.code ?? '');
        return (lineRank(ac) - lineRank(bc)) || ac.localeCompare(bc, 'es', { numeric: true, sensitivity: 'base' });
    };
    const holidayFor = (date) => (G.S.db.holidays || []).find((x) => (typeof x === 'string' ? x : x.date) === date) || null;
    const dayKind = (date) => {
        if (holidayFor(date)) return 'dom';
        const w = weekdayIndex(date);
        if (w === 0) return 'dom';
        if (w === 6) return 'sab';
        return 'lv';
    };
    const needFor = (kind) => Number(G.S.db.needs?.[kind] || 0);
    const vehicleSubtype = (id) => G.vehicleSubtypeMap?.get(String(id)) || null;
    const vehicleTypeLabel = (id) => {
        const entry = vehicleSubtype(id);
        if (!entry) return '';
        const parts = [];
        const brand = String(entry.type.brand || '').trim();
        const model = String(entry.type.model || '').trim();
        if (brand || model) parts.push([brand, model].filter(Boolean).join(' '));
        if (entry.variant.size) parts.push(entry.variant.size);
        if (entry.variant.fuel) parts.push(entry.variant.fuel);
        return parts.join(' · ');
    };
    const vehicleSizeMeters = (size) => {
        const m = String(size || '').match(/(\d+(?:[.,]\d+)?)\s*m/i);
        return m ? parseFloat(m[1].replace(',', '.')) : null;
    };
    const vehicleFuels = () => [...new Set(
        (G.S.db.vehicleTypes || []).flatMap((t) => (t.variants || []).map((v) => String(v.fuel || '').trim()).filter(Boolean))
    )].sort((a, b) => a.localeCompare(b, 'es'));
    const vehicleSizes = () => [...new Set(
        (G.S.db.vehicleTypes || []).flatMap((t) => (t.variants || []).map((v) => vehicleSizeMeters(v.size)).filter((n) => n !== null && n > 0).map(Math.ceil))
    )].sort((a, b) => a - b);
    const driverVehicleAuthLabel = (driver) => {
        const fuels = (driver?.authorizedFuels || []).filter(Boolean);
        const max = Number(driver?.maxVehicleSize || 0);
        if (!fuels.length) return 'Sin autorizar';
        const parts = [];
        if (max > 0) parts.push(`hasta ${max} m`);
        if (driver?.allowsArticulated) parts.push('Articulados');
        return parts.length ? `${fuels.join(', ')} · ${parts.join(' · ')}` : 'Sin autorizar';
    };
    const isRosterDriver = (driver) => {
        if (!driver || !driver.active) return false;
        const role = String(driver.role || '').trim().toLowerCase();
        return role === 'conductor' || role === 'conductora';
    };
    const rosterDrivers = (list) => (list || G.S.db.drivers || []).filter(isRosterDriver);
    const isVisibleEntity = (entity) => !!entity && !entity.deepInactive;
    const visibleDrivers = (list) => (list || G.S.db.drivers || []).filter(isVisibleEntity);
    const visibleVehicles = (list) => (list || G.S.db.vehicles || []).filter(isVisibleEntity);
    const visibleShifts = (list) => (list || G.S.db.shifts || []).filter(isVisibleEntity);
    const hasAssignmentsInMonth = (driverId, month) => {
        const rows = (G.S.db.assignments || {})[month] || {};
        return Object.keys(rows).some((key) => key.startsWith(String(driverId) + '|'));
    };
    /* Un mes está asignado cuando tiene códigos de turno guardados o pendientes.
       Las ausencias y los descansos no cuentan: solo se bloquea un cuadrante
       propiamente dicho. */
    const monthHasAssignments = (month) => {
        const rows = (G.S.db?.assignments || {})[month] || {};
        if (Object.values(rows).some((value) => isCode(value))) return true;
        for (const [key, value] of S.pending) {
            if (key.startsWith(`${month}|`) && isCode(value)) return true;
        }
        return false;
    };
    const archivedDriversForMonth = (month) => (G.S.db.drivers || []).filter(
        (d) => d.deepInactive && hasAssignmentsInMonth(d.id, month)
    );
    const driverGroupLabel = (driver) => {
        const group = String(driver?.group || '');
        return group === 'A' ? 'A · Mañana' : group === 'B' ? 'B · Tarde' : 'Sin grupo';
    };
    const driverPartner = (driver) => (driver?.partnerId ? driverById(driver.partnerId) : null);
    const driverPartnerLabel = (driver) => {
        const partner = driverPartner(driver);
        return partner ? G.prettyName(partner.name) : 'Sin compañero';
    };
    const driverCanDriveVehicle = (driver, vehicle) => {
        const entry = vehicleSubtype(vehicle?.typeId);
        if (!entry) return true; // Vehículo sin tipo de catálogo: no se puede comprobar.
        const fuel = String(entry.variant.fuel || '').trim();
        if (!fuel || !(driver?.authorizedFuels || []).includes(fuel)) return false;
        const meters = vehicleSizeMeters(entry.variant.size);
        const articulated = vehicle?.kind === 'articulado' || (meters !== null && meters >= 18);
        if (articulated) return !!driver?.allowsArticulated;
        const max = Number(driver?.maxVehicleSize || 0);
        return max > 0 && meters !== null && meters <= max;
    };
    const lineAllowsVehicle = (line, vehicle) => {
        const entry = vehicleSubtype(vehicle?.typeId);
        if (!entry) return true; // Vehículo sin tipo de catálogo: no se puede comprobar.
        const fuel = String(entry.variant.fuel || '').trim();
        const meters = vehicleSizeMeters(entry.variant.size);
        const fuelMode = line?.fuelMode || 'all';
        const fuelValues = line?.fuelValues || [];
        if (fuel && fuelMode === 'only' && !fuelValues.includes(fuel)) return false;
        if (fuel && fuelMode === 'deny' && fuelValues.includes(fuel)) return false;
        if (meters !== null) {
            if ((line?.sizeMode || 'all') === 'only' && !(line?.sizeValues || []).map(Number).includes(Math.ceil(meters))) return false;
            if ((line?.sizeMode || 'all') === 'max' && Number(line?.maxSize || 0) > 0 && meters > Number(line.maxSize)) return false;
        }
        return true;
    };
    const lineRestrictionLabel = (line) => {
        const parts = [];
        const fuelMode = line?.fuelMode || 'all';
        const sizeMode = line?.sizeMode || 'all';
        if (fuelMode === 'only') parts.push('Solo ' + (line.fuelValues || []).join(', '));
        if (fuelMode === 'deny') parts.push('Prohíbe ' + (line.fuelValues || []).join(', '));
        if (sizeMode === 'only') parts.push('Solo ' + (line.sizeValues || []).map((n) => n + ' m').join(', '));
        if (sizeMode === 'max') parts.push('Hasta ' + line.maxSize + ' m');
        return parts.filter(Boolean).join(' · ') || 'Sin restricciones';
    };

    /* ---------- Cuadre de servicios, conductores y buses ------------------- */

    const vehicleById = (id) => G.vehicleMap?.get(String(id || '').trim()) || null;
    const activeVehicleById = (id) => G.activeVehicleMap?.get(String(id || '').trim()) || null;
    const shiftVehicleFor = (shift, kind) => String(shift?.variants?.[kind]?.vehicle || shift?.vehicle || '').trim();
    const shiftLineFor = (shift, kind) => String(shift?.variants?.[kind]?.line || shift?.line || '').trim();
    const vehicleAssignmentFor = (driverId, date) => {
        const month = String(date || '').slice(0, 7);
        return G.S.db.vehicleAssignments?.[month]?.[`${driverId}|${date}`] || '';
    };
    const serviceSlot = (variant) => {
        let start = Number(variant?.startMin);
        let end = Number(variant?.endMin);
        if (!Number.isFinite(start)) start = hhmmToMin(variant?.start) ?? 0;
        if (!Number.isFinite(end)) end = hhmmToMin(variant?.end) ?? start;
        if (end <= start) end += 1440;
        return [start, end];
    };
    const usedVehicleSlots = (date, ignoreKey) => {
        const month = date.slice(0, 7);
        const kind = dayKind(date);
        const assignments = { ...(G.S.db.assignments?.[month] || {}) };
        for (const [key, value] of S.pending) {
            if (key.startsWith(month + '|')) assignments[key] = value;
        }
        const slots = new Map();
        for (const [key, code] of Object.entries(assignments)) {
            if (!key.endsWith('|' + date) || key === ignoreKey || !/^\d+$/.test(String(code))) continue;
            const variant = variantFor(code, kind);
            if (!variant) continue;
            const driverId = key.slice(0, key.lastIndexOf('|'));
            const id = vehicleAssignmentFor(driverId, date) || shiftVehicleFor(shiftFor(code), kind);
            if (!id) continue;
            const [start, end] = serviceSlot(variant);
            if (!slots.has(id)) slots.set(id, []);
            slots.get(id).push([start, end]);
        }
        return slots;
    };
    const checkAssignment = (driverId, date, code) => {
        const shift = shiftFor(code);
        const kind = dayKind(date);
        const variant = shift?.variants?.[kind];
        const driver = driverById(driverId);
        if (!shift || !variant || !driver || shift.deepInactive || shift.active === false || !isRosterDriver(driver)) {
            return { ok: false, vehicle: '', reason: 'El turno o el conductor no está disponible', reassigned: false };
        }
        const [start, end] = serviceSlot(variant);
        const consecutive = consecutiveCheck(driverId, date, code);
        if (!consecutive.ok) {
            return { ok: false, vehicle: '', reason: consecutive.reason, reassigned: false };
        }
        // El descanso entre turnos también se mide desde el último servicio del
        // mes anterior si la celda es el primer día del mes.
        const rest = restCheck(driverId, date, code);
        if (!rest.ok) {
            return { ok: false, vehicle: '', reason: rest.reason, reassigned: false };
        }
        const key = `${driverId}|${date}`;
        const month = date.slice(0, 7);
        const line = lineFor(shiftLineFor(shift, kind));
        const desired = shiftVehicleFor(shift, kind);
        const desiredVehicle = activeVehicleById(desired);
        const slots = usedVehicleSlots(date, key);
        const assignments = { ...(G.S.db.assignments?.[month] || {}) };
        for (const [k, v] of S.pending) if (k.startsWith(month + '|')) assignments[k] = v;

        // Los turnos pares releval al impar anterior con su bus si no solapan.
        let relief = '';
        const num = Number(code);
        if (num > 1 && num % 2 === 0) {
            const previousShift = shiftFor(num - 1);
            const previousVariant = previousShift?.variants?.[kind];
            if (previousShift && previousVariant) {
                const [, previousEnd] = serviceSlot(previousVariant);
                if (start >= previousEnd) {
                    for (const [k, v] of Object.entries(assignments)) {
                        if (!k.endsWith('|' + date) || k === key || String(v) !== String(num - 1)) continue;
                        const previousDriver = k.slice(0, k.lastIndexOf('|'));
                        const candidate = vehicleAssignmentFor(previousDriver, date) || shiftVehicleFor(previousShift, kind);
                        if (candidate && G.activeVehicleMap?.has(String(candidate))) { relief = String(candidate); break; }
                    }
                }
            }
        }

        const busy = (id) => (slots.get(String(id)) || []).some(([s, e]) => start < e && end > s);
        const score = (v) => {
            const isRelief = !!relief && String(v.id) === relief;
            const base = isRelief ? -1 : (String(v.id) === desired ? 0 : (desiredVehicle && v.typeId && v.typeId === desiredVehicle.typeId ? 1 : 2));
            return base + (isRelief ? 0 : (busy(v.id) ? 3 : 0));
        };
        const options = (G.S.db.vehicles || [])
            .filter((v) => !v.deepInactive && v.active !== false
                && String(v.status || 'disponible') !== 'taller'
                && driverCanDriveVehicle(driver, v)
                && (!line || lineAllowsVehicle(line, v)))
            .sort((a, b) => score(a) - score(b) || String(a.id).localeCompare(String(b.id), 'es', { numeric: true }));
        if (!options.length) {
            let reason = 'No hay ningún bus apto y disponible para esta línea';
            if (desired && !desiredVehicle) reason = `El bus ${desired} del turno no está en la flota`;
            else if (desiredVehicle && desiredVehicle.status === 'taller') reason = `El bus ${desired} está en taller y no hay alternativa`;
            else if (desired && (!driverCanDriveVehicle(driver, desiredVehicle) || (line && !lineAllowsVehicle(line, desiredVehicle)))) reason = `El bus ${desired} no es válido para este conductor o esta línea y no hay alternativa`;
            return { ok: false, vehicle: '', reason, reassigned: false };
        }
        const chosen = String(options[0].id);
        return { ok: true, vehicle: chosen, reason: '', reassigned: chosen !== desired };
    };
    const effectiveVehicleFor = (driverId, date) => {
        const key = `${driverId}|${date}`;
        const value = getValAt(driverId, date);
        if (S.pending.has(key) && G.isCode(value)) {
            const check = checkAssignment(driverId, date, value);
            if (check.ok) return check.vehicle;
        }
        return vehicleAssignmentFor(driverId, date) || shiftVehicleFor(shiftFor(value), dayKind(date));
    };
    const absenceFor = (driverId, date) => (G.S.db.absences || []).find((a) => String(a.driverId) === String(driverId) && a.from <= date && date <= a.to) || null;
    const maxConsecutive = () => Number(G.S.db.settings?.maxConsecutive || 5);
    const exceptionDays = () => {
        const value = Number(G.S.db.settings?.exceptionDays ?? 6);
        return Number.isFinite(value) ? Math.max(0, Math.min(14, Math.trunc(value))) : 6;
    };
    const exceptionRestMin = () => {
        const value = Number(G.S.db.settings?.exceptionRest ?? 48);
        return (Number.isFinite(value) ? Math.max(1, Math.min(168, value)) : 48) * 60;
    };
    const minRestMin = () => {
        const value = Number(G.S.db.settings?.minRest ?? 12);
        return (Number.isFinite(value) ? Math.max(0, Math.min(24, value)) : 12) * 60;
    };
    const reducedRestMinMin = () => {
        const value = Number(G.S.db.settings?.reducedRestMin ?? 9);
        return (Number.isFinite(value) ? Math.max(1, Math.min(24, value)) : 9) * 60;
    };
    const maxReducedRests = () => {
        const value = Number(G.S.db.settings?.maxReducedRests ?? 3);
        return Number.isFinite(value) ? Math.max(0, Math.min(14, Math.trunc(value))) : 3;
    };
    const weeklyRestMin = () => exceptionRestMin();

    /* Días libres del mes: ((días * 8 h) - 166 h) / 8 h, redondeado al más
       cercano. Se puede fijar un valor distinto para cada mes en Ajustes. */
    const defaultFreeDays = (month) => {
        const days = monthDays(month).length;
        return Math.max(0, Math.min(days, Math.round((days * 8 - 166) / 8)));
    };
    const freeDaysFor = (month) => {
        const raw = G.S.db.settings?.freeDaysByMonth?.[month];
        if (raw === undefined || raw === null || raw === '') return defaultFreeDays(month);
        const value = Number(raw);
        if (!Number.isFinite(value)) return defaultFreeDays(month);
        return Math.max(0, Math.min(monthDays(month).length, Math.trunc(value)));
    };
    /** Plan de turnos: capacidad teórica y jornadas virtuales X. */
    const turnPlan = (month, totalShifts) => {
        const dayCount = monthDays(month).length;
        const free = freeDaysFor(month);
        const workDays = Math.max(0, dayCount - free);
        const shifts = Math.max(0, Math.trunc(Number(totalShifts) || 0));
        const drivers = workDays ? Math.ceil(shifts / workDays) : 0;
        const capacity = workDays * drivers;
        return { days: dayCount, free, workDays, shifts, drivers, capacity, x: Math.max(0, capacity - shifts) };
    };

    /** Minutos de descanso entre dos jornadas consecutivas. */
    const restMinutesBetween = (prevDate, prevCode, nextDate, nextCode) => {
        const prevVariant = isCode(prevCode) ? variantFor(prevCode, dayKind(prevDate)) : null;
        const prevEnd = prevVariant ? serviceSlot(prevVariant)[1] : 1440;
        const nextVariant = isCode(nextCode) ? variantFor(nextCode, dayKind(nextDate)) : null;
        const nextStart = nextVariant ? serviceSlot(nextVariant)[0] : 0;
        const utc = (d) => Date.UTC(Number(d.slice(0, 4)), Number(d.slice(5, 7)) - 1, Number(d.slice(8, 10)));
        const days = Math.max(1, Math.round((utc(nextDate) - utc(prevDate)) / 86400000));
        return Math.max(0, (1440 - prevEnd) + (days - 1) * 1440 + nextStart);
    };

    /** Descansos reducidos consumidos desde el último descanso semanal. */
    const reducedRestUsage = (valueAt, date) => {
        const works = [];
        let cursor = addDays(date, -70);
        const last = addDays(date, -1);
        let guard = 0;
        while (cursor <= last && guard++ < 100) {
            const code = valueAt(cursor);
            if (isCode(code)) works.push({ date: cursor, code });
            cursor = addDays(cursor, 1);
        }
        let used = 0;
        for (let i = 1; i < works.length; i++) {
            const minutes = restMinutesBetween(
                works[i - 1].date, works[i - 1].code, works[i].date, works[i].code
            );
            if (minutes >= weeklyRestMin()) used = 0;
            else if (minutes >= reducedRestMinMin() && minutes < minRestMin()) used++;
        }
        return used;
    };

    /** Valida el descanso diario con la regla de reducidos configurada. */
    const restCheck = (driverId, date, code) => {
        const valueAt = (d) => (d === date ? String(code) : getValAt(driverId, d));
        const prevDate = addDays(date, -1);
        const prevCode = valueAt(prevDate);
        if (!isCode(prevCode)) return { ok: true, reason: '', kind: '' };
        const minutes = restMinutesBetween(prevDate, prevCode, date, String(code));
        if (minutes >= minRestMin()) return { ok: true, reason: '', kind: '' };
        const reducedMin = reducedRestMinMin();
        if (minutes < reducedMin || reducedMin >= minRestMin()) {
            return {
                ok: false, kind: 'min',
                reason: `Descanso insuficiente entre turnos: ${fmtHours(minutes / 60)}`,
            };
        }
        const max = maxReducedRests();
        if (reducedRestUsage(valueAt, date) + 1 > max) {
            return {
                ok: false, kind: 'quota',
                reason: `Máximo ${max} descansos reducidos entre descansos semanales`,
            };
        }
        return { ok: true, reason: '', kind: 'reduced' };
    };

    Object.assign(G, {
        h, icon, fmtNum, fmt1, fmtPct, fmtHours, pad2, MONTHS, DAY_SHORT, DAY_LONG, STATUS, STATUS_ABSENCE, absenceTotal, KIND_LABEL,
        normaliseStatusValue, normaliseDb,
        todayISO, currentMonth, validMonth, monthDays, monthLabel, weekdayIndex, weekdayShort, prettyDate,
        addDays, rangeDays, prettyName, initials, plural, hhmmToMin, minToHHMM, tint, darken,
        driverById, shiftFor, variantFor, codesFor, lineFor, lineColor, lineRank, compareLines, holidayFor, dayKind, needFor,
        vehicleSubtype, vehicleTypeLabel, vehicleSizeMeters, vehicleFuels, vehicleSizes,
        driverVehicleAuthLabel, driverCanDriveVehicle, lineAllowsVehicle, lineRestrictionLabel,
        isRosterDriver, rosterDrivers, isVisibleEntity, visibleDrivers, visibleVehicles, visibleShifts,
        hasAssignmentsInMonth, monthHasAssignments, archivedDriversForMonth, driverGroupLabel, driverPartner, driverPartnerLabel,
        vehicleById, activeVehicleById, shiftVehicleFor, shiftLineFor, vehicleAssignmentFor, checkAssignment, effectiveVehicleFor,
        absenceFor, maxConsecutive, exceptionDays, exceptionRestMin, minRestMin,
        reducedRestMinMin, maxReducedRests, weeklyRestMin, restMinutesBetween,
        defaultFreeDays, freeDaysFor, turnPlan,
        reducedRestUsage, restCheck, serviceSlot, buildIndexes,
    });

    /* ---------- Valores y guardado optimista ------------------------------ */

    const cellKey = (month, driverId, date) => `${month}|${driverId}|${date}`;
    const splitKey = (key) => {
        const i = key.indexOf('|');
        const month = key.slice(0, i);
        const rest = key.slice(i + 1);
        const j = rest.indexOf('|');
        return [month, rest.slice(0, j), rest.slice(j + 1)];
    };

    function getValAt(driverId, date) {
        const month = date.slice(0, 7);
        const key = cellKey(month, driverId, date);
        if (S.pending.has(key)) return S.pending.get(key);
        return S.db.assignments?.[month]?.[`${driverId}|${date}`] ?? '';
    }
    const getVal = (driverId, date) => getValAt(driverId, date);

    const isCode = (v) => /^\d+$/.test(String(v || ''));
    // X cuenta como jornada trabajada para rachas, pero no tiene horario.
    const isWorkCode = (v) => String(v) === 'X' || isCode(v);

    /* Regla de días consecutivos: los límites general y de excepción, así como
       el descanso necesario, se leen de los ajustes de la aplicación. */

    function streakBeforeWith(date, valueAt) {
        let count = 0;
        let cursor = addDays(date, -1);
        while (count < 60 && isWorkCode(valueAt(cursor))) {
            count++;
            cursor = addDays(cursor, -1);
        }
        return { count, start: addDays(date, -count) };
    }

    // La X se omite al medir descansos: cuenta para rachas, pero no tiene horario.
    function realCodeNear(valueAt, date, step) {
        let cursor = date;
        for (let i = 0; i < 70; i++) {
            const code = valueAt(cursor);
            if (isCode(code)) return { date: cursor, code };
            cursor = addDays(cursor, step);
        }
        return { date: '', code: '' };
    }

    function restBeforeWith(streakStart, valueAt) {
        let cursor = addDays(streakStart, -1);
        const restDays = [];
        for (let i = 0; i < 70; i++) {
            const code = valueAt(cursor);
            if (isCode(code)) break;
            if (String(code) !== 'X') restDays.push(cursor);
            cursor = addDays(cursor, -1);
        }
        if (!restDays.length) return null;
        const key = restDays[restDays.length - 1];
        const previous = realCodeNear(valueAt, key, -1);
        const previousVariant = previous.code ? variantFor(previous.code, dayKind(previous.date)) : null;
        const previousEnd = previousVariant ? serviceSlot(previousVariant)[1] : 1440;
        const first = realCodeNear(valueAt, streakStart, 1);
        const firstVariant = first.code ? variantFor(first.code, dayKind(first.date)) : null;
        const firstStart = firstVariant ? serviceSlot(firstVariant)[0] : 0;
        return { minutes: (1440 - previousEnd) + restDays.length * 1440 + firstStart, key };
    }

    function restAfterWith(streakEnd, valueAt) {
        let cursor = addDays(streakEnd, 1);
        const restDays = [];
        for (let i = 0; i < 70; i++) {
            const code = valueAt(cursor);
            if (isCode(code)) break;
            if (String(code) !== 'X') restDays.push(cursor);
            cursor = addDays(cursor, 1);
        }
        if (!restDays.length) return null;
        const end = realCodeNear(valueAt, streakEnd, -1);
        const endVariant = end.code ? variantFor(end.code, dayKind(end.date)) : null;
        const endMinute = endVariant ? serviceSlot(endVariant)[1] : 1440;
        const nextWork = addDays(restDays[restDays.length - 1], 1);
        const nextCode = valueAt(nextWork);
        const nextVariant = isCode(nextCode) ? variantFor(nextCode, dayKind(nextWork)) : null;
        const nextStart = nextVariant ? serviceSlot(nextVariant)[0] : 1440;
        return { minutes: (1440 - endMinute) + restDays.length * 1440 + nextStart, key: restDays[0] };
    }

    function claimedRests(valueAt, limit, date) {
        const claims = new Set();
        const restMin = exceptionRestMin();
        if (exceptionDays() <= limit) return claims;
        let cursor = addDays(date, -70);
        const until = addDays(date, 70);
        let guard = 0;
        while (cursor <= until && guard++ < 200) {
            if (!isWorkCode(valueAt(cursor))) {
                cursor = addDays(cursor, 1);
                continue;
            }
            let end = cursor;
            while (isWorkCode(valueAt(addDays(end, 1)))) end = addDays(end, 1);
            const length = Math.round((new Date(end + 'T12:00:00') - new Date(cursor + 'T12:00:00')) / 86400000) + 1;
            const includesDate = cursor <= date && date <= end;
            if (length >= limit + 1 && !includesDate) {
                const before = restBeforeWith(cursor, valueAt);
                const after = restAfterWith(end, valueAt);
                if (before && before.minutes >= restMin) claims.add(before.key);
                else if (after && after.minutes >= restMin) claims.add(after.key);
            }
            cursor = addDays(end, 1);
        }
        return claims;
    }

    function consecutiveCheck(driverId, date, code) {
        const limit = maxConsecutive();
        const extra = exceptionDays();
        const restMin = exceptionRestMin();
        const restHours = Math.round(restMin / 60);
        const valueAt = (d) => (d === date ? String(code) : getValAt(driverId, d));
        const streak = streakBeforeWith(date, valueAt);
        if (streak.count < limit) return { ok: true, reason: '' };
        const exceeds = streak.count >= (extra > limit ? extra : limit);
        const reason = exceeds
            ? `${streak.count + 1} días seguidos`
            : `${streak.count + 1} días seguidos sin ${restHours} h de descanso`;
        if (extra <= limit || exceeds) return { ok: false, reason };
        const claims = claimedRests(valueAt, limit, date);
        const before = restBeforeWith(streak.start, valueAt);
        const after = restAfterWith(date, valueAt);
        const okBefore = before && before.minutes >= restMin && !claims.has(before.key);
        const okAfter = after && after.minutes >= restMin && !claims.has(after.key);
        if (okBefore || okAfter) return { ok: true, reason: '' };
        return { ok: false, reason };
    }
    G.consecutiveCheck = consecutiveCheck;

    let lastAssignWarning = { key: '', at: 0 };
    function warnAssignment(reason, code, date) {
        const key = `${code}|${date}|${reason}`;
        const now = Date.now();
        if (key === lastAssignWarning.key && now - lastAssignWarning.at < 2500) return;
        lastAssignWarning = { key, at: now };
        toast(`No se puede asignar: ${reason}`, 'bad');
    }

    function setValue(driverId, date, value, opts = {}) {
        if (G.canEdit === false) return false;
        const month = date.slice(0, 7);
        const key = cellKey(month, driverId, date);
        const original = S.db.assignments?.[month]?.[`${driverId}|${date}`] ?? '';
        const next = String(value ?? '');
        const prev = S.pending.has(key) ? S.pending.get(key) : original;
        if (prev === next) return false;
        if (opts.validate !== false && isCode(next)) {
            const check = checkAssignment(driverId, date, next);
            if (!check.ok) {
                warnAssignment(check.reason, next, date);
                return false;
            }
        }
        if (opts.undo !== false) {
            S.undo.push({ month, driverId, date, prev });
            if (S.undo.length > 300) S.undo.shift();
        }
        if (next === original) S.pending.delete(key);
        else S.pending.set(key, next);
        S.rev++;
        S.cache = null;
        patchCell(driverId, date);
        schedulePatch();
        scheduleFlush();
        // Un colaborador que pinte un turno bloquea el mes en el acto.
        G.updatePermissions?.();
        return true;
    }
    G.setValue = setValue;
    G.getVal = getVal;
    G.getValAt = getValAt;
    G.isCode = isCode;
    G.isWorkCode = isWorkCode;
    G.cellKey = cellKey;

    function setSaveState(kind) {
        const el = $('#save-state');
        if (!el) return;
        el.classList.toggle('is-saving', kind === 'saving' || kind === 'pending');
        el.classList.toggle('is-error', kind === 'error');
        const label = kind === 'saving' ? 'Guardando…' :
            kind === 'pending' ? 'Cambios pendientes' :
            kind === 'error' ? 'Sin guardar' : 'Guardado';
        el.innerHTML = `<i></i><b>${label}</b>`;
    }
    G.setSaveState = setSaveState;

    function scheduleFlush(delay = 650) {
        clearTimeout(S.saveTimer);
        S.saveTimer = setTimeout(() => flushPending(), delay);
        setSaveState('pending');
    }
    G.scheduleFlush = scheduleFlush;

    async function flushPending() {
        clearTimeout(S.saveTimer);
        S.saveTimer = null;
        if (S.saving) return;
        const entries = Array.from(S.pending.entries());
        if (!entries.length) {
            setSaveState('saved');
            return;
        }
        S.saving = true;
        setSaveState('saving');
        const groups = new Map();
        for (const [key, value] of entries) {
            const [month, driverId, date] = splitKey(key);
            if (!groups.has(month)) groups.set(month, []);
            groups.get(month).push({ driverId, date, value });
        }
        const rejected = new Map();
        let reassigned = 0;
        try {
            for (const [month, changes] of groups) {
                const res = await api('saveAssignments', { month, changes });
                if (res.vehicleAssignments) {
                    if (!S.db.vehicleAssignments) S.db.vehicleAssignments = {};
                    S.db.vehicleAssignments[month] = res.vehicleAssignments;
                }
                for (const item of res.rejected || []) {
                    rejected.set(cellKey(month, item.driverId, item.date), item.reason || 'No se pudo asignar');
                }
                reassigned += (res.reassigned || []).length;
            }
            for (const [key, value] of entries) {
                if (S.pending.get(key) !== value) continue;
                const [month, driverId, date] = splitKey(key);
                S.pending.delete(key);
                if (rejected.has(key)) {
                    patchCell(driverId, date);
                    paintPending(key, false);
                    continue;
                }
                const k2 = `${driverId}|${date}`;
                if (!S.db.assignments[month]) S.db.assignments[month] = {};
                if (value === '') delete S.db.assignments[month][k2];
                else S.db.assignments[month][k2] = value;
                paintPending(key, false);
            }
            clearTimeout(S.retryTimer);
            S.retryTimer = null;
            setSaveState(S.pending.size ? 'pending' : 'saved');
            if (rejected.size) {
                toast(`No se pudieron cuadrar ${rejected.size} servicio(s): ${rejected.values().next().value}`, 'bad');
            }
            if (reassigned) toast(`Se reasignaron ${reassigned} bus(es) para cuadrar los servicios`);
        } catch (err) {
            setSaveState('error');
            toast('No se pudo guardar: ' + err.message, 'bad', {
                label: 'Reintentar',
                onClick: () => { clearTimeout(S.retryTimer); S.retryTimer = null; flushPending(); },
            });
            clearTimeout(S.retryTimer);
            S.retryTimer = setTimeout(() => { S.retryTimer = null; flushPending(); }, 9000);
        } finally {
            S.saving = false;
            if (S.pending.size && !S.retryTimer) scheduleFlush(300);
        }
    }
    G.flushPending = flushPending;

    function panelWindow() {
        return (S.db.settings?.currentMonth && validMonth(S.db.settings.currentMonth)) ? S.db.settings.currentMonth : currentMonth();
    }
    G.panelWindow = panelWindow;

    async function saveCurrentMonth() {
        // El mes es solo una preferencia de navegación. El lector no la guarda;
        // el colaborador usa una acción propia que no toca los ajustes.
        if (G.canEdit === false && !G.isColaborador) return;
        try {
            const res = G.isColaborador
                ? await api('setCurrentMonth', { month: S.month })
                : await api('saveSettings', { settings: { ...(S.db.settings || {}), currentMonth: S.month } });
            if (res.db) S.db.settings = res.db.settings;
        } catch { /* silencioso: es una preferencia */ }
    }
    G.saveCurrentMonth = saveCurrentMonth;

    /* ---------- API -------------------------------------------------------- */

    async function api(action, payload = {}) {
        // El colaborador viaja con el mes que está consultando: así el servidor
        // bloquea ese mes aunque la preferencia guardada todavía no se haya
        // actualizado tras cambiar de mes.
        const noMonth = ['login', 'session', 'logout', 'changeCredentials', 'bootstrap', 'setCurrentMonth'];
        const body = G.isColaborador && S.month && !noMonth.includes(action)
            ? { month: S.month, ...payload }
            : payload;
        const res = await fetch('api.php', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
            body: JSON.stringify({ action, ...body }),
        });
        let data;
        try { data = await res.json(); } catch { throw new Error('respuesta no válida del servidor'); }
        if (res.status === 401) {
            location.replace('login.php');
            throw new Error(data.error || 'Sesión no iniciada');
        }
        if (res.status === 403 && data.mustChange && G.openForcedSetup) {
            G.openForcedSetup();
        }
        if (!res.ok || !data.ok) throw new Error(data.error || `error ${res.status}`);
        if (data.db) data.db = normaliseDb(data.db);
        return data;
    }
    G.api = api;

    /* ---------- Toasts, modales y confirmaciones -------------------------- */

    function toast(message, type = 'ok', action = null) {
        const root = document.getElementById('toast-root');
        if (!root) return;
        const el = document.createElement('div');
        el.className = `toast ${type}`;
        el.innerHTML = `${icon(type === 'bad' ? 'warning' : 'check')}<span>${h(message)}</span>` +
            (action ? '<span class="spacer"></span><button type="button">' + h(action.label) + '</button>' : '');
        root.appendChild(el);
        if (action) {
            el.querySelector('button').addEventListener('click', () => { el.remove(); action.onClick(); });
        }
        setTimeout(() => el.remove(), action ? 7000 : 3600);
    }
    G.toast = toast;

    function openModal(opts) {
        const dismissible = opts.dismissible !== false;
        const root = document.getElementById('modal-root');
        root.innerHTML = `<div class="modal-backdrop">
            <div class="modal-card ${opts.wide ? 'wide' : ''}" role="dialog" aria-modal="true" aria-label="${h(opts.title)}">
                <div class="modal-head">
                    <div><h3>${h(opts.title)}</h3>${opts.subtitle ? `<p>${h(opts.subtitle)}</p>` : ''}</div>
                    ${dismissible ? `<button type="button" class="icon-btn" data-close aria-label="Cerrar">${icon('close')}</button>` : ''}
                </div>
                <div class="modal-body">${opts.body || ''}</div>
                ${opts.footer ? `<div class="modal-foot">${opts.footer}</div>` : ''}
            </div>
        </div>`;
        const backdrop = root.firstElementChild;
        const card = backdrop.firstElementChild;
        let closed = false;
        const close = () => {
            if (closed) return;
            closed = true;
            document.removeEventListener('keydown', onKey);
            root.innerHTML = '';
            if (opts.onClose) opts.onClose();
        };
        const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
        if (dismissible) {
            document.addEventListener('keydown', onKey);
            backdrop.addEventListener('mousedown', (e) => { if (e.target === backdrop) close(); });
            $$('[data-close]', card).forEach((b) => b.addEventListener('click', close));
        }
        if (opts.onMount) opts.onMount(card, close);
        const focusable = card.querySelector('input, select, textarea, button:not([data-close])');
        if (focusable) setTimeout(() => focusable.focus(), 40);
        return { root, card, close };
    }
    G.openModal = openModal;

    function confirmDialog(title, message, opts = {}) {
        return new Promise((resolve) => {
            let done = false;
            const finish = (v) => { if (!done) { done = true; resolve(v); } };
            const m = openModal({
                title,
                body: `<p style="font-size:13px;line-height:1.55;color:var(--ink-2)">${message}</p>`,
                footer: `<span class="spacer"></span>
                    <button type="button" class="btn" data-cancel>Cancelar</button>
                    <button type="button" class="btn ${opts.danger ? 'btn-danger' : 'btn-primary'}" data-ok>${h(opts.confirm || 'Aceptar')}</button>`,
                onClose: () => finish(false),
                onMount: (card, close) => {
                    card.querySelector('[data-cancel]').addEventListener('click', () => { finish(false); close(); });
                    card.querySelector('[data-ok]').addEventListener('click', () => { finish(true); close(); });
                },
            });
            if (opts.danger) setTimeout(() => m.card.querySelector('[data-ok]').focus(), 50);
        });
    }
    G.confirmDialog = confirmDialog;

    /* ---------- Celdas ----------------------------------------------------- */

    function cellMarkup(value, date, driverId, opts = {}) {
        const kind = dayKind(date);
        const key = `${driverId}|${date}`;
        const pending = S.pending.has(cellKey(date.slice(0, 7), driverId, date));
        const cls = ['cell'];
        let style = '';
        let text = '';
        let title = `${driverById(driverId)?.name || driverId} · ${prettyDate(date)}`;
        if (!value) {
            cls.push('empty');
            text = '·';
            title += ' · libre';
        } else if (isCode(value)) {
            const shift = shiftFor(value);
            const variant = variantFor(value, kind);
            const color = lineColor(variant?.line || shift?.line);
            cls.push('work');
            if (!variant) cls.push('invalid');
            style = `background:${tint(color, .13)};border-color:${tint(color, .32)};color:${darken(color, .18)}`;
            text = String(value);
            title += variant
                ? ` · T${pad2(value)} · ${variant.lineLabel || variant.line} · ${variant.start}–${variant.end} · ${fmtHours(variant.hours)}`
                : ` · T${pad2(value)} (no existe para ${KIND_LABEL[kind]})`;
        } else {
            const st = STATUS[value] || STATUS.D;
            cls.push(st.cls);
            text = st.short || value;
            title += ' · ' + st.label;
        }
        if (pending) cls.push('pending');
        return `<td class="cell-td"><button type="button" class="${cls.join(' ')}" data-cell="${h(key)}" style="${style}" title="${h(title)}">${h(text)}</button></td>`;
    }

    function patchCell(driverId, date) {
        const key = `${driverId}|${date}`;
        const btn = document.querySelector(`[data-cell="${key}"]`);
        if (!btn) return;
        const tmp = document.createElement('tr');
        tmp.innerHTML = cellMarkup(getVal(driverId, date), date, driverId);
        const replacement = tmp.firstElementChild.firstElementChild;
        btn.replaceWith(replacement);
        if (S.paint) replacement.classList.add('selected');
        else replacement.classList.remove('selected');
    }
    G.cellMarkup = cellMarkup;
    G.patchCell = patchCell;

    function paintPending(key, on) {
        const [, driverId, date] = splitKey(key);
        const btn = document.querySelector(`[data-cell="${driverId}|${date}"]`);
        if (btn) btn.classList.toggle('pending', on);
    }

    function schedulePatch() {
        if (S.patchRaf) return;
        S.patchRaf = requestAnimationFrame(() => {
            S.patchRaf = null;
            if (S.view === 'cuadrante' && G.patchCuadrante) G.patchCuadrante();
        });
    }
    G.schedulePatch = schedulePatch;
    G.patchCell = patchCell;
    G.schedulePatch = schedulePatch;
    G.paintPending = paintPending;
})();
